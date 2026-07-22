// services/esignWebhookService.js
//
/**
 * E-Sign INBOUND — webhook parsing, the shared status-change choke point, and
 * the log-writing seam.
 * services/esignWebhookService.js
 *
 * Phase 1C. Three things live here, and they are here together because they
 * are the same concern seen from three angles: what the provider told us, what
 * that means for the row, and what a human should see about it.
 *
 *   handleZohoWebhook()    the route's entire body. Parse → find row → decide.
 *   processStatusChange()  THE choke point. Every status change that can
 *                          trigger filing or an alert goes through this one
 *                          function, whoever noticed it.
 *   the log hook           wired at module load; turns audit events into
 *                          `log` rows.
 *
 * ── WHY processStatusChange IS EXPORTED ─────────────────────────────────────
 * There are two ways to learn a document was signed: Zoho tells us (webhook)
 * or we ask (the nightly reconciliation job, lib/internal_functions/esign.js).
 * Both must download the PDF, file it to Dropbox, write the same log row and
 * raise the same task on failure. If reconciliation reimplemented that against
 * raw esignService, the two paths would drift, and they would drift in the
 * least visible direction: the rare path — the one that only runs when a
 * webhook was MISSED — is exactly the one nobody exercises by hand.
 *
 * So: one function, two callers. The `source` argument is the only difference
 * between them, and it exists purely so the audit trail records which route
 * noticed the change.
 *
 * ── WIRING ──────────────────────────────────────────────────────────────────
 * The log hook is installed at the bottom of this file, on require. The
 * webhook route requires this module, and routes are require()d at boot by
 * server.js's readdir auto-mount, so the hook is live process-wide before any
 * request or job runs. startup/init.js is a documented no-op kept only for
 * back-compat and is NOT the place for new wiring.
 */
const crypto = require('crypto');

const esignService = require('./esignService');
const esignFilingService = require('./esignFilingService');
const esignAlertService = require('./esignAlertService');
const logService = require('./logService');
const { getProvider } = require('./esign');
const { mapRequestStatus, mapActionStatus } = require('./esign/zohoSignProvider');

/** app_settings key holding the shared secret in the webhook URL. */
const WEBHOOK_TOKEN_KEY = 'esign_webhook_token';

/**
 * app_settings key holding Zoho's webhook secret key (the one Zoho shows in
 * its webhook configuration UI). EMPTY = HMAC verification is OFF entirely —
 * the endpoint runs on the URL token alone, exactly as it did before this
 * feature existed. Setting it arms verification in whatever mode
 * WEBHOOK_HMAC_MODE_KEY selects.
 */
const WEBHOOK_SECRET_KEY = 'esign_webhook_secret';

/**
 * app_settings key selecting the HMAC posture once a secret is set:
 *
 *   'enforce'        — a delivery whose signature is missing, uncomputable
 *                      (no raw body) or wrong is REJECTED with 401.
 *   anything else    — LOG-ONLY: verification runs and its verdict is logged,
 *   (incl. unset)      but no delivery is ever rejected for it.
 *
 * Log-only is the deliberate default because the signature header has never
 * been OBSERVED on a live delivery — the header name and encoding come from
 * Zoho's documentation, not from a captured request. Arming 'enforce' on an
 * untested assumption would silently stop ALL inbound signing status (the
 * endpoint fails closed) until nightly reconciliation caught up. The rollout
 * is therefore: set the secret → watch the logs report 'match' on a real
 * delivery → flip this to 'enforce'.
 */
const WEBHOOK_HMAC_MODE_KEY = 'esign_webhook_hmac_mode';

/**
 * The header Zoho signs deliveries with: base64(HMAC-SHA256(secret, rawBody)).
 * Express lower-cases incoming header names; req.get() is case-insensitive
 * anyway. Kept here so the route and the tests share one spelling.
 */
const SIGNATURE_HEADER = 'x-zs-webhook-signature';

/** The only provider with a webhook route today. */
const PROVIDER = 'zoho_sign';

/**
 * Window for the duplicate-event guard, in seconds. Zoho retries a webhook it
 * believes failed; a retry arriving inside this window with the same event
 * name for the same recipient is treated as the same notification.
 *
 * Deliberately NOT keyed on a provider-side notification id: no such field is
 * documented, and inventing a dedupe key out of a payload shape nobody has
 * confirmed would be worse than a time window. The parser records every
 * id-shaped field it finds into the stored payload, so once a real delivery
 * has been observed this can be tightened to whatever Zoho actually sends.
 */
const DUPLICATE_WINDOW_SECONDS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// LOG HOOK  (Task 3)
//
// esignService fires its hook from _insertEvent, which runs for EVERY audit
// row — including 'created' when a draft is minted and 'viewed' on every
// recipient open. Logging all of them would bury the case log in plumbing, so
// the hook filters.
//
// LOGGED: the events a person reading a case file needs to see.
// NOT LOGGED: 'created' (a draft is not a fact about the client yet) and
//             'viewed' (high-volume, low-signal — the audit table keeps it).
// ─────────────────────────────────────────────────────────────────────────────

