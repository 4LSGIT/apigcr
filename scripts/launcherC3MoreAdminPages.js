#!/usr/bin/env node
// scripts/launcherC3MoreAdminPages.js
//
/**
 * launcher-nits C3 — More Features and Admin become the firm's own pages.
 *
 * Fred's ruling (2026-10-28, "literal, C1 first"): the static hubs #tabMore and
 * #tabAdmin retire; More and Admin become ordinary firm pages, `firm:more` and
 * `firm:admin`, which the firm arranges like any page and each person can
 * rearrange for themselves (L4b1). C1 made exec independent of hub tiles, C2
 * made Settings, the Admin row, old links and Casey's P13 independent of the
 * hubs. This is the DATA step; C4 then removes the hubs from the code.
 *
 * It runs while the CURRENT code is live, and leaves that code showing More
 * and Admin as firm pages in the sidebar and on Home (nothing missing in the
 * window before C4 deploys). One transaction writes, through
 * services/uiConfigService.write (validation, versions, retired ids):
 *
 *   firm registry_overrides
 *     + items  firm:more  "More Features" (or the firm's rename of
 *                         moreFeatures), icon of moreFeatures, { type:'page' }
 *              firm:admin "Admin" (or the rename), icon of admin, { type:'page' }
 *     + hidden / locked / renames / visible_to entries of moreFeatures and
 *       admin copied onto the new ids — so "who sees Admin" carries over:
 *       visible_to['firm:admin'] = visible_to.admin. (The old keys stay until
 *       C4's tidy stage.)
 *   firm layout
 *     + pages['firm:more']  = More as it shows today: the shipped More grid
 *                             under the firm's layout (resolveLayout('more')),
 *                             and its icon row ('moreIcons')
 *       pages['firm:admin'] = Admin likewise ('admin', 'adminIcons')
 *       — written only when absent (a page the firm already edited is kept);
 *     ~ placed.home / placed.sidebar / placed.homeIcons: the full resolved list
 *       with moreFeatures → firm:more and admin → firm:admin in place, and
 *       removed.<surface> += the old ids the shipped layout puts there, so the
 *       current code doesn't put the hub rows back beside the pages.
 *       (placed/removed.more|admin… stay until C4's tidy stage.)
 *   every user row (scope user: layout, shortcuts, items)
 *     ~ moreFeatures → firm:more and admin → firm:admin wherever an id is
 *       named: placed / removed lists, their own pages' tiles and icons,
 *       overlays, shortcut bindings, list (drawer) contents.
 *
 * USAGE (from the repo root):
 *   node scripts/launcherC3MoreAdminPages.js                          # CHECK — read-only
 *   node scripts/launcherC3MoreAdminPages.js --apply --expect=<digest> # write
 *   … --local-url=mysql://root@127.0.0.1:3395/<name>_test             # a local copy instead of .env
 * Each run ends with ONE line: GO or NO-GO, naming the next command.
 *
 * SAFETY (Fred, 2026-10-28: "you can run it if it backs up the previous values
 * first to scratch"):
 *   - CHECK prints a DIGEST of every ui_config row; --apply needs it
 *     (--expect) and refuses when the live rows differ — nothing changes
 *     between what was checked and what is written.
 *   - BEFORE any write, every row it will change goes to scratch
 *     (rw_scratch ns 'fred', k 'launcher_c3_backup_<digest>', the scratch
 *     API's own upsert) and to local/launcher-c3-backup-<digest>.json; the
 *     scratch copy is read back and compared. A backup that doesn't read back
 *     identical is a NO-GO with nothing written.
 *   - Then ONE transaction: the rows re-read FOR UPDATE, the digest checked
 *     again (a change since the backup → rollback, NO-GO), every document
 *     written through uiConfigService.write on this connection, commit.
 *   - Verified with the client's own code (public/index.html's ycLauncher in
 *     a vm, as scripts/uiCustomS5eCustomTabsToButtons.js does), for EVERY
 *     user, before writing (the plan) and after commit (the stored rows):
 *     their Home, sidebar and Home small buttons are the same list with the
 *     old ids replaced; More's and Admin's pages hold exactly the tiles the
 *     hubs showed them; firm:more / firm:admin are theirs exactly when
 *     moreFeatures / admin were; their shortcuts point at the same things.
 *   - Re-running is a no-op GO (nothing left to change). A failed run before
 *     commit changes nothing but the backup.
 *   - Undo: the backup holds every overwritten document; the firm's also sit
 *     in ui_config_versions (History → Restore).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const shape = require('../lib/uiConfigShape');
const svc = require('../services/uiConfigService');
const { deniedFor } = require('../services/entitlementService');

const ROOT = path.join(__dirname, '..');
const SELF = 'node scripts/launcherC3MoreAdminPages.js';
const QUERY_TIMEOUT_MS = 30_000;
const MAP = Object.freeze({ moreFeatures: 'firm:more', admin: 'firm:admin' });
const PAGES = Object.freeze({
  'firm:more': { from: 'moreFeatures', tiles: 'more', icons: 'moreIcons' },
  'firm:admin': { from: 'admin', tiles: 'admin', icons: 'adminIcons' },
});
const HOME_SURFACES = ['home', 'sidebar', 'homeIcons'];   // the firm layout surfaces the pages are placed on
const AUTHOR = 6;   // Fred (users.user 6): saved_by on the firm documents' new versions
const BACKUP_NS = 'fred';

const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => shape.canonical(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const mapId = (id) => (typeof id === 'string' && hasOwn(MAP, id) ? MAP[id] : id);

// ─────────────────────────────────────────────────────────────────────────
// The client's own code
// ─────────────────────────────────────────────────────────────────────────
/** The registry entries and DEFAULT_LAYOUTS as they were when this script ran
 *  live (main 323edb5, 2026-10-28/29): launcher-nits C4 retired moreFeatures /
 *  admin and the hubs' lists. loadCore puts them back when the client no longer
 *  has them, so the script stays runnable as the record of that run (its CHECK
 *  on the live state reads "nothing to write"), as
 *  scripts/uiCustomS5eCustomTabsToButtons.js does for the custom tab.
 *  tests/helpers/hubPages.js builds the tests' More / Admin pages from it. */
