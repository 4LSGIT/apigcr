# CHAT_DESIGN

Status: v0 DRAFT — 2026-10-12. Design-only; nothing built. Rulings R1–R2 are Fred's (2026-10-12); every P# is a proposal pending ratification; OQs at §7.
Scope: staff-only, YisraCase-native messaging. Threads anchored to entities (case / contact / task) come first; standing group rooms second; DMs per OQ1. Hosted as the comms hub's third tab plus a tab on the entity pages.
Related: `ref/MAILBOX_SYSTEM_DESIGN.md` (comms hub shell, two-tier record principle), `ref/CTA_DESIGN.md` (public token pages, in-thread buttons), task action tokens (`routes/taskActions.js`, `/t/`), access-control arc, YC3 tenancy plan (`ref/plans.md`), mobile-ui arc.
Gates: build after the Cloud SQL cutover settles (scheduled 2026-10-13) — under the 1 GB cap a new append-only store was not an option. Comms hub shell exists (mailbox S3 + S-PH shipped) — cleared. Access-control is NOT a gate (P7).

## 0. Why — and what we are not building

- **Today staff talk on private phones** (WhatsApp/SMS). Consequences: no firm record of client-matter discussion; the record walks out with the person; nothing links to the case; no handoff when someone leaves. That — not "chat is nice" — is the case for this arc and the argument for SS.
- **The competitor is the phone in their pocket**: instant push, zero friction. A YC chat that is slower or harder to reach than WhatsApp loses. ⇒ phone layout and push are v1 requirements, not polish (§4.3, §4.4).
- **What only YC can do** (the differentiator, and the YC3 pitch — a generic CRM cannot assume the customer runs Slack): discussion anchored to the matter; entity chips that deep-link into a specific tab; message → task; promote → log; automation/HITL posts carrying CTA buttons; an AI seat later.
- **Not building:** presence, typing indicators, reactions beyond a simple ack, GIFs, voice/video, nested threads. **Never clients in rooms** — the portal stays separate.
- **Adoption context (2026-10-12):** chat ships as part of the clean-surface restart, not as a standalone feature; a usage probe on today's surface would measure the current state, not the idea.

## 1. Rulings and proposals

- **R1 (Fred 2026-10-12) — v3-first.** Designed for DB-per-tenant and domain-agnostic matters (§6).
- **R2 (Fred 2026-10-12) — reply-from-email v1 is a token reply page**, not inbound mail parsing (§4.5).
- **P1 — Anchor-first.** Every case / contact / task has at most one thread, created lazily on the first message. Group rooms are secondary.
- **P2 — Two-tier record** (the mailbox principle). Chat is tier 1: complete, scoped. The log is tier 2: curated, firm-visible. The bridge is an explicit **Promote to log** (§4.7). No automatic mirroring in either direction.
- **P3 — Never destroy.** Edits keep history; delete is a tombstone (body retained, hidden in the UI); no purge in v1 (OQ2).
- **P4 — Transport is adaptive polling** on an audit-exempt pulse route (§4.2). SSE/WebSockets are revisited only if `min-instances` gets funded.
- **P5 — Notification ladder:** in-app → Web Push → SMS (body-free) → email (with a reply link). Delayed rungs run as one-shot `scheduled_jobs` (§4.4).
- **P6 — Message text is plain text plus typed ref tokens.** No HTML, ever (the `mailRender` lessons stay in the mail pane).
- **P7 — One access function.** Every read/write goes through `chatAccess(db, user, room)` so access-control roles slot in later without touching call sites. v1 rule: an entity thread is readable by whoever can see the entity (today: all staff); group rooms and DMs by membership; SU everything; portal users never.

## 2. Model

- **Thread kinds:** `entity` | `group` | `dm` (one `chat_rooms` table, §3).
- **Membership means notifications + read state, not access**, for entity threads. Auto-join on: posting, being @mentioned, being `task_from`/`task_to` of a task thread. Manual follow/unfollow. A non-member who can see the entity can read and post; they just get no unread counts until they join.
- **Read state** is a high-water mark, `chat_members.last_read_id` — chat is linear, unlike `mail_read_state`'s per-message rows. "Seen by" is derived from it.
- **Ref tokens** in message text: `[[case:PY9ZD564]]`, `[[case:PY9ZD564#documents]]`, `[[contact:2056#tasks]]`, `[[task:123]]`, `[[doc:456]]`; mentions `[[user:5]]`.
  - The server parses on write: validates existence and that the poster can see the target; stores a snapshot in `chat_messages.refs` (`[{type,id,tab,label}]`) and mention ids in `mentions`. An unresolvable token stays literal text.
  - The label is a display snapshot; the link resolves live (a renamed case still opens).
  - **Tab whitelist** = the entity pages' tab buttons — case: (overview), `tabLog`, `documents`, `tasks`, `checklists`, `forms`, `esign`, `timeline`, `auto`, `ISSN`, `chat`; contact: `tabLog`, `documents`, `notes`, `tasks`, `chat`. A click goes through the shell's existing file opener with `&tab=` — the `${tab}Button` boot convention (`index.html` `quickPick` / `restoreOpenFiles`). No new routing.
  - **Composer:** `#` opens a case/contact picker on `caseService.searchCases` (picker-shaped — never `listCases`); `@` opens users.

