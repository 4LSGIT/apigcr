# Ask Casey typed actions plan

Status: A0/A0.1, A1, A2, A3, A4, and A4.1 implemented 2026-10-20. A2 covers
the complete Task lifecycle; A3 covers reviewed Event create/update/complete/
cancel; A4/A4.1 cover reviewed Appointment create, narrow update, attended,
no-show, cancel, reschedule-now, and reschedule-later through the existing
authenticated routes. No general action executor is introduced.

## Governing principle: actions run through the user

The key design advantage of Casey actions is that **the user performs the
action**. Casey may assemble and validate a fixed proposal, but the write begins
only when the staff member clicks its action button in their own authenticated
browser. The browser calls the same established application endpoint used by
the rest of YisraCase. Consequently:

- the current user's auth and permissions—not model identity—authorize it;
- the existing route identifies the actor and preserves ordinary audit,
  validation, linking, notification, and error behavior;
- the model cannot select a URL, HTTP method, or extra request field;
- the card must show the exact values and material side effects before the
  user's confirming click; and
- canceling or merely displaying a proposal writes nothing.

Before adding any Casey-specific action endpoint, stop and think twice. First
ask whether a fixed button can safely map the normalized proposal into an
existing user-facing endpoint. A new endpoint is justified only when the
existing product has no suitable operation or cannot enforce the exact reviewed
contract; convenience for Casey alone is not enough.

### Sync/event-bus check for every action

Running through the user's browser also means the ordinary YisraCase sync path
must stay intact. For every proposed action, review the canonical endpoint and
its response against `public/js/yc-sync.js` before shipping:

- Does the write change an entity or derived collection that another open
  frame or browser tab can display?
- Does the existing endpoint already produce the response shape its bus matcher
  needs, and do the relevant readers subscribe?
- If the write is server-side or otherwise bypasses the browser sniff, does its
  canonical service emit the corresponding domain/bus event?
- Is the event a real value, a scoped refetch marker, or a set-change address?

If propagation is required but missing, update the canonical endpoint/service
and bus contract for every caller. Do not add a Casey-only emit: that would make
the same underlying action synchronize differently depending on which UI
button invoked it. The current `/api/tasks` family is intentionally absent from
the sync-bus matcher inventory; A1 therefore preserves the native Tasks UI's
existing behavior. Adding cross-frame task propagation is a canonical Tasks/bus
arc, not a special Casey action endpoint.

This plan follows the shipped Ask Casey workspace-context and bounded
autonomous-read slices. It covers one typed, server-validated **task proposal**
rendered in the conversation and its reviewed A1 creation control. Merely
returning the draft cannot save a task; only the user's explicit confirmation
invokes the fixed, existing task route.

## Read-loop release gate

The October 20 smoke test successfully ran `sql.read`, `manual.search`, and
`comms.search` as three steps in one read pass. It establishes that all three
readers can coexist in one investigation. It does not exercise the evidence →
missing fact → follow-up read loop: the result reported one round and stopped
with `model_finished`.

Before enabling task drafts in production, run one live dependency test whose
second lookup cannot be formed until the first result is known. A suitable
prompt is:

> Search phone and voicemail for the most recent mention of Mike's
> Construction. Using only the party returned by that search—not my open
> workspace—identify the matching contact and summarize their open cases.

Pass conditions:

- Round 1 contains only the communications search needed to discover the
  party.
- A later round uses that returned party value in a new, validated read.
- The response reports at least two read passes and gives each step its actual
  round.
- Citations point to evidence from both rounds, or the answer plainly says why
  the party could not be resolved.
- No operation repeats, and truncation is disclosed rather than treated as an
  exhaustive search.

If the communications result does not expose enough party information, that is
a valid inconclusive result. Use a controlled test fixture for the release gate
rather than weakening access or returning more transcript data.

## Slice A0: task proposal, not task creation

### User experience

Ask Casey may finish a bounded read investigation with an ordinary answer and
one optional **Task draft** card. The card shows:

