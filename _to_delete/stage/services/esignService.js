// services/esignService.js
//
/**
 * E-Sign Service — DATA LAYER (Phase 1A)
 * services/esignService.js
 *
 * Provider-agnostic persistence for signature requests. There is deliberately
 * NO provider code here: no Zoho, no HTTP, no Dropbox, no sequences wiring,
 * no PDF rendering. Those arrive in later slices and all of them talk to the
 * database THROUGH this module.
 *
 * Three tables (see ref/2026-07-19_esign_phase1a.sql):
 *   signing_requests        — one row per document sent (or about to be)
 *   signing_request_events  — APPEND-ONLY audit trail, legal defensibility
 *   contract_templates      — the document library (not touched by this module
 *                             yet; templateId is stored, never dereferenced)
 *
 * ── applyStatus is the choke point ──────────────────────────────────────────
 * Every status change goes through the transition table in TRANSITIONS. The
 * webhook route, the reconciliation job and manual staff actions will all land
 * on applyStatus() or markSent(); both enforce the table via the same
 * _assertTransition(). markSent exists separately only because it writes
 * columns applyStatus has no business writing (provider_id, sent_at).
 *
 * ── Late events are normal, not errors ──────────────────────────────────────
 * Providers deliver webhooks out of order. A 'viewed' arriving after 'signed'
 * is routine. applyStatus returns { changed:false, reason:'terminal' } for
 * anything applied to a terminal row — it does NOT throw. Callers that want
 * the late event recorded anyway call appendEvent() explicitly; the audit
 * table takes it happily.
 *
 * ── Hard-won facts this module is built around (verified 2026-07-19) ────────
 *
 *   sql_mode has NO STRICT_TRANS_TABLES. An overlong value truncates SILENTLY
 *   and a NOT NULL column omitted from an INSERT is a WARNING, not an error.
 *   Measured: omitting the NOT NULL `recipients` json column stores JSON scalar
 *   `null` with warning 1364 — not `[]`, and not SQL NULL. So every length
 *   guard here THROWS rather than truncates (taskService.createTask does the
 *   same, for the same reason), and every INSERT names every NOT NULL column.
 *
 *   linkable_id must ALWAYS be bound as a STRING. Measured with EXPLAIN on
 *   MySQL 8.0.46: `WHERE linkable_type='contact' AND linkable_id = 22` (bound
 *   as a number) still returns the right row but silently drops idx_sr_linkable
 *   to its one-column prefix — key_len 258 instead of 516, filtered 50%.
 *   Bound as '22' it is key_len 516, ref const,const. Hence String() at every
 *   site that touches linkable_id. A correctness-preserving performance bug is
 *   the worst kind to inherit, so it is coerced here rather than trusted to
 *   callers.
 *
 *   seq_instance_id is BIGINT UNSIGNED (sequence_enrollments.id). mysql2 is
 *   configured with neither supportBigNumbers nor bigNumberStrings
 *   (startup/db.js), so BIGINT comes back as a plain JS number — measured, for
 *   both result.insertId and column reads. lib/sequenceEngine.js treats
 *   enrollment ids the same way (`@param {number} enrollmentId`). No BigInt
 *   handling anywhere; do not add any without changing the pool config first.
 *
 *   JSON columns come back from mysql2 already parsed (object/array, not
 *   string) — measured. _parseJsonField still handles the string case, mirroring
 *   services/videoService.js, because the cost is zero and driver config drifts.
 *
 * Usage:
 *   const esignService = require('../services/esignService');
 *   const req = await esignService.createRequest(db, { ... });
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only provider implemented. createRequest accepts an explicit `provider`
 * override, so adding a second one is a caller change, not an edit here.
 *
 * NOTE (divergence, reported): the slice spec's createRequest signature has no
 * `provider` param, but signing_requests.provider is NOT NULL and participates
 * in UNIQUE (provider, provider_id). An optional param with this default is the
 * smallest honest resolution — it is a column default, not provider logic.
 */
const DEFAULT_PROVIDER = 'zoho_sign';

/**
 * Polymorphic link targets. Declared as a list rather than hard-coded checks so
 * adding 'appt' later is a one-line change. EXPANSION IS ALWAYS SAFE — the
 * validator only ever rejects values NOT in the list, so adding one cannot
 * newly reject an existing caller. Same reasoning as LOG_TYPES in
 * lib/internal_functions/log.js.
 */
const LINKABLE_TYPES = ['case', 'contact'];

