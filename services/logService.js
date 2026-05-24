// services/logService.js
//
/**
 * Log Service
 * services/logService.js
 *
 * Read and create log entries. All log writes from routes and services
 * should go through this module (except the DB trigger on contacts,
 * which writes directly).
 *
 * Track A.1 Phase A (logging foundation for pre-contact comms):
 *   - createLogEntry now normalizes log_link_id when link_type is 'phone'
 *     or 'email' (10-digit phone, trim+lowercase email). Invalid values
 *     throw an Error with code 'INVALID_LOG_LINK_ID'.
 *   - For phone/email-typed entries, the legacy log_link column is set
 *     to '' (the value lives in log_link_id; log_link only makes sense
 *     for entity-ID references).
 *   - listLog's LEFT JOINs on contacts and cases are now gated on
 *     log_link_type to prevent the H-bug (a non-contact/non-case row
 *     whose log_link_id happened to numerically match a contact_id or
 *     case_id was being incorrectly hydrated with that entity's name).
 *
 * Phase 2 (unified log_data shape):
 *   - createLogEntry now folds typed display params (from / to / subject /
 *     message) into the log_data JSON before insert. Result: every log row
 *     has a self-describing JSON blob the renderer can iterate generically,
 *     and new write paths inherit the convention without remembering to
 *     stuff content into log_data themselves.
 *   - Typed cols (log_from, log_to, log_subject, log_message) are still
 *     written for back-compat / indexing — the JSON is now the source of
 *     truth for display content; the cols are vestigial and slated for
 *     removal in a later slice.
 *   - log_direction is intentionally NOT folded into log_data — direction
 *     is rendered as a separate UI affordance (icon/arrow), not as a
 *     key/value line. It stays in the typed col.
 *   - Direction normalization (Slice 4-C, lifted from internal_functions
 *     create_log) now lives here so REST callers also benefit.
 *
 * Phase 3 Slice 1 (log_extra column split):
 *   - New optional `extra` param accepted by createLogEntry. Value (an
 *     object or JSON-string-of-object) is written to the new `log_extra`
 *     JSON column. Null/empty/non-object inputs write SQL NULL.
 *   - log_extra carries IT-facing fields (provider, timestamps, provider
 *     IDs, etc.); log_data is reduced to user-facing content. Old rows
 *     stay legacy — no backfill.
 *   - Empty attachments are stripped from log_data (Q4 ii-strict): null,
 *     '', and [] are removed. The "[object Object],..." string produced
 *     by the deferred Phase-2 fix #1 placeholder coercion stays visible
 *     — intentional; hiding it would delay prioritizing the MMS fix.
 *
 * Usage:
 *   const logService = require('../services/logService');
 *   const entries = await logService.listLog(db, { link_type: 'contact', link_id: 123 });
 *   const entry  = await logService.createLogEntry(db, { type: 'note', ... });
 */

// ─────────────────────────────────────────────────────────────
// Local normalization helpers (mirror contactService.{normalizePhone,
// normalizeEmail}; kept inline to avoid require-cycle risk and to be
// self-contained for this service). If contactService's semantics
// change, update here too.
// ─────────────────────────────────────────────────────────────

/**
 * Normalize a phone string to 10 digits.
 * Strips all non-digits; if 11 digits and leading '1', drops the '1'.
 * Returns '' for falsy input. Does NOT validate length here — caller
 * must check.
 */
function _normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * Normalize an email: trim + lowercase. Returns '' for falsy.
 */
function _normalizeEmail(email) {
  if (!email && email !== 0) return '';
  return String(email).trim().toLowerCase();
}

/**
 * Normalize direction strings from external providers to the
 * log_direction ENUM('incoming','outgoing') values.
 *
 * External providers use varied labels ("Inbound"/"Outbound" from
 * RingCentral, "incoming"/"outgoing" from internal callers). The DB
 * enum rejects mismatched values — that's the bug this fixes.
 *
 * Unknown values pass through unchanged for forward compatibility:
 * a future provider supplying a third direction label will be rejected
 * loudly by the enum rather than silently dropped here. Originally
 * shipped in lib/internal_functions.js create_log (Slice 4-C); lifted
 * here so REST callers via /api/log also normalize.
 */
