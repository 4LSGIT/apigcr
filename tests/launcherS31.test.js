// tests/launcherS31.test.js
//
/**
 * ui-custom S3.1 — the FIRM overlay in the shell's launcher (public/index.html
 * ycLauncher block) and the tool dialog host (its ycToolDialog block).
 *
 *   1. THE MATH (computeEffective, in a bare vm over the real registry): firm
 *      hidden out (the undeniable set defies it), renames replace label AND
 *      surfaceLabels (the custom item ignores them), firm items in a "Firm"
 *      group after More and before Admin in array order, a bad item dropped
 *      with a warning, firm items hideable / deniable like any id.
 *   2. THE MECHANISM, RUN FOR REAL in jsdom (the page's own renderer, drill-in,
 *      tab and custom-tab code, cut out of index.html as tests/launcherS2.test.js
 *      does): the hide pass and the relabel pass on every surface, idempotent
 *      across applyAccess and applyCustomTab re-runs, exactly reversible; the
 *      pill strip follows a rename; icons and badges untouched.
 *   3. exec() for firm items: window → window.open(url, '_blank', 'noopener');
 *      modal → openToolDialog(url, { title }) — the real dialog block: opens,
 *      Esc / close button / backdrop close it, focus restored; exec of anything
 *      closes an open dialog first; a malformed item never navigates; an
 *      unknown firm id is refused.
 *   4. Boot wiring: loadFirmData copies `ui`; loadUserContext hands it to
 *      applyAccess.
 *
 * Mutation-checked (see the S3.1 worker report for the list and results).
 *
 * Run:  npx jest tests/launcherS31.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const DIALOG_BLOCK = RAW.match(/<script id="ycToolDialogJs">[\s\S]*?<\/script>\s*<style>[\s\S]*?<\/style>/)[0];

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS31: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CUSTOM_SRC = slice('    function applyCustomTab(cfg) {', '    window.applyCustomTab = applyCustomTab;');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const DENIED_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const FIRMDATA_INIT = slice('    window.firmData = { phoneLines', ';\n') + ';\n';
const LOAD_FIRMDATA = slice('async function loadFirmData() {', '\n}\n') + '\n}\n';
const LUC_HEAD = slice('    async function loadUserContext() {', '      tasksBadgeRefresh();') + '\n    }\n';

// The launcher in a bare vm (+ URL, which a browser has), warnings captured.
function vmLauncher() {
  const warnings = [];
  const ctx = vm.createContext({ console: { error: (m) => warnings.push(String(m)), warn: (m) => warnings.push(String(m)) }, URL });
  ctx.window = ctx;
  vm.runInContext(REGISTRY_SRC, ctx);
  vm.runInContext(RENDERER_SRC, ctx);
  return { L: ctx.window.ycLauncher, REG: ctx.window.FEATURE_REGISTRY, LAY: ctx.window.DEFAULT_LAYOUTS, warnings };
}
const { L, REG, LAY } = vmLauncher();
const placed = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);

const FI = {
  payroll: { id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } },
  appt: { id: 'firm:appt', label: 'Appointment Form', icon: 'calendar-plus', action: { type: 'tool', key: 'appt-form', present: 'modal' } },
  leads: { id: 'firm:leads', label: 'Lead Follow-ups', icon: 'table-list', action: { type: 'view', key: 'lead_followups', present: 'modal' } },
  bad: { id: 'firm:bad', label: 'Bad', icon: 'bug', action: { type: 'url', href: 'javascript:alert(1)', present: 'window' } },
};
const ui = (ro) => ({ firm: { registry_overrides: ro }, user: {} });
const ids = (eff) => eff.map((e) => e.id);

// ─────────────────────────────────────────────────────────────────────────
describe('the firm overlay in the effective registry (pure)', () => {
  test('firm hidden out; the undeniable set defies it; junk ignored', () => {
    const eff = ids(L.computeEffective({ ui: ui({ hidden: ['moreCampaigns', 'cases', 'moreSettings', 'helpSupport', 7] }) }));
    expect(eff).not.toContain('moreCampaigns');
    expect(eff).not.toContain('cases');
    expect(eff).toContain('moreSettings');
    expect(eff).toContain('helpSupport');
    expect(ids(L.computeEffective({ ui: ui({ hidden: 'cases' }) }))).toContain('cases');
    for (const bad of [null, 'x', [], { firm: null }, { firm: { registry_overrides: [] } }]) {
      expect(ids(L.computeEffective({ ui: bad }))).toEqual(ids(L.computeEffective({})));
    }
  });

  test('renames replace label AND surfaceLabels; the custom item ignores them; bad labels ignored', () => {
    const eff = L.computeEffective({ customTab: { src: '/x', title: 'Mine' }, ui: ui({ renames: {
      bills: { label: ' Invoices ' }, cases: { label: 'Matters' }, custom: { label: 'Nope' },
      contacts: { label: '' }, log: { label: 'x'.repeat(41) }, tasks: 'To-dos' } }) });
    const by = Object.fromEntries(eff.map((e) => [e.id, e]));
    expect([by.bills.label, by.bills.labels]).toEqual(['Invoices', ['Invoices']]);     // "Billing" gone too
    expect(by.cases.label).toBe('Matters');
    expect(by.custom.label).toBe('Mine');
    expect([by.contacts.label, by.log.label, by.tasks.label]).toEqual(['Contacts', 'Log', 'Tasks']);
    expect(L.rank('billing', eff).map((e) => e.id)).not.toContain('bills');
    expect(L.rank('invoices', eff)[0].id).toBe('bills');
  });

  test('firm items: group "Firm" after More, before Admin, in array order; bad / duplicate dropped with a warning', () => {
    const v = vmLauncher();
    const eff = v.L.computeEffective({ isAdmin: true, ui: ui({ items: [FI.leads, FI.bad, FI.payroll, { ...FI.payroll, label: 'Dup' }, FI.appt] }) });
    // the order rides on the list (computeEffective is pure since S4a)
    expect(eff.groups).toEqual(['Home', 'Records', 'Actions', 'Settings', 'More actions', 'More', 'Firm', 'Admin']);   // More actions: S6b
    const firm = eff.filter((e) => e.group === 'Firm');
    expect(firm.map((e) => [e.id, e.label, e.icon])).toEqual([
      ['firm:leads', 'Lead Follow-ups', 'table-list'], ['firm:payroll', 'Payroll', 'money-check'], ['firm:appt', 'Appointment Form', 'calendar-plus']]);
    const gi = (g) => eff.findIndex((e) => e.group === g);
    expect(gi('More') < gi('Firm') && gi('Firm') < gi('Admin')).toBe(true);
    expect(v.warnings.filter((w) => /firm item \d+ dropped/.test(w))).toHaveLength(2);
    // no items → no Firm group at all
    expect(v.L.computeEffective({ isAdmin: true }).groups).toEqual(['Home', 'Records', 'Actions', 'Settings', 'More actions', 'More', 'Admin']);
  });

  test('firm items are hidden / denied like any id; effectiveRegistry() never hands out the action', () => {
    const eff = ids(L.computeEffective({ denied: ['firm:appt'], ui: ui({ hidden: ['firm:payroll'], items: [FI.payroll, FI.appt, FI.leads] }) }));
    expect(eff.filter((i) => i.startsWith('firm:'))).toEqual(['firm:leads']);
    const t = boot();
    t.L.applyAccess({ ui: ui({ items: [FI.payroll] }) });
    expect(JSON.parse(JSON.stringify(t.L.effectiveRegistry().find((e) => e.id === 'firm:payroll')))).toEqual(
      { id: 'firm:payroll', group: 'Firm', label: 'Payroll', labels: ['Payroll'], icon: 'money-check' });
    t.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
function boot({ registrySrc = REGISTRY_SRC } = {}) {
  const grid = (sf) => placed(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabCustom']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabCustom'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${registrySrc}</script><script id="ycLauncher">${RENDERER_SRC}</script>${DENIED_CSS}${DIALOG_BLOCK}</head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><script>ycLauncher.mount('home')</script></div>
    <div id="tabAll" class="tab-main"></div>
    <div id="tabCustom" class="tab-main"><iframe id="tabCustomFrame"></iframe></div>
    ${plainTabs}
    <div id="tabMore" class="tab-main"><h1>More</h1><script>ycLauncher.mount('more')</script>${grid('more')}</div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1><script>ycLauncher.mount('admin')</script>${grid('admin')}</div>
    <textarea id="elsewhere"></textarea><b id="myNameIs"></b><div id="hdrUserArea"></div>
  </body></html>`;
  const errors = [], warnings = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => warnings.push(a.join(' '));
  const calls = [], opened = [];
  w.__calls = calls;
  w.open = (...a) => { opened.push(a); return null; };
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push('${m[1]}'); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + CUSTOM_SRC + DRILL_SRC);
  const d = w.document;
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const pills = (tab) => [...d.querySelectorAll(`#${tab} > .feature-strip .pill-button`)].slice(1).map((p) => p.textContent.trim());
  const dlg = () => d.getElementById('ycToolDialog');
  const dlgOpen = () => !!dlg() && !dlg().hidden;
  return { w, d, L: w.ycLauncher, calls, opened, errors, warnings, shown, pills, dlg, dlgOpen, close: () => w.close() };
}
// Every launcher element's markup — but the custom item's, which applyCustomTab
// rewrites wholesale (icon, label, title) and the launcher never relabels.
const launcherHtml = (t) => ['sidebar', 'home', 'more', 'admin'].map((sf) =>
  placed(sf).filter((id) => id !== 'custom').map((id) => t.L.elementsOf(id)[sf].outerHTML).join('\n')).join('\n');

describe('the hide pass + relabel (for real)', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('firm-hidden items are hidden on every surface they render on, and get no pill', () => {
    t.L.applyAccess({ ui: ui({ hidden: ['cases', 'moreCampaigns', 'moreSettings'] }) });
    const c = t.L.elementsOf('cases');
    expect([t.shown(c.sidebar), t.shown(c.home), t.shown(t.L.elementsOf('moreCampaigns').more)]).toEqual([false, false, false]);
    expect(t.shown(t.L.elementsOf('moreSettings').more)).toBe(true);
    expect(c.sidebar.style.display).toBe('');                                  // by attribute, not style.display
    t.L.elementsOf('moreManuals').more.click();
    expect(t.pills('tabMore')).not.toContain('Campaigns');
    expect(t.pills('tabMore')).toHaveLength(placed('more').length - 1);
  });

  test('denied ∪ firm-hidden: one attribute, both honoured, and lifting one keeps the other', () => {
    t.L.applyAccess({ denied: ['cases'], ui: ui({ hidden: ['contacts'] }) });
    expect(t.d.querySelectorAll('[data-yc-denied]')).toHaveLength(4);
    t.L.applyAccess({ ui: ui({}) });
    expect([t.shown(t.L.elementsOf('cases').home), t.shown(t.L.elementsOf('contacts').home)]).toEqual([false, true]);
  });

  test('renames: every surface, text only — icons, badges, structure untouched; sidebar title follows', () => {
    t.L.applyAccess({ ui: ui({ renames: { cases: { label: 'Matters' }, bills: { label: 'Invoices' }, tasks: { label: 'To-dos' }, moreTheme: { label: 'Colours' } } }) });
    const c = t.L.elementsOf('cases'), b = t.L.elementsOf('bills'), k = t.L.elementsOf('tasks');
    expect(c.sidebar.querySelector('span').textContent).toBe('Matters');
    expect(c.sidebar.getAttribute('title')).toBe('Matters');
    expect(c.home.textContent.trim()).toBe('Matters');
    expect(c.home.querySelector('i.fa-landmark.fa-2xl')).toBeTruthy();
    expect(b.home.textContent.trim()).toBe('Invoices');                           // was "Billing" (surfaceLabels)
    expect(b.sidebar.querySelector('span').textContent).toBe('Invoices');
    const badge = k.sidebar.querySelector('.sb-badge#sbTasksBadge');
    expect([badge.textContent, k.sidebar.querySelector('span').textContent]).toEqual(['0', 'To-dos']);
    expect(t.L.elementsOf('moreTheme').more.textContent).toBe('Colours');
    expect(t.L.elementsOf('moreTheme').more.querySelectorAll('i, br')).toHaveLength(3);
    expect([...c.home.childNodes].map((x) => x.nodeName)).toEqual(['#text', 'I', 'BR', 'BR', '#text']);   // S1's structure
    expect([...c.sidebar.childNodes].map((x) => x.nodeName)).toEqual(['#text', 'I', 'SPAN', '#text']);
  });

  test('a DB-authored label is text, never markup', () => {
    t.L.applyAccess({ ui: ui({ renames: { cases: { label: '<img src=x onerror=alert(1)>' } } }) });
    const c = t.L.elementsOf('cases');
    expect(c.sidebar.querySelector('img')).toBeNull();
    expect(c.home.querySelector('img')).toBeNull();
    expect(c.sidebar.querySelector('span').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  test('idempotent across applyAccess and applyCustomTab re-runs; removing the rename restores the markup exactly', () => {
    const before = launcherHtml(t);
    const doc = ui({ hidden: ['moreViews'], renames: { cases: { label: 'Matters' }, bills: { label: 'Invoices' }, admin: { label: 'Back Office' } } });
    t.L.applyAccess({ isAdmin: true, ui: doc });
    const once = launcherHtml(t);
    t.L.applyAccess({ ui: doc });
    t.w.applyCustomTab({ src: '/x.html', title: 'X' });
    t.L.applyAccess({ customTab: { src: '/x.html', title: 'X' } });
    expect(launcherHtml(t).replace(/ style="[^"]*"/g, '')).toBe(once.replace(/ style="[^"]*"/g, ''));
    expect(t.L.elementsOf('cases').home.textContent.trim()).toBe('Matters');
    t.w.applyCustomTab(null);
    t.L.applyAccess({ ui: { firm: {}, user: {} } });
    expect(launcherHtml(t)).toBe(before);
  });

  test('an explicit registry title is kept; the custom item is never relabelled', () => {
    const src = REGISTRY_SRC.replace("label: 'Log', icon: 'box-archive',", "label: 'Log', icon: 'box-archive', title: 'The log',");
    expect(src).not.toBe(REGISTRY_SRC);
    const t2 = boot({ registrySrc: src });
    t2.L.applyAccess({ ui: ui({ renames: { log: { label: 'Journal' }, custom: { label: 'Hijack' } } }) });
    const lg = t2.L.elementsOf('log').sidebar;
    expect([lg.querySelector('span').textContent, lg.getAttribute('title')]).toEqual(['Journal', 'The log']);
    expect(t2.L.elementsOf('custom').sidebar.querySelector('span').textContent).toBe('Custom Tab');
    t2.close();
  });

  test('a drilled-in pill strip follows a rename (and its reversal)', () => {
    t.L.applyAccess({ ui: ui({}) });
    t.L.elementsOf('moreManuals').more.click();
    expect(t.pills('tabMore')).toContain('Theme');
    t.L.applyAccess({ ui: ui({ renames: { moreTheme: { label: 'Colours' } } }) });
    expect(t.pills('tabMore')).toContain('Colours');
    expect(t.pills('tabMore')).not.toContain('Theme');
    expect(t.d.querySelectorAll('#tabMore > .feature-strip')).toHaveLength(1);
    t.L.applyAccess({ ui: ui({}) });
    expect(t.pills('tabMore')).toContain('Theme');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('exec() for firm items + the tool dialog (for real)', () => {
  let t;
  const key = (el, init) => { const e = new t.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e; };
  beforeEach(() => {
    t = boot();
    t.L.applyAccess({ ui: ui({ items: [FI.payroll, FI.appt, FI.leads, FI.bad] }) });
    t.w.openMainTab('tabHome');
  });
  afterEach(() => t.close());

  test('window: window.open(url, "_blank", "noopener"); no dialog, no tab change', () => {
    expect(t.L.exec('firm:payroll')).toBe(true);
    expect(t.opened).toEqual([['https://payroll.example.com/', '_blank', 'noopener']]);
    expect([t.dlgOpen(), t.w.currentMainTabId()]).toEqual([false, 'tabHome']);
  });

  test('modal tool: the dialog opens over the shell with /tool/<key>, titled; Esc closes and gives focus back', () => {
    const ta = t.d.getElementById('elsewhere'); ta.focus();
    expect(t.L.exec('firm:appt')).toBe(true);
    expect(t.dlgOpen()).toBe(true);
    const f = t.dlg().querySelector('iframe.yc-td-frame');
    expect(f.getAttribute('src')).toBe('/tool/appt-form');
    expect(t.d.getElementById('ycToolDialogTitle').textContent).toBe('Appointment Form');
    expect(t.dlg().querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy();
    expect(t.d.activeElement).toBe(t.dlg().querySelector('.yc-td-close'));
    expect(t.opened).toEqual([]);
    key(t.d.body, { key: 'Escape' });
    expect([t.dlgOpen(), t.dlg().querySelector('iframe'), t.d.activeElement]).toEqual([false, null, ta]);
  });

  test('modal view: /customView.html?key=<key>; the close button and a backdrop click close it', () => {
    t.L.exec('firm:leads');
    expect(t.dlg().querySelector('iframe').getAttribute('src')).toBe('/customView.html?key=lead_followups');
    t.dlg().querySelector('.yc-td-close').click();
    expect(t.dlgOpen()).toBe(false);
    t.L.exec('firm:leads');
    t.dlg().querySelector('.yc-td').dispatchEvent(new t.w.MouseEvent('mousedown', { bubbles: true }));
    expect(t.dlgOpen()).toBe(true);                                          // inside the box: stays
    t.dlg().dispatchEvent(new t.w.MouseEvent('mousedown', { bubbles: true }));
    expect(t.dlgOpen()).toBe(false);
  });

  test('Esc stands aside for a SweetAlert over the dialog, and for a handler that took it', () => {
    t.L.exec('firm:appt');
    t.w.Swal = { isVisible: () => true, getPopup: () => null };
    key(t.d.body, { key: 'Escape' });
    expect(t.dlgOpen()).toBe(true);
    t.w.Swal = undefined;
    const taken = t.d.createElement('input'); t.dlg().appendChild(taken);
    taken.addEventListener('keydown', (e) => e.preventDefault());
    key(taken, { key: 'Escape' });
    expect(t.dlgOpen()).toBe(true);
    key(t.d.body, { key: 'Escape' });
    expect(t.dlgOpen()).toBe(false);
  });

  test('exec of anything closes an open dialog first; opening while open swaps the page', () => {
    t.L.exec('firm:appt');
    t.L.exec('firm:leads');
    expect(t.dlg().querySelectorAll('iframe')).toHaveLength(1);
    expect(t.dlg().querySelector('iframe').getAttribute('src')).toBe('/customView.html?key=lead_followups');
    t.L.exec('cases');
    expect([t.dlgOpen(), t.w.currentMainTabId()]).toEqual([false, 'tabCases']);
  });

  test('a malformed item never navigates; an unknown firm id is refused', () => {
    expect(t.L.effectiveRegistry().map((e) => e.id)).not.toContain('firm:bad');
    expect(t.warnings.some((w) => /firm item 3 dropped/.test(w))).toBe(true);
    for (const id of ['firm:bad', 'firm:nope', 'firm:']) expect(t.L.exec(id)).toBe(false);
    expect([t.opened, t.dlgOpen(), t.w.currentMainTabId()]).toEqual([[], false, 'tabHome']);
  });

  test('openToolDialog refuses anything but a same-origin /path', () => {
    for (const u of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a b', '', null, 7]) {
      expect([u, t.w.openToolDialog(u, { title: 'x' })]).toEqual([u, false]);
    }
    expect(t.dlgOpen()).toBe(false);
    expect(t.w.openToolDialog('/tool/x')).toBe(true);
    expect(t.d.getElementById('ycToolDialogTitle').textContent).toBe('Tool');
    t.w.openToolDialog.close();
    expect(t.w.openToolDialog.isOpen()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('boot wiring: loadFirmData + loadUserContext, extracted and run', () => {
  test('loadFirmData copies ui (and the empty layers when absent / not an object)', async () => {
    const run = async (u) => {
      const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
      const w = dom.window;
      w.apiSend = async () => ({ currentUser: { user: 1 }, denied: [], ui: u });
      w.eval(FIRMDATA_INIT + LOAD_FIRMDATA + 'window.loadFirmData = loadFirmData;');
      const initial = JSON.parse(JSON.stringify(w.firmData.ui));
      await w.loadFirmData();
      const out = [initial, JSON.parse(JSON.stringify(w.firmData.ui))];
      w.close();
      return out;
    };
    const U = ui({ hidden: ['bills'] });
    expect(await run(U)).toEqual([{ firm: {}, user: {} }, U]);
    expect(await run(undefined)).toEqual([{ firm: {}, user: {} }, { firm: {}, user: {} }]);
    expect(await run('x')).toEqual([{ firm: {}, user: {} }, { firm: {}, user: {} }]);
  });

  test('loadUserContext hands firmData.ui to applyAccess: hidden + renamed + firm items live after boot', async () => {
    const t = boot();
    t.w.eval('var Toast = { fire() {} }; function startFirmClock() {}\n' + LUC_HEAD);
    t.w.eval(`var user = { user: 1, user_name: 'x', roles: 'staff', user_custom_tab: null };
      window.firmData = { denied: [], ui: ${JSON.stringify(ui({ hidden: ['contacts'], renames: { cases: { label: 'Matters' } }, items: [FI.payroll] }))} };`);
    await t.w.eval('loadUserContext()');
    expect(t.shown(t.L.elementsOf('contacts').sidebar)).toBe(false);
    expect(t.L.elementsOf('cases').sidebar.querySelector('span').textContent).toBe('Matters');
    expect(t.L.effectiveRegistry().map((e) => e.id)).toContain('firm:payroll');
    t.close();
  });
});
