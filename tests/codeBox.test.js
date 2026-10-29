// tests/codeBox.test.js
//
// The Code dialog (public/js/ycCodeBox.js) and its audit route
// (routes/api.codeBox.js). The dialog half drives the REAL rendered controls
// in a JSDOM page (clicks and keys on the buttons the user sees), with the
// shell's apiSend stubbed at window.apiSend. The route half runs the real
// router + requireAuth on an express app with a stub db (no pool, no .env).

'use strict';

process.env.JWT_SECRET = 'code-box-test-secret';
process.env.JWT_VERSION = '1';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycCodeBox.js'), 'utf8');
const router = require('../routes/api.codeBox');

// ─────────────────────────────────────────────────────────────────────────
// the route

function makeDb({ failAudit = false, failFinish = false } = {}) {
  const audits = [];
  return {
    audits,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
      if (/INSERT INTO admin_audit_log/.test(s)) {
        if (failAudit) throw new Error('db down');
        const [tool, user_id, username, route, method, status, error_message, duration_ms, ip, ua, details] = params;
        audits.push({ tool, user_id, username, route, method, status, details: JSON.parse(details) });
        return [{ insertId: audits.length }];
      }
      if (/UPDATE admin_audit_log SET status/.test(s)) {
        if (failFinish) throw new Error('db down');
        const [status, duration, id, tool, actor, target] = params;
        const row = audits[id - 1];
        const eligible = row && row.tool === tool && row.status === 'run' && row.user_id === actor
          && (row.details.target_user_id || row.user_id) === target;
        if (eligible) Object.assign(row, { status, duration_ms: duration });
        return [{ affectedRows: eligible ? 1 : 0 }];
      }
      throw new Error('unscripted query: ' + s);
    },
  };
}

