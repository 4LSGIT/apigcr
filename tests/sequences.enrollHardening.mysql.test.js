// tests/sequences.enrollHardening.mysql.test.js
//
/**
 * A18.4a on REAL MySQL: the enrollment duplicate fence (GET_LOCK on one
 * pinned session around the duplicate check + INSERT) and the
 * scheduling-wedge fix, driven through the real engine funnel
 * (lib/sequenceEngine enrollContactByTemplateId → _enrollWithTemplate →
 * scheduleFromStep → scheduleStepJob) and the real lib/alerting.alert.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a184_test npx jest tests/sequences.enrollHardening.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql (live types,
 * keys, FKs — a clause referencing a table outside the list, i.e.
 * sequence_enrollments → contacts, is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off. Its afterAll drops sequence_step_log (FK →
 * sequence_enrollments), which sequences.expectedBase.mysql does not build,
 * so that sibling's FK-checked DROP of sequence_enrollments still works (it
 * now drops sequence_step_log first itself, too — optout.mysql leaves one).
 *
 * WHY A REAL ENGINE: the fence is a property of MySQL sessions — GET_LOCK is
 * session-scoped, an autocommitted INSERT is visible to the next session's
 * SELECT, and `appt_id <=> ?` matches NULL to NULL. A scripted pool can show
 * which connection ran a statement (tests/sequences.enrollHardening.test.js
 * does); only a real server can show that two concurrent enrollments for one
 * identity produce ONE row.
 *
 * WHAT IS LOCKED
 *   - Eight concurrent enrollments for one (contact, template, appt) produce
 *     exactly one active row and one scheduled job; the other seven are
 *     ALREADY_ENROLLED naming that row. (Without the lock the same burst
 *     inserts duplicates — the mutation this suite was checked against.)
 *   - Different appts for the same contact + template do not block each other.
 *   - A lock held by another session for longer than the wait is ENROLL_BUSY
 *     and inserts nothing; once released, the same enrollment goes through.
 *   - A first step whose absolute delay.at resolves empty leaves a CANCELLED
 *     row ('scheduling failed: …'), no job, an enrollment_schedule_failed
 *     alert — and does not block the next attempt (it is not ALREADY_ENROLLED).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueJobDispatch: jest.fn(async () => true),
}));

const seq = require('../lib/sequenceEngine');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['sequence_templates', 'sequence_template_versions', 'sequence_steps', 'sequence_enrollments',
  'sequence_step_log', 'scheduled_jobs', 'system_alerts', 'alert_state'];

// Line-based extraction (column COMMENTs may hold ';'). Constraint clauses
// that reference a table outside TABLES are dropped (contacts).
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

d('enrollment duplicate fence + scheduling-wedge fix on real MySQL (A18.4a)', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  async function seedTemplate(id, timing) {
    await q('INSERT INTO sequence_templates (id, name, type, active, current_version, draft_version) VALUES (?, ?, NULL, 1, 1, NULL)', [id, `t${id}`]);
    await q('INSERT INTO sequence_template_versions (template_id, version, name, published_at) VALUES (?, 1, ?, NOW())', [id, `t${id}`]);
    await q(`INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing)
             VALUES (?, 1, 1, 'task', ?, ?)`,
    [id, JSON.stringify({ function_name: 'create_task', params: { title: 'Call' } }), JSON.stringify(timing)]);
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const { creates, alters } = schemaFor(TABLES);
    for (const sql of creates) await q(sql);
    for (const sql of alters) await q(sql);
    await seedTemplate(1, { type: 'delay', value: 1, unit: 'days' });
    await seedTemplate(2, { type: 'delay', at: '{{trigger_data.hearing_at}}' });
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (pool) {
      await q('DROP TABLE IF EXISTS `sequence_step_log`');
      await pool.end();
    }
  });

  test('eight concurrent enrollments for one identity insert ONE row; the rest are ALREADY_ENROLLED', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 },
      () => seq.enrollContactByTemplateId(pool, 1983, 1, { appt_id: 77 })));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((r) => r.reason.code)).toEqual(Array(7).fill('ALREADY_ENROLLED'));
    const id = won[0].value.enrollmentId;
    expect(new Set(lost.map((r) => r.reason.enrollment_id))).toEqual(new Set([id]));
    const rows = await q("SELECT id, status, appt_id FROM sequence_enrollments WHERE contact_id = 1983 AND template_id = 1 AND appt_id = 77");
    expect(rows).toEqual([{ id, status: 'active', appt_id: 77 }]);
    const jobs = await q('SELECT idempotency_key, status FROM scheduled_jobs WHERE sequence_enrollment_id = ?', [id]);
    expect(jobs).toEqual([{ idempotency_key: `seq-${id}-step-1`, status: 'pending' }]);
    // Every pinned connection gave its lock back.
    expect((await q("SELECT IS_USED_LOCK('seq_enroll_1_1983_77_0') AS holder"))[0].holder).toBeNull();
  });

  test('a contact-scoped burst (no appt / signing request) is fenced the same way — NULL <=> NULL', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 },
      () => seq.enrollContactByTemplateId(pool, 2001, 1, {})));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await q('SELECT COUNT(*) AS n FROM sequence_enrollments WHERE contact_id = 2001 AND template_id = 1'))[0].n).toBe(1);
  });

  test('different appts for the same contact + template do not block each other', async () => {
    const results = await Promise.allSettled([78, 79, 80].map((appt) =>
      seq.enrollContactByTemplateId(pool, 1983, 1, { appt_id: appt })));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect((await q('SELECT appt_id FROM sequence_enrollments WHERE contact_id = 1983 AND template_id = 1 AND appt_id IN (78,79,80) ORDER BY appt_id')).map((r) => r.appt_id))
      .toEqual([78, 79, 80]);
  });

  test('a lock held past the wait is ENROLL_BUSY and inserts nothing; released, the same enrollment goes through', async () => {
    const holder = await mysql.createConnection({ uri: URL_ });
    try {
      const [[got]] = await holder.query("SELECT GET_LOCK('seq_enroll_1_3003_0_0', 0) AS got");
      expect(got.got).toBe(1);
      const err = await seq.enrollContactByTemplateId(pool, 3003, 1, {}).catch((e) => e);
      expect(err.code).toBe('ENROLL_BUSY');
      expect((await q('SELECT COUNT(*) AS n FROM sequence_enrollments WHERE contact_id = 3003'))[0].n).toBe(0);
      await holder.query("SELECT RELEASE_LOCK('seq_enroll_1_3003_0_0')");
    } finally {
      await holder.end();
    }
    const ok = await seq.enrollContactByTemplateId(pool, 3003, 1, {});
    expect((await q('SELECT id, status FROM sequence_enrollments WHERE contact_id = 3003'))).toEqual([{ id: ok.enrollmentId, status: 'active' }]);
  }, 20000);

  test('an unschedulable first step leaves a CANCELLED row, no job, an alert — and does not block the next attempt', async () => {
    const err = await seq.enrollContactByTemplateId(pool, 4004, 2, { case_id: 'ABC' }).catch((e) => e);
    expect(err.code).toBe('SCHEDULING_FAILED');
    expect(err.cancelled).toBe(true);
    const id = err.enrollment_id;
    const [row] = await q('SELECT status, cancel_reason FROM sequence_enrollments WHERE id = ?', [id]);
    expect(row.status).toBe('cancelled');
    expect(row.cancel_reason.startsWith('scheduling failed: delay.at resolved to empty')).toBe(true);
    expect([...row.cancel_reason].length).toBeLessThanOrEqual(200);
    expect(await q('SELECT id FROM scheduled_jobs WHERE sequence_enrollment_id = ?', [id])).toEqual([]);
    const alerts = await q("SELECT severity, group_key, ref_table, ref_id FROM system_alerts WHERE kind = 'enrollment_schedule_failed'");
    expect(alerts).toEqual([{ severity: 'error', group_key: 'seq_enroll_sched:2', ref_table: 'sequence_enrollments', ref_id: id }]);

    // Not a wedge: the dup guard does not see the cancelled row.
    const again = await seq.enrollContactByTemplateId(pool, 4004, 2, { case_id: 'ABC' }).catch((e) => e);
    expect(again.code).toBe('SCHEDULING_FAILED');
    expect(again.enrollment_id).not.toBe(id);
    expect((await q("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE contact_id = 4004 AND status = 'active'"))[0].n).toBe(0);
  });
});
