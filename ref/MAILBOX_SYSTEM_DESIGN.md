# MAILBOX_SYSTEM_DESIGN

Status: v4 — 2026-10-08, + S1-G addendum 2026-10-09. D1–D6 decided; OQ2 answered; remaining OQs open. S0 + S1 live; S1-G (Gmail pilot, emission identity — §4.1, `ref/MAILBOX_GMAIL_PARITY.md`) live through runbook step 2 (mailbox 2 storing, store-only); its htmlToText follow-up in review.
Scope: YisraCase-native mailbox subsystem and the comms hub that hosts it — many-to-many channel access (mailboxes now, phone lines later through the same grants), per-user mixed inboxes, ingest + send on top of a commodity mail host. Phone gets NO message store in this arc (§4.4, §6).
Related: `ref/EMAIL_PROVIDER_PLAN.md` (provider migration; this is its S2), access-control arc (roles), about-link/case-link machinery, email-ingest rules engine, YC3 tenancy plan.

## 0. Decisions (2026-10-08)

- **D1 — Storage:** metadata + text bodies inline in MySQL; attachments NOT copied at ingest — structure only, fetched on demand from IMAP; GCS archival (raw .eml + attachments) is a later slice behind reserved pointer columns. Nothing gates on the Cloud SQL move.
- **D2 — Coupling:** core is built to the protocols — IMAP (ingest/read) + SMTP via existing adapters (send) — which de facto covers any standards host. Provider-specific code is confined to an optional **provisioning driver** (Migadu first). Credential *acquisition* is the driver's job; credential *use* is always generic IMAP/SMTP — the transport never knows which provider it's talking to. API-transport providers (Gmail API, MS Graph) are out of scope for the core; if YC3 ever needs tenant-BYO Gmail/M365, evaluate embedding EmailEngine rather than hand-building.
- **D3 — Credential model:** preferred: per-mailbox **Migadu identities** — YC gets its own login per mailbox, independent of the human's password (rotation-safe, individually revocable). Pending trial test T1. Fallback if identities can't do IMAP login: YC-issued mailbox passwords (Fred mints them, so rotation stays controlled). Either way `mailboxes` stores plain host/user/secret and the transport is unaffected.
- **D4 — Worker placement / ingest mode:** prod is Cloud Run (`svpcac`) — no box, no systemd. v1 ingest is **poll-based**: Cloud Scheduler (or Cloud Tasks) hits an authenticated job endpoint every 5 min (config knob), lock-guarded and bounded per run (§4.1). Latency parity with today: the Apps Script source lands on a ~5-min cadence in `email_ingest_executions`. IMAP IDLE is deferred — revisit only if the VM per `ref/plans.md` lands or a real latency requirement appears; then a dedicated Cloud Run service (min=max=1, CPU always allocated), which still needs reconnect logic + the lock (rolling deploys overlap instances).
- **D5 — Sequencing:** the mailbox system is built BEFORE the Migadu migration executes (provider-plan S1+). The DB→Cloud SQL move is funding-gated and does not compete for this slot. Only the trial-account tests run beforehand (T1 below; T2 + MS first-contact per the provider plan) — they gate the migration stages, not this build. The cutover then lands on a working system, and a later provider swap per mailbox is just repointing its `mailboxes` row (host/user/secret) with the §4.1 UIDVALIDITY re-key absorbing the new UID world.
- **D6 — Channel-general access, email-only store:** the access model and UI shell generalize across channels; storage does not. Grants are `channel_grants` (§3) — 'mailbox' now, 'phone_line' later against the existing `phone_lines` rows — and the v1 UI ships as a comms hub (§4.4) with Email live and Phone as a later slice reading Quo LIVE via the adapter. No YC phone message store in this arc: Quo is phone's tier-1 store (same shape as D1's attachments-on-demand); the recordings arc owns any phone-side persistence, built on the same two-tier + grants patterns. Grant checks sit on INTERACTIVE routes only — never inside emailService/phoneService — so workflow/automation sends are untouched.

**Trial tests (run during Migadu trial, before S1):**
- T1: create mailbox + identity; attempt IMAP login with identity credentials; confirm it reads the mailbox. Result selects D3 mode.
- (MS first-contact deliverability test lives in EMAIL_PROVIDER_PLAN S1.)

