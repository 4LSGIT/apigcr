#!/usr/bin/env node
// scripts/uiCustomS5eCustomTabsToButtons.js
//
/**
 * ui-custom S5e-1 — move every legacy custom tab into the launcher, then clear it.
 *
 * The legacy custom tab is users.user_custom_tab ({ src, icon, title,
 * loadFunc }, Settings → My Custom Tab), drawn by applyCustomTab in
 * public/index.html as the registry item `custom`. This script turns each live
 * one into a launcher item in the same place, by the manager's per-user rulings
 * (local/ui-custom/S5e1_WORKER_PROMPT.md):
 *
 *   1 Stuart    a new button: tool call-review, "Call Review", headset, opens as a tab
 *   22 Rena     a new button: view lead_followups, "Follow Ups", list-check, opens as a tab
 *   3 Rivka     a new button: link /etch.html, "Paint", paintbrush (a new window)
 *       — each placed where `custom` is, on Home AND in the sidebar
 *   5 Shoshana  no button: the registry item moreManuals takes the custom slot on
 *               Home and in the sidebar (the user-layout validator allows a More
 *               item there); the loadFunc prank is dropped
 *   6 Fred      his stored layout's placed.home {item:'custom'} (right after log)
 *               becomes {item:'user:call-review'}, his existing button. Nothing
 *               else: not its presentation, not his drawer, no sidebar.
 *   0 Automations  nothing in ui_config
 * and, in the SAME per-user transaction, users.user_custom_tab := the JSON null
 * scalar ('null') for all six — what users 2, 4 and 23 already hold, and what
 * routes/admin.users.js inserts. NOT SQL NULL: the column is json NOT NULL, and
 * the route's own clear (SET user_custom_tab = NULL) only lands because the
 * sql_mode is relaxed (it stores JSON null with warning 1048; manager's
 * correction 2026-10-16). The end state asserts JSON_TYPE = 'NULL' AND
 * IS NOT NULL. The live shell renders nothing for an empty custom tab, so
 * no duplicate ever shows; retiring the code is S5e-2, the column S5e-3.
 *
 * USAGE (from the repo root, on a machine whose .env reaches production):
 *
 *   node scripts/uiCustomS5eCustomTabsToButtons.js           # CHECK — read-only
 *   node scripts/uiCustomS5eCustomTabsToButtons.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command.
 *
 * ── THE EXPECTED LIVE STATE ───────────────────────────────────────────────
 * ref/migrations/2026-10-16_ui_custom_s5e_custom_tabs_to_buttons.json is the
 * record of the exact prior values AND this script's expectation: every user
 * listed there must have exactly that user_custom_tab (key-order-insensitive —
 * MySQL re-orders JSON keys) and exactly those scope-user ui_config rows, and
 * no other user may have a custom tab. A value the record holds as
 * {"$unknown": …} is refused until it is filled in: CHECK prints every live
 * value under PRIOR VALUES. Fred's layout must hold one {item:'custom'} right
 * after {item:'log'} in placed.home, no user:call-review there, no stored
 * sidebar (placed or removed), and his items must hold user:call-review as a
 * modal tool button for call-review.
 *
 * Each user is in one of two states, and only these: BEFORE (exactly the
 * record) or AFTER (exactly what this script writes from it). Anything else —
 * a user edited something in between, the firm hid an item, a deny changed the
 * plan — is a NO-GO naming it, and nothing is written. CHECK and --apply
 * classify everyone first; --apply re-reads and re-plans each user under row
 * locks (users FOR UPDATE + their ui_config rows FOR UPDATE) and refuses when
 * that plan differs from the one it printed.
 *
 * ── HOW THE DOCUMENTS ARE MADE ────────────────────────────────────────────
 * With the client's own code, loaded in a bare vm exactly as
 * tests/launcherS4b.test.js loads it (public/js/ycIcon.js, featureRegistry.js,
 * index.html's ycLauncher block, ycLayoutEditor.js — no DOM: those pure cores
 * need none):
 *   - ids: ycLayoutEditor.makeUserId(label, taken) — the S5a rule;
 *   - placement: ycLayoutEditor.session(…).replace('custom', id), then a
 *     retarget without `custom` — what My buttons' "Make my custom tab a
 *     button" does (S5c-b convertLegacy): the full visible list of each
 *     surface, written as an explicit placed list, by the S4b editor itself;
 *     the effective registry is THIS user's (ycLauncher.computeEffective over
 *     their roles — isAdmin = su, as loadUserContext —, their denies
 *     (entitlementService.deniedFor), the firm's ui_config and their own);
 *   - Fred's: the single literal swap the ruling names.
 * AFTER S5e-2 (which retired the custom tab from the client once this script
 * had run live, 2026-10-16) the client no longer has `custom`: loadCore then
 * puts back exactly what S5e-2 took out of these pure cores — the registry
 * item, its Home slot (Calendar's since) and its sidebar slot, and
 * computeEffective's rule for it — so the script stays runnable as the record
 * of that run. Its CHECK on the live state reads AFTER for every user.
 * Every document is validated by lib/uiConfigShape.js (and must normalize to
 * itself) and written by services/uiConfigService.write — on this script's ONE
 * connection, inside the per-user transaction (txDb below: the service's own
 * begin / commit become no-ops, so its SELECT … FOR UPDATE and INSERT … ON
 * DUPLICATE KEY UPDATE run in our transaction; a failed statement poisons the
 * rest, so the service's deadlock retry can never run half a user outside it).
 * User rows are not versioned (the service writes no version row for them).
 * updated_by is the user themself — the service's rule for a user row.
 *
 * ── VERIFIED, PER USER, BEFORE AND AFTER COMMIT ───────────────────────────
 * The rows re-read, and the user classified AFTER; then Home and the sidebar
 * resolved with the real client resolver (ycLauncher.resolveLayout over
 * computeEffective) before and after: identical, except that the custom slot
 * now holds the new id (Fred's sidebar: the slot is gone — the ruling). The
 * All tab's ids likewise (custom out, the new button in). The new buttons show
 * the custom tab's own title and icon.
 *
 * ── CONSEQUENCE (reported, not avoided) ───────────────────────────────────
 * Users 1, 3, 5 and 22 had no stored layout: from now on they are "customized"
 * users, so firm defaults only ADD items for them (S6c ruling 4).
 *
 * ── RESUME ────────────────────────────────────────────────────────────────
 * One transaction per user. A user already AFTER is skipped. A failed or
 * killed run leaves every user BEFORE or AFTER; re-run --apply.
 * A ONE-TIME run (manager ruling Q4): once users start editing their layout or
 * buttons after it, a re-run is a DRIFT NO-GO for them, by design — not a
 * repeatable job.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const shape = require('../lib/uiConfigShape');
const uiConfigService = require('../services/uiConfigService');
const { deniedFor } = require('../services/entitlementService');

const ROOT = path.join(__dirname, '..');
const RECORD_FILE = path.join(ROOT, 'ref', 'migrations', '2026-10-16_ui_custom_s5e_custom_tabs_to_buttons.json');
const SELF = 'node scripts/uiCustomS5eCustomTabsToButtons.js';
const QUERY_TIMEOUT_MS = 30_000;
const SURFACES = ['home', 'sidebar'];

// The manager's rulings, by user. kind:
//   button    a new user button, placed in the custom slot on Home and the sidebar
//   registry  an existing registry item takes the custom slot on both surfaces
//   swapHome  the literal swap in a stored placed.home (Fred)
//   clear     nothing in ui_config
const DISPOSITIONS = Object.freeze({
  0:  Object.freeze({ kind: 'clear' }),
  1:  Object.freeze({ kind: 'button', label: 'Call Review', icon: 'headset', action: { type: 'tool', key: 'call-review', present: 'tab' } }),
  3:  Object.freeze({ kind: 'button', label: 'Paint', icon: 'paintbrush', action: { type: 'url', href: '/etch.html', present: 'window' } }),
  5:  Object.freeze({ kind: 'registry', id: 'moreManuals' }),
  6:  Object.freeze({ kind: 'swapHome', id: 'user:call-review', after: 'log', tool: 'call-review' }),
  22: Object.freeze({ kind: 'button', label: 'Follow Ups', icon: 'list-check', action: { type: 'view', key: 'lead_followups', present: 'tab' } }),
});

const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => shape.canonical(v);
const short = (v) => JSON.stringify(v);

// ─────────────────────────────────────────────────────────────────────────
// The record (the expected live state)
// ─────────────────────────────────────────────────────────────────────────
function loadRecord(file = RECORD_FILE) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!r || !Array.isArray(r.users)) throw new Error(`${file}: no users list`);
  const byUser = new Map();
  for (const u of r.users) {
    if (!Number.isInteger(u.user) || byUser.has(u.user)) throw new Error(`${file}: bad or duplicate user ${u.user}`);
    if (!Array.isArray(u.ui_config_before)) throw new Error(`${file}: user ${u.user} has no ui_config_before list`);
    byUser.set(u.user, { user: u.user, name: u.name || null, ct: u.user_custom_tab, rows: u.ui_config_before.slice().sort() });
  }
  for (const uid of Object.keys(DISPOSITIONS).map(Number)) {
    if (!byUser.has(uid)) throw new Error(`${file}: user ${uid} (a ruling of this script) is not in the record`);
  }
  return byUser;
}

const isUnknown = (v) => isObj(v) && Object.keys(v).length === 1 && Object.prototype.hasOwnProperty.call(v, '$unknown');
/** expected (may hold {$unknown}) vs actual → { same, unknown: [paths], diff: [paths] }. */
function compareExpected(exp, act, at = '') {
  const out = { unknown: [], diff: [] };
  (function walk(e, a, p) {
    if (isUnknown(e)) { out.unknown.push(p || '(value)'); return; }
    if (isObj(e) && isObj(a)) {
      const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
      for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(e, k) || !Object.prototype.hasOwnProperty.call(a, k)) out.diff.push(p + '.' + k);
        else walk(e[k], a[k], p + '.' + k);
      }
      return;
    }
    if (canon(e) !== canon(a)) out.diff.push(p || '(value)');
  })(exp, act, at);
  out.same = !out.unknown.length && !out.diff.length;
  return out;
}
/** The record's value with every {$unknown} replaced — for PLANNING only
 *  (the plan reads src / title / icon, never loadFunc). */
