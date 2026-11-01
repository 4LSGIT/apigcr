// tests/hookCredentialHeaders.test.js
//
/**
 * A hook's credential header is never stored (lib/hookCredentialHeaders,
 * 2026-11-02). Until then the receiver dropped only x-api-key / authorization
 * / cookie, so the api_key auth's default x-hook-key and RingCentral's
 * Verification-Token were written into every hook_executions.raw_input (and
 * captured_sample, and through a passthrough transform, transform_output).
 *
 * The REAL receiver (routes/api.hooks.js) and the REAL hookService over a
 * scripted db that records what is written; lib/taskQueue is mocked (the
 * doorbell is a provider boundary). Covered writers: the ack-first
 * recordExecution, the capture-mode captured_sample (+ its execution row),
 * and executeHook's own INSERT for a synchronous caller (live test / replay)
 * — whose input can carry the headers in ANY case.
 * Run: npx jest tests/hookCredentialHeaders.test.js
 */

'use strict';

jest.mock('../lib/taskQueue', () => ({
  enqueueHookExecutionDispatch: jest.fn(async () => true),
  enqueueJobDispatch: jest.fn(async () => true),
  enqueueDomainEventDispatch: jest.fn(async () => true),
}));

const express = require('express');
const hookService = require('../services/hookService');
const H = require('../lib/hookCredentialHeaders');

const SECRET = 'tok-FAKE-123'; // test literal only — secret-scan: allow
function makeDb(hook, { others = [] } = {}) {
  const writes = [];
  const all = [hook, ...others];
  const query = jest.fn(async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === H.UNION_SQL) return [all.filter((h) => h.auth_config && h.auth_config.header).map((h) => ({ header: h.auth_config.header }))];
    if (/^SELECT \* FROM hooks WHERE slug = \?/.test(s)) return [all.filter((h) => h.slug === p[0] && h.active !== 0).map((h) => ({ ...h }))];
    if (/FROM hook_targets ht/.test(s)) return [[]];
    if (/^INSERT INTO hook_executions/.test(s)) { writes.push({ kind: 'exec', raw: JSON.parse(p[2]) }); return [{ insertId: 900 + writes.length }]; }
    if (/^UPDATE hooks SET captured_sample = \?/.test(s)) { writes.push({ kind: 'sample', raw: JSON.parse(p[0]) }); return [{ affectedRows: 1 }]; }
    if (/^UPDATE hook_executions/.test(s)) { writes.push({ kind: 'execUpdate', sql: s, p }); return [{ affectedRows: 1 }]; }
    return [[]];
  });
  return { query, writes };
}

