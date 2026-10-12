/**
 * Tests for the stuck-enrollment (sequence wedge) scanner in lib/alerting.js.
 *
 * BACKGROUND. A sequence enrollment is driven by one scheduled_jobs row at a
 * time. If scheduling the next step throws after the current step ran, the
 * enrollment stays 'active' with no job: nothing sends again and no row says
 * 'failed' (May 2026, enrollment 61 — found by accident a day later). The
 * repair is the operator's "Recover stuck enrollment" button, and since
 * 2026-10 recovery SKIPS appointment reminders whose send time passed while
 * the enrollment sat wedged. So what a client misses is set by how fast
 * someone finds out. Before this scan that was "when somebody happens to open
 * the enrollment".
 *
 * WHAT IS LOAD-BEARING HERE
 *
 *   1. The predicate. 'active' AND no pending/running sequence_step job AND
 *      idle past the threshold, where the idle clock includes the JOBS'
 *      updated_at — the enrollment row alone is not a clock (executeStep
 *      never touches it). Asserted against the SQL text, because a stub
 *      cannot prove a predicate it never runs; the statement itself was run
 *      read-only against production when it was written (0 rows, and the
 *      idle clock checked against known enrollments).
 *
 *   2. Severity must stay 'error'. Phase B only sends when a group meets
 *      alert_email_min_severity; a 'warning' wedge would sit unread until an
 *      unrelated error carried it out — the same silence, one layer up.
 *
 *   3. One open row per enrollment, never a duplicate while it stays wedged.
 *
 *   4. It closes on the WEDGE CONDITION ALONE — never on the idle clock. A
 *      Recover that fails after the engine's current_step UPDATE, or a
 *      migrate_in_flight publish, bumps the clock on an enrollment that is
 *      still wedged; closing on the open query's result set resolved the
 *      alert right then and re-opened it 15 minutes later, with the second
 *      email held back by the per-group cooldown. 'stays open while still
 *      wedged, whatever the idle clock says' is the test that pins this.
 *
 *   5. Closing clears the group's cooldown, so a RE-wedge after a successful
 *      Recover is emailed at once instead of waiting out 6 hours.
 *
 *   6. A broken scan must not kill the sweep, and one failed insert must not
 *      stop the rest — same contract as every other source.
 *
 *   npx jest tests/alertingStuckEnrollments.test.js
 */

const fs = require('fs');
const path = require('path');
const alerting = require('../lib/alerting');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'alerting.js'), 'utf8');

// ─────────────────────────────────────────────────────────────
// A db matched by SQL shape (the alertingStartLatency idiom). Anything
// unmatched returns [[]], which leaves every other scanner and the Phase B
// digest inert — this file is only about stuck enrollments.
// ─────────────────────────────────────────────────────────────
/**
 * @param stuck          rows the OPEN query returns (wedged AND idle > 15 min)
 * @param openGroups     group_keys of this scanner's open alert rows
 * @param stillWedgedIds enrollment ids the CLOSE query reports as still wedged
 *                       (default: whatever `stuck` holds — the common case
 *                       where idle and wedged agree)
 * @param stuckExecs / openExecGroups  feed the stuck-EXECUTION scanner that
 *                       runs just before this one, to prove the two add up
 * @param failInsertFor  group_key whose system_alerts INSERT throws
 */
