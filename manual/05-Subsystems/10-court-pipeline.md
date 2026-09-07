# 10 — The Court Email Pipeline

Court notices arrive as email and mostly handle themselves. This chapter covers
the whole path: what reads them, what happens when the reader isn't sure, the
tuning tool for the prompt behind it, and the v2 extraction layer being built
alongside.

| Part | What it is |
|---|---|
| **Extraction** | An ingest rule hands each court email to an AI extractor |
| **The executor** | Turns an extraction into case / appointment / event writes |
| **The review queue** | Where anything uncertain waits for a person |
| **Court Preview** | Try a prompt or model against real mail, with no writes |
| **Parser v2** | A registry-driven replacement for the extraction half — in progress |

---

## The review queue

### For operators

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

### Technical reference — the queue

#### Files

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

#### Dry-run is the default, and it's hard

`executeCourtActions` defaults `dryRun` to **true** unless explicitly false. In
dry-run there are no `apptService` calls and no event or case writes — and
therefore none of the downstream side effects either: no Google Calendar, no
sequences, no confirmations.

**But the audit rows are still written**, with `dry_run=1`. Capturing intended
changes in `court_ai_log` and `ai_change_log` is the entire point of a dry run.

A `message_id` matching `/-test-/` **forces** dry-run. Mangled test ids must
never write real entities or fire side effects.

#### What "open" means — the openness rule

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

#### Dismiss, with no schema change

Dismiss writes a **new** `court_ai_log` row: same `message_id`,
`outcome='none'`, `dry_run=0`, `review_reason='dismissed:<note>'` (sliced to
255), with `classification` and `case_number` copied from the dismissed row and
`raw_response` NULL.

That row is a closing row under the openness rule, so the message leaves the
queue. `outcome='none'` with `dry_run=0` *also* trips the processed-marker, so a
later live re-run short-circuits as `already_processed` — which is what makes
dismiss terminal for live execution.

#### Entity defaults

Verified against live data:

- **341 appointment** — `appt_type` literally `'341 Meeting'`, `appt_length=10`,
  `appt_with=1`, platform defaults to `Zoom` when the payload omits it.
  `appt_date` is the firm-**local** string `${date} ${time}:00`;
  `apptService.createAppt` does the UTC conversion itself and owns
  `cases.case_341_current` / `341_appt_id` — the executor never writes those.
- **Event** — `event_link_type='case_number'`, `event_link_id` = the resolved
  docket string.

#### API

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

#### Related functions and jobs

`court_review_retry` and `court_activity_summary` both run nightly at 13:00 UTC
— see [the recurring-jobs roster](../03-YisraFlow/05-internal-functions.md).
`validate_case_trustee` checks a case's trustee against the docket.

---

## Court Preview

**More → Court Preview.** Pick a real court email, adjust the prompt or switch
the model, and see exactly what the extractor *would* do — without touching
anything.

This is how you tune extraction. Nothing it does is written: no `court_ai_log`
row, no `ai_change_log` row, no case, appointment or event. (The `ai_calls` row
*is* written, because cost tracking should count a preview run like any other.)

### Using it

1. **Pick an email.** The picker lists recent court mail, newest first. Search
   by subject, or paste an `email_log` id to jump straight to one.
2. **Check the prompt.** It arrives prefilled with the live `court_extract`
   prompt, so you start from what production is actually using.
3. **Pick a model** — Sonnet or Haiku.
4. **Run it.** You get the extraction *and* the plan the executor would carry
   out from it.

The value is in step 4: an extraction that looks right can still produce a wrong
plan, and this shows both.

### API

| Route | Method | Purpose |
|---|---|---|
| `/api/court-preview/prompt` | GET | The live prompt, model and token cap, plus the model list |
| `/api/court-preview/emails` | GET | Picker source — recent court mail; `q` matches a subject or an `email_log` id |
| `/api/court-preview/run` | POST | Extraction + preview plan, no writes |

Normal `jwtOrApiKey` auth. Meant to be mounted inside the shell, so
`window.top.apiSend` exists.