function token({ sub = 2, username = 'staff', roles = ['staff'], extra = {} } = {}) {
  return jwt.sign({ sub, username, user_type: 1, user_auth: 'authorized', roles, aud: 'staff', ver: 1, ...extra },
    process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function post(db, { body, headers = {}, url = '/api/code-box/runs' }) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(router);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const req = http.request({ port, method: 'POST', path: url,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('POST /api/code-box/runs', () => {
  test('any staff JWT: one admin_audit_log row holding the code, then success', async () => {
    const db = makeDb();
    const code = "await apiSend('/api/cases/1')\nreturn 1;";
    const r = await post(db, { body: { code }, headers: { Authorization: 'Bearer ' + token() } });
    expect(r).toEqual({ status: 200, body: { status: 'success', run_id: 1 } });
    expect(db.audits).toEqual([{ tool: 'code_box', user_id: 2, username: 'staff', route: '/api/code-box/runs',
      method: 'POST', status: 'run', details: { code } }]);
  });

  test('no token, or an API key (even the valid internal one): refused, nothing recorded', async () => {
    const db = makeDb();
    const fc = require('../lib/firmConfig');
    const spy = jest.spyOn(fc, 'cfg').mockImplementation((k) => (k === 'internal_api_key' ? 'internal-test-key' : null));
    try {
      expect((await post(db, { body: { code: '1' } })).status).toBe(401);
      expect((await post(db, { body: { code: '1' }, headers: { 'x-api-key': 'internal-test-key' } })).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
    expect(db.audits).toEqual([]);
  });

  test('empty, blank, non-string or over-long code: 400, nothing recorded', async () => {
    const db = makeDb();
    const auth = { Authorization: 'Bearer ' + token() };
    for (const body of [{}, { code: '' }, { code: '  \n ' }, { code: 5 }, { code: ['x'] }, { code: 'x'.repeat(router.CODE_MAX + 1) }]) {
      expect([JSON.stringify(body).slice(0, 30), (await post(db, { body, headers: auth })).status])
        .toEqual([JSON.stringify(body).slice(0, 30), 400]);
    }
    expect((await post(db, { body: { code: 'x'.repeat(router.CODE_MAX) }, headers: auth })).status).toBe(200);
    expect(db.audits).toHaveLength(1);
  });

  test('the audit write fails: 500, so the dialog runs nothing', async () => {
    const db = makeDb({ failAudit: true });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await post(db, { body: { code: '1' }, headers: { Authorization: 'Bearer ' + token() } });
    err.mockRestore();
    expect(r.status).toBe(500);
    expect(r.body.status).toBe('error');
  });

  test('read-only View-as: allowed, recorded under the REAL actor with the target in details', async () => {
    const db = makeDb();
    const t = token({ extra: { view_as: true, view_as_mode: 'readonly', act: { sub: '6', username: 'it' } } });
    const r = await post(db, { body: { code: '1+1' }, headers: { Authorization: 'Bearer ' + t } });
    expect(r.status).toBe(200);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ user_id: 6, username: 'it' });
    expect(db.audits[0].details).toEqual({ code: '1+1', target_user_id: 2, target_username: 'staff' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// the dialog

function boot({ audit = () => Promise.resolve({ status: 'success', run_id: 1 }),
  finish = () => Promise.resolve({ status: 'success' }) } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body>'
    + '<button id="launch" onclick="openCodeBox()">Code</button><input id="before"></body></html>',
  { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  const log = [];
  w.__log = log;
  w.apiSend = (url, method, payload) => {
    log.push(['apiSend', url, method, payload]);
    if (url === '/api/code-box/runs') return audit(payload);
    if (/^\/api\/code-box\/runs\/\d+\/finish$/.test(url)) return finish(payload);
    return Promise.resolve({ from: url });
  };
  w.eval(SRC);
  const d = w.document;
  const q = (s) => d.querySelector('#ycCodeBox ' + s);
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const type = (text) => { q('textarea').value = text; q('textarea').dispatchEvent(new w.Event('input', { bubbles: true })); };
  const key = (k, opts = {}) => q('textarea').dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  return { w, d, q, log, flush, type, key, close: () => w.close() };
}

describe('the Code dialog', () => {
  let t;
  afterEach(() => t && t.close());

  test('the launcher\'s page call opens it, through a rendered onclick, empty and focused', () => {
    t = boot();
    t.d.getElementById('before').focus();
    t.d.getElementById('launch').click();
    expect(t.w.ycCodeBox.isOpen()).toBe(true);
    expect(t.q('').hidden).toBe(false);
    expect(t.q('textarea').value).toBe('');
    expect(t.d.activeElement).toBe(t.q('textarea'));
    expect(t.q('[role="note"]').textContent).toMatch(/runs as you/i);
    t.q('.ycb-close').click();
    expect(t.w.ycCodeBox.isOpen()).toBe(false);
    expect(t.d.activeElement).toBe(t.d.getElementById('before'));   // focus goes back
  });

  test('it cannot be pre-filled: reopen preserves only the locally typed draft, and Clear resets it', () => {
    t = boot();
    t.w.openCodeBox('window.__log.push("prefilled")');
    expect(t.q('textarea').value).toBe('');
    t.w.ycCodeBox.close();
    t.w.ycCodeBox.open('window.__log.push("prefilled")');
    expect(t.q('textarea').value).toBe('');
    t.w.ycCodeBox.close();
    t.w.ycCodeBox.open({ code: 'x' }, 'y');
    expect(t.q('textarea').value).toBe('');
    t.type('1+1');
    t.w.ycCodeBox.close();
    t.w.ycCodeBox.open('untrusted replacement');
    expect(t.q('textarea').value).toBe('1+1');
    t.q('.ycb-clear').click();
    expect(t.q('textarea').value).toBe('');
    expect(t.w.ycCodeBox.open.length).toBe(0);
  });

  test('typing or pasting runs nothing; Run audits FIRST, then runs, and shows an expression\'s value', async () => {
    t = boot();
    t.w.openCodeBox();
    t.type('(window.__log.push(["ran"]), 1 + 1)');
    t.q('textarea').dispatchEvent(new t.w.Event('paste', { bubbles: true }));
    await t.flush();
    expect(t.log).toEqual([]);
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.log).toEqual([
      ['apiSend', '/api/code-box/runs', 'POST', { code: '(window.__log.push(["ran"]), 1 + 1)' }],
      ['ran'],
      ['apiSend', '/api/code-box/runs/1/finish', 'POST', { status: 'success', duration_ms: expect.any(Number) }],
    ]);
    expect(t.q('.ycb-out').textContent).toBe('2');
    expect(t.q('.ycb-out').classList.contains('is-error')).toBe(false);
    expect(t.q('.ycb-status').textContent).toMatch(/^Done in \d+ ms\.$/);
  });

  test('statements with await: apiSend works, and a return value is shown as JSON', async () => {
    t = boot();
    t.w.openCodeBox();
    t.type("const r = await apiSend('/api/cases/5');\nreturn { r, n: [1, 2] };");
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.log.map((x) => x[1])).toEqual(['/api/code-box/runs', '/api/cases/5', '/api/code-box/runs/1/finish']);
    expect(JSON.parse(t.q('.ycb-out').textContent)).toEqual({ r: { from: '/api/cases/5' }, n: [1, 2] });
  });

  test('the audit fails (an error, or any answer but success): NOTHING runs', async () => {
    for (const audit of [
      () => Promise.reject(Object.assign(new Error('Forbidden'), { name: 'ApiError', status: 403, url: '/api/code-box/runs', method: 'POST', body: { error: 'Forbidden' } })),
      () => Promise.resolve({ status: 'error' }),
      () => Promise.resolve(null),
    ]) {
      t = boot({ audit });
      t.w.openCodeBox();
      t.type('window.__log.push(["ran"])');
      t.q('.ycb-run').click();
      await t.flush();
      expect(t.log.filter((x) => x[0] === 'ran')).toEqual([]);
      expect(t.q('.ycb-status').textContent).toBe('Not run: the run could not be recorded.');
      expect(t.q('.ycb-out').classList.contains('is-error')).toBe(true);
      expect(t.q('.ycb-run').disabled).toBe(false);
      t.close();
    }
    t = null;
  });

  test('closed while recording: run continues once, and reopen restores its result', async () => {
    let release;
    t = boot({ audit: () => new Promise((r) => { release = r; }) });
    t.w.openCodeBox();
    t.type('window.__log.push(["ran"])');
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.q('.ycb-run').disabled).toBe(true);
    t.q('.ycb-x').click();
    release({ status: 'success', run_id: 1 });
    await t.flush();
    expect(t.log.filter((x) => x[0] === 'ran')).toHaveLength(1);
    t.w.openCodeBox();
    expect(t.q('textarea').value).toBe('window.__log.push(["ran"])');
    expect(t.q('.ycb-out').hidden).toBe(false);
    expect(t.q('.ycb-status').textContent).toMatch(/^Done in/);
  });

  test('a syntax error is reported and nothing is audited or run', async () => {
    t = boot();
    t.w.openCodeBox();
    t.type('return (;');
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.log).toEqual([]);
    expect(t.q('.ycb-status').textContent).toBe('Not run: the code has a syntax error.');
    expect(t.q('.ycb-out').textContent).toMatch(/SyntaxError/);
  });

  test('a thrown error, and an apiSend ApiError with its status and body, are shown as errors', async () => {
    t = boot();
    t.w.openCodeBox();
    t.type("throw new Error('boom')");
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.q('.ycb-out').classList.contains('is-error')).toBe(true);
    expect(t.q('.ycb-out').textContent).toMatch(/Error: boom/);
    expect(t.q('.ycb-status').textContent).toMatch(/^Threw an error in \d+ ms\.$/);
    t.type("const e = new Error('Forbidden'); e.name = 'ApiError'; e.status = 403; e.method = 'GET'; e.url = '/api/x'; e.body = { error: 'Forbidden' }; throw e;");
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.q('.ycb-out').textContent).toBe('ApiError: Forbidden\nGET /api/x → HTTP 403\n{\n  "error": "Forbidden"\n}');
  });

  test('Ctrl+Enter and ⌘+Enter run; plain Enter does not; Esc closes; no key escapes the dialog', async () => {
    t = boot();
    const heard = [];
    t.d.addEventListener('keydown', (e) => heard.push(e.key));
    t.w.openCodeBox();
    t.type('window.__log.push(["ran"])');
    t.key('Enter');
    t.key('k', { ctrlKey: true });
    await t.flush();
    expect(t.log).toEqual([]);
    t.key('Enter', { ctrlKey: true });
    await t.flush();
    expect(t.log.filter((x) => x[0] === 'ran')).toHaveLength(1);
    t.key('Enter', { metaKey: true });
    await t.flush();
    expect(t.log.filter((x) => x[0] === 'ran')).toHaveLength(2);
    t.key('Escape');
    expect(t.w.ycCodeBox.isOpen()).toBe(false);
    expect(heard).toEqual([]);
  });

  test('a click on the backdrop does not close it (pasted code is not thrown away)', () => {
    t = boot();
    t.w.openCodeBox();
    t.type('1');
    t.q('.ycb-back').click();
    expect(t.w.ycCodeBox.isOpen()).toBe(true);
    expect(t.q('textarea').value).toBe('1');
  });

  test('format: strings as they are, undefined, cycles, Maps, Sets, elements', () => {
    t = boot();
    const f = t.w.ycCodeBox._format;
    expect(f('hi')).toBe('hi');
    expect(f(undefined)).toBe('undefined');
    const o = { a: 1 }; o.self = o;
    expect(JSON.parse(f(o))).toEqual({ a: 1, self: '[Circular]' });
    expect(JSON.parse(f(t.w.eval("new Map([['k', 1]])")))).toEqual({ Map: [['k', 1]] });
    expect(JSON.parse(f(t.w.eval('new Set([1])')))).toEqual({ Set: [1] });
    expect(f(t.d.getElementById('launch'))).toBe('<button#launch>');
    expect(JSON.parse(f({ el: t.d.getElementById('launch') }))).toEqual({ el: '<button#launch>' });
    // a repeated reference is not a cycle; non-finite numbers keep their names
    const shared = { k: 1 };
    expect(JSON.parse(f([shared, shared]))).toEqual([{ k: 1 }, { k: 1 }]);
    expect(f(NaN)).toBe('NaN');
    expect(JSON.parse(f({ a: Infinity, b: NaN }))).toEqual({ a: 'Infinity', b: 'NaN' });
    // another realm's Map / Set / Error (a pane's frame) reads the same as the shell's
    expect(JSON.parse(f(new Map([['k', 1]])))).toEqual({ Map: [['k', 1]] });
    expect(JSON.parse(f(new Set([2])))).toEqual({ Set: [2] });
    expect(JSON.parse(f({ e: new Error('x') }))).toEqual({ e: { name: 'Error', message: 'x' } });
  });

  test('a second Ctrl+Enter while the audit is in flight runs nothing more: one audit, one run', async () => {
    let release;
    t = boot({ audit: () => new Promise((r) => { release = r; }) });
    t.w.openCodeBox();
    t.type('window.__log.push(["ran"])');
    t.key('Enter', { ctrlKey: true });
    await t.flush();
    t.key('Enter', { ctrlKey: true });
    t.key('Enter', { metaKey: true, repeat: true });
    await t.flush();
    release({ status: 'success' });
    await t.flush();
    expect(t.log.filter((x) => x[1] === '/api/code-box/runs')).toHaveLength(1);
    expect(t.log.filter((x) => x[0] === 'ran')).toHaveLength(1);
  });

  test('Tab cycles inside the dialog both ways; focus never reaches the page behind', async () => {
    t = boot();
    t.w.openCodeBox();
    const x = t.q('.ycb-x'), run = t.q('.ycb-run'), close = t.q('.ycb-close');
    const tab = (shift) => t.d.activeElement.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true }));
    expect(t.d.activeElement).toBe(t.q('textarea'));
    tab(); expect(t.d.activeElement).toBe(t.q('.ycb-clear'));
    tab(); expect(t.d.activeElement).toBe(close);   // output and Copy are hidden before a run
    tab(); expect(t.d.activeElement).toBe(run);
    tab(); expect(t.d.activeElement).toBe(x);       // wraps
    tab(true); expect(t.d.activeElement).toBe(run); // and back
    t.type('1');
    run.click();
    await t.flush();
    t.q('textarea').focus();
    tab(); expect(t.d.activeElement).toBe(t.q('.ycb-out'));
    tab(); expect(t.d.activeElement).toBe(t.q('.ycb-copy'));
  });

  test('while open, a key aimed behind it never reaches the page (Esc closes) — but a SweetAlert still gets its keys', () => {
    t = boot();
    const heard = [];
    t.d.addEventListener('keydown', (e) => heard.push(e.key));
    const swal = t.d.createElement('div');
    swal.className = 'swal2-container';
    swal.innerHTML = '<input id="swalIn">';
    t.d.body.appendChild(swal);
    t.w.openCodeBox();
    const behind = t.d.getElementById('before');
    behind.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(heard).toEqual([]);
    expect(t.d.activeElement).toBe(t.q('textarea'));     // focus put back in the editor
    t.d.getElementById('swalIn').dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    expect(heard).toEqual(['a']);                         // the snippet's dialog keeps its keys
    t.d.body.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(t.w.ycCodeBox.isOpen()).toBe(false);
    // closed: the guard is gone, the page hears its keys again
    behind.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(heard).toEqual(['a', 'k']);
  });

  test('Esc during IME composition does not close it (no pasted code lost)', () => {
    t = boot();
    t.w.openCodeBox();
    t.type('1');
    t.key('Escape', { isComposing: true });
    expect(t.w.ycCodeBox.isOpen()).toBe(true);
  });

  test('the client and route length limits agree', () => {
    t = boot();
    expect(t.w.ycCodeBox.CODE_MAX).toBe(router.CODE_MAX);
  });
});


describe('Code run outcomes', () => {
  const auth = (opts) => ({ Authorization: 'Bearer ' + token(opts) });
  const start = (db, opts) => post(db, { body: { code: '1' }, headers: auth(opts) });
  const finish = (db, body = { status: 'success', duration_ms: 12 }, opts, id = '1') => post(db, {
    url: '/api/code-box/runs/' + id + '/finish', body, headers: auth(opts),
  });

  test.each(['success', 'error'])('records %s and duration on the original row, only once', async (status) => {
    const db = makeDb();
    await start(db);
    expect((await finish(db, { status, duration_ms: 17 })).status).toBe(200);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ status, duration_ms: 17, details: { code: '1' } });
    expect((await finish(db)).status).toBe(404);
  });

  test('another staff user, another tool, or another View-as target cannot finish a run', async () => {
    const db = makeDb();
    await start(db);
    expect((await finish(db, undefined, { sub: 3 })).status).toBe(404);
    db.audits[0].tool = 'api_tester';
    expect((await finish(db)).status).toBe(404);
    db.audits[0].tool = 'code_box';
    const view = { sub: 4, extra: { view_as: true, view_as_mode: 'readonly', act: { sub: '2', username: 'staff' } } };
    expect((await finish(db, undefined, view)).status).toBe(404);
    expect(db.audits[0].status).toBe('run');
    await start(db, view);
    expect((await finish(db, undefined, view, '2')).status).toBe(200);
    expect(db.audits[1]).toMatchObject({ user_id: 2, status: 'success', details: { target_user_id: 4 } });
  });

  test('missing auth and invalid outcomes are refused; DB failure is visible', async () => {
    const db = makeDb();
    await start(db);
    expect((await post(db, { url: '/api/code-box/runs/1/finish', body: { status: 'success', duration_ms: 0 } })).status).toBe(401);
    for (const body of [{}, { status: 'run', duration_ms: 1 }, { status: 'success', duration_ms: -1 },
      { status: 'error', duration_ms: 1.5 }, { status: 'error', duration_ms: '2' },
      { status: 'success', duration_ms: 2147483648 }]) {
      expect((await finish(db, body)).status).toBe(400);
    }
    for (const id of ['0', '-1', 'abc', '9007199254740992']) {
      expect((await finish(db, undefined, undefined, id)).status).toBe(400);
    }
    const broken = makeDb({ failFinish: true });
    await start(broken);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await finish(broken)).status).toBe(500); } finally { spy.mockRestore(); }
    expect(broken.audits[0].status).toBe('run');
  });
});

