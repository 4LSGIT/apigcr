// tests/keyTasks.mysql.test.js
//
/**
 * Session-key tasks on REAL MySQL — access-control D3
 * (scripts/accessD3TaskSessionKey.js; routes/api.keyTasks.js through
 * services/taskService; the in-app routes/api.tasks.js on both schemas).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_d3_test npx jest tests/keyTasks.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates tasks,
 * log, scheduled_jobs, app_settings (production DDL from ref/database.sql —
 * i.e. the PRE-D3 schema), readonly_api_keys, admin_audit_log,
 * jwt_api_audit_log, users, contacts, cases. Needs the tz tables
 * (mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -uroot mysql): log rows are
 * dated with CONVERT_TZ(…, 'EST5EDT').
 *
 * WHAT IS LOCKED
 *   - DEPLOY ORDER both ways: on the pre-D3 schema every /api/key-tasks verb
 *     is a 500 and writes nothing, while the in-app task paths (create, list,
 *     get, update, complete, reopen, transfer, delete, history) all work.
 *   - The migration: CHECK writes nothing; APPLY adds the column INSTANT (a row
 *     version, no rebuild) and the index under ALGORITHM=INPLACE, LOCK=NONE;
 *     re-run no-op; a column / index of another shape is a NO-GO, unaltered.
 *   - Scope gate: legacy NULL key 403, a trio key 403, a child (even with
 *     tasks.own tampered into its row) 403, no key 401.
 *   - Create: owned row (from = the key's created_by, source
 *     session_key:<id>, task_session_key_id), log via session_key, the
 *     assignment email by default and not when switched off; the assignee
 *     predicate (active staff only; disabled / Automation / non-human /
 *     missing → 400); closed bodies.
 *   - Ownership: a task made in the app and one made by ANOTHER key are 404 on
 *     every verb and unchanged; the list is own-only.
 *   - Every verb on its own task works and logs { via: 'session_key', keyId };
 *     reassign = transferTask (log + email to the new assignee).
 *   - Rate limit: the 21st create in an hour → 429; rows from elsewhere count;
 *     a child's rows count toward its root; ageing frees it; 25 concurrent
 *     creates on a fresh key → exactly 20.
 *   - The action token never appears in any response.
 */
'use strict';

process.env.JWT_SECRET = 'key-tasks-d3-mysql-secret';

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({ ok: true })) }));

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const express = require('express');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const script = require('../scripts/accessD3TaskSessionKey');
const taskService = require('../services/taskService');
const { hashKey } = require('../lib/auth.readonly');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

/** CREATE + index/auto-increment ALTER blocks for `tables`, line-based (COMMENTs carry ';'). */
function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].match(/^CREATE TABLE `([^`]+)` \($/);
    const a = lines[i].match(/^ALTER TABLE `([^`]+)`$/);
    if ((c && tables.includes(c[1])) || (a && tables.includes(a[1]))) {
      const buf = [];
      for (; i < lines.length; i++) { buf.push(lines[i]); if (c ? /^\) ENGINE=.*;$/.test(lines[i]) : /;$/.test(lines[i])) break; }
      const s = buf.join('\n');
      if (!/ADD CONSTRAINT/.test(s)) out.push(s);
    }
  }
  return out;
}