function fillUnknown(v) {
  if (isUnknown(v)) return '(unknown)';
  if (Array.isArray(v)) return v.map(fillUnknown);
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = fillUnknown(v[k]); return o; }
  return v;
}

// ─────────────────────────────────────────────────────────────────────────
// The client's own code, in a bare vm
// ─────────────────────────────────────────────────────────────────────────
let CORE = null;
// What S5e-2 took out of the client's pure cores (featureRegistry.js and
// index.html's computeEffective at 5eef883, its parent), put back when absent.
const HISTORIC_CUSTOM = Object.freeze({
  label: 'Custom Tab', title: 'Custom', icon: 'clock',
  onclick: "openMainTab('tabCustom')", tab: 'tabCustom',
  domIds: { sidebar: 'sbCustom', home: 'tabCustomButton' },
});
function restoreCustomTab(w) {
  const home = w.DEFAULT_LAYOUTS.home, side = w.DEFAULT_LAYOUTS.sidebar;
  const cal = home.map((e, i) => (e && e.item === 'calendar' ? i : -1)).filter((i) => i >= 0);
  if (cal.length !== 1 || cal[0] !== home.length - 3) throw new Error('loadCore: Home has no single calendar at -3 (the slot S5e-2 gave it)');
  const nc = side.map((e, i) => (e && e.item === 'newClient' ? i : -1)).filter((i) => i >= 0);
  if (nc.length !== 1) throw new Error('loadCore: the sidebar has no single newClient');
  w.FEATURE_REGISTRY.custom = JSON.parse(JSON.stringify(HISTORIC_CUSTOM));
  home[cal[0]] = { item: 'custom' };
  side.splice(nc[0] + 1, 0, { item: 'custom' });
}
// computeEffective's custom-tab rule as it was: listed only while the user has
// a custom tab (opts.customTab with a src), under its title (else the
// registry label) and its icon (else the bug); no firm rename reaches it.
function wrapCustomTabRule(L) {
  const base = L.computeEffective;
  L.computeEffective = function (opts, ...rest) {
    const out = base.call(this, opts, ...rest);
    const i = out.findIndex((e) => e.id === 'custom');
    if (i < 0) return out;
    const ct = opts && opts.customTab;
    if (!ct || !ct.src) { out.splice(i, 1); return out; }
    const label = ct.title ? String(ct.title) : HISTORIC_CUSTOM.label;
    Object.assign(out[i], { label, labels: [label], icon: ct.icon ? String(ct.icon) : 'bug' });
    return out;
  };
}
function loadCore() {
  if (CORE) return CORE;
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const shell = read('public/index.html');
  const m = /<script id="ycLauncher">([\s\S]*?)<\/script>/.exec(shell);
  if (!m) throw new Error('public/index.html: the ycLauncher block was not found');
  const warnings = [];
  const ctx = vm.createContext({
    URL,
    console: { error: (msg) => { throw new Error('[client] ' + String(msg)); }, warn: (msg) => { warnings.push(String(msg)); }, log() {} },
  });
  ctx.window = ctx;
  vm.runInContext(read('public/js/ycIcon.js'), ctx, { filename: 'ycIcon.js' });
  vm.runInContext(read('public/js/featureRegistry.js'), ctx, { filename: 'featureRegistry.js' });
  const historic = !Object.prototype.hasOwnProperty.call(ctx.window.FEATURE_REGISTRY, 'custom');
  if (historic) restoreCustomTab(ctx.window);
  vm.runInContext(m[1], ctx, { filename: 'index.html#ycLauncher' });
  vm.runInContext(read('public/js/ycLayoutEditor.js'), ctx, { filename: 'ycLayoutEditor.js' });
  const L = ctx.window.ycLauncher, E = ctx.window.ycLayoutEditor;
  if (historic && L && typeof L.computeEffective === 'function') wrapCustomTabRule(L);
  for (const [n, f] of [['ycLauncher.computeEffective', L && L.computeEffective], ['ycLauncher.resolveLayout', L && L.resolveLayout],
    ['ycLayoutEditor.session', E && E.session], ['ycLayoutEditor.makeUserId', E && E.makeUserId]]) {
    if (typeof f !== 'function') throw new Error(`the client core has no ${n}`);
  }
  CORE = { L, E, REG: ctx.window.FEATURE_REGISTRY, LAY: J(ctx.window.DEFAULT_LAYOUTS), warnings, historic };
  return CORE;
}

