# COMMS_ARCHIVE_DESIGN

Status: v3 — 2026-10-13. Nothing built. v1 was independently reviewed the same day (claims re-verified against the code, the live DB and vendor pages); v2 carried the review's amendments; v3 folds in Fred's answers (Q1–Q4, Q6–Q7, F1–F6, F8 → §0 and their sections; F2 = AssemblyAI, P7). Still open: Q5 (SS) and F7 (revoke at arc close). An execution manager runs the slices in §12.
Scope: a private, long-retention archive for communication media — call recordings and MMS files now, email raw + attachments later (mailbox S6) — plus the derived text for calls: transcripts and AI summaries. Covers capture, storage, access, purge, the pipeline, and where the results surface (Comms hub, case/contact views, Documents tab, search).
Related: `claude/RECORDINGS_OPTION_A_REVIEW.md` (claude.ai Project — the Option A review: SS-facing summary, vendor comparison, cost model; this doc supersedes its §2 design notes), `ref/MAILBOX_SYSTEM_DESIGN.md` (D1, D6, §4.4 S-PH, S6), `ref/plans.md` (phone-tab follow-ups), `ref/AUDIT_TENANCY.md` (open decision 15: GCS per tenant), `ref/INFRA_GCP.md`, AI_CONTEXT §28 (phone ingest). Arc state: scratch `fred/recordings_arc`.
Verified against: `main` @ `0b9d788`, the live DB, and the RingCentral / Quo APIs on 2026-10-13; §2 figures and §11 vendor pricing re-measured at the same day's review. §4's IAM permission set: Google's published role reference, 2026-10-14.

## 0. Decisions

### Ratified

- **R1 — Retention: keep everything at least 10 years** ("forever" to start). SS via Fred, 2026-10-13. Nothing in the archive deletes on a schedule.
- **R2 — GCS Archive storage class.** Fred, 2026-10-13.
- **R3 — One archive for all comms media.** Recordings, MMS, and (mailbox S6) email raw + attachments share one bucket, one registry, one access path. Fred, 2026-10-13; mailbox-arc handover memo, same day.
- **R4 — Archive first.** The archive slice (S1) may start before SS answers the policy questions in §14. Fred, 2026-10-13. Reason: RingCentral deletes recordings at 90 days (§2), about 26 a day.
- **R5 — Option A** (Fred, 2026-10-13, after the review demoted it to Q3): every archived call transcribed and summarised, ~$20/month all-in. Per-call escape hatches: `comms_no_transcribe`, Restrict, Purge.
- **R6 — Access follows the call log** (Q1): whoever can read a line's call log can read its content; no stricter per-line grant for now (§7).
- **R7 — Derived text lives as long as the audio** (Q4): transcripts and summaries keep the R1 retention.
- **R8 — Label on every transcript and summary** (Q6): "AI-generated — check the recording before relying on it".
- **R9 — Restrict, Purge and `comms_no_transcribe` belong to SU and SS** (Q2, Q7; may widen later). Personal calls get no auto-hide flow — `personal` flags are informational; the remedy for a private call is Restrict or Purge.

### Constraints (from facts and other arcs — not up for review here)

- **C1 — No native vendor AI.** RingCentral: `ReadCopilotCallNotes` is not offered to our app, the `AI` scope is absent from the developer console, and RingSense is granted but returns no data (`RAH-3001` for every id). Quo: transcripts and summaries return 404 without the Business plan. Verified 2026-08-31 and 2026-10-13.
- **C2 — Grant checks go through `services/mailboxService.js`** (`getAccess` / `listReadable(db, user, 'phone_line' | 'mailbox')`), never re-implemented. Mailbox design D6: SU everything; attorneys read every mailbox and every phone line; everyone else their `channel_grants`; checks sit on INTERACTIVE routes only, jobs and automations are grant-blind.
- **C3 — `public/comms.html` is mailbox-arc owned.** Rebase on main, one `comms.html` slice at a time, tell the mailbox manager (via Fred) before landing. Gates: `node scripts/mobile-survey/survey.js --widths 320,375,414`, `scripts/mobile-survey/commsDensity.js` (also gates modal stacking), zero `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` in the file.
- **C4 — Mailbox S6 (email onto this archive) is the mailbox arc's slice,** not before the Gmail parity window closes (~2026-10-25; per the handover memo it freezes `mailboxIngestService.js`, `imapTransport.js`, `emailIngestService.js`, `routes/mailboxIngest.js` — that list is memo-only, not in-repo). Email objects key on `message_id`, never the IMAP UID (Migadu renumbers). Copying email attachments at ingest would amend mailbox D1 — their call.
- **C5 — The phone ingest workflows are untouched.** wf17 (`wf_rc_message_in`), wf18 (`wf_quo_message`), wf19 (`wf_rc_message_out`), wf20 (`wf_rc_call`), wf21 (`wf_quo_call`) keep writing `phone_event_log` and `log` as today. Everything here reads what they already store; no trigger-rule edits (the DELETE+REINSERT landmine stays out of play).
- **C6 — Byte-serving rules (CLAUDE.md):** authored bytes never serve executable on the app origin; any byte route on the app origin copies the documents-raw allowlist + `nosniff` pattern (`routes/api.documents.js` `RAW_INLINE_MIME`).
- **C7 — Vendors must not train on our data.** ABA Formal Opinion 512 (2024-07-29): client information goes into a self-learning tool only with the client's informed consent, beyond boilerplate. Every vendor account carries its no-training setting **before the first byte of client audio is sent** — including the S0 spike.