## 3. Schema (sketch — final names/types per `ref/SCHEMA_CONVENTIONS.md` at build)

```sql
chat_rooms (
  id               INT UNSIGNED PK AI,
  kind             VARCHAR(8)  NOT NULL,      -- entity | group | dm — app-validated (channel_grants precedent)
  anchor_type      VARCHAR(16) NULL,          -- case | contact | task (entity only)
  anchor_id        VARCHAR(20) NULL,          -- matches tasks.task_link_id width
  anchor_key       VARCHAR(40) GENERATED ALWAYS AS
                     (IF(kind = 'entity', CONCAT(anchor_type, ':', anchor_id), NULL)) STORED,
  title            VARCHAR(120) NULL,         -- group name; entity titles derive live
  created_by       TINYINT NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_id  BIGINT UNSIGNED NULL,      -- denormalized for the pulse
  last_message_at  DATETIME NULL,
  archived_at      DATETIME NULL,
  UNIQUE (anchor_key)                         -- one thread per entity; NULLs don't collide
)

chat_members (
  room_id       INT UNSIGNED NOT NULL,
  user          TINYINT NOT NULL,
  last_read_id  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  notify        VARCHAR(8) NOT NULL DEFAULT 'all',   -- all | mentions | none
  joined_via    VARCHAR(12) NOT NULL,                -- manual | posted | mention | task | created
  joined_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at       DATETIME NULL,
  PRIMARY KEY (room_id, user),
  KEY (user, room_id)
)

chat_messages (
  id           BIGINT UNSIGNED PK AI,
  room_id      INT UNSIGNED NOT NULL,
  user         TINYINT NOT NULL,              -- 0 = automation
  body         TEXT NOT NULL,                 -- plain text + [[ref]] tokens; app cap ~4000 chars
  refs         JSON NULL,                     -- resolved snapshot (§2)
  mentions     JSON NULL,                     -- user ids; drives notify
  reply_to_id  BIGINT UNSIGNED NULL,          -- flat quote-reply, not nesting
  via          VARCHAR(12) NOT NULL DEFAULT 'app',   -- app | email_reply | automation
  created_at   DATETIME(3) NOT NULL,
  edited_at    DATETIME NULL,
  deleted_at   DATETIME NULL, deleted_by TINYINT NULL,   -- tombstone (P3)
  log_id       INT NULL,                      -- set by Promote to log (tier bridge)
  task_id      INT UNSIGNED NULL,             -- set by message → task
  KEY (room_id, id)
)

chat_message_history (message_id, body, edited_by, edited_at)   -- prior bodies (P3)

push_subscriptions (                          -- generic: tasks/alerts can use it later
  id, user TINYINT, endpoint TEXT, endpoint_hash CHAR(64) UNIQUE,
  p256dh, auth, user_agent, created_at, last_ok_at, failed_at
)

chat_reply_tokens (
  token CHAR(22) COLLATE utf8mb4_bin PK,      -- lib/token generateToken; _bin = case-sensitive
  user TINYINT, room_id INT UNSIGNED,
  created_at, expires_at, revoked_at, uses
)
```

- `user` columns match `users.user` (signed TINYINT, FK by convention — see §6).
- `anchor_key` + UNIQUE is the "one thread per entity" guarantee without a partial index — the same generated-column technique as `mail_messages.in_inbox`.
- **Size:** text only. A busy 6–10-person office ≈ 200–500 messages/day × ~400 B ≈ 30–70 MB/yr with indexes. Fine on Cloud SQL.

## 4. Components

### 4.1 API and service
`routes/api.chat.js` + `services/chatService.js` (house pattern: route → service ← internal_function). A post is ONE pure-DB `withTransaction` span, `retries:1`: insert the message, bump `chat_rooms.last_message_id/at`, auto-join, store refs. Side effects (push, nudge jobs) run post-commit and fire-and-forget with `.catch()` — verify outcomes from the DB, not the UI.

