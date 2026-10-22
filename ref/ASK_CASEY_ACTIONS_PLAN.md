# Ask Casey typed actions plan

Status: A0/A0.1, A1, A2, A3, A4, A4.1, and A5 implemented 2026-10-20. A2 covers
the complete Task lifecycle; A3 covers reviewed Event create/update/complete/
cancel; A4/A4.1 cover reviewed Appointment create, narrow update, attended,
no-show, cancel, reschedule-now, and reschedule-later through the existing
authenticated routes. A5 covers one reviewed phone/email/address subrecord
create, narrow update, or history-preserving end. No general action executor is introduced.
The 2026-10-21 independent-review fix package (branch `fix/casey`) amends this
plan — see **Course corrections** below; where they conflict, it wins.
The automation-authoring family (A17 workflows, A18 sequences and trigger
rules) was planned in a dedicated session on 2026-10-22 and now carries slice
contracts and three platform prerequisites (P11-P13); nothing in it is built.

## Review briefing

The shipped baseline is 26 proposal kinds across four reviewed families: the
complete Task lifecycle, Event create/update/complete/cancel, the seven
Appointment actions, and nine contact phone/email/address actions. Every family
uses the same boundary: one
closed, evidence-backed, server-normalized proposal; exact SweetAlert review;
a fixed browser-owned route/method/body mapping; the ordinary authenticated
route as the write authority; persisted success; and canonical sync behavior.
No Casey execution endpoint, model-selected route, or model-selected actor
exists.

Deterministic tests cover the shipped contracts, but the review should not
mistake that for completion of the operational program. The following remain
open before wider rollout or before the higher-impact families that depend on
them:

- P0: a controlled live multi-round dependency-read test and a staff-fixture
  smoke test spanning Task, Event, Appointment, and contact-subrecord review,
  cancellation, success, history restoration, and canonical open-record behavior;
- P1/P2/P3: decide when to extract the closed registries/review components,
  complete the permission matrix, and extend stale-review protection beyond
  the row-version/current-primary checks already shipped with A5;
- P4/P5: durable idempotency and ambiguous-result/applied-result recovery before
  any external send, enrollment, fan-out, workflow execution, or replay;
- P6-P9: canonical sync inventory, privacy-safe action observability, the shared
  adversarial contract kit, and accessible/explainable review states; and
- P10: per-family rollout controls, ownership, dashboards, recovery playbooks,
  rollback criteria, and controlled live smoke tests.

Decisions requested in the upcoming review are: confirm the A6-A18 ordering;
decide whether A6 relation removal and role removal ship with creation/update or
as later sub-slices; choose the first low-impact A7 scalar fields; set the P1
extraction point; and define the rollout bar for the first external-send or
fan-out action. Destructive/admin/access/credential work, arbitrary tools,
multi-action plans, and unattended execution remain outside this roadmap.

## Course corrections from the independent review (2026-10-21)

The review (Fable-consolidated, six Opus reviewers) found the per-family
reviewed-action pattern right and consistently applied, and these gaps. The
fix package on `fix/casey` addressed what is marked SHIPPED; the rest is now
part of this plan.

1. **Click-time freshness is a required recipe step for every new family
   (A6 onward).** Proposal-time validation alone let a stale card replay a
   write. Each new kind must either re-read its target at click time through a
   canonical read route and refuse when the reviewed state changed, or carry a
   server-checked precondition (P3). SHIPPED interim for the four existing
   families: a card is offered for writing only within 15 minutes of arriving
   and never when reopened from saved history (it re-asks instead), re-checked
   after the review dialog; `apptService` now refuses repeat cancel/reschedule
   for every caller with a conditional status UPDATE.
2. **P5 and minimal P4 come before A6.** SHIPPED interim: the applied marker is
   saved as a required write (one retry); the card's button stays disabled until
   it settles and a failure is shown loudly. Still to build: durable
   server-side applied state (P5) and a browser/server idempotency key on
   creates (P4) — two tabs can still double-apply a create.
3. **No client sends inside A4 until A14.** SHIPPED: appointment create/cancel/
   reschedule proposals force SMS/email off and drop the model-authored message
   in the normalizer and again in the browser body. The confirmation path
   resolves `{{…}}` placeholders (`contacts.contact_ssn` resolves since the
   2026-09-24 ruling), so model-authored client text waits for A14's resolved
   preview, explicit recipients, and idempotency.
4. **P1 extraction is next, before A6.** Four ~150-line families already live
   in `public/assistant.html`; thirteen more are planned. Extract the repeated
   mechanics (freshness, single-flight, marker persistence, review rows) first.
   SHIPPED for the browser: one `ACTION_FAMILIES` registry and one shared
   engine — see P1 below.
5. **Real-MySQL harness for normalizer SQL.** `appt.create.v1` shipped dead
   (`user_auth = 1` against a varchar) because the unit suite mocked the users
   query. SHIPPED: the predicate now reuses `taskService.findAssignableStaff`'s,
   and the gated `tests/assistantNormalizer.mysql.test.js` runs normalizer SQL
   on a real engine. Every new family adds its predicates there.
6. Also SHIPPED: `end_reason` capped at its `varchar(40)` width in browser and
   server (relaxed sql_mode would truncate silently); Casey address creates
   leave `start_date` NULL like the native path; the forced action-draft repair
   no longer fires on questions about a record and never replaces a real
   answer; the firm monthly spend cap `assistant_ai_monthly_cap_cents`; chat
   rate limit and per-chat message cap; server identity/workspace blocks moved
   to the system prompt segment; the denied-column scan ignores string literals.

**Defaults pending Fred's ruling** (he answered "idk"; each default stands until
he rules):
- A15 (e-signature), A17 (workflows), A18 (sequences/trigger rules): RULED —
  Fred, 2026-10-22: workflow/sequence authoring is the STRATEGIC CORE of the
  Casey integration, not an optional extra ("90% of the reason to have an AI
  integration": Casey creating, editing, debugging and explaining the
  template-driven automations for non-dev users, especially under YCv3). The
  2026-10-21 review's "questionable for a four-user firm" framing is
  superseded. A17/A18 stay on the roadmap; their detailed plan (and A15's
  place) comes out of a dedicated Casey planning session with Fred — nothing
  that session ran
  2026-10-22: its rulings and the resulting slice plan are in A17/A18 below,
  and A15 keeps its place after A14.
- Draft lifetime — expire vs click-time revalidation: default is expiry (15-min
  TTL + no write from history) for the existing families; new families add
  click-time revalidation per correction 1.
- `end_reason`: default is free text capped at 40 characters. Alternatives:
  widen the columns (migration) or map to the native codes (`ended` /
  `replaced` / `transferred`) with the text in notes.
- Casey tasks land in the machine-Notices preset via `source:'Casey'`; the
  completion-notice default differs from the native form. Default: unchanged.
- Opus remains the `better_quality` default model.
- A6 remove variants: the review recommends deferring them; default deferred.

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

This is an idea, not a prohibition (Fred, 2026-10-22). The test to apply is
whether the endpoint would **perform the legal action**: that must stay with
the user's ordinary route, triggered by the user's own click. An endpoint that
only records or reconciles what the user already did — P5's applied ledger is
the worked example — writes no business record and is ordinary engineering.
"Almost every action" is the standard: the exceptions are bookkeeping, never a
second way to write business records.

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
autonomous-read slices. It now covers the shipped Task, Event, Appointment, and
contact-subrecord proposal families plus the remaining A6-A18 and P0-P10
roadmap. Merely returning any proposal changes nothing; only the user's explicit
confirmation invokes that kind's fixed, existing application route.

## Read-loop release gate

The October 20 smoke test successfully ran `sql.read`, `manual.search`, and
`comms.search` as three steps in one read pass. It establishes that all three
readers can coexist in one investigation. It does not exercise the evidence →
missing fact → follow-up read loop: the result reported one round and stopped
with `model_finished`.

Before wider production rollout of reviewed actions, run one live dependency
test whose second lookup cannot be formed until the first result is known. This
is still open; the deterministic action suites do not close it. A suitable
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

