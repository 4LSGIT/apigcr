// lib/portalCardEngine.js
//
/**
 * Portal card engine — Client Portal Slice E1.
 *
 * Evaluates and renders the configurable cards (portal_cards table) for the
 * client portal case view. Staff define cards (E2 admin UI); this module is
 * the ONLY render path — public/portal/case.html consumes its output verbatim.
 *
 * RATIFIED SECURITY MODEL (Fred + manager, 2026-08-07 — binding; not this
 * module's, staff's, or any caller's to relax):
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
 *  3. REFS PINNED TO THE SESSION — resolver refs / sql-condition params are
 *     built from exactly the authed contactId + the scope-confirmed caseId.
 *     Config can NEVER supply entity ids (rules mode has no id surface at
 *     all; sql mode's paramMap values may only name the two pinned paths).
 *  4. BODIES ARE ESCAPED TEXT — resolved template output is HTML-escaped
 *     HERE, server-side, before it enters the payload (the client inserts
 *     card.body WITHOUT re-escaping — see case.html). Templates are text with
 *     placeholders, never HTML; action links come from the structured
 *     link_url/link_label columns, never markup.
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
 *   PORTAL_FIELD_WHITELIST
 *   evaluateConditions(db, conditions, ctx)   ctx = { caseRow, contactRow,
 *                                                     caseId, contactId }
 *   renderCards(db, { caseId, contactId, placement }) → [{ key, title,
 *       body|null, link:{url,label}|null, coded_key|null, placement }]
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

/** escText parity (public/portal/*.html) — & < > " '. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

/** One leaf rule. Unknown op / non-whitelisted field / bad value → false. */
function evaluateLeafRule(rule, ctx) {
  const f = getField(ctx, rule.field);
  if (!f.ok) {
    console.warn(`[portalCardEngine] rule field not whitelisted: ${rule.field} — fail closed`);
    return false;
  }
  const v = f.value;
  const today = nowLocal().toISODate();

  switch (rule.op) {
    case 'empty':
      return isEmptyValue(v);
    case 'not_empty':
      return !isEmptyValue(v);
    case 'in': {
      if (!Array.isArray(rule.value) || v === null || v === undefined) return false;
      const actual = String(v).trim();   // trim parity with the shipped type gate
      return rule.value.some(c => String(c).trim() === actual);
    }
    case 'date_future': {
      const d = toNaiveDateStr(v);
      return d !== null && d >= today;   // >= : today still shows (shipped 341 boundary)
    }
    case 'date_past': {
      const d = toNaiveDateStr(v);
      return d !== null && d < today;
    }
    case 'date_within_days': {
      const n = Number(rule.value);
      if (!Number.isFinite(n) || n < 0) return false;
      const d = toNaiveDateStr(v);
      if (d === null) return false;
      const upper = nowLocal().plus({ days: Math.floor(n) }).toISODate();
      return d >= today && d <= upper;
    }
    case 'contains': {
      if (v === null || v === undefined || rule.value === null || rule.value === undefined) return false;
      return String(v).includes(String(rule.value));
    }
    case 'starts_with': {
      if (v === null || v === undefined || rule.value === null || rule.value === undefined) return false;
      return String(v).startsWith(String(rule.value));
    }
    default:
      console.warn(`[portalCardEngine] unknown rule op: ${rule && rule.op} — fail closed`);
      return false;
  }
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
// evaluateConditions
// ─────────────────────────────────────────────────────────────────────────────

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
  if (conditions === null || conditions === undefined) return true;

  let cond = conditions;
  if (typeof cond === 'string') {
    try { cond = JSON.parse(cond); } catch (err) {
      console.error('[portalCardEngine] conditions JSON parse failed — fail closed:', err.message);
      return false;
    }
  }
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return false;

  const mode = cond.mode || 'rules';
  if (mode === 'rules') {
    return evaluateRuleGroup({ match: cond.match, rules: cond.rules }, ctx, 0);
  }
  if (mode === 'sql') {
    return evaluateSqlCondition(db, cond, ctx);
  }
  console.warn(`[portalCardEngine] unknown conditions mode '${mode}' — fail closed`);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template body pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Static whitelist scan of a body_template using resolverService's OWN
 * scanner (scanExpressionRefs) — anything reported is exactly what resolve()
 * would fetch, including refs nested in |default:{{...}}. Returns the list
 * of violating refs ([] = clean). trigger_data is not portal vocabulary —
 * any use violates. (E2 runs the same scan at save time; this render-time
 * scan is the enforcement of record.)
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
 *   unresolved-stripped, and HTML-ESCAPED (the client inserts it verbatim).
 *   Coded cards carry coded_key and body:null — the client's coded renderer
 *   (fed by data the service attaches, e.g. meeting341) supplies the body.
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

        const link = safeLink(row.link_url, row.link_label);

        if (row.body_type === 'coded') {
          if (!row.coded_key) continue;   // misconfigured coded card → hidden
          out.push({
            key: row.card_key, title: row.title,
            body: null, link, coded_key: row.coded_key,
            placement: row.placement,
          });
          continue;
        }

        // template card
        const tpl = row.body_template === null || row.body_template === undefined
          ? '' : String(row.body_template);

        const violations = scanTemplateViolations(tpl);
        if (violations.length) {         // REFUSE, never strip
          fireRefusalAlert(db, row.card_key, violations);
          console.error(
            `[portalCardEngine] card '${row.card_key}' refused — ` +
            `non-whitelisted refs: ${violations.join(', ')}`
          );
          continue;
        }

        let body = '';
        if (tpl.trim() !== '') {
          // Refs pinned to the session — config never supplies entity ids.
          const res = await resolve({
            db,
            text: tpl,
            refs: {
              contacts: { contact_id: contactId },
              cases:    { case_id: caseId },
            },
            strict: false,
          });
          if (res.status === 'failed') {
            // Post-scan this is unreachable for security reasons; belt for
            // resolver-internal failures → hide the card.
            console.error(`[portalCardEngine] card '${row.card_key}' resolve failed — hidden`);
            continue;
          }
          body = res.text;
          // Unresolved tokens (NULL columns without |default:) must not reach
          // a client as literal {{...}} — strip them. Authors wanting a
          // fallback use |default:.
          for (const token of res.unresolved || []) {
            body = body.split(token).join('');
          }
        }

        out.push({
          key: row.card_key, title: row.title,
          body: escapeHtml(body),        // ratified item 4 — server-escaped
          link, coded_key: null,
          placement: row.placement,
        });
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
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  PORTAL_FIELD_WHITELIST,
  evaluateConditions,
  renderCards,
  // _-prefixed test surface (repo pattern: logService/portalCaseService).
  _evaluateRuleGroup: evaluateRuleGroup,
  _evaluateLeafRule:  evaluateLeafRule,
  _scanTemplateViolations: scanTemplateViolations,
  _escapeHtml: escapeHtml,
  _safeLink:   safeLink,
  _toNaiveDateStr: toNaiveDateStr,
  _isEmptyValue:   isEmptyValue,
  _loadCtx:    loadCtx,
  _resetAlertGate,
};