function makeDb({ stuck = [], openGroups = [], stillWedgedIds = null, failScan = false,
                  stuckExecs = [], openExecGroups = [], failInsertFor = null } = {}) {
  const inserts = [];
  const updates = [];
  const alertStateUpserts = [];
  const cooldownResets = [];
  let scanSql = null, closeSql = null, lookupSql = null;

  const db = {
    inserts, updates, alertStateUpserts, cooldownResets,
    scanSql: () => scanSql,
    closeSql: () => closeSql,
    lookupSql: () => lookupSql,
    stuckInserts: () => inserts.filter(i => i.kind === 'enrollment_stuck'),
    stuckUpdates: () => updates.filter(u => /'enrollment_stuck'/.test(u.sql)),

    query: jest.fn(async (sql, params = []) => {
      // ── CLOSE query: which open enrollments are STILL wedged ────────
      //    (checked first — it also selects FROM sequence_enrollments e
      //    with a NOT EXISTS, but is the only one with e.id IN (?))
      if (/FROM sequence_enrollments e/i.test(sql) && /e\.id IN \(\?\)/.test(sql)) {
        closeSql = sql;
        const still = stillWedgedIds ?? stuck.map(e => e.id);
        return [params[0].filter(id => still.includes(id)).map(id => ({ id }))];
      }

      // ── OPEN query: wedged and idle past the threshold ──────────────
      if (/FROM sequence_enrollments e/i.test(sql) && /NOT EXISTS/i.test(sql)) {
        scanSql = sql;
        if (failScan) throw new Error('derived table blew up');
        return [stuck];
      }

      // ── the neighbouring stuck-EXECUTION scanner ────────────────────
      if (/FROM workflow_executions e/i.test(sql) && /NOT EXISTS/i.test(sql)) {
        return [stuckExecs];
      }
      if (/SELECT id, group_key FROM system_alerts/i.test(sql) && /'execution_stuck'/.test(sql)) {
        return [openExecGroups.map((g, i) => ({ id: 800 + i, group_key: g }))];
      }

      // ── open-alert lookup for this scanner ──────────────────────────
      if (/SELECT id, group_key FROM system_alerts/i.test(sql) && /'enrollment_stuck'/.test(sql)) {
        lookupSql = sql;
        return [openGroups.map((g, i) => ({ id: 900 + i, group_key: g }))];
      }

      // ── writes ──────────────────────────────────────────────────────
      if (/INSERT (IGNORE )?INTO system_alerts/i.test(sql)) {
        const kind = /'enrollment_stuck'/.test(sql) ? 'enrollment_stuck' : (params[1] || 'other');
        if (failInsertFor && params[0] === failInsertFor) throw new Error('insert blew up');
        inserts.push({ sql, params, kind });
        return [{ affectedRows: 1, insertId: 1 }];
      }
      if (/UPDATE system_alerts SET resolved_at/i.test(sql)) {
        updates.push({ sql, params });
        return [{ affectedRows: Array.isArray(params[0]) ? params[0].length : 0 }];
      }
      if (/UPDATE alert_state SET last_alerted_at = NULL/i.test(sql)) {
        cooldownResets.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO alert_state/i.test(sql)) {
        alertStateUpserts.push({ sql, params });
        return [{ affectedRows: 1 }];
      }

      // ── settings: watermarks pre-seeded so init writes nothing ──────
      if (/FROM app_settings/i.test(sql)) {
        if (params[0] === 'error_sweep_state') {
          return [[{ value: JSON.stringify({
            wf_step_id: 0, job_result_id: 0, seq_log_id: 0, hook_exec_id: 0,
            email_ingest_id: 0, phone_ingest_id: 0, campaign_sent_at: '2026-01-01 00:00:00',
          }) }]];
        }
        return [[]]; // no recipients ⇒ Phase B cannot send
      }

      return [[]];
    }),
  };
  return db;
}

/** A wedged enrollment row as the scan returns it. */
const wedged = (id, over = {}) => ({
  id, template_id: 19, template_name: 'pre_appt — 341 Meeting', contact_id: 2001, appt_id: 3996,
  current_step: 5, total_steps: 7,
  idle_since: new Date('2026-10-11T22:00:34.000Z'),
  last_logged: '5 (sent)',
  ...over,
});

const sweep = (db, params = {}) => alerting.runErrorSweep(db, params);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('the predicate (SQL text — the stub cannot run it)', () => {
  test('active, no pending/running sequence_step job, idle past the threshold on a clock that includes the jobs', async () => {
    const db = makeDb();
    await sweep(db);
    const sql = db.scanSql().replace(/\s+/g, ' ');

    expect(sql).toMatch(/WHERE e\.status = 'active'/);
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM scheduled_jobs j WHERE j\.sequence_enrollment_id = e\.id AND j\.type = 'sequence_step' AND j\.status IN \('pending','running'\)\)/);
    // The idle clock: newest of the enrollment row and its jobs.
    expect(sql).toMatch(/GREATEST\( COALESCE\(e\.updated_at, e\.enrolled_at\), COALESCE\(\(SELECT MAX\(j2\.updated_at\) FROM scheduled_jobs j2 WHERE j2\.sequence_enrollment_id = e\.id AND j2\.type = 'sequence_step'\), e\.updated_at, e\.enrolled_at\) \) AS idle_since/);
    // 15 minutes; a clockless row is reported, not dropped.
    expect(sql).toMatch(/WHERE \(s\.idle_since IS NULL OR s\.idle_since < NOW\(\) - INTERVAL 15 MINUTE\)/);
  });

  test('the threshold constant is what the SQL interpolates', () => {
    expect(SRC).toMatch(/const STUCK_ENROLLMENT_MINUTES = 15;/);
    expect(SRC).toMatch(/INTERVAL \$\{STUCK_ENROLLMENT_MINUTES\} MINUTE/);
  });

  test('deterministic batch, newest log row for the message, and a template that may be gone', async () => {
    const db = makeDb();
    await sweep(db);
    const sql = db.scanSql().replace(/\s+/g, ' ');

    expect(sql).toMatch(/ORDER BY s\.id LIMIT 200$/);
    expect(sql).toMatch(/FROM sequence_step_log l WHERE l\.enrollment_id = e\.id ORDER BY l\.id DESC LIMIT 1\) AS last_logged/);
    expect(sql).toMatch(/LEFT JOIN sequence_templates t ON t\.id = e\.template_id/);
  });

  test('the open-row lookup only sees UNRESOLVED rows — or an enrollment that wedged once could never alert again', async () => {
    const db = makeDb();
    await sweep(db);
    expect(db.lookupSql().replace(/\s+/g, ' '))
      .toMatch(/WHERE source = 'sequence' AND kind = 'enrollment_stuck' AND resolved_at IS NULL$/);
  });

  test('the CLOSE query is the wedge condition with NO idle clause', async () => {
    const db = makeDb({ openGroups: ['seq_enr_stuck:197'] });
    await sweep(db);
    const sql = db.closeSql().replace(/\s+/g, ' ');

    expect(sql).toMatch(/WHERE e\.id IN \(\?\) AND e\.status = 'active' AND NOT EXISTS \( SELECT 1 FROM scheduled_jobs j WHERE j\.sequence_enrollment_id = e\.id AND j\.type = 'sequence_step' AND j\.status IN \('pending','running'\)\)$/);
    expect(sql).not.toMatch(/idle_since|INTERVAL|updated_at/);
    // Asked about exactly the enrollments that have an open row.
    const call = db.query.mock.calls.find(([q]) => /e\.id IN \(\?\)/.test(q));
    expect(call[1]).toEqual([[197]]);
  });
});

