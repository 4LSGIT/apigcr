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
 *     ├── Layer 2 suppression eval (any matching rule → skip default log; Slice 2.1)
 *     ├── Layer 3 automation eval (Slice 2.3 — ALWAYS runs, regardless of
 *     │   suppression OR downstream log-write outcome; matching rules' transforms
 *     │   run and their actions fire via lib/actionDispatchers + hookService).
 *     │   Slice 2.3.1 hoisted this above the log step so the architectural
 *     │   invariant ("layers are independent") holds even on the
 *     │   INVALID_LOG_LINK_ID error branch.
 *     └── conditional logService.createLogEntry (skipped iff suppressed; failures
 *         on INVALID_LOG_LINK_ID become 'error' status but still carry Layer 3
 *         outcomes in executions.metadata).
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
const emailIngestRuleService = require('./emailIngestRuleService');

const RAW_INPUT_LIMIT = 16 * 1024;            // 16 KB cap on raw_input snapshots
const LOG_MESSAGE_SOFT_CAP = 50000;           // mirror routes/logs.js soft cap

// The GAS test-replay marker. ref/gas.js:784's forwardTestTrigger() appends
// "-test-<base36 ts>-<rand6>" to the real Gmail message_id specifically so the
// (source, message_id) dedup below treats a re-POST as a NEW message and Layer 3
// fires again. Anything carrying it is a REPLAY of mail we have already handled.
const TEST_MESSAGE_ID_RE = /-test-/;

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

// Read via firmConfig per call (email_domains setting → EMAIL_DOMAINS /
// EMAIL_DOMAIN env), memoized on the raw value — live-editable, parsed once
// per distinct value.
const { cfg } = require('../lib/firmConfig');

let _domainsRaw = null;
let _domainsSet = new Set(['4lsg.com']);
function firmDomains() {
  const raw = cfg('email_domains');
  if (raw !== _domainsRaw) {
    _domainsRaw = raw;
    _domainsSet = new Set((raw && raw.trim()) ? _parseDomainList(raw) : ['4lsg.com']);
    console.log(`[emailIngest] firm domains: ${JSON.stringify([..._domainsSet])}`);
  }
  return _domainsSet;
}


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

/**
 * Build the executions.metadata JSON payload from suppression + automation
 * results. Returns null when there's nothing to record (no suppressions
 * matched, no automation rules matched, no parse warnings) — keeping the
 * column NULL for the "nothing interesting" baseline.
 *
 * Used by both the success path (step 9) and the INVALID_LOG_LINK_ID error
 * path inside the log-write catch (step 7d), so Layer 3 outcomes get
 * recorded even when the structured log row couldn't be written.
 */
