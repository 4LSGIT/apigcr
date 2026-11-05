# YisraMail — consent, bulk email & campaigns v2 (DESIGN)

Status: **DRAFT v0.5 — 2026-10-29. P1 (consent core) built — §4.4 "As built";
P2 (inbound SMS opt-out) built — §4.6 "As built"; P3 (email unsubscribe
surface) built — §4.5 "As built"; P4 (staff consent UI) built — §4.7 "As
built"; T1 (transport contract) built — §5.2 "As built"; T2 (events) built —
§5.4 "As built" (parsed shapes confirmed on captured events except Reject /
DeliveryDelay / Rendering Failure); C1 (campaign hardening) built — §6.1 and
§6.4 "As built (C1)"; C2 (the marketing send path) built, landing dark —
§6.4 / §6.5 "As built (C2)" (the SES account-pause reply shapes are
`VERIFY(live)`); C3 (designs library + the Designer editor) built — §6.3
"As built (C3a — server)" / "As built (C3b)"; C4 (segments + reporting)
built — §6.2 / §6.5 "As built (C4)"; C7 (promotional automations) built —
§6.4 "As built (C7)"; nothing else built.** Ruled 2026-10-29 (Fred):
D0 build, D1 no marketing SMS in v1, D2 (a) destination-keyed consent, D6
Amazon SES, D9 GrapesJS + MJML (spike first), D11 no tracking in v1 / C6
later; D15 no RC push in v1, D16 over-cap operational sends with
`campaigns.bulk`, D17 bounce tasks for clients only; D18 opt-outs gate
PROMOTION, not operational automation; D19 an SMS STOP still stops automated
texts. D5 ruled 2026-10-30 for SS's own lead lists; still open for the
Criminal Law list and `temp_contacts` (Fred + SS). Open: D8 (SS); D3, D4, D7, D10, D12–D14 stand as
recommendations until ruled. v0.5 also folds in a second,
unaffiliated review (send reservation / at-most-once, transport rate limit,
pause semantics, complaint hold before the first send, re-consent guard,
EventBridge DLQ). v0.3 folds in an
independent review against code `08f1737` + the live DB (2 blockers, 8 majors,
11 minors — all addressed below).
Supersedes the "YisraMail direction" entry in `ref/plans.md` (which now
points here). Related: `ref/MAILBOX_SYSTEM_DESIGN.md` §4.2 (`bulk_ok`, hub
budget), `ref/EMAIL_PROVIDER_PLAN.md` (bulk rule, OQ6), `services/optoutService.js`
(ruling 2026-10-27), `manual/01-YisraCase-overview/11-campaign-manager.md`.
The provider and builder surveys behind D6/D9 are archived in
`ref/archive/YISRAMAIL_SURVEY_2026-10-29.md`; Appendix C (compliance facts) stays
here because §4 is built on it.

## 0. Summary

1. **Consent first — Phase 1 is a hard gate.** No marketing send, email or
   SMS, until scoped destination-keyed consent with a ledger, a working
   unsubscribe (link + RFC 8058 one-click + preference page) and inbound SMS
   opt-out handling are live (§4).
2. **Opt-outs gate promotion, not operational mail (D18).** Automations
   stand in for a person ("your payment failed", "your appointment is
   tomorrow"); they are operational and keep sending after an email
   unsubscribe. Consent gets scopes stored by address with a ledger:
   email opt-outs are marketing-only; an SMS STOP (scope `all`) still stops
   every automated text — the law and the providers both require it (D19).
   Marketing sends stay off behind a kill switch until the consent gate is
   met (§6.1).
3. **SMS:** the providers enforce STOP themselves — RingCentral per (number,
   recipient) pair, **Quo across every Quo number**. Marketing SMS is out of
   v1 (ruled) and, if ever done, runs on its own RingCentral number and 10DLC
   marketing campaign (§4.6, D1).
4. **Transport = a driver, not lock-in** (§5.1, D7) — the existing email/
   phone adapter pattern. Every candidate speaks SMTP, so the existing `smtp`
   adapter sends; per-provider code is the events parser. YC owns list,
   consent, templates and the campaign engine.
5. **Provider: Amazon SES — ruled** (pay per use, no monthly commitment,
   ≈ $1/mo at 10k, own unsubscribe headers allowed, tenants for YC3) (§5.5, D6).
6. **Campaigns: enhance, don't replace** (§6, D10) — add a send class
   (operational mail merge ≤ 50 vs marketing broadcast), topics, rate control
   that doesn't starve the job queue, events and reporting.
7. **Builder: GrapesJS + grapesjs-mjml — ruled** (BSD, in-browser, no vendor,
   no per-tenant cost), spike first; fallback Unlayer Launch $250/mo (§7, D9).
8. **Bankruptcy-specific:** every marketing email carries the 11 U.S.C. §528
   debt-relief-agency statement, a responsible attorney (MRPC 7.2(d)), the
   postal address and an ad label; copies kept 2 years (MRPC 7.2(b)) — SS to
   confirm wording (Appendix C).

## 1. Goal and scope

SS wants a monthly email newsletter (and occasional small announcements) to
past leads, prospects and clients. That needs, in order:

1. **Consent** — unsubscribe for email, STOP handling for SMS, scoped so a
   marketing opt-out never stops case mail (Phase 1, a hard gate).
2. **A bulk transport** — a provider whose terms allow marketing mail, on a
   sending subdomain, with bounce/complaint events (Gmail/Workspace and
   Migadu are not bulk transports — `ref/EMAIL_PROVIDER_PLAN.md` bulk rule).
3. **Content** — a drag-and-drop builder for designed newsletters.
4. **Campaign engine changes** — send class, topics, rate, events, reporting.

Out of scope for v1: marketing SMS (D1), drips/journeys (sequence enrollment
later), A/B testing, YC3 provisioning. Open/click tracking shipped after v1
as C6 (§6.5 "As built (C6)").

## 2. Volume assumptions

Fred's planning numbers hold against the data: a monthly newsletter of
1–2k plus small bursts, < 5k/month. Ceiling if every list is merged:
1,080 contacts with an active email + 2,022 `temp_contacts` (all distinct,
**zero overlap** with contacts) + the 1,494-row legacy list (overlap with
`temp_contacts` unknown) ≈ **4.6k addresses**. Provider sizing therefore uses
**≤ 5k per send, ≤ 10k/month**, and a single-day burst of the whole list.

## 3. Current state (verified 2026-10-29 against main `1e64d4e` + live DB; re-verified by the review against `08f1737`)

The pre-build snapshot. What P1 and P3 changed since is in §4.4 and §4.5 "As built".

| Area | As built | Gap for bulk/marketing |
|---|---|---|
| Consent | `contact_phones.sms_optout` / `contact_emails.email_optout` on the ACTIVE row; sends read them through `services/optoutService.js`, but several writers and readers touch the row flags directly (§4.4); automation refuses, staff sends warn (409 + acknowledge). Live: 1 SMS opt-out, 0 email. | One scope: "nothing on this channel". No topic/marketing scope, no ledger (who/when/how — the proof), lost when the row is ended or the address moves; addresses outside `contacts` (imports) can't be suppressed. |
| Inbound STOP | Not handled (`ref/plans.md` "Recipient opt-out" follow-ups). RC delivery codes `SMS-RC/UP/CAR-413` map to `delivery_reason='opted_out'` (`services/adapters/phone/ringcentral.js:367`); live `phone_event_log` has 0 `opted_out` rows and 0 exact STOP-keyword inbound bodies in 3,474 inbound texts since 2026-05-31. | Nothing sets consent from a keyword, a provider opt-out signal, or a free-text "stop texting me". |
| Unsubscribe | None. No link, no `List-Unsubscribe` header, no page; `emailService` exposes no custom-header option outside the hub's threading headers. | CAN-SPAM opt-out mechanism + footer; RFC 8058 one-click. |
| Campaigns | `campaignService` + `campaign.html`: filter audience → `campaign_contacts` frozen → one `campaign_send` scheduled_job per contact (bulk INSERT, **no doorbell**) → `executeSend` → `emailService.sendEmail(from=campaigns.sender)` / `phoneService`. Editors: Quill rich text / HTML code; placeholders via `resolverService` (contacts refs only). | No cap (ruled 50, unbuilt), no class, no bulk transport, no topics/lists, no designs library, no events (delivered/bounce/complaint), no rate control. |
| Throughput | `process-jobs` cron claims `ORDER BY scheduled_time LIMIT 10` per minute. Campaign jobs ride only that claim. | 2,000 recipients ≈ 3.3 h, and every cron-only job due after the campaign's `scheduled_time` queues behind it (doorbelled workflow/sequence jobs are unaffected — they claim by id). |
| Transports | `email_credentials`: 9 `gmail` (one Workspace account), 2 `smtp` (SiteGround). Adapter contract in `services/emailService.js` header; capabilities object exists. Hub budget per transport (1500 gmail / 300 smtp per 24 h, `mailboxSendService`). | No `bulk_ok`, no provider for bulk, no events webhook. |
| Usage | 97 email + 21 SMS campaigns ever; real sends max 12 recipients — campaign 85 (2026-01-12, an IT test) sent 125 (its `contact_count` is 0: rows created before that column carry 0, so count `campaign_results`, not `contact_count`); last email campaign 2026-06-15. | Today's campaigns are mail-merge, not marketing. |
| Audience | 1,109 contacts; 1,080 with an active email, 1,085 with an active phone. `temp_contacts` 2,022 rows (all with email+phone, provenance unknown). Legacy FB/lead list 1,494 (outside YC). | Ceiling ≈ 4.6k addresses before de-dup. Provenance of the two outside lists is unknown. |
| Public origin | Landing hosts `4lsg.com,www.4lsg.com`; sessionless; routes ENUMERATED in `routes/pageLanding.js` (`/t/`, `/d/`, `/c/`, `/m/`, `/v/`, `/p/`…). `/u/` is unused. | Unsubscribe page + one-click POST need two new enumerated routes. |
| Firm data | `app_settings.firm_name` "Legal Solutions Group", `firm_address` "18481 W. 10 Mile Rd., #100, Southfield, MI 48075". | Footer source exists. |

## 4. Consent & unsubscribe — Phase 1, the gate

### 4.1 Principles

- **Consent belongs to a destination** (a normalized address or 10-digit
  number), per channel — not to a contact and not to a contact row. A person
  who says stop at an address stays stopped when staff end the row, move the
  address to another contact, or the address arrives in an import.
- **Consent gates promotion, not operational mail (D18, Fred 2026-10-29).**
  Every send is `operational` (case/appointment/payment/document mail — an
  automation standing in for a person, a staff message, an operational
  campaign) or `promotional` (marketing campaigns; later, automations flagged
  promotional — slice C7). Email: CAN-SPAM reaches commercial mail only, so
  an email opt-out is a marketing opt-out and **operational email is never
  blocked by consent**. SMS: a STOP revokes consent for texts generally
  (FCC "any reasonable means"), and RingCentral/Quo block the recipient
  themselves, so **an SMS STOP blocks operational texts too** (D19) — the
  client is reached by phone/email instead (§4.6 staff task).
- **Scopes.** Email: `marketing` (every marketing topic) and `<topic>`
  (e.g. `newsletter`) — there is no email `all`. SMS: `all` (STOP, staff,
  provider signal) and `sms_marketing` (future, D1).

  | send | email checks | SMS checks |
  |---|---|---|
  | operational | nothing | `all` |
  | promotional | `marketing` + topic | `all` + `sms_marketing` (refused in v1, D1) |
- **Every change is an event.** An append-only ledger (who/what/when/how,
  with evidence) is the proof; a current-state table is what sends read. One
  writer keeps them in step, on the caller's transaction, order-independent
  (§4.3).
- **Marketing class is fail-closed.** A marketing send that cannot prove an
  unsubscribe link + postal address in its rendered body, or whose recipient's
  state can't be read, does not go.
- **Never rely on one signal.** STOP may never reach our webhook (see
  Appendix C); provider opt-out lists/delivery codes and free-text replies
  feed the same ledger.

### 4.2 Data model (proposal — names provisional)

```sql
-- topics are config-as-data (YC3): a tenant adds a newsletter without code.
CREATE TABLE comm_topics (
  topic_key     varchar(40)  NOT NULL PRIMARY KEY,   -- 'newsletter', 'events', 'sms_marketing'
  channel       enum('email','sms') NOT NULL,
  label         varchar(100) NOT NULL,               -- shown on the preference page
  description   varchar(255) NULL,
  consent_model enum('opt_out','opt_in') NOT NULL,   -- email newsletter: opt_out; marketing SMS: opt_in
  active        tinyint(1) NOT NULL DEFAULT 1,
  created_at    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- the proof. Never updated, never deleted (retention: forever, tiny rows).
CREATE TABLE comm_consent_events (
  id                bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel           enum('email','sms') NOT NULL,
  destination       varchar(254) NOT NULL,       -- lowercased address | 10 digits
  scope             varchar(40)  NOT NULL,       -- 'all' | 'marketing' | topic_key
  action            enum('opt_out','opt_in') NOT NULL,
  source            varchar(32)  NOT NULL,       -- staff | unsub_page | one_click | pref_page | sms_keyword |
                                                 -- sms_review | provider_optout | provider_bounce |
                                                 -- provider_complaint | import | web_form | migration |
                                                 -- row_replace (a corrected number/address inherits the old one's opt-out)
  provider_event_id varchar(128) NULL,           -- provider message/event id when the source is external
  occurred_at       datetime(3)  NOT NULL,       -- when it happened (provider time when known)
  contact_id        int unsigned NULL,           -- best-effort attribution at the time
  line_number       char(10) NULL,               -- SMS: the firm line it arrived on / was sent from
  send_ref          varchar(64)  NULL,           -- campaign_results id / provider message id
  evidence          json NULL,                   -- ip, user_agent, keyword text, raw inbound body,
                                                 -- consent wording shown, form id …
  actor_user_id     int NULL,                    -- staff edits
  created_at        datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_dest (channel, destination, occurred_at),
  UNIQUE KEY uk_source_event (source, provider_event_id)   -- NULLs never collide
);

-- what sends read. One row per (channel, destination, scope) ever touched.
CREATE TABLE comm_consent_state (
  channel       enum('email','sms') NOT NULL,
  destination   varchar(254) NOT NULL,
  scope         varchar(40)  NOT NULL,
  state         enum('opted_out','opted_in') NOT NULL,
  occurred_at   datetime(3) NOT NULL,            -- of the event that set it
  last_event_id bigint unsigned NOT NULL,
  updated_at    datetime(3) NOT NULL,
  PRIMARY KEY (channel, destination, scope)
);

-- per-recipient unsubscribe capability (one per marketing send).
CREATE TABLE comm_unsub_tokens (
  token        char(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY, -- lib/token.js
  channel      enum('email') NOT NULL DEFAULT 'email',
  destination  varchar(254) NOT NULL,
  topic_key    varchar(40)  NOT NULL,
  campaign_id  int NULL,
  contact_id   int unsigned NULL,
  send_ref     varchar(64)  NULL,              -- campaign_results id / provider message id passed at
                                               -- mint; copied onto the consent event (§6.5 reports
                                               -- unsubscribes from the ledger by send_ref)
  created_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at      datetime NULL                   -- first use; the link keeps working after
);
```

Provider signals map to scopes: a **complaint** → `opt_out` scope
`marketing`; a **hard bounce** → `opt_out` scope `marketing`, source
`provider_bounce` (deliverability, not consent, but it suppresses the same
way). A hard bounce on a **client** (contact with a Primary/Secondary case)
also opens one staff task — "case email to this address is bouncing too" —
for the firm's consent follow-up assignee, `consent_task_user_id` (D17; `cases`
has no assigned-staff column); bounces on
non-clients only count in the campaign's stats (a cold import would
otherwise flood tasks). Re-opting-in an address the SES account suppression
list holds needs the driver to remove it there too (`events`-side hook, T2).

### 4.3 Read/write API — `optoutService` stays the ONE reader

```
findOptedOut(db, channel, dest, { klass = 'operational', topic } = {})
  operational, email → never blocked (returns [])
  operational, sms   → blocked by scope 'all'          (today's SMS behaviour)
  marketing (promotional) → email: 'marketing' | topic; sms: 'all' |
                topic; and, for an opt_in topic, also blocked unless
                state(topic) = 'opted_in'
  hit shape UNCHANGED: { channel, destination, contact_id, contact_name, row_id }
  — contact_id/row_id via LEFT JOIN to the destination's ACTIVE row; a
  destination with no row returns null ids and who() prints the address only
  (never "contact #0"). Audit sites read hit.contact_id (api.cta.js,
  api.mail.js, api.phoneComms.js, routes/internal/*).
assertNotOptedOut / optoutGate / *OptedOutSql — same, new optional opts
recordConsent(conn, { channel, destination, scope, action, source, occurredAt,
                      providerEventId, contactId, lineNumber, sendRef,
                      evidence, actorUserId })
```

`recordConsent` takes the **caller's connection** (never opens its own
`withTransaction` — that always borrows a fresh connection, so a consent
write inside `contactService`'s save would commit or roll back separately):
1. `INSERT IGNORE` the event (`uk_source_event` makes a provider redelivery
   or a nightly reconcile a no-op);
2. guarded upsert of the state row — the new event wins only if
   `(occurred_at, id)` is newer than the stored `(occurred_at, last_event_id)`.
   Order-independent: two racing writers, or a reconcile replaying an old
   opt-out after a newer START, can't leave state pointing at the older event.
Callers without a transaction wrap it in `withTransaction(fn, { retries: 1 })`
(pure DB). `FIND_SQL` changes, so `tests/helpers/optoutFake.js` and the test
worlds that answer it by identity change in the same slice; the predicates
stay held to real MySQL in `tests/optout.mysql.test.js`.

### 4.4 Migration of today's flags — D2 RULED (a)

The state table — the scope list stored by address — is THE truth for every
scope; `sms_optout` / `email_optout` become a cache for one release, then drop
with the column-drop sweep (CLAUDE.md). **It is not "callers untouched"**:
every writer and every reader that bypasses `optoutService` moves in P1.

**The two flags mean different things from P1 on (D18/D19):**
`contact_phones.sms_optout` = SMS scope `all` (unchanged: automation
refuses, staff warned). `contact_emails.email_optout` = email scope
`marketing` — relabelled on the contact form "No marketing email"; it no
longer stops automation or warns staff (live: 0 email opt-outs, so nothing
in flight changes). This revises the 2026-10-27 read rule for email only.

**Re-consent guard.** An `opt_in` is never manufactured by an ordinary save:
- creating a row (any path — form, Casey, intake, transfer) never opts in;
  an incoming `0` / omitted flag on create is ignored when the destination's
  state is `opted_out` (the new row's cache is read FROM the state);
- an update records a consent event only when the flag the caller sent
  differs from the row's current value (which the cache keeps equal to the
  state) — an unrelated field edit records nothing;
- an `opt_in` needs an explicit consent action with attribution: a staff
  toggle on an existing row (`source='staff'`, `actor_user_id`), a provider
  opt-in keyword (`sms_keyword`), the preference page (`pref_page`), or
  P4's consent control (with a note as evidence);
- cache synchronisation writes (recordConsent updating the row column) are
  never themselves consent events.

Writers (all must call `recordConsent`, in the same deploy that switches reads):
- `services/contactPhoneService.js` create/update (`sms_optout` in the
  validated fields and the `ALLOWED` list) and `services/contactEmailService.js`
  likewise — behind `routes/api.contactPhones.js` / `api.contactEmails.js`.
- `services/contactService.js` aggregate save, including end-and-replace,
  which today copies the flag onto the corrected row.
- Casey's `contact.phone/email.create/update` kinds (`services/assistantService.js`
  `CONTACT_*_CREATE_KEYS` and the update kinds).

Readers that bypass `optoutService` today:
- `services/assistantService.js` send-recipient check reads `row.sms_optout` /
  `row.email_optout` and uses `row.updated_at` as its concurrency stamp — a
  state-table change won't move it; it must read consent through the service
  and version on the consent state too.
- `public/assistant.html` re-checks the row flag at click time;
  `public/forms/contact-form.html` renders it.
- Reports expose the columns (`lib/reportSchema/manifest.js`); the AI prompts
  (`lib/aiPrompts/assistantPlan.js`, `assistantAnswer.js`,
  `assistantTaskDraftRepair.js`) tell the model "the row's flag is the only
  consent field".

Row lifecycle under (a): a number/address **moved to another contact keeps
its opt-out** (today the transfer INSERTs the new row with the flag at 0 —
`contactService._propagatePhone` / `_propagateEmail` collision branches and
the intake transfer — silently dropping it); a new row's cache column is read
from the destination's state, never defaulted. A **correction to a different
number/address** (end-and-replace in `_applyPhonePlan` / `_applyEmailPlan`)
keeps today's behaviour of carrying the opt-out, recorded as an explicit
`row_replace` event for the new destination.

Transition (fail closed): during the cache release a destination counts as
opted out for the flag's scope (SMS `all`, email `marketing`) if EITHER the
state table or the active row's flag says so; writers write both. Run the migration (live flags →
`source='migration'` events) before the backend deploy AND again after it,
so a flag written in the gap isn't lost. Consent writes on contact rows are
announced on the sync bus (`public/js/yc-sync.js` MATCHERS + the response's
`changes`) like any other row write.

Rejected alternatives: (b) row flags stay the truth for `all` — two stores,
and an `all` opt-out still dies with its row. (c) a list of scopes on the row
— dies with the row (end/transfer/re-add), can't suppress addresses no row
holds, can't express opt-in-with-proof, and still needs the ledger. The
contact form shows (a) exactly as (c) would: a checkbox per scope per
address/number.
This revises the STORAGE half of the 2026-10-27 ruling (row → destination);
its read rule (one service, automation refuses, staff warn) stands.

