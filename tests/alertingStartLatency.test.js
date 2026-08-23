/**
 * Tests for the workflow start-latency scanner in lib/alerting.js.
 *
 * BACKGROUND. On 2026-08-20 a dispatch change added a uniform 0–60s wait
 * before hook-started workflows ran their first step. Start latency went from
 * 0.6% of starts over 20s (n=1586) to 74.6% (n=197). Nobody noticed for ~36
 * hours; it surfaced as a stale Clio 2FA code two layers downstream. This
 * scanner is the check that was missing.
 *
 * WHAT IS LOAD-BEARING HERE
 *
 *   1. The quiet-hour gate must SKIP, not close. Overnight the trailing
 *      window routinely holds fewer than five starts, and a small sample is
 *      not evidence of health. On the real incident day the hourly sample
 *      fell below five SEVEN times while the regression was live — a scanner
 *      that closed on those would have flapped open/shut five times instead
 *      of opening once and staying open. 'closes on recovery' and 'a quiet
 *      hour does not close an open alert' are the pair that pins this down,
 *      and the second is the one that matters.
 *
 *   2. Severity must stay 'error'. Phase B only sends an email when an
 *      eligible group meets alert_email_min_severity (default 'error');
 *      'warning' groups piggyback on someone else's digest but never trigger
 *      one alone. Demoting this to 'warning' would reproduce the original
 *      failure — a real regression sitting unread waiting for an unrelated
 *      error to ride in on. Asserted explicitly so the demotion cannot
 *      happen quietly.
 *
 *   3. An in-flight execution must not be scored. The query filters
 *      executed_at IS NOT NULL on the join, so an execution that has not
 *      started yet leaves the sample entirely rather than counting as a
 *      zero-latency start or as a breach. Asserted against the SQL text,
 *      because a stub cannot prove a join predicate it never runs.
 *
 *   4. A broken scan must not kill the sweep. Every other source has a
 *      try/catch + date-bucketed scan_error alert; this one has to behave
 *      identically or a bad deploy takes out the whole hourly sweep.
 *
 *   npx jest tests/alertingStartLatency.test.js
 */

const alerting = require('../lib/alerting');