function _buildMetadata(suppression, automation, isTest = false) {
  const m = {};
  // Recorded whenever set, even when nothing else is interesting: a test
  // envelope must be visible on the executions row, not inferred from the
  // message_id by whoever is reading the audit trail later.
  if (isTest) m.is_test = true;
  if (suppression && suppression.matchedRuleIds && suppression.matchedRuleIds.length) {
    m.suppressed_by = suppression.matchedRuleIds;
  }
  if (automation && automation.matchedRuleIds && automation.matchedRuleIds.length) {
    m.matched_rules   = automation.matchedRuleIds;
    m.action_outcomes = automation.actionOutcomes;
  }
  if (automation && automation.parseWarnings && automation.parseWarnings.length) {
    m._parse_warnings = automation.parseWarnings;
  }
  return Object.keys(m).length ? m : null;
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
//   { status: 'skipped_suppression',  executionId, logId:null, emailLogId }
//   { status: 'validation_failed',    executionId, error }
//   { status: 'error',                executionId, error }
//
// Layer 3 automation (Slice 2.3) runs on EVERY path that survives
// validation + dedup — including 'skipped_firm_to_firm' — its outcomes are
// recorded in the executions row's metadata, not in the return shape. The
// 'logged'/'skipped_*' status reflects the LOGGING layer only.
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

  // ── 2b. TEST-ENVELOPE DETECTION (Slice 4 Phase B).
  //   A GAS forwardTestTrigger() replay mangles the Gmail message_id into
  //   "<id>-test-<base36ts>-<rand6>" (ref/gas.js:784) for the EXPLICIT purpose
  //   of defeating the (source, message_id) dedup two steps below, so that
  //   Layer-3 rules fire again. Its own comment calls that "SAFER". It is not.
  //
  //   Until now the marker was honoured in exactly ONE place in the whole tree
  //   — courtExecutor.js:245, which forces dry-run — so the court executor was
  //   protected and every WORKFLOW rule was wide open. On 2026-06-10 a replay
  //   of ~17 already-processed court emails re-fired wf24/wf25 live and created
  //   10 duplicate deadline events. Detect the marker ONCE, here, and let
  //   emailIngestRuleService._dispatchAction refuse the dangerous action type.
  //
  //   Non-mutating spread (matches evaluateRules' own convention): the caller's
  //   object is untouched, and rawInputForLog was snapshotted from the ORIGINAL
  //   above so raw_input stays a faithful record of what arrived on the wire.
  const isTest = TEST_MESSAGE_ID_RE.test(messageId);
  if (isTest) {
    console.warn(`[emailIngest] TEST envelope — message_id carries -test-: ${messageId}. Workflow actions will be SKIPPED.`);
    envelope = { ...envelope, is_test: true };
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
  const direction = inferDirection(fromEmail, firmDomains());

  // ── 6b. Layer 3 — automation rules (ALWAYS runs).
  //   Hoisted in Slice 2.3.1 to before the log-write step so the layer-
  //   independence invariant holds even when createLogEntry throws
  //   INVALID_LOG_LINK_ID (or any other error). Hoisted again (above the
  //   firm-to-firm check) so automation also fires on internal
  //   firm-to-firm mail — the logging skip must not gate automation.
  //   Independent of the logging layer. Matching rules' transforms run
  //   and their actions fire via lib/actionDispatchers (+ hook re-entry).
  //   Outcomes land in executions.metadata via _buildMetadata.
  //
  //   evaluateRules is designed not to throw — action failures are captured
  //   per-action in actionOutcomes. The defensive try/catch here covers the
  //   case where the rule loader itself fails (e.g. DB hiccup): we don't
  //   want to 500 a successfully-logged email because automation evaluation
  //   blew up. Record the failure in _parse_warnings and continue.
  let automation;
  try {
    automation = await emailIngestRuleService.evaluateRules(db, envelope);
  } catch (autoErr) {
    console.error('[emailIngest] Layer 3 evaluateRules threw:', autoErr.message);
    automation = {
      matchedRuleIds: [],
      actionOutcomes: [],
      parseWarnings: [`evaluateRules threw: ${autoErr.message}`],
    };
  }

  // ── 7. Firm-to-firm check (logging skip ONLY — Layer 3 already ran at 6b).
  //   Requires from + all to + all cc all on a firm domain.
  const allAddresses = _collectAllAddresses(envelope);
  if (isFirmToFirm(allAddresses, firmDomains())) {
    const executionId = await _writeExecution(db, {
      source_id:    source.id,
      message_id:   messageId,
      status:       'skipped_firm_to_firm',
      log_id:       null,
      email_log_id: emailLogId,
      metadata:     _buildMetadata(null, automation, isTest),
      raw_input:    rawInputForLog,
      remote_ip:    remoteIp || null,
    });
    return { status: 'skipped_firm_to_firm', executionId, emailLogId };
  }

  // ── 7b. Layer 2 — logging suppressions (decide the structured log row).
  //   Independent veto over the structured log row ONLY. Forensic email_log
  //   is already written above; suppression short-circuits createLogEntry but
  //   does NOT gate Layer 3 automation (step 6b). Boolean OR across active
  //   rules. Throwing rules fail-safe to non-match. Audit lands in
  //   executions.metadata as { suppressed_by: [<ruleId>...] }.
  const suppression = await emailIngestSuppressionService.evaluateSuppressions(db, envelope);

  // ── 7d. Conditional default log.
  //   link_id = the "other party" — for incoming, the sender; for outgoing,
  //   the first to-address (or envelope.recipient fallback). logService
  //   normalizes + validates the email. INVALID_LOG_LINK_ID is handled below
  //   as an execution error (forensic row exists; just no structured log).
  //   Skipped entirely when suppressed.
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
  if (!suppression.suppressed) {
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
        // Bad email shape on the "other party" side — happens for outbound
        // emails to address lists, malformed inbound senders, etc. The
        // email_log row above is the forensic trail; record 'error' status
        // and return.
        //
        // Slice 2.3.1: Layer 3 has already run above, so its outcomes are
        // captured in metadata even on this branch. Layer independence holds:
        // an automation rule that doesn't depend on log_id (which is none of
        // them, since actions consume the envelope, not the log row) still
        // fires for emails whose other-party address is malformed.
        const executionId = await _writeExecution(db, {
          source_id:    source.id,
          message_id:   messageId,
          status:       'error',
          error:        `createLogEntry INVALID_LOG_LINK_ID: ${logErr.message}`,
          email_log_id: emailLogId,
          metadata:     _buildMetadata(suppression, automation, isTest),
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
      // Any other error from logService — surface to the caller as a 500.
      // The route's catch writes the execution row with 'error' status.
      // Layer 3 has already fired; the route will not record automation
      // outcomes on this path. Acceptable: unexpected logService errors are
      // operator-attention events, and Layer 3's action_outcomes are still
      // observable via the dispatched workflows/sequences/hooks themselves.
      throw logErr;
    }
  }

  // ── 8. Determine final status (logging-layer outcome only).
  const status = suppression.suppressed ? 'skipped_suppression' : 'logged';

  // ── 9. Build metadata via the shared helper.
  const metadata = _buildMetadata(suppression, automation, isTest);

  // ── 10. Write the executions row + return.
  const executionId = await _writeExecution(db, {
    source_id:    source.id,
    message_id:   messageId,
    status,
    log_id:       logId,
    email_log_id: emailLogId,
    metadata,
    raw_input:    rawInputForLog,
    remote_ip:    remoteIp || null,
  });

  return { status, executionId, logId, emailLogId };
}


module.exports = {
  // Pipeline
  authenticate,
  ingestEmail,

  // Helpers (exported for testability / cross-service use)
  inferDirection,
  isFirmToFirm,

  // Module-level constants useful to tests
  RAW_INPUT_LIMIT,
  TEST_MESSAGE_ID_RE,
};