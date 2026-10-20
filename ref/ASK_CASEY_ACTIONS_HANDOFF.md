# Ask Casey actions arc — worker handoff

Updated 2026-10-20. Start by reading `AGENTS.md`,
`ref/ASK_CASEY_ACTIONS_PLAN.md`, and the Ask Casey chapter in the manual.

## Handoff checkpoint

Hand off from `ae5ac0a`, which ships reviewed contact phone/email/address
actions on `main`. Tasks, Events, Appointments, and A5 contact subrecords are complete;
do not redo those slices. The A5 run passed 275 focused assistant/chat/sync/
concurrency tests and 313 native contact service/UI tests. The
repository-wide Jest run has unrelated stale shell/layout assertions; continue
using the scoped regression set plus native suites for the family being added.

`ref/ASK_CASEY_ACTIONS_PLAN.md` is the roadmap source of truth. It now lists
the remaining action slices A6–A18, platform/release slices P0–P10, ordering,
release gates, review decisions, and work that is deliberately outside the
ordinary Casey roadmap. Keep this handoff focused on the immediate next slice
instead of copying and eventually drifting from that catalog.

## Shipped boundary

Casey does not execute a model-selected tool. It produces one typed,
evidence-backed, server-normalized proposal. Nothing changes when the card is
rendered. The staff member clicks a fixed button in their authenticated browser,
reviews an exact SweetAlert confirmation, and that browser calls the ordinary YisraCase
endpoint. The model never supplies the URL, method, auth, or arbitrary fields.

Task create/update/complete/cancel/reopen/transfer are implemented. They map to
the existing `/api/tasks` routes. Cancel is the existing reversible soft-delete.
Transfer stays separate from generic update because `/transfer` owns its audit
and notification semantics. Applied results are saved to assistant chat history
to prevent casual replay after reopening. The Tasks API has no `yc-sync`
matcher, so this slice preserves native Tasks behavior and refreshes the current
badge/list best-effort. A canonical Tasks sync matcher remains a separate arc.

Task creation requires assignee/title/description. Start is a not-before value,
not the creation date, and remains null unless requested; due is optional but
recommended for a real deadline. Unspecified completion notice defaults false
for self-assignment and true otherwise. The fixed browser mapping adds
`source:'Casey'`, omits `from` (authenticated user wins), and leaves assignment
email enabled by omitting `send_assignment_email`.

Event create/update/complete/cancel are implemented through the existing
`/api/events` routes. There is no Casey executor, Event delete/reopen, or batch
create. Create requires type/title/firm-local date/
all-day and time when timed. Optional duration, location, URL, note,
creation-time link, availability scope, and reminder are all normalized and
displayed. Known types resolve to their canonical registry label/key/kind;
custom types are `other`; meeting kinds are refused. All-day clears time and
duration and uses firm-wide scope.

Update exposes only type/title/date/time/all-day/duration/location/URL/note/
scope/reminder. Link identity, status, resolution, kind/type key, calendar
selection, dedupe, `skip_gcal`, and actor are excluded. Existing actions cite
the exact `event_id`, then reload and require Scheduled/non-superseded state.
Complete/cancel normalize per-kind resolution. Cancel defaults
`delete_gcal:true`. Cards and SweetAlerts state Google Calendar recreation/
retention/deletion and reminder-task effects.

Applied Event results persist and reopen as **Open event**. The canonical
`yc-sync` matchers already cover all four routes and the Events/Calendar/case/
contact readers subscribe to `event:*`, so no bus code changed and no Casey
emit exists.

Appointment create/narrow-update/attended/no-show/cancel/reschedule-now/
reschedule-later are implemented through `/api/appts*`. Create resolves a
verified contact, optional case linked to that contact, active meeting type,
active appointment provider, 1–1,440 minute length, platform, future firm-local time, note, and
optional reviewed SMS/email confirmation. It displays firm/provider calendar,
pre-appointment/no-show automation, and singleton-supersession effects.

Existing proposals cite the exact `appt_id` and reload joined current state.
Canceled/Rescheduled are terminal. PATCH is limited to note and case link
because the broad canonical route does not resync calendar or automation;
date/time uses reschedule and type/length/platform/provider remain excluded.
No-show defaults enrollment off. Cancel defaults calendar deletion on and
follow-up task off. Reschedule-now opens the lineage-linked successor;
reschedule-later creates none and may create the reviewed follow-up Task.
All seven browser mappings are closed and routes own source/actor. Applied
results persist. Existing `yc-sync` matchers already cover every route and both
reschedule IDs, so no bus or Casey emit changed.

Contact phone/email/address create, narrow update, and history-preserving end are
implemented as nine closed kinds through `/api/contact-*`. Create cites the
exact parent contact. Existing actions cite one row containing both parent and
subrecord IDs, reload active state, and carry server-owned row-version and
current-primary preconditions so the canonical service rejects stale review before writing.

