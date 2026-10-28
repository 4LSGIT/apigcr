// tests/caseySequencePublish.mysql.test.js
//
/**
 * A18.3 on REAL MySQL: the sequence.publish.v1 normalizer's SQL, and the
 * shipped browser builder's request through the real routes/sequences.js
 * router, real lib/withTransaction and a real InnoDB engine.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a183_test npx jest tests/caseySequencePublish.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql (live types,
 * keys; FKs kept only between cloned tables). Never point it at port 3306
 * (the production proxy).
 *
 * WHY A REAL ENGINE (course correction 5): the fingerprint the card bakes is
 * computed from rows mysql2 returns with JSON already PARSED and object keys
 * RE-ORDERED by MySQL (wf50), and the route recomputes it inside the publish
 * transaction from its own reads — including the draft version row's
 * template_condition, a JSON column. Here both sides read the real column
 * types, the enrollment counts run against the real status enum, and the
 * template condition is changed through the REAL PUT route (which writes the
 * draft version row without moving draft_version or touching a step).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 6, roles: ['staff'], username: 'IT' }; next(); }));

const { withTransaction } = require('../lib/withTransaction');
const { normalizeActionDraft } = require('../services/assistantService');
const automationReadService = require('../services/automationReadService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
// The sequence tables the card and the route read — the same four
// caseySequenceStep.mysql.test.js builds, so a shared _test DB holds no table
// with an FK that only one of them knows to drop. "What can enroll it"
// (automationReadService.references, its own suites' SQL) is stubbed below:
// this suite is about the publish predicates, not that scan.
const TABLES = ['sequence_templates', 'sequence_template_versions', 'sequence_steps', 'sequence_enrollments'];

// Line-based extraction (column COMMENTs may hold ';'). Constraint clauses
// that reference a table outside TABLES are dropped: this suite tests the
// publish predicates, not those parents.
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
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

// The SHIPPED browser builder, extracted from public/assistant.html.
function browserBuilder() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const m = /function\s+sequencePublishRequest\s*\(/.exec(html);
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', m.index); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${html.slice(m.index, end)}; return sequencePublishRequest;`)();
}

d('A18.3 sequence publish on real MySQL', () => {
  let pool;
  let server;
  let port;
  const buildRequest = browserBuilder();
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  const call = (method, urlPath, payload) => new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request({ port, path: urlPath, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => { let body = {}; try { body = JSON.parse(out || '{}'); } catch { body = { raw: out }; } resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  const evidenceFor = (id) => [{ id: 'q1', label: `Sequence ${id}`, rows: [{ sequence_template_id: id, step_number: 1, row_number: 1 }] }];
  const card = (id) => normalizeActionDraft(pool, {
    kind: 'sequence.publish.v1', sequence_template_id: id, evidence: [{ query_id: 'q1', row_number: 1 }],
  }, evidenceFor(id));
  const COND = { query: 'SELECT 1 AS ok', params: {}, assert: { ok: 1 } };

  // Published v1 (2 sms steps) + draft v2 (3 steps: step 1's text edited,
  // one appended), both version rows carrying COND. Step JSON is inserted
  // with keys in an order MySQL re-orders on write.
  async function seedTemplate(id, { firstPublish = false } = {}) {
    const cur = firstPublish ? 0 : 1;
    const draft = cur + 1;
    await q('INSERT INTO sequence_templates (id, name, type, active, current_version, draft_version) VALUES (?, ?, NULL, 1, ?, ?)', [id, `t${id}`, cur, draft]);
    for (const v of firstPublish ? [draft] : [cur, draft]) {
      await q(`INSERT INTO sequence_template_versions (template_id, version, name, template_condition, published_at)
               VALUES (?, ?, ?, ?, ${v === cur ? 'NOW()' : 'NULL'})`, [id, v, `t${id}`, JSON.stringify(COND)]);
      const steps = v === draft ? 3 : 2;
      for (let n = 1; n <= steps; n++) {
        await q(`INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing, error_policy)
                 VALUES (?, ?, ?, 'sms', ?, ?, ?)`,
        [id, v, n, JSON.stringify({ params: { message: v === draft && n === 1 ? 'edited' : `m${n}`, to: '{{contacts.contact_phone}}', from: '2484179800' }, function_name: 'send_sms' }),
          JSON.stringify({ value: n, unit: 'minutes', type: 'delay' }), JSON.stringify({ strategy: 'ignore', max_retries: 0, backoff_seconds: 5 })]);
      }
    }
  }
  const tplRow = async (id) => (await q('SELECT current_version, draft_version FROM sequence_templates WHERE id = ?', [id]))[0];

  beforeAll(async () => {
    jest.spyOn(automationReadService, 'references').mockImplementation(async (_db, { sequence_template_id }) =>
      [{ source: 'hook', sequence_template_id, source_id: 5, source_name: 'No-show hook', active: true }]);
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
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

  test('the card reads real rows: counts by status and version, and the condition column', async () => {
    await seedTemplate(1);
    await q(`INSERT INTO sequence_enrollments (template_id, template_version, contact_id, status, trigger_data, current_step)
             VALUES (1, 1, 1, 'active', '{}', 1), (1, 1, 2, 'active', '{}', 2), (1, 1, 3, 'cancelled', '{}', 1),
                    (1, 1, 4, 'completed', '{}', 2), (1, 0, 5, 'active', '{}', 1)`);
    const c = await card(1);
    expect(c).toMatchObject({ classification: 'structural', publish: { from_version: 1, to_version: 2, step_count: 3 },
      in_flight_count: 2, stranded_count: 1 });
    expect(c.changes).toEqual([{ step_number: 3, kind: 'added' }, { step_number: 1, kind: 'modified', fields: ['action_config'] }]);
    expect(c.starters).toEqual([{ source: 'hook', name: 'No-show hook', active: 1 }]);
    const [row] = await q('SELECT template_condition FROM sequence_template_versions WHERE template_id = 1 AND version = 2');
    expect(typeof row.template_condition).toBe('object');                    // parsed by mysql2, not a string
  });

  test('the card publishes through the real route; enrollments stay on their version', async () => {
    await seedTemplate(2);
    await q(`INSERT INTO sequence_enrollments (template_id, template_version, contact_id, status, trigger_data, current_step)
             VALUES (2, 1, 1, 'active', '{}', 1)`);
    const [stored] = await q('SELECT action_config FROM sequence_steps WHERE template_id = 2 AND version = 2 AND step_number = 1');
    expect(Object.keys(stored.action_config.params)).not.toEqual(['message', 'to', 'from']);   // re-ordered on write
    const c = await card(2);
    const r = await call('POST', '/sequences/templates/2/publish', buildRequest(c).body);
    expect({ status: r.status, published: r.body.published_version, migrated: r.body.migrated_count, error: r.body.error || null })
      .toEqual({ status: 200, published: 2, migrated: null, error: null });
    expect(await tplRow(2)).toEqual({ current_version: 2, draft_version: null });
    expect(await q('SELECT template_version FROM sequence_enrollments WHERE template_id = 2')).toEqual([{ template_version: 1 }]);
  });

  test('a template condition changed through the real PUT after the review is refused, nothing written', async () => {
    await seedTemplate(3);
    const c = await card(3);
    const put = await call('PUT', '/sequences/templates/3', { condition: { ...COND, assert: { ok: 0 } } });
    expect(put.status).toBe(200);
    expect(await tplRow(3)).toEqual({ current_version: 1, draft_version: 2 });   // the draft did not move
    expect(await q('SELECT COUNT(*) AS n FROM sequence_steps WHERE template_id = 3 AND version = 2')).toEqual([{ n: 3 }]);
    const r = await call('POST', '/sequences/templates/3/publish', buildRequest(c).body);
    expect({ status: r.status, changed: r.body.conflict && r.body.conflict.changed }).toEqual({ status: 409, changed: 'draft_fingerprint' });
    expect(await tplRow(3)).toEqual({ current_version: 1, draft_version: 2 });
    expect(await q('SELECT published_at FROM sequence_template_versions WHERE template_id = 3 AND version = 2')).toEqual([{ published_at: null }]);
  });

  test('a step edited through the real PATCH after the review is refused; a re-read card then publishes', async () => {
    await seedTemplate(4);
    const stale = await card(4);
    expect((await call('PATCH', '/sequences/templates/4/steps/2', { timing: { type: 'immediate' } })).status).toBe(200);
    const r = await call('POST', '/sequences/templates/4/publish', buildRequest(stale).body);
    expect({ status: r.status, changed: r.body.conflict && r.body.conflict.changed }).toEqual({ status: 409, changed: 'draft_fingerprint' });
    expect(await tplRow(4)).toEqual({ current_version: 1, draft_version: 2 });
    const fresh = await card(4);
    expect((await call('POST', '/sequences/templates/4/publish', buildRequest(fresh).body)).status).toBe(200);
    expect(await tplRow(4)).toEqual({ current_version: 2, draft_version: null });
  });

  test('a first publish (v0) and a native publish with no expected_base both still work', async () => {
    await seedTemplate(5, { firstPublish: true });
    const c = await card(5);
    expect(c.classification).toBe('first_publish');
    expect((await call('POST', '/sequences/templates/5/publish', buildRequest(c).body)).status).toBe(200);
    expect(await tplRow(5)).toEqual({ current_version: 1, draft_version: null });
    await seedTemplate(6);
    expect((await call('POST', '/sequences/templates/6/publish', {})).status).toBe(200);
    expect(await tplRow(6)).toEqual({ current_version: 2, draft_version: null });
  });
});
