# MAILBOX_SYSTEM_DESIGN

Status: DRAFT v3 — 2026-10-08. D1–D4 decided; remaining OQs open. No code yet.
Scope: YisraCase-native mailbox subsystem — many-to-many user↔mailbox access, per-user mixed inboxes, ingest + send on top of a commodity mail host.
Related: `ref/EMAIL_PROVIDER_PLAN.md` (provider migration; this is its S2), access-control arc (roles), about-link/case-link machinery, email-ingest rules engine, YC3 tenancy plan.

## 0. Decisions (2026-10-08)

- **D1 — Storage:** metadata + text bodies inline in MySQL; attachments NOT copied at ingest — structure only, fetched on demand from IMAP; GCS archival (raw .eml + attachments) is a later slice behind reserved pointer columns. Nothing gates on the Cloud SQL move.
- **D2 — Coupling:** core is built to the protocols — IMAP (ingest/read) + SMTP via existing adapters (send) — which de facto covers any standards host. Provider-specific code is confined to an optional **provisioning driver** (Migadu first). Credential *acquisition* is the driver's job; credential *use* is always generic IMAP/SMTP — the transport never knows which provider it's talking to. API-transport providers (Gmail API, MS Graph) are out of scope for the core; if YC3 ever needs tenant-BYO Gmail/M365, evaluate embedding EmailEngine rather than hand-building.
- **D3 — Credential model:** preferred: per-mailbox **Migadu identities** — YC gets its own login per mailbox, independent of the human's password (rotation-safe, individually revocable). Pending trial test T1. Fallback if identities can't do IMAP login: YC-issued mailbox passwords (Fred mints them, so rotation stays controlled). Either way `mailboxes` stores plain host/user/secret and the transport is unaffected.
- **D4 — Worker placement / ingest mode:** prod is Cloud Run (`svpcac`) — no box, no systemd. v1 ingest is **poll-based**: Cloud Scheduler (or Cloud Tasks) hits an authenticated job endpoint every 5 min (config knob), lock-guarded and bounded per run (§4.1). Latency parity with today: the Apps Script source lands on a ~5-min cadence in `email_ingest_executions`. IMAP IDLE is deferred — revisit only if the VM per `ref/plans.md` lands or a real latency requirement appears; then a dedicated Cloud Run service (min=max=1, CPU always allocated), which still needs reconnect logic + the lock (rolling deploys overlap instances).

**Trial tests (run during Migadu trial, before S1):**
- T1: create mailbox + identity; attempt IMAP login with identity credentials; confirm it reads the mailbox. Result selects D3 mode.
- (MS first-contact deliverability test lives in EMAIL_PROVIDER_PLAN S1.)

## 1. Goal

Every user gets personal inbox(es); some users hold several addresses (billing@4lsg + shoshana@mdbl); users can be granted read and/or send access to others' mailboxes; SU and SS see everything; each user composes a "mixed inbox" from the mailboxes they can read, with custom saved views. YisraCase is the access-control and UI layer; the provider supplies storage and transport.

## 2. Architecture boundary (per D2)

```
                      ┌────────────────────────────┐
  Migadu admin API ──▶│ provisioning driver (opt.) │  mints mailboxes/identities,
  (or manual panel)   └──────────┬─────────────────┘  writes credentials rows
                                 ▼
                     mailboxes table (host/user/secret — provider-blind)
                                 ▼
          ┌──────────────────────┴──────────────────────┐
          ▼                                             ▼
  imapTransport.js (ONE module owns all IMAP)    emailService + adapters (send, exists)
          ▼                                             ▼
  ingest worker → canonical envelope → emailIngestService (rules/suppression/case-link, exists)
                → mail_messages
```

- All IMAP calls live in `services/mailbox/imapTransport.js` — not an interface framework, just discipline. A future JMAP module would be a sibling, added only when real.
- Hostnames/ports are config/row data, never constants.
- Useful property: the ingest worker can be **piloted against the existing Workspace account over Gmail IMAP** before Migadu holds real mail — the pilot is decoupled from the migration timeline.

## 3. Schema