## Slice A0: task proposal, not task creation — shipped 2026-10-20

### User experience

Ask Casey may finish a bounded read investigation with an ordinary answer and
one optional **Task draft** card. The card shows:

- title and description;
- proposed assignee;
- optional contact, case, appointment, or event link;
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

## Shipped test contract for A0

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

## Slice A1: reviewed task creation — shipped 2026-10-20

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

## Slice A2: reviewed task lifecycle — shipped 2026-10-20

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

## Slice A3: reviewed Events lifecycle — shipped 2026-10-20

A3 adds `event.create.v1`, `event.update.v1`, `event.complete.v1`, and
`event.cancel.v1`. The browser maps them only to `POST /api/events`,
`PATCH /api/events/:id`, `PATCH /api/events/:id/complete`, and
`PATCH /api/events/:id/cancel`. There is no Event delete or reopen route, so no
such proposal exists. Batch creation remains out of scope. Appointments were
outside A3 and shipped separately under A4/A4.1.

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
that contact and note are supported. Client SMS/email is forced off (course
correction 3). The server resolves the
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
it sends nothing to the client (course correction 3). Reschedule-now
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

#### A5: Contact phone, email, and address records — shipped 2026-10-20

Nine closed kinds cover create, narrow update, and history-preserving end for exactly
one phone, email, or address through `/api/contact-*`. Create requires current
exact-parent evidence. Update/end require a single evidence row with the exact
parent and subrecord IDs, then reload the active row. Phone/email ownership
transfer, hard DELETE, verified state, reactivation, start-date edits, explicit
primary demotion, scalar contact edits, and batch changes remain excluded.

Phone/email updates expose label, notes, primary promotion, and their explicit
opt-out/MMS fields; their values remain immutable. Address update exposes its
parts, label, notes, and primary promotion. Create normalizes native labels,
values, defaults, first-row auto-promotion, collision/ownership-window rules,
and an exact non-future ownership start (an address with no stated start keeps
NULL, "since forever", as natively). End requires a non-future date and a reason of
at most 40 characters (the column width) and keeps history. Review shows the complete value, before/after fields, consent values,
current-primary demotion, mirror recomputation, and absence of messages or
ownership transfer.

P3 begins here: update/end carry server-owned `updated_at`; primary-changing
writes also carry the reviewed current-primary ID (including explicit none).
The canonical routes/services lock and reject stale state before writing.
Native callers remain compatible because these preconditions are optional
outside reviewed proposals.
The canonical `yc-sync` matchers now announce phone/email/address create and
PATCH recipients to all open contact readers, plus the existing donor marker
for native forced phone/email transfers. No Casey-only emit exists. Applied
results persist and open the parent contact.

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

Planned 2026-10-22 in a dedicated session; the rulings block follows. Twelve
independently releasable slices (A17.0-A17.8, with A17.4a-A17.4c) sit behind
three platform prerequisites (P11-P13). Authoring targets the **YCv2 editors that ship
today**, not YCv3.

**A17/A18 rulings — Fred, 2026-10-22 planning session.**

1. **Read-only explanation ships first, as its own slice** (A17.0), before any
   authoring write.
2. **Authoring targets YCv2's current editors**, not YCv3.
3. **Publish stays a separate step from drafting** — allowed, but never folded
   into the slice that writes the draft (A17.6, A18.3).
4. **All staff may use it for now.** This widens nothing: every workflow,
   sequence and trigger route is already open to any authorized staff JWT, and
   `automations.manage` gates only hooks and pages. Casey's write slices must
   read **one** per-family flag so that gating them to `automations.manage` —
   or to whatever automations role control lands on — is a one-line change
   later.
5. **Casey must explain a run**, not only a definition: what went wrong, what
   to do about it, and the usual responses (A17.1, A18.0).
6. **Code steps**: Casey never authors a STANDARD-mode `custom_code` body, but
   it does explain how to add one, insert an inert **stub** step, and hand over
   copyable code for the user to paste (A17.4c). The rules reference that makes
   this trustworthy is part of that slice. Safe-mode bodies are a later
   revision — ruling 13.
7. **Webhook steps are allowed** (A17.4b). They are the best-validated step
   type in the system and run through the correct outbound-auth path; the
   earlier blanket exclusion was wrong. The narrow part is the destination and
   the credential, not the step type.
8. **`query_db` authoring is planned**, not deferred (A17.4a).
9. **Casey may read `custom_code` bodies** (Fred, 2026-10-22). P12 therefore
   redacts webhook URLs and resolved payloads but not code. This is what makes
   A17.0/A17.1 able to explain and debug the 41 live code steps, which is most
   of the "debug and explain" goal.
10. **P11 may tighten the human editor** — rejecting an unknown
    `function_name` at save, and a `type` key in a sequence `action_config` —
    confirmed by Fred, 2026-10-22.
11. **P12 is the typed Casey read kind**, not a widened Reports manifest
    (Fred, 2026-10-22).
12. **Trigger rules get an audit trail and a stale-write guard, not
    draft/publish** (Fred delegated the call, 2026-10-22). Reasoning in
    *Trigger rules* under A18.
