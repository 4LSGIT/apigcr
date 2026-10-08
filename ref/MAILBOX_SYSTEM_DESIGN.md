# MAILBOX_SYSTEM_DESIGN

Status: DRAFT v1 — 2026-10-08. Design sketch for review/refinement; no code yet.
Scope: YisraCase-native mailbox subsystem — many-to-many user↔mailbox access, per-user mixed inboxes, ingest + send on top of a commodity mail host.
Related: `ref/EMAIL_PROVIDER_PLAN.md` (provider migration; this is its S2), access-control arc (roles), about-link/case-link machinery, email-ingest rules engine, YC3 tenancy plan.

## 1. Goal

Every user gets personal inbox(es); some users hold several addresses (billing@4lsg + shoshana@mdbl); users can be granted read and/or send access to others' mailboxes; SU and SS see everything; each user composes a "mixed inbox" from the mailboxes they can read, with custom saved views. YisraCase is the access-control and UI layer; the provider supplies storage and transport.

## 2. Provider coupling — Migadu-specific or open?

**The core is provider-agnostic.** Coupling exists at exactly two seams, both behind interfaces:

| Seam | Agnostic form | Migadu specifics | Notes |
|---|---|---|---|
| Transport (ingest + flags) | IMAP (IDLE/poll) — works on Migadu, MXroute, Gmail-via-IMAP, any host | none required | Future: JMAP driver (Fastmail/Stalwart) is a cleaner sync model; keep transport behind a `MailboxTransport` interface (`imap` now, `jmap` later, `gmail-api` exists for send) |
| Provisioning | manual (admin panel) | Migadu admin API: create domains/mailboxes/identities/rewrites from YC | Optional driver. This is the only genuinely Migadu-specific code we'd write. YC3: per-tenant provisioning driver interface (Migadu first; Stalwart self-host later) |

Send is already abstracted (`email_credentials` + adapters gmail/pabbly/smtp). Migadu wildcard send-as is a **convenience** (one credential sends as any address on the domain), not a dependency — per-mailbox SMTP creds work on any host. Conclusion: build against IMAP+SMTP+optional-provisioning-driver; nothing in the schema or ACL knows about Migadu.

## 3. Schema

```sql
mailboxes (
  id INT UNSIGNED PK AI,
  address VARCHAR(255) UNIQ,          -- shoshana@metrodetroitbankruptcylaw.com
  domain VARCHAR(128),
  display_name VARCHAR(128),
  transport ENUM('imap','gmail-api','jmap') DEFAULT 'imap',
  imap_host VARCHAR(255), imap_port INT, imap_user VARCHAR(255),
  imap_secret TEXT,                   -- encrypted, same crypto pattern as email_credentials.smtp_pass
  send_credential_id INT NULL,        -- FK email_credentials; NULL = mailbox cannot send
  ingest_enabled TINYINT(1) DEFAULT 1,
  ingest_state JSON,                  -- per-folder {uidvalidity, last_uid}; cursor for resume
  active TINYINT(1) DEFAULT 1,
  created_at / updated_at
)

mailbox_grants (
  id PK, user TINYINT FK users.user, mailbox_id FK,
  can_read TINYINT(1), can_send TINYINT(1), can_manage TINYINT(1),  -- manage = grant others, edit settings
  granted_by, created_at,
  UNIQUE(user, mailbox_id)
)
-- Role bypass: SU + designated role (SS/attorney) short-circuit grant checks in the service
-- layer; align with access-control arc rather than inserting grant rows for them.

mail_messages (
  id BIGINT PK AI,
  mailbox_id FK, folder VARCHAR(128), uid INT UNSIGNED,
  message_id VARCHAR(512), in_reply_to VARCHAR(512), thread_key VARCHAR(512),
  from_addr, to_addrs TEXT, cc_addrs TEXT,
  subject TEXT, date DATETIME, snippet VARCHAR(512),
  body_html MEDIUMTEXT NULL, body_text MEDIUMTEXT NULL,   -- or external pointer, see OQ-1
  has_attachments TINYINT(1), size INT,
  flags SET('seen','answered','flagged','draft'),          -- SERVER flags (mailbox-level)
  log_id INT NULL,                                         -- bridge to log/about-link case linking
  UNIQUE(mailbox_id, folder, uid),
  INDEX(mailbox_id, date), INDEX(message_id(191)), INDEX(thread_key(191))
)

mail_read_state (                      -- PER-USER read state; see §4.3
  user, message_id_fk BIGINT, read_at DATETIME, PRIMARY KEY(user, message_id_fk)
)

inbox_views (
  id PK, user FK, name VARCHAR(64),
  mailbox_ids JSON, filters JSON,      -- filters: unread-only, has-case, from-domain, etc.
  is_default TINYINT(1), sort_order
)
```

