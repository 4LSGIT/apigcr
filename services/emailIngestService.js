// services/emailIngestService.js
//
/**
 * Email Ingest Service
 * services/emailIngestService.js
 *
 * Phase 1.1 of the new email-ingest pipeline. Receives normalized
 * email envelopes from external adapters (SiteGround PHP, GAS for
 * Gmail-firm — Phase 1.2) at POST /api/email/ingest, writes a
 * forensic email_log row, and (unless firm-to-firm) writes a
 * structured log row via logService.createLogEntry.
 *
 * NOT in this slice: rules table, transforms, dispatch
 * (workflow/sequence/hook actions), code-mode eval, UI, capture
 * mode, tear-out of the dead email_router_* tables.
 *
 * NOT a replacement for logService — every successful, non-firm-
 * to-firm ingest still goes through logService.createLogEntry so
 * the contact/case views see it via the Phase-A date-windowed
 * contact_emails join.
 *
 * Pipeline (per inbound POST):
 *   authenticate(apiKey) → ingestEmail(source, envelope, remoteIp)
 *     ├── resolve message_id (headers.message_id → envelope.exim_message_id)
 *     ├── validate required fields
 *     ├── pre-check (source, message_id) for duplicate
 *     ├── INSERT IGNORE email_log (race-safe)
 *     ├── infer direction from from.email domain vs EMAIL_DOMAINS
 *     ├── firm-to-firm check (all addresses on a firm domain → skip log)
 *     ├── Layer 2 suppression eval (any matching rule → skip log; Slice 2.1)
 *     └── logService.createLogEntry({ link_type:'email', link_id:<other party>, ... })
 *   → emits an email_ingest_executions row in every path including
 *     auth failures (handled by the route, not by this module).
 *
 * Direction policy:
 *   from.email's domain in EMAIL_DOMAINS  → 'outgoing'
 *   otherwise                             → 'incoming'
 *   (Replaces /logEmail's hardcoded 'incoming' — that route only
 *   ever saw forwarded-inbound traffic, so the hardcode was safe.
 *   The new pipeline sees both directions.)
 *
 * Forensic continuity:
 *   email_log is written for every ingest including firm-to-firm
 *   and duplicates. It's the byte-level record. The structured log
 *   row is the user-facing event.
 */

const crypto = require('crypto');
const logService = require('./logService');
const emailIngestSuppressionService = require('./emailIngestSuppressionService');

const RAW_INPUT_LIMIT = 16 * 1024;            // 16 KB cap on raw_input snapshots
const LOG_MESSAGE_SOFT_CAP = 50000;           // mirror routes/logs.js soft cap

// ─────────────────────────────────────────────────────────────
// EMAIL_DOMAINS parsing (module-scope, computed once at load).
//
// Canonical env var is EMAIL_DOMAINS (plural, comma-separated).
// EMAIL_DOMAIN (singular) honored as fallback for back-compat —
// matches routes/logs.js behavior exactly so the two paths agree
// on which domains are "ours."
//
// Each entry is normalized to bare lowercase domain ('4lsg.com'),
// with leading '@' tolerated on input. We expose the resulting
// Set both as a list (for diagnostics) and as a Set (for O(1)
// lookups in the hot path).
//
// If neither env var is set, defaults to ['4lsg.com'] — same as
// the legacy /logEmail default.
// ─────────────────────────────────────────────────────────────

function _normalizeDomain(s) {
  return String(s).trim().toLowerCase().replace(/^@/, '');
}

function _parseDomainList(raw) {
  return String(raw)
    .split(',')
    .map(_normalizeDomain)
    .filter(Boolean);
}

function parseFirmDomains() {
  const plural   = process.env.EMAIL_DOMAINS;
  const singular = process.env.EMAIL_DOMAIN;
  let list;
  if (plural && plural.trim())        list = _parseDomainList(plural);
  else if (singular && singular.trim()) list = _parseDomainList(singular);
  else                                  list = ['4lsg.com'];
  return new Set(list);
}