13. **Safe-mode code authoring is GO** (Fred, 2026-10-22, safe-mode session):
    with `code_mode:'safe'` landed (QuickJS/WASM guest engine inside the
    scrubbed child — `lib/safeCodeRunner.js`, dispatch failing closed on every
    execution path), Casey may author SAFE-mode bodies. The "never composes
    code" rule now scopes to STANDARD mode, which keeps the A17.4c stub +
    copyable treatment. The authoring slice still ships under the A17 review
    contract (show-before-save, A17.2 dry-run): containment makes an escape
    find nothing — it does not make a wrong output or its downstream sends
    harmless. Fred's stated goal is Casey authoring complete automations,
    safely. **First kind shipped same day (safe-mode S3):**
    `job.code_safe.create.v1` — a ONE-TIME safe-mode scheduled job through
    `POST /scheduled-jobs` on the P1 card engine, with the safe engine pinned
    in the fixed request builder, optional evidence (0-8 refs), the
    `casey_code_actions_enabled` off switch (ruling 4's per-family flag), and
    route idempotency wired so the card's draft_id dedupes the create.
    Workflow-STEP code authoring is deliberately NOT this: it stays with
    A17.4c behind the A17 ladder (A17.0 read-only explain first).
    **Shipped lesson (same day): a kind must be taught to EVERY model stage.**
    S3 taught only the ANSWER prompt; the PLAN prompt enumerates the reviewed
    families and says "Unlisted writes remain unavailable", so the planner
    refused "schedule a job" an hour after the capability landed — and a
    manual-search hit one turn later made the model claim the opposite, then
    refuse again (assistant_chat_messages chat 26). Fixed by teaching plan /
    repair / investigate and the forced-draft heuristic;
    `tests/assistantPromptKinds.test.js` now asserts every shipped kind
    against every stage, so the next family cannot repeat this.
    **Second lesson, same test (chat 27):** the planner's direct
    `{"action":"answer"}` shape has NO action_draft slot, so a planner that
    answers an action request directly produces confident, cardless prose
    ("approve it through the review card") — the stage that can emit the card
    never runs. Fixed twice over: the plan prompt now says ALWAYS plan for a
    job request (as the other families already did), and `plan()` carries a
    server backstop converting a direct answer into a one-step carrier plan
    whenever `taskDraftRequested` is true — prompt-rule compliance is no
    longer the only thing standing between a request and its card.

**Defaults recorded for this family** (each stands until Fred rules otherwise):

- P12 read surface: a typed Casey read kind, **not** a widened Reports
  manifest.
- `custom_code` bodies and webhook URLs are **redacted** in what Casey reads.
- Casey may publish a draft containing steps it did not author and cannot
  explain, after showing them redacted and taking an explicit acknowledgment.
- New-workflow drafting (A17.3) ships before editing an existing workflow
  (A17.4).
- `query_db` authoring is **deferred** to a later sub-slice, not excluded
  forever.
- Trigger-rule authoring is **deferred** pending a native draft/publish model
  for trigger rules; Casey gets explain and dry-run only.

**A15 (e-signature) keeps its place, after A14.** It is not part of
automation authoring and has no dependency on A17/A18: every A15 action —
send, remind, resend, recall, mark-satisfied-externally — is an irreversible
external send, so it inherits A14's resolved-recipient preview, idempotency
and unambiguous-outcome machinery and should follow it directly.

**The measured ground** (live DB + code, 2026-10-22). The plan fits these
numbers, not an imagined subsystem:

- 42 workflows, 24 sequence templates, 23 trigger rules, 37 hooks. The largest
  workflow is 50 steps / 38 KB of step config; the largest single step config
  is 20 KB.
- Of the ~330 steps on live published versions: 71 `evaluate_condition`, 41
  `custom_code`, 34 `query_db`, 32 `set_next`, 30 `send_email`, 24 `webhook`,
  13 `create_task`, then a long tail. **A17's "never arbitrary code, URLs,
  credentials" rule therefore excludes a large share of what the firm actually
  runs** (see *What Casey cannot author*). That is a scope fact to state out
  loud, not a reason to loosen the rule.
- Every human publish on record is IT's: 42 workflow versions and 10 sequence
  versions, the rest being the 2026-08-18 backfill and two seeds. Casey
  authoring makes the six staff-only users first-time automation authors.
- 90-day run health: 7,694 `completed`, 11 `completed_with_errors`, 4 `failed`,
  4 `cancelled`, 2 `held`; ten distinct failing (workflow, step) pairs at 1-2
  occurrences each. **Hard failure is rare — "it ran and did the wrong thing"
  is the common question**, which is why A17.1 reconstructs branches and skip
  reasons rather than only reading `error_message`.
- Sequence step log, 90 days: 268 `sent`, 83 skipped `unschedulable`, 41
  `step_condition_failed`, 2 `fire_guard_failed`, 2 `failed`. The skip-reason
  vocabulary *is* the sequence debugging surface.

**Where the write authority is, measured.** Every workflow, execution,
sequence and trigger route is `jwtOrApiKey` and nothing else: no role,
capability or SU gate exists on any of them (`automations.manage` is defined
as "Manage workflows, sequences and trigger rules" but is mounted only on
`/api/hooks` and `/api/pages` — a known follow-up, `ref/plans.md`). So A17/A18
inherit no authorization from the route, and the P2 finding generalizes: on
this family the canonical route is **not** a validation authority either.
Measured gaps, all on the human path too:

- An unknown or misspelled `function_name` passes save on a workflow step (no
  `__meta` found means permissive); it fails only at run time.
- Undeclared param keys are never rejected, `params: null` skips validation,
  and `error_policy.strategy` is not validated at all (any string behaves as
  `ignore`).
- Sequence `sms`/`email`/`task`/`internal_function` steps get **no** param
  validation: no `function_name` check, no `__meta` check.
- Publish re-runs shape and branch-target validation but **not** `__meta` param
  validation, and never checks that a `function_name` exists.
- No step-mutating route and no publish route has any optimistic-concurrency
  check. Steps are addressed by `step_number`, which is a *position*, so a PUT
  from a stale view lands on whichever step now occupies that slot — the wf27
  scar as a live route property.

P11 closes these in the canonical route, for both paths, before any A17 write.

**What Casey cannot author (initial contract).** Excluded by construction: a
STANDARD-mode `custom_code` **body** (A17.4c adds an inert stub plus copyable
code instead; safe-mode bodies are ruling 13's later revision),
every function carrying a `credential_id` or a fetched URL, `update_db` /
`insert_db` / `set_setting` (generic writes), `create_cta` (mints public bearer
links with nested step plans), `start_workflow` and `enroll_sequence` (chained
fan-out), the esign `on_signed`/`on_declined` targets, and every EXTERNAL-SEND
function (`send_sms`, `send_email`, `send_mms`, `esign_*`, the digests and
sweeps) until A14's send machinery exists.

`__meta` records no side-effect class for any of the 104 registry functions,
and the CTA-eligible set is far too wide to stand in for one (it still admits
`update_db`, `insert_db`, `set_setting` and the senders), so **A17 needs its
own allowlist with a side-effect class per function**. Casey explains every
step; it authors only allowlisted ones, and says so plainly when a step is
outside its allowlist.

All three step *types* are reachable: `internal_function` (A17.4),
`query_db` as its bounded special case (A17.4a), `webhook` under a narrow
destination-and-credential contract (A17.4b), and `custom_code` as a stub the
user fills (A17.4c) or, since ruling 13, a safe-mode body Casey writes. What
stays closed is the model composing STANDARD-mode code, inventing a
destination, or choosing a credential for a new host.

**Sync bus.** No workflow, execution, step, sequence, enrollment or trigger
route appears in `public/js/yc-sync.js` MATCHERS; the bus header classes
workflows as server-side writers outside it. A Casey draft-step write is
therefore invisible to an editor open in another frame — and so is a human's.
Per the standing rule this slice adds **no Casey-only emit**: the protection is
P11's server-enforced expected-base precondition, which refuses the stale write
on either path. A canonical automations/bus slice is filed to `ref/plans.md`.

---

**A17.0: Explain a workflow (read-only). SHIPPED 2026-10-22** — served by P12
(the typed read surface renders exactly the per-step projection and inbound
references this slice asks for) plus the plan-prompt guidance steering
automation questions to those kinds. Original spec:

Casey answers "what does this workflow do", "who gets notified", "what happens
if step 7 fails", "what starts this". No proposal, no `action_draft`, no write
of any kind — so it needs no freshness, idempotency or permission contract
beyond the existing read limits. Depends on P12 (the read surface) and reads
better with P13 (the open-workflow id).

Renders, per step: number, label, type, function, a param digest, the branch
targets resolved into plain language, the error policy as the engine actually
applies it, and the side-effect class. Plus the inbound references — which
hooks, trigger rules, forms, CTA plans, sequence steps or parent workflows can
start it — because "what starts this" is unanswerable from the definition
alone. Where the check lives: the P12 read service (projection, redaction,
caps); nothing else can be wrong here.

**A17.1: Explain a run (read-only). SHIPPED 2026-10-22** — `automation.run`
(P12) carries the history; `lib/aiPrompts/automationRunExplainer.js` carries
the six traps below and the curated cause catalog, appended to the answer
stage ONLY when automation evidence was read (zero cost elsewhere); the two
false manual claims (trap 1's and trap 2's) are corrected in
`manual/03-YisraFlow/08-error-policies.md` in the same slice. Original spec:

Fred's addition, 2026-10-22: "explain a
run, like what went wrong, based on that how to fix, usual responses".

Reads one execution: its pinned version's definition, the
`workflow_execution_steps` history, `init_data` versus final `variables`,
`cancel_reason`, any pending `workflow_resume` job and its `data.nextStep`,
pending `decision_requests`, and the `system_alerts` rows for that run. Output
is: what ran in order, where control actually went, what diverged from the
author's apparent intent, the likely cause, and the fix **as instructions to
the human** — this slice proposes nothing.

Six engine traps the explainer must encode, each measured in code rather than
taken from the manual:

1. `executeStep` hardcodes `success: true` on any non-throwing return, so a
   function that returns `{success:false}` is recorded as a **success** row
   with the failure inside `output_data`. There are 12 such return sites
   (`esign.js`, `reports.js`, `system.js`). Reading `status` alone misreports
   these runs. (`manual/03-YisraFlow/08-error-policies.md` claims
   `success:false` counts as a failure — filed as doc debt.)
2. Retries run for **every** strategy while `attempt <= max_retries`, before
   the strategy is consulted; `abort` with `max_retries: 2` does retry. The
   same chapter says otherwise — filed.
3. `workflow_execution_steps.attempts` is never written (always 0), so retry
   counts cannot be read from history.
4. `output_data` is NULL on failure; `resolved_config` is the pre-execution
   config, so `set_vars` entries referencing `{{this.*}}` appear blank there by
   design.
5. Unresolved workflow placeholders become `''` **silently**, and workflow
   templating has no modifiers, so `{{x|default:y}}` and `{{contacts.col}}`
   both resolve to empty. A blank value in `resolved_config` is the single most
   likely cause of a "ran but did nothing" report.
6. `completed_with_errors` means *any* history row failed, including rows from
   before a resume.

Also carries the ten real failure shapes measured above (missing required
param, webhook 401, provider timeout, Dropbox 409 conflict, unknown column in a
code step, already-enrolled) as a curated known-cause catalog. The catalog is
**curated guidance grounded in a manual chapter plus the specific stored row**,
not model invention: "usual responses" that Casey makes up are worse than none.

**A17.2: Validate and preview an authored step without saving.**

Reuses `POST /workflows/test-step` with `dry_run` only, to show the resolved
config and the unresolved placeholders before anything is stored. **Live mode
is excluded explicitly and permanently for Casey**, and the reason is stronger
than side effects: that route takes a whole step from the request body with
`dry_run` defaulting to **false**, accepts `custom_code`, and runs it with no
workflow id, no save, no publish and nothing persisted beyond logs. Given the
escapable sandbox below, it is the **shortest path to server-side execution in
the application** — shorter than the editor. Casey must send `dry_run: true`
explicitly, and the kind must be unable to express anything else. Dry-run has
zero side effects, so this stays a read-shaped slice.

**A17.3: Draft a new, never-published workflow (the first write).**

The safest possible first write: a workflow born `current_version = 0` can be
started by nothing — every dispatch site refuses v0 — and has no inbound
references and no in-flight runs. One proposal creates the workflow
(`POST /workflows`) and appends its allowlisted steps; nothing publishes.

Review shows every step's full param list as text, the plain-language
behaviour, the side-effect class of each function, and that **nothing runs
until a human publishes**. Click-time freshness per correction 1: re-read at
click time and refuse if the name now collides or the workflow already exists.
Idempotency: `draft_id` as `Idempotency-Key` (P4 covers six create routes
today, so this extends `requestIdempotency` to `POST /workflows` — canonical
and user-scoped, benefiting native callers). Descriptor:
`ACTION_FAMILIES.workflow_draft`, with `appliedKey` `wf_draft`, `open()` to the
Automations workflow editor, and `danger: false` (nothing can run).

**A17.4: Insert or edit one step in an existing workflow's draft.**

Higher impact than A17.3 because the workflow may be published and running.
Separate kinds for insert and narrow edit:

- Insert writes through `POST /workflows/:id/steps` with `stepNumber`, so the
  **server** performs the branch-target remap; the proposal's own targets are
  authored against post-insert numbering, and review names every target the
  remap rewrites plus every warning it emits.
- Edit covers `label`, `note` and the param values of an already-allowlisted
  function. Never `type`, never `function_name`, never a branch target, never
  `error_policy` in this slice.

Both carry P11's expected-base precondition — editing version, step count and a
**key-order-insensitive** per-step fingerprint (wf50: MySQL re-orders JSON keys
on write, so a byte comparison of what you sent never matches what you read
back). The precondition is the wf27 scar made structural: a proposal built
against a 31-step base is refused by the route against a 39-step draft rather
than applied at the wrong position. Where the check lives: **the canonical
route** (P11), because the human editor has the identical hazard; Casey's
normalizer re-checks at proposal time, and the browser re-reads at click time.

Note the precondition also fences a replay: a second apply sees a changed base
and is refused. That is weaker than an idempotency key only in the unknown-
outcome case, so the slice still sends one and reuses P4's three-outcome
vocabulary.

**A17.4a: `query_db` steps.** Fred, 2026-10-22: promoted from a deferred
option to a planned slice.

`query_db`'s "SQL" is a JSON structure (`from`, `select`, `where`, `join`)
over a 19-table allowlist with blocked columns, not raw SQL, and the function
is read-only — a wrong query returns wrong data rather than writing anything.
It is also the gateway to the dominant live pattern: `query_db` then
`evaluate_condition` then act, 105 of the ~330 live steps between them.

One cost to budget: array and object params carry **no element schema**
today, so `select` / `where` / `join` contents are validated only at run time.
Casey's normalizer therefore builds the structure field by field — table from
the allowlist, columns checked against the table, operators from a closed set
— or P11 adds the element schema. The model never supplies a query string.

**A17.4b: `webhook` steps.** Fred, 2026-10-22: "it's very standard, and should
be allowed." Correct, and the earlier blanket exclusion was wrong. Measured:

- `validateWebhookConfig` makes the webhook step the **best-validated** step
  type in the system — the URL is parsed, the method checked, the
  `credential_id` verified against `credentials`, and `timeout_ms` capped at
  120 s. By contrast an `internal_function` step accepts a function name that
  does not exist, and `custom_code` is not validated at all.
- Execution goes through `lib/webhookExecutor.executeWebhook`, which uses the
  async `buildHeadersForCredential` — the load-bearing outbound-auth
  invariant, satisfied — and honours `timeout_ms` (30 s default, 120 s cap).
  (The comment in `sequenceEngine` claiming the workflow path has no
  credential injection and a hardcoded 10 s timeout is stale; filed.)

So the contract is narrow rather than absent:

- **The URL is literal and never invented by the model.** It comes from the
  user's own message or from a host already present in an existing step or
  credential — the evidence rule applied to destinations. A `{{templated}}`
  URL is refused outright: unresolved workflow placeholders blank silently, so
  `{{base}}/hook` can resolve to `/hook` and the real destination is not
  reviewable.
- **Auth comes only from a named credential the user picks.** Casey writes no
  literal header values, because that is where raw secrets get pasted, and it
  never pairs a *new* host with an existing credential — reusing an existing
  (host, credential) pair is fine. CLAUDE.md classes webhook URLs as
  secret-bearing, so a URL that embeds its own token stays the user's to
  supply, never Casey's to compose.
- Method from a closed set; `timeout_ms` defaulted well below the 120 s cap,
  because a long hang on a CPU-throttled background step is its own hazard.
- Review shows the full URL, the method, the credential **label** (never its
  value), the body with placeholders resolved by A17.2's dry run, the timeout,
  that the call leaves the firm, and the step's retry behaviour — retries fire
  for every strategy, so a non-idempotent third-party endpoint can be hit
  twice.

**A17.4c: code-step scaffold and copyable code.** Fred, 2026-10-22: Casey
should explain how to add a code step, be able to add a blank one, know all the
rules, and hand the user copyable code to paste.

**Revised 2026-10-22 (ruling 13):** everything below describes STANDARD mode
(`code_mode` absent or `'standard'`), and it is why Casey never authors one.
The safe-mode engine has since landed: `code_mode:'safe'` runs the body in a
QuickJS/WASM guest (`lib/safeCodeRunner.js`) — no host realm, no network, no
`Intl`, time and memory limits, dispatch failing closed on every execution
path including test-step. Casey authoring safe-mode bodies is approved and is
its own slice under the usual review contract.

Casey never authors a STANDARD `custom_code` **body** as a write, and the
reason is stronger than reviewability. **Measured 2026-10-22: the standard
code sandbox is escapable.** `lib/job_executor.js` runs a step's code with
`new vm.Script(code).runInNewContext({input, console}, {timeout})`, and
Node's `vm` is not a security boundary — `input` is a host-realm object, so
`input.constructor.constructor('return process')()` returns the real
`process`, with a working `mainModule.require`. Verified empirically against a
replica of that exact sandbox: `{reached:"object", pid:true,
canRequire:"function"}`.

So a code step is arbitrary server-side execution on the Cloud Run instance —
it can reach `process.env` (database credentials, API keys), require
`child_process`, and bypass every table tier and SENSITIVE-table gate the
access-control arc built. It is not, as an earlier draft of this section
claimed, a pure function of its inputs.

That makes model-authored code a qualitative change in threat model rather
than a quantitative one: Casey's inputs include transcripts, emails, documents
and SQL rows, which this plan already treats as untrusted and
prompt-injectable, so authoring code would put injectable content on a path to
server-side code execution. Today the risk is held by trust in four people,
not by a boundary. If Fred ever wants real code authoring it needs its own
arc: a genuine sandbox (an isolate or a separate runtime), SU-only, and its
own threat model — not a slice here.

Two consequences worth stating, because they bound what any future gate buys.
First, the declared step type was not a reliable selector at all: all three
dispatch payload builders spread a step's config AFTER its `type`, so a step
saved and validated as `internal_function` executed as `custom_code` — on the
workflow side, the sequence side, and in `test-step`. Fixed in the
dispatch/resolver slice, and it means a control keyed on the declared type was
side-steppable through the config until now. Second, a gate on authoring is
not containment: it limits who may INTRODUCE a code step, not who may run one,
since `POST /workflows/:id/start` is open to any staff JWT and every trigger,
hook and ingest path starts workflows whose code steps already exist.
Containment means a real sandbox or retiring `custom_code`.

**Fred has twice said he is not convinced code authoring should be excluded,
and retains the call.** This section records the evidence rather than the
preference: the blocker is the escapable sandbox, and it is fixable
independently of Casey. The related finding — that any staff JWT can obtain
server-side execution through the ordinary editor and, more directly, through
`test-step` — is filed to `ref/plans.md` with the full list of routes a gate
would have to cover.

Instead:

- **It adds the step as an inert stub**, not an empty one. An empty `code`
  throws at run time (`Custom code job missing "code"`), so a genuinely blank
  step would fail if published before the user pastes anything. The stub
  carries a comment and `return { success: true };`, so publishing it early is
  a no-op rather than a failure. Review states that the step does nothing until
  the user pastes code, and that **any** later change to a `custom_code`
  step's config is classified structural
  ([`lib/versionDiff.js`](../lib/versionDiff.js) always), so the paste forces a
  structural publish and in-flight runs cannot be migrated onto it.
- **It hands over the code as a copyable snippet in the chat**, rendered in a
  `<pre>` with its own copy button — a descriptor-level addition to the card,
  which already has a Copy affordance. This is not an action: nothing is
  written, so it needs no freshness, idempotency or permission contract, and it
  works the moment A17.0 ships.
- **It knows the rules.** This is the slice's real content, and `manual.search`
  cannot carry it: five ~1,200-character excerpts out of a 122 KB chapter
  cannot convey a sandbox contract. The slice adds one compact, curated code-step
  reference that Casey reads reliably, pinning at minimum: the sandbox is
  `{input, console}` only — no `require`, no `fetch`, no `process`; the return
  contract and the fact that a non-throwing return is recorded as a **success**
  row whatever it contains; that workflow templating has no modifiers and
  blanks unresolved tokens silently; the timeout and the Cloud Run throttling
  trap that makes pure-CPU code fail in a background step while the identical
  work succeeds through an in-request route; and that step renumbering never
  rewrites a `next_step` written inside code.

One caveat to state plainly rather than imply away: handing over code for a
human to paste is the same injection path as authoring it, only slower, and
its safety rests entirely on the reader actually auditing the JavaScript. That
is a reasonable bet for a developer and a poor one for a legal secretary. The
rules reference exists partly so the reader *can* audit it; the card carries an
explicit warning; and if code steps are gated per the `ref/plans.md` finding,
this flow should sit behind the same gate.

Even so this is the best value-per-risk slice in the family: it writes nothing
but a stub, and with ruling 9 it serves the 41 live code steps that authoring
will never touch.

**A17.5: Branch targets and control flow.**

Its own slice because this is where the engine's edges are: literal step
numbers in `BRANCH_TARGET_PARAMS`, the sentinels (`end`/`cancel`/`fail`/null),
`foreach.end_step` having to exceed its own step, the pause-free-cycle check
publish enforces via Tarjan SCC, and the fact that renumbering never rewrites
`custom_code` `next_step` or non-literal targets (both are warnings only).
Casey must never author a non-literal target.

**A17.6: Publish a draft.** Fred, 2026-10-22: publish is allowed but stays its
own step.

Reads `GET /workflows/:id/draft-diff`, then writes `POST
/workflows/:id/publish`. Review **is** the required impact preview: the
classification (`content_only` vs `structural`) and the reasons, the per-step
diff, validation errors and warnings, the in-flight execution count and
stranded versions, the inbound references (what can start this), the external
calls and sends the draft contains, the estimated fan-out, and the plain
statement that **no rollback route exists** — restoring a previous version
means rebuilding a draft step by step.

Fixed rules: `migrate_in_flight` is always false for Casey, never offered.
Publish carries an expected-draft-version and draft fingerprint (P11), so a
draft edited after the preview cannot be published blind — today the route
takes no such token and a publish can include edits made after the publisher
read the diff. **RULED — Fred, 2026-10-22: Casey may not publish a version containing a
`custom_code` step.** It may build the draft; a human publishes it. This
supersedes the earlier default of publishing with an acknowledgment, and it is
narrow on purpose: it names `custom_code` only. A `webhook` step is reviewable
and authorable (A17.4b), so a draft containing one still publishes.

**What that rule does and does not buy, because the difference matters.** It is
a review control, not a boundary. An unpublished code step already executes by
two paths, both open to any staff JWT:

- `POST /workflows/:id/start` accepts `use_draft` (query param or wrapped
  body) and runs the **draft** — that is the editor's Run button, built so
  authors can test before publishing; and
- `POST /workflows/test-step` needs no workflow and no save at all, with
  `dry_run` defaulting to **false**.

So "cannot publish" is not "cannot run", and a publish gate on its own would
read as safety while leaving the two shorter paths open. The rule therefore
travels with two companions, without which it is decorative: A17.7 applies the
same refusal to **starting**, and A17.2 keeps `test-step` dry-run-only for
Casey permanently.

**Where the check lives.** Not in the route — `POST /workflows/:id/publish`
must keep working for humans, who have to be able to publish code workflows.
So it lives where this family's other preconditions live: the normalizer
refuses to mint a publish proposal when the target version carries a code step
(it already re-reads the target at proposal time), and the browser re-reads at
click time per course correction 1. That makes it a Casey-scoped rule, which
is worth saying plainly given P2's finding that the route is often not an
authority.

**Known limit, not chased:** the predicate is direct. A workflow Casey
publishes may `start_workflow` into one that has code steps, or a trigger may.
Transitive closure is unbounded here and the firm's workflows chain heavily,
so one hop would be arbitrary. Recorded rather than papered over.

**A17.7: Start a workflow.**

An irreversible fan-out, not an extension of publish: `POST
/workflows/:id/start` has no idempotency or dedup today, so every call creates
another execution, and the advance is detached. Requires the P4 extension and
an impact preview covering the triggers the run can fan out to, its external
calls, and its estimated writes. Review requires a fresh confirmation.

**The A17.6 code-step refusal applies here too** (Fred, 2026-10-22): Casey may
not start a version carrying a `custom_code` step, and that explicitly includes
the draft — the route takes `use_draft`, so a draft runs on demand and starting
is the path a publish refusal would otherwise leave open. Casey never sends
`use_draft` at all: running an unpublished draft is an author's own test, not a
reviewed action.

**A17.8: Cancel one known execution.**

Cancel only. The cancel route already guards terminal state properly (one
transaction, a status-guarded UPDATE limited to
`active|processing|delayed|held`, pending resume jobs deleted, pending
decisions cancelled, paired tasks dismissed) and is the one execution route
that does. **Resume is excluded**: it refuses only `active|processing|delayed`
— so `completed` and `held` runs are resumable — it does not check
`workflows.active`, and it is not atomic (a plain SELECT followed by an
unguarded UPDATE, so two concurrent resumes both pass). Resume becomes
proposable only after the route is made atomic and state-guarded, which is a
canonical fix filed to `ref/plans.md`, not a Casey slice.

#### A18: Sequences and trigger rules

Planned 2026-10-22 with A17. Sequences keep the draft/publish model workflows
have, so A18.0-A18.3 mirror A17 closely. **Trigger rules do not**, and that
changes the plan — see *Trigger rules* below.

**A18.0: Explain a sequence template or an enrollment run (read-only).**

Mirrors A17.0/A17.1 over `sequence_templates`, `sequence_steps` and
`sequence_step_log`. The payload is different in kind: the sequence question is
almost never "what errored" (2 failed rows in 90 days) but "why didn't this
send", whose answer is the skip-reason vocabulary — `unschedulable` (83),
`step_condition_failed` (41), `fire_guard_failed`, `condition_failed`,
`enrollment_not_active`, `held_step_skipped` — plus the check chain that
produced it: enrollment active, then template condition (failing **cancels**
the enrollment), then fire guard, then step condition (failing **skips** the
step). Also reads the cascade: which template won for a type, and why, from
`sequence_template_types.priority_fields` scoring against `filters`.

Two sequence-specific traps the explainer must encode:

- Resolution is a `JSON.stringify` -> resolve -> `JSON.parse` round trip, and
  substituted values are **not** JSON-escaped. A value containing a double
  quote breaks the parse, the error is caught, and the step runs with its
  config **entirely unresolved** — a client-facing SMS or email body full of
  literal `{{...}}`. Measured: no current contact row carries a quote in
  `contact_name`/`contact_fname`/`contact_lname`, so this has not fired, and
  live active templates do interpolate exactly those fields. Filed as a live
  bug (see *Prerequisites*).
- An absolute-`delay` placeholder that resolves empty throws inside
  *scheduling*, not action execution, so `error_policy` never sees it and the
  enrollment wedges (active with no pending job). `lib/alerting` flags that
  shape after ~15 minutes.

**A18.1: Preview an enrollment (read-only).**

`POST /sequences/preview` is a zero-side-effect preview that already returns
the enrollment verdict and, per step, `computed_time`, `would_skip`,
`condition_error`, `timing_error`, `resolved_config`, `unresolved` and an
action summary. It is the single best read in either subsystem and should be
exposed early — it answers "what will this actually do to this client" without
writing anything.

**A18.2: Draft one sequence step.**

`sms`, `email` and `task` action types only, from the A17 allowlist, into the
template's draft. Blocked on P11 for two reasons beyond the shared ones:

- Sequence step saves validate **nothing** for these action types — no
  `function_name` check, no `__meta` check.
- `executeStep` builds `jobData = { type: 'internal_function',
  ...resolvedConfig }`, so a `type` key **inside** `action_config` wins the
  spread and redirects the step: `"type":"custom_code"` runs `vm` code,
  `"type":"webhook"` takes the executor's webhook path, and `validateStepConfig`
  blocks neither. Any "Casey may only author sms steps" contract is void until
  the route rejects a `type` key. Verified in code 2026-10-22.

Sequences have no step-to-step variables and no `set_vars`, so a sequence step
proposal is simpler than a workflow one; its timing is the hard part (seven
types, two of them appointment-anchored and silently `unschedulable` once
their window passes).

**A18.3: Publish a sequence template draft.**

Same impact preview as A17.6, with the sequence classifier's stricter rule
noted in review: content-only means an `action_config` change on an unchanged
`sms`/`email`/`task` step and nothing else — `action_type`, `timing`,
`condition`, `fire_guard`, `error_policy`, webhook/`start_workflow` config,
numbering and the template-level condition are all structural. Publishing
repoints `active` enrollments only and does not rewrite queued jobs.

**A18.4: Enroll a contact. Deferred past A14.**

Enrollment is an external-send fan-out and inherits A14's bar (resolved
preview, explicit recipients, strong idempotency, an unambiguous outcome). The
route is not ready either: `POST /sequences/enroll` has no idempotency key, its
duplicate guard is a racy SELECT-then-INSERT with no unique constraint, a
scheduling throw after the enrollment INSERT leaves an active enrollment with
no job, and every engine error including `ALREADY_ENROLLED` comes back as an
HTTP 500 whose `err.code` is not surfaced. Those are canonical fixes, filed to
`ref/plans.md`; none is a Casey slice.

Also note for any later enrollment work: step firing has no "already sent this
step" check, and `recoverStuckJobs` resets a job sitting in `running` for over
15 minutes back to pending, so an SMS or email **can** re-send. Only
`start_workflow` steps are retry-safe.

**Trigger rules: explain only, authoring deferred.**

The A18 text above assumed trigger rules could be drafted and published like
sequences. Measured, they cannot:

- There is **no draft and no versioning**. An edit is live the moment it is
  saved, with no cache in between. There is no definition-history table, so an
  edit cannot even be described after the fact.
- `updateRule` DELETEs every `trigger_rule_actions` row and reinserts them with
  new ids, in one transaction, and the editor always sends the full `actions`
  array — the behaviour CLAUDE.md records. A partial PUT without `actions`
  leaves the rows alone.
- `match_config` and `transform_config` structure, code syntax, and whether a
  target workflow or template exists or is published are **not** validated.
- `code` mode runs in `node:vm` with a 15 s timeout, savable by any staff JWT.
- There is no concurrency check at all: `getRule` runs outside the transaction
  with no row lock.
- Replay re-dispatches for real with no idempotency, and the stale sweep
  re-runs `processEvent` in full, so actions can dispatch twice.

So Casey gets **explain and dry-run only** for trigger rules: read a rule, read
`trigger_executions` and `trigger_execution_rules`, explain why a rule did or
did not match, and use `POST /api/triggers/test` and `/test-draft` (match and
transform only, no actions). Authoring a trigger rule waits for trigger rules
to get a draft/publish model, which is a **native automations arc, not a Casey
slice**. Reported rather than coded around, per the standing rule.

**Decision (Fred delegated it, 2026-10-22): do not build draft/publish for
trigger rules. Build an audit trail and a stale-write guard instead.**

The reason workflows and sequences have versioning is to protect *in-flight
runs* — an execution or enrollment is long-lived and pins its version. A
trigger rule has no in-flight representation: it matches and dispatches
synchronously at the emitting service's post-commit point, and whatever it
starts is a downstream automation pinned to its own version. So version
pinning buys trigger rules almost nothing, and it is the most expensive thing
on the menu. (One small window remains: `domain_event_queue` holds pending
events drained by a Cloud Task, so an event queued before an edit is matched
against the edited rule — seconds to minutes, plus the 15-minute stale sweep.
Real, but not worth a versioning model.)

What trigger rules actually lack is **auditability and revert**: an edit is
live on save, `updateRule` replaces every action row, and no history survives,
so nobody can say what a rule looked like yesterday. Two cheap pieces fix
that and are enough to let Casey author them under the same contract as
workflows:

- an append-only change log — the rule's fields and its action set, before and
  after, written inside `updateRule`'s existing transaction, with the actor;
  this gives both the review diff and a manual revert path;
- a row lock plus an expected-`updated_at` precondition on the rule, matching
  P11's shape, so a stale write is refused rather than applied.

Rule churn says this matters: the ten most recently edited rules were all
touched between 2026-10-09 and 2026-10-20, so trigger rules are edited *more*
actively than workflows, and explain-only would be a real loss. Until those
two pieces exist, Casey stays on explain and dry-run (`POST /api/triggers/test`
and `/test-draft`); once they do, trigger-rule authoring becomes an A18 slice
on the same expected-base recipe, with `code` mode excluded for the same
sandbox reason as `custom_code`.

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
staff-fixture smoke test for shipped Task, Event, Appointment, and contact-
subrecord review, cancellation, success, history restoration, and canonical
open-record behavior. Record the known repository-wide stale-test baseline
separately from action regressions.

#### P1: Closed action registry and shared review components — browser side shipped

The duplication did justify extraction: four copies of the same ~150 lines, with
thirteen more families planned. The browser side now has one registry and one
engine in `public/assistant.html`:

- `ACTION_FAMILIES` is the registry. One descriptor per family carries its
  kinds, its label/text/body builders, its result reader, its applied-marker
  key, its review warning, and how to open its record. `actionFamily(draft)`
  resolves a kind to exactly one descriptor, and an unknown kind resolves to
  none — such a draft is inert in the engine, the card and the renderer.
- `executeActionDraft`, `confirmActionDraft`, `applyActionResults` and
  `hydrateActionDraft` are the shared mechanics: freshness at render, click and
  again after the dialog closes; review and write single-flight; the required
  applied-marker save; retry state; the canonical open-record link; and
  text-only value rows. The per-kind route/method/body mapping stays written out
  by hand, per kind, inside each family's own `request` builder.
- A family's descriptor is the only thing a new action family adds to the
  mechanics. A6 is a descriptor plus its own builders, not another copy of the
  engine.

Deliberately NOT done: moving the region into a `public/js/` module. The pane
loads one inline script, which several tests and the shell's frozen-binding
rules rely on; a separate file buys reuse no second page needs yet. Revisit if a
second surface ever renders action cards.

The server registry (one normalizer dispatch per kind in `assistantService`)
already exists as a switch and was NOT touched by this slice. Neither registry
accepts a URL, method, selector, handler, arbitrary body, or actor from model
output; `tests/assistantUi.test.js` pins the registry's shape, the 26 kinds, the
uniqueness of each family's applied-marker key, and the inertness of an
unknown kind.

#### P2: Permission and capability matrix — inventoried 2026-10-22

Inventory route authentication, role/capability checks, row-level scope, and
native UI visibility for every proposed kind. Normalize only what the current
signed-in user may review, but keep the canonical write route as the final
authority. Add negative tests for foreign-parent IDs, inactive records, and
state or permissions changing between proposal and click.

The executable matrix is `tests/caseyActionPermissions.test.js`; it carries the
route table as data, so a moved route fails a test rather than drifting
silently. What the inventory established, for all 26 shipped kinds:

- **Authentication is identical everywhere and there is no authorization.**
  Every one of the 22 route mounts behind the 26 kinds is `jwtOrApiKey` and
  nothing else: a staff-audience JWT whose `user_auth` starts with
  `authorized` (a varchar prefix test, not a flag), or a machine key subject to
  its route scopes. No route file mounts a role, capability or superuser gate.
  The one authorization-shaped refusal in the stack is read-only View-as.
- **There is no firm/tenant axis.** The schema has no `firm_id` or `tenant_id`,
  so "cross-firm" has no expression here; the row constraints that exist are
  the normalizer's (evidence must name the exact id, the parent must match, the
  link must exist) plus the A5 subrecord preconditions.
