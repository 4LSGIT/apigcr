# Database move: SiteGround MySQL → Cloud SQL (2026-10-11 … 10-13)

Record of a closed arc: what was done, how, and what made it uneventful. Not a
living document. Current state of the database and its setup: `ref/INFRA_GCP.md`
(§1, §2, §7; local development §10). Follow-ups still open: `ref/plans.md` →
Operational.

This repo is public, so this record names no host, address, account or database.
The operator script, the step-by-step runbook and the harness rebuild notes do, and
are kept privately — see "Where the rest lives" at the end.

## Result

| | |
|---|---|
| Cut over | Tuesday 2026-10-13, 02:49–03:14 Detroit (06:49–07:14 UTC) |
| Write freeze | about 26 minutes: last write on the old server 06:48:48 UTC, first on the new one 07:14:32 UTC. Staff and clients saw a maintenance page (503 + `Retry-After`). |
| Stages (UTC, from the script's own state file) | freeze 06:49:01 → 06:52:17 · copy → 07:12:47 (20½ min: dump, upload, import, triggers) · verify → 07:13:44 · flip → 07:14:44 · resume → 07:16:18. |
| Webhooks lost | none. One arrived during the freeze (the deliberate test); it was captured and replayed once, by Cloud Tasks itself, about a minute after the switch. |
| Data | 153 tables, 15 triggers, about 0.9 GB. Traffic moves only after a strict comparison of the two servers, down to a content hash of every row, has passed; the script enforces it. |
| Alerts in the hours after | none |
| Speed, same jobs before → after | CTA expiry sweep 116–159 ms → 6–11 ms; error-alert sweep ~880 ms → 107–141 ms; documents sync 3.9–4.3 s → 1.7–2.6 s. The old server cost about 67 ms of network per query; the socket costs none. |
| Fallback | the old database, untouched since the freeze, kept for 30 days |

Why move at all: the old host capped the database at 1 GB (it was at 0.9), was
reachable only by allowlisted IP (hence the NAT chain, a 4-second connection
stall from a laptop, and phpMyAdmin as the only admin tool), and closed idle
connections after 60 seconds.

## How it was done

Four pieces, each finished and proven before the next one mattered.

**1. Code that is inert until an environment variable says otherwise.** Shipped
to production days ahead, changing nothing:

- `lib/dbTarget.js` — one variable (`INSTANCE_CONNECTION_NAME`) switches both
  connection pools from host TCP to the Cloud SQL socket.
- `lib/maintenance.js` — `MAINTENANCE_MODE=1` answers 503 to everything except
  the webhook receiver.
- `lib/hookSpool.js` + `routes/internal/hookReplay.js` — during a freeze the
  receiver stores each authenticated webhook as a task on a paused Cloud Tasks
  queue; resuming the queue replays them through the normal pipeline, once each.
  This exists because that receiver answers 200 whatever happens next: senders do
  not retry, so a closed door would have lost events silently.
- `scripts/dbmigrate/dump.sh` and `parity.js` — a consistent dump with triggers
  split out and their owner stripped, and a comparison of two live servers down
  to a content hash of every row.

So the switch itself was configuration: a new Cloud Run revision with different
variables. Nothing was deployed, built or migrated during the window.

**2. A rehearsal against the real destination, while production kept running.**
The Cloud SQL instance was created two days ahead and loaded from a live dump.
That is where the things nobody could have reasoned out were found (next
section), and where the numbers that set the length of the freeze came from:
dump 13 minutes, import 4, comparison 1.

It also settled the machine size by measurement. The same eight statements,
timed three passes each on both servers: the shared-core tier had a 640 MB buffer
pool, could not keep the three big log tables in memory, and ran those scans
3.5–60× slower than the old host on every pass. One dedicated vCPU with 3.75 GB
(pool 1.4 GB, the whole database fits) came within the bar — the old host's time
plus 60 ms — on seven of eight, and far under it on most; the eighth, a text
search of the log, is CPU-bound and 0.2 s slower.

**3. The night as one script with stages.** `precheck → freeze → copy → verify
→ flip → resume`, plus `rollback` and `status`. Each stage:

- refuses to run out of order, and can be run again after a failure, Ctrl-C or
  a lost terminal (a small state file records how far the night has got);
- puts a time limit on every external call, and prints a line a minute while
  it waits;
- ends with exactly one unmistakable line — `FROZEN — GO.  Next: …`,
  `NOT IN PARITY — NO-GO.`, `STOP: …` — that says what state production is in
  and what to type next. No prompts, nothing to paste, nothing to decide at 3 AM
  that had not been decided in daylight.

What the stages did:

| Stage | In one line |
|---|---|
| `precheck` | Read-only. Several dozen checks of both servers, the service, the queues and the tools; lists every problem instead of stopping at the first. Run the day before and again at the start. |
| `freeze` | Saves production's settings. Pauses the schedulers and the job queue. Deploys the maintenance revision **on the read-only database login**, so a stray write fails instead of landing in a database about to be left behind. Sends a test webhook and finds it in the capture queue. Then proves the freeze: the newest row of 14 tables and the job poller's heartbeat, read twice a minute apart, must not move. |
| `copy` | Dump, upload, import, triggers. Then table, trigger and line-ending counts must equal the source's. |
| `verify` | `parity.js --strict --checksum`. Anything but exact equality is NO-GO. |
| `flip` | Refuses if the old server was written to since `verify`. Deploys the Cloud SQL revision **with no traffic**, under a tag; makes one real request to the tagged URL and finds that request's audit row in the new database; only then moves traffic, and checks again on the real URL. |
| `resume` | Schedulers and job queue on. Capture queue resumed, drained, parked. The test webhook must have been replayed exactly once. Waits for the job poller's heartbeat on the new server. |
| `rollback` | Traffic back to the original revision first, questions later. Needs nothing from Cloud SQL. Once production has served from the new database it demands an explicit word, because from then on going back loses writes. |

**4. A local harness, so the script had run before it ran.** Every command was
executed with its exact text before it was ever typed in Cloud Shell: two local
MySQL servers as source and destination, **the real app** in between, a stand-in
`gcloud` that models revisions, traffic, tags, queues, schedulers, import
operations and IAM (with fault injection), and a small dispatcher playing Cloud
Tasks and the scheduler. On it: the whole sequence on a real terminal with the
real waits; a webhook every half second through an entire cutover, none lost and
none run twice; every failure point followed by its recovery; Ctrl-C and a
hangup mid-stage. 367 scenario checks; 14 of 15 deliberate breakages of the
script caught (the fifteenth removed a step that is redundant by design); every
`gcloud` line parsed by the real CLI, which catches a wrong flag without needing
credentials.

## What the rehearsal and the harness caught

Found before the window instead of during it.

- **Trigger owners.** The old triggers were owned by accounts that exist only on
  the old host; imported as-is they fail (error 1227) or, worse, import and then
  fail every write to their table. Fixed by stripping the owner and applying the
  triggers logged in as the app's account.
- **Line endings.** 13 of 15 triggers had been written in phpMyAdmin and carry
  CRLF. `mysql < file` silently rewrites CRLF to LF: same behaviour, different
  bytes, strict comparison fails. Fixed with `mysql --binary-mode`.
- **`sql_mode` read through the wrong window.** The first instance was created
  with one mode too many, because the value had been read through the app, and
  the Node driver adds `IGNORE_SPACE` to every connection it opens. The server's
  own value (`@@GLOBAL.sql_mode`) is what has to match.
- **A stored function nobody remembered.** One unused function on the old
  server; the dump does not carry routines, so the comparison failed until it
  was dropped.
- **A dump that crossed the Atlantic twice.** Cloud Shell had been placed in
  Europe. 44 minutes; 13 with a compressed connection
  (`--compression-algorithms=zstd,zlib`).
- **`CHECKSUM TABLE` is useless for this.** It hashes stored bytes, and a text
  dump re-encodes JSON columns: 55 false alarms in 11 tables. `parity.js` hashes
  JSON through the same text round trip the dump performs.
- **The import command's own wait is not much longer than the import.** `gcloud
  sql import` stops waiting after 5–10 minutes (it varies by CLI version) while
  the import carries on; the rehearsal import took 4. The script starts it with
  `--async` and polls the operation itself.
- **A mixed-collation error in the pre-flight's own query**, and a "stuck job"
  check that would have blocked the freeze for five minutes and then refused:
  both found on the harness by running the real text against real MySQL, neither
  visible by reading.
- **A hung image pull.** A fresh Cloud Shell session pulled the MySQL client
  image mid-step and one layer stalled for 15 minutes without an error. From then
  on: pulled up front, from Google's mirror, under a time limit.
- **The old host answers a non-allowlisted address with "Access denied … using
  password: YES"**, not with a timeout. It reads like a bad password and is not
  one.

## What made it smooth

Worth reusing for any hand-run production operation.

1. **Make the risky change a configuration change.** The code went out early and
   inert; the night only deployed revisions.
2. **Rehearse on the real destination, not a description of it.** Every finding
   above came from running, none from review.
3. **One uploaded script, short commands.** The first rehearsal used pasted
   blocks; a 70-line paste garbled the web terminal, the session had to be reset,
   and the state of the run was unknown. After that: one file, `bash ~/yc.sh
   <stage>`.
4. **No prompts, and never a typed password.** The rehearsal lost attempts to a
   prompt overwritten by log output and to a password typed blind. Secrets are
   generated, written to a mode-600 file, and read back.
5. **A time limit on every external call.** A hang becomes a failure with a
   message.
6. **One go/no-go line per stage, and the stage names its successor.**
7. **Stages are re-runnable and know where the night is.** Recovery from an
   interruption is "run it again".
8. **Verify by effect.** "Frozen" is rows that do not move, not a paused
   scheduler. "Flipped" is this request's audit row in the new database, not a
   successful deploy. "Replayed" is exactly one execution for the test webhook.
9. **Send no traffic to a revision until it has answered a real request**
   (`--no-traffic --tag`).
10. **Decide rollback before starting**, including the point after which it costs
    data, and make the script enforce that point.
11. **Pick the window from data.** 28 nights of webhook arrivals, staff requests
    and scheduled jobs chose a weekday at 01:30 over the assumed Sunday.
12. **Find every other writer.** Maintenance mode stops what passes through the
    app. A third-party connector with its own MySQL login, and a developer's
    local `.env`, do not pass through the app; they were switched off by hand and
    repointed after.

## What changed for the app

Recorded where it now matters, in `ref/INFRA_GCP.md` §7: idle connections live
8 hours instead of 60 seconds; no phpMyAdmin; a cold buffer pool after any
restart; flags and authorized networks that replace their whole list when
changed. Local development goes through the Cloud SQL Auth Proxy (§10).

One thing did NOT change, though this record first said it had: neither server
limits how long a SELECT may run. The 30-second figure attributed to the old host
was read through the app's read-only API, which sets that limit on its own
connections — the same session-for-server mistake as `sql_mode` above. It was
caught when a plan to "restore" the limit was checked against the dump, which had
run multi-minute SELECTs on the old host without being interrupted.

## Afterwards (the same day)

- **The NAT chain went too.** The VPC connector, Cloud NAT, router, static address
  and subnet existed only so SiteGround could allowlist the app. They were removed
  on 2026-10-13 (detached 21:58, deleted 22:06 UTC) with a second staged script:
  check, then a revision without the connector proven on a test address before any
  traffic moved, then the delete. Afterwards the job poller, a mail poll and
  Documents Sync all ran without errors. The Google bill is now ≈ $54 a month,
  almost all Cloud SQL (≈ $40 with a 1-year commitment). The approval was for a
  total under SiteGround's $45 plan once email has left it too; that holds with
  the commitment.
- **Its first run was refused by gcloud itself.** Clearing a connector whose
  egress is `all-traffic` needs a confirmation prompt, and with prompts disabled
  gcloud refuses after reading the service, before sending anything. The harness's
  stand-in had not modelled that check, and the argument-parse check stops before
  it. Fix and lesson: `ref/INFRA_GCP.md` §7, and the method line in `CLAUDE.md` →
  Deploy (run every changing command through the real CLI against a stub API).
- **The old database is no longer a fallback.** From that evening rollback was not
  possible: staff had written to Cloud SQL, and the old revisions named the deleted
  connector. Remaining cleanup: `ref/plans.md` → Operational.

## Where the rest lives

Private, because they carry host names, addresses and account names:

- the operator script as it was run (`yc.sh`, about 1,270 lines of bash),
- the runbook, with the rehearsal log and the cutover log,
- the harness rebuild notes, with every stand-in file.

Two copies: the Claude project docs (`claude/DB_MIGRATION_yc.sh`,
`claude/DB_MIGRATION_RUNBOOK.md`, `claude/DB_MIGRATION_HARNESS.md`), and the
developer machine's git-ignored `local/db-migration-2026-10/`.

In this repo: `scripts/dbmigrate/` (dump and comparison), `lib/dbTarget.js`,
`lib/maintenance.js`, `lib/hookSpool.js`, `routes/internal/hookReplay.js`, and the
maintenance procedure in `ref/INFRA_GCP.md` §9.