### 4.2 Transport — the pulse
- `GET /api/chat/pulse?since=<max id seen>` → `{rooms:[{id, last_message_id, unread}], max_id}`. One indexed query over the caller's memberships (`chat_members (user, room_id)` → `chat_rooms`); `unread` capped (99+).
- Cadence: chat pane focused ~5 s; shell visible ~15 s; tab hidden ~60 s; back off on errors. Later, optionally: one poller per browser elected over BroadcastChannel (`yc-sync` already owns a channel).
- **Needs an audit exemption.** Every authorized request writes a `jwt_api_audit_log` row — ~2.1 KB each (133 MB / 64k rows live, the 4th-largest table) — and `lib/auth.jwtOrApiKey.js` has no skip mechanism. A 15 s pulse across a handful of users is ~13 MB/day. Proposal: a short constant allowlist of pulse routes that skip the success-path INSERT (auth still enforced, failures still logged); `/api/system-status` (polled every 10 min per open shell) is the obvious second member. Ruling needed (OQ4).
- **Rejected for now:** SSE / WebSockets. An open stream keeps an instance billed all day (the unfunded `min-instances`) and needs cross-instance fan-out (maxScale 6, no Redis — it would fall back to DB polling server-side anyway). Revisit trigger: `min-instances` funded.
- **Same-browser frames:** a post emits on `yc-sync` so the case tab and the hub update instantly; register the matcher in the same slice (CLAUDE.md sync-bus rule).

### 4.3 Surfaces
- **Comms hub, third tab `Chat`:** thread list (entity threads you are in, rooms, DMs) with unread, thread view, composer with `#`/`@` pickers, chips. The sidebar Comms badge (`commsBadgeSet`) adds chat unread.
- **Entity pages:** `case.html` and `contact.html` gain a `chat` tab (`chatButton`, so `&tab=chat` deep-links); the task view gets a thread panel.
- **Boot param** `?chat=<room>[,<msg>]` for notification clicks — a one-shot, scrubbed after firing like `?case=`.
- **Phone-first:** every chat surface passes `scripts/mobile-survey` at 320/375/414. These users live on their phones.

### 4.4 Notifications
Per recipient per message, honouring the member's `notify` (all | mentions | none) and quiet hours (OQ3):
1. **In-app** — the pulse drives badge + toast (suppressed while viewing that room).
2. **Web Push** — `public/sw.js` (install-only today) gains `push` + `notificationclick` (opens `?chat=`); VAPID key pair in env; `web-push` dependency; `push_subscriptions`. Sent immediately, post-commit. **iOS delivers only to a home-screen-installed PWA (16.4+)** — onboarding includes "Add to Home Screen" (the manifest exists: `/assets/manifest.json`).
3. **SMS nudge** — only if still unread after N minutes AND the user has not pulsed in ~2 min. A one-shot `scheduled_jobs` row with `idempotency_key = chatnudge:<room>:<user>` (dedupe on pending/running — the `sequenceEngine` pattern), fired by `process-jobs` (the Cloud Tasks accelerator covers short delays). **Body-free:** "New message from SB on Smith — <link>". `phoneService.sendSms` from the firm staff line to `users.phone` where `allow_sms = 1`. Reason: client data on carrier SMS and lock screens.
4. **Email digest** — per room, at most one per window, bodies included (every staff `users.email` is a firm address today), each with a Reply button (§4.5).

### 4.5 Reply page (R2)
- `GET|POST /cr/:token` — free as of 2026-10-12 (`/r/` = redirects, `/m/` = manage). Served on the landing host like `/c/`: add to `landingAllowed` + `isMigratedPath`, mirror CTA's LOCK tests.
- Token: `lib/token` `generateToken` (22-char base62), scope = (user, room), 7-day expiry, revocable, **minted per digest email** so revocation is granular.
- GET shows the last ~10 messages (escaped) and a textbox; POST posts as that user with `via='email_reply'` and marks the room read. Rate-limited (the `/t/` `readLimited` pattern).
- Accepted risk: whoever holds the email can post as that user into that one room until expiry — the same class as `/t/` task tokens.
- Later: true "just hit Reply" via plus-addressed tokens on the mailbox ingest.

### 4.6 Tasks ↔ chat
- **Message → task:** a prefilled dialog; `task_source='chat'`, `task_dedupe_key='chatmsg:<id>'`, `task_link` from the room's anchor (case/contact), `task_desc` = message text + a link back. The message gets `task_id` and shows a "→ task #N" chip.
- **Task → thread:** an entity thread anchored to the task; `task_from` and `task_to` auto-join. Task emails can link `?chat=`.

### 4.7 Promote to log
Writes a `log` row (`log_type='note'`, `log_extra {chat_message_id, room_id}`) about-linked to the anchor (`logService.setLogAbout`) and sets `chat_messages.log_id`. The log row is a snapshot — later edits to the message do not propagate.

### 4.8 Automation posts (later slice)
Internal function `chat_post(anchor | room, text, cta_id?)` posting as user 0, optionally carrying CTA buttons — HITL in the matter's thread instead of another email that gets ignored. CTA exposure decision (CLAUDE.md): proposal — add it to `CTA_FN_DENYLIST` (a minted link should not post as automation).