const LOGGED_EVENTS = new Set([
  'sent', 'signed', 'declined', 'bounced', 'recalled', 'expired', 'reminded',
]);

/**
 * Direction, from the FIRM's point of view.
 *
 * wf30/wf31 stamp 'incoming' on everything because they parse an inbound
 * Adobe notification email — the direction described the email, not the act.
 * Here we are the actor for half these events, so the split is meaningful:
 * a case log that shows "we sent it" and "they signed it" as different
 * directions reads correctly in the UI's incoming/outgoing rendering.
 */
const OUTGOING_EVENTS = new Set(['sent', 'reminded', 'recalled']);

/**
 * Event names that suggest the invitation never arrived. Used ONLY to raise a
 * staff task, never to move a row — see the bounce block in handleZohoWebhook.
 */
const BOUNCE_HINT = /bounce|undeliver|delivery_fail|failed_deliver|not_deliver/;

/**
 * Turn one audit event into a `log` row.
 *
 * Shape follows wf30 step 13 / wf31 step 7 verbatim — log_type 'esign',
 * log_by 0, structured `data` — so Adobe-era rows and Zoho-era rows render
 * identically in the case log and nobody has to know which system produced
 * which. `by: 0` is a constant: these are machine events. Who ASKED for the
 * send is a fact about the request, and it travels in data.created_by rather
 * than in log_by, which is a tinyint meant for a user id.
 */