### Proposed — ratify at review

- **P1 — Own registry tables, not `documents` rows.** `comms_media` (archived binaries) and `comms_transcripts` (derived text), §5. *Why not `documents`:* the documents routes (`/api/documents/*`, including `/:id/raw`) are firm-wide behind `jwtOrApiKey` with no per-user ACL, and the 154k Dropbox rows rely on that. Putting grant-scoped content into that registry means every documents route must learn a source-specific grant check, and any route that misses it serves privileged audio firm-wide — fail-open. The Documents tab still shows archive items (S5), fetched through the archive's own grant-checked API, with the log-style anchoring Fred described (phone / email / docket, resolved at read time, plus manual link).
- **P2 — Bucket** `lsg-yc-comms-archive` (matches `lsg-yc-migration`), us-east1, spec in §4. (F1: name ratified 2026-10-13.)
- **P3 — Deletion posture:** no bucket retention policy and never Bucket Lock; soft delete 30 days; SU Restrict + Purge (§8); delete detection (§10). Replaces the review's first-draft "delete-less service account", withdrawn 2026-10-13: it pushed every purge into Cloud Shell for little protection beyond soft delete + an alarm, and the runtime service account is the default compute SA, which can do everything anyway (`ref/INFRA_GCP.md`).
- **P4 — Sweepers, not ingest hooks.** Recurring internal functions over `phone_event_log`, on the `documents_sync` model: bounded work per tick, fail-closed kill switch read uncached through `settingsService.getSetting`, idempotent on the source row (§6). Phone ingest emits no domain event today, and a sweeper also absorbs provider lag (recordings appear after the call ends) and retries.
- **P5 — Serving by V4 signed URLs** on `storage.googleapis.com`, 5-minute TTL, issued only after the grant check (§7). Needs the runtime SA to sign (`roles/iam.serviceAccountTokenCreator` on itself + IAM Credentials API) — no key file. Fallback if that is refused: an app-origin byte route with Range support under C6.
- **P6 — Scope rules (Option A — R5):** archive every non-suppressed recording and MMS file; transcribe talk time ≥ 15 s; summarise ≥ 30 s; never transcribe numbers on `comms_no_transcribe` (audio still archived; list maintained by SU / SS — R9).
- **P7 — STT vendor: AssemblyAI Universal-3.5 Pro + diarization** (Fred, 2026-10-13 — F2: same-hour turnaround for +$2.8/month over GCP batch; whole multi-hour files, no chunking; keyterm hints). The no-training opt-out (a free dashboard toggle on paid plans) is set BEFORE the first upload — C7; the vendor-side transcript is deleted right after fetch. S0 validates quality on our audio against the written rubric; fallbacks if it fails: Google STT v2 Chirp 3 dynamic batch (cheaper, up-to-a-day, 20-min chunking), then OpenAI `gpt-4o-transcribe-diarize` (zero vendor retention, ~2× the batch price). Deepgram dropped: v1's claim that its no-training opt-out roughly doubles the price is unsupported by any official page (re-checked 2026-10-13), and its $200 signup credit is one-time, irrelevant to a forever-retention design.
- **P8 — Summary model: Sonnet 5.5 default** (`claude-sonnet-5-5`), with a Haiku 5.5 (`claude-haiku-5-5`) eval in S0. Grounded extraction: every extracted item carries a quote that must occur in the transcript, or it is dropped (§6.4). Nothing auto-creates tasks or deadlines.
- **P9 — Every content access is audited** (view transcript, view summary, listen, open MMS) in `admin_audit_log`, `tool='comms_archive'`. The table has no action column: the action and `comms_media.id` go in `details` (the `grant_create` / `mint` precedent), the outcome in `status`, and `route`/`method` are NOT NULL — the `reqMeta(req, tool)` pattern in `routes/api.phoneComms.js`.
- **P10 — MMS capture rides S1** with recordings (mailbox handover recommendation).

## 1. Goal

Nothing the firm said or received on a call or in a picture message is lost to a vendor's retention, and anyone entitled to a call can read what was said, see a summary that pulls out what a bankruptcy file needs, and listen to check it — from the Comms hub, the client's case and contact pages, and the Documents tab.

Non-goals: live / in-call transcription; auto-created tasks or deadlines; replacing the phone systems' own recording.

## 2. Live facts (2026-10-13)