### 4.9 Search
`LIKE` over threads the caller can read (escape `%`, `_`, `\` — `NO_BACKSLASH_ESCAPES` is off); FULLTEXT later.

### 4.10 Attachments
v1: none, except refs to existing documents (`[[doc:<id>]]`). Later: a case-anchored thread uploads into the case's Dropbox folder through the existing documents pipeline (the file lands in the file; chat holds the doc ref). Group/DM files go to GCS.

### 4.11 AI seat (later)
A member of kind `ai` with a scoped capability key from the access-control arc ("@ai summarize this thread"). Out of v1; it must not shape v1.

## 5. Slices (indicative — refine)

- **C0** schema + `chatService` + API (rooms, members, messages, pulse, ref parser, `chatAccess`) + the audit-exemption mechanism. Real-MySQL harness for the pulse/unread queries (the `mailboxS2.mysql` pattern).
- **C1** Comms hub Chat tab: list, thread view, composer, pickers, chips + deep links, read state, adaptive pulse, badge, `yc-sync` matcher.
- **C2** Entity tabs (case/contact `chat` tab, task panel) + `?chat=` boot param.
- **C3** Web Push: `sw.js` handlers, VAPID, `push_subscriptions`, subscribe UI, install-to-home-screen onboarding.
- **C4** Nudge ladder: `scheduled_jobs` nudges, SMS, email digest, per-member notify, quiet hours.
- **C5** Reply page `/cr/` (small; can ride C4).
- **C6** Message → task, promote → log, edit-history UI, search.
- **C7** Automation posts + CTA buttons in thread.
- **Later:** attachments, FULLTEXT, AI seat, SSE.

**Restart MVP = C0–C5.**

## 6. YC3 notes

- All tables are tenant-local — compatible with DB-per-tenant as-is. No module-scope caches of rooms/members/subscriptions (tenancy audit §A3).
- Nudges ride `scheduled_jobs` / `process-jobs`, so they inherit that path's tenant-identity work (tenancy invariant 6 / P0-8) — no new cron entry point.
- VAPID: one key pair per deployment is fine (it identifies the sending server); subscriptions are tenant-local; the push payload carries an absolute tenant URL so `notificationclick` opens the right host.
- The reply page lives on the pages origin (`<slug>.p.yisracase.com/cr/<t>`); tenant resolved by Host like every landing route.
- The anchor vocabulary is generic (`case` becomes the v3 matter; contact/task unchanged). Nothing bankruptcy-specific.
- **Found while designing:** `users.user` is a SIGNED TINYINT (−128..127), while `tasks.task_from/task_to` are TINYINT UNSIGNED — a 127-user-per-tenant ceiling across the schema that `ref/AUDIT_TENANCY.md` does not list. Chat matches the current type; widening is a schema-wide tenancy item, not this arc's.

## 7. Open questions

1. **DM privacy vs SU and `ycro_` keys** (Fred pondering). Shaping fact: `lib/sqlGuard` `SECRET_TABLES` is table-granular (word-boundary regex on table names), so "DMs hidden, entity threads visible" cannot be a row filter. Options:
   - **A.** DMs readable by SU and RO keys like every other table; the UI says so plainly ("not private from admins").
   - **B.** All chat RO-blind (`chat_messages` in `SECRET_TABLES`). Cost: Claude triage/debug sessions lose case discussions.
   - **C.** Base table secret + an RO-visible VIEW excluding DM rooms (`chat_messages_ro`; `\bchat_messages\b` does not match it). Caveat: views carry a DEFINER — the same strip-on-dump landmine as triggers.
   - **D.** No DMs in v1: every conversation is a room or an entity thread (records-friendly; common firm policy).
   The schema is identical under all four — only `sqlGuard` and the UI differ — so this does not block C0.
2. **Records policy (SS):** retention, legal hold, export with the case (a thread transcript into the case folder at close?). Default until ruled: no purge.
3. **Notification defaults:** nudge delays (proposal: 10 min, 3 min for @mentions), quiet hours, SMS on or off by default. Per-user timezone has no home yet (no per-user prefs table — the My Settings arc owns that); users do not all share the firm's timezone.
4. **Audit exemption** for pulse routes (§4.2): accept the security-log trade, or keep auditing at a slower cadence?
5. **Entity-thread auto-join:** beyond poster / @mention / task parties, should anyone be auto-followed on a case thread (e.g. a responsible-staff field, if one is added)?
6. **Group rooms:** any staff member can create one, or admin only? Archive rules.
7. **Policy (SS, not code):** does the firm require client-matter discussion to move off private phones? Adoption hinges on it.