d('D3 session-key tasks on real MySQL', () => {
  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const flush = (ms = 150) => new Promise(r => setTimeout(r, ms));
  const lines = () => { const out = []; return { out, log: (s) => out.push(String(s)) }; };
  const goLine = (out) => out.map(l => l.trim()).filter(l => /^(GO|NO-GO)\b/.test(l));
  const bodies = [];   // every key-route response body, for the token sweep

  const KEYS = {};     // name → { id, raw }
  async function key(name, scopes, { parent = null, createdBy = 6 } = {}) {
    const raw = `ycro_d3${name}fixture`;
    const [r] = await pool.query(
      `INSERT INTO readonly_api_keys (key_hash, key_prefix, label, created_by, expires_at, scopes, parent_key_id)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY), ?, ?)`,
      [hashKey(raw), raw.slice(0, 12), name, createdBy, scopes == null ? null : JSON.stringify(scopes), parent]);
    KEYS[name] = { id: r.insertId, raw };
    return KEYS[name];
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 30, timezone: 'Z' });
    const PROD = ['tasks', 'log', 'scheduled_jobs', 'app_settings'];
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...PROD, 'readonly_api_keys', 'admin_audit_log', 'jwt_api_audit_log', 'users', 'contacts', 'cases']) {
      await q(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await q('SET FOREIGN_KEY_CHECKS = 1');
    for (const s of schemaFor(PROD)) await q(s);
    await q(`CREATE TABLE readonly_api_keys (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      key_hash char(64) NOT NULL UNIQUE, key_prefix varchar(16) NOT NULL, label varchar(255) NOT NULL,
      created_by int NOT NULL, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at datetime NOT NULL, revoked_at datetime DEFAULT NULL, last_used_at datetime DEFAULT NULL,
      use_count int NOT NULL DEFAULT '0', scopes json DEFAULT NULL, parent_key_id int DEFAULT NULL,
      KEY idx_rok_parent (parent_key_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE admin_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, tool varchar(32) NOT NULL, user_id int DEFAULT NULL,
      username varchar(255) DEFAULT NULL, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      status varchar(40) NOT NULL, error_message text, duration_ms int DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, details json DEFAULT NULL,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE jwt_api_audit_log (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, route varchar(255) NOT NULL, method varchar(10) NOT NULL,
      headers json DEFAULT NULL, query_params json DEFAULT NULL, body json DEFAULT NULL,
      ip_address varchar(45) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL, auth_type varchar(20) DEFAULT NULL,
      username varchar(255) DEFAULT NULL, auth_status varchar(20) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE users (user tinyint NOT NULL PRIMARY KEY, user_name varchar(100), username varchar(100),
      user_type tinyint(1) NOT NULL DEFAULT 1, user_auth varchar(20) NOT NULL, roles varchar(100) NOT NULL DEFAULT '',
      email varchar(255), phone varchar(30), allow_sms tinyint(1) NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`INSERT INTO users (user, user_name, username, user_type, user_auth, roles, email) VALUES
      (0, 'Automation', 'automations', 0, 'authorized', 'automation', 'admin@example.test'),
      (6, 'IT', 'IT', 1, 'authorized', 'su', 'it@example.test'),
      (9, 'Fred', 'fred', 1, 'authorized', 'staff', 'fred@example.test'),
      (11, 'Dana', 'dana', 1, 'authorized', 'staff,attorney', 'dana@example.test'),
      (3, 'Ex Employee', 'ex', 1, 'disabled', 'staff', 'ex@example.test'),
      (20, 'Kiosk', 'kiosk', 0, 'authorized', '', 'kiosk@example.test')`);
    await q('CREATE TABLE contacts (contact_id int PRIMARY KEY, contact_name varchar(255)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await q('CREATE TABLE cases (case_id varchar(20) PRIMARY KEY, case_number varchar(50), case_number_full varchar(50)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await q("INSERT INTO contacts VALUES (9001, 'Test Client')");
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('task_from_email', 'tasks@example.test')").catch(() => {});

    await key('mgr', ['sql.ro', 'tasks.own', 'keys.mint']);
    await key('other', ['tasks.own']);
    await key('legacy', null);
    await key('trio', ['sql.ro', 'scratch', 'alert']);
    await key('child', ['sql.ro', 'tasks.own'], { parent: KEYS.mgr.id });   // tasks.own tampered in

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.keyTasks'));
    app.use(require('../routes/api.tasks'));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });
  beforeEach(() => emailService.sendEmail.mockClear());

  const staffJwt = () => jwt.sign({ sub: 9, userId: 9, username: 'fred', user_type: 1, user_auth: 'authorized', roles: ['staff'], aud: 'staff' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  async function hit(method, p, { key: k, jwt: j, body } = {}) {
    const headers = {};
    if (k) headers['x-readonly-api-key'] = k;
    if (j) headers.authorization = 'Bearer ' + staffJwt();
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (k) bodies.push(text);
    let json = {};
    try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
    return { status: r.status, body: json };
  }
  const create = (k, body) => hit('POST', '/api/key-tasks', { key: k, body: { to: 9, title: 'Do the thing', ...body } });
  const taskRow = async (id) => (await q('SELECT * FROM tasks WHERE task_id = ?', [id]))[0];
  const taskLog = async (id) => (await q(
    `SELECT log_by, log_data FROM log WHERE log_type = 'task' AND JSON_UNQUOTE(JSON_EXTRACT(log_data, '$.task_id')) = ? ORDER BY log_id`,
    [String(id)])).map(r => ({ by: r.log_by, ...JSON.parse(r.log_data) }));

  // ── deploy order, old schema ──────────────────────────────────────────────

  test('PRE-D3 schema: every key-task verb is a 500 and writes nothing', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const before = (await q('SELECT COUNT(*) n FROM tasks'))[0].n;
    const r = await create(KEYS.mgr.raw);
    expect(r.status).toBe(500);
    for (const [m, p] of [['GET', '/api/key-tasks'], ['GET', '/api/key-tasks/1'], ['PATCH', '/api/key-tasks/1'],
      ['PATCH', '/api/key-tasks/1/complete'], ['PATCH', '/api/key-tasks/1/reopen'], ['PATCH', '/api/key-tasks/1/delete']]) {
      expect([m, p, (await hit(m, p, { key: KEYS.mgr.raw, body: m === 'PATCH' ? {} : undefined })).status]).toEqual([m, p, 500]);
    }
    expect((await q('SELECT COUNT(*) n FROM tasks'))[0].n).toBe(before);
    expect(console.error.mock.calls.some(c => /Unknown column '(t\.)?task_session_key_id'/.test(c.join(' ')))).toBe(true);
    console.error.mockRestore();
  });

  let appTaskId;
  test('PRE-D3 schema: the in-app task paths all work', async () => {
    let r = await hit('POST', '/api/tasks', { jwt: true, body: { to: 11, title: 'In-app work', due: '2099-01-01' } });
    expect(r.status).toBe(200);
    appTaskId = r.body.task_id;
    expect((await hit('GET', '/api/tasks', { jwt: true })).body.data.map(t => t.id)).toContain(appTaskId);
    expect((await hit('GET', `/api/tasks/${appTaskId}`, { jwt: true })).body.data.title).toBe('In-app work');
    expect((await hit('PATCH', `/api/tasks/${appTaskId}`, { jwt: true, body: { task_title: 'In-app work (edited)' } })).status).toBe(200);
    expect((await hit('PATCH', `/api/tasks/${appTaskId}/transfer`, { jwt: true, body: { to: 9 } })).status).toBe(200);
    expect((await hit('PATCH', `/api/tasks/${appTaskId}/complete`, { jwt: true, body: {} })).status).toBe(200);
    expect((await hit('PATCH', `/api/tasks/${appTaskId}/reopen`, { jwt: true, body: {} })).status).toBe(200);
    const extra = (await hit('POST', '/api/tasks', { jwt: true, body: { to: 9, title: 'to delete' } })).body.task_id;
    expect((await hit('PATCH', `/api/tasks/${extra}/delete`, { jwt: true, body: {} })).status).toBe(200);
    expect((await hit('GET', `/api/tasks/${appTaskId}/history`, { jwt: true })).body.data.length).toBeGreaterThanOrEqual(5);
    await flush();
  });

  // ── the migration ─────────────────────────────────────────────────────────

  test('migration: CHECK writes nothing; APPLY: INSTANT column + INPLACE/LOCK=NONE index; re-run no-op', async () => {
    const conn = await pool.getConnection();
    try {
      const versions = async () => Number((await conn.query(
        "SELECT TOTAL_ROW_VERSIONS n FROM information_schema.innodb_tables WHERE name = CONCAT(DATABASE(), '/tasks')"))[0][0].n);
      const v0 = await versions();
      let L = lines();
      expect(await script.run(conn, { apply: false, log: L.log })).toEqual({ ok: true });
      expect(goLine(L.out)).toEqual(['GO — base state matches. Next: node scripts/accessD3TaskSessionKey.js --apply']);
      expect(L.out.join('\n')).toMatch(/ALGORITHM=INSTANT[\s\S]*ALGORITHM=INPLACE, LOCK=NONE/);
      expect(await q("SHOW COLUMNS FROM tasks LIKE 'task_session_key_id'")).toHaveLength(0);

      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
      expect(goLine(L.out)).toEqual(['GO — migration applied. Next: land + deploy access D3 (then npm run db:ref).']);
      expect(L.out).toEqual(expect.arrayContaining(['✓ column added (INSTANT)', '✓ index idx_tasks_session_key added (INPLACE, LOCK=NONE)']));
      expect(await versions()).toBe(v0 + 1);                                  // INSTANT: one row version, no rebuild
      const [c] = await q("SHOW FULL COLUMNS FROM tasks LIKE 'task_session_key_id'");
      expect(c).toMatchObject({ Type: 'int', Null: 'YES', Default: null, Key: 'MUL' });
      expect(c.Comment).toMatch(/^Session-key tasks \(access-control D3\)/);
      expect((await q("SHOW INDEX FROM tasks WHERE Key_name = 'idx_tasks_session_key'")).map(i => i.Column_name))
        .toEqual(['task_session_key_id', 'task_date']);
      expect(await q('SELECT task_id FROM tasks WHERE task_session_key_id IS NOT NULL')).toEqual([]);

      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
      expect(goLine(L.out)[0]).toMatch(/^GO — the migration is already applied/);
    } finally { conn.release(); }
  });

  // ── the scope gate ────────────────────────────────────────────────────────

  test('scope gate: legacy NULL 403, trio 403, child (tampered) 403, keyless 401', async () => {
    for (const k of ['legacy', 'trio', 'child']) {
      const r = await create(KEYS[k].raw);
      expect([k, r.status, r.body.missingScope]).toEqual([k, 403, 'tasks.own']);
    }
    expect((await hit('POST', '/api/key-tasks', { body: { to: 9, title: 'x' } })).status).toBe(401);
    expect((await hit('GET', '/api/key-tasks', { jwt: true })).status).toBe(401);       // a staff JWT is not a key
  });

  // ── create ────────────────────────────────────────────────────────────────

  let mine;
  test('create: an owned row — from = the key\'s minter, source session_key:<id>, the key\'s id; logged via the key; emailed', async () => {
    const r = await create(KEYS.mgr.raw, { title: 'Call the trustee', desc: 'about 341', due: '2099-02-01', link_type: 'contact', link_id: 9001 });
    expect(r.status).toBe(200);
    mine = r.body.task_id;
    expect(r.body.data).toMatchObject({ id: mine, title: 'Call the trustee', from: { id: 6 }, to: { id: 9 },
      link: { type: 'contact', id: 9001 }, source: `session_key:${KEYS.mgr.id}` });
    const row = await taskRow(mine);
    expect(row).toMatchObject({ task_from: 6, task_to: 9, task_source: `session_key:${KEYS.mgr.id}`, task_session_key_id: KEYS.mgr.id });
    expect(row.task_action_token).toMatch(/\S{10,}/);
    expect(await taskLog(mine)).toEqual([expect.objectContaining({ by: 6, action: 'created', assigned_to: 9, via: 'session_key', keyId: KEYS.mgr.id })]);
    await flush(300);
    expect(emailService.sendEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'fred@example.test' }));
  });

  test('send_assignment_email:false → no email', async () => {
    const r = await create(KEYS.mgr.raw, { title: 'quiet', send_assignment_email: false });
    expect(r.status).toBe(200);
    await flush(300);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('notify (default ON): completing the task emails the minter (task_from); notify:false does not; PATCH toggles it', async () => {
    const completionMails = () => emailService.sendEmail.mock.calls.filter(c => /^Task Completed:/.test(c[1].subject));
    const on = (await create(KEYS.mgr.raw, { title: 'notify default', send_assignment_email: false })).body.task_id;
    expect((await taskRow(on)).task_notification).toBe(1);
    emailService.sendEmail.mockClear();
    // the ASSIGNEE completes it in the app (Fred, JWT)
    expect((await hit('PATCH', `/api/tasks/${on}/complete`, { jwt: true, body: {} })).status).toBe(200);
    await flush(300);
    expect(completionMails().map(c => c[1].to)).toEqual(['it@example.test']);         // user 6 = the key's minter

    const off = (await create(KEYS.mgr.raw, { title: 'notify off', notify: false, send_assignment_email: false })).body.task_id;
    expect((await taskRow(off)).task_notification).toBe(0);
    emailService.sendEmail.mockClear();
    expect((await hit('PATCH', `/api/tasks/${off}/complete`, { jwt: true, body: {} })).status).toBe(200);
    await flush(300);
    expect(completionMails()).toEqual([]);

    const t = (await create(KEYS.mgr.raw, { title: 'notify toggled', notify: false, send_assignment_email: false })).body.task_id;
    expect((await hit('PATCH', `/api/key-tasks/${t}`, { key: KEYS.mgr.raw, body: { notify: true } })).body.data.notify).toBe(true);
    expect((await taskRow(t)).task_notification).toBe(1);
    expect((await hit('PATCH', `/api/key-tasks/${t}`, { key: KEYS.mgr.raw, body: { notify: 'no' } })).status).toBe(400);
    expect((await taskRow(t)).task_notification).toBe(1);
    emailService.sendEmail.mockClear();
    expect((await hit('PATCH', `/api/key-tasks/${t}/complete`, { key: KEYS.mgr.raw, body: {} })).status).toBe(200);
    await flush(300);
    expect(completionMails().map(c => c[1].to)).toEqual(['it@example.test']);
  });

  test('assignee: active staff only — disabled, Automation, non-human, missing, junk → 400, nothing written', async () => {
    const n0 = (await q('SELECT COUNT(*) n FROM tasks'))[0].n;
    for (const to of [3, 0, 20, 99, 'x', null, -1, 1.5]) {
      const r = await create(KEYS.mgr.raw, { to });
      expect([to, r.status]).toEqual([to, 400]);
      expect(r.body.message).toMatch(/active staff/);
    }
    expect((await create(KEYS.mgr.raw, { to: 11, title: 'for Dana' })).status).toBe(200);
    expect((await q('SELECT COUNT(*) n FROM tasks'))[0].n).toBe(n0 + 1);
  });

  test('closed bodies + field rules → 400, nothing written', async () => {
    const n0 = (await q('SELECT COUNT(*) n FROM tasks'))[0].n;
    for (const [body, msg] of [
      [{ status: 'Completed' }, /unknown field\(s\): status/], [{ from: 9 }, /unknown field\(s\): from/],
      [{ source: 'court_review' }, /unknown field/], [{ notify: 'yes' }, /notify must be true or false/], [{ notify: 1 }, /notify must be true or false/],
      [{ title: '' }, /title is required/], [{ title: 'x'.repeat(101) }, /title exceeds 100/],
      [{ desc: 'x'.repeat(1001) }, /desc exceeds 1000/], [{ due: '2026-02-30' }, /not a real date/],
      [{ start: '10/15/2026' }, /YYYY-MM-DD/], [{ link_type: 'matter', link_id: 1 }, /link_type must be one of/],
      [{ link_id: 5 }, /link_id needs link_type/], [{ link_type: 'case' }, /link_type needs link_id/],
      [{ send_assignment_email: 'no' }, /true or false/],
    ]) {
      const r = await create(KEYS.mgr.raw, body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      expect(r.body.message).toMatch(msg);
    }
    expect((await q('SELECT COUNT(*) n FROM tasks'))[0].n).toBe(n0);
  });

  // ── ownership ─────────────────────────────────────────────────────────────

  test('foreign tasks — made in the app, or by ANOTHER key — are 404 on every verb, and unchanged', async () => {
    const theirs = (await create(KEYS.other.raw, { title: 'other key work' })).body.task_id;
    for (const id of [appTaskId, theirs]) {
      const before = await taskRow(id);
      const logsBefore = (await taskLog(id)).length;
      for (const [m, p, body] of [['GET', '', undefined], ['PATCH', '', { title: 'hijack' }], ['PATCH', '', { to: 11 }],
        ['PATCH', '/complete', {}], ['PATCH', '/reopen', {}], ['PATCH', '/delete', {}]]) {
        const r = await hit(m, `/api/key-tasks/${id}${p}`, { key: KEYS.mgr.raw, body });
        expect([id, m + p, r.status, r.body.message]).toEqual([id, m + p, 404, 'Task not found']);
      }
      expect(await taskRow(id)).toEqual(before);
      expect((await taskLog(id)).length).toBe(logsBefore);
    }
    expect((await hit('GET', '/api/key-tasks/999999', { key: KEYS.mgr.raw })).body.message).toBe('Task not found');
    const list = await hit('GET', '/api/key-tasks?status=All', { key: KEYS.mgr.raw });
    const ids = list.body.data.map(t => t.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(appTaskId);
    expect(ids).not.toContain(theirs);
    expect(list.body.data.every(t => t.source === `session_key:${KEYS.mgr.id}`)).toBe(true);
  });

  // ── every verb on its own task ────────────────────────────────────────────

  test('edit, reassign, complete, reopen, delete — each works and logs via the key', async () => {
    const via = { via: 'session_key', keyId: KEYS.mgr.id };
    let r = await hit('PATCH', `/api/key-tasks/${mine}`, { key: KEYS.mgr.raw, body: { title: 'Call the trustee today', due: '2099-03-01' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ title: 'Call the trustee today' });
    expect(String((await taskRow(mine)).task_due.toISOString()).slice(0, 10)).toBe('2099-03-01');
    expect((await taskLog(mine)).pop()).toMatchObject({ by: 6, action: 'updated', changed: ['task_title', 'task_due', 'task_status'], ...via });

    emailService.sendEmail.mockClear();
    r = await hit('PATCH', `/api/key-tasks/${mine}`, { key: KEYS.mgr.raw, body: { to: 11 } });
    expect(r.body.data.to.id).toBe(11);
    expect((await taskLog(mine)).pop()).toMatchObject({ action: 'transferred', from_user_id: 9, to_user_id: 11, ...via });
    await flush(300);
    expect(emailService.sendEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'dana@example.test' }));
    expect((await hit('PATCH', `/api/key-tasks/${mine}`, { key: KEYS.mgr.raw, body: { to: 3 } })).status).toBe(400);

    r = await hit('PATCH', `/api/key-tasks/${mine}`, { key: KEYS.mgr.raw, body: { link_type: null } });
    expect(r.body.data.link).toBeNull();
    expect(await taskRow(mine)).toMatchObject({ task_link: '', task_link_type: null, task_link_id: null });

    r = await hit('PATCH', `/api/key-tasks/${mine}/complete`, { key: KEYS.mgr.raw, body: { note: 'done by phone' } });
    expect(r.body.data.status).toBe('Completed');
    expect((await taskLog(mine)).pop()).toMatchObject({ action: 'completed', note: 'done by phone', ...via });
    expect((await hit('PATCH', `/api/key-tasks/${mine}/complete`, { key: KEYS.mgr.raw, body: {} })).status).toBe(400);
    // reassigning a completed task: 400 before any write
    const logs = (await taskLog(mine)).length;
    expect((await hit('PATCH', `/api/key-tasks/${mine}`, { key: KEYS.mgr.raw, body: { title: 'x', to: 9 } })).body.message).toMatch(/Cannot transfer a Completed task/);
    expect((await taskLog(mine)).length).toBe(logs);

    r = await hit('PATCH', `/api/key-tasks/${mine}/reopen`, { key: KEYS.mgr.raw, body: {} });
    expect(r.body.data.status).toBe('Pending');
    expect((await taskLog(mine)).pop()).toMatchObject({ action: 'reopened', previous_status: 'Completed', ...via });

    r = await hit('PATCH', `/api/key-tasks/${mine}/delete`, { key: KEYS.mgr.raw, body: { note: 'no longer needed' } });
    expect(r.body.data.status).toBe('Deleted');
    expect((await taskLog(mine)).pop()).toMatchObject({ action: 'deleted', previous_status: 'Pending', note: 'no longer needed', ...via });

    // the in-app history shows the key as the actor
    const h = await taskService.getTaskHistory(pool, mine);
    expect(h.every(e => e.data.via === 'session_key' && e.data.keyId === KEYS.mgr.id)).toBe(true);
    expect((await hit('PATCH', `/api/key-tasks/${mine}`, { key: KEYS.mgr.raw, body: {} })).body.message).toMatch(/nothing to change/);
    expect((await hit('PATCH', `/api/key-tasks/${mine}/reopen`, { key: KEYS.mgr.raw, body: { note: 'x' } })).status).toBe(400);
  });

  // ── rate limit ────────────────────────────────────────────────────────────

  test('20 creates per rolling hour per root key; rows from elsewhere and from its children count', async () => {
    const k = await key('rate', ['tasks.own']);
    for (let i = 0; i < 20; i++) expect((await create(k.raw, { title: `t${i}`, send_assignment_email: false })).status).toBe(200);
    const r = await create(k.raw, { title: 'twenty-first' });
    expect(r.status).toBe(429);
    expect(r.body.message).toMatch(/20 tasks per rolling hour per key/);
    expect(await q("SELECT task_id FROM tasks WHERE task_title = 'twenty-first'")).toEqual([]);
    await q('UPDATE tasks SET task_date = NOW() - INTERVAL 61 MINUTE WHERE task_session_key_id = ?', [k.id]);
    expect((await create(k.raw, { title: 'after the hour', send_assignment_email: false })).status).toBe(200);
    // a child's rows count toward its root (written directly: a child cannot hold tasks.own)
    const p = await key('rateparent', ['tasks.own', 'keys.mint']);
    const c = await key('ratechild', ['sql.ro'], { parent: p.id });
    for (let i = 0; i < 20; i++) {
      await q(`INSERT INTO tasks (task_from, task_to, task_title, task_desc, task_link, task_date, task_session_key_id)
               VALUES (6, 9, 'elsewhere', '', '', NOW(), ?)`, [c.id]);
    }
    expect((await create(p.raw)).status).toBe(429);
  });

  test('25 concurrent creates on a fresh key → exactly 20', async () => {
    const k = await key('race', ['tasks.own']);
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => create(k.raw, { title: `race${i}`, send_assignment_email: false })));
    const by = rs.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
    expect(by).toEqual({ 200: 20, 429: 5 });
    expect(Number((await q('SELECT COUNT(*) n FROM tasks WHERE task_session_key_id = ?', [k.id]))[0].n)).toBe(20);
  });

  // ── the action token ──────────────────────────────────────────────────────

  test('migration NO-GO on a column or index of another shape; nothing altered', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.query('ALTER TABLE tasks DROP INDEX idx_tasks_session_key, ADD INDEX idx_tasks_session_key (task_session_key_id)');
      let L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: false });
      expect(L.out.join('\n')).toMatch(/index idx_tasks_session_key exists as \(task_session_key_id\)/);
      expect(goLine(L.out)[0]).toMatch(/^NO-GO — re-verify by hand/);
      expect((await q("SHOW INDEX FROM tasks WHERE Key_name = 'idx_tasks_session_key'")).map(i => i.Column_name)).toEqual(['task_session_key_id']);
      await conn.query('ALTER TABLE tasks DROP INDEX idx_tasks_session_key, MODIFY task_session_key_id bigint NULL');
      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: false });
      expect(L.out.join('\n')).toMatch(/task_session_key_id exists as bigint/);
      expect((await q("SHOW COLUMNS FROM tasks LIKE 'task_session_key_id'"))[0].Type).toBe('bigint');
      // restored by hand, the script resumes with only the index
      await conn.query('ALTER TABLE tasks MODIFY task_session_key_id int NULL');
      L = lines();
      expect(await script.run(conn, { apply: true, log: L.log })).toEqual({ ok: true });
      expect(L.out.filter(l => l.startsWith('✓')).slice(0, 1)).toEqual(['✓ index idx_tasks_session_key added (INPLACE, LOCK=NONE)']);
    } finally { conn.release(); }
  });

  test('the action token appears in no key-route response', async () => {
    const tokens = (await q('SELECT task_action_token t FROM tasks WHERE task_session_key_id IS NOT NULL AND task_action_token IS NOT NULL')).map(r => r.t);
    expect(tokens.length).toBeGreaterThan(20);
    expect(bodies.length).toBeGreaterThan(50);
    for (const b of bodies) {
      expect(b).not.toMatch(/action_token|action_url/);
      for (const t of tokens) expect(b.includes(t) ? `${t} in ${b.slice(0, 400)}` : false).toBe(false);
    }
  });
});