- **The write route is NOT a validation authority for assignee or provider
  eligibility, and mostly not for terminal state.** `taskService.createTask`
  contains no SELECT at all and never looks `to` up in `users`;
  `apptService.createAppt` never checks `appt_with`. The governing principle
  above says the existing route "preserves ordinary validation" — for these
  fields that is false, and the normalizer's proposal-time check is the only
  one. The 15-minute TTL and the no-write-from-history rule bound the exposure
  window; they do not close it. The contact-subrecord family is the exception:
  its `expected_updated_at` / `expected_primary_id` preconditions make the
  route the authority, which is what P3 should generalize.

The specific gaps are filed in `ref/plans.md` (Ask Casey arc section). Two of
them — appointment attended/no-show and event field edits on a dead row — are
cases where the route is merely as permissive as the native UI, so they belong
to P3's click-time precondition rather than to a service guard that would also
change the human path.

#### P3: Optimistic concurrency and stale review protection

Existing-record actions must protect the interval between server normalization
and confirmation. A5 starts this pattern with server-owned row versions and
reviewed current-primary preconditions. Extend it with a canonical version,
updated-at value, or narrow before-value precondition for every route that lacks
one, and reject a write when the reviewed state has changed. This is required
before scalar edits, relationship changes, pipeline transitions, publishing,
and other operations where a stale review could overwrite someone else's work.