## 1. Goal

Every user gets personal inbox(es); some users hold several addresses (billing@4lsg + shoshana@mdbl); users can be granted read and/or send access to others' mailboxes; SU and SS see everything; each user composes a "mixed inbox" from the mailboxes they can read, with custom saved views. YisraCase is the access-control and UI layer; the provider supplies storage and transport.

**Two-tier record (the organizing principle).** Tier 1 — the mailbox store (`mail_messages`): complete — every message in every ingested folder — and access-controlled by grants. Tier 2 — the log: curated and firm-visible; the rules/suppression/firm-to-firm pipeline is the valve between the tiers, and `log_id` is the bridge. The principle extends per channel: Quo is phone's tier-1 store today; the recordings arc adds YC-side phone persistence later.

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
- Not just a pilot path: from S1 the worker **is the ingest for the current providers** — SiteGround mailboxes over `gcam1191.siteground.biz:993` and the Workspace account over Gmail IMAP — pre-migration, superseding the dead exim/PHP relay (ingest source 2, dead since 2026-05-27; provider-plan S1 keeps its deactivate+delete cleanup). The Apps Script source retires parity-gated: ~14 clean days of Gmail-IMAP ingest feeding the same pipeline, no later than provider-plan S3. **Dedupe does NOT cover the overlap by itself** — `email_log` dedupes on `(source, message_id)` per source only (AI_CONTEXT §27), and `gmail-firm` keys on Gmail's internal id while the worker's default is the RFC Message-ID under `mailbox-imap`. The overlap is safe only because the Gmail mailbox emits under `gmail-firm` keyed by hex(X-GM-MSGID) — the Apps Script key — via the S1-G emission override (§4.1), verified live before it emits (`ref/MAILBOX_GMAIL_PARITY.md`). The same per-source rule keeps **SiteGround boxes that forward into the Workspace inbox store-only**: their `mailbox-imap` copy would cross-source-duplicate the Gmail copy until those forwarders die at the Migadu migration.
- No process-global state: `mailboxService`/`imapTransport` hold no module-scope caches of mailbox/grant data and no persistent IMAP connections — per-run connections (ingest) and per-request connections (part fetch) only (tenancy audit §A3 / P0-5).

## 3. Schema