const FIRM_DOMAINS = parseFirmDomains();
console.log(
  `[emailIngest] firm domains: ${JSON.stringify([...FIRM_DOMAINS])}`
);


// ─────────────────────────────────────────────────────────────
// AUTHENTICATION
//
// Lookup the api_key against email_ingest_sources. Constant-time
// compare on the matched-length buffer to avoid leaking key length
// via timing (Buffer.compare on mismatched lengths returns immediately,
// so length-class is still observable — but that's not a meaningful
// info leak for an api_key).
//
// On success, updates last_used_at fire-and-forget. The UPDATE is
// not awaited; if it fails (e.g., transient pool error), the auth
// success is already returned and we just log.
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {string} apiKey                    - raw header value
 * @returns {Promise<{id:number,name:string}|null>}
 */
async function authenticate(db, apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return null;

  // Load all active rows. Volume is tiny (<10 forever) so a
  // table scan + constant-time compare in JS is fine and matches
  // emailRouter.authenticateRequest's pattern.
  const [rows] = await db.query(
    `SELECT id, name, api_key FROM email_ingest_sources WHERE active = 1`
  );

  const incoming = Buffer.from(apiKey, 'utf8');
  for (const row of rows) {
    const stored = Buffer.from(String(row.api_key || ''), 'utf8');
    if (stored.length !== incoming.length) continue;
    if (crypto.timingSafeEqual(stored, incoming)) {
      // Fire-and-forget last_used_at update — the auth result is
      // independent of this write succeeding.
      db.query(
        `UPDATE email_ingest_sources SET last_used_at = NOW() WHERE id = ?`,
        [row.id]
      ).catch(e =>
        console.error(`[emailIngest] last_used_at update failed for source ${row.id}:`, e.message)
      );
      return { id: row.id, name: row.name };
    }
  }
  return null;
}


// ─────────────────────────────────────────────────────────────
// Helpers — direction inference, firm-to-firm detection.
// Exported (named) for testability.
// ─────────────────────────────────────────────────────────────

