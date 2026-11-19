// tests/clientUploadPages.landed.test.js
//
// Docs intake S3 — the two upload pages report each file AS IT LANDS:
//
//   public/docReq.html         → POST /api/public/upload-landed
//   public/portal/docs.html    → POST /api/portal/cases/:id/docs/upload-landed
//
// BOOTS THE REAL PAGES in jsdom (the tests/portalCaseUi.timeline.test.js
// harness: `runScripts:'outside-only'`, the page's one inline block eval'd,
// portal.js eval'd FOR REAL for the portal page), with only the transport
// stubbed: window.fetch (our server), window.XMLHttpRequest (Dropbox's PUT),
// and — docReq only — window.Swal (a CDN library; the stub renders its html so
// the page's progress elements exist).
//
// ── WHAT IS RUN-TIME-ONLY HERE ──────────────────────────────────────────────
//   · ONE KEY PER RUN: every landed call and the final upload-complete carry
//     the same batch key; the next run mints a new one. A shared key across
//     runs would append run 2 to run 1's (closed) row — refused, and only the
//     final list would report them.
//   · keepalive: true ON EVERY LANDED CALL — the whole point: the request must
//     outlive a tab or phone that closes right after the file lands.
//   · ONLY SUCCESSES are reported, each right after its Dropbox PUT (before
//     the next file's link) — a failed PUT reports nothing.
//   · NOTHING ELSE CHANGES in the UX: the final upload-complete still names
//     the successes, now with `batch`.
//
// Run:
//   npx jest tests/clientUploadPages.landed.test.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
// The pages console.error a failed PUT on purpose; keep jest's output for real failures.
const quiet = () => new VirtualConsole();

const ROOT     = path.join(__dirname, '..');
const DOCREQ   = fs.readFileSync(path.join(ROOT, 'public/docReq.html'), 'utf8');
const PORTAL   = fs.readFileSync(path.join(ROOT, 'public/portal/docs.html'), 'utf8');
const PORTALJS = fs.readFileSync(path.join(ROOT, 'public/portal/portal.js'), 'utf8');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } }); });

const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));
const KEY_RE = /^[a-f0-9]{32}$/;

function inlineScript(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // Fence: a second inline block means the page was restructured and this harness is stale.
  expect(inline).toHaveLength(1);
  return inline[0];
}

/** Dropbox's temporary-link PUT, as the pages drive it (XHR for progress). `fail` names files whose PUT 500s. */
function installXhr(window, fail = new Set()) {
  const puts = [];
  window.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(file) {
      puts.push({ url: this.url, name: file.name });
      window.setTimeout(() => {
        if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: 1, total: 1 });
        this.status = fail.has(file.name) ? 500 : 200;
        this.onload();
      }, 1);
    }
  };
  return puts;
}

/** The transport log: every fetch the page makes, in order, with its body parsed. */
function installFetch(window, routes) {
  const calls = [];
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const entry = { url: u, method: opts.method || 'GET', keepalive: opts.keepalive === true, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(entry);
    const out = routes(u, entry);
    return { ok: (out.status || 200) < 400, status: out.status || 200, json: async () => out.json };
  };
  return calls;
}

const file = (window, name, bytes = 'abc') => new window.File([bytes], name, { type: 'application/pdf' });
function setFiles(input, files) { Object.defineProperty(input, 'files', { configurable: true, value: files }); }
async function until(window, pred, ms = 2000) {
  for (let t = 0; t < ms; t += 10) { if (pred()) return; await tick(window, 10); }
  throw new Error('timed out waiting for the page');
}

// ─────────────────────────────────────────────────────────────────────────────
// public/docReq.html
// ─────────────────────────────────────────────────────────────────────────────