```sql
mailboxes (
  id INT UNSIGNED PK AI,
  address VARCHAR(255) UNIQ,
  domain VARCHAR(128),
  display_name VARCHAR(128),
  color VARCHAR(7) NULL,              -- S2 comms-hub colour '#rrggbb' (NULL = none); cosmetic, manager-editable
  imap_host VARCHAR(255), imap_port INT DEFAULT 993, imap_user VARCHAR(255),
  imap_secret TEXT,                   -- encrypted, same crypto pattern as email_credentials.smtp_pass
                                      -- (identity creds or mailbox password — transport doesn't care, per D3)
  send_credential_id INT NULL,        -- FK email_credentials; NULL = read-only mailbox
  ingest_enabled TINYINT(1) DEFAULT 1,
  ingest_folders JSON,                -- per-folder CONFIG: which folders to poll + emit_to_rules (§4.1; v1 default INBOX:true, Sent:false)
                                      -- + backfill:false (S1-G) = store only mail arriving after first sight
  ingest_state JSON,                  -- per-folder CURSOR {uidvalidity, last_uid}
  emit_source_name VARCHAR(64) NULL,  -- S1-G emission override: the email_ingest_sources row emitted under (NULL = mailbox-imap)
  emit_id_kind VARCHAR(12) NULL,      -- S1-G: 'rfc' | 'provider' — the (source, message_id) key; set as a pair, SU PATCH only
  active TINYINT(1) DEFAULT 1,
  created_at, updated_at
)

channel_grants (                                  -- channel-general per D6
  id PK, user TINYINT FK users.user,
  channel_type VARCHAR(16) NOT NULL,              -- 'mailbox' | 'phone_line' (app-validated; VARCHAR not ENUM so new channels need no ALTER)
  channel_id INT UNSIGNED NOT NULL,               -- mailboxes.id | phone_lines.id (FK-by-convention)
  can_read TINYINT(1), can_send TINYINT(1), can_manage TINYINT(1),  -- manage = grant others, edit settings
  granted_by, created_at,
  UNIQUE(user, channel_type, channel_id)
)
-- Role bypass: SU + designated role (SS/attorney) short-circuit grant checks in the
-- service layer; align with access-control arc rather than inserting grant rows.
-- Enforcement seat (D6): grant checks live on INTERACTIVE routes only -- never inside
-- emailService/phoneService -- so workflow/automation sends are untouched.
-- S0 ships the general schema; pane + write API stay mailbox-only until the phone
-- slice wires enforcement (no unenforced phone rows).

mail_messages (
  id BIGINT PK AI,
  mailbox_id FK, folder VARCHAR(128), uid INT UNSIGNED,             -- uid NULLABLE: re-key parking (§4.1)
  message_id VARCHAR(512), in_reply_to VARCHAR(512), thread_key VARCHAR(512),
  provider_id VARCHAR(64) NULL,                   -- S1-G: provider-native id (Gmail: hex X-GM-MSGID); NULL elsewhere
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
Poll-based per D4 (suggest `imapflow`). Each run: `GET_LOCK(CONCAT('mailbox_ingest:', DATABASE()), 0)` — skip if held (`fieldDefReconciler` pattern; the name is DB-suffixed from day one because the lock namespace is server-global — possibly-shared SG MySQL today, YC3 P0-6 tomorrow); iterate `ingest_enabled` mailboxes; connect, fetch UIDs newer than the `ingest_state` cursor, process, advance cursor, disconnect. Bounded runtime — stop and leave the remainder for the next tick rather than overrun. Dedupe by `(mailbox, folder, uid)`, secondarily `message_id`; the trigger is at-least-once, so a re-run must be a no-op. Backoff on errors; capped concurrency.

**UIDVALIDITY change ⇒ re-key, never blanket-purge.** Purging the folder's rows would cascade into `mail_read_state` and orphan `log_id` bridges — users' read markers and case links on old mail would vanish. Instead: re-scan the folder, re-map stored rows to their new UIDs by `message_id`, insert unmatched messages, purge only true orphans (stored rows with no match). Rows whose `message_id` is missing or ambiguous within the folder don't re-map — they fall through to insert + orphan-purge. The rules pipeline is safe either way (`emailIngestService` reports re-emitted envelopes as `duplicate`). Mechanics: re-mapping collides with `UNIQUE(mailbox_id, folder, uid)` mid-update — a row's new UID can equal another row's old UID — so re-key in two phases: park affected rows' `uid` to NULL (nullable for exactly this), then set finals.

Per D1, the worker fetches envelope + text parts + BODYSTRUCTURE only — attachments are not downloaded. On-demand endpoint (`GET /api/mailboxes/:id/messages/:mid/parts/:part`) streams the part from IMAP when a user opens it, grant-checked — a request-scoped connection, unaffected by D4. Caveat accepted for v1: if a message is deleted server-side (webmail/Outlook), its attachments are gone from YC too; the GCS archival slice removes this. Exception hook: ingest rules that *need* a binary (court pipeline PDFs) may materialize those parts at ingest into the existing case-file path — rule-driven, not default.

**Pipeline reuse (key decision):** the worker emits the existing canonical envelope into `emailIngestService` — same path as the Apps Script / `POST /api/email/ingest` sources, registered as a new row in `email_ingest_sources`. Rules, suppressions, firm-to-firm skip, executions logging, and case-linking work unchanged. Additionally it writes the full message into `mail_messages` (`log_id` bridges). Apps Script source retires parity-gated (§2), no later than provider-plan S3.

**Emission identity (S1-G).** Which `(source, message_id)` a mailbox's mail is emitted under IS its dedupe space. Default: `mailbox-imap` + RFC Message-ID. Override (`mailboxes.emit_source_name` + `emit_id_kind`, SU PATCH only, set as a pair, active source row required, `provider` never under `mailbox-imap`, one provider-keyed mailbox per source): emit under another source keyed by the RFC id or by `mail_messages.provider_id`. The transport captures Gmail's X-GM-MSGID (imapflow surfaces it as `emailId` on X-GM-EXT-1 servers that do not advertise OBJECTID) as lowercase hex — the id Gmail's web UI, API and Apps Script use. A provider-keyed message without a provider id is stored, counted and alerted, **never** emitted under the RFC id (that would mint a second identity). Where present, the provider id is also the secondary-dedupe and re-key identity. The override never changes which folders emit or whether history emits. Runbook + live gate: `ref/MAILBOX_GMAIL_PARITY.md`.

**Backlog policy (S1-G).** `ingest_folders.<folder>.backfill:false` stores only mail arriving after first sight (decided then; a later UIDVALIDITY re-key backfills only above the highest re-mapped UID). For large accounts — the Workspace INBOX holds 62k messages; a full backfill would exceed Gmail's ~2.5 GB/day IMAP download cap and multiply the SiteGround DB. Bounded history (the 2-year cutoff) stays S4's.

**Per-folder rules policy (v1):** the worker consults `mailboxes.ingest_folders` — only folders flagged `emit_to_rules` (default: INBOX yes, Sent no) emit into the rules pipeline; everything ingested is stored to `mail_messages` regardless. Deliberate consequences: externally-sent mail (Outlook/Apple Mail) becomes visible in the mailbox tier immediately but reaches the log tier only if a later rule opts Sent in; YC's own APPENDed sends are stored without re-entering the pipeline.

### 4.2 Send
Compose/reply in YC → grant check (`can_send`, on the interactive route per D6 — never inside `emailService`, so automation sends bypass) → `emailService` with the mailbox's `send_credential_id` → existing adapters. With Migadu, one wildcard-send credential per domain serves many mailboxes (convenience, not dependency). After successful send: IMAP APPEND to the mailbox's Sent folder so external clients see YC-sent mail. Guardrails: per-credential daily send budget checked against `email_log` before dispatch (defer + notify on breach — provider counts refused attempts, never retry-hammer); `bulk_ok` flag on credentials; campaign sender refuses non-`bulk_ok` credentials above ~50 recipients.

### 4.3 Read state — per-user by necessity
IMAP `\Seen` is per-MAILBOX; our model is many users per mailbox, so server flags cannot represent "has Fred read this." Per-user read state lives in `mail_read_state` (YC-side). Server flags mirror into `mail_messages.flags` read-only and change only on explicit action (flag/unflag, mark-answered on reply). v1 does NOT write `\Seen` back — avoids two-way sync fights while SB/SS still use external clients.

**As built (S2):** row present = read. Writes are idempotent (`INSERT … ON DUPLICATE KEY UPDATE` / `DELETE` no-op). Opening a conversation marks every unread COPY of every message shown read in one bulk call (`POST /api/mail/read {ids}`); "Mark all read" is the same route with `{all:true, mailbox_ids?, filters?}` and marks exactly what the list would show for that scope, every page — the same predicates (`scopeWhere`: INBOX unless `all_folders`, plus the filters), never the mailbox behind a filtered list; the pane confirms first (per-user state, no undo). Both are grant-scoped inside the statement (`mailbox_id IN` the readable set). Unread counts are per user over the INBOX folder only — a Sent copy is mail the box itself sent.

### 4.4 UI — comms hub (v1 scope = Email tab)
The surface is `comms.html`, a tabbed hub: **Email** (this arc's v1) and **Phone** (later slice, §5). `contact.html`'s Communicate tab stays as the per-contact entry point; the hub is the firm-wide surface.

Email tab: inbox list scoped by active `inbox_view` (default = all readable personal boxes); thread view (grouped by the stored `thread_key` — OQ1, answered below); compose/reply with identity picker limited to `can_send` grants; case-link affordance (reuse about-link); per-user unread markers; grant-admin page (SU/manage only; mailbox grants only until the phone slice). Not v1: body search (SQL LIKE first, FULLTEXT later), drafts sync, labels.

**As built (S2, read-only — compose is S3).** API `routes/api.mail.js`, service `services/mailbox/mailReadService.js`, pane `public/comms.html` (the shell's Comms tab, `tabComms` — a sidebar item with the INBOX-unread badge, shown once the user can read ≥ 1 mailbox, and a Home button; it took Settings' sidebar/Home places 2026-10-11, Settings moving to More Features. It piloted as an Admin tile), renderer `public/js/mailRender.js`.
- **Scope.** Readable = grants ∪ SU ∪ the **attorney READ bypass**: `users.roles` containing `attorney` (SS) reads every mailbox without a grant row. READ only — `can_send`/`can_manage` still come from the grant row and the role reader is never treated as SU (public projection on `GET /api/mailboxes`, no bypass writes, no SU diagnostics). DB-sourced per request, like the SU check. Phone lines get no role bypass before S-PH. A message that exists but is unreadable answers exactly like a missing one (404).
- **List.** Keyset on `(date, id)`: one UNION ALL branch per mailbox, each a backward walk of `idx_mail_messages_mailbox_date` (FORCE INDEX — left alone the optimizer takes the `(mailbox_id, folder, uid)` key + filesort once a box holds a few thousand rows) with its own LIMIT; cursor = the last row's `(date, id)`; NULL dates last. Never bodies. Default folder = INBOX; `all_folders` adds Sent etc. Filters: `unread_only`, `has_case` (the log row's about-link is a case) / `no_case` (its complement — both on is a 400), `client_only`, `has_files`, `from_domain` (exact domain), `q` (from/subject LIKE, escaped). `has_case` is a sparse filter on the same walk (~0.2 s over 35k rows measured) — a has-case-first plan is a later optimization if it matters.
  - `client_only`: the sender (the `<angle>` part) or one of the first 5 address tokens of "To,Cc" is an ACTIVE `contact_emails` address of a contact who is Primary/Secondary on some case, minus firm addresses (`firmDomains()` + subdomains, via a REGEXP param) and every `mailboxes.address` — staff sit on test cases as clients (live data: Stuart's and Fred's own addresses), so without that every outgoing message matched through its own From. The candidates are a `JSON_TABLE(JSON_ARRAY(…))` JOINed to `contact_emails` so each is an `idx_email_history` probe; `ce.email IN (<per-row expressions>)` scanned all ~1k rows per walked message (production EXPLAIN).
  - `has_files`: the list's paperclip in SQL — a `JSON_TABLE` over `attachments` with a part that is not (image + Content-ID + a `LOCATE` hit for `cid:<id>` or its `%40` form in `body_html`). Its columns are declared `utf8mb4_general_ci`: undeclared they take the CONNECTION collation and the LOCATE is an illegal mix. Known gap vs `markInline`, one way only: a cid that is a strict prefix of another referenced cid counts as drawn (a missed file, never a false one).
  - Both are SCALAR subqueries (`0 < (SELECT COUNT(*) …)`), never `EXISTS`: on 8.0.46 the EXISTS form was flattened to a semi-join that lost the backward walk (DuplicateWeedout + filesort) and marked NOTHING inside mark-all's `INSERT … SELECT` while listing correctly. `tests/mailboxS2.mysql.test.js` pins the plan, the probe and the count; the fake world (`tests/helpers/mailboxS2World.js`) is checked against the engine row for row.
- **Threads.** The stored `thread_key` (References[0] → In-Reply-To → own Message-ID, written by the worker) merged across every readable mailbox; copies of one message (two boxes, INBOX + Sent) collapse by Message-ID with every copy listed. Over 100 stored rows the NEWEST 100 come back (`truncated`), oldest-first — the clicked message is almost always the latest. Threadless rows open by message id.
- **Views.** `inbox_views` rows are caller-owned (every query carries `user = caller`). `mailbox_ids` null = all readable; ids must be readable when written and are intersected with the readable set when used — a view never grants. `filters` vocabulary = the list's filters (`unread_only`, `has_case`, `no_case`, `client_only`, `has_files`, `all_folders`, `from_domain`, `q`); one default per user. A view is any SET of readable boxes + filters: the pane's mailbox picker combines any boxes (SB: shoshana@ + billing@), Save stores the set, Update replaces it; list calls are fully explicit (`mailbox_ids` + every toggle), and a view whose boxes were all revoked shows nothing, never everything. At ≥ 1000 px pane width the pane shows a RAIL (borrowed from a design mockup of the hub): views (+ "All mail") and mailboxes as lists (colour, access R·S·M, INBOX unread), over the SAME state as the view menu + mailbox picker, which narrow screens keep (CSS picks one). Each view's unread count comes from `GET /api/mail/views/counts` (`viewCounts`: one COUNT per view through `scopeWhere` with `unread_only` forced on and `all_folders` forced OFF — a Sent copy is never "read", so counting folders would count the box's own outgoing mail; = the view's list with Unread on); "All mail" is the summary's total. "Unsaved changes" (screen ≠ active view) offers Save as view / Update. The rail collapses (« → the menus come back in the bar; remembered per browser in localStorage). Filters are pressed-state chips; Inbox | All folders is one choice; a row whose From is one of the readable mailboxes reads "To: <first recipient>".
- **Mailbox colour.** `mailboxes.color` (`ref/migrations/2026-10-09_mailbox_s2.sql`): one stored `#rrggbb` per box, the same for every viewer — a quick-glance aid beside the printed address (row stripe, tag, picker, thread copies, views list), never an access or routing input. Assigned when the box is added: the admin's pick, else a random `PALETTE` entry no other box uses (server-side too, for API creates); editable afterwards by SU or the box's `can_manage` holders (`MANAGER_EDITABLE_FIELDS`, like `display_name`), in place from the admin list's swatch or the edit form. One shared module, `public/js/mailboxColor.js`, holds the palette, the validation and the drawing rule for server and panes: a colour is drawn as stored wherever it clears 3:1 (SC 1.4.11, non-text) on every surface of the active theme — surface, page, surface-2, hover, the selected row's accent-soft — else the same hue/saturation with HSL lightness moved just far enough; the two per-theme values ride inline custom properties (`--mbc-l`/`--mbc-d`), so a theme flip is pure CSS. The stored pick is never rewritten; `tests/mailboxS2.color.test.js` fails if the module's surfaces drift from `theme.css`.
- **Hostile HTML.** `body_html` reaches the page only as the `srcdoc` of an iframe built by `mailRender.js`, behind three independent layers each shown to stop a live payload alone in real Chrome (`tests/mailboxS2.renderBrowser.test.js`): DOMPurify (vendored, pinned, HTML profile, forms/media/meta dropped, links forced to new tab `noopener noreferrer`), the sandbox (no `allow-scripts`, no `allow-same-origin`; `allow-popups(+escape)` only so links open as normal tabs), and a CSP `<meta>` first in the frame head (`default-src 'none'`, images `data:` only). **Remote content is blocked by default** (tracking pixels are read receipts): src/srcset/background/poster and CSS `url()`/`image-set()`/`@import` are stripped and counted; "Show images" re-renders with http(s) images allowed and fetches inline `cid:` images through the part route as data: URLs. No script runs in the frame, so its height is estimated.
- **Inline vs attached.** The server decides (`mailReadService.markInline`, `inline` on every thread attachment; the list's `attachment_count` excludes the inline ones): a part is inline ONLY when it is an image the HTML body references as `cid:<Content-ID>` (RFC 2392, URL-decoded, case-blind). A Content-ID alone means nothing — Gmail gives every attachment one (X-Attachment-Id), and the first cut's "has a cid = inline" rule hid every Gmail PDF. The stored structure has no disposition (Apple Mail marks plain PDFs `inline` anyway), so the body reference is the test; the list reads `body_html` server-side for just the page rows that have a cid part, never sending it.
- **Attachments (hub polish).** Per file: View · Download · Save to case. **View** only for PDFs and raster images (png/jpeg/gif/webp; a `.pdf` name with a generic octet-stream type counts) — the viewer shows a `blob:` URL, which carries the APP origin, so the blob is re-wrapped with the type the PAGE decides (`viewKind`), never the server's or the bytes': an HTML or SVG file named `.pdf` is a broken PDF, not a page on the app origin; SVG is never viewable. PDFs render in an iframe (plus **New tab**, `noopener`; the URL is revoked 5 minutes after a tab took it, immediately otherwise), images in an `<img>`. **Save to case** is the documents upload flow unchanged (`/api/documents/upload-link` → the browser POSTs the bytes straight to Dropbox → `/upload-commit` with Dropbox's own `id`), so placement (case folder root, or the no-folder ladder) and registration are the Documents subsystem's, and the commit's yc-sync matcher refreshes open Documents tabs. The case is picked from suggestions (the message's case, then the conversation's client cases from `related`) or search — the same picker as Link to case.
- **Always show images from a sender.** `mail_image_senders` (`ref/migrations/2026-10-09_mail_image_senders.sql`): per USER, per exact address (the `<angle>` part of From, `senderOf`). Every thread / message read annotates `from_email` + `images_trusted` for the caller (one `IN` probe); a trusted message renders with remote images allowed and its inline images fetched, as if Show images had been clicked — sanitizer, sandbox and CSP unchanged. A forged From can at most earn a read receipt. `GET/POST /api/mail/image-senders`, `DELETE /api/mail/image-senders/:address`.
- **Related — open the client's file.** `GET /api/mail/messages/:id/related`: the conversation's OUTSIDE addresses (firm domains and every `mailboxes.address` dropped; senders first; ≤ 50) → ACTIVE `contact_emails` → contacts, each with the cases they are a CLIENT on (`case_relate` Primary/Secondary; open stages first, then newest; ≤ 10). An attorney or trustee ("Other") is a contact chip without cases. Loaded after the thread renders; never blocks reading.
- **Add to a client.** `related` also returns `unmatched`: the same outside addresses that no active row holds, `{email, name (the display name the mail carried), role}`, automated local parts (`AUTOMATED_RE`: no-reply, do-not-reply, mailer-daemon, postmaster, bounce(s), notification(s)) left out. The pane shows them as dashed chips (3, then "+N more") that call the SHELL's `OrphanAdoptDialog(email, 'email', onDone, {earliest, name})` (scripts.js — the log tab's attach-or-create dialog): attach to an existing contact (the picker's search starts with `name`) or Create new (`newContact` prefilled with name + email + start date), with the 409 force-transfer and same-contact backdate paths unchanged. `earliest` = `GET /api/mail/first-seen?address=` — the firm-local day of the earliest READABLE mail carrying the address (LIKE narrows, a REGEXP pins it between list delimiters, so `mjane@` never counts for `jane@`); the dialog defaults the start date to the earlier of it and the log's own first row (a store-only box logs nothing). `onDone` reloads the strip.
- **Read state in the pane.** Unread rows carry four cues (raised `--surface` row, bold sender/subject/date in `--text`, an `--accent-2` dot, screen-reader "Unread."); read rows sit on `--page-bg` in `--text-2`. Thread cards unread at open keep a **New** pill for that view (open marks them read); per-card Mark read ↔ Mark unread (`POST /api/mail/read {ids}` of the unread copies / `DELETE …/read` of the opened copy).
- **Case link.** `POST /api/mail/messages/:id/case-link {case_id}` sets the about-link (`logService.setLogAbout`, about_type `case`) on the message's log row. A message with no stamped `log_id` first looks for a log row that ALREADY carries the email — a copy's stamp, else any source's `email_ingest_executions` row (with a live log row) keyed by the RFC Message-ID (bare or `<bracketed>`) or by a provider id (this row's or a copy's): the Apps Script source logs the Workspace inbox under Gmail's id (= `provider_id`) while that mailbox is store-only, and per §2 nothing else dedupes across sources, so without this every hub link of Workspace mail minted a second log row. Only when none exists is one created through `logService.createLogEntry` in the email pipeline's shape (type/link `email`, the other party, From/To/Subject/Message, direction by firm domains), dated when the mail was sent but never after the worker stored it (`createLogEntry`'s optional `date`; the Date header is sender-supplied), then stamped — the two-tier valve opening for one message. Refused (409) while another writer may still log it: the ingest worker (emitting folder, UID above the cursor, or inside an emitting re-key backfill — its own stamp would lose and its log row would orphan), or, in a store-only folder, for 10 minutes after the worker stored it (`STORE_ONLY_GRACE_MIN`: another ~5-min source may still post it).

Phone tab (slice S-PH): per-line SMS inbox + call log read **live from Quo via the adapter** — no YC phone message store in this arc — grant-enforced via `channel_grants('phone_line')`; SMS send; recordings/transcripts render here when that arc lands; outgoing calls after. **Phonebook** add-in (slice S-PB): type-ahead contact lookup (existing contactLookup pattern) → compose email/SMS from the hub.

## 5. Slices (indicative — refine)

- **S0** schema (incl. `channel_grants`, channel-general; pane + write API mailbox-only per D6) + grants service/API + grant-admin UI. No ingest.
- **S1** ingest worker, ONE pilot mailbox — can be the Workspace account via Gmail IMAP, or archive@mdbl post-trial; canonical-envelope emission + `mail_messages` + on-demand part fetch.
- **S1-G** Gmail second pilot: provider-id capture, per-mailbox emission override (`gmail-firm` + hex X-GM-MSGID), `backfill:false`, SU folder listing + emission preview, the live gate and the 14-day parity window that retires the Apps Script source (`ref/MAILBOX_GMAIL_PARITY.md`). Follow-up: `htmlToText` matches Gmail's plain text where Layer 3 reads it (links as `label <url>`, LF, bare `&nbsp`, `<hr>` breaks, `<img alt>`), and the G4 script classifies the residual Gmail renderings (80 live NEFs: STOP → REVIEW, 0 VALUE).
- **S2** inbox/thread read-only UI + views + read state. BUILT 2026-10-09 (§4.3, §4.4 "As built"; attorney READ bypass; OQ1 answered; one column — `mailboxes.color`, migration `2026-10-09_mailbox_s2.sql`).
- **S3** send (identity picker, Sent APPEND, budget guardrails + `bulk_ok`).
- **S4** remaining mailboxes, flags polish, filters. (Retention pruning per OQ2's answer lands by here.)
- **S-PB** (any time after S3) phonebook add-in: contact type-ahead → compose email/SMS.
- **S-PH** phone tab: Quo-adapter live reads (per-line SMS inbox, call log), `phone_line` grant enforcement + pane support, SMS send; recordings-arc outputs render here when available.
- **S5** Migadu provisioning driver (mint mailbox/identity from YC, per D3/T1) + retire Apps Script ingest at provider-plan S3.
- **S6 (later)** GCS archival: raw .eml + attachments to bucket, fill `raw_ref`/`gcs_ref`; lifecycle policy. Gated on GCP landing (DB migration).

## 6. YC3 notes

DB-per-tenant: tables are tenant-local — compatible as-is. Provisioning-driver seam is the YC3 "email included" story (per-tenant domain onboarding via Migadu API; Stalwart self-host driver later). Protocol-first keeps JMAP open as a sibling transport. EmailEngine is the named escape hatch if tenant-BYO Gmail/M365 ever becomes a requirement. Nothing binds a tenant to Migadu. The ingest job endpoint is deliberately `/process-jobs`-shaped: a cron-fired async entry that must eventually carry explicit tenant identity (tenancy invariant 6) — it rides P0-8 and open decision 7 (per-tenant scheduler jobs vs platform fan-out), not a special case; if Cloud Tasks ever drive it, task names are tenant-prefixed. Phone persistence stays out platform-wide: the tenant's phone provider is phone's tier 1; the recordings arc owns any YC-side phone store, on the same two-tier + `channel_grants` patterns.

## 7. Open questions

1. Thread algorithm acceptance — ANSWERED 2026-10-09 (S2): v1 groups by the stored `thread_key` (References-first, else In-Reply-To, else the message's own id). No subject/participants fallback; JWZ-style full threading is a non-goal. Known cost: a client that sets In-Reply-To without References splits a thread at that message.
2. Retention — ANSWERED 2026-10-08: 2-year full-body mirror window; the provider + future GCS archive are the long-term record; pruning mechanics decided at implementation (by S4); revisit at S6. Basis: DB 897MB today (373MB email-adjacent), ~100 distinct inbound msgs/day ≈ 0.7–1.5GB/yr of stored text+html on pre-Cloud-SQL SiteGround.
3. Do SB/SS keep external clients long-term? If YC becomes sole client for some users, `\Seen` write-back stops mattering for them.
4. Shared-box semantics: surface who replied on a thread (send-attribution — cheap, worth v1?).
