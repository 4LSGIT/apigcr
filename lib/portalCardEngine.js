// lib/portalCardEngine.js
//
/**
 * Portal card engine — Client Portal Slice E1 (+ E2 admin surface).
 *
 * Evaluates and renders the configurable cards (portal_cards table) for the
 * client portal case view. Staff define cards (E2 admin UI); this module is
 * the ONLY render path — public/portal/case.html consumes its output, and
 * the E2 admin preview renders THROUGH this same path (previewCard →
 * renderOneCard), never a parallel renderer that can drift.
 *
 * RATIFIED SECURITY MODEL (Fred + manager, 2026-08-07; item 4 amended by the
 * ratified E2 rider 2026-08-08 — binding; not this module's, staff's, or any
 * caller's to relax):
 *
 *  1. PORTAL_FIELD_WHITELIST — a CODE CONSTANT (never staff-editable, never a
 *     DB table) of `table.column` pairs that template BODIES and rules-mode
 *     condition FIELDS may reference. Deny-by-default. resolverService's own
 *     ALLOWED_TABLES / BLOCKED_COLUMNS are automation-grade and far too
 *     permissive for client-facing output — this whitelist layers ON TOP and
 *     is much smaller.
 *  2. REFUSE, NEVER STRIP — a body_template referencing ANYTHING outside the
 *     whitelist (or trigger_data) refuses the WHOLE card: hidden from the
 *     payload + an alert (once per card key per boot), never sanitized.
 *     E2's validateCard runs the same scan at SAVE time (a UX layer so staff
 *     learn on save instead of by cards vanishing); this render-time refusal
 *     REMAINS the enforcement of record.
 *  3. REFS PINNED TO THE SESSION — resolver refs / sql-condition params are
 *     built from exactly the authed contactId + the scope-confirmed caseId.
 *     Config can NEVER supply entity ids (rules mode has no id surface at
 *     all; sql mode's paramMap values may only name the two pinned paths).
 *     The E2 preview pins the same way — to the admin-chosen case and that
 *     case's Primary contact, resolved server-side.
 *  4. BODIES ARE RAW TEXT, CLIENT-ESCAPED AT INSERTION (rider 2026-08-08) —
 *     resolved template output ships in the payload as RAW text; the portal
 *     client escapes it with escText at the point of insertion, exactly like
 *     every other payload string (title, docket, labels — the portal's
 *     client-side symmetry). Templates remain text with placeholders, never
 *     HTML; action links come from the structured link_url/link_label
 *     columns, never markup. (Pre-rider, E1 escaped server-side here and the
 *     client inserted pre-escaped — the flip removes that asymmetry and its
 *     double-escape hazard.)
 *  5. CONDITIONS gate, bodies leak — bodies are whitelisted because their
 *     values reach the client; conditions may be more powerful (sql escape
 *     hatch) because only one boolean escapes. Everything about condition
 *     evaluation FAILS CLOSED: parse error, unknown op, unknown field,
 *     query error, thrown anything → card hidden, never a portal error.
 *  6. Failed-condition and refused cards are ABSENT from the payload —
 *     never display:none'd client-side.
 *
 * Conditions JSON (portal_cards.conditions; NULL = always renders):
 *
 *   rules mode (default):
 *     { "mode": "rules", "match": "all"|"any", "rules": [ <rule>... ] }
 *     <rule> = leaf  { "field": "cases.case_341_current", "op": "...",
 *                      "value": <op-dependent> }
 *           | group { "match": "all"|"any", "rules": [ <rule>... ] }
 *              (nested groups, depth-capped — needed e.g. for the 341 card's
 *               (chapter OR type) AND date gates)
 *     Operators v1: in, empty, not_empty, date_future, date_past,
 *                   date_within_days, contains, starts_with.
 *     Date semantics (PARITY-CRITICAL): date ops read the value's NAIVE
 *     components (Date.toISOString().slice(0,10)) and compare against
 *     firm-local today (nowLocal().toISODate()) as strings. This matches the
 *     shipped buildMeeting341 read of case_341_current — firm-local wall
 *     time stored as-if-UTC (mysql2 timezone:'Z'). Do NOT whitelist real-UTC
 *     timestamp columns for date rules without adding a conversion mode
 *     here first; they would gate on the wrong day near midnight.
 *       date_future      → date >= today  (today still passes — the shipped
 *                          341 boundary; suppression is `date < today`)
 *       date_past        → date <  today
 *       date_within_days → today <= date <= today + N days (value = N)
 *
 *   sql mode (escape hatch, amended ruling 2026-08-07):
 *     { "mode": "sql", "condition": { query, params, assert, assert_mode } }
 *     Reuses sequenceEngine.checkCondition verbatim — SELECT-only, fails
 *     closed on missing/invalid query, no rows, or query error. paramMap
 *     values are validated here to name ONLY the pinned session paths
 *     (case_id / contact_id, with or without the trigger_data. prefix);
 *     anything else refuses the condition (fail closed) BEFORE any SQL runs.
 *
 * Exports:
 *   PORTAL_FIELD_WHITELIST, RULE_OPS, VALID_PLACEMENTS, KNOWN_CODED_KEYS,
 *   ALLOWED_SQL_PARAM_PATHS
 *   evaluateConditions(db, conditions, ctx)   ctx = { caseRow, contactRow,
 *                                                     caseId, contactId }
 *   renderCards(db, { caseId, contactId, placement }) → [{ key, title,
 *       body|null, link:{url,label}|null, coded_key|null, placement }]
 *   validateCard(card)  — E2 save-time validation + normalization (REJECTS,
 *       never strips/sanitizes; errors name offending refs — no oracle
 *       concern staff-side). Built on the SAME primitives the render path
 *       enforces with (scanTemplateViolations, RULE_OPS, the whitelist,
 *       ALLOWED_SQL_PARAM_PATHS), so save-time and render-time can't drift.
 *   previewCard(db, card, { caseId, contactId })  — E2 preview: the REAL
 *       pipeline (conditions → renderOneCard) pinned to an admin-chosen
 *       case/contact, plus per-top-level-group pass/fail for author insight.
 *   (+ _-prefixed test helpers — repo pattern)
 */

