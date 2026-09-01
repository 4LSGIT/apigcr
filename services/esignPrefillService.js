// services/esignPrefillService.js
//
/**
 * PREFILL RESOLUTION — template placeholder values from a case.
 * services/esignPrefillService.js
 *
 * Phase 2B. A template's prefill_schema declares keys; each key may name a
 * RESOLVER — a string like 'debtor1.name' — that maps to real data on the
 * case the document is being sent for. This module owns that mapping.
 *
 * ── THE WHITELIST IS LITERAL ────────────────────────────────────────────────
 * RESOLVERS is an explicit map: resolver string → function. There is NO
 * dot-path eval and NO dynamic property walk — 'debtor1.name' is an opaque
 * NAME that happens to contain a dot, not a path into anything. A resolver
 * that is not a key of this map does not exist; esignTemplateService rejects
 * it at save time (ESIGN_BAD_RESOLVER) using RESOLVER_NAMES below.
 *
 * ── DATA CONVENTIONS (read from the repo, verified against live data) ───────
 *   debtor1 = the case's 'Primary' contact via case_relate. Among multiple
 *             Primaries, MIN(contact_id) — the same determinism rule
 *             caseService.searchCases uses. (Live data 2026-07-19: every one
 *             of 1,066 case_relate Primary rows is the only Primary on its
 *             case, so the tiebreak is dormant.)
 *   debtor2 = the case's 'Secondary' contact (the joint debtor), lowest
 *             case_relate_id first. Live data: 11 cases carry exactly one
 *             Secondary; none carry two. Missing joint debtor resolves to ''
 *             (empty string), never undefined — a contract renders "and ____"
 *             cleanly rather than "and undefined".
 *   case.case_number / case.case_number_full are OPAQUE STRINGS — repo rule,
 *             never parsed or validated server-side. Passed through verbatim.
 *   case.case_name — the cases table has NO name column; the repo-wide display
 *             convention for "the case's name" is the primary debtor's name
 *             (courtExecutor/eventService title convention), so that is what
 *             this resolver returns.
 *   firm.*  — lib/firmConfig cfg() over app_settings: fe-firm_phone (digits,
 *             formatted here), firm_email, fe-firm_site_url, firm_name,
 *             firm_attorney_name, and firm_address (type json_array, read via
 *             cfgJson). firm_name / firm_attorney_name keep a literal fallback
 *             so a cleared setting degrades to the previous hardcoded value;
 *             firm_address has none — see the comment at those resolvers.
 *   trustee.* — the matched entry of the `fe-trustees` json_array setting,
 *             matched on cases.case_trustee. See the TRUSTEE block below for
 *             why the match is exact-name.
 *
 * ── RESOLVER INVENTORY ──────────────────────────────────────────────────────
 *   case.case_name  case.case_number  case.case_number_full  case.debtor_names
 *   case.docket  case.chapter  case.open_date
 *   case.judge  case.trustee  case.file_date                        (G4)
 *   debtor1.name  debtor1.email  debtor1.phone
 *   debtor1.address_street  debtor1.address_csz                     (G4)
 *   debtor1.ssn_last4  debtor1.ssn_masked                           (G4)
 *   debtor2.{the same seven}
 *   trustee.name  trustee.address_street  trustee.address_csz
 *   trustee.phone  trustee.email                                    (G4)
 *   attorney.name
 *   firm.name  firm.phone  firm.email  firm.website
 *   firm.address  firm.address_line1  firm.address_line2
 *
 * ── LAYOUT LIVES IN THE TEMPLATE ────────────────────────────────────────────
 * The address resolvers come in PIECES (street / city-state-zip) rather than
 * one pre-joined block, for the reason spelled out at firm.address below:
 * interpolateTemplate HTML-escapes every value, so a '<br>' in a value renders
 * as literal '&lt;br&gt;'. A template that wants stacked lines puts each piece
 * in its own element; the empty-value-hides-label idiom
 * (`.l:has(> span:empty){display:none}`) then collapses the ones that resolved
 * to ''. That is why EVERY resolver here returns '' and never a placeholder
 * string like 'N/A' — '' is the only value a template can style away.
 *
 * ── FORMATTING ──────────────────────────────────────────────────────────────
 * By declared prefill type:  money → $X,XXX.XX;  date → MM/DD/YYYY (firm-
 * local; DATE columns arrive from mysql2 as midnight-fake-UTC, so they are
 * formatted with UTC getters — see timezoneService's header for the mismatch);
 * number → decimal string; text → trimmed passthrough. Unparseable money/
 * number/date values pass through trimmed rather than throwing: a staff
 * member typing "waived" into a fee field gets "waived" on the page, not a
 * 500.
 */