Phone/email values cannot be patched or force-transferred. Updates expose only
label, notes, primary promotion, and explicit opt-out/MMS settings; addresses
also expose address parts. End records a non-future date and required reason,
preserving history. Hard DELETE, verified state, start-date edits, explicit
primary demotion, reactivation, scalar fields, relations/roles, and batches are
excluded. Review shows current/proposed values, consent settings, primary
demotion and mirror effects, and that no message or ownership transfer occurs.

Canonical sync was repaired for every caller: create/PATCH responses announce
the recipient contact, while native force-transfer still announces its donor.
There is no Casey emit. Success persists and opens the parent contact.

## Recipe for every new action

1. Locate the exact existing user-facing endpoint and its native UI caller.
2. Inspect its authentication, actor attribution, validation, audit, external
   side effects, notifications, reversibility, and response shape.
3. Define a closed versioned model schema. Require current evidence containing
   the exact target ID; resolve IDs and labels again on the server.
4. Normalize to a server-owned proposal. Reject unknown kinds and fields.
5. Render all material values and side effects as text and require a fresh
   click plus confirmation. Cancellation of the dialog writes nothing.
6. Map the normalized proposal to a fixed endpoint/method/body in the browser.
   Never accept these from the model and do not add a Casey endpoint merely for
   convenience.
7. Make the request single-flight, leave failures retryable, persist success,
   and offer the canonical open-record action.
8. Audit `public/js/yc-sync.js`. If propagation is missing, fix the canonical
   endpoint/service and matcher for every caller—never emit a Casey-only event.
9. Test schema rejection, stale state, confirmation cancellation, exact request
   mapping, double-click protection, failure/retry, history replay prevention,
   permissions, side effects, and bus behavior.

## Remaining roadmap

Use the numbered catalog in the plan rather than expanding scope from this
summary. In order, it covers contact relations/roles;
narrow contact/case fields; case-contact membership; pipeline transitions;
checklists; documents; forms; communication triage/drafts; external email/SMS;
e-sign; reports; workflows; and sequences/triggers. Workflow creation is not
one action: disabled draft, validation/preview, versioned save, publish, start,
and execution controls are separate releases with different risk gates.

The plan also makes non-action work explicit: current live release gates, a
closed action registry and shared review UI, permission mapping, optimistic
concurrency, durable idempotency, applied-result recovery, canonical sync
coverage, privacy-safe audit/observability, a reusable adversarial test kit,
accessibility/explainability, and controlled rollout. Do not defer these until
after all action families; follow the gates in the plan.

Bulk/destructive/admin/access/credential changes, arbitrary tools or endpoints,
multi-action plans, and unattended execution are not merely “last.” They are
outside the ordinary roadmap pending a separate product and threat-model
decision.

## Review readiness

The deterministic shipped-family contracts are documented and tested, but P0
is not yet closed: the live dependent second-read test and the staff-fixture
smoke spanning all four shipped families remain explicit review/rollout gates.
The review should also decide the A6 remove-operation split, initial A7 fields,
P1 extraction timing, and the P4/P5/P10 bar before external sends or fan-out.
The plan's **Review briefing** is the authoritative checklist.

## Immediate next slice

Implement A6 contact relations and roles next. Trace the dedicated relation and
role routes/services, both directional native views, registries, permissions,
uniqueness rules, lifecycle/remove behavior, audit, and sync readers before
fixing schemas. Keep contact-to-contact relations separate from firm-defined
contact roles when their invariants or side effects differ.

## Copy-paste prompt for the next instance

```text
Read AGENTS.md, ref/ASK_CASEY_ACTIONS_PLAN.md,
ref/ASK_CASEY_ACTIONS_HANDOFF.md, ref/AI_CONTEXT.md, and
manual/05-Subsystems/17-ask-yisracase.md. Continue the Ask Casey actions arc
from clean main at or after `ae5ac0a`. Do not redo or
redesign the shipped Tasks, Events, Appointments, or A5 subrecord slices.

Implement the next slice only: reviewed contact relation and contact-role
actions through the existing authenticated dedicated routes. Do not add a
Casey execution endpoint. Preserve one evidence-backed, server-normalized
proposal; exact SweetAlert review; fixed browser route/method/body mapping;
authenticated actor;
single-flight/retry/history/open-record behavior; and canonical sync only.

First trace the relation/role routes and services, every native UI caller,
type registries, and `yc-sync` contact matchers/readers. Document direction,
inverse labels, uniqueness, required/defaulted fields, status/lifecycle,
permissions, audit, reversibility, and propagation to both contacts before
coding. Require exact involved contact/relation/role IDs in current evidence
and reload them server-side. Exclude firm-level type administration, scalar
contact edits, case membership, batch actions, personality changes, broader
reads, and all other action families.

Add deterministic schema/state/UI/mapping/single-flight/retry/history/bus tests,
run focused assistant plus native relation/role suites, update the four action
docs, then commit and push.
```
