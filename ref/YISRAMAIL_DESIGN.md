# YisraMail — consent, bulk email & campaigns v2 (DESIGN)

Status: **DRAFT v0.1 — 2026-10-29, for review. Nothing built.** Decisions in
§10 are recommendations until Fred (and SS where marked) rules them.
Supersedes the "YisraMail direction" entry in `ref/plans.md` (which now
points here). Related: `ref/MAILBOX_SYSTEM_DESIGN.md` §4.2 (`bulk_ok`, hub
budget), `ref/EMAIL_PROVIDER_PLAN.md` (bulk rule, OQ6), `services/optoutService.js`
(ruling 2026-10-27), `manual/01-YisraCase-overview/11-campaign-manager.md`.
Appendices A–C are a dated market/legal survey (2026-10-29) — move them to
`ref/archive/` once D6/D9 are ruled; the body stays living.

## 0. Summary

1. **Consent first — Phase 1 is a hard gate.** No marketing send, email or
   SMS, until scoped destination-keyed consent with a ledger, a working
   unsubscribe (link + RFC 8058 one-click + preference page) and inbound SMS
   opt-out handling are live (§4).
2. **Marketing ≠ operational.** Today's flags mean "automation sends nothing
   on this channel". A newsletter unsubscribe must never stop a 341 reminder,
   so consent gets scopes (`all` / `marketing` / topic); the flags become
   scope `all` (§4.1, D2).
3. **SMS:** the providers enforce STOP themselves — RingCentral per (number,
   recipient) pair, **Quo across every Quo number**. Marketing SMS is out of
   v1 and, if ever done, runs on its own RingCentral number and 10DLC
   marketing campaign (§4.6, D1).
4. **Transport = a driver, not lock-in** (§5.1, D7) — the existing email/
   phone adapter pattern. Every candidate speaks SMTP, so the existing `smtp`
   adapter sends; per-provider code is the events parser. YC owns list,
   consent, templates and the campaign engine.
5. **Provider: Amazon SES** (≈ $1/mo at 10k, own unsubscribe headers allowed,
   tenants for YC3); runner-up Resend Pro $20/mo (§5.5, D6).
6. **Campaigns: enhance, don't replace** (§6, D10) — add a send class
   (operational mail merge ≤ 50 vs marketing broadcast), topics, rate control
   that doesn't starve the job queue, events and reporting.
7. **Builder: GrapesJS + grapesjs-mjml** (BSD, in-browser, no vendor, no
   per-tenant cost) after a short spike; fallback Unlayer Launch $250/mo (§7, D9).
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

## 3. Current state (verified 2026-10-29 against main `1e64d4e` + live DB)

| Area | As built | Gap for bulk/marketing |
|---|---|---|
| Consent | `contact_phones.sms_optout` / `contact_emails.email_optout` on the ACTIVE row; read ONLY via `services/optoutService.js`; automation refuses, staff sends warn (409 + acknowledge). Live: 1 SMS opt-out, 0 email. | One scope: "nothing on this channel". No topic/marketing scope, no ledger (who/when/how — the proof), lost when the row is ended or the address moves; addresses outside `contacts` (imports) can't be suppressed. |
| Inbound STOP | Not handled (`ref/plans.md` "Recipient opt-out" follow-ups). RC delivery codes `SMS-RC/UP/CAR-413` map to `delivery_reason='opted_out'` (`services/adapters/phone/ringcentral.js:367`); live `phone_event_log` has 0 `opted_out` rows and 0 exact STOP-keyword inbound bodies in 3,474 inbound texts since 2026-05-31. | Nothing sets consent from a keyword, a provider opt-out signal, or a free-text "stop texting me". |
| Unsubscribe | None. No link, no `List-Unsubscribe` header, no page; `emailService` exposes no custom-header option outside the hub's threading headers. | CAN-SPAM opt-out mechanism + footer; RFC 8058 one-click. |
| Campaigns | `campaignService` + `campaign.html`: filter audience → `campaign_contacts` frozen → one `campaign_send` scheduled_job per contact (bulk INSERT, **no doorbell**) → `executeSend` → `emailService.sendEmail(from=campaigns.sender)` / `phoneService`. Editors: Quill rich text / HTML code; placeholders via `resolverService` (contacts refs only). | No cap (ruled 50, unbuilt), no class, no bulk transport, no topics/lists, no designs library, no events (delivered/bounce/complaint), no rate control. |
| Throughput | `process-jobs` cron claims `ORDER BY scheduled_time LIMIT 10` per minute. Campaign jobs ride only that claim. | 2,000 recipients ≈ 3.3 h, and every cron-only job due after the campaign's `scheduled_time` queues behind it (doorbelled workflow/sequence jobs are unaffected — they claim by id). |
| Transports | `email_credentials`: 9 `gmail` (one Workspace account), 2 `smtp` (SiteGround). Adapter contract in `services/emailService.js` header; capabilities object exists. Hub budget per transport (1500 gmail / 300 smtp per 24 h, `mailboxSendService`). | No `bulk_ok`, no provider for bulk, no events webhook. |
| Usage | 97 email + 21 SMS campaigns ever; max 12 recipients; last email campaign 2026-06-15. | Today's campaigns are mail-merge, not marketing. |
| Audience | 1,109 contacts; 1,080 with an active email, 1,085 with an active phone. `temp_contacts` 2,022 rows (all with email+phone, provenance unknown). Legacy FB/lead list 1,494 (outside YC). | Ceiling ≈ 4.6k addresses before de-dup. Provenance of the two outside lists is unknown. |
| Public origin | Landing hosts `4lsg.com,www.4lsg.com`; sessionless; routes ENUMERATED in `routes/pageLanding.js` (`/t/`, `/d/`, `/c/`, `/m/`, `/v/`, `/p/`…). `/u/` is unused. | Unsubscribe page + one-click POST need two new enumerated routes. |
| Firm data | `app_settings.firm_name` "Legal Solutions Group", `firm_address` "18481 W. 10 Mile Rd., #100, Southfield, MI 48075". | Footer source exists. |