// ─────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────
const parseJson = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
};
const rolesOf = (s) => String(s || '').split(',').map((r) => r.trim()).filter(Boolean);

/** One user's state: { user, name, roles, ct, ctType, rows: { key: doc }, badRows: [] }.
 *  lock: FOR UPDATE (inside a transaction). */
async function readUser(db, uid, lock = false) {
  const fu = lock ? ' FOR UPDATE' : '';
  const [[u]] = await db.query(
    '/* s5e:user */ SELECT `user`, user_name, roles, user_custom_tab AS ct, JSON_TYPE(user_custom_tab) AS ct_type, ' +
    '(user_custom_tab IS NULL) AS ct_sql_null FROM users WHERE `user` = ?' + fu, [uid]);
  if (!u) return null;
  const [rows] = await db.query(
    "/* s5e:rows */ SELECT id, role, config_key, config FROM ui_config WHERE scope = 'user' AND user_id = ? ORDER BY config_key" + fu, [uid]);
  // ctType: 'SQL NULL' for a real SQL NULL (the column is json NOT NULL: never
  // expected), else JSON_TYPE ('NULL' = the JSON null scalar)
  const out = { user: Number(u.user), name: u.user_name, roles: rolesOf(u.roles), ct: parseJson(u.ct),
    ctType: Number(u.ct_sql_null) ? 'SQL NULL' : u.ct_type, rows: {}, badRows: [] };
  for (const r of rows) {
    if (r.role !== '') { out.badRows.push(`${r.config_key} (role "${r.role}")`); continue; }
    out.rows[r.config_key] = parseJson(r.config);
  }
  return out;
}