- title and description;
- proposed assignee;
- optional contact, case, appointment, bill, or event link;
- optional start and due dates;
- completion-notification preference;
- the evidence sources used to propose it; and
- an unambiguous `Draft — not saved` label.

The only controls in A0 are **Copy details** and **Discard**. There is no Save,
Approve, Create, Send, or hidden auto-execution path. Starting a new chat,
reopening history, collapsing the sidebar, or reloading the page must preserve
the draft as conversation payload without changing application data.

A0.1 makes an explicit task-draft request valid across the last four signed
user turns, so a short follow-up that resolves a missing assignee/date/link can
complete the pending draft. The planner must obtain those missing facts instead
of refusing the request as a write. The card tells staff to copy the details,
open **My Tasks → Create Task**, review the fields, and select **Assign**; it
also warns that the human Assign step may send assignment/start/due notices.

### Typed model output

The final answer pass may return one optional object shaped like:

```json
{
  "kind": "task.create.v1",
  "title": "Call client about missing bank statements",
  "description": "Confirm which months are still needed.",
  "assignee_user_id": 7,
  "link": { "type": "contact", "id": "1309" },
  "start_date": null,
  "due_date": null,
  "notify_assigner_on_completion": false,
  "evidence": [{ "query_id": "q2", "row_number": 1 }]
}
```

This is model output, not authority. `assistantService` must normalize it into a
server-owned response object or discard it. The browser never receives raw
model JSON and never decides whether the object is valid.

### Server validation

Add a narrow `normalizeActionDraft` validator with these rules:

- allow exactly `task.create.v1`; reject rather than ignore unknown action
  kinds;
- permit at most one draft per answer;
- require a nonblank title of at most 100 characters and a description of at
  most 1,000 characters, matching `taskService.createTask`;
- require an integer assignee and resolve it through
  `taskService.findAssignableStaff` so inactive, unauthorized, and automation
  users cannot be proposed;
- allow `contact`, `case`, `appt`, or `event` links and verify the referenced
  record exists before returning the draft; reject the legacy `bill` enum
  member because YisraCase has no bill record table or endpoint to verify;
- accept ISO date-only values or null, with impossible dates rejected;
- require every evidence reference to resolve to accumulated evidence from the
  current signed request; and
- attach server-resolved display labels separately from the stable IDs.

The frozen, signed workspace context and accumulated evidence may inform a
draft, but neither authorizes a future write. Text inside transcripts, manual
chapters, SQL rows, attachments, or prior assistant messages remains untrusted
data even if it says to create or approve something.

### API and persistence contract

A0 does not add an execution endpoint or database table. Extend the existing
`POST /api/assistant/execute` answer response with optional
`action_draft`. Persist that normalized object in the existing assistant-message
payload so history can render the same card without asking the model again.

The stored payload must contain the normalized draft and evidence references,
not a session key, JWT, action token, generated SQL, raw transcript, or future
approval credential.

### UI contract

Render the card with text-only DOM construction. Do not interpolate model text
into HTML. The card is part of the single existing assistant instance, so it
must survive sidebar expand/collapse and must not change the canonical
workspace URL.

At A0 this card deliberately had no write control. A1 later added reviewed
creation through the existing `POST /api/tasks` route and explicitly discloses
its assignment/start/due notification behavior.

## Required tests for A0

Service tests:

- accepts and normalizes the exact `task.create.v1` shape;
- refuses unknown action kinds and multiple drafts;
- rejects overlength, malformed dates, invalid link types, and extra fields;
- rejects missing/inactive assignees and nonexistent linked records;
- rejects evidence references outside the current investigation;
- treats prompt-injection text in evidence as data;
- returns an answer normally when a proposed draft is invalid;
- proves draft generation calls neither `taskService.createTask` nor any other
  write service; and
- proves the draft contains no action token or approval credential.

Route and chat-history tests:

- only signed-in staff can request or reload a draft;
- a user cannot load another user's stored draft;
- normalized drafts round-trip through message payloads;
- legacy messages without drafts remain unchanged.

Browser tests:

- card says `Draft — not saved` and has no write control;
- all fields render safely as text;
- Copy and Discard behave locally;
- collapse/expand, recent-chat reopen, and mobile fallback preserve layout and
  the active workspace URL; and
- a model-provided URL, selector, handler name, or HTML string cannot become an
  interactive control.

Run the focused assistant suites and the full scoped regression suite used by
the preceding Ask Casey slices. The live dependency test above is a release
gate, not a substitute for deterministic unit tests.

## Slice A1: reviewed task creation

A1 adds **Review & create task** to a server-normalized draft. Selecting it
first presents a SweetAlert confirmation containing the exact assignee, link,
and dates.
Only an affirmative confirmation posts the normalized fields to the existing
authenticated `POST /api/tasks` route. That established route stamps the
signed-in user as assigner and uses the canonical task insert, audit, linking,
and notification behavior. The model cannot select an endpoint or add request
fields, and no general assistant action endpoint or approval credential exists.

The control disables while its request is in flight. Success changes the card
to **Created** and provides an ordinary task-open action; failure leaves the
draft visible with an inline error. The confirmation plainly warns that task
creation is immediate and can send assignment, start-date, and due-date
notifications.

Creation requires assignee, title, and a clear description to match the native
Tasks UI. Start is optional/null and means not-before; it is never defaulted to
the creation date. Due is optional but recommended for a stated deadline. An
unspecified completion notice defaults off for self-assignment and on for an
assignment to someone else. The browser hard-codes `source:'Casey'`, never sends
`from`, and leaves `send_assignment_email` omitted/true.

## Slice A2: reviewed task lifecycle

A2 adds five closed proposal kinds alongside creation:

- `task.update.v1` maps only requested editable fields to
  `PATCH /api/tasks/:id`;
- `task.complete.v1` maps an optional note to
  `PATCH /api/tasks/:id/complete`;
- `task.cancel.v1` maps an optional note to the reversible soft-delete route
  `PATCH /api/tasks/:id/delete`;
- `task.reopen.v1` maps to `PATCH /api/tasks/:id/reopen`; and
- `task.transfer.v1` maps the validated active assignee to
  `PATCH /api/tasks/:id/transfer` so canonical transfer audit and notification
  behavior are preserved.

Every existing-task proposal must cite current evidence containing the exact
`task_id`. The server reloads that task, validates its current status, resolves
new assignees and links, and rejects extra fields. The browser owns a fixed
kind-to-route/method/body mapping; the model owns none of those. Confirmation,
single-flight behavior, inline retry, task-list/badge refresh, and persisted
applied results follow A1. Reopening a saved chat therefore offers **Open task**
rather than casually replaying the write.

## Slice A3: reviewed Events lifecycle

A3 adds `event.create.v1`, `event.update.v1`, `event.complete.v1`, and
`event.cancel.v1`. The browser maps them only to `POST /api/events`,
`PATCH /api/events/:id`, `PATCH /api/events/:id/complete`, and
`PATCH /api/events/:id/cancel`. There is no Event delete or reopen route, so no
such proposal exists. Batch creation and Appointments remain out of scope.

The traced native field contract is:

- create requires a nonblank title, real firm-local date, explicit all-day
  choice, and a nonblank type for Casey; a timed proposal also requires a
  firm-local `HH:MM[:SS]` time. Type is resolved through the calendar-item
  registry; meeting kinds are rejected because they belong to Appointments;
  known types return their canonical label/key/kind, while custom types are
  explicitly shown as `other`;
- optional create fields are duration (1–1,440 minutes), location, URL, note,
  one verified creation-time link (`case`, `contact`, or `case_number`),
  availability scope, and one reminder task. All-day events normalize time and
  duration to null and availability scope to firm-wide. A null duration on a
  timed Google event means the service's 60-minute default;
- availability scope defaults to null/firm-wide, `0` means blocks nobody, and
  a positive id must resolve to a current appointment provider. A reminder
  requires an assignable staff id and a non-past firm-local date; creating or
  replacing it uses the normal linked Task behavior;