const { DateTime } = require('luxon');
const { cfg, cfgJson } = require('../lib/firmConfig');
const { FIRM_TZ } = require('./timezoneService');

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────────────────────

function _err(code, message, extra = null) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/** '2484179800' → '(248) 417-9800'; anything not 10 digits passes through. */
function formatPhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return s;
}

/** Date-ish → MM/DD/YYYY, or trimmed passthrough when unparseable. */
function formatDate(raw) {
  if (raw == null || raw === '') return '';
  let dt;
  if (raw instanceof Date) {
    // mysql2 (timezone: 'Z') reads DATE columns as midnight labeled UTC; the
    // calendar date lives in the UTC components. Reading them in FIRM_TZ
    // would shift the date back a day.
    dt = DateTime.fromJSDate(raw, { zone: 'utc' });
  } else {
    const s = String(raw).trim();
    dt = DateTime.fromISO(s, { zone: FIRM_TZ });
    if (!dt.isValid) dt = DateTime.fromFormat(s, 'MM/dd/yyyy', { zone: FIRM_TZ });
  }
  return dt && dt.isValid ? dt.toFormat('MM/dd/yyyy') : String(raw).trim();
}

/** Number-ish → '$1,234.50', or trimmed passthrough when unparseable. */
function formatMoney(raw) {
  if (raw == null || raw === '') return '';
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return String(raw).trim();
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Number-ish → decimal string, or trimmed passthrough when unparseable. */
function formatNumber(raw) {
  if (raw == null || raw === '') return '';
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : String(raw).trim();
}

/**
 * One formatter for BOTH resolved values and caller-supplied overrides, keyed
 * by the schema entry's declared type — the UI can send '1234.5' for a money
 * field and the contract still reads '$1,234.50'.
 */
function formatValue(type, raw) {
  switch (type) {
    case 'money':  return formatMoney(raw);
    case 'date':   return formatDate(raw);
    case 'number': return formatNumber(raw);
    // 'options' is LIST-valued — the only non-string prefill type. A resolver
    // hands back an array; the sending forms hand back a newline-joined
    // string (one option per line in a textarea). Either way the formatted
    // value is a cleaned string array: trimmed, empties dropped, order kept,
    // duplicates dropped (validatePlacements rejects duplicate dropdown
    // options, so dedupe here beats a send-time error for a staff-typo).
    case 'options': {
      const parts = Array.isArray(raw)
        ? raw
        : String(raw == null ? '' : raw).split(/\r?\n/);
      const out = [];
      const seen = new Set();
      for (const p of parts) {
        const t = String(p == null ? '' : p).trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
      return out;
    }
    case 'text':
    default:       return String(raw == null ? '' : raw).trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load everything the resolvers read, in three queries, ONCE per resolution —
 * resolvers then run against this context rather than each hitting the db.
 *
 * linkableType 'contact': the contact stands in as debtor1 and there is no
 * case — case.* resolvers return ''. Everything degrades to empty string,
 * never undefined.
 *
 * linkable ids bind as STRINGS at every site (cases.case_id is an 8-char
 * varchar — repo landmine).
 *
 * @returns {Promise<{caseRow: ?object, debtor1: ?object, debtor2: ?object}>}
 */
async function buildContext(db, { linkableType, linkableId } = {}) {
  const id = String(linkableId == null ? '' : linkableId).trim();
  const ctx = { caseRow: null, debtor1: null, debtor2: null };
  if (!id) return ctx;

  if (linkableType === 'contact') {
    const [[contact]] = await db.query(
      'SELECT * FROM contacts WHERE contact_id = ? LIMIT 1', [id]
    );
    ctx.debtor1 = contact || null;
    return ctx;
  }

  if (linkableType !== 'case') return ctx;

  const [[caseRow]] = await db.query(
    'SELECT * FROM cases WHERE case_id = ? LIMIT 1', [id]
  );
  ctx.caseRow = caseRow || null;
  if (!caseRow) return ctx;

  // Primary → debtor1. MIN(contact_id) among Primaries = searchCases's rule.
  const [[d1]] = await db.query(
    `SELECT co.*
       FROM case_relate cr
       JOIN contacts co ON co.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary'
      ORDER BY cr.case_relate_client_id ASC
      LIMIT 1`,
    [id]
  );
  ctx.debtor1 = d1 || null;

  // Secondary → debtor2 (the joint debtor). Lowest relate_id first.
  const [[d2]] = await db.query(
    `SELECT co.*
       FROM case_relate cr
       JOIN contacts co ON co.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Secondary'
      ORDER BY cr.case_relate_id ASC
      LIMIT 1`,
    [id]
  );
  ctx.debtor2 = d2 || null;

  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RESOLVER WHITELIST
//
// Each entry is an EXPLICIT function over the pre-loaded context. Every one
// returns a STRING — '' for absent, never null/undefined. Formatting by the
// schema's declared type happens in resolvePrefills, not here; these return
// raw-ish values (dates come out pre-formatted only where the source is a
// Date column and there is exactly one sane rendering).
// ─────────────────────────────────────────────────────────────────────────────

const s = (v) => (v == null ? '' : String(v).trim());

const RESOLVERS = Object.freeze({
  // case identity. case_number/case_number_full are OPAQUE — verbatim, always.
  'case.case_name':        (ctx) => s(ctx.debtor1 && ctx.debtor1.contact_name),
  'case.case_number':      (ctx) => s(ctx.caseRow && ctx.caseRow.case_number),
  'case.case_number_full': (ctx) => s(ctx.caseRow && ctx.caseRow.case_number_full),
  // Both debtors when the case is joint, the primary alone when it isn't —
  // "John Smith and Jane Smith". Built for the CLIENT line of the fee
  // agreements, where case.case_name (primary only) forced staff to hand-edit
  // every joint send. Falls back through each side: a joint case with a
  // nameless secondary degrades to the primary's name, not to "X and ".
  'case.debtor_names':     (ctx) => {
    const d1 = s(ctx.debtor1 && ctx.debtor1.contact_name);
    const d2 = s(ctx.debtor2 && ctx.debtor2.contact_name);
    return d1 && d2 ? `${d1} and ${d2}` : (d1 || d2);
  },
  // The docket, whichever form the case has: full ("24-48734-mlo") beats
  // short, short beats blank. Still OPAQUE — coalescing is not parsing.
  // Pre-filing cases have neither and resolve to '' (a required schema key
  // then blocks the send, which is right: the post-filing agreement is the
  // only fee contract that cites a docket, and it cannot exist pre-docket).
  'case.docket':           (ctx) => s(ctx.caseRow && ctx.caseRow.case_number_full)
                                 || s(ctx.caseRow && ctx.caseRow.case_number),
  'case.chapter':          (ctx) => s(ctx.caseRow && ctx.caseRow.case_chapter),
  'case.open_date':        (ctx) => ctx.caseRow ? formatDate(ctx.caseRow.case_open_date) : '',

  // G4 — the post-filing trio. All three are FREE TEXT on `cases`
  // (case_judge / case_trustee varchar(100) NOT NULL, no default, populated by
  // the court-email pipeline and by staff); nothing here parses or validates
  // them, exactly as case_number is passed through verbatim.
  'case.judge':            (ctx) => s(ctx.caseRow && ctx.caseRow.case_judge),
  'case.trustee':          (ctx) => s(ctx.caseRow && ctx.caseRow.case_trustee),
  // cases.case_file_date is a DATE column — mysql2 reads it as midnight
  // labeled UTC, so formatDate reads the UTC components. There is no time
  // component to render and the template must not imply one.
  'case.file_date':        (ctx) => ctx.caseRow ? formatDate(ctx.caseRow.case_file_date) : '',

  // debtors
  'debtor1.name':  (ctx) => s(ctx.debtor1 && ctx.debtor1.contact_name),
  'debtor1.email': (ctx) => s(ctx.debtor1 && ctx.debtor1.contact_email),
  'debtor1.phone': (ctx) => ctx.debtor1 ? formatPhone(ctx.debtor1.contact_phone) : '',
  'debtor2.name':  (ctx) => s(ctx.debtor2 && ctx.debtor2.contact_name),
  'debtor2.email': (ctx) => s(ctx.debtor2 && ctx.debtor2.contact_email),
  'debtor2.phone': (ctx) => ctx.debtor2 ? formatPhone(ctx.debtor2.contact_phone) : '',

  // ── G4: DEBTOR ADDRESS ────────────────────────────────────────────────────
  // Read from the CONTACTS COLUMNS (contact_address / _city / _state / _zip),
  // not from contact_addresses. Those columns are the mirror that
  // contactAddressService maintains from the child table, and they are what
  // every other read path in the repo uses; going to the child table here
  // would mean this module owns a second definition of "the debtor's address".
  //
  // Two pieces, not one: see LAYOUT LIVES IN THE TEMPLATE in the header.
  'debtor1.address_street': (ctx) => s(ctx.debtor1 && ctx.debtor1.contact_address),
  'debtor1.address_csz':    (ctx) => composeCsz(ctx.debtor1),
  'debtor2.address_street': (ctx) => s(ctx.debtor2 && ctx.debtor2.contact_address),
  'debtor2.address_csz':    (ctx) => composeCsz(ctx.debtor2),

  // ── G4: SSN — LAST FOUR ONLY, BY DESIGN ───────────────────────────────────
  // There is no full-SSN resolver and there must not be one. A notice of
  // filing carries the masked form because that is what the recipient needs to
  // identify the case; a template author who could reach the other nine digits
  // could put them on any document, and the whole point of a bespoke resolver
  // over a dot-path eval is that the reachable set is a list somebody chose.
  //
  // resolverService.BLOCKED_COLUMNS.contacts = ['contact_ssn'] refuses the
  // column to EXPRESSION resolvers for the same reason. These two functions
  // are the only sanctioned path to any part of an SSN in the template layer;
  // if a future document needs more, that is a decision somebody makes on
  // purpose, in this file, with a comment saying why.
  //
  // Digits-only first: the column is char(11) and staff type it both ways
  // ('123-45-6789' and '123456789'). Anything that does not yield at least
  // four digits resolves to '' rather than to a partial mask — 'xxx-xx-' with
  // nothing after it on a legal document is worse than a blank the template
  // collapses.
  'debtor1.ssn_last4':  (ctx) => ssnLast4(ctx.debtor1),
  'debtor1.ssn_masked': (ctx) => ssnMasked(ctx.debtor1),
  'debtor2.ssn_last4':  (ctx) => ssnLast4(ctx.debtor2),
  'debtor2.ssn_masked': (ctx) => ssnMasked(ctx.debtor2),

  // ── G4: TRUSTEE ───────────────────────────────────────────────────────────
  // The panel trustee's contact block, from the `fe-trustees` setting, matched
  // against cases.case_trustee. Every one resolves to '' when there is no
  // match — a Chapter 7 no-asset case with no trustee yet renders a notice
  // with the trustee column collapsed, not with orphan labels.
  'trustee.name':           (ctx) => s(_trusteeEntry(ctx) && _trusteeEntry(ctx).name),
  'trustee.address_street': (ctx) => {
    const e = _trusteeEntry(ctx);
    if (!e) return '';
    const a1 = s(e.address1);
    const a2 = s(e.address2);
    if (!a1) return a2;
    return a2 ? `${a1}, ${a2}` : a1;
  },
  'trustee.address_csz':    (ctx) => composeCsz(_trusteeEntry(ctx)),
  'trustee.phone':          (ctx) => {
    const e = _trusteeEntry(ctx);
    return e ? formatPhone(e.phone) : '';
  },
  'trustee.email':          (ctx) => s(_trusteeEntry(ctx) && _trusteeEntry(ctx).email),

  // attorney. Settings-backed as of 2026-07-20; the literal remains ONLY as a
  // last-resort fallback. firmConfig falls through an empty DB value to env to
  // null, and a blank attorney name in an executed retainer is worse than a
  // stale one — so a cleared setting degrades to the previous behaviour rather
  // than to ''. Change the setting, not this string.
  'attorney.name': () => s(cfg('firm_attorney_name')) || 'Stuart Sandweiss',

  // firm — app_settings via firmConfig. Same fallback rationale as above:
  // 'Legal Solutions Group' is the display name used repo-wide
  // (routes/api.redirects.js, public/docReq.html, views/v.html).
  'firm.name':    () => s(cfg('firm_name')) || 'Legal Solutions Group',
  'firm.phone':   () => formatPhone(cfg('fe-firm_phone')),
  'firm.email':   () => s(cfg('firm_email')),
  'firm.website': () => s(cfg('fe-firm_site_url')),

  // firm.address — THREE resolvers over one `json_array` setting, because
  // LAYOUT BELONGS TO THE TEMPLATE, NOT THE DATA. interpolateTemplate
  // HTML-escapes every value (esignSendService _escapeHtml), so a '<br>' in
  // the value renders as literal '&lt;br&gt;' and a '\n' collapses to a space
  // under normal HTML whitespace rules. A template that wants a stacked
  // address uses the two line resolvers in two elements; one that wants it
  // inline (letterhead, signature block) uses firm.address.
  //
  // NO fallback literal here, deliberately — unlike the name resolvers there
  // is no prior value to degrade to. An unset setting yields '', which lands
  // in resolvePrefills' `missing` array; a template that declares its address
  // key `required: true` then HARD-FAILS the send (esignSendService
  // ESIGN_MISSING_REQUIRED) rather than mailing a contract with a blank
  // address. Mark it required in prefill_schema.
  'firm.address':       () => _addressLines().join(', '),
  'firm.address_line1': () => _addressLines()[0] || '',
  'firm.address_line2': () => _addressLines().slice(1).join(', '),
});

/**
 * The firm's mailing address as trimmed, non-empty lines.
 *
 * Setting `firm_address` is type `json_array` — validated as an array both
 * client-side (settings.html VALIDATORS) and server-side (api.appSettings
 * TYPE_VALIDATORS) — but array-ness is all either one checks, so coerce and
 * filter here rather than trusting the elements. Unset / malformed → [].
 *
 * @returns {string[]}
 */
function _addressLines() {
  const raw = cfgJson('firm_address', null);
  if (!Array.isArray(raw)) return [];
  return raw.map(s).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// G4 HELPERS — pure, exported under `_` for the table tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "City, ST 48075" from whichever of the three pieces exist.
 *
 * PURE and source-agnostic: it reads `city` / `state` / `zip` off whatever
 * object it is handed, which is why one function serves both the contacts row
 * (whose columns are contact_city/_state/_zip — the callers map them) and a
 * fe-trustees entry (whose keys already are city/state/zip). Callers pass the
 * OBJECT; the mapping for contacts lives in _cszParts.
 *
 * Rules, in order:
 *   city && state  → "City, ST"
 *   city only      → "City"
 *   state only     → "ST"
 *   then zip, appended after a single space if the zip is present
 *   nothing at all → ''  (never ', ' and never a bare comma)
 *
 * A zip with no city and no state yields just the zip. That is deliberate: a
 * lone zip is still information, and the empty-value-hides-label idiom in the
 * template is what decides whether it is worth a line.
 *
 * @param {?object} src  a contacts row, a fe-trustees entry, or null
 * @returns {string}
 */
function composeCsz(src) {
  if (!src || typeof src !== 'object') return '';
  const { city, state, zip } = _cszParts(src);
  let head = '';
  if (city && state)  head = `${city}, ${state}`;
  else if (city)      head = city;
  else if (state)     head = state;
  if (!head) return zip;
  return zip ? `${head} ${zip}` : head;
}

/**
 * The three pieces, from either shape. contacts rows carry the contact_
 * prefix; fe-trustees entries do not. Prefixed keys win when both are present
 * so a contacts row that happens to have picked up a stray `city` property
 * cannot shadow its own column.
 */
function _cszParts(src) {
  return {
    city:  s(src.contact_city  != null ? src.contact_city  : src.city),
    state: s(src.contact_state != null ? src.contact_state : src.state),
    zip:   s(src.contact_zip   != null ? src.contact_zip   : src.zip),
  };
}

/**
 * The last four digits of a contact's SSN, or ''.
 *
 * Digits-only, then a length gate: contacts.contact_ssn is char(11) and holds
 * both '123-45-6789' and '123456789' in live data. Fewer than four digits
 * (a half-typed value, a placeholder like '000') yields '' — see the SSN
 * comment in RESOLVERS for why a partial mask is not an acceptable output.
 *
 * @param {?object} contact
 * @returns {string}  exactly 4 characters, or ''
 */
function ssnLast4(contact) {
  if (!contact) return '';
  const digits = s(contact.contact_ssn).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

/** 'xxx-xx-6789', or '' when there is no last-4 to mask. */
function ssnMasked(contact) {
  const last4 = ssnLast4(contact);
  return last4 ? `xxx-xx-${last4}` : '';
}

/**
 * The fe-trustees entry for this case's trustee, or null.
 *
 * ── MATCHING IS EXACT-NAME (case-insensitive), NOT SURNAME ──────────────────
 * The roster contains BOTH 'Thomas W. McDonald' (a Chapter 12 trustee) and
 * 'Thomas W. Jr. McDonald' (a Chapter 13 trustee). A surname match would
 * return whichever came first and put the wrong trustee's address on a mailed
 * notice — silently, and in the one place a client would act on it. So the
 * comparison is the whole `name` string, trimmed and lowercased, against the
 * whole `case_trustee` string. Anything short of an exact match resolves to
 * null and the template collapses the trustee block.
 *
 * That strictness is a deliberate data-entry pressure, the same as the
 * required debtor1_street key: 105 of the 107 cases filed in the last two
 * years match a roster name exactly, and the two misses are stale short forms
 * that should be corrected on the case rather than accommodated here. Fuzzy
 * matching would hide them forever.
 *
 * MEMOIZED on the context object, the way buildExpressionRefs is built once
 * per resolution: five trustee.* resolvers on one template would otherwise
 * parse the 6.5KB setting five times. The cache key is a non-enumerable
 * symbol so it can never leak into a JSON.stringify of the context.
 *
 * @param {object} ctx  the resolution context
 * @returns {?object}   the roster entry, or null
 */
const _TRUSTEE_CACHE = Symbol('trusteeEntry');

function _trusteeEntry(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(ctx, _TRUSTEE_CACHE)) {
    return ctx[_TRUSTEE_CACHE];
  }

  let entry = null;
  const wanted = s(ctx.caseRow && ctx.caseRow.case_trustee).toLowerCase();
  if (wanted) {
    // cfgJson NEVER throws — unset, malformed, or a non-array all arrive here
    // as something that is not an array, and a firm-identity read must not be
    // able to 500 a document render.
    const roster = cfgJson('fe-trustees', null);
    if (Array.isArray(roster)) {
      entry = roster.find(
        (e) => e && typeof e === 'object' && s(e.name).toLowerCase() === wanted
      ) || null;
    }
  }

  Object.defineProperty(ctx, _TRUSTEE_CACHE, {
    value: entry, enumerable: false, configurable: true, writable: true,
  });
  return entry;
}

/** The Set esignTemplateService validates against at save time. */
const RESOLVER_NAMES = Object.freeze(new Set(Object.keys(RESOLVERS)));

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESSION RESOLVERS (Phase 2E)
//
// A prefill entry's `resolver` may be, instead of a whitelist name above, an
// EXPRESSION in services/resolverService.js's universal placeholder syntax:
//
//   "{{cases.case_filed_date|date:MM/DD/YYYY}}"
//   "{{contacts.contact_address|default:address on file}}"
//   "{{cases.case_number}} / {{cases.case_chapter}}"
//
// Detection is unambiguous: expressions start with '{{' and end with '}}';
// bespoke names never contain braces. Data access is DELEGATED to
// resolverService.resolve — its ALLOWED_TABLES / BLOCKED_COLUMNS are the one
// source of truth, its modifiers (date/phone/default/upper/…) come for free.
//
// The refs an expression can address are built from the SAME context the
// bespoke resolvers read: `cases` anchors on the linked case, `contacts`
// anchors on debtor1 (the Primary). debtor2 and every other row are NOT
// expression-addressable — the bespoke `debtor2.*` resolvers cover the joint
// debtor, and widening the anchor set is a deliberate future decision, not a
// default. trigger_data is INVALID here (there is no trigger at send time);
// esignTemplateService rejects it at save.
//
// SEMANTICS stay this layer's, not resolverService's: any unresolved
// placeholder or resolve failure yields '' (never a literal '{{…}}' on a
// legal document), then the entry's `default` applies, then formatValue by
// declared type, then the required-missing policy downstream — identical to a
// bespoke resolver returning ''. Per-placeholder fallback INSIDE an
// expression is the author's |default: modifier.
// ─────────────────────────────────────────────────────────────────────────────

/** Is this resolver string an expression rather than a whitelist name? */
function isExpressionResolver(resolver) {
  return typeof resolver === 'string' &&
    resolver.length > 4 &&
    resolver.startsWith('{{') &&
    resolver.endsWith('}}');
}

/**
 * PURE save-time checks for one expression (syntax + table/column policy).
 * The column-EXISTENCE check needs a db and lives in
 * esignTemplateService.assertExpressionColumnsExist; this covers everything
 * checkable without one. Throws ESIGN_BAD_RESOLVER; returns the scanned refs
 * on success so the caller can batch the existence query.
 *
 * @param {string} resolver  the expression string
 * @returns {Array<{table:string, column:string}>}
 */
function validateExpressionResolver(resolver) {
  const resolverService = require('./resolverService');
  const { refs, triggerData, placeholderCount } = resolverService.scanExpressionRefs(resolver);

  if (placeholderCount === 0) {
    throw _err('ESIGN_BAD_RESOLVER',
      `Expression resolver ${JSON.stringify(resolver)} contains no valid {{table.column}} placeholder.`);
  }
  if (triggerData) {
    throw _err('ESIGN_BAD_RESOLVER',
      `Expression resolver ${JSON.stringify(resolver)} references trigger_data, ` +
      `which does not exist at send time.`);
  }
  if (refs.length === 0) {
    // e.g. "{{just_a_word}}" — a placeholder with no table.column shape.
    throw _err('ESIGN_BAD_RESOLVER',
      `Expression resolver ${JSON.stringify(resolver)} has no table.column reference.`);
  }
  for (const { table, column } of refs) {
    if (!resolverService.ALLOWED_TABLES.includes(table)) {
      throw _err('ESIGN_BAD_RESOLVER',
        `Expression resolver references table "${table}", which is not resolvable ` +
        `(allowed: ${resolverService.ALLOWED_TABLES.join(', ')}).`);
    }
    const blocked = resolverService.BLOCKED_COLUMNS[table] || [];
    if (blocked.includes(column)) {
      throw _err('ESIGN_BAD_RESOLVER',
        `Expression resolver references "${table}.${column}", which is not accessible.`);
    }
  }
  return refs;
}

/**
 * The refs object expressions resolve against, from the loaded context.
 * `cases` = the linked case; `contacts` = debtor1 (Primary) — or the contact
 * itself for a contact-linked request. Anchors bind as STRINGS where the
 * column is a string (cases.case_id — repo landmine).
 */
function buildExpressionRefs(linkable, context) {
  const refs = {};
  const type = linkable && linkable.linkableType;
  const id   = linkable && linkable.linkableId != null ? String(linkable.linkableId).trim() : '';

  if (type === 'case' && id) refs.cases = { case_id: id };
  if (context && context.debtor1 && context.debtor1.contact_id != null) {
    refs.contacts = { contact_id: context.debtor1.contact_id };
  } else if (type === 'contact' && id) {
    refs.contacts = { contact_id: id };
  }
  return refs;
}

/**
 * Resolve one expression to a raw string per the semantics block above.
 * '' on any unresolved placeholder or failure — never a literal '{{…}}'.
 */
async function resolveExpression(db, resolver, exprRefs) {
  const resolverService = require('./resolverService');
  const r = await resolverService.resolve({
    db, text: resolver, refs: exprRefs, strict: false,
  });
  if (!r || r.status !== 'success') return '';
  if (Array.isArray(r.unresolved) && r.unresolved.length > 0) return '';
  return typeof r.text === 'string' ? r.text : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve every prefill_schema entry of a template against a linkable.
 *
 * @param {object} db
 * @param {object|number} templateOrId   a template row (getTemplate shape) or its id
 * @param {object} [linkable]            {linkableType, linkableId}; omit for an
 *                                       authoring-time resolution (resolvers
 *                                       are skipped; defaults only)
 * @returns {Promise<{values: Object<string,string>, missing: string[], context: object}>}
 *          values  — key → formatted string for EVERY schema key
 *          missing — keys whose final value is '' (required or not; the
 *                    caller applies its own required policy)
 *          context — the loaded case context (sendFromTemplate derives the
 *                    document-name suffix from it)
 */
async function resolvePrefills(db, templateOrId, linkable = null) {
  let template = templateOrId;
  if (template == null || typeof template !== 'object') {
    // Lazy require — templateService does not depend on this module, but keep
    // the direction obvious and cycle-proof anyway.
    template = await require('./esignTemplateService').getTemplate(db, templateOrId);
    if (!template) throw _err('ESIGN_NOT_FOUND', `Template ${templateOrId} not found.`);
  }

  const schema = Array.isArray(template.prefill_schema) ? template.prefill_schema : [];

  const hasLinkable = linkable && linkable.linkableId != null && linkable.linkableId !== '';
  const context = hasLinkable
    ? await buildContext(db, linkable)
    : { caseRow: null, debtor1: null, debtor2: null };

  // Built once per resolution — every expression entry shares it.
  const exprRefs = hasLinkable ? buildExpressionRefs(linkable, context) : null;

  const values = {};
  const missing = [];

  for (const entry of schema) {
    let raw = '';

    if (entry.resolver != null && hasLinkable) {
      if (isExpressionResolver(entry.resolver)) {
        // Delegated to resolverService; '' on unresolved/failure (see the
        // EXPRESSION RESOLVERS block above), then default/format/missing
        // policy applies exactly as for a bespoke resolver returning ''.
        raw = await resolveExpression(db, entry.resolver, exprRefs);
      } else {
        const fn = RESOLVERS[entry.resolver];
        if (!fn) {
          // A template saved before a resolver was removed. Loud, not silent:
          // silently rendering '' where the schedule of fees should be is how
          // a bad contract goes out.
          throw _err('ESIGN_BAD_RESOLVER',
            `Template prefill "${entry.key}" names unknown resolver "${entry.resolver}".`);
        }
        raw = await fn(context, db);
      }
    }

    const rawEmpty = raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0);
    if (rawEmpty) {
      raw = entry.default != null ? entry.default : '';
    }

    const formatted = raw === '' && entry.type !== 'options' ? '' : formatValue(entry.type, raw);
    values[entry.key] = formatted;
    const isEmpty = Array.isArray(formatted) ? formatted.length === 0 : formatted === '';
    if (isEmpty) missing.push(entry.key);
  }

  return { values, missing, context };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  resolvePrefills,
  buildContext,
  RESOLVERS,
  RESOLVER_NAMES,
  // expressions (Phase 2E)
  isExpressionResolver,
  validateExpressionResolver,
  buildExpressionRefs,
  resolveExpression,
  // formatting — shared with sendFromTemplate (caller-override formatting)
  formatValue,
  formatPhone,
  formatDate,
  formatMoney,
  formatNumber,
  // G4 pure helpers — exported for the table tests, not for callers. Nothing
  // outside tests/esignPrefill.notice.test.js should reach for these: the
  // RESOLVERS map is the interface.
  _composeCsz: composeCsz,
  _ssnLast4:   ssnLast4,
  _ssnMasked:  ssnMasked,
  _trusteeEntry,
};