async function writeEventLog(db, ev) {
  const request = ev && ev.request;
  if (!request) return;                       // nothing to link to
  if (!LOGGED_EVENTS.has(ev.event)) return;

  const data = {
    event:       ev.event,
    source:      request.provider || PROVIDER,
    tracking_id: request.tracking_id,
    kind:        request.kind,
    ...(request.provider_id ? { provider_id: request.provider_id } : {}),
    ...(request.created_by ? { created_by: request.created_by } : {}),
    ...(ev.recipient_email ? { recipient: ev.recipient_email } : {}),
    ...(ev.event === 'signed' && request.signed_pdf_path
      ? { signed_pdf_path: request.signed_pdf_path } : {}),
    ...(ev.event === 'signed' && request.cert_pdf_path
      ? { cert_pdf_path: request.cert_pdf_path } : {}),
  };

  const recipientList = Array.isArray(request.recipients) ? request.recipients : [];
  const counterparty = ev.recipient_email || (recipientList[0] && recipientList[0].email) || null;
  const outgoing = OUTGOING_EVENTS.has(ev.event);

  await logService.createLogEntry(db, {
    type:      'esign',
    link_type: request.linkable_type,          // 'case' | 'contact'
    link_id:   request.linkable_id,
    by:        0,                              // machine event — see above
    subject:   `E-sign ${ev.event}: ${request.document_name || request.kind}`,
    direction: outgoing ? 'outgoing' : 'incoming',
    ...(outgoing ? { to: counterparty } : { from: counterparty }),
    data,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constant-time string compare.
 *
 * timingSafeEqual THROWS on a length mismatch, which would itself leak length
 * and turn a bad token into a 500. Hashing both sides first makes the operands
 * unconditionally 32 bytes, so the comparison is both safe and total.
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Read the webhook secret.
 *
 * Queried DIRECTLY rather than through the get_setting internal function,
 * which refuses is_secret rows by design (lib/internal_functions/system.js) —
 * that refusal protects automation authors from leaking secrets into workflow
 * variables and is not meant to stop the app's own code reading its own
 * secret. settingsService.getSetting does the same plain read; it is inlined
 * here only to keep the is_secret intent visible at the point of use.
 */
async function getWebhookToken(db) {
  const [[row]] = await db.query(
    'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1',
    [WEBHOOK_TOKEN_KEY]
  );
  const v = row && row.value;
  return v == null || String(v).trim() === '' ? null : String(v).trim();
}

/**
 * @returns {Promise<{ok:boolean, reason?:string}>}
 *
 * ROTATION SUPPORT: the setting may hold SEVERAL tokens, comma-separated —
 * any one of them passes. Zero-downtime rotation is therefore a pure data
 * operation, no redeploy:
 *
 *   1. value = 'NEW,OLD'                 (both accepted)
 *   2. update the URL in Zoho's console  (Zoho now presents NEW)
 *   3. value = 'NEW'                     (OLD dies)
 *
 * Every candidate is still compared in constant time; the loop runs over ALL
 * candidates unconditionally (no early return) so a match's position in the
 * list is not observable either.
 */
async function verifyToken(db, presented) {
  let expected;
  try {
    expected = await getWebhookToken(db);
  } catch (err) {
    console.error(`[ESIGN WEBHOOK] could not read ${WEBHOOK_TOKEN_KEY}: ${err.message}`);
    return { ok: false, reason: 'token_unreadable' };
  }
  // Fail CLOSED. An unset secret means the endpoint is not configured, and an
  // unauthenticated status-mutation endpoint is worse than a broken one.
  if (!expected) return { ok: false, reason: 'token_unset' };
  if (!presented) return { ok: false, reason: 'token_missing' };
  const candidates = expected.split(',').map((s) => s.trim()).filter(Boolean);
  if (candidates.length === 0) return { ok: false, reason: 'token_unset' };
  let matched = false;
  for (const c of candidates) {
    if (safeEqual(presented, c)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: 'token_mismatch' };
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC  (X-ZS-WEBHOOK-SIGNATURE)
//
// Zoho signs each delivery: base64(HMAC-SHA256(webhook secret, raw body)).
// This is verification of the BYTES ON THE WIRE, which is why req.rawBody
// (captured by server.js's verify hooks before any parser touches the stream)
// is the only acceptable input — re-serializing req.body can produce different
// bytes and a false mismatch. A delivery that reached the handler without a
// captured raw body is 'raw_body_unavailable', never silently passed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the HMAC config. One query, both keys; missing rows tolerated (feature
 * simply off until the migration runs — code-before-SQL is inert by design).
 * Same direct-read posture as getWebhookToken (see its comment).
 *
 * @returns {Promise<{secret:string|null, mode:'off'|'log'|'enforce'}>}
 */
async function getHmacConfig(db) {
  const [rows] = await db.query(
    'SELECT `key`, `value` FROM app_settings WHERE `key` IN (?, ?)',
    [WEBHOOK_SECRET_KEY, WEBHOOK_HMAC_MODE_KEY]
  );
  let secret = null;
  let modeRaw = '';
  for (const r of rows || []) {
    if (r.key === WEBHOOK_SECRET_KEY) secret = r.value == null ? null : String(r.value).trim() || null;
    if (r.key === WEBHOOK_HMAC_MODE_KEY) modeRaw = r.value == null ? '' : String(r.value).trim();
  }
  if (!secret) return { secret: null, mode: 'off' };
  return { secret, mode: modeRaw === 'enforce' ? 'enforce' : 'log' };
}

/**
 * Verify a delivery's signature against the configured secret.
 *
 * Never throws for a bad input — every outcome is a verdict object, because
 * the ROUTE decides what a verdict costs (log mode: nothing; enforce mode:
 * a 401). A config-read failure is reported as its own reason so enforce mode
 * fails CLOSED on it, matching verifyToken's 'token_unreadable' posture.
 *
 * Diagnostic courtesy (the 9011 lesson — make the wrong assumption visible in
 * one look): on a base64 mismatch the HEX digest is also compared, and a hex
 * match is reported as its own reason. If Zoho turns out to encode the
 * signature as hex rather than base64, the very first log-mode line says so
 * instead of leaving a generic mismatch to bisect.
 *
 * @param {object} db
 * @param {object} o
 * @param {Buffer|string|null} o.rawBody verbatim request bytes. A Buffer is
 *   used as-is (byte-exact); a string is encoded back to UTF-8 bytes, which
 *   round-trips correctly for any valid-UTF-8 payload but not for invalid
 *   sequences — callers with access to the wire Buffer should pass it.
 * @param {string|null} o.signature presented X-ZS-WEBHOOK-SIGNATURE value
 * @returns {Promise<{mode:'off'|'log'|'enforce', ok:boolean, reason:string, presented?:string, expected?:string}>}
 */
async function evaluateHmac(db, { rawBody = null, signature = null } = {}) {
  let cfg;
  try {
    cfg = await getHmacConfig(db);
  } catch (err) {
    console.error(`[ESIGN WEBHOOK] could not read HMAC config: ${err.message}`);
    return { mode: 'enforce', ok: false, reason: 'config_unreadable' };
  }
  if (cfg.mode === 'off') return { mode: 'off', ok: true, reason: 'disabled' };

  const trunc = (s) => (s == null ? null : String(s).slice(0, 16));

  if (rawBody == null) {
    return { mode: cfg.mode, ok: false, reason: 'raw_body_unavailable', presented: trunc(signature) };
  }
  const presented = signature == null ? '' : String(signature).trim();
  if (!presented) {
    return { mode: cfg.mode, ok: false, reason: 'signature_missing' };
  }

  const macInput = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const mac = crypto.createHmac('sha256', cfg.secret).update(macInput);
  // .digest() consumes the hmac — compute once, encode twice.
  const digest = mac.digest();
  const b64 = digest.toString('base64');
  const hex = digest.toString('hex');

  if (safeEqual(presented, b64)) {
    return { mode: cfg.mode, ok: true, reason: 'match' };
  }
  if (safeEqual(presented, hex) || safeEqual(presented.toLowerCase(), hex)) {
    // Right MAC, wrong encoding assumption on OUR side. Not accepted — the
    // contract is base64 until a live delivery proves otherwise — but named
    // loudly so the fix is a one-liner, not a hunt.
    return { mode: cfg.mode, ok: false, reason: 'mismatch_but_hex_encoding_matched', presented: trunc(presented) };
  }
  return {
    mode: cfg.mode, ok: false, reason: 'signature_mismatch',
    presented: trunc(presented), expected: trunc(b64),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD PARSING
//
// ⚠ THE SHAPE BELOW IS INFERRED, NOT DOCUMENTED. ⚠
//
// Zoho publishes no webhook payload reference for Zoho Sign that could be
// found from the public API docs (zoho.com/sign/api/ has no webhooks section).
// The one hard datum is a Zoho support thread in which a Deluge handler reads
// `mapPayload.get("notifications")` — so a top-level `notifications` key
// exists. Everything else here is inference from the REST responses.
//
// The parser is therefore written to be WRONG SAFELY:
//
//   1. It hunts for request_id / request_status across several plausible
//      shapes instead of asserting one.
//   2. The STATUS DECISION NEVER DEPENDS ON THE GUESSED PART. Status comes
//      from `request_status`, whose vocabulary was verified against the live
//      API in 1B and is mapped by the same exported table the poller uses.
//      The undocumented `operation_type` only ever LABELS an audit row — it
//      can never drive a state transition.
//   3. Every delivery stores the body verbatim, so one real notification
//      turns all of this into fact. scripts/esign_e2e_check.js --verify
//      prints those captured payloads for exactly that purpose.
//
// Until then: an unparseable body is a 200 with a warning and a stored
// payload. Never a 500 — a 5xx invites a retry storm, and retrying will not
// make an unknown shape parseable.
// ─────────────────────────────────────────────────────────────────────────────

/** Keys whose values, if id-shaped, might serve as a future dedupe key. */
const ID_HINT_KEYS = [
  'notification_id', 'event_id', 'webhook_id', 'log_id', 'activity_id', 'action_id',
];

/**
 * Bounded search for the first object owning any of `keys`.
 * Breadth-first, depth-capped — the payload is untrusted input and a
 * pathological nesting must not become a stack overflow.
 */
function _findOwner(root, keys, maxDepth = 5) {
  const queue = [[root, 0]];
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (!Array.isArray(node) && keys.some((k) => node[k] !== undefined)) return node;
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') queue.push([v, depth + 1]);
    }
  }
  return null;
}

/** First non-empty value for any of `keys`, anywhere shallow in the payload. */
function _findValue(root, keys, maxDepth = 5) {
  const owner = _findOwner(root, keys, maxDepth);
  if (!owner) return null;
  for (const k of keys) {
    const v = owner[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/**
 * Coerce whatever body-parser produced into a plain object.
 *
 * Three inbound forms are handled, because we do not know which Zoho uses:
 *   - application/json          → express.json already gave us an object
 *   - x-www-form-urlencoded     → an object, possibly with a `data` field
 *                                 carrying JSON (Zoho's own REST API takes
 *                                 parameters that way, so it is plausible
 *                                 their webhook emits it)
 *   - anything else / no type   → a raw string from the route's scoped text
 *                                 parser
 *
 * @returns {{obj:object|null, note:string|null}}
 */
function coerceBody(body) {
  if (body == null) return { obj: null, note: 'empty body' };

  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return { obj: null, note: 'empty body' };
    try { return { obj: JSON.parse(trimmed), note: null }; }
    catch { return { obj: null, note: 'body was not valid JSON' }; }
  }

  if (typeof body === 'object' && !Array.isArray(body)) {
    // urlencoded `data=<json>` — unwrap, but keep the wrapper's other fields.
    if (typeof body.data === 'string' && body.data.trim().startsWith('{')) {
      try {
        const inner = JSON.parse(body.data);
        return { obj: { ...body, ...inner }, note: 'unwrapped urlencoded data field' };
      } catch { /* fall through — keep the outer object */ }
    }
    return { obj: body, note: null };
  }

  return { obj: null, note: `unusable body type: ${typeof body}` };
}

/**
 * Extract what we need from a Zoho Sign webhook delivery.
 *
 * @returns {{
 *   ok: boolean, providerId: string|null, providerStatus: string|null,
 *   actions: Array, operationType: string|null, performedByEmail: string|null,
 *   occurredAt: string|null, documentName: string|null, hintIds: object,
 *   raw: *, notes: string[]
 * }}
 */
function parseZohoWebhook(body) {
  const notes = [];
  const { obj, note } = coerceBody(body);
  if (note) notes.push(note);

  const out = {
    ok: false,
    providerId: null, providerStatus: null, actions: [],
    operationType: null, performedByEmail: null, occurredAt: null,
    documentName: null, hintIds: {}, raw: obj ?? body ?? null, notes,
  };
  if (!obj) return out;

  // `requests` is the container in every REST response; assume the webhook
  // mirrors it, but do not require it.
  let reqNode = obj.requests ?? obj.request ?? null;
  if (Array.isArray(reqNode)) reqNode = reqNode[0] ?? null;

  const owner = (reqNode && typeof reqNode === 'object' && reqNode.request_id !== undefined)
    ? reqNode
    : _findOwner(obj, ['request_id', 'request_status']);

  if (owner) {
    if (owner.request_id != null && String(owner.request_id).trim() !== '') {
      out.providerId = String(owner.request_id).trim();
    }
    if (owner.request_status != null && String(owner.request_status).trim() !== '') {
      out.providerStatus = String(owner.request_status).trim();
    }
    if (Array.isArray(owner.actions)) out.actions = owner.actions;
    if (owner.request_name != null) out.documentName = String(owner.request_name);
  }

  // Last resort: request_id may sit somewhere we did not anticipate.
  if (!out.providerId) {
    const v = _findValue(obj, ['request_id', 'requestId']);
    if (v != null) {
      out.providerId = String(v).trim();
      notes.push('request_id was found outside the expected container');
    }
  }
  if (!out.providerStatus) {
    const v = _findValue(obj, ['request_status', 'requestStatus', 'status']);
    if (v != null) {
      out.providerStatus = String(v).trim();
      notes.push('request_status was found outside the expected container');
    }
  }

  // Event metadata — LABELS ONLY. Never feeds a transition.
  const notif = obj.notifications ?? obj.notification ?? null;
  const notifNode = Array.isArray(notif) ? (notif[0] ?? null) : notif;
  const metaOwner = (notifNode && typeof notifNode === 'object') ? notifNode : obj;

  const op = metaOwner.operation_type ?? metaOwner.operationType
          ?? metaOwner.activity ?? metaOwner.event_type ?? null;
  if (op != null && String(op).trim() !== '') out.operationType = String(op).trim();

  const who = metaOwner.performed_by_email ?? metaOwner.performedByEmail
           ?? metaOwner.recipient_email ?? metaOwner.email ?? null;
  if (who != null && String(who).includes('@')) {
    out.performedByEmail = String(who).trim().toLowerCase();
  }

  const when = metaOwner.performed_at ?? metaOwner.performedAt
            ?? metaOwner.action_time ?? metaOwner.time ?? null;
  if (when != null && String(when).trim() !== '') {
    const n = Number(when);
    const d = Number.isFinite(n) && String(when).trim() !== '' ? new Date(n) : new Date(String(when));
    if (!Number.isNaN(d.getTime())) out.occurredAt = d.toISOString();
  }

  for (const k of ID_HINT_KEYS) {
    const v = metaOwner[k] ?? obj[k];
    if (v != null && String(v).trim() !== '') out.hintIds[k] = String(v);
  }

  out.ok = Boolean(out.providerId);
  if (!out.ok) notes.push('no request_id could be located in the payload');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE GUARD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Has an identical audit event landed inside the dedupe window?
 *
 * `created_at` (our ingest time), not `occurred_at` (the provider's claim):
 * the question is "did WE already record this", and a retry carries the same
 * original occurred_at, which would make an occurred_at comparison match
 * forever rather than for five minutes.
 */
async function isDuplicateEvent(db, requestId, event, recipientEmail) {
  try {
    const [[row]] = await db.query(
      `SELECT id FROM signing_request_events
        WHERE signing_request_id = ?
          AND event = ?
          AND recipient_email <=> ?
          AND created_at >= (NOW() - INTERVAL ? SECOND)
        LIMIT 1`,
      [requestId, event, recipientEmail || null, DUPLICATE_WINDOW_SECONDS]
    );
    return Boolean(row);
  } catch (err) {
    // Fail OPEN: a duplicate audit row is noise; a dropped one is a hole in a
    // legal trail. Noise wins.
    console.warn(`[ESIGN WEBHOOK] duplicate check failed, recording anyway: ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CHOKE POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a provider-reported status to a request, and do everything that
 * follows from it: file the documents, alert a human, leave an audit trail.
 *
 * Shared by the webhook and the reconciliation job — see the header.
 *
 * @param {object} db
 * @param {object} request        a shaped signing_requests row
 * @param {object} o
 * @param {string|null} o.status          OUR status, or null if unmapped
 * @param {string|null} [o.providerStatus] the raw vendor string, for the trail
 * @param {Array|null}  [o.recipients]     neutral recipients, if known
 * @param {*}           [o.raw]            payload to persist
 * @param {string|null} [o.occurredAt]
 * @param {string|null} [o.recipientEmail]
 * @param {object|null} [o.provider]       provider instance; built on demand
 * @param {'webhook'|'reconcile'} [o.source='webhook']
 * @returns {Promise<object>} a summary — never throws for expected outcomes
 */
async function processStatusChange(db, request, {
  status, providerStatus = null, recipients = null, raw = null,
  occurredAt = null, recipientEmail = null, provider = null, source = 'webhook',
} = {}) {
  const result = {
    requestId: request.id, source,
    status, providerStatus,
    changed: false, reason: null,
    filed: false, filing: null, alerted: false,
  };

  // ── unmapped vendor status ────────────────────────────────────────────────
  // 1B's mapping table returns null rather than guessing. Record it, alert
  // nobody, transition nothing — a status we cannot read must not move a row.
  if (!status) {
    result.reason = 'unmapped_status';
    console.warn(
      `[ESIGN ${source.toUpperCase()}] request ${request.id}: provider status ` +
      `"${providerStatus}" is not in the mapping table — recording an event only`
    );
    await esignService.appendEvent(db, request.id, {
      event: 'provider_status_unmapped',
      recipientEmail,
      occurredAt,
      payload: { provider_status: providerStatus, source, raw },
    });
    return result;
  }

  // ── the transition ────────────────────────────────────────────────────────
  let applied;
  try {
    applied = await esignService.applyStatus(db, request.id, {
      status, recipients, raw, occurredAt, recipientEmail,
    });
  } catch (err) {
    // INVALID_ESIGN_TRANSITION is a real bug (draft → viewed). Terminal and
    // noop are NOT errors and never reach here — applyStatus soft-refuses
    // those. So anything caught here deserves to be loud.
    result.reason = 'transition_error';
    result.error = err.message;
    console.error(`[ESIGN ${source.toUpperCase()}] request ${request.id}: ${err.message}`);
    await esignService.appendEvent(db, request.id, {
      event: 'status_apply_failed',
      occurredAt,
      payload: { attempted: status, provider_status: providerStatus, error: err.message, source },
    }).catch(() => {});
    return result;
  }

  result.changed = applied.changed;
  result.reason  = applied.reason || null;

  if (!applied.changed) {
    // Routine: a re-delivered webhook, or reconciliation confirming what the
    // webhook already handled. Nothing to do and nothing to say.
    console.log(
      `[ESIGN ${source.toUpperCase()}] request ${request.id}: ${status} — ` +
      `no change (${applied.reason})`
    );
    return result;
  }

  const updated = applied.request;

  // ── signed → file the paperwork ───────────────────────────────────────────
  if (status === 'signed') {
    let prov = provider;
    if (!prov) {
      try {
        prov = await getProvider(db, updated.provider);
      } catch (err) {
        result.filing = { filed: false, reason: 'no_provider', note: err.message };
      }
    }

    if (prov) {
      result.filing = await esignFilingService.fileSignedDocuments(db, updated, { provider: prov });
      result.filed  = Boolean(result.filing.filed);
    }

    await _announceFiling(db, updated, result);
  }

  // ── declined / bounced → tell someone, loudly ─────────────────────────────
  if (status === 'declined' || status === 'bounced') {
    result.alerted = await _announceFailure(db, updated, status, recipientEmail);
  }

  return result;
}

/** Task + audit row describing how filing went. */
async function _announceFiling(db, request, result) {
  const f = result.filing || {};
  const label = request.document_name || request.kind;

  if (f.filed && !f.warnings?.length) {
    await esignService.appendEvent(db, request.id, {
      event: 'filed',
      payload: { signed_pdf_path: f.signedPdfPath, cert_pdf_path: f.certPdfPath, source: result.source },
    }).catch((e) => console.error(`[ESIGN] could not record filing event: ${e.message}`));
    return;
  }

  if (f.reason === 'already_filed') return;   // idempotent replay — say nothing

  // Anything else is a human's problem. Say exactly what happened and what
  // is left to do; a task that only says "filing failed" costs a person the
  // ten minutes we just saved them.
  const lines = [
    `A signed document came back from Zoho Sign but could not be filed to Dropbox automatically.`,
    ``,
    `Document: ${label}`,
    `Tracking: ${request.tracking_id}`,
    `Linked to: ${request.linkable_type} ${request.linkable_id}`,
  ];
  if (f.note) lines.push(``, `Reason: ${f.note}`);
  for (const w of (f.warnings || [])) lines.push(``, `Note: ${w}`);
  lines.push(
    ``,
    f.filed
      ? `The signed document IS in Dropbox — see the notes above for what still needs doing.`
      : `Action: download the signed document from the Zoho Sign dashboard and file it by hand.`
  );

  const alert = await esignAlertService.raiseTask(db, {
    title: `File signed doc manually: ${label}`,
    desc: lines.join('\n'),
    linkableType: request.linkable_type,
    linkableId: request.linkable_id,
  });
  result.alerted = Boolean(alert.ok);

  await esignService.appendEvent(db, request.id, {
    event: 'filing_needs_attention',
    payload: {
      filed: Boolean(f.filed), reason: f.reason || null,
      note: f.note || null, warnings: f.warnings || [],
      task_id: alert.taskId || null, source: result.source,
    },
  }).catch((e) => console.error(`[ESIGN] could not record filing-attention event: ${e.message}`));
}

/** Loud task for a declined or bounced envelope. */
async function _announceFailure(db, request, status, recipientEmail) {
  const label = request.document_name || request.kind;
  const who = recipientEmail
    || (Array.isArray(request.recipients) && request.recipients[0] && request.recipients[0].email)
    || 'the recipient';

  const body = status === 'declined'
    ? [
        `${who} DECLINED to sign this document.`,
        ``,
        `Document: ${label}`,
        `Tracking: ${request.tracking_id}`,
        `Linked to: ${request.linkable_type} ${request.linkable_id}`,
        ``,
        `Zoho does not pass on a decline reason, so the client has to be asked directly.`,
        `Nothing further happens automatically — this envelope is closed and a replacement`,
        `must be sent if the document is still needed.`,
      ]
    : [
        `The signing invitation for this document BOUNCED — ${who} never received it.`,
        ``,
        `Document: ${label}`,
        `Tracking: ${request.tracking_id}`,
        `Linked to: ${request.linkable_type} ${request.linkable_id}`,
        ``,
        `Action: confirm the correct email address, fix it on the contact record, then`,
        `re-send. A bounced request can be re-sent without starting over.`,
      ];

  const alert = await esignAlertService.raiseTask(db, {
    title: `E-sign ${status.toUpperCase()}: ${label}`,
    desc: body.join('\n'),
    linkableType: request.linkable_type,
    linkableId: request.linkable_id,
  });
  return Boolean(alert.ok);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WEBHOOK ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle one inbound Zoho delivery. Called by the route AFTER it has already
 * responded 200 — see routes/api.esign.js for why.
 *
 * Returns a summary for logs and tests. Throws only if something truly
 * unexpected happens; the route catches and logs regardless.
 *
 * @param {object} db
 * @param {object} o
 * @param {*} o.body            parsed body (object) or raw string
 * @param {string} [o.rawBody]  the verbatim bytes, when available
 * @param {string} [o.ip]
 */
async function handleZohoWebhook(db, { body, rawBody = null, ip = null } = {}) {
  const parsed = parseZohoWebhook(body);
  const stored = parsed.raw ?? (rawBody != null ? { unparsed_body: String(rawBody).slice(0, 20000) } : null);

  // ── unparseable ───────────────────────────────────────────────────────────
  // Nothing to attach it to, so there is nowhere to store it but the log.
  // Truncated, because an attacker who has the token could otherwise fill the
  // Cloud Run log with a single request.
  if (!parsed.ok) {
    console.warn(
      `[ESIGN WEBHOOK] could not identify a request from this delivery ` +
      `(${parsed.notes.join('; ') || 'no notes'}) from ip=${ip || 'unknown'}. ` +
      `Body head: ${JSON.stringify(stored).slice(0, 1000)}`
    );
    return { ok: true, action: 'unparseable', notes: parsed.notes };
  }

  // ── find the row ──────────────────────────────────────────────────────────
  let request;
  try {
    request = await esignService.getByProviderId(db, PROVIDER, parsed.providerId);
  } catch (err) {
    console.error(`[ESIGN WEBHOOK] lookup failed for ${parsed.providerId}: ${err.message}`);
    return { ok: false, action: 'lookup_failed', error: err.message };
  }

  // Envelopes sent from the Zoho dashboard rather than YisraCase are real and
  // expected. A 200 with a warn is correct: this is not our document, and
  // making Zoho retry forever would not change that.
  if (!request) {
    console.warn(
      `[ESIGN WEBHOOK] no signing_requests row for ${PROVIDER} request ` +
      `${parsed.providerId} (status "${parsed.providerStatus}", op ` +
      `"${parsed.operationType}") — sent outside YisraCase? Ignoring.`
    );
    return { ok: true, action: 'unknown_provider_id', providerId: parsed.providerId };
  }

  // ── map ───────────────────────────────────────────────────────────────────
  // Same exported table the poller uses. One vocabulary, one source of truth.
  const status = parsed.providerStatus
    ? mapRequestStatus(parsed.providerStatus, parsed.actions)
    : null;

  const recipients = parsed.actions.length
    ? parsed.actions.map((a, i) => ({
        name:      a.recipient_name ?? null,
        email:     String(a.recipient_email || '').trim().toLowerCase(),
        order:     Number.isFinite(Number(a.signing_order)) ? Number(a.signing_order) + 1 : i + 1,
        status:    mapActionStatus(a.action_status),
        signed_at: a.signed_time ?? a.action_time ?? null,
        ip:        a.ip_address ?? null,
      })).filter((r) => r.email)
    : null;

  // ── no status at all → a notification ABOUT the envelope, not a change ────
  // 'reminded', a per-recipient view, a delivery receipt. Audit row only.
  if (!parsed.providerStatus) {
    const eventName = _eventNameFor(parsed.operationType);
    if (await isDuplicateEvent(db, request.id, eventName, parsed.performedByEmail)) {
      console.log(`[ESIGN WEBHOOK] duplicate "${eventName}" for request ${request.id} — ignoring`);
      return { ok: true, action: 'duplicate', event: eventName };
    }
    await esignService.appendEvent(db, request.id, {
      event: eventName,
      recipientEmail: parsed.performedByEmail,
      occurredAt: parsed.occurredAt,
      payload: { operation_type: parsed.operationType, hint_ids: parsed.hintIds, source: 'webhook', raw: stored },
    });

    // ── BOUNCE: alert without transitioning ─────────────────────────────────
    // Zoho has NO request-level bounce status — ZOHO_REQUEST_STATUS_MAP holds
    // exactly draft/inprogress/completed/declined/recalled/expired — so a
    // failed delivery can only ever reach us as one of these status-less
    // notifications. Our own vocabulary HAS 'bounced' (markSent even supports
    // the bounced → sent resend), but nothing can currently set it.
    //
    // A bounced retainer is invisible failure: the client never got the email,
    // and without this the only trace is an audit row nobody reads. So we
    // raise the task on a keyword match — but we do NOT transition the row,
    // because that would be exactly the thing this file refuses to do
    // elsewhere: letting an undocumented field drive state. A wrong guess here
    // costs a spurious task; a wrong guess on a transition would corrupt the
    // record.
    //
    // FOLLOW-UP: once checkpoint step D prints a real operation_type
    // vocabulary, promote this to a proper 'bounced' status change and delete
    // the heuristic.
    if (BOUNCE_HINT.test(eventName)) {
      console.warn(`[ESIGN WEBHOOK] request ${request.id}: "${eventName}" looks like a failed delivery`);
      await _announceFailure(db, request, 'bounced', parsed.performedByEmail);
      return { ok: true, action: 'event_only', event: eventName, requestId: request.id, alerted: true };
    }

    return { ok: true, action: 'event_only', event: eventName, requestId: request.id };
  }

  // ── status-bearing delivery ───────────────────────────────────────────────
  // Guard the whole delivery, not just the event append: a retry of a
  // 'completed' notification that arrives while the first is still filing
  // would otherwise start a second download.
  const dedupeName = status || 'provider_status_unmapped';
  if (await isDuplicateEvent(db, request.id, dedupeName, parsed.performedByEmail)) {
    console.log(`[ESIGN WEBHOOK] duplicate "${dedupeName}" for request ${request.id} — ignoring`);
    return { ok: true, action: 'duplicate', event: dedupeName, requestId: request.id };
  }

  const outcome = await processStatusChange(db, request, {
    status,
    providerStatus: parsed.providerStatus,
    recipients,
    raw: stored,
    occurredAt: parsed.occurredAt,
    recipientEmail: parsed.performedByEmail,
    source: 'webhook',
  });

  return { ok: true, action: 'processed', ...outcome };
}

/**
 * Audit-row name for a status-less notification.
 *
 * Zoho's operation_type vocabulary is unverified, so this normalizes rather
 * than switches: whatever the string is, it becomes a lowercase snake_case
 * event name that fits varchar(64). Recognizable ones are folded onto our own
 * vocabulary so 'reminded' reads the same however it arrived.
 */
function _eventNameFor(operationType) {
  if (!operationType) return 'provider_notification';
  const norm = String(operationType)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (!norm) return 'provider_notification';
  if (norm.includes('remind')) return 'reminded';
  if (norm.includes('view') || norm.includes('open')) return 'viewed';
  if (norm.includes('deliver')) return 'delivered';
  return norm;
}

// ─────────────────────────────────────────────────────────────────────────────
// WIRING — see the header. Runs once, at require, via the route's require.
// ─────────────────────────────────────────────────────────────────────────────

esignService.setLogHook(writeEventLog);

module.exports = {
  handleZohoWebhook,
  processStatusChange,
  verifyToken,
  getWebhookToken,
  getHmacConfig,
  evaluateHmac,
  parseZohoWebhook,
  coerceBody,
  isDuplicateEvent,
  writeEventLog,
  safeEqual,
  WEBHOOK_TOKEN_KEY,
  WEBHOOK_SECRET_KEY,
  WEBHOOK_HMAC_MODE_KEY,
  SIGNATURE_HEADER,
  LOGGED_EVENTS,
  OUTGOING_EVENTS,
  BOUNCE_HINT,
  DUPLICATE_WINDOW_SECONDS,
  _eventNameFor,
};