/** What the launcher of this user is computed from, besides their own rows. */
async function readEnv(db, uid, roles) {
  const firm = (await uiConfigService.readFor(db, null)).firm;
  const denied = await deniedFor(db, uid);
  const ro = isObj(firm.registry_overrides) ? firm.registry_overrides : {};
  return {
    firm, denied, roles: roles.slice(), isAdmin: roles.includes('su'),
    locked: Array.isArray(ro.locked) ? ro.locked.filter((x) => typeof x === 'string') : [],
  };
}

async function readAll(db) {
  const [users] = await db.query(
    '/* s5e:users */ SELECT `user`, user_name, roles, user_custom_tab AS ct, JSON_TYPE(user_custom_tab) AS ct_type FROM users ORDER BY `user`');
  const [rows] = await db.query("/* s5e:user-rows */ SELECT DISTINCT user_id FROM ui_config WHERE scope = 'user'");
  const states = new Map();
  for (const u of users) states.set(Number(u.user), await readUser(db, Number(u.user)));
  const envs = new Map();
  for (const uid of Object.keys(DISPOSITIONS).map(Number)) {
    if (states.has(uid)) envs.set(uid, await readEnv(db, uid, states.get(uid).roles));
  }
  return { states, envs, rowUsers: rows.map((r) => Number(r.user_id)) };
}