const HISTORIC = Object.freeze({"items": {"admin": {"label": "Admin", "icon": "mug-hot", "onclick": "openMainTab('tabAdmin')", "tab": "tabAdmin", "domIds": {"sidebar": "sbAdmin"}, "defaultHidden": true}, "moreFeatures": {"label": "More Features", "icon": "grip", "onclick": "openMainTab('tabMore')", "tab": "tabMore", "tabAlso": "tabSettings"}}, "layouts": {"home": [{"item": "cases"}, {"item": "contacts"}, {"item": "appts"}, {"break": true}, {"item": "bills"}, {"item": "pipeline"}, {"item": "events"}, {"break": true}, {"item": "tasks"}, {"item": "newClient"}, {"item": "log"}, {"break": true}, {"item": "calendar"}, {"item": "moreFeatures"}, {"item": "comms"}], "sidebar": [{"label": "Records"}, {"item": "cases"}, {"item": "contacts"}, {"item": "appts"}, {"item": "calendar"}, {"item": "events"}, {"item": "tasks"}, {"item": "comms"}, {"item": "log"}, {"item": "bills"}, {"label": "Actions"}, {"item": "pipeline"}, {"item": "newClient"}, {"label": "Settings"}, {"item": "admin"}, {"item": "moreFeatures"}, {"item": "helpSupport"}, {"item": "all"}], "homeIcons": [{"item": "all"}], "more": [{"item": "moreManuals"}, {"item": "moreSettings"}, {"item": "moreTheme"}, {"item": "moreFeatureRequests"}, {"break": true}, {"item": "moreSimpleForms"}, {"item": "moreFormBuilder"}, {"item": "moreFormInbox"}, {"item": "morePortalManager"}, {"break": true}, {"item": "moreSignatures"}, {"item": "moreAssetManager"}, {"item": "moreVideoManager"}, {"item": "moreDocuments"}, {"break": true}, {"item": "moreCaseConfig"}, {"item": "moreChecklists"}, {"item": "moreAutomations"}, {"item": "moreViews"}, {"break": true}, {"item": "moreAvailability"}, {"item": "moreBooking"}, {"item": "moreCourtPreview"}, {"break": true}, {"item": "moreCampaigns"}, {"item": "moreRedirects"}, {"item": "moreLandingPages"}, {"item": "moreReports"}, {"break": true}, {"item": "moreAssistant"}], "moreIcons": [{"item": "casey"}], "admin": [{"item": "adminReadonlyKeys"}, {"item": "adminApiKeys"}, {"item": "adminCtaLinks"}, {"break": true}, {"item": "adminDbConsole"}, {"item": "adminConnections"}, {"item": "adminApiTester"}, {"break": true}, {"item": "adminTools"}, {"item": "adminEtch"}, {"item": "adminScratch"}, {"item": "adminSharedValues"}, {"break": true}, {"item": "adminUsers"}, {"item": "adminSystemAlerts"}, {"item": "adminSupportInbox"}, {"break": true}, {"item": "adminMailboxes"}], "adminIcons": []}});
let CORE = null;
function loadCore() {
  if (CORE) return CORE;
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = /<script id="ycLauncher">([\s\S]*?)<\/script>/.exec(read('public/index.html'));
  if (!m) throw new Error('public/index.html: the ycLauncher block was not found');
  const ctx = vm.createContext({ URL, console: { error: (msg) => { throw new Error('[client] ' + String(msg)); }, warn() {}, log() {} } });
  ctx.window = ctx;
  vm.runInContext(read('public/js/ycIcon.js'), ctx, { filename: 'ycIcon.js' });
  vm.runInContext(read('public/js/featureRegistry.js'), ctx, { filename: 'featureRegistry.js' });
  const historic = Object.keys(MAP).some((id) => !hasOwn(ctx.window.FEATURE_REGISTRY, id));
  if (historic) {   // after C4: the retired items and lists, as they were
    for (const [id, it] of Object.entries(HISTORIC.items)) ctx.window.FEATURE_REGISTRY[id] = J(it);
    ctx.window.DEFAULT_LAYOUTS = J(HISTORIC.layouts);
  }
  vm.runInContext(m[1], ctx, { filename: 'index.html#ycLauncher' });
  const L = ctx.window.ycLauncher;
  for (const n of ['computeEffective', 'resolveLayout']) if (!L || typeof L[n] !== 'function') throw new Error('the client core has no ycLauncher.' + n);
  const REG = ctx.window.FEATURE_REGISTRY;
  CORE = { L, REG, LAY: J(ctx.window.DEFAULT_LAYOUTS), historic };
  return CORE;
}