- update permits only type, title, date, time, all-day, duration, location,
  URL, note, availability scope, and reminder. Link identity is immutable after
  create. Status, resolution, calendar selection, dedupe, `skip_gcal`, kind,
  `type_key`, and actor attribution are never model-controlled;
- existing-event proposals require current evidence containing the exact
  `event_id`; the server reloads it and accepts only Scheduled,
  non-superseded targets. Complete defaults to `met` for deadlines and `held`
  otherwise; a reviewed deadline completion may instead be `moot`, while the
  nightly sweep—not a staff action—owns `missed`. Cancel defaults to `cancelled` and `delete_gcal:true`; only a
  deadline may use `moot` on cancel; and
- create attempts Google Calendar creation on the canonical default calendar.
  Updates to title/date/time/all-day/duration/location/URL recreate a synced
  entry; type/note/availability-scope changes do not rewrite an existing Google
  entry. Complete keeps the past entry. Cancel deletes it by default. Complete
  and cancel cancel active Event reminder tasks.

The card and SweetAlert render every normalized value plus those side effects
as text. Review and write are single-flight; cancellation writes nothing;
failures leave the proposal retryable. A successful result is persisted in chat
history and reopening offers **Open event**. The existing `yc-sync` create,
update, complete, and cancel matchers already turn the canonical browser calls
into `event:<id>` refetch markers consumed by the Events tab, Calendar, and
case/contact readers, so A3 required no Casey-specific or canonical bus change.

## Roadmap

This is the source of truth for the actions arc. A
listed slice is a direction, not permission to expose every field accepted by
the named route. Each slice starts by tracing the canonical route, service,
native callers, permissions, audit, side effects, response, and sync readers.
It then chooses a smaller closed contract. Each slice retains one proposal per
answer and the governing user-through-browser boundary above.

The sequence is deliberate: finish common, reversible record work before
external sends, fan-out, configuration, or destructive operations. A slice may
be split again when tracing reveals materially different side effects. It must
not be combined with its neighbors merely to reduce the number of releases.

### Action slices

#### A4: Appointments core lifecycle — shipped 2026-10-20

Separate proposal kinds implement create, whitelisted edit, attended, no-show,
and cancel through the existing `/api/appts*` routes. Provider/type rules,
duration, firm-local/UTC semantics, contact/case linkage, automation, Google Calendar,
attendee/staff notices, and cancellation effects are reflected in the closed
schemas and review. Existing actions require current exact-`appt_id` evidence
and a server reload; review identifies everyone who may be notified.

#### A4.1: Appointment reschedule — shipped 2026-10-20

Reschedule remains its own higher-impact contract within the same release. The
canonical route creates a successor or marks the predecessor for later,
retires/links the old row, moves calendar entries, and can send different
notices from an ordinary edit. Review shows old/new slots, provider,
participants, case/contact linkage, calendar effects, and every notice. It is never
implemented as a generic appointment patch.

The shipped contract has seven proposal kinds: `appt.create.v1`,
`appt.update.v1`, `appt.attended.v1`, `appt.no_show.v1`, `appt.cancel.v1`,
`appt.reschedule.v1`, and `appt.reschedule_later.v1`. Create requires a
verified contact, active meeting type, 1–1,440 minute length, platform, future
firm-local date/time, and active appointment provider; optional case linked to
that contact, note, and reviewed SMS/email confirmation are supported. The server resolves the
canonical type key and labels; the browser alone maps the normalized proposal
to `/api/appts*`, and the route supplies `source:'staff'` and authenticated
actor identity.

The generic PATCH route does not update Google Calendar or appointment
automation. A4 therefore limits update to complete-note replacement and case
link change; date/time changes use reschedule, while type/length/platform/
provider changes remain excluded. Existing actions require current evidence
with the exact `appt_id`, reload the target, and reject terminal Canceled or
Rescheduled state. Attended and no-show can correct one another; cancel and
either reschedule form also accept Attended/No Show because the native UI does.