// ─────────────────────────────────────────────────────────────────────────
// Planning and checking — pure (given the client core)
// ─────────────────────────────────────────────────────────────────────────
function effective(core, env, rows, ct) {
  return core.L.computeEffective({
    isAdmin: env.isAdmin, denied: env.denied, roles: env.roles, customTab: ct || null,
    ui: { firm: env.firm, user: rows },
  });
}
/** Every user: id named anywhere in v. */
function userIds(v, out = new Set()) {
  if (typeof v === 'string') { if (shape.USER_ID_RE.test(v)) out.add(v); }
  else if (Array.isArray(v)) v.forEach((x) => userIds(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => userIds(x, out));
  return out;
}
function fredHomeProblems(rows, d) {
  const p = [];
  const lay = rows.layout, items = rows.items;
  const home = isObj(lay) && isObj(lay.placed) && Array.isArray(lay.placed.home) ? lay.placed.home : null;
  if (!home) p.push('his layout has no placed.home');
  else {
    const at = home.map((e, i) => (isObj(e) && e.item === 'custom' ? i : -1)).filter((i) => i >= 0);
    if (at.length !== 1) p.push(`placed.home holds ${at.length} {item:'custom'} entries, expected 1`);
    else if (!(at[0] > 0 && isObj(home[at[0] - 1]) && home[at[0] - 1].item === d.after)) p.push(`placed.home's custom is not right after {item:'${d.after}'}`);
    if (home.some((e) => isObj(e) && e.item === d.id)) p.push(`placed.home already holds ${d.id}`);
  }
  if (isObj(lay) && isObj(lay.placed) && Object.prototype.hasOwnProperty.call(lay.placed, 'sidebar')) p.push('he has a stored placed.sidebar');
  if (isObj(lay) && isObj(lay.removed) && Object.prototype.hasOwnProperty.call(lay.removed, 'sidebar')) p.push('he has a stored removed.sidebar');
  const btn = isObj(items) && Array.isArray(items.items) ? items.items.find((it) => isObj(it) && it.id === d.id) : null;
  if (!btn) p.push(`his items hold no ${d.id}`);
  else if (!isObj(btn.action) || btn.action.type !== 'tool' || btn.action.key !== d.tool || btn.action.present !== 'modal') {
    p.push(`his ${d.id} is not a modal tool button for ${d.tool}: ${short(btn.action)}`);
  }
  return p;
}

/** The BEFORE test: the state is exactly the record → problems[] ([] = BEFORE). */
function beforeProblems(uid, st, exp) {
  const p = [];
  const c = compareExpected(exp.ct, st.ct);
  for (const k of c.unknown) p.push(`the record does not hold the exact prior user_custom_tab${k}: paste it from PRIOR VALUES (user ${uid}) into ${path.relative(ROOT, RECORD_FILE)}`);
  for (const k of c.diff) p.push(`user_custom_tab${k === '(value)' ? '' : k} differs from the record`);
  if (exp.ct === null && st.ct === null && st.ctType !== 'NULL') p.push(`user_custom_tab is ${st.ctType}, not the JSON null scalar`);
  if (st.badRows.length) p.push(`ui_config rows with a role: ${st.badRows.join(', ')}`);
  const keys = Object.keys(st.rows).sort();
  if (canon(keys) !== canon(exp.rows)) p.push(`ui_config rows are [${keys.join(', ')}], the record says [${exp.rows.join(', ')}]`);
  const d = DISPOSITIONS[uid];
  if (d && d.kind === 'swapHome' && !p.length) p.push(...fredHomeProblems(st.rows, d));
  return p;
}

/**
 * The plan for a user in the BEFORE state → { writes: [{ config_key, config }],
 * slots: { home, sidebar } (what the custom slot holds after; null = gone),
 * button?: the new item, problems: [] }.
 */
function planUser(uid, st, env, core = loadCore()) {
  const d = DISPOSITIONS[uid];
  const out = { uid, kind: d ? d.kind : 'none', writes: [], slots: null, button: null, problems: [] };
  if (!d) { out.problems.push(`no ruling for user ${uid}`); return out; }
  if (d.kind === 'clear') return out;
  const { L, E, REG, LAY } = core;
  const base = { home: LAY.home, sidebar: LAY.sidebar };
  const session = (stored, eff) => E.session({ stored: stored || null, effective: J(eff), locked: env.locked, base, registry: REG, groups: J(eff.groups) });

  if (d.kind === 'swapHome') {
    const lay = J(st.rows.layout);
    const i = lay.placed.home.findIndex((e) => isObj(e) && e.item === 'custom');
    lay.placed.home[i] = { item: d.id };
    out.writes.push({ config_key: 'layout', config: lay });
    out.slots = { home: d.id, sidebar: null };
  } else {
    let rows = J(st.rows), id = d.id;
    if (d.kind === 'button') {
      if (Object.keys(rows).length) { out.problems.push('a new button is only planned for a user with no ui_config rows'); return out; }
      const taken = {};
      for (const x of userIds(rows)) taken[x] = true;
      id = E.makeUserId(d.label, taken);
      out.button = { id, label: d.label, icon: d.icon, action: J(d.action) };
      rows = { items: { items: [out.button] } };
      out.writes.push({ config_key: 'items', config: rows.items });
    }
    // convertLegacy: the editor's registry has the button AND the custom tab;
    // replace puts the button in custom's place; then custom leaves the registry
    const s = session(st.rows.layout, effective(core, env, rows, st.ct));
    const got = J(s.replace('custom', id));
    if (canon(got) !== canon(SURFACES)) {
      out.problems.push(`the editor put ${id} in the custom slot on [${got.join(', ')}], expected Home and the sidebar ` +
        '(custom not visible there, or the item not in this user\'s launcher)');
      return out;
    }
    const after = effective(core, env, rows, null);
    s.retarget(J(after), J(after.groups));
    out.writes.push({ config_key: 'layout', config: J(s.doc()) });
    out.slots = { home: id, sidebar: id };
  }
  for (const w of out.writes) {
    const r = shape.validate('user', w.config_key, w.config);
    if (!r.ok) out.problems.push(`the planned ${w.config_key} is refused by lib/uiConfigShape.js: ${r.errors.join('; ')}`);
    else if (canon(r.value) !== canon(w.config)) out.problems.push(`the planned ${w.config_key} does not normalize to itself`);
  }
  return out;
}

/** The state a plan leads to (rows replaced by the planned documents). */
function predicted(st, plan) {
  const rows = J(st.rows);
  for (const w of plan.writes) rows[w.config_key] = J(w.config);
  return { ...st, ct: null, ctType: 'NULL', rows };
}

const entryKey = (r) => (r.kind === 'item' ? r.id : r.kind === 'label' ? '#' + r.text : '|');
function surfaces(core, env, st) {
  const eff = effective(core, env, st.rows, st.ct);
  const lay = isObj(st.rows.layout) ? st.rows.layout : null;
  const out = { eff: J(eff) };
  for (const sf of SURFACES) out[sf] = J(core.L.resolveLayout(sf, { base: core.LAY[sf], user: lay, effective: eff, locked: env.locked })).map(entryKey);
  return out;
}

/**
 * The resolver identity check: Home and the sidebar after are the ones before,
 * except that the custom slot holds plan.slots[sf] (null: the slot is gone);
 * the All ids likewise; a new button shows the custom tab's title and icon.
 * → problems[].
 */
function renderProblems(before, after, env, plan, core = loadCore()) {
  const p = [];
  if (!plan.slots) return p;                  // nothing in the launcher changes
  const b = surfaces(core, env, before), a = surfaces(core, env, after);
  for (const sf of SURFACES) {
    const n = b[sf].filter((k) => k === 'custom').length;
    if (n !== 1) { p.push(`${sf}: the custom tab showed ${n} times before, expected once`); continue; }
    const want = b[sf].flatMap((k) => (k === 'custom' ? (plan.slots[sf] ? [plan.slots[sf]] : []) : [k]));
    if (canon(a[sf]) !== canon(want)) p.push(`${sf} after is [${a[sf].join(' ')}], expected [${want.join(' ')}]`);
  }
  const ids = (eff) => eff.map((e) => e.id).sort();
  const wantAll = b.eff.map((e) => e.id).filter((id) => id !== 'custom').concat(plan.button ? [plan.button.id] : []).sort();
  if (canon(ids(a.eff)) !== canon(wantAll)) p.push(`All after is [${ids(a.eff).join(' ')}], expected [${wantAll.join(' ')}]`);
  if (plan.button) {
    const e = a.eff.find((x) => x.id === plan.button.id);
    const ct = before.ct || {};
    if (!e) p.push(`${plan.button.id} is not in the launcher after`);
    else if (e.label !== ct.title || e.icon !== ct.icon || canon(e.userAction) !== canon(plan.button.action)) {
      p.push(`${plan.button.id} shows ${short([e.label, e.icon, e.userAction])}, expected the custom tab's ${short([ct.title, ct.icon])} and ${short(plan.button.action)}`);
    }
  }
  return p;
}

/** The AFTER test: the state is exactly what the plan from the record writes → problems[]. */
function afterProblems(uid, st, exp, env, core = loadCore()) {
  const p = [];
  if (st.ct !== null) p.push('user_custom_tab is not empty');
  else if (st.ctType !== 'NULL') p.push(`user_custom_tab is ${st.ctType}, not the JSON null scalar`);
  if (st.badRows.length) p.push(`ui_config rows with a role: ${st.badRows.join(', ')}`);
  if (p.length) return p;
  const d = DISPOSITIONS[uid];
  let before;
  if (d.kind === 'swapHome') {
    // Fred: his layout with the swap undone must be a BEFORE layout
    const rows = J(st.rows);
    const home = isObj(rows.layout) && isObj(rows.layout.placed) && Array.isArray(rows.layout.placed.home) ? rows.layout.placed.home : [];
    const i = home.findIndex((e) => isObj(e) && e.item === d.id);
    if (i < 0) return [`placed.home holds no ${d.id}`];
    home[i] = { item: 'custom' };
    const keys = Object.keys(rows).sort();
    const bp = canon(keys) !== canon(exp.rows) ? [`ui_config rows are [${keys.join(', ')}], the record says [${exp.rows.join(', ')}]`]
      : fredHomeProblems(rows, d);
    if (bp.length) return bp.map((x) => `with the swap undone, ${x}`);
    before = { ...st, ct: fillUnknown(exp.ct), rows };
  } else {
    before = { ...st, ct: fillUnknown(exp.ct), rows: {} };
  }
  const plan = planUser(uid, before, env, core);
  if (plan.problems.length) return plan.problems;
  const want = predicted(before, plan);
  const keys = Object.keys(st.rows).sort(), wkeys = Object.keys(want.rows).sort();
  if (canon(keys) !== canon(wkeys)) return [`ui_config rows are [${keys.join(', ')}], the end state has [${wkeys.join(', ')}]`];
  for (const k of keys) if (canon(st.rows[k]) !== canon(want.rows[k])) p.push(`its ${k} is not the document this script writes`);
  return p;
}

/** BEFORE | AFTER | DRIFT for one user. */
function classify(uid, st, exp, env, core = loadCore()) {
  if (!st) return { state: 'DRIFT', problems: [`user ${uid} does not exist`] };
  const bp = beforeProblems(uid, st, exp);
  if (!bp.length) return { state: 'BEFORE', problems: [] };
  if (exp.ct === null) return { state: 'DRIFT', problems: bp };   // no custom tab: nothing to be AFTER of
  const ap = afterProblems(uid, st, exp, env, core);
  if (!ap.length) return { state: 'AFTER', problems: [] };
  return { state: 'DRIFT', problems: bp, after: ap };
}

// ─────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────
/** The service's `db` on OUR connection, inside OUR transaction: its begin /
 *  commit / release are no-ops; every statement is time-limited; the first
 *  failed statement poisons the rest (a deadlock has already rolled the whole
 *  transaction back — nothing may run after it in autocommit). */
function txDb(conn) {
  let poisoned = null;
  const query = async (sql, params) => {
    if (poisoned) throw new Error(`an earlier statement of this transaction failed (${poisoned}) — nothing more runs in it`);
    try {
      return await conn.query({ sql: typeof sql === 'string' ? sql : sql.sql, timeout: QUERY_TIMEOUT_MS }, params);
    } catch (err) {
      poisoned = err.code || err.message;
      throw err;
    }
  };
  const c = { query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}, destroy() {} };
  return { query, getConnection: async () => c };
}

