# YisraMail — consent, bulk email & campaigns v2 (DESIGN)

Status: **DRAFT v0.5 — 2026-10-29. P1 (consent core) built — §4.4 "As built";
P3 (email unsubscribe surface) built — §4.5 "As built"; nothing else built.**
Ruled 2026-10-29 (Fred):
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
later), A/B testing, open/click tracking (D11), YC3 provisioning.

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
for the case's assigned staff member, else the firm default (D17); bounces on
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
  cache by primary key. A direct caller (the migration, P2's keyword handler)
  holds nothing, so recordConsent locks the destination's ACTIVE row first
  (`SELECT … WHERE phone_active_uniq = ? FOR UPDATE` — the active-only unique
  key, so ended history rows are never locked, and a concurrent insert waits
  on the gap). A writer must never re-lock its own row through that index: a
  direct caller waiting on the row holds the index entry, and the second ask
  is a deadlock (proven on the engine — the reviewer's suggested `WHERE
  phone = ? AND end_date IS NULL FOR UPDATE` alone deadlocks the same way).
  Deadlocks are not retried (`withTransaction` retries connection blips
  only), so the order is load-bearing. The state is re-read after the upsert with a LOCKING read
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
    and stores the text part itself (`campaigns.body_text`), rendering links
    as visible URLs. After render the send asserts the unsubscribe URL is in
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

**As built (P3).** Nothing mints a token until C2 wires `executeSend`; the
surface is live and smoke-tested ahead of it (gate G1).
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
  `withTransaction(retries: 1)`.
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
  user; Config → Firm → Marketing email & consent; P2's stranded-client task
  reads it too). Unset → an IT warning once per UTC day
  (`consent_task_unassigned`), the event flagged `evidence.note_unassigned`; a
  note that changed nothing has no event, so it gets a warning of its own
  carrying the text.
- **The footer** `lib/complianceFooter.buildComplianceFooter({ unsubscribeUrl,
  preferencesUrl, topic })` → `{ html, text }`: ad label (opt_out topics
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
  `phone_log`, fed by their hooks — editable rows, and for Quo YC's ONLY
  opt-out signal. So: a test pins both workflows' `phone_log` step; a
  liveness alert per provider fires when no inbound SMS has been ingested
  for N business hours; the keyword handler also runs on the backfill path
  (`services/phoneDeliveryService.js`) — idempotent, so double sight is safe.
- **Keyword handler, built into `phoneIngestService`** after the dedup
  precheck (step 1b, keyed on `provider_message_id` — present on every live
  inbound row), before Layer 2/3. Body trimmed, case-folded, punctuation
  stripped, exact single-message match:
  - opt-out: `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`,
    `REVOKE`, `OPT OUT`, `OPTOUT` → `opt_out`. Quo does not act on `REVOKE` /
    `OPT OUT`, so for those YC is the only enforcement.
  - opt-in: `START`, `UNSTOP` (both providers); `SUBSCRIBE`, `RESUME`,
    `CONTINUE` only on RC lines. Recorded **only when the number is currently
    opted out** — otherwise "continue" is an ordinary reply.
  - Ledger idempotency: `source='sms_keyword'`, `provider_event_id` = the
    provider message id.
- **Confirmation texts.** RC and Quo send their own for the words they act
  on; YC never sends a second (CTIA, FCC (a)(12)). For `REVOKE` / `OPT OUT` on
  Quo, YC sends the one non-marketing confirmation within 5 minutes as an
  idempotent scheduled job keyed by the provider event id, through an
  explicit opt-out-gate exemption (like the portal PIN) — not a send inside
  the workflow step.
- **Scope — D3.** A STOP on any case line → scope `all` SMS (today's
  semantics). The provider block already makes this true for the whole Quo
  account and for that RC pair; matching it keeps automation from sending
  into blocks. FCC 26-67's informational "category" scoping (from
  2026-11-25) can't help: the provider block is absolute.
- **Provider sync (RC).** Subscribe to the v2 consent events and reconcile
  nightly against `GET /restapi/v2/accounts/~/sms/consents?optStatus=OptOut`
  (read-only, guarded by `occurred_at` so an old opt-out never overwrites a
  newer START); treat `SMS-RC/UP/CAR-413` delivery failures as opt-outs
  (already mapped to `delivery_reason='opted_out'`). **Pushing** YC-captured
  opt-outs to RC (`PATCH …/sms/consents`) is **D15 — recommended: not in v1.**
  A `from:"*"` push blocks every RC line, so a staff-acknowledged send ("a
  reply they requested", the 2026-10-27 override) then fails with SMS-RC-413,
  and a later START on one line lifts only that pair. YC already refuses
  automation; the push would only add protection for texts staff send from
  the RingCentral app directly. Whether the API can opt someone back IN is
  unverified (RC's consent page says the block lifts "only if the customer
  sends an opt-in keyword") — P2 step 0 settles it.
- **P2 step 0 (before code):** confirm the RC app permission / admin role
  and rate group for `/restapi/v2/accounts/~/sms/consents`; live STOP / START
  test on one RC and one Quo line (does the inbound STOP even reach the
  webhook? — 0 exact STOP keywords in 3,474 inbound texts since 2026-05-31).
- **A STOP on a case line strands a client.** Every SMS `opt_out` with scope
  `all` on a client (contact with a Primary/Secondary case) opens a staff
  task: "client opted out of texts — reach them by phone/email". The call is
  how re-consent is recorded.
- **Free-text revocation** ("please stop texting me", "remove me", "wrong
  number"): the FCC's "any reasonable means" standard applies until a sender
  designates an exclusive method (allowed from 2026-11-25; D14 says don't),
  and CTIA expects plain-language opt-outs honored anyway. A word-boundary
  phrase list (+ optional AI classifier on the existing pipeline), on
  10-digit senders only (live: 101 non-suppressed texts contain "stop" as a
  substring), opens a staff review task due well inside 10 business days;
  staff confirm → `source='sms_review'`.
- **Marketing SMS — D1 RULED: not in v1.** If ever: a dedicated
  **RingCentral** number on a MARKETING or MIXED 10DLC campaign (sending
  promotional content from a customer-care campaign risks suspension), never
  Quo (one marketing STOP there blocks every Quo line), opt-in topic with
  captured written consent (`web_form` events carrying the exact disclosure
  and form version), national-DNC scrub unless an established business
  relationship applies (attorney call), 8 am–9 pm recipient-local send
  window, brand + "Reply STOP to opt out" in every message.

### 4.7 Staff surfaces

- Contact page email/phone rows: badges per scope (`plans.md` open item),
  history popover from the ledger, toggles that call `recordConsent` with
  `source='staff'` and an optional note.
- Compose surfaces: the 409 warn stays for SMS (scope `all`); operational
  email no longer warns (D18). The marketing class shows how many recipients
  each scope removes.
- SU tool: import a suppression list (CSV of addresses/numbers, scope,
  source `import`), and export the ledger for a destination (proof request).

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
                tags })    // { campaign_id, result_id } → the driver's correlation headers
events: { verify(req, credential) → bool,
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
  `events_driver varchar(20) NULL` naming the parser (the send is plain SMTP;
  events come from the provider).
- **The bulk row is not a sender anywhere else.** `GET /api/firm-data` ships
  every `email_credentials` row to every compose surface, and the public
  `sendEmail` picks a row by `from` — unfenced, the SES row would appear in
  Comms, workflow and campaign pickers and operational mail could leave
  through the marketing subdomain without a footer. So: `bulk_ok` rows are
  filtered out of `emailFrom`; the public `sendEmail` and operational
  campaigns refuse a `bulk_ok` row; no mailbox `send_credential_id` and no
  other row may share its SMTP login (else the hub's `checkBudget` would
  count newsletters against the hub). `gmail.js` never gets `bulk_ok`.
- Operational campaigns through Gmail/SMTP already count against the hub
  budget (their sends land in `email_log` under that transport's source),
  which covers the old `ref/plans.md` "count campaigns against the budget"
  item; marketing volume never touches it.

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

### 6.5 Complaint safety (enforced from the first send) and reporting

- **Enforcement — T2 + C2, part of gate G1.** T2's event ingest keeps a
  rolling per-transport tally (complaints and hard bounces over delivered,
  last 24 h and per campaign). C2 checks it before every marketing send:
  complaint rate > 0.1 % → `warning` alert; > 0.3 % (the Gmail ceiling,
  Appendix C) or hard bounces > 5 % → the **transport is held**: every
  running marketing campaign on it is paused (§6.4), new ones refuse, an
  `error` alert fires, and only an SU release (audited) lifts it. Rates are
  computed only once a campaign has ≥ 200 deliveries, so one early
  complaint doesn't trip a hold — but any single complaint in the first
  200 still alerts (`warning`).
- **Reporting — C4.** Campaign view adds delivered / bounced / complained /
  unsubscribed / unknown counts (unsubscribes from the ledger by
  `send_ref`) and the transport's current rates.

### 6.6 What stays out (later, `ref/plans.md`)

Drips/journeys = sequence enrollment from a campaign audience (the existing
YisraMail direction — no third flow engine); A/B subjects; send-time
optimization; dynamic content blocks. Open/click tracking is not "out" — it is
slice C6, after v1 (D11).

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
| P2 | Inbound SMS opt-out | **step 0:** RC consent-API permission/role/rate-group check + live STOP/START test on one RC and one Quo line; keyword handler after the dedup precheck (also on the backfill path); RC 413 failures + read-only nightly consent reconcile → ledger; Quo REVOKE/OPT OUT confirmation job (gate exemption); client-stranded staff task; free-text review task; wf17/wf18 `phone_log` pin test + per-provider inbound liveness alert | P1 |
| P3 | Email unsubscribe surface — **built** (§4.5 "As built") | `comm_unsub_tokens` (+ `send_ref`) via `scripts/yisramailP3Migrate.js`; `services/unsubService.js` (mint for C2, lookup, one-click, page form); `/u/:token` GET page + one-click POST + prefs POST on the landing origin (all three `pageLanding` enumerations, test-locked; no-store / noindex / no-referrer; no per-IP limit on the one-click POST); `{{send.*}}` / `{{firm.*}}` resolver pseudo-tables; `lib/complianceFooter.js` (the footer block C2 injects); settings `consent_task_user_id`, `marketing_ad_label`, `marketing_debt_relief_statement` | P1 |
| P4 | Staff consent UI | badges + history on contact rows; compose counts; SU suppression import/export | P1 |
| T1 | Transport contract | adapter capabilities (`bulk`, `headers`, `tags`, `events`, `batch`); `headers` / `replyTo` / `tags` options through `sendEmailDirect` + `smtp.js` (marketing path only; public `sendEmail` strips them); driver-owned headers (SES `X-SES-*`); SES message id from the SMTP reply; `email_credentials.bulk_ok` + `events_driver`; bulk rows fenced out of `emailFrom`, public `sendEmail` and operational campaigns; DKIM `h=` acceptance test | — |
| T2 | Events | SES → EventBridge API destination (+ SQS DLQ and a tested replay procedure) → YisraHook hook (`api_key` auth, `dedup_path` on the event id) → `mail_event_ingest` internal function (added to `CTA_FN_DENYLIST` — engine plumbing) → ledger (bounce/complaint/unsub) + `campaign_results` delivery columns by `result_id` tag + the per-transport complaint/bounce tally (§6.5); SES suppression-list removal on re-opt-in | T1, P1 |
| C1 | Campaign hardening | `campaigns.class` / `topic_key`; 50 cap in `createCampaign` + D16 over-cap path; `campaigns.bulk` capability; `bulk_ok` refused for operational; **`marketing_send_enabled` kill switch (`'0'`): marketing refused 422 at create and skipped at send**; **send reservation / at-most-once for every campaign** (`sending` / `unknown` statuses); per-transport rate window at dispatch; per-campaign pump with bounded catch-up; cron per-tick `campaign_send` quota; `paused` status with defer semantics (§6.4 table); operational-class honesty prompt | P1, T1 |
| C2 | Marketing send path | executeSend marketing branch: scope check, token mint, explicit text part, footer inject/lock + post-render assert, headers/tags, transport, send-start snapshot (MRPC 7.2(b)), `email_log` without body; **complaint/bounce transport hold enforced before every send** (§6.5); account-pause detection; test send (HTML escaping + the sandboxed preview already shipped — §6.3) | P1, **P2**, P3, C1, T2 |
| C3 | Designs + builder | spike first (§7, incl. a malicious `design_json`); then `email_designs` with server-side validation on save; Designer editor mode (GrapesJS + MJML); merge-tag picker; locked footer block; asset upload via AssetPicker/`apiSend` | C2 (can build in parallel, lands after) |
| C4 | Segments + reporting | saved segments; campaign stats incl. `unknown`; transport-rate display; bounce digest | C2 |
| C5 | Outside-list import | provenance-recording import; hygiene check; first-send warm-up order | G2, C2 |
| C6 | Open/click tracking (v2, D11) | SES config-set open + click events on a **custom tracking domain** under the sending subdomain (not the provider's shared one); `campaign_results.opened_at` / `clicked_at` + per-link click counts; campaign stats; clicks are the primary metric, opens shown as approximate (Apple Mail Privacy Protection pre-fetches images); a per-campaign toggle; one line on the preference page that marketing mail is tracked | C2, C4 |
| C7 | Promotional automations | `send_email` / `send_sms` internal functions gain `promotional` (default false) + `topic`: a promotional automation send takes the marketing path (consent check by topic, token, footer, headers, transport rules) and skips opted-out recipients; SMS `promotional` refused while D1 stands. Workflow/sequence editors show the checkbox | C2 |
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
| D15 | Push YC-captured SMS opt-outs to RingCentral? | **RULED: no push in v1**; read-only reconcile. | A `from:"*"` push blocks every RC line, so staff-acknowledged replies (2026-10-27 override) would fail with 413, and a later START lifts only one pair. YC already refuses automation; the push only protects texts staff send from the RC app directly. Revisit after P2 step 0. |
| D16 | Operational sends over the 50 cap (e.g. office-closure notice to all active clients, email or SMS)? | **RULED:** allowed with `campaigns.bulk` + a typed confirmation of the count, audited; still operational (no footer), still consent-checked. | Informational notices to clients are legitimate; the cap exists to stop accidental blasts, not these. |
| D17 | Who gets the "case email is bouncing" task? | **RULED:** clients only, to the case's assigned staff member, else the firm default; non-client bounces → campaign stats only. | One task per bounce would flood on a cold import. |
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
  [consent mgmt](https://developers.ringcentral.com/guide/messaging/sms/messaging-consent-management),
  [SMS errors](https://developers.ringcentral.com/guide/messaging/sms/sms-errors),
  [HV opt-out](https://developers.ringcentral.com/guide/messaging/sms/high-volume/opt-out)
- **Quo:** single-word STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT only
  ("STOP PLEASE" doesn't trigger; REVOKE / OPT OUT not listed); opt-in START,
  UNSTOP; auto-confirmation. Scope: **all Quo numbers in the account**. No
  master opt-out list, no opt-out API or event; contacts must opt back in
  themselves. [Quo opt-out](https://support.quo.com/core-concepts/messaging/opt-out.md)
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