> The source file still opens with a "TEMPORARY — commit-and-delete-later"
> header from when it was written. It is staying; treat the header as stale.

---

## Parser v2 — the extraction layer being rebuilt

> **In progress.** Stages 2–4 are built (`services/aiMatchService.js`); the
> registry is seeded but not yet wired, so **the live pipeline still runs v1**.
> Documented here because the design decides how the registry is filled in.

### What changes

v1 asks a model to read a court email and describe what happened, in prose-ish
JSON that the executor interprets. v2 inverts that: the model is given a
**closed list** of known item types and asked only *which of these match, what
are their declared fields, and where in the text does each value come from.*

**The model recognises; the system decides.** The only string the model emits
that matters is a `type_key`, and that is validated against the registry on the
way out — so casing and wording cannot drift.

### The registry

Two tables, and **adding a type is an INSERT plus a version bump, never a
deploy**:

| Table | Holds |
|---|---|
| `ai_match_sets` | A named set — label, description, prompt preamble, version |
| `ai_match_types` | The types in that set |

Each type carries a `type_key`, a `label`, a `disposition`
(`act` / `ignore` / `out_of_scope`), an `item_type` and `verb`
(`scheduled` / `rescheduled` / `cancelled` / `occurred` / `status_changed`),
`recognition_hints`, a `fields` spec, `collapse_same_date`, and an optional
`workflow_id`.

**Today the registry holds 42 types and every one is `disposition: 'ignore'`** —
`reply_motions`, `certificate_of_service`, `proof_of_claim_activity`,
`bnc_certificate_of_mailing` and the rest. That is the noise catalog: the docket
traffic that means nothing to us. Naming it explicitly is what lets the
actionable set stay small and legible. `ai_match_sets` is still empty, which is
why nothing loads yet.

### Per-field citations

Every extracted value must come with a **verbatim span from the source text**
proving where it came from. The verification is deterministic and ours, not the
model's:

| Situation | Result |
|---|---|
| Field marked `citable: false` (composed labels, constants) | Exempt |
| Field value null or blank | Nothing to verify |
| Citation fails on an **optional** field | That field is dropped, processing continues (recorded in `dropped_fields`) |
| Citation fails or is absent on a **required** field | The whole match is flagged |

The matcher is `lib/courtCitation`'s `citationMatches` — elision-aware,
emphasis-stripping, whitespace-normalized. Nothing in it is court-specific, and
it is **imported rather than copied**, so the v1 executor path and the v2 path
can never disagree about what counts as a faithful quote.

### Flag codes

Computed, never asked of the model:

| Code | Means |
|---|---|
| `shape_invalid` | Output didn't parse into the contract |
| `unknown_key` | A match named a `type_key` not in the registry |
| `missing_required` | A required field absent or blank |
| `citation_fail_required` | A required field's citation was absent or fabricated |

`case_unresolved`, `prior_not_found`, `prior_ambiguous` and `date_in_past` are
stage-5/6 codes and live downstream.

### The seven stages, and what exists

| Stage | What | State |
|---|---|---|
| 1 | Intake — the court email arrives | ingest rule (v1, shared) |
| 2 | Prompt generation from the registry | **built** |
| 3 | Output shape validation | **built** |
| 4 | Per-field citation verification | **built** |
| 5 | Case resolution | `lib/courtResolve.js`, unchanged from v1 |
| 6 | Prior-item reconciliation | designed, not built |
| 7 | Routing and dispatch | the workflow layer's job — `foreach` over matches plus `evaluate_condition` / `start_workflow` |

**`ai_match` never dispatches.** Stage 7 is deliberately left to workflows, so
what happens to a match is configuration rather than code.

### Prompt safety

The generated system prompt carries **only trusted material** — the registry and
our own `source_ref`. All foreign text rides in `userInput`, which `aiService`
wraps in `<untrusted_user_input>`, and the prompt tells the model explicitly
that everything inside it — including any `SUBJECT:` / `FROM:` lines — is data
and never instructions.

Court Preview v2 is expected to land alongside this, so the same tuning loop
works against the registry.