describe('opening', () => {
  test('opens one error row per wedged enrollment, pointing the operator at Recover', async () => {
    const db = makeDb({ stuck: [wedged(197), wedged(201, { contact_id: 2050, last_logged: null, current_step: 1 })] });
    const out = await sweep(db);

    expect(out.scanned.stuck_enrollments).toBe(2);
    expect(out.opened).toBe(2);

    const rows = db.stuckInserts();
    expect(rows).toHaveLength(2);

    // Positional: source, kind and severity are literals in the statement.
    expect(rows[0].sql).toMatch(/VALUES \('sequence', 'enrollment_stuck', \?, 'error', \?, \?, \?, 'sequence_enrollments', \?, NULL\)/);

    const [groupKey, title, message, context, refId] = rows[0].params;
    expect(groupKey).toBe('seq_enr_stuck:197');
    expect(refId).toBe(197);
    expect(title).toBe('Sequence 19 (pre_appt — 341 Meeting) enrollment 197 stuck — active with no pending step');
    expect(message).toMatch(/No pending or running step since 2026-10-11 22:00:34 UTC\./);
    expect(message).toMatch(/Last logged step: 5 \(sent\); step pointer 5\/7\./);
    expect(message).toMatch(/contact #2001 → Automations/);
    expect(message).toMatch(/"Recover stuck enrollment"/);
    expect(JSON.parse(context)).toEqual({
      enrollment_id: 197, template_id: 19, contact_id: 2001, appt_id: 3996, current_step: 5, total_steps: 7,
    });

    // Enrollment-time wedge: nothing logged yet.
    expect(rows[1].params[2]).toMatch(/Last logged step: none; step pointer 1\/7\./);

    // Occurrence bookkeeping, one per opened group.
    expect(db.alertStateUpserts.map(u => u.params[0])).toEqual(['seq_enr_stuck:197', 'seq_enr_stuck:201']);
  });

  test('severity is error — a warning would never trigger a digest by itself', async () => {
    const db = makeDb({ stuck: [wedged(197)] });
    await sweep(db);
    const [row] = db.stuckInserts();
    expect(row.sql).toMatch(/'enrollment_stuck', \?, 'error'/);
    expect(row.sql).not.toMatch(/'warning'/);
  });

  test('does not re-open an enrollment that already has an open row', async () => {
    const db = makeDb({ stuck: [wedged(197), wedged(201)], openGroups: ['seq_enr_stuck:197'] });
    const out = await sweep(db);

    expect(out.opened).toBe(1);
    expect(db.stuckInserts().map(r => r.params[0])).toEqual(['seq_enr_stuck:201']);
    expect(db.stuckUpdates()).toHaveLength(0);   // 197 is still wedged — stays open
  });

  test('one failed insert does not stop the rest', async () => {
    const db = makeDb({ stuck: [wedged(197), wedged(201)], failInsertFor: 'seq_enr_stuck:197' });
    const out = await sweep(db);

    expect(out.opened).toBe(1);
    expect(db.stuckInserts().map(r => r.params[0])).toEqual(['seq_enr_stuck:201']);
    expect(db.alertStateUpserts.map(u => u.params[0])).toEqual(['seq_enr_stuck:201']);
  });

  test('its counts ADD to the stuck-execution scan\'s, they do not replace them', async () => {
    const db = makeDb({
      stuck: [wedged(201)],
      openGroups: ['seq_enr_stuck:197'], stillWedgedIds: [201],        // 197 recovered → 1 close
      stuckExecs: [{ id: 5, workflow_id: 27, status: 'active', current_step_number: 3,
                     steps_executed_count: 2, updated_at: new Date('2026-10-11T20:00:00Z'), workflow_name: 'wf' }],
      openExecGroups: ['wf_exec_stuck:9'],                              // exec 9 moved on → 1 close
    });
    const out = await sweep(db);

    expect(out.scanned).toMatchObject({ stuck_executions: 1, stuck_enrollments: 1 });
    expect(out.opened).toBe(2);
    expect(out.closed).toBe(2);
  });

  test('nothing wedged, nothing open → no writes', async () => {
    const db = makeDb();
    const out = await sweep(db);

    expect(out.scanned.stuck_enrollments).toBe(0);
    expect(out.opened).toBe(0);
    expect(out.closed).toBe(0);
    expect(db.stuckInserts()).toHaveLength(0);
    expect(db.stuckUpdates()).toHaveLength(0);
  });
});

describe('closing', () => {
  test('resolves the open row once the enrollment is no longer wedged, and clears that group\'s cooldown', async () => {
    // 197: recovered (has a pending job again) / cancelled / completed.
    const db = makeDb({ stuck: [wedged(201)], openGroups: ['seq_enr_stuck:197', 'seq_enr_stuck:201'] });
    const out = await sweep(db);

    expect(out.opened).toBe(0);
    expect(out.closed).toBe(1);
    const [upd] = db.stuckUpdates();
    expect(upd.sql).toMatch(/source = 'sequence' AND kind = 'enrollment_stuck' AND resolved_at IS NULL/);
    expect(upd.params).toEqual([['seq_enr_stuck:197']]);
    // A re-wedge of 197 must not sit out a 6h cooldown.
    expect(db.cooldownResets).toHaveLength(1);
    expect(db.cooldownResets[0].params).toEqual([['seq_enr_stuck:197']]);
  });

  test('stays open while still wedged, whatever the idle clock says (failed Recover / in-flight publish bumped it)', async () => {
    // 197 is NOT in the open query's result — its clock was bumped a minute
    // ago — but it is still active with no live job.
    const db = makeDb({ stuck: [], openGroups: ['seq_enr_stuck:197'], stillWedgedIds: [197] });
    const out = await sweep(db);

    expect(out.scanned.stuck_enrollments).toBe(0);
    expect(out.closed).toBe(0);
    expect(out.opened).toBe(0);
    expect(db.stuckUpdates()).toHaveLength(0);     // not resolved…
    expect(db.stuckInserts()).toHaveLength(0);     // …and not duplicated
    expect(db.cooldownResets).toHaveLength(0);
  });

  test('nothing open → the close query is not even issued', async () => {
    const db = makeDb({ stuck: [wedged(197)] });
    await sweep(db);
    expect(db.closeSql()).toBeNull();
  });
});

describe('dry run and failure', () => {
  test('dry run counts what it would do and writes nothing', async () => {
    const db = makeDb({ stuck: [wedged(201)], openGroups: ['seq_enr_stuck:197'] });
    const out = await sweep(db, { dry_run: true });

    expect(out.scanned.stuck_enrollments).toBe(1);
    expect(out.opened).toBe(1);
    expect(out.closed).toBe(1);
    expect(db.stuckInserts()).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
    expect(db.alertStateUpserts).toHaveLength(0);
    expect(db.cooldownResets).toHaveLength(0);
  });

  test('a broken scan raises a date-bucketed scan_error and the rest of the sweep still runs', async () => {
    const db = makeDb({ failScan: true });
    const out = await sweep(db);

    expect(out.scanned.stuck_enrollments).toBeNull();
    // Scanners after this one still ran…
    expect(out.scanned).toHaveProperty('start_latency');
    // …and the ones before it were not disturbed.
    expect(out.scanned).toHaveProperty('stuck_executions', 0);

    const err = db.inserts.find(i => i.kind === 'scan_error');
    expect(err).toBeDefined();
    expect(err.params).toEqual(expect.arrayContaining([
      'sweep', 'scan_error', 'sweep:stuck_enrollments', 'error',
      "Error sweep: 'stuck_enrollments' scan failed", 'derived table blew up',
    ]));
    expect(err.params.find(p => typeof p === 'string' && p.startsWith('sweep:scan_error:stuck_enrollments:')))
      .toMatch(/^sweep:scan_error:stuck_enrollments:\d{4}-\d{2}-\d{2}$/);
  });
});
