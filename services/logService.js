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
 * Log reader semantic unification (Slice 1):
 *   - Two private-but-exported helpers, _buildContactLogWhere and
 *     _buildCaseLogWhere, produce the WHERE fragments (+ params) used by
 *     listLog when link_type is 'contact' or 'case'. They are also called
 *     directly by contactService.getContact and caseService.getCase so
 *     all four log readers (global feed, contact view, case view, future
 *     legacy-file conversions) produce consistent results.
 *   - Underscore-prefixed but exported: "internal but cross-service usable."
 *   - Contact view = contact-typed + NULL-typed legacy + phone/email logs
 *     attributed to this contact via contact_phones/contact_emails date
 *     windows.
 *   - Case view = case-typed + NULL-typed legacy (matched against case_id,
 *     case_number, and case_number_full until Slice 2 normalization lands)
 *     + each related contact's contact-view fragment, gated by
 *     case_relate_filter ('default' = Primary/Secondary/Other; 'all' = no
 *     type filter; 'none' = case-only, no related-contact merge).
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
 * Case-insensitive own-key presence check on a plain object.
 * Returns true if `obj` has any own key whose lowercase form equals
 * `key.toLowerCase()`. Used by the createLogEntry typed-param fold so a
 * caller-supplied {From} blocks the fold from adding a lowercase {from}
 * twin (which the log renderer would print as a duplicate row).
 */
function _hasKeyCI(obj, key) {
  if (!obj || typeof obj !== 'object') return false;
  const want = String(key).toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === want) return true;
  }
  return false;
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
// Log-WHERE builders (semantic-unification helpers)
//
// Both helpers return { whereFragment, params } where whereFragment is
// a parenthesized boolean expression suitable to drop into a WHERE
// clause (or AND-joined with other predicates). They do NOT execute
// queries themselves (except _buildCaseLogWhere, which needs two
// lookups to resolve the case row and its related contacts).
//
// These helpers are exposed on the module exports as
// _buildContactLogWhere / _buildCaseLogWhere so contactService.getContact
// and caseService.getCase can share the exact same logic that
// /api/log?link_type=contact|case uses.
// ─────────────────────────────────────────────────────────────

/**
 * Build a WHERE fragment matching all log rows attributable to a
 * single contact. Four sources:
 *   1. log_link_type = 'contact' AND log_link_id = contactId
 *   2. Legacy NULL-typed rows where log_link = contactId
 *   3. log_link_type = 'phone' rows whose log_link_id (a 10-digit
 *      phone) was owned by this contact at the time the log was
 *      written (per contact_phones date window).
 *   4. log_link_type = 'email' rows, same pattern via contact_emails.
 *
 * Date-window math: cp.start_date <= DATE(log_date)
 *   AND (cp.end_date IS NULL OR cp.end_date >= DATE(log_date)).
 *   Per the contact_phones/contact_emails "end day before transfer"
 *   rule this yields single attribution — no log surfaces under two
 *   contacts on the transfer day.
 *
 * Param-typing matches the existing contactService.getContact log
 * block: first two params are stringified (log_link_id / log_link are
 * varchar), latter two are raw (cp.contact_id / ce.contact_id are INT).
 * Don't change this without verifying the column types haven't moved.
 *
 * @param {number|string} contactId
 * @returns {{ whereFragment: string, params: (string|number)[] }}
 */
function _buildContactLogWhere(contactId) {
  const whereFragment = `(
       (l.log_link_type = 'contact' AND l.log_link_id = ?)
    OR (l.log_link_type IS NULL    AND l.log_link    = ?)
    OR (l.log_link_type = 'phone'  AND EXISTS (
          SELECT 1 FROM contact_phones cp
           WHERE cp.contact_id = ?
             AND cp.phone      = l.log_link_id
             AND (cp.start_date IS NULL OR cp.start_date <= DATE(l.log_date))
             AND (cp.end_date   IS NULL OR cp.end_date   >= DATE(l.log_date))
       ))
    OR (l.log_link_type = 'email'  AND EXISTS (
          SELECT 1 FROM contact_emails ce
           WHERE ce.contact_id = ?
             AND ce.email      = l.log_link_id
             AND (ce.start_date IS NULL OR ce.start_date <= DATE(l.log_date))
             AND (ce.end_date   IS NULL OR ce.end_date   >= DATE(l.log_date))
       ))
  )`;
  return {
    whereFragment,
    params: [String(contactId), String(contactId), contactId, contactId]
  };
}

