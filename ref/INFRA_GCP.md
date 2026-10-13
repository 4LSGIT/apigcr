# INFRA_GCP.md — Google Cloud setup for svpcac (app.4lsg.com)

Captured from live state 2026-09-20; `mailbox-ingest` scheduler job added 2026-10-09; maintenance mode + the `yc-hook-spool` queue (§9) added 2026-10-12; the database moved to Cloud SQL 2026-10-13 (§1, §2, §5–§7; local development §10). One open item: the NAT chain's removal (§1, `ref/plans.md` → Operational). Project `lsg-api-425223` (number `618099140949`), region `us-east1`.

**Why this file exists.** The deploy pipeline (`cloudbuild.yaml`) only ever runs
`gcloud run services update --image=...` — every other piece of the system (env vars,
scaling, the VPC/NAT chain, the build trigger, cleanup policies, DNS) is sticky mutable
state that was configured once in the console or CLI and lives nowhere in git. This file
is the rebuild runbook and drift reference for that state.

**Redaction rule.** This repo is fetched unauthenticated, so: secret env vars appear as
NAMES only, and the NAT egress IP / DB coordinates (database name, account names, the
instance's IP) are deliberately not written here. Resource names — the service, the
Cloud SQL instance, the queues — are not secrets: every one is IAM-gated.
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

**Database:** Cloud SQL for MySQL 8.4, instance **`yc-mysql`** (same project and
region). Cloud Run reaches it over the Unix socket `/cloudsql/<connection name>`, which
Cloud Run mounts on a revision deployed with `--add-cloudsql-instances`; the connection
is IAM-authorized and encrypted by Google's connector and needs neither an IP
allowlist nor the VPC connector and NAT below. The app picks the socket when `INSTANCE_CONNECTION_NAME`
is set (`lib/dbTarget.js`). A developer machine uses the Cloud SQL Auth Proxy (§10).
How the database got here from SiteGround: `ref/archive/DB_MIGRATION_2026-10.md`.

**WHY THE NAT STILL EXISTS:** it was built because the previous database host
(SiteGround remote MySQL) only accepted allowlisted IPs, and the static NAT IP was that
address. The database no longer needs it. The chain (2× e2-micro connector VMs + NAT
IP + NAT gateway ≈ $7–8/mo) stays while the SiteGround copy is the rollback fallback;
once that copy is dropped, and after checking that no other outside service allowlists
the address, delete the connector + router + NAT + address and clear the connector
from the service (`gcloud run services update svpcac --region=us-east1
--clear-vpc-connector`). The socket has only ever run here WITH the connector
attached, so make that change as a `--no-traffic --tag=…` revision first, and move
traffic only once its boot log is free of connection errors and a request through the
tagged URL has read the database. Tracked in `ref/plans.md` → Operational.

Front door: `app.4lsg.com` is a **Cloud Run domain mapping** (DNS CNAME →
`ghs.googlehosted.com`). Uploads: GCS bucket `uploads.4lsg.com` served via DNS CNAME →
`c.storage.googleapis.com`.

## 2. Inventory (as of 2026-09-20; Cloud SQL rows 2026-10-13)

| Resource | Name / value | Notes |
|---|---|---|
| Cloud Run service | `svpcac`, us-east1 | 1 vCPU / 1 Gi, maxScale 6, **minScale unset (0 → cold starts)**, concurrency 80, timeout 900 s, port 8080 (http1), startup-cpu-boost on, default TCP startup probe, ingress all. Container name `apigcr-1`. |
| Runtime/deploy SA | `618099140949-compute@developer.gserviceaccount.com` | Default compute SA does everything: runtime, build, deploy. Holds `roles/cloudsql.client` — the socket does not connect without it. |
| Cloud SQL | instance `yc-mysql`, us-east1 (zonal), MySQL 8.4, Enterprise edition | Tier `db-custom-1-3840` (1 vCPU, 3.75 GB → InnoDB buffer pool ≈ 1.4 GB, which holds the whole ~0.9 GB database; the shared-core `db-g1-small` was measured and rejected — its 640 MB pool could not). 20 GB SSD, auto-increase. Daily backup 08:00 UTC, 7 kept; binary log on, 7 days of point-in-time recovery. Maintenance window Sunday 09:00 UTC. **Deletion protection on** (the backups live with the instance). Four database flags — §7. Connection name `lsg-api-425223:us-east1:yc-mysql`. Has a public IP with ONE authorized network (the Pabbly connector's address); everything else connects by IAM. Accounts: an app account (all privileges on the one database), a read-only account (SELECT only — the `user_ro` pool), one for Pabbly bound to its address, and root. Names and passwords are in the private runbook / the service config, not here. |
| GCS (migration) | bucket `lsg-yc-migration`, us-east1 | Uniform access, public access prevented. Staging for `gcloud sql import` only; the Cloud SQL service account has objectViewer on it. Holds nothing in steady state — an object left here is a full copy of client data. |
| VPC connector | `svpcac`, network `default`, subnet `vpc28` | e2-micro, min 2 / max 10 instances. This is the "Compute Engine" line on the bill (mostly free-tier-discounted). Carries the app's outbound traffic to the NAT (`--vpc-egress=all-traffic`). The database connection does not depend on it (Cloud SQL socket). |
| Subnet | `vpc28`, us-east1, `10.124.0.0/28` | Connector-dedicated /28 on network `default`. |
| Cloud Router | `crouter`, network `default`, us-east1 | |
| Cloud NAT | `nat4lsg` on `crouter` | MANUAL_ONLY IPs = `api-4lsg-ip`; NATs **only subnet `vpc28`** (primary range). Defaults otherwise: endpoint-independent mapping off, dynamic port allocation, no NAT logging, tcp-time-wait 120 s. |
| Static IP | `api-4lsg-ip`, us-east1, EXTERNAL, IN_USE | The app's fixed egress IP — the address the previous database host (SiteGround) allowlisted. The database no longer needs it; whether any other outside service allowlists it is the check to make before the NAT chain is removed (§1). Value: console → VPC network → IP addresses. |
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

**Steady-state bill (~monthly):** Cloud SQL ≈ **$53** on demand (1 vCPU $30.15 +
3.75 GB $19.16 + 20 GB SSD $3.40, list prices 2026-10-12; ≈ $40 under a 1-year
commitment) + the NAT chain ≈ $7–8 (NAT IP $3.72 + NAT gateway $2.08 + connector VMs
~$1–2 net of free tier + NAT data processing ~$0.20) + AR ~$0.10–0.50 ≈ **$60/mo**.
Anything materially above that = something regressed (check AR size first; then
whether the Cloud SQL disk auto-grew).

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

- **DB (Cloud SQL over the socket):** `INSTANCE_CONNECTION_NAME`
  (`PROJECT:REGION:INSTANCE`), `database`, `user`, `password`, `user_ro`, `password_ro`
  (lowercase names are historical; keep them). With `INSTANCE_CONNECTION_NAME` set, both
  pools connect over `/cloudsql/<name>` — which exists only on a revision deployed with
  `--add-cloudsql-instances=<name>`; the flag and the variable go together, and
  `cloudbuild.yaml`'s image-only update carries both forward. **`host` is UNSET in
  prod**: it is the TCP fallback, read only when `INSTANCE_CONNECTION_NAME` is absent
  (that is how a developer machine connects, §10). Optional and unset:
  `INSTANCE_CONNECTION_NAME_RO` overrides the target for the readonly pool only.
  See `lib/dbTarget.js`.
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
   iam.googleapis.com logging.googleapis.com sqladmin.googleapis.com`
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
   ⚠ **The new reserved IP is a NEW address.** The database does not care (it is
   reached over the Cloud SQL socket), but any outside service that allowlists the old
   address must be given the new one. Steps 2–4 exist only to give the app a fixed
   egress address: if nothing needs one, skip them and leave `--vpc-connector` /
   `--vpc-egress` off the service in step 7.
4. **Connector:**
   ```
   gcloud compute networks vpc-access connectors create svpcac --region=$R \
     --subnet=vpc28 --subnet-project=$P \
     --machine-type=e2-micro --min-instances=2 --max-instances=10
   ```
4a. **Cloud SQL** (the database; step 7 points the service at it). Restoring into a
   NEW instance from a backup of the old one replaces the create-and-load below —
   console → SQL → Backups → Restore.
   ```
   gcloud sql instances create yc-mysql --region=$R \
     --database-version=MYSQL_8_4 --edition=enterprise --tier=db-custom-1-3840 \
     --availability-type=zonal --storage-type=SSD --storage-size=20GB --storage-auto-increase \
     --backup-start-time=08:00 --enable-bin-log --retained-backups-count=7 --retained-transaction-log-days=7 \
     --maintenance-window-day=SUN --maintenance-window-hour=9 --deletion-protection \
     --database-flags='^~^sql_mode=NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION~lower_case_table_names=0~log_bin_trust_function_creators=on~default_time_zone=+00:00'
   gcloud sql databases create <database> --instance=yc-mysql \
     --charset=utf8mb4 --collation=utf8mb4_general_ci
   gcloud projects add-iam-policy-binding $P --role=roles/cloudsql.client \
     --member=serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com
   ```
   `^~^` makes `~` the separator, because `sql_mode` contains commas. The flags and
   the database's default collation are load-bearing — §7. 20 GB rather than the 10 GB
   minimum because disk throughput scales with size.
   **Accounts:** set a generated root password (`gcloud sql users set-password root
   --host=% --instance=yc-mysql --password=…`), then create the app and read-only
   accounts with SQL as root through the Auth Proxy (§10): `CREATE USER` + `GRANT ALL
   PRIVILEGES ON <database>.*` for the app account, `GRANT SELECT ON <database>.*`
   for the read-only one. **Not `gcloud sql users create`** — it makes an account with
   near-superuser rights on every database. Generate the passwords (alphanumeric:
   dotenv cuts a value at `#`); never type one into a prompt.
   **Data:** `scripts/dbmigrate/` — `dump.sh` from the source, `gcloud sql import sql`
   for the data file, the trigger file applied as the app account, then `parity.js`.
   Order and reasons in its README.
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
     --add-cloudsql-instances=$P:$R:yc-mysql \
     --set-env-vars/--set-secrets ...   # fastest: edit the private svpcac.export.yaml
                                        # and `gcloud run services replace` it
   ```
   The export carries the Cloud SQL attachment too (annotation
   `run.googleapis.com/cloudsql-instances`); if the project or instance name changed,
   fix it there and in `INSTANCE_CONNECTION_NAME` together.
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
12. **Smoke:** app loads over `https://app.4lsg.com`; DB queries succeed (with
    `INSTANCE_CONNECTION_NAME` set there is no fallback to `host`, so a working query
    proves the Cloud SQL attachment + the `cloudsql.client` role); if the NAT chain
    was built, an outbound-IP check from inside the app equals the reserved IP;
    scheduler tick processes a job; a `mailbox-ingest` tick advances
    `mailboxes.ingest_state.<folder>.checked_at`; a test push deploys end-to-end.

## 7. Gotchas

- **The NAT IP is no longer load-bearing for the database** (Cloud SQL socket). It is
  still the app's fixed egress address: before releasing `api-4lsg-ip` or switching the
  NAT to AUTO_ONLY, confirm no outside service allowlists it (§1).
- **Cloud SQL: `--database-flags` REPLACES the whole set.** Changing or adding one flag
  means restating all of them, or the others silently reset to defaults:
  `sql_mode=NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`,
  `lower_case_table_names=0`, `log_bin_trust_function_creators=on`,
  `default_time_zone=+00:00`. Same for `--authorized-networks`: it replaces the list.
  Some flag changes restart the instance.
- **`sql_mode` is an explicit choice, not a default.** MySQL 8.4's default is strict +
  `ONLY_FULL_GROUP_BY`; the app relies on both being absent, so an instance created
  without the flag breaks case listing and case inserts on day one. Check the server
  value with `SELECT @@GLOBAL.sql_mode` from a mysql client — a query run through the
  app shows one extra mode, `IGNORE_SPACE`, which the mysql2 driver requests per
  connection and which must NOT be copied into the flag.
- **The database's default collation is `utf8mb4_general_ci`**, not the 8.4 default.
  Existing tables name their collation; a new table created without one inherits the
  database default, and a mismatch surfaces later as "Illegal mix of collations".
- **No server-side query time limit.** `max_execution_time` is 0 (the previous host
  enforced 30 s on every SELECT). The read-only API and reports set their own
  per-query limit; nothing else has one, so a runaway SELECT runs until its
  connection closes.
- **`wait_timeout` is 28800 s** (the previous host: 60 s). The pool's 30 s idle
  recycling in `startup/db.js` was sized for the old value and is merely conservative
  now.
- **After any instance restart the buffer pool is cold** (weekly maintenance window, a
  tier or flag change): first-touch scans of the big log tables take seconds for a
  few minutes. Not a fault.
- **No phpMyAdmin.** Ad-hoc SQL: Cloud SQL Studio in the console, or a local client
  through the Auth Proxy (§10). An 8.4 `mysql` client on the proxy's plain-TCP port
  needs `--get-server-public-key` (otherwise `ERROR 2061 … requires secure
  connection`); the Node driver does that exchange by itself.
- **Triggers are owned by the app account** (no host-specific DEFINER). Create new
  ones logged in as that account, or name it in the DEFINER clause: a trigger whose
  definer does not exist fails every write to its table.
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
echo "== sql";       gcloud sql instances describe yc-mysql --project=$P \
                       --format='yaml(databaseVersion,region,gceZone,state,connectionName,settings.tier,settings.edition,settings.availabilityType,settings.dataDiskSizeGb,settings.dataDiskType,settings.storageAutoResize,settings.databaseFlags,settings.backupConfiguration,settings.maintenanceWindow,settings.deletionProtectionEnabled,settings.ipConfiguration.authorizedNetworks)'; \
                     gcloud sql users list --instance=yc-mysql --project=$P; \
                     gcloud storage ls gs://lsg-yc-migration/
} 2>&1 | tee /tmp/infra_dump.txt
```

Diff the output against this file during docs review; divergences get fixed here or
filed in scratch `ns=docs`. The `== run yaml` section contains secret values, and the
`== sql` section the instance's address, an allowlisted address and the account names
— never commit the dump. `gcloud storage ls` should print nothing (§2).

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
(`^#^…#…`). The alternative that avoids the separator question: write the complete
variable set to a JSON file and deploy with `--env-vars-file`. That flag REPLACES every
variable on the revision, so the file must hold all of them, each value a string.
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