let currentDb;
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = currentDb; next(); });
  app.use(require('../routes/api.hooks'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  H.invalidateConfiguredHeaderNames();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const hookRow = (over = {}) => ({ id: 21, slug: 'rc-like', active: 1, auth_type: 'api_key',
  auth_config: { header: 'Verification-Token', key: SECRET }, filter_mode: 'none', transform_mode: 'passthrough',
  capture_mode: 'off', dedup_path: null, ...over });

const post = (slug, headers) => fetch(`${base}/hooks/${slug}`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Custom-Trace': 'keep-me', ...headers }, body: JSON.stringify({ uuid: 'e1' }) });

const STATIC_HEADERS = { 'X-Hook-Key': 'leak1', 'X-Signature': 'leak2', 'X-Api-Key': 'leak3', Cookie: 'c=1' };

describe('the receiver stores no credential header', () => {
  test('ack-first path: raw_input.headers lack the configured header and every static name; others survive', async () => {
    currentDb = makeDb(hookRow());
    const r = await post('rc-like', { 'Verification-Token': SECRET, ...STATIC_HEADERS });
    expect(r.status).toBe(200);
    const [exec] = currentDb.writes.filter((w) => w.kind === 'exec');
    const keys = Object.keys(exec.raw.headers);
    for (const k of ['verification-token', 'x-hook-key', 'x-signature', 'x-api-key', 'cookie']) expect(keys).not.toContain(k);
    expect(exec.raw.headers['x-custom-trace']).toBe('keep-me');
    expect(exec.raw.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.stringify(currentDb.writes)).not.toContain(SECRET);
  });

  test('a hook-specific header name (not a static one) is stripped too — whatever the auth type', async () => {
    for (const auth of [{ auth_type: 'api_key', auth_config: { header: 'X-Ses-Shared-Secret', key: SECRET } },
      { auth_type: 'hmac', auth_config: { header: 'Calendly-Webhook-Signature', secret: 'x' } }]) {
      currentDb = makeDb(hookRow({ ...auth, auth_type: 'none' }));      // auth none: the configured name still counts
      const name = auth.auth_config.header;
      await post('rc-like', { [name]: SECRET });
      const [exec] = currentDb.writes.filter((w) => w.kind === 'exec');
      expect(Object.keys(exec.raw.headers)).not.toContain(name.toLowerCase());
      expect(exec.raw.headers['x-custom-trace']).toBe('keep-me');
    }
  });

  test('capture mode: captured_sample and its execution row lack them', async () => {
    currentDb = makeDb(hookRow({ capture_mode: 'capturing' }));
    const r = await post('rc-like', { 'Verification-Token': SECRET, ...STATIC_HEADERS });
    expect((await r.json()).status).toBe('captured');
    const sample = currentDb.writes.find((w) => w.kind === 'sample');
    const exec = currentDb.writes.find((w) => w.kind === 'exec');
    for (const stored of [sample.raw, exec.raw]) {
      expect(Object.keys(stored.headers).sort()).toEqual(expect.arrayContaining(['x-custom-trace']));
      for (const k of ['verification-token', 'x-hook-key', 'x-signature', 'x-api-key', 'cookie']) expect(Object.keys(stored.headers)).not.toContain(k);
    }
    expect(JSON.stringify(currentDb.writes)).not.toContain(SECRET);
  });

  test('maintenance: the event spooled for later replay carries none of them either', async () => {
    const hookSpool = require('../lib/hookSpool');
    const put = jest.spyOn(hookSpool, 'put').mockResolvedValue({ bytes: 1 });
    process.env.MAINTENANCE_MODE = '1';
    try {
      currentDb = makeDb(hookRow({ auth_config: { header: 'X-Ses-Shared-Secret', key: SECRET } }));
      const r = await post('rc-like', { 'X-Ses-Shared-Secret': SECRET, 'Verification-Token': 'v', ...STATIC_HEADERS });
      expect(r.status).toBe(200);
      const spooled = put.mock.calls[0][0].input;
      expect(Object.keys(spooled.headers)).toEqual(expect.arrayContaining(['x-custom-trace']));
      for (const k of ['x-ses-shared-secret', 'verification-token', 'x-hook-key', 'x-signature', 'x-api-key', 'cookie']) expect(Object.keys(spooled.headers)).not.toContain(k);
    } finally {
      delete process.env.MAINTENANCE_MODE;
    }
  });

  test('recordExecution on its own (any writer that skips the receiver) strips them, any case', async () => {
    const hook = hookRow({ auth_config: { header: 'X-Ses-Shared-Secret', key: SECRET } });
    currentDb = makeDb(hook, { others: [hookRow({ id: 30, slug: 'old-hook', active: 0, auth_config: { header: 'X-Old-Hook-Secret', key: 'x' } })] });
    await hookService.recordExecution(currentDb, hook, hook.slug, { body: {}, headers: { 'x-ses-SHARED-secret': SECRET, 'X-HOOK-KEY': 'k', 'X-OLD-HOOK-SECRET': SECRET, Keep: 'yes' } });
    expect(currentDb.writes[0].raw.headers).toEqual({ Keep: 'yes' });
  });

  test('an UNMATCHED event (deactivated slug → _catchall, auth none) loses the intended hook\'s custom header too — the union', async () => {
    const catchall = hookRow({ id: 1, slug: '_catchall', auth_type: 'none', auth_config: null });
    const gone = hookRow({ id: 30, slug: 'old-hook', active: 0, auth_config: { header: 'X-Old-Hook-Secret', key: SECRET } });
    currentDb = makeDb(catchall, { others: [gone] });
    const r = await post('old-hook', { 'X-Old-Hook-Secret': SECRET });
    expect(r.status).toBe(200);
    const [exec] = currentDb.writes.filter((w) => w.kind === 'exec');
    expect(Object.keys(exec.raw.headers)).not.toContain('x-old-hook-secret');
    expect(exec.raw.headers['x-custom-trace']).toBe('keep-me');
    expect(JSON.stringify(currentDb.writes)).not.toContain(SECRET);
  });

  test('wrong key: 401, nothing stored', async () => {
    currentDb = makeDb(hookRow());
    const r = await post('rc-like', { 'Verification-Token': 'nope' });
    expect(r.status).toBe(401);
    expect(currentDb.writes).toEqual([]);
  });
});

describe('executeHook for a synchronous caller (live test / replay): mixed-case headers in the input', () => {
  test('its own INSERT and the transform output carry none of them', async () => {
    const hook = hookRow({ auth_config: { header: 'X-Ses-Shared-Secret', key: SECRET }, targets: [] });
    currentDb = makeDb(hook, { others: [hookRow({ id: 30, slug: 'old-hook', active: 0, auth_config: { header: 'X-Old-Hook-Secret', key: 'x' } })] });
    const input = { body: { a: 1 }, headers: { 'VERIFICATION-TOKEN': SECRET, 'X-Ses-Shared-Secret': SECRET, 'x-HOOK-key': 'k', 'x-old-hook-SECRET': SECRET, Keep: 'yes' },
      query: {}, method: 'POST', meta: { source: 'live_test' } };
    await hookService.executeHook(currentDb, hook.slug, input, { hook });
    expect(JSON.stringify(currentDb.writes)).not.toContain(SECRET);
    const exec = currentDb.writes.find((w) => w.kind === 'exec');
    expect(exec.raw.headers).toEqual({ Keep: 'yes' });
  });
});

describe('lib/hookCredentialHeaders', () => {
  test('names: statics + the configured header, lowercased; the hookService defaults are the statics', () => {
    expect([...H.credentialHeaderNames({ auth_config: '{"header":"X-Mine"}' })]).toEqual(expect.arrayContaining(['x-mine', 'x-hook-key', 'x-signature', 'verification-token', 'x-api-key', 'authorization', 'cookie']));
    expect(H.STATIC_CREDENTIAL_HEADERS).toEqual(expect.arrayContaining([H.DEFAULT_API_KEY_HEADER, H.DEFAULT_HMAC_HEADER]));
    expect([...H.credentialHeaderNames(null)].sort()).toEqual([...H.STATIC_CREDENTIAL_HEADERS].sort());
  });
  test('scrubInputHeaders: a non-object headers value becomes {}; an input without headers is left alone', () => {
    expect(H.scrubInputHeaders({ body: 1, headers: 'x-hook-key: k' }, null)).toEqual({ body: 1, headers: {} });
    expect(H.scrubInputHeaders({ body: 1, headers: ['x'] }, null)).toEqual({ body: 1, headers: {} });
    expect(H.scrubInputHeaders({ body: 1 }, null)).toEqual({ body: 1 });
  });
  test('configuredHeaderNames: cached, grows, fails soft', async () => {
    const q = jest.fn(async () => [[{ header: 'X-A' }, { header: null }, { header: 'null' }]]);
    expect([...(await H.configuredHeaderNames({ query: q }))]).toEqual(expect.arrayContaining(['x-a']));
    await H.configuredHeaderNames({ query: q });
    expect(q).toHaveBeenCalledTimes(1);                                  // cached
    H.invalidateConfiguredHeaderNames();
    const boom = { query: jest.fn(async () => { throw new Error('down'); }) };
    expect([...(await H.configuredHeaderNames(boom))]).toContain('x-a');  // failed read keeps what it knew
  });
  test('the union only grows: a later read that lacks a name still strips it', async () => {
    H.invalidateConfiguredHeaderNames();
    await H.configuredHeaderNames({ query: async () => [[{ header: 'X-Grow-First' }]] });
    H.invalidateConfiguredHeaderNames();
    const names = await H.configuredHeaderNames({ query: async () => [[{ header: 'X-Grow-Second' }]] });
    expect([...names]).toEqual(expect.arrayContaining(['x-grow-first', 'x-grow-second']));
    expect(H.stripCredentialHeaders({ 'X-Grow-First': 's', keep: 1 }, null, names)).toEqual({ keep: 1 });
  });
  test('credentialHeaderPaths: every credential key under any `headers` object, any case, any depth; nothing else', () => {
    const names = H.credentialHeaderNames({ auth_config: { header: 'X-Mine' } });
    const doc = { headers: { 'Verification-Token': 'a', keep: 1 }, body: { authorization: 'not a header' },
      params: { input: { HEADERS: { 'x-mine': 'b', 'X-Hook-Key': 'c' } } }, list: [{ headers: { cookie: 'd' } }] };
    expect(H.credentialHeaderPaths(doc, names).sort()).toEqual([
      '$."headers"."Verification-Token"', '$."list"[0]."headers"."cookie"',
      '$."params"."input"."HEADERS"."X-Hook-Key"', '$."params"."input"."HEADERS"."x-mine"'].sort());
  });
});
