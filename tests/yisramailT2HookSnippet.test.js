// tests/yisramailT2HookSnippet.test.js
//
/**
 * YisraMail T2 — ref/migrations/2026-11-02_yisramail_t2_hook_ses_events.console.js,
 * the EXACT file text, run in a vm against an apiSend stub whose request /
 * response shapes come from routes/api.hooks.js (GET /api/hooks → {hooks},
 * GET /api/hooks/:id → {hook: …, targets}, POST /api/hooks → {status, id,
 * target_ids}, POST /api/hooks/:id/targets → {status, id}). Locks: check() on
 * an absent hook is NO-GO and writes nothing; create() posts the definition
 * with header x-api-key and a 64-hex key that goes to copy(), never to the
 * console; addTarget() posts mail_event_ingest with params_mapping event ←
 * body; a drifted hook is NO-GO naming the field.
 * Run: npx jest tests/yisramailT2HookSnippet.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'ref', 'migrations', '2026-11-02_yisramail_t2_hook_ses_events.console.js');
const SRC = fs.readFileSync(FILE, 'utf8');

function world(initial = null) {
  const state = { hook: initial, writes: [], lines: [], copied: [] };
  const apiSend = async (url, method = 'GET', body = null) => {
    if (method === 'GET' && url === '/api/hooks') return { status: 'success', hooks: state.hook ? [{ ...state.hook, targets: undefined }] : [] };
    if (method === 'GET' && /^\/api\/hooks\/\d+$/.test(url)) return { status: 'success', hook: { ...state.hook, targets: state.hook.targets || [] } };
    if (method === 'POST' && url === '/api/hooks') {
      state.writes.push({ url, body });
      state.hook = { id: 70, ...body, auth_config: body.auth_config, capture_mode: 'off', targets: [] };
      return { status: 'success', id: 70, target_ids: [] };
    }
    if (method === 'POST' && /^\/api\/hooks\/70\/targets$/.test(url)) {
      state.writes.push({ url, body });
      state.hook.targets.push({ id: 71, ...body, config: JSON.stringify(body.config) });
      return { status: 'success', id: 71 };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const ctx = {
    apiSend, crypto: { getRandomValues: (a) => crypto.randomFillSync(a) }, copy: (v) => state.copied.push(v),
    console: { log: (...a) => state.lines.push(a.join(' ')) }, JSON, Array, Uint8Array, String, Number,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  state.run = () => vm.runInContext(`(async () => { ${SRC.replace(/^\s*await \(async/m, 'return await (async')} })()`, ctx);
  state.ctx = ctx;
  return state;
}

test('absent: check() is NO-GO and writes nothing; create() posts the definition and hands the key to copy(), never the console', async () => {
  const w = world();
  await w.run();
  expect(w.lines.at(-1)).toBe('NO-GO — hook ses-events is absent. Create it: await sesHook.create()');
  expect(w.writes).toEqual([]);
  w.lines.length = 0;
  await w.ctx.sesHook.create();
  expect(w.writes).toHaveLength(1);
  const body = w.writes[0].body;
  expect(body).toMatchObject({ slug: 'ses-events', auth_type: 'api_key', filter_mode: 'none', transform_mode: 'passthrough', dedup_path: 'body.id', active: 1 });
  expect(body.auth_config.header).toBe('x-api-key');
  expect(body.auth_config.key).toMatch(/^[0-9a-f]{64}$/);
  expect(w.copied).toEqual([body.auth_config.key]);
  expect(w.lines.join('\n')).not.toContain(body.auth_config.key);
  expect(w.lines.at(-1)).toBe('GO — hook ses-events matches its definition; no target yet (add it at the land: await sesHook.addTarget()).');
});

test('addTarget(): posts mail_event_ingest with params_mapping event ← body; a second call adds nothing', async () => {
  const w = world({ id: 70, slug: 'ses-events', auth_type: 'api_key', auth_config: { header: 'x-api-key', key: 'k'.repeat(64) },
    filter_mode: 'none', transform_mode: 'passthrough', dedup_path: 'body.id', active: 1, capture_mode: 'off', targets: [] });
  await w.run();
  await w.ctx.sesHook.addTarget();
  expect(w.writes).toEqual([{ url: '/api/hooks/70/targets', body: { name: 'mail_event_ingest', target_type: 'internal_function', position: 0,
    config: { function_name: 'mail_event_ingest', params_mapping: { event: 'body' } }, transform_mode: 'passthrough', active: 1 } }]);
  expect(w.lines.at(-1)).toBe('GO — hook ses-events matches its definition, target included.');
  await w.ctx.sesHook.addTarget();
  expect(w.writes).toHaveLength(1);
  expect(w.lines.join('\n')).not.toContain('k'.repeat(64));
});

test('check() returns a redacted summary — never the key', async () => {
  const KEY = 'f'.repeat(64);
  const w = world({ id: 70, slug: 'ses-events', auth_type: 'api_key', auth_config: { header: 'x-api-key', key: KEY },
    filter_mode: 'none', transform_mode: 'passthrough', dedup_path: 'body.id', active: 1, capture_mode: 'off', targets: [] });
  await w.run();
  const out = await w.ctx.sesHook.check();
  expect(JSON.stringify(out)).not.toContain(KEY);
  expect(out).toMatchObject({ present: true, hook_id: 70, header: 'x-api-key', has_key: 'yes', dedup_path: 'body.id', target_id: null, problems: [] });
  expect(w.lines.join('\n')).not.toContain(KEY);
});

test('drift: the default header, a missing dedup path, capture still on → NO-GO naming each', async () => {
  const w = world({ id: 70, slug: 'ses-events', auth_type: 'api_key', auth_config: { key: 'x' }, filter_mode: 'none', transform_mode: 'passthrough',
    dedup_path: null, active: 1, capture_mode: 'capturing', targets: [] });
  await w.run();
  expect(w.lines).toEqual(expect.arrayContaining([
    '  ✗ auth header is (default x-hook-key), expected x-api-key',
    '  ✗ dedup_path is (empty), expected body.id',
    '  ✗ capture mode is still ON (the next event would be captured, not ingested)',
  ]));
  expect(w.lines.at(-1)).toBe('NO-GO — hook ses-events differs from its definition (above). Paste this to Claude.');
  expect(w.writes).toEqual([]);
});