/**
 * Every status the `status` column may hold. VARCHAR, not ENUM, on purpose:
 * this firm has felt ENUM-ALTER pain (the log_type 'esign' migration), and a
 * new status should be zero-migration.
 */
const STATUSES = [
  'draft', 'sent', 'viewed', 'signed', 'declined',
  'expired', 'recalled', 'bounced', 'satisfied_external',
];

/**
 * The transition table. Enforced by _assertTransition(); every write path in
 * this module routes through it.
 *
 *   draft   → sent, recalled
 *   sent    → viewed, signed, declined, expired, recalled, bounced, satisfied_external
 *   viewed  → signed, declined, expired, recalled, bounced, satisfied_external
 *   bounced → sent (resend after fixing the email), recalled, satisfied_external
 *   signed / declined / expired / recalled / satisfied_external → TERMINAL
 */
const TRANSITIONS = Object.freeze({
  draft:              ['sent', 'recalled'],
  sent:               ['viewed', 'signed', 'declined', 'expired', 'recalled', 'bounced', 'satisfied_external'],
  viewed:             ['signed', 'declined', 'expired', 'recalled', 'bounced', 'satisfied_external'],
  bounced:            ['sent', 'recalled', 'satisfied_external'],
  signed:             [],
  declined:           [],
  expired:            [],
  recalled:           [],
  satisfied_external: [],
});

/** Statuses with no exits. Reached only once; late events bounce off them. */
const TERMINAL = new Set(['signed', 'declined', 'expired', 'recalled', 'satisfied_external']);

/**
 * Terminal statuses that mean "the firm got what it needed" — these stamp
 * completed_at. 'satisfied_external' counts: the debtor signed on paper or in
 * the office, so the obligation IS discharged, just not through the provider.
 * declined / expired / recalled are terminal FAILURES and leave completed_at
 * NULL, which is what makes "outstanding vs abandoned" reportable later.
 */
const TERMINAL_SUCCESS = new Set(['signed', 'satisfied_external']);

/** Statuses listOutstanding() considers still in flight. */
const OUTSTANDING_STATUSES = ['sent', 'viewed', 'bounced'];

// Column-width guards. sql_mode is not strict, so these THROW (see header).
const MAX_LINKABLE_ID   = 64;
const MAX_KIND          = 64;
const MAX_DOCUMENT_NAME = 255;
const MAX_PROVIDER      = 32;
const MAX_PROVIDER_ID   = 128;
const MAX_PDF_PATH      = 512;
const MAX_TRACKING_ID   = 80;

/**
 * tracking_id format — `YC-{linkable_id}-{kind}-{SUFFIX}`
 *
 *   SUFFIX = 8 uppercase hex chars (crypto.randomBytes(4)), 32 bits.
 *   Hex, not base64url, precisely BECAUSE base64url contains '-' and would
 *   make the id look parseable-by-splitting when it is not.
 *
 * The id is OPAQUE. Do not parse it to recover the case or kind — 1 of the
 * 1066 live cases.case_id values already contains a base64url '-', so splitting
 * on '-' is wrong today, not merely fragile.
 *
 * Length budget against VARCHAR(80):
 *   worst REAL case  — 'YC-'(3) + case_id(8) + '-'(1)
 *                      + 'retainer_postpetition'(21) + '-'(1) + suffix(8) = 42
 *   worst COLUMN case — linkable_id and kind are varchar(64) each, so a
 *                       pathological pair yields 3+64+1+64+1+8 = 141 > 80.
 * _buildTrackingId throws TRACKING_ID_TOO_LONG rather than truncating, because
 * a truncated tracking id is a silently-broken lookup key.
 */
const TRACKING_PREFIX  = 'YC-';
const SUFFIX_BYTES     = 4;
const MAX_TRACKING_ATTEMPTS = 3;

/** kind must be snake_case so it is safe to embed in the tracking id. */
const KIND_RE = /^[a-z0-9_]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
//
// Repo convention (services/logService.js): construct, attach .code, throw.
// ─────────────────────────────────────────────────────────────────────────────

