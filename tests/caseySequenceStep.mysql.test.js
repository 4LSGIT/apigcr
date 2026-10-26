// tests/caseySequenceStep.mysql.test.js
//
/**
 * A18.2 on REAL MySQL: the sequence.step_insert.v1 normalizer's SQL
 * predicates, and the shipped browser builder's request through the real
 * routes/sequences.js router, real lib/withTransaction, real
 * lib/requestIdempotency and a real InnoDB engine.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3351/yc_a182_test npx jest tests/caseySequenceStep.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql (live types,
 * keys; FKs kept only between cloned tables). Never point it at port 3306
 * (the production proxy).
 *
 * WHY A REAL ENGINE (course correction 5): mocked queries shipped
 * `user_auth = 1` against a varchar. Here the predicates that decide a card —
 * `phone_lines.active = 1`, the utf8mb4_general_ci mailbox equality,
 * findAssignableStaff's LIKE, the editing-version read, the active-enrollment
 * count — run against the real column types, and the fingerprint is computed
 * from rows mysql2 returns with JSON already parsed and keys re-ordered.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 6, roles: ['staff'] }; next(); }));

const { withTransaction } = require('../lib/withTransaction');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'sequence_templates', 'sequence_template_versions', 'sequence_steps', 'sequence_enrollments',
  'phone_lines', 'email_credentials', 'request_idempotency'];

// Line-based extraction (column COMMENTs may hold ';'). Constraint clauses
// that reference a table outside TABLES are dropped (contacts, credentials):
// this suite tests predicates, not those parents.
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
  const constSrc = (name) => {
    const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
    let depth = 0;
    for (let i = m.index; i < html.length; i++) {
      const c = html[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ';' && depth === 0) return html.slice(m.index, i + 1);
    }
    throw new Error(name);
  };
  const m = /function\s+sequenceStepActionRequest\s*\(/.exec(html);
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', m.index); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${constSrc('SEQUENCE_STEP_FUNCTIONS')}\n${constSrc('SEQUENCE_STEP_ERROR_POLICY')}\n${html.slice(m.index, end)}; return sequenceStepActionRequest;`)();
}

d('A18.2 sequence step insert on real MySQL', () => {
  let pool;
  let server;
  let port;
  const buildRequest = browserBuilder();
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  const call = (method, urlPath, payload, headers = {}) => new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request({ port, path: urlPath, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } : headers,
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
  const CITE = [{ query_id: 'q1', row_number: 1 }];
  const card = (id, over = {}) => normalizeActionDraft(pool, {
    kind: 'sequence.step_insert.v1', sequence_template_id: id, action_type: 'sms',
    action_config: { params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Hi "{{contacts.contact_fname}}"' } },
    timing: { type: 'delay', value: 2, unit: 'hours' }, evidence: CITE, ...over,
  }, evidenceFor(id));

  async function seedTemplate(id, { draft = false } = {}) {
    await q('INSERT INTO sequence_templates (id, name, type, active, current_version, draft_version) VALUES (?, ?, NULL, 1, 1, ?)', [id, `t${id}`, draft ? 2 : null]);
    await q('INSERT INTO sequence_template_versions (template_id, version, name, published_at) VALUES (?, 1, ?, NOW())', [id, `t${id}`]);
    const versions = draft ? [1, 2] : [1];
    for (const v of versions) {
      const steps = v === 2 ? 4 : 3;
      for (let n = 1; n <= steps; n++) {
        await q(`INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing, error_policy)
                 VALUES (?, ?, ?, 'sms', ?, ?, ?)`,
        [id, v, n, JSON.stringify({ function_name: 'send_sms', params: { message: `m${v}.${n}`, to: '{{contacts.contact_phone}}', from: '2484179800' } }),
          JSON.stringify({ value: n, unit: 'minutes', type: 'delay' }), JSON.stringify({ strategy: 'ignore', max_retries: 0, backoff_seconds: 5 })]);
      }
    }
  }

  beforeAll(async () => {
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

    // users: active staff 6/7, a disabled login, a machine user (type 0).
    for (const [user, name, auth, type] of [[6, 'IT', 'authorized', 1], [7, 'Stuart', 'authorized - admin', 1],
      [8, 'Gone', 'disabled', 1], [0, 'Automations', 'authorized', 0]]) {
      await q('INSERT INTO users (user, user_name, user_auth, user_type) VALUES (?, ?, ?, ?)', [user, name, auth, type]);
    }
    await q("INSERT INTO phone_lines (id, phone_number, provider, display_name, active, credential_id) VALUES (6, '2484179800', 'quo', 'office', 1, 1), (7, '7344663328', 'ringcentral', 'RC-old', 0, 1)");
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, provider, from_name)
             VALUES (16, 'office@4lsg.com', 'h', 465, 'u', 'ENCv1:x', 'gmail', '4LSG Office')`);

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

  test('sender, mailbox and assignee predicates on the real column types', async () => {
    await seedTemplate(1);
    expect((await card(1)).sender).toBe('office (2484179800)');
    await expect(card(1, { action_config: { params: { from: '7344663328', to: 'x', message: 'm' } } }))
      .rejects.toThrow(/not an active firm phone line/);                  // active = 0 is refused
    const email = (from) => card(1, { action_type: 'email', action_config: { params: { from, to: 'x', subject: 's', text: 't' } } });
    expect((await email('Office@4LSG.com')).sender).toBe('4LSG Office <office@4lsg.com>');   // general_ci equality
    await expect(email('office@4lsg.co')).rejects.toThrow(/not a configured firm mailbox/);
    const task = (assigned_to) => card(1, { action_type: 'task', action_config: { params: { title: 't', assigned_to } } });
    expect((await task(7)).assignee).toBe('Stuart (#7)');                  // 'authorized - admin' passes LIKE
    await expect(task(8)).rejects.toThrow(/not an active staff member/);   // disabled
    await expect(task(0)).rejects.toThrow(/not an active staff member/);   // user_type 0
  });

  // Ruling 15: the closed placeholder set, and the trigger_data echo read off
  // the REAL action_config column — mysql2 hands it back parsed, keys
  // re-ordered, which is exactly what the echo comparison has to survive.
  test('placeholder senders: the closed set, and a trigger_data echo found in real stored JSON', async () => {
    await seedTemplate(6);
    const ph = await card(6, { action_config: { params: { from: '{{users.default_phone}}', to: '{{contacts.contact_phone}}', message: 'm' } } });
    expect(ph.sender).toBe('{{users.default_phone}}');
    expect(ph.sender_note).toMatch(/enrolling user's default phone/);
    const email = (from) => card(6, { action_type: 'email', action_config: { params: { from, to: '{{contacts.contact_email}}', subject: 's', text: 't' } } });
    await expect(email('{{trigger_data.automationsFrom}}')).rejects.toThrow(/sender placeholder the sequence engine resolves/);
    await q(`INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing, error_policy)
             VALUES (6, 1, 4, 'internal_function', ?, '{"type":"immediate"}', NULL)`,
    [JSON.stringify({ params: { text: 'x', subject: 'Failed', to: 'billing@4lsg.com', from: '{{trigger_data.automationsFrom}}' }, function_name: 'send_email' })]);
    const [row] = await q('SELECT action_config FROM sequence_steps WHERE template_id = 6 AND step_number = 4');
    expect(typeof row.action_config).toBe('object');                        // parsed by mysql2, not a string
    const echoed = await email('{{trigger_data.automationsFrom}}');
    expect(echoed.sender).toBe('{{trigger_data.automationsFrom}}');
    expect(echoed.sender_note).toMatch(/other email steps already use/);
  });

  test('the editing version is read (draft ?? current) and only ACTIVE enrollments are counted', async () => {
    await seedTemplate(2, { draft: true });
    await q(`INSERT INTO sequence_enrollments (template_id, template_version, contact_id, status, trigger_data, current_step)
             VALUES (2, 1, 1, 'active', '{}', 1), (2, 1, 2, 'cancelled', '{}', 1), (2, 1, 3, 'completed', '{}', 1)`);
    const out = await card(2, { step_number: 2 });
    expect(out.expected_base).toMatchObject({ draft_version: 2, step_count: 4 });
    expect(out.template).toMatchObject({ has_draft: 1, published_version: 1, active_enrollments: 1 });
    await expect(card(2, { step_number: 6 })).rejects.toThrow(/position must be 1-5 \(the template's draft has 4 steps\)/);
  });

  test('the card applies through the real route; MySQL\'s JSON key re-ordering does not break the fingerprint', async () => {
    await seedTemplate(3);
    const [row] = await q('SELECT action_config FROM sequence_steps WHERE template_id = 3 AND version = 1 AND step_number = 2');
    expect(Object.keys(row.action_config.params)).not.toEqual(['message', 'to', 'from']);   // re-ordered on write
    const c = await card(3, { step_number: 2 });
    const r = await call('POST', '/sequences/templates/3/steps', buildRequest(c).body, { 'idempotency-key': c.draft_id });
    expect({ status: r.status, stepNumber: r.body.stepNumber, error: r.body.error || null }).toEqual({ status: 201, stepNumber: 2, error: null });
    const rows = await q('SELECT step_number, action_config, timing, error_policy, `condition`, fire_guard FROM sequence_steps WHERE template_id = 3 AND version = 2 ORDER BY step_number');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ step_number: 2, timing: { type: 'delay', value: 2, unit: 'hours' },
      error_policy: { strategy: 'ignore', max_retries: 0, backoff_seconds: 5 }, condition: null, fire_guard: null });
    expect(rows[1].action_config).toEqual({ function_name: 'send_sms', params: c.step.params });
    expect(rows[2].action_config.params.message).toBe('m1.2');             // the displaced step moved down one
    const [[t]] = await pool.query('SELECT draft_version FROM sequence_templates WHERE id = 3');
    expect(t.draft_version).toBe(2);
  });

  test('the draft_id replays instead of inserting twice; a stale card is refused, writes nothing, and frees its key', async () => {
    await seedTemplate(4);
    const c = await card(4);
    const req = buildRequest(c);
    const first = await call('POST', '/sequences/templates/4/steps', req.body, { 'idempotency-key': c.draft_id });
    const second = await call('POST', '/sequences/templates/4/steps', req.body, { 'idempotency-key': c.draft_id });
    expect([first.status, second.status, second.body.replayed, second.body.stepNumber]).toEqual([201, 201, true, first.body.stepNumber]);
    expect(await q('SELECT COUNT(*) AS n FROM sequence_steps WHERE template_id = 4 AND version = 2')).toEqual([{ n: 4 }]);
    expect(await q("SELECT scope, status FROM request_idempotency WHERE idem_key = ?", [c.draft_id]))
      .toEqual([{ scope: 'sequences.step_insert', status: 'applied' }]);

    // A card built against the published v1 (draft null) is stale once the
    // first insert forked draft v2.
    await seedTemplate(5);
    const staleCard = await card(5, { step_number: 1 });
    expect((await call('PATCH', '/sequences/templates/5/steps/1', { timing: { type: 'immediate' } })).status).toBe(200);
    const key = crypto.randomUUID();
    const refused = await call('POST', '/sequences/templates/5/steps', buildRequest(staleCard).body, { 'idempotency-key': key });
    expect(refused.status).toBe(409);
    expect(refused.body.conflict).toEqual({ changed: 'draft_version', expected: null, actual: 2 });
    expect(await q('SELECT COUNT(*) AS n FROM sequence_steps WHERE template_id = 5 AND version = 2')).toEqual([{ n: 3 }]);
    expect(await q('SELECT COUNT(*) AS n FROM request_idempotency WHERE idem_key = ?', [key])).toEqual([{ n: 0 }]);
  });
});