```sql
mailboxes (
  id INT UNSIGNED PK AI,
  address VARCHAR(255) UNIQ,
  domain VARCHAR(128),
  display_name VARCHAR(128),
  imap_host VARCHAR(255), imap_port INT DEFAULT 993, imap_user VARCHAR(255),
  imap_secret TEXT,                   -- encrypted, same crypto pattern as email_credentials.smtp_pass
                                      -- (identity creds or mailbox password — transport doesn't care, per D3)
  send_credential_id INT NULL,        -- FK email_credentials; NULL = read-only mailbox
  ingest_enabled TINYINT(1) DEFAULT 1,
  ingest_state JSON,                  -- per-folder {uidvalidity, last_uid}
  active TINYINT(1) DEFAULT 1,
  created_at, updated_at
)

mailbox_grants (
  id PK, user TINYINT FK users.user, mailbox_id FK,
  can_read TINYINT(1), can_send TINYINT(1), can_manage TINYINT(1),  -- manage = grant others, edit settings
  granted_by, created_at,
  UNIQUE(user, mailbox_id)
)
-- Role bypass: SU + designated role (SS/attorney) short-circuit grant checks in the
-- service layer; align with access-control arc rather than inserting grant rows.

mail_messages (
  id BIGINT PK AI,
  mailbox_id FK, folder VARCHAR(128), uid INT UNSIGNED,
  message_id VARCHAR(512), in_reply_to VARCHAR(512), thread_key VARCHAR(512),
  from_addr VARCHAR(255), to_addrs TEXT, cc_addrs TEXT,
  subject TEXT, date DATETIME, snippet VARCHAR(512),
  body_text MEDIUMTEXT, body_html MEDIUMTEXT,     -- inline per D1
  attachments JSON,                               -- [{part, filename, size, mime}] — structure only, per D1
  raw_ref VARCHAR(512) NULL, gcs_ref VARCHAR(512) NULL,  -- reserved for archival slice, NULL in v1
  size INT,
  flags SET('seen','answered','flagged','draft'), -- SERVER flags (mailbox-level, mirrored read-mostly)
  log_id INT NULL,                                -- bridge to log/about-link case linking
  UNIQUE(mailbox_id, folder, uid),
  INDEX(mailbox_id, date), INDEX(message_id(191)), INDEX(thread_key(191))
)

mail_read_state (                                 -- PER-USER read state; see §4.3
  user TINYINT NOT NULL,                          -- FK users.user
  message_fk BIGINT NOT NULL,                     -- FK mail_messages.id
  read_at DATETIME NOT NULL,
  PRIMARY KEY(user, message_fk)
)

inbox_views (
  id PK, user TINYINT FK users.user, name VARCHAR(64),
  mailbox_ids JSON, filters JSON,                 -- unread-only, has-case, from-domain, etc.
  is_default TINYINT(1), sort_order
)
```

## 4. Components

### 4.1 Ingest worker
Poll-based per D4 (suggest `imapflow`). Each run: `GET_LOCK('mailbox_ingest', 0)` — skip if held (`fieldDefReconciler` pattern); iterate `ingest_enabled` mailboxes; connect, fetch UIDs newer than the `ingest_state` cursor, process, advance cursor, disconnect. Bounded runtime — stop and leave the remainder for the next tick rather than overrun. Dedupe by `(mailbox, folder, uid)`, secondarily `message_id`; the trigger is at-least-once, so a re-run must be a no-op. Backoff on errors; capped concurrency.

**UIDVALIDITY change ⇒ re-key, never blanket-purge.** Purging the folder's rows would cascade into `mail_read_state` and orphan `log_id` bridges — users' read markers and case links on old mail would vanish. Instead: re-scan the folder, re-map stored rows to their new UIDs by `message_id`, insert unmatched messages, purge only true orphans (stored rows with no match). Rows whose `message_id` is missing or ambiguous within the folder don't re-map — they fall through to insert + orphan-purge. The rules pipeline is safe either way (`emailIngestService` reports re-emitted envelopes as `duplicate`).