function _err(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mysql2 may auto-parse JSON columns or return strings depending on driver
 * config. Handle both. (Mirrors services/videoService.js parseJsonField.)
 */
function _parseJsonField(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}

const JSON_FIELDS = ['recipients', 'placement_json', 'raw_payload'];

/** Hydrate a raw signing_requests row. Column names are kept as-is. */
function _shape(row) {
  if (!row) return null;
  const out = { ...row };
  for (const f of JSON_FIELDS) {
    if (f in out) out[f] = _parseJsonField(out[f]);
  }
  // recipients is NOT NULL and always written as an array. A row that predates
  // that guarantee (or a hand-edited one) should still read as an array.
  if (!Array.isArray(out.recipients)) out.recipients = [];
  return out;
}

/**
 * Normalize a datetime for the DB. The pool runs timezone:'Z', so everything
 * is UTC; formatting explicitly here removes any doubt about what a Date turns
 * into and keeps test assertions deterministic.
 *
 * Accepts Date | ISO string | 'YYYY-MM-DD HH:MM:SS' | null/undefined.
 * Returns 'YYYY-MM-DD HH:MM:SS' (UTC) or null.
 */
/**
 * Already in DB shape: 'YYYY-MM-DD HH:MM:SS' (or with a 'T'), no zone.
 * Values in this shape are ALREADY UTC — _nowDb() and _toDbDateTime both emit
 * it — so they must be passed through untouched.
 */
const DB_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;

function _toDbDateTime(v) {
  if (v == null || v === '') return null;

  // IDEMPOTENCE. Without this, round-tripping our own output silently shifts
  // the value by the PROCESS's UTC offset:
  //
  //   markSent: sentStamp = _nowDb()          → '2026-07-19 09:48:10' (UTC)
  //             _insertEvent({occurredAt: sentStamp})
  //             → new Date('2026-07-19 09:48:10')
  //
  // That string has no zone designator and a space separator, so ECMAScript
  // parses it as LOCAL time. On a UTC box local === UTC and nothing happens,
  // which is why production never showed it. Run the same code from a laptop
  // in UTC+3 and the event lands three hours in the past — observed live on
  // 2026-07-19: signing_request_events id 2 stored occurred_at 06:48:10
  // against created_at 09:48:10, so the 'sent' event appeared to precede the
  // 'created' event in a legal audit trail.
  if (typeof v === 'string' && DB_DATETIME_RE.test(v.trim())) {
    return v.trim().replace('T', ' ');
  }

  const d = (v instanceof Date) ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw _err('INVALID_ESIGN_DATETIME', `Not a usable datetime: ${JSON.stringify(v)}`);
  }
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function _nowDb() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Throw if a string is longer than its column. Never truncate — see header. */
function _guardLength(label, value, max) {
  if (value != null && String(value).length > max) {
    throw _err(
      'ESIGN_FIELD_TOO_LONG',
      `esignService: ${label} exceeds ${max} chars (got ${String(value).length}). ` +
      `sql_mode is not strict, so writing it would truncate silently.`
    );
  }
}

/**
 * Random tracking-id suffix. Swappable so the collision-retry path is testable
 * (__setTrackingSuffixGenerator). Double-underscore = internal/test handle,
 * matching internalFunctions.__resetFirmNumberCache.
 */
let _suffixGenerator = () => crypto.randomBytes(SUFFIX_BYTES).toString('hex').toUpperCase();

function __setTrackingSuffixGenerator(fn) {
  _suffixGenerator = fn || (() => crypto.randomBytes(SUFFIX_BYTES).toString('hex').toUpperCase());
}

/** `YC-{linkableId}-{kind}-{suffix}`, throwing rather than truncating. */
function _buildTrackingId(linkableId, kind, suffix) {
  const id = `${TRACKING_PREFIX}${linkableId}-${kind}-${suffix}`;
  if (id.length > MAX_TRACKING_ID) {
    throw _err(
      'TRACKING_ID_TOO_LONG',
      `esignService: tracking_id would be ${id.length} chars, max ${MAX_TRACKING_ID}. ` +
      `linkable_id=${String(linkableId).length} kind=${String(kind).length}. ` +
      `Shorten the kind — the id is a lookup key and must not be truncated.`
    );
  }
  return id;
}

/** True when a mysql2 error is a duplicate-key violation on `keyName`. */
function _isDupKey(err, keyName) {
  if (!err || err.code !== 'ER_DUP_ENTRY') return false;
  const msg = String(err.sqlMessage || err.message || '');
  return msg.includes(keyName);
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

function _assertLinkableType(linkableType) {
  if (!LINKABLE_TYPES.includes(linkableType)) {
    throw _err(
      'INVALID_LINKABLE_TYPE',
      `Invalid linkableType: ${JSON.stringify(linkableType)}. ` +
      `Must be one of: ${LINKABLE_TYPES.join(', ')}.`
    );
  }
}

function _assertStatus(status) {
  if (!STATUSES.includes(status)) {
    throw _err(
      'INVALID_ESIGN_STATUS',
      `Unknown e-sign status: ${JSON.stringify(status)}. ` +
      `Must be one of: ${STATUSES.join(', ')}.`
    );
  }
}

/**
 * Enforce the transition table. The single place TRANSITIONS is consulted, so
 * markSent and applyStatus can never drift apart.
 */
function _assertTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw _err(
      'INVALID_ESIGN_TRANSITION',
      `Illegal e-sign transition ${from} → ${to}. ` +
      (allowed.length
        ? `From '${from}' the only legal next statuses are: ${allowed.join(', ')}.`
        : `'${from}' is terminal — it has no exits.`)
    );
  }
}

