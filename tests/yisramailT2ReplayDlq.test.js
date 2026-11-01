// tests/yisramailT2ReplayDlq.test.js
//
/**
 * YisraMail T2 — scripts/yisramailT2ReplayDlq.js: both input shapes, the dry
 * run, and a live run against a local server running the REAL hook receiver
 * (routes/api.hooks.js + hookService over a scripted db): the key rides in
 * x-api-key from the env and is never printed; an event the hook already has
 * is a duplicate no-op (dedup_path body.id); a refused POST is a NO-GO.
 * Run: npx jest tests/yisramailT2ReplayDlq.test.js
 */

'use strict';

jest.mock('../lib/taskQueue', () => ({
  enqueueHookExecutionDispatch: jest.fn(async () => true),
  enqueueJobDispatch: jest.fn(async () => true),
  enqueueDomainEventDispatch: jest.fn(async () => true),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const H = require('../lib/hookCredentialHeaders');
const replay = require('../scripts/yisramailT2ReplayDlq');

const KEY = 'ses-hook-key-FAKE-0002'; // test literal only — secret-scan: allow
const FIX = path.join(__dirname, 'fixtures', 'ses-events');
const ev = (n) => {   // the captured event when step 0 produced one, else the documented shape
  const real = path.join(FIX, `${n}.json`);
  return JSON.parse(fs.readFileSync(fs.existsSync(real) ? real : path.join(FIX, `${n}.assumed.json`), 'utf8'));
};
const HOOK = { id: 70, slug: 'ses-events', active: 1, auth_type: 'api_key', auth_config: { header: 'x-api-key', key: KEY },
  filter_mode: 'none', transform_mode: 'passthrough', capture_mode: 'off', dedup_path: 'body.id' };

let execs; let keys; let server; let base;
const db = { query: async (sql, p = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === H.UNION_SQL) return [[{ header: 'x-api-key' }]];
  if (/^SELECT \* FROM hooks WHERE slug = \?/.test(s)) return [p[0] === 'ses-events' ? [{ ...HOOK }] : []];
  if (/^INSERT INTO hook_executions/.test(s)) {
    if (p[5] != null && keys.has(p[5])) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 });
    keys.add(p[5]); execs.push(JSON.parse(p[2])); return [{ insertId: execs.length }];
  }
  return [[]];
} };

let dir;
const write = (name, content) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); return f; };

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-t2-dlq-'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(require('../routes/api.hooks'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { execs = []; keys = new Set(); H.invalidateConfiguredHeaderNames(); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

const AWS_CLI = () => ({ Messages: [
  { MessageId: 'm1', ReceiptHandle: 'r1', Body: JSON.stringify(ev('bounce-permanent')), MessageAttributes: { ERROR_CODE: { StringValue: 'SDK_CLIENT_ERROR' } } },
  { MessageId: 'm2', ReceiptHandle: 'r2', Body: JSON.stringify(ev('complaint')) },
  { MessageId: 'm3', ReceiptHandle: 'r3', Body: JSON.stringify(ev('complaint')) },     // the same event twice
  { MessageId: 'm4', ReceiptHandle: 'r4', Body: 'not json' },
] });

describe('input shapes', () => {
  test('aws sqs receive-message output: Bodies parsed, a repeated id dropped, junk skipped', () => {
    const r = replay.readEvents(JSON.stringify(AWS_CLI()));
    expect(r).toMatchObject({ shape: 'aws-cli', skipped: 1, duplicates: 1 });
    expect(r.events.map((e) => e.id)).toEqual([ev('bounce-permanent').id, ev('complaint').id]);
  });
  test('the console\'s copied bodies: one event, an array of events or of {Body}, one event per line', () => {
    expect(replay.readEvents(JSON.stringify(ev('delivery')))).toMatchObject({ shape: 'event', events: [{ id: ev('delivery').id }] });
    expect(replay.readEvents(JSON.stringify([ev('delivery'), { Body: JSON.stringify(ev('reject')) }])).events).toHaveLength(2);
    const lines = `${JSON.stringify(ev('delivery'))}\n\n${JSON.stringify(ev('send'))}\n{bad\n`;
    expect(replay.readEvents(lines)).toMatchObject({ shape: 'json-lines', skipped: 1 });
    expect(replay.readEvents(lines).events).toHaveLength(2);
    expect(replay.readEvents(JSON.stringify({ source: 'aws.sns', id: 'x' }))).toMatchObject({ events: [], skipped: 1 });
  });
});

describe('arguments', () => {
  test('--url consumes its value before the file is picked, wherever it sits', () => {
    expect(replay.parseArgs(['--url', 'http://x:1/', 'msgs.json', '--dry-run'])).toEqual({ file: 'msgs.json', base: 'http://x:1', dryRun: true });
    expect(replay.parseArgs(['msgs.json', '--url', 'http://y'])).toEqual({ file: 'msgs.json', base: 'http://y', dryRun: false });
    expect(replay.parseArgs(['--dry-run'])).toEqual({ file: null, base: 'https://app.4lsg.com', dryRun: true });
  });
});

describe('runs', () => {
  test('--dry-run lists and posts nothing (no key needed)', async () => {
    const out = [];
    const r = await replay.run({ file: write('a.json', AWS_CLI()), dryRun: true, base, key: undefined, say: (l) => out.push(l) });
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/^DRY RUN — GO\. 2 event\(s\) would be posted to http:\/\/127\.0\.0\.1:\d+\/hooks\/ses-events/);
    expect(out.filter((l) => /would post:/.test(l))).toHaveLength(2);
    expect(execs).toEqual([]);
  });

  test('a live run posts each event with the key in x-api-key, never prints it; a replay of an event already there is a no-op', async () => {
    const out = [];
    const file = write('b.json', AWS_CLI());
    const r = await replay.run({ file, base, key: KEY, say: (l) => out.push(l) });
    expect(r).toMatchObject({ ok: true, posted: 2, failed: 0 });
    expect(r.line).toMatch(/^GO — 2 event\(s\) posted/);
    expect(execs.map((e) => e.body.id)).toEqual([ev('bounce-permanent').id, ev('complaint').id]);
    expect(JSON.stringify(execs)).not.toContain(KEY);                // the receiver strips x-api-key
    expect(out.join('\n')).not.toContain(KEY);
    const again = await replay.run({ file, base, key: KEY, say: () => {} });
    expect(again).toMatchObject({ ok: true, posted: 2 });             // 200s…
    expect(execs).toHaveLength(2);                                    // …recorded nothing new
  });

  test('no key → NO-GO before any POST; a refused POST (wrong key) → NO-GO with counts', async () => {
    const file = write('c.json', [ev('delivery')]);
    const none = await replay.run({ file, base, key: '', say: () => {} });
    expect(none.line).toMatch(/^NO-GO — env SES_HOOK_KEY is not set/);
    const bad = await replay.run({ file, base, key: 'wrong', say: () => {} });
    expect(bad).toMatchObject({ ok: false, posted: 0, failed: 1 });
    expect(bad.line).toMatch(/^NO-GO — 0 posted, 1 failed/);
    expect(execs).toEqual([]);
  });

  test('an unreadable or empty file → NO-GO', async () => {
    expect((await replay.run({ file: path.join(dir, 'missing.json'), say: () => {} })).line).toMatch(/^NO-GO — cannot read/);
    expect((await replay.run({ file: write('d.json', '[]'), say: () => {} })).line).toMatch(/^NO-GO — no SES event found/);
  });
});
