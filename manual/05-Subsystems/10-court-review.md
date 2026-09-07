# 10 — Court Review Queue

## For operators

Court notices arrive as email. An AI reads each one, works out what it means —
a 341 meeting, a hearing, a deadline, a docket number — and either applies it to
the case or **puts it in a queue for a person to look at**.

This is that queue: **More → Automations → Court Review**.

Anything the extractor wasn't confident enough to apply on its own lands here.
One card per message, showing what it proposes to do.

### Your four options

| Action | What it does |
|---|---|
| **Re-run** | Run it again as-is. Use after fixing whatever was wrong on the case |
| **Adopt & re-run** | Attach the docket to a case first, then run. The usual fix for "we couldn't tell which case this is" |
| **Approve / force-apply** | Apply the proposed changes |
| **Dismiss** | Nothing to do here — a duplicate, a notice about a case we don't have |

### Dismiss is terminal

A dismissed message is closed for good: it leaves the queue **and** a later
re-run of the same message short-circuits as already-handled. That is
intentional — dismiss means "this needed no action," and a message shouldn't
quietly come back later. If you dismissed something by mistake, apply it by hand.

### One card per message, always the newest

A dry re-run that stays queued writes a *new* row rather than editing the old
one, so the audit trail keeps every attempt. The queue shows only the newest, so
re-running replays the freshest payload and you see one card per message rather
than a growing stack.

### An empty queue is the normal state

The queue being empty means the extractor is applying things confidently. It's
what you want to see.

---

## Technical reference

### Files

```
services/courtExecutor.js   Turns an extraction payload into case/appt/event writes
services/courtRerun.js      Re-run mechanics
routes/courtReview.js       The queue's HTTP surface
lib/courtResolve.js         Docket → case resolution
lib/aiPrompts/courtExtract.js  The extraction prompt
public/automation/courtReview.html  The UI
```

Extraction is driven by an **ingest rule** — the "Court: AI Extract" rule in
[chapter 10](../03-YisraFlow/10-ingest.md) — not by a bespoke inbound route.

### Dry-run is the default, and it's hard

`executeCourtActions` defaults `dryRun` to **true** unless explicitly false. In
dry-run there are no `apptService` calls and no event or case writes — and
therefore none of the downstream side effects either: no Google Calendar, no
sequences, no confirmations.

**But the audit rows are still written**, with `dry_run=1`. Capturing intended
changes in `court_ai_log` and `ai_change_log` is the entire point of a dry run.

A `message_id` matching `/-test-/` **forces** dry-run. Mangled test ids must
never write real entities or fire side effects.

### What "open" means — the openness rule

There is no `open` column. A `court_ai_log` row is open (still needs review)
if and only if:

- `outcome = 'queued'`, **and**
- no *later* row (`id >`) for the same `message_id` is a **closing row**, where
  closing means `dry_run = 0 AND outcome IN ('executed','none')`.

The `dry_run = 0` requirement is load-bearing: a *dry* re-run that "executes"
intended-only changes writes a `dry_run=1` row and must **not** close the queued
row.

This composes with `executeCourtActions` STEP 1 (the processed-marker), which
also blocks a live re-run of an already-handled message.

To count the open queue:

```sql
SELECT COUNT(*) FROM court_ai_log a
WHERE a.outcome = 'queued'
  AND NOT EXISTS (
    SELECT 1 FROM court_ai_log b
    WHERE b.message_id = a.message_id
      AND b.id > a.id
      AND b.dry_run = 0
      AND b.outcome IN ('executed','none'));
```

### Dismiss, with no schema change

Dismiss writes a **new** `court_ai_log` row: same `message_id`,
`outcome='none'`, `dry_run=0`, `review_reason='dismissed:<note>'` (sliced to
255), with `classification` and `case_number` copied from the dismissed row and
`raw_response` NULL.

That row is a closing row under the openness rule, so the message leaves the
queue. `outcome='none'` with `dry_run=0` *also* trips the processed-marker, so a
later live re-run short-circuits as `already_processed` — which is what makes
dismiss terminal for live execution.

### Entity defaults

Verified against live data:

- **341 appointment** — `appt_type` literally `'341 Meeting'`, `appt_length=10`,
  `appt_with=1`, platform defaults to `Zoom` when the payload omits it.
  `appt_date` is the firm-**local** string `${date} ${time}:00`;
  `apptService.createAppt` does the UTC conversion itself and owns
  `cases.case_341_current` / `341_appt_id` — the executor never writes those.
- **Event** — `event_link_type='case_number'`, `event_link_id` = the resolved
  docket string.

### API

| Route | Method | Purpose |
|---|---|---|
| `/api/court-review/queue` | GET | Open items, deduped to the newest per message |
| `/api/court-review/item/:id` | GET | One item with its payload |
| `/api/court-review/rerun` | POST | Re-run as-is |
| `/api/court-review/reextract` | POST | Re-run extraction |
| `/api/court-review/adopt-rerun` | POST | Attach the docket to a case, then re-run |
| `/api/court-review/approve` | POST | Apply |
| `/api/court-review/force-apply` | POST | Apply past a guard |
| `/api/court-review/dismiss` | POST | Close it — terminal |

Normal `jwtOrApiKey` auth. Default page size 200, max 1000.

### Related functions and jobs

`court_review_retry` and `court_activity_summary` both run nightly at 13:00 UTC
— see [the recurring-jobs roster](../03-YisraFlow/05-internal-functions.md).
`validate_case_trustee` checks a case's trustee against the docket.

> `routes/courtPreview.js` (More → Court Preview) is a **temporary tuning
> tool**: it runs extraction with no writes so a prompt or model change can be
> evaluated against real mail. It is marked commit-and-delete-later in the
> source and is not part of the permanent surface.