| | Measured |
|---|---|
| Volume, Jul–Sep monthly average | RC ~794 calls with talk time, 3,235 recorded min (re-measured 2026-10-13; v1 ran ~9% low). Quo ~105 calls, 144 min (~107 recorded). **~3,340 recorded min/month, ~897 calls with talk time** |
| Concentration | Line 2485592400 = 94% of RC minutes |
| Length mix | < 30 s: 16% of calls, 1.4% of minutes. > 30 min: 2.5% of calls, 34% of minutes (long outbound calls to institutional numbers, mostly hold queues). Longest ~4 h |
| Party match (RC minutes) | 40% contact on a case · 12% contact, no case · 48% number not in `contact_phones` |
| **RC recording retention** | **90-day hard delete** (RC-documented: 90 days or 100k recordings/account, whichever first): 89 days → 200, 90–135 days → 404 `CMN-102`. ≈ 26 recordings/day cross it |
| RC MMS retention | No cliff seen: the oldest MMS (2026-06-01, 134 days) still returns 200 |
| Quo recording retention | No age cliff on the office line (134-day recordings present), but 4 recordings on 2489655355 present on 2026-08-31 are gone by 2026-10-13. Not durable |
| Quo recording coverage | Recent answered calls with a recording: 2484179800 23/23, 2489654574 8/14, 2489655355 0/3 |
| Quo MMS links | The `share.quo.com` URL stored in `log.log_data` expires (June link → 403). `GET /v1/messages/<provider_ref>` returns a freshly signed link that works |
| MMS volume | Quo ~8/month; RC 48 / 34 / 11 / 22 / 7 (Jun–Oct). 155 MMS texts since 2026-06-01; per message: jpeg ~74, png ~46, pdf ~23 (18 of them Quo), video/3gpp 5, audio/mp4 2, vcard 1 — Quo refs are url-only, typed by extension; v1 counted only RC contentType and missed Quo media (`ref/plans.md`) |
| Join keys | RC call: `raw_extra.recording_id` (~97% of rows). **Quo call: `raw_extra.recording_id` is an empty string on every row (530/530)** → `GET /v1/call-recordings/<provider_ref>`. MMS: `log.log_data.attachments` via `phone_event_log.log_id` (RC `{id,type,contentType}`; Quo signed URL) |
| RC ingest gaps | ~2.5% of RC call rows (97 rows) carry no call-log data (`provider_ref` `tsi:<telephonySessionId>`); `call-log?telephonySessionId=` recovers them (3 sampled: unrecorded hang-ups) |
| Formats | RC: MP3 32 kbps, 16 kHz, mono (~0.24 MB/min). Quo: MP3 64 kbps, joint stereo (~0.48 MB/min) |
| RC rate limits | Recording metadata + content: **Heavy** (10/min). Message content: Medium (40/min). Live call ingest also spends Heavy (call-log) |
| Credentials | 9 RingCentral (oauth2; `platform.` + `media.ringcentral.com`); 10 Quo (api_key; `api.openphone.com` + `share.quo.com`); 12 Claude (api_key) |
| DB | Cloud SQL MySQL 8.4.11; `innodb_ft_min_token_size` 3 |
| Existing GCS | `services/storageService.js` → `gcs_bucket` is **world-readable** (public URLs). Never used for archive content |

## 3. Architecture

```
TIER 1 (exists, unchanged)        ARCHIVE (this design)                   DERIVED TEXT (this design)
phone_event_log  ──┐
log.log_data       │  comms_archive_sweep (every 2 min)
 .attachments ─────┼─► fetch via adapter ──► gs://lsg-yc-comms-archive ─┐
                   │   (RC cred 9 / Quo cred 10)   + comms_media row      │
                   │                                                      ▼
                   │                         comms_transcribe_sweep ─► STT vendor ─► comms_transcripts
                   │                                                      │            (segments, FULLTEXT)
                   │                                                      ▼
                   │                         comms_summarize_sweep ──► aiService (Sonnet 5.5) ─► summary JSON
                   │                                                                 (grounding check)
                   ▼
SURFACES (grant-checked via mailboxService):  Comms call bubble · MMS in sms bubbles · case/contact
log entries · Documents tab · transcript search.  Bytes: V4 signed URL (5 min) after the check.
```

Boundaries:
- **Tier 1 stays the truth for "a call happened."** `phone_event_log` and the `log` row are never deleted or rewritten by this arc. Purge removes content, not the record of the call.
- **Archive = bytes + registry.** `comms_media` says what we hold, where, its hash, and its state. One row per archived file.
- **Derived text = `comms_transcripts`,** one row per transcribed recording, keyed to its `comms_media` row.
- **Provider specifics live in the phone adapters** (`services/adapters/phone/ringcentral.js`, `quo.js`), which gain fetch functions (§6.1). The archive service never builds provider URLs itself.

## 4. Storage

**Bucket `lsg-yc-comms-archive`** (P2):
- Location `us-east1` (same as Cloud Run and Cloud SQL). Default storage class **Archive** (R2): $0.0012/GiB-month, $0.05/GiB retrieval, 365-day minimum, millisecond access (no restore wait).
- Uniform bucket-level access; public access prevention **enforced**.
- **Soft delete 30 days** (allowed 7–90; 0 disables). A soft-deleted object cannot be permanently removed before its window ends; the policy in force at deletion time applies to it.
- **No retention policy, no Bucket Lock, no lifecycle delete rule, versioning off.** "10 years" (R1) is the absence of deletion, not a rule that forbids it (P3).
- Encryption: Google-managed. CMEK not proposed.
- IAM: runtime SA `618099140949-compute@developer.gserviceaccount.com` — `roles/storage.objectUser` on this bucket only: `storage.objects.create`, `get`, `list`, `delete`, `update`, `move`, `restore` (plus multipart uploads) — the narrowest predefined role with create + get + list + delete; `objectAdmin` adds only object IAM and `setRetention`. The archive sweep's pre-flight requires create, get and list (list for stat-first by prefix); purge needs delete. `roles/iam.serviceAccountTokenCreator` on itself, and the IAM Credentials API, for V4 signing (P5). If GCP STT is chosen, the Speech service agent gets object read on the bucket.
- Infra: `scripts/commsArchive/s0_infra.sh` (Cloud Shell; stages `precheck`, `bucket`, `iam`, `env`, `verify`, `status`, `rollback`; dry-run harness in `s0_harness/`). Result in `ref/INFRA_GCP.md`.