describe('Code console and retained session', () => {
  let t;
  afterEach(() => t && t.close());

  test('captures console levels, objects and assertions live without replacing the shell console', async () => {
    t = boot();
    const native = t.w.console;
    const spies = ['log', 'info', 'warn', 'error', 'debug', 'table', 'dir', 'assert', 'trace']
      .map((name) => jest.spyOn(native, name).mockImplementation(() => {}));
    t.w.openCodeBox();
    t.type(`console.log('hello', { n: 1 }); console.info('info'); console.warn('warn');
      console.error('error'); console.debug('debug'); console.table([{ a: 2 }]); console.dir({ b: 3 });
      console.assert(true, 'not shown'); console.assert(false, 'failed'); console.trace('trace');
      await new Promise(r => window.releaseRun = r); return 'finished';`);
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.w.console).toBe(native);
    const output = t.q('.ycb-out').textContent;
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'table', 'dir', 'assert', 'trace']) {
      expect(output).toContain('[' + level + ']');
    }
    expect(output).toContain('"n": 1');
    expect(output).not.toContain('not shown');
    native.log('unrelated app log');
    expect(t.q('.ycb-out').textContent).toBe(output);
    expect(spies[0]).toHaveBeenCalledWith('hello', { n: 1 });
    t.w.releaseRun();
    await t.flush();
    expect(t.q('.ycb-out').textContent).toContain('finished');
    expect(t.q('.ycb-status').textContent).toMatch(/^Done in/); // console.error is a message, not a thrown error
    spies.forEach((s) => s.mockRestore());
  });

  test('closing while running preserves the draft, output and lock; reopening cannot start a duplicate', async () => {
    t = boot();
    jest.spyOn(t.w.console, 'log').mockImplementation(() => {});
    t.w.openCodeBox();
    t.type(`console.log('before'); await new Promise(r => window.releaseRun = r); console.log('after'); return 42;`);
    t.q('.ycb-run').click();
    await t.flush();
    t.key('Escape');
    expect(t.w.ycCodeBox.isOpen()).toBe(false);
    t.w.openCodeBox();
    expect(t.q('.ycb-out').textContent).toContain('before');
    expect(t.q('.ycb-run').disabled).toBe(true);
    expect(t.q('.ycb-clear').disabled).toBe(true);
    t.key('Enter', { ctrlKey: true });
    t.q('.ycb-clear').click();
    expect(t.log.filter((x) => x[1] === '/api/code-box/runs')).toHaveLength(1);
    t.q('.ycb-close').click();
    t.w.releaseRun();
    await t.flush();
    t.w.openCodeBox();
    expect(t.q('.ycb-out').textContent).toContain('[log] after\n\n42');
    expect(t.q('.ycb-run').disabled).toBe(false);
    t.q('.ycb-clear').click();
    expect(t.q('textarea').value).toBe('');
    expect(t.q('.ycb-out').hidden).toBe(true);
  });

  test('late callbacks cannot overwrite a newer run; output is capped and Copy uses retained text', async () => {
    t = boot();
    jest.spyOn(t.w.console, 'log').mockImplementation(() => {});
    t.w.openCodeBox();
    t.type(`window.lateLog = () => console.log('old callback'); window.lateClear = () => console.clear(); console.log('x'.repeat(300000)); return 1;`);
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.q('.ycb-out').textContent.length).toBeLessThan(201000);
    expect(t.q('.ycb-out').textContent).toContain('more characters');
    expect(t.q('.ycb-out').textContent).toContain('console output limit reached');
    let copied;
    t.w.navigator.clipboard = { writeText: (text) => { copied = text; return Promise.resolve(); } };
    t.q('.ycb-copy').click();
    await t.flush();
    expect(copied).toContain('console output limit reached');
    expect(copied).toMatch(/\n\n1$/);
    t.type('2');
    t.q('.ycb-run').click();
    await t.flush();
    t.w.lateLog();
    t.w.lateClear();
    expect(t.q('.ycb-out').textContent).toBe('2');
  });

  test('console.clear clears captured messages without clearing the draft', async () => {
    t = boot();
    jest.spyOn(t.w.console, 'log').mockImplementation(() => {});
    t.w.openCodeBox();
    t.type(`console.log('removed'); console.clear(); console.log('kept'); return 3;`);
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.q('.ycb-out').textContent).toBe('[log] kept\n\n3');
    expect(t.q('textarea').value).toContain('removed');
  });

  test.each([false, true])('reports completion or error, retaining results when the outcome write fails (throws=%s)', async (throws) => {
    t = boot({ finish: () => Promise.reject(new Error('offline')) });
    t.w.openCodeBox();
    t.type(throws ? `throw new Error('boom')` : '21 * 2');
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.q('.ycb-out').textContent).toContain(throws ? 'boom' : '42');
    expect(t.q('.ycb-status').textContent).toContain('Completion could not be recorded.');
    expect(t.q('.ycb-run').disabled).toBe(false);
    expect(t.log.filter((x) => /finish$/.test(x[1]))).toEqual([
      ['apiSend', '/api/code-box/runs/1/finish', 'POST', { status: throws ? 'error' : 'success', duration_ms: expect.any(Number) }],
    ]);
    expect(t.log.filter((x) => x[1] === '/api/code-box/runs')).toHaveLength(1);
  });
});


