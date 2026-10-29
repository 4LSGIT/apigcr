// tests/toolShellS33.test.js
//
/**
 * ui-custom S3.3 — the tool shell API, tool presentation, and firm items as
 * tiles (public/index.html: the <script id="ycToolDialogJs"> block, which
 * defines window.openToolDialog and window.ycTool; the ycLauncher block's
 * pages and exec), plus the `size` field in lib/uiConfigShape.js and its
 * client copy.
 *
 *   1. size in the grammar: optional on tool / view, 'compact' | 'large' only,
 *      absent stays absent; refused on a url item; the client's re-validation
 *      (ycLauncher.cleanFirmItem) keeps exactly what the server accepts.
 *   2. window.ycTool, run for real in jsdom over the shell's own dialog, auth
 *      state and apiSend (tests/helpers/toolShell.js): frozen and
 *      non-writable; nothing reachable through it is the token or AUTH_STATE;
 *      quiet mode never prompts; apiSend's guards hold; close / resize act only
 *      for the dialog's own page; openCase / openContact close that dialog
 *      first, refuse bad ids, and open only what /api/search confirms; exec
 *      keeps ycLauncher's refusals.
 *   3. presentation: openToolDialog's size presets; exec passes a firm item's
 *      size through.
 *   4. firm items on a firm page — the More firm row's heir since launcher-nits
 *      C4 (More Features is the firm page firm:more; the firm's layout places
 *      its items there, no automatic row anywhere): tiles where the page's
 *      layout puts them, in its order, label as text, no data-target, click →
 *      exec; idempotent re-runs, replacement, removal; hidden / denied firm
 *      items not drawn; the pill strip follows.
 *
 * Mutation-checked (see local/ui-custom/S3.3_worker_report.md).
 *
 * Run:  npx jest tests/toolShellS33.test.js
 */

'use strict';

const vm = require('vm');
const shape = require('../lib/uiConfigShape');
const { boot, jwt, RAW, REGISTRY_SRC, RENDERER_SRC } = require('./helpers/toolShell');
const { hubFirm, HISTORIC_LAYOUTS: HL } = require('./helpers/hubPages');

const ro = (doc) => shape.validate('firm', 'registry_overrides', doc);
const ui = (r) => ({ firm: { registry_overrides: r }, user: {} });
const FI = {
  clio: { id: 'firm:clio', label: 'Get Clio Code', icon: 'c', action: { type: 'tool', key: 'clio-code', present: 'modal', size: 'compact' } },
  appt: { id: 'firm:appt', label: 'Appointment Form', icon: 'calendar-plus', action: { type: 'tool', key: 'appt-form', present: 'modal' } },
  leads: { id: 'firm:leads', label: 'Lead Follow-ups', icon: 'table-list', action: { type: 'view', key: 'lead_followups', present: 'modal', size: 'large' } },
  pay: { id: 'firm:pay', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } },
};

const CL = (() => {
  const ctx = vm.createContext({ console: { error() {}, warn() {} }, URL });
  ctx.window = ctx;
  vm.runInContext(REGISTRY_SRC, ctx);
  vm.runInContext(RENDERER_SRC, ctx);
  return ctx.window.ycLauncher;
})();

