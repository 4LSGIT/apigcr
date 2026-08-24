# Cloud Tasks dispatch — setup runbook

Deploy order: patch + deploy first (inert — flag defaults off), GCP steps in any
order after, flag flip LAST. NOTE the patch adds `@google-cloud/tasks` to
package.json — a new install in the Docker build, so the first build after
applying runs longer and a registry hiccup fails the deploy (retry it; nothing
is stateful at that point). It also folds in the start-latency alert scanner
(lib/alerting.js) — no setup needed for that; it rides the existing Error
Alert Sweep (job 867, every 15 min). Rollback at any point: set `cloud_tasks_enabled`
to `'0'` (NOT blank — blank falls through to the env var); instances converge
within the 60s config-cache TTL. No redeploy needed either direction.
The switch stops task CREATION, not delivery: tasks already in the queue
still fire and `/process-job/:id` deliberately has no flag check (stranding
claimed-adjacent work would be worse than finishing it). Expect up to ~90s
plus any queue backlog of continued dispatches after the flip; each is
harmless — same claim predicates as the cron.

Values to fill in: PROJECT, SVC, REGION.

```bash
gcloud config get-value project
gcloud run services list
```

## 1. Enable the API

```bash
gcloud services enable cloudtasks.googleapis.com
```

## 2. Create the queue — WITH caps

Cloud Tasks defaults are maxConcurrentDispatches=1000 / maxAttempts=100. A hook
burst under defaults fans out to as many concurrent Cloud Run requests as it
can, each holding a workflow open. Cap it:

```bash
gcloud tasks queues create yc-jobs --location=REGION \
  --max-dispatches-per-second=5 \
  --max-concurrent-dispatches=5 \
  --max-attempts=3 \
  --min-backoff=10s --max-backoff=60s
```

Dispatch deadline: there is NO queue-level gcloud flag for it (an earlier
draft of this runbook said `--max-dispatch-deadline=1800s`, which fails with
`unrecognized arguments` — it is a Task field, not a Queue field). The 10-min
default is safe: a pathological advance (20 steps × up to 300s custom_code)
that outlives it just gets retried, the targeted claim finds
`status='running'`, and the retry ends as `already_claimed` 200. In the logs
that looks like a `/process-job/:id` request with no response entry, followed
seconds later by an identical request answering 200. If the wasted retry ever
matters, set `dispatchDeadline: { seconds: 1800 }` on the task object in
lib/taskQueue.js.

(3 attempts is plenty: already-claimed returns HTTP 200, so retries only fire
on 5xx/timeouts, and the 60s cron backstops everything.)

## 3. IAM for the runtime service account

```bash
gcloud run services describe SVC --region=REGION \
  --format='value(spec.template.spec.serviceAccountName)'
# blank output = default SA: PROJECT_NUMBER-compute@developer.gserviceaccount.com
#   (gcloud projects describe PROJECT --format='value(projectNumber)')

# Required — lets the app create tasks:
gcloud projects add-iam-policy-binding PROJECT \
  --member=serviceAccount:THE_SA --role=roles/cloudtasks.enqueuer

# Recommended — lets the boot warmup ALSO validate the queue exists
# (getQueue). Without it, warmup still establishes the channel but logs
# "grant roles/cloudtasks.viewer to also validate the queue at boot":
gcloud projects add-iam-policy-binding PROJECT \
  --member=serviceAccount:THE_SA --role=roles/cloudtasks.viewer
```

## 3b. One console sanity check — Cloud Run concurrency

`--max-concurrent-dispatches=5` means up to 5 task requests in flight, each
holding a full `advanceWorkflow`. Cloud Run's default container concurrency
is 80, so all 5 likely land on ONE instance (1 vCPU) — no worse than today's
cron batch (up to 10 concurrent jobs via Promise.allSettled), but the timing
changes: dispatches now spread across the minute and can overlap the cron
batch and chromium PDF renders instead of bunching at the top of it. The
concurrency setting is not in the repo, so check it once:

```bash
gcloud run services describe SVC --region=REGION \
  --format='value(spec.template.spec.containerConcurrency)'
```

At the measured peak of 6 jobs/minute this should not bind; if PDF renders
ever get slow at busy hours, this is the knob to remember.

## 4. Env vars on the service (creates a new revision)

```bash
gcloud run services update SVC --region=REGION \
  --update-env-vars=CLOUD_TASKS_LOCATION=REGION,CLOUD_TASKS_QUEUE=yc-jobs
```

## 5. Migration SQL (run against MySQL directly — readonly API can't INSERT)

```sql
INSERT INTO app_settings (`key`, `value`, is_secret, is_editable)
VALUES ('cloud_tasks_enabled', '0', 0, 1)
ON DUPLICATE KEY UPDATE `key` = `key`;
```

