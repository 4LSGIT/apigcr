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
 *   firm.*  — lib/firmConfig cfg() over app_settings. Existing keys only:
 *             fe-firm_phone (digits, formatted here), firm_email,
 *             fe-firm_site_url. There is NO firm-name, firm-address or
 *             attorney-name setting (checked app_settings live and the
 *             firmConfig REGISTRY) — see the NAG comments at those resolvers.
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
const { cfg } = require('../lib/firmConfig');
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
  'case.chapter':          (ctx) => s(ctx.caseRow && ctx.caseRow.case_chapter),
  'case.open_date':        (ctx) => ctx.caseRow ? formatDate(ctx.caseRow.case_open_date) : '',

  // debtors
  'debtor1.name':  (ctx) => s(ctx.debtor1 && ctx.debtor1.contact_name),
  'debtor1.email': (ctx) => s(ctx.debtor1 && ctx.debtor1.contact_email),
  'debtor1.phone': (ctx) => ctx.debtor1 ? formatPhone(ctx.debtor1.contact_phone) : '',
  'debtor2.name':  (ctx) => s(ctx.debtor2 && ctx.debtor2.contact_name),
  'debtor2.email': (ctx) => s(ctx.debtor2 && ctx.debtor2.contact_email),
  'debtor2.phone': (ctx) => ctx.debtor2 ? formatPhone(ctx.debtor2.contact_phone) : '',

  // attorney.
  // NAG: there is NO attorney-name key in app_settings or the firmConfig
  // REGISTRY (checked live, 2026-07-19). Until one exists this is a literal —
  // the firm's sole attorney. When an 'attorney_name' setting is added, wire
  // it through firmConfig's REGISTRY and read cfg('attorney_name') here.
  'attorney.name': () => 'Stuart Sandweiss',

  // firm — app_settings via firmConfig where a key EXISTS.
  // NAG: there is NO firm-name key either; 'Legal Solutions Group' is the
  // display name used repo-wide (routes/api.redirects.js, public/docReq.html,
  // views/v.html). Same remedy: add a setting, wire it through the REGISTRY.
  'firm.name':    () => 'Legal Solutions Group',
  'firm.phone':   () => formatPhone(cfg('fe-firm_phone')),
  'firm.email':   () => s(cfg('firm_email')),
  'firm.website': () => s(cfg('fe-firm_site_url')),
  // firm.address is DELIBERATELY ABSENT from this whitelist: no address exists
  // anywhere in app_settings, env, or the codebase, and a legal contract with
  // a silently blank firm address is worse than a template that refuses to
  // save until the resolver exists. Add an 'firm_address' setting + resolver
  // together when the address is known.
});

/** The Set esignTemplateService validates against at save time. */
const RESOLVER_NAMES = Object.freeze(new Set(Object.keys(RESOLVERS)));

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

  const values = {};
  const missing = [];

  for (const entry of schema) {
    let raw = '';

    if (entry.resolver != null && hasLinkable) {
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

    if (raw === '' || raw == null) {
      raw = entry.default != null ? entry.default : '';
    }

    const formatted = raw === '' ? '' : formatValue(entry.type, raw);
    values[entry.key] = formatted;
    if (formatted === '') missing.push(entry.key);
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
  // formatting — shared with sendFromTemplate (caller-override formatting)
  formatValue,
  formatPhone,
  formatDate,
  formatMoney,
  formatNumber,
};
