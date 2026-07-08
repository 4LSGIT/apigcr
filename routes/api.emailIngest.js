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

// ── Management API (Phase 3 Slice 3.1) deps.
const jwtOrApiKey            = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction }   = require('../lib/auth.superuser');
const suppressionService     = require('../services/emailIngestSuppressionService');
const ruleService            = require('../services/emailIngestRuleService');
const executionsService      = require('../services/emailIngestExecutionsService');
const metaService            = require('../services/emailIngestMetaService');
const sampleService          = require('../services/emailIngestSampleService');


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


// ═════════════════════════════════════════════════════════════
// MANAGEMENT API (Phase 3 Slice 3.1)
//
// All endpoints below are mounted under /api/email-ingest/ and gated by
// jwtOrApiKey (same as routes/api.hooks.js). The public receiver above
// (/api/email/ingest, singular) is UNCHANGED and stays key-authed.
//
// Writes emit an admin_audit_log row via auditAdminAction(db, {...}),
// matching the credentials endpoints in api.hooks.js. tool = 'email_ingest'.
// last_modified_by is set server-side from req.auth.userId on suppression /
// rule writes (action rows have no such column).
//
// Validation errors thrown by the services (ValidationError, carrying a
// .validationErrors array) are translated to a structured 400 here.
// ═════════════════════════════════════════════════════════════

const EI_TOOL = 'email_ingest';

