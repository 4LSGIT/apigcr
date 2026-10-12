# INFRA_GCP.md — Google Cloud setup for svpcac (app.4lsg.com)

Captured from live state 2026-09-20; `mailbox-ingest` scheduler job added 2026-10-09; maintenance mode + the `yc-hook-spool` queue (§9) added 2026-10-12. No open TODOs. Project `lsg-api-425223` (number `618099140949`), region `us-east1`.

**Why this file exists.** The deploy pipeline (`cloudbuild.yaml`) only ever runs
`gcloud run services update --image=...` — every other piece of the system (env vars,
scaling, the VPC/NAT chain, the build trigger, cleanup policies, DNS) is sticky mutable
state that was configured once in the console or CLI and lives nowhere in git. This file
is the rebuild runbook and drift reference for that state.

**Redaction rule.** This repo is fetched unauthenticated, so: secret env vars appear as
NAMES only, and the NAT egress IP / DB coordinates are deliberately not written here.
Values live in the live service config (console → Cloud Run → svpcac → revision → variables)
— keep a private export current with:
`gcloud run services describe svpcac --region=us-east1 --format=export > svpcac.export.yaml`
(contains all secret values; store off-repo, e.g. local `~/keys/`).

---

## 1. Architecture

GitHub push to `4LSGIT/apigcr` `main` → Cloud Build trigger (GitHub App, currently in
location **global**) runs repo `cloudbuild.yaml` → docker build (classic builder,
`--cache-from` a `:cache` tag; app image `FROM` a prebuilt base with node+chromium) →
push to Artifact Registry `us-east1/cloud-run-source-deploy/apigcr/svpcac` → `gcloud run
services update svpcac --image=...:$COMMIT_SHA`. Push-to-live ≈ 2 min.

Cloud Run egress is forced through **Serverless VPC Access connector `svpcac`** → Cloud
Router `crouter` → **Cloud NAT `nat4lsg`** using the reserved static IP **`api-4lsg-ip`**.

**WHY THE NAT EXISTS:** the MySQL database is SiteGround-hosted remote MySQL, which only
accepts connections from allowlisted IPs. The static NAT IP is that allowlisted address.
This chain (2× e2-micro connector VMs + NAT IP + NAT gateway ≈ $7–8/mo) is essentially
the *entire* steady-state GCP bill. If the DB ever moves somewhere that doesn't need IP
allowlisting, delete the connector + router + NAT + address and remove
`--vpc-connector`/`--vpc-egress` from the service.

Front door: `app.4lsg.com` is a **Cloud Run domain mapping** (DNS CNAME →
`ghs.googlehosted.com`). Uploads: GCS bucket `uploads.4lsg.com` served via DNS CNAME →
`c.storage.googleapis.com`.

## 2. Inventory (as of 2026-09-20)

