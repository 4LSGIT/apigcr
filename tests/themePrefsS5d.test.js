// tests/themePrefsS5d.test.js
//
/**
 * ui-custom S5d — the theme follows the user (prefs roaming).
 *
 *   1. THE STORAGE GRAMMAR (lib/uiConfigShape.js, user config_key 'prefs'):
 *      { theme: { mode?, vars? } }, vars being exactly the yc-theme-vars blob
 *      public/themeCustom.html writes. Every value theme.css ships and every
 *      preset / density value the page can write is accepted; injection-shaped
 *      values (url(, expression(, ;, }, <, escapes, …) are refused; names are
 *      theme.css tokens (a well-formed non-token drops); caps refuse before
 *      iterating. The token set is pinned to a real CSSOM walk of theme.css
 *      (the way themeCustom.html reads it), and the client copy of the value
 *      grammar (public/index.html ycThemePrefs.valueOk) agrees with the server
 *      over one matrix.
 *   2. THE BOOT APPLY, run for real in jsdom: the shell's own theme section,
 *      auth state, apiSend and ycTool (<script id="ycToolDialogJs">), cut out
 *      of public/index.html unmodified, plus the real public/themeSync.js in
 *      the shell AND in a pane frame. The account beats localStorage (cache
 *      written, applied in the shell, the pane follows on themeSync.js's own
 *      storage / top-observer paths); an equal account writes nothing; no row
 *      leaves the device's theme alone and uploads it once — only after
 *      GET /api/ui-config confirms there is no row; no session never prompts.
 *      initAuth runs adopt with firmData.ui before loadUserContext.
 *   3. THE WRITE-THROUGH: toggleTheme and themeCustom.html (its real script in
 *      the pane) — debounced to one PUT of the whole cache, never blocking,
 *      quiet on failure (a console warning, no login), legacy values the server
 *      would refuse pruned; themeCustom.html refuses such a value at entry.
 *      The Advanced tab is driven through its OWN inputs (theme.css linked in
 *      the frame): its inline handlers once called write(), which an inline
 *      handler resolves to document.write — every edit blanked the page.
 *
 *   4. FIX ROUND (review F1 / F2 / F5): no value shape backtracks
 *      super-linearly (a timed adversarial matrix — an optional colour-function
 *      separator made one 52 KB body cost ~5 s); a change made before adopt has
 *      settled is held, and a pending one is dropped when adopt runs, so it can
 *      never overwrite the account; a stock device never claims an empty account.
 *
 * Mutation-checked (see local/ui-custom/S5d_worker_report.md).
 *
 * Run:  npx jest tests/themePrefsS5d.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, ResourceLoader } = require('jsdom');
const shape = require('../lib/uiConfigShape');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const THEME_CSS = fs.readFileSync(path.join(ROOT, 'public/theme.css'), 'utf8');
const THEME_SYNC = fs.readFileSync(path.join(ROOT, 'public/themeSync.js'), 'utf8');
const CUSTOM_PAGE = fs.readFileSync(path.join(ROOT, 'public/themeCustom.html'), 'utf8');

function cut(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('themePrefsS5d: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const PREPAINT_SRC = RAW.match(/<head>\s*<!-- THEME PRE-PAINT[\s\S]*?-->\s*<script>([\s\S]*?)<\/script>/)[1];
const DIALOG_BLOCK = RAW.match(/<script id="ycToolDialogJs">[\s\S]*?<\/script>\s*<style>[\s\S]*?<\/style>/)[0];
const AUTH_SRC = cut('    // ---- Global auth state ----', "    /**\n     * The app's ONE auth transport.");
const APISEND_SRC = cut('    async function apiSend(endpoint', '\n\n    /**\n     * Multipart upload with progress');
const THEME_SRC = cut('    // ============ DARK MODE ============', '    // Restore sidebar state + theme on page load');
const INITAUTH_SRC = cut('async function initAuth() {', '    async function loadUserContext() {');
const CUSTOM_SCRIPT = CUSTOM_PAGE.match(/<script>\s*\/\* ═+\s*\n\s*Theme customization([\s\S]*?)<\/script>/)[0]
  .replace(/^<script>/, '').replace(/<\/script>$/, '');
const CUSTOM_BODY = CUSTOM_PAGE.match(/<body[^>]*>([\s\S]*?)<script>\s*\/\* ═/)[1];

// PRESETS / DENSITY lifted the way scripts/checkThemePresets.js lifts them.
function lift(name) {
  const m = new RegExp('const ' + name + ' = ([\\[{][\\s\\S]*?\\n[\\]}]);').exec(CUSTOM_PAGE);
  if (!m) throw new Error('could not lift ' + name);
  return vm.runInNewContext('(' + m[1] + ')');
}
const PRESETS = lift('PRESETS');
const DENSITY = lift('DENSITY');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expInS) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: 1, username: 'tester', exp: Math.floor(Date.now() / 1000) + expInS })}.sig`;
const J = (x) => JSON.parse(JSON.stringify(x));
const P = (theme) => shape.validate('user', 'prefs', { theme });
const errs = (r) => r.errors.join(' | ');
const VARS = (o = {}) => ({ v: 1, preset: null, density: null, light: {}, dark: {}, ...o });

// theme.css read through a real CSSOM, the way themeCustom.html's readStock does.
const CSSOM_STOCK = (() => {
  const dom = new JSDOM(`<!DOCTYPE html><html><head><style>${THEME_CSS}</style></head></html>`);
  const out = {};
  for (const r of dom.window.document.styleSheets[0].cssRules) {
    if (!r.style || !r.selectorText) continue;
    const sel = r.selectorText.replace(/\s+/g, '').replace(/["']/g, '');
    const slot = sel === ':root' ? 'light' : sel === 'html[data-theme=dark]' ? 'dark' : null;
    if (!slot) continue;
    for (let i = 0; i < r.style.length; i++) {
      const n = r.style[i];
      if (n.startsWith('--')) (out[n] = out[n] || {})[slot] = r.style.getPropertyValue(n).trim();
    }
  }
  dom.window.close();
  return out;
})();
const STOCK_VALUES = Object.values(CSSOM_STOCK).flatMap((s) => Object.values(s));
const PAGE_VALUES = [
  ...Object.values(PRESETS).flatMap((p) => [...Object.values(p.light), ...Object.values(p.dark)]),
  ...Object.values(DENSITY).flatMap((d) => Object.values(d)),
];

// The client copy: the shell's theme section in a bare vm.
const CLIENT = (() => {
  const ctx = vm.createContext({ console: { warn() {} }, document: { documentElement: { getAttribute: () => 'light' } } });
  ctx.window = ctx;
  vm.runInContext(THEME_SRC, ctx);
  return ctx.window.ycThemePrefs;
})();

const INJECTIONS = [
  'url(https://evil.example/x.png)', 'url(x)', 'URL(x)', 'red; background: url(x)', 'red;', '#fff;',
  'expression(alert(1))', 'red}body{color:red', '}', '{', '<script>', '</style>', 'a<b', 'a>b',
  '\\75rl(x)', 'r\\65 d', 'red !important', '@import "x"', '/* c */', 'attr(title)', 'image-set("x" 1x)',
  'var(--x, url(y))', 'var(--x,red)', '"a;b"', "'a}b'", '"<b>"', 'calc(1px + 2px)', 'color-mix(in srgb, red, blue)',
  'element(#x)', 'javascript:alert(1)', 'red\n', 'red\u0000', ' ', 'a`b', 'a=b', 'a:b', '--x', '#fffg', '12pxx',
  '2px0', 'rgb(0,0)', 'rgb(a,b,c)', 'rgb(1,2,3,4,5)', '',
];
const ACCEPTS = [
  '#4ea6e2', '#FFF', '#ffff', '#11223344', 'rgba(7, 173, 239, 0.12)', 'rgb(0 0 0 / 40%)', 'hsl(200deg 50% 50%)',
  'hsla(200, 50%, 50%, .5)', 'var(--ok)', 'var( --accent )', '12.5px', '-1px', '0', '.5', '1.25rem', '110%', '7px 12px',
  '0 1px 3px rgba(0, 0, 0, 0.05)', '2px 0 12px rgba(0, 0, 0, 0.5)', 'Georgia, serif', 'transparent', 'white',
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  "ui-monospace, 'SF Mono', monospace", '1px solid #ccc', '16px/1.4',
];