## 10. Local development against Cloud SQL

A developer machine has no `/cloudsql` socket. It connects through the **Cloud SQL Auth
Proxy**: a local process that listens on `127.0.0.1:3306` and tunnels to the instance
using the developer's own Google login. No IP allowlist, no database port open to the
internet, nothing to update when the laptop changes networks.

**One-time setup (new machine or new developer).**

1. Install the proxy: `brew install cloud-sql-proxy` (macOS). Other systems: one
   binary from the `GoogleCloudPlatform/cloud-sql-proxy` releases page, on `PATH` under
   that name.
2. Give the proxy credentials: `gcloud auth application-default login` (browser; signs
   in as you). This is separate from `gcloud auth login` — the proxy reads the
   application-default credentials, not the CLI's.
3. The Google account needs **`roles/cloudsql.client`** on the project. A project
   Owner already has it. Anyone else, granted once by an Owner:
   ```
   gcloud projects add-iam-policy-binding lsg-api-425223 \
     --member=user:<their Google account> --role=roles/cloudsql.client
   ```
   That role only lets the proxy open the tunnel. Logging in to MySQL still takes a
   database account and its password.
4. `.env` (never committed):
   ```
   host=127.0.0.1
   DEV_SQL_PROXY_INSTANCE=lsg-api-425223:us-east1:yc-mysql
   database=…
   user=…
   password=…
   user_ro=…
   password_ro=…
   ```
   Do **not** put `INSTANCE_CONNECTION_NAME` in a local `.env`: it means "use the
   `/cloudsql` socket", which exists only on Cloud Run.