#### P4: Durable idempotency and ambiguous-result recovery

Pulled ahead of A6 in its minimal form (an idempotency key on creates) by the
2026-10-21 review — course correction 2.

Browser single-flight prevents double-clicks but does not solve a timeout after
the server committed. Add canonical, user-scoped idempotency support to create,
send, enroll, start, replay, and fan-out operations before exposing the risky
families. Reconciliation must distinguish not-applied, applied, and unknown;
it must never blindly retry an unknown send. The key is browser/server-owned,
not model-chosen, and the same protection should benefit native callers where
appropriate.

**Shipped for creates, both halves.** Server (`3eb7a99`): an optional
`Idempotency-Key` header on the six create routes, one server-chosen scope
each, backed by `request_idempotency`. No key means the old behaviour and zero
extra queries, so native callers are untouched; the key can never change what a
route writes, only whether it writes twice. The claim is committed before the
operation's own transaction — inside it, the claim could not fence a second tab
— and `withIdempotency` refuses a transaction connection outright. A failed
operation releases the claim, so the key stays reusable.

Browser: a create sends its server-minted `draft_id` as the key — stable across
retries of that card, unique per proposal, never model-chosen — and only a
create sends one, because no other kind can duplicate a record. The three
outcomes reach the card as three different states: a `replayed` response
restores the applied state and says the record already existed rather than
reporting a second create. The canonical P4 facility distinguishes a fresh
`in_flight` 409 from a stale `unknown` 409. With P5, either response after a
ledger claim leaves the card unknown: **the write control is removed entirely**
and the user is told to open the record, because offering it again could apply
the action twice. Copy and Discard remain available.

