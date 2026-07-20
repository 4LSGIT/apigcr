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
};
