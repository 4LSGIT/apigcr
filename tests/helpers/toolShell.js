// tests/helpers/toolShell.js
//
/**
 * The shell, for real, as far as a TOOL sees it (ui-custom S3.3): the launcher
 * (public/js/featureRegistry.js + the page's <script id="ycLauncher">), the
 * tool dialog AND the tool shell API (<script id="ycToolDialogJs">, which
 * defines window.openToolDialog and window.ycTool), the tab / drill-in /
 * custom-tab code, and the auth half the API delegates to — AUTH_STATE,
 * getJwtPayload, isJwtExpired and the shell's own apiSend, every one cut out
 * of public/index.html unmodified and run in jsdom.
 *
 * Stubbed, and recorded, because they are the shell's OTHER subsystems, not
 * what is under test: fetch (a scripted backend: `routes`), loginBlocking (the
 * blocking login — the thing quiet mode must never reach), elevateBlocking,
 * window.Toast (the scripts.js Swal toast mixin), addFile (the file opener —
 * the record keeps whether the tool dialog was still open at the call), and the
 * registry items' plain onclick openers.
 *
 * mountTool(html) puts a tool page into the OPEN dialog's own frame, as the
 * browser would after loading /tool/<key>: its body markup, then its inline
 * scripts run in that frame. Before they run, the frame's `parent` is swapped
 * for a recording proxy of the shell window (`parentReads`: every property the
 * tool read off its parent) and the frame gets a fake clock (`clock.tick(ms)`
 * runs its timers in order and settles promises between them).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { rawShellHtml } = require('./shellHtml');

const ROOT = path.join(__dirname, '..', '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');

function cut(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('toolShell: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const DIALOG_BLOCK = RAW.match(/<script id="ycToolDialogJs">[\s\S]*?<\/script>\s*<style>[\s\S]*?<\/style>/)[0];
const DENIED_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];
const DRILL_SRC = cut('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = cut('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const AUTH_SRC = cut('    // ---- Global auth state ----', "    /**\n     * The app's ONE auth transport.");
const APISEND_SRC = cut('    async function apiSend(endpoint', '\n\n    /**\n     * Multipart upload with progress');
const CUSTOM_SRC = cut('    function applyCustomTab(cfg) {', '    window.applyCustomTab = applyCustomTab;');
const CURRENT_SRC = cut('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** An unsigned JWT-shaped token; exp in seconds from now (negative = expired). */
function jwt(expInS, username = 'tester') {
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: 1, username, exp: Math.floor(Date.now() / 1000) + expInS })}.sig`;
}

function boot({ routes = {}, token = jwt(3600) } = {}) {
  const { FEATURE_REGISTRY: REG, DEFAULT_LAYOUTS: LAY } = (() => {
    const w = {};
    new Function('window', REGISTRY_SRC)(w);
    return w;
  })();
  const placed = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
  const grid = (sf) => placed(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabCustom']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabCustom', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${DENIED_CSS}${DIALOG_BLOCK}</head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><script>ycLauncher.mount('home')</script></div>
    <div id="tabAll" class="tab-main"></div>
    <div id="tabCustom" class="tab-main"><iframe id="tabCustomFrame"></iframe></div>
    ${plainTabs}
    <div id="tabMore" class="tab-main"><h1>More</h1><script>ycLauncher.mount('more')</script><div class="more-egg-row"></div>${grid('more')}</div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1><script>ycLauncher.mount('admin')</script>${grid('admin')}</div>
    <iframe id="paneFrame"></iframe>
  </body></html>`;
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.test/' });
  const w = dom.window;
  const rec = { login: 0, elevate: 0, fetch: [], toast: [], addFile: [], errors: [], warnings: [] };
  w.console.error = (...a) => rec.errors.push(a.map(String).join(' '));
  w.console.warn = (...a) => rec.warnings.push(a.map(String).join(' '));
  w.localStorage.setItem('jwt', token);
  w.__rec = rec;
  // The scripted backend. routes: { 'GET /clio-code': handler | body }, a
  // handler gets ({ method, path, headers, body }) and returns a body, or
  // { status, body }, or a Promise of either.
  w.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'https://app.test/');
    const req = { method: opts.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: opts.headers || {}, body: opts.body };
    rec.fetch.push(req);
    const h = routes[`${req.method} ${req.path}`];
    let out = typeof h === 'function' ? await h(req) : h;
    if (out === undefined) out = { status: 404, body: { error: 'no route' } };
    const shaped = out && typeof out === 'object' && Object.prototype.hasOwnProperty.call(out, 'status') && Object.prototype.hasOwnProperty.call(out, 'body')
      ? out : { status: 200, body: out };
    const res = {
      status: shaped.status, ok: shaped.status >= 200 && shaped.status < 300, statusText: '',
      json: async () => shaped.body, text: async () => JSON.stringify(shaped.body),
    };
    res.clone = () => res;
    return res;
  };
  w.eval(`
    var E = (id) => document.getElementById(id);
    function syncWorkspaceUrl() {}
    function pingBecameVisible() {}
    function getSuElevToken() { return null; }
    async function elevateBlocking() { __rec.elevate++; return null; }
    async function loginBlocking() { __rec.login++; AUTH_STATE.jwt = ${JSON.stringify(jwt(3600, 'relogged'))}; }
    window.Toast = { fire: (o) => { __rec.toast.push(o); return Promise.resolve({}); } };
    function addFile(name, type, id) {
      __rec.addFile.push({ name, type, id, dialogOpen: openToolDialog.isOpen() });
      return 'file-div1';
    }
  `);
  const stubs = new Set();
  let stubSrc = '';
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + AUTH_SRC + APISEND_SRC + CUSTOM_SRC + DRILL_SRC);
  const d = w.document;
  const dlg = () => d.getElementById('ycToolDialog');
  const dlgOpen = () => !!dlg() && !dlg().hidden;
  // jsdom does not load an iframe's src: the dialog's frame starts with an
  // empty document. Give it the skeleton the real /tool/<key> page would.
  const dlgFrame = () => {
    const f = dlgOpen() ? dlg().querySelector('iframe.yc-td-frame') : null;
    if (f && !f.contentWindow.document.body) {
      const fd = f.contentWindow.document;
      fd.open(); fd.write('<!DOCTYPE html><html><head></head><body></body></html>'); fd.close();
    }
    return f;
  };
  const shown = (el) => w.getComputedStyle(el).display !== 'none';

  /** Settle promises (a few event-loop turns: apiSend awaits several times). */
  const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

  /** A tool page into the open dialog's frame (see the header). */
  function mountTool(html, { start = Date.parse('2026-10-15T15:00:00Z'), noShell = false } = {}) {
    const f = dlgFrame();
    if (!f) throw new Error('mountTool: no open tool dialog');
    const fw = f.contentWindow;
    const parentReads = [];
    const px = new Proxy(w, { get(t, k) { parentReads.push(String(k)); return Reflect.get(t, k); } });
    // noShell: the page as if opened in a tab of its own (parent === itself)
    Object.defineProperty(fw, 'parent', { get: () => (noShell ? fw : px), configurable: true });
    // the fake clock
    let now = start, seq = 1;
    const timers = new Map();
    fw.Date.now = () => now;
    fw.setTimeout = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + (ms || 0), every: 0 }); return id; };
    fw.setInterval = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + ms, every: ms }); return id; };
    fw.clearTimeout = fw.clearInterval = (id) => { timers.delete(id); };
    const clock = {
      now: () => now,
      pending: () => timers.size,
      async tick(ms) {
        const end = now + ms;
        for (;;) {
          let next = null;
          for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
          if (!next) break;
          const [id, t] = next;
          now = t.at;
          if (t.every) t.at += t.every; else timers.delete(id);
          t.fn();
          await settle();
        }
        now = end;
        await settle();
      },
    };
    const log = [];                       // the page's own console.warn / console.error
    fw.console.warn = (...a) => log.push('warn: ' + a.map(String).join(' '));
    fw.console.error = (...a) => log.push('error: ' + a.map(String).join(' '));
    const copied = [];
    Object.defineProperty(fw.navigator, 'clipboard', { configurable: true, value: { writeText: async (v) => { copied.push(v); } } });
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)[1];
    const scripts = [];
    fw.document.body.innerHTML = body.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, js) => { scripts.push(js); return ''; });
    const headStyle = /<style>([\s\S]*?)<\/style>/i.exec(html);
    if (headStyle) { const s = fw.document.createElement('style'); s.textContent = headStyle[1]; fw.document.head.appendChild(s); }
    for (const js of scripts) fw.eval(js);
    return { fw, fd: fw.document, parentReads, clock, copied, log };
  }

  return {
    w, d, L: w.ycLauncher, T: w.ycTool, REG, LAY, rec, dlg, dlgOpen, dlgFrame, shown, settle, mountTool,
    pane: () => d.getElementById('paneFrame').contentWindow,
    close: () => w.close(),
  };
}

module.exports = { boot, jwt, RAW, REGISTRY_SRC, RENDERER_SRC };