| Resource | Name / value | Notes |
|---|---|---|
| Cloud Run service | `svpcac`, us-east1 | 1 vCPU / 1 Gi, maxScale 6, **minScale unset (0 → cold starts)**, concurrency 80, timeout 900 s, port 8080 (http1), startup-cpu-boost on, default TCP startup probe, ingress all. Container name `apigcr-1`. |
| Runtime/deploy SA | `618099140949-compute@developer.gserviceaccount.com` | Default compute SA does everything: runtime, build, deploy. |
| VPC connector | `svpcac`, network `default`, subnet `vpc28` | e2-micro, min 2 / max 10 instances. This is the "Compute Engine" line on the bill (mostly free-tier-discounted). |
| Subnet | `vpc28`, us-east1, `10.124.0.0/28` | Connector-dedicated /28 on network `default`. |
| Cloud Router | `crouter`, network `default`, us-east1 | |
| Cloud NAT | `nat4lsg` on `crouter` | MANUAL_ONLY IPs = `api-4lsg-ip`; NATs **only subnet `vpc28`** (primary range). Defaults otherwise: endpoint-independent mapping off, dynamic port allocation, no NAT logging, tcp-time-wait 120 s. |
| Static IP | `api-4lsg-ip`, us-east1, EXTERNAL, IN_USE | The SiteGround-allowlisted egress IP. Value: console → VPC network → IP addresses. |
| AR repo (app) | `us-east1/cloud-run-source-deploy` | Docker. **Cleanup policy since 2026-09-20** (see §4). Holds `apigcr/svpcac` images incl. the `:cache` tag. |
| AR repo (base) | `us-east1/svpcac-base` | Holds `base:1` (node:24-slim + chromium + fonts, ~330 MB). **Deliberately NO cleanup policy** — see Dockerfile.base header. |
| AR legacy | `gcr.io` (us, ~113 MB), `cloud-run-source-deploy` (us-central1, ~147 MB, 2024) | Unused, ≈$0.03/mo. Delete if confirmed unreferenced, or ignore. |
| Build trigger (active) | `rmgpgab-svpcac-us-east1-4LSGIT-apigcr--maulx`, id `deae68ad-1912-4a06-9db6-516dab663a64`, location **global** | GitHub App, `4LSGIT/apigcr` push `^main$`, builds `cloudbuild.yaml`, SA = default compute. Two disabled June-2026 triggers remain (buildpack `3a276457`, docker `8934804e`) — keep disabled or delete. |
| Cloud Scheduler | `process-jobs`, us-east1, `* * * * *`, tz America/Cancun | `POST https://svpcac-<PROJECT_NUMBER>.us-east1.run.app/process-jobs` with header `x-api-key: <yck_ write key>` (value lives in the job config; view with `gcloud scheduler jobs describe`, mint/rotate in the app). Deliberately targets the run.app URL, not the custom domain — **the URL embeds the project number, so it changes on a project rebuild**. attemptDeadline 900 s; retries backoff 5 s→300 s. Tz is DST-less EST; irrelevant at every-minute but don't copy the pattern for daily jobs (FIRM_TZ is America/Detroit). |
| Cloud Scheduler | `mailbox-ingest`, us-east1, `*/5 * * * *`, tz Etc/UTC (created 2026-10-09) | `POST https://svpcac-<PROJECT_NUMBER>.us-east1.run.app/mailbox-ingest` with header `x-api-key: <yck_ key>` — its OWN key (labelled "scheduler mailbox-ingest"), revocable without touching `process-jobs`. attemptDeadline 600 s; **no retries** (`--max-retry-attempts=0`): every tick is a retry, and the run's `GET_LOCK('mailbox_ingest:<db>')` would turn a retry into a skip. Run budget 240 s (`MAILBOX_INGEST_BUDGET_MS`) sits inside the deadline. Deliberately NOT folded into the `process-jobs` tick: own pause switch (`gcloud scheduler jobs pause mailbox-ingest`), an IMAP-appropriate cadence, and failure isolation (an IMAP stall can't hold `process-jobs` open). Emit kill switch is DB-side: `email_ingest_sources` row `mailbox-imap` `active=0`. |
| Cloud Tasks | queue `yc-jobs`, us-east1 | Referenced by env `CLOUD_TASKS_LOCATION`/`CLOUD_TASKS_QUEUE`. |
| Cloud Tasks | queue `yc-hook-spool`, us-east1 — **PAUSED by design** | The hook spool (`lib/hookSpool.js`): where `POST /hooks/:slug` parks webhooks while `MAINTENANCE_MODE=1`. Paused = capture, resumed = replay to `/internal/hook-replay`. max-concurrent-dispatches 1, **max-attempts -1 (unlimited)**, backoff 30 s→600 s, log sampling 1.0. Leave it paused between uses; a RUNNING state is only correct while draining after a maintenance window. Procedure: §9. |
| GCS | bucket `uploads.4lsg.com` (US multi-region) | Served via CNAME `uploads.4lsg.com → c.storage.googleapis.com` (HTTP path). |
| Domain mapping | `app.4lsg.com` → svpcac | DNS: CNAME `app` → `ghs.googlehosted.com.` (DNS-only record at the DNS host; NOT proxied through Cloudflare — Express/GFE headers visible). |
| Secret Manager | **not used** | All config is plain env vars on the service (§5). `gcloud secrets list` prompts to enable the API — that's the tell. |
| Other SAs | `firebase-adminsdk-kg83l@…`, `local-fred@…` (Fred's local dev), appspot default | A `runapps` firebase-hosting integration (2024-07) is still annotated on the service — legacy, not in the serving path. |

**Steady-state bill (post-cleanup, ~monthly):** NAT IP $3.72 + NAT gateway $2.08 +
connector VMs ~$1–2 net of free tier + NAT data processing ~$0.20 + AR ~$0.10–0.50
≈ **$7–8/mo**. Anything materially above that = something regressed (check AR size first).

## 3. Build pipeline (source of truth: `cloudbuild.yaml`, `Dockerfile`, `Dockerfile.base`)

- App image: `Dockerfile` — `FROM us-east1-docker.pkg.dev/lsg-api-425223/svpcac-base/base:1`,
  `npm ci --omit=dev`, `CMD node server.js`, port 8080.
- Base image: `Dockerfile.base` — node:24-slim + chromium + fonts-liberation/dejavu (for
  pdfRenderService). Rebuild only for node/chromium security refreshes; **bump the tag**
  (`:2`, `:3`…) and update the `FROM` line in the same commit. Full build/push commands in
  its header comment.
- Layer caching: each build pulls `…apigcr/svpcac:cache` and builds with
  `--cache-from` under `DOCKER_BUILDKIT=0`; commits not touching `package*.json` skip npm.
  The `:cache` tag is retagged onto every new build's digest, so it always sits on the
  newest version and the keep-last-2 cleanup rule (§4) always protects it. If the policy
  is ever rewritten tag-based, do not reap `:cache` — builds degrade to ~5 min npm runs.
- **Known inefficiency:** the trigger lives in location *global*, so build VMs land in an
  arbitrary US region and pull the base + cache images cross-region from us-east1 —
  that's the "Artifact Registry Network Inter Region Egress NA→NA" billing SKU
  (~50 GiB ≈ $0.51 in Sep 2026). Fix when convenient by recreating the trigger in
  us-east1 (GitHub-App triggers can't be moved in place). Same settings: repo
  `4LSGIT/apigcr`, push `^main$`, `cloudbuild.yaml`, default compute SA.

## 4. Artifact Registry cleanup policy (and the Sept 2026 incident)

History: until 2026-08-30 the chromium apt layer lived in the app Dockerfile and was
re-pushed (~800 MB fresh blob) on every deploy — measured 4.1 GiB/day, repo reached
~150 GiB. The 2026-08-30 base-image split stopped the growth, but the cleanup policy
that fix assumed was **never applied**, so the accumulated images sat at ~168 GiB billing
$0.10/GiB-mo (~$10–17/mo) until the policy below was added on 2026-09-20.

Active policy on `cloud-run-source-deploy` (us-east1) only — never on `svpcac-base`:

```json
[
  {"name": "delete-older-than-1d", "action": {"type": "Delete"},
   "condition": {"tagState": "any", "olderThan": "1d"}},
  {"name": "keep-last-2", "action": {"type": "Keep"},
   "mostRecentVersions": {"keepCount": 2}}
]
```

Apply: `gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy
--location=us-east1 --policy=ar-cleanup.json --no-dry-run`. Keep beats Delete on
conflict; runs ~daily (first pass up to 24 h).

Why aggressive deletion is safe: **Cloud Run copies the container image into its own
storage at deploy time** — deleting images from AR never breaks the serving revision or
revision rollback. Rebuild-from-commit is the real rollback path anyway (~2 min).

Expected repo size in steady state: well under 1 GiB. If
`gcloud artifacts repositories describe cloud-run-source-deploy --location=us-east1 | grep Size`
shows multi-GiB growth again, the policy broke or was removed.

## 5. Runtime env vars (service `svpcac`)

Secret values: NAMES only here; live values on the service revision (see header for the
export command). Non-secret values inline.

- **DB (SiteGround remote MySQL, reached via the NAT IP):** `host`, `database`, `user`,
  `password`, `user_ro`, `password_ro` (lowercase names are historical; keep them).
  Optional, UNSET in prod today: `INSTANCE_CONNECTION_NAME` (`PROJECT:REGION:INSTANCE`) —
  when set, both pools connect over the Cloud SQL Unix socket `/cloudsql/<name>` and
  ignore `host` (needs `--add-cloudsql-instances` on the revision); `INSTANCE_CONNECTION_NAME_RO`
  overrides it for the readonly pool only. See `lib/dbTarget.js`.
- **App identity:** `ENVIRONMENT=production`, `APP_URL=https://app.4lsg.com`,
  `FIRM_TIMEZONE=America/Detroit`, `EMAIL_DOMAIN=@4lsg.com`,
  `EMAIL_DOMAINS=@4lsg.com,@metrodetroitbankruptcylaw.com`, `IT_EMAIL=it@4lsg.com`,
  `AUTO_EMAIL=automations@4lsg.com`, `FIRM_PHONE=2484179800`,
  `FIRM_EMAIL=office@4lsg.com`, `FIRM_URL=https://legalsolutions.group`,
  `FIRM_LOG=<hosted logo png URL>`
- **GCP wiring:** `GCS_BUCKET=uploads.4lsg.com`, `CLOUD_TASKS_LOCATION=us-east1`,
  `CLOUD_TASKS_QUEUE=yc-jobs`
- **Maintenance (all UNSET in prod; set only on a maintenance revision — §9):**
  `MAINTENANCE_MODE=1` turns the gate on (`lib/maintenance.js`); optional
  `MAINTENANCE_MESSAGE` (text on the 503 page/JSON), `MAINTENANCE_RETRY_AFTER`
  (seconds, default 900), `CLOUD_TASKS_SPOOL_QUEUE` (default `yc-hook-spool`).
- **App secrets:** `API_KEY`, `INTERNAL_API_KEY`, `JWT_SECRET`,
  `CREDENTIALS_ENCRYPTION_KEY`, `STREAK_ADMIN_PASSWORD`, `AITEST_KEY` (+`AITEST_ENABLED=1`)
- **RingCentral:** `RINGCENTRAL_CLIENT_ID`, `RINGCENTRAL_CLIENT_SECRET`,
  `RINGCENTRAL_API_KEY`, `RINGCENTRAL_REDIRECT_URI=https://app.4lsg.com/ringcentral/callback`
- **Dropbox:** `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, plus
  legacy `DROPBOX_ACCESS_TOKEN` and `DROPBOX_TOKEN` (duplicates; refresh-token trio is
  the live path — candidates for removal after verifying no code reads them).
- **AI / misc:** `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `BADGE_DEVICE_TOKEN`

## 6. Rebuild runbook (dependency order)

Assumes fresh project or region. `P=lsg-api-425223 R=us-east1` (adjust if new project).

1. **APIs:** `gcloud services enable run.googleapis.com cloudbuild.googleapis.com
   artifactregistry.googleapis.com vpcaccess.googleapis.com compute.googleapis.com
   cloudscheduler.googleapis.com cloudtasks.googleapis.com storage.googleapis.com
   iam.googleapis.com logging.googleapis.com`
2. **Subnet** (connector-dedicated /28 on `default`):
   `gcloud compute networks subnets create vpc28 --network=default --region=$R --range=10.124.0.0/28`
3. **Static IP + router + NAT:**
   ```
   gcloud compute addresses create api-4lsg-ip --region=$R
   gcloud compute routers create crouter --network=default --region=$R
   gcloud compute routers nats create nat4lsg --router=crouter --region=$R \
     --nat-external-ip-pool=api-4lsg-ip \
     --nat-custom-subnet-ip-ranges=vpc28   # confirmed: only vpc28, primary range
   ```
   ⚠ **The new reserved IP is a NEW address.** Update the SiteGround remote-MySQL
   allowlist (Site Tools → MySQL → Remote MySQL) with it — the app cannot reach the DB
   until this is done. Check for any other services allowlisting the old IP.
4. **Connector:**
   ```
   gcloud compute networks vpc-access connectors create svpcac --region=$R \
     --subnet=vpc28 --subnet-project=$P \
     --machine-type=e2-micro --min-instances=2 --max-instances=10
   ```
5. **Artifact Registry + base image:** create both repos and apply the cleanup policy
   (§4) to `cloud-run-source-deploy` only; build and push `svpcac-base/base:1` per the
   commands in the `Dockerfile.base` header.
6. **Build trigger (console; GitHub App connect is interactive):** Cloud Build →
   Triggers → region **us-east1** → Connect repository (GitHub App) `4LSGIT/apigcr` →
   push `^main$`, type "Cloud Build configuration file" `cloudbuild.yaml`, SA = default
   compute. If the trigger id changes, update the `--labels=...gcb-trigger-id=` value in
   `cloudbuild.yaml` (cosmetic) and `_IMAGE` if the project changed.
7. **First deploy:** push to main (or `gcloud builds triggers run`). The build's
   `run services update` creates/updates the service image only; then apply the one-time
   service config:
   ```
   gcloud run services update svpcac --region=$R \
     --vpc-connector=svpcac --vpc-egress=all-traffic \
     --cpu=1 --memory=1Gi --max-instances=6 --concurrency=80 --timeout=900 \
     --port=8080 --cpu-boost \
     --set-env-vars/--set-secrets ...   # fastest: edit the private svpcac.export.yaml
                                        # and `gcloud run services replace` it
   ```
8. **Scheduler** (after the service exists — the URI embeds the NEW project number;
   mint a fresh `yck_` write key PER JOB in the app first):
   ```
   gcloud scheduler jobs create http process-jobs --location=$R \
     --schedule="* * * * *" --time-zone="America/Cancun" \
     --http-method=POST \
     --uri="https://svpcac-<PROJECT_NUMBER>.$R.run.app/process-jobs" \
     --headers=x-api-key=<yck_ write key> \
     --attempt-deadline=900s \
     --min-backoff=5s --max-backoff=300s --max-doublings=5

   gcloud scheduler jobs create http mailbox-ingest --location=$R \
     --schedule="*/5 * * * *" --time-zone="Etc/UTC" \
     --http-method=POST \
     --uri="https://svpcac-<PROJECT_NUMBER>.$R.run.app/mailbox-ingest" \
     --headers=x-api-key=<its own yck_ key> \
     --attempt-deadline=600s --max-retry-attempts=0
   ```
9. **Cloud Tasks:** `gcloud tasks queues create yc-jobs --location=$R`, and the hook
   spool, created then immediately paused (it stays paused — §9):
   ```
   gcloud tasks queues create yc-hook-spool --location=$R \
     --max-concurrent-dispatches=1 --max-dispatches-per-second=2 \
     --max-attempts=-1 --min-backoff=30s --max-backoff=600s --max-doublings=5 \
     --log-sampling-ratio=1.0
   gcloud tasks queues pause yc-hook-spool --location=$R
   gcloud tasks queues describe yc-hook-spool --location=$R \
     --format='value(state,retryConfig.maxAttempts)'        # must print: PAUSED  -1
   ```
   `-1` = unlimited attempts, and it is load-bearing: Cloud Tasks **deletes** a task
   when its attempts run out, whatever the status code, so a finite budget would let
   any systematic replay failure empty the spool. If `describe` prints anything but
   `-1`, fix it (`gcloud tasks queues update … --max-attempts=-1`) before relying on it.
10. **GCS:** `gsutil mb -l US gs://uploads.4lsg.com` (domain-named bucket requires the
    domain be verified to the account) + grant the runtime SA object admin on it.
11. **Domain mapping + DNS:**
    `gcloud beta run domain-mappings create --service=svpcac --domain=app.4lsg.com --region=$R`,
    then at the DNS host: CNAME `app` → `ghs.googlehosted.com.` (DNS-only), CNAME
    `uploads` → `c.storage.googleapis.com.`
12. **Smoke:** app loads over `https://app.4lsg.com`; DB queries succeed (proves NAT +
    allowlist); an outbound-IP check from inside the app equals the reserved IP;
    scheduler tick processes a job; a `mailbox-ingest` tick advances
    `mailboxes.ingest_state.<folder>.checked_at`; a test push deploys end-to-end.

## 7. Gotchas

- **NAT IP is load-bearing state.** Recreating/releasing `api-4lsg-ip` = DB outage until
  the SiteGround allowlist is updated. Never fix by switching NAT to AUTO_ONLY.
- **Deploys don't carry config.** `cloudbuild.yaml` updates `--image` only. Env/scaling
  changes made in console persist silently and exist nowhere else — that's what the
  private `svpcac.export.yaml` snapshot is for. Re-export after intentional changes.
- **minScale is 0.** Every scale-from-zero is a cold start and a cold MySQL pool.
  min-instances=1 has been repeatedly considered; costs roughly the price of one
  always-on instance minus request-time overlap. Decide deliberately, not by default.
- **`svpcac-base` must never get a cleanup policy**; `base:N` tags are immutable by
  convention (bump, don't overwrite).
- Old triggers `3a276457` (buildpack) and `8934804e` (docker) exist disabled — re-enabling
  the buildpack one would bypass the Dockerfile/base-image pipeline entirely.
- Scheduler tz `America/Cancun` ≠ `FIRM_TZ` (Detroit observes DST, Cancun doesn't).
  Harmless at `* * * * *`; wrong template for anything daily. `mailbox-ingest` uses
  `Etc/UTC` — the pattern to copy for new cadence jobs.
- July-2026 billing showed a $0.01 Cloud SQL snapshot; no Cloud SQL instance exists now
  (`sqladmin` API is enabled but idle).

## 8. Re-capture (drift check — safe to run any time, no prompts)

```bash
P=lsg-api-425223; R=us-east1
{
echo "== run yaml";  gcloud run services describe svpcac --region=$R --project=$P --format=export
echo "== connector"; gcloud compute networks vpc-access connectors list --region=$R --project=$P
echo "== subnet";    gcloud compute networks subnets describe vpc28 --region=$R --project=$P
echo "== nat";       gcloud compute routers nats describe nat4lsg --router=crouter --region=$R --project=$P
echo "== addresses"; gcloud compute addresses list --project=$P
echo "== ar";        gcloud artifacts repositories list --project=$P
echo "== ar policy"; gcloud artifacts repositories describe cloud-run-source-deploy --location=$R --project=$P
echo "== triggers";  gcloud builds triggers list --project=$P --region=global; \
                     gcloud builds triggers list --project=$P --region=$R
echo "== scheduler"; gcloud scheduler jobs list --location=$R --project=$P; \
                     for j in process-jobs mailbox-ingest; do \
                       gcloud scheduler jobs describe $j --location=$R --project=$P; done
echo "== tasks";     gcloud tasks queues list --location=$R --project=$P
echo "== domains";   gcloud beta run domain-mappings list --region=$R --project=$P
} 2>&1 | tee /tmp/infra_dump.txt
```

Diff the output against this file during docs review; divergences get fixed here or
filed in scratch `ns=docs`. The `== run yaml` section contains secret values — never
commit the dump.

## 9. Maintenance mode (write freeze)

For work that needs the data to stand still (a database move). One env var on a
revision; the code is inert without it. Design and rationale: `lib/maintenance.js`,
`lib/hookSpool.js`, `routes/internal/hookReplay.js`.

**What `MAINTENANCE_MODE=1` does.** Every route answers `503` + `Retry-After` (an HTML
page for a browser navigation, JSON otherwise) — staff, portal, booking pages, API keys,
both scheduler ticks, Cloud Tasks pushes, e-sign webhooks. The one door left open is
`POST /hooks/:slug`: that receiver answers 200 even when its own pipeline fails, so
closing it — or leaving it running against a frozen database — would lose RingCentral /
Quo events, website leads and Calendly bookings silently. Instead it authenticates the
event as usual and stores it as a task on `yc-hook-spool`. If the event cannot be stored
it answers 503, so the sender retries. Boot also skips the custom-field reconcile (DDL).

**What it does not do.** It cannot stop a writer that never passes through Express:
anything holding MySQL credentials directly (Pabbly's MySQL steps, a local dev `.env`).
Switch those off by hand. And run the maintenance revision on the **read-only DB user**
(`user`/`password` = the `user_ro`/`password_ro` values) so a stray write anywhere in
the app fails instead of landing in a database that is about to be left behind.

**Enter.** First quiet the app's own callers — not required for safety (they would
just collect 503s) but it keeps the scheduler from logging a failure a minute:
```
gcloud scheduler jobs pause process-jobs   --location=$R
gcloud scheduler jobs pause mailbox-ingest --location=$R
gcloud tasks queues pause yc-jobs          --location=$R
gcloud tasks queues describe yc-hook-spool --location=$R \
  --format='value(state,retryConfig.maxAttempts)'                    # must print: PAUSED  -1
```
Then one revision. `^@^` makes `@` the separator because values may contain commas —
if a value contains `@`, pick another character that appears in none of them
(`^#^…#…`):
```
gcloud run services update svpcac --region=$R \
  --update-env-vars='^@^MAINTENANCE_MODE=1@user=<user_ro value>@password=<password_ro value>'
```
The boot log must show `[maintenance] MAINTENANCE_MODE=1` and
`[hookSpool] ready — queue yc-hook-spool (us-east1) exists and is PAUSED`. A
`not PAUSED` / `NOT FOUND` / `NOT CONFIGURED` line there means captured webhooks are
not safe — fix it before relying on the window. Then prove it with a real hit: POST to
a test hook, expect 200, and see the task with
`gcloud tasks list --queue=yc-hook-spool --location=$R`.

During the window the app cannot record alerts (read-only DB user), so a failed
capture shows **only in the Cloud Run log** — search for `could NOT spool`. The sender
got a 503 for each one and will retry.

**Leave** — order matters: the app first, the queue second.
```
gcloud run services update svpcac --region=$R \
  --remove-env-vars=MAINTENANCE_MODE \
  --update-env-vars='^@^user=<app user>@password=<app password>'     # plus any new DB target
# confirm the app answers normally, THEN:
gcloud scheduler jobs resume process-jobs   --location=$R
gcloud scheduler jobs resume mailbox-ingest --location=$R
gcloud tasks queues resume yc-jobs          --location=$R
gcloud tasks queues resume yc-hook-spool    --location=$R
gcloud tasks list --queue=yc-hook-spool --location=$R                # drains to empty
gcloud tasks queues pause yc-hook-spool --location=$R                # park it for next time
```
Resuming early is harmless but pointless: the gate 503s `/internal/hook-replay` too, so
tasks just retry. **A queue that does not drain is the signal that something is wrong**
— a task leaves it only when the replay route answers 2xx. Look at one with
`gcloud tasks describe <task> --queue=yc-hook-spool --location=$R --response-view=full`
(shows the stored event and the last attempt's status), fix the cause, and it goes
through on its next retry (at most 10 minutes later).

**Replay semantics.** One task = one captured event, replayed through the normal hook
pipeline with its original `received_at`, plus `meta.spooled`, `meta.spool_id` and
`meta.replayed_at` in `hook_executions.raw_input`. Redelivery is a no-op (keyed on
`spool_id`). Events replay one at a time in roughly arrival order (Cloud Tasks does not
guarantee order). A captured event whose hook was deleted in the meantime — with no
`_catchall` hook — is dropped: a `spool_replay_dropped` system alert, and the full
payload written to the Cloud Run log (search `DROPPED spooled event`). The tasks carry
the internal API key, so rotating it twice between capture and replay makes every
replay 401 (one rotation is covered by the previous-key slot); the tasks wait in the
queue until the key they carry is valid again.

**Limits.** An event over ~900 KB cannot be stored in one task → the sender gets 503
for the whole window. An event between 512 KB and 900 KB is captured but cannot replay
until the pipeline's oversized-payload handling is fixed (`executeHook` cuts the JSON
text at 512 KB, which a JSON column rejects — the same event is dropped by the live
receiver today); it stays in the queue, visibly. Largest hook payload on record: 24 KB.
Tasks are kept 31 days.