No-show defaults enrollment off and states its possible sequence/pipeline
effects. Cancel defaults Google Calendar deletion on and follow-up task off;
optional client SMS/email requires the exact reviewed message. Reschedule-now
retires the predecessor, deletes its firm/provider calendar entries and
automation, creates a lineage-linked successor, re-creates calendars and
automation, and opens the successor. Reschedule-later creates no successor,
deletes calendar entries/automation, and may create the reviewed follow-up
task. Create also discloses firm/provider calendar attempts, reminder-sequence
enrollment, no-show-sequence cancellation, and singleton supersession.

The canonical `yc-sync` matchers already cover create, narrow update,
attended, no-show, cancel, and both reschedule result IDs, so no bus or
Casey-specific emit changed. Applied results persist and reopen as **Open
appointment**. Focused assistant/chat/sync, native route, Appointment service,
Calendar, case/contact sync, and unified-events suites passed.

#### A5: Contact phone, email, and address records

Ship one subrecord family at a time through the dedicated contact routes.
Start with create and narrow update; add deactivate/delete only where the
native operation is reversible or its impact is fully understood. Normalize
labels, primary/preferred flags, and duplicate rules, and show the parent
contact plus the complete value being changed. One proposal changes one
subrecord. Verify that contact detail views receive the canonical sync marker.

#### A6: Contact relations and roles

Add relation and role create/update/remove separately from scalar contact
editing. Resolve both ends and the role/type registry on the server, protect
directionality and uniqueness rules, and display the relationship in plain
language. Firm-level role-type administration is not part of this slice.

#### A7: Narrow scalar contact and case edits

Expose small field groups rather than the broad bodies accepted by
`PATCH /api/contacts/:id` and `PATCH /api/cases/:id`. Every proposal shows
before and after values and carries a server-owned stale-value/version check
through confirmation. Start with low-impact descriptive fields. Identity,
access, merge, docket, intake ownership, and pipeline state remain excluded.

#### A8: Case-contact membership

Add, remove, or change one case/contact membership through the dedicated case
contact routes. Preserve primary-contact, role, and last-contact invariants;
show both records, old and new role, and any primary-contact effect. This is
separate from both contact roles and scalar case editing because it changes a
set and can alter downstream addressing.

#### A9: Case pipeline transitions and requirement overrides

Add advance and explicit move as different proposal kinds. The proposal must
show the current and destination stages, unmet requirements, downstream
automation, and any note or notification effect. Requirement override and
override removal are a later sub-slice with their own reason and permission
contract; Casey must never manufacture or conceal a blocker.

#### A10: Checklists and checklist items

Start with creating a checklist or one item and updating/completing one item.
Template expansion, upsert-many, reorder, and deletion remain separate because
they can create or affect many records. Resolve the parent entity and template
server-side, display generated item counts, and verify collection-level sync.

#### A11: Documents

Begin with metadata-only register/link/update operations whose file already
exists in the browser-controlled upload flow. Upload bytes, signed upload URLs,
and provider credentials never become model output. Generation, sharing,
relinking, external-store sync, unlinking, replacement, and deletion are each
separate higher-impact sub-slices with exact destination, filename/template,
overwrite, link, recipient, and external-provider effects shown in review.

#### A12: Forms and form templates

Start with a form draft or prefill and save/link it to a resolved record.
Submission, PDF filing, template editing, publishing, visibility changes,
version restore, and deletion are separate proposal kinds and later releases.
Render the template/version, destination, material answers, overwrite behavior,
and whether the operation makes anything client-visible.

#### A13: Message triage and communication drafts

Low-risk communication work comes first: mark a known message read/unread,
link one message to a case, or prepare a non-sent email/SMS draft where a
canonical draft operation exists. A draft must be visibly non-sent. Never
reinterpret an endpoint that sends immediately as a draft endpoint.

#### A14: Outbound email and SMS

Sending is an irreversible external side effect and is not an extension of a
draft slice. Use distinct proposal kinds for email and SMS/MMS through their
canonical routes. Review the resolved from identity, exact recipients, subject
and body, attachments/media, schedule, link/audit destination, opt-out or
consent constraints, and audience count. Require a fresh send confirmation,
strong idempotency, and an unambiguous delivered/queued/failed result.