describe('Code execution compatibility and pending audit', () => {
  let t;
  afterEach(() => t && t.close());

  test('keeps top-shell this, zero snippet arguments, and locally declared console bindings', async () => {
    t = boot();
    t.w.openCodeBox();
    t.type(`const console = { local: true }; return { top: this === window.top, args: arguments.length, local: console.local };`);
    t.q('.ycb-run').click();
    await t.flush();
    expect(JSON.parse(t.q('.ycb-out').textContent)).toEqual({ top: true, args: 0, local: true });
  });

  test('a delayed outcome does not lock execution or repaint a newer run in the same session', async () => {
    let release, calls = 0;
    t = boot({ finish: () => ++calls === 1 ? new Promise(r => { release = r; }) : Promise.resolve({ status: 'success' }) });
    t.w.openCodeBox();
    t.type('1');
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.q('.ycb-run').disabled).toBe(false);
    expect(t.q('.ycb-clear').disabled).toBe(false);
    t.type('2');
    t.q('.ycb-run').click();
    await t.flush();
    const status = t.q('.ycb-status').textContent;
    release({ status: 'error' });
    await t.flush();
    expect(t.q('.ycb-status').textContent).toBe(status);
    expect(t.q('.ycb-out').textContent).toBe('2');
  });

  test.each([null, { status: 'error' }])('a non-success outcome answer is visible without retrying the snippet: %s', async (answer) => {
    t = boot({ finish: () => Promise.resolve(answer) });
    t.w.openCodeBox();
    t.type('window.__log.push(["once"]); return 9;');
    t.q('.ycb-run').click();
    await t.flush();
    expect(t.q('.ycb-status').textContent).toContain('Completion could not be recorded.');
    expect(t.q('.ycb-out').textContent).toBe('9');
    expect(t.log.filter(x => x[0] === 'once')).toHaveLength(1);
  });
});


