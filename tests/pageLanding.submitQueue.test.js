/**
 * tests/pageLanding.submitQueue.test.js
 *
 * A landing-page form post is QUEUED for its hook the way the ack-first
 * webhook receiver queues a webhook (routes/pageLanding.js queueSubmission,
 * 2026-11-19). Until then handleSubmit called executeHook detached and
 * answered at once: the pipeline ran in Cloud Run's throttled post-response
 * tail, and a code filter/transform that found the sandbox busy failed for
 * good there — only lib/hookDrain re-queues one. hookService and taskQueue
 * are mocked at the module boundary (the drain and the pipeline have their own
 * suites; tests/pageLandingSubmit.mysql.test.js runs the real ones end to
 * end). This suite locks what the ROUTE guarantees:
 *
 *   1. RECORD, RING, ANSWER — in that order, all awaited: recordExecution
 *      (queued, NOT claimed) before the doorbell with that row's id, and the
 *      303 only after the doorbell resolves (a detached enqueue starves in
 *      the post-response tail).
 *   2. executeHook is never called on the normal path.
 *   3. The recorded input is the FLAT landing envelope, meta fields last so a
 *      form cannot spoof them.
 *   4. A dead doorbell (false) and a failed INSERT are both still the 303 to
 *      the thank-you target; nothing is rung for a row that was never written.
 *   5. Kill switch `hook_async_ack` = '0' → the old detached executeHook, no
 *      row of ours, no doorbell.
 *   6. Capture mode → executeHook awaited (the capture is a receive-time
 *      decision a queued row would skip).
 *   7. CATCH-ALL (Fred, 2026-11-19): a missing/inactive hook falls back to
 *      `_catchall` — the row keeps the page's hook slug, the envelope gains
 *      `_unmatched: true`; no `_catchall` either → nothing recorded. A form
 *      cannot set `_unmatched` on a matched submission.
 *   7b. Honeypot, rate limit, no hook_slug → nothing recorded, still the 303.
 *   8. The landing-host paths (root slug, host+path pin) queue the same way.
 *
 * Run: npx jest tests/pageLanding.submitQueue.test.js
 */
'use strict';

jest.mock('../services/hookService', () => ({
  getHookBySlug: jest.fn(),
  executeHook: jest.fn(),
  recordExecution: jest.fn(),
}));
jest.mock('../lib/taskQueue', () => ({
  enqueueHookExecutionDispatch: jest.fn(async () => true),
}));

const express = require('express');
const hookService = require('../services/hookService');
const taskQueue = require('../lib/taskQueue');
const firmConfig = require('../lib/firmConfig');
const pageService = require('../services/pageService');

const HOOK = { id: 31, slug: 'lp-ch7', auth_type: 'none', capture_mode: 'off', targets: [] };
const CATCHALL = { id: 1, slug: '_catchall', auth_type: 'none', capture_mode: 'off', targets: [] };
// getHookBySlug stand-in: only the slugs listed resolve (null = missing/inactive)
const hooksBySlug = (map) => async (_db, slug) => (Object.prototype.hasOwnProperty.call(map, slug) ? map[slug] : null);

const PAGES = {
  ch7: { id: 1, slug: 'ch7', host: null, path: null, status: 'live', hook_slug: 'lp-ch7', thankyou_url: 'thanks', html: '<h1>CH7</h1>' },
  nohook: { id: 2, slug: 'nohook', host: null, path: null, status: 'live', hook_slug: null, thankyou_url: null, html: '<h1>N</h1>' },
};
const PINS = [
  { id: 20, slug: 'pin-ch7', host: '4lsg.com', path: '/offer', status: 'live', hook_slug: 'lp-ch7', thankyou_url: null, html: '<h1>PIN</h1>' },
];