## 4. Components

### 4.1 Ingest worker
Per-mailbox IMAP connection, IDLE with poll fallback (suggest `imapflow`), honoring `ingest_state` cursors. UIDVALIDITY change ⇒ folder resync. Dedupe by `(mailbox, folder, uid)` and secondarily `message_id`. Backoff on errors; one connection per mailbox, capped concurrency.

**Pipeline reuse (key decision):** the worker emits the existing canonical envelope into `emailIngestService` — the same path as the Apps Script / `POST /api/email/ingest` sources. Rules, suppressions, firm-to-firm skip, executions logging, and case-linking all work unchanged; the worker is just a new source row in `email_ingest_sources`. Additionally it writes the full message into `mail_messages` (the ingest pipeline keeps feeding `email_log`/`log` as today; `mail_messages.log_id` bridges them). Apps Script source retires only when the 4lsg mailboxes themselves move (plan S3).

### 4.2 Send
Compose/reply in YC → grant check (`can_send`) → `emailService` with the mailbox's `send_credential_id` → existing adapters. With Migadu, one wildcard-send credential per domain serves many mailboxes. After successful send: IMAP APPEND to the mailbox's Sent folder so external clients (Outlook/Apple Mail/webmail) see YC-sent mail. Guardrails (from provider plan): per-credential daily send budget checked against `email_log` before dispatch (defer + notify on breach, never retry-hammer — provider counts refused attempts); `bulk_ok` flag on credentials; campaign sender refuses non-`bulk_ok` credentials above ~50 recipients.

### 4.3 Read state — the per-user insight
IMAP `\Seen` is per-MAILBOX; our model is many users per mailbox, so server flags cannot represent "has Fred read this". Therefore: **per-user read state lives in `mail_read_state` (YC-side)**; server flags are mirrored into `mail_messages.flags` read-only and only changed by explicit user action (flag/unflag, mark-answered on reply). v1 does NOT write `\Seen` back (external clients keep their own behavior; avoids two-way sync fights while SB/SS still use Outlook/Apple Mail).

### 4.4 UI (v1 scope)
Inbox list scoped by active `inbox_view` (default = all readable personal boxes); thread view (`thread_key` from References/In-Reply-To, subject+participants fallback); compose/reply with identity picker limited to `can_send` grants; case-link affordance (reuse about-link); per-user unread markers; mailbox-grant admin page (SU/manage only). Not v1: search-in-body (SQL LIKE first, FULLTEXT later), drafts sync, labels.

## 5. Slices (indicative — refine)

- **S0** schema + grants service/API + admin UI for grants. No ingest yet.
- **S1** ingest worker, ONE pilot mailbox (e.g. archive@mdbl or shoshana@mdbl), canonical-envelope emission + `mail_messages`.
- **S2** inbox/thread read-only UI + views + read state.
- **S3** send (identity picker, Sent APPEND, budget guardrails).
- **S4** remaining mailboxes, flags polish, filters.
- **S5** Migadu provisioning driver (create mailbox/identity from YC) + retire Apps Script ingest when S3 of the provider plan happens.

## 6. YC3 notes

DB-per-tenant: these tables are tenant-local — compatible as-is. Provisioning driver + wildcard identities are the YC3 "email included" story (per-tenant domain onboarding via Migadu API, or Stalwart self-host driver later). Transport interface keeps JMAP open. Nothing here binds a tenant to Migadu.

## 7. Open questions

1. **OQ-1 storage:** bodies/attachments in MySQL (MEDIUMTEXT/blob) vs object storage (GCS after Cloud SQL move) with DB pointers. Attachments in DB will bloat fast; leaning GCS — but that gates on the DB migration landing first.
2. Thread algorithm acceptance: References-chain with subject fallback good enough, or want JWZ-style full threading?
3. Retention: does `mail_messages` keep everything forever, or mirror-window (e.g. 2y) with provider as archive of record?
4. Do SB/SS keep external clients long-term? If YC becomes sole client for some users, two-way `\Seen` sync stops mattering entirely for them.
5. Shared-box semantics: should "answered by someone" surface who replied (needs send-attribution on the thread — cheap, worth v1?).
6. Does the worker run in the main YC process or a separate node service (systemd) on the same box? (Separate suggested: connection-heavy, restart-isolated.)
7. Per-user mailbox passwords vs one master + Migadu identities: identities would let each human keep their own client login while YC holds only identity creds — check Migadu identity capabilities during trial.
