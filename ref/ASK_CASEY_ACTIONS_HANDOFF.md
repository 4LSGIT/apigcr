# Ask Casey actions arc — worker handoff

Updated 2026-10-20. Start by reading `AGENTS.md`,
`ref/ASK_CASEY_ACTIONS_PLAN.md`, and the Ask Casey chapter in the manual.

## Handoff checkpoint

Hand off after commit `09bc6e9` (`Refine Casey task review defaults`) on
`main`, pushed to `origin/main`. The worktree was clean and the scoped
assistant/task/sync regression run passed 10 suites and 304 tests. Do not redo
the Tasks slice. The repository-wide Jest run has unrelated stale shell/layout
assertions; use the scoped regression set plus the native service/UI/bus suites
for the action family being added.

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

1. **Events lifecycle.** Add create/update/complete/cancel using the existing
   `/api/events` routes. This most closely matches Tasks, and `yc-sync` already
   has event create/update/transition matchers. Freeze exact event types, dates,
   ownership, link values, and completion/cancel semantics.

2. **Appointments lifecycle.** Add create, edit, attended, no-show, cancel, then
   reschedule through `/api/appts*`. Matchers already exist, but calendar
   writes, provider/time validation, reminders, and cancellation/reschedule
   notices make this more complex than Events. Show timezone and every notice
   consequence in confirmation.

3. **Contact subrecords, one family at a time.** Phone, email, address, relation,
   and role add/edit/deactivate/delete already have dedicated routes. Start with
   additive and reversible operations. For each family, check whether the root
   contact view sees a bus update; add canonical matcher/response support if it
   does not. Never bundle multiple subrecords into one proposal initially.

4. **Scalar contact and case edits.** Use `PATCH /api/contacts/:id` and
   `PATCH /api/cases/:id`, whose root matchers already exist. Do not expose the
   routes' broad payloads. Ship narrow field families with before/after display,
   optimistic-concurrency or stale-value checks, and explicit exclusions for
   identity, access, merge, docket, and other high-impact fields.

5. **Case relationships and pipeline transitions.** Add/remove/change a case
   contact and advance/move pipeline using their dedicated routes. `yc-sync`
   already understands these paths, including set-change markers. Complexity
   comes from primary-contact invariants, pipeline requirements, overrides,
   notes, and downstream automation; show blockers and effects before confirm.

6. **Documents and form drafts.** Prefer draft/save-to-case actions before
   deletion, movement, submission, or publication. Browser uploads are
   multi-step and file bytes never belong in a model action. Require exact
   destination, filename/template, overwrite behavior, and a canonical bus
   decision for document collections.

7. **Outbound communications.** Separate compose/draft from send. Sending mail,
   SMS, CTA, campaigns, or signature requests is an irreversible external side
   effect: show exact recipients, channel/from identity, subject/body,
   attachments, schedule, and audience count. Require a fresh send confirmation
   and preserve the endpoint's delivery/audit semantics.

8. **Reports, workflows, and automations.** Draft and preview first; save,
   publish, run, cancel, or resume are separate kinds. These can fan out into
   many writes or external calls and need versioning, validation, dry-run data,
   permission gates, and domain-event review. Never allow arbitrary workflow
   step JSON from the model.

9. **Destructive/admin actions last.** Case/contact merge, file purge, credential
   changes, access controls, Court Review force-apply, and similar operations
   need dedicated designs, stronger re-auth/confirmation, impact previews, and
   explicit rollback stories. They should not inherit authority from ordinary
   Casey action support.

## Immediate next slice

Implement Events lifecycle first. Before changing prompts, trace the native
Events UI request bodies and the `yc-sync` event matchers, then write the closed
schemas and deterministic tests. Keep one proposal per answer and retain the
current bounded read limits; personality, larger autonomous investigations,
and general-purpose action execution remain out of scope.

Known Events facts to verify rather than rediscover from scratch:

- `routes/api.events.js` exposes create, whitelisted update, complete, and
  cancel. There is no delete or reopen route.
- The route replaces any model-supplied `acting_user_id` with the authenticated
  user; Casey must omit that field anyway.
- Complete accepts an optional kind-validated `resolution`.
- Cancel defaults `delete_gcal` to true and accepts an optional resolution;
  those consequences must be explicit in the card and SweetAlert.
- `public/js/yc-sync.js` already matches browser calls for event create,
  update, complete, and cancel and emits canonical event refetch/create signals.
- `/api/events/batch` is deliberately not matched and is out of scope for the
  first Events slice. Keep the slice to one event action per proposal.

## Copy-paste prompt for the next instance

```text
Read AGENTS.md, ref/ASK_CASEY_ACTIONS_PLAN.md,
ref/ASK_CASEY_ACTIONS_HANDOFF.md, ref/AI_CONTEXT.md, and
manual/05-Subsystems/17-ask-yisracase.md. Continue the Ask Casey actions arc
from clean main at or after commit 09bc6e9. Do not redo or redesign the shipped
Tasks lifecycle.

Implement the next slice only: reviewed Events lifecycle actions—create,
whitelisted update, complete, and cancel—through the existing authenticated
/api/events routes. Do not add a Casey execution endpoint. Preserve the core
boundary: Casey returns one closed, evidence-backed, server-normalized proposal;
the signed-in user reviews it in the existing SweetAlert flow; a fixed browser
mapping chooses the endpoint, method, and exact allowlisted body. The model must
never choose those or acting_user_id.

First trace routes/api.events.js, services/eventService.js, every native Events
UI caller, and the event matchers/readers in public/js/yc-sync.js. Document
required, optional, defaulted, and side-effecting fields before coding. Pay
special attention to event kind/type rules, firm-local date/time semantics,
links, reminders, Google Calendar behavior, completion resolution, and cancel's
delete_gcal default. There is no Events delete/reopen route. Exclude batch
creation, appointments, personality changes, broader autonomous reads, and all
other action families.

Require current evidence containing the exact event_id for existing-event
actions, reload and validate the target server-side, reject extra fields, render
all material values/side effects as text, prevent duplicate review dialogs and
writes, leave failures retryable, persist applied results to prevent casual
replay, and open the canonical event on success. Verify the existing yc-sync
path end to end; fix only canonical endpoint/response/matcher behavior if a bus
gap exists—never add a Casey-only emit.

Add deterministic service and UI tests for schemas, stale/invalid state,
confirmation cancellation, exact route/body mapping, SweetAlert review,
single-flight behavior, failure/retry, history restoration, and bus propagation.
Run the focused assistant tests plus the relevant Events service/UI/yc-sync
suites. Update the manual, AI context, actions plan, and this handoff with the
shipped contract and next recommended slice. Then commit and push.
```