test('old log and clear callbacks independently leave a newer run alone', async () => {
  const t = boot();
  jest.spyOn(t.w.console, 'log').mockImplementation(() => {});
  try {
    t.w.openCodeBox();
    t.type(`window.oldLog = () => console.log('old'); window.oldClear = () => console.clear(); console.log('first run'); return 1;`);
    t.q('.ycb-run').click();
    await t.flush();
    t.type('2');
    t.q('.ycb-run').click();
    await t.flush();
    t.w.oldLog();
    expect(t.q('.ycb-out').textContent).toBe('2');
    t.w.oldClear();
    expect(t.q('.ycb-out').textContent).toBe('2');
  } finally { t.close(); }
});


test('a new syntax error retires callbacks and the pending outcome of the prior run', async () => {
  let release;
  const t = boot({ finish: () => new Promise(r => { release = r; }) });
  jest.spyOn(t.w.console, 'log').mockImplementation(() => {});
  try {
    t.w.openCodeBox();
    t.type(`window.oldLog = () => console.log('old'); return 1;`);
    t.q('.ycb-run').click();
    await t.flush();
    t.type('return (;');
    t.q('.ycb-run').click();
    await t.flush();
    const before = t.q('.ycb-out').textContent;
    expect(before).toContain('SyntaxError');
    t.w.oldLog();
    release({ status: 'success' });
    await t.flush();
    expect(t.q('.ycb-out').textContent).toBe(before);
    expect(t.q('.ycb-status').textContent).toBe('Not run: the code has a syntax error.');
  } finally { t.close(); }
});