Per D1, the worker fetches envelope + text parts + BODYSTRUCTURE only — attachments are not downloaded. On-demand endpoint (`GET /api/mailboxes/:id/messages/:mid/parts/:part`) streams the part from IMAP when a user opens it, grant-checked — a request-scoped connection, unaffected by D4. Caveat accepted for v1: if a message is deleted server-side (webmail/Outlook), its attachments are gone from YC too; the GCS archival slice removes this. Exception hook: ingest rules that *need* a binary (court pipeline PDFs) may materialize those parts at ingest into the existing case-file path — rule-driven, not default.

**Pipeline reuse (key decision):** the worker emits the existing canonical envelope into `emailIngestService` — same path as the Apps Script / `POST /api/email/ingest` sources, registered as a new row in `email_ingest_sources`. Rules, suppressions, firm-to-firm skip, executions logging, and case-linking work unchanged. Additionally it writes the full message into `mail_messages` (`log_id` bridges). Apps Script source retires only at provider-plan S3.

### 4.2 Send
Compose/reply in YC → grant check (`can_send`) → `emailService` with the mailbox's `send_credential_id` → existing adapters. With Migadu, one wildcard-send credential per domain serves many mailboxes (convenience, not dependency). After successful send: IMAP APPEND to the mailbox's Sent folder so external clients see YC-sent mail. Guardrails: per-credential daily send budget checked against `email_log` before dispatch (defer + notify on breach — provider counts refused attempts, never retry-hammer); `bulk_ok` flag on credentials; campaign sender refuses non-`bulk_ok` credentials above ~50 recipients.

### 4.3 Read state — per-user by necessity
IMAP `\Seen` is per-MAILBOX; our model is many users per mailbox, so server flags cannot represent "has Fred read this." Per-user read state lives in `mail_read_state` (YC-side). Server flags mirror into `mail_messages.flags` read-only and change only on explicit action (flag/unflag, mark-answered on reply). v1 does NOT write `\Seen` back — avoids two-way sync fights while SB/SS still use external clients.

### 4.4 UI (v1 scope)
Inbox list scoped by active `inbox_view` (default = all readable personal boxes); thread view (`thread_key` from References/In-Reply-To, subject+participants fallback); compose/reply with identity picker limited to `can_send` grants; case-link affordance (reuse about-link); per-user unread markers; grant-admin page (SU/manage only). Not v1: body search (SQL LIKE first, FULLTEXT later), drafts sync, labels.

## 5. Slices (indicative — refine)

- **S0** schema + grants service/API + grant-admin UI. No ingest.
- **S1** ingest worker, ONE pilot mailbox — can be the Workspace account via Gmail IMAP, or archive@mdbl post-trial; canonical-envelope emission + `mail_messages` + on-demand part fetch.
- **S2** inbox/thread read-only UI + views + read state.
- **S3** send (identity picker, Sent APPEND, budget guardrails + `bulk_ok`).
- **S4** remaining mailboxes, flags polish, filters.
- **S5** Migadu provisioning driver (mint mailbox/identity from YC, per D3/T1) + retire Apps Script ingest at provider-plan S3.
- **S6 (later)** GCS archival: raw .eml + attachments to bucket, fill `raw_ref`/`gcs_ref`; lifecycle policy. Gated on GCP landing (DB migration).

## 6. YC3 notes

DB-per-tenant: tables are tenant-local — compatible as-is. Provisioning-driver seam is the YC3 "email included" story (per-tenant domain onboarding via Migadu API; Stalwart self-host driver later). Protocol-first keeps JMAP open as a sibling transport. EmailEngine is the named escape hatch if tenant-BYO Gmail/M365 ever becomes a requirement. Nothing binds a tenant to Migadu.

## 7. Open questions

1. Thread algorithm acceptance: References-chain with subject fallback good enough, or want JWZ-style full threading?
2. Retention: does `mail_messages` keep everything forever, or a mirror window (e.g. 2y) with provider + future GCS archive as record?
3. Do SB/SS keep external clients long-term? If YC becomes sole client for some users, `\Seen` write-back stops mattering for them.
4. Shared-box semantics: surface who replied on a thread (send-attribution — cheap, worth v1?).