/**
 * Build a WHERE fragment matching all log rows attributable to a case.
 *
 * Case-scope:
 *   - log_link_type = 'case' AND log_link_id IN (case_id, case_number, case_number_full)
 *   - log_link_type IS NULL  AND log_link    IN (same 3 values)
 *   The IN list against three case identifiers is the "Slice 2 hasn't
 *   normalized log_link/log_link_id yet" workaround: court-email logs
 *   write the docket-style case number, manual notes may write either,
 *   and we want all of them surfacing on the case view.
 *
 * Related-contact merge:
 *   - For each related contact (resolved via case_relate, filtered by
 *     `relateFilter`), OR in the four-source contact fragment so the
 *     case view also surfaces those contacts' logs (including
 *     phone/email-typed rows attributed by date window).
 *
 * If case_number / case_number_full are NULL on the case row, they are
 * substituted with '' in the IN list. log_link / log_link_id are never
 * legitimately '' for case-scope rows (Phase-A wrote '' for phone/email
 * rows only, and those carry log_link_type='phone'/'email', not 'case'
 * or NULL), so the empty-string substitute can never spuriously match.
 * Passing literal NULL into IN(...) would make the predicate
 * un-matchable AND clutter the plan; the substitute keeps the SQL flat.
 *
 * If the case is not found, falls back to a minimal fragment matching
 * the raw caseId — don't throw; the caller may pass a non-existent ID.
 *
 * @param {object} db                       - mysql2 pool/conn
 * @param {string} caseId
 * @param {object} [opts]
 * @param {string} [opts.relateFilter='default']
 *   'default' → case_relate_type IN ('Primary','Secondary','Other')
 *   'all'     → all related contacts (includes 'Bystander')
 *   'none'    → no related-contact merge; case-scope only
 * @returns {Promise<{ whereFragment: string, params: (string|number)[] }>}
 */