async function applyUser(conn, uid, exp, printed, say, hooks) {
  const db = txDb(conn);
  await conn.query({ sql: 'START TRANSACTION', timeout: QUERY_TIMEOUT_MS });
  let committed = false;
  try {
    const st = await readUser(db, uid, true);
    const env = await readEnv(db, uid, st ? st.roles : []);
    const c = classify(uid, st, exp, env);
    if (c.state === 'AFTER') {
      await conn.query({ sql: 'ROLLBACK', timeout: QUERY_TIMEOUT_MS });
      say(`  = user ${uid}: already done (another run got there first)`);
      return 'skipped';
    }
    if (c.state !== 'BEFORE') throw new Error(`user ${uid} changed since the check: ${c.problems.join('; ')}`);
    const plan = planUser(uid, st, env);
    if (plan.problems.length) throw new Error(`user ${uid}: ${plan.problems.join('; ')}`);
    if (canon(plan.writes) !== canon(printed.writes)) throw new Error(`user ${uid}: the plan under lock differs from the one printed above — re-run`);
    for (const w of plan.writes) {
      const r = await uiConfigService.write(db, { scope: 'user', config_key: w.config_key, config: w.config }, { type: 'jwt', userId: uid });
      if (!r.changed || canon(r.config) !== canon(w.config)) throw new Error(`user ${uid}: the ${w.config_key} write did not store the planned document`);
    }
    // the JSON null scalar, never SQL NULL (json NOT NULL; manager's correction)
    const [res] = await db.query("/* s5e:clear */ UPDATE users SET user_custom_tab = 'null' WHERE `user` = ?", [uid]);
    if (res.affectedRows !== 1) throw new Error(`user ${uid}: clearing user_custom_tab touched ${res.affectedRows} rows`);
    if (hooks.beforeCommit) await hooks.beforeCommit(uid);
    const inTx = await readUser(db, uid);
    const vp = verifyUser(uid, st, inTx, exp, env, plan);
    if (vp.length) throw new Error(`user ${uid} is not in the end state before commit: ${vp.join('; ')}`);
    await conn.query({ sql: 'COMMIT', timeout: QUERY_TIMEOUT_MS });
    committed = true;
  } catch (err) {
    if (!committed) await conn.query({ sql: 'ROLLBACK', timeout: QUERY_TIMEOUT_MS }).catch(() => {});
    err.committed = committed;
    throw err;
  }
  return 'done';
}