'use strict';

const { resolve, scanExpressionRefs } = require('../services/resolverService');
const { checkCondition }              = require('./sequenceEngine');
const { nowLocal }                    = require('../services/timezoneService');
const { alert }                       = require('./alerting');

// ─────────────────────────────────────────────────────────────────────────────
// PORTAL_FIELD_WHITELIST — the client-facing field surface. Deny-by-default.
//
// Initial set (E1) = exactly what the portal already ships to clients today
// (case identity/docket/341 columns via getCaseView; the contact's own first
// name is portal-login identity). Every future addition goes through manager
// ratification — justify why the VALUE is safe in a client's browser.
//
// NEVER to be added (ratified): contacts.contact_ssn, cases.case_status
// (internal vocabulary), internal_label, log columns, ANY users columns.
// ─────────────────────────────────────────────────────────────────────────────

const PORTAL_FIELD_WHITELIST = new Set([
  'cases.case_id',
  'cases.case_chapter',
  'cases.case_type',
  'cases.case_number',
  'cases.case_number_full',
  'cases.case_341_current',
  'cases.case_341_link',
  'contacts.contact_fname',
]);

// Whitelist tables → the ctx row that carries them, and the PK the engine's
// own loader anchors on. Derived structures below keep loadCtx's SELECT lists
// in lockstep with the whitelist (add a column there → it loads here).
const CTX_ROW_KEY = { cases: 'caseRow', contacts: 'contactRow' };
const TABLE_PK    = { cases: 'case_id', contacts: 'contact_id' };

const WL_COLUMNS_BY_TABLE = (() => {
  const out = {};
  for (const entry of PORTAL_FIELD_WHITELIST) {
    const dot = entry.indexOf('.');
    const table = entry.slice(0, dot);
    (out[table] ||= []).push(entry.slice(dot + 1));
  }
  return out;
})();

// ─────────────────────────────────────────────────────────────────────────────
// E2 vocabulary constants — shared by render-time enforcement, save-time
// validation, and the admin UI's /meta endpoint. All CODE CONSTANTS.
// ─────────────────────────────────────────────────────────────────────────────

// Card placements the portal actually lays out (case.html splits on
// 'case_top' vs everything-else, and renderCards is called with exactly this
// pair). Save-time validation pins to this set: an unknown placement is a
// card that renders NOWHERE — the silent vanish E2 exists to prevent. The
// column is varchar for future surfaces ('home', …); extending means adding
// here + a client layout, together.
const VALID_PLACEMENTS = ['case_top', 'case'];

// Coded-card renderers that exist in the portal client
// (case.html CODED_RENDERERS). A coded card whose coded_key isn't here is
// silently skipped client-side — so save-time validation pins coded_key to
// this set. Shipping a new coded renderer = add the client renderer + this
// entry, together (deploy-level pairing; that's also why the admin refuses
// to DELETE coded cards or change their coded_key — deactivate instead).
const KNOWN_CODED_KEYS = ['meeting341'];

// card_key: stable staff-facing identifier (unique key in the table).
const CARD_KEY_RE = /^[A-Za-z0-9_-]{1,50}$/;

// Column-length caps (portal_cards DDL — keep in sync with the migration).
const TITLE_MAX = 100;
const LINK_URL_MAX = 255;
const LINK_LABEL_MAX = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Value helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * empty = null/undefined, or a string that trims to ''. Dates, numbers
 * (including 0) and booleans are values. String-trim semantics mirror the
 * shipped isBankruptcyCase gate (`String(x).trim()`) so the migrated
 * not_empty rule on case_chapter is parity-exact.
 */
function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

/**
 * Value → naive 'YYYY-MM-DD' or null.
 * Date instance: toISOString().slice(0,10) — the NAIVE read (see header;
 * parity with buildMeeting341's fake-UTC/local-wall handling). Strings must
 * lead with an ISO date. Anything else / invalid → null (→ date ops fail
 * closed).
 */