## 4. Consent & unsubscribe — Phase 1, the gate

### 4.1 Principles

- **Consent belongs to a destination** (a normalized address or 10-digit
  number), per channel — not to a contact and not to a contact row. A person
  who says stop at an address stays stopped when staff end the row, move the
  address to another contact, or the address arrives in an import.
- **Scopes.** `all` = nothing on this channel (today's flag, unchanged
  meaning: automation refuses, staff warned). `marketing` = every marketing
  topic. `<topic>` = one topic (e.g. `newsletter`). Operational sends check
  `all` only; marketing sends check `all` + `marketing` + their topic.
- **Every change is an event.** An append-only ledger (who/what/when/how,
  with evidence) is the proof; a current-state table is what sends read. One
  writer keeps them in step in one transaction.
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
  id            bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel       enum('email','sms') NOT NULL,
  destination   varchar(254) NOT NULL,          -- lowercased address | 10 digits
  scope         varchar(40)  NOT NULL,          -- 'all' | 'marketing' | topic_key
  action        enum('opt_out','opt_in') NOT NULL,
  source        varchar(32)  NOT NULL,          -- staff | unsub_page | one_click | pref_page | sms_keyword |
                                                -- sms_review | provider_optout | provider_bounce |
                                                -- provider_complaint | import | web_form | migration
  contact_id    int unsigned NULL,              -- best-effort attribution at the time
  line_number   char(10) NULL,                  -- SMS: the firm line it arrived on / was sent from
  send_ref      varchar(64)  NULL,              -- campaign_results id / provider message id
  evidence      json NULL,                      -- ip, user_agent, keyword text, provider event id,
                                                -- consent wording shown, form id …
  actor_user_id int NULL,                       -- staff edits
  created_at    datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_dest (channel, destination, created_at)
);

