# Ask Casey actions arc — worker handoff

Updated 2026-10-20. Start by reading `AGENTS.md`,
`ref/ASK_CASEY_ACTIONS_PLAN.md`, and the Ask Casey chapter in the manual.

## Handoff checkpoint

Hand off from the commit that ships reviewed Events lifecycle actions on
`main`. Tasks and Events are complete; do not redo either slice. The scoped A3
run passed the focused assistant/sync suites and the native Event service/UI
suites. The repository-wide Jest run has unrelated stale shell/layout
assertions; continue using the scoped regression set plus the native suites for
the action family being added.

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
`/api/events` routes. There is no Casey executor, Event delete/reopen, batch
create, or Appointment action. Create requires type/title/firm-local date/
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

## Recommended order, lowest to highest complexity

1. **Appointments lifecycle.** Add create, edit, attended, no-show, cancel, then
   reschedule through `/api/appts*`. Matchers already exist, but calendar
   writes, provider/time validation, reminders, and cancellation/reschedule
   notices make this more complex than Events. Show timezone and every notice
   consequence in confirmation.

2. **Contact subrecords, one family at a time.** Phone, email, address, relation,
   and role add/edit/deactivate/delete already have dedicated routes. Start with
   additive and reversible operations. For each family, check whether the root
   contact view sees a bus update; add canonical matcher/response support if it
   does not. Never bundle multiple subrecords into one proposal initially.

3. **Scalar contact and case edits.** Use `PATCH /api/contacts/:id` and
   `PATCH /api/cases/:id`, whose root matchers already exist. Do not expose the
   routes' broad payloads. Ship narrow field families with before/after display,
   optimistic-concurrency or stale-value checks, and explicit exclusions for
   identity, access, merge, docket, and other high-impact fields.

4. **Case relationships and pipeline transitions.** Add/remove/change a case
   contact and advance/move pipeline using their dedicated routes. `yc-sync`
   already understands these paths, including set-change markers. Complexity
   comes from primary-contact invariants, pipeline requirements, overrides,
   notes, and downstream automation; show blockers and effects before confirm.

5. **Documents and form drafts.** Prefer draft/save-to-case actions before
   deletion, movement, submission, or publication. Browser uploads are
   multi-step and file bytes never belong in a model action. Require exact
   destination, filename/template, overwrite behavior, and a canonical bus
   decision for document collections.

6. **Outbound communications.** Separate compose/draft from send. Sending mail,
   SMS, CTA, campaigns, or signature requests is an irreversible external side
   effect: show exact recipients, channel/from identity, subject/body,
   attachments, schedule, and audience count. Require a fresh send confirmation
   and preserve the endpoint's delivery/audit semantics.

7. **Reports, workflows, and automations.** Draft and preview first; save,
   publish, run, cancel, or resume are separate kinds. These can fan out into
   many writes or external calls and need versioning, validation, dry-run data,
   permission gates, and domain-event review. Never allow arbitrary workflow
   step JSON from the model.

8. **Destructive/admin actions last.** Case/contact merge, file purge, credential
   changes, access controls, Court Review force-apply, and similar operations
   need dedicated designs, stronger re-auth/confirmation, impact previews, and
   explicit rollback stories. They should not inherit authority from ordinary
   Casey action support.

## Immediate next slice

Implement Appointments lifecycle next, one reviewed transition at a time. Trace
`routes/api.appts.js`, `services/apptService.js`, every native Appointment UI
caller, scheduling/notification/calendar side effects, and the existing
`yc-sync` matchers before fixing schemas. Start with create/edit/attended/
no-show/cancel; treat reschedule as a separate higher-impact contract if its
successor/predecessor and notice semantics do not fit cleanly in the first
slice. Keep one proposal per answer and the current bounded read limits.

## Copy-paste prompt for the next instance

```text
Read AGENTS.md, ref/ASK_CASEY_ACTIONS_PLAN.md,
ref/ASK_CASEY_ACTIONS_HANDOFF.md, ref/AI_CONTEXT.md, and
manual/05-Subsystems/17-ask-yisracase.md. Continue the Ask Casey actions arc
from clean main after the reviewed Events lifecycle commit. Do not redo or
redesign the shipped Tasks or Events slices.

Implement the next slice only: reviewed Appointments lifecycle actions through
the existing authenticated `/api/appts*` routes. Do not add a Casey execution
endpoint. Preserve one evidence-backed, server-normalized proposal; exact
SweetAlert review; fixed browser route/method/body mapping; authenticated actor;
single-flight/retry/history/open-record behavior; and canonical sync only.

First trace the Appointment routes, service, all native UI callers, and bus
readers. Document provider/type/length rules, firm-local/UTC twins, links,
availability, Google Calendar writes, reminders, attendee notices, cancellation
and reschedule effects, and reversibility before coding. Require exact appt_id
evidence and a server reload for existing actions. Exclude batch actions, Events,
personality changes, broader autonomous reads, and other action families.

Add deterministic schema/state/UI/mapping/single-flight/retry/history/bus tests,
run focused assistant plus native Appointment suites, update the four action
docs, then commit and push.
```