async function bootDocReq({ fail, noRandomUUID = false, confirmMore = false } = {}) {
  const dom = new JSDOM(DOCREQ, { url: 'https://app.4lsg.com/docReq.html?case=PVXC1RMM', runScripts: 'outside-only', virtualConsole: quiet() });
  DOMS.push(dom);
  const { window } = dom;
  if (noRandomUUID) Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: undefined });
  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  let finals = 0;
  window.Swal = {
    fire(opts) {
      if (opts && opts.didOpen) {
        const host = window.document.createElement('div');
        host.innerHTML = opts.html || '';
        window.document.body.appendChild(host);
        window.setTimeout(() => opts.didOpen(), 0);
        return Promise.resolve({ isConfirmed: false });
      }
      if (opts && opts.confirmButtonText === 'Upload More Documents') finals++;
      return Promise.resolve({ isConfirmed: confirmMore });
    },
  };
  const puts = installXhr(window, fail);
  let link = 0;
  const calls = installFetch(window, (u) => {
    if (u.startsWith('/api/public/docs/')) return { json: { name: 'Jane', items: ['W2'] } };
    if (u === '/api/public/get-upload-link') return { json: { link: `https://content.dropboxapi.com/up/${++link}` } };
    if (u === '/api/public/upload-landed') return { json: { status: 'success' } };
    if (u === '/api/public/upload-complete') return { json: { status: 'success' } };
    return { status: 404, json: {} };
  });
  window.eval(inlineScript(DOCREQ));
  await tick(window, 20);
  return { window, calls, puts, errors, finals: () => finals };
}

