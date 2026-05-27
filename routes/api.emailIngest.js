// routes/api.emailIngest.js
//
/**
 * Email Ingest Routes
 * routes/api.emailIngest.js
 *
 * POST /api/email/ingest — external adapter endpoint
 *
 * Authentication: per-source API key in X-Email-Ingest-Key header.
 * Each row in email_ingest_sources has its own key. Constant-time
 * compare in emailIngestService.authenticate.
 *
 * NOT mounted under JWT — the adapters (SiteGround PHP forwarder
 * pipe-from-Exim, GAS for Gmail) can't carry JWT.
 *
 * Response policy:
 *   401 — bad/missing X-Email-Ingest-Key (writes an auth_failed
 *         execution row so attack patterns surface in the table)
 *   400 — envelope validation failed (writes a validation_failed
 *         execution row, with the parse error in `error`)
 *   500 — unhandled exception, including DB connectivity issues.
 *         Adapter MAY retry on 500.
 *   200 — every other path (logged / duplicate / skipped_firm_to_firm
 *         / structured-log error). The adapter does NOT retry on 200,
 *         even when status='error' in the body; the email_log row
 *         IS persisted in that case and we don't want double-logging.
 *
 * Body: the canonical envelope shape (see worker prompt for the
 *       full 19-key schema and per-field semantics).
 */

const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const emailIngestService = require('../services/emailIngestService');


// ─────────────────────────────────────────────────────────────
// SENSITIVE HEADER STRIPPING
//
// Defense-in-depth: any header we might inadvertently store from
// the inbound request (e.g. for forensic purposes) must NOT carry
// auth material. Mirrors routes/api.hooks.js's denylist with the
// addition of x-email-ingest-key — our own per-source key, which
// is captured in source_id on the execution row and should never
// be redundantly stored in raw_input.
//
// (Slice 1.1 doesn't actually store any headers in raw_input — the
// raw_input column captures only req.body. This helper is here in
// case Phase 2 adds header storage for filter/transform evaluation,
// at which point the denylist applies automatically.)
// ─────────────────────────────────────────────────────────────

const SENSITIVE_HEADER_DENYLIST = new Set([
  'x-api-key',
  'authorization',
  'cookie',
  'x-email-ingest-key',
]);

// eslint-disable-next-line no-unused-vars
function stripSensitiveHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const k of Object.keys(headers)) {
    if (SENSITIVE_HEADER_DENYLIST.has(String(k).toLowerCase())) continue;
    out[k] = headers[k];
  }
  return out;
}


// ─────────────────────────────────────────────────────────────
// RECEIVER
//
// 60 req/min per IP. Adapter is ours; the limit catches runaway
// loops (Gmail filter loop, PHP forwarder firing in a hot retry
// loop) without affecting normal traffic. Mirrors the receive
// limit on the deprecated /email-router.
//
// Body size: server.js mounts express.json({limit:'10mb'}) globally
// BEFORE the route auto-mount loop, so by the time we get here the
// body is already parsed (or rejected as 413). The canonical envelope's
// raw.body_block can reach ~1 MB; 10 MB is enough headroom. A local
// express.json() here would be a no-op-second (body already parsed
// upstream) and would silently fail to enforce a smaller limit, so
// don't add one.
// ─────────────────────────────────────────────────────────────

const receiveLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  keyGenerator:    (req) => req.ip,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { status: 'error', message: 'Too many requests' },
  validate: false,
});


/**
 * POST /api/email/ingest
 */
router.post('/api/email/ingest', receiveLimiter, async (req, res) => {
  const db = req.db;

  // ── 1. Auth.
  //   Read the key header. emailIngestService.authenticate returns
  //   either the source row or null.
  const apiKey = req.get('X-Email-Ingest-Key') || '';

  let source;
  try {
    source = await emailIngestService.authenticate(db, apiKey);
  } catch (err) {
    console.error('[email-ingest] auth lookup failed:', err);
    return res.status(500).json({
      status:  'error',
      message: 'auth backend unavailable',
    });
  }

  if (!source) {
    // Write an auth_failed execution row for attack-pattern visibility.
    // source_id=NULL because we have no matched source. error captures
    // whether the key was missing or just wrong — both useful signals.
    const errLabel = apiKey ? 'unknown key' : 'missing key';
    try {
      await db.query(
        `INSERT INTO email_ingest_executions
           (source_id, message_id, status, error, remote_ip)
         VALUES (NULL, NULL, 'auth_failed', ?, ?)`,
        [errLabel, req.ip || null]
      );
    } catch (err) {
      // Don't surface DB-write failure on the auth-failed path; the
      // 401 is the operationally correct response regardless.
      console.error('[email-ingest] failed to write auth_failed execution:', err.message);
    }
    return res.status(401).json({
      status:  'error',
      message: 'invalid api key',
    });
  }

  // ── 2. Dispatch the pipeline.
  let result;
  try {
    result = await emailIngestService.ingestEmail(
      db,
      source,
      req.body,
      req.ip
      // raw_input snapshot defaults to req.body, truncated by the service.
    );
  } catch (err) {
    console.error('[email-ingest] pipeline error:', err);
    // Best-effort execution row with status='error'. If this write
    // also fails, just log; we still return 500.
    try {
      await db.query(
        `INSERT INTO email_ingest_executions
           (source_id, message_id, status, error, remote_ip)
         VALUES (?, NULL, 'error', ?, ?)`,
        [source.id, String(err.message || err).slice(0, 1000), req.ip || null]
      );
    } catch (writeErr) {
      console.error('[email-ingest] failed to write error execution:', writeErr.message);
    }
    return res.status(500).json({
      status:  'error',
      message: 'pipeline error',
    });
  }

  // ── 3. Status-driven response shape.
  if (result.status === 'validation_failed') {
    return res.status(400).json({
      status:       'validation_failed',
      execution_id: result.executionId,
      error:        result.error,
    });
  }

  // All remaining paths return 200. The adapter does NOT retry on
  // 200 — duplicate / skip / structured-log error are all "we got
  // it, move on" outcomes from the sender's perspective.
  const payload = {
    status:       result.status,
    execution_id: result.executionId,
  };
  if (result.logId      != null) payload.log_id       = result.logId;
  if (result.emailLogId != null) payload.email_log_id = result.emailLogId;
  if (result.error      != null) payload.error        = result.error;

  return res.status(200).json(payload);
});


module.exports = router;