**Object names carry ids only** — no names, numbers or dates beyond year/month — so a leaked listing reveals nothing:

| Kind | Object name |
|---|---|
| Call recording | `phone/rec/<yyyy>/<mm>/<phone_event_log.id>-<part>.<ext>` |
| MMS file | `phone/mms/<yyyy>/<mm>/<phone_event_log.id>-<part>.<ext>` |
| STT vendor output | `phone/stt/<yyyy>/<mm>/<comms_media.id>.<vendor>.json` |
| Email raw / attachment (mailbox S6) | `mail/eml/…`, `mail/att/…` — the mailbox arc picks the shape |
| S0 probe (not client data) | `_s0/probe.txt` — permanent; the post-S1a signing check reads it. Delete detection and any "unregistered object" check skip the `_s0/` prefix |

`<part>` is the provider's recording / attachment id. Tenancy: a `<tenant>/` prefix or a bucket per tenant is AUDIT_TENANCY open decision 15; names above leave room for either.

**Config** (`lib/firmConfig` registry key, like `gcs_bucket`): `comms_archive_bucket`. **Kill switches and knobs** (`app_settings`, read uncached via `settingsService.getSetting`, fail-closed — exact string `'1'` enables): `comms_archive_enabled`, `comms_transcribe_enabled`, `comms_summarize_enabled`; numeric knobs `comms_min_transcribe_s` (15), `comms_min_summary_s` (30), `comms_stt_max_min_per_call` (e.g. 300), `comms_ai_monthly_cap_cents`.

## 5. Schema (proposed — S1 / S2 migrations)

Defaults follow `ref/SCHEMA_CONVENTIONS.md`: no `DEFAULT CHARSET` without `COLLATE` (inherit `utf8mb4_general_ci`), vocabularies are app-validated `VARCHAR`, every table and non-obvious column carries a COMMENT. Columns sized to what writes into them (non-strict `sql_mode` truncates silently).

```sql
-- S1
CREATE TABLE comms_media (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel       VARCHAR(8)   NOT NULL COMMENT 'phone | mail — app-validated',
  kind          VARCHAR(20)  NOT NULL COMMENT 'call_recording | mms_file | stt_raw | mail_raw | mail_attachment',
  source_table  VARCHAR(32)  NOT NULL COMMENT 'phone_event_log | mail_messages | comms_media (stt_raw)',
  source_id     BIGINT UNSIGNED NOT NULL,
  part          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'provider recording / attachment id; '''' = placeholder before the provider lists any',
  provider      VARCHAR(16)  NULL,
  channel_id    INT UNSIGNED NULL COMMENT 'phone_lines.id / mailboxes.id — the grant anchor (mailboxService.getAccess)',
  party         VARCHAR(20)  NULL COMMENT 'other party (10-digit) for phone — the log-style read-time anchor',
  object_name   VARCHAR(255) NULL COMMENT 'name inside comms_archive_bucket; NULL until archived',
  mime          VARCHAR(128) NULL,
  bytes         BIGINT UNSIGNED NULL,
  sha256        CHAR(64)     NULL,
  duration_s    INT UNSIGNED NULL,
  audio_channels TINYINT UNSIGNED NULL,
  captured_at   DATETIME     NULL COMMENT 'provider time of the call/message (UTC wall clock, pool convention)',
  state         VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending | archived | none | gone | failed | purged',
  restricted    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = SU/SS-only visibility (Restrict, §8)',
  attempts      INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME   NULL,
  last_error    VARCHAR(1000) NULL,
  archived_at   DATETIME     NULL,
  purged_at     DATETIME     NULL, purged_by TINYINT NULL, purge_reason VARCHAR(500) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_media_source (source_table, source_id, kind, part),
  KEY idx_comms_media_work (state, next_attempt_at),
  KEY idx_comms_media_party (party, captured_at),
  KEY idx_comms_media_channel (channel, channel_id, captured_at)
) ENGINE=InnoDB COMMENT='Comms archive registry (ref/COMMS_ARCHIVE_DESIGN.md). One row per archived file. Never deleted — purge clears content and stamps purged_*';

-- S2
CREATE TABLE comms_transcripts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  media_id      BIGINT UNSIGNED NOT NULL COMMENT 'comms_media.id (call_recording)',
  phone_event_id BIGINT UNSIGNED NOT NULL COMMENT 'phone_event_log.id — denormalised for joins',
  state         VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending | transcribing | transcribed | summarized | skipped | failed | purged',
  skip_reason   VARCHAR(32) NULL COMMENT 'short | no_transcribe | over_cap | policy',
  stt_vendor    VARCHAR(16) NULL, stt_model VARCHAR(48) NULL, stt_job_ref VARCHAR(191) NULL,
  language      VARCHAR(16) NULL, speakers TINYINT UNSIGNED NULL,
  segments      JSON NULL COMMENT '[{s:speaker,a:start_s,b:end_s,t:text}]',
  full_text     MEDIUMTEXT NULL,
  summary       JSON NULL COMMENT 'schema in COMMS_ARCHIVE_DESIGN §6.4',
  summary_text  TEXT NULL,
  summary_model VARCHAR(48) NULL,
  ai_call_ids   JSON NULL COMMENT 'ai_calls.id of every summary attempt — purge clears their request_excerpt/response',
  grounding_dropped SMALLINT UNSIGNED NULL,
  stt_cost_cents DECIMAL(10,4) NULL, llm_cost_cents DECIMAL(10,4) NULL,
  attempts      INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at DATETIME NULL, last_error VARCHAR(1000) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_transcripts_media (media_id),
  KEY idx_comms_transcripts_event (phone_event_id),
  KEY idx_comms_transcripts_work (state, next_attempt_at),
  FULLTEXT KEY ft_comms_transcripts (full_text, summary_text)
) ENGINE=InnoDB COMMENT='Transcript + AI summary per archived call recording';

CREATE TABLE comms_no_transcribe (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone      CHAR(10) NOT NULL,
  note       VARCHAR(255) NULL,
  created_by TINYINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comms_no_transcribe_phone (phone)
) ENGINE=InnoDB COMMENT='Numbers whose calls are archived but never transcribed or summarised (P6)';
```