function toNaiveDateStr(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Structured link guard. Allowed: http(s) absolute, or site-relative starting
 * with a single '/' ('//' is protocol-relative = off-site — rejected).
 * Invalid url → null (card renders without its link; the URL never reaches
 * an href). Label defaults to 'Open' when blank.
 */
function safeLink(url, label) {
  const u = String(url == null ? '' : url).trim();
  if (!u) return null;
  const ok = /^https?:\/\//i.test(u) || (u.startsWith('/') && !u.startsWith('//'));
  if (!ok) return null;
  const l = String(label == null ? '' : label).trim() || 'Open';
  return { url: u, label: l };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules mode
// ─────────────────────────────────────────────────────────────────────────────

const RULE_GROUP_MAX_DEPTH = 5;

/**
 * Whitelist-gated field lookup. { ok:false } for anything not in
 * PORTAL_FIELD_WHITELIST (→ the rule fails closed). A missing ctx row (e.g.
 * no case in scope) yields value null — empty/date ops then behave as if the
 * column were NULL.
 */
function getField(ctx, field) {
  if (typeof field !== 'string' || !PORTAL_FIELD_WHITELIST.has(field)) {
    return { ok: false };
  }
  const dot = field.indexOf('.');
  const table = field.slice(0, dot);
  const col = field.slice(dot + 1);
  const rowKey = CTX_ROW_KEY[table];
  if (!rowKey) return { ok: false };
  const row = ctx ? ctx[rowKey] : null;
  return { ok: true, value: row ? row[col] : null };
}

/**
 * Operator implementations, keyed by op name. RULE_OPS (the validation
 * vocabulary validateCard checks against) is DERIVED from this map's keys —
 * evaluation and validation can't drift by construction: an op exists for
 * both or for neither.
 *
 * Each impl: (value, rule, today) → boolean, where `today` is firm-local
 * nowLocal().toISODate(). Semantics are E1-frozen (see header) — the
 * operator matrix in tests/portalCardEngine.test.js pins them.
 */
const RULE_OP_IMPLS = {
  empty:     (v) => isEmptyValue(v),
  not_empty: (v) => !isEmptyValue(v),

  in: (v, rule) => {
    if (!Array.isArray(rule.value) || v === null || v === undefined) return false;
    const actual = String(v).trim();   // trim parity with the shipped type gate
    return rule.value.some(c => String(c).trim() === actual);
  },

  date_future: (v, rule, today) => {
    const d = toNaiveDateStr(v);
    return d !== null && d >= today;   // >= : today still shows (shipped 341 boundary)
  },

  date_past: (v, rule, today) => {
    const d = toNaiveDateStr(v);
    return d !== null && d < today;
  },

  date_within_days: (v, rule, today) => {
    const n = Number(rule.value);
    if (!Number.isFinite(n) || n < 0) return false;
    const d = toNaiveDateStr(v);
    if (d === null) return false;
    const upper = nowLocal().plus({ days: Math.floor(n) }).toISODate();
    return d >= today && d <= upper;
  },

  contains: (v, rule) => {
    if (v === null || v === undefined || rule.value === null || rule.value === undefined) return false;
    return String(v).includes(String(rule.value));
  },

  starts_with: (v, rule) => {
    if (v === null || v === undefined || rule.value === null || rule.value === undefined) return false;
    return String(v).startsWith(String(rule.value));
  },
};

const RULE_OPS = Object.freeze(Object.keys(RULE_OP_IMPLS));

/** One leaf rule. Unknown op / non-whitelisted field / bad value → false. */
function evaluateLeafRule(rule, ctx) {
  const f = getField(ctx, rule.field);
  if (!f.ok) {
    console.warn(`[portalCardEngine] rule field not whitelisted: ${rule.field} — fail closed`);
    return false;
  }
  const impl = Object.prototype.hasOwnProperty.call(RULE_OP_IMPLS, rule.op)
    ? RULE_OP_IMPLS[rule.op] : null;
  if (!impl) {
    console.warn(`[portalCardEngine] unknown rule op: ${rule && rule.op} — fail closed`);
    return false;
  }
  return impl(f.value, rule, nowLocal().toISODate());
}

/**
 * A group: { match: 'all'|'any', rules: [...] }. Empty/missing rules array is
 * a misconfiguration → false (a card that ASKED to be gated never shows on a
 * broken gate). Entries are leaves or nested groups (depth-capped).
 */
function evaluateRuleGroup(group, ctx, depth = 0) {
  if (depth > RULE_GROUP_MAX_DEPTH) return false;
  if (!group || !Array.isArray(group.rules) || group.rules.length === 0) return false;

  const evalOne = (r) => {
    if (!r || typeof r !== 'object') return false;
    if (Array.isArray(r.rules)) return evaluateRuleGroup(r, ctx, depth + 1);
    return evaluateLeafRule(r, ctx);
  };

  return group.match === 'any'
    ? group.rules.some(evalOne)
    : group.rules.every(evalOne);        // 'all' default
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL mode
// ─────────────────────────────────────────────────────────────────────────────

// The ONLY paths a sql-mode paramMap value may name. checkCondition strips an
// optional 'trigger_data.' prefix before its dot-path walk, so both spellings
// resolve to the same pinned value.
const ALLOWED_SQL_PARAM_PATHS = new Set([
  'case_id', 'contact_id',
  'trigger_data.case_id', 'trigger_data.contact_id',
]);

/**
 * sql mode: validate the paramMap against the pinned-path allowlist, then
 * hand the condition to sequenceEngine.checkCondition with triggerData built
 * from EXACTLY the session's { case_id, contact_id }. Config can map param
 * NAMES but only to those two VALUES — it has no way to inject an entity id
 * (paramMap values are dot-paths into triggerData, never literals; and any
 * path outside the allowlist refuses the condition before SQL runs).
 * checkCondition already enforces SELECT-only and fails closed on query
 * errors / no rows; the try/catch is belt for anything else (§1.5).
 */
async function evaluateSqlCondition(db, cond, ctx) {
  const c = cond && cond.condition;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;

  const paramMap = c.params || {};
  if (typeof paramMap !== 'object' || Array.isArray(paramMap)) return false;
  for (const [name, path] of Object.entries(paramMap)) {
    if (typeof path !== 'string' || !ALLOWED_SQL_PARAM_PATHS.has(path)) {
      console.error(
        `[portalCardEngine] sql condition param :${name} maps to '${path}' — ` +
        `outside the pinned session paths, fail closed`
      );
      return false;
    }
  }

  try {
    return await checkCondition(db, c, {
      case_id: ctx.caseId,
      contact_id: ctx.contactId,
    });
  } catch (err) {
    console.error('[portalCardEngine] sql condition threw — fail closed:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditions parse + evaluate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared parse step for evaluateConditions AND the E2 explain path — one
 * parser so the two can't disagree about what a conditions value means.
 *
 * @returns {{ always: true } | { error: string } |
 *           { cond: object, mode: 'rules'|'sql' } | { error: string }}
 */
function parseConditionsValue(conditions) {
  if (conditions === null || conditions === undefined) return { always: true };

  let cond = conditions;
  if (typeof cond === 'string') {
    try { cond = JSON.parse(cond); } catch (err) {
      return { error: 'conditions JSON parse failed: ' + err.message };
    }
  }
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
    return { error: 'conditions must be a JSON object (or null)' };
  }
  const mode = cond.mode || 'rules';
  if (mode !== 'rules' && mode !== 'sql') {
    return { error: `unknown conditions mode '${mode}'` };
  }
  return { cond, mode };
}

/**
 * @param {object}      db          mysql2 pool (sql mode only)
 * @param {object|string|null} conditions portal_cards.conditions — mysql2
 *                      usually hands JSON columns back parsed, but a string
 *                      is parsed defensively (emailIngestRuleService pattern)
 * @param {object}      ctx         { caseRow, contactRow, caseId, contactId }
 *                      rows contain WHITELISTED fields only (loadCtx)
 * @returns {Promise<boolean>} true = card renders. NULL conditions always
 *                      pass; every malformed/erroring shape fails closed.
 */
async function evaluateConditions(db, conditions, ctx) {
  const parsed = parseConditionsValue(conditions);
  if (parsed.always) return true;
  if (parsed.error) {
    console.error(`[portalCardEngine] ${parsed.error} — fail closed`);
    return false;
  }
  if (parsed.mode === 'rules') {
    return evaluateRuleGroup({ match: parsed.cond.match, rules: parsed.cond.rules }, ctx, 0);
  }
  return evaluateSqlCondition(db, parsed.cond, ctx);
}

/**
 * E2 preview insight: overall pass/fail PLUS per-top-level-entry results.
 * The overall boolean comes from the SAME primitives evaluateConditions
 * dispatches to (shared parse, evaluateRuleGroup, evaluateSqlCondition) —
 * this adds visibility, never a second opinion.
 *
 * @returns {Promise<{ passes: boolean, mode: 'none'|'rules'|'sql'|'invalid',
 *   match?: 'all'|'any', error?: string,
 *   groups: Array<{ type:'rule'|'group'|'sql', label:string, passes:boolean }> }>}
 */
async function explainConditions(db, conditions, ctx) {
  const parsed = parseConditionsValue(conditions);
  if (parsed.always) return { passes: true, mode: 'none', groups: [] };
  if (parsed.error) return { passes: false, mode: 'invalid', error: parsed.error, groups: [] };

  if (parsed.mode === 'sql') {
    const passes = await evaluateSqlCondition(db, parsed.cond, ctx);
    return {
      passes, mode: 'sql',
      groups: [{ type: 'sql', label: 'sql condition', passes }],
    };
  }

  // rules mode — overall via the REAL group evaluator on the full shape…
  const shape = { match: parsed.cond.match, rules: parsed.cond.rules };
  const passes = evaluateRuleGroup(shape, ctx, 0);

  // …then each top-level entry individually through the SAME leaf/group
  // primitives (a nested group evaluates at depth 1, exactly as it does
  // inside evaluateRuleGroup's own recursion).
  const groups = [];
  if (Array.isArray(parsed.cond.rules)) {
    for (const r of parsed.cond.rules) {
      if (!r || typeof r !== 'object') {
        groups.push({ type: 'rule', label: '(malformed rule)', passes: false });
      } else if (Array.isArray(r.rules)) {
        groups.push({
          type: 'group',
          label: `group — ${r.match === 'any' ? 'any' : 'all'} of ${r.rules.length} rule${r.rules.length === 1 ? '' : 's'}`,
          passes: evaluateRuleGroup(r, ctx, 1),
        });
      } else {
        const val = r.value === undefined ? '' :
          ' ' + (Array.isArray(r.value) ? JSON.stringify(r.value) : String(r.value));
        groups.push({
          type: 'rule',
          label: `${r.field} ${r.op}${val}`,
          passes: evaluateLeafRule(r, ctx),
        });
      }
    }
  }

  return { passes, mode: 'rules', match: shape.match === 'any' ? 'any' : 'all', groups };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template body pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Static whitelist scan of a body_template using resolverService's OWN
 * scanner (scanExpressionRefs) — anything reported is exactly what resolve()
 * would fetch, including refs nested in |default:{{...}}. Returns the list
 * of violating refs ([] = clean). trigger_data is not portal vocabulary —
 * any use violates. (validateCard runs this same scan at save time; this
 * render-time scan is the enforcement of record.)
 */
function scanTemplateViolations(text) {
  const scan = scanExpressionRefs(text);
  const violations = [];
  if (scan.triggerData) violations.push('trigger_data.*');
  for (const { table, column } of scan.refs) {
    const key = `${table}.${column}`;
    if (!PORTAL_FIELD_WHITELIST.has(key)) violations.push(key);
  }
  return violations;
}

// Refusal alert gate — once per card key per boot (module lifetime), not per
// request. alert() is fire-and-forget by contract (never throws) but is not
// awaited here regardless — a card refusal must never slow or fail the view.
const _alertedCardKeys = new Set();

function fireRefusalAlert(db, cardKey, violations) {
  if (_alertedCardKeys.has(cardKey)) return;
  _alertedCardKeys.add(cardKey);
  Promise.resolve(alert(db, {
    source:    'portal_cards',
    kind:      'template_ref_violation',
    severity:  'error',
    group_key: `portal_card_refused:${cardKey}`,
    title:     `Portal card '${cardKey}' refused — template references non-whitelisted fields`,
    message:   `Refs outside PORTAL_FIELD_WHITELIST: ${violations.join(', ')}. ` +
               `Card hidden from the portal (refuse, never strip). ` +
               `Fix the template in the portal cards admin.`,
    ref_table: 'portal_cards',
  })).catch(() => { /* alert() never throws; belt anyway */ });
}

/** Test hook — resets the per-boot alert gate. */
function _resetAlertGate() { _alertedCardKeys.clear(); }

// ─────────────────────────────────────────────────────────────────────────────
// Context loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the whitelisted case/contact rows the rules vocabulary evaluates
 * against. SELECT lists are DERIVED from PORTAL_FIELD_WHITELIST — the rows
 * can never carry a non-whitelisted column. (getCaseView holds a similar
 * case row already; the engine re-reads to stay self-contained — two PK
 * lookups per view, deliberate coupling trade.)
 */
async function loadCtx(db, caseId, contactId) {
  const ctx = { caseRow: null, contactRow: null, caseId, contactId };

  for (const [table, rowKey] of Object.entries(CTX_ROW_KEY)) {
    const anchor = table === 'cases' ? caseId : contactId;
    if (anchor === null || anchor === undefined || anchor === '') continue;
    const cols = WL_COLUMNS_BY_TABLE[table].map(c => `\`${c}\``).join(', ');
    const [[row]] = await db.query(
      `SELECT ${cols} FROM \`${table}\` WHERE \`${TABLE_PK[table]}\` = ? LIMIT 1`,
      [anchor]
    );
    ctx[rowKey] = row || null;
  }

  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-card render — THE single materialization path (production + preview)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Materialize ONE card whose conditions have already passed. Shared by
 * renderCards (production) and previewCard (E2 admin) so the preview can
 * never drift from what the portal ships.
 *
 * @param {object} db
 * @param {object} row   portal_cards-shaped row (card_key, title, body_type,
 *                       body_template, coded_key, link_url, link_label,
 *                       placement)
 * @param {object} ctx   loadCtx result (carries the pinned caseId/contactId)
 * @param {object} [opts]
 * @param {boolean} [opts.fireAlerts=true]  production fires the once-per-boot
 *                       refusal alert; the E2 preview suppresses it (a
 *                       preview must not consume the gate or page anyone).
 * @returns {Promise<{ card: object|null, hidden_reason: string|null }>}
 *   card=null when the pipeline hid it; hidden_reason is staff-facing
 *   diagnostics for the preview ('refused: <refs>' / 'missing coded_key' /
 *   'resolve failed').
 */
async function renderOneCard(db, row, ctx, { fireAlerts = true } = {}) {
  const link = safeLink(row.link_url, row.link_label);

  if (row.body_type === 'coded') {
    if (!row.coded_key) return { card: null, hidden_reason: 'missing coded_key (misconfigured coded card)' };
    return {
      card: {
        key: row.card_key, title: row.title,
        body: null, link, coded_key: row.coded_key,
        placement: row.placement,
      },
      hidden_reason: null,
    };
  }

  // template card
  const tpl = row.body_template === null || row.body_template === undefined
    ? '' : String(row.body_template);

  const violations = scanTemplateViolations(tpl);
  if (violations.length) {         // REFUSE, never strip
    if (fireAlerts) fireRefusalAlert(db, row.card_key, violations);
    console.error(
      `[portalCardEngine] card '${row.card_key}' refused — ` +
      `non-whitelisted refs: ${violations.join(', ')}`
    );
    return { card: null, hidden_reason: `refused — non-whitelisted refs: ${violations.join(', ')}` };
  }

  let body = '';
  if (tpl.trim() !== '') {
    // Refs pinned to the session — config never supplies entity ids.
    const res = await resolve({
      db,
      text: tpl,
      refs: {
        contacts: { contact_id: ctx.contactId },
        cases:    { case_id: ctx.caseId },
      },
      strict: false,
    });
    if (res.status === 'failed') {
      // Post-scan this is unreachable for security reasons; belt for
      // resolver-internal failures → hide the card.
      console.error(`[portalCardEngine] card '${row.card_key}' resolve failed — hidden`);
      return { card: null, hidden_reason: 'resolve failed' };
    }
    body = res.text;
    // Unresolved tokens (NULL columns without |default:) must not reach
    // a client as literal {{...}} — strip them. Authors wanting a
    // fallback use |default:.
    for (const token of res.unresolved || []) {
      body = body.split(token).join('');
    }
  }

  return {
    card: {
      key: row.card_key, title: row.title,
      body,          // RAW resolved text — the client escapes at insertion
                     // (ratified item 4, rider 2026-08-08)
      link, coded_key: null,
      placement: row.placement,
    },
    hidden_reason: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderCards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate + render the active cards for one portal case view.
 *
 * @param {object} db
 * @param {object} o
 * @param {string} o.caseId     scope-confirmed case id (canonical casing)
 * @param {number} o.contactId  authed portal contact
 * @param {string|string[]} [o.placement]  filter; omitted = all placements
 * @returns {Promise<Array<{key:string, title:string, body:string|null,
 *          link:{url:string,label:string}|null, coded_key:string|null,
 *          placement:string}>>}
 *   Ordered by (sort, id) across placements. Template `body` is resolved,
 *   unresolved-stripped RAW text — the client escapes it at insertion with
 *   escText, like every other payload string (rider 2026-08-08). Coded
 *   cards carry coded_key and body:null — the client's coded renderer (fed
 *   by data the service attaches, e.g. meeting341) supplies the body.
 *
 * Fail-closed everywhere: any per-card error hides THAT card; any top-level
 * error (e.g. portal_cards missing pre-migration) returns [] — the portal
 * case view itself never errors because of the card engine.
 */
async function renderCards(db, { caseId, contactId, placement } = {}) {
  try {
    const placements = placement === null || placement === undefined
      ? null
      : (Array.isArray(placement) ? placement : [placement]);

    const [rows] = await db.query(
      `SELECT id, card_key, title, body_type, body_template, coded_key,
              link_url, link_label, conditions, placement, sort
         FROM portal_cards
        WHERE active = 1
        ORDER BY sort ASC, id ASC`
    );
    if (!rows.length) return [];

    const ctx = await loadCtx(db, caseId, contactId);
    const out = [];

    for (const row of rows) {
      try {
        if (placements && !placements.includes(row.placement)) continue;

        const passes = await evaluateConditions(db, row.conditions, ctx);
        if (!passes) continue;   // ABSENT from the payload — never display:none'd

        const { card } = await renderOneCard(db, row, ctx);
        if (card) out.push(card);
      } catch (err) {
        console.error(`[portalCardEngine] card '${row && row.card_key}' errored — hidden:`, err.message);
      }
    }

    return out;
  } catch (err) {
    console.error('[portalCardEngine] renderCards failed — no cards:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// E2 — save-time validation (validateCard)
// ─────────────────────────────────────────────────────────────────────────────

/** Push-style leaf-rule validation. `path` labels errors ('rules[2]', …). */
function validateLeafRuleShape(rule, path, errors) {
  if (typeof rule.field !== 'string' || !PORTAL_FIELD_WHITELIST.has(rule.field)) {
    errors.push(`${path}: field '${rule.field}' is not in the portal field whitelist`);
  }
  // Own-property check — same dispatch rule as evaluateLeafRule, so an op
  // like 'constructor' can't validate here and then fail closed at render.
  if (typeof rule.op !== 'string' ||
      !Object.prototype.hasOwnProperty.call(RULE_OP_IMPLS, rule.op)) {
    errors.push(`${path}: unknown op '${rule.op}' (valid: ${RULE_OPS.join(', ')})`);
    return; // value checks are op-dependent
  }
  switch (rule.op) {
    case 'in':
      if (!Array.isArray(rule.value) || rule.value.length === 0) {
        errors.push(`${path}: op 'in' requires a non-empty array value`);
      }
      break;
    case 'date_within_days': {
      const n = Number(rule.value);
      if (!Number.isFinite(n) || n < 0) {
        errors.push(`${path}: op 'date_within_days' requires a number value ≥ 0`);
      }
      break;
    }
    case 'contains':
    case 'starts_with':
      if (rule.value === null || rule.value === undefined || String(rule.value) === '') {
        errors.push(`${path}: op '${rule.op}' requires a value`);
      }
      break;
    default:
      break; // empty / not_empty / date_future / date_past take no value
  }
}

function validateRuleGroupShape(group, path, depth, errors) {
  if (depth > RULE_GROUP_MAX_DEPTH) {
    errors.push(`${path}: rule groups nest deeper than the engine's cap (${RULE_GROUP_MAX_DEPTH})`);
    return;
  }
  if (group.match !== undefined && group.match !== 'all' && group.match !== 'any') {
    errors.push(`${path}: match must be 'all' or 'any'`);
  }
  if (!Array.isArray(group.rules) || group.rules.length === 0) {
    errors.push(`${path}: rules must be a non-empty array`);
    return;
  }
  group.rules.forEach((r, i) => {
    const p = `${path}.rules[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push(`${p}: must be a rule or a nested group object`);
      return;
    }
    if (Array.isArray(r.rules)) validateRuleGroupShape(r, p, depth + 1, errors);
    else validateLeafRuleShape(r, p, errors);
  });
}

function validateSqlConditionShape(cond, errors) {
  const c = cond.condition;
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    errors.push(`sql mode requires a 'condition' object ({ query, params, assert, assert_mode })`);
    return;
  }
  if (!c.query || typeof c.query !== 'string' || !c.query.trim().toUpperCase().startsWith('SELECT')) {
    errors.push(`sql condition query must be a SELECT statement`);
  }
  const paramMap = c.params === undefined ? {} : c.params;
  if (!paramMap || typeof paramMap !== 'object' || Array.isArray(paramMap)) {
    errors.push(`sql condition params must be an object mapping :placeholders to pinned paths`);
  } else {
    for (const [name, path] of Object.entries(paramMap)) {
      if (typeof path !== 'string' || !ALLOWED_SQL_PARAM_PATHS.has(path)) {
        errors.push(
          `sql condition param :${name} maps to '${path}' — only the pinned session ` +
          `paths are allowed (case_id, contact_id, optionally trigger_data.-prefixed)`
        );
      }
    }
  }
  if (c.assert !== undefined && (!c.assert || typeof c.assert !== 'object' || Array.isArray(c.assert))) {
    errors.push(`sql condition assert must be an object`);
  }
  if (c.assert_mode !== undefined && c.assert_mode !== 'all' && c.assert_mode !== 'any') {
    errors.push(`sql condition assert_mode must be 'all' or 'any'`);
  }
}

/**
 * E2 save-time validation + normalization. REJECTS, never strips or
 * sanitizes — staff learn about a violation when SAVING, instead of by the
 * card silently vanishing from the portal (the render-time refusal remains
 * the enforcement of record; this is the UX layer in front of it). Errors
 * are staff-facing and NAME the offending refs/ops/paths.
 *
 * Built on the SAME primitives the render path enforces with
 * (scanTemplateViolations → PORTAL_FIELD_WHITELIST, RULE_OP_IMPLS,
 * ALLOWED_SQL_PARAM_PATHS, VALID_PLACEMENTS, KNOWN_CODED_KEYS), so a card
 * that saves is a card that renders — and vice versa.
 *
 * @param {object} card  full card object (create payload, or an existing row
 *                       merged with a partial update). `conditions` may be an
 *                       object, a JSON string, or null.
 * @returns {{ valid: boolean, errors: string[], card: object|null }}
 *   `card` = the normalized row (trimmed strings, conditions as object|null,
 *   sort int, active 0/1) ready for storage; null when invalid.
 */
function validateCard(input) {
  const errors = [];
  const c = input && typeof input === 'object' ? input : {};

  // card_key
  const card_key = String(c.card_key == null ? '' : c.card_key).trim();
  if (!CARD_KEY_RE.test(card_key)) {
    errors.push(`card_key must match ${CARD_KEY_RE} (letters, digits, _ and -, max 50)`);
  }

  // title
  const title = String(c.title == null ? '' : c.title).trim();
  if (!title) errors.push('title is required');
  else if (title.length > TITLE_MAX) errors.push(`title exceeds ${TITLE_MAX} characters`);

  // body_type
  const body_type = c.body_type == null ? 'template' : String(c.body_type);
  if (body_type !== 'template' && body_type !== 'coded') {
    errors.push(`body_type must be 'template' or 'coded'`);
  }

  // body_template / coded_key — split by body_type
  let body_template = c.body_template === undefined || c.body_template === null
    ? null : String(c.body_template);
  let coded_key = c.coded_key === undefined || c.coded_key === null
    ? null : String(c.coded_key).trim() || null;

  if (body_type === 'coded') {
    if (body_template !== null && body_template.trim() !== '') {
      errors.push(`coded cards have no body_template — the body is supplied by code (coded_key)`);
    }
    body_template = null;
    if (!coded_key) {
      errors.push(`coded cards require a coded_key`);
    } else if (!KNOWN_CODED_KEYS.includes(coded_key)) {
      errors.push(
        `coded_key '${coded_key}' has no renderer in the portal client — ` +
        `known coded keys: ${KNOWN_CODED_KEYS.join(', ')} (new renderers ship with code)`
      );
    }
  } else if (body_type === 'template') {
    if (coded_key) {
      errors.push(`template cards must not carry a coded_key`);
    }
    coded_key = null;
    const violations = scanTemplateViolations(body_template === null ? '' : body_template);
    if (violations.length) {
      errors.push(
        `body_template references fields outside the portal whitelist: ` +
        `${violations.join(', ')} — cards refuse (never strip); remove or replace these refs`
      );
    }
  }

  // link
  const link_url = c.link_url === undefined || c.link_url === null
    ? null : String(c.link_url).trim() || null;
  const link_label = c.link_label === undefined || c.link_label === null
    ? null : String(c.link_label).trim() || null;
  if (link_url) {
    if (link_url.length > LINK_URL_MAX) errors.push(`link_url exceeds ${LINK_URL_MAX} characters`);
    if (!safeLink(link_url, link_label)) {
      errors.push(
        `link_url must be an absolute http(s) URL or a site-relative path starting ` +
        `with a single '/' — anything else is dropped at render time`
      );
    }
  } else if (link_label) {
    errors.push(`link_label without link_url does nothing — set link_url or clear the label`);
  }
  if (link_label && link_label.length > LINK_LABEL_MAX) {
    errors.push(`link_label exceeds ${LINK_LABEL_MAX} characters`);
  }

  // conditions
  let conditions = null;
  if (c.conditions !== undefined && c.conditions !== null && c.conditions !== '') {
    const parsed = parseConditionsValue(c.conditions);
    if (parsed.error) {
      errors.push(parsed.error);
    } else if (!parsed.always) {
      conditions = parsed.cond;
      if (parsed.mode === 'rules') {
        validateRuleGroupShape(
          { match: conditions.match, rules: conditions.rules }, 'conditions', 0, errors
        );
      } else {
        validateSqlConditionShape(conditions, errors);
      }
    }
  }

  // placement
  const placement = c.placement == null || String(c.placement).trim() === ''
    ? 'case' : String(c.placement).trim();
  if (!VALID_PLACEMENTS.includes(placement)) {
    errors.push(
      `placement '${placement}' is not a portal surface — valid: ${VALID_PLACEMENTS.join(', ')} ` +
      `(an unknown placement renders nowhere)`
    );
  }

  // sort
  let sort = 0;
  if (c.sort !== undefined && c.sort !== null && c.sort !== '') {
    const n = Number(c.sort);
    if (!Number.isInteger(n)) errors.push('sort must be an integer');
    else sort = n;
  }

  // active
  let active = 1;
  if (c.active !== undefined && c.active !== null && c.active !== '') {
    if (c.active === true || c.active === 1 || c.active === '1') active = 1;
    else if (c.active === false || c.active === 0 || c.active === '0') active = 0;
    else errors.push('active must be 0 or 1');
  }

  if (errors.length) return { valid: false, errors, card: null };
  return {
    valid: true, errors: [],
    card: {
      card_key, title, body_type, body_template, coded_key,
      link_url, link_label, conditions, placement, sort, active,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// E2 — preview (previewCard)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a (draft) card through the REAL pipeline, pinned to an admin-chosen
 * case and contact — the exact path the portal takes for that client:
 * loadCtx → evaluateConditions → renderOneCard. Adds per-group condition
 * results for author insight (explainConditions — same primitives, extra
 * visibility). Refusal ALERTS are suppressed (a preview must not consume the
 * once-per-boot gate or page anyone); refusal itself still hides the card
 * and is reported in hidden_reason.
 *
 * The caller (routes/api.portalCardsAdmin.js) validates the draft FIRST —
 * previewCard renders whatever it's given so the pipeline stays authoritative.
 *
 * @param {object} db
 * @param {object} card   portal_cards-shaped card (validateCard-normalized)
 * @param {object} o      { caseId, contactId } — the pinned preview session
 * @returns {Promise<{ passes: boolean,
 *   conditions: { passes, mode, match?, error?, groups },
 *   card: object|null, hidden_reason: string|null }>}
 */
async function previewCard(db, card, { caseId, contactId } = {}) {
  const ctx = await loadCtx(db, caseId, contactId);
  const conditions = await explainConditions(db, card.conditions, ctx);

  if (!conditions.passes) {
    return { passes: false, conditions, card: null, hidden_reason: 'conditions failed' };
  }

  const { card: rendered, hidden_reason } =
    await renderOneCard(db, card, ctx, { fireAlerts: false });
  return { passes: true, conditions, card: rendered, hidden_reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  PORTAL_FIELD_WHITELIST,
  RULE_OPS,
  VALID_PLACEMENTS,
  KNOWN_CODED_KEYS,
  ALLOWED_SQL_PARAM_PATHS,
  evaluateConditions,
  renderCards,
  validateCard,
  previewCard,
  // _-prefixed test surface (repo pattern: logService/portalCaseService).
  _evaluateRuleGroup: evaluateRuleGroup,
  _evaluateLeafRule:  evaluateLeafRule,
  _scanTemplateViolations: scanTemplateViolations,
  _explainConditions: explainConditions,
  _renderOneCard: renderOneCard,
  _safeLink:   safeLink,
  _toNaiveDateStr: toNaiveDateStr,
  _isEmptyValue:   isEmptyValue,
  _loadCtx:    loadCtx,
  _resetAlertGate,
};