// ─────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────
const parseJson = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return v; } };
const q = (db, sql, params) => db.query({ sql, timeout: QUERY_TIMEOUT_MS }, params);

async function readRows(db, lock = false) {
  const [rows] = await q(db, 'SELECT id, scope, user_id, role, config_key, config, updated_at FROM ui_config ORDER BY id' + (lock ? ' FOR UPDATE' : ''));
  return rows.map((r) => ({ id: Number(r.id), scope: String(r.scope), user_id: Number(r.user_id), role: String(r.role || ''), config_key: String(r.config_key),
    config: parseJson(r.config), updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at) }));
}
/** The digest CHECK prints and --apply must match: every row's scope / user / key / document. */
function digestOf(rows) {
  const flat = rows.map((r) => [r.id, r.scope, r.user_id, r.role, r.config_key, canon(r.config)]);
  return crypto.createHash('sha256').update(JSON.stringify(flat)).digest('hex').slice(0, 16);
}
async function readUsers(db) {
  const [rows] = await q(db, 'SELECT `user`, roles FROM users ORDER BY `user`');
  const out = [];
  for (const r of rows) {
    const roles = String(r.roles || '').split(',').map((s) => s.trim()).filter(Boolean);
    out.push({ uid: Number(r.user), roles, denied: await deniedFor(db, Number(r.user)) });
  }
  return out;
}
const rowOf = (rows, scope, uid, key) => rows.find((r) => r.scope === scope && r.user_id === uid && r.role === '' && r.config_key === key) || null;

// ─────────────────────────────────────────────────────────────────────────
// The plan (pure)
// ─────────────────────────────────────────────────────────────────────────
// The grammar each hub list follows: a grid's (breaks) or an icon row's — the names a page's
// tiles and small buttons borrow, which the client keeps after C4 (it drops 'admin' / 'adminIcons').
const GRAMMAR = Object.freeze({ more: 'more', admin: 'more', moreIcons: 'moreIcons', adminIcons: 'moreIcons' });
/** resolveLayout of a hub list (base: the shipped list) under a firm document, with the grammar
 *  its page borrows: the firm's own lists for it are moved under the grammar's name for the call. */