-- what sends read. One row per (channel, destination, scope) ever touched.
CREATE TABLE comm_consent_state (
  channel       enum('email','sms') NOT NULL,
  destination   varchar(254) NOT NULL,
  scope         varchar(40)  NOT NULL,
  state         enum('opted_out','opted_in') NOT NULL,
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
  created_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at      datetime NULL                   -- first use; the link keeps working after
);
```

Bounces are deliverability, not consent, but they suppress the same way: a
hard bounce writes `opt_out` scope `marketing`, source `provider_bounce` (and
opens a staff task "email for <contact> bounced — fix the address": the
operational mail to that address is bouncing too).

### 4.3 Read/write API — `optoutService` stays the ONE reader

Callers don't change for operational sends:

```
findOptedOut(db, channel, dest, { klass = 'operational', topic } = {})
  operational → blocked by scope 'all'                  (today's behaviour)
  marketing   → blocked by 'all' | 'marketing' | topic, and, for an opt_in
                topic, also blocked unless state(topic) = 'opted_in'
assertNotOptedOut / optoutGate / *OptedOutSql — same, new optional opts
recordConsent(db, { channel, destination, scope, action, source,
                    contactId, lineNumber, sendRef, evidence, actorUserId })
  → INSERT event + UPSERT state in ONE withTransaction (pure DB, retries:1)
```

`*OptedOutSql(col, opts)` grows the same scope logic so the campaign preview
filters in SQL.

### 4.4 Migration of today's flags — DECISION D2

Recommended (a): the state table becomes THE truth for every scope. Migrate
the live flags (1 SMS today) as `source='migration'` events, have the contact
form's toggle call `recordConsent`, keep `sms_optout`/`email_optout` as a
read-through cache for one release (written by `recordConsent`), then drop
them with the column-drop sweep (CLAUDE.md). Callers are untouched — they
already read through `optoutService`.
(b): keep the row flags as the truth for `all`; the new tables hold only
marketing scopes. Smaller, but two stores, and an `all` opt-out still dies
with its row.
This revises the STORAGE half of the 2026-10-27 ruling (row → destination);
its read rule (one service, automation refuses, staff warn) stands.

### 4.5 Email unsubscribe

- **Every marketing send** mints one `comm_unsub_tokens` row and gets:
  - body: a **fixed compliance footer** the design cannot remove — unsubscribe
    link + "manage preferences" (whose menu includes "stop all marketing
    email", required of a CAN-SPAM preference menu), the firm's postal
    address, the responsible attorney + contact (MRPC 7.2(d)), the 11 U.S.C.
    §528 debt-relief-agency statement (bankruptcy ads, incl. electronic
    messages — attorney to confirm wording), and an "advertisement"
    identification unless the topic's consent is affirmative (CAN-SPAM
    (a)(5)). Values come from new resolver pseudo-tables in the
    `trigger_data` style (`{{send.unsubscribe_url}}`,
    `{{send.preferences_url}}`, `{{firm.postal_address}}`,
    `{{firm.compliance_footer}}` — in-memory, no SQL). If the design doesn't
    place `{{firm.compliance_footer}}`, the send appends it. After render,
    the send asserts the unsubscribe URL and address are in the HTML **and**
    the text part, else it records `failed` (fail closed).
  - headers: exactly one `List-Unsubscribe: <https://4lsg.com/u/<token>>`
    (HTTPS only in v1; a `mailto:` alternate needs an inbound handler — later)
    and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, plus `List-Id:
    <newsletter.<domain>>` and the provider campaign tag for events. Both
    List-Unsubscribe headers MUST be inside the DKIM signature's `h=` or
    receivers won't offer one-click (RFC 8058) — verified per provider in
    T1's acceptance test by reading a received message's DKIM-Signature.
- **Retention:** every marketing campaign's rendered body and recipient
  results are kept ≥ 2 years after last use (MRPC 7.2(b)). No campaign delete
  route exists today (`routes/campaign.js`); keep it that way, and a design
  edit never rewrites a sent campaign's stored body.
- **Routes (landing origin, sessionless, added to `pageLanding`'s
  enumerated list):**
  - `GET /u/:token` → a page with one "Unsubscribe" button, topic
    checkboxes and "all marketing email". GET itself changes nothing (link
    scanners prefetch GETs); one page + one click satisfies CAN-SPAM
    (Appendix C §C).
  - `POST /u/:token` with body `List-Unsubscribe=One-Click` (RFC 8058, mail
    clients) → `recordConsent(opt_out, scope=topic, source='one_click')`,
    `200` empty body, no auth, no redirect.
  - `POST /u/:token/prefs` (the page's form) → per-topic opt-out/opt-in,
    `source='pref_page'`.
  - Tokens never expire (CAN-SPAM: must work ≥30 days after send). Unknown
    token → the same neutral page with "contact us" (no oracle).
  - Rate-limited like the other public token routes.
- **The page offers marketing scopes only.** "Stop ALL email from the firm"
  (scope `all`) is not offered to the public: it would silently stop
  case-critical mail. A free-text box ("anything else?") opens a staff task
  instead.
- Replies saying "remove me" land in the reply-to mailbox (YC hub); staff
  unsubscribe via the contact page (source `staff`).

### 4.6 SMS opt-out

The providers enforce STOP themselves, at a granularity we can't change
(Appendix C §A): **RingCentral blocks the (sender number, recipient) pair;
Quo blocks the recipient on EVERY Quo number in the account** (9800, 4574,
5355 today) and offers no API to read the list or opt anyone back in. YC's
job is to know *before* sending ("may send") and keep the proof; the
provider decides "can send".

- **Keyword handler, built into `phoneIngestService`** (not an editable
  ingest rule — compliance must not be deletable): inbound SMS body,
  trimmed, case-folded, punctuation stripped, exact match against the union
  of the FCC per-se words and both providers' lists — opt-out: `STOP`,
  `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `REVOKE`, `OPT OUT`,
  `OPTOUT`; opt-in: `START`, `UNSTOP`, `SUBSCRIBE`, `RESUME`, `CONTINUE`.
  Quo does not act on `REVOKE` / `OPT OUT`, so for those YC is the only
  enforcement. Runs for every provider before Layer 2/3, idempotent on the
  provider event id (the existing dedup precheck).
- **No app-side confirmation text.** RC and Quo both send their own; a second
  one breaks the one-confirmation rule (CTIA, FCC (a)(12)). For `REVOKE` /
  `OPT OUT` on Quo (no provider confirmation) YC sends the single
  non-marketing confirmation within 5 minutes.
- **Scope — DECISION D3.** A STOP on any case line → scope `all` SMS (today's
  semantics). The provider block already makes this true for the whole Quo
  account and for that RC pair; matching it in YC keeps automation from
  burning sends into blocks. FCC 26-67's informational "category" scoping
  (from 2026-11-25) can't help: the provider block is absolute.
- **Provider sync.** RC: subscribe to the v2 consent events, reconcile
  nightly against `GET /restapi/v2/accounts/~/sms/consents?optStatus=OptOut`,
  and treat `SMS-RC/UP/CAR-413` delivery failures as opt-outs (already mapped
  to `delivery_reason='opted_out'`). Push opt-outs YC captured elsewhere
  (staff, free-text review, `REVOKE` on Quo) to RC with `PATCH …/sms/consents`
  (`from:"*"` — every RC number, matching scope `all`) so RC blocks too. RC opt-back-in only with documented consent
  (`opt_in`, `source='staff'`, evidence required). Quo: no list to sync — YC's
  ledger is the list; a client who STOPped Quo must text START themselves.
- **A STOP on a case line strands a client.** Every SMS `opt_out` with scope
  `all` on a client (contact with a Primary/Secondary case) opens a staff
  task: "client opted out of texts — reach them by phone/email". Free-text
  opt-outs are reachable by phone; the call is how re-consent is recorded.
- **Free-text revocation** ("please stop texting me", "remove me", "wrong
  number"): the FCC's "any reasonable means" standard applies until a sender
  designates an exclusive method (allowed from 2026-11-25), and CTIA expects
  plain-language opt-outs honored anyway. A phrase list (+ optional AI
  classifier on the existing pipeline) opens a staff review task due well
  inside 10 business days; staff confirm → `source='sms_review'`.
- **Marketing SMS — DECISION D1: deferred.** If SS wants it: a dedicated
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
- Compose surfaces: the existing 409 warn stays (operational); marketing
  class shows how many recipients each scope removes.
- SU tool: import a suppression list (CSV of addresses/numbers, scope,
  source `import`), and export the ledger for a destination (proof request).

## 5. Transport

### 5.1 Lock in a provider, or a driver? — driver (DECISION D7)

Driver, with one default provider. Why:

- It's already the shape: `email_credentials.provider` → `services/adapters/email/*`,
  `phone_lines.provider` → `services/adapters/phone/*`, and the YC3 direction
  says "driver pattern extends" (`ref/plans.md` YC 3.0).
- The marginal cost of a driver is small here because **every candidate
  speaks SMTP** (Appendix A): the existing `smtp` adapter sends through any
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
  provider isolates tenants (sub-accounts / tenants / servers — Appendix A).
  That isolation is a provider-choice criterion for YC3, not a reason to
  hard-wire one.

Not abstracted: provider marketing features (above). Not built now:
provisioning drivers (YC3), API send (SMTP covers v1 at this volume).

### 5.2 Adapter contract additions (T1)

```
capabilities: { html, attachments_inline, attachments_url,      // existing
                bulk, headers, tags, batch, events }            // new
sendEmail(db, { …existing…,
                headers,   // allowlist: List-Unsubscribe, List-Unsubscribe-Post,
                           //   List-Id, Feedback-ID — nothing else
                replyTo,   // the monitored mailbox for replies
                tags })    // { campaign_id, result_id } → provider metadata/headers
events: { verify(req, credential) → bool,
          parse(req) → [{ type: 'delivered'|'bounce_hard'|'bounce_soft'|
                          'complaint'|'unsubscribe'|'open'|'click',
                          provider_message_id, recipient, at, provider_event_id,
                          raw }] }
```

- `headers` / `replyTo` / `tags` reach adapters only from the campaign
  marketing path (`sendEmailDirect` with a `bulk_ok` row); the public
  `sendEmail` strips them like `HUB_ONLY_OPTIONS`, so no automation starts
  setting headers by accident.
- `email_credentials.bulk_ok tinyint(1) NOT NULL DEFAULT 0` + an
  `events_driver varchar(20) NULL` naming the parser (the send may be plain
  SMTP while events come from the provider's webhook).
- `smtp.js` sets `headers`/`replyTo` through nodemailer (supported natively);
  `gmail.js` never gets `bulk_ok` (Workspace is not a bulk transport).
- The bulk row is NOT a mailbox send identity, so the hub's per-transport
  budget never counts it and a newsletter can't lock the hub.

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
`recordConsent` (§4.2); all types → `campaign_results` delivery columns by
`provider_message_id`. Signature verification: `hooks.auth_type` already has
`hmac` and a Calendly-style scheme; a provider whose scheme differs gets its
verify in the adapter's `events.verify` (the "parsing into drivers" item in
`ref/plans.md`).

### 5.5 Provider (DECISION D6)

Hard requirements (Appendix A): marketing allowed by the AUP; **we set our
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

**Recommendation: Amazon SES** as the default driver.
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

## 6. Campaigns v2 — enhance, don't replace

The engine is sound: frozen audience, one idempotent job per recipient
(`campaign:{id}:{contactId}`), per-recipient results, cancel by name prefix,
transient-vs-permanent error classification. Replacing it would re-solve
those. What changes:

### 6.1 Send class — chosen explicitly at compose

| | `operational` (today's use: mail merge) | `marketing` (broadcast / newsletter) |
|---|---|---|
| Who/why | a note to a dozen clients, a hearing-change notice | newsletter, announcements, re-engagement |
| Consent check | scope `all` (today) | `all` + `marketing` + topic (§4.3) |
| Transport | any staff `email_credentials` row (Gmail/SMTP) | only a `bulk_ok` row (§5) |
| Cap | **50 recipients** (ruled 2026-10-22), firm-configurable, enforced in `campaignService.createCampaign` (API keys reach it) | none beyond provider/plan limits; rate-controlled |
| Unsubscribe | none | mandatory token, footer, headers (§4.5) |
| Topic | — | required (`comm_topics`) |
| SMS | allowed (≤ cap) | **refused** until D1 says otherwise |

Over-cap operational is refused with "use a marketing campaign". The class
is stored (`campaigns.class`, `campaigns.topic_key`). The marketing class
requires a new `campaigns.marketing` capability (D13, `lib/capabilities.js`
vocabulary, admin role); operational stays open to staff as today (every
campaign route is plain `jwtOrApiKey`).

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
- Address hygiene before the first send to an imported/cold slice: syntax +
  MX check in-app (free); optional paid list verification for cold slices
  (vendor not surveyed). Hard bounces suppress automatically afterwards (§4.2).

### 6.3 Designs library + builder

- New `email_designs` (id, name, builder, design_json, html, text, thumbnail
  asset, created_by, updated_at, archived) — reusable newsletter templates.
  A campaign stores the rendered HTML it sent (as today) plus `design_id`
  for "duplicate last month's".
- `campaign.html` editor mode gets a third option, **Designer**, beside Rich
  Text / HTML Code. The builder edits the design JSON; save exports HTML;
  the existing placeholder dropdown feeds the builder's merge-tag list
  (`{{contacts.contact_fname}}` etc. pass through untouched); images upload
  through `POST /api/assets` (the asset store) via the builder's upload hook.
- Sending never trusts the builder: the server renders placeholders (strict),
  injects/asserts the footer, and the preview renders in a sandboxed iframe
  (authored bytes never execute on the app origin — CLAUDE.md).
- Signature append (`include_signature`) is disabled for Designer content (a
  full HTML document can't take a `<br><br>` + signature after `</html>`).
- Builder pick: §7.

### 6.4 Send pipeline changes

- **Rate control without starving the queue:** at create, a marketing
  campaign staggers its jobs' `scheduled_time` at the campaign's rate
  (default from a firm setting, e.g. 60/min) and rings a Cloud Tasks doorbell
  per job at that time (`lib/taskQueue.enqueueJobDispatch(jobId, when)` —
  exists). Jobs then claim by id like workflow/sequence jobs; the cron claim
  only mops up missed doorbells, and other jobs never wait behind a 2k
  campaign. 2,000 at 60/min ≈ 33 min.
- Provider 429/5xx keep their transient classification (retry with backoff);
  a provider "account paused / sending disabled" response stops the
  campaign (new status `paused` — an enum expansion) and alerts — never
  burn the remaining jobs.
- Per-recipient event columns on `campaign_results`: `provider_message_id`
  (indexed), `delivery_state` (sent / delivered / bounced / complained),
  `delivery_at`, `bounce_type`, `opened_at`/`clicked_at` only if D11 turns
  tracking on. Fed by §5.4.
- Test send: "send a test to me" renders against a chosen contact and goes
  through the same transport (no token write, `[TEST]` subject prefix).

### 6.5 Reporting

Campaign view adds delivered / bounced / complained / unsubscribed (from the
ledger by `send_ref`) counts. Complaint rate > 0.1 % on a campaign → `warning`
alert; > 0.3 % (the Gmail ceiling, Appendix C) → `error` alert and further
marketing campaigns on that transport require SU release.

### 6.6 What stays out (later, `ref/plans.md`)

Drips/journeys = sequence enrollment from a campaign audience (the existing
YisraMail direction — no third flow engine); A/B subjects; send-time
optimization; dynamic content blocks.

## 7. Builder (DECISION D9)

Constraints that decide it: `campaign.html` is a no-build vanilla-JS iframe
pane (libs from a CDN `<script>`, e.g. Quill 2 from jsdelivr); merge tags are
ours (`{{contacts.contact_fname|cap}}`); images go to our asset store
(`POST /api/assets`); YC3 wants no per-tenant cost line; client content
should not round-trip a vendor.

**Recommendation: GrapesJS core + `grapesjs-mjml`** (BSD-3, free), version-
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
build a newsletter in < 30 min. Fail → fallback below.

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

Full table: Appendix B.

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
- **Platform vs BYO sending:** decide at YC3, not now. The criterion the
  provider pick (D6) must not foreclose: per-tenant isolation (sub-accounts /
  tenants / servers) and per-tenant domains via API.
- **Builder licensing:** a commercial SDK priced per end user or per tenant
  becomes a per-tenant cost line in YC3 (Appendix B); an open-source builder
  has no such line.
- **Consent is portable:** the ledger exports per destination (a tenant's
  proof belongs to the tenant); nothing consent-related lives only at the
  provider.

## 9. Slices and order

Each slice independently deployable; SQL → backend → frontend per slice.
**Gate G1 (Fred, 2026-10-29: unsubscribe for both channels before anything):
no marketing send until P1–P3 are live, plus T1, T2, verified DNS (§5.3) and
SES production access. Gate G2: no import/send to an outside list until D5
is ruled.**

| # | Slice | Contents | Depends |
|---|---|---|---|
| P0 | Decisions + accounts (no code) | D0–D14 ruled; SES account + production-access request (marketing use); sending subdomain DNS (DKIM, custom MAIL FROM, DMARC p=none); Google Postmaster Tools for the domain; SS legal review of the footer (§528 wording, responsible attorney, ad label) and of D1/D5; brand/from/reply-to chosen | — |
| P1 | Consent core | `comm_topics` / `comm_consent_events` / `comm_consent_state`; `optoutService` scopes + `recordConsent`; migration of live flags; contact-form toggle → `recordConsent`; real-MySQL twin tests for the scope predicates | — |
| P2 | Inbound SMS opt-out | keyword handler in `phoneIngestService` (both providers; REVOKE/OPT OUT confirmation on Quo only); RC 413 failures → ledger; RC consent API: nightly reconcile + push YC-captured opt-outs (`PATCH …/sms/consents`); client-stranded staff task; free-text review task | P1 |
| P3 | Email unsubscribe surface | `comm_unsub_tokens`; `/u/:token` GET page + one-click POST + prefs POST on the landing origin; `{{send.*}}` / `{{firm.postal_address}}` resolver pseudo-tables; footer inject + post-render assert | P1 |
| P4 | Staff consent UI | badges + history on contact rows; compose counts; SU suppression import/export | P1 |
| T1 | Transport contract | adapter capabilities (`bulk`, `headers`, `events`, `batch`); `headers` / `replyTo` / `tags` options (marketing-path only, stripped from the public `sendEmail` like `HUB_ONLY_OPTIONS`); `email_credentials.bulk_ok`; provider driver config row | — |
| T2 | Events | provider webhook via YisraHook (ack-first, dedup on provider event id) → `mail_event_ingest` internal function → ledger (bounce/complaint/unsub) + `campaign_results` delivery columns; signature verify per provider | T1, P1 |
| C1 | Campaign hardening | `campaigns.class` / `topic_key`; 50 cap (operational) in `createCampaign`; marketing requires `bulk_ok` + topic; capabilities; staggered schedule + doorbells; pause on provider block | P1, T1 |
| C2 | Marketing send path | executeSend marketing branch: scope check, token mint, headers, footer assert, transport; test send | P3, C1, T2 |
| C3 | Designs + builder | spike first (§7); then `email_designs`; Designer editor mode (GrapesJS + MJML); merge-tag picker; asset upload hook; sandboxed preview | C2 (can build in parallel, lands after) |
| C4 | Segments + reporting | saved segments; campaign stats; complaint-rate alerts | C2 |
| C5 | Outside-list import | provenance-recording import; hygiene check; first-send warm-up order | G2, C2 |
| — | Deferred | marketing SMS (D1), drips via sequences, open/click tracking (D11), provider domain provisioning (YC3) | — |

Docs per slice (living-docs rule): this file's "As built" blocks, AI_CONTEXT
§17 (campaigns) + the opt-out entry, manual 11-campaign-manager.md + a new
consent chapter, schema COMMENTs on every new column.

Estimated size (rough, for planning): P1 M, P2 M, P3 M, P4 S, T1 S, T2 M,
C1 M, C2 M, C3 L, C4 S, C5 S.

## 10. Decisions for Fred (and SS where marked)

| # | Decision | Recommendation | Why / trade-off |
|---|---|---|---|
| D0 | Build (YisraMail) or buy (Brevo/MailerLite + sync)? | **Build**; buy only as a bridge if SS needs a send before C2. | §5.5 last paragraph. Build is a YC3 feature and the consent work is needed for SMS anyway; buy ships in days but splits consent across two systems. |
| D1 | Marketing SMS in v1? **(SS)** | **No.** Email newsletter only; SMS campaigns stay operational ≤ cap. | Needs a dedicated RC number on a MARKETING/MIXED 10DLC campaign, written-consent capture, DNC scrub, quiet hours (Appendix C). Never Quo: one STOP there blocks every Quo line. Revisit as its own slice. |
| D2 | Consent storage | **(a)** destination-keyed state table is THE truth for every scope; row flags become a cache, then drop. | Survives row end/transfer/import; one store. Revises the storage half of 2026-10-27; callers unchanged. |
| D3 | Scope of an SMS STOP on a case line | **`all` SMS** (today's semantics) + a staff task to reach the client another way. | Quo already blocks the whole Quo account and RC the pair; YC matching that stops automation from sending into blocks. |
| D4 | One-click scope | **The send's topic**; the page offers "all marketing". | Matches RFC 8058 intent (this list); with one topic today they're the same. |
| D5 | Outside lists (legacy 1,494, `temp_contacts` 2,022) **(SS)** | Import only with a stated basis per list (who are they, how did they reach the firm); send to them last, after hygiene; or leave them out. | Cold lists drive bounces/complaints, the only real threat to a new sending domain; MRPC solicitation rules may apply (Appendix C §D). |
| D6 | Provider | **Amazon SES** (SMTP send + EventBridge events); runner-up Resend Pro $20. | §5.5. ≈ $1/mo, own headers, tenants for YC3; costs an AWS setup + production-access review. MailerSend rejected. |
| D7 | Driver vs lock-in | **Driver**, one default provider, SMTP send + provider events parser. | §5.1. |
| D8 | Brand, From, subdomain, Reply-To **(SS)** | e.g. `Legal Solutions Group <news@news.4lsg.com>`, Reply-To `office@4lsg.com`. | Which brand speaks (LSG vs MDBL) is SS's call; one subdomain per brand. |
| D9 | Builder | **GrapesJS + grapesjs-mjml** (BSD, self-hosted), after a ½–1 day spike; fallback Unlayer Launch $250/mo. | §7. Free, no vendor round-trip, no per-tenant cost; we build the merge-tag picker. |
| D10 | Campaigns | **Enhance** with send classes (§6.1); keep Rich Text / HTML modes for operational mail merge. | The engine is sound; the gaps are consent, transport, content, rate. |
| D11 | Open/click tracking | **Off in v1** (delivered/bounce/complaint/unsubscribe only). | Opens are unreliable (Apple MPP); click tracking rewrites links through a provider domain unless a custom tracking domain is set up. Add later if SS wants numbers. |
| D12 | Default marketing send rate | **60/min** (2k ≈ 33 min), firm setting. | Gentle on a new domain; doorbells keep the job queue clear. |
| D13 | Who may send marketing | New capability `campaigns.marketing` (admin role). | Today any staff login can send as any firm address. |
| D14 | Designate an exclusive SMS revocation method (FCC 26-67, from 2026-11-25)? | **No, not in v1.** Keep "any reasonable means" + the free-text review queue. | Designating requires the disclosure in every text, case texts included; the review queue already covers plain-language opt-outs. Revisit with marketing SMS. |

## Appendix A — Bulk transport survey (official pricing/docs pages, fetched 2026-10-29)

Prices move; re-check before signing up. "Own headers" = we may set our own
`List-Unsubscribe` + `List-Unsubscribe-Post` on marketing mail.

| Provider | Free (month / day) | Plan covering 5k/mo + a 2k day | @10k | @50k | Marketing OK | Own headers | Webhooks signed | Tenant isolation |
|---|---|---|---|---|---|---|---|---|
| **Amazon SES** | sandbox 200/day; $200 AWS credit 6 mo | $0.10/1k → ≈ $0.50 | $1 | $5 | yes, after production-access review | yes | yes (SNS SHA256) / EventBridge | **Tenants** (reputation + auto-pause, API) |
| Resend | 3k / 100 per day | Pro $20 (50k) | $20 | $20 | yes (opt-in) | yes (`/emails`) | yes (Svix) | none (domain-scoped keys) |
| Mailgun | 100/day | Basic $15 (10k) | $15 | $35 | yes (provable opt-in) | yes | yes (HMAC) | sub-accounts not self-serve |
| SendGrid | 60-day trial, 100/day | Essentials $19.95 (50k) | $19.95 | $19.95 | yes | yes | yes (ECDSA) | subusers Pro+ |
| Postmark | 100/mo | Basic $15 (10k) | $15 | $55–66 | Broadcast stream, vetted | needs support approval; Broadcast adds its own | **no** | Servers + Domains API |
| MailerSend | 500/mo | Hobby $7 (5k; 1,000 req/day incl. SMTP) | ≈ $14.50 / $35 | $35 | yes | only Professional $110 | yes (HMAC) | none found |
| Brevo (API) | 300/day | Starter $9 (5k) | $17 | $56 | yes | unverified one-click | unverified | unverified |
| Mailjet | 6k / 200 per day | Starter $9 (8k) | $19 | $40–59 | yes | yes | **no** | 1–20 sub-accounts |
| SMTP2GO | 1k / 200 per day | Starter $10 (10k) | $10 | $75 | 100 % opt-in | unverified | **no** | sub-accounts |
| Mailtrap | 4k / 150 per day | Basic $15 (10k) | $15 | $20 | Bulk Stream | Bulk Stream adds them | yes (HMAC) | unverified |
| Elastic Email | 3k/mo | Starter $19 (50k) | $19 | $19 | with consent | forced own unsubscribe link | unverified | Pro $49 |
| Bird (ex-SparkPost) | 1k / 50 per day | $15 deposit, $0.40/1k | $15 | ≈ $20 | yes | **rejected (422)** | yes | workspaces |
| ZeptoMail / Cloudflare Email / Mandrill | — | — | — | — | **transactional only** | — | — | — |

All-in-one marketing platforms (~2,500 contacts, monthly sends): Brevo
Marketing ≈ $25 (+$12 no logo); MailerLite Comfort $33 / Power $49;
EmailOctopus Pro $20, or Connect $17 sending through your own SES; Sender.net
free tier covers 2.5k/15k; Mailchimp/Kit/Constant Contact prices unverified.
All but Constant Contact report unsubscribes by webhook.

Sources: aws.amazon.com/ses/pricing, docs.aws.amazon.com/ses (production
access, suppression list, tenants, event destinations), resend.com/pricing +
/legal/acceptable-use, mailgun.com/pricing + /legal/aup, twilio.com SendGrid
pricing, postmarkapp.com/pricing + message-streams + webhooks, mailersend.com/pricing
+ help/smtp-relay, brevo.com/pricing.md, mailjet.com/pricing, smtp2go.com/terms,
mailtrap.io/pricing, elasticemail.com/email-api-pricing, bird.com/pricing/email,
zoho.com/zeptomail/pricing, developers.cloudflare.com/email-service,
mailchimp.com/pricing/transactional-email, mailerlite.com/pricing, emailoctopus.com/pricing.

## Appendix B — Email builder survey (fetched 2026-10-29; npm registry, GitHub, vendor pricing pages)

| Candidate | License | Price (free / paid) | CDN, no build | Self-hosted | Client-side HTML+JSON | Merge tags | Upload hook | Health 2026 |
|---|---|---|---|---|---|---|---|---|
| **GrapesJS + grapesjs-mjml** | BSD-3 | free | yes | yes | yes (mjml-browser) | no picker (build one) | `uploadFile` | core 0.23.8 (10-15), mjml plugin active |
| GrapesJS + preset-newsletter | BSD-3 | free | yes | yes | yes (juice inline) | no picker | `uploadFile` | preset stale (2023) |
| Unlayer | commercial | Free / Launch $250 / Scale $750 / Optimize $2,000 per mo | yes | no (vendor iframe) | yes, unmetered | any syntax | Launch+ | active |
| Beefree SDK | commercial | Free (10 users) / $400 / $1,200 / $3,000 per mo | yes + server token | no | no (vendor renders) | Core+ "smart" | paid | active |
| Stripo Plugin | commercial | Free (100 emails/mo) / $100 / $550 | yes + server token | no (emails stored at Stripo) | partial | yes | all plans (GCS) | active |
| Topol Plugin | commercial | trial / $70 / $140 / $300 per mo + per-MAU | yes | no | no (vendor backend) | yes | Expansion+ | active |
| Chamaileon SDK | commercial | Free (10 MAU) / from $200 | yes + server token | no | no (metered generator) | via variables | `onEditImage` | active |
| GrapesJS Studio SDK | proprietary | Free (1k sessions, branding) / $200 / $2,000 | yes (UMD) | mostly (licence key) | yes | plugins | `onUpload` | active |
| Templatical | FSL-1.1-MIT / MIT renderer | free | yes (ESM) | yes | JSON+MJML; HTML needs MJML compiler | yes | `onRequestMedia` | very active; created 2026-03, pre-1.0, solo |
| Easy Email | MIT (Pro commercial) | free / Pro $199–499 | no (React 18) | yes | yes (MJML) | `mergeTags` | `onUploadImage` | moderate |
| EmailBuilder.js | MIT | free | no (React app to fork) | yes | yes | no | none | slow |
| Maily | MIT | free | no (React/Tiptap; not drag-drop canvas) | yes | via renderer | variable nodes | `onImageUpload` | moderate |
| Mosaico | GPL-3.0 | free | built dist | needs backend | yes | — | backend | low |
| MJML / react-email | MIT | free | — | — | rendering layers, not builders | | | active |

Sources: unlayer.com/pricing, developers.beefree.io/pricing-plans,
stripo.email/plugin, topol.io/pricing, chamaileon.io/sdk, grapesjs.com/sdk/pricing,
github.com/GrapesJS/grapesjs, github.com/GrapesJS/mjml, github.com/templatical/sdk,
easyemail.pro, github.com/usewaypoint/email-builder-js, github.com/arikchakma/maily.to.

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