States, `comms_media`:
- `pending` — known work, not yet fetched.
- `archived` — bytes in the bucket, `sha256` and `bytes` recorded.
- `none` — the provider has no file after the wait window (Quo staff lines often record nothing).
- `gone` — the provider returned not-found where a file was expected (past RC's 90 days, or deleted at the source). The cliff guard exists to keep this at zero.
- `failed` — retries exhausted on a non-404 error; alerts.
- `purged` — §8.

## 6. Pipeline

### 6.1 Archive sweep — `comms_archive_sweep` (S1)

Recurring `scheduled_jobs` row (`type:'recurring'`, `data:{type:'internal_function', function_name:'comms_archive_sweep'}`), every 2 minutes. Each tick, while time budget (≈ 45 s) and provider budgets last:

1. **Discover.** Insert `pending` placeholder rows (`part=''`) for:
   - calls in `phone_event_log` (`event_type='call'`, `suppressed=0`) with no `call_recording` row: RC rows carrying a `recording_id` or a `tsi:` ref; Quo rows that were answered (`started_at` < `ended_at` — Quo rows never carry a recording id, the recording list decides);
   - MMS texts whose `log.log_data.attachments` is non-empty and have no `mms_file` row.
   Oldest first within RC's window, so the backlog drains toward the cliff, not away from it. `INSERT IGNORE` on the unique key makes discovery idempotent across ticks and instances.
2. **Fetch.** Through the line's adapter (new functions, credentials via `buildHeadersForCredential`):
   - **RC recording:** recording id from `raw_extra.recording_id`. For `tsi:` rows, recover via `call-log?telephonySessionId=`. Then `media.ringcentral.com/…/recording/<id>/content`.
   - **RC MMS:** `…/extension/~/message-store/<provider_ref>/content/<attachment id>`. rc2 (2486213656) needs its own extension id (raw webhook `body.ownerId`, in `hook_executions` since 2026-05-19) — S1 resolves it.
   - **Quo recording:** `GET /v1/call-recordings/<provider_ref>` → 0..n recordings → one row each (`part` = recording id), each fetched from its signed URL.
   - **Quo MMS:** `GET /v1/messages/<provider_ref>` → fresh signed `media[].url` (the stored link is not reused).
3. **Store.** Stream to the bucket with `sha256` computed on the way, `ifGenerationMatch: 0` (never overwrite), then flip the row to `archived` in one UPDATE. A crash between upload and UPDATE leaves an object the next attempt finds by name and adopts after re-hashing.
4. **Pacing.** RC Heavy ≤ 3 calls/min from this sweeper (live ingest keeps the rest of the 10/min). On 429: honour `Retry-After`, end the tick. Backfill of ~2,200 RC recordings (measured 2026-10-13) ≈ 12 h at that pace — well inside the cliff.
5. **Retry.** Provider "not yet" (no recording right after the call): back off; after 24 h with nothing listed → `none`. Transient errors: exponential backoff, `failed` after N. A 404 for a file that was listed → `gone`.

### 6.2 Cliff guard (S1)

Every tick, after the work: any non-suppressed RC call row with a `recording_id`, older than 75 days, whose `call_recording` row is not `archived` / `none` / `purged` → `alerting.alert` (`source`, `kind`, `group_key` and `title` are required — it throws without them; `severity:'error'`, `dedup_key` per day). This is the alarm that matters: past 90 days the loss is permanent.

### 6.3 Transcription — `comms_transcribe_sweep` (S2)

Picks `archived` `call_recording` rows with no `comms_transcripts` row; inserts the row (`pending`, or `skipped` with a reason under P6), then submits and polls. Vendor: AssemblyAI (P7); GCP mechanics stay documented as the fallback:

- **Chosen — AssemblyAI Universal-3.5 Pro + diarization:** submit with a 1-hour signed URL, poll or webhook, multi-hour files whole, keyterm hints. Delete the vendor-side transcript (`DELETE /v2/transcript/<id>`) right after fetching it, so purge never has a vendor copy to chase.
- **Fallback — Google Chirp 3, dynamic batch:** `BatchRecognize` reading `gs://` directly, diarization on, `us` multi-region. Files up to 8 h, but word-level timestamps — which the segment times and Listen-jump need — cap audio at 20 min per file, so calls over ~18 min split into overlapping chunks (ffmpeg) and stitch: far more chunking than v1 assumed. Stereo bills per channel. Results can take up to a day.

Either way: vendor JSON → bucket as `stt_raw` (re-processable without re-transcribing); `segments` + `full_text` → row. Quo stereo: S0 decides between downmix-to-mono + diarization (one-channel price) and per-channel transcription (exact speaker split, billed per channel) — depends on whether Quo records one party per channel.

### 6.4 Summary — `comms_summarize_sweep` (S3)

`aiService.call` (credential 12) with a new `lib/aiPrompts` entry, `outputType:'json'`, the transcript as `userInput` (wrapped as untrusted data, so speech saying "ignore your instructions" is just text). Known context — the matched contact's name, case number(s) — goes in `vars`. Output:

```json
{
  "call_type": "client | prospect | creditor | trustee | court | opposing_counsel | agency | vendor | personal | spam | voicemail | other",
  "summary": "2–5 sentences",
  "parties": [{"speaker": "A", "role": "firm | client | other", "name": null}],
  "commitments":         [{"by": "firm | other", "what": "", "quote": "", "t": 0}],
  "dates":               [{"what": "", "date_text": "", "quote": "", "t": 0}],
  "documents_requested": [{"what": "", "quote": "", "t": 0}],
  "amounts":             [{"what": "", "amount_text": "", "quote": "", "t": 0}],
  "case_refs":           [{"text": "", "quote": ""}],
  "follow_up": {"needed": false, "why": ""},
  "flags": ["personal", "sensitive", "dispute"]
}
```

**Grounding check:** every item's `quote` must occur in `full_text` (whitespace- and case-normalised); items that fail are dropped and counted in `grounding_dropped`. `t` lets Listen jump to the moment. `personal` flags are informational (Q2: no auto-hide) — the remedy for a private call is Restrict or Purge (R9). Every rendered transcript and summary carries the R8 label. Speaker roles are inferred (mono diarization) and labelled as inferred.

Plumbing: `MODEL_PRICING` gains `claude-sonnet-5-5` ($2 / $10 per MTok) and `claude-haiku-5-5` ($0.10 / $0.50, prompts ≤ 100K tokens) — without them `ai_calls.cost_cents` logs NULL. `aiService` is sync; the sweep passes `timeout_ms` explicitly (the default is 20 s — 120 s is only the clamp ceiling) and raises `max_tokens` past the 1,024 default. The longest call (~4 h ≈ 48K tokens) fits inside the 120 s ceiling. In `ai_calls`, `request_excerpt` (2,000 chars) holds the SYSTEM text after `vars` substitution — contact name and case numbers, not the transcript; transcript-derived text exists only in `response` (capped at 100k chars) — `ai_call_ids` lets purge find both.

### 6.5 Guards

- Kill switches per stage (§4), fail-closed.
- Per-call STT minute cap (`comms_stt_max_min_per_call`; over cap → `skipped:over_cap`, surfaced for an SU to release).
- Monthly AI spend cap: month-to-date `ai_calls` + STT cost ≥ `comms_ai_monthly_cap_cents` stops transcribe/summarise and alerts. Archive never stops for cost (~$0.20/month).
- Every new internal function is a CTA exposure decision (CLAUDE.md): the three sweepers go on `CTA_FN_DENYLIST` (`services/ctaService.js`), like `cta_expiry_sweep` — every registry function needs `__meta` (tests/internal_functions.meta.test.js), so "carry no `__meta`" is not an option. Today's sweepers (`documents_sync` et al.) are CTA-eligible; denylisting these is a deliberate divergence. No public link should be able to start one.

## 7. Access, serving, audit

| Surface | Rule |
|---|---|
| Comms hub (phone tab) | `mailboxService.getAccess(db, user, 'phone_line', channel_id).can_read` |
| Case / contact views | The call's LOG row stays as visible as today. Summary, transcript, Listen and MMS bytes need the same line `can_read` (attorneys and SU pass through the D6 rules) — so content is never broader than the hub |
| Documents tab, search | Same check per item; items the viewer can't read are omitted, not shown as locked |
| `restricted = 1` | SU and SS only, everywhere (R9) |
| Sweepers, workflows | Grant-blind (C2) |

"Stricter than the call log" (e.g. attorneys-only content on 2485592400) is not expressible today: `channel_grants` has `can_read` / `can_send` / `can_manage`, nothing that separates reading a line's log from reading its content. If SS wants it (§14 Q1), it is a grants change in mailbox-arc code, designed with the mailbox manager — not built here.

**Bytes:** after the check, the API returns a V4 signed URL (5 min) with `response-content-type` from an allowlist and `response-content-disposition: inline` only for `audio/mpeg`, `audio/wav`, `audio/mp4`, `image/jpeg|png|gif|webp` and `application/pdf`. Everything else downloads as an attachment, and SVG / HTML never render inline (C6). A signed URL is a bearer link for its 5 minutes; short TTL plus the audit row is the control. The `<audio>` element seeks with Range requests, which storage serves natively.

**Text:** transcripts and summaries render with `textContent` only (C3 gate).

**Audit (P9):** `admin_audit_log` via `auditAdminAction` (`tool='comms_archive'`; `details.action` ∈ `listen`, `view_transcript`, `view_summary`, `open_mms`, `restrict`, `unrestrict`, `purge`, `release_cap` — the table has no action column), with user, `comms_media.id` in `details`, outcome in `status`, `route`/`method` via `reqMeta`. No content in the audit row.

## 8. Restrict and purge

Both limited to SU and SS (Q7 — may widen later), reason required, audited (§7). S1 ships them as API routes driven from the console (`apiSend`); a UI comes with S4.

- **Restrict / unrestrict** — flips `comms_media.restricted` (and hides the derived text with it). Reversible. For "this one is private" without destroying anything.
- **Purge** — irreversible, removes content everywhere we hold it:

| Copy | Purge does |
|---|---|
| Bucket: audio / MMS file + `stt_raw` | Delete → soft-deleted 30 days, then gone. Purging an object younger than 365 days incurs the Archive early-delete charge (cents — expected, not an anomaly). For immediate destruction an admin sets soft delete to 0, deletes, restores it (the policy at deletion time applies) — documented runbook, not an app feature |
| `comms_transcripts` | `segments`, `full_text`, `summary`, `summary_text` set NULL; `state='purged'` |
| `comms_media` | `state='purged'`, `purged_at/by/reason`; `object_name` kept so the tombstone says what was removed |
| `ai_calls` (rows in `ai_call_ids`) | `request_excerpt`, `response` set NULL |
| STT vendor | Nothing left: AssemblyAI's copy is deleted right after fetch, and the account's data TTL (30 days, set 2026-10-14; may drop to 7 later) removes anything a failed delete leaves; Google returns results on the job's operation with no separate transcript store (confirm retention of the operation result in S0) |
| Anthropic API | Standard API retention is ~30 days (ZDR is gated opt-in; the newest models are excluded from it) — a purge is complete at Anthropic ~30 days after the last summary attempt. Not trained on without opt-in |
| Cloud SQL backups | Not editable; the content ages out with backup retention (instance setting — F5: the current value stands; record it here during S1) |
| RingCentral / Quo originals | RC deletes at 90 days; Quo — delete in the Quo app if needed. Purge reports this, it doesn't do it |

The `log` row and the `phone_event_log` row stay: that a call happened is the firm's record. Removing those too is a separate, explicit decision outside this design.

## 9. Surfaces

- **S4 — Comms hub** (C3 lane): the call items of `GET /api/phone-lines/:id|all/conversations/:party` (`routes/api.phoneComms.js`, `services/phoneCommsService.listMessages`) gain `archive: {media_id, has_audio, has_transcript, summary_text, restricted}` — only what the viewer may read. `callBubble` shows the summary as the bubble text with **Listen** and **Transcript**. SMS items gain `attachments` (images inline, PDF/other as a file chip — PDFs are ~15% of MMS, not rare), replacing "Attachment — not shown here yet". Freshness: the phone tab has no live update path (no ycSync matcher, no poll — manual refresh and post-send recheck timers only); archive fields ride the conversations fetch, so a bubble fills on the next refresh after the pipeline catches up — minutes (AssemblyAI, F2).
- **S5 — Case / contact / Documents:** call log entries on case and contact views show the summary line and the same buttons (log reader unchanged, content via the archive API). The Documents tab lists archive items next to Dropbox documents, fetched through the archive API: anchored like logs — phone (date-windowed against `contact_phones`, so a recording attaches the day its number is added to a contact), email and docket for mail later — plus manual link, and a **Save to case Dropbox** action (F8: yes — copy the archived bytes into the case folder through the documents upload path, so the copy becomes an ordinary document). The documents registry and its routes are not touched (P1).
- **S6 — Search:** `MATCH(full_text, summary_text) AGAINST(? IN BOOLEAN MODE)` scoped to the viewer's readable lines, newest first, snippets from `segments`. Words under 3 characters aren't indexed (`innodb_ft_min_token_size`).

## 10. Alarms and observability

| Alarm | Severity (CLAUDE.md convention) |
|---|---|
| Cliff guard (§6.2) | error |
| `failed` rows (archive / transcribe / summarise) | warning first per subject, error on repeat |
| Credential 9 refresh failure (stops the RC side) | the sweeper warns on `no_auth`, error on repeat (whether the `refresh_expiring_oauth_credentials` job already alerts: check in S1) |
| Delete detected outside a purge | error |
| AI monthly cap reached | warning, then error if it holds 24 h |
| Transcription backlog older than 48 h | warning |

**Delete detection (F3):** a nightly rolling stat of 1/14 of `archived` objects — every object checked within the 30-day soft-delete window, so any unexplained delete is caught while still restorable; recorded in `ref/INFRA_GCP.md` at S1. (The alternative, a Pub/Sub `OBJECT_DELETE` push, was declined as the more moving parts; if ever adopted, the push subscription authenticates with an OIDC token the endpoint verifies — never an open endpoint.)

**Health:** an SU status read (counts by state, oldest pending per stage, month-to-date cost) — an Admin pane panel (F4; `tools` pages are for personalized pages and quick no-deploy mockups).

## 11. Cost (Jul–Sep volume, re-measured 2026-10-13; the Option A review's figures run ~9% low)

Full-corpus (Option A) costing at ~3,340 recorded min/month — F2 chose the AssemblyAI column (same-hour for +$2.8/month); the GCP column stays as the fallback costing:

| | GCP Chirp 3 + Sonnet 5.5 | AssemblyAI + Sonnet 5.5 |
|---|---|---|
| Transcription | $10.03 / month | $12.81 / month |
| Summaries | $7.94 / month | $7.94 / month |
| Archive (ops, retrieval, storage) | ~$0.20 / month | ~$0.20 / month |
| **Total** | **~$18.2 / month (~$220 / yr)** | **~$21.0 / month (~$250 / yr)** |

- Q3 answered: Option A at ~$20/month (R5). The case-matched hybrid (40% of minutes, ~$8–9/month) stays the fallback if exposure concerns resurface.
- Archive growth: ~0.8 GiB/month (~10 GiB/year); 10-year cumulative storage ≈ $7.
- One-time backfill of what still exists (~2,200 recordings, ~9,700 min): ~$55–65 including summaries.
- With AssemblyAI chosen, GCP-side spend is just the archive (~$0.20/month); STT and Anthropic bill on their own invoices. GCP budget (F6): $100/month, alerts at 75 / 90 / 100% — fits either way, no raise.

## 12. Slices

Each slice independently deployable; deploy order SQL → backend → frontend; full jest before and after; `node --check` on every touched JS (and extracted inline scripts).

| Slice | Content | Done when |
|---|---|---|
| **S0 — Spike + infra** | Bucket + IAM + signing (Cloud Shell script, house rules). Vendor accounts with no-training set BEFORE any upload (C7). 20–30 real calls through AssemblyAI (P7; run the GCP fallback only if the rubric fails): short, > 1 h, Quo stereo, noisy, names / case numbers / amounts. Summary eval (Sonnet 5.5 vs Haiku 5.5) against a written rubric. Resolve rc2's extension id | P7 validated (or the fallback invoked), P8 and the Quo-stereo choice recorded in §0; measured turnaround and accuracy recorded in §2 |
| **S1 — Archive** | Migration `comms_media`; `comms_archive_bucket` config + kill switch; archive service (put / stat / signed URL / remove); adapter fetch functions; `comms_archive_sweep` for recordings AND MMS; cliff guard; delete detection; SU restrict / unrestrict / purge routes (bucket + DB parts that exist); CTA denylist entries | Backfill drained; cliff guard quiet for 7 days; no `gone` rows created after go-live; purge proven end to end on a test object |
| **S2 — Transcribe** | Migrations `comms_transcripts`, `comms_no_transcribe`; `comms_transcribe_sweep`; chunking (only if the GCP fallback is invoked); `stt_raw` to archive; vendor-side delete; caps | Every eligible archived call transcribed within the latency target; purge clears transcript columns |
| **S3 — Summarise** | Prompt in `lib/aiPrompts`; schema; grounding check; `MODEL_PRICING` 5.x; `comms_summarize_sweep`; monthly cap; purge extended to `ai_calls` | Eval rubric passes on a fresh sample; `grounding_dropped` rate reported |
| **S4 — Comms surfaces** (C3) | Call items + `callBubble`; Listen; Transcript viewer; MMS in SMS bubbles; audit; restrict / purge UI; health read | Mobile survey + `commsDensity.js` green; security greps zero; grant matrix tested (SU / attorney / granted / ungranted / restricted) |
| **S5 — Case, contact, Documents** | Log entries show summary + buttons; Documents tab lists archive items through the archive API, phone-anchored like logs, manual link; Save-to-case-Dropbox (F8) | Same grant matrix on these surfaces |
| **S6 — Search** | FULLTEXT search route + UI, grant-scoped | Ungranted lines never appear in results (tested) |

Mailbox S6 (email raw + attachments) consumes this archive after ~2026-10-25 under C4 — their slice.

## 13. YC3 / tenancy

- Tables are tenant-local — compatible with DB-per-tenant as-is.
- Bucket: per-tenant bucket vs `<tenant>/` prefix is AUDIT_TENANCY open decision 15; object names (§4) leave room for either, and `comms_archive_bucket` is a firm-config key, not a constant.
- The sweepers are cron-fired jobs like the mailbox ingest pass: they must eventually carry explicit tenant identity (`ref/MAILBOX_SYSTEM_DESIGN.md` §6).
- Phone numbers and line ids are data, never constants in code (implied by AUDIT_TENANCY §B2's blast-radius table; stated as a rule only here).

## 14. Open questions

Answered 2026-10-13 by Fred, folded into §0 and the sections: Q1 → R6; Q2 + Q7 → R9; Q3 → R5; Q4 → R7; Q6 → R8 (and spawned the deferred editable-derived-text idea, `ref/plans.md`); F1 → P2; F2 → P7 (AssemblyAI — same-hour for +$2.8/month; S0 validates against the rubric); F3, F4 → §10; F5 → §8; F6 → §11; F8 → §9 S5.

**Still open:**
1. **Q5 (SS):** does the engagement letter / recording notice cover transcription? SS owns the legal read; nothing in S0–S1 waits on it (R4).
2. **F7 (arc close):** revoke the temp Quo API key (minted 2026-08-31) and delete `routes/api.temp.ringcentral.js` once S1 has its own fetch path — §15 carries the reminder. (The route header's claim that credential 9 lacks `media.ringcentral.com` is stale: the live allowlist has it, verified 2026-10-13.)

## 15. At arc close — where learnings go

Per CLAUDE.md's routing table:
- `ref/AI_CONTEXT.md`: a comms-archive section (registry, states, sweepers, grant rule, purge scope).
- `manual/` (Admin tools): kill switches, restrict / purge, alarms, health read — operators' view.
- `ref/INFRA_GCP.md`: bucket, IAM, signing, delete detection.
- Schema COMMENTs via the migrations.
- `ref/plans.md`: deferred items (live transcription, per-tenant buckets, stricter grants if wanted later, editable derived text).
- **F7 reminder:** revoke the temp Quo API key and delete `routes/api.temp.ringcentral.js` — the arc is not closed with them alive.
- This doc stays as the design contract, edited in place as slices land.
