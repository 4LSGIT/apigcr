# 10 — Email & Phone Ingest

## For operators

Every email the firm sends or receives, and every call and text that touches a
firm number, arrives here first. Ingest is the front door: it records the event,
decides whether it deserves a log entry on the contact, and — separately — fires
any automation you've configured for it.

Two pipelines, identical in shape:

| | Email | Phone |
|---|---|---|
| Fed by | external adapters (Gmail via Apps Script, SiteGround PHP) | RingCentral / Quo phone events |
| Forensic record | `email_log` | `phone_event_log` |
| Management UI | More → Automations → **Email Ingest** | More → Automations → **Phone Ingest** |

The thing to understand before you touch anything: **there are three layers, and
they are independent.**

1. **Forensic** — the raw event is written down. Always. No rule can stop this.
2. **Suppression** — decides whether a *structured log entry* appears on the
   contact or case. A newsletter doesn't need to clutter a client's history.
3. **Automation** — decides what *happens*. Start a workflow, enroll a sequence,
   call a function, hit a webhook.

Layer 3 runs **whether or not layer 2 suppressed the log**. Suppressing a
notification from a court's mailer does not stop the rule that files it. This
catches people out, so it's worth saying twice: **suppression hides, it does not
cancel.**

### Which layer do I want?

- *"This mail is noise on the client's timeline."* → a **suppression** rule.
- *"When this mail arrives, do something."* → an **automation** rule.
- *"I want both."* → both. They're separate lists and don't interact.

### Reading the executions table

Every event writes exactly one execution row, whatever happened to it. The
status tells you which path it took:

| Status | Means | Email | Phone |
|---|---|---|---|
| `logged` | Wrote a structured log entry | ✓ | ✓ |
| `duplicate` | The provider sent it again; already terminal, so nothing re-ran | ✓ | ✓ |
| `skipped_suppression` / `suppressed` | A suppression rule matched; no log entry | ✓ | ✓ |
| `skipped_firm_to_firm` | Every address was on a firm domain | ✓ | — |
| `auth_failed` | Bad or missing source key | ✓ | — |
| `validation_failed` | Envelope didn't parse | ✓ | — |
| `error` | Something threw — usually a bad link id | ✓ | ✓ |

`duplicate` being the **largest** bucket on email is normal and healthy: the
Gmail adapter re-presents messages it has already handed over, and the dedup
precheck stops them before any rule fires.

Phone has no `skipped_firm_to_firm` status on purpose. Firm-to-firm is exposed
as a match field (`extra.firmToFirm`) instead, so you can choose to suppress it
with a normal rule and see the count — rather than have it silently vanish.

---

## Technical reference

### Files

```
routes/api.emailIngest.js              POST /api/email/ingest + the management API
routes/api.phoneIngest.js              Phone management API
services/emailIngestService.js         The email pipeline
services/phoneIngestService.js         The phone pipeline
services/*IngestRuleService.js         Layer 3 — match, transform, dispatch
services/*IngestSuppressionService.js  Layer 2 — the log-write decision
services/*IngestExecutionsService.js   The executions ledger (read side)
services/*IngestMetaService.js         Field catalog, operators, action schemas
services/*IngestSampleService.js       Sample events for the rule tester
services/emailIngestValidator.js       Envelope validation
lib/actionDispatchers.js               Shared with YisraHook — the four action types
public/automation/emailIngest.html     UI (iframed in automationManager.html)
public/automation/phoneIngest.html     UI
public/automation/matchBuilder.js      Shared condition-tree builder (also used by triggers)
```

### The email pipeline, in order

```
POST /api/email/ingest        X-Email-Ingest-Key: <per-source key>
  ├─ authenticate                        → 401 + auth_failed row
  ├─ validate envelope                   → 400 + validation_failed row
  ├─ resolve message_id                  headers.message_id → exim_message_id
  ├─ dedup precheck (source, message_id) → duplicate row, STOP
  ├─ INSERT IGNORE email_log             forensic, race-safe, always
  ├─ infer direction                     from-domain ∈ firm domains ? outgoing : incoming
  ├─ firm-to-firm check                  all addresses on a firm domain → skip the log
  ├─ LAYER 2  suppression eval           decides the log write only
  ├─ LAYER 3  automation eval            ALWAYS runs — see below
  └─ LAYER 1b conditional createLogEntry skipped iff suppressed
        └─ exactly one email_ingest_executions row, every path
```

**Layer 3 sits above the log write deliberately.** It was hoisted there so the
independence invariant holds even on the error branch: if `createLogEntry`
fails with `INVALID_LOG_LINK_ID`, the execution row goes to `error` but still
carries the layer-3 outcomes in `metadata`. An automation must not be lost
because a log link was wrong.

**Response policy — the adapter must only retry on non-200.** 401 for a bad
key, 400 for a bad envelope, 500 for an unhandled exception (retry is fine),
and **200 for everything else, including `status:'error'` in the body**. On a
200-with-error the `email_log` row *is* persisted; retrying would double-log.

### Authentication

Per-source API key in `X-Email-Ingest-Key`, one row per adapter in
`email_ingest_sources`, constant-time compared. Deliberately **not** behind the
app JWT — the adapters (a PHP forwarder piped from Exim, an Apps Script bound
to a Gmail account) can't carry one. Two sources are live: `gmail-firm` and
`siteground-php`.

Auth failures write an `auth_failed` execution row rather than dropping
silently, so a credential-guessing pattern shows up in the table.

### Rules — match, transform, act

Both pipelines share one rule shape (`email_ingest_rules` / `phone_ingest_rules`):

