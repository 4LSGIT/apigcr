// lib/ingestSampleProjection.js
//
/**
 * Ingest Sample — Projection Core (SHARED: email + phone)
 * lib/ingestSampleProjection.js
 *
 * The genuinely-shared core behind both ingest "sample event" panels. Given a
 * plain event object and a match-field catalog, it projects the object down to
 * exactly the catalog paths and returns display-safe {path,label,type,present,
 * value} rows for the rule/suppression editor's field-discovery panel.
 *
 * WHY A SHARED CORE:
 *   The phone and email sample SERVICES differ only in how they SOURCE an event
 *   object (phone reads the clean create_log params straight out of
 *   phone_ingest_executions.raw_input; email RECONSTRUCTS one from email_log +
 *   log.log_extra, optionally overlaid with intact raw_input). Everything after
 *   "we have an event object + a catalog" is identical, so it lives here once.
 *   The per-page services (phoneIngestSampleService / emailIngestSampleService)
 *   are thin SOURCE ADAPTERS that fetch rows, shape an event object, and call
 *   projectEvent(event, catalog).
 *
 * PROJECTION-LIMIT (load-bearing, NOT privacy):
 *   We emit ONLY the catalog paths — never the raw object, never off-catalog
 *   keys (_variables, data.fetch_records on phone; raw/html/text/envelope on
 *   email). This is CORRECTNESS, not redaction: off-catalog paths are unstable
 *   and not matchable, so surfacing them would invite rules that silently never
 *   match. (There is NO value redaction — all firm staff already see this
 *   content in the logs; the rule-config surface is the same audience seeing
 *   the same data. The old phone `message` redaction was removed deliberately.)
 *
 * PRESENT vs NULL (load-bearing distinction):
 *   `present` is about KEY-CHAIN EXISTENCE, independent of the value.
 *     - present:false            → the key chain didn't exist on this event
 *                                  ("not captured in this sample"). The catalog
 *                                  still lists the field as matchable.
 *     - present:true, value:null → the key EXISTS and is genuinely null. Real
 *                                  case: outbound / from-firm email carries
 *                                  `auth` with null spf/dkim/dmarc sub-values.
 *   Callers (the frontend panel) MUST render these two cases distinctly: a real
 *   null reads as "exists and is empty", an absent field reads as "missing".
 */

/**
 * Resolve a dotted path ('extra.firmToFirm', 'auth.spf') against an object.
 * Returns { present, value }. present=false means the key chain didn't exist
 * (vs a real null/'' value, which is present=true). This separation is the
 * present-vs-null distinction documented above — do not collapse it.
 *
 * @param {object} obj
 * @param {string} path
 * @returns {{present: boolean, value: *}}
 */
function _resolvePath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) {
      return { present: false, value: undefined };
    }
    cur = cur[part];
  }
  return { present: true, value: cur };
}

/**
 * Coerce a resolved value into a compact, JSON-safe display form. Objects and
 * arrays are SUMMARIZED rather than dumped (the catalogs don't point at nested
 * objects today, but be defensive — a summarized blob is safer than leaking a
 * large nested structure into the config UI). Scalars pass through as-is so the
 * frontend can format null/boolean/number/string itself.
 *
 * NOTE: no redaction branch. Real values are shown. (See header.)
 *
 * @param {boolean} present
 * @param {*} value
 * @returns {*} string | number | boolean | null
 */
function _displayValue(present, value) {
  if (!present) return null;
  if (value === null) return null;            // genuine null — caller renders "null"
  if (Array.isArray(value)) return `‹array, ${value.length} item${value.length === 1 ? '' : 's'}›`;
  if (typeof value === 'object') return `‹object›`;
  return value; // string | number | boolean — JSON-safe as-is
}

/**
 * Project one event object down to the catalog field rows.
 *
 * @param {object} event   The (already-sourced) event object.
 * @param {Array<{path:string,label:string,type:string,channels?:string[]}>} catalog
 *        The match-field catalog (phone's MATCH_FIELDS or email's MATCH_FIELDS).
 * @returns {Array<{path,label,type,present,value}>}
 */
function projectEvent(event, catalog) {
  const ev = (event && typeof event === 'object') ? event : {};
  return (Array.isArray(catalog) ? catalog : []).map((f) => {
    const { present, value } = _resolvePath(ev, f.path);
    return {
      path:    f.path,
      label:   f.label,
      type:    f.type,
      present,
      value:   _displayValue(present, value),
    };
  });
}

/**
 * Parse a raw_input / JSON cell. mysql2 returns JSON columns as objects already,
 * but tolerate a stringified value (older rows / tooling) and never throw —
 * unparseable input returns null so adapters can decide how to degrade.
 *
 * @param {*} raw
 * @returns {object|null}
 */
function _parseRawInput(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

module.exports = {
  projectEvent,
  _resolvePath,
  _displayValue,
  _parseRawInput,
};