function verifyUser(uid, before, now, exp, env, plan) {
  const p = [];
  if (!now) return [`user ${uid} is gone`];
  if (!(now.ct === null && now.ctType === 'NULL')) p.push(`user_custom_tab is not the JSON null scalar (${now.ctType})`);
  const c = classify(uid, now, exp, env);
  if (c.state !== 'AFTER') p.push(`not the end state (${c.state}: ${c.problems.concat(c.after || []).join('; ')})`);
  p.push(...renderProblems(before, now, env, plan));
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────
function describeSurfaces(core, env, st) {
  const s = surfaces(core, env, st);
  return { home: s.home.join(' '), sidebar: s.sidebar.join(' ') };
}

/**
 * run(conn, { apply, log, recordFile, hooks }) → { ok, line, states, done }.
 * conn: one mysql2 promise connection. hooks (tests only): beforeCommit(uid),
 * afterCommit(uid) — a throw there is a crash at that point.
 */
async function run(conn, { apply = false, log = console.log, recordFile = RECORD_FILE, hooks = {} } = {}) {
  const say = (s) => log(s);
  const core = loadCore();
  core.warnings.length = 0;
  const record = loadRecord(recordFile);
  const problems = [], notes = [];

  const [[who]] = await conn.query({ sql: '/* s5e:who */ SELECT CURRENT_USER() AS cu, @@SESSION.sql_mode AS sm, DATABASE() AS db, VERSION() AS v', timeout: QUERY_TIMEOUT_MS });
  say(`S5e-1 — legacy custom tabs into the launcher (${apply ? 'APPLY' : 'CHECK, read-only'})`);
  say(`  ${who.db} on ${who.v} as ${who.cu}; sql_mode "${who.sm}"`);
  await conn.query({ sql: 'SET SESSION lock_wait_timeout = 5', timeout: QUERY_TIMEOUT_MS });
  await conn.query({ sql: 'SET SESSION innodb_lock_wait_timeout = 10', timeout: QUERY_TIMEOUT_MS });

  const all = await readAll(conn);
  say('\nPRIOR VALUES (users.user_custom_tab, exactly as stored now):');
  for (const [uid, st] of all.states) say(`  ${String(uid).padStart(3)}  ${st.ct === null ? 'null' : JSON.stringify(st.ct)}`);

  // every user: in the record, or no custom tab and untouched
  for (const [uid, st] of all.states) {
    if (!record.has(uid) && st.ct !== null) problems.push(`user ${uid} (${st.name}) has a custom tab the record does not know: ${JSON.stringify(st.ct)}`);
  }
  const classes = new Map(), plans = new Map();
  for (const [uid, exp] of record) {
    const st = all.states.get(uid);
    const env = all.envs.get(uid) || null;
    const c = DISPOSITIONS[uid] ? classify(uid, st, exp, env, core)
      : { state: st && !beforeProblems(uid, st, exp).length ? 'BEFORE' : 'DRIFT', problems: st ? beforeProblems(uid, st, exp) : [`user ${uid} does not exist`] };
    classes.set(uid, c);
    if (c.state === 'DRIFT') {
      problems.push(`user ${uid}${st ? ` (${st.name})` : ''} is neither as recorded nor in the end state: ${c.problems.join('; ')}` +
        (c.after && c.after.length ? ` [not the end state either: ${c.after.join('; ')}]` : ''));
    }
  }

  say('\nUSERS:');
  for (const [uid, exp] of record) {
    const st = all.states.get(uid), c = classes.get(uid), d = DISPOSITIONS[uid];
    const name = st ? `${st.name} [${st.roles.join(',')}]` : '?';
    if (!d) { say(`  user ${uid} ${name}: no custom tab — untouched (${c.state === 'BEFORE' ? 'as recorded' : 'DRIFT'})`); continue; }
    if (c.state === 'AFTER') { say(`  user ${uid} ${name}: ALREADY DONE — skipped`); continue; }
    if (c.state !== 'BEFORE') { say(`  user ${uid} ${name}: DRIFT — see PROBLEMS`); continue; }
    const env = all.envs.get(uid);
    const plan = planUser(uid, st, env, core);
    plans.set(uid, plan);
    for (const x of plan.problems) problems.push(`user ${uid}: ${x}`);
    say(`  user ${uid} ${name}: ${exp.ct && exp.ct.title ? `"${exp.ct.title}" ${exp.ct.src}` : ''}`);
    for (const w of plan.writes) {
      if (st.rows[w.config_key] !== undefined) say(`      ${w.config_key} was ${JSON.stringify(st.rows[w.config_key])}`);
      say(`      ${w.config_key} := ${JSON.stringify(w.config)}`);
    }
    say("      users.user_custom_tab := 'null' (the JSON null scalar)");
    if (plan.problems.length) continue;
    const after = predicted(st, plan);
    const rp = renderProblems(st, after, env, plan, core);
    for (const x of rp) problems.push(`user ${uid}: predicted launcher: ${x}`);
    if (plan.slots) {
      const b = describeSurfaces(core, env, st), a = describeSurfaces(core, env, after);
      say(`      Home before:    ${b.home}`);
      say(`      Home after:     ${a.home}`);
      say(`      sidebar before: ${b.sidebar}`);
      say(`      sidebar after:  ${a.sidebar}`);
      say(`      the custom slot → Home ${plan.slots.home || '(gone)'}, sidebar ${plan.slots.sidebar || '(gone)'}${rp.length ? '' : ' — identical otherwise (verified)'}`);
    }
    if (!Object.keys(st.rows).length && plan.writes.some((w) => w.config_key === 'layout')) {
      notes.push(`user ${uid} (${st.name}) had no stored layout: from now on a "customized" user — firm defaults only ADD items for them (S6c ruling 4)`);
    }
    const sc = st.rows.shortcuts;
    if (isObj(sc) && Array.isArray(sc.bindings) && sc.bindings.some((b) => isObj(b) && b.id === 'custom')) {
      notes.push(`user ${uid} (${st.name}) has a keyboard shortcut bound to custom: it stops doing anything (left as it is — the ruling changes nothing else)`);
    }
    const items = st.rows.items;
    if (isObj(items) && Array.isArray(items.items) && items.items.some((it) => isObj(it) && isObj(it.action) && it.action.type === 'drawer' && (it.action.items || []).includes('custom'))) {
      notes.push(`user ${uid} (${st.name}) has a drawer holding custom: it drops out of the drawer (left as it is)`);
    }
  }
  for (const w of new Set(core.warnings)) notes.push(`client warning: ${w}`);

  if (notes.length) { say('\nNOTES:'); for (const x of notes) say(`  - ${x}`); }
  if (problems.length) {
    say('\nPROBLEMS:');
    for (const x of problems) say(`  - ${x}`);
    const line = `NO-GO — ${problems.length} problem(s) above. Nothing was changed.`;
    say(`\n${line}`);
    return { ok: false, line, problems };
  }
  const todo = [...plans.keys()];
  if (!todo.length) {
    const line = 'ALREADY APPLIED — every custom tab is in the launcher and cleared. GO: nothing to run.';
    say(`\n${line}`);
    return { ok: true, line, done: [] };
  }
  if (!apply) {
    const line = `CHECK OK — GO. ${todo.length} user(s) to convert (${todo.join(', ')}). Next: ${SELF} --apply`;
    say(`\n${line}`);
    return { ok: true, line, todo };
  }

  // ── apply: one transaction per user ──
  say('');
  const done = [];
  for (const uid of todo) {
    try {
      const r = await applyUser(conn, uid, record.get(uid), plans.get(uid), say, hooks);
      if (r === 'done') {
        // re-read outside the transaction: what was committed
        const now = await readUser(conn, uid);
        const vp = verifyUser(uid, all.states.get(uid), now, record.get(uid), all.envs.get(uid), plans.get(uid));
        if (vp.length) {
          const e = new Error(`user ${uid} committed, but the committed state is wrong: ${vp.join('; ')}`);
          e.committed = true;
          throw e;
        }
        done.push(uid);
        say(`  ✓ user ${uid}: written, committed, verified (rows re-read; Home + sidebar resolved by the client: identical but the custom slot)`);
      }
      if (hooks.afterCommit) await hooks.afterCommit(uid);
    } catch (err) {
      say(`\n  ✗ ${err.message}`);
      const line = `NO-GO — stopped at user ${uid}${err.committed ? ' (its change IS committed — read the line above)' : ' (rolled back)'}; ` +
        `done this run: ${done.length ? done.join(', ') : 'none'}. Re-running ${SELF} --apply resumes.`;
      say(`\n${line}`);
      return { ok: false, line, done };
    }
  }

  // ── the end state, everyone ──
  const end = await readAll(conn);
  const bad = [];
  for (const [uid, exp] of record) {
    const st = end.states.get(uid);
    if (!DISPOSITIONS[uid]) {
      if (!st || beforeProblems(uid, st, exp).length) bad.push(`user ${uid} changed`);
      continue;
    }
    const c = classify(uid, st, exp, end.envs.get(uid), core);
    if (c.state !== 'AFTER') bad.push(`user ${uid} is ${c.state}: ${c.problems.join('; ')}`);
  }
  for (const [uid, st] of end.states) if (st.ct !== null) bad.push(`user ${uid} still has a custom tab`);
  if (bad.length) {
    const line = `NO-GO — the end state is wrong: ${bad.join(' | ')}`;
    say(`\n${line}`);
    return { ok: false, line, done };
  }
  const line = `S5e-1 APPLIED — GO. Converted this run: ${done.join(', ')}; no user has a custom tab. Nothing else to run.`;
  say(`\n${line}`);
  return { ok: true, line, done };
}

module.exports = {
  run, loadRecord, loadCore, planUser, classify, beforeProblems, afterProblems, renderProblems, predicted,
  readUser, readAll, compareExpected, txDb, DISPOSITIONS, RECORD_FILE,
};

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  (async () => {
    let conn;
    try {
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      conn = mysql.createConnection({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
      }).promise();
      const r = await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