const db = {
  query: jest.fn(async (sql, params) => {
    if (/SELECT DISTINCT host FROM pages/i.test(sql)) return [[{ host: '4lsg.com' }]];
    if (/FROM pages\s+WHERE host = \?/i.test(sql)) {
      const row = PINS.find(r => r.host === params[0] && r.path === params[1]);
      return [row ? [row] : []];
    }
    if (/FROM pages WHERE slug = \?/i.test(sql)) {
      const row = PAGES[String(params[0])];
      return [row ? [row] : []];
    }
    return [[]];
  }),
};

let server, base, ipSeq = 0;

beforeAll((done) => {
  process.env.LANDING_HOSTS = '4lsg.com';
  firmConfig._test({ resetCache: true });
  pageService.invalidateHostCache();
  const pageLanding = require('../routes/pageLanding');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(pageLanding.pageHostMiddleware(db));
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(pageLanding);
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  delete process.env.LANDING_HOSTS;
  delete process.env.HOOK_ASYNC_ACK;
  firmConfig._test({ resetCache: true });
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});
beforeEach(() => {
  delete process.env.HOOK_ASYNC_ACK;
  firmConfig._test({ resetCache: true });
  hookService.getHookBySlug.mockReset().mockResolvedValue(HOOK);
  hookService.executeHook.mockReset().mockResolvedValue({ status: 'completed' });
  hookService.recordExecution.mockReset().mockResolvedValue({ executionId: 777, truncated: false, duplicate: false, dedupKey: null });
  taskQueue.enqueueHookExecutionDispatch.mockReset().mockResolvedValue(true);
});

// Each post gets its own client IP (cf-connecting-ip) so the per-IP rate
// limit never trips unless a test means it to.
function post(path, body = 'name=Ann+Lee&phone=5551234', { host, ip } = {}) {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'cf-connecting-ip': ip || `10.0.0.${++ipSeq % 250}`,
  };
  if (host) headers['x-original-host'] = host;
  return fetch(base + path, { method: 'POST', headers, body, redirect: 'manual' });
}

const tick = (ms) => new Promise(r => setTimeout(r, ms));