function _domainOf(email) {
  if (!email || typeof email !== 'string') return '';
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * @param {string} fromEmail
 * @param {Set<string>} firmDomains
 * @returns {'incoming'|'outgoing'}
 */
function inferDirection(fromEmail, firmDomains) {
  const d = _domainOf(fromEmail);
  return d && firmDomains.has(d) ? 'outgoing' : 'incoming';
}

/**
 * Returns true if EVERY supplied address (from + all to + all cc) is
 * present AND its domain is in firmDomains. Empty input → false (we
 * never skip on a missing-data input — that'd be the most likely
 * place for an attacker to hide an externally-bound payload).
 *
 * @param {string[]} addresses
 * @param {Set<string>} firmDomains
 * @returns {boolean}
 */
function isFirmToFirm(addresses, firmDomains) {
  if (!Array.isArray(addresses) || !addresses.length) return false;
  for (const a of addresses) {
    if (!a) return false;            // any empty address disqualifies
    const d = _domainOf(a);
    if (!d || !firmDomains.has(d)) return false;
  }
  return true;
}


// ─────────────────────────────────────────────────────────────
// Helpers — envelope reading.
//
// All helpers tolerate the envelope shape from EITHER the SiteGround
// PHP forwarder (full shape including envelope.* and raw.*) or a
// future Gmail-side adapter (partial shape, some fields null).
// ─────────────────────────────────────────────────────────────

function _firstEmail(arr) {
  if (!Array.isArray(arr)) return '';
  for (const e of arr) {
    if (e && typeof e === 'object' && e.email) return String(e.email);
  }
  return '';
}

function _joinEmails(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map(e => (e && typeof e === 'object' ? e.email : null))
            .filter(Boolean)
            .join(', ');
}

function _collectAllAddresses(envelope) {
  const out = [];
  if (envelope.from && envelope.from.email) out.push(String(envelope.from.email));
  if (Array.isArray(envelope.to)) {
    for (const e of envelope.to) if (e && e.email) out.push(String(e.email));
  }
  if (Array.isArray(envelope.cc)) {
    for (const e of envelope.cc) if (e && e.email) out.push(String(e.email));
  }
  return out;
}

/**
 * Resolve a stable message-id from the envelope, in priority order:
 *   1. headers.message_id (preferred — RFC 5322 identifier)
 *   2. envelope.exim_message_id
 * Returns null if neither resolves.
 *
 * Strips RFC 5322 angle brackets if present so the stored form is
 * canonical.
 */
function _resolveMessageId(envelope) {
  const h = envelope?.headers?.message_id;
  const e = envelope?.envelope?.exim_message_id;
  const raw = (h && String(h).trim()) || (e && String(e).trim()) || null;
  if (!raw) return null;
  return raw.replace(/^<+/, '').replace(/>+$/, '').trim() || null;
}


// ─────────────────────────────────────────────────────────────
// Helpers — execution-row writes.
// ─────────────────────────────────────────────────────────────

/**
 * Truncate a string-formed raw_input snapshot to RAW_INPUT_LIMIT
 * bytes, returning a JSON-safe replacement marker when truncation
 * occurs. raw_input is a JSON column — the marker is a valid JSON
 * object so the stored value is always parseable.
 *
 * Mirrors the spirit of hookService's slice-at-512KB pattern but
 * returns a structured envelope (matches what the prompt requested)
 * rather than a raw fragment.
 */
function _truncateRawInput(body) {
  let json;
  try {
    json = JSON.stringify(body);
  } catch {
    return { _truncated: true, _reason: 'body not JSON-stringifiable' };
  }
  if (json.length <= RAW_INPUT_LIMIT) {
    // Return the original object — JSON column will re-encode.
    return body;
  }
  return {
    _truncated:    true,
    _original_size: json.length,
    preview:       json.slice(0, RAW_INPUT_LIMIT - 200),  // headroom for marker bytes
  };
}

// JSON columns we explicitly stringify when the caller passes an object.
// (mysql2 will auto-encode, but being explicit keeps stored bytes
// predictable across mysql2 versions and avoids surprises if a future
// caller passes something unusual like a Date.)
const _JSON_COLS = new Set(['raw_input', 'metadata']);

async function _writeExecution(db, fields) {
  const cols = [];
  const placeholders = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(k);
    placeholders.push('?');
    if (_JSON_COLS.has(k) && v != null && typeof v === 'object') {
      values.push(JSON.stringify(v));
    } else {
      values.push(v);
    }
  }
  const [r] = await db.query(
    `INSERT INTO email_ingest_executions (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values
  );
  return r.insertId;
}


// ─────────────────────────────────────────────────────────────
// Helpers — message-body building for the log row.
//
// Mirror routes/logs.js's soft-cap on the message body. The log
// row's log_message column is text(65535) but every reader still
// renders the message — clipping at 50k chars (and appending an
// "[truncated]" marker) keeps the rendered preview tidy and
// avoids producing huge log_data blobs.
// ─────────────────────────────────────────────────────────────

function _bodyForLog(envelope) {
  // Prefer plain text; fall back to html with a noted-HTML marker.
  // We don't strip HTML — logService leaves the message text as-is,
  // and stripping html in the ingest path would lose structure for
  // any future viewer that wants to render it.
  let m = envelope?.text || envelope?.html || '';
  if (m.length > LOG_MESSAGE_SOFT_CAP) {
    m = m.slice(0, LOG_MESSAGE_SOFT_CAP) + '…[truncated]';
  }
  return m;
}


// ─────────────────────────────────────────────────────────────
// Helpers — validation.
//
// Required (per the worker prompt):
//   - kind === 'email'
//   - source (the resolved source row — the route owns this; the
//     service validates only the envelope shape)
//   - from.email non-empty with '@'
//   - at least one recipient: to[].email populated OR
//                              envelope.recipient populated
//
// Returns { valid: true } or { valid: false, error: <string> }.
// ─────────────────────────────────────────────────────────────

function _validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, error: 'envelope is not an object' };
  }
  if (envelope.kind !== 'email') {
    return { valid: false, error: `kind must be 'email', got ${JSON.stringify(envelope.kind)}` };
  }
  const fromEmail = envelope?.from?.email;
  if (!fromEmail || typeof fromEmail !== 'string' || !fromEmail.includes('@')) {
    return { valid: false, error: 'from.email is required and must contain @' };
  }
  const hasToList   = Array.isArray(envelope.to) && envelope.to.some(t => t && t.email);
  const hasEnvRcpt  = envelope?.envelope?.recipient && String(envelope.envelope.recipient).trim();
  if (!hasToList && !hasEnvRcpt) {
    return { valid: false, error: 'at least one of to[].email or envelope.recipient is required' };
  }
  return { valid: true };
}


// ─────────────────────────────────────────────────────────────
// Main pipeline.
//
// Returns one of:
//   { status: 'logged',               executionId, logId, emailLogId }
//   { status: 'duplicate',            executionId, emailLogId }
//   { status: 'skipped_firm_to_firm', executionId, emailLogId }
//   { status: 'skipped_suppression',  executionId, emailLogId }
//   { status: 'validation_failed',    executionId, error }
//   { status: 'error',                executionId, error }
//
// Always writes an email_ingest_executions row before returning
// (auth failures excepted — the route writes those). The execution
// row is best-effort: if THAT write fails, propagate the underlying
// error (route maps to 500) so the operator sees the storm. We
// don't try to ingest without a corresponding execution row.
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {{id:number,name:string}} source - auth-resolved source row
 * @param {object} envelope                - the canonical envelope (req.body)
 * @param {string} remoteIp                - req.ip
 * @param {object} [rawInputSnapshot]      - object to store in raw_input
 *                                            (caller may pre-truncate);
 *                                            if absent, we truncate envelope here.
 */
async function ingestEmail(db, source, envelope, remoteIp, rawInputSnapshot) {
  const rawInputForLog = rawInputSnapshot !== undefined
    ? rawInputSnapshot
    : _truncateRawInput(envelope);

  // ── 1. Validate envelope shape (kind + from + recipient).
  const vresult = _validateEnvelope(envelope);
  if (!vresult.valid) {
    const executionId = await _writeExecution(db, {
      source_id:  source.id,
      message_id: null,
      status:     'validation_failed',
      error:      vresult.error,
      raw_input:  rawInputForLog,
      remote_ip:  remoteIp || null,
    });
    return { status: 'validation_failed', executionId, error: vresult.error };
  }

  // ── 2. Resolve message_id.
  const messageId = _resolveMessageId(envelope);
  if (!messageId) {
    const executionId = await _writeExecution(db, {
      source_id:  source.id,
      message_id: null,
      status:     'validation_failed',
      error:      'no message-id resolvable (headers.message_id and envelope.exim_message_id both empty)',
      raw_input:  rawInputForLog,
      remote_ip:  remoteIp || null,
    });
    return {
      status:      'validation_failed',
      executionId,
      error:       'no message-id resolvable',
    };
  }

  // ── 3. Pre-check dedup on (source.name, messageId).
  //   This is a fast path that avoids the email_log INSERT when the
  //   row already exists. The INSERT IGNORE below catches the race
  //   window between this SELECT and the INSERT.
  const [existing] = await db.query(
    `SELECT id FROM email_log WHERE source = ? AND message_id = ? LIMIT 1`,
    [source.name, messageId]
  );
  if (existing.length > 0) {
    const executionId = await _writeExecution(db, {
      source_id:    source.id,
      message_id:   messageId,
      status:       'duplicate',
      log_id:       null,
      email_log_id: existing[0].id,
      raw_input:    rawInputForLog,
      remote_ip:    remoteIp || null,
    });
    return { status: 'duplicate', executionId, emailLogId: existing[0].id };
  }

  // ── 4. Build the forensic email_log payload.
  const fromEmail = String(envelope.from.email).trim();
  const toEmailFirst = _firstEmail(envelope.to)
    || (envelope?.envelope?.recipient ? String(envelope.envelope.recipient).trim() : '');
  const subject = envelope.subject != null ? String(envelope.subject) : '';
  const body    = envelope.text || envelope.html || '';
  const attachmentsStr = Array.isArray(envelope.attachments)
    ? JSON.stringify(envelope.attachments)
    : '[]';

  // ── 5. INSERT IGNORE the email_log row. Race-safe.
  const [insRes] = await db.query(
    `INSERT IGNORE INTO email_log
       (source, message_id, from_email, to_email, subject, body, attachments, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'))`,
    [source.name, messageId, fromEmail, toEmailFirst, subject, body, attachmentsStr]
  );

  let emailLogId;
  if (insRes.affectedRows === 0) {
    // Race: concurrent request inserted between our SELECT and INSERT.
    const [refetch] = await db.query(
      `SELECT id FROM email_log WHERE source = ? AND message_id = ? LIMIT 1`,
      [source.name, messageId]
    );
    if (refetch.length === 0) {
      // INSERT IGNORE didn't insert and we can't find the row — corrupt
      // state (perhaps another column triggered IGNORE for a different
      // reason). Don't claim success; report error.
      const executionId = await _writeExecution(db, {
        source_id:  source.id,
        message_id: messageId,
        status:     'error',
        error:      'INSERT IGNORE on email_log affected 0 rows but no existing row was found on refetch',
        raw_input:  rawInputForLog,
        remote_ip:  remoteIp || null,
      });
      return {
        status:      'error',
        executionId,
        error:       'email_log INSERT IGNORE no-op without matching existing row',
      };
    }
    // Treat as duplicate — the other concurrent request "won".
    emailLogId = refetch[0].id;
    const executionId = await _writeExecution(db, {
      source_id:    source.id,
      message_id:   messageId,
      status:       'duplicate',
      log_id:       null,
      email_log_id: emailLogId,
      raw_input:    rawInputForLog,
      remote_ip:    remoteIp || null,
    });
    return { status: 'duplicate', executionId, emailLogId };
  }
  emailLogId = insRes.insertId;

  // ── 6. Direction inference.
  const direction = inferDirection(fromEmail, FIRM_DOMAINS);

  // ── 7. Firm-to-firm check.
  //   Requires from + all to + all cc all on a firm domain.
  const allAddresses = _collectAllAddresses(envelope);
  if (isFirmToFirm(allAddresses, FIRM_DOMAINS)) {
    const executionId = await _writeExecution(db, {
      source_id:    source.id,
      message_id:   messageId,
      status:       'skipped_firm_to_firm',
      log_id:       null,
      email_log_id: emailLogId,
      raw_input:    rawInputForLog,
      remote_ip:    remoteIp || null,
    });
    return { status: 'skipped_firm_to_firm', executionId, emailLogId };
  }

  // ── 7b. Layer 2 — logging suppressions.
  //   Independent veto over the structured log row. Forensic email_log
  //   already written above; suppression only short-circuits createLogEntry.
  //   Boolean OR across active rules. Throwing rules fail-safe to non-match.
  //   Audit data lands in executions.metadata as { suppressed_by: [<ruleId>...] }.
  const suppression = await emailIngestSuppressionService.evaluateSuppressions(db, envelope);
  if (suppression.suppressed) {
    const executionId = await _writeExecution(db, {
      source_id:    source.id,
      message_id:   messageId,
      status:       'skipped_suppression',
      log_id:       null,
      email_log_id: emailLogId,
      metadata:     { suppressed_by: suppression.matchedRuleIds },
      raw_input:    rawInputForLog,
      remote_ip:    remoteIp || null,
    });
    return { status: 'skipped_suppression', executionId, emailLogId };
  }

  // ── 8. Write the structured log row via logService.
  //   link_id = the "other party" — for incoming, the sender; for
  //   outgoing, the first to-address (or envelope.recipient as
  //   fallback). logService normalizes (trim+lowercase) and validates
  //   the email; INVALID_LOG_LINK_ID is mapped to an execution error
  //   here (forensic row exists, just no structured log).
  const otherParty = direction === 'incoming'
    ? fromEmail
    : (toEmailFirst || '');

  const toJoined = _joinEmails(envelope.to) || toEmailFirst || '';

  // log_data carries the user-facing content. log_extra carries the
  // IT-facing forensic blob — source, message_id, cc list, reply_to,
  // attachment summaries, auth (spf/dkim/dmarc). Mirrors the
  // log_extra contract from logService Phase 3 Slice 1.
  const logData = {
    From:    fromEmail,
    To:      toJoined,
    Subject: subject,
    Message: _bodyForLog(envelope),
  };
  const logExtra = {
    source:      source.name,
    message_id:  messageId,
    attachments: Array.isArray(envelope.attachments) ? envelope.attachments : [],
    cc:          Array.isArray(envelope.cc)        ? envelope.cc.map(c => c?.email).filter(Boolean) : [],
    reply_to:    Array.isArray(envelope.reply_to)  ? envelope.reply_to.map(r => r?.email).filter(Boolean) : [],
    auth:        envelope.auth || null,
    envelope_date: envelope.date || null,
    received_at:   envelope.received_at || null,
  };

  let logId = null;
  try {
    const r = await logService.createLogEntry(db, {
      type:      'email',
      link_type: 'email',
      link_id:   otherParty,
      by:        0,
      data:      logData,
      extra:     logExtra,
      from:      fromEmail,
      to:        toJoined,
      subject,
      message:   logData.Message,
      direction,
    });
    logId = r.log_id;
  } catch (logErr) {
    if (logErr.code === 'INVALID_LOG_LINK_ID') {
      // Bad email shape on the "other party" side — happens for
      // outbound emails to address lists, malformed inbound senders,
      // etc. The email_log row above is the forensic trail; record
      // 'error' status on the execution and continue. We do NOT
      // upgrade this to a 400 — the email IS logged, just not as a
      // structured user-facing event.
      const executionId = await _writeExecution(db, {
        source_id:    source.id,
        message_id:   messageId,
        status:       'error',
        error:        `createLogEntry INVALID_LOG_LINK_ID: ${logErr.message}`,
        email_log_id: emailLogId,
        raw_input:    rawInputForLog,
        remote_ip:    remoteIp || null,
      });
      return {
        status:      'error',
        executionId,
        emailLogId,
        error:       logErr.message,
      };
    }
    // Any other error from logService — surface to the caller as
    // a 500. The email_log row above is the forensic record; the
    // structured log row failed. We do NOT write an execution row
    // here because the route's catch will (with 'error' status and
    // the same error string).
    throw logErr;
  }

  // ── 9. Success.
  const executionId = await _writeExecution(db, {
    source_id:    source.id,
    message_id:   messageId,
    status:       'logged',
    log_id:       logId,
    email_log_id: emailLogId,
    raw_input:    rawInputForLog,
    remote_ip:    remoteIp || null,
  });
  return { status: 'logged', executionId, logId, emailLogId };
}


module.exports = {
  // Pipeline
  authenticate,
  ingestEmail,

  // Helpers (exported for testability / cross-service use)
  parseFirmDomains,
  inferDirection,
  isFirmToFirm,

  // Module-level constants useful to tests
  RAW_INPUT_LIMIT,
};