// ─────────────────────────────────────────────────────────────────────────
describe('the prefs grammar (lib/uiConfigShape.js)', () => {
  test('prefs is a USER key: the PUT envelope takes it for scope user, not firm', () => {
    expect(shape.CONFIG_KEYS.user).toContain('prefs');
    expect(shape.validateWrite({ scope: 'user', config_key: 'prefs', config: { theme: { mode: 'dark' } } }).ok).toBe(true);
    expect(errs(shape.validateWrite({ scope: 'firm', config_key: 'prefs', config: {} }))).toMatch(/config_key for scope firm/);
  });

  test('a full document normalizes to itself; absent keys stay absent; preset / density absent → null, modes absent → {}', () => {
    const doc = { mode: 'dark', vars: VARS({ preset: 'warm-paper', density: 'compact', light: { '--accent': '#c9782f' }, dark: { '--fs': '12.5px' } }) };
    expect(P(doc)).toEqual({ ok: true, errors: [], value: { theme: doc } });
    expect(shape.validate('user', 'prefs', {}).value).toEqual({});
    expect(P({}).value).toEqual({ theme: {} });
    expect(P({ mode: 'light' }).value).toEqual({ theme: { mode: 'light' } });
    expect(P({ vars: { v: 1 } }).value).toEqual({ theme: { vars: VARS() } });
  });

  test.each([
    [{ mode: 'Dark' }, /theme\.mode must be "light" or "dark"/],
    [{ mode: null }, /theme\.mode must be/],
    [{ colour: 'x' }, /theme: unknown field "colour"/],
    [{ vars: [] }, /theme\.vars must be an object/],
    [{ vars: { light: {} } }, /theme\.vars\.v must be 1/],
    [{ vars: { v: 2 } }, /theme\.vars\.v must be 1/],
    [{ vars: VARS({ extra: 1 }) }, /theme\.vars: unknown field "extra"/],
    [{ vars: VARS({ preset: 'Warm Paper' }) }, /theme\.vars\.preset must be null or a name/],
    [{ vars: VARS({ density: 3 }) }, /theme\.vars\.density must be null or a name/],
    [{ vars: VARS({ light: [] }) }, /theme\.vars\.light must be an object/],
    [{ vars: VARS({ dark: { accent: '#fff' } }) }, /theme\.vars\.dark: "accent" is not a token name/],
    [{ vars: VARS({ dark: { '--a;b': '#fff' } }) }, /is not a token name/],
    [{ vars: VARS({ light: { '--accent': 12 } }) }, /theme\.vars\.light\.--accent must be a non-empty string/],
  ])('refused: %j', (theme, re) => {
    const r = P(theme);
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(re);
  });

  test('strict at the top: prefs takes only theme; theme must be an object', () => {
    expect(errs(shape.validate('user', 'prefs', { theme: {}, layout: {} }))).toMatch(/prefs: unknown field "layout"/);
    expect(errs(shape.validate('user', 'prefs', { theme: 'dark' }))).toMatch(/theme must be an object/);
  });

  test('a well-formed name that is not a theme.css token DROPS (soft ref); the rest of the document stands', () => {
    const r = P({ vars: VARS({ light: { '--accent': '#123456', '--retired-token': '#fff' } }) });
    expect(r.ok).toBe(true);
    expect(r.value.theme.vars.light).toEqual({ '--accent': '#123456' });
  });

  test.each(INJECTIONS.map((v) => [v]))('injection-shaped value %j is refused', (v) => {
    expect(shape.themeValueProblem(v)).not.toBeNull();
    const r = P({ vars: VARS({ light: { '--accent': v } }) });
    expect(r.ok).toBe(false);
    expect(errs(r)).toMatch(/theme\.vars\.light\.--accent /);
  });

  test.each(ACCEPTS.map((v) => [v]))('ordinary value %j is accepted', (v) => {
    expect(shape.themeValueProblem(v)).toBeNull();
  });

  test('every value theme.css ships and every preset / density value themeCustom.html writes is accepted', () => {
    expect(STOCK_VALUES.length).toBeGreaterThan(80);
    expect(PAGE_VALUES.length).toBeGreaterThan(60);
    const bad = [...STOCK_VALUES, ...PAGE_VALUES].filter((v) => shape.themeValueProblem(v) !== null);
    expect(bad).toEqual([]);
  });

  test('every store the page can build from its cards (palette × density, as applyPreset / applyDensity do) validates unchanged', () => {
    for (const p of [null, ...Object.keys(PRESETS)]) {
      for (const d of [null, ...Object.keys(DENSITY)]) {
        const store = VARS({ preset: p, density: d });
        for (const m of ['light', 'dark']) Object.assign(store[m], p ? PRESETS[p][m] : {}, d ? DENSITY[d] : {});
        const r = P({ mode: 'dark', vars: store });
        expect(r.ok).toBe(true);
        expect(r.value.theme.vars).toEqual(store);
      }
    }
  });

  test('the token set is theme.css read through a real CSSOM (the way themeCustom.html reads it)', () => {
    expect(shape.THEME_TOKENS.slice()).toEqual(Object.keys(CSSOM_STOCK).sort());
    expect(Object.isFrozen(shape.THEME_TOKENS)).toBe(true);
  });

  test('caps: over THEME_VARS_MAX names is refused at the cap, before any entry is looked at; a value over THEME_VALUE_MAX is refused', () => {
    const many = {};
    for (let i = 0; i < 60000; i++) many['--t' + i] = 'url(x)';
    const t0 = Date.now();
    const r = P({ vars: VARS({ dark: many }) });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.errors).toEqual([`theme.vars.dark: at most ${shape.THEME_VARS_MAX} entries`]);
    const atCap = {};
    for (let i = 0; i < shape.THEME_VARS_MAX; i++) atCap['--t' + i] = '1px';
    expect(P({ vars: VARS({ dark: atCap }) }).ok).toBe(true);
    expect(shape.THEME_VALUE_MAX).toBe(120);
    const v120 = '10px ' + '1px '.repeat(28) + '1px';
    expect(v120.length).toBe(120);
    expect(shape.themeValueProblem(v120)).toBeNull();
    expect(shape.themeValueProblem(v120 + '0')).toMatch(/longer than 120/);
    expect(shape.themeValueProblem(' 1px')).toMatch(/space/);
    expect(shape.themeValueProblem('1px ')).toMatch(/space/);
  });

  test('the client copy (ycThemePrefs.valueOk) agrees with the server over one matrix', () => {
    const v120 = '10px ' + '1px '.repeat(28) + '1px';
    const matrix = [...INJECTIONS, ...ACCEPTS, ...STOCK_VALUES, ...PAGE_VALUES, ' 1px', '1px ', v120, v120 + '0', 'a'.repeat(41), 'a'.repeat(42),
      null, 12, undefined, {}];
    const diff = matrix.filter((v) => CLIENT.valueOk(v) !== (shape.themeValueProblem(v) === null));
    expect(diff).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The shell harness: pre-paint script, themeSync.js, ycTool, auth + apiSend,
// the theme section — all real; fetch scripted, loginBlocking recorded.
// ready: adopt has already settled (an account row with no theme) — the state
// every write-through runs in after boot (S5d fix round F2: before it, they are held).
function boot({ local = {}, token = jwt(3600), routes = {}, ready = false } = {}) {
  // Serves theme.css only, so a frame can link it and themeCustom.html's
  // readStock finds its tokens in the CSSOM (it matches the sheet by href).
  class CssOnly extends ResourceLoader {
    fetch(url, opts) { return /\/theme\.css$/.test(url) ? Promise.resolve(Buffer.from(THEME_CSS)) : null; }
  }
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body><i id="themeIcon" class="fa-solid fa-moon"></i><iframe id="pane"></iframe></body></html>`,
    { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.test/', resources: new CssOnly() });
  const w = dom.window;
  const rec = { login: 0, fetch: [], warnings: [], errors: [], toast: [], setItem: [] };
  w.console.warn = (...a) => rec.warnings.push(a.map(String).join(' '));
  w.console.error = (...a) => rec.errors.push(a.map(String).join(' '));
  if (token) w.localStorage.setItem('jwt', token);
  for (const [k, v] of Object.entries(local)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  const realSet = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (k, v) { rec.setItem.push(k); return realSet.call(this, k, v); };
  // a fake clock for the shell (the debounce)
  let now = 0, seq = 1;
  const timers = new Map();
  w.setTimeout = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + (ms || 0) }); return id; };
  w.clearTimeout = (id) => { timers.delete(id); };
  w.__rec = rec;
  w.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'https://app.test/');
    const req = { method: opts.method || 'GET', path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null };
    rec.fetch.push(req);
    const h = routes[`${req.method} ${req.path}`];
    let out = typeof h === 'function' ? await h(req) : h;
    if (out === undefined) out = { status: 404, body: { error: 'no route' } };
    const own = (k) => Object.prototype.hasOwnProperty.call(out, k);
    const shaped = out && own('status') && own('body') ? out : { status: 200, body: out };
    const res = { status: shaped.status, ok: shaped.status < 300, statusText: '', headers: { get: () => null },
      json: async () => shaped.body, text: async () => JSON.stringify(shaped.body) };
    res.clone = () => res;
    return res;
  };
  const run = (src) => { const s = w.document.createElement('script'); s.textContent = src; w.document.head.appendChild(s); };
  run(PREPAINT_SRC);
  run(THEME_SYNC);
  const host = w.document.createElement('div');
  host.innerHTML = DIALOG_BLOCK;
  for (const node of [...host.childNodes]) {
    if (node.nodeName === 'SCRIPT') run(node.textContent); else w.document.head.appendChild(node);
  }
  w.eval(`
    function getSuElevToken() { return null; }
    async function elevateBlocking() { return null; }
    async function loginBlocking() { __rec.login++; }
    window.Toast = { fire: (o) => { __rec.toast.push(o); return Promise.resolve({}); } };
    window.firmData = { ui: { firm: {}, user: {} } };
  `);
  w.eval(AUTH_SRC + APISEND_SRC);
  run(THEME_SRC);
  if (ready) w.ycThemePrefs.adopt({ firm: {}, user: { prefs: {} } });
  // the pane: about:blank, same origin, with the real themeSync.js
  const fw = w.document.getElementById('pane').contentWindow;
  const paneSet = fw.Storage.prototype.setItem;
  fw.Storage.prototype.setItem = function (k, v) { rec.setItem.push('pane:' + k); return paneSet.call(this, k, v); };
  const fs1 = fw.document.createElement('script');
  fs1.textContent = THEME_SYNC;
  fw.document.head.appendChild(fs1);
  const paneEvents = { vars: 0 };
  fw.addEventListener('yc-theme-vars', () => paneEvents.vars++);
  const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  const clock = {
    pending: () => timers.size,
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
  const html = w.document.documentElement;
  return {
    w, fw, rec, clock, settle, paneEvents,
    T: w.ycThemePrefs,
    theme: () => html.getAttribute('data-theme'),
    accent: () => html.style.getPropertyValue('--accent'),
    paneTheme: () => fw.document.documentElement.getAttribute('data-theme'),
    paneAccent: () => fw.document.documentElement.style.getPropertyValue('--accent'),
    ls: (k) => w.localStorage.getItem(k),
    puts: () => rec.fetch.filter((f) => f.method === 'PUT'),
    close: () => w.close(),
  };
}

const LOCAL = { 'yc-theme': 'light', 'yc-theme-vars': VARS({ preset: null, light: { '--accent': '#aa0000' }, dark: { '--accent': '#aa0000' } }) };
const ACCOUNT = { theme: { mode: 'dark', vars: VARS({ preset: 'square', light: { '--accent': '#0000bb', '--radius': '2px' }, dark: { '--accent': '#0000bb', '--radius': '2px' } }) } };
const savedPut = (req) => ({ status: 'success', scope: 'user', config_key: 'prefs', config: shape.validate('user', 'prefs', req.body.config).value, changed: true });

describe('boot: the account beats this device', () => {
  let t;
  afterEach(() => t && t.close());

  test('the device starts on its cache (pre-paint + themeSync), then adopt writes the account into it, applies it, and the pane follows', async () => {
    t = boot({ local: LOCAL });
    await t.settle();
    expect(t.theme()).toBe('light');
    expect(t.accent()).toBe('#aa0000');
    expect(t.paneAccent()).toBe('#aa0000');
    const before = t.paneEvents.vars;

    const got = await t.T.adopt({ firm: {}, user: { prefs: J(ACCOUNT) } });
    await t.settle();
    expect(got).toBe('account');
    expect(t.ls('yc-theme')).toBe('dark');
    expect(JSON.parse(t.ls('yc-theme-vars'))).toEqual(ACCOUNT.theme.vars);
    expect(t.theme()).toBe('dark');
    expect(t.accent()).toBe('#0000bb');
    expect(t.w.document.documentElement.style.getPropertyValue('--radius')).toBe('2px');
    expect(t.w.document.getElementById('themeIcon').className).toBe('fa-solid fa-sun');
    // the pane: the storage event (vars) and the top-window observer (mode)
    expect(t.paneTheme()).toBe('dark');
    expect(t.paneAccent()).toBe('#0000bb');
    expect(t.paneEvents.vars).toBeGreaterThan(before);
    // and nothing went back up: the account was the source
    expect(t.rec.fetch).toEqual([]);
    expect(t.clock.pending()).toBe(0);
  });

  test('vars only (same mode): still applied in the shell itself, not just in the panes', async () => {
    t = boot({ local: { ...LOCAL, 'yc-theme': 'dark' } });
    await t.T.adopt({ user: { prefs: J(ACCOUNT) } });
    await t.settle();
    expect(t.theme()).toBe('dark');
    expect(t.accent()).toBe('#0000bb');
    expect(t.paneAccent()).toBe('#0000bb');
  });

  test('mode only: a theme with no vars leaves the cached vars alone', async () => {
    t = boot({ local: LOCAL });
    await t.T.adopt({ user: { prefs: { theme: { mode: 'dark' } } } });
    await t.settle();
    expect(t.theme()).toBe('dark');
    expect(JSON.parse(t.ls('yc-theme-vars'))).toEqual(LOCAL['yc-theme-vars']);
    expect(t.accent()).toBe('#aa0000');
  });

  test('an account equal to the cache (keys in MySQL\'s order, not ours) writes nothing', async () => {
    t = boot({ local: { 'yc-theme': 'dark', 'yc-theme-vars': ACCOUNT.theme.vars } });
    await t.settle();
    t.rec.setItem.length = 0;
    const mysqlOrder = { theme: { vars: { dark: ACCOUNT.theme.vars.dark, light: ACCOUNT.theme.vars.light, density: null, preset: 'square', v: 1 }, mode: 'dark' } };
    const before = t.paneEvents.vars;
    await t.T.adopt({ user: { prefs: mysqlOrder } });
    await t.settle();
    expect(t.rec.setItem).toEqual([]);
    expect(t.paneEvents.vars).toBe(before);
    expect(t.rec.fetch).toEqual([]);
  });

  test('a prefs row without a theme changes nothing and uploads nothing', async () => {
    t = boot({ local: LOCAL });
    t.rec.setItem.length = 0;
    await t.T.adopt({ user: { prefs: {} } });
    await t.settle();
    expect(t.rec.setItem).toEqual([]);
    expect(t.rec.fetch).toEqual([]);
    expect(t.theme()).toBe('light');
  });
});

describe('boot: no account row yet (first roll-out)', () => {
  let t;
  afterEach(() => t && t.close());

  test('GET /api/ui-config confirms no row → the device theme is NOT touched and is uploaded once as the account\'s first value', async () => {
    t = boot({ local: LOCAL, routes: { 'GET /api/ui-config': { status: 'success', firm: {}, user: {} }, 'PUT /api/ui-config': savedPut } });
    t.rec.setItem.length = 0;
    const got = await t.T.adopt({ firm: {}, user: {} });
    await t.settle();
    expect(got).toBe('uploaded');
    expect(t.rec.setItem).toEqual([]);
    expect(t.theme()).toBe('light');
    expect(t.accent()).toBe('#aa0000');
    expect(t.rec.fetch.map((f) => `${f.method} ${f.path}`)).toEqual(['GET /api/ui-config', 'PUT /api/ui-config']);
    const body = t.puts()[0].body;
    expect(body).toEqual({ scope: 'user', config_key: 'prefs', config: { theme: { mode: 'light', vars: LOCAL['yc-theme-vars'] } } });
    expect(shape.validateWrite(body).ok).toBe(true);
    expect(t.w.firmData.ui.user.prefs).toEqual({ theme: { mode: 'light', vars: LOCAL['yc-theme-vars'] } });
    expect(t.rec.login).toBe(0);
  });

  test('a dark device with no overrides uploads its mode and an empty store', async () => {
    t = boot({ local: { 'yc-theme': 'dark' }, routes: { 'GET /api/ui-config': { status: 'success', firm: {}, user: {} }, 'PUT /api/ui-config': savedPut } });
    await t.T.adopt({ firm: {}, user: {} });
    await t.settle();
    expect(t.puts()[0].body.config).toEqual({ theme: { mode: 'dark', vars: VARS() } });
    expect(t.ls('yc-theme-vars')).toBeNull();
  });

  test('firm-data said "no row" but GET finds one (a fail-soft read) → the account is applied, nothing uploaded', async () => {
    t = boot({ local: LOCAL, routes: { 'GET /api/ui-config': { status: 'success', firm: {}, user: { prefs: J(ACCOUNT) } } } });
    const got = await t.T.adopt({ firm: {}, user: {} });
    await t.settle();
    expect(got).toBe('account');
    expect(t.theme()).toBe('dark');
    expect(t.accent()).toBe('#0000bb');
    expect(t.puts()).toEqual([]);
  });

  test('GET fails → nothing is uploaded and the device theme stands (a failed read never overwrites the account)', async () => {
    t = boot({ local: LOCAL, routes: { 'GET /api/ui-config': { status: 500, body: { status: 'error', message: 'db down' } } } });
    t.rec.setItem.length = 0;
    const got = await t.T.adopt({ firm: {}, user: {} });
    await t.settle();
    expect(got).toBe('failed');
    expect(t.puts()).toEqual([]);
    expect(t.rec.setItem).toEqual([]);
    expect(t.theme()).toBe('light');
    expect(t.rec.warnings.join('\n')).toMatch(/\[theme\] the account theme was not read/);
  });

  test('no session → no login prompt, no request, nothing changed', async () => {
    t = boot({ local: LOCAL, token: jwt(-60) });
    const got = await t.T.adopt({ firm: {}, user: {} });
    await t.settle();
    expect(got).toBe('failed');
    expect(t.rec.login).toBe(0);
    expect(t.rec.fetch).toEqual([]);
    expect(t.theme()).toBe('light');
  });
});

describe('initAuth runs the boot apply', () => {
  test('after loadFirmData, with firmData.ui, before loadUserContext; a throwing adopt does not stop the boot', async () => {
    const order = [];
    const ctx = {
      AUTH_STATE: { jwt: 'x' }, isJwtExpired: () => false, loginBlocking: async () => {},
      Toast: { fire() {} }, localStorage: { removeItem() {} }, console: { warn: (...a) => order.push('warn ' + a.join(' ')) },
      loadFirmData: async () => { order.push('loadFirmData'); ctx.window.firmData = { currentUser: { user: 1 }, users: [], ui: { firm: {}, user: { prefs: { theme: { mode: 'dark' } } } } }; },
      loadUserContext: () => order.push('loadUserContext'),
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext('var user, users;\n' + INITAUTH_SRC, ctx);
    ctx.window.ycThemePrefs = { adopt: (ui) => { order.push('adopt ' + JSON.stringify(ui.user)); return Promise.resolve('account'); } };
    await ctx.initAuth();
    expect(order).toEqual(['loadFirmData', 'adopt {"prefs":{"theme":{"mode":"dark"}}}', 'loadUserContext']);

    order.length = 0;
    ctx.window.ycThemePrefs = { adopt: () => { throw new Error('boom'); } };
    await ctx.initAuth();
    expect(order).toEqual(['loadFirmData', 'warn [theme] adopt failed: Error: boom', 'loadUserContext']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('write-through: toggleTheme', () => {
  let t;
  afterEach(() => t && t.close());

  test('a burst of toggles is ONE debounced PUT of the final state; the toggle itself never waits on the network', async () => {
    t = boot({ ready: true, local: LOCAL, routes: { 'PUT /api/ui-config': savedPut } });
    t.w.toggleTheme();
    expect(t.theme()).toBe('dark');                    // applied synchronously
    t.w.toggleTheme();
    t.w.toggleTheme();
    expect(t.theme()).toBe('dark');
    await t.settle();
    expect(t.rec.fetch).toEqual([]);                   // nothing yet
    await t.clock.tick(999);
    expect(t.rec.fetch).toEqual([]);
    await t.clock.tick(1);
    expect(t.puts().length).toBe(1);
    expect(t.puts()[0].body).toEqual({ scope: 'user', config_key: 'prefs', config: { theme: { mode: 'dark', vars: LOCAL['yc-theme-vars'] } } });
    expect(t.w.firmData.ui.user.prefs.theme.mode).toBe('dark');
    await t.clock.tick(5000);
    expect(t.puts().length).toBe(1);
  });

  test('a failed PUT is a console warning — no throw, no toast, no login', async () => {
    t = boot({ ready: true, local: LOCAL, routes: { 'PUT /api/ui-config': { status: 500, body: { status: 'error', message: 'nope' } } } });
    t.w.toggleTheme();
    await t.clock.tick(1000);
    expect(t.puts().length).toBe(1);
    expect(t.rec.warnings.join('\n')).toMatch(/\[theme\] not saved to your account/);
    expect(t.rec.login).toBe(0);
    expect(t.rec.toast).toEqual([]);
    expect(t.rec.errors).toEqual([]);
    expect(t.theme()).toBe('dark');                    // the local change stands
  });

  test('no session (expired) → quiet: no login prompt, no request, a warning; the toggle still applies', async () => {
    t = boot({ ready: true, local: LOCAL, token: jwt(-60), routes: { 'PUT /api/ui-config': savedPut } });
    t.w.toggleTheme();
    expect(t.theme()).toBe('dark');
    await t.clock.tick(1000);
    expect(t.rec.login).toBe(0);
    expect(t.rec.fetch).toEqual([]);
    expect(t.rec.warnings.join('\n')).toMatch(/\[theme\] not saved to your account/);
  });

  test('a legacy cached value the server would refuse is left out of the PUT; the rest still roams', async () => {
    const dirty = VARS({ preset: 'Not A Slug', light: { '--accent': 'url(x)', '--text': '#111111', bogus: '#fff' }, dark: { '--text': '#eeeeee' } });
    t = boot({ ready: true, local: { 'yc-theme': 'light', 'yc-theme-vars': dirty }, routes: { 'PUT /api/ui-config': savedPut } });
    t.w.toggleTheme();
    await t.clock.tick(1000);
    const body = t.puts()[0].body;
    expect(body.config.theme.vars).toEqual(VARS({ light: { '--text': '#111111' }, dark: { '--text': '#eeeeee' } }));
    expect(shape.validateWrite(body).ok).toBe(true);
  });
});

describe('write-through: themeCustom.html in the shell', () => {
  let t, cw;
  // The page's real script, in the pane frame (whose top is the shell).
  function mountCustom() {
    const fd = t.fw.document;
    fd.body.innerHTML = CUSTOM_BODY;
    t.fw.eval(CUSTOM_SCRIPT);
    return t.fw;
  }
  // …with theme.css linked first, so the Advanced tab renders its real rows.
  async function mountCustomWithRows() {
    const fd = t.fw.document;
    const link = fd.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://app.test/theme.css';
    const loaded = new Promise((r) => { link.onload = r; link.onerror = r; });
    fd.head.appendChild(link);
    await loaded;
    // jsdom's CSSOM leaves sheet.href (and ownerNode) unset; the browser sets
    // it, and readStock picks theme.css by it. The frame's only sheet is it.
    expect(fd.styleSheets.length).toBe(1);
    Object.defineProperty(fd.styleSheets[0], 'href', { value: link.href });
    return mountCustom();
  }
  const row = (fd, n) => [...fd.querySelectorAll('.row')].find((r) => r.querySelector('.nm').firstChild.textContent === n);
  afterEach(() => t && t.close());

  test('a preset pick, a density pick and an edit each write through — debounced into one PUT of the whole store', async () => {
    t = boot({ ready: true, local: { 'yc-theme': 'light' }, routes: { 'PUT /api/ui-config': savedPut } });
    cw = mountCustom();
    cw.applyPreset('warm-paper');
    cw.applyDensity('compact');
    cw.setToken('--accent', '#123456');
    expect(t.rec.fetch).toEqual([]);
    await t.clock.tick(1000);
    expect(t.puts().length).toBe(1);
    const vars = t.puts()[0].body.config.theme.vars;
    expect(vars.preset).toBe(null);                    // the edit un-picked the palette
    expect(vars.density).toBe('compact');
    expect(vars.light['--accent']).toBe('#123456');
    expect(vars.light['--fs']).toBe('12.5px');
    expect(vars).toEqual(JSON.parse(t.ls('yc-theme-vars')));
    expect(t.accent()).toBe('#123456');                // the shell followed (storage event)
  });

  test('switching the edited mode goes through the shell and writes through', async () => {
    t = boot({ ready: true, local: { 'yc-theme': 'light' }, routes: { 'PUT /api/ui-config': savedPut } });
    cw = mountCustom();
    cw.setMode('dark');
    expect(t.theme()).toBe('dark');
    await t.clock.tick(1000);
    expect(t.puts().length).toBe(1);
    expect(t.puts()[0].body.config.theme.mode).toBe('dark');
  });

  test('a value the account would refuse is refused at entry: a warning toast, the store unchanged, nothing written', async () => {
    t = boot({ ready: true, local: { 'yc-theme': 'light', 'yc-theme-vars': VARS({ light: { '--accent': '#123456' } }) }, routes: { 'PUT /api/ui-config': savedPut } });
    cw = mountCustom();
    t.rec.setItem.length = 0;
    cw.setToken('--accent', 'red; background: url(https://evil.example/x)');
    expect(t.rec.toast.length).toBe(1);
    expect(t.rec.toast[0].icon).toBe('warning');
    expect(t.rec.toast[0].titleText).toMatch(/is not a value the Theme page can save/);
    expect(t.rec.setItem).toEqual([]);
    expect(JSON.parse(t.ls('yc-theme-vars')).light['--accent']).toBe('#123456');
    await t.clock.tick(1000);
    expect(t.puts()).toEqual([]);
    // an ordinary value goes through
    cw.setToken('--accent', 'Georgia, serif');
    expect(JSON.parse(t.ls('yc-theme-vars')).light['--accent']).toBe('Georgia, serif');
  });

  test('the Advanced tab\'s own inputs reach the page (inline handlers do not hit document.write) and write through', async () => {
    t = boot({ ready: true, local: { 'yc-theme': 'light' }, routes: { 'PUT /api/ui-config': savedPut } });
    cw = await mountCustomWithRows();
    const fd = cw.document;
    expect(fd.querySelectorAll('.row').length).toBe(shape.THEME_TOKENS.length);
    const box = row(fd, '--accent').querySelector('input[type=text]');
    box.value = '#c0ffee';
    box.dispatchEvent(new cw.Event('change'));
    expect(fd.getElementById('groups')).not.toBeNull();          // the page is still there
    expect(JSON.parse(t.ls('yc-theme-vars')).light['--accent']).toBe('#c0ffee');
    // the length control (number input + unit) and the per-token reset button
    const num = row(fd, '--radius').querySelector('input[type=number]');
    num.value = '3';
    num.dispatchEvent(new cw.Event('change'));
    expect(JSON.parse(t.ls('yc-theme-vars')).light['--radius']).toBe('3px');
    row(fd, '--radius').querySelector('button.x').click();
    expect(JSON.parse(t.ls('yc-theme-vars')).light['--radius']).toBeUndefined();
    await t.clock.tick(1000);
    expect(t.puts().length).toBe(1);
    expect(t.puts()[0].body.config.theme.vars.light).toEqual({ '--accent': '#c0ffee' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// S5d fix round (review F1 / F2 / F5).
describe('fix round F1: no value shape backtracks super-linearly', () => {
  // The review's worst case: an unterminated colour function over a digit
  // run — with an OPTIONAL argument separator the engine tried every split of
  // the run into 3–4 numbers (O(n³), ~5 s for this 52 KB document).
  const fill = (head, unit, tail = '') => { let s = head; while (s.length + unit.length + tail.length <= 120) s += unit; return (s + tail).slice(0, 120); };
  const doc = (v) => { const light = {}, dark = {}; for (let i = 0; i < 200; i++) { light['--t' + i] = v; dark['--t' + i] = v; } return { theme: { vars: VARS({ light, dark }) } }; };
  const SHAPES = [
    // colour functions
    ...['rgb(', 'rgba(', 'hsl(', 'hsla('].flatMap((f) => [fill(f, '1'), fill(f, '1.'), fill(f, '11.'), fill(f, '1', '%%%%'), fill(f, '1 '), fill(f, '1,'), fill(f + '1', ' '), fill(f, '1%'), fill(f, '1', ')x')]),
    // numbers / lengths, hex, var(), keywords, quoted names, separators
    fill('', '1'), fill('', '1', 'x'), fill('', '1.'), fill('-', '1', 'p'), fill('', '1px'), fill('#', 'f'), fill('#', '1', 'x'), fill('#fff', '#fff'),
    fill('var(--', 'a'), fill('var(--a', ' '), fill('var(', ' '), fill('', 'a-'), fill('', 'a'), fill('"', 'a'), fill('"a', ' '), fill('', ' ', 'x'),
    fill('', ' ,'), fill('', ', '), fill('', ' / '), fill('1', ' ', '('),
  ];
  test('the review\'s 400-entry document, and every adversarial shape through the server and the client grammar, take < 50 ms in total', () => {
    const t0 = process.hrtime.bigint();
    const r = shape.validate('user', 'prefs', doc('rgb(' + '1'.repeat(116)));
    for (const v of SHAPES) { shape.themeValueProblem(v); CLIENT.valueOk(v); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r.ok).toBe(false);
    expect(SHAPES.length).toBeGreaterThan(50);
    expect(ms).toBeLessThan(50);
  });
  test('real colour functions still match, with or without commas, and the slash alpha', () => {
    for (const v of ['rgb(0 0 0 / 40%)', 'rgba(7, 173, 239, 0.12)', 'hsl(200deg 50% 50%)', 'hsla(200, 50%, 50%, .5)', 'rgb(0,0,0)', 'rgb( 0 , 0 , 0 )', 'rgb(0 0 0)']) {
      expect([v, shape.themeValueProblem(v)]).toEqual([v, null]);
      expect(CLIENT.valueOk(v)).toBe(true);
    }
    for (const v of ['rgb(000)', 'rgb(0 0)', 'rgb(0,0,0,0,0)', 'rgb(0 0 0']) expect(shape.themeValueProblem(v)).not.toBeNull();
  });
});

describe('fix round F2: a change made before adopt never overwrites the account', () => {
  let t;
  afterEach(() => t && t.close());

  test('fresh device: toggle before firm-data lands → no PUT (held), then adopt — the account (vars too) survives and is shown', async () => {
    t = boot({ local: {}, routes: { 'PUT /api/ui-config': savedPut } });
    t.w.toggleTheme();
    expect(t.theme()).toBe('dark');                    // the toggle still works at once
    await t.clock.tick(1000);
    expect(t.puts()).toEqual([]);
    expect(t.rec.warnings.join('\n')).toMatch(/not saved to your account: the account theme has not been read yet/);
    await t.T.adopt({ user: { prefs: J(ACCOUNT) } });
    await t.clock.tick(5000);
    expect(t.puts()).toEqual([]);
    expect(t.theme()).toBe('dark');
    expect(t.accent()).toBe('#0000bb');
    expect(JSON.parse(t.ls('yc-theme-vars'))).toEqual(ACCOUNT.theme.vars);
  });

  test('a PUT still pending when adopt runs is dropped: the account wins', async () => {
    t = boot({ local: LOCAL, routes: { 'PUT /api/ui-config': savedPut } });
    t.w.toggleTheme();
    await t.clock.tick(500);
    await t.T.adopt({ user: { prefs: { theme: { mode: 'light', vars: LOCAL['yc-theme-vars'] } } } });
    expect(t.theme()).toBe('light');
    await t.clock.tick(5000);
    expect(t.puts()).toEqual([]);
    // and once settled, a change writes through
    t.w.toggleTheme();
    await t.clock.tick(1000);
    expect(t.puts().length).toBe(1);
    expect(t.puts()[0].body.config.theme.mode).toBe('dark');
  });

  test('toggle while the no-row GET is in flight → exactly one PUT, carrying the toggle', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    t = boot({ local: LOCAL, routes: { 'GET /api/ui-config': async () => { await gate; return { status: 'success', firm: {}, user: {} }; }, 'PUT /api/ui-config': savedPut } });
    const p = t.T.adopt({ firm: {}, user: {} });
    await t.settle();
    t.w.toggleTheme();
    await t.clock.tick(1000);                          // the held timer fires and does nothing
    expect(t.puts()).toEqual([]);
    t.w.toggleTheme();                                 // …and one still pending when the GET returns
    release();
    expect(await p).toBe('uploaded');
    await t.clock.tick(5000);
    expect(t.puts().length).toBe(1);
    expect(t.puts()[0].body.config.theme).toEqual({ mode: 'light', vars: LOCAL['yc-theme-vars'] });
  });

  test('the account read failed → write-through stays off this session (never a blind overwrite)', async () => {
    t = boot({ local: LOCAL, routes: { 'GET /api/ui-config': { status: 500, body: { status: 'error', message: 'db down' } }, 'PUT /api/ui-config': savedPut } });
    expect(await t.T.adopt({ firm: {}, user: {} })).toBe('failed');
    t.w.toggleTheme();
    await t.clock.tick(1000);
    expect(t.puts()).toEqual([]);
    expect(t.theme()).toBe('dark');
  });
});

describe('fix round F5: a stock device never claims the account', () => {
  let t;
  afterEach(() => t && t.close());
  const NOROW = { 'GET /api/ui-config': { status: 'success', firm: {}, user: {} }, 'PUT /api/ui-config': savedPut };

  test.each([
    ['no theme keys at all', {}],
    ['yc-theme light (every boot writes it: applyTheme at load)', { 'yc-theme': 'light' }],
    ['light + an EMPTY store (after Reset all)', { 'yc-theme': 'light', 'yc-theme-vars': VARS() }],
  ])('%s → kept, nothing uploaded; the first change then writes through', async (_, local) => {
    t = boot({ local, routes: NOROW });
    expect(await t.T.adopt({ firm: {}, user: {} })).toBe('kept');
    await t.clock.tick(5000);
    expect(t.puts()).toEqual([]);
    t.w.toggleTheme();
    await t.clock.tick(1000);
    expect(t.puts().length).toBe(1);
    expect(t.puts()[0].body.config.theme.mode).toBe('dark');
  });

  test.each([
    ['dark mode', { 'yc-theme': 'dark' }],
    ['an override', { 'yc-theme': 'light', 'yc-theme-vars': VARS({ dark: { '--accent': '#123456' } }) }],
    ['a density pick', { 'yc-theme': 'light', 'yc-theme-vars': VARS({ density: 'compact' }) }],
  ])('a customized device (%s) uploads once', async (_, local) => {
    t = boot({ local, routes: NOROW });
    expect(await t.T.adopt({ firm: {}, user: {} })).toBe('uploaded');
    expect(t.puts().length).toBe(1);
  });
});