5. `git config core.hooksPath .githooks` (the pre-commit hook; `CLAUDE.md` →
   Commands & gates).

**Day to day there is nothing to start by hand.** `scripts/ensure-sql-proxy.js` starts
the proxy when it is not already listening, from three places: `npm run dev` (the
`predev` script), `npm run db:ref` / `db:ref:check`, and the pre-commit hook (both via
`scripts/dump-schema.js`). It is opt-in through `DEV_SQL_PROXY_INSTANCE`: a machine
without that line, CI and Cloud Run are untouched. The proxy is left running on
purpose — the next commit finds it there in about a millisecond.

**Listening is not working.** The proxy opens its port before it has talked to Google.
With expired credentials, or an account without the role, it starts, reports "ready
for new connections", accepts every connection and drops it without a byte — which a
MySQL client reports as `PROTOCOL_CONNECTION_LOST` / "The server closed the
connection", with no hint of the cause. And **a running proxy keeps the credentials it
started with**: signing in again does nothing until it is restarted. So the script
checks that a database actually answers through the port (the MySQL server speaks
first; one byte proves credentials, role, instance name and network together):

- a proxy it starts is always checked; one that does not connect is stopped again and
  the reason is read out of its log, with the command that fixes it;
- when a connection through an already-running proxy fails (`db:ref`, the hook), or
  on `npm run dev` / `npm run db:proxy`, the running one is checked too. A dead proxy
  that was started from here is replaced — that is what picks up fresh credentials.
  One started by hand is left alone and named as the problem: stop it yourself.