Still open from P4's full scope: sends, enrollment, starts, replays and
fan-out are not wired (their families are not built yet), and an ambiguous
outcome is only logged server-side, not alerted — that belongs to P7.

#### P5: Durable applied-result persistence

Pulled ahead of A6 (course correction 2). The interim required-save + loud
failure shipped with the fix package. The P5 implementation uses the recording
ledger described below; its SQL must be applied before backend/frontend deployment.

**RULED — Fred, 2026-10-22: a ledger endpoint is allowed.** "No new endpoints"
is an idea, not a rule; what is load-bearing is that *almost* every action
Casey takes is an ordinary legal action of the user, performed through the
route the rest of YisraCase uses and triggered by the user — just from outside
the ordinary UI. An endpoint that only records that the user performed an
action does not perform one, so it is ordinary engineering. The test in
`tests/assistantUi.test.js` that today spells this as "`routes/api.assistant.js`
contains no `/api/assistant/actions`" must therefore be RE-PINNED, not deleted,
when the ledger lands: the invariant to assert is that no assistant endpoint
performs a business write (it requires no write service and calls none of their
write functions). Deleting the assertion would retire the guarantee instead of
restating it. That re-pin shipped with the ledger: the assertion now reads the
route for any of the six canonical write services.

The ledger is the preferred shape, because it gives the full
not-applied / applied / unknown trichotomy for every kind rather than only for
creates. Design for the slice:

- key it on the server-minted `draft_id` — already a uuid from the normalizer,
  already user-scoped, already not model-chosen;
- claim before the canonical write, record the canonical result after;
- on chat reopen the ledger, not the chat payload, is the source of applied
  truth;
- an in_flight row with no result is `unknown` and must never offer a retry.
  Reuse P4's vocabulary and outcome names rather than inventing a second set.

P4's canonical idempotency stays as the creates-side protection; the two
compose, and P4 landed first (`3eb7a99`). The ledger registers server-issued drafts before returning them, claims on the
pool before the browser's canonical request, and records only canonical record
IDs. A claim is never taken over or automatically freed, and a claim without a
receipt stays `in_flight` — which the ledger reports as `unknown` — because the
browser cannot certify a rollback. Receipt-only retries do not repeat the
write. Rows survive chat deletion and all kind-version changes until the user
is deleted. Legacy messages without rows retain chat marker restoration;
unsupported kinds stay inert. See `assistantActionLedger` and
`scripts/caseyP5Ledger.js` for the recording/retention contract.

**The card distinguishes a refusal from an unknown outcome, the ledger does
not.** When the canonical route answers a 4xx other than 409, it read the
request and refused it, so nothing was written; the card says exactly that and
asks for a fresh proposal, rather than claiming the action may have been
applied and sending staff to hunt for a record that does not exist. A 409 and
anything 5xx or socket-dead stay ambiguous on purpose: appointment status
conflicts reach the browser as 500 (`ref/plans.md`) and the A5 stale
preconditions as 409, and a conflict from an unaudited route could still have
written. The claim is spent either way, so neither state ever offers the write
again. The ledger row, however, is still `in_flight` after a refusal, so
**reopening that chat shows the conservative unknown wording instead of the
refusal** — the row cannot express "claimed, then refused" without a third
status. Filed in `ref/plans.md`; it costs a misleading message on reopen, never
a write.

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