function _reqMeta(req) {
  return {
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function auditEI(req, { status = 'success', errorMessage, details }) {
  const meta = _reqMeta(req);
  return auditAdminAction(req.db, {
    tool:     EI_TOOL,
    userId:   req.auth?.userId,
    username: req.auth?.username,
    route:    req.originalUrl,
    method:   req.method,
    status,
    ...(errorMessage ? { errorMessage } : {}),
    ...meta,
    details: details || {},
  }).catch((err) => console.error('[email-ingest] audit log failed:', err.message));
}

// Translate a thrown ValidationError into the structured 400 body. Returns
// true if it handled the error (response sent), false otherwise.
function _handleValidationError(err, res) {
  if (err && err.name === 'ValidationError' && Array.isArray(err.validationErrors)) {
    const errs = err.validationErrors;
    if (errs.length === 1) {
      res.status(400).json({
        error:   'validation_failed',
        field:   errs[0].field,
        message: errs[0].message,
      });
    } else {
      res.status(400).json({ error: 'validation_failed', errors: errs });
    }
    return true;
  }
  return false;
}


// ─────────────────────────────────────────────────────────────
// SUPPRESSIONS
// ─────────────────────────────────────────────────────────────

router.get('/api/email-ingest/suppressions', jwtOrApiKey, async (req, res) => {
  try {
    const suppressions = await suppressionService.listAll(req.db);
    res.json({ status: 'success', suppressions });
  } catch (err) {
    console.error('[email-ingest] list suppressions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/email-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const row = await suppressionService.getById(req.db, req.params.id);
    if (!row) return res.status(404).json({ status: 'error', message: 'Suppression not found' });
    res.json({ status: 'success', suppression: row });
  } catch (err) {
    console.error('[email-ingest] get suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/email-ingest/suppressions', jwtOrApiKey, async (req, res) => {
  try {
    const row = await suppressionService.create(req.db, req.body, req.auth.userId);
    auditEI(req, { details: { entity: 'suppression', entity_id: row.id, after: row } });
    res.status(201).json({ status: 'success', suppression: row });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[email-ingest] create suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/email-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await suppressionService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Suppression not found' });

    const after = await suppressionService.update(req.db, req.params.id, req.body, req.auth.userId);
    auditEI(req, { details: { entity: 'suppression', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', suppression: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[email-ingest] update suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/email-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await suppressionService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Suppression not found' });

    await suppressionService.remove(req.db, req.params.id);
    auditEI(req, { details: { entity: 'suppression', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[email-ingest] delete suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// RULES
// ─────────────────────────────────────────────────────────────

router.get('/api/email-ingest/rules', jwtOrApiKey, async (req, res) => {
  try {
    const rules = await ruleService.listAll(req.db);
    res.json({ status: 'success', rules });
  } catch (err) {
    console.error('[email-ingest] list rules error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/email-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await ruleService.getById(req.db, req.params.id);
    if (!rule) return res.status(404).json({ status: 'error', message: 'Rule not found' });
    res.json({ status: 'success', rule });
  } catch (err) {
    console.error('[email-ingest] get rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/email-ingest/rules', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await ruleService.createRule(req.db, req.body, req.auth.userId);
    auditEI(req, { details: { entity: 'rule', entity_id: rule.id, after: rule } });
    res.status(201).json({ status: 'success', rule });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[email-ingest] create rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/email-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Rule not found' });

    const after = await ruleService.updateRule(req.db, req.params.id, req.body, req.auth.userId);
    auditEI(req, { details: { entity: 'rule', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', rule: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[email-ingest] update rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/email-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Rule not found' });

    await ruleService.deleteRule(req.db, req.params.id);
    auditEI(req, { details: { entity: 'rule', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[email-ingest] delete rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// RULE ACTIONS
// ─────────────────────────────────────────────────────────────

router.post('/api/email-ingest/rules/:id/actions', jwtOrApiKey, async (req, res) => {
  try {
    const action = await ruleService.addAction(req.db, req.params.id, req.body);
    if (action === null) return res.status(404).json({ status: 'error', message: 'Rule not found' });
    auditEI(req, { details: { entity: 'rule_action', entity_id: action.id, rule_id: Number(req.params.id), after: action } });
    res.status(201).json({ status: 'success', action });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[email-ingest] add action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/email-ingest/rule-actions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getActionById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Action not found' });

    const after = await ruleService.updateAction(req.db, req.params.id, req.body);
    auditEI(req, { details: { entity: 'rule_action', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', action: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[email-ingest] update action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/email-ingest/rule-actions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getActionById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Action not found' });

    await ruleService.deleteAction(req.db, req.params.id);
    auditEI(req, { details: { entity: 'rule_action', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[email-ingest] delete action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// EXECUTIONS (read-only)
// ─────────────────────────────────────────────────────────────

router.get('/api/email-ingest/executions', jwtOrApiKey, async (req, res) => {
  try {
    const hasMatch = req.query.has_match === 'true' ? true
                   : req.query.has_match === 'false' ? false
                   : undefined;
    const { rows, total, page, page_size } = await executionsService.list(req.db, {
      page:      req.query.page,
      page_size: req.query.page_size,
      status:    req.query.status,
      source:    req.query.source,
      since:     req.query.since,
      until:     req.query.until,
      has_match: hasMatch,
    });
    res.json({ executions: rows, page, page_size, total });
  } catch (err) {
    console.error('[email-ingest] list executions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/email-ingest/executions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await executionsService.getById(req.db, req.params.id);
    if (!result) return res.status(404).json({ status: 'error', message: 'Execution not found' });
    res.json(result); // { execution, linked }
  } catch (err) {
    console.error('[email-ingest] get execution error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// META
// ─────────────────────────────────────────────────────────────

router.get('/api/email-ingest/meta', jwtOrApiKey, async (req, res) => {
  try {
    const meta = await metaService.getMeta(req.db);
    res.json(meta);
  } catch (err) {
    console.error('[email-ingest] meta error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// SAMPLE EVENTS (read-only, UI field-discovery aid)
//
// Returns the newest-N logged email events, each RECONSTRUCTED from clean
// columns (email_log + log.log_extra) and projected to the match-field catalog
// — newest first. Email's raw_input is ~75% truncated/unparseable, so unlike
// phone we cannot read it directly; the adapter rebuilds a synthetic envelope
// (8/12 fields always; the other 4 overlaid only when raw_input is intact). No
// value redaction; projection limited to catalog paths for correctness. See
// services/emailIngestSampleService.js + lib/ingestSampleProjection.js.
// ─────────────────────────────────────────────────────────────

router.get('/api/email-ingest/sample-events', jwtOrApiKey, async (req, res) => {
  try {
    const result = await sampleService.getSampleEvents(req.db);
    res.json(result); // { samples: [{ exec_id, type, ts, label, fields:[...] }] }
  } catch (err) {
    console.error('[email-ingest] sample-events error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// TEST-MATCH (Slice 10A — read-only, zero side effects)
//
// POST /api/email-ingest/rules/test-match
//
// Evaluates an editor's CURRENT (unsaved) match config against recent
// historical email events, using the PRODUCTION matcher
// (emailIngestRuleService._evaluateMatch) — so semantics, including per-row
// error swallowing, are byte-identical to what the rule would do live. The
// corpus is the same synthetic-envelope reconstruction the sample panel uses
// (sampleService.fetchSyntheticEnvelopes — one reconstruction implementation);
// each row carries `fidelity` ('full' when raw_input was intact and the 4
// raw-only fields — from.name, kind, headers.list_id, headers.in_reply_to —
// were overlaid; 'reconstructed' otherwise, where those 4 fields are ABSENT
// and conditions on them will read as non-match on that row).
//
// No suppression evaluation — this tests the RULE layer only. No DB writes,
// no audit row (nothing changed), no dispatching.
//
// Slice 10C — the corpus is now scope:'wide' (suppressed/skipped events
// included, duplicates excluded — suppressed mail is disproportionately what
// rules are written FOR), `since` anchors the window at its START (oldest-
// first from the date, with truncation reporting), and `exec_id` targets one
// specific execution with no status filter at all.
//
// Body: { match_mode, match_config, limit?, since?, exec_id?, include_misses? }
//   exec_id — positive int; mutually exclusive with since (400 if both);
//             limit is ignored with it; not found / not reconstructable → 404.
// Response:
//   { success:true, total, matched_count,
//     rows: [ { exec_id, ts, from, label, matched, fidelity, status } ] }
//   + when since was used: window_total (rows in range) and
//     truncated (window_total > total — the range overflowed the cap).
//   rows = matches newest-first (oldest-first when since given); when
//   include_misses, misses appended after them (same ordering).
// ─────────────────────────────────────────────────────────────

router.post('/api/email-ingest/rules/test-match', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const { match_mode, match_config } = body;

    // ── validation ──
    if (match_mode !== 'conditions' && match_mode !== 'code') {
      return res.status(400).json({ error: "match_mode must be 'conditions' or 'code'" });
    }

    let limit = 100;
    if (body.limit !== undefined && body.limit !== null) {
      const n = Number(body.limit);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = Math.min(300, n);
    }

    let since;
    if (body.since !== undefined && body.since !== null && body.since !== '') {
      const d = new Date(body.since);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Invalid since datetime' });
      }
      since = body.since;
    }

    let execId;
    if (body.exec_id !== undefined && body.exec_id !== null && body.exec_id !== '') {
      const n = Number(body.exec_id);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'exec_id must be a positive integer' });
      }
      if (since !== undefined) {
        return res.status(400).json({ error: 'exec_id and since are mutually exclusive — target one execution or a date window, not both' });
      }
      execId = n; // limit is ignored in exec_id mode
    }

    const includeMisses = body.include_misses === true;

    if (match_mode === 'conditions') {
      // The production matcher treats a NULL conditions config as NON-match
      // (never match-all), so testing one is pointless — reject with the
      // explicit always-match shape instead.
      if (match_config == null || typeof match_config !== 'object' || Array.isArray(match_config)) {
        return res.status(400).json({
          error: "conditions mode requires match_config to be an object — for an explicit always-match, use {operator:'and', conditions:[]}",
        });
      }
    } else {
      // code mode — extract the code string EXACTLY the way _evaluateMatch
      // does: a string config is JSON.parse'd FIRST (the matcher's defensive
      // parse), THEN code = string-or-.code. A raw (non-JSON) code string
      // therefore never matches in production — reject it up front instead of
      // returning a misleading 0-match run. Then compile ONCE so a syntax
      // error is a clean 400 instead of 0-matches-with-N-warnings. The
      // compiled fn is DISCARDED — per-row evaluation still goes through
      // _evaluateMatch so runtime semantics (error swallowing included) are
      // byte-identical to production.
      let cfg = match_config;
      if (typeof cfg === 'string') {
        try { cfg = JSON.parse(cfg); }
        catch {
          return res.status(400).json({
            error: "match_config string is not valid JSON — the production matcher would treat this as non-match on every event; send {code:'...'} instead",
          });
        }
      }
      const code = typeof cfg === 'string' ? cfg : cfg?.code;
      if (!code || typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ error: 'code mode requires a non-empty code string (match_config.code)' });
      }
      try {
        // eslint-disable-next-line no-new-func
        new Function('input', code);
      } catch (err) {
        return res.status(400).json({ error: `code does not compile: ${err.message}` });
      }
    }

    // ── corpus + evaluation ──
    // exec_id → that one execution, no status filter. Otherwise scope 'wide':
    // suppressed/skipped events in, duplicates out (see fetcher docs).
    const corpus = execId !== undefined
      ? await sampleService.fetchSyntheticEnvelopes(req.db, { exec_id: execId })
      : await sampleService.fetchSyntheticEnvelopes(req.db, { limit, since, scope: 'wide' });

    if (corpus.not_found) {
      return res.status(404).json({
        error: corpus.not_found === 'no_email_log'
          ? `execution #${execId} has no email_log row — nothing to reconstruct (auth/validation failures never produced one)`
          : `execution #${execId} not found`,
      });
    }

    const { rows } = corpus;
    const testRule = { id: 'test-match', name: '(editor)', match_mode, match_config };
    const matches = [];
    const misses  = [];
    for (const r of rows) {
      const matched = ruleService._evaluateMatch(testRule, r.envelope);
      const shaped = {
        exec_id:  r.exec_id,
        ts:       r.ts,
        from:     (r.envelope.from && r.envelope.from.email != null) ? r.envelope.from.email : null,
        label:    sampleService._subjectSnippet(r.envelope.subject),
        matched,
        fidelity: r.fidelity,
        status:   r.status,
      };
      (matched ? matches : misses).push(shaped);
    }

    const out = {
      success:       true,
      total:         rows.length,
      matched_count: matches.length,
      rows:          includeMisses ? matches.concat(misses) : matches,
    };
    if (since !== undefined && corpus.window_total !== undefined) {
      out.window_total = corpus.window_total;
      out.truncated    = corpus.window_total > rows.length;
    }
    return res.json(out);
  } catch (err) {
    console.error('[email-ingest] test-match error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;