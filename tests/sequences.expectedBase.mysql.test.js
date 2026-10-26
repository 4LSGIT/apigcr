// tests/sequences.expectedBase.mysql.test.js
//
/**
 * P11 sequence half on REAL MySQL: the expected_base precondition and the
 * save-time step validation, driven through the real router, the real
 * lib/withTransaction and a real InnoDB engine.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3341/yc_p11seq_test npx jest tests/sequences.expectedBase.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * sequence_templates, sequence_template_versions and sequence_steps in it,
 * cloned line-by-line from ref/database.sql (live types, keys, FKs).
 *
 * WHY A REAL ENGINE: the precondition's predicates (the parent-row lock, the
 * COUNT over the read version, the fingerprint over a row's JSON columns) are
 * exactly where a mocked query ships green and dead — appt.create.v1's
 * `user_auth = 1` (course correction 5). And the fingerprint only means
 * something if it survives MySQL re-ordering JSON object keys on write (the
 * wf50 scar): a mock that returns what was written cannot show that.
 *
 * WHAT IS LOCKED
 *   - The native editor's payloads (seqGatherStep shapes) save through all
 *     five routes with no expected_base, exactly as before.
 *   - A base built from the GET /sequences/templates/:id response holds
 *     after MySQL re-orders the stored JSON keys.
 *   - The first write with draft_version null forks the draft; a second
 *     write on that same stale base is a 409 naming the new draft.
 *   - An edit / delete / reorder that lands between a proposer's read and
 *     its write is refused with a 409 naming what changed, and writes nothing.
 *   - The save-time validation refuses before any row moves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 1, roles: ['staff'] }; next(); }));

const { withTransaction } = require('../lib/withTransaction');
const { sequenceStepFingerprint } = require('../lib/versionDiff');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['sequence_templates', 'sequence_template_versions', 'sequence_steps'];

// Line-based extraction (column COMMENTs may hold ';'): a CREATE block ends
// at `) ENGINE=…;`, an ALTER block at the first line ending in ';'.
function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [];
  const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        alters.push(buf.join('\n'));
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  // FK constraints last (they reference sibling tables' keys).
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

const EDITOR_EP = { strategy: 'ignore', max_retries: 0, backoff_seconds: 5 };
const PAYLOADS = {
  sms: { action_type: 'sms',
    action_config: { function_name: 'send_sms', params: { message: 'Hi {{contacts.contact_fname}}', to: '{{contacts.contact_phone}}', from: '2485550100' } },
    timing: { unit: 'minutes', value: 5, type: 'delay' }, condition: null, fire_guard: null, error_policy: EDITOR_EP },
  email: { action_type: 'email',
    action_config: { function_name: 'send_email', params: { text: 'Body', subject: 'Hello', to: '{{contacts.contact_email}}', from: 'info@example.com' } },
    timing: { type: 'next_business_day', timeOfDay: '09:00', randomizeMinutes: 0 }, condition: null, fire_guard: null, error_policy: EDITOR_EP },
  task: { action_type: 'task',
    action_config: { function_name: 'create_task', params: { title: 'Call', assigned_to: '{{trigger_data.user_id}}' } },
    timing: { type: 'immediate' }, condition: { query: 'SELECT 1 AS ok', params: {}, assert: { ok: 1 } },
    fire_guard: { min_hours_before_appt: 2 }, error_policy: EDITOR_EP },
  internal_function: { action_type: 'internal_function',
    action_config: { params: {}, function_name: 'noop', set_vars: { x: '1' } },
    timing: { type: 'immediate' }, condition: null, fire_guard: null,
    error_policy: { strategy: 'retry_then_ignore', max_retries: 2, backoff_seconds: 5 } },
};

d('sequence step routes on real MySQL (P11 sequence half)', () => {
  let pool;
  let server;
  let port;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  const call = (method, urlPath, payload) => new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request({
      port, path: urlPath, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(out || '{}'); } catch { body = { raw: out }; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  // What a proposer does: read the editor view, build the base from it.
  const readBase = async (id, fingerprintAt) => {
    const r = await call('GET', `/sequences/templates/${id}`);
    expect(r.status).toBe(200);
    const base = { draft_version: r.body.template.draft_version, step_count: r.body.steps.length };
    if (fingerprintAt) base.step_fingerprint = sequenceStepFingerprint(r.body.steps[fingerprintAt - 1]);
    return { base, steps: r.body.steps, template: r.body.template };
  };

  const stepRows = (id, version) => q(
    'SELECT step_number, action_type, action_config, timing FROM sequence_steps WHERE template_id = ? AND version = ? ORDER BY step_number', [id, version]);

  async function seedTemplate(id) {
    await q('INSERT INTO sequence_templates (id, name, type, active, current_version, draft_version) VALUES (?, ?, NULL, 1, 1, NULL)', [id, `t${id}`]);
    await q('INSERT INTO sequence_template_versions (template_id, version, name, published_at) VALUES (?, 1, ?, NOW())', [id, `t${id}`]);
    let n = 1;
    for (const p of [PAYLOADS.sms, PAYLOADS.task, PAYLOADS.email]) {
      await q(`INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing, \`condition\`, fire_guard, error_policy)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [id, n++, p.action_type, JSON.stringify(p.action_config), JSON.stringify(p.timing),
        p.condition ? JSON.stringify(p.condition) : null, p.fire_guard ? JSON.stringify(p.fire_guard) : null, JSON.stringify(p.error_policy)]);
    }
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    const { creates, alters } = schemaFor(TABLES);
    for (const sql of creates) await q(sql);
    for (const sql of alters) await q(sql);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/sequences.js'));
    server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    port = server.address().port;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });

  test('MySQL re-orders the stored JSON keys — byte comparison would fail, the fingerprint does not', async () => {
    await seedTemplate(1);
    const [row] = await q('SELECT action_config, timing FROM sequence_steps WHERE template_id = 1 AND version = 1 AND step_number = 1');
    expect(typeof row.action_config).toBe('object');           // mysql2 returns JSON columns parsed
    expect(JSON.stringify(row.action_config.params)).not.toBe(JSON.stringify(PAYLOADS.sms.action_config.params));
    expect(JSON.stringify(row.timing)).not.toBe(JSON.stringify(PAYLOADS.sms.timing));
    const { base } = await readBase(1, 1);
    expect(base.step_fingerprint).toBe(sequenceStepFingerprint(PAYLOADS.sms));
  });

  test('native editor payloads save through all five routes with no expected_base', async () => {
    await seedTemplate(2);
    for (const t of Object.keys(PAYLOADS)) {
      const r = await call('POST', '/sequences/templates/2/steps', PAYLOADS[t]);
      expect([t, r.status]).toEqual([t, 201]);
    }
    expect((await call('PUT', '/sequences/templates/2/steps/1', PAYLOADS.email)).status).toBe(200);
    expect((await call('PATCH', '/sequences/templates/2/steps/2', { timing: { type: 'immediate' } })).status).toBe(200);
    expect((await call('PATCH', '/sequences/templates/2/steps/reorder', { fromStep: 1, toStep: 3 })).status).toBe(200);
    expect((await call('DELETE', '/sequences/templates/2/steps/7')).status).toBe(200);
    const [t] = await q('SELECT current_version, draft_version FROM sequence_templates WHERE id = 2');
    expect(t).toEqual({ current_version: 1, draft_version: 2 });
    expect((await stepRows(2, 2)).map((s) => s.step_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await stepRows(2, 1)).toHaveLength(3);                // published rows untouched
  });

  test('a base read from GET holds; the first write forks; the same stale base is then refused', async () => {
    await seedTemplate(3);
    const { base } = await readBase(3, 2);
    expect(base).toMatchObject({ draft_version: null, step_count: 3 });
    const put = await call('PUT', '/sequences/templates/3/steps/2', { ...PAYLOADS.task, timing: { type: 'immediate' }, expected_base: base });
    expect(put.status).toBe(200);
    const [t] = await q('SELECT draft_version FROM sequence_templates WHERE id = 3');
    expect(t.draft_version).toBe(2);
    const again = await call('PUT', '/sequences/templates/3/steps/2', { ...PAYLOADS.task, expected_base: base });
    expect(again.status).toBe(409);
    expect(again.body.conflict).toEqual({ changed: 'draft_version', expected: null, actual: 2 });

    // Re-read on the draft: the fresh base passes on every route.
    for (const [m, u, b, at] of [
      ['PATCH', '/sequences/templates/3/steps/1', { timing: { type: 'immediate' } }, 1],
      ['POST', '/sequences/templates/3/steps', { ...PAYLOADS.sms, step_number: 2 }, 2],
      ['DELETE', '/sequences/templates/3/steps/4', {}, 4],
      ['PATCH', '/sequences/templates/3/steps/reorder', { fromStep: 1, toStep: 3 }, null],
    ]) {
      const { base: fresh } = await readBase(3, at);
      const r = await call(m, u, { ...b, expected_base: fresh });
      expect([m, u, r.status]).toEqual([m, u, m === 'POST' ? 201 : 200]);
    }
  });

  test('an edit between read and write: fingerprint 409, nothing written', async () => {
    await seedTemplate(4);
    const { base } = await readBase(4, 2);
    // a native edit lands on step 2 in between
    expect((await call('PATCH', '/sequences/templates/4/steps/2', { timing: { type: 'delay', value: 1, unit: 'hours' } })).status).toBe(200);
    const before = await stepRows(4, 2);
    // the stale proposal: draft_version moved (null → 2) — refused on that first
    const r1 = await call('PUT', '/sequences/templates/4/steps/2', { ...PAYLOADS.task, expected_base: base });
    expect(r1.body.conflict.changed).toBe('draft_version');
    // same draft, content changed under the proposer
    const { base: b2 } = await readBase(4, 2);
    await q("UPDATE sequence_steps SET timing = JSON_OBJECT('type', 'immediate') WHERE template_id = 4 AND version = 2 AND step_number = 2");
    const r2 = await call('PUT', '/sequences/templates/4/steps/2', { ...PAYLOADS.task, expected_base: b2 });
    expect(r2.status).toBe(409);
    expect(r2.body.conflict.changed).toBe('step_fingerprint');
    expect((await stepRows(4, 2)).map((s) => s.action_config)).toEqual(before.map((s) => s.action_config));
  });

  test('a delete or a reorder between read and write: step_count / fingerprint 409', async () => {
    await seedTemplate(5);
    await call('PATCH', '/sequences/templates/5/steps/1', { timing: { type: 'immediate' } });   // fork the draft
    const { base } = await readBase(5, 3);
    expect((await call('PATCH', '/sequences/templates/5/steps/reorder', { fromStep: 3, toStep: 1 })).status).toBe(200);
    // position 3 now holds what was step 2 — the wf27 shape, refused
    const r1 = await call('PATCH', '/sequences/templates/5/steps/3', { timing: { type: 'immediate' }, expected_base: base });
    expect(r1.status).toBe(409);
    expect(r1.body.conflict.changed).toBe('step_fingerprint');
    expect((await call('DELETE', '/sequences/templates/5/steps/1')).status).toBe(200);
    const r2 = await call('PATCH', '/sequences/templates/5/steps/reorder', { order: [2, 1], expected_base: { draft_version: 2, step_count: 3 } });
    expect(r2.status).toBe(409);
    expect(r2.body.conflict).toEqual({ changed: 'step_count', expected: 3, actual: 2 });
    expect((await stepRows(5, 2)).map((s) => s.action_type)).toEqual(['sms', 'task']);
  });

  test('save-time validation refuses before any row moves (and before any draft fork)', async () => {
    await seedTemplate(6);
    const bad = [
      ['POST', '/sequences/templates/6/steps', { ...PAYLOADS.sms, step_number: 1, action_config: { function_name: 'send_smss', params: {} } }, /Unknown function_name/],
      ['PUT', '/sequences/templates/6/steps/1', { ...PAYLOADS.sms, action_config: { function_name: 'send_sms', params: { from: '1', to: '2', message: 'm', bogus: 1 } } }, /undeclared key: bogus/],
      ['PATCH', '/sequences/templates/6/steps/2', { action_config: { function_name: 'create_task', params: null } }, /is required/],
    ];
    for (const [m, u, b, re] of bad) {
      const r = await call(m, u, b);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(re);
    }
    const [t] = await q('SELECT draft_version FROM sequence_templates WHERE id = 6');
    expect(t.draft_version).toBeNull();
    expect(await q('SELECT COUNT(*) AS n FROM sequence_steps WHERE template_id = 6')).toEqual([{ n: 3 }]);
  });
});