function resolveHub(L, LAY, sf, firmDoc, user, effective, locked) {
  const g = GRAMMAR[sf] || sf;
  let firm = firmDoc;
  if (g !== sf) {
    firm = { placed: {}, removed: {} };
    if (isObj(firmDoc) && isObj(firmDoc.placed) && hasOwn(firmDoc.placed, sf)) firm.placed[g] = firmDoc.placed[sf];
    if (isObj(firmDoc) && isObj(firmDoc.removed) && hasOwn(firmDoc.removed, sf)) firm.removed[g] = firmDoc.removed[sf];
  }
  return L.resolveLayout(g, { base: LAY[sf] || [], firm, user, effective, locked });
}
const entriesOf = (rows) => rows.map((r) => (r.kind === 'item' ? { item: r.id } : r.kind === 'break' ? { break: true } : { label: r.text }));
/** Map the ids of a placed list; an id twice keeps its first place. */
function mapEntries(list) {
  const seen = new Set(), out = [];
  for (const e of list || []) {
    if (isObj(e) && typeof e.item === 'string') {
      const id = mapId(e.item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ item: id });
    } else out.push(J(e));
  }
  return out;
}
const mapIds = (list) => [...new Set((list || []).map(mapId))];
/** More's FIRM ROW: while the firm has no placed.more, the shell draws its own items (not pages)
 *  after More's grid — a break, then each (renderFirmRow; the firm editor's seed). */
function firmRow(ro, lay, sf) {
  if (sf !== 'more' || (isObj(lay) && isObj(lay.placed) && Array.isArray(lay.placed.more))) return [];
  const ids = (Array.isArray(ro.items) ? ro.items : []).filter((it) => it && typeof it.id === 'string' && !hasOwn(PAGES, it.id)
    && !(isObj(it.action) && it.action.type === 'page')).map((it) => it.id);
  return ids.length ? [{ kind: 'break' }].concat(ids.map((id) => ({ kind: 'item', id }))) : [];
}

function planFirm(core, rows) {
  const { L, REG, LAY } = core;
  const roRow = rowOf(rows, 'firm', 0, 'registry_overrides'), layRow = rowOf(rows, 'firm', 0, 'layout');
  const ro = isObj(roRow && roRow.config) ? J(roRow.config) : { hidden: [], locked: [], renames: {}, items: [] };
  const lay = isObj(layRow && layRow.config) ? J(layRow.config) : { placed: {}, removed: {} };
  const ro2 = J(ro);
  ro2.items = Array.isArray(ro2.items) ? ro2.items : [];
  ro2.renames = isObj(ro2.renames) ? ro2.renames : {};
  for (const [pid, p] of Object.entries(PAGES)) {
    if (!ro2.items.some((it) => it && it.id === pid)) {
      const label = isObj(ro2.renames[p.from]) && typeof ro2.renames[p.from].label === 'string' ? ro2.renames[p.from].label : REG[p.from].label;
      ro2.items.push({ id: pid, label, icon: REG[p.from].icon, action: { type: 'page' } });
    }
  }
  for (const k of ['hidden', 'locked']) {
    if (!Array.isArray(ro2[k])) continue;
    for (const [from, to] of Object.entries(MAP)) if (ro2[k].includes(from) && !ro2[k].includes(to)) ro2[k].push(to);
  }
  if (isObj(ro2.visible_to)) {
    for (const [from, to] of Object.entries(MAP)) if (hasOwn(ro2.visible_to, from) && !hasOwn(ro2.visible_to, to)) ro2.visible_to[to] = J(ro2.visible_to[from]);
  }
  delete ro2.retired;   // server-managed: uiConfigService.write re-derives it

  // what the firm's documents resolve to, everything visible (the pages hold every tile; each person
  // sees only what they may open, as on the hubs)
  const everything = Object.keys(REG).filter((id) => !REG[id].placeholder).map((id) => ({ id }))
    .concat(ro2.items.filter((it) => it && typeof it.id === 'string').map((it) => ({ id: it.id })));
  const resolveFirm = (sf) => (hasOwn(GRAMMAR, sf) ? resolveHub(L, LAY, sf, lay, null, everything, [])
    : L.resolveLayout(sf, { base: LAY[sf] || [], firm: lay, user: null, effective: everything, locked: [] }));
  const lay2 = J(lay);
  lay2.placed = isObj(lay2.placed) ? lay2.placed : {};
  lay2.removed = isObj(lay2.removed) ? lay2.removed : {};
  lay2.pages = isObj(lay2.pages) ? lay2.pages : {};
  for (const [pid, p] of Object.entries(PAGES)) {
    if (hasOwn(lay2.pages, pid)) continue;   // the firm already has this page: keep it
    lay2.pages[pid] = { tiles: entriesOf(resolveFirm(p.tiles).concat(firmRow(ro, lay, p.tiles))), icons: entriesOf(resolveFirm(p.icons)) };
  }
  for (const sf of HOME_SURFACES) {
    const base = (LAY[sf] || []).filter((e) => e && typeof e.item === 'string').map((e) => e.item);
    const olds = Object.keys(MAP).filter((id) => base.includes(id));
    const placedOld = isObj(lay.placed) && Array.isArray(lay.placed[sf]) && lay.placed[sf].some((e) => e && hasOwn(MAP, e.item));
    if (!olds.length && !placedOld) continue;   // nothing of the hubs on this surface
    lay2.placed[sf] = mapEntries(entriesOf(resolveFirm(sf)));
    lay2.removed[sf] = [...new Set([...(Array.isArray(lay2.removed[sf]) ? lay2.removed[sf] : []), ...olds])];
  }
  return { registry_overrides: { before: roRow ? roRow.config : null, after: ro2 }, layout: { before: layRow ? layRow.config : null, after: lay2 } };
}