// ─────────────────────────────────────────────────────────────────────────
describe('size in the firm item grammar', () => {
  test('optional on tool / view; compact | large kept; absent stays absent', () => {
    const r = ro({ items: [FI.clio, FI.appt, FI.leads] });
    expect(r.ok).toBe(true);
    expect(r.value.items.map((i) => i.action)).toEqual([
      { type: 'tool', key: 'clio-code', present: 'modal', size: 'compact' },
      { type: 'tool', key: 'appt-form', present: 'modal' },
      { type: 'view', key: 'lead_followups', present: 'modal', size: 'large' }]);
    expect(shape.SIZES).toEqual(['compact', 'large']);
  });

  test.each([['huge'], ['Compact'], [''], [null], [480], [{ w: 1 }], ['480px']])('size %p is refused', (z) => {
    const r = ro({ items: [{ ...FI.appt, action: { ...FI.appt.action, size: z } }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/size must be "compact" or "large"/);
  });

  test('a url item may not carry a size', () => {
    const r = ro({ items: [{ ...FI.pay, action: { ...FI.pay.action, size: 'compact' } }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/unknown field "size"/);
  });

  const FIXTURES = [
    FI.clio, FI.appt, FI.leads, FI.pay,
    { ...FI.appt, action: { ...FI.appt.action, size: 'large' } },
    { ...FI.appt, action: { ...FI.appt.action, size: 'huge' } },
    { ...FI.appt, action: { ...FI.appt.action, size: null } },
    { ...FI.leads, action: { ...FI.leads.action, size: 'compact' } },
    { ...FI.pay, action: { ...FI.pay.action, size: 'compact' } },
    { ...FI.pay, action: { ...FI.pay.action, size: 'large' } },
  ];
  test.each(FIXTURES.map((f, i) => [i, f]))('client == server, fixture %i', (_, f) => {
    const server = ro({ items: [f] });
    const client = CL.cleanFirmItem(f);
    expect(client === null ? null : JSON.parse(JSON.stringify(client))).toEqual(server.ok ? server.value.items[0] : null);
  });

  test('the client size list is the server one', () => {
    expect(RAW.match(/var SIZES = (\[.*?\]);/g).map((m) => JSON.parse(m.replace(/^var SIZES = /, '').replace(/;$/, '').replace(/'/g, '"'))))
      .toEqual([shape.SIZES.slice(), shape.SIZES.slice()]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('window.ycTool: shape', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('version 1, the documented members, all plain frozen functions on a frozen, non-writable object', () => {
    const T = t.w.ycTool;
    expect(T.version).toBe(1);
    expect(Object.keys(T).sort()).toEqual(['apiSend', 'authReady', 'close', 'exec', 'openCase', 'openContact', 'resize', 'toast', 'version']);
    expect(Object.isFrozen(T)).toBe(true);
    for (const k of Object.keys(T)) if (k !== 'version') {
      expect(typeof T[k]).toBe('function');
      expect(Object.isFrozen(T[k])).toBe(true);
    }
    t.w.eval('ycTool.apiSend = function () { return "MITM"; }; ycTool.extra = 1; window.ycTool = { version: 99 };');
    expect(t.w.ycTool).toBe(T);
    expect(T.extra).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(t.w, 'ycTool')).toMatchObject({ writable: false, configurable: false });
  });

  test('nothing reachable through it — members, their properties, what they return — is the token or AUTH_STATE', async () => {
    const T = t.w.ycTool, token = t.w.AUTH_STATE.jwt, seen = new Set(), hits = [];
    expect(token).toMatch(/^ey/);
    const walk = (v, p, depth) => {
      if (v === t.w.AUTH_STATE) hits.push(p + ' is AUTH_STATE');
      if (typeof v === 'string' && v.includes(token)) hits.push(p + ' holds the token');
      if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v) || depth > 6) return;
      if (v === t.w || v === t.w.document) { hits.push(p + ' is the shell window/document'); return; }
      seen.add(v);
      for (const k of Object.getOwnPropertyNames(v)) {
        if (['caller', 'callee', 'arguments'].includes(k)) continue;
        let x; try { x = v[k]; } catch (_) { continue; }
        walk(x, p + '.' + k, depth + 1);
      }
    };
    walk(T, 'ycTool', 0);
    t.rec.fetch.length = 0;
    const results = {
      authReady: T.authReady(), toast: T.toast('hi'), close: T.close(t.w), resize: T.resize('compact', t.w),
      exec: T.exec('nope'), openCase: await T.openCase('bad id!'), openContact: await T.openContact(-1),
    };
    walk(results, 'result', 0);
    expect(hits).toEqual([]);
    expect(results.authReady).toBe(true);
  });

  test('nor is anything reachable through a REJECTION: the quiet ToolAuthError and a server ApiError — own keys, cause, prototype chain', async () => {
    const valid = t.w.AUTH_STATE.jwt, hits = [], seen = new Set();
    const walk = (v, p, depth) => {
      if (v === t.w.AUTH_STATE) hits.push(p + ' is AUTH_STATE');
      if (typeof v === 'string' && v.includes(valid)) hits.push(p + ' holds the token');
      if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v) || depth > 8) return;
      if (v === t.w || v === t.w.document) { hits.push(p + ' is the shell window/document'); return; }
      seen.add(v);
      for (const k of Reflect.ownKeys(v)) {
        if (['caller', 'callee', 'arguments'].includes(k)) continue;
        let x; try { x = v[k]; } catch (_) { continue; }
        walk(x, p + '.' + String(k), depth + 1);
      }
      if (typeof v === 'object') walk(Object.getPrototypeOf(v), p + '.[[Prototype]]', depth + 1);
    };
    // a server error: the shell's ApiError, through ycTool.apiSend
    const t2 = boot({ routes: { 'GET /boom': { status: 500, body: { error: 'Server error', detail: 'x' } } } });
    const apiErr = await t2.w.ycTool.apiSend('/boom').catch((e) => e);
    expect([apiErr.name, apiErr.status]).toEqual(['ApiError', 500]);
    // the quiet refusal
    t.w.AUTH_STATE.jwt = jwt(-60);
    const quietErr = await t.w.ycTool.apiSend('/x', 'GET', null, { quiet: true }).catch((e) => e);
    expect(quietErr.name).toBe('ToolAuthError');
    t.w.AUTH_STATE.jwt = valid;
    const t2Token = t2.w.AUTH_STATE.jwt;
    walk(quietErr, 'quietErr', 0);
    walk(quietErr.cause, 'quietErr.cause', 0);
    walk(apiErr, 'apiErr', 0);
    walk(apiErr.cause, 'apiErr.cause', 0);
    const t2hits = [];
    const sseen = new Set();
    const walk2 = (v, p, d) => {
      if (v === t2.w.AUTH_STATE) t2hits.push(p + ' is AUTH_STATE');
      if (typeof v === 'string' && v.includes(t2Token)) t2hits.push(p + ' holds the token');
      if (v === null || (typeof v !== 'object' && typeof v !== 'function') || sseen.has(v) || d > 8) return;
      sseen.add(v);
      for (const k of Reflect.ownKeys(v)) { let x; try { x = v[k]; } catch (_) { continue; } walk2(x, p + '.' + String(k), d + 1); }
      if (typeof v === 'object') walk2(Object.getPrototypeOf(v), p + '.[[Prototype]]', d + 1);
    };
    walk2(apiErr, 'apiErr', 0);
    walk2(apiErr.cause, 'apiErr.cause', 0);
    t2.close();
    expect(hits).toEqual([]);
    expect(t2hits).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('ycTool.apiSend / authReady', () => {
  test('delegates to the shell apiSend: the request carries the session; the body comes back', async () => {
    const t = boot({ routes: { 'GET /clio-code': { value: '123456', age_seconds: 4 } } });
    const d = await t.w.ycTool.apiSend('/clio-code');
    expect(d).toEqual({ value: '123456', age_seconds: 4 });
    expect(t.rec.fetch[0].headers.Authorization).toBe('Bearer ' + t.w.AUTH_STATE.jwt);
    t.close();
  });

  test('quiet + no valid session → rejects ToolAuthError at once: no login prompt, no request', async () => {
    for (const token of [jwt(-60), 'not-a-jwt', '']) {
      const t = boot({ token, routes: { 'GET /clio-code': { value: '1' } } });
      if (!token) t.w.AUTH_STATE.jwt = null;
      expect(t.w.ycTool.authReady()).toBe(false);
      const e = await t.w.ycTool.apiSend('/clio-code', 'GET', null, { quiet: true }).catch((x) => x);
      expect([e.name, e.code]).toEqual(['ToolAuthError', 'auth_required']);
      expect([t.rec.login, t.rec.fetch.length]).toEqual([0, 0]);
      t.close();
    }
  });

  test('not quiet + an expired session → the shell\'s normal blocking login (unchanged behaviour)', async () => {
    const t = boot({ token: jwt(-60), routes: { 'GET /x': { ok: 1 } } });
    await t.w.ycTool.apiSend('/x');
    expect(t.rec.login).toBe(1);
    t.close();
  });

  test('quiet + a valid session goes through', async () => {
    const t = boot({ routes: { 'POST /process-jobs': { processed: 0 } } });
    expect(await t.w.ycTool.apiSend('/process-jobs', 'POST', null, { quiet: true })).toEqual({ processed: 0 });
    expect(t.rec.login).toBe(0);
    t.close();
  });

  test('apiSend\'s guards hold: no cross-origin endpoint, no extra headers', async () => {
    const t = boot({ routes: { 'POST /x': { ok: 1 } } });
    for (const bad of ['https://evil.example/x', '//evil.example/x', '/\\evil.example']) {
      await expect(t.w.ycTool.apiSend(bad)).rejects.toThrow(/root-relative/);
    }
    expect(t.rec.fetch).toHaveLength(0);
    await t.w.ycTool.apiSend('/x', 'POST', { a: 1 }, { quiet: false, headers: { Authorization: 'Bearer forged' }, 'X-Evil': 1 });
    expect(t.rec.fetch[0].headers.Authorization).toBe('Bearer ' + t.w.AUTH_STATE.jwt);
    expect(Object.keys(t.rec.fetch[0].headers).sort()).toEqual(['Authorization', 'Content-Type']);
    expect(t.rec.fetch[0].body).toBe('{"a":1}');
    t.close();
  });

  test('authReady never prompts and never touches the network', () => {
    const t = boot({ token: jwt(-5) });
    expect(t.w.ycTool.authReady()).toBe(false);
    t.w.AUTH_STATE.jwt = jwt(60);
    expect(t.w.ycTool.authReady()).toBe(true);
    expect([t.rec.login, t.rec.fetch.length]).toEqual([0, 0]);
    t.close();
  });
});

describe('ycTool.toast', () => {
  test('the shell toast, as TEXT (titleText), kind checked, length capped', () => {
    const t = boot();
    expect(t.w.ycTool.toast('<img src=x onerror=1>', 'success')).toBe(true);
    expect(t.w.ycTool.toast('Saved')).toBe(true);
    expect(t.w.ycTool.toast('x'.repeat(500), 'nonsense')).toBe(true);
    expect(t.w.ycTool.toast('')).toBe(false);
    // a hostile argument never throws out of the API (manual: "None of them throws for a bad argument")
    expect(t.w.ycTool.toast({ toString() { throw new Error('boom'); } })).toBe(false);
    expect(t.w.ycTool.toast(Object.create(null))).toBe(false);
    expect(t.rec.toast).toEqual([
      { icon: 'success', titleText: '<img src=x onerror=1>' }, { icon: 'info', titleText: 'Saved' },
      { icon: 'info', titleText: 'x'.repeat(300) }]);
    t.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('close / resize: only the dialog\'s own page', () => {
  let t, fw;
  beforeEach(() => {
    t = boot();
    t.L.applyAccess({ ui: ui({ items: [FI.appt] }) });
    expect(t.L.exec('firm:appt')).toBe(true);
    fw = t.dlgFrame().contentWindow;
  });
  afterEach(() => t.close());

  test('a frame that is not the dialog\'s page gets false and changes nothing', () => {
    const tabFrame = t.d.getElementById('tabOtherFrame').contentWindow;
    for (const other of [t.pane(), tabFrame, t.w, undefined, null, {}, { parent: t.w }]) {
      expect(t.w.ycTool.resize('compact', other)).toBe(false);
      expect(t.w.ycTool.close(other)).toBe(false);
    }
    expect(t.dlgOpen()).toBe(true);
    expect(t.w.openToolDialog.size()).toBe('large');
  });

  test('the dialog\'s own page (and a frame nested in it) resizes it between the presets, then closes it', () => {
    expect(t.w.ycTool.resize('compact', fw)).toBe(true);
    expect([t.w.openToolDialog.size(), t.dlg().getAttribute('data-size'), t.dlg().querySelector('.yc-td').classList.contains('yc-td-compact')])
      .toEqual(['compact', 'compact', true]);
    for (const bad of ['huge', '480px', 480, { w: 1 }, undefined]) expect(t.w.ycTool.resize(bad, fw)).toBe(false);
    expect(t.w.openToolDialog.size()).toBe('compact');
    const nested = fw.document.createElement('iframe');
    fw.document.body.appendChild(nested);
    expect(t.w.ycTool.resize('large', nested.contentWindow)).toBe(true);
    expect(t.dlg().querySelector('.yc-td').classList.contains('yc-td-compact')).toBe(false);
    expect(t.w.ycTool.close(fw)).toBe(true);
    expect(t.dlgOpen()).toBe(false);
    expect([t.w.ycTool.close(fw), t.w.ycTool.resize('compact', fw)]).toEqual([false, false]);
  });

  test('a page from an earlier dialog cannot act on the next one', () => {
    t.L.applyAccess({ ui: ui({ items: [FI.appt, FI.leads] }) });
    t.L.exec('firm:leads');
    expect(t.dlgFrame().contentWindow).not.toBe(fw);
    expect(t.w.ycTool.close(fw)).toBe(false);
    expect(t.dlgOpen()).toBe(true);
  });

  test('outside any dialog (a frame in another tab, nothing open) both are no-ops returning false', () => {
    t.w.openToolDialog.close();
    const tabFrame = t.d.getElementById('tabOtherFrame').contentWindow;
    expect([t.w.ycTool.close(tabFrame), t.w.ycTool.resize('compact', tabFrame)]).toEqual([false, false]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('openCase / openContact', () => {
  const routes = {
    'GET /api/search': (req) => {
      const db = { case: { ABCD2345: 'Doe, Jane - Ch 7', 'x-Y_9': 'Legacy Case' }, contact: { 1405: 'Jane Doe' } };
      const name = (db[req.query.type] || {})[req.query.q];
      if (name) return { results: [{ id: req.query.type === 'contact' ? Number(req.query.q) : req.query.q, type: req.query.type, name }] };
      // no exact hit: the search's fuzzy best match — a DIFFERENT file (or another kind)
      if (req.query.q === 'NOHITS99') return { results: [] };
      return { results: [req.query.type === 'case' ? { id: 'ABCD2345', type: 'case', name: 'Someone else' } : { id: 'ABCD2345', type: 'case', name: 'A case' }] };
    },
  };
  let t, fw;
  beforeEach(() => {
    t = boot({ routes });
    t.L.applyAccess({ ui: ui({ items: [FI.appt] }) });
    t.L.exec('firm:appt');
    fw = t.dlgFrame().contentWindow;
  });
  afterEach(() => t.close());

  test('from the dialog\'s page: the dialog closes FIRST, then addFile opens the confirmed file', async () => {
    expect(await t.w.ycTool.openCase('ABCD2345', fw)).toBe(true);
    expect(t.rec.addFile).toEqual([{ name: 'Doe, Jane - Ch 7', type: 'case', id: 'ABCD2345', dialogOpen: false }]);
    expect(t.dlgOpen()).toBe(false);
    t.L.exec('firm:appt');
    expect(await t.w.ycTool.openContact(1405, t.dlgFrame().contentWindow)).toBe(true);
    expect(t.rec.addFile[1]).toEqual({ name: 'Jane Doe', type: 'client', id: '1405', dialogOpen: false });
    expect(await t.w.ycTool.openCase('x-Y_9')).toBe(true);                     // a legacy id shape
    expect(t.rec.fetch.filter((f) => f.path === '/api/search').map((f) => f.query))
      .toEqual([{ q: 'ABCD2345', type: 'case', limit: '1' }, { q: '1405', type: 'contact', limit: '1' }, { q: 'x-Y_9', type: 'case', limit: '1' }]);
  });

  test('from another frame: the file opens, and someone else\'s dialog stays open', async () => {
    expect(await t.w.ycTool.openContact('1405', t.pane())).toBe(true);
    expect(t.rec.addFile).toEqual([{ name: 'Jane Doe', type: 'client', id: '1405', dialogOpen: true }]);
    expect(t.dlgOpen()).toBe(true);
  });

  test('bad ids are refused before any request; the dialog stays', async () => {
    for (const id of [1405, '', 'a b', 'x'.repeat(21), '../x', 'AB&tab=docs', null, undefined, {}]) {
      expect(await t.w.ycTool.openCase(id, fw)).toBe(false);
    }
    for (const id of [0, -1, 1.5, '0', '12a', '01', ' 12', 'ABCD2345', 12345678901, null]) {
      expect(await t.w.ycTool.openContact(id, fw)).toBe(false);
    }
    expect([t.rec.fetch.length, t.rec.addFile.length, t.dlgOpen()]).toEqual([0, 0, true]);
  });

  test('an id /api/search cannot confirm opens nothing (and keeps the dialog) — never its fuzzy best match', async () => {
    expect(await t.w.ycTool.openCase('ZZZZ9999', fw)).toBe(false);             // best match: another case
    expect(await t.w.ycTool.openContact(77, fw)).toBe(false);                  // best match: not even a contact
    expect(await t.w.ycTool.openCase('NOHITS99', fw)).toBe(false);             // nothing at all
    expect([t.rec.addFile.length, t.dlgOpen()]).toEqual([0, true]);
  });
});

describe('ycTool.exec', () => {
  test('ycLauncher.exec, refusals kept', () => {
    const t = boot();
    t.L.applyAccess({ ui: ui({ items: [FI.appt] }) });
    expect(t.w.ycTool.exec('firm:appt')).toBe(true);
    expect(t.dlgFrame().getAttribute('src')).toBe('/tool/appt-form');
    expect([t.w.ycTool.exec('firm:nope'), t.w.ycTool.exec(7), t.w.ycTool.exec('adminDbConsole')]).toEqual([false, false, false]);
    t.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('tool presentation: size presets', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());
  const compact = () => t.dlg().querySelector('.yc-td').classList.contains('yc-td-compact');

  test('openToolDialog: large by default; compact on request; anything else opens large with a warning', () => {
    expect(t.w.openToolDialog.size()).toBe(null);
    t.w.openToolDialog('/tool/a');
    expect([t.w.openToolDialog.size(), compact(), t.dlg().getAttribute('data-size')]).toEqual(['large', false, 'large']);
    t.w.openToolDialog('/tool/a', { size: 'compact' });
    expect([t.w.openToolDialog.size(), compact()]).toEqual(['compact', true]);
    t.w.openToolDialog('/tool/a', { size: '300px' });
    expect([t.w.openToolDialog.size(), compact()]).toEqual(['large', false]);
    expect(t.rec.warnings.join('\n')).toMatch(/size must be "compact" or "large"/);
    t.w.openToolDialog.close();
    expect(t.w.openToolDialog.size()).toBe(null);
  });

  test('exec passes a firm item\'s size; absent = large', () => {
    t.L.applyAccess({ ui: ui({ items: [FI.clio, FI.appt, FI.leads] }) });
    t.L.exec('firm:clio');
    expect([t.dlgFrame().getAttribute('src'), t.w.openToolDialog.size(), compact()]).toEqual(['/tool/clio-code', 'compact', true]);
    t.L.exec('firm:appt');
    expect([t.w.openToolDialog.size(), compact()]).toEqual(['large', false]);
    t.L.exec('firm:leads');
    expect(t.w.openToolDialog.size()).toBe('large');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// launcher-nits C4: More Features is the firm page firm:more and the firm row
// is gone — a firm item is drawn where the firm's layout places it. Here: on
// firm:more after a break at the end of the grid, where the row used to be.
describe('firm items on the firm page firm:more (the More firm row\'s heir)', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());
  const J = (x) => JSON.parse(JSON.stringify(x));
  /** The firm's documents: these items, placed (or not) at the end of firm:more's grid. */
  const onMore = (items, { place = items, ro = {} } = {}) => ({
    firm: hubFirm({ items, ro, layout: { pages: { 'firm:more': {
      tiles: [...J(HL.more), ...(place.length ? [{ break: true }, ...place.map((i) => ({ item: i.id }))] : [])], icons: J(HL.moreIcons) } } } }),
    user: {},
  });
  const more = () => t.d.querySelector('#ycPages > [data-yc-page="firm:more"]');
  const tiles = () => [...more().querySelectorAll(':scope > .big-button')].filter((b) => /^firm:/.test(b.getAttribute('data-yc-shortcut')));
  const pills = () => [...more().querySelectorAll(':scope > .feature-strip .pill-button')].slice(1).map((p) => p.textContent.trim());

  test('no row, ever: a firm item the layout places nowhere is drawn nowhere (no firm-row node in the shell)', () => {
    t.L.applyAccess({ isAdmin: true, ui: onMore([FI.clio, FI.appt], { place: [] }) });
    expect(tiles()).toEqual([]);
    expect(t.d.querySelectorAll('[data-yc-firm-row]')).toHaveLength(0);
    expect(t.d.querySelectorAll('[data-yc-shortcut^="firm:clio"], [data-yc-shortcut^="firm:appt"]')).toHaveLength(0);
    expect(t.L.effectiveRegistry().map((e) => e.id)).toEqual(expect.arrayContaining(['firm:clio', 'firm:appt']));   // still All's / the palette's
  });

  test('tiles where the layout puts them — after the break at the END of the grid, in its order; label as text; no drill attributes', () => {
    const evil = { id: 'firm:evil', label: '<img src=x onerror=alert(1)>', icon: 'bug', action: { type: 'tool', key: 'x', present: 'modal' } };
    t.L.applyAccess({ ui: onMore([FI.leads, FI.pay, evil, FI.clio]) });
    const kids = [...more().children];
    const lastReg = kids.indexOf(more().querySelector(':scope > [data-yc-shortcut="moreAssistant"]'));   // the grid's last registry tile (YisrAI row, 2026-10-19)
    expect(lastReg).toBeGreaterThan(0);
    expect(kids.slice(lastReg + 1, lastReg + 7).map((n) => n.tagName + (n.getAttribute('data-yc-shortcut') || '')))
      .toEqual(['BR', 'BR', 'BUTTONfirm:leads', 'BUTTONfirm:pay', 'BUTTONfirm:evil', 'BUTTONfirm:clio']);
    expect(kids[lastReg + 7].className).toBe('page-egg-row');
    for (const b of tiles()) {
      expect(b.className).toBe('big-button');
      expect(b.parentNode).toBe(more());
      expect(b.hasAttribute('data-target') || b.hasAttribute('data-exclusive-group') || b.hasAttribute('onclick')).toBe(false);
      expect([...b.childNodes].map((n) => n.nodeName)).toEqual(['I', 'BR', 'BR', '#text']);
    }
    expect(tiles().map((b) => [b.textContent, b.querySelector('i').className])).toEqual([
      ['Lead Follow-ups', 'fa-solid fa-table-list fa-2xl'], ['Payroll', 'fa-solid fa-money-check fa-2xl'],
      ['<img src=x onerror=alert(1)>', 'fa-solid fa-bug fa-2xl'], ['Get Clio Code', 'fa-solid fa-c fa-2xl']]);
    expect(more().querySelector('img')).toBeNull();
    expect(t.L.elementsOf('firm:clio')).toEqual({});              // exec stays declarative
  });

  test('a tile click runs exec: the tool opens in its size; a url item opens its window', () => {
    const opened = [];
    t.w.open = (...a) => { opened.push(a); return null; };
    t.L.applyAccess({ ui: onMore([FI.pay, FI.clio]) });
    tiles()[1].click();
    expect([t.dlgOpen(), t.dlgFrame().getAttribute('src'), t.w.openToolDialog.size()]).toEqual([true, '/tool/clio-code', 'compact']);
    tiles()[0].click();
    expect(opened).toEqual([['https://payroll.example.com/', '_blank', 'noopener']]);
    expect(t.dlgOpen()).toBe(false);                                // exec closes the dialog first
  });

  test('idempotent: the same documents re-run (applyAccess, also with only roles) leave the very same nodes', () => {
    const doc = onMore([FI.clio, FI.appt]);
    t.L.applyAccess({ ui: doc });
    const first = [...more().childNodes];
    t.L.applyAccess({ ui: J(doc) });
    t.L.applyAccess({ roles: ['staff'] });
    expect([...more().childNodes].every((n, i) => n === first[i])).toBe(true);
    expect(more().childNodes.length).toBe(first.length);
    expect(tiles()).toHaveLength(2);
  });

  // (The row's "a tile removed by hand comes back" is not carried over: a
  // page relays out only what its layout changed — S6c-5, not a C4 contract.)
  test('a change replaces the tiles; none placed removes them', () => {
    t.L.applyAccess({ ui: onMore([]) });
    const bare = more().childNodes.length;
    t.L.applyAccess({ ui: onMore([FI.clio, FI.appt]) });
    // the grid's own spacing: one whitespace node before each element, as the mounted markup has
    const ws = (n) => n.previousSibling && n.previousSibling.nodeType === 3 && n.previousSibling.nodeValue === '\n  ';
    expect(tiles().every(ws)).toBe(true);
    expect(more().childNodes.length).toBe(bare + 3 + 2 * 2);       // the break (whitespace + 2 BR), then whitespace + tile each
    t.L.applyAccess({ ui: onMore([FI.appt, { ...FI.clio, label: 'Clio' }, FI.leads]) });
    expect(tiles().map((b) => b.textContent)).toEqual(['Appointment Form', 'Clio', 'Lead Follow-ups']);
    expect(more().childNodes.length).toBe(bare + 3 + 2 * 3);       // nothing left behind by the old tiles
    t.L.applyAccess({ ui: onMore([]) });
    expect(tiles()).toEqual([]);
    expect(more().childNodes.length).toBe(bare);
  });

  test('firm-hidden and denied firm items are not drawn', () => {
    t.L.applyAccess({ denied: ['firm:appt'], ui: onMore([FI.clio, FI.appt, FI.leads], { ro: { hidden: ['firm:clio'] } }) });
    expect(tiles().map((b) => b.getAttribute('data-yc-shortcut'))).toEqual(['firm:leads']);
  });

  test('drilled in: the strip has a pill per firm tile (it runs exec), and follows a change', () => {
    t.L.applyAccess({ ui: onMore([FI.appt]) });
    t.L.exec('moreManuals');                                          // a panel tile on this page: drills it in
    expect(more().classList.contains('drill-active')).toBe(true);
    expect(pills()).toContain('Appointment Form');
    t.L.applyAccess({ ui: onMore([{ ...FI.appt, label: 'Appts' }]) });
    expect(pills()).toContain('Appts');
    expect(pills()).not.toContain('Appointment Form');
    expect(more().querySelectorAll(':scope > .feature-strip')).toHaveLength(1);
    [...more().querySelectorAll(':scope > .feature-strip .pill-button')].find((p) => p.textContent.trim() === 'Appts').click();
    expect([t.dlgOpen(), t.dlgFrame().getAttribute('src')]).toEqual([true, '/tool/appt-form']);
  });
});
