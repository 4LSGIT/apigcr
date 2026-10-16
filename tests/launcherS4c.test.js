// tests/launcherS4c.test.js
//
/**
 * ui-custom S4c — personal keyboard shortcuts.
 *
 *   1. THE SERVER RULE (lib/uiConfigShape.js comboProblem): a combo needs
 *      ctrl, meta or alt, and is never the palette's Ctrl-K / Cmd-K — and the
 *      client copy (public/js/ycAll.js, ycAll.keys.comboProblem) agrees with
 *      it over one matrix.
 *   2. THE KEY HELPERS (ycAll.keys): how a keydown becomes a combo (keyOf:
 *      e.key for plain letters, e.code KeyX / DigitN otherwise, named keys,
 *      Space) and how a combo is written (⌃⌘T on a Mac, Ctrl+Alt+T elsewhere).
 *   3. THE DISPATCHER, RUN FOR REAL in jsdom over the page's own launcher and
 *      the real ycAll.js: a binding runs exec, exact modifiers, defers to
 *      defaultPrevented, stands down during a SweetAlert / the editor / before
 *      login, hears a hooked iframe, does nothing (silently) for an item that
 *      is not effective (denied, admin-gated, firm-hidden, role-restricted, unknown), runs once when held, and its map rebuilds when — and
 *      only when — the bindings change.
 *   4. THE PALETTE shows a row's combos.
 *   5. THE EDITOR's Keyboard shortcuts tab (real ycLayoutEditor.js): capture
 *      → binding; reserved, palette and modifier-less combos refused with the
 *      reason; the AltGr warning; duplicates refused naming the holder;
 *      unavailable bindings kept and removable; Save writes the full document
 *      (validated by the real validator) and the dispatcher follows with no
 *      reload; a both-dirty save, one part failing; escaping; edits ignored
 *      while saving.
 *
 * Mutation-checked (see the S4c worker report).
 *
 * Run:  npx jest tests/launcherS4c.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const shape = require('../lib/uiConfigShape');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const YCALL_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycAll.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS4c: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const ALL_TAB = slice('  <div id="tabAll" class="tab-main">', '\n  <style>');
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CUSTOM_SRC = slice('    function applyCustomTab(cfg) {', '    window.applyCustomTab = applyCustomTab;');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];

const J = (x) => JSON.parse(JSON.stringify(x));
const MODS = ['ctrl', 'meta', 'alt', 'shift'];
const C = (mods, key) => ({ ctrl: mods.includes('ctrl'), meta: mods.includes('meta'), alt: mods.includes('alt'), shift: mods.includes('shift'), key });
const B = (mods, key, id) => ({ combo: C(mods, key), id });

// ycAll.js in a bare vm: no document, so it hands out only its pure helpers
function bareKeys() {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext(YCALL_SRC, ctx, { filename: 'ycAll.js' });
  return ctx.window.ycAll.keys;
}
const K = bareKeys();

// ─────────────────────────────────────────────────────────────────────────
describe('the server rule (lib/uiConfigShape.js) and its client copy', () => {
  const sc = (bindings) => shape.validate('user', 'shortcuts', { bindings });
  const errs = (r) => r.errors.join(' | ');

  test('a combo needs ctrl, meta or alt: none, or shift alone, is refused', () => {
    expect(errs(sc([B([], 't', 'tasks')]))).toMatch(/bindings\[0\]\.combo needs ctrl, meta or alt/);
    expect(errs(sc([B(['shift'], 't', 'tasks')]))).toMatch(/needs ctrl, meta or alt/);
    expect(errs(sc([B(['shift'], 'F2', 'tasks')]))).toMatch(/needs ctrl, meta or alt/);
    for (const m of [['ctrl'], ['meta'], ['alt'], ['alt', 'shift'], ['ctrl', 'meta'], ['ctrl', 'alt', 'shift']]) {
      expect([m, sc([B(m, 't', 'tasks')]).ok]).toEqual([m, true]);
    }
  });

  test('the palette\'s own combo is refused: k with ctrl XOR meta and no alt, shift either way', () => {
    for (const m of [['ctrl'], ['meta'], ['ctrl', 'shift'], ['meta', 'shift']]) {
      expect([m, errs(sc([B(m, 'k', 'tasks')]))]).toEqual([m, expect.stringMatching(/command palette's own/)]);
      expect([m, sc([B(m, 'K', 'tasks')]).ok]).toEqual([m, false]);          // letters fold first
    }
    for (const m of [['ctrl', 'meta'], ['ctrl', 'alt'], ['meta', 'alt'], ['alt']]) expect([m, sc([B(m, 'k', 'tasks')]).ok]).toEqual([m, true]);
  });

  test('a refused combo does not count as taken: the next equal combo is reported once, by the rule', () => {
    const r = sc([B(['ctrl'], 'k', 'tasks'), B(['ctrl'], 'k', 'cases')]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.every((e) => /palette/.test(e))).toBe(true);
  });

  test('the client copy agrees with the server over every modifier set × a key set', () => {
    let n = 0;
    for (let bits = 0; bits < 16; bits++) {
      const mods = MODS.filter((_, i) => bits & (1 << i));
      for (const key of ['k', 'K', 't', '1', '/', 'F2', 'Space', 'ArrowUp']) {
        const server = sc([B(mods, key, 'tasks')]);
        const c = K.cleanCombo(C(mods, key));
        const client = K.comboProblem(c);
        expect([mods, key, server.ok]).toEqual([mods, key, client === null]);
        if (client) expect(server.errors[0]).toBe('bindings[0].combo ' + client);   // same words
        n++;
      }
    }
    expect(n).toBe(128);
    expect(shape.comboProblem).toBeInstanceOf(Function);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the key helpers (ycAll.keys)', () => {
  const ev = (o) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

  test('keyOf: one printable ASCII e.key as typed; e.code only for a non-ASCII e.key; named keys; Space', () => {
    const cases = [
      [{ key: 't', code: 'KeyT' }, 't'],
      [{ key: 'T', code: 'KeyT', shiftKey: true }, 't'],
      [{ key: 'a', code: 'KeyQ' }, 'a'],                  // AZERTY: the letter on the keycap
      [{ key: 'å', code: 'KeyA', altKey: true }, 'a'],    // Option on a Mac types å
      [{ key: '€', code: 'KeyE', ctrlKey: true, altKey: true }, 'e'],   // AltGr
      [{ key: 'е', code: 'KeyT' }, 't'],                  // Cyrillic layout
      [{ key: 'ф', code: 'KeyA' }, 'a'],
      [{ key: '.', code: 'KeyE' }, '.'],                  // Dvorak: punctuation never maps to a letter
      [{ key: 'e', code: 'KeyD' }, 'e'],                  // Dvorak's e is e
      [{ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }, '@'],   // AltGr+Q (German) stays @
      [{ key: '!', code: 'Digit1', shiftKey: true }, '!'],              // ASCII as typed (with shift)
      [{ key: '&', code: 'Digit1' }, '&'],                // AZERTY digit row, unshifted
      [{ key: '½', code: 'Digit5', altKey: true }, '5'],  // non-ASCII: the digit by code
      [{ key: '7', code: 'Numpad7' }, '7'],
      [{ key: 'F2', code: 'F2' }, 'F2'],
      [{ key: 'ArrowUp', code: 'ArrowUp' }, 'ArrowUp'],
      [{ key: ' ', code: 'Space' }, 'Space'],
      [{ key: '/', code: 'Slash' }, '/'],
      [{ key: 'k' }, 'k'],                                // no code at all (synthetic events)
      [{ key: 'Control', code: 'ControlLeft', ctrlKey: true }, null],
      [{ key: 'Shift', code: 'ShiftLeft', shiftKey: true }, null],
      [{ key: 'Meta', code: 'MetaLeft', metaKey: true }, null],
      [{ key: 'Dead', code: 'Quote' }, null],
      [{ key: 'Unidentified', code: '' }, null],
    ];
    for (const [e, want] of cases) expect([e, K.keyOf(ev(e))]).toEqual([e, want]);
    expect(K.comboOf(ev({ key: 'T', code: 'KeyT', ctrlKey: true, metaKey: true, shiftKey: true }))).toEqual(C(['ctrl', 'meta', 'shift'], 't'));
    expect(K.comboOf(ev({ key: 'Control', ctrlKey: true }))).toBe(null);
  });

  test('format: Apple\'s order and symbols on a Mac; Ctrl+Alt+Shift+Win/Meta elsewhere', () => {
    expect(K.format(C(['ctrl', 'meta'], 't'), true)).toBe('⌃⌘T');
    expect(K.format(C(['ctrl', 'meta', 'alt', 'shift'], 't'), true)).toBe('⌃⌥⇧⌘T');
    expect(K.format(C(['meta', 'alt'], 'ArrowLeft'), true)).toBe('⌥⌘←');
    expect(K.format(C(['ctrl', 'alt'], 't'), false, true)).toBe('Ctrl+Alt+T');
    expect(K.format(C(['ctrl', 'alt', 'shift', 'meta'], 'F2'), false, true)).toBe('Ctrl+Alt+Shift+Win+F2');
    expect(K.format(C(['meta'], 'Space'), false, false)).toBe('Meta+Space');
    expect(K.format(C(['ctrl', 'alt'], 'ArrowUp'), false)).toBe('Ctrl+Alt+Up');
    expect(K.isMac({ platform: 'MacIntel' })).toBe(true);
    expect(K.isMac({ platform: 'Win32' })).toBe(false);
    expect(K.isMac({ userAgentData: { platform: 'macOS' } })).toBe(true);
  });

  test('cleanCombo: the server\'s grammar (strict booleans, one printable or a named key; letters fold)', () => {
    expect(K.cleanCombo(C(['ctrl'], 'B'))).toEqual(C(['ctrl'], 'b'));
    for (const bad of [{ ...C(['ctrl'], 'b'), ctrl: 1 }, { ...C(['ctrl'], 'ab') }, { ...C(['ctrl'], ' ') }, { ...C(['ctrl'], 'enter') }, null, 'x']) {
      expect(K.cleanCombo(bad)).toBe(null);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The shell for real: the page's launcher blocks, the All tab, ycAll.js and
// (by default) ycLayoutEditor.js, over a stateful mock of /api/ui-config.
const FIRM_URL = { id: 'firm:payroll', label: 'Pay <img src=x onerror=alert(1)>', icon: 'money-check',
  action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const FIRM_GONE = { id: 'firm:gone', label: 'Gone for now', icon: 'ghost',
  action: { type: 'url', href: 'https://gone.example.com/', present: 'window' } };
const RO = { items: [FIRM_URL, FIRM_GONE], hidden: ['firm:gone'], locked: [], renames: {} };
const ACCESS = { isAdmin: false, denied: ['moreViews'], customTab: null };

function boot({ shortcuts = null, layout = null, access = ACCESS, login = true, platform = '', editor = true } = {}) {
  const LAY = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(REGISTRY_SRC, c); return J(c.DEFAULT_LAYOUTS); })();
  const REG = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(REGISTRY_SRC, c); return c.FEATURE_REGISTRY; })();
  const placedIds = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
  const grid = (sf) => placedIds(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabCustom']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabCustom', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}</head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <button id="homeAll" class="home-btn"></button></div>
    ${ALL_TAB}
    <div id="tabCustom" class="tab-main"><iframe id="tabCustomFrame"></iframe></div>
    ${plainTabs}
    <div id="tabMore" class="tab-main"><h1>More</h1><script>ycLauncher.mount('more')</script>${grid('more')}</div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1><script>ycLauncher.mount('admin')</script>${grid('admin')}</div>
    <textarea id="elsewhere"></textarea>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  if (platform) Object.defineProperty(w.navigator, 'platform', { get: () => platform, configurable: true });
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const calls = [];
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push('${m[1]}'); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.__calls = calls;
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + CUSTOM_SRC + DRILL_SRC);
  const opened = [];
  w.open = (url) => { opened.push(url); return null; };
  const ui = () => ({ firm: { registry_overrides: J(RO) }, user: { ...(layout ? { layout: J(layout) } : {}), ...(shortcuts ? { shortcuts: J(shortcuts) } : {}) } });
  w.firmData = { ui: ui() };
  // the server: GET answers what it holds; PUT validates with the real
  // validator and stores; fail[key] forces a reply for that config_key; hold
  // keeps a PUT pending until release()
  const server = { puts: [], gets: 0, fail: {}, hold: false, release: null, user: J(w.firmData.ui.user), firm: J(w.firmData.ui.firm) };
  w.apiSend = (url, method, body) => {
    if (method === 'GET' || method == null) {
      server.gets++;
      return Promise.resolve({ status: 'success', firm: J(server.firm), user: J(server.user), can_edit_firm: false });
    }
    server.puts.push(J({ url, method, body }));
    if (server.hold) return new Promise((resolve, reject) => { server.release = () => { server.hold = false; answerPut(body).then(resolve, reject); }; });
    return answerPut(body);
  };
  function answerPut(body) {
    const f = server.fail[body.config_key];
    if (f) return Promise.reject(Object.assign(new Error(f.message || 'refused'), f));
    const v = shape.validateWrite(J(body));
    if (!v.ok) return Promise.reject(Object.assign(new Error('Invalid'), { status: 400, body: { status: 'error', errors: v.errors } }));
    server.user[body.config_key] = J(v.value.config);
    return Promise.resolve({ status: 'success', scope: 'user', config_key: body.config_key, config: J(v.value.config), changed: true, versioned: false });
  }
  const confirms = [];
  let answer = true;
  w.confirm = (text) => { confirms.push(text); return answer; };
  if (login) w.ycLauncher.applyAccess({ ...access, ui: w.firmData.ui });
  w.eval(YCALL_SRC);
  if (editor) w.eval(EDITOR_SRC);
  const d = w.document;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const key = (el, init) => {
    const e = new (el.ownerDocument.defaultView.KeyboardEvent)('keydown', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  const panel = () => d.getElementById('ycLayoutEditor');
  const scSec = () => panel().querySelector('.ysc-sec');
  const scRows = () => [...scSec().querySelectorAll('.ysc-row')].map((li) => [li.querySelector('.ysc-kbd').textContent, li.querySelector('.yle-name').textContent, !!li.querySelector('.yle-tag')]);
  const cap = () => scSec().querySelector('.ysc-capture');
  const msg = () => scSec().querySelector('.ysc-msg');
  const addBtn = () => scSec().querySelector('[data-act="sc-add"]');
  const openEditor = async (section = 'shortcuts') => { const ok = await w.ycLayoutEditor.open({ section }); await flush(); return ok; };
  // the add box: pick the item by typing its name, then press the combo
  const startAdd = (query, id) => {
    scSec().querySelector('[data-act="sc-open"]').click();
    const q = scSec().querySelector('.yle-pick-q');
    q.value = query;
    q.dispatchEvent(new w.Event('input', { bubbles: true }));
    const pick = scSec().querySelector(`.yle-pick-item[data-id="${id}"]`);
    if (!pick) throw new Error('picker has no ' + id);
    pick.click();
  };
  const press = (init) => key(cap(), init);
  return {
    w, d, server, errors, calls, opened, confirms, flush, key, panel, scSec, scRows, cap, msg, addBtn, openEditor, startAdd, press,
    tab: () => w.currentMainTabId(), answer: (v) => { answer = v; }, close: () => w.close(),
  };
}
const CMD_CTRL_T = { key: 't', code: 'KeyT', ctrlKey: true, metaKey: true };

// ─────────────────────────────────────────────────────────────────────────
describe('the dispatcher (ycAll.js onKey, for real)', () => {
  let t;
  afterEach(() => t && t.close());
  const SC = { bindings: [B(['ctrl', 'meta'], 't', 'tasks'), B(['ctrl', 'alt'], 'a', 'moreAutomations'), B(['ctrl', 'alt'], 'p', 'firm:payroll')] };

  test('a bound combo runs exec(id) and is claimed; an unbound one is left alone', () => {
    t = boot({ shortcuts: SC });
    const ta = t.d.getElementById('elsewhere'); ta.focus();          // from a focused text box too
    const e = t.key(ta, CMD_CTRL_T);
    expect([e.defaultPrevented, t.tab()]).toEqual([true, 'tabTasks']);
    const e2 = t.key(t.d.body, { key: 'a', code: 'KeyA', ctrlKey: true, altKey: true });   // a More panel
    expect(e2.defaultPrevented).toBe(true);
    expect([t.tab(), t.w.getComputedStyle(t.d.getElementById('automationsDiv')).display]).toEqual(['tabMore', 'block']);
    t.key(t.d.body, { key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });               // a firm item
    expect(t.opened).toEqual(['https://payroll.example.com/']);
    const e3 = t.key(t.d.body, { key: 'y', code: 'KeyY', ctrlKey: true, metaKey: true });
    expect([e3.defaultPrevented, t.tab()]).toEqual([false, 'tabMore']);
    expect(t.errors).toEqual([]);
  });

  test('modifiers match exactly: ⌃⌘T does not fire on ⌃⌘⇧T, ⌃⌥⌘T or ⌃T', () => {
    t = boot({ shortcuts: SC });
    t.w.openMainTab('tabHome');
    for (const extra of [{ shiftKey: true, key: 'T' }, { altKey: true }, { metaKey: false }, { ctrlKey: false }]) {
      const e = t.key(t.d.body, { ...CMD_CTRL_T, ...extra });
      expect([extra, e.defaultPrevented, t.tab()]).toEqual([extra, false, 'tabHome']);
    }
  });

  test('defers to an owner that already claimed the combo (defaultPrevented)', () => {
    t = boot({ shortcuts: SC });
    t.w.openMainTab('tabHome');
    const ed = t.d.createElement('div');
    ed.addEventListener('keydown', (e) => e.preventDefault());
    t.d.body.appendChild(ed);
    t.key(ed, CMD_CTRL_T);
    expect(t.tab()).toBe('tabHome');
  });

  test('stands down during a SweetAlert dialog (a toast does not count), while the editor is open, and before login', async () => {
    t = boot({ shortcuts: SC });
    t.w.openMainTab('tabHome');
    const popup = t.d.createElement('div');
    popup.className = 'swal2-popup';
    t.w.Swal = { isVisible: () => true, getPopup: () => popup };
    expect([t.key(t.d.body, CMD_CTRL_T).defaultPrevented, t.tab()]).toEqual([false, 'tabHome']);
    popup.className = 'swal2-popup swal2-toast';
    expect([t.key(t.d.body, CMD_CTRL_T).defaultPrevented, t.tab()]).toEqual([true, 'tabTasks']);
    t.w.Swal.isVisible = () => false;
    t.w.openMainTab('tabHome');
    expect(await t.openEditor('layout')).toBe(true);
    expect([t.key(t.d.body, CMD_CTRL_T).defaultPrevented, t.tab()]).toEqual([false, 'tabHome']);
    t.close();

    t = boot({ shortcuts: SC, login: false });
    const e = t.key(t.d.body, CMD_CTRL_T);
    expect([e.defaultPrevented, t.calls]).toEqual([false, []]);
    t.w.ycLauncher.applyAccess({ ...ACCESS, ui: t.w.firmData.ui });   // login: the map is read then
    expect([t.key(t.d.body, CMD_CTRL_T).defaultPrevented, t.tab()]).toEqual([true, 'tabTasks']);
  });

  test('works from inside a same-origin pane iframe', async () => {
    t = boot({ shortcuts: SC });
    t.w.openMainTab('tabHome');
    const f = t.d.createElement('iframe');
    t.d.body.appendChild(f);
    await new Promise((r) => setTimeout(r, 50));            // its load event hooks the frame
    const inp = f.contentDocument.createElement('input');
    f.contentDocument.body.appendChild(inp);
    inp.focus();
    const e = t.key(inp, CMD_CTRL_T);
    expect([e.defaultPrevented, t.tab()]).toEqual([true, 'tabTasks']);
  });

  test('a binding to an item that is not effective now does nothing — no exec, no navigation, no console noise, the key untouched', () => {
    // moreViews denied, adminDbConsole admin-gated (non-admin), firm:gone firm-hidden, nope unknown
    const bad = { bindings: [B(['ctrl', 'meta'], 'v', 'moreViews'), B(['ctrl', 'meta'], 'b', 'adminDbConsole'),
      B(['ctrl', 'meta'], 'g', 'firm:gone'), B(['ctrl', 'meta'], 'n', 'nope')] };
    t = boot({ shortcuts: bad });
    t.w.openMainTab('tabHome');
    const execs = [];
    const real = t.w.ycLauncher.exec;
    t.w.ycLauncher.exec = (id) => { execs.push(id); return real(id); };
    for (const k of ['v', 'b', 'g', 'n']) {
      const e = t.key(t.d.body, { key: k, code: 'Key' + k.toUpperCase(), ctrlKey: true, metaKey: true });
      expect([k, e.defaultPrevented]).toEqual([k, false]);  // not ours: the key goes through untouched
    }
    expect([execs, t.tab(), t.calls, t.opened, t.errors]).toEqual([[], 'tabHome', [], [], []]);
    expect(t.w.getComputedStyle(t.d.getElementById('viewsDiv')).display).toBe('none');
  });

  test('a role-restricted target (the firm\'s visible_to, S3.4) does nothing; for a role that may see it, it runs', () => {
    t = boot({ shortcuts: { bindings: [B(['ctrl', 'meta'], 'a', 'moreAutomations')] } });
    t.w.openMainTab('tabHome');
    t.w.firmData.ui = { ...t.w.firmData.ui, firm: { registry_overrides: { ...J(RO), visible_to: { moreAutomations: ['attorney'] } } } };
    t.w.ycLauncher.applyAccess({ ui: t.w.firmData.ui, roles: ['staff'] });
    expect(t.w.ycLauncher.effectiveRegistry().map((e) => e.id)).not.toContain('moreAutomations');
    const ev = { key: 'a', code: 'KeyA', ctrlKey: true, metaKey: true };
    expect([t.key(t.d.body, ev).defaultPrevented, t.tab(), t.errors]).toEqual([false, 'tabHome', []]);
    expect(t.w.getComputedStyle(t.d.getElementById('automationsDiv')).display).toBe('none');
    t.w.ycLauncher.applyAccess({ roles: ['staff', 'attorney'] });
    t.key(t.d.body, ev);
    expect(t.tab()).toBe('tabMore');
  });

  test('Dvorak: the "." key (code KeyE) does not fire Ctrl+Alt+E; the "e" key (code KeyD) does', () => {
    t = boot({ shortcuts: { bindings: [B(['ctrl', 'alt'], 'e', 'calendar'), B(['ctrl', 'alt'], '.', 'tasks')] } });
    t.w.openMainTab('tabHome');
    t.key(t.d.body, { key: '.', code: 'KeyE', ctrlKey: true, altKey: true });
    expect(t.tab()).toBe('tabTasks');                                      // "." is its own binding
    t.w.openMainTab('tabHome');
    t.close();
    t = boot({ shortcuts: { bindings: [B(['ctrl', 'alt'], 'e', 'calendar')] } });
    t.w.openMainTab('tabHome');
    const dot = t.key(t.d.body, { key: '.', code: 'KeyE', ctrlKey: true, altKey: true });
    expect([dot.defaultPrevented, t.tab()]).toEqual([false, 'tabHome']);
    t.key(t.d.body, { key: 'e', code: 'KeyD', ctrlKey: true, altKey: true });
    expect(t.tab()).toBe('tabCalendar');
  });

  test('AltGr held: a Ctrl+Alt+Q binding does not fire and the character is left alone', () => {
    t = boot({ shortcuts: { bindings: [B(['ctrl', 'alt'], 'q', 'tasks')] } });
    t.w.openMainTab('tabHome');
    const ta = t.d.getElementById('elsewhere'); ta.focus();
    const e = t.key(ta, { key: 'q', code: 'KeyQ', ctrlKey: true, altKey: true, modifierAltGraph: true });
    expect([e.defaultPrevented, t.tab()]).toEqual([false, 'tabHome']);
    t.key(ta, { key: 'q', code: 'KeyQ', ctrlKey: true, altKey: true });   // real Ctrl+Alt+Q
    expect(t.tab()).toBe('tabTasks');
  });

  test('Option / Cyrillic letters still match through the code fallback', () => {
    t = boot({ shortcuts: { bindings: [B(['ctrl', 'alt'], 'a', 'tasks'), B(['ctrl', 'meta'], 'a', 'calendar')] } });
    t.w.openMainTab('tabHome');
    t.key(t.d.body, { key: 'å', code: 'KeyA', ctrlKey: true, altKey: true });   // ⌃⌥A on a Mac types å
    expect(t.tab()).toBe('tabTasks');
    t.key(t.d.body, { key: 'ф', code: 'KeyA', ctrlKey: true, metaKey: true });  // Russian layout
    expect(t.tab()).toBe('tabCalendar');
  });

  test('IME composition (isComposing, key "Process") is never a shortcut', () => {
    t = boot({ shortcuts: { bindings: [B(['ctrl', 'alt'], 'a', 'tasks')] } });
    t.w.openMainTab('tabHome');
    const a = t.key(t.d.body, { key: 'a', code: 'KeyA', ctrlKey: true, altKey: true, isComposing: true });
    const b = t.key(t.d.body, { key: 'Process', code: 'KeyA', ctrlKey: true, altKey: true });
    expect([a.defaultPrevented, b.defaultPrevented, t.tab()]).toEqual([false, false, 'tabHome']);
    t.key(t.d.body, { key: 'a', code: 'KeyA', ctrlKey: true, altKey: true });
    expect(t.tab()).toBe('tabTasks');
  });

  test('held down (auto-repeat), it runs once', () => {
    t = boot({ shortcuts: SC });
    const execs = [];
    const real = t.w.ycLauncher.exec;
    t.w.ycLauncher.exec = (id) => { execs.push(id); return real(id); };
    t.key(t.d.body, CMD_CTRL_T);
    const r = t.key(t.d.body, { ...CMD_CTRL_T, repeat: true });
    expect([execs, r.defaultPrevented]).toEqual([['tasks'], true]);
  });

  test('stored bindings the rules refuse never fire (no modifier, the palette\'s combo, bad grammar)', () => {
    // Ctrl+Shift+K is the one only the re-check stops: the palette ignores
    // Shift, and it holds a modifier — the server refuses it (the palette rule)
    const odd = { bindings: [B([], 'x', 'tasks'), B(['shift'], 'y', 'tasks'), { combo: { ...C(['ctrl', 'meta'], 'z'), alt: 'no' }, id: 'tasks' },
      B(['ctrl', 'shift'], 'k', 'tasks')] };
    t = boot({ shortcuts: odd });
    t.w.openMainTab('tabHome');
    for (const init of [{ key: 'x', code: 'KeyX' }, { key: 'Y', code: 'KeyY', shiftKey: true }, { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true },
      { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }]) {
      const e = t.key(t.d.body, init);
      expect([init, e.defaultPrevented]).toEqual([init, false]);
    }
    expect([t.tab(), t.w.ycAll.lookup(C(['ctrl', 'meta'], 'z')), t.w.ycAll.lookup(C(['ctrl', 'shift'], 'k'))]).toEqual(['tabHome', null, null]);
  });

  test('the palette keeps Ctrl-K / ⌘K; ⌃⌘K is no longer the palette (it can be bound); a binding closes an open palette', () => {
    t = boot({ shortcuts: { bindings: [B(['ctrl', 'meta'], 'k', 'cases'), ...SC.bindings] } });
    const pal = () => t.d.getElementById('ycPalette');
    t.key(t.d.body, { key: 'k', ctrlKey: true });
    expect(pal().hidden).toBe(false);
    t.key(t.d.querySelector('#ycPalette .yc-pal-input'), CMD_CTRL_T);    // a binding from inside the palette
    expect([pal().hidden, t.tab()]).toEqual([true, 'tabTasks']);
    t.key(t.d.body, { key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true });
    expect([pal().hidden, t.tab()]).toEqual([true, 'tabCases']);
    t.key(t.d.body, { key: 'k', metaKey: true });
    expect(pal().hidden).toBe(false);
  });

  test('the map is rebuilt when the bindings change, and only then', () => {
    t = boot({ shortcuts: SC });
    const v0 = t.w.ycAll.shortcutsVersion();
    t.w.ycLauncher.applyAccess({});                                      // nothing changed
    t.w.applyCustomTab && t.w.ycLauncher.applyAccess({ customTab: null });
    expect(t.w.ycAll.shortcutsVersion()).toBe(v0);
    // MySQL hands the same document back with its keys in another order: still unchanged
    t.w.firmData.ui = { ...t.w.firmData.ui, user: { shortcuts: { bindings: SC.bindings.map((b) => ({ id: b.id, combo: { key: b.combo.key, shift: b.combo.shift, alt: b.combo.alt, meta: b.combo.meta, ctrl: b.combo.ctrl } })) } } };
    t.w.ycLauncher.applyAccess({ ui: t.w.firmData.ui });
    expect(t.w.ycAll.shortcutsVersion()).toBe(v0);
    t.w.firmData.ui = { ...t.w.firmData.ui, user: { shortcuts: { bindings: [B(['ctrl', 'meta'], 'e', 'calendar')] } } };
    t.w.ycLauncher.applyAccess({ ui: t.w.firmData.ui });
    expect(t.w.ycAll.shortcutsVersion()).toBe(v0 + 1);
    expect([t.w.ycAll.lookup(C(['ctrl', 'meta'], 't')), t.w.ycAll.lookup(C(['ctrl', 'meta'], 'e'))]).toEqual([null, 'calendar']);
    t.key(t.d.body, { key: 'e', code: 'KeyE', ctrlKey: true, metaKey: true });
    expect(t.tab()).toBe('tabCalendar');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the palette shows a row\'s combos', () => {
  let t;
  afterEach(() => t && t.close());
  const row = (label) => [...t.d.querySelectorAll('#ycPalette .yc-pal-item')].find((b) => b.querySelector('span').textContent === label);

  test('platform form, as text; unbound rows carry none', () => {
    t = boot({ platform: 'MacIntel', shortcuts: { bindings: [B(['ctrl', 'meta'], 't', 'tasks'), B(['ctrl', 'meta', 'shift'], 't', 'tasks')] } });
    t.key(t.d.body, { key: 'k', metaKey: true });
    expect([...row('Tasks').querySelectorAll('.yc-pal-keys kbd')].map((k) => k.textContent)).toEqual(['⌃⌘T', '⌃⇧⌘T']);
    expect(row('Cases').querySelector('.yc-pal-keys')).toBe(null);
    t.close();
    t = boot({ platform: 'Win32', shortcuts: { bindings: [B(['ctrl', 'alt'], 't', 'tasks'), B(['ctrl', 'alt'], 'p', 'firm:payroll')] } });
    t.key(t.d.body, { key: 'k', ctrlKey: true });
    expect(row('Tasks').querySelector('.yc-pal-keys').textContent).toBe('Ctrl+Alt+T');
    const pay = row(FIRM_URL.label);                                       // markup in the label stays text
    expect([pay.querySelector('.yc-pal-keys').textContent, pay.querySelector('img')]).toEqual(['Ctrl+Alt+P', null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the editor\'s Keyboard shortcuts tab (for real)', () => {
  let t;
  afterEach(() => t && t.close());

  test('a tab beside Home & sidebar; says shortcuts need a keyboard; capture → binding → Save writes the full document; the dispatcher follows, no reload', async () => {
    const stored = { bindings: [B(['ctrl', 'meta'], 'e', 'calendar')] };
    t = boot({ platform: 'MacIntel', shortcuts: stored });
    const marker = t.w.__noReload = {};
    expect(await t.openEditor('layout')).toBe(true);
    const tabs = [...t.panel().querySelectorAll('.yle-tab')];
    expect(tabs.map((b) => b.textContent.replace('•', '').trim())).toEqual(['Home & sidebar', 'Keyboard shortcuts', 'My buttons']);   // My buttons: S5a
    expect(t.panel().querySelector('#ylePane_shortcuts').hidden).toBe(true);
    tabs[1].click();
    expect([t.panel().querySelector('#ylePane_shortcuts').hidden, t.panel().querySelector('#ylePane_layout').hidden]).toEqual([false, true]);
    expect(t.scSec().querySelector('.ysc-intro').textContent).toMatch(/Shortcuts need a keyboard/);
    expect(t.scRows()).toEqual([['⌃⌘E', 'Calendar', false]]);

    t.startAdd('tasks', 'tasks');
    expect(t.d.activeElement).toBe(t.cap());
    expect(t.scSec().querySelector('.ysc-chosen').textContent).toMatch(/Tasks/);
    expect(t.addBtn().disabled).toBe(true);                               // no keys yet
    const mod = t.press({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
    expect([mod.defaultPrevented, t.cap().value]).toEqual([true, '⌃…']);  // live
    const e = t.press(CMD_CTRL_T);
    expect([e.defaultPrevented, t.cap().value, t.msg().textContent, t.addBtn().disabled]).toEqual([true, '⌃⌘T', 'Free to use.', false]);
    expect(t.calls).toEqual([]);                                          // the capture ran nothing
    t.addBtn().click();
    expect(t.scRows()).toEqual([['⌃⌘E', 'Calendar', false], ['⌃⌘T', 'Tasks', false]]);
    expect(t.panel().querySelector('.yle-tab[data-pane="shortcuts"] .yle-tab-dot').hidden).toBe(false);
    expect(t.panel().querySelector('.yle-tab[data-pane="layout"] .yle-tab-dot').hidden).toBe(true);

    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['shortcuts']);   // the layout was clean
    const doc = t.server.puts[0].body;
    expect([doc.scope, doc.config.bindings]).toEqual(['user', [B(['ctrl', 'meta'], 'e', 'calendar'), B(['ctrl', 'meta'], 't', 'tasks')]]);
    expect(shape.validate('user', 'shortcuts', doc.config).ok).toBe(true);
    expect(t.panel().hidden).toBe(true);
    expect(t.w.firmData.ui.user.shortcuts).toEqual(t.server.user.shortcuts);
    t.w.openMainTab('tabHome');
    t.key(t.d.body, CMD_CTRL_T);
    expect(t.tab()).toBe('tabTasks');
    expect(t.w.__noReload).toBe(marker);
    expect(t.errors).toEqual([]);
  });

  test('refused: ⌘T (browser), Ctrl-K / ⌘K (palette), no modifier, ⌥ alone, Tab — each with its reason; Add stays off', async () => {
    t = boot({ platform: 'MacIntel' });
    await t.openEditor();
    t.startAdd('tasks', 'tasks');
    const cases = [
      [{ key: 't', code: 'KeyT', metaKey: true }, /belongs to the browser.*Try ⌃⌘T\./],
      [{ key: 'w', code: 'KeyW', ctrlKey: true }, /Ctrl with a single key belongs to the browser/],
      [{ key: 'k', code: 'KeyK', ctrlKey: true }, /opens the search palette/],
      [{ key: 'k', code: 'KeyK', metaKey: true }, /⌘K opens the search palette/],
      [{ key: 't', code: 'KeyT', shiftKey: true }, /needs Ctrl, ⌘ or ⌥/],
      [{ key: 'F2', code: 'F2' }, /needs Ctrl/],
      [{ key: '†', code: 'KeyT', altKey: true }, /⌥ on its own types characters/],
      [{ key: 'Tab', code: 'Tab', ctrlKey: true, metaKey: true }, /Tab and Esc/],
      [{ key: 'f', code: 'KeyF', ctrlKey: true, metaKey: true }, /full screen/],
    ];
    for (const [init, re] of cases) {
      t.press(init);
      expect([init, t.msg().className, t.msg().textContent, t.addBtn().disabled, t.cap().getAttribute('aria-invalid')])
        .toEqual([init, 'ysc-msg ysc-refuse', expect.stringMatching(re), true, 'true']);
    }
    t.addBtn().disabled = false;                                          // even forced, the core refuses
    t.addBtn().click();
    expect(t.scRows()).toEqual([]);
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
  });

  test('Ctrl+Alt warns about AltGr (and can still be added); elsewhere the suggestion is Ctrl+Alt', async () => {
    t = boot({ platform: 'Win32' });
    await t.openEditor();
    t.startAdd('tasks', 'tasks');
    t.press({ key: 't', code: 'KeyT', ctrlKey: true });
    expect(t.msg().textContent).toMatch(/Ctrl with a single key.*Try Ctrl\+Alt\+T\./);
    t.press({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true });
    expect([t.msg().className, t.msg().textContent, t.addBtn().disabled]).toEqual(['ysc-msg ysc-warn', expect.stringMatching(/AltGr/), false]);
    t.press({ key: 't', code: 'KeyT', ctrlKey: true, metaKey: true });    // ⌃ + Win: no warning
    expect(t.msg().className).toBe('ysc-msg ysc-ok');
    t.press({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true });
    t.addBtn().click();
    expect(t.scRows()).toEqual([['Ctrl+Alt+T', 'Tasks', false]]);
  });

  test('a combo already bound is refused, naming the item that holds it', async () => {
    t = boot({ platform: 'MacIntel', shortcuts: { bindings: [B(['ctrl', 'meta'], 't', 'tasks')] } });
    await t.openEditor();
    t.startAdd('calendar', 'calendar');
    t.press(CMD_CTRL_T);
    expect([t.msg().textContent, t.addBtn().disabled]).toEqual(['⌃⌘T already opens Tasks.', true]);
    t.press({ ...CMD_CTRL_T, shiftKey: true, key: 'T' });                 // another modifier set is another combo
    expect(t.addBtn().disabled).toBe(false);
  });

  test('bindings to items not available now are listed as unavailable, kept on Save, and removable', async () => {
    const stored = { bindings: [B(['ctrl', 'meta'], 'v', 'moreViews'), B(['ctrl', 'meta'], 'g', 'firm:gone'), B(['ctrl', 'meta'], 'e', 'calendar')] };
    t = boot({ platform: 'MacIntel', shortcuts: stored });
    await t.openEditor();
    expect(t.scRows()).toEqual([['⌃⌘V', 'Views', true], ['⌃⌘G', 'firm:gone', true], ['⌃⌘E', 'Calendar', false]]);
    expect(t.scSec().querySelector('.yle-tag').textContent).toBe('Unavailable');
    t.startAdd('tasks', 'tasks');
    t.press(CMD_CTRL_T);
    t.addBtn().click();
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.server.puts[0].body.config.bindings.map((b) => b.id)).toEqual(['moreViews', 'firm:gone', 'calendar', 'tasks']);
    await t.openEditor();
    t.scSec().querySelectorAll('.ysc-row [data-act="sc-remove"]')[1].click();   // the firm:gone one
    expect(t.scRows().map((r) => r[1])).toEqual(['Views', 'Calendar', 'Tasks']);
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.server.puts[1].body.config.bindings.map((b) => b.id)).toEqual(['moreViews', 'calendar', 'tasks']);
  });

  test('both tabs dirty: Save writes both; one failing keeps every edit, says which, and what saved becomes stored', async () => {
    t = boot({ platform: 'MacIntel' });
    await t.openEditor('layout');
    const homeRow = (name) => [...t.panel().querySelectorAll('.yle-sec[data-sf="home"] .yle-rows > .yle-row')].find((li) => (li.querySelector('.yle-name') || {}).textContent === name);
    homeRow('Contacts').querySelector('[data-act="up"]').click();          // layout dirty
    t.panel().querySelector('.yle-tab[data-pane="shortcuts"]').click();
    t.startAdd('tasks', 'tasks');
    t.press(CMD_CTRL_T);
    t.addBtn().click();                                                    // shortcuts dirty
    t.server.fail.shortcuts = { status: 400, message: 'Invalid ui config', body: { status: 'error', errors: ['bindings[0].combo <b>refused</b>'] } };
    t.panel().querySelector('.yle-save').click();
    await t.flush(); await t.flush();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['layout', 'shortcuts']);
    expect(t.panel().hidden).toBe(false);
    const banner = t.panel().querySelector('.yle-banner').textContent;
    expect(banner).toMatch(/Your launcher layout was saved\. The server refused your keyboard shortcuts\. See the messages under Keyboard shortcuts\. Your changes are still here\./);
    expect([...t.scSec().querySelectorAll('.yle-errs li')].map((l) => l.textContent)).toEqual(['bindings[0].combo <b>refused</b>']);
    expect(t.scSec().querySelector('.yle-errs b')).toBe(null);
    expect(t.panel().querySelector('#ylePane_shortcuts').hidden).toBe(false);   // the failed part is on screen
    expect(t.scRows()).toEqual([['⌃⌘T', 'Tasks', false]]);                     // shortcut edit kept
    expect(t.w.firmData.ui.user.layout).toEqual(t.server.user.layout);         // the layout reached the shell
    expect(t.w.firmData.ui.user.layout.placed.home[0]).toEqual({ item: 'contacts' });
    expect(t.panel().querySelector('.yle-tab[data-pane="layout"] .yle-tab-dot').hidden).toBe(true);   // now stored: clean
    expect(t.panel().querySelector('.yle-tab[data-pane="shortcuts"] .yle-tab-dot').hidden).toBe(false);
    expect(t.w.ycLayoutEditor.isDirty()).toBe(true);
    // the next Save sends only what is still unsaved
    t.server.fail = {};
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.server.puts.map((p) => p.body.config_key)).toEqual(['layout', 'shortcuts', 'shortcuts']);
    expect(t.panel().hidden).toBe(true);
    t.key(t.d.body, CMD_CTRL_T);
    expect(t.tab()).toBe('tabTasks');
  });

  test('the layout failing and the shortcuts saving: the other way round', async () => {
    t = boot({ platform: 'MacIntel' });
    await t.openEditor('layout');
    t.panel().querySelector('.yle-sec[data-sf="home"] .yle-rows > .yle-row:nth-child(2) [data-act="up"]').click();
    t.panel().querySelector('.yle-tab[data-pane="shortcuts"]').click();
    t.startAdd('tasks', 'tasks');
    t.press(CMD_CTRL_T);
    t.addBtn().click();
    t.server.fail.layout = { status: 500, message: 'UI config request failed' };
    t.panel().querySelector('.yle-save').click();
    await t.flush(); await t.flush();
    expect(t.panel().querySelector('.yle-banner').textContent)
      .toBe('Your launcher layout did not save: UI config request failed. Your keyboard shortcuts were saved. Your changes are still here.');
    expect(t.panel().querySelector('#ylePane_layout').hidden).toBe(false);
    expect(t.w.firmData.ui.user.shortcuts).toEqual({ bindings: [B(['ctrl', 'meta'], 't', 'tasks')] });
    expect(t.w.firmData.ui.user.layout).toBeUndefined();
    expect(t.panel().querySelector('.yle-tab[data-pane="layout"] .yle-tab-dot').hidden).toBe(false);
    t.w.ycLayoutEditor.close();                                            // the dispatcher already has the saved shortcut
    await t.flush();
    t.key(t.d.body, CMD_CTRL_T);
    expect(t.tab()).toBe('tabTasks');
  });

  test('only shortcuts dirty and refused: the single-part wording', async () => {
    t = boot({ platform: 'MacIntel' });
    await t.openEditor();
    t.startAdd('tasks', 'tasks');
    t.press(CMD_CTRL_T);
    t.addBtn().click();
    t.server.fail.shortcuts = { status: 503, message: 'Service down' };
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.panel().querySelector('.yle-banner').textContent).toBe('Save failed: Service down. Your changes are still here.');
    expect(t.scRows()).toHaveLength(1);
  });

  test('escaping: a firm item label with markup stays text in the picker, the chosen line and the list', async () => {
    t = boot({ platform: 'MacIntel' });
    await t.openEditor();
    t.startAdd('pay', 'firm:payroll');
    expect(t.scSec().querySelector('.ysc-chosen-name').textContent).toBe(FIRM_URL.label);
    t.press({ key: 'p', code: 'KeyP', ctrlKey: true, metaKey: true });
    t.addBtn().click();
    expect(t.scRows()).toEqual([['⌃⌘P', FIRM_URL.label, false]]);
    expect(t.panel().querySelector('img')).toBe(null);
    expect(t.w.__pwn).toBeUndefined();
  });

  test('while a save is out, the tab takes no edits', async () => {
    t = boot({ platform: 'MacIntel', shortcuts: { bindings: [B(['ctrl', 'meta'], 'e', 'calendar')] } });
    await t.openEditor();
    t.startAdd('tasks', 'tasks');
    t.press(CMD_CTRL_T);
    t.addBtn().click();
    t.server.hold = true;
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    t.scSec().querySelector('.ysc-row [data-act="sc-remove"]').click();      // ignored
    t.scSec().querySelector('[data-act="sc-open"]').click();                 // ignored
    expect(t.scSec().querySelector('.ysc-add').hidden).toBe(true);
    t.server.release();
    await t.flush(); await t.flush();
    expect(t.server.puts[0].body.config.bindings.map((b) => b.id)).toEqual(['calendar', 'tasks']);
    expect(t.w.firmData.ui.user.shortcuts.bindings).toHaveLength(2);
  });

  test('Esc in the add box closes the box, not the editor; leaving with an unsaved shortcut asks first', async () => {
    t = boot({ platform: 'MacIntel' });
    await t.openEditor();
    t.startAdd('tasks', 'tasks');
    t.key(t.cap(), { key: 'Escape', code: 'Escape' });
    expect([t.scSec().querySelector('.ysc-add').hidden, t.panel().hidden]).toEqual([true, false]);
    t.startAdd('tasks', 'tasks');
    t.press(CMD_CTRL_T);
    t.key(t.cap(), { key: 'Enter', code: 'Enter' });                       // plain Enter adds
    expect(t.scRows()).toHaveLength(1);
    t.answer(false);
    t.panel().querySelector('.yle-cancel').click();
    await t.flush();
    expect([t.confirms.pop(), t.panel().hidden]).toEqual([expect.stringMatching(/Discard your unsaved launcher changes/), false]);
    const ev = new t.w.Event('beforeunload', { cancelable: true });
    t.w.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the shortcut session core (pure) — every document it writes passes the real validator', () => {
  const core = () => {
    const ctx = vm.createContext({ URL, console: { error: (m) => { throw new Error(String(m)); }, warn() {} } });
    ctx.window = ctx;
    vm.runInContext(ICON_SRC, ctx);
    vm.runInContext(REGISTRY_SRC, ctx);
    vm.runInContext(RENDERER_SRC, ctx);
    vm.runInContext(YCALL_SRC, ctx);
    vm.runInContext(EDITOR_SRC, ctx);
    return ctx.window;
  };
  const W = core();
  const eff = J(W.ycLauncher.computeEffective({ ...ACCESS, ui: { firm: { registry_overrides: RO } } }));
  const ids = eff.map((e) => e.id);

  test('random add / remove sequences: valid, no duplicate combos, refusals change nothing, ≤ 50', () => {
    let seed = 0xC0FFEE;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const keys = ['a', 'b', 't', 'k', '1', '/', 'F2', 'Space', 'Tab', 'ArrowLeft', 'f', 'q'];
    for (let run = 0; run < 60; run++) {
      const mac = run % 2 === 0;
      const s = W.ycLayoutEditor.shortcutSession({ stored: null, effective: eff, registry: W.FEATURE_REGISTRY, groups: [], keys: W.ycAll.keys, mac });
      for (let step = 0; step < 80; step++) {
        const before = JSON.stringify(s.doc());
        if (rnd(4) === 0 && s.list().length) {
          expect(s.remove(rnd(s.list().length))).toBe(true);
        } else {
          const c = C(MODS.filter(() => rnd(2)), keys[rnd(keys.length)]);
          const ok = s.add(ids[rnd(ids.length)], c);
          const r = s.check(c);
          if (!ok) expect(JSON.stringify(s.doc())).toBe(before);
          else expect(r.refuse).toBeUndefined();
          if (ok) expect(W.ycAll.keys.comboProblem(c)).toBe(null);
        }
        const doc = J(s.doc());
        const v = shape.validate('user', 'shortcuts', doc);
        expect([run, step, v.errors]).toEqual([run, step, []]);
        expect(shape.canonical(v.value)).toBe(shape.canonical(doc));
        expect(doc.bindings.length).toBeLessThanOrEqual(50);
      }
    }
  });

  test('isDirty is key-order-insensitive; an edit back to the stored list is clean', () => {
    const stored = { bindings: [{ id: 'tasks', combo: { key: 't', shift: false, alt: false, meta: true, ctrl: true } }] };
    const s = W.ycLayoutEditor.shortcutSession({ stored, effective: eff, registry: W.FEATURE_REGISTRY, keys: W.ycAll.keys, mac: true });
    expect(s.isDirty()).toBe(false);
    expect(s.remove(0)).toBe(true);
    expect(s.isDirty()).toBe(true);
    expect(s.add('tasks', C(['ctrl', 'meta'], 't'))).toBe(true);
    expect(s.isDirty()).toBe(false);
    expect(s.add('nope', C(['ctrl', 'meta'], 'y'))).toBe(false);          // not an effective item
  });
});
