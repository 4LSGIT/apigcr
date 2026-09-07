# 1 — Overview

## For operators

Getting something signed has four parts, and they happen in this order:

1. **A template** — the document, with markers saying where each person signs
   and which blanks get filled from the case.
2. **A send** — pick a case and recipients; we fill the blanks, stamp a footer,
   and hand it to the provider.
3. **Tracking** — the client views it, signs it, declines it, or lets it lapse.
   Every one of those lands on the request as a status.
4. **Filing** — the moment it's signed, the executed PDF and the completion
   certificate are filed to the case's Dropbox folder. Nobody has to remember.

**More → Signatures** is the dashboard: everything outstanding, everything
finished, and what happened to each.

The provider today is **Zoho Sign**, but only one directory in the codebase
knows that. If it ever changes, templates, placements, prefill, the status
model and the audit trail all survive.

### The statuses, and what they mean for you

| Status | Means |
|---|---|
| `draft` | Row exists, nothing sent, no money spent |
| `sent` | With the provider and on its way |
| `viewed` | Somebody opened it |
| `partially_signed` | One signer of several has signed |
| `signed` | **Done** — filed automatically |
| `declined` | A signer refused — terminal |
| `expired` | Nobody acted in time — terminal |
| `recalled` | Staff pulled it back — terminal |
| `bounced` | The email didn't reach them — recoverable, can be re-sent |
| `satisfied_external` | They signed on paper or in the office — terminal, and counts as **done** |

Two of those deserve a note.

**`bounced` is not terminal.** A bad email address is fixable; the request can
go back out without starting over.

**`satisfied_external` exists so the dashboard tells the truth.** When a client
signs in the office, the obligation really is discharged — it just didn't happen
through the provider. Marking it satisfied stamps a completion just like a real
signature, so it stops showing as outstanding. `declined` / `expired` /
`recalled` are terminal *failures* and deliberately do **not** stamp completion,
which is what keeps "still waiting" and "gave up" separable.

### Late events are normal

Providers deliver webhooks out of order. A `viewed` arriving after `signed` is
routine, not an error — the status model simply bounces it off the terminal
state. If you see something odd in the event trail, out-of-order delivery is the
first explanation, not a bug.

### The nightly safety net

A scheduled job (`esign_reconcile`, 11:00 UTC) re-checks every outstanding
request against the provider and applies anything a webhook missed — including
downloading and filing a signed document. **A dropped webhook costs you a day,
not a document.**

---

## Technical reference

### The layer map

The whole design is one rule: **only `services/esign/` knows a vendor exists.**

```
routes / sequences / jobs                    ← callers
       │
       ├──→ services/esignService.js          DATA  — rows, audit trail,
       │                                              status transitions
       └──→ services/esign/index.js           WIRE  — provider factory +
                   │                                  neutral contract
                   └──→ zohoSignProvider.js   vendor dialect
```

The two halves are **peers, not a stack**: `esignService` never calls a
provider, and the provider layer never writes a row.

| Module | Owns |
|---|---|
| `esignService.js` | Rows, the append-only audit trail, the transition table |
| `esign/index.js` | Provider factory, the neutral contract, credit accounting |
| `esign/zohoSignProvider.js` | Zoho dialect — the only vendor-aware file |
| `esign/placements.js` | The neutral placement schema — validator only |
| `esign/pdfFill.js` | Filling the document |
| `esignSendService.js` | Orchestration: send, resend, recall, remind, satisfy |
| `esignTemplateService.js` | Template CRUD + save-time validation |
| `esignPrefillService.js` | Resolver whitelist — case data into placeholders |
| `esignWebhookService.js` | Inbound parsing + `processStatusChange`, the choke point |
| `esignFilingService.js` | Signed PDF + certificate → Dropbox |
| `esignAlertService.js` | Who gets told when something fails |
| `esignInlineImageService.js` | Inline images in generated documents |

### `applyStatus` is the choke point

Every status change goes through one transition table. The webhook, the nightly
reconciliation job and manual staff actions all land on `applyStatus()` or
`markSent()`, and both enforce the same table.

```
draft            → sent, recalled
sent             → viewed, partially_signed, signed, declined, expired,
                   recalled, bounced, satisfied_external
viewed           → partially_signed, signed, declined, expired, recalled,
                   bounced, satisfied_external
partially_signed → signed, declined, expired, recalled, bounced,
                   satisfied_external
bounced          → sent, recalled, satisfied_external
signed | declined | expired | recalled | satisfied_external → (terminal)
```

`markSent` exists separately only because it writes columns `applyStatus` has no
business writing — `provider_id` and `sent_at`.

**Terminal statuses are reached once; late events bounce off them.** Of the
five, only `signed` and `satisfied_external` stamp `completed_at`. That single
column is what makes "outstanding vs abandoned" reportable.

### `processStatusChange` is exported on purpose

There are exactly two ways to learn a document was signed: the provider tells us
(webhook), or we ask (the nightly job). Both must download the PDF, file it to
Dropbox, write the same log row, and raise the same task on failure.

If reconciliation reimplemented that against raw `esignService`, the two paths
would drift — and they would drift in the **least visible direction**, because
the reconciliation path only runs when a webhook was *missed*, which is exactly
the path nobody exercises by hand.

### Kinds

The product's built-in vocabulary is `retainer_prepetition`,
`retainer_postpetition`, `schedules`, `other`. **Templates may define new
kinds** (≤64 chars, non-empty); the legal set at send time is the union of the
built-ins and every kind an active template declares.

Dependency direction: `esignSendService` requires `esignTemplateService`, never
the reverse.

### Documents are capped at 20MB

Zoho's own ceiling is 25MB. We stop at 20 so that footer stamping — which
rewrites the file and can grow it — cannot push a document we already accepted
over a limit the provider rejects three steps later, after the work is done.

---

## Contents

| # | File | What's in it |
|---|------|----|
| 2 | [02-templates.md](02-templates.md) | Contract templates — placements, prefill resolvers, save-time validation, why templates are never deleted |
| 3 | [03-sending-and-filing.md](03-sending-and-filing.md) | The send sequence and its failure story, resend/recall/remind/satisfy, webhooks, reconciliation, filing to Dropbox |
| 4 | [04-api-and-schema.md](04-api-and-schema.md) | Every endpoint and every table |