#### A15: E-signature lifecycle

Separate send, remind, resend, recall, and mark-satisfied-externally. Resolve
the envelope, template/file, signers, routing order, message, expiration, and
case/document links server-side. Show all recipients and external effects.
File bytes remain browser-owned, and recall or external satisfaction requires
especially clear finality and stale-state checks.

#### A16: Reports

Start with a report draft and preview. Save, update, run, export, share/lock,
and delete are different proposal kinds. Server validation owns the allowed
data source, filters, columns, scope, and limits; the model cannot supply query
text. Review potentially large result/export scopes and access implications
before executing or sharing.

#### A17: Workflow definitions and executions

Split the family into independently releasable steps: draft a disabled
workflow from a closed step registry; validate/preview it; save the disabled
draft; edit one versioned definition; publish; start; and cancel/resume one
known execution. Duplicate, capture, reorder, test-step, bulk creation, and
delete remain separate. Never accept arbitrary workflow step JSON, code, URLs,
credentials, or model-selected tools. Publishing and starting require an
impact preview covering triggers, scope, estimated fan-out, writes, external
calls, rollback/compensation, and version.

#### A18: Sequences and trigger rules

Treat communication sequences and event triggers separately from workflows,
even where their editors look similar. Draft/preview a template or rule first;
then versioned save, publish, enroll, cancel, recover, fire-next, enable, and
replay as individual kinds. Enrollment and replay require an exact audience or
event, step schedule, channel effects, fan-out count, and idempotency plan.
Bulk enrollment and arbitrary captured steps are not initial contracts.

### Secondary action candidates

The route inventory also exposes useful but lower-priority candidates. Add
them to the relevant family only after native behavior is traced: document
share/relink and sync controls; e-sign reminder/resend; form-submission PDF
filing and linking; mail views and trusted-image settings; report locks;
workflow/sequence duplication and capture; and appointment/pipeline override
utilities. Their existence in the API is not itself a reason to expose them to
Casey.

### Not on the ordinary action roadmap

These need a dedicated product and threat-model decision before they can become
planned implementation slices:

- case/contact merge, permanent file or record deletion, and bulk mutation;
- credentials, OAuth, API keys, impersonation, user/access/entitlement changes,
  portal administration, and firm-wide settings;
- arbitrary database writes, code, SQL, URLs, endpoint selection, or tool/API
  invocation chosen by the model;
- Court Review force-apply and comparable legal-decision overrides;
- conditional or multi-action plans, unattended/background execution, and
  autonomous retries of writes; and
- personality changes or broader/longer autonomous read budgets.

## Platform and release slices (work besides adding actions)

These are first-class roadmap items. Some run beside an action family; others
are gates before higher-impact families. None creates a general Casey executor.

#### P0: Close current release gates

Run the controlled multi-round dependency-read test described above. Add a
staff-fixture smoke test for shipped Task, Event, and Appointment review, cancellation,
success, history restoration, and canonical open-record behavior. Record the
known repository-wide stale-test baseline separately from action regressions.

#### P1: Closed action registry and shared review components

After the third family establishes another concrete contract, extract only the
repeated mechanics: known kind/version dispatch, strict extra-field rejection,
evidence resolution, text-only value/side-effect rows, dialog single-flight,
retry state, applied-result persistence, and canonical open-record links. The
server registry normalizes proposals; the browser registry independently maps
each known kind to its fixed route/method/body. Neither registry accepts a URL,
method, selector, handler, arbitrary body, or actor from model output.

#### P2: Permission and capability matrix

Inventory route authentication, role/capability checks, row-level/firm scope,
and native UI visibility for every proposed kind. Normalize only what the
current signed-in user may review, but keep the canonical write route as the
final authority. Add negative tests for cross-firm IDs, inactive records,
insufficient roles, and permissions changing between proposal and click.

#### P3: Optimistic concurrency and stale review protection