| Column | Meaning |
|---|---|
| `position` | Evaluation order, ascending. Unlike YisraHook routing, **every** matching rule fires — position is for readability, not first-match-wins |
| `match_mode` | `conditions` (the visual tree) or `code` (a JS predicate) |
| `match_config` | The condition tree — same JSON shape as `hooks.filter_config` and trigger rules, same `matchBuilder.js` UI |
| `transform_mode` | `passthrough`, `mapper` (field mapping) or `code` (JS) |
| `transform_config` | What the actions receive |
| `match_count`, `last_matched_at` | Bumped on every match — the cheapest health check you have |

Actions hang off `*_ingest_rule_actions` and use the **same four dispatchers as
YisraHook** (`lib/actionDispatchers.js`, extracted from `hookService` so the two
systems cannot drift): `workflow`, `sequence`, `hook`, `internal_function`,
`http`.

Email match fields include `from.email`, `from.name`, `to`, `subject`, `kind`,
`source`, `headers.message_id`, `headers.list_id`, `headers.in_reply_to`,
`auth.spf`, `auth.dkim`, `auth.dmarc`, and `body` (full text). `GET
/api/email-ingest/meta` serves the live catalog along with the operator list and
the per-action-type param schemas that drive the editor.

### What the rules actually do today

The live rule set is a good map of what this pipeline is for:

| Rule | Matches | Transform |
|---|---|---|
| Court: AI Extract | the catch-all court feed | passthrough → AI docket extraction |
| court emails | court senders | code |
| clio payment failed | Clio's dunning mail | code |
| Court: Ch7 / Ch13 Meeting, Voluntary Petition | specific court notices | mapper |
| Adobe Sign / Clio Grow / Jotform Sign: completion | third-party e-sign callbacks arriving as mail | code |
| Delivery Status Notification | bounces | passthrough |
| remindme@4lsg.com | mail to a reminder alias | mapper |

Phone rules are fewer and simpler — a forward-to-email rule and a Clio-code
extractor.

### Testing a rule before you arm it

Two endpoints, both non-destructive, both wired into the UI:

| Endpoint | Answers |
|---|---|
| `POST /api/{email,phone}-ingest/rules/test-match` | Would this rule have matched? |
| `POST /api/{email,phone}-ingest/rules/test-transform` | What would the actions receive? |

`GET /api/{email,phone}-ingest/sample-events` gives you real recent events to
test against, so you aren't hand-writing envelopes.

### Management API

Identical surface on both pipelines — substitute `email-ingest` or
`phone-ingest`:

| Endpoint | Method | Notes |
|---|---|---|
| `/api/email/ingest` | POST | **The receiver.** Source key, not JWT. Email only |
| `/api/{…}-ingest/rules` | GET POST | Layer 3 rules |
| `/api/{…}-ingest/rules/:id` | GET PUT DELETE | |
| `/api/{…}-ingest/rules/:id/duplicate` | POST | Clone — the usual way to build a variant |
| `/api/{…}-ingest/rules/:id/actions` | POST | Attach an action |
| `/api/{…}-ingest/rule-actions/:id` | PUT DELETE | Edit one action |
| `/api/{…}-ingest/suppressions` | GET POST | Layer 2 rules |
| `/api/{…}-ingest/suppressions/:id` | GET PUT DELETE | |
| `/api/{…}-ingest/executions` | GET | Paginated ledger, filterable by status |
| `/api/{…}-ingest/executions/:id` | GET | One event, with its layer-3 outcomes |
| `/api/{…}-ingest/meta` | GET | Match fields, operators, action schemas, status list |
| `/api/{…}-ingest/sample-events` | GET | Recent real events for the tester |
| `/api/{…}-ingest/rules/test-match` | POST | Dry-run match |
| `/api/{…}-ingest/rules/test-transform` | POST | Dry-run transform |

All management routes are `jwtOrApiKey` and audited; the receiver is not.

### Common pitfalls

1. **Suppression does not stop automation.** Said three times in this chapter
   because it is the single most common surprise. If you want an event to stop
   entirely, deactivate the automation rule — don't suppress it.
2. **Every matching rule fires.** Two rules that both match the same court
   notice will both run their actions. `position` orders them; it does not
   make them exclusive.
3. **A rule with `match_count` stuck at 0 has never matched.** Check it before
   debugging anything downstream — most "the automation didn't run" reports are
   a condition that never matched.
4. **`duplicate` means nothing re-ran.** A redelivery of an already-terminal
   event returns before layer 3, by design, so a provider replay cannot double
   fire your actions. If you *want* a replay to fire, the Apps Script test
   helper appends `-test-<ts>` to the message id specifically so dedup treats
   it as new.
5. **Firm-to-firm mail is skipped on email but only *matchable* on phone.**
   Don't expect a `skipped_firm_to_firm` row on the phone side.
6. **Body matching is full-text and can be expensive.** Prefer a header or
   sender condition first; `body` is there for when nothing else identifies
   the message.

---

## History — what this replaced

Two things folded into this pipeline:

- **The Email Router** (`/email-router`, `email_routes`, `email_router_config`,
  `email_router_executions`) — a routing layer that matched inbound mail and
  dispatched into YisraHook. Its tables have been dropped;
  `routes/api.email_router.js` and `services/emailRouter.js` are still in the
  tree but no longer have anything to read. Anything it used to do is a layer-3
  rule with a `hook` action.
- **The inline `phone_log` pipeline** — the phone-side layers 1 and 2 are a
  verbatim extraction of what used to live inside the `phone_log` internal
  function, with layer 3 added afterwards to mirror email.