/**
 * Coerce + validate the recipients array into the declared shape
 * [{name,email,order,status,signed_at,ip}].
 *
 * Provider-specific extras are dropped deliberately: raw_payload already keeps
 * the full blob, and letting this column drift into a per-provider shape would
 * defeat the point of a provider-agnostic table.
 *
 * An EMPTY array is legal — a draft may exist before the recipients are known.
 */
function _normalizeRecipients(recipients) {
  if (recipients == null) return [];
  if (!Array.isArray(recipients)) {
    throw _err('INVALID_RECIPIENTS', `recipients must be an array (got ${typeof recipients}).`);
  }
  return recipients.map((r, i) => {
    if (!r || typeof r !== 'object') {
      throw _err('INVALID_RECIPIENTS', `recipients[${i}] must be an object.`);
    }
    // Lowercased + trimmed, matching logService's email normalization so the
    // same address compares equal across subsystems.
    const email = String(r.email == null ? '' : r.email).trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw _err('INVALID_RECIPIENTS', `recipients[${i}].email is missing or not an email address.`);
    }
    return {
      name:      r.name == null ? null : String(r.name),
      email,
      order:     Number.isInteger(r.order) ? r.order : i + 1,
      status:    r.status == null ? 'pending' : String(r.status),
      signed_at: r.signed_at == null ? null : String(r.signed_at),
      ip:        r.ip == null ? null : String(r.ip),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING HOOK POINT
//
// This slice writes NO log entries. It exposes the seam that slice 1C fills.
//
// The target is already in place: the live `log` table's log_type ENUM
// contains 'esign' (verified 2026-07-19 — shipped with the Adobe Sign email
// parser, Phase 0), and log_link_type contains both 'case' and 'contact', so a
// signing_requests row maps onto a log row with no schema change:
//
//   esignService.setLogHook(async (db, ev) => {
//     await require('./logService').createLogEntry(db, {
//       type:      'esign',
//       link_type: ev.request.linkable_type,      // 'case' | 'contact'
//       link_id:   ev.request.linkable_id,
//       by:        ev.request.created_by,
//       subject:   ev.request.document_name,
//       data:      { event: ev.event, tracking_id: ev.request.tracking_id },
//     });
//   });
//
// Fire-and-forget by construction: a logging failure must never roll back or
// block a signature write. Same posture as eventService's calendar work.
// ─────────────────────────────────────────────────────────────────────────────

let _logHook = null;

function setLogHook(fn) { _logHook = typeof fn === 'function' ? fn : null; }

function _fireLogHook(db, payload) {
  if (!_logHook) return;
  try {
    const r = _logHook(db, payload);
    if (r && typeof r.catch === 'function') {
      r.catch(e => console.error('[ESIGN] log hook failed:', e && e.message));
    }
  } catch (e) {
    console.error('[ESIGN] log hook threw:', e && e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT APPEND (audit trail)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal append. No existence check — every caller has just read the row.
 * Callers outside this module use appendEvent(), which does check.
 */
async function _insertEvent(db, requestId, { event, recipientEmail = null, payload = null, occurredAt = null }, request = null) {
  if (!event || typeof event !== 'string') {
    throw _err('INVALID_ESIGN_EVENT', `appendEvent requires a non-empty event name (got ${JSON.stringify(event)}).`);
  }
  _guardLength('event', event, 64);
  _guardLength('recipient_email', recipientEmail, 255);

  const occurred = _toDbDateTime(occurredAt) || _nowDb();

  await db.query(
    `INSERT INTO signing_request_events
       (signing_request_id, event, recipient_email, payload, occurred_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      requestId,
      event,
      recipientEmail || null,
      payload == null ? null : JSON.stringify(payload),
      occurred,
    ]
  );

  _fireLogHook(db, {
    signing_request_id: requestId,
    event,
    recipient_email: recipientEmail || null,
    payload,
    occurred_at: occurred,
    request,
  });
}

/**
 * Public append for NON-status events ('reminded', 'delivered', a late event
 * applyStatus refused, …). Verifies the request exists so the append-only
 * audit table cannot accumulate orphans — there is no FK doing that for us.
 */
async function appendEvent(db, id, { event, recipientEmail = null, payload = null, occurredAt = null } = {}) {
  const request = await getById(db, id);
  if (!request) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);
  await _insertEvent(db, request.id, { event, recipientEmail, payload, occurredAt }, request);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// READS
// ─────────────────────────────────────────────────────────────────────────────

async function getById(db, id) {
  const [[row]] = await db.query(
    `SELECT * FROM signing_requests WHERE id = ? LIMIT 1`,
    [id]
  );
  return _shape(row);
}

/**
 * Look up by the provider's own id. providerId must be non-NULL — a NULL never
 * matches with '=', and every draft row carries NULL, so passing null here
 * would silently return nothing rather than "some draft".
 */
async function getByProviderId(db, provider, providerId) {
  if (providerId == null || providerId === '') {
    throw _err('INVALID_PROVIDER_ID', 'getByProviderId requires a non-empty providerId (drafts hold NULL and are not addressable this way).');
  }
  const [[row]] = await db.query(
    `SELECT * FROM signing_requests WHERE provider = ? AND provider_id = ? LIMIT 1`,
    [provider, String(providerId)]
  );
  return _shape(row);
}

/** UNIQUE KEY uq_sr_tracking guarantees at most one row. */
async function getByTrackingId(db, trackingId) {
  const [[row]] = await db.query(
    `SELECT * FROM signing_requests WHERE tracking_id = ? LIMIT 1`,
    [String(trackingId)]
  );
  return _shape(row);
}

/**
 * Requests still in flight, oldest first.
 *
 * "Oldest" is COALESCE(sent_at, created_at): a bounced row that was resent has
 * a newer sent_at and belongs further down the queue, while anything never
 * sent falls back to when it was created. id ASC breaks ties so the order is
 * total and stable across pages.
 *
 * linkableId is String()-coerced — see the header note on key_len 516.
 */
async function listOutstanding(db, { linkableType = null, linkableId = null } = {}) {
  const where  = [`status IN (${OUTSTANDING_STATUSES.map(() => '?').join(', ')})`];
  const params = [...OUTSTANDING_STATUSES];

  if (linkableType != null) {
    _assertLinkableType(linkableType);
    where.push('linkable_type = ?');
    params.push(linkableType);
  }
  if (linkableId != null) {
    where.push('linkable_id = ?');
    params.push(String(linkableId));
  }

  const [rows] = await db.query(
    `SELECT * FROM signing_requests
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(sent_at, created_at) ASC, id ASC`,
    params
  );
  return (rows || []).map(_shape);
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a DRAFT signing request and append its 'created' event.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  opts.linkableType          'case' | 'contact'
 * @param {string|number} opts.linkableId      cases.case_id or contacts.contact_id
 * @param {string}  opts.kind                  snake_case; embedded in tracking_id
 * @param {string}  [opts.documentName]        debtor-visible name
 * @param {Array}   [opts.recipients=[]]       [{name,email,order,status,signed_at,ip}]
 * @param {object}  [opts.placementJson]
 * @param {number}  [opts.templateId]          contract_templates.id
 * @param {Date|string} [opts.expiresAt]
 * @param {number}  opts.createdBy             REQUIRED. users.user. Pass 0
 *                                             explicitly when automation is the
 *                                             actor — it is not defaulted here.
 * @param {string}  [opts.provider=DEFAULT_PROVIDER]
 *
 * @returns {Promise<object>} the shaped row
 *
 * createdBy is required even though the column defaults to 0. The column
 * default exists because sql_mode is not strict and an omitted NOT NULL int
 * would land as 0 anyway — making that explicit in the schema is honest. But
 * silently attributing a staff-initiated retainer to the automations user is a
 * real audit defect, so the SERVICE refuses to guess.
 */
async function createRequest(db, {
  linkableType,
  linkableId,
  kind,
  documentName = null,
  recipients   = [],
  placementJson = null,
  templateId    = null,
  expiresAt     = null,
  createdBy,
  provider      = DEFAULT_PROVIDER,
} = {}) {
  _assertLinkableType(linkableType);

  if (linkableId == null || String(linkableId).trim() === '') {
    throw _err('INVALID_LINKABLE_ID', 'createRequest requires a non-blank linkableId.');
  }
  // Bound as a STRING everywhere — see the header note on idx_sr_linkable.
  const linkId = String(linkableId).trim();
  _guardLength('linkableId', linkId, MAX_LINKABLE_ID);

  if (!kind || !KIND_RE.test(String(kind))) {
    throw _err(
      'INVALID_ESIGN_KIND',
      `Invalid kind: ${JSON.stringify(kind)}. Must be snake_case (${KIND_RE}) — ` +
      `it is embedded verbatim in the tracking_id.`
    );
  }
  _guardLength('kind', kind, MAX_KIND);
  _guardLength('documentName', documentName, MAX_DOCUMENT_NAME);
  _guardLength('provider', provider, MAX_PROVIDER);

  if (createdBy == null) {
    throw _err(
      'ESIGN_CREATED_BY_REQUIRED',
      'createRequest requires createdBy (users.user). Pass 0 explicitly when ' +
      'automation is the actor — it is never inferred.'
    );
  }
  const createdByNum = Number(createdBy);
  if (!Number.isInteger(createdByNum) || createdByNum < 0) {
    throw _err('ESIGN_CREATED_BY_REQUIRED', `createdBy must be a non-negative integer (got ${JSON.stringify(createdBy)}).`);
  }

  // Explicit, never omitted: an omitted NOT NULL json column stores JSON `null`
  // under this sql_mode, not [].
  const recips  = _normalizeRecipients(recipients);
  const expires = _toDbDateTime(expiresAt);

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_TRACKING_ATTEMPTS; attempt++) {
    const trackingId = _buildTrackingId(linkId, kind, _suffixGenerator());
    try {
      const [result] = await db.query(
        `INSERT INTO signing_requests
           (provider, provider_id, linkable_type, linkable_id, kind, status,
            document_name, tracking_id, recipients, placement_json,
            template_id, expires_at, created_by)
         VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
        [
          provider,
          linkableType,
          linkId,
          String(kind),
          documentName || null,
          trackingId,
          JSON.stringify(recips),
          placementJson == null ? null : JSON.stringify(placementJson),
          templateId == null ? null : Number(templateId),
          expires,
          createdByNum,
        ]
      );

      const id  = result.insertId;
      const row = await getById(db, id);

      await _insertEvent(db, id, {
        event:   'created',
        payload: { linkable_type: linkableType, linkable_id: linkId, kind: String(kind), tracking_id: trackingId },
      }, row);

      return row;
    } catch (err) {
      // Only a tracking_id collision is retryable. uq_provider cannot fire here
      // (provider_id is NULL on every draft, and NULLs do not collide), so any
      // other duplicate-key error is a real bug and must surface.
      if (_isDupKey(err, 'uq_sr_tracking')) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw _err(
    'TRACKING_ID_COLLISION',
    `createRequest could not mint a unique tracking_id in ${MAX_TRACKING_ATTEMPTS} attempts ` +
    `(last: ${lastErr && lastErr.sqlMessage ? lastErr.sqlMessage : lastErr && lastErr.message}). ` +
    `With 32 bits of suffix entropy this means the generator is not random.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND / RESEND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record that the provider has accepted the request.
 *
 * Legal from 'draft' (first send) AND from 'bounced' (resend after fixing a bad
 * email). The resend path is why this is not just applyStatus({status:'sent'}):
 * the provider issues a FRESH request id on resend, so provider_id has to be
 * overwritten.
 *
 * On a resend the OLD provider_id is preserved in the 'sent' event payload —
 * overwriting the column would otherwise erase the only record that the first
 * attempt ever had an id, and that is exactly the sort of gap that makes an
 * audit trail useless. UNIQUE (provider, provider_id) survives the overwrite
 * because the old value vacates the column in the same statement.
 *
 * Any signed/cert PDF paths are cleared on resend: they could only be stale
 * artifacts of the failed attempt, and a stale path pointing at the wrong
 * document is worse than no path.
 *
 * @param {object} db
 * @param {number} id
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {Date|string} [opts.sentAt=now]
 * @param {Date|string} [opts.expiresAt]  only written when supplied
 */
async function markSent(db, id, { providerId, sentAt = null, expiresAt = null } = {}) {
  const request = await getById(db, id);
  if (!request) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);

  if (providerId == null || String(providerId).trim() === '') {
    throw _err('INVALID_PROVIDER_ID', 'markSent requires a non-empty providerId.');
  }
  const provId = String(providerId).trim();
  _guardLength('providerId', provId, MAX_PROVIDER_ID);

  // Enforced by the shared table: draft → sent and bounced → sent are the only
  // two routes in. Anything else raises INVALID_ESIGN_TRANSITION here.
  _assertTransition(request.status, 'sent');

  const isResend  = request.status === 'bounced';
  const sentStamp = _toDbDateTime(sentAt) || _nowDb();
  const expires   = _toDbDateTime(expiresAt);

  const sets   = ['status = ?', 'provider_id = ?', 'sent_at = ?'];
  const params = ['sent', provId, sentStamp];

  if (expires) { sets.push('expires_at = ?'); params.push(expires); }
  if (isResend) {
    // Cannot be legitimate on a bounced row; clear rather than carry forward.
    sets.push('signed_pdf_path = NULL', 'cert_pdf_path = NULL');
  }
  params.push(id);

  await db.query(`UPDATE signing_requests SET ${sets.join(', ')} WHERE id = ?`, params);

  const updated = await getById(db, id);

  await _insertEvent(db, id, {
    event:      'sent',
    occurredAt: sentStamp,
    payload: {
      from_status: request.status,
      provider_id: provId,
      ...(isResend ? { resend: true, previous_provider_id: request.provider_id } : {}),
    },
  }, updated);

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS CHOKE POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a status change. Webhook, reconciliation job and manual staff actions
 * all funnel through here.
 *
 * Return shape is always { changed, request, reason? }:
 *   { changed:true,  request }                    — applied
 *   { changed:false, reason:'noop',     request } — already in that status
 *   { changed:false, reason:'terminal', request } — row is terminal; late event
 *
 * The terminal case does NOT throw. Providers deliver webhooks out of order and
 * a 'viewed' landing after 'signed' is routine, not exceptional. An ILLEGAL but
 * non-terminal transition (draft → viewed) DOES throw
 * INVALID_ESIGN_TRANSITION — that is a real bug, not a race.
 *
 * @param {object} db
 * @param {number} id
 * @param {object} opts
 * @param {string} opts.status
 * @param {Array}  [opts.recipients]      replaces the column when supplied
 * @param {object} [opts.raw]             stored to raw_payload
 * @param {Date|string} [opts.occurredAt]
 * @param {string} [opts.recipientEmail]  which recipient the event is about
 */
async function applyStatus(db, id, { status, recipients = null, raw = null, occurredAt = null, recipientEmail = null } = {}) {
  // Validated before anything else: an unknown status is a programming error
  // regardless of what the row currently holds.
  _assertStatus(status);

  const request = await getById(db, id);
  if (!request) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);

  // Idempotent: re-delivering the same webhook appends nothing.
  if (request.status === status) {
    return { changed: false, reason: 'noop', request };
  }

  if (TERMINAL.has(request.status)) {
    return { changed: false, reason: 'terminal', request };
  }

  _assertTransition(request.status, status);

  const stamp  = _toDbDateTime(occurredAt) || _nowDb();
  const sets   = ['status = ?'];
  const params = [status];

  if (recipients != null) {
    sets.push('recipients = ?');
    params.push(JSON.stringify(_normalizeRecipients(recipients)));
  }
  if (raw != null) {
    sets.push('raw_payload = ?');
    params.push(JSON.stringify(raw));
  }
  // Stamped once. If a row somehow already carries completed_at, the first
  // stamp is the one that counts.
  if (TERMINAL_SUCCESS.has(status) && !request.completed_at) {
    sets.push('completed_at = ?');
    params.push(stamp);
  }
  params.push(id);

  await db.query(`UPDATE signing_requests SET ${sets.join(', ')} WHERE id = ?`, params);

  const updated = await getById(db, id);

  await _insertEvent(db, id, {
    event:          status,
    recipientEmail,
    occurredAt:     stamp,
    payload:        { from_status: request.status, ...(raw != null ? { raw } : {}) },
  }, updated);

  return { changed: true, request: updated };
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGETED COLUMN WRITES
//
// Not status changes, so they do not route through applyStatus. Neither
// appends an event: seq_instance_id and the PDF paths are internal bookkeeping,
// and padding a legal audit trail with plumbing noise devalues it. Slice 1C can
// call appendEvent() explicitly if a stored PDF turns out to be worth recording.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach (or clear) the reminder sequence enrollment.
 *
 * seqInstanceId is sequence_enrollments.id — BIGINT UNSIGNED in the DB, a plain
 * JS number here (mysql2 is configured with neither supportBigNumbers nor
 * bigNumberStrings; lib/sequenceEngine.js treats enrollment ids the same way).
 * Pass null to detach after cancelling the sequence.
 */
async function setSeqInstance(db, id, seqInstanceId) {
  if (seqInstanceId != null) {
    const n = Number(seqInstanceId);
    if (!Number.isInteger(n) || n <= 0) {
      throw _err('INVALID_SEQ_INSTANCE_ID', `seqInstanceId must be a positive integer or null (got ${JSON.stringify(seqInstanceId)}).`);
    }
    if (!Number.isSafeInteger(n)) {
      throw _err('INVALID_SEQ_INSTANCE_ID', `seqInstanceId ${n} exceeds Number.MAX_SAFE_INTEGER — the pool would have to be reconfigured with supportBigNumbers first.`);
    }
  }
  const [res] = await db.query(
    `UPDATE signing_requests SET seq_instance_id = ? WHERE id = ?`,
    [seqInstanceId == null ? null : Number(seqInstanceId), id]
  );
  if (res.affectedRows === 0) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);
  return getById(db, id);
}

/**
 * Store the Dropbox paths of the signed document and/or the completion
 * certificate. Omitted keys are left alone; pass null to clear one.
 */
async function setPdfPaths(db, id, { signedPdfPath, certPdfPath } = {}) {
  const sets   = [];
  const params = [];

  if (signedPdfPath !== undefined) {
    _guardLength('signedPdfPath', signedPdfPath, MAX_PDF_PATH);
    sets.push('signed_pdf_path = ?');
    params.push(signedPdfPath == null ? null : String(signedPdfPath));
  }
  if (certPdfPath !== undefined) {
    _guardLength('certPdfPath', certPdfPath, MAX_PDF_PATH);
    sets.push('cert_pdf_path = ?');
    params.push(certPdfPath == null ? null : String(certPdfPath));
  }
  if (!sets.length) {
    throw _err('ESIGN_NO_FIELDS', 'setPdfPaths requires at least one of signedPdfPath / certPdfPath.');
  }
  params.push(id);

  const [res] = await db.query(
    `UPDATE signing_requests SET ${sets.join(', ')} WHERE id = ?`,
    params
  );
  if (res.affectedRows === 0) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);
  return getById(db, id);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE PDF (Phase 2E) — signing_request_sources
//
// The UNSIGNED source document of a send: text-filled (pdfFill) but UNSTAMPED
// — both resend branches re-stamp, so storing stamped bytes would double-
// stamp. LONGBLOB in its own table so signing_requests' hot rows never carry
// megabytes. One row per request (PK = signing_request_id); a draft-retry
// upserts, because the retried bytes may carry corrected fill-ins.
// ─────────────────────────────────────────────────────────────────────────────

async function storeSourcePdf(db, id, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw _err('ESIGN_BAD_PDF', 'storeSourcePdf requires a non-empty Buffer.');
  }
  await db.query(
    `INSERT INTO signing_request_sources (signing_request_id, pdf, size)
     VALUES (?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE pdf = new.pdf, size = new.size`,
    [id, buffer, buffer.length]
  );
  return { id: Number(id), size: buffer.length };
}

/** @returns {Promise<?{buffer: Buffer, size: number}>} null when never stored */
async function getSourcePdf(db, id) {
  const [[row]] = await db.query(
    'SELECT pdf, size FROM signing_request_sources WHERE signing_request_id = ? LIMIT 1',
    [id]
  );
  if (!row) return null;
  return { buffer: Buffer.isBuffer(row.pdf) ? row.pdf : Buffer.from(row.pdf), size: Number(row.size) };
}

/** Existence WITHOUT the blob — detail views ask this on every open. */
async function hasSourcePdf(db, id) {
  const [[row]] = await db.query(
    'SELECT 1 AS x FROM signing_request_sources WHERE signing_request_id = ? LIMIT 1',
    [id]
  );
  return Boolean(row);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // writes
  createRequest,
  markSent,
  applyStatus,
  appendEvent,
  setSeqInstance,
  setPdfPaths,
  storeSourcePdf,
  // reads
  getById,
  getByProviderId,
  getByTrackingId,
  listOutstanding,
  getSourcePdf,
  hasSourcePdf,
  // logging seam (slice 1C)
  setLogHook,
  // constants — exported so routes/tests share one source of truth
  DEFAULT_PROVIDER,
  LINKABLE_TYPES,
  STATUSES,
  TRANSITIONS,
  TERMINAL,
  TERMINAL_SUCCESS,
  OUTSTANDING_STATUSES,
  MAX_TRACKING_ID,
  // internal/test handles
  __setTrackingSuffixGenerator,
  _buildTrackingId,
  _toDbDateTime,
  _normalizeRecipients,
  _assertTransition,
};