function planUserDoc(key, doc) {
  const d = J(doc);
  if (!isObj(d)) return d;
  if (key === 'layout') {
    for (const half of ['placed', 'removed']) {
      if (!isObj(d[half])) continue;
      for (const sf of Object.keys(d[half])) d[half][sf] = half === 'placed' ? mapEntries(d[half][sf]) : mapIds(d[half][sf]);
    }
    if (isObj(d.pages)) for (const p of Object.values(d.pages)) for (const part of ['tiles', 'icons']) if (Array.isArray(p[part])) p[part] = mapEntries(p[part]);
    if (isObj(d.overlays)) {
      for (const o of Object.values(d.overlays)) {
        if (isObj(o.placed)) for (const part of Object.keys(o.placed)) o.placed[part] = mapEntries(o.placed[part]);
        if (isObj(o.removed)) for (const part of Object.keys(o.removed)) o.removed[part] = mapIds(o.removed[part]);
      }
    }
  } else if (key === 'shortcuts') {
    if (Array.isArray(d.bindings)) d.bindings = d.bindings.map((b) => (isObj(b) ? { ...b, id: mapId(b.id) } : b));
  } else if (key === 'items') {
    if (Array.isArray(d.items)) for (const it of d.items) if (isObj(it) && isObj(it.action) && Array.isArray(it.action.items)) it.action.items = mapIds(it.action.items);
    delete d.retired;   // server-managed
  }
  return d;
}

/** Every document to write: [{ row, scope, uid, key, after }] — only those that change. */
function plan(core, rows) {
  const writes = [];
  const firm = planFirm(core, rows);
  for (const key of ['registry_overrides', 'layout']) {
    const row = rowOf(rows, 'firm', 0, key);
    const stored = row ? row.config : null;
    const cmp = J(stored);
    if (isObj(cmp)) delete cmp.retired;
    if (canon(cmp) !== canon(firm[key].after)) writes.push({ row, scope: 'firm', uid: 0, key, after: firm[key].after });
  }
  for (const row of rows) {
    if (row.scope !== 'user' || row.role !== '' || !['layout', 'shortcuts', 'items'].includes(row.config_key)) continue;
    const after = planUserDoc(row.config_key, row.config);
    const cmp = J(row.config);
    if (isObj(cmp) && row.config_key === 'items') delete cmp.retired;
    if (canon(cmp) !== canon(after)) writes.push({ row, scope: 'user', uid: row.user_id, key: row.config_key, after });
  }
  return writes;
}

