# 3 — Sending, Tracking and Filing

## For operators

### Sending

From a case, **Signatures → Send**: pick a template (or upload a one-off
document), confirm the recipients, and send. What we do between your click and
the client's inbox:

1. Fill the text fields from the case.
2. Stamp a tracking footer.
3. Hand it to the provider.
4. Mark it sent.

Recipients sign **in order**. Signer 1 acts first; signer 2 doesn't see it until
they're done.

### After it's out

| Action | Use it when | Result |
|---|---|---|
| **Remind** | They've gone quiet | Provider nudges them |
| **Resend** | The email bounced | Goes out again, same request |
| **Recall** | Wrong document, wrong person, changed plan | Terminal — dead, can't be revived |
| **Mark satisfied externally** | They signed on paper or in the office | Terminal, counts as **done** |

Recall is deliberately one-way. If you recall the wrong thing, send a new one.

### Filing happens by itself

The instant a document reaches `signed`, the executed PDF **and** the completion
certificate are filed to the case's Dropbox folder, under **Signed Documents**.

Filing can't fail in a way that loses the signature — by the time it runs, the
client has already signed and that's recorded. What it does instead is degrade,
and tell you:

| Situation | What happens |
|---|---|
| Case has a linked Dropbox folder | Filed to `<case folder>/Signed Documents` |
| Case has no linked folder | The folder is **created**, then filed — **always with a warning** |
| No case, missing case row, dead link, path too long | Filed to the **unsorted** folder, filename prefixed with the entity id and contact name |
| Even unsorted fails | A task: download it from the provider by hand |

**Take the auto-create warning seriously.** Some cases already have a hand-made
Dropbox folder that was simply never linked, and a silently created duplicate
sitting next to the real one is worse than the warning. The warning names the
folder it made and tells you to merge and re-link if one already existed.

The task wording distinguishes the cases on purpose: *"move this file"* is a
different job from *"download it from Zoho by hand."*

### When a webhook goes missing

`esign_reconcile` runs nightly at 11:00 UTC, re-checks everything outstanding,
and applies whatever was missed — including downloading and filing a signed
document. It's the reason a dropped callback costs a day rather than a document.

---

## Technical reference

### The send sequence — the order is the design

```
1. validate           no row, no network, no credit spent
2. createRequest      draft row exists, tracking_id minted
3. stamp footer       needs the tracking_id from step 2
4. provider send      the only step that costs money
5. markSent           draft → sent, provider_id recorded
6. recordCreditSpend  local estimate, best effort
```

Each failure has a different right answer, which is why this lives in a service
rather than a route handler:

**A failure at step 4 leaves the row a draft and rethrows with `.draftId`
attached** so the caller retries with the *same* row. This is why `draftId` is a
first-class parameter and not an internal detail: a retry after a provider 500
must reuse the `tracking_id` already stamped into the document, or the copy the
debtor eventually signs carries an id that matches nothing.

**A failure at step 6 is swallowed.** By then the envelope is out and the
credits are gone. Turning a bookkeeping miss into a 500 would tell the caller
the send failed when it didn't — and they would send it again, spending more.

`sendPipeline` takes a PDF buffer and asks no questions about where it came
from. The template branch (`sendFromTemplate`) manufactures its PDF through
`templateRenderService` and then joins the same pipeline.

### Inbound

`handleZohoWebhook()` is the route's entire body: parse → find row → decide.
Everything then funnels into **`processStatusChange()`**, the choke point that
both the webhook and the reconciliation job call. See
[chapter 1](01-overview.md) for why it's exported rather than reimplemented.

Webhook authenticity is HMAC-verified (`ref/2026-07-22_esign_webhook_hmac.sql`).

A log-writing hook is wired at module load and turns audit events into `log`
rows, so the signature trail shows up in the ordinary activity history.

### Filing never throws

By the time `esignFilingService` runs, **the client has signed** — that fact is
recorded in `signing_requests` and is not in question. A Dropbox outage must not
un-record it, must not 500 the webhook, and must not make the provider retry. So
every failure path returns `{ filed: false, note }` and lets
`processStatusChange` decide what a human needs to hear.

The module raises no tasks and writes no logs by design: filing is a
*mechanism*, deciding who gets told is *policy*. Mixing them would let the
webhook and the reconciliation job alert differently for identical outcomes.

**The fallback ladder:**

1. Case with a live `case_dropbox` link → `<case folder>/Signed Documents`.
2. Case with none → `caseService.ensureCaseDropboxFolder` (the same stage-aware
   creator intake and the case-page repair button use), then (1). **Always
   warns.**
3. Anything else — contact-linked request, missing case row, dead or revoked
   shared link, auto-create failure, over-long path → the unsorted folder
   (`app_settings.dropbox_unsorted_esign_path`), filename prefixed with the
   linked entity's id and primary contact name so it's identifiable in a shared
   bin, plus a best-effort direct shared link in the warnings so the task email
   can point at the file.
4. Unsorted also fails → `{ filed: false }`.

`placement` (`'case'` | `'unsorted'`) rides on the verdict so the announcer can
word the task truthfully.

### Internal functions

Automation drives all of this — see
[YisraFlow chapter 5](../03-YisraFlow/05-internal-functions.md):

| Function | Does |
|---|---|
| `esign_send_from_template` | Send a template for a case |
| `esign_get_status` | Read current status |
| `esign_remind` | Nudge outstanding signers |
| `esign_recall` | Pull a request back |
| `esign_reconcile` | The nightly safety net (`dry_run` supported) |

E-sign completions also emit domain events, so trigger rules can react to a
signed document — see [triggers](../03-YisraFlow/15-triggers.md).

> Third-party e-sign completions that arrive as **email** (Adobe Sign, Clio
> Grow, Jotform Sign) are handled by ingest rules, not by this subsystem — see
> [chapter 10](../03-YisraFlow/10-ingest.md).
