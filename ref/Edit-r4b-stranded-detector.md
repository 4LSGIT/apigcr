# R4b — stranded-dispatch detector (folded into the nightly sweep)

One edit. `lib/internal_functions/system.js`. Anchor verified verbatim-unique
against the post-R4 tarball.

## What this is

R3's S12 change (insert the execution row BEFORE dispatching) left a
signature we never spent: a row still carrying `outcomes.dispatch_pending`
means the engine wrote the row, started dispatching, and never reached the
Phase-4 finalize. On a CPU-throttled Cloud Run instance with `Min: 0`, that
is what "trigger processing was suspended and the instance went away"
looks like from the database.

The heartbeat (Cloud Scheduler, 1/min) means the normal outcome is *delay*,
not loss — the work resumes on the next CPU window. So a row that is STILL
pending an hour later was genuinely lost, and that is the only thing worth
alerting on. The one-hour floor is what keeps this from crying wolf about
routine throttling.

Deliberately detection-only: it does NOT re-dispatch. Re-running actions
whose outcomes were never recorded is the bounded-retry design (reviewer's
P3) and needs the idempotency question answered first. This tells us whether
the problem is real before we build for it.

## Edit — `lib/internal_functions/system.js`

**FIND:**
```js
  console.log(`[TRIGGER SWEEP] deleted=${deleted} keep_days=${keepDays} keep_matched_days=${keepMatchedDays}`);
  return { success: true, output: { deleted, keep_days: keepDays, keep_matched_days: keepMatchedDays } };
};
```

**REPLACE:**
```js
  console.log(`[TRIGGER SWEEP] deleted=${deleted} keep_days=${keepDays} keep_matched_days=${keepMatchedDays}`);

  // ── Stranded-dispatch detection (S16) ──────────────────────────────────
  // A row whose outcomes still carry dispatch_pending never reached the
  // Phase-4 finalize UPDATE: the engine recorded the event, began
  // dispatching, and stopped. The expected cause is Cloud Run CPU throttling
  // (the service runs Min:0 with throttling ON), where post-response work is
  // starved between requests. The 1/min scheduler heartbeat normally rescues
  // it within a minute or two, so anything still pending after an hour was
  // genuinely lost, not merely delayed — hence the floor.
  //
  // Detection only. Re-dispatching actions with no recorded outcome is the
  // bounded-retry design and is deliberately NOT done here.
  let stranded = 0;
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS c, MIN(id) AS first_id, MAX(id) AS last_id
         FROM trigger_executions
        WHERE JSON_EXTRACT(outcomes, '$.dispatch_pending') = TRUE
          AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)
          AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    stranded = row ? Number(row.c) : 0;
    if (stranded > 0) {
      const { alert } = require('../alerting');
      await alert(db, {
        source: 'app', kind: 'trigger_dispatch_stranded', severity: 'warning',
        group_key: 'trigger_dispatch_stranded',
        title: `${stranded} trigger execution(s) stranded mid-dispatch`,
        message:
          `Executions ${row.first_id}–${row.last_id} recorded their event but never ` +
          `finalized, so some actions may not have run. Most likely cause: Cloud Run ` +
          `CPU throttling suspending post-response work (service runs Min:0, ` +
          `cpu-throttling on). Inspect: SELECT id, event_type, created_at, outcomes ` +
          `FROM trigger_executions WHERE JSON_EXTRACT(outcomes,'$.dispatch_pending')=TRUE;`,
        context: { stranded, first_id: row.first_id, last_id: row.last_id },
      }).catch(() => {});
    }
  } catch (err) {
    // Detection must never break retention.
    console.error('[TRIGGER SWEEP] stranded check failed:', err.message);
  }

  return { success: true, output: { deleted, stranded, keep_days: keepDays, keep_matched_days: keepMatchedDays } };
};
```

**And update the `__meta` description** so the function's purpose stays honest:

**FIND:**
```js
  description: 'Retention sweep for trigger_executions: no_match/no_rules rows kept keep_days (default 30), matched/error rows kept keep_matched_days (default 90). Batched deletes.',
```

**REPLACE:**
```js
  description: 'Retention sweep for trigger_executions: no_match/no_rules rows kept keep_days (default 30), matched/error rows kept keep_matched_days (default 90). Batched deletes. Also alerts on executions stranded mid-dispatch for over an hour (suspended post-response work).',
```

## Manual check any time

```sql
SELECT id, event_type, status, created_at,
       JSON_EXTRACT(outcomes, '$.matched_rule_ids') AS rules
  FROM trigger_executions
 WHERE JSON_EXTRACT(outcomes, '$.dispatch_pending') = TRUE
 ORDER BY id DESC;
```

Currently returns zero rows — but there have been no post-R4 executions yet,
so that is a null result rather than a clean bill of health.

## The delay measurement (the other half of S16)

Loss is one failure mode; latency is the other, and it is measurable without
any new code. `trigger_executions.created_at` is stamped when the engine
actually ran, not when the mutation happened, so the gap against the source
row's own timestamp IS the suspension time:

```sql
SELECT e.id, e.event_type, l.entered_at AS mutation_at, e.created_at AS processed_at,
       TIMESTAMPDIFF(SECOND, l.entered_at, e.created_at) AS lag_seconds
  FROM trigger_executions e
  JOIN case_stage_log l ON l.case_id = e.case_id
 WHERE e.event_type = 'case.stage_advanced'
   AND l.entered_at <= e.created_at
   AND e.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
 ORDER BY e.id DESC LIMIT 20;
```

Single-digit seconds means CPU was available and throttling is not biting.
Tens of seconds means the heartbeat is doing the rescuing — the risk is real
and the mitigation is working. Worth running after a week of live traffic,
including one weekend, since the isolated-event window (e-sign webhooks,
external form submits with no staff traffic behind them) is exactly where
this bites.