/** Validation: each planned document normalizes to itself under lib/uiConfigShape. */
function validationProblems(writes) {
  const out = [];
  for (const w of writes) {
    const r = shape.validate(w.scope, w.key, w.after);
    if (!r.ok) { out.push(`${w.scope} ${w.uid} ${w.key}: ${r.errors.slice(0, 3).join(' · ')}`); continue; }
    const v = J(r.value);
    if (isObj(v)) delete v.retired;
    // after C4 the validator drops the hubs' old surfaces from a firm layout (stored as dropped)
    const want = J(w.after);
    if (w.scope === 'firm' && w.key === 'layout' && Array.isArray(shape.RETIRED_FIRM_SURFACES)) {
      for (const half of ['placed', 'removed']) if (isObj(want[half])) for (const sf of shape.RETIRED_FIRM_SURFACES) delete want[half][sf];
    }
    if (canon(v) !== canon(want)) out.push(`${w.scope} ${w.uid} ${w.key}: does not normalize to itself`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Verification (pure): every user, before vs after
// ─────────────────────────────────────────────────────────────────────────
function applyPlan(rows, writes) {
  const out = J(rows);
  for (const w of writes) {
    const r = out.find((x) => x.scope === w.scope && x.user_id === w.uid && x.role === '' && x.config_key === w.key);
    if (r) r.config = J(w.after);
    else out.push({ id: -1, scope: w.scope, user_id: w.uid, role: '', config_key: w.key, config: J(w.after) });
  }
  return out;
}
function uiFor(rows, uid) {
  const get = (scope, u, key) => { const r = rowOf(rows, scope, u, key); return r && isObj(r.config) ? r.config : undefined; };
  const firm = {}, user = {};
  for (const k of ['registry_overrides', 'layout']) { const v = get('firm', 0, k); if (v) firm[k] = v; }
  for (const k of ['layout', 'shortcuts', 'items']) { const v = get('user', uid, k); if (v) user[k] = v; }
  return { firm, user };
}
function viewOf(core, rows, u) {
  const { L, LAY } = core;
  const ui = uiFor(rows, u.uid);
  const eff = L.computeEffective({ isAdmin: u.roles.includes('su'), roles: u.roles, denied: u.denied, ui });
  const effIds = new Set(eff.map((e) => e.id));
  const ro = ui.firm.registry_overrides || {};
  const locked = Array.isArray(ro.locked) ? ro.locked : [];
  const surf = {};
  for (const sf of HOME_SURFACES) {
    surf[sf] = L.resolveLayout(sf, { base: LAY[sf] || [], firm: ui.firm.layout || null, user: ui.user.layout || null, effective: eff, locked })
      .map((r) => (r.kind === 'item' ? r.id : r.kind === 'label' ? '#' + r.text : '|'));
  }
  const hub = {};
  for (const [pid, p] of Object.entries(PAGES)) {
    for (const part of ['tiles', 'icons']) {
      hub[pid + ':' + part] = resolveHub(L, LAY, p[part], ui.firm.layout || null, null, eff, [])
        .concat(firmRow(ro, ui.firm.layout, p[part]))
        .filter((r) => r.kind === 'item' && effIds.has(r.id)).map((r) => r.id);
    }
  }
  const pages = {}, hasPage = {};
  const fl = ui.firm.layout && isObj(ui.firm.layout.pages) ? ui.firm.layout.pages : {};
  for (const pid of Object.keys(PAGES)) {
    hasPage[pid] = isObj(fl[pid]);
    for (const part of ['tiles', 'icons']) {
      const list = isObj(fl[pid]) && Array.isArray(fl[pid][part]) ? fl[pid][part] : [];
      pages[pid + ':' + part] = list.filter((e) => e && typeof e.item === 'string' && effIds.has(e.item)).map((e) => e.item);
    }
  }
  const shortcuts = ui.user.shortcuts && Array.isArray(ui.user.shortcuts.bindings) ? ui.user.shortcuts.bindings.map((b) => b.id) : [];
  return { effIds, surf, hub, pages, hasPage, shortcuts };
}
/** → problems: a user whose launcher would change beyond the id swap. */
function verify(core, before, after, users) {
  const out = [];
  for (const u of users) {
    const b = viewOf(core, before, u), a = viewOf(core, after, u);
    const who = `user ${u.uid}`;
    for (const sf of HOME_SURFACES) {
      const want = b.surf[sf].map(mapId);
      if (JSON.stringify(a.surf[sf]) !== JSON.stringify(want)) out.push(`${who} ${sf}: ${JSON.stringify(a.surf[sf])} ≠ ${JSON.stringify(want)}`);
    }
    for (const [pid, p] of Object.entries(PAGES)) {
      if (a.effIds.has(pid) !== b.effIds.has(p.from)) out.push(`${who}: ${pid} is ${a.effIds.has(pid) ? '' : 'not '}theirs, ${p.from} was ${b.effIds.has(p.from) ? '' : 'not '}`);
      if (!a.effIds.has(pid)) continue;
      // a page the firm already had is kept (planFirm), so it must read as it was — after C4 its
      // hub's lists are gone from the stored layout, and the hub is no longer what it showed
      for (const part of ['tiles', 'icons']) {
        const k = pid + ':' + part, want = b.hasPage[pid] ? b.pages[k] : b.hub[k];
        if (JSON.stringify(a.pages[k]) !== JSON.stringify(want)) out.push(`${who} ${k}: ${JSON.stringify(a.pages[k])} ≠ ${b.hasPage[pid] ? 'as it was' : "the hub's"} ${JSON.stringify(want)}`);
      }
    }
    const sc = b.shortcuts.map(mapId);
    if (JSON.stringify(a.shortcuts) !== JSON.stringify(sc)) out.push(`${who} shortcuts: ${JSON.stringify(a.shortcuts)} ≠ ${JSON.stringify(sc)}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────
/** The service's `db` on OUR connection, inside OUR transaction (scripts/uiCustomS5eCustomTabsToButtons.js). */
function txDb(conn) {
  let poisoned = null;
  const query = async (sql, params) => {
    if (poisoned) throw new Error(`an earlier statement of this transaction failed (${poisoned}) — nothing more runs in it`);
    try { return await conn.query({ sql: typeof sql === 'string' ? sql : sql.sql, timeout: QUERY_TIMEOUT_MS }, params); } catch (err) { poisoned = err.code || err.message; throw err; }
  };
  const c = { query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}, destroy() {} };
  return { query, getConnection: async () => c };
}

async function backup(conn, digest, rows, writes, { localDir, log }) {
  const k = 'launcher_c3_backup_' + digest;
  const payload = { taken_at: new Date().toISOString(), digest, note: 'launcher-nits C3: every ui_config row --apply overwrites, as it was',
    rows: writes.filter((w) => w.row).map((w) => J(w.row)), created: writes.filter((w) => !w.row).map((w) => ({ scope: w.scope, user_id: w.uid, config_key: w.key })) };
  const v = JSON.stringify(payload);
  if (localDir) fs.writeFileSync(path.join(localDir, `launcher-c3-backup-${digest}.json`), v + '\n');
  await q(conn, 'INSERT INTO rw_scratch (ns, k, v, meta) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), meta = VALUES(meta)',
    [BACKUP_NS, k, v, JSON.stringify({ by: 'scripts/launcherC3MoreAdminPages.js' })]);
  const [back] = await q(conn, 'SELECT v FROM rw_scratch WHERE ns = ? AND k = ?', [BACKUP_NS, k]);
  if (back.length !== 1 || back[0].v !== v) throw new Error(`the backup did not read back identical (scratch ${BACKUP_NS}/${k}) — nothing was written`);
  log(`✓ backup: scratch ${BACKUP_NS}/${k} (${v.length} chars, read back identical)` + (localDir ? ` and local/launcher-c3-backup-${digest}.json` : ''));
  return k;
}

async function run(conn, { apply = false, expect = null, log = console.log, localDir = null } = {}) {
  const core = loadCore();
  const rows = await readRows(conn);
  const users = await readUsers(conn);
  const digest = digestOf(rows);
  const writes = plan(core, rows);
  log(`ui_config: ${rows.length} rows, digest ${digest}. ${users.length} users.`);
  if (!writes.length) {
    const left = verify(core, rows, rows, users);   // already done: still consistent?
    const line = left.length ? `NO-GO — nothing to write, but: ${left.join(' | ')}` : 'GO — nothing to write: More and Admin are already the firm\'s pages. Next: land C4.';
    log(line);
    return { ok: !left.length, line, digest, writes: [] };
  }
  for (const w of writes) log(`  plan: ${w.scope} ${w.uid} ${w.key}${w.row ? '' : ' (new row)'}`);
  const problems = validationProblems(writes).concat(verify(core, rows, applyPlan(rows, writes), users));
  if (problems.length) {
    problems.forEach((p) => log('  ✗ ' + p));
    const line = `NO-GO — ${problems.length} problem(s) above. Nothing was changed.`;
    log(line);
    return { ok: false, line, digest, writes };
  }
  log(`✓ every user's Home, sidebar, small buttons, pages and shortcuts verified (the plan, with the client's own code)`);
  if (!apply) {
    const line = `GO — CHECK passed. Next: ${SELF} --apply --expect=${digest}`;
    log(line);
    return { ok: true, line, digest, writes };
  }
  if (expect !== digest) {
    const line = `NO-GO — --expect=${expect || '(missing)'} but the live digest is ${digest}: run CHECK again. Nothing was changed.`;
    log(line);
    return { ok: false, line, digest, writes };
  }
  const key = await backup(conn, digest, rows, writes, { localDir, log });
  const db = txDb(conn);
  await q(conn, 'START TRANSACTION');
  try {
    const locked = await readRows(db, true);
    if (digestOf(locked) !== digest) throw new Error('the rows changed since the backup');
    const bases = await svc.firmVersionIds(db);
    for (const w of writes) {
      const body = { scope: w.scope, config_key: w.key, config: w.after };
      if (w.scope === 'firm') body.base = bases[w.key] == null ? null : bases[w.key];
      const roles = w.scope === 'firm' ? ['su'] : (users.find((u) => u.uid === w.uid) || { roles: [] }).roles;
      await svc.write(db, body, { type: 'jwt', userId: w.scope === 'firm' ? AUTHOR : w.uid, roles });
    }
    await q(conn, 'COMMIT');
  } catch (err) {
    await q(conn, 'ROLLBACK').catch(() => {});
    const line = `NO-GO — rolled back, nothing written (the backup stays): ${err.message}`;
    log(line);
    return { ok: false, line, digest, writes };
  }
  log(`✓ committed: ${writes.length} document(s)`);
  const now = await readRows(conn);
  const left = plan(core, now);
  const bad = left.map((w) => `${w.scope} ${w.uid} ${w.key} still differs`).concat(verify(core, rows, now, users));
  const line = bad.length ? `NO-GO — committed, but the end state is wrong: ${bad.join(' | ')} (undo from scratch ${BACKUP_NS}/${key})`
    : `GO — More and Admin are the firm's pages (firm:more, firm:admin); backup at scratch ${BACKUP_NS}/${key}. Next: land C4.`;
  log(line);
  return { ok: !bad.length, line, digest, writes };
}

module.exports = { run, plan, planFirm, planUserDoc, verify, applyPlan, digestOf, validationProblems, loadCore, MAP, PAGES, HISTORIC };

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const mysql = require('mysql2');
  const arg = (name) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : null; };
  const apply = process.argv.includes('--apply');
  const localUrl = arg('local-url');
  (async () => {
    let conn;
    try {
      let opts;
      if (localUrl) {
        const u = new URL(localUrl);
        const dbName = u.pathname.replace(/^\//, '');
        if (!/_test$/.test(dbName)) throw new Error('--local-url: the database name must end in _test');
        if (u.port === '' || u.port === '3306') throw new Error('--local-url: name the port, and never 3306 (on a dev machine 127.0.0.1:3306 is production)');
        opts = { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: dbName };
      } else {
        require('dotenv').config({ path: path.join(ROOT, '.env') });
        const { ensureSqlProxy } = require('./ensure-sql-proxy');
        const proxy = await ensureSqlProxy();
        if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
        for (const k of ['host', 'user', 'password', 'database']) if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
        opts = { host: process.env.host, user: process.env.user, password: process.env.password, database: process.env.database };
      }
      conn = mysql.createConnection({ ...opts, timezone: 'Z', connectTimeout: 15_000 }).promise();
      const localDir = path.join(ROOT, 'local');
      const r = await run(conn, { apply, expect: arg('expect'), localDir: fs.existsSync(localDir) ? localDir : null });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓ committed.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