| | |
|---|---|
| `npm run db:proxy` | Start it, or check that the running one really reaches the database; replaces a dead one. |
| `npm run db:proxy:stop` | Stop the one started from here. |
| its output | `yc-sql-proxy.log` in the system temp dir; the path is printed when it starts. |

**When it does not work, the message says which of these it is:**

- `"cloud-sql-proxy" is not installed` → step 1.
- `Google credentials are missing or have expired` (the proxy logged `invalid_grant`,
  a reauthentication error, or `could not find default credentials`) → step 2 again,
  then rerun. Application-default credentials expire; expect this every so often.
- `The Google account you signed in with … may not connect to Cloud SQL` (the proxy
  logged `403` / `NOT_AUTHORIZED`) → step 3. Check which account step 2 signed in:
  it is the browser's choice, not `gcloud config`'s.
- `refused the API call for lack of a quota project` →
  `gcloud auth application-default set-quota-project lsg-api-425223`. (Sign-in
  warns `Cannot find a quota project to add to ADC` when gcloud has no default
  project on that machine; `gcloud config set project lsg-api-425223` before
  signing in avoids it.)
- `Google does not know the instance` → the `DEV_SQL_PROXY_INSTANCE` line.
- `something is listening on 127.0.0.1:3306 but no database answers through it, and
  it was not started from here` → a hand-started proxy with stale credentials, or a
  local MySQL on the port. Stop it — the port is fixed because `startup/db.js` and
  `scripts/dump-schema.js` pass `host` and no port.
- An ordinary MySQL error (`ER_ACCESS_DENIED_ERROR` …) means the tunnel is fine and
  the database login in `.env` is not.

In the pre-commit hook any of these prints `skipped: …` and **the commit goes through
anyway** — by design (a commit made offline must not be blocked). That commit did not
refresh `ref/database.sql`; `npm run db:ref` once the proxy works does. `npm run dev`
stops instead: the app is useless without a database.

**This is the production database.** A local `npm run dev` reads and writes live
client data; there is no staging copy. A local process that keeps writing during a
maintenance window (§9) is exactly the writer maintenance mode cannot stop — stop it,
or run `npm run db:proxy:stop`, first.

**Ad-hoc SQL as root or with a mysql client:** run a second proxy on another port —
`cloud-sql-proxy lsg-api-425223:us-east1:yc-mysql --port 3307` — then
`mysql --get-server-public-key -h127.0.0.1 -P3307 -u<account> -p`.