## 6. Flip it on

Settings tab: `cloud_tasks_enabled` → `1`, or:

```sql
UPDATE app_settings SET `value`='1' WHERE `key`='cloud_tasks_enabled';
```

## 7. Verify — capture the baseline BEFORE the flip

**F-step (one query, before step 6's flip):** run the hook→step-1 query below
and save the output. That is the pre-flip baseline; the figure to beat is
**36s average**. Without it, "it feels faster" is the only evidence.

Boot log (new revision): expect one of
- `[taskQueue] warm — queue yc-jobs (REGION) reachable and exists`  ← healthy
- `... channel established (grant roles/cloudtasks.viewer ...)`     ← healthy, viewer not granted
- `... queue NOT FOUND — check CLOUD_TASKS_LOCATION/CLOUD_TASKS_QUEUE` ← fix config

Then flip, trigger any hook-started workflow (text the firm number), and
expect the log pair `[taskQueue] enqueued dispatch for job N` → `[RESUME]
Resuming execution ...` seconds apart.

**The measurement that matters** — hook received → workflow step 1 executed
(the user-visible number that regressed on Aug 20; queue wait alone
undercounts it):

```sql
SELECT DATE(he.created_at) d, COUNT(*) n,
       ROUND(AVG(TIMESTAMPDIFF(SECOND, he.created_at, es.executed_at))) avg_s,
       MAX(TIMESTAMPDIFF(SECOND, he.created_at, es.executed_at)) max_s
FROM hook_executions he
JOIN hook_delivery_logs dl ON dl.execution_id = he.id
                          AND JSON_VALID(dl.response_body)
JOIN workflow_execution_steps es
  ON es.workflow_execution_id =
     CAST(JSON_UNQUOTE(JSON_EXTRACT(dl.response_body, '$.executionId')) AS UNSIGNED)
 AND es.step_number = 1
WHERE he.slug = 'rc-message-in'
  AND he.created_at > NOW() - INTERVAL 21 DAY
GROUP BY d ORDER BY d
```

Secondary (queue wait only — cheap spot check):

```sql
SELECT COUNT(*) n,
       ROUND(AVG(TIMESTAMPDIFF(SECOND, created_at, updated_at))) avg_s,
       MAX(TIMESTAMPDIFF(SECOND, created_at, updated_at)) max_s
FROM scheduled_jobs
WHERE type='workflow_resume' AND status='completed'
  AND created_at > NOW() - INTERVAL 1 HOUR
  AND ABS(TIMESTAMPDIFF(SECOND, created_at, scheduled_time)) <= 2;
```

Baseline (7d pre-slice): avg 35s, max 64s, 76% > 20s. Expect low single
digits on both queries. If the numbers do NOT move, check Cloud Run logs for
`[taskQueue] enqueue failed` warn lines — and note the start-latency alert
(folded into this patch) opens automatically when >25% of starts in a
qualifying hour exceed 20s, so a silent regression is no longer silent.

**G-step (after 24h):** re-run the hook→step-1 query and replace the
"EXPECTED start latency: ~2-4s (a projection...)" line in the
`lib/taskQueue.js` header with the measured number, so the projection never
ossifies into apparent fact.

## 8. One failure signature worth knowing (heartbeat isolation)

The targeted dispatch path deliberately never stamps the poll heartbeat. The
consequence: if Cloud SCHEDULER dies while Cloud TASKS stays healthy, jobs
keep dispatching normally but `recoverStuckJobs()` stops running — the
observable signature is "everything looks fine, the systemStatus heartbeat
is stale, and orphaned `running` jobs accumulate silently." The heartbeat
staleness banner is therefore MORE load-bearing than it was pre-slice; a
stale heartbeat now warrants attention even when latency looks great.

## 9. Post-deploy addendum (2026-08-24, 17h after the flip)

Deployed and measured: hook→step-1 at ~4–6s typical (pre-regression baseline
was 3.8s), throughput win intact, alert live with zero false positives. Two
standing items from the post-deploy report:

**Index for the scanner** (one line, whenever convenient — `_scanStartLatency`
currently full-scans `workflow_executions` every 15 min; harmless at ~33k
rows/year but permanent):

```sql
CREATE INDEX idx_wf_exec_created ON workflow_executions (created_at);
```

**The ~3% silent-fallback tail** (enqueue RPC starving in the throttled
post-response tail at idle hours; e.g. job 4000, Sun 22:39, 48s) is the
evidence base for the split-phase hook dispatch slice. The follow-up patch's
buffer reduction (2000→750ms) trims the typical floor but does not touch the
tail — only moving the enqueue into the request-bound phase does.