Existing-record actions must protect the interval between server normalization
and confirmation. Define a canonical version, updated-at value, or narrow
before-value precondition for routes that lack one, and reject a write when the
reviewed state has changed. This is required before scalar edits, relationship
changes, pipeline transitions, publishing, and other operations where a stale
review could overwrite someone else's work.

#### P4: Durable idempotency and ambiguous-result recovery

Browser single-flight prevents double-clicks but does not solve a timeout after
the server committed. Add canonical, user-scoped idempotency support to create,
send, enroll, start, replay, and fan-out operations before exposing the risky
families. Reconciliation must distinguish not-applied, applied, and unknown;
it must never blindly retry an unknown send. The key is browser/server-owned,
not model-chosen, and the same protection should benefit native callers where
appropriate.

#### P5: Durable applied-result persistence

Make success restoration resilient when the canonical write succeeds but chat
history persistence fails. Preserve the canonical result needed to reopen the
record, retry result persistence without replaying the write, and reconcile on
chat reopen. Define retention and migration behavior for old kind versions and
legacy messages. Never store auth/session credentials or raw sensitive
evidence in the action payload.

#### P6: Canonical sync coverage program

Maintain a route-to-entity matcher/reader matrix and deterministic propagation
tests for every family. Close the known canonical Tasks bus gap as its own
native Tasks/`yc-sync` slice if cross-frame refresh is desired. Cover
server-side writers that browser fetch sniffing cannot observe with domain
events at the canonical service—not Casey-only emissions—and define scoped
set-change markers for collections.

#### P7: Audit and observability

Verify that every canonical action records the authenticated actor and ordinary
audit event. Add privacy-safe correlation and metrics for proposal accepted or
rejected, review opened, user canceled, write attempted, succeeded, failed, or
reconciled, plus latency and action kind/version. Do not log message bodies,
session keys, auth headers, raw evidence, or sensitive field values. Alert on
duplicate/ambiguous writes and sustained validation or sync failures.

#### P8: Reusable contract and adversarial test kit

Provide shared deterministic fixtures/assertions for strict schemas, exact
evidence IDs, stale and unauthorized state, safe text rendering, confirmation
cancellation, exact route/method/body mapping, single-flight, failure/retry,
ambiguous outcomes, history restoration, open-record behavior, and bus
propagation. Add prompt-injection and malicious-value cases and a route contract
test that fails if a canonical endpoint changes incompatibly.

#### P9: Review UX, accessibility, and explainability

Standardize compact before/after rows, firm-timezone labels, side-effect and
irreversibility warnings, large-recipient/fan-out summaries, loading/error/
unknown-result states, keyboard/focus behavior, mobile layout, and screen-reader
labels. Add an action-kind catalog so staff can tell what Casey can propose and
why a refused action is unavailable. Keep every material value inspectable as
text before confirmation.

#### P10: Rollout, operations, and governance

Add per-family feature flags and a kill switch, start with a small staff cohort,
and define owner, dashboards, support/recovery playbook, rollback criteria, and
manual/training updates. Each release needs permission-negative tests, native
route regression tests, canonical sync tests, and a controlled live smoke test.
Higher-impact families require explicit security/privacy review and an owner
for external-side-effect incidents.

## Recommended execution order

1. Close P0 and continue P2, P7, and P8 alongside the shipped A4/A4.1 contract.
2. Implement A5–A8 with P3 in place; extract P1 only from demonstrated common
   behavior, not as a speculative generic executor.
3. Implement A9–A12 and complete the collection-sync portions of P6.
4. Complete P4 and P5 before A14, A15, A17 execution, or A18 enrollment/replay;
   A13 draft/triage and A16 draft/preview can proceed earlier.
5. Expand via P10 gates. Keep destructive/admin/bulk/autonomous work outside
   the ordinary roadmap until separately approved.

For the upcoming review, the key decisions are whether this ordering is right,
which low-impact scalar fields belong in A7, whether delete variants in A5/A6
should be deferred entirely, and what operational bar must be met before the
first external-send or fan-out action. The immediate engineering slice is now
A5 contact phone, email, and address records, one subrecord family at a time.