**As built (P1).** Where the build chose within this section, or diverged:
- **The writer** (`optoutService.recordConsent`) inserts the event with a plain
  INSERT and treats only an `ER_DUP_ENTRY` on `uk_source_event` as the no-op —
  not `INSERT IGNORE`, which under the relaxed sql_mode also turns a bad enum,
  a NULL or a truncation into a warning and a stored row. The guarded upsert
  is two statements under the row lock: a seed (`INSERT … ON DUPLICATE KEY
  UPDATE scope = scope`, which also takes the lock) then
  `UPDATE … WHERE (occurred_at, last_event_id) < (new pair)` — one
  ODKU would depend on MySQL's left-to-right assignment order. Values are
  validated in JS first (channel, scope per channel — `all` is SMS-only,
  `marketing` email-only, a topic must exist on that channel — action, source,
  a normalizable destination).
- **Lock order, every writer: the destination's contact row, then its state
  row.** A row writer holds its row by primary key and passes it to
  recordConsent (`rowId`), which then takes no further row lock and syncs the
  cache by primary key. A direct caller (the migration; P2's
  `phoneConsentService` and P4's import in `routes/api.consent.js` take that
  same lock themselves first and pass the row on as `rowId`) holds nothing,
  so recordConsent locks the destination's ACTIVE row first
  (`SELECT … WHERE phone_active_uniq = ? FOR UPDATE` — the active-only unique
  key, so ended history rows are never locked, and a concurrent insert waits
  on the gap). A writer must never re-lock its own row through that index: a
  direct caller waiting on the row holds the index entry, and the second ask
  is a deadlock (proven on the engine — the reviewer's suggested `WHERE
  phone = ? AND end_date IS NULL FOR UPDATE` alone deadlocks the same way).
  `withTransaction` retries connection blips only, so the order is
  load-bearing. One deadlock the order cannot prevent is retried: a `FOR
  SHARE` read of a state row that does not exist yet is a GAP lock, and two
  writers holding one gap that both insert their seed row deadlock (two
  saves of never-recorded numbers, or a form save of two rows against a
  direct writer) — so the consent-bearing saves (`contactService.createContact`
  / `updateContact`, the per-row phone / email create and update) re-run
  their pure-DB span once on `ER_LOCK_DEADLOCK` (`lib/withTransaction`
  `retryOnDeadlock`), each attempt from the caller's own input, side effects
  (Google push, domain events) only after the commit. The re-run lands or
  answers a clean 409 `consent_changed`; it runs ONCE — a second deadlock
  surfaces as the save's error (`tests/consentGapDeadlock.mysql.test.js`,
  `tests/consentGapRetry.test.js`). The state is re-read after the upsert with a LOCKING read
  (`FOR UPDATE`), and every read that decides a row's flag is `FOR SHARE`:
  live runs REPEATABLE-READ, and a plain read would return the writer's
  older snapshot (no state row → "missing after its upsert"; a stale row →
  the cache synced to the wrong value).
- **The cache** a row flag holds is the flag's scope: `sms_optout` = SMS
  `all`, `email_optout` = email `marketing` (D18) — recordConsent syncs the
  ACTIVE row's flag when it writes that scope, never for a topic.
- **The reader** (`findOptedOut`) issues two statements — the destinations'
  active rows with their cache flag, and their state rows for the checked
  scopes — plus the topic row when a topic is named, and decides in JS.
  Operational email returns `[]` without a query. An unknown, inactive or
  other-channel topic blocks every destination (fail closed) in
  `findOptedOut` and `*OptedOutSql` alike. D19 as ruled (Fred, 2026-10-29):
  operational SMS = scope `all`, unchanged; reversing it would be one
  line in `blockingScopes`.
- **Casey's consent read** goes through `optoutService.consentVersions`
  (operational read + the newest event id per destination, any scope): the
  send proposal carries `recipient.consent_version`, the phone/email LIST
  routes annotate each active row with `consent: { opted_out, version }`, and
  the card's click-time re-check compares those instead of the row flag. The
  contact-subrecord kinds still diff the row flag (the cache) — moves with the
  column drop.
- **Writers**, on their own connection:
  - a NEW active row (insert, transfer, end-and-replace, reactivation) is
    written first, then `optoutService.bornRow` reads the state and sets the
    flag to max(the caller's intent, carried flags, the state) — never an
    opt-in. A correction's old row always carries (its destination's CURRENT
    consent → `row_replace`); a transfer's donor flag and a reactivated row's
    own history flag carry only where the destination has no state row yet
    (a stale flag never overrides a recorded decision);
  - an ACTIVE row's flag goes through `decideRowFlag`, the three-way compare:
    the contact form sends, per loaded row, the flag it loaded
    (`sms_optout_base` / `email_optout_base`). Sent = base → no decision, the
    cache takes the current state (the repeater resends every field of every
    row, so a stale `0` must not become an opt-in). Sent ≠ base → the user's
    decision, unless base ≠ current → 409 `consent_changed`, nothing written
    (the form offers a reload). No base (Casey, API callers, an older tab) →
    sent vs current. Chosen over the list routes' `consent.version`: the base
    is per flag scope and the aggregate save has no version loaded, while a
    version moves on any scope's change (P3 topics) and would 409 spuriously;
  - who: routes pass `optoutService.consentActor(req.auth)`. An opt-in needs
    a signed-in user — an API key gets 422 `opt_in_needs_staff` and may only
    opt out (evidence `via: 'api_key'` + the key id); in-process automation
    (intake, booking, update_contact) never decides consent. A flag edit on a
    row ended before and after the write records nothing (history). Casey's
    writes are attributed by the card sending `casey_draft_id`, which the
    phone/email routes accept only while it is the user's in-flight ledger
    claim of a matching kind (`assistantActionLedger.attribution`) → evidence
    `{ via: 'casey', draft_id }`.
- **Generic writers:** `update_db` / `insert_db` refuse `sms_optout` /
  `email_optout` (WRITE_POLICY `block`) and realign the cache of every row
  they touch from its destination's state (`after` → `syncRowCaches`, no
  event), so an inserted, revived or renumbered row is never a stray 0.
  `scripts/reviveScalarReplacedValues.js` predates this and says so.
- **Sync bus:** the per-row routes already announce the parent contact
  (`contactSubrecordGetter`, a refetch); the contact form's aggregate save does
  not ride the bus by the bus's own rule ("SCALARS only", yc-sync header) —
  unchanged, consent is no different from any other row field there.
- **Migration:** `scripts/yisramailP1MigrateConsent.js` migrates only active
  flagged rows whose destination has NO state row for the scope — the second
  run (after the deploy) fills gaps and never re-attributes a destination the
  new code already recorded. It verifies the end state (every active flag =
  its destination's state) and is NO-GO on a flag cleared or set outside the
  ledger, printing the SU-console UPDATE that restores the cache from the
  ledger and the form change that records a real decision afterwards — an
  opt_in is a decision, not a migration. A flag the old code writes on a row
  that a transfer then ends, in the minutes between the first run and the
  deploy, is not picked up by the second run (it reads active rows) —
  accepted.
- **Not done in P1:** the two flag columns' COMMENTs still describe the
  2026-10-27 rule (changing a COMMENT is a live-table ALTER — the drop slice,
  `ref/plans.md`).

### 4.5 Email unsubscribe

- **Every marketing send** mints one `comm_unsub_tokens` row and gets:
  - **A fixed compliance footer** — unsubscribe link + "manage preferences"
    (whose menu includes "stop all marketing email", required of a CAN-SPAM
    preference menu), the firm's postal address, the responsible attorney +
    contact (MRPC 7.2(d)), the 11 U.S.C. §528 debt-relief-agency statement
    (bankruptcy ads, incl. electronic messages — attorney to confirm
    wording), and an "advertisement" identification unless the topic's
    consent is affirmative (CAN-SPAM (a)(5)). The footer is a **block** built
    by `lib/complianceFooter.js`, not a resolver placeholder: campaign email
    bodies resolve with `escape:'html'` (`campaignService.bodyEscapeFor`), which
    would escape its markup. Its scalar values are resolver pseudo-tables in
    the `trigger_data` style (`{{send.unsubscribe_url}}`,
    `{{send.preferences_url}}`, `{{firm.postal_address}}` … — in-memory, no
    SQL) for a template that wants to place them itself. In Designer content
    the footer is a **locked block** the editor can't delete; in Rich Text /
    HTML content it is injected **before `</body>`** (or appended when there
    is no `</body>`) — never after `</html>`.
  - **An explicit text part.** Today `executeSend` passes `html` only and
    `htmlToText` (`services/emailService.js`) strips tags, so a URL that lives
    only in an `href` vanishes from the text part. The marketing path builds
    the text part itself (its template copy is stored in the send-start
    snapshot, `campaigns.send_snapshot.text`), rendering links as visible
    URLs. After render the send asserts the unsubscribe URL is in
    the HTML (as an `href`) **and** visible in the text part, else it records
    `failed` (fail closed).
  - Headers: exactly one `List-Unsubscribe: <https://4lsg.com/u/<token>>`
    (HTTPS only in v1; a `mailto:` alternate needs an inbound handler — later)
    and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, plus `List-Id:
    <newsletter.<domain>>` and the driver's correlation headers (§5.2). Both
    List-Unsubscribe headers MUST be inside the DKIM signature's `h=` or
    receivers won't offer one-click (RFC 8058) — verified per provider in
    T1's acceptance test by reading a received message's DKIM-Signature.
- **Retention:** each marketing campaign keeps ≥ 2 years after last use
  (MRPC 7.2(b)) a **snapshot of what was sent** — the rendered template with
  the footer as it stood at send start (footer values come from settings that
  can change), plus recipient results. No campaign delete route exists today
  (`routes/campaign.js`); keep it that way, and a design edit never rewrites
  a sent campaign's stored body.
- **Routes (landing origin, sessionless) — three:**
  - `GET /u/:token` → a page with one "Unsubscribe" button, topic
    checkboxes and "all marketing email". GET itself changes nothing (link
    scanners prefetch GETs); one page + one click satisfies CAN-SPAM
    (Appendix C §C). IP-rate-limited like `/c/` reads.
  - `POST /u/:token` (RFC 8058, mail clients) → unsubscribe from the URI
    alone: accept any content type and ignore the body (RFC 8058 says
    multipart SHOULD be used and `server.js` parses multipart only under
    `/hooks`), `recordConsent(opt_out, scope=topic, source='one_click')`,
    `200` empty body, no auth, never a redirect. **No per-IP limit** — the
    POSTs come from a few mail-provider IPs, and a 429 would silently drop
    unsubscribes; the call is idempotent and token-bound (limit per token
    if anything).
  - `POST /u/:token/prefs` (the page's form) → per-topic opt-out/opt-in,
    `source='pref_page'`, IP-limited like `/c/` posts.
  - All three registered in **every** enumeration in `routes/pageLanding.js`
    (`landingAllowed`, `isCredentialedPath` for noindex, `isMigratedPath` for
    the GET only), each test-locked: a POST missing from the allow-list meets
    `deadPage`'s 303, which breaks RFC 8058's no-redirect rule. Response
    headers as `/c/`: `Cache-Control: no-store`, `X-Robots-Tag: noindex`,
    plus `Referrer-Policy: no-referrer`.
  - Tokens never expire (CAN-SPAM: must work ≥ 30 days after send). Unknown
    token → the same neutral page with "contact us" (no oracle).
- **The page offers marketing scopes only** — there is no email scope that
  stops case mail (D18): an unsubscribe can't silently cut a client off
  from their own case. A free-text box ("anything else?") opens a staff task
  for anything beyond marketing.
- Replies saying "remove me" land in the reply-to mailbox (YC hub); staff
  unsubscribe via the contact page (source `staff`).

**As built (P3).** C2's marketing send mints the tokens (§6.4 "As built
(C2)": one per send, right after the reservation, `send_ref` = its
`campaign_results` id, re-used across a definite retry); the surface went
live and was smoke-tested ahead of it (gate G1).
- **Table** `comm_unsub_tokens` as in §4.2 (with `send_ref`), created by
  `scripts/yisramailP3Migrate.js` (CHECK / `--apply`: verifies every column,
  the keys and — in a rolled-back transaction on the engine — that two tokens
  differing only in case are two rows).
- **Substrate** `services/unsubService.js`: `mintUnsubToken(conn, …)` (C2's,
  on the caller's connection; the topic must exist, be an email topic —
  `optoutService.assertScope`, the check `recordConsent` runs — and be
  ACTIVE; collision retry), `urlFor` / `preferencesUrlFor` (the landing
  origin, `firmConfig.publicUrl()`; preferences = the same page's `#prefs`),
  `lookupToken` (read only, `lib/token.PUBLIC_TOKEN_RE` gate first),
  `oneClick`, `applyPage`. Every write goes through `recordConsent` inside
  `withTransaction(retries: 1)` plus one retry on `ER_LOCK_DEADLOCK`
  (`consentTx`, as in `phoneConsentService`): the page is a direct caller
  that locks the token row and then, through `recordConsent`, the address's
  active row by `uk_email_active`, so a contact-form end-and-replace of that
  same address racing it can deadlock — the retry re-runs the pure-DB span
  instead of answering a mail client's one-click with a 500.
- **Sources:** `one_click` (`POST /u/:token`, scope = the token's topic,
  D4), `unsub_page` (the page's "Unsubscribe from <topic>" → the topic;
  "Stop all marketing email" → `marketing`), `pref_page` (the checkboxes).
  Evidence: `token`, `via` (`rfc8058` | `unsub_page`), `ip`, `user_agent`,
  `campaign_id`; `send_ref` and `contact_id` are copied from the token onto
  the event.
- **Idempotency is on STATE:** an event is recorded only for a scope whose
  requested state differs from the current one — a second one-click writes
  nothing; a one-click after a page opt-in writes again. `used_at` = the
  first POST only.
- **Locks:** the token row `FOR UPDATE` first (serializes requests on one
  token); the current state is then read with a PLAIN read, so the
  transaction's snapshot is taken after that lock — and no state lock is
  taken ahead of `recordConsent`'s contact-row lock (which would invert §4.4's
  lock order); scopes are written marketing first, then topics by key. Held to
  the engine (`tests/unsubService.mysql.test.js`): a same-token race records
  one event; cross-token races for one address, with and without a contact
  row, never deadlock.
- **Re-subscribing after "stop all":** ticking a topic opts `marketing` back
  in AND opts out every unticked topic that would otherwise resume with it.
- **A token whose topic row was deleted:** the one-click falls back to scope
  `marketing` (evidence `topic_missing`) — an unsubscribe is never thrown
  away. A retired (inactive) topic still records its own scope.
- **No oracle:** an unknown token gets the neutral page (200) and a one-click
  on it is 200 empty; a bogus topic key is 422 for unknown and known tokens
  alike (validated before the token is read). An infrastructure failure on
  the one-click is a 500 — an unsubscribe that did not record must not read
  as done.
- **The free-text note** (≤ 1000 characters; longer is kept to 1000, never
  refused) rides on the request's first event (`evidence.note`) and becomes
  ONE staff task after the commit — from 0, `source 'consent'`, linked to the
  token's contact, the full text also in the task's created-log
  `consent_note` — for the firm setting `consent_task_user_id` (an active
  user; Config → Firm → Marketing email & consent; P2's stranded-client and
  text-review tasks read it too). Unset → an IT warning once per UTC day
  (`consent_task_unassigned`), the event flagged `evidence.note_unassigned`; a
  note that changed nothing has no event, so it gets a warning of its own
  carrying the text.
- **The footer** `lib/complianceFooter.buildComplianceFooter({ unsubscribeUrl,
  preferencesUrl, topic, firm? })` → `{ html, text }` (`firm` = C2's
  send-start snapshot of `firmValues()`, held to the same checks; absent, the
  values are read now): ad label (opt_out topics
  only), why + unsubscribe URL (an `href` AND visible) + manage preferences,
  firm name · address · phone, responsible attorney, the §528 statement;
  inline styles, no tables, every value escaped. Throws on a missing firm
  name, postal address or attorney name, or a non-http(s) URL. Settings
  `marketing_ad_label` (blank = "Advertisement") and
  `marketing_debt_relief_statement` (blank = the statutory sentence; SS
  confirms the wording, P0).
- **Resolver:** `PSEUDO_TABLES` = `trigger_data`, `send`, `firm`. `firm.*`
  (name, postal_address, phone, attorney_name, debt_relief_statement,
  ad_label) is computed from `firmConfig` unless the caller passes `refs.firm`
  (C2's send-start snapshot, MRPC 7.2(b)); `send.*` is caller-supplied only.
  `scanExpressionRefs` is unchanged: it still reports `send.*` / `firm.*` as
  table refs, so the whitelist validators built on it (e-sign expressions,
  portal cards, Casey's confirmations) keep refusing them.
- **Body parsing:** `server.js`'s global JSON / urlencoded parsers run before
  every route, so a one-click POST that DECLARES JSON or urlencoded but
  carries a malformed body, or an unsupported charset, is refused by the
  parser (400 / 415) before the route runs. RFC 8058 senders post
  urlencoded or multipart UTF-8, which pass; closing the gap is a
  `server.js` change (`ref/plans.md`).

### 4.6 SMS opt-out

The providers enforce STOP themselves, at a granularity we can't change
(Appendix C §A): **RingCentral blocks the (sender number, recipient) pair;
Quo blocks the recipient on EVERY Quo number in the account** (9800, 4574,
5355 today) and offers no API to read the list or opt anyone back in. YC's
job is to know *before* sending ("may send") and keep the proof; the
provider decides "can send".

- **Where inbound arrives.** Inbound SMS reach `ingestPhoneEvent` only
  through workflows `wf_rc_message_in` (17) and `wf_quo_message` (18), step 1
  `phone_log`, fed by hooks 21 / 16 — editable DB rows, and for Quo YC's ONLY
  opt-out signal. The delivery sync (`services/phoneDeliveryService.js`)
  lists OUTBOUND texts only, so the keyword handler has exactly one path: the
  ingest of an incoming text. Because the wiring lives in the DB, no jest test
  can pin it: `scripts/yisramailP2CheckInbound.js` (read only, `.env` or a
  `ycro_` key) asserts that step 1 of each workflow's published version is
  `phone_log` with `from`, `message`, `link_id` (what `firmToFirm` reads —
  without it every inbound reads as firm-to-firm and the plain-language
  review task never opens), `direction`, `extra.provider`,
  `extra.provider_message_id` and `extra.ts` wired, that both are active and
  fed by an active hook — one GO / NO-GO line, a deploy step. A liveness
  alert per provider covers "the hook went quiet" (below).
- **Keyword handler, called from `phoneIngestService`** (step 2b) after the
  dedup precheck (step 1b, keyed on `provider_message_id` — present on every
  live inbound row) and the catch-all write, before Layer 2/3. Body trimmed,
  case-folded, punctuation stripped, exact single-message match:
  - opt-out: `STOP`, `STOPALL`, `STOP ALL`, `UNSUBSCRIBE`, `CANCEL`, `END`,
    `QUIT`, `REVOKE`, `OPT OUT`, `OPTOUT` → `opt_out`. Quo's docs list only
    the first seven, but live (2026-10-30) Quo acted on `REVOKE` and
    `OPT OUT` too — blocked the number and sent its own confirmation. Every
    word YC honors, the providers honor as well.
  - opt-in: `START`, `UNSTOP` (both providers); `SUBSCRIBE`, `RESUME`,
    `CONTINUE` only on RC lines. Recorded **only when the number is currently
    opted out** — otherwise "continue" is an ordinary reply.
  - Ledger idempotency: `source='sms_keyword'`, `provider_event_id` =
    `'<provider>:<provider message id>'`; `occurred_at` = the provider's
    timestamp (`extra.ts`), never ingest time.
- **Confirmation texts.** RC and Quo send their own for every word they act
  on, which the live tests showed is every word YC honors; YC never sends a
  second (CTIA, FCC (a)(12)). The `consent_sms_confirm` job P2 shipped for
  "words Quo ignores" was removed on 2026-10-30 once REVOKE and OPT OUT both
  proved to be acted on (and Quo refuses the send anyway, 400 `0201400`
  "User Opted Out" — job 12787). If a provider ever stops confirming a
  word, the job comes back as a one-attempt scheduled job through the
  documented gate exemption (`phoneService.sendSms` directly, like the
  portal PIN) — never a send inside the ingest.
- **Scope — D3.** A STOP on any case line → scope `all` SMS (today's
  semantics). The provider block already makes this true for the whole Quo
  account and for that RC pair; matching it keeps automation from sending
  into blocks. FCC 26-67's informational "category" scoping (from
  2026-11-25) can't help: the provider block is absolute.
- **Provider signals (RC).** Read-only, nightly: the account's opted-out
  pairs from RC's consent list, guarded by `occurred_at` so an old opt-out
  never overwrites a newer START; and `SMS-RC/UP/CAR-413` delivery failures
  (already mapped to `delivery_reason='opted_out'`) as opt-outs. **Pushing**
  YC-captured opt-outs to RC (`PATCH …/sms/consents`) is **D15 — ruled: not
  in v1.** A `from:"*"` push blocks every RC line, so a staff-acknowledged
  send ("a reply they requested", the 2026-10-27 override) then fails with
  SMS-RC-413, and a later START on one line lifts only that pair. YC already
  refuses automation; the push would only add protection for texts staff
  send from the RingCentral app directly. Whether the API can opt someone
  back IN is unverified: step 0 got no answer (403 below). RC's consent page
  says the block lifts "only if the customer sends an opt-in keyword"; live,
  ANY later text from the recipient lifts it (Appendix C §A).
- **P2 step 0 (run 2026-10-29).** Live STOP / START on RC line 2486213656
  and Quo line 2484179800 (0 exact STOP keywords in 3,474 inbound texts
  before it): **GO** — every text reached `phone_event_log` within ~4 s,
  with `provider_ref` and `ts`; the providers' own auto-replies are not
  logged. The consent list: **NO-GO** — both the POST `…/search` and the GET
  form answered `403 CMN-408` ("Unauthorized access") for the user behind
  credential 9, rate group Light: the endpoints exist, the permission is
  missing. The reconcile therefore ships dark (`sms_rc_consent_sync_enabled`
  unset); turning it on needs that permission on the OAuth user (a wider
  token) and one real list response captured as the fixture.
- **A STOP on a case line strands a client.** An SMS `opt_out` with scope
  `all` on a client (contact with a Primary/Secondary case) opens a staff
  task: "client opted out of texts — reach them by phone/email". The call is
  how re-consent is recorded.
- **Free-text revocation** ("please stop texting me", "remove me", "wrong
  number"): the FCC's "any reasonable means" standard applies until a sender
  designates an exclusive method (allowed from 2026-11-25; D14 says don't),
  and CTIA expects plain-language opt-outs honored anyway. A word-boundary
  phrase list, on 10-digit senders only (live: 166 inbound texts contain
  "stop" as a substring), opens a staff review task due well inside 10
  business days; staff confirm by ticking the number's opt-out.
- **Marketing SMS — D1 RULED: not in v1.** If ever: a dedicated
  **RingCentral** number on a MARKETING or MIXED 10DLC campaign (sending
  promotional content from a customer-care campaign risks suspension), never
  Quo (one marketing STOP there blocks every Quo line), opt-in topic with
  captured written consent (`web_form` events carrying the exact disclosure
  and form version), national-DNC scrub unless an established business
  relationship applies (attorney call), 8 am–9 pm recipient-local send
  window, brand + "Reply STOP to opt out" in every message.

**As built (P2).** `services/phoneConsentService.js` decides; every write is
`optoutService.recordConsent` (the one writer). Where the build chose within
this section, or diverged:
- **One transaction per consent write**, pure DB (`retries:1`, plus one retry
  on `ER_LOCK_DEADLOCK` — the victim's span rolled back whole). A direct
  caller in P1's lock order: the destination's ACTIVE `contact_phones` row
  locked first through `phone_active_uniq` (the statement `recordConsent`
  runs for a direct caller, also reading `contact_id` and the cache flag),
  handed to `recordConsent` as `rowId`, so nothing is locked twice. An opt-in
  decides "currently opted out" with `optoutService.stateFlag` (FOR SHARE,
  after the row) — the state, or the active row's cache flag where no state
  exists (the reader's dual-read).
- **The keyword handler** runs in `ingestPhoneEvent` only for
  `type='sms' AND direction='incoming'`, after step 1b and the catch-all
  write, before Layer 2. A throw is logged + alerted at `error`
  (`phone_consent_inbound`, deduped per provider message) and the pipeline
  carries on — suppression, rules and the log write still run. The outcome
  lands in `phone_ingest_executions.metadata.consent` (`{ kind, recorded }`,
  or `{ …, error }`) only when something matched or failed; an ordinary text
  keeps the NULL baseline. A firm line texting a keyword is recorded like any
  sender (the provider blocks that pair too); a non-10-digit sender (a short
  code) records nothing.
- **Review**, beyond the phrase list: an opt-out word with nothing but
  courtesy words around it ("STOP PLEASE" — the documented Quo miss; never
  CANCEL / END, which name appointments) is a review too, and so is
  `SUBSCRIBE` / `RESUME` / `CONTINUE` on a Quo line while the number is opted
  out ("Possible text opt-in — review": Quo keeps blocking until START). No
  review for a number already opted out, nor for a firm line. One OPEN review
  task per number (`tasks.task_dedupe_key = 'consent_review:<number>'`, the
  `create_task` FIL-3 pattern; source `consent_review`), due on the third
  firm business day (`calendarService.nextBusinessDay`; calendar +3 when the
  holiday calendar is unreachable). `sms_review` stays unused: the staff
  tick is recorded as `staff` (P1's path), and since P4 it carries the
  staff member's note (`evidence.note`) — a distinct review source is
  deferred (`ref/plans.md`).
- **The stranded-client task** opens only on a TRANSITION into opted out
  (was not, is now — read under the row lock): the same opt-out seen again
  by the 413 path or the reconcile opens nothing. Client = the number's
  ACTIVE row's contact with a `case_relate_type IN ('Primary','Secondary')`
  link (the portal predicate) to a case whose `case_stage` is open
  (`Open` / `Pending` / `Filed` — `case_status` is free text). Title
  "Client opted out of texts — reach by phone/email", source `consent`,
  linked to the contact; created after the commit, never thrown.
- **Assignee** for both tasks: `consent_task_user_id` (P3's key — the firm
  default; `cases` has no assigned-staff column), read through P3's own
  rule, `unsubService.resolveAssignee`: it must name an ACTIVE user. Unset or
  inactive → no task, the `warning` alert P3 raises
  (`consent_task_unassigned`, one shared dedup key per UTC day), the event
  still recorded.
- **No confirmation job.** `consent_sms_confirm` existed from P2's landing
  (72ddf3d) until 2026-10-30: the live REVOKE test (job 12787 — Quo had
  already blocked the number and auto-replied; our send got 400 `0201400`)
  and then OPT OUT showed Quo acts on every word YC honors, so the job, its
  scheduler, `lib/job_executor`'s branch and the `sms_optout_confirmation_text`
  setting were removed rather than kept as dead code. `phone_ingest_executions.metadata.consent`
  no longer carries a `job_id`.
- **413 verdicts** (`phoneDeliveryService`): checked on EVERY listing of a
  record whose verdict reason is `opted_out`, not only on the stamp's
  transition — a ledger lookup (`source='provider_optout'`,
  `'<provider>:<provider_ref>'`) makes a re-sighting free, and a write that
  failed once heals on the next run instead of hiding behind an unchanged
  stamp. `occurred_at` = the text's send time (the adapter has no verdict
  time); evidence carries the code. A backfill records but opens no task.
- **The reconcile** (`syncRcConsents`, nightly in `fns.sms_consent_sync`,
  fail-closed on `sms_rc_consent_sync_enabled`, `GET_LOCK`, ≤ 20 pages of
  1,000): through `ringcentral.listConsents` (`capabilities.consentList`),
  which owns RC's vocabulary. Per RC's API spec (its generated SDK,
  ringcentral-extensible 1.8.6) the list is `POST
  /restapi/v2/accounts/~/sms/consents/search` (`optStatus`, `coverage`,
  `perPage` ≤ 1000, `pageToken`; App Permission SMS, rate group Light; the
  authenticated user needs Account Administration) — the guide page's GET
  form answered the same 403 at step 0. Coverage is limited to `PhoneNumber` +
  `Account`: a `CampaignType` record is an opt-out of one campaign type, not
  of every text. Records carry no id, so the ledger key is
  `'<provider>:consent:<from>:<to>:<lastModifiedTime>'` — a later re-opt-out
  of the same pair is a new event, a re-listing is not. `dry_run` counts
  what it would record and writes nothing (runs with the setting off).
  Provider trouble: `warning` first, `error` when the group alerted in the
  last 36 h; a 429 parks the run. Step 0 got a 403, not a list, so the
  record fixture in `tests/rcConsentSync.test.js` is still SDK-shaped (its
  403 body is the real capture) — replaced before the setting is ever `1`.
- **Re-opt-in is not mirrored.** RingCentral lifts a pair's block on any
  later text from the recipient ("hi" → "Thanks for opting in", live
  2026-10-29); Quo only on START. YC records an opt-in only for an opt-in
  keyword (or a staff untick): a "hi" is not re-consent. So after a STOP and
  a "hi" on an RC line, RC would deliver and YC still refuses automation —
  the stricter side, by design; staff replies ask to confirm (P1's
  override).
- **Inbound liveness** (`inboundLivenessCheck`, same nightly run): per
  provider with an active line, the newest ingested inbound SMS older than
  `sms_inbound_liveness_hours` (default 72, plain hours) → alert
  `sms_inbound_liveness:<provider>`, warning then error.

### 4.7 Staff surfaces

**As built (P4).** Reads go through `optoutService` (the ONE reader); the one
write path added — the import — goes through `recordConsent` (the ONE writer).
Routes in `routes/api.consent.js` (auto-mounted).
- **Reads** (`optoutService`): `consentSummary(db, channel, dests)` → per
  destination `{ scopes, version }` — every scope with a STATE row (SMS `all`
  + topics, email `marketing` + topics) as `{ opted_out, state, occurred_at,
  source }`, plus `label` / `active` / `consent_model` for a topic; one
  statement (state ⋈ the event that set it ⋈ `comm_topics`), `version` =
  `consentVersions`' stamp. It is a DISPLAY read: what a send checks stays
  `findOptedOut` (with the row-flag dual-read), so a cache flag set without a
  state row shows on the checkbox but has no badge. `consentHistory(db,
  channel, destination, { limit })` → one destination's ledger, newest first
  by `(occurred_at, id)`, the staff actor's `user_name` joined, evidence
  REDACTED by an allow-list (`redactEvidence`): kept — `via`, `note`,
  `keyword`, `body` (the inbound text, clipped to 200), `ip`, `provider`,
  `signal`, `delivery_code` / `delivery_reason`, `campaign_id`, `batch_id`,
  `key_label`, `from_destination`, `carried_by`, `column`, `topic_missing`;
  dropped — everything else, notably the unsubscribe `token` (a live
  capability), `user_agent`, provider message refs, key ids, row ids and
  Casey draft ids. Scalars only; strings clipped (note 1000, others 200).
  `scopeState(conn, …)` is the import's PLAIN read of one scope, taken right
  after the row lock (see Import).
- **History popover** shows the route's default 50 rows and, when 50 came
  back, says it shows the latest 50 and points at the CSV (all rows).
- **List routes:** `GET /api/contacts/:id/{phones,emails}` add
  `consent.scopes` (from `consentSummary`; `{}` when none) beside P1's
  `opted_out` / `version` — additive; Casey's click-time re-check reads only
  those two.
- **Gates.** `GET /api/consent/history`, `GET /api/consent/export`, `POST
  /api/consent/preview`: `jwtOrApiKey` — the gate of the contact-subrecord
  list routes and of campaign compose (a scoped API key reaches them only
  through its route scopes, else 403). `POST /api/consent/import`:
  `superuserOnlyFor('consent_import')` — the `su` role, the step-up elevation
  token, the per-tool rate limit; API keys 403; every outcome written to
  `admin_audit_log` (tool `consent_import`).
- **History / export** take `channel` + `destination`, normalized by
  `normalizeDestination` (an email must be exactly ONE address — the helper
  alone would take `a@x.com,b@y.com` as one string); anything else 400.
  History: ≤ 500 rows (default 50). Export: the same rows (≤ 10,000) as CSV,
  `Content-Disposition: attachment`, `nosniff`, every field quoted, quotes
  doubled, and a field starting `=` `+` `-` `@` (or tab / CR) prefixed with
  `'` — formula injection from a note or an inbound text.
- **Import (SU)** `{ channel, scope, rows: [{ destination, note? }], source:
  'import' }`, ≤ 5,000 rows. ALL-OR-NOTHING validation first: the scope must
  pass `assertScope` (400), any bad destination or a note > 1000 refuses the
  file with the bad rows listed (400, nothing written), an opt-in — by body
  or by any row — is 422 (an import never opts in: the API-key rule).
  Duplicates in the file collapse into the first occurrence (`duplicates`
  count, and the answer's `message` says so). Then ONE `opt_out` per
  destination, source `import`, actor = the SU, `contact_id` from the active
  row, evidence `{ via: 'import', batch_id, note? }` — ONE TRANSACTION PER
  DESTINATION (`withTransaction(retries: 1)` + one `ER_LOCK_DEADLOCK` retry),
  so the import never holds two contact rows at once (a 100-row batch held
  them in file order to commit and deadlocked a form save locking two rows of
  one contact by id — review r2). The lock steps live in the route, as P2's
  live in `phoneConsentService` (§4.4's direct-caller list names both): the
  destination's ACTIVE row locked first (`*_active_uniq`, handed to
  `recordConsent` as `rowId`), then the scope's state by a PLAIN read
  (`scopeState` — the transaction's snapshot is taken there, after the row
  lock). Not `FOR SHARE`: a locking read of a state row that does not exist
  yet takes a gap lock, and two writers holding one gap that both insert
  their seed row deadlock. Idempotent on STATE: already `opted_out` →
  `unchanged`, nothing recorded (an `opted_in` state is recorded over — a
  suppression wins), so a re-run records nothing → `{ recorded, unchanged,
  invalid: 0, duplicates, batch_id }`. A failure part-way leaves the earlier
  destinations committed and the 500 carries their counts; a failure before
  any write says nothing was recorded. On the engine
  (`tests/consentReads.mysql.test.js`): an import racing a contact-form
  toggle of the same number, and an import paused between two numbers of one
  contact while a form save of both rows waits (a forced interleave), move
  InnoDB's deadlock counter not at all — the form lands or gets a clean 409
  `consent_changed`. Free-running, an import of two numbers of one contact
  racing a form save of both rows never surfaces a deadlock on either side,
  but the counter does move: a P1 cycle, not the import's — the form holds
  row A, then a `FOR SHARE` GAP lock on `comm_consent_state` (`stateFlag` on
  a number with no state row yet), then asks for row B; an import holding
  row B that inserts its state seed into that gap closes it. InnoDB rolled
  back the one-row import in every round measured, and `consentTx` re-ran
  it; the form was never the victim in this pairing, so its own retry
  (§4.4) is proven by the form-vs-form races, not by this one.
- **Contact form** (`public/forms/contact-form.html`): under each phone /
  email row, a chip per opted-out scope (`.ycr-badge`: "SMS: stopped", "No
  marketing email", "<topic label>: off"; an opted-in `opt_in` topic: "<label>:
  on") and a **history** control — shown only for a destination with a state
  row. The badges come from the two list routes, fetched on every load /
  save (the contact load carries no consent). History is fetched on click
  (firm-local times, `America/Detroit` from `firmData.firmTimezone`) with an
  **Export CSV** button. **The note:** changing a LOADED row's opt-out reveals
  an optional "Opt-out note" (≤ 1000); the aggregate save sends
  `sms_optout_note` / `email_optout_note` on that row only, and
  `contactService` passes it into the staff event's evidence (`note`) — on an
  update (`applyRowDecision`) and on a correction whose flag the user set
  (`bornRow`'s `staff` event, never a carried `row_replace`). The three-way
  compare is unchanged; a note beside an unchanged flag records nothing; a
  note > 1000 is a row validation error. New rows have no note.
- **Compose** (`public/campaign.html`): after the selection, the class or the
  topic changes (debounced), `POST /api/consent/preview { channel, class,
  topic, contact_ids }` (≤ 5,000; `class` defaults to operational) answers
  `{ selected, will_send, skipped_optout, missing_destination, not_found }`
  through `findOptedOut`, asked exactly as `campaignService.executeSend`
  asks (`campaignService.consentOptsFor`, C1): each contact's
  `contacts.contact_phone` / `contact_email` (the primary mirror it sends
  to), SMS operational, marketing email scope `marketing` + the topic,
  operational email NO reader call (D18 — nothing is skipped). Beside "N
  selected": "N will be skipped (texts stopped)" / "N will be skipped (opted
  out of marketing email)", nothing at 0; never blocks the send. The contact
  search (`getFilteredContacts`, same `class` / `topic`) already leaves out
  contacts opted out at search time, so the line catches consent that moved
  after the search.
- **Sync bus:** none of the four routes is a MATCHERS entry — three are
  reads, and the import writes destinations (ledger, state, recordConsent's
  cache sync) with no contact field diff; an open contact form shows the new
  badges on its next load / save.
- Compose surfaces otherwise as ruled: the 409 warn stays for SMS (scope
  `all`); operational email never warns (D18).

## 5. Transport

### 5.1 Lock in a provider, or a driver? — driver (DECISION D7)

Driver, with one default provider. Why:

- It's already the shape: `email_credentials.provider` → `services/adapters/email/*`,
  `phone_lines.provider` → `services/adapters/phone/*`, and the YC3 direction
  says "driver pattern extends" (`ref/plans.md` YC 3.0).
- The marginal cost of a driver is small here because **every candidate
  speaks SMTP** (survey in `ref/archive/YISRAMAIL_SURVEY_2026-10-29.md`): the existing `smtp` adapter sends through any
  of them on day one. The per-provider code is (1) the events parser +
  signature verify, (2) optionally an API send (batch, tags), (3) optionally
  domain provisioning for YC3 self-serve onboarding.
- What "lock-in" would buy is the provider's marketing layer — hosted lists,
  hosted templates, hosted unsubscribe, broadcasts. We deliberately keep all
  of those in YC (consent is legal proof; templates are tenant data; the
  campaign engine exists). Use none of them, and switching providers is a
  credential row + a DNS change + one parser.
- YC3: a tenant either brings its own account (its reputation, its ToS
  relationship) or uses a platform default. One tenant's complaint spike on
  a shared platform account can pause everyone's sending unless the
  provider isolates tenants (sub-accounts / tenants / servers — see the survey).
  That isolation is a provider-choice criterion for YC3, not a reason to
  hard-wire one.

Not abstracted: provider marketing features (above). Not built now:
provisioning drivers (YC3), API send (SMTP covers v1 at this volume).

### 5.2 Adapter contract additions (T1)

```
capabilities: { html, attachments_inline, attachments_url,      // existing
                bulk, headers, tags, batch, events }            // new
sendEmail(db, { …existing…,
                headers,   // base allowlist: List-Unsubscribe, List-Unsubscribe-Post,
                           //   List-Id — plus whatever the DRIVER adds (below)
                replyTo,   // the monitored mailbox for replies
                tags,      // { campaign_id, result_id } → the driver's correlation headers
                driver })  // the row's events driver (email_credentials.events_driver)
driver.events: { verify(req, credential) → bool,                 // T2 — on the DRIVER
          parse(req) → [{ type: 'delivered'|'bounce_hard'|'bounce_soft'|
                          'complaint'|'unsubscribe'|'open'|'click',
                          provider_message_id, recipient, at, provider_event_id,
                          tags, raw }] }
```

- **Driver-owned headers.** The caller passes only the base allowlist; the
  driver adds its own. SES over SMTP: `X-SES-CONFIGURATION-SET` (selects the
  config set whose event destination publishes events) and
  `X-SES-MESSAGE-TAGS` (`campaign_id`, `result_id`). Nothing else passes.
- **Correlation by tags, not Message-ID.** `executeSend` stores nodemailer's
  `info.messageId` today; SES events carry SES's own message id. The SES
  driver parses that id from the SMTP reply (`info.response`) into
  `campaign_results.provider_message_id`, and events join by the
  `result_id` tag first, `provider_message_id` second.
- **Code that changes in T1:** `sendEmailDirect` destructures a fixed option
  set (`services/emailService.js`) and `smtp.js` builds `mailOptions` with no
  `headers` / `replyTo` — both grow the new options. `headers` / `replyTo` /
  `tags` reach adapters only from the campaign marketing path
  (`sendEmailDirect` with a `bulk_ok` row); the public `sendEmail` strips them
  like `HUB_ONLY_OPTIONS`.
- `email_credentials.bulk_ok tinyint(1) NOT NULL DEFAULT 0` + an
  `events_driver varchar(20) NULL` naming the driver (the send is plain SMTP;
  events come from the provider) + `driver_config json NULL` (the driver's
  settings — for SES the configuration-set name).
- **The bulk row is not a sender anywhere else.** `GET /api/firm-data` ships
  every `email_credentials` row to every compose surface, and the public
  `sendEmail` picks a row by `from` — unfenced, the SES row would appear in
  Comms, workflow and campaign pickers and operational mail could leave
  through the marketing subdomain without a footer. So: `bulk_ok` rows are
  filtered out of `emailFrom`; the public `sendEmail` and operational
  campaigns within the cap refuse a `bulk_ok` row (D16 lets an over-cap one
  use it, no footer); no mailbox `send_credential_id` and no
  other row may share its SMTP login (else the hub's `checkBudget` would
  count newsletters against the hub). `gmail.js` never gets `bulk_ok`.
- Operational campaigns through Gmail/SMTP already count against the hub
  budget (their sends land in `email_log` under that transport's source),
  which covers the old `ref/plans.md` "count campaigns against the budget"
  item; marketing volume never touches it.

**As built (T1).** The contract and the fences; nothing sends marketing mail
until C2 calls it.
- **Options** (`services/emailService.sendEmailDirect`, destructured like the
  hub's): `bulk` (the caller's assertion that it IS a path allowed on a bulk row: the
  marketing path, C2, or — since C1 — an over-cap operational campaign, D16),
  `headers`, `reply_to`, `tags` — `MARKETING_ONLY_OPTIONS`. The public
  `sendEmail` strips all four the way it strips `HUB_ONLY_OPTIONS`.
  `headers`: `MARKETING_HEADERS` = `List-Unsubscribe`, `List-Unsubscribe-Post`,
  `List-Id`, matched case-insensitively and passed on canonical; string values,
  no CR / LF / NUL, ≤ 998 bytes. `reply_to`: one address by the comms hub's own
  rule (`mailboxSendService.parseRecipient`). `tags`: ≤ 10 pairs of
  `[A-Za-z0-9_-]{1,256}` strings; they reach the wire only through the row's
  driver (no driver → nothing to carry them).
- **Refusals** (an `Error` whose `.code` is the name and whose message starts
  with it), all before any provider call: `bulk_row_requires_marketing_path`
  (a `bulk_ok` row without `bulk:true` — keeps the hub, the diagnostic route
  and every automation off the SES row even when they load it directly;
  `bulk_ok` counts unless it is exactly 0 / false / NULL);
  `bulk_requires_bulk_row`; `marketing_options_require_bulk` (headers /
  reply_to / tags without `bulk:true` — thrown, never stripped);
  `marketing_header_refused`; `marketing_reply_to_invalid`;
  `marketing_tags_invalid`; `adapter_lacks_capability` (gmail and pabbly never
  see these options or a driver); `unknown_events_driver`;
  `events_driver_requires_bulk` (a driver on a row that is not `bulk_ok` —
  fail closed, so a driver's headers never ride operational or hub mail). The public
  `sendEmail` refuses a `bulk_ok` row outright: `bulk_sender_refused` ("… is
  a marketing transport; automation, workflows and operational campaigns
  cannot send from it"), which `campaignService.isTransientError` classifies
  permanent by its code.
- **Capabilities:** smtp `bulk / headers / tags: true, batch / events:
  false` (events come from the driver, not the transport); gmail and pabbly
  all five `false`.
- **Driver** `services/adapters/email/drivers/ses.js`, chosen by
  `email_credentials.events_driver` (`bulk_ok` rows only) through
  emailService's `DRIVERS` whitelist (no dynamic require). Contract: `HEADERS` (the only names it may
  add — the smtp adapter throws on any other), `validateConfig(cfg)`,
  `headersFor({emailRow, tags})`, `messageIdFromResponse(response)`, `events`
  = null until T2. SES adds `X-SES-CONFIGURATION-SET` (from
  `driver_config.configuration_set`; omitted when absent — the identity's
  default set applies) and `X-SES-MESSAGE-TAGS` (`k=v, k=v`; omitted without
  tags), merged after the caller's headers. nodemailer re-cases header names
  on the wire (`X-Ses-Message-Tags`, `List-ID`); names are case-insensitive.
  The smtp adapter returns `info.providerMessageId` (the SES id from the
  `250 Ok <id>` reply; null without a driver or when it does not parse);
  `email_log` is unchanged — `delivery_info.response` keeps the raw line.
- **Columns** (`scripts/yisramailT1Migrate.js`, CHECK / `--apply`, one
  connection, `lock_wait_timeout` 10, verifies types / defaults / collation /
  comments and the data rules below): `bulk_ok`, `events_driver`,
  `driver_config` — each COMMENT carries its rule.
- **Fences:** `bulk_ok = 0` on `GET /api/firm-data` `emailFrom` (every compose
  surface), `GET /api/email-from`, the diagnostic sender list, Casey's
  literal-sender check (`assistantService.literalFirmSender`), the
  self-service signature list (`/api/me/signatures`) and a user's
  `default_email` (`auth.profile`). `/internal/email-test/send` refuses a bulk
  row (400) on both paths and its override clone carries `bulk_ok`.
  `createCampaign` accepts `type` exactly `'email'` or `'sms'` (executeSend
  treats any non-sms type as email) and for email loads the sender row: an
  unknown sender throws (before T1 nothing checked it — every job failed at send) and
  a bulk one throws ("Operational campaigns cannot send from a marketing
  transport") — within the operational cap; since C1 an operational campaign
  confirmed over the cap may name one (D16, §6.1 "As built (C1)"). `mailboxService.assertSendCredential` refuses a bulk row (400)
  and the Mailboxes admin's send-credential picker leaves it out; the hub's
  `whyNot` reports `bulk_transport` (picker + 409 at send). The
  sender editor (`routes/api.emailCredentials.js`, `connections.html`) exposes
  the three columns on SMTP rows only and refuses (400): `bulk_ok` /
  `events_driver` / `driver_config` on a non-SMTP row, a driver or config set
  on a row that is not bulk (un-marking bulk clears both), an unknown driver,
  a bad `driver_config`, a bulk row whose (smtp_host, smtp_user) another row shares
  (naming it), a plain row taking a bulk row's login, and marking bulk a row a
  mailbox sends through. Leaving SMTP clears the three; the test send refuses
  a bulk row. The editor list (`GET /api/email-credentials`) still lists bulk
  rows — it is the editor's source (the mailbox admin filters them out), not
  a compose picker. The migration CHECK also NO-GOs on a driver or
  `driver_config` on a row that is not bulk.
- **Acceptance** `scripts/yisramailT1Acceptance.js`: `--send --row 17 --to …`
  (one production send through the marketing path with the three headers, a
  Reply-To and tags; prints the provider id, the 250 line, the `email_log`
  id) and `--check <eml>` (GO only when the received message carries both
  one-click headers AND the `d=news.4lsg.com` DKIM signature lists both in
  `h=`). Acceptance (Fred, 2026-11-01, row 17 → it@4lsg.com): GO — SES signs
  `list-unsubscribe` and `list-unsubscribe-post` (and `list-id`) under
  `d=news.4lsg.com` (Easy DKIM) and again under `d=amazonses.com`; the
  receiver's DKIM verdict for news.4lsg.com is pass; `X-SES-CONFIGURATION-SET`
  and `X-SES-MESSAGE-TAGS` are stripped before delivery; Reply-To arrives as
  `office@4lsg.com`. RFC 8058's signed-header requirement is met: C2 may
  build on these headers.

### 5.3 Sending domain (P0, no code)

- Dedicated subdomain per brand (D8), e.g. `news.4lsg.com`: provider DKIM
  records, custom MAIL FROM / Return-Path subdomain (SPF alignment), DMARC
  on the subdomain `p=none` → `quarantine` after 2–4 clean weeks of reports.
  4lsg.com DNS is at Namecheap; MDBL at Cloudflare.
- Reply-To: a real mailbox in the hub (e.g. `office@`), so replies are seen.
- Warm-up: first sends to the most engaged slice (recent leads + clients),
  cold/imported slices last and in smaller batches; watch bounce < 2 % and
  complaints < 0.1 %.

### 5.4 Events (T2)

Provider webhook → a YisraHook hook (ack-first, `dedup_path` on the
provider's event id — both exist) → target internal function
`mail_event_ingest` → by type: `bounce_hard`/`complaint`/`unsubscribe` →
`recordConsent` (§4.2, idempotent on the provider event id); the complaint /
bounce tally for §6.5; all types →
`campaign_results` delivery columns, joined by the `result_id` message tag
first and `provider_message_id` second (§5.2). Signature verification: `hooks.auth_type` already has
`hmac` and a Calendly-style scheme; a provider whose scheme differs gets its
verify in the adapter's `events.verify` (the "parsing into drivers" item in
`ref/plans.md`). **Lost events:** the EventBridge API-destination rule gets an
SQS dead-letter queue (exhausted retries are otherwise dropped) and T2 ships a
tested replay procedure (DLQ → re-POST to the hook); the hook's `dedup_path`
on the event id makes a replay safe.

**As built (T2).** The parser is confirmed on REAL events captured in step 0
(2026-11-01: five SES mailbox-simulator sends through row 17, hook_executions
36158–36169, kept as `tests/fixtures/ses-events/<type>.json`); the three types
the simulator cannot produce stay on AWS's documented shape, marked
`VERIFY(step0)`.
- **Path.** Configuration set `yisramail-marketing` → event destination
  EventBridge (Send, Rendering failure, Reject, Delivery, Hard bounce,
  Complaint, Delivery delay; Open/Click since the C6 flip, 2026-11-05) → rule
  `yisramail-ses-events` (`source: aws.ses`) → API destination
  `yisramail-hook` (Connection `yisramail-hook-conn`, API key) → hook
  `ses-events` (api_key auth, header **`x-api-key`** — the receiver strips
  that header from everything it stores, which the default `x-hook-key` was
  not, before 2026-11-02; `dedup_path` `body.id`, the EventBridge event id;
  passthrough) → target internal_function `mail_event_ingest`, params mapping
  `event` ← `body`. DLQ `yisramail-ses-dlq` (14 days). The definition and a
  recreate/add-target snippet: `ref/migrations/2026-11-02_yisramail_t2_hook_ses_events.console.js`.
- **Parser** (`services/adapters/email/drivers/ses.js` `events`):
  `parseDetailed(body)` → `{ events, ignored, unknown_shape, errors }`, never
  throws. One SES event naming N recipients → N events, each `{ type,
  provider_message_id (detail.mail.messageId), recipient (lowercased), at,
  provider_event_id (<eventbridge id>:<recipient>, a sha256 suffix past 128
  characters), tags {campaign_id, result_id} (mail.tags, arrays of one),
  diagnostic, raw }`. Types: Delivery → `delivered`; Bounce Permanent →
  `bounce_hard`; Bounce Transient / Undetermined and DeliveryDelay →
  `bounce_soft` (an undetermined bounce never opts anyone out); Complaint →
  `complaint` — except a `not-spam` feedback report, which retracts one and is
  ignored (no opt-out, alert or status change); Reject → `reject`; Rendering
  Failure → `rendering_failure`; Open → `open`, Click → `click` (engagement,
  C6); Send / Subscription → ignored; a known type without its
  sub-object, or an unknown eventType → `unknown_shape` (counted); not an
  `aws.ses` event → an error (counted). `unsubscribe` is never produced (SES
  list management is not used). `verify` is `true`: the hook's api_key auth
  is the check (EventBridge signs nothing).
- **Captured facts (step 0):** `source` `aws.ses`; `id` (a UUID — the dedup
  key and the provider_event_id prefix); `detail-type` "Email Sent" / "Email
  Delivered" / "Email Bounced" / "Email Complaint Received"; `resources` = the
  configuration set's ARN; `detail.eventType` Send / Delivery / Bounce /
  Complaint; `detail.mail.messageId` in the same shape the T1 driver reads
  from the 250 reply; `detail.mail.tags` = our `campaign_id` / `result_id` plus
  SES's `ses:*` tags (operation, source-ip, from-domain, outgoing-ip,
  caller-identity, configuration-set, source-tls-version), every value a
  one-string array (the parser reads only ours); `delivery.recipients`
  (strings), `timestamp`, `smtpResponse`; bounces seen: Permanent / General
  (`diagnosticCode` present), Transient / General (ooto — `emailAddress` only,
  no diagnosticCode; the diagnostic falls back to "Transient/General"),
  Permanent / **EmailValidationSuppressed** (suppressionlist — a suppression
  subtype); complaint `abuse` with `complainedRecipients`; ooto@ also produces
  a Delivery (the precedence keeps it `delivered`). The receiver stored no
  `x-api-key` header (the strip works live).
- **Still VERIFY(step0)** (not producible from the simulator; documented
  shape; delivery columns only, never the ledger): Reject (`reject.reason`,
  recipients = `mail.destination`), DeliveryDelay
  (`deliveryDelay.delayedRecipients`), Rendering Failure (eventType with a
  space, `failure.errorMessage`); and the DLQ message Body = the original
  event (replay script) until a real DLQ message is seen.
- **Ingest** (`services/mailEventService.ingest`, skin
  `lib/internal_functions/mail.js`, CTA-denied, `uiHidden`): per event one
  transaction (`withTransaction` retries:1 + one deadlock retry). Correlation:
  the `result_id` tag's row when the `campaign_id` tag is present AND names
  that row's campaign (C2 sends both; a tag-less result_id falls through),
  else the row holding the `provider_message_id`, locked; none → `unknown` (a
  non-campaign send). Delivery columns: `delivery_status` only rises —
  complained > bounced_hard > rejected > delivered > bounced_soft > unknown —
  with `delivery_diag` (and, for a bounce, `bounce_subtype`) following it;
  `delivered_at` / `bounced_at` / `complained_at` are set once per rank (the
  event that raises the status stamps its column — a hard bounce after a soft
  one re-stamps `bounced_at`; a same-or-weaker event only fills an empty one);
  `provider_message_id` filled on a tag-found row that had none, unless another
  row already holds it. **Lock order for C2:** the ingest locks the
  `campaign_results` row BEFORE recordConsent's contact row — a send path that
  touches both must take them in the same order or tolerate a deadlock.
  Ledger (D18):
  `bounce_hard` → `recordConsent` opt_out email scope `marketing` source
  `provider_bounce`, `complaint` → `provider_complaint`; provider_event_id as
  above (a replay is `duplicate`); evidence `{via:'ses', event_type,
  bounce_type, diagnostic ≤ 200, message_id}`; send_ref = the result_id;
  contact_id = the result's contact; no rowId (recordConsent locks the
  destination). After the commit: D17 — a newly recorded hard bounce on an
  active address of a contact with an open Primary/Secondary case
  (phoneConsentService's predicate) → one task to `consent_task_user_id`,
  dedupe key `mail_bounce:<address>` (an open one is touched); each complaint →
  a `warning` alert per address per UTC day; per transport touched, hard
  bounces > 5 % over 24 h with ≥ 200 delivered → an `error` alert per UTC day
  (an alert whose dedup key already exists is neither sent nor counted). An
  address the ledger cannot hold still gets its delivery columns, no ledger
  event, counted `invalid`; any thrown error (database, or a recordConsent
  anomaly) is rethrown after the others ran, so the hook retries the target
  once (every write is idempotent). Hard bounces with a suppression subtype
  are still `bounced_hard` and still an opt-out (the address is known-bad). Returns `{ parsed, ignored, unknown_shape,
  parse_errors, updated, unknown, invalid, ledger: {recorded, duplicate},
  tasks, alerts }`.
- **Columns** (`scripts/yisramailT2Migrate.js`, CHECK / `--apply`, one
  connection, `lock_wait_timeout` 10; 291 rows live): `campaign_results.
  provider_message_id` (+ `ix_provider_message_id`), `delivery_status`,
  `delivered_at`, `bounced_at`, `complained_at`, `delivery_diag`,
  `bounce_subtype` — each COMMENT says what sets it. `recordResult` never
  writes them.
- **Health** `mailEventService.transportHealth(db, {credentialId |
  campaignId})` → `{ window_h: 24, delivered, bounced_hard, suppressed,
  complained, delivery_rate, complaint_rate, bounce_rate, enough }` — the §6.5
  definitions (suppression-subtype bounces in `suppressed`, not in
  `bounced_hard`); computed from `campaign_results` (no counter table). C2
  reads it before each marketing send and owns the hold.
- **Replay** `scripts/yisramailT2ReplayDlq.js <messages.json> [--dry-run]`:
  `aws sqs receive-message` output or bodies copied from the SQS console,
  re-POSTed with the key from env `SES_HOOK_KEY` (never an argument, never
  printed); an event the hook already has is a no-op.
- **Not built:** SES account-level suppression removal on re-opt-in (needs the
  SES API — `ref/plans.md`).

### 5.5 Provider (DECISION D6)

Hard requirements (survey: `ref/archive/YISRAMAIL_SURVEY_2026-10-29.md`): marketing allowed by the AUP; **we set our
own `List-Unsubscribe` / `-Post` headers** (YC owns unsubscribe — §4); a
2k-recipient day on the paid tier; SMTP; signed (or otherwise authenticated)
event webhooks; a path to per-tenant isolation for YC3.

| | Cost at our volume | Fails / weak on |
|---|---|---|
| **Amazon SES** | ≈ $0.50–1/mo ($0.10 per 1k) | setup effort (AWS account, production-access review, IAM SMTP creds, config set, event destination) |
| Resend | $20/mo (Pro; free tier 100/day) | AUP: account "may be shut down without warning" over 0.08 % complaints — risky with cold lists; no tenant isolation |
| Mailgun | $15/mo (Basic) | 1-day log retention; sub-accounts not on self-serve plans |
| SendGrid | $19.95/mo | free tier is a 60-day trial; subusers only on Pro+ |
| Postmark | $15/mo | Broadcast adds its own non-editable unsubscribe; own handling needs support approval; webhooks unsigned |
| MailerSend (EMAIL_PROVIDER_PLAN OQ6 candidate) | $7/mo Hobby | own List-Unsubscribe only on the $110 plan; Hobby's 1,000 requests/day caps an SMTP 2k burst → **rejected**; drop the dead `_spf.mailersend.net` include as planned |
| Brevo / Mailjet / SMTP2GO / Elastic / Bird | $9–19 | unsigned or unverified webhooks; Elastic forces its own unsubscribe link; Bird rejects custom List-Unsubscribe (422) |
| ZeptoMail, Cloudflare Email, Mandrill | — | transactional-only terms → excluded |

**Ruled 2026-10-29: Amazon SES** as the default driver (Fred: no monthly commitment, far cheaper than any alternative).
- Cost is noise (≈ $1/mo at 10k), our own headers allowed, SMTP endpoint
  for the existing `smtp` adapter, account-level suppression of bounces/
  complaints with an API, custom MAIL FROM, and **SES Tenants** (per-tenant
  reputation + automatic pause, $0.005/tenant/mo) — the strongest YC3 story
  in the survey.
- Events: SES event destination → **EventBridge API destination** posting to
  a YisraHook hook with an API-key header (hook `auth_type='api_key'` already
  exists) avoids SNS certificate verification; SNS HTTPS (signed, SHA256) is
  the fallback. Verify the EventBridge route in T2's first step.
- Cost of choosing it: the production-access request (state marketing use,
  opt-in practice, bounce/complaint handling — this design is the answer;
  first reply ≤ 96 h) and AWS setup in P0.
- Gmail complaints don't reach any provider's feedback loop (SES included):
  register the sending domain in **Google Postmaster Tools** (P0) and watch
  its spam rate there.

**Runner-up: Resend Pro ($20/mo)** if AWS setup is a blocker — simplest
setup, Svix-signed webhooks, own headers on `/emails`; accept its strict AUP
and no tenant isolation.

**Buy instead of build (stated for completeness).** An all-in-one platform
(Brevo Marketing ≈ $25/mo, MailerLite $33–49/mo at ~2.5k contacts; both have
unsubscribe webhooks) would ship a newsletter in days, with builder, hosted
unsubscribe and compliance footer included. It doesn't give YC3 a feature,
puts consent in a second system, and does nothing for SMS. Use it only as a
bridge if SS needs a send before C2 lands — and import its unsubscribes into
the ledger at cutover.

### 5.6 Relation to the mailbox / Migadu arc

Independent — nothing here changes `ref/EMAIL_PROVIDER_PLAN.md` or
`ref/MAILBOX_SYSTEM_DESIGN.md`, and nothing there changes this. The seams:
- **Bulk rule.** The provider plan already says any send over ~50 recipients
  goes through a transactional provider on a subdomain, never the mailbox
  host (Migadu's terms prohibit mailing people who didn't opt in, and its
  quotas are account-wide). SES on `news.<domain>` is that provider.
- **DNS.** The sending subdomain has its own DKIM, MAIL FROM and DMARC; the
  apex keeps its MX/SPF for the mailbox host (Gmail now, Migadu later).
  `d=news.4lsg.com` aligns (relaxed) under the 4lsg.com DMARC, so tightening
  the apex policy during the provider migration doesn't break bulk mail; set
  the apex `sp=` deliberately when it happens.
- **Replies.** Reply-To is a hub mailbox, wherever it is hosted.
- **The provider plan's Microsoft fallback** ("send human mail via SES if
  Migadu's shared IPs get junked") must never reuse this identity: SES's
  account-level suppression list is shared by the whole AWS account, so a
  newsletter complaint would suppress that person's correspondence too. If
  that fallback is ever used, it gets its own AWS account (or a config set
  with the suppression override), never the `bulk_ok` row.
- **Hub budget.** The bulk row is not a mailbox identity (§5.2), so a
  newsletter never counts against the hub.

## 6. Campaigns v2 — enhance, don't replace

The engine is sound: frozen audience, one idempotent job per recipient
(`campaign:{id}:{contactId}`), per-recipient results, cancel by name prefix,
transient-vs-permanent error classification. Replacing it would re-solve
those. What changes:

### 6.1 Send class — chosen explicitly at compose

| | `operational` (today's use: mail merge) | `marketing` (broadcast / newsletter) |
|---|---|---|
| Who/why | a note to a dozen clients, a hearing-change notice, an office-closure notice | newsletter, announcements, re-engagement |
| Consent check | email: none; SMS: scope `all` (a STOP) — §4.1 | email: `marketing` + topic; SMS refused (D1) |
| Transport | any staff `email_credentials` row except `bulk_ok` (Gmail/SMTP) | only a `bulk_ok` row (§5) |
| Cap | **50 recipients** (ruled 2026-10-22), firm-configurable, enforced in `campaignService.createCampaign` (API keys reach it). Over the cap only with `campaigns.bulk` + a typed confirmation, audited (D16) | none beyond provider/plan limits; rate-controlled |
| Unsubscribe | none | mandatory token, footer, headers (§4.5) |
| Topic | — | required (`comm_topics`) |
| SMS | allowed (≤ cap, or over it per D16 — informational texts to clients) | **refused** (D1) |

**No "send to opt-outs" switch.** A marketing campaign never reaches a
marketing opt-out (that send is the CAN-SPAM violation, and the reason
Gmail/Yahoo demand one-click unsubscribe). The legitimate need — telling
everyone, opted-out or not, that the office is closed or a hearing moved —
is the operational class, which marketing opt-outs never block. The class
is the switch, so it must be honest: choosing operational shows "this
message is about the recipient's case, appointment or account — not
promoting services" and records who chose it; an operational message must
not carry promotional content (CAN-SPAM's primary-purpose test can turn a
mixed message commercial).

The class is stored (`campaigns.class`, `campaigns.topic_key`). The
marketing class and any over-cap operational send require a new
`campaigns.bulk` capability (D13, `lib/capabilities.js` vocabulary, admin
role); operational ≤ cap stays open to staff as today (every campaign route
is plain `jwtOrApiKey`).

**Kill switch (fail closed).** `marketing_send_enabled` (settings registry,
system kind, default `'0'`, SU console) is checked in BOTH
`createCampaign` (refuse class `marketing` with 422) and `executeSend`
(record `skipped`, reason `marketing_disabled`). It ships `'0'` in C1 and is
flipped by an SU only after the G1 checklist (§9) passes. Without it, C1
would let staff create marketing campaigns that today's `executeSend` sends
with no token, footer or headers.

**As built (C1).** `services/campaignService.js`, `routes/campaign.js`,
`public/campaign.html`; schema by `scripts/yisramailC1Migrate.js`
(`ref/migrations/2026-11-03_yisramail_c1_campaign_class.sql`).
- **Columns:** `campaigns.class enum('operational','marketing') NOT NULL
  DEFAULT 'operational'`, `campaigns.topic_key varchar(40) NULL`, and — beyond
  the list above — `campaigns.bulk_confirmed_count int unsigned NULL`: the
  count a `campaigns.bulk` holder typed to confirm an over-cap operational
  send. NOT NULL marks a campaign over-cap, which is what lets `executeSend`
  send it through a `bulk_ok` row (a stored fact, not a re-derivation from a
  cap that may have changed since).
- **`createCampaign`** (every caller — API keys included): `class` exactly
  `operational` | `marketing` (route body `class`, absent = operational; 400
  otherwise). Operational: no `topic_key` (400); the cap
  (`campaign_operational_cap`, blank / absent / not > 0 → 50) counts the
  DEDUPED ids; over it → 403 `bulk_capability_required` without
  `campaigns.bulk` (checked FIRST, so a correct count never helps a staff
  login), then 409 `over_cap_confirmation` unless `confirmCount` equals the
  deduped count (the body names the real `count` and `cap`; the page
  re-prompts); over-cap may name a `bulk_ok` email sender, within the cap the
  T1 refusal stands (400). Marketing: SMS → 422 `marketing_sms_refused`; the
  switch not exactly `'1'` → 422 `marketing_disabled`; no `campaigns.bulk` →
  403; the topic must exist, be an EMAIL topic (`optoutService.assertScope`)
  and be active (400 — the scope names `marketing` / `all` are not topics);
  the sender must be a `bulk_ok` row (400). Marketing and over-cap creates
  write an `admin_audit_log` row (`campaign_marketing_create` /
  `campaign_over_cap`; details: campaign id, class, type, sender, count,
  topic, cap, rate, confirmed count) INSIDE the create transaction, so a
  campaign exists iff its audit row does. Refusals are `CampaignError`s
  carrying `status` / `code` / extra fields; the route answers them as-is
  (other create errors stay 500). A `scheduledTime` more than 366 days out
  (`MAX_SCHEDULE_DAYS`) → 400 `schedule_too_far` (a year typo; it also keeps
  pause parking's threshold unreachable).
- **Settings are read UNCACHED** (`settingsService.getSettings`, one query —
  the way the kill switch's neighbours `documents_sync_enabled` /
  `court_ingest_live` are read) rather than through `lib/firmConfig.cfg`: a
  switch turned off must hold on every instance at once, and cfg's cache
  fails OPEN on a refresh error. `marketing_send_enabled` (system / switches /
  console, ships `'0'` as an explicit row; anything but exactly `'1'` is off),
  `campaign_operational_cap` and `campaign_marketing_rate` (firm / consent
  section, blank → 50 / 60).
- **Consent by class** (`consentOptsFor`, the ONE answer for `executeSend`,
  `getFilteredContacts` and the compose preview): SMS → `{}` (scope `all`,
  D19) whatever the class; marketing email → `{klass:'marketing', topic}`;
  operational email → no consent query at all (D18). **Behaviour change:**
  before C1 every email campaign skipped a marketing opt-out (it asked as
  marketing because campaigns had no class); an operational email campaign
  now reaches one — the ruled design, pinned by
  `tests/campaignC1.mysql.test.js` (O) and `tests/optout.mysql.test.js`.
- **The marketing send** was not built in C1 (a marketing recipient was
  recorded `skipped` `marketing_path_unbuilt` with the switch on); C2 built it
  — §6.4 "As built (C2)". `marketing_disabled` while the switch is off is
  unchanged.
- **D16 as built:** an over-cap operational EMAIL campaign whose sender is a
  `bulk_ok` row sends through `emailService.sendEmailDirect(db, row,
  {…, bulk: true, tags: {campaign_id, result_id}})` — the tags so an SES
  event that beats the `sent` update still correlates (T2 needs both); no
  `headers` / `reply_to`, no footer — which is exactly what T1's
  `bulk_row_requires_marketing_path` fence asks for;
  every other campaign email stays on the public `sendEmail` (a within-cap
  campaign whose row turned bulk later fails `bulk_sender_refused`). Still
  consent-checked by its class (operational: email nothing, SMS scope `all`).
  `campaigns.bulk` (root: false, admin role) gates both paths
  (`lib/capabilities.js`; the shell's copy in `public/index.html` follows).
- **Compose** (`campaign.html`): a class picker (radios, default
  Operational) showing the honesty line; Marketing shows a topic select and
  swaps the sender list to the marketing senders from
  `GET /api/campaigns/compose-options` (bulk rows, the active email topics via
  `unsubService.UNSUB_SQL.topics`, the cap, the switch state, `can_bulk`) —
  firm-data's `emailFrom` keeps its T1 fence; the 409 opens a typed-count
  prompt and resends `confirmCount`.
- **Not built here:** an attestation record of WHO chose the operational
  class beyond `campaigns.created_by` + `class` (the honesty line is shown,
  not separately recorded), and any kill-switch UI beyond the compose note
  (`ref/plans.md`).

### 6.2 Audiences and lists

- Keep the ad-hoc filter (tags / case type / stage / dates) and add
  **saved segments** (`campaign_segments`: name + the filter JSON, re-evaluated
  at send) so "Newsletter — everyone subscribed" is one pick each month.
- A topic is the list: for an opt_out topic the eligible set is "has an active
  address, not suppressed for all/marketing/topic"; for opt_in it's "state =
  opted_in". No separate list-membership table in v1.
- Outside lists (legacy 1,494, `temp_contacts` 2,022): import as contacts (or
  as suppression-only rows) through an SU import that records provenance
  (`source='import'`, evidence = file name + SS's stated basis). Gated on D5.
  SS's own lead lists (Clio Grow, Active Campaign, Phil Tirone) are imported by
  `scripts/leadListImport.js` (D5, 2026-10-30) with no `import` consent event —
  an inquiry grants no opt-in, and an opt_out topic needs none — so their
  provenance is the source tag plus the `[lead:<cluster>]` marker in
  `contact_notes`; the lists' known Active Campaign bounces are recorded as
  `provider_bounce` opt-outs (scope `marketing`).
- Address hygiene before the first send to an imported/cold slice: syntax +
  MX check in-app (free); optional paid list verification for cold slices
  (vendor not surveyed). Hard bounces suppress automatically afterwards (§4.2).

**As built (C4) — saved segments.** `campaign_segments` (name + `filter_json`,
archive flag, no delete; `scripts/yisramailC4Migrate.js` +
`ref/migrations/2026-11-05_yisramail_c4_campaign_segments.sql`).
`services/campaignSegmentService.js` validates EVERY save against exactly the
GET /api/campaigns/contacts filter keys (tags / case_type / case_subtype /
case_stage / case_open_after / case_open_before / channel) — an unknown key or
wrong shape is a 400 `segment_rejected`, never stored; `{}` is valid
("everyone" — the topic's consent state is the list). A segment never carries
class/topic (those belong to the campaign being composed). Routes
`GET/POST /api/campaigns/segments`, `PUT/PATCH …/:id` (any staff JWT, above
`/campaigns/:id` so 'segments' is not captured as an id). The Select tab's
picker applies the filter to the bar and RE-RUNS the search when picked —
recipients still freeze at campaign create and consent is re-asked per
recipient at send, so a stale segment cannot bypass an opt-out; a case type
the vocabulary no longer offers falls back to "Any" with a visible warning.
Save updates the picked segment when the name is kept, saves new otherwise.

### 6.3 Designs library + builder

- New `email_designs` (id, name, builder, design_json, html, text, thumbnail
  asset, created_by, updated_at, archived) — reusable newsletter templates.
  A campaign stores the rendered HTML + text it sent plus `design_id` for
  "duplicate last month's".
- `campaign.html` editor mode gets a third option, **Designer**, beside Rich
  Text / HTML Code. The builder edits the design JSON; save exports HTML;
  the existing placeholder dropdown feeds the builder's merge-tag list
  (`{{contacts.contact_fname}}` etc. pass through untouched); images upload
  through the AssetPicker / `apiSend` base64 path to `POST /api/assets`
  (panes never hold the JWT, so the builder's upload hook can't call fetch
  itself). The compliance footer is a locked block (§4.5).
- **The editor is part of the attack surface, not just the preview.**
  GrapesJS's canvas is a same-origin iframe inside a pane that can reach
  `parent.apiSend`. Its import parser drops `<script>` / `on*` /
  `javascript:` from HTML, but a stored `design_json` loaded as project data
  may bypass that parser. So: the server validates `design_json` and `html`
  on save (no script components, no `on*` attributes, no `javascript:` URLs —
  reject, don't silently strip), and the C3 spike includes a malicious
  `design_json` (a component with an `onerror` attribute / a script property)
  that must not execute.
- **Merge values are escaped in HTML bodies — DONE 2026-10-29** (shipped
  ahead of the arc, separately): `resolverService` gained `escape: 'html'`;
  `campaignService` uses it for every campaign EMAIL body, preview and send
  (`bodyEscapeFor` — subjects and SMS bodies stay verbatim); `campaign.html`'s
  preview renders the email body in a `sandbox=""` iframe fed through the
  `srcdoc` property and SMS bodies as escaped text
  (`tests/campaignPreviewEscape.test.js`). Before that fix the resolved body
  went straight into the shell's Swal `html`, so markup in a contact field
  could run in a pane that reaches `parent.apiSend`. The marketing path (C2)
  inherits all of it.
- Signature append (`include_signature`) is disabled for Designer content (a
  full HTML document can't take a `<br><br>` + signature after `</html>`).
- Builder pick: §7.

**As built (C3a — server).** `lib/emailDesignRules.js` (the validator),
`services/emailDesignService.js`, `routes/api.emailDesigns.js`,
`campaignService.createCampaign` (`design_id`); schema by
`scripts/yisramailC3Migrate.js`
(`ref/migrations/2026-11-04_yisramail_c3_email_designs.sql`): table
`email_designs` + `campaigns.design_id`. Lands dark in effect: nothing calls
the routes until the Designer editor (C3b).
- **API** (`jwtOrApiKey`): `GET /api/email-designs?q=&include_archived=` →
  `{designs:[{id, name, builder, updated_at, archived}]}` (no bodies, newest
  first, ≤ 500; `q` matched literally); `GET /api/email-designs/:id` →
  `{design}` (full row, `design_json` an object); `POST` / `PUT :id`
  `{name, design_json, html, text}` → `{success, id, warning?}`;
  `PATCH :id` `{archived: true|false}` → `{success}`. A rule failure → 400
  `{error, code:'design_rejected', rule, detail}`; bad name / text → 400
  `invalid_input`; a missing id → 404 `not_found`. No delete route.
- **Who:** plain staff, no capability — an operational campaign create (any
  staff) already takes an arbitrary html body, and a design is that body
  pre-validated; the validator, not the role, is the boundary. Sending a
  design as marketing still needs `campaigns.bulk` at create.
- **Validation (every create and update, on the raw payload, before any
  write):** the C3 spike's server rules 1–10, `design_json` and `html` each on
  its own — the html is never assumed to be the design's compile. Refused,
  never stripped. Readings taken where the rules leave room:
  - the footer slot (rule 9) is the `mj-section` whose `css-class` holds
    `yc-footer`, the LAST child of the one `mj-body`; the marker is a GrapesJS
    `comment` component with content ` yc:footer-slot ` (it exports exactly
    `campaignService.FOOTER_SLOT`), inside that slot; the slot holds columns /
    texts / whitespace and the marker — any visible text, image, button or
    background image (`background-url`, a CSS `url()`) is refused;
    `yc:footer-slot` appears once in the whole design. In the html: exactly one
    exact marker, a real comment inside `<body>` and inside the one element of
    class `yc-footer`, nothing visible in that element (its Outlook conditional
    branches included; no `background` attribute or `url()` in a style), and
    `campaignService.injectFooter` must inject AT it — C2's own string reading
    decides, not only the parser's. No stylesheet (the project's, a component's
    `styles`, an html `<style>`) may use generated content (`content:`) or name
    the `yc-footer` class;
  - rule 2 admits `mj-title` / `mj-preview` / `mj-attributes` / `mj-all` as
    GrapesJS stores them (type `text` or default carrying the tagName —
    grapesjs-mjml 1.0.8 registers no type for them); an `<img>` / `image`
    inside mj-text is refused (not in the inline list);
  - properties GrapesJS renders in the PANE, outside the canvas CSP — a
    stored `toolbar`, `traits`, an `icon` / `name` with markup — are refused
    (rules 4 / 5; `Component.toJSON` of the pinned 0.23.8 never writes
    `toolbar` or `traits`); `symbols` / `dataSources` must be empty, pages carry
    only `id` / `type` / `frames` and frames only `id` / `component` / numeric
    `width` / `height` (a frame's `name` renders raw in the pane, its `styles`
    bypass rule 8), and no key anywhere may be `__proto__` / `constructor` /
    `prototype` (rule 1); attribute values must be plain (no data bindings); the
    image model's top-level `src` is checked like the attribute (rule 6);
  - a URL may start with a merge tag only as `{{send.unsubscribe_url}}` /
    `{{send.preferences_url}}` — `firm.*` has no URL-valued key; an empty URL
    passes; relative URLs are refused;
  - html tags (rule 7): rule 2's list minus `meta` / `style` (MJML emits both:
    only `meta http-equiv=refresh` is refused, every `<style>` goes through
    rule 8), plus frame / frameset / applet; `<noscript>` content is parsed as
    markup; every `<!--[if …]>` comment's content is parsed and checked;
  - rule 10: a warning string over 95 KB of html; a hard ceiling at 512 KB
    (refused, rule 10) bounds the parse.
- **Linear on hostile bodies:** parse5 is quadratic on deep nesting (scope
  walks) and on many attributes in one tag (its duplicate check), so the
  html is refused past 128 levels of nesting (a tree-adapter cap), 256
  attributes on a tag (a pre-parse scan that mirrors the tokenizer — exact
  because `<script>` / `<svg>` / `<math>` / `<select>` / `<frameset>` are
  refused BEFORE the parse: script data's escape states, foreign content and
  the select / frameset modes would desynchronise it) or 400 conditional
  comments; worst cases pinned in
  `tests/emailDesignRules.timing.test.js`. Prod dependency: `parse5` 7.3.0
  (already in the tree under jsdom).
- **`createCampaign` `design_id`** (body `design_id`): EMAIL only (400
  `design_not_email`), an existing (400 `unknown_design`), non-archived (400
  `design_archived`) design; stored as provenance — the body stays exactly
  what the caller sent and is not re-validated against the rules.
- Not built here: anything writing `thumbnail_asset_id` (the contract carries
  no thumbnail), the editor (C3b).

**As built (C3b) — the Designer editor mode.** `public/js/campaignDesigner.js`
(`window.YcDesigner`; require()-able for the unit tests) + `public/campaign.html`.
Spec: the C3 spike findings (`local/2026-11-03_YISRAMAIL_C3_SPIKE_FINDINGS.md`),
implemented by item. The editor is not a security boundary — the server's save
rules (C3a) and C2's post-render assert are; the editor's job is that normal
use never produces a design they refuse.
- **Loading:** GrapesJS 0.23.8 + grapesjs-mjml 1.0.8 + the GrapesJS CSS from
  jsdelivr with the findings' sha384 `integrity` (and `crossorigin`), injected
  the first time Designer is picked — a plain compose fetches none of it
  (~650 KB gz). A failed or mismatched file refuses to load and the mode falls
  back. `campaignDesigner.js` itself (no library code) loads with the page.
- **Canvas:** Mitigation A — `canvas.frameContent` carries the CSP
  (`script-src 'none'`, …); `allowExternalDrop:false` and a capture-phase drop
  guard keep a dropped file from becoming a base64 image; a paste into a text
  block is inserted as PLAIN TEXT (rich paste would bring tables / data: images
  the server refuses).
- **Blocks:** the plugin's set cut to `mj-1-column`, `mj-2-columns`, `mj-text`,
  `mj-button`, `mj-image`, `mj-divider`, `mj-spacer` (no `mj-raw`), plus a
  Header block (logo + title). New designs start from a starter newsletter
  (adapted from the spike's).
- **The footer slot:** an `mj-section css-class="yc-footer"` → `mj-column` →
  `mj-text` holding ONLY a `comment` component whose content is
  ` yc:footer-slot ` — it exports as exactly one `<!-- yc:footer-slot -->` inside
  the card, no visible text (Fred's rule: C2 injects at the marker and deletes
  nothing around it). After every load (`normalizeFooter`) the footer is made
  canonical: one section, marker-only content, last child of `mj-body`, locked
  — `removable / draggable / droppable / copyable / editable:false`,
  `stylable:['yc-locked-footer']` (a list naming no property: grapesjs-mjml's
  column view throws on `false`; an empty list measures the same, 0
  properties — the named list only says what it is for),
  `toolbar` = select-parent only, `traits:[]`, on the section and every child.
  The six "Not blocked" items: `mjml-import` button removed and the command
  refuses; `UndoManager.clear()` after every load; `core:canvas-clear` refuses;
  `mj-body`'s `droppable` refuses an index below the footer and a
  `component:add` guard moves anything that lands there back above it;
  toolbar and traits as above.
- **Footer preview (display only):** the marker comment's VIEW renders a
  dashed block of static sample lines styled like `lib/complianceFooter`
  ("Compliance footer preview — added here when the email is sent", the ad
  label, why / unsubscribe, firm line, attorney, §528 statement). It exists
  only in the canvas DOM — the model holds the comment, so `getProjectData()`,
  `getHtml()` and the compiled html carry the marker alone. The real footer:
  "Send test to me".
- **Export:** rich-text editing is ended explicitly (`view.disableEditing()`)
  before every read (Q1 risk); then `getProjectData()` (design_json),
  `mjml-code-to-html` (html) and a client-side `deriveText` (text: comments /
  head / hidden preheader dropped, links as `label (url)`, blank line between
  blocks) — the design row's text only; C2 builds a campaign's text part from
  the body itself. `checkExport` refuses a save (and a Designer Create) with
  ≠ 1 marker, a `data:` image, an image inside a text block, a URL attribute
  that is relative or starts with a merge tag other than
  `{{send.unsubscribe_url}}` / `{{send.preferences_url}}` (C3a's rule 6), or a
  footer that is not the last block / not marker-only — the same shapes the
  server refuses, caught first with a plain message.
- **Merge tags:** ONE list — `#c-placeholder-email`'s options feed the text
  toolbar's `{{ }}` select (`RichTextEditor.add`, `insertHTML`, caret moved
  after the tag), the compose list itself (inserts into the text being
  edited), and a `yc-url` trait on `href` (`mj-button`, `mj-image`, `link`)
  with the same list beside the input — it refuses a tag at the START of an
  address (a contact value there could become `javascript:`). No type has a
  `src` trait: image addresses come from the AssetPicker only.
- **Text toolbar:** bold `<b>`, italic `<i>`, underline `<u>`, link `<a>`,
  wrap-for-style (a span) and the merge-tag list — every one inside the
  server's allowed inline set (a browser test runs each on a selection and
  feeds the export to the real validator). Strike-through is REMOVED: Chrome
  writes `<strike>`, which the server refuses (rule 2 allows `<s>`), so one
  click would make every later save fail.
- **Images:** `open-assets` is replaced: every image flow (double-click an
  image, the image block) goes to the shared `AssetPicker.pick`; only an
  http(s) URL is applied. No GrapesJS asset-manager upload, no base64.
- **Save / load (`/api/email-designs`, C3a's contract):** Save = POST (new) or
  PUT `:id` with exactly `{name, design_json (object), html, text}`; "Save as
  new" POSTs; a `warning` is shown and the save stands; a 400
  `design_rejected` shows "Rule N (name): detail". The Designs dialog lists
  (search, archived too), opens (GET `:id` → `loadProjectData` → footer
  normalized → history cleared), duplicates (opens a copy, unsaved, "Copy of …")
  and archives / restores (PATCH). Unsaved changes are confirmed before
  another design replaces them.
- **Compose:** Designer is the third `#c-editor-mode` option; its body is the
  compiled html (`getBody` is async — Preview, the test send and Create await
  it). Create sends `design_id` only when the body IS the open design's saved
  html; otherwise it asks: save first, or send with no `design_id`. Signature
  append is greyed out in Designer with the reason, and Create never appends
  it to a Designer body. Video links are not offered in Designer (a toast
  says so). Duplicate on a campaign with `design_id` reopens that design in
  Designer.
- Tests: `tests/campaignDesigner.test.js` (no browser) and
  `tests/campaignDesigner.browser.test.js` (real Chromium, gated on
  `PUPPETEER_EXECUTABLE_PATH`, driver `tests/helpers/campaignDesignerSmoke.js`).
  Native drag of a block from the panel is not automatable headless — a hand
  check.

### 6.4 Send pipeline changes

- **Send reservation — at most once.** Today `executeSend` sends, then
  records; a failure in `recordResult` / `checkCompletion` is retried as a
  job and **sends again** (the `recordResult` header says so). From C1, for
  every campaign class: (1) reserve — upsert the `campaign_results` row as
  `sending` with an attempt id (and, for marketing, mint the unsub token)
  BEFORE any provider call; (2) send; (3) update to `sent` with the provider
  message id. A retry that finds its row `sending` does NOT resend: the
  outcome is ambiguous (the provider may have accepted it), so the row goes
  to `unknown` and counts as such in the stats — a missed message over a
  duplicate, the rule AI_CONTEXT §17 already states for unrecognized
  errors. Provider errors received before acceptance (a 4xx/5xx reply) are
  definite and keep today's retry/permanent classification. New
  `campaign_results.status` values `sending` / `unknown` (enum expansion).
  The reserved row also gives early provider events something to update
  (§5.4).
- **Delivery-state precedence:** complained > bounced > delivered > sent —
  the step-(3) `sent` update never overwrites an event that arrived first.
- **Rate — enforced at dispatch, per transport.** Staggered
  `scheduled_time` paces a healthy campaign but enforces nothing after an
  outage (hundreds of overdue jobs) or with two campaigns on one transport.
  So: before step (1), the send checks a per-transport window (sends
  recorded for this transport in the last 60 s ≥ the transport's rate →
  defer the job a few seconds, consuming no attempt). Soft at the edge, like
  the hub budget. The **pump** stays the accelerator and catches up bounded:
  each tick rings doorbells for at most `rate × tick` due jobs, overdue
  ones included, never all of them.
- **The pump.** At create, a marketing (or over-cap) campaign inserts its
  per-recipient jobs with `scheduled_time` staggered at the campaign's rate
  (D12) and ONE `campaign_pump` job due now. Each tick rings Cloud Tasks
  doorbells (`lib/taskQueue.enqueueJobDispatch`) only for that campaign's
  jobs due within `ACCEL_WINDOW_MS` (90 s), bounded as above, then
  reschedules itself ~60 s later until no pending jobs remain. This keeps
  `lib/taskQueue.js` invariant 3 ("a DOORBELL, not a CALENDAR") and keeps
  `POST /api/campaigns` fast. 2,000 at 60/min ≈ 33 min.
- **Cron fallback can't starve other jobs.** The `process-jobs` batch claim
  (`ORDER BY scheduled_time LIMIT 10`) takes at most N `campaign_send` rows
  per tick (N < 10, e.g. 5); other due jobs claim first.
- **Campaign status as the job sees it:**

  | status | job does |
  |---|---|
  | `scheduled` | proceeds; the first send flips the campaign to `sending` |
  | `sending` | proceeds |
  | `paused` (new) | **defers** — reschedules itself, records nothing, consumes no attempt; resumable |
  | `canceled` | records `skipped` (today) |
  | `sent` / `failed` / `partial_fail` | records `skipped` (a straggler after completion) |

  Pause = status `paused` + pump stopped; pending jobs stay pending (no
  `active=0` flip). Resume = status back to `sending` + pump restarted.
  `cancelCampaign` accepts `paused`.
- **Account pause.** SMTP 5xx is classified permanent today, so an SES
  "sending paused" reply would fail every remaining recipient. The send
  detects the provider's account-level refusal explicitly BEFORE
  classification → the campaign (and every other marketing campaign on that
  transport) goes `paused`, the transport is held (§6.5), an `error` alert
  fires; that recipient's row goes back to pending (the refusal came before
  acceptance).
- **Volume per send.** Per recipient: one `scheduled_jobs` row, one
  `campaign_results` row, one `comm_unsub_tokens` row, one `email_log` row.
  The marketing path writes `email_log` WITHOUT the body (the campaign's
  snapshot is the copy — §4.5), so a 5k send adds rows, not megabytes.
- Per-recipient event columns on `campaign_results`: `provider_message_id`
  (indexed), `delivery_state`, `delivery_at`, `bounce_type`; `opened_at` /
  `clicked_at` arrive with C6. Fed by §5.4.
- Test send: "send a test to me" renders against a chosen contact and goes
  through the same transport (no token write, `[TEST]` subject prefix).

**As built (C1).** Account pause, the delivery-state precedence on the
marketing path, the per-recipient token and the test send are C2's.
- **Reservation (every class):** `executeSend` first reads this recipient's
  row: final (`sent` / `failed` / `skipped` / `unknown`) → a replay, nothing
  touched; `sending` → an earlier attempt reserved and died: the row becomes
  `unknown` (old `result_meta` kept + `unknown_note`), never resent. Before
  the provider call it INSERTs the row as `sending` with
  `result_meta.attempt_id = '<scheduled_jobs.id>:<attempt>'` (a plain INSERT;
  a duplicate means another worker owns it → touch nothing) — single-row
  autocommit, so nothing here holds a `campaign_results` lock and then asks
  for a contact row (T2's lock order). Success UPDATEs THAT attempt's row to
  `sent` + `provider_message_id` (`COALESCE` — never overwrites a stored one)
  + a fresh `sent_at`; the update also accepts `unknown` for the same attempt
  id (a slow attempt a recovery run marked unknown still lands as sent).
  Skip / failure outcomes with no provider call are recorded FIRST-WINS
  (`recordResult`'s ODKU no longer overwrites — a replay can never turn
  `sent` into `skipped`).
- **Error classification (`isAmbiguousSendError`):** DEFINITE (reservation
  deleted, then `isTransientError` decides retry vs `failed` as before) —
  checked by CODE first, before any message heuristic: an SMTP reply
  (`err.responseCode` — even a 421 whose text says "Timeout"), our own T1
  fence codes (`bulk_sender_refused` and kin), a MySQL server error (`ER_*` /
  `PROTOCOL_*` code or a `sqlState`); then an HTTP status (`err.status`, or a
  `"<Provider> API|SMS|MMS <status>:"` message), a connection that never
  opened (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`,
  `ENETUNREACH`, `EAUTH`, `ETLS`, `EDNS`, `UND_ERR_CONNECT_TIMEOUT`), and
  anything unrecognized (our own pre-send errors: a missing credential, a bad
  number — `isTransientError` calls an unrecognized error permanent, so none
  of these is resent). AMBIGUOUS (→
  `unknown`, returned, never retried) — `ESOCKET`, `ETIMEDOUT`, `ETIME`,
  `ECONNRESET`, `EPIPE`, `ECONNECTION` (nodemailer's "closed unexpectedly"),
  `ECONNABORTED`, `UND_ERR_SOCKET` / body / headers timeouts, an Abort /
  Timeout error, or a "timed out / socket hang up / closed unexpectedly /
  connection reset" message — with no reply code. One conservative edge: a
  DB CONNECT timeout / reset (mysql2 `ETIMEDOUT` / `ECONNRESET`, no sqlState)
  in a pre-send lookup inside the send span cannot be told from a provider
  socket and comes out AMBIGUOUS (`unknown`, a missed message, never a
  duplicate). The adapters log to `email_log` / `phone_log` fire-and-forget,
  so no post-acceptance DB write surfaces as a definite error. A failure
  AFTER the reservation that the outer catch sees (the `sent` update or the
  clearing DELETE threw): transient with attempts left → rethrown, and the
  retry finds the row `sending` → `unknown`; final attempt or permanent → no
  retry follows, so the outer catch marks THIS attempt's row `unknown` itself
  (conditional on `sending` + its attempt id — a row that landed `sent` is
  untouched) and checkCompletion runs, instead of a first-wins `failed` that
  would be a no-op and leave the campaign unfinished forever.
- **checkCompletion:** `sending` rows are not done; `unknown` is. Final
  status: `sent` only when nothing failed, was skipped or is unknown; `failed`
  when nothing was sent; else `partial_fail` (unknown counts like failed);
  `result_summary` = `{sent, failed, skipped, unknown}`. Finalizes from
  `sending` / `scheduled` / `paused`. getCampaign / listCampaigns carry
  `sending` / `unknown` counts.
- **Rate window — narrowed to bulk transports:** only a campaign whose sender
  is a `bulk_ok` row (today: over-cap operational; C2 adds marketing) counts
  `campaign_results` `IN ('sending','sent')` joined `campaigns` on the same
  `sender` with `sent_at` in the last 60 s; ≥ `campaign_marketing_rate` →
  DEFER 2–8 s (jittered). Non-bulk transports have no window (the hub budget
  covers them) — the reading of "per transport" C1 took (`ref/plans.md`).
- **Deferral:** `executeSend` returns `{deferred, retryAtMs, reason}`;
  `lib/job_executor` wraps it in `deferJob()` — an object marked with a
  module-private Symbol (no job OUTPUT can forge it: custom code and webhook
  results cross as JSON); `routes/process_jobs.js`, right after `executeJob`
  and before the recording transaction (unchanged), sets the row `pending` at
  `retryAt` (`WHERE status = 'running'`) — `attempts` / `execution_count`
  untouched, no `job_results` row, no doorbell.
- **Status table as built:** `scheduled` proceeds (the first reservation
  flips it to `sending`); `sending` proceeds; `paused` — normally never seen,
  pause parks the pending rows — is the backstop for a job claimed before
  the pause: it defers 5 min (+ ≤ 30 s jitter), nothing recorded; `canceled` → `skipped`; `sent` / `failed` /
  `partial_fail` → `skipped` (first-wins, so only when no row exists).
- **The pump** (`campaign_pump` job, `campaignService.runPump`): inserted at
  create for marketing and over-cap campaigns, due at the campaign's start
  (`jobTime` — now for a send-now, the scheduled time otherwise — floored to
  the second: DATETIME rounds), its doorbell rung when within
  `ACCEL_WINDOW_MS`; name + idempotency key `campaign:{id}:pump` (inside the
  cancel prefix). Each tick: campaign gone / paused / canceled / finished →
  done (the job completes); a NEWER pending / running pump for the campaign →
  done (`superseded`); else ring `enqueueJobDispatch` for the campaign's
  pending sends with `scheduled_time <= NOW() + 90 s`, ordered by time, LIMIT
  `pumpBound(rate)` = rate × 55/60 — the re-arm interval, so a catch-up tick
  never exceeds the rate per minute (≥ 1) — overdue ones included;
  then sends still pending / running → re-arm the SAME row 55 s out (the
  deferral above: one row per pump; a crash mid-tick leaves it `running` for
  recoverStuckJobs, never a second row) AND ring that row's own doorbell for
  the same instant (55 s < ACCEL_WINDOW_MS, invariant 3 holds) — a 60 s
  re-arm with no doorbell waited for the next cron tick and ran the pump at
  about half the rate; none left → done. Sends are
  staggered at create: job i at `jobTime + i × 60/rate s`. Within-cap
  campaigns get no pump and no stagger.
- **Cron quota:** `runJobPass`'s BATCH claim only — two candidate reads with
  no locks (non-campaign due rows `ORDER BY scheduled_time LIMIT 10`, then
  `name LIKE 'campaign:%:send:%'` rows `LIMIT min(5, 10 − others)`), then ONE
  locking read `WHERE id IN (…) AND <the claim predicate> FOR UPDATE SKIP
  LOCKED`, all in the one claim transaction; others execute first. The
  targeted claim is unchanged; the predicate is one shared text (`CLAIMABLE`).
  Locking by id instead of a name-filtered range scan keeps REPEATABLE READ
  from locking every campaign row walked past (a pump doorbell arriving
  meanwhile would lose its claim).
- **Pause / resume:** `PATCH /api/campaigns/:id` `{status:'paused'}` from
  scheduled / sending, `{status:'sending'}` from paused (409 otherwise, 404
  missing); `cancelCampaign` accepts `paused`. PAUSE, in ONE transaction with
  the status write, PARKS the campaign's pending campaign_send rows
  (`scheduled_time + INTERVAL 1000 YEAR`; a row ≥ 2900-01-01 is parked — a
  threshold no real send can reach: `createCampaign` refuses a
  `scheduledTime` more than 366 days out, 400 `schedule_too_far`):
  still pending, never due, so a paused campaign's overdue rows cannot hold
  the cron's 5-row quota against other campaigns (a fixed per-tick defer did:
  15 paused rows starved a within-cap send for three ticks). A crash leaves
  both writes or neither; a job already claimed is the backstop case above.
  RESUME, in one transaction with its status write, pulls every pending row
  back: stragglers first, then the parked rows in their original order, row i
  at base + i × 60/rate s (within-cap: + 0), base = the later of NOW() and the
  earliest parked original — a running campaign restarts paced from now, one
  paused before its start keeps its start. Resume rule: insert a pump iff
  the campaign has pending / running sends and no pump is already PENDING —
  whatever its class (a within-cap campaign's deferred sends then return at
  once instead of 5 per cron tick) — due at the earliest pending send; then
  checkCompletion. A pump still running its last tick at resume retires on
  its next one (newest wins), so the resume race leaves one pump.

**As built (C2).** `services/campaignService.js` (executeSend's marketing
branch, `testSendMarketing`, `releaseTransport`), `services/unsubService.js`
(`mintOrReuseUnsubToken`), `services/emailService.js` + `smtp.js`
(`log_body`), `lib/complianceFooter.js` (`firm` snapshot input),
`routes/campaign.js`, `public/campaign.html`; schema by
`scripts/yisramailC2Migrate.js`
(`ref/migrations/2026-11-04_yisramail_c2_marketing_send.sql`). It slots INTO
C1's reservation contract — reserve → send → `sent`, ambiguous → `unknown` —
unchanged. `marketing_send_enabled` stays `'0'` until gate G1.
- **Order, marketing email** (switch exactly `'1'`): contact → consent
  (`consentOptsFor` → `findOptedOut(…, {klass:'marketing', topic})`: scope
  `marketing` / the topic, and an `opt_in` topic needs state `opted_in` — P1's
  predicate) → channel → the `bulk_ok` row (gone non-bulk since create →
  `failed` `marketing_requires_bulk_sender`) → **the hold** (§6.5 "As built
  (C2)") → **the send-start snapshot** → C1's rate window → RESERVE →
  **token + render + post-render assert** → send → `sent`. A marketing body
  is resolved AFTER the reservation (it may use `{{send.unsubscribe_url}}`,
  and the token needs the row's id). Anything THROWN in the token / render
  step (a resolver DB error, a mint deadlock) clears the reservation exactly
  like a definite send error — nothing reached the provider, so a retry
  re-reserves (pinned: `tests/campaignC2.mysql.test.js` X). C1's
  scheduled → sending campaign flip still sits between that step and the
  send, outside the clearing catch: a throw there leaves the row `sending`
  and the retry records it `unknown` (a missed send, never a duplicate —
  C1's rule); a permanent render outcome
  (`body_unresolved`, `footer_missing`) finalizes THAT reservation `failed`
  (`failReservation`, conditional on `sending` + the attempt id) with no
  provider call.
- **Token (`mintOrReuseUnsubToken`):** plain autocommit statements on the
  pool right after the single-row reservation INSERT — no transaction holds
  the `campaign_results` row while the token row is written, so T2's lock
  order (result row, then contact row) is never in play. `send_ref` = the
  reservation's `result_id`. An UNUSED token of the same (campaign, contact,
  destination, topic) — an earlier attempt of this send whose provider call
  failed definitely, so nobody received it — is re-pointed at the new
  attempt instead of minting a second row; a token after an ambiguous attempt
  never comes back (that recipient is `unknown`, never re-reserved).
- **Render (`renderMarketing`, shared with the test send):** body resolved
  `escape:'html'`, subject unescaped, refs `contacts` + `send`
  (`unsubscribe_url`, `preferences_url`, `topic_key`, `topic_label`) + `firm`
  = the snapshot's. Footer = `buildComplianceFooter({unsubscribeUrl:
  urlFor(token), preferencesUrl: preferencesUrlFor(token), topic, firm})`,
  injected at the **footer-slot marker `<!-- yc:footer-slot -->`** (the
  first one INSIDE the body — after the `<body>` open tag, or after
  `</head>` when there is no `<body>`, and before the closing tag; a marker in
  `<head>` / `<title>` or after `</body>` is normally ignored — C3's builder
  places the footer inside a card layout with it) or before the LAST
  `</body>`, else before `</html>`, else appended; a `</body>` that comes
  after `</html>` is
  ignored, so the footer never lands after `</html>`. Indices come from an
  ASCII-only lowercase (`toLowerCase` can lengthen a string). The body window
  is found by plain string search, so this placement is best effort against
  ACCIDENTAL misplacement, not a visibility guarantee: a `<body` inside a
  comment, a `<title>` or an attribute value in `<head>` moves the window into
  `<head>`, and the post-render assert still passes. A campaign author can
  defeat it deliberately — as with CSS that hides the footer, which no string
  assert catches. **Text part**
  (`textPartFor`): comments and `<head>` / `<style>` / `<script>` /
  `<title>` removed, every http(s) / mailto link kept visible as
  `label (url)` (the bare url when the label is the url), `<br>` / `</p>` /
  `</li>` line breaks (no other block closer adds one), tags stripped, and
  these entities decoded: `&nbsp;` `&lt;` `&gt;` `&quot;` `&apos;` / `&#39;`
  `&amp;` plus every numeric entity (`&#NNN;`, `&#xHH;`) — other named
  entities (`&copy;`, `&mdash;`, `&rsquo;` …) pass through as written, as
  they did in `emailService.htmlToText`;
  the footer's text appended at the end. Every step is LINEAR (indexOf loops,
  no overlapping quantifiers — CLAUDE.md's validator rule: a staff-authored
  body runs here per recipient and inside the test-send request); the worst
  cases are pinned by a timing test (`tests/campaignC2.test.js`). It no
  longer calls `emailService.htmlToText`, whose `<[^>]+>` strip is quadratic
  on unclosed tags (pre-existing, `ref/plans.md`). The topic the footer states is the snapshot's, with the
  advertisement label whenever EITHER the snapshot or the live topic is
  `opt_out` (a topic flipped mid-send never drops the label).
- **Post-render assert (`footerHoles`), fail closed:** on the FINAL html and
  text — the html carries the builder's own marker
  (`data-yc-compliance-footer="1"`), not after `</html>`, the footer block
  and `href="<unsubscribe url>"`; the text contains the footer text and the
  url. A hole, or the builder
  throwing (a missing firm name / address / attorney), → that recipient
  `failed` `footer_missing: …`, NO provider call, per recipient (the job
  returns normally; the campaign finalizes).
- **Send:** `sendEmailDirect(bulkRow, {…, bulk:true, headers:
  {List-Unsubscribe: <url>, List-Unsubscribe-Post: List-Unsubscribe=One-Click,
  List-Id: <topic.sender-domain>}, reply_to, tags: {campaign_id, result_id}
  (strings), log_body:false})`, html + the explicit text, the attachment
  ONCE (below), NO signature. `List-Id` = `<topic_key.sender-domain>`
  (`_` → `-`), e.g. `<newsletter.news.4lsg.com>`. Reply-To = the snapshot's
  (`marketing_reply_to`, blank → `firm_email`; both blank → none, replies go
  to the sender). The SES driver adds its own headers (T1).
  `provider_message_id` lands on the `sent` update (C1's, unchanged).
- **`email_log` without the body:** `log_body:false` (a new bulk-only
  option) makes the smtp adapter write `LOG_BODY_OMITTED` in place of the
  body on the success row (envelope + `delivery_info` kept; the FAILED row's
  body is the error text either way). Fail closed in `emailService`: exactly
  `false`, only with `bulk:true`, only with a `List-Unsubscribe` header (so the
  over-cap D16 send — no headers — always logs its body), only on an adapter
  declaring `log_without_body` (smtp); else `marketing_log_body_refused` /
  `adapter_lacks_capability`. The public `sendEmail` strips it.
- **Send-start snapshot (`campaigns.send_snapshot`, MRPC 7.2(b)):** written
  ONCE by the first marketing send to reach it (`UPDATE … WHERE send_snapshot
  IS NULL`, then read back — a concurrent first send converges on the
  winner): `{v, taken_at, firm (firmValues()), topic, reply_to, list_id,
  sender, subject, html, text, token_placeholder:'{token}'}` — the template
  copy is the body with the footer injected for the placeholder token. Every
  recipient renders from it, so a settings edit mid-send cannot split the
  campaign; a new campaign takes the new values. A firm hole at snapshot time
  → that recipient `failed` `footer_missing`, nothing written (the next send
  tries again). No campaign delete route exists — keep it that way (§4.5).
- **Account pause:** a marketing send's DEFINITE error (`isAmbiguousSendError`
  says no — an error with no reply stays `unknown`, never re-pended)
  matching SES's account-level family (`isAccountPausedError`: "Account is
  paused", "Sending paused for this account / configuration set", "Sending
  suspended for this account", the `*SendingPaused*` exception names; an SMTP
  reply code, if any, 4xx/5xx) → the reservation cleared (the refusal came
  before acceptance), the transport HELD with the reply as the reason (which
  pauses every running marketing campaign on it, this one included, and
  raises the `error` alert), and the job DEFERRED like the paused backstop —
  the recipient is back to pending, no attempt used. **`VERIFY(live)`:** AWS
  documents the condition and the API exception names, not the SMTP reply
  text; the SMTP shapes are community-reported — widen the pattern from the
  first real one. An ordinary 554 (an unverified address) stays a
  per-recipient `failed`.
- **Test send (`POST /api/campaigns/test-send`, `testSendMarketing`):**
  `{sender, subject, body, topic_key, contactId, attachmentUrl?}` → the same
  `renderMarketing` for that contact with the LIVE firm values, `[TEST] `
  before the subject, the same transport, headers and Reply-To, to the
  caller's own `users.email`. The unsubscribe URL uses the dead placeholder
  token `test.send.no-token` (it fails `PUBLIC_TOKEN_RE`, so `/u/` answers
  the neutral page and a one-click records nothing) — no token row, no
  campaign or result row, no tags, the body logged (not a broadcast). Needs
  `campaigns.bulk` (403) and a staff login with an email (400); refused on a
  held transport (422). Works while `marketing_send_enabled` is off: it is
  staff-to-self, so the footer and headers can be checked before G1. The
  compose tab shows "Send test to me" for the marketing class (with
  `campaigns.bulk`), rendering for the first selected contact.
- **Attachments (security + a pre-existing duplicate, review round 1):**
  an EMAIL campaign's `attachment_url` must be `https://` at create
  (`assertHttpsAttachment`, 400 `bad_attachment_url` — refused, never
  stripped; rows created before C2 are not re-checked), and so must the test
  send's: nodemailer reads any attachment `path` that is not a URL as a LOCAL
  FILE, so `/proc/self/environ` would have mailed the server's secrets. The
  root fix is in the adapters: the smtp transport and the gmail adapter's
  MailComposer set `disableFileAccess` (URL paths and inline `content` still
  work; `disableUrlAccess` is not set; no caller passes a local path — swept
  2026-11-04). executeSend (every class) and the test send pass the file
  ONCE, as `attachment_urls` — passing it as `attachments` too made smtp and
  gmail attach it twice (their `buildAttachments` concatenates both).
- **Not built here:** the C3 builder (it places the slot marker), C4's
  reporting, a hold for the over-cap D16 sends on a held transport (the
  hold gates marketing only — `ref/plans.md`), and auto-release (never).

### 6.5 Complaint safety (enforced from the first send) and reporting

- **Enforcement — T2 + C2, part of gate G1.** T2 computes the rates (no
  counter table): `mailEventService.transportHealth(db, {credentialId |
  campaignId})` over the last 24 h of `campaign_results` — per transport (the
  campaigns' sender row) or per campaign — gives complaint_rate = complaints /
  delivered and bounce_rate = hard bounces / (delivered + hard bounces), the
  hard bounces leaving out SES's suppression subtypes (OnAccountSuppressionList,
  EmailValidationSuppressed, OnTenantSuppressionList — AWS does not count them),
  and `enough` = ≥ 200 deliveries in that window. T2 itself alerts: every
  complaint → `warning` (once per address per day); a transport's hard bounces
  > 5 % with `enough` → `error` (once per transport per day). C2 checks
  `transportHealth` before every marketing send: complaint rate > 0.1 % →
  `warning`; > 0.3 % (the Gmail ceiling, Appendix C) or hard bounces > 5 % →
  the **transport is held**: every running marketing campaign on it is paused
  (§6.4), new ones refuse, an `error` alert fires, and only an SU release
  (audited) lifts it. Rates decide nothing until `enough`, so one early
  complaint doesn't trip a hold — but any single complaint still alerts.
- **Reporting — C4.** Campaign view adds delivered / bounced / complained /
  unsubscribed / unknown counts (unsubscribes from the ledger by
  `send_ref`) and the transport's current rates.

**As built (C4) — reporting + the daily digest.** `getCampaign` carries a
`delivery` block for marketing EMAIL campaigns only (operational sends have no
delivery events — zeros there would lie): delivered by the set-once
`delivered_at` stamp (a complaint OUTRANKS delivered in the status column, and
that mail WAS delivered), bounced by terminal `delivery_status =
'bounced_hard'`, complaints by `complained_at`, unsubscribes from the ledger
by `send_ref` = the campaign's `result_id`s AND source ∈ one_click /
unsub_page / pref_page (unsubService's surfaces; mail_event_ingest writes
provider_bounce / provider_complaint opt-outs with the SAME send_ref, which
without the source filter count every bounce and complaint as an unsubscribe
too — review B1, 2026-11-05; the join CAST is pinned
`COLLATE utf8mb4_general_ci` — send_ref's collation — or the connection
default makes it an illegal mix). Deliberate asymmetry: the per-campaign
`bounced` count INCLUDES SES suppression-subtype bounces (the recipient did
not get the mail) while transportHealth's rates exclude them (they say
nothing about the transport) — the digest's two tables can differ by that.
Plus a `transport` block (transportHealth + the §6.5 held state; null when
the sender row is gone). The Stats dialog renders both; below-volume rates
say "low volume — rates not decisive" instead of pretending precision.
The DIGEST: `mail_bounce_digest` (`lib/internal_functions/mailDigest.js`,
CTA-denied, uiHidden) over `mailEventService.bounceDigestData` — the last
24 h per campaign + per bulk transport, emailed only when the window saw
activity; recipient `campaign_bounce_digest_email` → `alert_recipients`,
sender `alert_from_email` → `email_automations` (the alerting email path's
resolution); off only when `campaign_bounce_digest_enabled` = `'0'` (fresh
read each run, never the cfg cache); activity with no recipient THROWS so
the failed-job sweep sees it. Driven by the daily "Marketing Mail Digest"
recurring job, 12:00 UTC
(`ref/migrations/2026-11-05_yisramail_c4_mail_digest_job.sql`, applied
through the SU console AFTER the C4 backend deploy).

**As built (C2).** The HOLD is `email_credentials.held_at` / `held_reason`
(per transport, survives restarts, visible in compose — the marketing sender
reads "— HELD"). `transportHealth` stays computed (no counter table).
- **Checked before EVERY marketing send** (executeSend, after consent, before
  the snapshot and the rate window) and at **marketing `createCampaign`**
  (422 `transport_held`, `held_reason` in the body); the test send refuses it
  too. A held transport → `pauseCampaign` (C1 — the pending sends parked),
  nothing recorded for the recipient (its job DEFERS like the paused
  backstop and is re-staggered on resume), and an `error` alert
  `mail_transport_held` once per HOLD per UTC day (dedup key on the
  transport, its `held_at` and the day — a re-hold after a same-day release
  alerts again). The alert names the release path: the API route below
  (there is no button).
- **The thresholds** (`transportHealthGate`, each marketing send, decided
  only with `enough` = ≥ 200 delivered in 24 h): complaint rate > 0.3 % or
  hard-bounce rate > 5 % → SET the hold (first trip wins the reason),
  pause EVERY running (scheduled / sending) marketing campaign on that
  sender, the alert above, and this send defers; complaint rate > 0.1 % →
  `warning` `mail_complaint_rate` once per transport per day and the send
  goes. The account-level refusal (§6.4 "As built (C2)") sets it too.
- **Release:** `POST /api/campaigns/transports/:id/release`,
  `superuserOnlyFor('mail_transport_release')` (SU + step-up + rate limit —
  the consent-import pattern). The clear and its `admin_audit_log` row
  (`mail_transport_release`, details: id, email, held_at, held_reason) commit
  in ONE transaction; then an `info` alert. 404 unknown, 409 not held.
  Paused campaigns stay paused — staff resume each; `resumeCampaign` refuses
  a marketing campaign whose transport is still held (422 `transport_held`).
  No auto-release.
- The hold gates the MARKETING class only; an over-cap operational (D16)
  campaign on the same `bulk_ok` row is not held (`ref/plans.md`).

**As built (C7) — promotional automations, the second kind of campaign email.**
Fred (2026-11-05): "there are two kinds of campaign emails, send now to many
people and send to people as something triggers it. I didn't think about the
second when I designed campaigns." The campaign engine stays blast-shaped;
the triggered kind is `campaignService.sendPromotional` — ONE recipient, no
campaign row — reached from a workflow / sequence `send_email` step with
`promotional: true` + `topic` (+ optional `design_id` / `contact_id` /
`marketing_sender`).
- **Same compliance plumbing as a campaign send:** the kill switch (not '1' →
  422, a loud configuration error), consent by topic with opted-out →
  `{ sent:false, skipped:'opted_out' }` (the automation goes on — a birthday
  sweep must not die on one opt-out), a REAL unsub token (`campaign_id` NULL,
  contact attributed, fresh each send — the reuse path needs a campaign),
  renderMarketing + footer at the slot + the post-render assert, marketing
  headers + Reply-To, bulk transport only (named via `marketing_sender`, or
  the firm's ONLY bulk row — refused when none or several), held → 422.
  `from` and `include_signature` are ignored on a promotional step.
- **Deliberately absent** (triggered volume is a handful a day — the
  reporting gap is in `ref/plans.md`): no campaign_results row, so no
  reservation (the engine's step retry owns retries), no delivery
  correlation (a bounce still suppresses — mail_event_ingest records the
  ledger event uncorrelated), invisible to transportHealth and the digest;
  no rate window and no transportHealthGate (both are campaign-traffic
  measures); email_log KEEPS the body — with no campaign snapshot the log is
  the MRPC 7.2(b) record.
- **Designs from any automation (both classes):** `design_id` loads the
  Designer template at RUN time (the engine resolves only the step config,
  never the design), so its merge tags resolve in the function against
  `contact_id` — promotional inside renderMarketing, operational through the
  same resolver with no footer (D18: it reaches opt-outs). Archived designs
  refused, as at campaign create.
- **Who may author one — the D13 gate (review B1):** a send_email step whose
  `promotional` is anything but a literal falsy needs `campaigns.bulk`, at
  EVERY writer (`lib/promotionalSendGate.js`, the codeStepGate pattern):
  the workflow step writers + test-step + Casey's dry-run preview, sequence
  steps — ALL FOUR function-carrying action types, since sequences run
  'sms'/'email'/'task' through executeJob as internal functions too
  (re-review B1a) — scheduled jobs POST/PATCH, trigger-rule actions,
  email + phone ingest rule actions (inline on create, add, update —
  re-review B1b) and hook targets
  (those two map `params_mapping`, whose values resolve from the event at
  dispatch — so the PRESENCE of the promotional KEY is what is gated, fail
  closed on indirection; a {{placeholder}} in a step's promotional is refused
  the same way). Relaxing this to "any automation author" is Fred's call
  (`ref/plans.md`). A CTA plan may NOT carry promotional at all (review S1):
  the marketing path re-resolves merge tags over the FINAL text, so clicker
  input substituted into html/subject would resolve ({{contacts.contact_ssn}}
  against the plan's frozen contact) — refused at mint. The same second
  resolve applies to engine-substituted variable text in a promotional
  step's inline html: authors keep merge tags OUT of values they interpolate.
- **Casey (the argued default — vision says yes):** Casey keeps authoring
  promotional steps (risk: a misdescribed marketing send; mitigation: the
  impact card now reports the MARKETING semantics — the bulk transport as
  sender, the consent skip, the topic, the campaigns.bulk save requirement —
  and the save gate binds whoever publishes, Casey drafts included, since
  every workflow_steps INSERT lives in the gated routes). ONE exclusion,
  argued like attachments: model-invented `design_id` is refused (content
  Casey cannot inspect; a human picks the design in the editor; a stored
  design left unchanged is kept).
- **Account-level pause (review S4):** a definite SES account-refusal from a
  promotional send HOLDS the transport (holdTransport — campaigns on it pause
  at their next send) and fails the step 502 `account_paused`. An ambiguous
  provider error fails the step as-is and MAY have sent: promotional steps
  carry no retry policy (the engine default; the manual says so) — a retry
  could double-send, and there is no reservation row to dedupe on.
- **Guards kept:** SMS `promotional` is refused loudly (D1); `from` is
  save-required UNLESS promotional is the literal true (`requiredUnless` in
  the params validator — the editor's from-list never offers marketing
  transports, which is why `marketing_sender` is its own field);
  include_signature on a promotional step is REFUSED (the footer is the
  sign-off); send_email's CTA clicker-input set is pinned unchanged
  (to / subject / html) — no C7 param is clicker-writable.
- The step editors render the new params from `__meta` — no editor code.
  A birthday workflow is: a daily recurring job → query today's
  `contacts.contact_dob` matches → `send_email(design_id, contact_id,
  promotional?)`. Whether the firm's birthday default is operational (no
  footer, reaches everyone) or promotional is an open ruling (`ref/plans.md`).

**As built (C6) — open/click tracking.** Engagement is its OWN AXIS, never
the delivery one: SES `Open` / `Click` (published only once the config set
carries the custom tracking domain + the two event types) parse in the ses.js
driver like every event, correlate identically (result_id+campaign_id tags,
provider_message_id second), and then branch in mailEventService BEFORE the
delivery/ledger path — `campaign_results.opened_at` / `clicked_at` are
set-once (a click proves an open, so a click stamps both), `delivery_status`,
the consent ledger and the transport-health sweep are untouched. Each
correlated Click also writes one `campaign_clicks` row, idempotent on
`provider_event_id` (INSERT IGNORE — a hook-retried event re-runs and a
counter would double-count where set-once columns cannot). An uncorrelated
open/click (a C7 triggered send has no results row) stores nothing. Stats
(getCampaign → the Stats dialog) leads with clicks — opens are approximate,
Apple MPP prefetches — plus a top-10 per-link list (clicks + distinct
clickers). `ses:no-track` keeps unsubscribe/preferences URLs out of the tracking
redirect wherever they appear — the compliance footer's anchors carry it, and
`campaignService.addNoTrack` tags any BODY anchor whose href resolves to the
send's unsub/prefs URL (authors may place `{{send.unsubscribe_url}}`
themselves) — so an unsubscribe never counts as engagement and the /u/ link
never rides the redirect; the /u/ page discloses the tracking in one line.
SCOPE: tracking is config-set-wide — over-cap OPERATIONAL campaigns send on
the same bulk transport, so they carry the pixel and wrapped links too (no
footer; their engagement surfaces nowhere today). Routing them to a no-track
config set is the plans.md toggle — Fred's call.
The step editors gained `widget: 'email_design'` (send_email `design_id`
picked by name; archived/unknown stored ids label themselves; blank omits).
LIVE since 2026-11-05 (flip + stage-3 verify, campaign 120): shapes confirmed
on captured events (tests/fixtures/ses-events/open.json / click.json), and
they carry `isBotEvent` — a STRING ("Unlikely" observed) — so an open/click
SES flags Likely (or `true`) is IGNORED like a not-spam complaint; anything
else counts, the Gmail image-proxy open included (fail open — an
over-filtered click is unrecoverable, and only SES's own verdict is used). INFRA the docs hide: an HTTPS tracking domain cannot be a
bare CNAME to awstrack (no cert for your name — ERR_CERT_COMMON_NAME_INVALID,
found live) — `r.news.4lsg.com` is a CNAME to a CloudFront distribution
(origin `r.us-east-2.awstrack.me`, HTTPS-only, CachingDisabled + AllViewer so
the Host header forwards — SES requires it) carrying an ACM cert that lives
in us-east-1 (CloudFront's rule, the one deliberate us-east-1 piece). TWO
PERMANENT Namecheap records: `r.news.4lsg.com` → the CloudFront domain, and
the ACM validation CNAME (`_….r.news.4lsg.com` → `….acm-validations.aws`) —
ACM re-checks the latter to AUTO-RENEW the cert, so deleting it in a DNS
cleanup kills every tracking link in every email ever sent, silently, about
a year later. The guard is the daily `tracking_domain_check` job (C6c).

**As built (C6c) — the report UI + the watchdog.** The Stats dialog's
recipient table carries per-person Delivery / Opened / Clicked on tracked
campaigns (getCampaignResults rides the engagement columns + a per-recipient
campaign_clicks count, scoped by campaign AND result), and its Full report
button opens the richer view: the sent→delivered→opened→clicked funnel, the
top-links table, and a sortable, filterable per-recipient table — all
client-side over the two fetches Stats already made, no new endpoint. The
daily watchdog `tracking_domain_check` (uiHidden, CTA-denied) probes the
tracking domain the way AWS's doc verifies it (favicon GET: 200,
x-amz-ses-region, https protocol) and reads the TLS cert's days-to-expiry
off the socket — under 21 days (ACM renews ~60 out) or a broken response is
an error alert once per UTC day; a transient fetch failure is a warning
(lib/trackingDomainCheck.js probe/verdict split, the verdict pure and
mutation-tested). The C6b near-miss also taught the secret scanner
real-shaped `/u/` unsubscribe tokens (scripts/secret-scan.js; fixture
placeholders stay all-upper by convention), with the scrub-before-fixture
rule written into CLAUDE.md's one-way doors. A
per-campaign toggle is NOT built — deferred with its sketch in ref/plans.md
(a second config set, Fred may call for it). Deploy order was:
`scripts/yisramailC6Migrate.js` → backend → frontend → the config-set flip
(us-east-2; events arriving earlier were ignored by the old parser, harmless).

### 6.6 What stays out (later, `ref/plans.md`)

Drips/journeys = sequence enrollment from a campaign audience (the existing
YisraMail direction — no third flow engine); A/B subjects; send-time
optimization; dynamic content blocks. Open/click tracking is built — §6.5
"As built (C6)".

## 7. Builder (DECISION D9)

Constraints that decide it: `campaign.html` is a no-build vanilla-JS iframe
pane (libs from a CDN `<script>`, e.g. Quill 2 from jsdelivr); merge tags are
ours (`{{contacts.contact_fname|cap}}`); images go to our asset store
(`POST /api/assets`); YC3 wants no per-tenant cost line; client content
should not round-trip a vendor.

**Ruled 2026-10-29: GrapesJS core + `grapesjs-mjml`** (BSD-3, free), version-
pinned, loaded like Quill (or vendored under `public/vendor/` to drop the
runtime CDN dependency).
- Runs entirely in the browser; MJML compiles client-side (`mjml-browser`)
  to table-based, responsive HTML; design JSON + HTML both stored by us.
- `assetManager.uploadFile` → our asset API; no vendor sees content.
- Core is healthy (26k★, 0.23.8 released 2026-10-15, 78 commits in 2026);
  the MJML plugin is active (last commit 2026-10-27).
- Cost: we build the merge-tag picker (a custom RTE action fed by the
  existing placeholder list) and a small block set (header, text, image,
  button, divider, columns, footer slot). `grapesjs-preset-newsletter` is
  stale (last release 2023) — don't build on it.

**C3 starts with a spike** (½–1 day, no merge): GrapesJS+MJML in a
throwaway page; verify (1) `{{…}}` survives MJML compile in text AND in
`href`/`src`, (2) the HTML renders acceptably in Gmail web/app, Outlook
desktop + outlook.com, Apple Mail (send real tests), (3) a non-developer can
build a newsletter in < 30 min, (4) a malicious stored `design_json` (a
component carrying an `onerror` attribute / a script property) does not
execute when loaded (§6.3), (5) a locked footer block can't be deleted.
Fail → fallback below.

**Fallback: Unlayer, Launch tier ($250/mo)** — best editor UX, any merge-tag
syntax, HTML export in the browser and unmetered; but the editor runs in a
vendor iframe, Free lacks uploads/custom storage/white-label (so Free is not
usable), and it's a fixed monthly cost for a monthly newsletter.

Not recommended: Beefree / Topol / Chamaileon (vendor renders the HTML;
per-user pricing — a YC3 cost line), Stripo (stores emails on its servers),
React-only options (Easy Email, EmailBuilder.js, Maily — need a build step;
EmailBuilder.js has no upload hook), Mosaico (GPL, needs a backend, low
activity). **Watch:** Templatical (ESM CDN, merge tags + media hooks built
in, SaaS embedding allowed under FSL-1.1-MIT) — attractive API, but created
2026-03, pre-1.0, single maintainer.

Full table: `ref/archive/YISRAMAIL_SURVEY_2026-10-29.md`.

## 8. YC3 fit

- **DB-per-tenant:** every table here is tenant-local (consent, tokens,
  designs, segments, campaign results). The unsubscribe routes resolve the
  tenant from the host like every other public route will (Tenancy plan);
  the token alone never crosses tenants.
- **Config-as-data:** topics, segments, designs, the cap, the rate, footer
  wording — rows/settings, not code (`lib/settingsRegistry.js` entries for
  every new key, one editor home each).
- **Drivers:** transport and events are per-credential drivers (§5.1). A
  provisioning driver (create domain, return DNS records, poll verification)
  is the YC3 onboarding piece; v2 does DNS by hand.
- **Managed services, offered not required (Fred, 2026-10-29).** YC3 may
  offer tenants hosted mailboxes (Migadu) and hosted bulk sending (SES);
  any tenant can bring its own provider instead (the driver model, §5.1).
  What that commits YC to:
  - **Mailboxes: one Migadu account PER TENANT**, never tenant domains inside
    one shared account. Migadu's terms make the account holder solely
    responsible for all mail, quotas are account-wide (one tenant's volume
    would cap everyone), and a blocked account's domains go on Migadu's
    permanent blacklist — so one tenant's abuse would take every tenant's
    domains down. Whether Migadu permits an operator to hold accounts for
    its customers (agency/reseller terms) is UNVERIFIED — confirm with
    Migadu before offering it. Provisioning via the Migadu API is the
    mailbox arc's YC3 driver.
  - **Bulk: one YC-operated AWS account using SES Tenants** — per-tenant
    reputation and automatic pause, a per-tenant configuration set and
    verified sending domain created through the provisioning driver, usage
    metered per tenant tag for billing. YC carries the AUP relationship, so
    each tenant gets its own `marketing_send_enabled` kill switch (it lives
    in the tenant DB) and onboarding includes a consent/compliance
    attestation; a tenant's SES pause stops only that tenant.
  - **Separation holds at every scale:** the mailbox host never carries bulk,
    and the bulk identity never carries correspondence (§5.6).
- **Builder licensing:** a commercial SDK priced per end user or per tenant
  becomes a per-tenant cost line in YC3 (see the survey); an open-source builder
  has no such line.
- **Consent is portable:** the ledger exports per destination (a tenant's
  proof belongs to the tenant); nothing consent-related lives only at the
  provider.

## 9. Slices and order

Each slice independently deployable; SQL → backend → frontend per slice; an
ALTER on a live table ships as the node-script pattern with a low
`lock_wait_timeout` (CLAUDE.md "A migration that needs a session").

**Gate G1 (Fred, 2026-10-29: unsubscribe for both channels before
anything).** No marketing send until P1, P2 and P3 are live, plus T1, T2
(incl. the DLQ), C1, C2 (incl. the complaint hold), verified DNS (§5.3) and
SES production access. Enforced in code, not just
procedure: `marketing_send_enabled` ships `'0'` (C1) and an SU flips it only
after this checklist. **Gate G2:** no import/send to an outside list until D5
is ruled for that list (ruled 2026-10-30 for SS's own lead lists).

| # | Slice | Contents | Depends |
|---|---|---|---|
| P0 | Decisions + accounts (no code) | open decisions ruled; SES account + production-access request (marketing use); sending subdomain DNS (DKIM, custom MAIL FROM, DMARC p=none); Google Postmaster Tools for the domain; SS legal review of the footer (§528 wording, responsible attorney, ad label) and of D5; brand/from/reply-to chosen (D8) | — |
| P1 | Consent core | `comm_topics` / `comm_consent_events` / `comm_consent_state`; `optoutService` scopes + `recordConsent(conn, …)` (guarded upsert); hit shape kept; EVERY writer and bypassing reader of the row flags moved (§4.4 list); dual-read/dual-write transition; migration run before AND after the backend deploy; yc-sync MATCHERS for consent writes; `optoutFake` + test worlds; real-MySQL twin tests for the scope predicates and the race guard | — |
| P2 | Inbound SMS opt-out — **built** (§4.6 "As built"; the reconcile ships dark) | **step 0:** RC consent-API permission/role/rate-group check + live STOP/START test on one RC and one Quo line + one captured consent-list response; keyword handler in the ingest of INCOMING texts, after the dedup precheck; RC 413 failures + read-only nightly consent reconcile (`sms_consent_sync`, behind `sms_rc_consent_sync_enabled`) → ledger; (the Quo confirmation job was built, then removed 2026-10-30 — Quo confirms REVOKE / OPT OUT itself); client-stranded staff task; free-text review task; `scripts/yisramailP2CheckInbound.js` (the wf17/wf18 `phone_log` wiring check, a deploy step) + per-provider inbound liveness alert | P1 |
| P3 | Email unsubscribe surface — **built** (§4.5 "As built") | `comm_unsub_tokens` (+ `send_ref`) via `scripts/yisramailP3Migrate.js`; `services/unsubService.js` (mint for C2, lookup, one-click, page form); `/u/:token` GET page + one-click POST + prefs POST on the landing origin (all three `pageLanding` enumerations, test-locked; no-store / noindex / no-referrer; no per-IP limit on the one-click POST); `{{send.*}}` / `{{firm.*}}` resolver pseudo-tables; `lib/complianceFooter.js` (the footer block C2 injects); settings `consent_task_user_id`, `marketing_ad_label`, `marketing_debt_relief_statement` | P1 |
| P4 | Staff consent UI — **built** (§4.7 "As built") | badges + history on contact rows; compose counts; SU suppression import/export | P1 |
| T1 | Transport contract — **built** (§5.2 As built) | adapter capabilities (`bulk`, `headers`, `tags`, `events`, `batch`); `headers` / `replyTo` / `tags` options through `sendEmailDirect` + `smtp.js` (marketing path only; public `sendEmail` strips them); driver-owned headers (SES `X-SES-*`); SES message id from the SMTP reply; `email_credentials.bulk_ok` + `events_driver`; bulk rows fenced out of `emailFrom`, public `sendEmail` and operational campaigns; DKIM `h=` acceptance test | — |
| T2 | Events — **built** (§5.4 As built; Reject / DeliveryDelay / Rendering Failure still documented-shape) | SES → EventBridge API destination (+ SQS DLQ and a tested replay procedure) → YisraHook hook (`api_key` auth, `dedup_path` on the event id) → `mail_event_ingest` internal function (added to `CTA_FN_DENYLIST` — engine plumbing) → ledger (bounce/complaint/unsub) + `campaign_results` delivery columns by `result_id` tag + the per-transport complaint/bounce tally (§6.5); SES suppression-list removal on re-opt-in | T1, P1 |
| C1 | Campaign hardening — **built** (§6.1, §6.4 "As built (C1)") | `campaigns.class` / `topic_key`; 50 cap in `createCampaign` + D16 over-cap path; `campaigns.bulk` capability; `bulk_ok` refused for operational; **`marketing_send_enabled` kill switch (`'0'`): marketing refused 422 at create and skipped at send**; **send reservation / at-most-once for every campaign** (`sending` / `unknown` statuses); per-transport rate window at dispatch; per-campaign pump with bounded catch-up; cron per-tick `campaign_send` quota; `paused` status with defer semantics (§6.4 table); operational-class honesty prompt | P1, T1 |
| C2 | Marketing send path — **built, dark** (§6.4 / §6.5 "As built (C2)"; account-pause shapes `VERIFY(live)`) | executeSend marketing branch: scope check, token mint, explicit text part, footer inject/lock + post-render assert, headers/tags, transport, send-start snapshot (MRPC 7.2(b)), `email_log` without body; **complaint/bounce transport hold enforced before every send** (§6.5); account-pause detection; test send (HTML escaping + the sandboxed preview already shipped — §6.3) | P1, **P2**, P3, C1, T2 |
| C3 | Designs + builder — **built** (§6.3 "As built (C3a — server)", "As built (C3b)" Designer) | spike first (§7, incl. a malicious `design_json`); then `email_designs` with server-side validation on save; Designer editor mode (GrapesJS + MJML); merge-tag picker; locked footer block; asset upload via AssetPicker/`apiSend` | C2 (can build in parallel, lands after) |
| C4 | Segments + reporting — **built** (§6.2 / §6.5 "As built (C4)") | saved segments (`campaign_segments` + the Select-tab picker); campaign stats incl. `unknown` + delivered / bounced / complained / unsubscribed + transport rates in the Stats dialog; the daily marketing-mail digest (`mail_bounce_digest` recurring job) | C2 |
| C5 | Outside-list import | provenance-recording import; hygiene check; first-send warm-up order | G2, C2 |
| C6 | Open/click tracking — **built** (§6.5 "As built (C6)") | SES config-set open + click events on a **custom tracking domain** under the sending subdomain (`r.news.4lsg.com`, us-east-2); `campaign_results.opened_at` / `clicked_at` + `campaign_clicks` per-link counts; campaign stats lead with clicks, opens shown as approximate (Apple Mail Privacy Protection pre-fetches images); footer unsub/preference links `ses:no-track`; the preference page names the tracking; the design_id picker (`widget: 'email_design'`). The per-campaign toggle moved to ref/plans.md (not built) | C2, C4 |
| C7 | Promotional automations — **built** (§6.4 "As built (C7)") | `send_email` / `send_sms` gain `promotional` (default false) + `topic`: a promotional automation send takes the marketing path (consent by topic, token, footer, headers, transport rules) and SKIPS opted-out recipients; `design_id` + `contact_id` send a saved Designer template from any automation (both classes); SMS `promotional` refused while D1 stands; the step editors render the new params from __meta | C2, C3 |
| — | Deferred | marketing SMS (D1), drips via sequences, provider domain provisioning (YC3) | — |

Per-slice obligations (CLAUDE.md): settings-registry entries for every new
key (`campaign_operational_cap`, `campaign_marketing_rate`,
`marketing_send_enabled`, footer text keys), one editor home each; schema
COMMENTs on every new column; this file's "As built" blocks; AI_CONTEXT §17
(campaigns) + the opt-out entry; manual `11-campaign-manager.md` + a new
consent chapter, with the section README TOC; `ref/plans.md` for anything
deferred.

Estimated size (rough, for planning): P1 L (the writer/reader inventory makes
it bigger than it looked), P2 M, P3 M, P4 S, T1 M, T2 M, C1 L, C2 M, C3 L,
C4 S, C5 S, C6 M, C7 S.

## 10. Decisions for Fred (and SS where marked)

| # | Decision | Status / recommendation | Why / trade-off |
|---|---|---|---|
| D0 | Build (YisraMail) or buy (Brevo/MailerLite + sync)? | **RULED: build.** Buy only as a bridge if SS needs a send before C2. | §5.5 last paragraph. Build is a YC3 feature and the consent work is needed for SMS anyway; buy ships in days but splits consent across two systems. |
| D1 | Marketing SMS in v1? | **RULED: no.** Email newsletter only. | Needs a dedicated RC number on a MARKETING/MIXED 10DLC campaign, written-consent capture, DNC scrub, quiet hours (Appendix C). Never Quo: one STOP there blocks every Quo line. |
| D2 | Consent storage | **RULED: (a)** destination-keyed state table + ledger is THE truth; row flags a cache for one release, then drop (§4.4). | Survives row end/transfer/import; one store; opt-in-with-proof expressible. |
| D3 | Scope of an SMS STOP on a case line | Rec: **`all` SMS** + a staff task to reach the client another way. | Quo already blocks the whole Quo account and RC the pair. |
| D4 | One-click scope | Rec: **the send's topic**; the page offers "all marketing". | RFC 8058 intent (this list); one topic today. |
| D5 | Outside lists (legacy 1,494, `temp_contacts` 2,022) **(SS)** | **RULED in part (Fred, 2026-10-30):** SS's lead lists — Clio Grow, Active Campaign and Phil Tirone (the firm's ad lead form) — are people who contacted the firm; they are imported as contacts by `scripts/leadListImport.js` (provenance: source tags + `[lead:<cluster>]` notes markers; known Active Campaign bounces recorded as `provider_bounce` opt-outs). Still open (Fred + SS): the Criminal Law (MailChimp) list and `temp_contacts`; whether the 1,494-row legacy list is one of the imported lists is unverified. Every list: send to it last, after hygiene. | Cold lists drive bounces/complaints; MRPC solicitation rules may apply (Appendix C §D). |
| D6 | Provider | **RULED: Amazon SES** (SMTP send + EventBridge events); runner-up Resend Pro $20. | §5.5. Pay per use, ≈ $1/mo, own headers, tenants for YC3. |
| D7 | Driver vs lock-in | Rec: **driver**, one default provider. | §5.1. |
| D8 | Brand, From, subdomain, Reply-To **(SS)** | **OPEN** — not blocking P1–P4/T1; needed before P0's DNS. Default: `Legal Solutions Group <news@news.4lsg.com>`, Reply-To `office@4lsg.com`. | Matches `firm_name`; unsubscribe links (`4lsg.com/u/…`) on the sender's own domain. An MDBL sender would want MDBL as a landing host too. |
| D9 | Builder | **RULED: GrapesJS + grapesjs-mjml**, spike first; fallback Unlayer Launch $250/mo. | §7. |
| D10 | Campaigns | Rec: **enhance** with send classes (§6.1). | The engine is sound; the gaps are consent, transport, content, rate. |
| D11 | Open/click tracking | **RULED: off in v1, built in v2 as C6.** | v1 ships delivered/bounce/complaint/unsubscribe. |
| D12 | Default marketing send rate | Rec: **60/min** (2k ≈ 33 min), firm setting. | Gentle on a new domain; the pump keeps the queue clear. |
| D13 | Who may send marketing / over-cap | Rec: new capability **`campaigns.bulk`** (admin role) covering the marketing class AND over-cap operational sends. | Today any staff login can send as any firm address. |
| D14 | Designate an exclusive SMS revocation method (FCC 26-67, from 2026-11-25)? | Rec: **no, not in v1.** | Requires the disclosure in every text, case texts included; the review queue covers plain-language opt-outs. |
| D15 | Push YC-captured SMS opt-outs to RingCentral? | **RULED: no push in v1**; read-only reconcile. | A `from:"*"` push blocks every RC line, so staff-acknowledged replies (2026-10-27 override) would fail with 413, and a later START lifts only one pair. YC already refuses automation; the push only protects texts staff send from the RC app directly. Revisit once the consent API answers (P2 step 0: 403 CMN-408). |
| D16 | Operational sends over the 50 cap (e.g. office-closure notice to all active clients, email or SMS)? | **RULED:** allowed with `campaigns.bulk` + a typed confirmation of the count, audited; still operational (no footer), still consent-checked. | Informational notices to clients are legitimate; the cap exists to stop accidental blasts, not these. |
| D17 | Who gets the "case email is bouncing" task? | **RULED:** clients only, to the firm's consent follow-up assignee (`consent_task_user_id` — `cases` has no assigned-staff column); non-client bounces → campaign stats only. | One task per bounce would flood on a cold import. |
| D18 | Do opt-outs stop automations? | **RULED (Fred, 2026-10-29): no — opt-outs gate promotion.** Automations are operational (a stand-in for a person); a later `promotional` checkbox (C7) makes an automation send obey marketing consent. Email opt-outs are marketing-only; no "send to opt-outs" switch on marketing campaigns — the operational class is the honest path. | CAN-SPAM covers commercial mail only; the 10-27 "automation refuses" rule was broader than the law and blocked the reminders clients need. |
| D19 | Does an SMS STOP still stop automated (operational) texts? | **RULED (Fred, 2026-10-29): yes** — the one exception to D18. | A STOP revokes consent for texts (FCC "any reasonable means"; FCC 26-67 only lets informational revocations be scoped by category from 2026-11-25), and the providers block anyway — RC the pair, Quo every Quo line — so the send would fail. The client gets a staff task to be reached by phone/email (§4.6). |

## Appendix C — Compliance & provider opt-out facts (fetched 2026-10-29; engineering input, not legal advice)

**§A SMS — providers**
- **RingCentral:** opt-out words STOP, UNSUBSCRIBE, QUIT, CANCEL, END (+ REVOKE,
  OPT OUT per support article), case-insensitive; RC sends the confirmation.
  Consent is per (sender number, recipient) pair — "specific to a phone number,
  not an extension, site, or entire account"; marketing and conversational
  can't be separated on one number. A blocked send ends
  `messageStatus:"SendingFailed"`, `deliveryErrorCode` `SMS-RC-413` /
  `SMS-UP-413` (HV also `SMS-CAR-413`). Consent API v2:
  `GET /restapi/v2/accounts/~/sms/consents?from=&optStatus=OptOut|OptIn`
  (paged), CSV export, `PATCH …/sms/consents` `records:[{from,to,optStatus,
  source:"Api"}]` (`from:"*"` = every number in the account) — the app CAN
  opt someone back in. Consent-change events exist (filter string UNVERIFIED).
  RC's API spec as its generated SDK carries it (ringcentral-extensible
  1.8.6, read 2026-10-29) has no GET list: the read is `POST
  …/sms/consents/search` (body `optStatus`, `from[]`, `to[]`, `coverage[]`,
  `campaignType[]`, `pageToken`, `perPage` ≤ 1000; records `{from, to,
  optStatus, source, lastModifiedTime}`, no id; paging `nextPageToken`),
  plus `GET …/consents/export` (CSV) and `GET …/consents/history`; all App
  Permission SMS, rate group Light. The authenticated user needs the Account
  Administration permission, else `CMN-408` (RC community answer; seen
  live at P2 step 0, 2026-10-29, on both the POST and the GET form).
  Observed live (rc2 2486213656, 2026-10-29): STOP → "Thanks for opting out
  of our messaging services. You have been opted out."; a later "hi" → "Thanks
  for opting in for our messaging service." — any text re-opts the pair in,
  whatever the consent page says; START → the same opt-in reply.
  [SDK paths](https://github.com/ringcentral/ringcentral-extensible/tree/master/packages/core/src/paths/Restapi/V2/Accounts/Sms/Consents),
  [CMN-408](https://community.ringcentral.com/developer-platform-apis-integrations-5/sms-consent-cmn-408-error-11399),
  [consent mgmt](https://developers.ringcentral.com/guide/messaging/sms/messaging-consent-management),
  [SMS errors](https://developers.ringcentral.com/guide/messaging/sms/sms-errors),
  [HV opt-out](https://developers.ringcentral.com/guide/messaging/sms/high-volume/opt-out)
- **Quo:** single-word STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT only
  ("STOP PLEASE" doesn't trigger; REVOKE / OPT OUT not listed — but BOTH
  act, observed live 2026-10-30: block + auto-reply, and a send to the
  number is refused 400 `0201400` "User Opted Out"); opt-in START,
  UNSTOP; auto-confirmation. Scope: **all Quo numbers in the account**. No
  master opt-out list, no opt-out API or event; contacts must opt back in
  themselves. Observed live (2484179800, 2026-10-29): STOP → "You have
  successfully been unsubscribed. You will not receive any more messages from
  this number. Reply START to resubscribe."; a later "hi" → nothing (still
  blocked); START → "You have successfully been re-subscribed…". (The reply
  says "this number"; the support article says every Quo number — not tested
  across lines.) [Quo opt-out](https://support.quo.com/core-concepts/messaging/opt-out.md)
- **10DLC:** use cases include CUSTOMER_CARE, ACCOUNT_NOTIFICATION, MARKETING,
  MIXED. Sending marketing from a customer-care campaign is a carrier/TCR
  policy breach (suspension risk). Separate numbers per purpose are the norm
  (CTIA §5.1.2.2). Low-volume throughput (~1–2k/day to T-Mobile) fits.

**§B SMS — rules** ([47 CFR 64.1200](https://www.ecfr.gov/current/title-47/part-64/section-64.1200))
- Marketing texts: prior express **written** consent (e-sign OK; must name the
  number; consent not a condition of purchase). Informational: prior express
  consent. National DNC applies to solicitations absent an established
  business relationship (purchase ≤ 18 mo / inquiry ≤ 3 mo) or written
  invitation. Company DNC: record at request, honor ≤ 10 business days,
  keep 5 years. Federal quiet hours 8 am–9 pm recipient-local.
- Revocation (in force since 2025-04-11): any reasonable method; per-se words
  stop, quit, end, revoke, opt out, cancel, unsubscribe; honor ≤ 10 business
  days; one non-marketing confirmation (presumed OK within 5 min).
- **FCC 26-67** ([91 FR 67214](https://www.govinfo.gov/content/pkg/FR-2026-10-26/pdf/2026-21821.pdf),
  effective **2026-11-25**) replaces the delayed "revoke-all" rule: a sender
  may designate an exclusive revocation method disclosed in each text
  (e.g. "Reply STOP"); a STOP to an informational text may be scoped to that
  informational category; a STOP to a marketing text revokes all marketing
  from the sender. FNPRM pending (shorter deadline, revoke-all method).
- CTIA: promotional = express written consent; one final opt-out
  confirmation; honor plain-language opt-outs; keep consent records
  (timestamp, medium, language shown, campaign, IP, number, identity).

**§C Email**
- CAN-SPAM ([15 USC 7704](https://www.law.cornell.edu/uscode/text/15/7704),
  [16 CFR 316](https://www.ecfr.gov/current/title-16/part-316)): accurate
  headers/subject; identify as an ad unless prior affirmative consent; clear
  opt-out; valid postal address; opt-out works ≥ 30 days after send; honor
  ≤ 10 business days; a preference menu must include "stop all commercial
  email"; no fee/login/extra info — at most a reply or one web page.
  Transactional/relationship messages exempt (narrow categories); primary-
  purpose test for mixed messages — keep case email free of promotion.
- Gmail ([sender guidelines](https://support.google.com/a/answer/81126)): all
  senders SPF or DKIM, PTR, TLS, spam rate < 0.3 % (target < 0.1 %); bulk
  (~5k/day to personal Gmail, domain-wide, permanent status) adds
  SPF+DKIM+DMARC aligned and one-click unsubscribe + visible link, honored
  within 48 h. Yahoo: no published bulk threshold; same requirements, honor
  within 2 days. Microsoft (since 2025-05-05): > 5k/day to Outlook.com needs
  SPF+DKIM+DMARC aligned.
- RFC 8058: one HTTPS `List-Unsubscribe` URI (opaque token) +
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, both in DKIM `h=`;
  the POST carries no cookies/auth, must not redirect, and unsubscribes from
  the URI alone.

**§D Lawyer advertising — for SS** ([MRPC](https://www.courts.michigan.gov/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf))
- 7.1 no misleading claims (results/testimonials ordinarily out). 7.2(b)
  keep a copy of each communication 2 years after last use + when/where used.
  7.2(d) identify a responsible lawyer + contact. 7.3(a) solicitation ban
  where no family/prior professional relationship and pecuniary motive —
  "communication directed to a specific recipient" counts; truthful
  targeted letters excepted. 7.3(b) never solicit someone who said no.
  Open: does a consultation make a "prior professional relationship"; is a
  text "telephone" contact.
- **11 U.S.C. §528:** bankruptcy-services ads to the public, including
  "specific mailings, telephonic or electronic messages", must say the relief
  is under bankruptcy law and carry "We are a debt relief agency. We help
  people file for bankruptcy relief under the Bankruptcy Code." (or
  substantially similar). Applied to attorneys by *Milavetz* (2010).
