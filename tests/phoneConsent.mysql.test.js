// tests/phoneConsent.mysql.test.js
//
/**
 * YisraMail P2 — inbound SMS opt-out on a REAL engine (ref/YISRAMAIL_DESIGN.md
 * §4.6): services/phoneConsentService.handleInbound through the real
 * optoutService.recordConsent, its own SQL (the active-row lock, the
 * open-client predicate, the review dedupe on tasks, the ledger lookup, the
 * Quo confirmation job) and the state guard under real row locks, including
 * concurrent first-time opt-outs. Nothing in the consent path is mocked;
 * mocked are the collaborators that would leave the scratch DB: taskService
 * (a real INSERT stands in for it), calendarService (network), lib/taskQueue
 * (Cloud Tasks) and lib/alerting.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3377/yc_p2_test npx jest tests/phoneConsent.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it — contacts / contact_phones / case_relate / cases /
 * tasks / scheduled_jobs / app_settings cloned line-by-line from
 * ref/database.sql (with their ALTER blocks: keys, the active-only unique
 * index, AUTO_INCREMENT), the comm_* tables from the P1 migration
 * (tests/helpers/consentSchema.js). Siblings that create any of these are
 * dropped here first (the twin rule), and its own tables are dropped again
 * at the end. Run it on a server started with
 * --default-time-zone=+00:00 and the production sql_mode (the pool also sets
 * the session sql_mode). Never point it at port 3306 (the production proxy).
 */
'use strict';