const _DIRECTION_NORMALIZATION = {
  'inbound':  'incoming',
  'incoming': 'incoming',
  'outbound': 'outgoing',
  'outgoing': 'outgoing',
};
function _normalizeDirection(d) {
  if (d == null || d === '') return d;
  const lower = String(d).toLowerCase();
  return _DIRECTION_NORMALIZATION[lower] ?? d;
}


// ─────────────────────────────────────────────────────────────
// listLog
// ─────────────────────────────────────────────────────────────

/**
 * List log entries with filters.
 *
 * Reads from the new link columns (log_link_type / log_link_id) first,
 * falls back to legacy log_link for old rows that haven't been backfilled.
 *
 * The LEFT JOINs to contacts and cases are gated on log_link_type so
 * non-contact/non-case rows (phone, email, future task, etc.) don't
 * accidentally hydrate contact/case fields when their log_link value
 * coincidentally matches a contact_id or case_number. Legacy NULL-type
 * rows still hydrate (back-compat).
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  [opts.link_type]   - 'contact','case','appt','bill','phone','email'
 * @param {string}  [opts.link_id]     - the ID/value to filter by
 * @param {string}  [opts.type]        - log_type enum filter
 * @param {string}  [opts.direction]   - 'incoming' or 'outgoing'
 * @param {string}  [opts.from_date]   - ISO datetime lower bound
 * @param {string}  [opts.to_date]     - ISO datetime upper bound
 * @param {number}  [opts.limit=50]
 * @param {number}  [opts.offset=0]
 * @returns {{ entries: object[], total: number }}
 */