describe('normal path — record, ring, answer', () => {
  test('records the row queued, rings with its id, never runs the pipeline in the request', async () => {
    const res = await post('/p/ch7');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/p/thanks');

    expect(hookService.getHookBySlug).toHaveBeenCalledWith(db, 'lp-ch7');
    expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
    const [rdb, rhook, rslug, input, opts] = hookService.recordExecution.mock.calls[0];
    expect(rdb).toBe(db);
    expect(rhook).toBe(HOOK);
    expect(rslug).toBe('lp-ch7');
    // queued, not claimed: a claimed row is one the drain will never take
    expect(opts === undefined || (opts.claimed !== true && opts.dedup !== true)).toBe(true);
    expect(input).toMatchObject({ name: 'Ann Lee', phone: '5551234', _page: 'ch7' });

    expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledTimes(1);
    expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledWith(777);
    expect(hookService.recordExecution.mock.invocationCallOrder[0])
      .toBeLessThan(taskQueue.enqueueHookExecutionDispatch.mock.invocationCallOrder[0]);
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('the 303 waits for the doorbell (no detached enqueue)', async () => {
    let ring;
    taskQueue.enqueueHookExecutionDispatch.mockImplementation(() => new Promise(r => { ring = r; }));
    let answered = false;
    const pending = post('/p/ch7').then(r => { answered = true; return r; });
    for (let i = 0; i < 100 && !ring; i++) await tick(10); // bounded: ≤1 s
    expect(typeof ring).toBe('function');
    await tick(150);
    expect(answered).toBe(false);
    ring(true);
    const res = await pending;
    expect(res.status).toBe(303);
  });

  test('the envelope is flat and a form cannot spoof the meta fields', async () => {
    await post('/p/ch7', 'name=X&_page=evil&_ip=1.2.3.4&_host=evil.example', { ip: '10.9.9.9' });
    const input = hookService.recordExecution.mock.calls[0][3];
    expect(input._page).toBe('ch7');
    expect(input._ip).toBe('10.9.9.9');
    expect(input._host).not.toBe('evil.example');
    expect(input).not.toHaveProperty('body');
    expect(Object.keys(input)).toEqual(expect.arrayContaining(['name', '_page', '_host', '_ip', '_referrer', '_ua']));
  });

  test('a dead doorbell is still the 303 — the row exists, the cron drains it', async () => {
    taskQueue.enqueueHookExecutionDispatch.mockResolvedValue(false);
    const res = await post('/p/ch7');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/p/thanks');
    expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
  });

  test('a failed INSERT is still the 303, nothing is rung, and it is logged as not queued', async () => {
    hookService.recordExecution.mockRejectedValue(new Error('ER_LOCK_WAIT_TIMEOUT'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post('/p/ch7');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/p/thanks');
      expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
      expect(err.mock.calls.some(a => /submission hand-off failed \(page=ch7, hook=lp-ch7\) — nothing queued for the drain/.test(a[0]))).toBe(true);
    } finally { err.mockRestore(); }
  });
});

describe('the receiver rules this path keeps', () => {
  test("kill switch hook_async_ack='0' → the old detached executeHook, no row of ours, no doorbell", async () => {
    process.env.HOOK_ASYNC_ACK = '0';
    firmConfig._test({ resetCache: true });
    let finish;
    hookService.executeHook.mockImplementation(() => new Promise(r => { finish = r; }));
    const res = await post('/p/ch7');
    // answered while executeHook is still pending — detached, as before
    expect(res.status).toBe(303);
    expect(hookService.executeHook).toHaveBeenCalledTimes(1);
    const [, slug, input, opts] = hookService.executeHook.mock.calls[0];
    expect(slug).toBe('lp-ch7');
    expect(input._page).toBe('ch7');
    expect(opts).toEqual({ hook: HOOK });
    expect(hookService.recordExecution).not.toHaveBeenCalled();
    expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
    finish({ status: 'completed' });
  });

  test('any other switch value queues', async () => {
    process.env.HOOK_ASYNC_ACK = '1';
    firmConfig._test({ resetCache: true });
    await post('/p/ch7');
    expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('capture mode → executeHook awaited before the 303, no queued row', async () => {
    hookService.getHookBySlug.mockResolvedValue({ ...HOOK, capture_mode: 'capturing' });
    let finish;
    hookService.executeHook.mockImplementation(() => new Promise(r => { finish = r; }));
    let answered = false;
    const pending = post('/p/ch7').then(r => { answered = true; return r; });
    for (let i = 0; i < 100 && !finish; i++) await tick(10);
    expect(typeof finish).toBe('function');
    await tick(150);
    expect(answered).toBe(false);
    finish({ status: 'captured', execution_id: 9 });
    expect((await pending).status).toBe(303);
    expect(hookService.executeHook.mock.calls[0][3]).toEqual({ hook: expect.objectContaining({ capture_mode: 'capturing' }) });
    expect(hookService.recordExecution).not.toHaveBeenCalled();
    expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
  });
});

describe('catch-all — a missing or inactive hook keeps the lead', () => {
  test('falls back to _catchall: queued under the page hook slug, marked _unmatched, rung', async () => {
    hookService.getHookBySlug.mockImplementation(hooksBySlug({ _catchall: CATCHALL }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await post('/p/ch7', 'name=Lost+Lead');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/p/thanks');
      expect(hookService.getHookBySlug.mock.calls.map(c => c[1])).toEqual(['lp-ch7', '_catchall']);
      expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
      const [, rhook, rslug, input] = hookService.recordExecution.mock.calls[0];
      expect(rhook).toBe(CATCHALL);
      expect(rslug).toBe('lp-ch7'); // the row is reviewable under the page's own hook slug
      expect(input).toMatchObject({ name: 'Lost Lead', _page: 'ch7', _unmatched: true });
      expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledWith(777);
      expect(warn.mock.calls.some(a => /page "ch7": hook "lp-ch7" is missing or inactive — submission routed to _catchall/.test(a[0]))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  test('no _catchall either: nothing recorded, logged as an error', async () => {
    hookService.getHookBySlug.mockImplementation(hooksBySlug({}));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post('/p/ch7');
      expect(res.status).toBe(303);
      expect(hookService.recordExecution).not.toHaveBeenCalled();
      expect(hookService.executeHook).not.toHaveBeenCalled();
      expect(taskQueue.enqueueHookExecutionDispatch).not.toHaveBeenCalled();
      expect(err.mock.calls.some(a => /page "ch7": hook "lp-ch7" is missing or inactive and there is no _catchall hook — submission NOT recorded/.test(a[0]))).toBe(true);
    } finally { err.mockRestore(); }
  });

  test('a form cannot mark a matched submission _unmatched', async () => {
    await post('/p/ch7', 'name=X&_unmatched=1');
    const input = hookService.recordExecution.mock.calls[0][3];
    expect(hookService.recordExecution.mock.calls[0][1]).toBe(HOOK);
    expect(input).not.toHaveProperty('_unmatched');
  });

  test("kill switch '0' + missing hook: the detached call runs the catch-all under the page hook slug", async () => {
    process.env.HOOK_ASYNC_ACK = '0';
    firmConfig._test({ resetCache: true });
    hookService.getHookBySlug.mockImplementation(hooksBySlug({ _catchall: CATCHALL }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post('/p/ch7')).status).toBe(303);
      const [, slug, input, opts] = hookService.executeHook.mock.calls[0];
      expect(slug).toBe('lp-ch7');
      expect(opts).toEqual({ hook: CATCHALL });
      expect(input._unmatched).toBe(true);
      expect(hookService.recordExecution).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});

describe('nothing to record — still the 303', () => {

  test('honeypot filled: silent drop', async () => {
    const res = await post('/p/ch7', 'name=bot&website=spam.example');
    expect(res.status).toBe(303);
    expect(hookService.getHookBySlug).not.toHaveBeenCalled();
    expect(hookService.recordExecution).not.toHaveBeenCalled();
  });

  test('rate limited: the 11th post in a minute from one IP records nothing', async () => {
    for (let i = 0; i < 10; i++) expect((await post('/p/ch7', 'name=a', { ip: '10.7.7.7' })).status).toBe(303);
    hookService.recordExecution.mockClear();
    const res = await post('/p/ch7', 'name=a', { ip: '10.7.7.7' });
    expect(res.status).toBe(303);
    expect(hookService.recordExecution).not.toHaveBeenCalled();
  });

  test('page without a hook: no lookup, no row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await post('/p/nohook');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/p/nohook?submitted=1');
      expect(hookService.getHookBySlug).not.toHaveBeenCalled();
      expect(hookService.recordExecution).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});

describe('landing-host paths queue the same way', () => {
  test('root slug (4lsg.com/ch7)', async () => {
    const res = await post('/ch7', 'name=R', { host: '4lsg.com' });
    expect(res.status).toBe(303);
    expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
    expect(hookService.recordExecution.mock.calls[0][3]).toMatchObject({ name: 'R', _page: 'ch7', _host: '4lsg.com' });
    expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledWith(777);
    expect(hookService.executeHook).not.toHaveBeenCalled();
  });

  test('host+path pin (4lsg.com/offer)', async () => {
    const res = await post('/offer', 'name=P', { host: '4lsg.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/offer?submitted=1');
    expect(hookService.recordExecution).toHaveBeenCalledTimes(1);
    expect(hookService.recordExecution.mock.calls[0][3]).toMatchObject({ name: 'P', _page: 'pin-ch7' });
    expect(taskQueue.enqueueHookExecutionDispatch).toHaveBeenCalledWith(777);
  });
});