jest.mock('../services/taskService', () => ({ createTask: jest.fn() }));
jest.mock('../services/calendarService', () => ({ nextBusinessDay: jest.fn() }));
jest.mock('../lib/taskQueue', () => ({ enqueueJobDispatch: jest.fn(async () => {}) }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const taskService = require('../services/taskService');
const alerting = require('../lib/alerting');
const calendarService = require('../services/calendarService');
const svc = require('../services/phoneConsentService');
const { CONSENT_TABLES: COMM, consentStatements } = require('./helpers/consentSchema');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'contact_phones', 'case_relate', 'cases', 'tasks', 'scheduled_jobs', 'app_settings', 'phone_lines', 'phone_event_log', 'system_alerts', 'users'];
// Tables siblings create that hold an FK into ours (consentCore twin:
// contact_emails → contacts) or share the DB's id space — dropped first, or
// re-creating `contacts` fails on the sibling's leftover constraint.
const SIBLING_DROPS = ['contact_emails', 'field_defs'];

// Line-based extraction of each table's CREATE block AND its ALTER blocks (the
// keys live there) — the tests/consentCore.mysql.test.js extractor. FK clauses
// naming a table outside the list are dropped.
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
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${buf[0]}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks of ${tables.length}`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return [...creates, ...alters];
}

const LINE_RC = '2485592400';
const LINE_QUO = '2484179800';
const PAT = '3135550001';     // client, open Primary case
const SAM = '3135550002';     // closed case
const ANN = '3135550003';     // 'Other' relation on an open case
const GHOST = '3135550009';   // no row at all

d('inbound SMS opt-out on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  async function reset() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    // Any sibling table holding an FK into ours (e.g. optout.mysql's
    // sequence_enrollments / campaign_contacts → contacts) would refuse our
    // re-created tables' constraints — found by the catalog, not by name.
    const holders = await q(`SELECT DISTINCT TABLE_NAME AS t FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?)`, [TABLES]);
    for (const t of [...COMM, ...SIBLING_DROPS, ...holders.map((h) => h.t), ...TABLES]) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    for (const sql of schemaFor(TABLES)) await q(sql);
    for (const sql of consentStatements()) await q(sql);
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname) VALUES
      (1, 'Pat Client', 'Pat', 'Client'), (2, 'Sam Former', 'Sam', 'Former'), (3, 'Ann Other', 'Ann', 'Other')`);
    await q(`INSERT INTO contact_phones (id, contact_id, phone) VALUES (11, 1, '${PAT}'), (12, 2, '${SAM}'), (13, 3, '${ANN}')`);
    await q(`INSERT INTO cases (case_id, case_stage, case_status) VALUES ('C100', 'Filed', ''), ('C200', 'Closed', ''), ('C300', 'Open', '')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (1, 'C100', 1, 'Primary'), (2, 'C200', 2, 'Primary'), (3, 'C300', 3, 'Other')`);
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('consent_task_user_id', '22')");
    // The assignee rule is P3's (unsubService.resolveAssignee): an ACTIVE user.
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral) VALUES
      (22, 'rg', 'Rena', 'Rena', 'G', 'RG', 'authorized', 0), (23, 'gone', 'Gone', 'Gone', 'User', 'GU', 'disabled', 0)`);
  }
  const events = () => q('SELECT id, destination, scope, action, source, provider_event_id, contact_id, line_number, occurred_at FROM comm_consent_events ORDER BY id');
  const stateOf = async (dest) => (await q("SELECT state, last_event_id FROM comm_consent_state WHERE channel = 'sms' AND destination = ? AND scope = 'all'", [dest]))[0] || null;
  const flag = async (id) => Number((await q('SELECT sms_optout AS f FROM contact_phones WHERE id = ?', [id]))[0].f);
  const inbound = (over = {}) => svc.handleInbound(pool, {
    provider: 'ringcentral', providerRef: 'm-1', line: LINE_RC, from10: PAT, body: 'STOP',
    ts: '2026-10-29T22:30:22.899Z', firmToFirm: false, ...over,
  });

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 12, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
  });
  beforeEach(async () => {
    await reset();
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // The task stand-in: a real row, so the review dedupe runs on the engine.
    taskService.createTask.mockImplementation(async (db, o) => {
      const [r] = await db.query(
        `INSERT INTO tasks (task_from, task_to, task_title, task_desc, task_status, task_source, task_link, task_link_type, task_link_id, task_date, task_last_update)
         VALUES (?, ?, ?, ?, 'Pending', ?, '', ?, ?, NOW(), NOW())`,
        [o.from, o.to, o.title, o.desc, o.source, o.link_type, o.link_id == null ? null : String(o.link_id)]);
      return { task_id: r.insertId };
    });
    calendarService.nextBusinessDay.mockImplementation(async (from) => new Date(new Date(from).getTime() + 86400000));
  });
  afterEach(() => jest.restoreAllMocks());
  // Leave the DB as a later twin expects to find it: no contact_phones / comm_*
  // FK into `contacts` (assistantNormalizer.mysql drops `contacts` and would be
  // refused — found by the forced-order pair runs).
  afterAll(async () => {
    if (!pool) return;
    try {
      await q('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of [...COMM, ...TABLES]) await q(`DROP TABLE IF EXISTS \`${t}\``);
      await q('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      await pool.end();
    }
  });

  test('STOP → opted_out, the active row\'s cache flag 1, attributed; the stranded client gets ONE task', async () => {
    const r = await inbound();
    expect(r).toMatchObject({ kind: 'opt_out', recorded: true, state: 'opted_out' });
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ destination: PAT, scope: 'all', action: 'opt_out', source: 'sms_keyword', provider_event_id: 'ringcentral:m-1', contact_id: 1, line_number: LINE_RC });
    expect(new Date(ev[0].occurred_at).toISOString()).toBe('2026-10-29T22:30:22.899Z');
    expect((await stateOf(PAT)).state).toBe('opted_out');
    expect(await flag(11)).toBe(1);
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(taskService.createTask.mock.calls[0][1]).toMatchObject({ to: 22, source: 'consent', link_type: 'contact', link_id: 1 });
  });

  test('the assignee must be an ACTIVE user on the engine: a disabled one → no task, the warning, the event still recorded', async () => {
    await q("UPDATE app_settings SET `value` = '23' WHERE `key` = 'consent_task_user_id'");
    const r = await inbound();
    expect(r).toMatchObject({ recorded: true, state: 'opted_out', task_id: null });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(alerting.alert.mock.calls.map((c) => c[1].kind)).toEqual(['consent_task_unassigned']);
    expect(await events()).toHaveLength(1);
  });

  test('START while opted out → opted_in, flag 0; START while not opted out → no event', async () => {
    expect(await inbound({ body: 'START', providerRef: 'm-0' })).toMatchObject({ kind: 'opt_in', recorded: false });
    expect(await events()).toHaveLength(0);
    await inbound();
    expect(await inbound({ body: 'start', providerRef: 'm-2', ts: '2026-10-29T23:00:00Z' })).toMatchObject({ kind: 'opt_in', recorded: true, state: 'opted_in' });
    expect((await stateOf(PAT)).state).toBe('opted_in');
    expect(await flag(11)).toBe(0);
  });

  test('a redelivered STOP (same provider id) → duplicate, no second event', async () => {
    await inbound();
    expect(await inbound()).toMatchObject({ kind: 'opt_out', recorded: false });
    expect(await events()).toHaveLength(1);
  });

  test('a STOP OLDER than an existing START: recorded, the state stays opted_in (the guard)', async () => {
    await inbound({ providerRef: 'a', ts: '2026-10-29T10:00:00Z' });
    await inbound({ body: 'START', providerRef: 'b', ts: '2026-10-29T12:00:00Z' });
    const r = await inbound({ providerRef: 'c', ts: '2026-10-29T11:00:00Z' });
    expect(r).toMatchObject({ recorded: true, state: 'opted_in' });
    expect(await events()).toHaveLength(3);
    expect((await stateOf(PAT)).state).toBe('opted_in');
    expect(await flag(11)).toBe(0);
  });

  test('the open-client predicate on the engine: no task for a closed case, an Other relation, no row, or a re-sighting', async () => {
    await inbound({ from10: SAM, providerRef: 's' });
    await inbound({ from10: ANN, providerRef: 'a' });
    await inbound({ from10: GHOST, providerRef: 'g' });
    expect(taskService.createTask).not.toHaveBeenCalled();
    await inbound({ providerRef: 'p1' });
    await svc.recordProviderOptOut(pool, { destination: PAT, providerEventId: 'ringcentral:out-1', lineNumber: LINE_RC });
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect((await events()).map((e) => e.source)).toEqual(['sms_keyword', 'sms_keyword', 'sms_keyword', 'sms_keyword', 'provider_optout']);
    // the ledger lookup: the same verdict again is a duplicate before any lock
    expect(await svc.recordProviderOptOut(pool, { destination: PAT, providerEventId: 'ringcentral:out-1' })).toEqual({ recorded: false, duplicate: true });
  });

  test('Quo OPT OUT → exactly one confirmation job; the redelivery → still one; STOP on Quo → none', async () => {
    const r = await inbound({ provider: 'quo', line: LINE_QUO, body: 'OPT OUT', providerRef: 'ACx' });
    expect(r.job_id).toBeTruthy();
    await inbound({ provider: 'quo', line: LINE_QUO, body: 'OPT OUT', providerRef: 'ACx' });
    await inbound({ provider: 'quo', line: LINE_QUO, body: 'STOP', from10: SAM, providerRef: 'ACy' });
    const jobs = await q('SELECT type, status, max_attempts, backoff_seconds, idempotency_key, data, scheduled_time <= NOW() AS due FROM scheduled_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'one_time', status: 'pending', max_attempts: 1, backoff_seconds: 0, idempotency_key: 'consent_confirm:quo:ACx', due: 1 });
    const data = typeof jobs[0].data === 'string' ? JSON.parse(jobs[0].data) : jobs[0].data;
    expect(data).toEqual({ type: 'consent_sms_confirm', line: LINE_QUO, to: PAT, provider_message_id: 'ACx' });
  });

  test('review: one open task per number on the engine (task_dedupe_key + open statuses)', async () => {
    const a = await inbound({ body: 'please stop texting me', providerRef: 'r1' });
    const b = await inbound({ body: 'wrong number', providerRef: 'r2' });
    expect(a.task_id).toBeTruthy();
    expect(b.task_id).toBe(a.task_id);
    expect(await q('SELECT COUNT(*) AS n FROM tasks WHERE task_dedupe_key = ?', [`consent_review:${PAT}`])).toEqual([{ n: 1 }]);
    await q("UPDATE tasks SET task_status = 'Completed' WHERE task_id = ?", [a.task_id]);
    const c = await inbound({ body: 'leave me alone', providerRef: 'r3' });
    expect(c.task_id).not.toBe(a.task_id);
    expect(await events()).toHaveLength(0);
  });

  test('concurrent first-time opt-outs (rows and row-less numbers) all land — no deadlock escapes', async () => {
    const withRows = Array.from({ length: 6 }, (_, i) => `31355510${String(i).padStart(2, '0')}`);
    const rowless = Array.from({ length: 6 }, (_, i) => `31355520${String(i).padStart(2, '0')}`);
    await q(`INSERT INTO contacts (contact_id, contact_name) VALUES ${withRows.map((_, i) => `(${100 + i}, 'C${i}')`).join(', ')}`);
    await q(`INSERT INTO contact_phones (contact_id, phone) VALUES ${withRows.map((n, i) => `(${100 + i}, '${n}')`).join(', ')}`);
    const all = [...withRows, ...rowless];
    const results = await Promise.all(all.map((n, i) => inbound({ from10: n, providerRef: `cc-${i}`, body: i % 2 ? 'stop' : 'QUIT' })));
    expect(results.every((r) => r.recorded && r.state === 'opted_out')).toBe(true);
    expect(await q("SELECT COUNT(*) AS n FROM comm_consent_state WHERE channel = 'sms' AND scope = 'all' AND state = 'opted_out'")).toEqual([{ n: all.length }]);
    expect(await q('SELECT COUNT(*) AS n FROM contact_phones WHERE sms_optout = 1')).toEqual([{ n: withRows.length }]);
  });

  test('inbound liveness on the engine: per provider with an ACTIVE line, the newest inbound SMS against the threshold', async () => {
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, credential_id) VALUES
      (1, '${LINE_RC}', 'ringcentral', 1, 9), (2, '${LINE_QUO}', 'quo', 1, 10), (3, '4404674208', 'quo', 0, 10)`);
    await q(`INSERT INTO phone_event_log (provider, provider_ref, event_type, direction, from_number, to_number, processed_at) VALUES
      ('ringcentral', 'r-new', 'sms', 'incoming', '${PAT}', '${LINE_RC}', NOW() - INTERVAL 2 HOUR),
      ('ringcentral', 'r-out', 'sms', 'outgoing', '${LINE_RC}', '${PAT}', NOW()),
      ('quo', 'q-old', 'sms', 'incoming', '${PAT}', '${LINE_QUO}', NOW() - INTERVAL 80 HOUR),
      ('quo', 'q-call', 'call', 'incoming', '${PAT}', '${LINE_QUO}', NOW())`);
    const alerting = require('../lib/alerting');
    const out = await svc.inboundLivenessCheck(pool);
    // phone_lines.provider is an ENUM: ORDER BY sorts by its index (ringcentral, quo), not alphabetically.
    expect(out.map((r) => [r.provider, r.silent_hours, r.alerted])).toEqual([['ringcentral', 2, null], ['quo', 80, 'warning']]);
    expect(alerting.alert).toHaveBeenCalledTimes(1);
    // the alert lib is mocked, so write yesterday's row by hand: the next run escalates to error
    await q("INSERT INTO system_alerts (source, kind, group_key, severity, title, created_at) VALUES ('app', 'sms_inbound_silent', 'sms_inbound_liveness:quo', 'warning', 't', UTC_TIMESTAMP() - INTERVAL 20 HOUR)");
    alerting.alert.mockClear();
    expect((await svc.inboundLivenessCheck(pool))[1].alerted).toBe('error');
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('sms_inbound_liveness_hours', '96')");
    alerting.alert.mockClear();
    await svc.inboundLivenessCheck(pool);
    expect(alerting.alert).not.toHaveBeenCalled();
  });

  test('a START racing the STOP it answers (same number, both in flight): the newer decision wins', async () => {
    const [stop, start] = await Promise.all([
      inbound({ providerRef: 'x1', ts: '2026-10-29T10:00:00Z' }),
      new Promise((res) => setTimeout(res, 5)).then(() => inbound({ body: 'START', providerRef: 'x2', ts: '2026-10-29T10:00:05Z' })),
    ]);
    expect(stop.recorded).toBe(true);
    // The START either saw the committed STOP (recorded, opted_in) or ran first (nothing to undo) —
    // never an opted_out state with a later START recorded.
    const st = (await stateOf(PAT)).state;
    if (start.recorded) expect(st).toBe('opted_in'); else expect(st).toBe('opted_out');
  });
});