// ─────────────────────────────────────────────────────────────────────────────
// A db that is just real enough.
//
// Matched by SQL shape rather than parsed, so a change to the queries in
// alerting.js shows up here as a failure rather than as a silent pass against
// a stub that answers everything. Anything unmatched returns [[]], which makes
// the seven streaming scanners, the oauth scan, the stuck-execution scan and
// the Phase B digest all inert — this file is only about start latency.
// ─────────────────────────────────────────────────────────────────────────────
function makeDb({ perWorkflow = [], open = false, failLatencyQuery = false } = {}) {
  const inserts = [];
  const updates = [];
  const alertStateUpserts = [];

  const db = {
    inserts, updates, alertStateUpserts,

    /** The system_alerts row this scanner wrote, if any. */
    latencyInsert: () => inserts.find(i => i.kind === 'start_latency'),

    query: jest.fn(async (sql, params = []) => {
      // ── the per-workflow latency aggregate ──────────────────────────────
      // Keyed on GREATEST(TIMESTAMPDIFF, which is unique to this scanner.
      if (/GREATEST\(TIMESTAMPDIFF/i.test(sql)) {
        if (failLatencyQuery) throw new Error('derived table blew up');
        return [perWorkflow.map(r => ({
          workflow_id: r.workflow_id,
          workflow_name: r.workflow_name,
          // mysql2 hands back DECIMAL/BIGINT aggregates as strings — mirror
          // that, so a missing Number() coercion fails here rather than in
          // production as '1020' instead of 3.
          n: String(r.n),
          breaches: String(r.breaches),
          avg_s: String(r.avg_s ?? 0),
          max_s: String(r.max_s ?? 0),
        }))];
      }

      // ── open-alert lookup for this group ────────────────────────────────
      if (/SELECT id FROM system_alerts/i.test(sql) && /start_latency/i.test(sql)) {
        return [open ? [{ id: 777 }] : []];
      }

      // ── writes ──────────────────────────────────────────────────────────
      // alert() switches to INSERT IGNORE whenever a dedup_key is supplied,
      // which is exactly the scan_error path — matching only the bare INSERT
      // would silently miss it.
      if (/INSERT (IGNORE )?INTO system_alerts/i.test(sql)) {
        // Positional INSERT (the scanner) vs the fully-parameterised one used
        // by alert(). Both are recorded; kind is read off whichever applies.
        const kind = /'start_latency'/.test(sql) ? 'start_latency' : (params[1] || 'other');
        inserts.push({ sql, params, kind });
        return [{ affectedRows: 1, insertId: 1 }];
      }
      if (/UPDATE system_alerts SET resolved_at/i.test(sql)) {
        updates.push({ sql, params });
        return [{ affectedRows: open ? 1 : 0 }];
      }
      if (/INSERT INTO alert_state/i.test(sql)) {
        alertStateUpserts.push({ sql, params });
        return [{ affectedRows: 1 }];
      }

      // ── settings: watermarks pre-seeded so init writes nothing ──────────
      if (/FROM app_settings/i.test(sql)) {
        const key = params[0];
        if (key === 'error_sweep_state') {
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

/** One workflow, `n` starts of which `breaches` were slow. */
const wf = (n, breaches, id = 19) => ([
  { workflow_id: id, workflow_name: 'wf_rc_message_out', n, breaches, avg_s: 42.5, max_s: 48 },
]);

const sweep = (db) => alerting.runErrorSweep(db, {});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('opening', () => {
  // The real incident hour: 15 starts, 12 over 20s = 80%.
  test('opens above the breach-rate threshold', async () => {
    const db = makeDb({ perWorkflow: wf(15, 12) });
    const out = await sweep(db);

    expect(out.opened).toBe(1);
    expect(out.scanned.start_latency).toBe(15);
    expect(out.start_latency).toMatchObject({ breachRate: 0.8, sampleSize: 15, breaches: 12 });
    expect(db.latencyInsert()).toBeDefined();
  });

  test('does not open below the breach-rate threshold', async () => {
    // 20% — above the sample floor, under the 25% bar.
    const db = makeDb({ perWorkflow: wf(20, 4) });
    const out = await sweep(db);

    expect(out.opened).toBe(0);
    expect(db.latencyInsert()).toBeUndefined();
    expect(out.start_latency).toMatchObject({ breachRate: 0.2, sampleSize: 20 });
  });

  test('does not re-open when a row is already open', async () => {
    const db = makeDb({ perWorkflow: wf(15, 12), open: true });
    const out = await sweep(db);

    expect(out.opened).toBe(0);
    expect(db.latencyInsert()).toBeUndefined();
  });

  test('sums the sample across workflows rather than rating each one', async () => {
    // 10+3+2 starts, 9+3+0 breaches = 12/15. One global alert, not three.
    const db = makeDb({ perWorkflow: [
      { workflow_id: 19, workflow_name: 'wf_rc_message_out', n: 10, breaches: 9, avg_s: 42.5, max_s: 48 },
      { workflow_id: 17, workflow_name: 'wf_rc_message_in',  n: 3,  breaches: 3, avg_s: 44,   max_s: 54 },
      { workflow_id: 20, workflow_name: 'wf_rc_call',        n: 2,  breaches: 0, avg_s: 11,   max_s: 16 },
    ]});
    const out = await sweep(db);

    expect(out.opened).toBe(1);
    expect(out.start_latency).toMatchObject({ sampleSize: 15, breaches: 12, breachRate: 0.8 });
    expect(db.inserts.filter(i => i.kind === 'start_latency')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
describe('the alert row', () => {
  let db, row;
  beforeEach(async () => {
    db = makeDb({ perWorkflow: [
      { workflow_id: 19, workflow_name: 'wf_rc_message_out', n: 10, breaches: 9, avg_s: 42.5, max_s: 48 },
      { workflow_id: 17, workflow_name: 'wf_rc_message_in',  n: 5,  breaches: 3, avg_s: 44,   max_s: 54 },
    ]});
    await sweep(db);
    row = db.latencyInsert();
  });

  // Not cosmetic. This is the line that lands in the digest email, and it is
  // the whole difference between a person acting on it and a person ignoring
  // it. "Latency alert" would be worthless.
  test('the title states the rate, the threshold and the sample size', () => {
    const title = row.params[1];
    expect(title).toMatch(/80% of starts over 20s/);
    expect(title).toMatch(/\(n=15\)/);
  });

  // Guards the design decision, not the code path — see header note 2.
  test("severity is 'error', so it can trigger a digest on its own", () => {
    expect(row.sql).toMatch(/'error'/);
    expect(row.sql).not.toMatch(/'warning'/);
  });

  test('the per-workflow breakdown rides in context, not in separate rows', () => {
    const ctx = JSON.parse(row.params[3]);
    expect(ctx.by_workflow).toHaveLength(2);
    expect(ctx.by_workflow[0]).toMatchObject({ workflow_id: 19, n: 10, breaches: 9 });
    expect(ctx).toMatchObject({ sample_size: 15, breaches: 12, breach_rate: 0.8,
      window_minutes: 60, breach_threshold_s: 20 });
    expect(typeof ctx.window_start).toBe('string');
    expect(typeof ctx.window_end).toBe('string');
  });

  // varchar(500) on a non-strict sql_mode truncates silently; the digest
  // renderer clips to 400 again on top of that.
  test('title and message stay inside the column limits', () => {
    expect(row.params[1].length).toBeLessThanOrEqual(500);
    expect(row.params[2].length).toBeLessThanOrEqual(500);
  });

  // There is no single row this alert points at — it is a rate over a window.
  // The digest builder reads `${r.ref_table || '?'}#${r.ref_id ?? '?'}`, which
  // tolerates both being NULL; this asserts the scanner really does send NULL
  // rather than inventing a reference.
  test('ref_table and ref_id are NULL', () => {
    expect(row.sql).toMatch(/NULL,\s*NULL,\s*NULL\)/);
  });

  test('opening upserts alert_state for the group', () => {
    expect(db.alertStateUpserts.some(u => u.params[0] === 'wf_start_latency:global')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('closing', () => {
  test('closes when the rate recovers', async () => {
    const db = makeDb({ perWorkflow: wf(20, 1), open: true }); // 5%
    const out = await sweep(db);

    expect(out.closed).toBe(1);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].params).toEqual(['wf_start_latency:global']);
  });

  test('does not try to close when nothing is open', async () => {
    const db = makeDb({ perWorkflow: wf(20, 1), open: false });
    const out = await sweep(db);

    expect(out.closed).toBe(0);
    expect(db.updates).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
describe('the sample-size gate', () => {
  test('a thin window opens nothing even at a 100% breach rate', async () => {
    const db = makeDb({ perWorkflow: wf(4, 4) });
    const out = await sweep(db);

    expect(out.opened).toBe(0);
    expect(db.latencyInsert()).toBeUndefined();
    expect(out.start_latency).toMatchObject({ skipped: 'below_min_sample', sampleSize: 4 });
    expect(out.start_latency.breachRate).toBeNull();
  });

  // THE IMPORTANT ONE. A quiet hour is not a recovery. Closing here would
  // have flapped the real alert open and shut five times on 2026-08-20.
  test('a quiet hour does not close an open alert', async () => {
    const db = makeDb({ perWorkflow: wf(2, 0), open: true });
    const out = await sweep(db);

    expect(out.closed).toBe(0);
    expect(db.updates).toHaveLength(0);
    expect(out.start_latency).toMatchObject({ skipped: 'below_min_sample', alreadyOpen: true });
  });

  test('an entirely empty window is a skip, not a recovery', async () => {
    const db = makeDb({ perWorkflow: [], open: true });
    const out = await sweep(db);

    expect(out.opened).toBe(0);
    expect(out.closed).toBe(0);
    expect(out.start_latency).toMatchObject({ sampleSize: 0, skipped: 'below_min_sample' });
  });

  // Exactly at the floor the scanner is live again — an off-by-one here would
  // silently widen the blind spot by one start.
  test('exactly five starts is enough to act on', async () => {
    const db = makeDb({ perWorkflow: wf(5, 5) });
    const out = await sweep(db);

    expect(out.opened).toBe(1);
    expect(out.start_latency).toMatchObject({ sampleSize: 5, breachRate: 1 });
  });
});

// ─────────────────────────────────────────────────────────────
describe('the query itself', () => {
  // A stub cannot execute a join predicate, so these assert the SQL text.
  // Each one encodes a decision that is invisible at runtime until it is
  // wrong, and wrong quietly.
  let sql;
  beforeEach(async () => {
    const db = makeDb({ perWorkflow: wf(15, 12) });
    await sweep(db);
    sql = db.query.mock.calls.map(c => c[0]).find(s => /GREATEST\(TIMESTAMPDIFF/i.test(s));
  });

  // An execution still in flight has no executed_at and must leave the sample
  // entirely — not count as a zero-latency start, not count as a breach.
  test('excludes steps with no executed_at', () => {
    expect(sql).toMatch(/s\.executed_at IS NOT NULL/);
  });

  // A step 1 that fails and retries writes a SECOND step_number=1 row rather
  // than updating the first (execution 9609: +9s failed, +2518s success). A
  // bare join double-counts the denominator AND scores the retry as a slow
  // start — that one row is the whole difference between a 2518s and a 55s
  // pre-deploy maximum.
  test('collapses step-1 retries with MIN(executed_at)', () => {
    expect(sql).toMatch(/MIN\(s\.executed_at\)/);
    expect(sql).toMatch(/GROUP BY e\.id, e\.workflow_id/);
  });

  test('clamps negative diffs rather than scoring them as breaches', () => {
    expect(sql).toMatch(/GREATEST\(TIMESTAMPDIFF\(SECOND[^)]*\)[^,]*,\s*0\)/);
  });

  test('measures only step 1, over the trailing 60 minutes', () => {
    expect(sql).toMatch(/s\.step_number = 1/);
    expect(sql).toMatch(/INTERVAL 60 MINUTE/);
  });

  // sqlGuard blocks WITH; the aggregate has to stay a derived table.
  test('uses a derived table, not a CTE', () => {
    expect(sql).not.toMatch(/\bWITH\b/i);
  });
});

// ─────────────────────────────────────────────────────────────
describe('failure containment', () => {
  test('a broken scan does not kill the sweep and raises scan_error', async () => {
    const db = makeDb({ failLatencyQuery: true });
    const out = await sweep(db);

    expect(out.scanned.start_latency).toBeNull();
    const se = db.inserts.find(i => /scan_error/.test(JSON.stringify(i.params)));
    expect(se).toBeDefined();
    expect(se.params).toContain('sweep:start_latency');
    // Date-bucketed: one ledger row per broken source per day, not 24.
    expect(se.params.some(p => typeof p === 'string'
      && /^sweep:scan_error:start_latency:\d{4}-\d{2}-\d{2}$/.test(p))).toBe(true);
  });

  test('the sweep still returns its normal shape after a scan failure', async () => {
    const db = makeDb({ failLatencyQuery: true });
    const out = await sweep(db);
    expect(out).toMatchObject({ dry_run: false, email_sent: false });
    expect(typeof out.opened).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────
describe('dry_run', () => {
  test('counts what it would open without writing a row', async () => {
    const db = makeDb({ perWorkflow: wf(15, 12) });
    const out = await alerting.runErrorSweep(db, { dry_run: true });

    expect(out.opened).toBe(1);
    expect(db.latencyInsert()).toBeUndefined();
    expect(db.alertStateUpserts).toHaveLength(0);
  });

  test('counts what it would close without resolving anything', async () => {
    const db = makeDb({ perWorkflow: wf(20, 1), open: true });
    const out = await alerting.runErrorSweep(db, { dry_run: true });

    expect(out.closed).toBe(1);
    expect(db.updates).toHaveLength(0);
  });
});