async function listLog(db, {
  link_type = null, link_id = null, type = null, types = null,
  q = null, direction = null, from_date = null, to_date = null, by=null,
  limit = 50, offset = 0
} = {}) {

  const where = [];
  const params = [];

  if (by) {
    where.push('l.log_by = ?');
    params.push(by);
  }
  if (link_type && link_id) {
    // Match on new columns OR legacy column for backward compat
    where.push(`(
      (l.log_link_type = ? AND l.log_link_id = ?)
      OR (l.log_link_type IS NULL AND l.log_link = ?)
    )`);
    params.push(link_type, String(link_id), String(link_id));
  }

  if (types && types.length) {
    where.push(`l.log_type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  } else if (type) {
    where.push('l.log_type = ?');
    params.push(type);
  }

  if (direction) {
    where.push('l.log_direction = ?');
    params.push(direction);
  }

  if (from_date) {
    where.push('l.log_date >= ?');
    params.push(from_date);
  }

  if (to_date) {
    where.push('l.log_date < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(to_date);
  }

  if (q) {
    const like = `%${q}%`;
    where.push(`(l.log_data LIKE ? OR l.log_from LIKE ? OR l.log_to LIKE ?
                 OR l.log_subject LIKE ? OR CAST(l.log_link AS CHAR) LIKE ?)`);
    params.push(like, like, like, like, like);
  }

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // H-bug fix (Track A.1 Phase A):
  //   The contacts and cases LEFT JOINs are now gated on log_link_type.
  //   Without the gate, a row whose log_link_id (or legacy log_link)
  //   happens to coincide with a contact_id / case_id / case_number
  //   from an unrelated entity type would get hydrated with the wrong
  //   contact/case name. Legacy NULL-type rows preserved by the
  //   `OR log_link_type IS NULL` branch.
  const [entries] = await db.query(
    `SELECT
     l.log_id, l.log_type, l.log_date, l.log_link,
     l.log_link_type, l.log_link_id, l.log_by, l.log_data,
     l.log_from, l.log_to, l.log_subject, l.log_direction,
     u.user_name AS by_name,
     DATE_FORMAT(l.log_date, '%M %e, %Y at %h:%i %p') AS formatted_date,
     c.contact_name, c.contact_id,
     ca.case_id,
     COALESCE(ca.case_number_full, ca.case_number) AS case_number
   FROM log l
   LEFT JOIN users    u  ON l.log_by = u.user
   LEFT JOIN contacts c  ON l.log_link = c.contact_id
                        AND (l.log_link_type = 'contact' OR l.log_link_type IS NULL)
   LEFT JOIN cases    ca ON (l.log_link = ca.case_id
                             OR l.log_link = ca.case_number
                             OR l.log_link = ca.case_number_full)
                         AND l.log_link != ''
                         AND (l.log_link_type = 'case' OR l.log_link_type IS NULL)
   ${whereSQL}
   ORDER BY l.log_date DESC
   LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM log l ${whereSQL}`,
    params
  );

  return { entries, total };
}


// ─────────────────────────────────────────────────────────────
// getLogEntry
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single log entry by ID.
 * @param {object} db
 * @param {number} logId
 * @returns {object|null}
 */
async function getLogEntry(db, logId) {
  const [[entry]] = await db.query(
    `SELECT
       l.*,
       u.user_name AS by_name
     FROM log l
     LEFT JOIN users u ON l.log_by = u.user
     WHERE l.log_id = ?`,
    [logId]
  );
  return entry || null;
}


// ─────────────────────────────────────────────────────────────
// createLogEntry
// ─────────────────────────────────────────────────────────────

/**
 * Insert a log entry.
 *
 * Writes all three link columns (legacy log_link + new log_link_type/log_link_id).
 * The contacts table has a DB trigger that writes 'update' logs automatically
 * on contact changes — don't call this for contact field updates.
 *
 * Track A.1 Phase A: when link_type is 'phone', link_id is normalized to
 * 10 digits and validated (must be 10 digits after stripping non-digits;
 * +1 country code is stripped). When link_type is 'email', link_id is
 * trimmed and lowercased and validated (must contain '@' and be non-empty
 * after trim). Invalid values throw `Error` with `err.code =
 * 'INVALID_LOG_LINK_ID'` so routes can map to a 400.
 *
 * For phone/email types, the legacy log_link column is set to '' — the
 * value lives in log_link_id; log_link is reserved for entity-ID
 * references (contact/case/appt/bill).
 *
 * Phase 2 — unified log_data shape:
 *   The typed display params from/to/subject/message are folded into
 *   the log_data JSON before insert. The renderer reads log_data
 *   generically (one row per key); putting the message text into the
 *   JSON makes new rows self-describing without changing the
 *   renderer. The typed cols (log_from etc.) are still written for
 *   back-compat / indexing. Caller-supplied keys in `data` win over
 *   the typed-param folds (explicit data wins). Direction stays
 *   column-only since the renderer surfaces it as a separate icon.
 *
 *   Plain-string `data` (a non-empty string that isn't JSON-parsable)
 *   is left untouched — we can't safely splice typed params into an
 *   opaque string. Such callers get the old behaviour and miss the
 *   enrichment; in practice, all current callers pass an object or a
 *   JSON-stringified object.
 *
 * Phase 3 Slice 1 — log_extra split:
 *   The new `extra` param (object or JSON-string-of-object) is written
 *   to the log_extra JSON column. Use for IT-facing fields that should
 *   not clutter the user-facing log_data render. Empty attachments are
 *   stripped from log_data; see top-file docstring for the strip rules.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  opts.type        - log_type enum (required)
 * @param {string}  [opts.link_type] - 'contact','case','appt','bill','phone','email'
 * @param {string}  [opts.link_id]   - the linked entity ID, or phone/email value
 * @param {number}  [opts.by=0]      - user ID (0 = system/automation)
 * @param {string|object} [opts.data=''] - log_data (JSON string or object, auto-stringified)
 * @param {object|string} [opts.extra]   - log_extra (JSON object or JSON-string-of-object).
 *                                         Null/empty/non-object → SQL NULL.
 * @param {string}  [opts.from]      - log_from + folded into log_data.from
 * @param {string}  [opts.to]        - log_to + folded into log_data.to
 * @param {string}  [opts.subject]   - log_subject + folded into log_data.subject
 * @param {string}  [opts.message]   - log_message + folded into log_data.message
 * @param {string}  [opts.direction] - 'incoming' or 'outgoing' (normalized from
 *                                     'Inbound'/'Outbound'/etc.) — column only
 * @returns {{ log_id: number }}
 */
async function createLogEntry(db, {
  type,
  link_type  = null,
  link_id    = null,
  by         = 0,
  data       = '',
  extra      = null,
  from       = null,
  to         = null,
  subject    = null,
  message    = null,
  direction  = null
}) {
  if (!type) throw new Error('createLogEntry requires type');

  // Track A.1 Phase A: normalize/validate phone & email link_ids and
  // suppress the legacy log_link mirror for those types.
  let normalizedLinkId = link_id != null ? String(link_id) : null;
  let logLink;

  if (link_type === 'phone') {
    const norm = _normalizePhone(normalizedLinkId);
    if (!norm || norm.length !== 10) {
      const err = new Error(
        `Invalid phone for log_link_id: ${JSON.stringify(link_id)}. ` +
        `Must normalize to exactly 10 digits.`
      );
      err.code = 'INVALID_LOG_LINK_ID';
      throw err;
    }
    normalizedLinkId = norm;
    logLink = '';
  } else if (link_type === 'email') {
    const norm = _normalizeEmail(normalizedLinkId);
    if (!norm || !norm.includes('@')) {
      const err = new Error(
        `Invalid email for log_link_id: ${JSON.stringify(link_id)}. ` +
        `Must be non-empty and contain '@'.`
      );
      err.code = 'INVALID_LOG_LINK_ID';
      throw err;
    }
    normalizedLinkId = norm;
    logLink = '';
  } else {
    // Unchanged behavior for contact/case/appt/bill/null link_types
    logLink = link_id != null ? String(link_id) : '';
  }
/* TEMP FIX FOR RC OUT (1/3): */
// Phase 2 ext: canonicalize from/to for phone-bearing log types.
  // External providers vary: RC inbound transform produces 10-digit (norm10
  // in the transform), RC outbound path's wf 15 step 2 set_vars produces
  // +1-prefixed E.164 from the fetched message-store response, Quo always
  // ships +1-prefixed. Normalizing at the chokepoint means callers don't
  // need to remember the convention; all phone-bearing rows land 10-digit.
  //
  // Conservative: only touch sms/call (unambiguously phone fields). Replace
  // only if normalization yields exactly 10 digits — international numbers
  // or malformed strings pass through unchanged rather than getting mangled.
  // Email's from/to is left alone because "Name <addr@host>" formats would
  // be destroyed by phone-style stripping.
  let normalizedFrom = from;
  let normalizedTo   = to;
  if (type === 'sms' || type === 'call') {
    if (from != null && from !== '') {
      const n = _normalizePhone(from);
      if (n.length === 10) normalizedFrom = n;
    }
    if (to != null && to !== '') {
      const n = _normalizePhone(to);
      if (n.length === 10) normalizedTo = n;
    }
  }
  /*END TEMP FIX PART 1 */

  // Slice 4-C: normalize direction at the write boundary. The caller's
  // workflow variable / API input retains its raw upstream value (useful
  // for evaluate_condition branches in wf 15); only the DB write conforms
  // to the log_direction ENUM.
  const normalizedDirection = _normalizeDirection(direction);

  // Phase 2: build the unified log_data shape.
  //   - data is null/empty            → start with {}
  //   - data is an object             → shallow-copy
  //   - data is JSON-string-of-object → parse, shallow-copy
  //   - data is plain string          → leave alone (can't enrich safely)
  let dataObj = null;
  if (data == null || data === '') {
    dataObj = {};
  } else if (typeof data === 'object' && !Array.isArray(data)) {
    dataObj = { ...data };
  } else if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        dataObj = { ...parsed };
      }
    } catch { /* not JSON — leave data as-is */ }
  }

  let logData;
  if (dataObj !== null) {
    // Fold typed display params into log_data without overwriting
    // caller-supplied keys. Direction intentionally omitted — rendered
    // separately by the UI.
    /* TEMP FIX P2/3
    if (from    != null && dataObj.from    === undefined) dataObj.from    = from;
    if (to      != null && dataObj.to      === undefined) dataObj.to      = to;
*/
    if (normalizedFrom != null && dataObj.from === undefined) dataObj.from = normalizedFrom;
    if (normalizedTo   != null && dataObj.to   === undefined) dataObj.to   = normalizedTo;
    /* END TEMP FIX P2 */
    if (subject != null && dataObj.subject === undefined) dataObj.subject = subject;
    if (message != null && message !== '' && dataObj.message === undefined) {
      dataObj.message = message;
    }


    // Phase 3 Slice 1 follow-up: normalize data.direction. The workflow
    // placeholder system passes raw provider values ("Outbound" from RC
    // message-store, etc.) into data.direction when the workflow
    // explicitly sets it (Q1(a) decision). Normalize here so the
    // user-facing render stays consistent with the log_direction column.
    // Unknown values pass through unchanged.
    if (dataObj.direction != null && dataObj.direction !== '') {
      dataObj.direction = _normalizeDirection(dataObj.direction);
    }

    // Phase 3 Slice 1 (Q4 ii-strict): strip empty attachments from log_data.
    // Empty includes null, '', and []. The "[object Object],[object Object]..."
    // string produced by the deferred Phase-2 fix #1 placeholder coercion is
    // intentionally NOT stripped — hiding it would delay prioritizing the MMS
    // engine fix.
    if ('attachments' in dataObj) {
      const a = dataObj.attachments;
      if (a == null || a === '' || (Array.isArray(a) && a.length === 0)) {
        delete dataObj.attachments;
      }
    }

    logData = JSON.stringify(dataObj);
  } else {
    // Plain-string fallback path.
    logData = data;
  }

  // Phase 3 Slice 1: coerce `extra` to a JSON string for the log_extra column.
  // Mirrors the `data` handling: accept object or JSON-string-of-object,
  // write SQL NULL for anything else (null, '', arrays, plain non-JSON strings,
  // numbers). This is intentional — log_extra is for structured IT data only.
  let logExtra = null;
  if (extra != null && extra !== '') {
    if (typeof extra === 'object' && !Array.isArray(extra)) {
      logExtra = JSON.stringify(extra);
    } else if (typeof extra === 'string') {
      try {
        const parsed = JSON.parse(extra);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          logExtra = JSON.stringify(parsed);
        }
      } catch { /* not JSON — leave null */ }
    }
  }

  console.log(
    `[CREATE_LOG] type=${type} link=${link_type}:${link_id} by=${by} ` +
    `direction=${direction}\u2192${normalizedDirection} extra=${logExtra ? 'set' : 'null'}`
  );

  const [result] = await db.query(
    `INSERT INTO log
       (log_type, log_date, log_link, log_link_type, log_link_id,
        log_by, log_data, log_extra, log_from, log_to, log_subject, log_message, log_direction)
     VALUES (?, CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'), ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      type,
      logLink,
      link_type,
      normalizedLinkId,
      by,
      logData,
      logExtra,
      /* TEMP FIX P3/3
      from,
      to,*/
      normalizedFrom,
      normalizedTo,
      /* END TEMP FIX P3 */
      subject,
      message || '',
      normalizedDirection
    ]
  );

  return { log_id: result.insertId };
}


module.exports = {
  listLog,
  getLogEntry,
  createLogEntry
};