#### P11: Canonical automation preconditions and step validation

The prerequisite for every A17/A18 write, and a fix to the human editor's
identical hazards. All of it lands in the canonical routes, because Casey's
normalizer cannot be the authority for a route the native editor also uses.

**Expected-base preconditions.** Add an optional precondition to the
step-mutating routes (`POST|PUT|PATCH|DELETE /workflows/:id/steps*`, the
reorder route, the sequence equivalents) and to both publish routes: the
expected editing version, the expected step count, and a per-step fingerprint
computed **key-order-insensitively** (sort keys, then stringify — wf50, where a
correct draft was discarded over MySQL's JSON key re-ordering alone). A write
whose base does not match is refused, not applied at the shifted position.
Optional for native callers so the editors keep working unchanged; **required**
on every Casey proposal. This is the wf27 scar turned into a route property:
assert the base before writing.

**Close the save-time validation gaps**, on both paths:

- reject an unknown `function_name` (today no `__meta` means permissive);
- reject undeclared param keys, including `_`-prefixed ones, which the engine
  otherwise overwrites or passes through;
- validate `params: null` instead of skipping;
- enforce the `error_policy.strategy` enum;
- run the workflow `__meta` validation on sequence `sms`/`email`/`task`/
  `internal_function` steps, which validate nothing today;
- **reject a `type` key inside a sequence `action_config`** (A18.2);
- re-run param validation at publish, which today checks shape and branch
  targets but never params or function existence.

One structural divergence to rule on: a human can today save a step naming a
function that does not exist, and rejecting that changes the human path.
Validate only the fields being written, so an existing step whose function was
since renamed can still have its label edited; a PUT that rewrites the whole
step is validated whole. Reported for Fred's ruling rather than coded around.

Mutation-check every new assertion against a real engine, not mocks — the
family's SQL predicates and row types are exactly where `appt.create.v1`
shipped dead (course correction 5).

#### P12: Automation read surface for Casey

**P12 SHIPPED 2026-10-22, both halves,** as shape (b) below:
`automation.list` / `automation.definition` / `automation.run` /
`automation.references`, typed read kinds in the existing execute loop, served
by `services/automationReadService.js` with the redaction this section
specifies (code bodies readable per ruling 9). P12a = workflows; P12b (same
day) = sequences: the same four kinds take `sequence_template_id` /
`enrollment_id`, `sequence_step_log.action_config_resolved` is never selected,
and sequence references match a starter by exact `template_id` or by
`template_type` equal to the template's type.
One drift found while building: nothing in the forms code references a
workflow, so the "form definitions" starter named below does not exist;
`automation.references` covers hooks, trigger rules, sequence steps, parent
workflows and CTA links.

Casey could read **no** automation definition or run before P12a. Of the automation
tables only `sequence_enrollments` is on the Reports manifest allowlist
(`lib/reportSchema/manifest.js`), and the allowlist is enforced twice: by the
report validator and by per-column SELECT grants held by the least-privilege
`yc_report` MySQL account. Every A17/A18 slice, including the read-only ones,
depends on closing that.

Two shapes, and the choice is Fred's:

- **(a) Widen the Reports manifest.** Cheapest to build, but the manifest is
  shared with Reports and the AI report builder, so it would expose workflow
  definitions, run payloads and trigger config to every staff report; it
  carries no redaction layer; and it needs a grant re-provision run
  (`scripts/reportGrantUserProvision.js`) plus prompt-context changes.
- **(b) A new typed assistant read kind**, id-keyed and served by a projection
  service: `automation.definition` (one workflow or sequence template, draft or
  an explicit version), `automation.run` (one execution or enrollment with its
  step history), `automation.list` (bounded id/name/active/version/step_count),
  and `automation.references` (what can start a given workflow — from
  `hook_targets`, `trigger_rule_actions`, form definitions, CTA plans and
  sequence steps). A read kind is not a new endpoint: it is another step kind
  inside the existing `/api/assistant/execute` route.

**Recommended: (b)**, because redaction is impossible in (a). The projection
must elide `custom_code` bodies (digest, length and first line only), webhook
URLs (credential label, method and a host digest — CLAUDE.md treats webhook
URLs as secrets), literal header values, and the resolved payloads in
`workflow_execution_steps.resolved_config` / `output_data` and
`sequence_step_log.action_config_resolved`, which hold resolved headers, client
PII and third-party response bodies. Rows must alias `workflow_id`,
`step_number`, `execution_id`, `template_id` and `enrollment_id` so the
existing evidence rule (the cited row carries the exact id) works for the later
write kinds. Code bodies: ruling 9 (2026-10-22) settled it — Casey MAY read
`custom_code` bodies (capped per cell), which is what makes explaining the
live code steps possible; webhook URLs and resolved payloads stay redacted.

**Budgets make the projection mandatory, not cosmetic.** The read loop allows 3
rounds, 8 steps, 250 rows, 50 rows per query, 3,000 characters per cell and
60,000 characters of evidence in total; the answer call is capped at 2,500
output tokens. The largest live workflow is 38 KB of step config across 50
steps, so a raw definition nearly fills the evidence budget and leaves no room
for its run history — and a 2,500-token answer cannot emit a whole definition
at all. Hence: summarized projections for reading, and **step-at-a-time
proposals** for authoring (A17.3-A17.5). Authoring may also need its own model
call with its own cap rather than riding the answer call.

Also to settle here: the draft heuristic `taskDraftRequested` contains no
workflow or sequence nouns, so no automation proposal can be produced until it
does; and the assistant's typed output is enforced only by prompt text plus the
server normalizers (`aiService.call` sends no JSON schema and no tools), so the
normalizer carries the whole burden for every new kind.

#### P13: Workspace context for automations

The Automation Manager reports only its sub-tab (`open=tabMore~
moreAutomations~workflows`); `wsReportSubPage` drops anything after the sub-tab
id, so **Casey cannot tell which workflow, sequence or execution is open**.
"Explain this workflow" is unanswerable without it. Three small changes, the
same shape the case/contact ids already use: the sub-page reports the open id,
the server parses that segment, and it verifies the id exists before signing it
into the ticket. Add the matching `automations.workflow` / `automations.sequence`
destinations so Casey can link the user back to what it explained — today the
only automation destination is `automations.court_review`.

## Recommended execution order

0. The 2026-10-21 fix package landed (`7c8f225`); the P1 browser extraction
   landed after it. Next are minimal P4 and P5 (course correction 2), both
   before A6 — P5 pending the ruling recorded in its section.
1. Close P0 and continue P2, P7, and P8 alongside the shipped A4/A4.1/A5 contracts.
2. Implement A6–A8 with P3 in place; extract P1 only from demonstrated common
   behavior, not as a speculative generic executor.
3. Implement A9–A12 and complete the collection-sync portions of P6.
4. Complete P4 and P5 before A14, A15, A17 execution, or A18 enrollment/replay;
   A13 draft/triage and A16 draft/preview can proceed earlier.
5. The automation-authoring track runs on its own prerequisites, not behind
   A6-A16. P12 (the read surface) and P13 (workspace context) gate the
   read-only slices A17.0, A17.1, A18.0 and A18.1, which need no write
   machinery and can ship alongside A6-A8. P11 gates every A17/A18 write;
   A17.6 and A18.3 publish additionally need P3 generalized. A17.7 start and
   A18.4 enrollment stay behind A14's send machinery.
6. Expand via P10 gates. Keep destructive/admin/bulk/autonomous work outside
   the ordinary roadmap until separately approved.

For the upcoming review, the key decisions are whether this ordering is right,
which low-impact scalar fields belong in A7, whether delete variants in A6
should be deferred entirely, and what operational bar must be met before the
first external-send or fan-out action. A5 deliberately excluded hard delete;
after the fix package, P1 extraction and minimal P4/P5, the next action slice
is A6 contact relations and roles.