async function _buildCaseLogWhere(db, caseId, { relateFilter = 'default' } = {}) {
  // 1) Resolve case row for the three-ID IN-list scope.
  const [[caseRow]] = await db.query(
    'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = ?',
    [caseId]
  );

  if (!caseRow) {
    // Case not found: minimal fragment against the raw caseId.
    const whereFragment = `(
         (l.log_link_type = 'case' AND l.log_link_id = ?)
      OR (l.log_link_type IS NULL  AND l.log_link    = ?)
    )`;
    return {
      whereFragment,
      params: [String(caseId), String(caseId)]
    };
  }

  // NULL → '' sentinel for IN-list (see docstring rationale).
  const caseIdsForIn = [
    String(caseRow.case_id),
    caseRow.case_number      != null ? String(caseRow.case_number)      : '',
    caseRow.case_number_full != null ? String(caseRow.case_number_full) : ''
  ];

  // 2) Resolve related contacts per filter.
  let relatedContactIds = [];
  if (relateFilter !== 'none') {
    let relateSQL;
    const relateParams = [caseId];
    if (relateFilter === 'all') {
      relateSQL = `SELECT case_relate_client_id
                     FROM case_relate
                    WHERE case_relate_case_id = ?`;
    } else {
      // 'default'
      relateSQL = `SELECT case_relate_client_id
                     FROM case_relate
                    WHERE case_relate_case_id = ?
                      AND case_relate_type IN ('Primary','Secondary','Other')`;
    }
    const [relRows] = await db.query(relateSQL, relateParams);
    relatedContactIds = relRows.map(r => r.case_relate_client_id);
  }

  // 3) Build the OR-list fragment dynamically.
  const orParts = [];
  const params = [];

  // 3a. Case-scope: two clauses, three params each.
  orParts.push(`(l.log_link_type = 'case' AND l.log_link_id IN (?, ?, ?))`);
  params.push(...caseIdsForIn);
  orParts.push(`(l.log_link_type IS NULL  AND l.log_link    IN (?, ?, ?))`);
  params.push(...caseIdsForIn);

  // 3b. Per-related-contact: four clauses, four params each (mirrors
  //     _buildContactLogWhere). Inlined rather than calling the helper
  //     so the OR-list is flat — one parens-deep, easier to read in
  //     EXPLAIN.
  for (const cid of relatedContactIds) {
    orParts.push(`(l.log_link_type = 'contact' AND l.log_link_id = ?)`);
    params.push(String(cid));

    orParts.push(`(l.log_link_type IS NULL    AND l.log_link    = ?)`);
    params.push(String(cid));

    orParts.push(`(l.log_link_type = 'phone'  AND EXISTS (
        SELECT 1 FROM contact_phones cp
         WHERE cp.contact_id = ?
           AND cp.phone      = l.log_link_id
           AND (cp.start_date IS NULL OR cp.start_date <= DATE(l.log_date))
           AND (cp.end_date   IS NULL OR cp.end_date   >= DATE(l.log_date))
      ))`);
    params.push(cid);

    orParts.push(`(l.log_link_type = 'email'  AND EXISTS (
        SELECT 1 FROM contact_emails ce
         WHERE ce.contact_id = ?
           AND ce.email      = l.log_link_id
           AND (ce.start_date IS NULL OR ce.start_date <= DATE(l.log_date))
           AND (ce.end_date   IS NULL OR ce.end_date   >= DATE(l.log_date))
      ))`);
    params.push(cid);
  }

  const whereFragment = `(\n    ${orParts.join('\n    OR ')}\n  )`;
  return { whereFragment, params };
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
 * Slice 1 semantic unification: when link_type is 'contact' or 'case',
 * the WHERE fragment is delegated to _buildContactLogWhere /
 * _buildCaseLogWhere so the global feed surfaces the same
 * date-windowed phone/email matches (contact) and related-contact
 * merge (case) that the entity views surface. Other link_types
 * ('appt','bill','phone','email','task') retain the original literal
 * match.
 *
 * The LEFT JOINs to contacts and cases are gated on log_link_type so
 * non-contact/non-case rows (phone, email, future task, etc.) don't
 * accidentally hydrate contact/case fields when their log_link value
 * coincidentally matches a contact_id or case_number. Legacy NULL-type
 * rows still hydrate (back-compat).
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  [opts.link_type]          - 'contact','case','appt','bill','phone','email'
 * @param {string}  [opts.link_id]            - the ID/value to filter by
 * @param {string}  [opts.type]               - log_type enum filter
 * @param {string[]}[opts.types]              - array of log_types (OR-matched)
 * @param {string}  [opts.q]                  - search across log_data/from/to/subject/link
 * @param {string}  [opts.direction]          - 'incoming' or 'outgoing'
 * @param {string}  [opts.from_date]          - ISO datetime lower bound
 * @param {string}  [opts.to_date]            - ISO datetime upper bound
 * @param {number}  [opts.by]                 - user ID filter
 * @param {string}  [opts.case_relate_filter='default']
 *   For link_type='case': 'default' = Primary/Secondary/Other,
 *   'all' = include Bystander, 'none' = no related-contact merge.
 *   Ignored for other link_types.
 * @param {number}  [opts.limit=50]
 * @param {number}  [opts.offset=0]
 * @returns {{ entries: object[], total: number }}
 */
async function listLog(db, {
  link_type = null, link_id = null, type = null, types = null,
  q = null, direction = null, from_date = null, to_date = null, by=null,
  case_relate_filter = 'default',
  limit = 50, offset = 0
} = {}) {

  const where = [];
  const params = [];

  if (by) {
    where.push('l.log_by = ?');
    params.push(by);
  }
  if (link_type && link_id) {
    if (link_type === 'contact') {
      const { whereFragment, params: contactParams } = _buildContactLogWhere(link_id);
      where.push(whereFragment);
      params.push(...contactParams);
    } else if (link_type === 'case') {
      const { whereFragment, params: caseParams } =
        await _buildCaseLogWhere(db, link_id, { relateFilter: case_relate_filter });
      where.push(whereFragment);
      params.push(...caseParams);
    } else {
      // Literal match preserved for appt/bill/phone/email/task and any
      // future enum value.
      where.push(`(
        (l.log_link_type = ? AND l.log_link_id = ?)
        OR (l.log_link_type IS NULL AND l.log_link = ?)
      )`);
      params.push(link_type, String(link_id), String(link_id));
    }
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
  //
  // Slice 4 (entity hydration):
  //   Added LEFT JOINs to contact_phones / contact_emails (date-windowed
  //   on log_date) so phone- and email-typed rows arrive at the renderer
  //   with contact_id/contact_name populated when resolvable. The gate
  //   on l.log_link_type='phone'/'email' inside the JOIN ON clause is
  //   load-bearing — without it, any row whose log_link_id happened to
  //   be phone-shaped or email-shaped would spuriously hydrate (a phone/
  //   email H-bug analogue).
  //
  //   Slice 3.5's single-attribution invariant (donor end_date set to
  //   yesterday on cross-contact transfer) guarantees no row duplication
  //   from the phone/email joins — verified at deploy time as 50,126
  //   baseline preserved through both joins independently.
  //
  //   The contact_id / contact_name COALESCE resolves in priority order:
  //   contact-typed direct match first (c), then phone-window (c_phone),
  //   then email-window (c_email). Only one of these can be non-null per
  //   row (mutually exclusive on log_link_type).
  //
  //   NOTE on pre-existing cases-JOIN inflation: the triple-OR in the
  //   cases JOIN can multiply rows when two cases share case_number or
  //   case_number_full (data-quality issue, not a JOIN-logic issue).
  //   Slice 4 does NOT worsen this — verified pre/post COUNT(*) both
  //   yield the same inflated total. Tracking separately.
  const [entries] = await db.query(
    `SELECT
     l.log_id, l.log_type, l.log_date, l.log_link, l.log_extra,
     l.log_link_type, l.log_link_id, l.log_by, l.log_data,
     l.log_from, l.log_to, l.log_subject, l.log_direction,
     u.user_name AS by_name,
     DATE_FORMAT(l.log_date, '%M %e, %Y at %h:%i %p') AS formatted_date,
     COALESCE(c.contact_name, c_phone.contact_name, c_email.contact_name) AS contact_name,
     COALESCE(c.contact_id,   c_phone.contact_id,   c_email.contact_id)   AS contact_id,
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
   LEFT JOIN contact_phones cp ON l.log_link_type = 'phone'
                              AND cp.phone        = l.log_link_id
                              AND (cp.start_date IS NULL OR cp.start_date <= DATE(l.log_date))
                              AND (cp.end_date   IS NULL OR cp.end_date   >= DATE(l.log_date))
   LEFT JOIN contacts c_phone  ON c_phone.contact_id = cp.contact_id
   LEFT JOIN contact_emails ce ON l.log_link_type = 'email'
                              AND ce.email        = l.log_link_id
                              AND (ce.start_date IS NULL OR ce.start_date <= DATE(l.log_date))
                              AND (ce.end_date   IS NULL OR ce.end_date   >= DATE(l.log_date))
   LEFT JOIN contacts c_email  ON c_email.contact_id = ce.contact_id
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

  // Slice 2-C cleanup: the per-caller phone canonicalization slap-on that
  // used to live here (TEMP FIX FOR RC OUT) is gone. All callers now emit
  // 10-digit phones at the source:
  //   - 5 hook transforms (rc-message-in/out, rc-call, quo-message, quo-call)
  //     all run norm10/stripPlusOne in JS before set_vars.
  //   - wf 19 step 3 custom_code explicitly strips +1 before set_vars.
  //   - wf 20 step 3 reads RC call-log records which are already 10-digit.
  //   - communicate.html POSTs 10-digit (phone_lines.phone_number is char(10);
  //     manual to-field uses .replace(/\D/g,'') + 10-digit validation).
  // The column-level _normalizeDirection() below stays — cheap defense at the
  // ENUM write boundary against any future caller that supplies "Inbound" etc.

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
    //
    // CASE-INSENSITIVE: a caller may already carry the content under a
    // differently-cased key (e.g. email ingest builds {From,To,Subject,
    // Message}). The fold must not add a lowercase twin of an existing
    // cased key, or the renderer prints both — the email log double-render
    // bug. `_hasKeyCI` treats {From} as already satisfying `from`, so the
    // fold no-ops and the existing cased key wins.
    if (from    != null && !_hasKeyCI(dataObj, 'from'))    dataObj.from    = from;
    if (to      != null && !_hasKeyCI(dataObj, 'to'))      dataObj.to      = to;
    if (subject != null && !_hasKeyCI(dataObj, 'subject')) dataObj.subject = subject;
    if (message != null && message !== '' && !_hasKeyCI(dataObj, 'message')) {
      dataObj.message = message;
    }

    // Slice 2-C cleanup: dropped the dataObj.direction normalization slap-on
    // that was added in Phase 3 Slice 1 follow-up. The per-provider workflows
    // (wf 17–21) now emit canonical 'incoming'/'outgoing' in data.direction
    // (wf 19 step 8 hardcodes 'outgoing'; wf 20 step 8 forwards the variable
    // set from rc-call transform which is already canonical; quo hooks
    // emit canonical from the transform). The column-level direction
    // normalization below remains as defense-in-depth.

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
      from,
      to,
      subject,
      message || '',
      normalizedDirection
    ]
  );

  return { log_id: result.insertId };
}


// ─────────────────────────────────────────────────────────────
// getOrphanEarliestDate
// ─────────────────────────────────────────────────────────────

/**
 * Find the earliest log_date for an orphan phone/email value — i.e. a
 * log row whose log_link_type is 'phone' or 'email' and whose log_link_id
 * holds the normalized value. Backs GET /api/log/orphan-earliest, which the
 * OrphanAdoptDialog uses to default the "start date on contact" field to the
 * first date the value was ever seen in the log.
 *
 * Normalization mirrors createLogEntry's link_id handling so the lookup form
 * matches the stored form: phone → 10 digits via _normalizePhone, email →
 * trim+lowercase via _normalizeEmail. An invalid/short value yields a null
 * result rather than throwing (the route validates type; value shape is
 * fail-soft here — a stale UI could pass a malformed value).
 *
 * @param {object} db
 * @param {'phone'|'email'} type
 * @param {string} value
 * @returns {Promise<{ earliest_log_date: string|null }>}  date as 'YYYY-MM-DD'
 */
async function getOrphanEarliestDate(db, type, value) {
  let normalized;
  if (type === 'phone') {
    normalized = _normalizePhone(value);
    if (!normalized || normalized.length !== 10) return { earliest_log_date: null };
  } else if (type === 'email') {
    normalized = _normalizeEmail(value);
    if (!normalized || !normalized.includes('@')) return { earliest_log_date: null };
  } else {
    return { earliest_log_date: null };
  }

  const [[row]] = await db.query(
    `SELECT DATE_FORMAT(MIN(log_date), '%Y-%m-%d') AS earliest
       FROM log
      WHERE log_link_type = ? AND log_link_id = ?`,
    [type, normalized]
  );

  return { earliest_log_date: (row && row.earliest) || null };
}


module.exports = {
  listLog,
  getLogEntry,
  createLogEntry,
  getOrphanEarliestDate,
  // Slice 1 semantic unification: exposed for contactService.getContact
  // and caseService.getCase. Underscore-prefixed = "internal but
  // cross-service usable" — please don't call from frontend or routes.
  _buildContactLogWhere,
  _buildCaseLogWhere
};