async function runDocReq(env, names, comment = '') {
  const { window } = env;
  setFiles(window.document.getElementById('files'), names.map(n => file(window, n)));
  window.document.getElementById('client-comment').value = comment;
  const before = env.finals();
  window.document.getElementById('upload-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(window, () => env.finals() > before);
}

describe('public/docReq.html', () => {
  test('one landed call per successful PUT — keepalive, the run\'s key, name + size, the comment — then upload-complete with the same key', async () => {
    const env = await bootDocReq();
    await runDocReq(env, ['W2.pdf', '2025 return.pdf'], 'taxes');
    expect(env.errors).toEqual([]);

    const landed = env.calls.filter(c => c.url === '/api/public/upload-landed');
    expect(landed).toHaveLength(2);
    for (const c of landed) {
      expect(c.method).toBe('POST');
      expect(c.keepalive).toBe(true);
      expect(c.headers['Content-Type']).toBe('application/json');
    }
    const key = landed[0].body.batch;
    expect(key).toMatch(KEY_RE);
    expect(landed.map(c => c.body)).toEqual([
      { case_id: 'PVXC1RMM', batch: key, file: { name: 'W2.pdf', size: 3 }, comment: 'taxes' },
      { case_id: 'PVXC1RMM', batch: key, file: { name: '2025 return.pdf', size: 3 }, comment: 'taxes' },
    ]);
    const complete = env.calls.filter(c => c.url === '/api/public/upload-complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].body).toEqual({ case_id: 'PVXC1RMM', files: ['W2.pdf', '2025 return.pdf'], comment: 'taxes', batch: key });
  });

  test('each file is reported right after ITS PUT — before the next file\'s link, before upload-complete', async () => {
    const env = await bootDocReq();
    await runDocReq(env, ['a.pdf', 'b.pdf']);
    const seq = env.calls.map(c => c.url.replace('/api/public/', '')).filter(u => !u.startsWith('docs/'));
    expect(seq).toEqual(['get-upload-link', 'upload-landed', 'get-upload-link', 'upload-landed', 'upload-complete']);
  });

  test('a failed PUT reports nothing; the successes still do', async () => {
    const env = await bootDocReq({ fail: new Set(['bad.pdf']) });
    await runDocReq(env, ['ok1.pdf', 'bad.pdf', 'ok2.pdf']);
    expect(env.puts.map(p => p.name)).toEqual(['ok1.pdf', 'bad.pdf', 'ok2.pdf']);
    const landed = env.calls.filter(c => c.url === '/api/public/upload-landed').map(c => c.body.file.name);
    expect(landed).toEqual(['ok1.pdf', 'ok2.pdf']);
    expect(env.calls.find(c => c.url === '/api/public/upload-complete').body.files).toEqual(['ok1.pdf', 'ok2.pdf']);
  });

  test('a run where every PUT fails sends no landed call and no upload-complete', async () => {
    const env = await bootDocReq({ fail: new Set(['x.pdf']) });
    await runDocReq(env, ['x.pdf']);
    expect(env.calls.some(c => c.url === '/api/public/upload-landed' || c.url === '/api/public/upload-complete')).toBe(false);
  });

  test('"Upload More Documents" starts a NEW key; no comment → null', async () => {
    const env = await bootDocReq({ confirmMore: true });
    await runDocReq(env, ['a.pdf']);
    await runDocReq(env, ['b.pdf']);
    const landed = env.calls.filter(c => c.url === '/api/public/upload-landed');
    expect(landed).toHaveLength(2);
    expect(landed[0].body.batch).not.toBe(landed[1].body.batch);
    expect(landed[1].body.comment).toBeNull();
    const completes = env.calls.filter(c => c.url === '/api/public/upload-complete');
    expect(completes.map(c => c.body.batch)).toEqual([landed[0].body.batch, landed[1].body.batch]);
  });

  test('without crypto.randomUUID the key still comes out as 32 hex (getRandomValues)', async () => {
    const env = await bootDocReq({ noRandomUUID: true });
    expect(env.window.crypto.randomUUID).toBeUndefined();
    await runDocReq(env, ['a.pdf']);
    expect(env.calls.find(c => c.url === '/api/public/upload-landed').body.batch).toMatch(KEY_RE);
  });

  test('a landed call that fails (network) never breaks the run', async () => {
    const env = await bootDocReq();
    const orig = env.window.fetch;
    env.window.fetch = async (url, opts) => {
      if (String(url) === '/api/public/upload-landed') { orig(url, opts); throw new TypeError('Failed to fetch'); }
      return orig(url, opts);
    };
    await runDocReq(env, ['a.pdf', 'b.pdf']);
    expect(env.errors).toEqual([]);
    expect(env.calls.find(c => c.url === '/api/public/upload-complete').body.files).toEqual(['a.pdf', 'b.pdf']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// public/portal/docs.html
// ─────────────────────────────────────────────────────────────────────────────

const CASE_ID = 'AbCdEf12';
const BASE = `/api/portal/cases/${CASE_ID}/docs`;

async function bootPortal({ fail } = {}) {
  const dom = new JSDOM(PORTAL, { url: `https://app.4lsg.com/portal/docs.html?id=${CASE_ID}`, runScripts: 'outside-only', virtualConsole: quiet() });
  DOMS.push(dom);
  const { window } = dom;
  window.localStorage.setItem('portal_token', 'test-token');
  window.Element.prototype.scrollIntoView = function () {};   // not in jsdom; the page calls it on the progress card
  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  const puts = installXhr(window, fail);
  let link = 0;
  const calls = installFetch(window, (u, c) => {
    if (u === '/api/portal/branding') return { json: {} };
    if (u === BASE && c.method === 'GET') {
      return { json: { status: 'success', case_id: CASE_ID, has_upload: true, items: [{ id: 7, name: 'Bank statements', status: 'needed' }] } };
    }
    if (u === `${BASE}/upload-link`) return { json: { status: 'success', link: `https://content.dropboxapi.com/up/${++link}` } };
    if (u === `${BASE}/upload-landed`) return { json: { status: 'success' } };
    if (u === `${BASE}/upload-complete`) return { json: { status: 'success' } };
    return { status: 404, json: {} };
  });
  window.eval(PORTALJS);
  window.eval(inlineScript(PORTAL));
  await tick(window, 30);
  return { window, calls, puts, errors };
}

async function runPortal(env, { item = null, names, comment }) {
  const { window } = env;
  const doc = window.document;
  if (item != null) doc.querySelector(`button.up[data-item="${item}"]`).click();
  else {
    if (comment != null) doc.getElementById('comment').value = comment;
    doc.getElementById('btn-other').click();
  }
  const input = doc.getElementById('file-input');
  setFiles(input, names.map(n => file(window, n)));
  const completes = env.calls.filter(c => c.url === `${BASE}/upload-complete`).length;
  const gets = env.calls.filter(c => c.url === BASE).length;
  input.dispatchEvent(new window.Event('change'));
  // done = upload-complete sent (or skipped) AND the list re-fetched
  await until(window, () => env.calls.filter(c => c.url === BASE).length > gets);
  return env.calls.filter(c => c.url === `${BASE}/upload-complete`).length > completes;
}

describe('public/portal/docs.html', () => {
  test('per-item batch: a landed call per success — keepalive, Bearer, the key, name + item id — then upload-complete with the key', async () => {
    const env = await bootPortal();
    expect(await runPortal(env, { item: 7, names: ['NFCU jan.pdf', 'NFCU feb.pdf'] })).toBe(true);
    expect(env.errors).toEqual([]);

    const landed = env.calls.filter(c => c.url === `${BASE}/upload-landed`);
    expect(landed).toHaveLength(2);
    for (const c of landed) {
      expect(c.method).toBe('POST');
      expect(c.keepalive).toBe(true);
      expect(c.headers.Authorization).toBe('Bearer test-token');   // through Portal.fetch
      expect(c.headers['Content-Type']).toBe('application/json');
    }
    const key = landed[0].body.batch;
    expect(key).toMatch(KEY_RE);
    expect(landed.map(c => c.body)).toEqual([
      { batch: key, file: { name: 'NFCU jan.pdf', item_id: 7 }, comment: null },
      { batch: key, file: { name: 'NFCU feb.pdf', item_id: 7 }, comment: null },
    ]);
    const complete = env.calls.find(c => c.url === `${BASE}/upload-complete`);
    expect(complete.body).toEqual({
      files: [{ name: 'NFCU jan.pdf', item_id: 7 }, { name: 'NFCU feb.pdf', item_id: 7 }],
      comment: null, batch: key,
    });
  });

  test('"Other documents": no item id, the comment rides each landed call; the next batch gets a new key', async () => {
    const env = await bootPortal();
    await runPortal(env, { names: ['lease.pdf'], comment: 'my lease' });
    await runPortal(env, { item: 7, names: ['stmt.pdf'] });
    const landed = env.calls.filter(c => c.url === `${BASE}/upload-landed`);
    expect(landed[0].body).toEqual({ batch: expect.stringMatching(KEY_RE), file: { name: 'lease.pdf', item_id: null }, comment: 'my lease' });
    expect(landed[1].body.batch).toMatch(KEY_RE);
    expect(landed[1].body.batch).not.toBe(landed[0].body.batch);
    const completes = env.calls.filter(c => c.url === `${BASE}/upload-complete`);
    expect(completes.map(c => c.body.batch)).toEqual([landed[0].body.batch, landed[1].body.batch]);
  });

  test('order: each landed call right after its PUT, before the next link; a failed PUT reports nothing', async () => {
    const env = await bootPortal({ fail: new Set(['bad.pdf']) });
    await runPortal(env, { item: 7, names: ['a.pdf', 'bad.pdf', 'b.pdf'] });
    const seq = env.calls.map(c => c.url).filter(u => u.startsWith(`${BASE}/`)).map(u => u.slice(BASE.length + 1));
    expect(seq).toEqual(['upload-link', 'upload-landed', 'upload-link', 'upload-link', 'upload-landed', 'upload-complete']);
    expect(env.calls.filter(c => c.url === `${BASE}/upload-landed`).map(c => c.body.file.name)).toEqual(['a.pdf', 'b.pdf']);
  });
});
