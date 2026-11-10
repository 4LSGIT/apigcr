# Ask Casey typed actions plan

The destination is `ref/CASEY_VISION.md`; this document is the mechanics.

Status (2026-11-09): A0/A0.1, A1, A2, A3, A4, A4.1 and A5 shipped 2026-10-20 —
the Task lifecycle; reviewed Event create/update/complete/cancel; Appointment
create, narrow update, attended, no-show, cancel, reschedule-now and
reschedule-later; one phone/email/address subrecord create, narrow update or
history-preserving end. Since then: A6 (contact relations and roles — create and
update), A7 group A (case notes, case alerts, contact notes), A7 groups B/C (any
other case field, 2026-11-09; the docket's replace / clear, A7e), A7c (case docket adopt), A8 (case contacts — add, role change, remove), A9 + A9.1 (pipeline
advance and move; off-ramp = exit) + A9.2 (the typed `case.pipeline` read) + A9.3 (the cross-pipeline transfer) + A9.4 (requirement override set / clear), A10 + A10.2 (checklists and items; list rename / note edit, list and item delete), A11 + A11.2 (documents —
update and link; share and unlink), A11.1 (a case's Dropbox folder — candidates-only relink),
A12 + A12.2 + A12.3 (form drafts and submission links; draft discard and PDF filing; appointment
records; submitting a stored draft), A13 (mail triage —
read state and case link; no drafts exist, no SMS triage), A13b (one email's
attachments filed to a case, the Comms File attachments route), A14 (direct email /
SMS send), A16 (reports), A17.0–A17.4, A17.6, A17.7 + A17.7b (workflows — explain,
preview, draft, step, publish, start with an optional reviewed input), A18.2, A18.3, A18.4a/b/c/d (sequences — step,
publish, enroll with an optional reviewed trigger_data, appointment- or e-sign-scoped), A19.0/A19.1 (inbound hooks), A20.0–A20.3 (email and phone
ingest rules), R1 (read-loop continuation) and P13. A15 (e-signature) is not
built. Each slice's section below carries its shipped contract. No general
action executor is introduced.
The 2026-10-21 independent-review fix package (branch `fix/casey`) amends this
plan — see **Course corrections** below; where they conflict, it wins.
The automation-authoring family (A17 workflows, A18 sequences and trigger
rules) was planned in a dedicated session on 2026-10-22 with three platform
prerequisites (P11-P13); its shipped sub-slices are listed above, and the rest
of its plan stands in those sections.

## Review briefing

The shipped baseline is 87 proposal kinds (the action ledger's `KINDS`
registry; `tests/caseyActionPermissions.test.js` pins the inventory against it)
in 46 browser families: the record families — Tasks, Events, Appointments,
contact phone / email / address rows, contact relations and roles, case and
contact notes and case alerts, case contacts, case pipeline moves, the case
docket, the case's Dropbox folder, checklists and their items, documents and their links (edit, link, unlink, share), form drafts, submission links,
draft discards, submission PDF filings and draft submits, an email's read state and its case link — plus direct SMS /
email sends, report drafts and the automation families (safe code jobs, workflow draft / step / publish / start,
hooks, sequence step / publish / enroll, ingest rules). Every family
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

- P0: a staff-fixture smoke test spanning Task, Event, Appointment, and
  contact-subrecord review, cancellation, success, history restoration, and
  canonical open-record behavior (the live multi-round dependency-read test
  passed 2026-10-28 — see the Read-loop release gate section);
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
(A7's field groups are decided and shipped: case notes, case alerts and
contact notes, then every other case field except case_id, see A7; A6 removal is decided: a later sub-slice, see A6); set the P1
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
3. **No client sends inside A4 until A14.** SHIPPED, then lifted under the A14
   bar (ruling 15): appointment create/cancel/reschedule proposals carry a
   client SMS/email confirmation only when the user asks, and the normalizer
   resolves it BEFORE the card is shown (see *Client confirmations* under
   A4.1). Off — the default — the flags stay false and any model-authored
   message is dropped, in the normalizer and again in the browser body.
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
- A6 lifecycle (end / reactivate / remove; role deactivate / reactivate /
  remove): shipped as A6.2, 2026-11-10 — ENDING a relation is its own kind, not
  an update (manager ruling 2026-10-28, kept). See A6.

## Governing principle: actions run through the user

The key design advantage of Casey actions is that **the user performs the
action**. Casey may assemble and validate a fixed proposal, but the write begins
only when the staff member clicks its action button in their own authenticated
browser. The browser calls the same established application endpoint used by
the rest of YisraCase. Consequently:

- the current user's auth and permissions—not model identity—authorize it;
- the existing route identifies the actor and preserves ordinary audit,
  linking, notification, and error behavior, and whatever validation the
  native path has — for assignee/provider eligibility and most terminal state
  that is none, so the normalizer's proposal-time check is the only one (P2);
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

The gate is CLOSED: run live 2026-10-28 and passed (chat 51 — 2 rounds,
3 steps; round 2 read contacts/cases by the phone number round 1's comms
search returned, a value the prompt never contained; citations from both
rounds; the answer hedges the phone-only identification). The test prompt
anchored on a street address ("a Seven Mile address") that appears in exactly
one transcript. The lesson from the first, non-probative attempt stands for
any rerun: the prompt must not contain the party's name or number — a round's
steps are planned before any result is seen, so a leaked identifier lets the
model form every query from the prompt text and finish in one round. A
rerun's prompt shape:

> Search phone and voicemail for the most recent call that mentions
> [distinctive non-party phrase]. Using only what that search returns — not
> my open workspace — identify the client on the call, find their matching
> contact record, and summarize their open cases.

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
that contact and note are supported. A client SMS/email confirmation is off
unless the user asks (*Client confirmations* under A4.1). The server resolves the
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
it sends nothing to the client unless a confirmation was asked for. Reschedule-now
retires the predecessor, deletes its firm/provider calendar entries and
automation, creates a lineage-linked successor, re-creates calendars and
automation, and opens the successor. Reschedule-later creates no successor,
deletes calendar entries/automation, and may create the reviewed follow-up
task. Create also discloses firm/provider calendar attempts, reminder-sequence
enrollment, no-show-sequence cancellation, and singleton supersession.

**Client confirmations (A14 bar, ruling 15).** Create, cancel and
reschedule-now may carry the route's own client confirmation
(`confirm_sms`/`confirm_email` + `confirm_message` on create, `sms`/`email` +
`confirm_message` / `msg` on cancel and reschedule) — off unless the user asks.
The route sends it fire-and-forget after the write
(`apptService.sendApptConfirmation`) and resolves its `{{…}}` itself,
non-strict, after the click; so the normalizer resolves it first, STRICT, with
the same resolver and refs (`{contacts: the client, appts: the row the route
resolves against}`), and the browser sends that resolved text. The route's
resolve is then a passthrough for everything but the client's manage link,
`{{appts.appt_manage_token|default:}}`: it cannot resolve before the
appointment exists, stays literal in the sent text, and the card shows it as a
labeled element — the one disclosed exception to shown-is-sent. Create and
reschedule resolve `{{appts.*}}` from the card's own values shaped as mysql2
reads the stored row (date/end/length/type/platform/status/note; reschedule as
the successor: the old type/length/platform at the new time with this note);
any other appts column refuses (`appts.appt_length` is a smallint, so every
length the card allows is stored as itself). Cancel resolves against the real row (so status/note read as before the
cancel) and only checks that a token exists — the token never enters the card.
An unresolved placeholder, another table, a non-canonical link, or braces left
after resolution refuse. Recipient and sender are the route's: the contact's
`contact_phone` / `contact_email`, `sms_default_from` / `email_default_from`;
the email subject is the route's fixed one. These are automation sends, so an
opted-out channel REFUSES at proposal (no acknowledge — ruling 17's confirm
belongs to the direct send cards), as does a missing number, address or
sender. SMS is capped at 1000 with the link counted at 32 characters. The card
re-reads the contact (and its phone/email rows' opt-out) at click time and
refuses on any change; a card without a confirmation reads nothing and is
byte-for-byte the earlier card. Pinned on a real engine (route resolve over the
card's text changes only the link, and equals the route's resolve of the raw
text against the stored row): `tests/caseyApptConfirm.mysql.test.js`.

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

#### A6: Contact relations and roles — create and update shipped 2026-10-28, lifecycle (A6.2) 2026-11-10

Add relation and role create/update/remove separately from scalar contact
editing. Resolve both ends and the role/type registry on the server, protect
directionality and uniqueness rules, and display the relationship in plain
language. Firm-level role-type administration is not part of this slice.

**Read prerequisite (A6.0).** The relation/role tables (`contact_relations`,
`contact_relation_types`, `contact_roles`, `contact_role_types`) are not in
the curated report manifest, so `sql.read` (and the yc_report grants behind
it) cannot see them: an update's `relation_id` / `role_id` evidence and the
live registry had no read at all. A6.0 adds the typed read
`contact.relations {contact_id}` on the app pool (the P12 automation-read
precedent, ruled 2026-10-28): the contact's relation rows from its own
perspective (`relation_id`, both ends with names, both plain readings), its
role rows (`role_id`, attrs), and both active registries, through the services
the Relationships tab and the Roles section read.

**Shipped contract (A6.1).** Four kinds: `contact.relation.create.v1`
(POST `/api/contact-relations`), `contact.relation.update.v1` (PATCH
`/api/contact-relations/:id` — status, start_date, notes; A6.2 adds
type_code and an ENDED relation's end_date / end_reason), `contact.role.create.v1` (POST `/api/contacts/:id/roles`) and
`contact.role.update.v1` (PATCH `/api/contacts/:id/roles/:rowId` — the
complete attrs object of an active row). The type / role code resolves in the
registry and carries its spelling; an unknown or retired code refuses and
names the live ones; status from the type's vocabulary; role attrs through
the route's own validator. One relation per pair and type in EITHER
direction, active or not — the reverse of a one-way type refuses with its own
wording (stricter than the route, which would store it). A held or inactive
role row refuses by id. Evidence: both contact ids for a relation create, the
contact id for a role create, the exact `relation_id` row / `role_id` +
`contact_id` row for an update. The card reads "On A's record: <forward
label> B" and "On B's record: <reverse label> A"; a role card discloses the
trustee roster / judge docket-suffix consumers and flags a judge suffix
another active judge already carries. Click-time freshness re-reads the
native GETs (relations: `updated_at` plus the reviewed values; roles: attrs,
key-order-insensitive) and refuses before the claim. Idempotency: no
Idempotency-Key — the ledger allows one claim per draft and the routes'
UNIQUE keys refuse a second card's duplicate (400, a refusal); residual race
on record: two cards for the opposite orders of a SYMMETRIC pair (the
route's reverse check is application-level). Both route families are on
yc-sync (`relations:contact:<id>` for both ends, `roles:contact:<id>`), so
the other contact's open tab and the open Roles section re-read; the cards
add no emit of their own.
Off switch `casey_contact_relations_enabled` (on unless '0'). Tests:
`tests/caseyContactRelations.test.js`, gated
`tests/caseyContactRelations.mysql.test.js`.

**Shipped contract (A6.2, 2026-11-10 — Fred, 2026-11-09: "Casey can do at
least anything the user can do in the UI").** Six lifecycle kinds, each on the
route the native control uses: `contact.relation.end.v1` {relation_id,
end_date? (today, firm-local), end_reason?} → PATCH {active:0, end_date,
end_reason}; `contact.relation.reactivate.v1` {relation_id} → PATCH {active:1,
end_date:null, end_reason:''}; `contact.relation.remove.v1` {relation_id} →
DELETE `/api/contact-relations/:id` ({deleted_id}); `contact.role.deactivate.v1`
/ `.reactivate.v1` {contact_id, role_id} → PATCH `/api/contacts/:id/roles/:rowId`
{active:0|1} ({id}); `contact.role.remove.v1` → DELETE the same path
({removed}). And `contact.relation.update.v1` widened to what the tab's Edit
dialog allows: `type_code` (a live type; contact_a stays A; the dialog's rule —
status and end_reason always sent with a type change — kept; the pair rule
re-run on the new type) and, on an ENDED relation (active 0 or an end_date),
`end_date` / `end_reason`. The body comes from the KIND in the browser
(families `contact_relation_lifecycle`, `contact_role_lifecycle`), never from
draft text. Refused by name (the routes guard none of it): an ended relation on
an end card (ENDED = A6.1's reading: inactive or carrying an end date), an
active one on a reactivate card, an inactive role on a deactivate card, an
active one on a reactivate card, an ACTIVE role row on a remove card (the Roles
section offers Delete only on inactive rows; the route would delete it — pinned
on the twin), reactivating onto a retired type / retired or unknown role code
(stricter than the route — never put a retired vocabulary back into use; an end,
deactivate or remove of one is allowed), an end_reason outside the type's
`allowed_end_reasons` (the contact.relations read now carries it), an end date
in the future or before the start, a stored status / end reason the type no
longer allows (the PATCH re-validates the MERGED values on every save and would
400 — pinned), and a reactivation that would leave two ACTIVE relations of the
type between the pair. No relation row is undeletable natively (no FK, trigger
or reader blocks it). DISCLOSED: the Relationships tab of both contacts (the
only code reader besides Casey's read; no template, report, event or portal page
reads relations); the A7 stored-definitions scan for `contact_relations` /
`contact_roles` (a hit is a STORED READERS warning); NO UNDO on every delete,
naming END as the reversible alternative for an active relation; the role's code
readers (trustee roster, judge resolution, role filter / pickers); and, for a
judge or trustee, the link SHIFT — measured by running lib/caseRoleResolver and
lib/trusteeRoster (the resolvers updateCase runs) once on the stored state and
once on a projected one (`roleProjectedDb` rewrites the single `cr.active = 1`
of each contact_roles query; a query of another shape or any failure refuses the
card, since the resolvers swallow errors), over the cases they could touch
(judge: docket suffix, judge text carrying the judge's last name, or a stored
link; trustee: every case with a trustee; more than 20,000 refuses). The card
names the cases whose link would change and counts the stored links to the
contact; nothing re-resolves until each case's judge / docket / trustee is next
written. Danger: every delete and every role deactivation; an end, a relation
reactivation or a role reactivation when it carries a warning. `expected` is the
row as stored (relations: updated_at, both ends, type, every value; roles:
active, attrs, stored role code — the table has no updated_at); the click
re-reads the native GETs and refuses on ANY difference before the claim (a
reactivation also re-checks the pair). Outcomes: either route's 404 is "already
removed" (`contactLifecycleKnownOutcome`); a role DELETE answering removed:0
throws in the result reader. Idempotency: none — one claim per draft; a second
card's delete is a 404, a second end / reactivate is refused by the re-read
(residual: two cards clicked in the same instant both pass and both PATCH — the
second end rewrites the end fields). On yc-sync like A6.1's writes (the
relation DELETE answers both ends for it).
Ledger rows, prompts (plan 27, answer 29, repair 17; the investigate stage had no
refusal to drop), the request detector's lifecycle verbs, permissions matrix
(76 kinds / 64 mounts). Same switch `casey_contact_relations_enabled`. Tests:
`tests/caseyContactRelationsRemove.test.js`, gated
`tests/caseyContactRelationsRemove.mysql.test.js`.

**Deferred.** Changing either contact of a relation (the native PATCH forbids
it; delete and re-add) and role-type / relation-type administration (YisraCase
Config, firm.settings).

#### A7: Scalar contact and case edits — group A shipped 2026-10-28, groups B/C 2026-11-09

Every proposal shows before and after values and carries a server-owned
stale-value check through confirmation. A contact exposes its notes only
(group A); a case exposes every column except case_id (groups B/C, Fred's
ruling below; the docket too — filled, replaced or cleared, A7e) — except the
columns another card owns or derives, each refused by name with a pointer:
pipeline state (A9), the Dropbox folder (A11.1), the notes and alerts (group A), the judge / trustee
links (derived) and the 341 appointment's projection (the type / subtype are
editable since A7d, 2026-11-09). Contact identity and access, and case merge,
remain excluded.

**Fred's rulings (2026-10-28, recorded by the manager).**
1. The first field group is `case_notes` + `case_alerts` (cases) and
   `contact_notes` (contacts) — group A.
2. Freshness is the A6-style check: the server bakes the expected current
   value into the card and the click-time re-read refuses on a mismatch. A
   conditional-write route change (a precondition on the PATCH itself) is
   deferred until a client-facing field group needs it.
3. `case_source` is allowed in a LATER group — it is not intake-excluded.

**Shipped contract (group A).** Three kinds: `case.notes.update.v1` and
`case.alerts.update.v1` (PATCH `/api/cases/:id`) and `contact.notes.update.v1`
(PATCH `/api/contacts/:id`). The column is fixed by the kind and the browser's
builder sends that one column only. The model gives `value` (the complete new
text; `''` clears) XOR `append` (one addition); the normalizer reads the
record through the routes' own GET services and resolves either to the FULL
after-value — an append keeps the stored text byte-for-byte and adds a new
line — so the PATCH always carries the whole value. Caps count the whole
result: notes 10,000 (`lib/noteLimits`, the route's own limit), alerts 5,000
(the column is TEXT with no server cap; the case-detail forms' maxlength).
Unknown keys (including any other column) refuse by name; a no-op refuses.
Evidence: a cited row carrying the exact `case_id` / `contact_id`. The card
shows the size before → after and the changed region with bounded context
(never the whole note), says "Clears" for a clear, danger-styles any card that
removes stored text, and names the CONTACT on a contact-notes card (with its
linked-case count) so it never reads as case-scoped. Click-time freshness
compares the stored value (cases has no `updated_at`; `contact_updated` moves
on unrelated writes). Idempotency: none needed — setting a value is
idempotent, and the ledger allows one claim per draft (a replay of the contact
PATCH re-pushes Google Contacts, harmless). Receipts: the case kinds' receipt
is the STRING `case_id` (cases.case_id is a varchar(20) PK) — the one string
receipt, carried by the ledger's `STRING_RECEIPT_FIELDS` and the engine's
family `stringReceipt` flag (manager ruling 2026-10-28; every integer family
unchanged); contact notes receipt `contact_id`. Sync: both routes already
carry yc-sync matchers and case.html, contact.html and checklistView repaint
these columns — nothing added. Off switch `casey_record_edits_enabled` (on
unless '0'). Tests: `tests/caseyRecordText.test.js` (no twin: the normalizer
adds no SQL of its own) + `tests/assistantUi.test.js`.

**Live sweep (manager, 2026-10-28).** No stored trigger rule, sequence or
ingest rule reacts to these three columns. Their readers are the casedetails
and bk_worksheet form templates, reports 10 and 13, and the case-merge
workflows — all deliberate consumers of the text.

**Groups B/C.** Every other case column is one kind, `case.fields.update.v1`
(below). Ruling 2's route precondition is still not built: the card keeps the
baked-expected + click-time re-read even for the portal-visible columns it
now writes (`ref/plans.md`).

#### A7c: Case docket adopt — shipped 2026-11-02

Origin: a refused request (Fred, 2026-10-29): "can you add a case number to a
given case?" — 887 of 1,130 non-closed cases had a blank `case_number`
(measured 2026-11-02). One kind fills a BLANK docket; replacing or clearing one
goes on the case fields card (A7e, in the A7 groups B/C section below).

**What the route guards.** `PATCH /api/cases/:id/docket` {case_number?,
case_number_full?} — the court-review adopt flow's dedicated writer, never the
generic cases PATCH — trims each value (empty = not supplied) and answers 409,
before any write, (1) when the case already holds a DIFFERENT non-blank value
in a submitted column (trimmed, compared exactly in JS: a capitalisation
difference is a replacement; "Replacing it is a case-detail-form operation, not
an adopt.") and (2) when another case holds a submitted value in EITHER column
(`caseService.checkCaseNumberCollision`: the database's equality under
general_ci — capitalisation and trailing spaces aside — never a docket-shape
parse); 404 for an unknown case. It writes only the submitted columns through
`updateCase` (`source:'docket_adopt'`), which re-resolves the judge link
(`case_judge_contact_id`, lib/caseRoleResolver) whenever case_number_full is
written and emits `case.updated` (fire-and-forget) when something changed; it
answers `{status, data:<getCase result>, changes:{field:{from,to}}}`. Since
2026-11-09 it 400s a value over 20 characters (before, relaxed sql_mode stored
it cut short, answered 200). All pinned on a real engine
(`tests/caseyDocket.mysql.test.js`).

**Shipped contract.** One kind, `case.docket.adopt.v1` {case_id,
case_number?, case_number_full?, evidence} → that route. The values are the
user's words, opaque server-side; the card shows them verbatim, quoted.
- **Refused by name before anything is read:** a replace / clear / overwrite /
  force-shaped key; any other case field (status, stage, dates, trustee, judge,
  tags, type, chapter, caption …); any other unknown key.
- **Refused:** a non-text value; a line break or control character anywhere
  (C0, DEL, C1, U+2028/2029 — edges included, before the route's trim); more
  than 20 characters counted in code points; neither number given; evidence
  not citing the exact case_id; a gone case; a column holding a DIFFERENT
  value (the route's rule word for word, naming the stored value); nothing to
  fill (every given number already there — no-op); another case holding a
  number (the route's own function, run first; the refusal names that case and
  both its values). A column already holding exactly the value is not sent and
  says so.
- **The card** names the case, both columns before → after (NULL vs empty text
  shown), and every reader that changes, each by its own rule read off the
  code: the case header (`full || number || 'Not Filed'`); the Cases list
  (`COALESCE(NULLIF(full, ''), NULLIF(number, ''), case_id)` since
  2026-11-09 — before that NULL only, so a full number stored as `''` kept
  the Case Number column blank); the client
  portal docket line (`deriveDocket`, for the Primary / Secondary contacts
  named) and portal cards; the Documents tabs' case badge
  (`_labelTargets`, blank-skipping) and the Dropbox relink panel's docket lane;
  court-email matching (`courtResolve`: court mail carrying the number is filed
  on this case from now on); the caption stamp when the case has none
  (`lib/caseCaption.js` rules; `courtExecutor` fills an empty caption from the
  first resolved court email); templates; the events and log rows ALREADY filed
  under the number that join the case at once (counted with
  `eventService`'s docket expansion and `logService._buildCaseLogWhere`'s
  three clauses); the judge link a full number re-resolves (none → X, unchanged,
  or — a danger warning — an existing link that changes or clears); and every
  active `case.updated` rule that would run / fail / MAY run — updateCase's
  exact envelope (priorRow overlaid, `changes` via `buildChanges` including the
  judge link, `extra.updated_fields`) through A9's
  `listActiveRulesForEvent` + `evaluateDraft` on the preview lane, nothing
  dispatched.
- **Freshness:** `expected` = both columns as stored (NULL and `''` distinct),
  `case_type`, and — when the full number is sent — `case_judge` and
  `case_judge_contact_id` (cases has no `updated_at`); the click re-reads GET
  `/api/cases/:id` and refuses on any difference before the claim (a number set
  by hand since is named). A number another case took meanwhile is the route's
  own 409.
- **Idempotency:** none added — one claim per draft; a second card on the same
  case is refused by the precheck, or by the route's adopt-only 409.
- **Outcomes:** both 409s (matched by message, with `body.conflict`) and the 404
  are before-write refusals (`knownOutcome`); a 400 is a refusal; any other 409
  and 5xx stay ambiguous.
- **Receipt:** the STRING case_id (A7's `STRING_RECEIPT_FIELDS` path — the route
  returns the case, no integer).
- **Sync:** the route already has its yc-sync matcher (`case:<id>` with
  `changes`); case pages and the Cases list refresh. Nothing added.
- Off switch `casey_case_docket_enabled` (on unless '0', casey section, sort
  63). Tests: `tests/caseyDocket.test.js`, gated `tests/caseyDocket.mysql.test.js`,
  `tests/assistantUi.test.js`.

Replacing or clearing a docket is the case fields card's (A7e, below); this
card is unchanged by it.

#### A7 groups B/C: Any other case field — shipped 2026-11-09

Fred's ruling (2026-11-09): "Casey can edit any field except case_id, just
like the user." The user's surface is `PATCH /api/cases/:id` →
`caseService.updateCase`, whose BLOCKED set is exactly `case_id`; it 400s an
unknown column (`fieldDefService.writableColumns`), an over-long notes column
(`lib/noteLimits`) and a bad cf_ value (`splitCustomFields`), maps a blank
date to NULL (`lib/blankDateToNull`), re-resolves `case_judge_contact_id` /
`case_trustee_contact_id` when case_judge / case_number_full / case_trustee is
written (a miss writes NULL), and emits `case.updated` (source `manual`) when
its `buildChanges` sees a change. It checks no width: relaxed sql_mode stores
an over-width varchar cut short and answers 200 (pinned on a real engine,
`tests/caseyCaseFields.mysql.test.js`).

**Manager rulings within Fred's** (flagged to Fred). Refused BY NAME, with a
pointer, because the raw PATCH skips the work the owning card does:
`case_stage`, `case_status`, `case_rec`, `pipeline_phase` (A9);
`case_dropbox` (A11.1); `case_notes`, `case_alerts` (group A — append
semantics live there); `case_judge_contact_id`, `case_trustee_contact_id`
(derived — the card for case_judge / case_trustee discloses the re-resolution
instead); `custom` (cf_ keys only). **`case_type` / `case_subtype` are
ALLOWED (A7d, 2026-11-09 — Fred: "casey can do at least anything the user can
do in the UI"; the case page PATCHes them raw):** a type change without a
subtype on the card sends `case_subtype: ''` too, as the case page's
`caseTypeChanged` does ("a refinement never carries across types"), and the
card says so; both values are checked against the firm's list
(`fe-case_types`, via `firmConfig.cfgJson`) — an unlisted type or subtype is a
WARNING, not a refusal, because every create form offers a free-typed "Other";
and the card discloses the pipeline the case resolves to before → after
(`pipelineService.resolveTemplate` on the stored row and on the post-state):
when it changes, a danger warning names both pipelines, says whether the
case's current stage exists on the new one (else the widget and board show it
unstaged), and that no stage-log row is written and no step checked — the
case page's "Move to another pipeline…" does both, this edit neither. The
portal title ("Chapter <chapter> <type>"), header, Cases list, board and
filters are the code-measured readers. The worker added `case_341_current` and
`341_appt_id` (flagged for a ruling): apptService is their single writer —
they mirror the live 341 appointment, and the client portal shows the date —
so the 341 moves by rescheduling its appointment.

**Shipped contract.** One kind, `case.fields.update.v1` {case_id, changes:
{<column>: <value>, …}, evidence} → that route, behind
`casey_record_edits_enabled` (the A7 family switch; no new key).
- **Shape:** 1–10 columns per card (one review per card); every column inside
  `changes`; two keys naming one column (capitalisation aside) refuse; evidence
  cites a row carrying the exact case_id.
- **Column map:** the live information_schema (the same read as the route's
  unknown-column check), so the card never trusts a frozen copy: an unknown
  column, a computed one and a type with no reviewed rule refuse.
- **Values by type:** DATE one ISO date, `''` / null clears (sent null —
  "Clears"); DATETIME (show_cause) firm-local wall time, sent as the Case
  Details form's datetime-local value `YYYY-MM-DDTHH:MM`; ENUM an exact member
  (a NOT NULL enum cannot be cleared); SET an array of members, sent
  comma-joined in MEMBER order (MySQL's own read-back order); CHAR / VARCHAR
  one line, trimmed, at most the column width in code points (a NOT NULL
  column clears to `''`, a nullable one to NULL); TEXT keeps tabs and line
  breaks, folds CRLF, at most noteLimits' cap (341_notes), the form's maxlength
  (docs_missing 2,000) or 10,000. cf_ keys go through the route's own
  `splitCustomFields` — its 400 message is the refusal.
- **No-op:** compared the way MySQL stores the value (SET order-insensitive,
  DATE as yyyy-mm-dd, NULL and `''` alike); a column already holding it is not
  sent and says so; nothing left refuses.
- **The card** names, per column: before → after (TEXT as the changed region),
  "Clears" (danger-styled when stored data is removed); who reads it — the
  code-measured surfaces (the client portal reads `case_chapter` — the case
  title —, `case_341_link` — the 341 card's link — and `case_open_date` — the
  order of the client's case list; the header, Cases list and court email read
  the caption; court email fills or overwrites the dates, judge, trustee and
  chapter it knows) plus a live word-bounded scan of every stored definition
  naming it (active reports, form templates, active portal cards, active
  pipeline requirements, sequence and workflow steps, active ingest actions);
  the judge / trustee link updateCase re-resolves (an existing link that
  changes or clears is a danger warning); the 341 link a raw trustee change
  does NOT re-point (the Case Details form does it client-side — a warning
  when the case has one); and every active `case.updated` rule that would run /
  fail / MAY run on updateCase's exact envelope (A9's `listActiveRulesForEvent`
  + `evaluateDraft`, preview lane, nothing dispatched) — or that no event fires
  when `buildChanges` sees no change. A card over 60,000 characters refuses.
- **Freshness:** `expected` = each touched column as stored, `case_type`,
  `case_subtype`, and with a judge / trustee change what the link rests on
  (`case_number_full` / the judge link; `case_chapter` / `case_341_link` / the
  trustee link); the click re-reads GET `/api/cases/:id` and refuses on any
  difference before the claim.
- **Outcomes:** a 4xx (unknown column, notes length, cf_ value, 404) is a
  refusal; 5xx stays ambiguous. **Receipt:** the STRING case_id. **Sync:** the
  case PATCH matcher already carries `data.changes`; case.html merges it,
  repaints the Overview / header columns it shows and pushes the rest into the
  Case Details forms. Nothing added.
- Tests: `tests/caseyCaseFields.test.js`, gated
  `tests/caseyCaseFields.mysql.test.js`, `tests/assistantUi.test.js`,
  `tests/assistantPromptKinds.test.js`.

**A7e — the docket on this card (Fred, 2026-11-09: "Casey can do *at least*
anything the user can do in the UI").** The Case Details form replaces and
clears `case_number` / `case_number_full` through this same PATCH, so the card
does too — fill, replace or clear (a blank one is filled here as well; the A7c
adopt card stays, byte-identical, for the model's convenience). The PATCH
refuses a collision (409) and an over-width number (400) at the write since
2026-11-09 (it used to store both, answering 200 — the native gap this slice
found, closed the same day; pinned on a real engine); the card refuses them
first, naming more:
- **Refused:** a number another case holds in either column — the docket
  route's own `caseService.checkCaseNumberCollision` (general_ci + PAD SPACE
  equality, no shape parse), run before anything else is read, the refusal
  naming that case and both its numbers; over 20 code points / a line break or
  control character (the varchar rule on the live width).
- **The card** (`caseFieldsDocketReview`), danger-styled for a replace or a
  clear: old → new or "DOCKET CLEARED"; the events (eventService's case-scope
  docket expansion) and log rows (`_buildCaseLogWhere`'s three case-scope
  clauses) that LEAVE the case — matched by the pre-state, not the post-state —
  and that ARRIVE, counted in SQL so the database's equality decides (a
  capitalisation-only change moves nothing); court email (`courtResolve`): mail
  carrying a dropped number no longer files here unless its bare number (judge
  letters stripped) is still this case's case number — said so — and mail
  carrying the new one does, plus the bare-number fallback when `case_number`
  changes; header / Cases list / portal / Documents text before → after
  (A7c's `caseDocketDisplays`) and the relink panel's docket lane; the judge
  link updateCase re-resolves when `case_number_full` is written (from the new
  suffix, else the judge text — a clear re-resolves from the text alone and can
  empty it); caption unchanged; the case.updated dry-run as for any column.
- **Freshness:** `expected` carries both numbers (and, with a full-number
  change, the judge text and link); the click re-checks the collision after
  the stale check, before the claim, through the case picker's search (GET
  `/api/cases/search?q=<number>&limit=50` — raw columns, substring LIKE over
  both, compared general_ci-style); a full page of 50 without a hit proves
  nothing and refuses. The gap between that read and the write stays (ruling
  2's precondition). The builder holds each number to the docket rule.
- Tests: `tests/caseyCaseFields.test.js` (A7e block), gated
  `tests/caseyCaseFields.mysql.test.js` (A7e block: the real readers before /
  after, `courtResolve`, the judge drop, the duplicate and the clip the PATCH
  stores), `tests/assistantUi.test.js`, `tests/assistantPromptKinds.test.js`.

**Still excluded** (`ref/plans.md`): ruling 2's route precondition; the owned
columns above stay with their cards.

#### A8: Case-contact membership — shipped 2026-10-28

Add, remove, or change one case/contact membership through the dedicated case
contact routes. Preserve primary-contact, role, and last-contact invariants;
show both records, old and new role, and any primary-contact effect. This is
separate from both contact roles and scalar case editing because it changes a
set and can alter downstream addressing.

**What the routes guard.** Nothing beyond the `case_relate` UNIQUE key
(case, contact, type) and its two duplicate triggers. There is no native
primary-contact, last-contact or portal rule, the PATCH validates no type and
emits no event, and PATCH / DELETE act on every row of the (case, contact)
pair. So the invariants are the normalizer's, enforced fail-closed and
re-checked at the click (pinned on a real engine, including the route
behaviour each refusal rests on: `tests/caseyCaseContacts.mysql.test.js`).

**Shipped contract.** Three kinds: `case.contact.add.v1` (POST
`/api/cases/:id/contacts` {contact_id, relate_type}), `case.contact.update.v1`
(PATCH `/api/cases/:id/contacts/:contactId` {relate_type}) and
`case.contact.remove.v1` (DELETE the same path). relate_type is explicit and
one of the four (the route's Primary default is never assumed). Refused by
name: a PORTAL USER — any `portal_access_log` row, carried as `portal_used` on
each GET `/api/cases/:id/contacts` row (anything but an explicit 0), PIN-only
rows included on purpose — leaving Primary/Secondary by demotion or removal,
whatever `portal_enabled` says (manager ruling 2026-10-29: the flag is
DEFAULT 1 and was 0 for none of 1,109 contacts, so a flag rule refused every
demotion; usage — 2 pilot contacts that day — is the real signal). Anyone else
may be demoted or removed with a danger warning that they lose portal sight of
the case once the portal is live (no warning when `portal_enabled` is 0);
the case's only Primary leaving (a second Primary is allowed with a danger
warning — the swap path is promote-then-demote); the case's last contact; a
pair holding two rows; an add for a pair already on the case in any role
(stricter than the route, which would store a second row the PATCH can never
change); an add for a case_id over 8 characters (the column would truncate
it); a case with more than 50 contacts. Evidence: an add cites rows with the
exact case_id and contact_id; an update/remove cites the case_relate row with
the exact `case_relate_id` — the table is in the curated report manifest, so
`sql.read` reads it and no typed read was needed. The card names the case and
the contact, the old and new role, the contacts after, and every effect: the
Primary slot (new Primary, stepping down, TWO PRIMARY warning), the client
portal (a portal user gaining sight of the case is a warning), which case
readers count each role, and the trigger event (add fires
`case.contact_linked`, remove `case.contact_unlinked`, a role change none).
Freshness: `expected` carries the case's whole membership set, the
contact's portal flag and (change / remove) its `portal_used`; the click re-reads GET `/api/cases/:id/contacts` and GET
`/api/contacts/:id` and refuses on any difference before the claim — which is
also how a contact who used the portal since the card was prepared is refused. Outcomes: the add's 409 "already linked" and a change/remove 404
"Relationship not found" are before-write refusals ("already removed"); other
409s and 5xx stay ambiguous. Idempotency: none needed — one claim per draft,
the UNIQUE key refuses a second card's add, and a second card's remove is a
404. Receipt: the integer `case_relate_id` (new / reviewed / removed row), not
A7's case_id string path — the ledger's own rule for a record with an integer
id. Sync: all three routes share one yc-sync matcher (a `case:<id>` marker),
so case pages and the shell lists refresh; an open contact page does not (a
native gap, `ref/plans.md`). Off switch `casey_case_contacts_enabled` (on
unless '0'). Tests: `tests/caseyCaseContacts.test.js`, gated
`tests/caseyCaseContacts.mysql.test.js`, `tests/assistantUi.test.js`.

**Deferred.** A swap of two Primaries in one card, fixing two-row pairs, and
any native guard on the case page (`ref/plans.md`).

#### A9: Case pipeline transitions — advance and move shipped 2026-10-29

Add advance and explicit move as different proposal kinds. The proposal must
show the current and destination stages, unmet requirements, downstream
automation, and any note or notification effect. Requirement override and
override removal are A9.4's own cards, with their own reason and permission
contract; Casey must never manufacture or conceal a blocker.

**What the route guards.** `POST /api/cases/:id/pipeline/advance` →
`pipelineService.advanceStage` (the only `case_stage_log` writer; it writes
case_stage / case_status / case_rec and `pipeline_phase` from the entered
stage's template role) checks NO requirement — skipping is legal by design —
and is idempotent per destination: a repeat of the latest row's key and
template is a noop under a per-case GET_LOCK that writes nothing and emits no
`case.stage_advanced`. Both are pinned on a real engine
(`tests/caseyPipeline.mysql.test.js`).

**Shipped contract.** Two kinds, both through that route with body
{stage: <stage_key>, note?}: `case.pipeline.advance.v1` (the next main-lane
stage, server-picked — the model names none) and `case.pipeline.move.v1`
({stage}: a key or label of a stage of the case's RESOLVED pipeline, either
lane — off-ramp, skip ahead, step back, recovery). The one cross-template
destination is the retention crossing (intake → case): an intake case into its
chapter pipeline's FIRST active main-lane stage, reached by the route's own
cross-phase key search, and only when the R2.5 projection names that pipeline
by subtype (a blank or unmatched subtype under an is_default template is
refused — the route would file it there). The cases PATCH is never used;
these two kinds never send `/pipeline/move` (cross-pipeline membership) — a
cross-pipeline key refuses by name and points at A9.3's transfer card.
- **Unmet requirements** are the normalizer's gate, fail closed: every
  REQUIRED step in status active / upcoming that the move would turn
  'skipped' — the resolver's rule 3 (a stage numbered below the destination
  in its template; on the crossing, every intake step) — refuses a move to a
  main-lane stage and the crossing, each listed word for word with its stage
  and owner. **Off-ramp = exit** (Fred, 2026-11-01): a required step is a
  prerequisite for CONTINUING the pipeline, and leaving it is not
  continuing, so a same-template move onto an off-ramp-lane stage passes
  over no requirement. Its open required steps are disclosed instead — one
  danger warning after the OFF-RAMP line names each word for word with its
  stage and owner ("they will read as skipped once the case is on <off-ramp>")
  — and carried in `expected.required_open`. Optional steps left open are
  disclosed (they will read skipped); done / N/A ones are listed. A step back
  passes none. A RECOVERY (off-ramp → a main-lane stage) is never refused for
  them either: every REQUIRED step below its destination still reading
  'skipped' gets a danger warning after the RECOVERY line ("they stay skipped
  at <dest>") and rides `expected.required_skipped`, which the click compares
  like `required_open`. There is NO override pathway on these cards (an
  off-ramp is not one): a draft key naming an override / skip / force /
  waive / requirement refuses by name before anything is read, and the
  refusal points at A9.4's `case.requirement.override.v1` — one step, its
  reason, its own card, never folded into a move.
- **Refused by name, besides:** a case-phase case that resolves to Intake (no
  chapter pipeline matches — advancing it there would flip a retained case
  back to intake); advance from an off-ramp or past the last stage; a later
  stage of a chapter pipeline not yet entered (its requirements cannot be
  computed before the case is on it); an all-digit stage key (the route reads
  it as a numeric stage id); a note over 255 characters (the log width).
- **The card** names the case, the pipeline, both stages, the phase
  (danger-styled RETAINED on the crossing; off-ramp, recovery and backward
  moves warn too), the four overwritten columns before → after (a
  hand-written next step is replaced), the client-portal visibility of the
  new stage, the passed-over and destination steps, and every active
  `case.stage_advanced` trigger rule that would run, fail, or could not be
  evaluated ("MAY run", danger) — the exact envelope advanceStage emits,
  dry-run through `triggerService.listActiveRulesForEvent` + `evaluateDraft`
  on the preview lane, nothing dispatched; transitive effects are not chased.
- **Evidence:** a row carrying the exact case_id; the destination comes from
  the server-resolved stage registry (getPipeline's stages, or the matter
  pipeline's list), never free text.
- **Freshness:** `expected` = template id, current stage_key, history length
  (catches A → B → A), phase / type / subtype, and the passed-over requirement
  signature (plus, onto an off-ramp, the disclosed required-open set); the
  click re-reads GET `…/pipeline?requirements=1` and GET `/api/cases/:id`,
  recomputes the blockers (a newly unmet step refuses by name; onto an
  off-ramp — the card AND the live stage both off-ramp lane — the open
  required steps must equal the disclosed set, so a step done or newly open
  since refuses) and refuses on any other difference before the claim.
- **Idempotency (the double-fire question):** no Idempotency-Key and no route
  change. Stage-entry automation fans out per transition, but the route itself
  dedups a repeat (noop: no row, no event), the ledger allows one claim per
  draft, a second card's precheck refuses "already there", and the route's
  noop answers a race as a refusal ("nothing written, no automation ran"). The
  residual is a DIFFERENT destination applied between two cards — a real
  second transition, which the second card's precheck refuses (position
  changed). The A18.4a idempotentRequest pattern is not needed here.
- **Outcomes:** the noop and the per-case lock's 409 ("already in progress")
  are before-write refusals (`knownOutcome`); a 400 (stage deactivated since)
  is a refusal; other 409s and 5xx stay ambiguous.
- **Receipt:** the STRING case_id (A7's `STRING_RECEIPT_FIELDS` path). The
  transition's own row has an integer id, but the route never returns it
  (getPipeline's history projection omits it, a byte-identical C1 contract).
- **Sync:** the advance route's yc-sync matcher carries `changes` (the four
  overwritten columns); case pages repaint and reload the widget
  (`pipeline_phase` is the advance signature), the board refetches. Nothing
  added.
- Off switch `casey_case_pipeline_enabled` (on unless '0'). Tests:
  `tests/caseyPipeline.test.js`, gated `tests/caseyPipeline.mysql.test.js`,
  `tests/assistantUi.test.js`.

**Elsewhere.** Setting and clearing a requirement override (`POST/DELETE
…/pipeline/requirements/:key/override`, its reason and permission contract) is
A9.4. Cross-pipeline moves — and with them entering a chapter pipeline past its
first stage — are A9.3.

#### A9.2: Typed `case.pipeline` read — shipped 2026-11-09

A read, not a card: Casey SHOWS a case's pipeline — where it is, every stage,
each step's status and what blocks a move — before proposing one. The
pipeline tables are outside `lib/reportSchema/manifest.js` (so `sql.read`
cannot see them, and widening the manifest needs the production grant script
re-run), so this is the typed-read-on-the-app-pool recipe (A6.0
`contact.relations`, A11.1 `document.relink.candidates`). No flag, no route,
no schema change, no settings key.

**Shipped contract.** `case.pipeline` {case_id} (validator: one exact case_id,
`^[A-Za-z0-9_-]{1,20}$`; fingerprint per case) →
`assistantService.casePipelineRead`: `caseService.getCase` (the case row only)
then `pipelineService.getPipeline(db, <the STORED case_id>, {requirements:
true})` — the case page's own GET `/api/cases/:id/pipeline?requirements=1`,
the read the A9 click re-runs. Passing the stored id matters: getPipeline
finds the case case-insensitively but keys its steps by the id it is given,
so a mis-cased id would read the case with no steps. Rows (cap 50, the
per-step `MAX_ROWS`; a cut is stated in the head note, stage rows first):
- **head** (`row_type: 'case'`): case id + label (full case number, else
  number, else id — the A9 card's label), type / subtype, `pipeline_phase`
  (anything not exactly 'case' reads intake, as the engine does), case_stage
  / case_status / case_rec, the resolved template (id, name, role, matter
  type / subtype), `phase_mismatch`, current stage (key, label, lane, number,
  `current_on_pipeline`), `next_main_stage_key` (getPipeline's `upcoming[0]`),
  history count, the last transition (entered_at, entered_by as a user id,
  source, note), the row counts, and a note.
- **stage** rows, one per active stage of the resolved pipeline, both lanes:
  key, label, client label / visibility, lane (main / offramp — the A9
  card's test), number, case_stage, is_terminal, default_rec, `is_current`,
  `upcoming` (membership in getPipeline's upcoming — main lane only),
  `times_entered` / `last_entered_at` (history matched by stage_key, the
  engine's convention), requirement count.
- **requirement** rows, one per step of those stages, the resolver's object
  verbatim: key, label, client label / visibility, required (1/0), owner,
  kind, `status` (done / na / skipped / active / upcoming — the resolver's
  vocabulary; an override is not a status of its own), satisfied_at, detail,
  progress, hint, and the override (`override_status` / `_note` / `_set_by`
  / `_at`) when one is stored.
- **projected_stage** rows, intake-resolved cases only: getPipeline's R2.5
  projection (source subtype → the named chapter pipeline's main-lane
  stages; generic → the Intake template's inactive `retained` row).

**Not returned, on purpose:** stage_id (the cards name a stage by key or
label; an all-digit target is a numeric id to the route); `is_default` (not
in getPipeline's template projection); a name for `entered_by` (a users join
the resolver does not make); the Intake pipeline's steps of a retained case
(getPipeline is stage-anchored — they are history; GET
`…/pipeline/requirements` has them); no server-side summary — the note states
facts and the row vocabulary, the model summarises.

**Refusal-shaped answers:** an unknown case → a `not_found` row with the
route's 404 wording ("Case X not found"); no pipeline resolves (no active
Intake template) → a NO PIPELINE head row with no stage rows; a retained case
no chapter pipeline matches → RETAINED CASE ON THE INTAKE PIPELINE
(`phase_mismatch` 1, the wording the A9 card refuses on); no history → NO
STAGE YET. Any other failure of the pipeline read is the step's failure.

**Permission posture:** the read runs inside POST `/api/assistant/execute`
(`jwtOrApiKey` + `staffOnly`); the route it mirrors is bare `jwtOrApiKey`.
Every caller that route refuses, the assistant refuses; an API key the route
admits, the assistant refuses — narrower, never wider (pinned behind the real
gate). Its rows carry case_id, so a head row satisfies the A9 cards' "a row
carrying the exact case_id" evidence.

**A9 touch:** the chapter-pipeline "not a stage" move refusal ends "A case.pipeline
read shows each stage with its steps"; the prompts teach the read at every
stage (plan / investigate kind lists, the A9 plan bullet, the answer's
pipeline rules — name a stage from a stage row — and the repair shape).
Nothing else in the cards changed.

Tests: `tests/caseyPipelineRead.test.js` (validator, executor, cap, posture),
gated `tests/caseyPipelineRead.mysql.test.js` (the real resolver: detector
done / skipped / N/A override / active / upcoming, both lanes, read = route,
projection, mismatch, no pipeline, 404, mis-cased id, the A9 refusal over the
step the read shows), `tests/assistantPromptKinds.test.js`,
`tests/automationRead.test.js` READ_KINDS.

#### A9.3: Cross-pipeline transfer — shipped 2026-11-09

Fred (2026-11-09): "Casey can do *at least* anything the user can do in the
UI." The case page's "Move to another pipeline…" (`public/case.html`
`pwMoveOpen` → POST `/api/cases/:id/pipeline/move` {template_id, stage_id,
note?} → `pipelineService.movePipeline`) now has a card. What A9 deferred as
reasons not to build it (non-atomic, writes case_type / case_subtype, fires
case.updated, passed-over requirements not computable before the membership
write) are its disclosures.

**What the route does.** `movePipeline` validates (unknown template / stage
404, inactive template / stage or a stage of another template 400), then
writes the membership through `caseService.updateCase` — for a role 'case'
template with a case_type, only the columns that differ by an exact String
compare (a blank-subtype template clears the subtype; an intake template
writes none and the case KEEPS its subtype) — emitting case.updated (source
`pipeline_move`), then `advanceStage` by NUMERIC stage id (no key resolution,
no active filter, the per-case lock, the noop when the latest log row is
already that stage of that template — no phase write either). The two writes
are separate transactions: an advance failure after the membership write
rethrows with "case type/subtype updated for "<name>" but the stage advance
failed (<reason>) — retry the move" and the advance's own status (409 lock,
500 …). The route checks no requirement and does not ask whether the case
will resolve to the destination afterwards — the phantom its own header warns
of (pinned on a real engine).

**Shipped contract.** One kind, `case.pipeline.transfer.v1` {case_id,
pipeline (template id or name), stage? (key or label on the DESTINATION),
note?, evidence} → that route, behind A9's `casey_case_pipeline_enabled` (no
new key). `normalizeCasePipelineTransferAction`:
- **Refused by name:** an override-shaped key (no override pathway on a pipeline card — the refusal points at A9.4's card); any other
  key (template_id, stage_id, case_type, case_subtype … — the server derives
  them); the pipeline the case resolves to now ("a move along it is not a
  transfer: propose case.pipeline.move.v1"); an unknown, ambiguous (two
  templates of one name) or inactive template; an unknown, ambiguous or
  inactive stage (the active ones listed); a destination with no active stage;
  and **PIPELINE DOES NOT RESOLVE** — `pipelineService.resolveTemplate` on the
  post-state (phase = the destination's role, or unchanged when the advance
  would noop; type / subtype after the membership write) must name the
  destination, else the card refuses with the reason (a second intake
  template never resolves; a matter template with no case type writes nothing;
  a duplicate loses to a lower id). The A9 cards' cross-pipeline-key refusal
  now points at this kind.
- **The stage when unnamed:** `pwMoveOpen`'s own default — the case's current
  stage key when the destination has it active (any lane), else its first
  active main-lane stage, else its first active stage (an off-ramp); the card
  says which.
- **Disclosed, never refused** (danger warnings): PIPELINE TRANSFER (no
  undo); LIFECYCLE when the phase flips (retained, or back to intake); CASE
  TYPE / SUBTYPE REWRITTEN (from → to, A7d's `CASE_FIELDS_SURFACES` readers as
  effects) and NOT ATOMIC (the torn state and how to finish it); PASSED-OVER
  REQUIRED STEPS — every REQUIRED step on the destination's active stages
  numbered below the destination stage that is not done / N/A, word for word
  with stage and owner. The statuses are PROJECTED the resolver's way
  (`casePipelineTransferSteps`: the case's override, else the requirement's
  detector satisfied through the same `requirementDetectors` batch, else
  skipped below / active on / upcoming after the destination) because the
  resolver only reads the pipeline a case resolves to now. A9.1 fails closed on
  these for same-template moves; the case page's move allows them, and the A9
  ruling text governs A9's two kinds, so this card discloses. REQUIRED STEPS
  LEFT ON <old pipeline> — its open required steps (read skipped on intake →
  case, else they leave the case's step list); OFF-RAMP; AUTOMATION when a
  rule cannot be evaluated. Optional steps passed over, satisfied ones and the
  destination stage's own steps are listed.
- **Automation:** both events dry-run on their exact envelopes through A9's
  `casePipelineAutomation` — case.updated (updateCase's: source
  `pipeline_move`, `buildChanges` over the membership fields; skipped when
  nothing is written) and case.stage_advanced (advanceStage's: the
  post-membership type / subtype, `extra.from_*` from the latest log row, the
  note or the route's default `Moved to "<name>"`; skipped on the noop).
- **The card:** both pipelines and stages, the type / subtype before → after,
  the four columns advanceStage overwrites (unchanged on the noop), the
  client-portal visibility of the stage, the stage-log line.
- **Freshness:** `expected` = the case's type / subtype / phase / case_stage,
  its resolved template, current stage_key and history count, the
  destination's id / role / type / subtype / active, the stage id, the
  destination's active-stage signature (id, key, number, lane, req_count) and
  the active-template signature (id, role, type, subtype, is_default — the
  resolver's inputs). The click re-reads GET `/api/cases/:id`, GET
  `…/pipeline`, GET `/api/pipeline-admin/templates` and GET
  `/api/pipeline-admin/templates/:id/stages` (the page's own move-dialog
  reads) and refuses on any difference before the claim. Not re-read: a
  destination step's done / not-done status (no route projects another
  pipeline's steps for a case) — the card says so.
- **Outcomes** (`caseTransferKnownOutcome`): the torn message → `Failed —
  partly written` (whatever its status; never applied, never "nothing
  written"); a success whose fresh pipeline is not the destination at the
  destination stage → `Failed — not on the destination`; the noop with no
  membership write and a lock 409 without the torn prefix → refusals; other
  4xx refusals, 5xx ambiguous. **Receipt:** the STRING case_id. **Sync:** the
  `/pipeline/move` matcher already carries `changes` (stage columns + type /
  subtype). Nothing added.
- Tests: `tests/caseyPipelineTransfer.test.js` (normalizer + the browser
  functions lifted by name), gated `tests/caseyPipelineTransfer.mysql.test.js`
  (the projection = the real resolver after the real route, the intake
  destination, the resolver refusal beside the route's real phantom, the torn
  state under a held lock, the precheck over the real GETs),
  `tests/assistantUi.test.js`, `tests/assistantPromptKinds.test.js`,
  `tests/caseyActionPermissions.test.js`.

#### A9.4: Requirement overrides — set and clear shipped 2026-11-10

Fred (2026-11-09): "Casey can do *at least* anything the user can do in the
UI." The case page's Steps panel marks any step N/A or done (an optional note)
and clears an override (`public/case.html` `pwOverride` / `pwClearOverride` →
POST / DELETE `/api/cases/:id/pipeline/requirements/:key/override` →
`requirementService.setOverride` / `clearOverride`). This is the
"requirement-override sub-slice" A9 deferred; its reason and permission
contract is below.

**What the routes do.** Bare `jwtOrApiKey` (any staff, any API key). POST
{status 'na' | 'done', note?}: 400 for any other status, and for a key no
ACTIVE requirement carries anywhere (any template — overrides bind by key);
404 for an unknown case; otherwise an upsert on (case_id, requirement_key)
with `set_by` = the JWT user (0 for an API key) and the note clipped to 255
by JS string length (UTF-16 units — an emoji note is cut mid-character), then
a fire-and-forget case-log row (`type 'status'`, `link_type 'case'`, by the
user or 0): `Requirement <key>: marked N/A (override) - <note>` (or `marked
done`; no ` - …` without a note). DELETE: 404 when no override row exists
("No override on requirement …"), else the row is deleted and the log reads
`Requirement <key>: override cleared`. Neither emits a domain event. The
resolver's precedence is override → detector → position, so an override wins
over everything until it is cleared. All pinned on a real engine
(`tests/caseyRequirementOverride.mysql.test.js`).

**Shipped contract.** Two kinds behind A9's `casey_case_pipeline_enabled` (no
new key): `case.requirement.override.v1` {case_id, requirement (key or
label), status, note, evidence} → POST {status, note};
`case.requirement.override.clear.v1` {case_id, requirement, evidence} →
DELETE. `normalizeCaseRequirementOverrideAction`:
- **The step** resolves through `requirementService.getCaseRequirements` —
  the route's own FULL read, BOTH applicable templates, so a retained case's
  intake-history steps (which the panel's "Intake steps" section also offers)
  resolve too — by key (case-insensitive), else by label. A label two keys
  share is refused naming both; an unknown step lists the case's steps. Every
  step carrying the key is marked at once (an override binds by key); the
  card says so when there are two.
- **The reason (manager ruling, flagged to Fred):** `note` is REQUIRED on a
  set (the panel's is optional) — the card comes out of a conversation where
  the reason exists, and the note is the override's only audit trail (the log
  line quotes it). One line, at most 255 characters counted BOTH as code
  points and as UTF-16 units (the service clips by the latter); the card
  refuses instead of letting the route cut it.
- **Permission (manager ruling):** no new gate — the route is jwtOrApiKey,
  the card is any staff. Casey never proposes an override as a side effect of
  another card: the A9 / A9.3 cards still refuse every override-shaped key by
  name and now point at this kind.
- **Refused by name:** any other field (a stage rides no override card); a
  status outside na / done (the others are derived); a set that changes no
  step's status — already done by its detector (named, with its detail), or
  already that override with the same note (nothing to change); a clear with
  no override (the route 404s; the panel shows no clear button). A set over an
  override of the SAME status with a DIFFERENT note is a valid NOTE-ONLY card
  (coordinator ruling, 2026-11-10 — the panel allows it): "status unchanged
  (<status>); note replaced: "<old>" → "<new>"", the log line it writes, and
  no gate / portal / danger change (`note_only` on the draft).
- **Disclosed** — Casey never manufactures or conceals a blocker:
  1. *What the system sees vs what the override declares*, per step: its
     DERIVED status, its detector (registry label; a `manual` step "only an
     override can mark"), the resolver's detail / progress / hint. For a set
     over an existing override and for a clear, the derived status is the
     REAL resolver re-run over a db wrapper that hides exactly this case's
     override on this key from its one overrides read
     (`caseOverrideHiddenDb`); the wrapper must see exactly one such read in
     mysql2's shape, and the projected row must carry no override, or the
     card is refused (fail closed).
  2. *What it unblocks / re-blocks:* A9's gate re-run over the case's
     pipeline with the step before and after (`caseOverrideGate`) — every
     main-lane stage but the current one, plus an intake lead's retention
     crossing: UNBLOCKS (danger line) the moves this step alone was
     blocking, RE-BLOCKS on a clear, and "still blocked" with the other steps
     named. The native Advance and the board's drag check no requirement, so
     there it changes only what the Steps panel shows (said on the card).
  3. *The client portal:* `buildNextSteps`'s own rule — client-visible steps
     with a client label on the current main-lane and upcoming stages; N/A
     and skipped hidden, done shown done — before → after; staff-only, no
     client label and off-scope steps say the portal does not change.
  4. *The case-log line* word for word, `set_by` = the signed-in user (an API
     key would record 0), fire-and-forget.
  5. *The override it replaces / drops:* status, note, author (users name),
     when (firm time).
  A REQUIRED step marked done / N/A that the system does not see done gets a
  danger line, as does a clear that returns a REQUIRED step to open.
- **The card (browser family `case_requirement_override`):** danger exactly
  on those two cases (`caseOverrideDanger`). Freshness: `expected` = the
  matched rows (stage id / key / number, status, derived status), the
  override (status, note, set_by, at), the whole step list's signature
  (key@stage:status:required:override), the resolved template, current stage
  key, history length, and phase / type / subtype. The click re-reads GET
  `…/pipeline/requirements`, GET `…/pipeline` and GET `/api/cases/:id` and
  refuses on any difference before the claim. A step's DERIVED status under
  an override is not re-readable from any route (the override masks it) —
  the card says what it was at preparation.
- **Outcomes:** the clear's "No override on requirement" 404 reads as
  `Refused — nothing written` (someone cleared it first); other 4xx are the
  shared refusal. Result checks read the route payloads (`override` echo on
  a set — key, status, note, case; `cleared: true` on a clear). **Receipt:**
  the STRING case_id (neither route returns a row id). **Sync:** the
  override matcher in `public/js/yc-sync.js` (POST + DELETE, `yc_pipeline`)
  already exists — open case pages reload their pipeline. Nothing added.
- Tests: `tests/caseyRequirementOverride.test.js` (normalizer + the browser
  functions lifted by name), gated
  `tests/caseyRequirementOverride.mysql.test.js` (set / replace / clear on
  the real routes; the projected "returns to" status = the real resolver
  after the real DELETE; the log row; the precheck after hand edits; the
  routes' own 400 / 404 beside the card's refusals and the clipped note),
  `tests/assistantUi.test.js`, `tests/assistantPromptKinds.test.js`,
  `tests/caseyActionPermissions.test.js` (78 kinds / 66 mounts).

#### A10: Checklists and checklist items — create, item add and item update shipped 2026-11-01, edits and deletes (A10.2) 2026-11-11

Creating a checklist or note, adding one item, and updating / completing one
item; A10.2 adds the page's own edits of an existing list (rename, a note's
done state and text) and its deletes (a list, an item). Template expansion and
upsert-many stay separate because they create or affect many records; reorder
does not exist on the page or as an atomic route. The parent record is resolved
server-side, the card shows the item counts, and A10's and A10.2's writes are
all on the sync bus.

**What the routes guard.** Little. The Notes & Lists routes
(`routes/api.checklists.js`, mounted at the ROOT — `/checklists`,
`/checklists/:id/items`, `/checkitems/:id`, not under `/api`) are SQL in the
route behind bare `jwtOrApiKey`. They enforce the note/checklist shape (a note
rejects `items`, a checklist rejects a `body`; a note's parent rejects an item)
and the note body length (lib/noteLimits), and they gate `tag` for staff
(`mayWriteTag`: api_key / SU only) and the detach of another user's personal
list. They do NOT check the parent record exists, the title or item name width
(varchar(255), clipped silently under the relaxed sql_mode), or a duplicate
item name; and the portal's docs predicate is `tag='docs_needed' OR
title='Docs Needed'`, so an untagged case list with that title (any
capitalisation or accent — general_ci) IS the client-facing docs list. All of
this is pinned on a real engine (`tests/caseyChecklists.mysql.test.js`).

**Shipped contract.** Three kinds behind one switch:
`checklist.create.v1` (POST `/checklists` {title, kind, body?, link_type, link,
items?}), `checklist.item.add.v1` (POST `/checklists/:id/items` {name}) and
`checklist.item.update.v1` (PATCH `/checkitems/:id` {name?, status?}).
- **Create.** One checklist (`list_kind` "checklist", up to 25 initial item
  names — name only, each starts incomplete, the route numbers them) or one
  note (`list_kind` "note", optional body) on a case (`link` = the exact
  case_id, cited by an evidence row), a contact (the exact contact_id, cited)
  or the ASKING user's own personal list (no evidence needed; the ledger claim
  is per user, so only the asker can apply it). The draft key is `list_kind`;
  the browser maps it to the route's `kind`.
- **Refused by name**, before anything is read where it is a field: `tag` and
  `position` anywhere (the draft or an initial item); a CASE list or note
  titled "Docs Needed" (folded the way the column's collation compares —
  case, accents, trailing spaces); a list for another user; a list on a bill,
  appointment, task or event (item cards refuse lists of those kinds and
  unlinked lists too); a title or item name over 255; a note body over
  lib/noteLimits; a note with items; a checklist with a body; more than 25
  initial items; an item name already on the list or twice in the initial
  items (trimmed, case-insensitive — stricter than the route); an item card on
  a NOTE; another user's personal list; a no-op update; a record with more
  than 200 lists or a list with more than 200 items (not reviewable on one
  card).
- **Disclosed, not refused:** a list with the same title already on the
  record (a DUPLICATE TITLE warning — duplicates are legal natively); an item
  added to, completed on, reopened on or renamed on a case's DOCS list
  (CLIENT-VISIBLE: the portal shows its items, and the unauthenticated GET
  `/api/public/docs/:caseId` lists its incomplete items) — computed by the
  portal's own predicate, evaluated by the engine; an item added to a complete
  list, or an item reopened on one, REOPENS the list.
- **The item update card** shows the list (title, record), the item before →
  after, and the list status after (derived, lib/checklistStatus.js: the last
  open item completes it; a NULL stored status never transitions, as the
  route's `WHERE status <> ?` cannot match NULL). Its effects mirror the route
  exactly: completing an incomplete item emits `checkitem.completed`; the list
  transitioning to complete emits `checklist.completed` — each dry-run against
  every active trigger rule on that event (`listActiveRulesForEvent` +
  `evaluateDraft`, preview lane, nothing dispatched; "MAY run", danger, when a
  rule cannot be evaluated). Create and item add emit no event and say so.
  Live 2026-11-01 (manager-verified): no active rule on either event (rule 14
  is `checklist.items_upserted`, which these routes never emit).
- **Evidence:** create = a row with the exact case_id / contact_id; item add =
  a row with the exact `checklist_id` (read as `checklists.id AS
  checklist_id`); item update = a row with the exact `checkitem_id`
  (`checkitems.id AS checkitem_id`). Both tables are in the curated report
  manifest, so `sql.read` reads them — no typed read.
- **Freshness:** `expected` = the record's list ids (create); the list's
  title / kind / link / tag / status and every item's id:status:name (item
  cards). The click re-reads GET `/checklists?link_type=&link=` (plus GET
  `/api/cases/:id` or `/api/contacts/:id` for create) or GET `/checklists/:id`
  and refuses on any difference before the claim.
- **Idempotency:** none added. One claim per draft; a second create card makes
  a second list (the warning says so); a second item card's re-read sees the
  first card's item. **Outcomes:** 404 "Checklist not found" / "Item not
  found" are before-write refusals (`knownOutcome`); a 400 is a refusal; a 5xx
  or an answer that does not confirm the write stays ambiguous.
- **Receipt:** the integer `checklist_id` for create and item add (both
  routes return the whole list; the new item is one row of it) and
  `checkitem_id` for the update (the route returns the item row). Two browser
  families (`checklist`, `checkitem`) because a family has one receipt field.
- **Sync (fixed in this slice):** yc-sync had no matcher for any of the three
  routes, so a Casey write was silent to an open Notes & Lists board. Three
  matchers now announce `checklist:<link_type>:<link>` (the doclink split —
  the list belongs to its record's board, so `case:<id>` would cost every open
  case file a full refetch); PATCH `/checkitems/:id` answers the item row
  byte-identical PLUS an additive `checklist: {id, link_type, link}` echo for
  it. checklistView.html subscribes to `checklist:*` and reloads for its own
  record and, on a case board, its contact groups — fenced on its own echo
  (api() stamps writes), and parked while hidden or while someone types
  (reloaded on refocus, visibility, or tab re-entry).
- Off switch `casey_checklists_enabled` (on unless '0'). Tests:
  `tests/caseyChecklists.test.js`, gated `tests/caseyChecklists.mysql.test.js`,
  `tests/assistantUi.test.js`, `tests/ycSync.test.js`,
  `tests/checklistView.sync.test.js`.

**Shipped contract (A10.2, 2026-11-11 — Fred, 2026-11-09: "Casey can do at
least anything the user can do in the UI").** Three more kinds behind the same
switch, each the route the Notes & Lists page (`public/checklistView.html`, also
the case and contact pages' Notes & Lists tabs, which iframe it) uses:
`checklist.update.v1` {checklist_id, title?, status?, body?} → PATCH
`/checklists/:id` (the page's editTitle / toggleNoteDone / saveBody),
`checklist.delete.v1` {checklist_id} → DELETE `/checklists/:id` (deleteList) and
`checklist.item.delete.v1` {checkitem_id} → DELETE `/checkitems/:id`
(deleteItem). There is no reorder kind: the page has no item reorder (no drag
handler, no position write) and the routes no atomic reorder — only one
`position` per PATCH `/checkitems/:id`, which no surface sends (manager ruling,
2026-11-11).
- **Refused by name**, before anything is read: `tag` (system field, SU-only)
  and `position` anywhere; on an update `list_kind` (a list's kind never changes
  — the route 400s it), `link` / `link_type` (the page never moves a list) and
  `items` (item cards' job); any other unknown field.
- **Update.** At least one field. The title is trimmed, one line, non-empty,
  and at most the column's width in CHARACTERS, read from
  `information_schema.COLUMNS` (the route clips silently — pinned). `status`
  is "complete" / "incomplete" and in the column's ENUM, and `body` is the
  WHOLE new text (tabs and newlines kept, other control characters refused,
  `lib/noteLimits`); both on a NOTE only — the route's own rule, judged on the
  stored kind. A field equal to the stored value is dropped, and a card left
  with nothing is refused (NULL and '' are one empty note). A rename INTO "Docs
  Needed" on a case is refused (DOCS LIST, as create); a rename OUT of a
  title-only docs list is a CLIENT-VISIBLE warning (the portal and the public
  documents link stop showing it); a duplicate title on the record is warned.
  No event, no pipeline step reads a title, a note or its text — said.
- **Delete.** NO UNDO always, with the cascade (the items go by
  `checkitems_ibfk_1` ON DELETE CASCADE): the counts (done / open) and the first
  30 items, or a note's text length. Disclosed: the docs list (CLIENT-VISIBLE —
  gone from the portal and the public documents link), a tagged list (SYSTEM
  LIST — automation finds nothing by that tag), a contact's list (gone from
  their tab and their group on every case board they are on, counted from
  case_relate). Another user's personal list is refused naming its owner,
  unless the asking user is a SUPERUSER (`rowIsSuperuser` on the users row —
  the route's `mayDetachPersonal` reads the JWT's roles; a change between is
  the route's 403): then it is a card with an ANOTHER USER'S LIST warning. No
  event.
- **Item delete.** NO UNDO (offering check-off instead); the derived list
  status after (`lib/checklistStatus.js`, the route recomputes): the last open
  item completes the list and `checklist.completed` is dry-run against the
  active rules (preview lane, as A10's update); the only item of a complete
  list REOPENS it (an empty checklist is never complete; no event); a docs-list
  item is CLIENT-VISIBLE (open: no longer asked for; done: no longer shown as
  received).
- **The pipeline projection** (delete, item delete): the requirementDetectors
  `checklist` detector reads a case's tagged CHECKLISTS' stored status and item
  counts, so a delete can move a step. The card re-runs the REAL resolver
  (`requirementService.resolveRequirements`) over `checklistProjectedDb`, which
  rewrites exactly this list in the detector's two reads — dropped, or its
  status and counts replaced — and names every step whose status moves
  (`PIPELINE:` danger, `pipeline` on the draft); a case with no checklist step,
  a contact or personal list, and an unchanged step each say so. Shape guard,
  fail closed: at most one read of each table, mysql2's shape, the same list
  reads with and without the projection.
- **Freshness / outcomes.** `expected` = the list's title, kind, record, tag,
  status, TEXT and every item's id:status:name; the click re-reads GET
  `/checklists/:id` and refuses on any difference (an item already gone reads
  "someone already deleted it"). 404 "Checklist not found" / "Item not found"
  and the detach 403 are refusals (`knownOutcome`). Receipts: the integer
  checklist_id (update — the PATCH returns the list — and delete) or
  checkitem_id (item delete); the DELETEs answer `{status, message}` plus only
  the record's address (for the bus), so the receipt is the reviewed row. Browser families `checklist_update`
  (danger with a warning), `checklist_delete` and `checkitem_delete` (always
  danger).
- **Sync.** PATCH and DELETE `/checklists/:id` and DELETE `/checkitems/:id`
  are on yc-sync (`checklist:<link_type>:<link>`; the DELETEs echo the record,
  a re-homing PATCH adds `moved_from`), so another open board for the record
  refreshes; the global page's Browse view does not listen (each card says
  so; `ref/plans.md`).
- Tests: `tests/caseyChecklistEdit.test.js` (mocked; the real resolver over a
  fake db; browser lifted by name), gated `tests/caseyChecklistEdit.mysql.test.js`
  (the real routes; the projection equals the real resolver after the real
  write), `tests/assistantUi.test.js`, `tests/assistantPromptKinds.test.js`,
  `tests/caseyActionPermissions.test.js`.

**Deferred** (`ref/plans.md`): lists for another user (except a superuser's
delete); lists on bills, appointments, tasks and events; reorder — no surface
offers it and no route does it atomically; upsert-many and template expansion.

#### A11: Documents — update and link shipped 2026-11-02

Editing a registered document's staff metadata and linking a document to a
case or contact come first. Upload bytes, signed upload URLs and provider
credentials never become model output. Sharing and unlinking are A11.2, the
case folder relink A11.1; registering by external id, generation,
external-store sync, replacement and deletion stay separate sub-slices with
exact destination, filename/template, overwrite, link, recipient and
external-provider effects shown in review, and no screen changes a status.

**What the routes guard.** Little. `PATCH /api/documents/:id` and `POST
/api/documents/:id/links` (`routes/api.documents.js` → `documentService`) sit
behind bare `jwtOrApiKey`. `documentService.update` CLIPS an over-width title
(varchar 255), doc_type (64) or tags (512, after `normalizeTags`: lowercase,
spaces → hyphens, deduplicated, comma-joined; empty → NULL) silently and
answers success; it writes and emits nothing when every field is unchanged by
domainEvents' compare (trimmed, NULL = ''). `documentService.link` answers a
repeat as success (`created:false`, no row, no event) — also for a `link_id`
that differs only in case, because the UNIQUE key (document_id, link_type,
link_id) compares under general_ci — and the link route never looks at the
document's status. All of this is pinned on a real engine
(`tests/caseyDocuments.mysql.test.js`).

**Read enablement.** `documents` and `document_links` joined the curated
report manifest (`lib/reportSchema/manifest.js`), so `sql.read` reads a
document (`documents.id AS document_id`) and its links — no typed read. The
sync / provider internals (external_id, path_lower, path_hash, content_hash,
rev, ai_meta) are unlisted; `shared_link` is on `DENIED_COLUMNS` (a permanent
public link is a capability, never data). The `yc_report` grants follow the
manifest: `scripts/reportGrantUserProvision.js --apply` must run against
production BEFORE the backend deploy, or every Casey / report read of the two
tables is `SELECT command denied`. The manifest's `checklists` entry gained
`kind`, `body` and the `event` link type in the same commit.

**Shipped contract.** Two kinds behind one switch:
`document.update.v1` (PATCH `/api/documents/:id` {title?, doc_type?, tags?})
and `document.link.v1` (POST `/api/documents/:id/links` {link_type, link_id,
relation?}).
- **Update.** At least one of title / doc_type / tags; "" clears one (the
  native edit dialog sends "" too). The browser sends only the fields that
  change, trimmed, tags in their stored form.
- **Link.** `link_type` "case" (link_id = the exact case_id) or "contact"
  (link_id = the exact integer contact_id); `relation` optional — one short
  plain word (≤ 32), disclosed as an existing word (with its count) or a NEW
  one; never required.
- **Refused by name**, before anything is read: `status` (delete / restore /
  missing — no screen offers it; the Dropbox sync owns it) and the
  provider-owned `name`, `path`, `external_id`, `shared_link` (written only by
  the share route — A11.2's card); relation **"path"** — the
  Dropbox sync's own mark: its reconciler retracts only path links without a
  creator, but its attribution sweep skips any document holding a case link
  with that relation, so a person's "path" link would silently stop the sync
  attributing the file (a tightening of the boot prompt, which listed "path"
  among the words the model may name).
- **Refused, besides:** a deleted or missing document (stricter than the link
  route); a value over its column width, counted in characters as the column
  counts (code points) and, for tags, on the stored form; a no-op by the
  service's own compare; a link to anything but a case or contact; a target
  that no longer exists; a link that already exists — folded the way the
  general_ci UNIQUE key compares (stricter than the route's silent success);
  a document already linked to more than 20 records (5 or more is disclosed).
- **Disclosed:** a pending delete (Dropbox reported the file deleted; the
  registry marks it deleted after the ~30-minute grace unless it reappears);
  the stored tag form when it differs from what was asked; a type already on N
  other documents or NEW; a field already equal ("not sent"); where the
  document shows.
- **The update card** shows the document (file name, path, size, source,
  modified), each changed field before → after, the records it is linked to
  (so the user sees where the retitle shows), that the title is searchable,
  and that documents are staff-only (the client portal lists none).
- **The link card** shows the document, the target record, the existing
  links, the relation, and exactly where it starts to show:
  `documentService.resolveRelatedTargets` — the predicate the Documents tabs'
  "Include related" view (on by default) reads — so a case link names each
  contact on the case and a contact link each case the contact is on, ONE hop,
  badged "via" the target; plus the triage effect (a document's first case
  link takes it off the Documents page's "no case" list) and that a person's
  link is kept when the file moves.
- **Automation:** each card dry-runs the event the service emits —
  `document.updated` (exactly the changed fields, `domainEvents.buildChanges`
  over the prior row; a cleared tag set is NULL) or `document.linked` (the
  target promoted to case_id / contact_id) — against every active rule
  (`listActiveRulesForEvent` + `evaluateDraft`, preview lane, nothing
  dispatched; "MAY run", danger, when a rule cannot be evaluated).
- **Evidence:** a row carrying the exact `document_id` (update); the document
  row AND a row carrying the exact case_id / contact_id (link — A8's two-row
  pattern). The report pool returns BIGINT as a string, so the id is compared
  numerically.
- **Freshness:** `expected` = title / doc_type / tags / status / updated_at
  (update; a sync rename bumps updated_at, so it refuses too) or status + the
  whole link set (link: id:type:link_id:relation). The click re-reads GET
  `/api/documents/:id` (plus the target's GET for a link) and refuses on any
  difference before the claim.
- **Idempotency:** none added. One claim per draft; a second link card's
  re-read sees the first card's link; a link made between the re-read and the
  write comes back `created:false`, read as a refusal ("nothing written, no
  automation ran"). **Outcomes:** 404 "Document not found" is a before-write
  refusal (`knownOutcome`); a 400 is a refusal; a 5xx or an answer that does
  not confirm the write (another document, unsaved values, no matching link
  row) stays ambiguous.
- **Receipt:** the integer `document_id` (update — the PATCH returns the
  row) and `document_link_id` (link — the POST returns every link row; the one
  matching the reviewed target is the receipt). Two browser families
  (`document`, `doclink`) because a family has one receipt field.
- **Sync:** nothing added. The existing matchers carry both writes: PATCH →
  `document:<id>` with the four human-owned values; POST links →
  `doclink:<link_type>:<link_id>` refetch (pinned with the routes' exact
  answers in `tests/ycSync.test.js`).
- Off switch `casey_documents_enabled` (on unless '0'). Tests:
  `tests/caseyDocuments.test.js`, gated `tests/caseyDocuments.mysql.test.js`,
  `tests/assistantUi.test.js`, `tests/ycSync.test.js`,
  `tests/reportSchemaDenylist.test.js`.

**Deferred** (`ref/plans.md`): share and unlink shipped as A11.2, the relink
confirm as A11.1 (both below); what remains is A11.2's Deferred list, each with
its reason.

#### A11.1: Case folder relink — shipped 2026-11-03

Origin: the 2026-11-02 note on cases without a Dropbox folder (15 cases with a
blank `case_status` lack `case_dropbox`; 119,056 active documents had no link,
1,099 folders were cached, none dismissed — measured 2026-11-03). One kind
claims ONE Dropbox folder for ONE case through the Documents relink panel's own
confirm.

**What the route guards.** `POST /api/documents/relink` {case_id, folder_path}
(`routes/api.documents.js` → `documentSyncService.applyRelink`, bare
`jwtOrApiKey`) answers `{status:'success', result:{skipped:true}}` — 200,
nothing written — while `documents_sync_enabled` is not `'1'`. Otherwise, in
order: 400 for a blank / relative path, a root, or a folder under no enabled
sync root; 404 for an unknown case; **409** when another case's
`case_folder_cache` row holds the folder (`_loadFolderOwners` — exact
`path_lower` EQUALITY; a folder merely inside another case's folder passes and
is a nesting note); 404 for a folder Dropbox does not have (only when no
registered file is under it); then it mints the folder's permanent shared link
(Dropbox's existing direct link, else a new PUBLIC one), rewrites
`cases.case_dropbox` through `updateCase` (`source:'documents_relink'` —
`case.updated`, fire-and-forget), refreshes this case's cache row, DETACHES the
case's sync-made links (relation `path`, no creator) to documents outside the
folder (`reconcileCaseFolderLinks`), attaches what is under it with engine
parity (innermost cached folder; add-only — a document already holding any
case's sync link is skipped; at most 20,000 rows considered), clears the
dismissal and writes one `update` log entry with the old path and old link. A
Dropbox error before the write can answer 4xx (`mapErrorStatus` reads
"→ 4xx:" out of the message); every 4xx is thrown before step 4 (audited), the
502 / 500 pre-write errors stay ambiguous. All of it is pinned on a real engine
(`tests/caseyRelink.mysql.test.js`, the Dropbox provider stubbed at its
boundary). The panel itself lists only cases in its queue (a cached folder,
no attributed document) and offers only candidates — weak ones behind a toggle
and a second tick; it has **no typed-path field** (the route accepts any path,
no screen sends one).

**Read enablement.** A typed read `document.relink.candidates` {case_id}
(app pool — `case_folder_cache` stays OUT of the report manifest; no grant run)
→ `documentSyncService.relinkCandidates` — the panel's own read, open to any staff member as its route is — NEVER
`includeWeak` (not exposed: surname-only suggestions are a different client
nearly every time — the service header's measurement). Rows: a head row
(docket, clients, `current_path`, `current_link` — `case_dropbox`, already
readable through `sql.read` — the resolve error, the dismissal, the count,
`candidates_truncated`) and one row per candidate (≤ the service's cap of 10):
exact `path`, transitive `files`, `newest`, `confidence` / `matched_on`,
`already_linked_to`, `inside_case_id`, `nested_case_ids`, `is_current`,
`proposable`. It works for ANY case, including cases outside the panel's queue
(no folder at all, or documents already attributed).

**Shipped contract.** One kind, `case.folder.relink.v1` {case_id, folder_path,
evidence} → that route.
- **Refused by name before anything is read**, in order: bulk keys (`case_ids`,
  `all`, `folders`, `paths` … — quoting the route header: "a bulk verb would
  exist to save eight clicks and would be the single most dangerous button in
  the app"); dismiss / undismiss / undo / restore; unlink / detach / clear /
  remove; weak / force / override / skip; free-typed folder keys (`path`,
  `folder`, `dropbox_path`, `url`, `shared_link`, `case_dropbox` …); any other
  key.
- **Two sources:** a `sql.read` row carrying the exact case_id AND a cited
  candidate row from a `document.relink.candidates` read of the SAME case whose
  `path` equals `folder_path` byte for byte. Refused: no candidates read; a
  read of another case; a path the read did not list ("NOT A CANDIDATE … pick it
  in the Documents relink panel" — which also cannot take a typed path; a
  re-cased copy is told to copy exactly); the candidate row not cited.
- **Refused after the reads** (`relinkCandidates` re-run without weak matches):
  a gone case; the sync switched off (the route would only skip); a folder no
  longer a candidate; a candidate whose `already_linked_to` names another case
  (the route's 409, named); the case's current folder (a no-op).
- **The card** — danger-styled always (a rewritten link, documents moved on and
  off the case, no undo): the case (number, clients) and the folder (path,
  registered files, newest); the lane it matched on; what the case points at
  now (or no folder); that `cases.case_dropbox` is REWRITTEN with the folder's
  permanent shared link (Dropbox's existing one, else a new public one — the
  old link survives only in the audit entry); the attach count predicted with
  applyRelink's own predicates (step 7's rows matched with `_matchCase` against
  the cache as step 5 leaves it), with the files that already carry a case's
  sync link (named by case) and those under nested case folders, and "at
  least" plus a LARGE FOLDER warning past 20,000; the detach count
  (`reconcileCaseFolderLinks`' clause — a danger line when non-zero) and the
  person-made links that stay; nested case folders keep their files; INSIDE
  ANOTHER CASE'S FOLDER (danger); the Documents tab (staff only — the portal
  lists no documents); FILING: client uploads (portal and public documents
  link → "Client Uploads"), form PDFs, signed e-sign documents and
  `{{case_dropbox}}` automation steps go to this folder from now on; the
  dismissal it clears; truncated candidates; a cache that fails to resolve
  attaches / detaches nothing until the next cache run; the audit entry; and
  **NO UNDO**: recovery is re-linking the correct folder (which retracts these
  sync links) or per-document unlink plus clearing the link by hand — the
  audit entry keeps the old path and link. `case.updated` (updateCase's own
  envelope, source `documents_relink`, `changes.case_dropbox`, the new link a
  stand-in — it is minted at the click) is dry-run against every active rule
  (A9's `listActiveRulesForEvent` + `evaluateDraft`, preview lane, nothing
  dispatched; "MAY run", danger, when a rule cannot be evaluated).
- **Freshness:** `expected` = the case's link and cached path and the
  candidate's path / file count / owners; the click re-reads GET
  `/api/documents/relink/:caseId/candidates` and refuses on ANY difference
  before the claim (re-pointed, folder claimed, gone, file count changed).
- **Idempotency:** none added — one claim per draft; a second card's re-read
  sees the changed folder (and the normalizer refuses the current folder).
- **Outcomes:** `result.skipped` is NOT done — read as a refusal, never a
  success; the 409 (matched by the service's message) is a refusal naming the
  case; a 400 / 404 refuses by the shared rule; any other 409, a 5xx and an
  answer that does not confirm the case and a new link stay ambiguous.
- **Receipt:** the STRING case_id from `result` (A7c's string path); a new
  browser family `case_folder` (applied key `result_folder_case_id`). The
  applied line carries the route's detached / attached counts and notes.
- **Sync (new):** `POST /api/documents/relink` had no matcher (the panel
  repaints itself). It now announces `case:<case_id>` with the real value
  `{case_dropbox: result.shared_link}` and `doclink:case:<case_id>` (refetch —
  the case's Documents tab's own address); a skip, a missing case id or link
  announce nothing (`tests/ycSync.test.js`, the answer's key set pinned against
  the real route in the twin). The case page merges the value; its Dropbox
  panel is embedded once at load and shows the new folder on reopen (native
  gap, `ref/plans.md`).
- Off switch `casey_document_relink_enabled` (on unless '0', casey section,
  sort 66). Tests: `tests/caseyRelink.test.js`, gated
  `tests/caseyRelink.mysql.test.js`, `tests/assistantUi.test.js`,
  `tests/ycSync.test.js`.

**Deferred** (`ref/plans.md`): free-typed folder paths; relink dismiss /
undo-dismiss through Casey; unlinking on the folder card (one document's link
is A11.2's unlink card); an undo verb for a claim (pending Fred); bulk
anything — NEVER.

#### A11.2: Documents — share and unlink shipped 2026-11-11

Origin: Fred's standing rule (2026-11-09) — "Casey can do *at least* anything
the user can do in the UI." The Documents page (`public/documents.html`)
offers three per-document controls A11 refused by name: the row's **Copy
public link** button (`onCopyLink` → POST `/api/documents/:id/share`, on every
row, whatever its status — no flag, tag or status marks a document
unshareable), the Links dialog's **Unlink** button (`onLinks` → DELETE
`/api/documents/:id/links {link_type, link_id}`, on EVERY link — the last one
included, any document status, with no confirm), and nothing else. Its edit
dialog sends `{title, doc_type, tags}` only: **no screen changes a document's
status**, so no status kind is built (Deferred, below).

**What the routes guard.** Both bare `jwtOrApiKey`. The share route
(`loadOr404` → `sources.get(row.source).ensureSharedLink` →
`documentService.setSharedLink`) is the only site that mints a document's
permanent link: `dropboxService.getOrCreateSharedLink` lists the file's direct
links (`sharing/list_shared_links`, `direct_only`) and returns the first —
whatever settings it was made with, possibly outside YisraCase — else creates
one with `requested_visibility: 'public'` and no expiry; the route stores the
answer (clamped to varchar(512)) and returns `{status, shared_link}`. It never
looks at the document's status, and it ALWAYS asks Dropbox, even when a link
is stored (the page never calls it then — its button copies the stored link
and never asks Dropbox again). Nothing in YisraCase revokes a link; Dropbox's
own sharing settings do, and a revoked link stays stored (dead) until a later
share replaces it. No event (`setSharedLink` emits nothing). A Dropbox error
maps through `mapErrorStatus`: its 409 from either sharing call passes through
as 409 — nothing was created. The unlink route deletes
`WHERE document_id AND link_type AND link_id` (general_ci — case-folded) and
answers `{status, removed:true, link_type, link_id}` echoing the request, or
404 "Link not found"; no event (`document.unlinked` is unregistered). Pinned
on a real engine (`tests/caseyDocumentShare.mysql.test.js`, Dropbox stubbed at
`getOrCreateSharedLink`).

**Shipped contract.** Two kinds behind A11's switch
`casey_documents_enabled`: `document.share.v1` {document_id, evidence} and
`document.unlink.v1` {document_id, link_type, link_id, evidence}.
- **Refused by name before anything is read** (A11's rule, both kinds):
  `status`, `shared_link`, `name`, `path`, `external_id`; any other key.
- **Share.** Evidence: a row carrying the exact `document_id`. A deleted /
  missing / gone document refuses (Dropbox has no file to share — the route
  would ask anyway and fail with its 409). The server reads only WHETHER a link
  is stored (`(shared_link IS NOT NULL AND shared_link <> '')`), never the link
  — the column stays on `DENIED_COLUMNS`. Card, always danger: PUBLIC LINK
  (permanent, anyone holding it opens and downloads the file, no login, no
  expiry, nothing records who opens it); NEW LINK when none is stored (Dropbox's
  existing link for the file, with its own settings, else a new public one);
  ALREADY SHARED otherwise (nothing new, unless Dropbox lost the link — then a
  new one replaces it); PENDING DELETE; revoking only in Dropbox; the link is
  shown only after the click; Casey sends it nowhere; no trigger event; the
  document, its title / type and every record it is linked to.
- **Unlink.** `link_type` "case" (exact case_id) or "contact" (exact
  contact_id) — another type refuses (the Links dialog unlinks it). Evidence:
  the document row AND the record's row (its case_id / contact_id) or the
  `document_links` row (link_type + link_id). Refused: a gone document; a link
  the document does not have (folded as the DELETE compares — the route's
  404); a document linked to more than 20 records (A11's review cap). A
  deleted or missing document is DISCLOSED, not refused — the dialog offers
  it. The request carries the link row's own stored spelling. Card, always
  danger: the link (record, relation, made by a person or by the Dropbox
  sync), the links before and after; where it stops showing —
  `resolveRelatedTargets` of the removed link minus everything the remaining
  links still reach (the "Include related" predicate, one hop): the record's
  own tab (left, or still shown through another link), each related tab it
  leaves (badged "via" today), each it keeps; LINKED TO NOTHING (danger) for
  the last link; the triage effect (no case link left → back on the "Unlinked"
  list); **COMES BACK** (danger) when the link is a case link of an active
  document whose file sits in that case's folder — `documentSyncService
  ._matchCase` over the `case_folder_cache` rows of the path's ancestors: the
  sync re-adds a case "path" link whenever the file changes in Dropbox
  (`documents.link`, firing `document.linked`) and, when no case path link is
  left, on a later sweep lap (`attributeUnlinked`, silent) — with the sync
  switched off said so; the lasting fix is moving the file; the file, the
  title / type / tags and the other links untouched; no undo (a re-link is a
  new row; Casey never writes "path"); no trigger event.
- **Freshness.** `expected` = status, link presence, name / title / doc_type
  and the whole link set (share) or status and the whole link set (unlink);
  the click re-reads GET `/api/documents/:id` and refuses on ANY difference
  before the claim (shared since, link removed, retitled, renamed by the sync,
  a link added or removed, the reviewed link row gone, status changed).
- **Idempotency:** none added — one claim per draft. A second share is
  Dropbox's get-or-create (the same link back, stored unchanged); a second
  unlink is the route's 404, read as a refusal.
- **Outcomes.** Share: 404 "Document not found" and Dropbox's 409 from
  `sharing/list_shared_links` / `create_shared_link_with_settings` are
  refusals (nothing was made or stored); the answer must carry an `https://`
  link of at most 512 characters, else ambiguous (a link may exist at Dropbox).
  Unlink: 404 "Link not found" is a refusal; the answer must echo
  `removed:true` with the reviewed link_type / link_id.
- **The link, in the browser only.** The share answer's link is kept on the
  draft as a NON-enumerable property: shown on the applied card with a "Copy
  public link" button (the Documents page's own clipboard call and its
  copy-by-hand fallback), never serialized into the chat, the action ledger or
  the model's history. The applied copy says whether Dropbox returned the
  stored link or a new one. A card reopened from history (or replayed from
  the ledger) points at the Documents page's button instead. No auto-copy
  after the click (the card shows it).
- **Receipts:** the reviewed integer `document_id` (share — the route answers
  only the link, never a receipt) and the reviewed `document_link_id` (unlink
  — the DELETE echoes no id). Browser families `docshare` and `docunlink`.
- **Sync:** nothing added. Both routes already have matchers —
  `POST /api/documents/:id/share` announces `document:<id>` with the stored
  `shared_link` value; `DELETE /api/documents/:id/links` announces
  `doclink:<link_type>:<link_id>` (refetch) from the echo.
- Tests: `tests/caseyDocumentShare.test.js` (mocked; browser lifted by name),
  gated `tests/caseyDocumentShare.mysql.test.js` (the real routes; the real
  sweep re-adding the unlinked case link), `tests/assistantUi.test.js`,
  `tests/assistantPromptKinds.test.js`, `tests/caseyActionPermissions.test.js`.

**Deferred** (`ref/plans.md`): a status change (delete / restore / missing) —
no screen offers one: the edit dialog saves title / type / tags, and the
Dropbox sync owns the status; register by external id, generate, upload,
replacement and deletion — none is a control on an existing document's row
(upload and generate are the page's own flows with a destination, a filename
and an overwrite to review); sync roots and relink dismiss — the sync panel's
engine configuration and queue, not per-document actions; a link type other
than case / contact (no screen makes one; the Links dialog unlinks it).

#### A12: Forms — draft and submission link shipped 2026-11-02

Start with a form draft or prefill and save/link it to a resolved record.
Draft discard and PDF filing are A12.2's kinds, and submitting a stored draft
is A12.3's; template editing, publishing, visibility changes and version
restore are form-builder operations with no card.
Render the template/version, destination, material answers, overwrite behavior,
and whether the operation makes anything client-visible.

**What the routes guard.** POST `/api/forms/draft` (`routes/api.forms.js` →
`formService.upsertDraft`, bare `jwtOrApiKey`) checks only that form_key,
link_type, link_id and data are present: it is `INSERT … ON DUPLICATE KEY
UPDATE data = VALUES(data)` on the generated `draft_key` (one draft per
form_key + link_type + link_id, compared under general_ci), so a second save
keeps the row and REPLACES the whole payload — any answer it does not carry is
gone — and stamps the body's `schema_version` (1 when the body omits it). It
validates nothing against the template and emits no event. PATCH
`/api/forms/submissions/:id/link` → `formService.linkSubmission` answers 400 for
a draft, 409 for an already-linked row (its own read, and its conditional
UPDATE losing a race) and for another link type than the template's (a
submission with no template row skips that check), 404 for an unknown
submission or target; it renumbers the version to MAX + 1 of the TARGET
series, stamps `linked_by` / `linked_at`, writes one best-effort `form` log
entry ("Form adopted: <title>" / "… was linked to this <type> from the Form
Inbox." — fixed wording) and stamps `cases.case_intake_form = 'yf:<id>'` for an
`intake` form only when the pointer is `''` (the column is NOT NULL). All of it
is pinned on a real engine (`tests/caseyForms.mysql.test.js`).

**Read enablement.** `form_templates` is outside the curated report manifest
(adding it needs the production grant re-run, A11), so a TYPED read on the app
pool, `form.template` {form_key, search?} — the A6.0 `contact.relations`
precedent: the template's title, link type, visibility, schema_version,
published flag, data mode and server-drafts flag, and the PUBLISHED
definition's field list (key, label, type, required, options as a JSON list,
mask, min / max, max length, repeater rows) through
`extFormService.buildValueRegistry` — the registry the external draft and
submit routes check keys against; display-only items are left out and the raw
definition never leaves the server. An unpublished template returns its head
row only. 49 field rows per read; `search` narrows by key or label. The
`form_submissions` rows themselves are in the manifest (`data` readable), so
`sql.read` reads drafts and submissions.

**Shipped contract.** Two kinds behind one switch: `form.draft.v1` (POST
`/api/forms/draft` {form_key, link_type, link_id, schema_version, data}) and
`form.submission.link.v1` (PATCH `/api/forms/submissions/:id/link` {link_type,
link_id}).
- **Refused by name**, before anything is read: the route-owned columns
  `status`, `version`, `submitted_by`, `schema_version`; any key shaped like
  another form operation (submit, pdf / render / file, publish, delete /
  discard, visibility, restore, unlink / relink, template — the discard and the
  PDF are their own A12.2 cards); any other unknown key. An appointment record
  is accepted since A12.2 (link_type "appt"): no live template links to one
  today (verified 2026-11-11); the code accepts it throughout.
- **Draft.** The evidence cites a row with the exact case_id / contact_id AND
  the investigation holds a `form.template` read of that form_key (the field
  keys come from it, never from memory). Refused: an unknown form_key; an
  unpublished template; a link type other than the template's; a gone record;
  a key the published form does not have (display-only items carry no
  answer); a value of the wrong type — text for text / textarea / hidden (no
  line break in a one-line field, the field's max length), a finite number
  inside min / max, an ISO date, `YYYY-MM-DDTHH:MM`, one listed option for a
  select / radio (an `optionsFrom` list is filled when the form opens, so only
  the template's static values pass), a boolean for a checkbox, option values
  for a checkgroup (one extra value when it has an Other box), words for tags,
  row objects of the repeater's own fields (≤ 50 rows); `null`; a payload over
  64 KB; a card over 60,000 characters (it carries the whole draft, and the
  chat stores a message's details up to 100,000); a stored draft that is not a
  JSON object; a no-op. Values are stored
  the way yc-forms' `collect()` stores them (numbers as text, lists
  comma-joined, masks stripped — disclosed). Required answers left empty are
  disclosed, not refused (a draft never submits).
- **The carry-forward.** The normalizer reads the existing draft through
  `formService.getLatest` (the read the click re-runs) and sends every answer
  it holds that the card does not set again VERBATIM — the card says "N
  existing answers carried forward unchanged" (and how many are not on the
  current form). The body's `schema_version` is the template's (server-chosen;
  the route would store 1).
- **Disclosed:** each answer before → after (an answer already equal is shown
  unchanged); who last saved the draft and when — someone else (the client
  included) within 24 hours is a danger warning; **RESTORE BLANKS** — the form's
  Restore populates every field from the draft, so each field the draft does
  not hold shows blank, and a save after it saves the blanks (and writes the
  record when the form patches it) — a danger warning naming them; the latest
  SUBMITTED row is untouched; the form-version restamp; no trigger event and no
  pipeline step (both count submitted forms only). **Client visibility**, read
  off the serving code: only `public` templates are served outside the app
  (`getServableTemplate`'s default scope), and the public page reads a server
  draft back only when the template set `external.serverDrafts === true`
  (case-linked) — then the D1 GET returns whatever draft row exists, staff
  draft included, and the card warns CLIENT-VISIBLE; otherwise (public without
  server drafts, portal, internal) the card says no client sees it.
- **Link.** The evidence cites the submission's row (`form_submissions.id AS
  submission_id`; the report pool's BIGINT string accepted) AND a row with the
  target's exact id. Refused first, in the route's words: gone, a draft, already
  linked, a link type other than the template's, a gone target — plus a
  submission whose form has NO template (stricter than the route, which skips
  the check). **Identity** (the Form Inbox's own keys `name` / `phone` /
  `email`): a name matches a person when its first and last words (accents,
  case and punctuation ignored; one word alone) are both among the person's
  name words; a phone when its 10 digits (intake's normalizePhone: a leading 1
  dropped from 11) equal any of the person's phones, ended rows included; an
  email when it equals any of the person's emails, case-insensitive. The
  people are the case's contacts (any role) or the contact. Answers matching
  no one are an IDENTITY MISMATCH danger warning, never a refusal; no answers
  to compare, or a case with no contacts, is said. Disclosed: the version it
  becomes (MAX + 1 of the target series — the newest submission), the form tab
  (snapshot forms show these answers from now on), the log entry word for
  word, the intake gate (`''` stamped / already set), the active pipeline steps
  whose `form` detector names this form_key (case-insensitive) — they read as
  done — and that it emits no event.
- **Freshness:** `expected` = the existing draft's id + updated_at + the
  SHA-256 of its canonical (key-sorted) JSON, or none (draft); the
  submission's status + link_type + link_id + version (link). The click re-reads
  the record (GET `/api/cases/:id` / `/api/contacts/:id`) and GET
  `/api/forms/latest` or GET `/api/forms/submissions/:id`, and refuses on any
  difference before the claim — a draft saved, restored or discarded since, a
  draft that appeared over a "no draft" card, a submission linked since.
- **Idempotency:** none added. One claim per draft; a second draft card re-reads
  the changed draft and refuses; a second link card is refused by its re-read or
  the route's 409.
- **Outcomes:** the link route's 409s ("already linked", "was linked by
  someone else", the template's link type) and 404s (submission, target) are
  before-write refusals (`knownOutcome`); a 400 is a refusal; anything else —
  every draft-route 500, an answer that does not echo the reviewed form and
  record or the submission — stays ambiguous.
- **Receipt:** the integer `submission_id` for both — the draft row the POST
  upserted (it returns the row id) and the submission the PATCH linked. Two
  browser families (`form_draft`, `form_link`): their routes, re-reads and
  outcomes differ.
- **Sync (fixed in this slice):** yc-sync had no matcher for any `/api/forms`
  route, so a Casey draft was silent to an open form. Both routes now announce
  `form:<link_type>:<link_id>` (a `yc_refetch` marker); POST
  `/api/forms/draft` answers its `{id, updated_at}` PLUS an additive
  `{form_key, link_type, link_id}` echo for it (the link route already answers
  the target). `YCForm._setupSync` (public/js/yc-forms.js) subscribes in any
  host that loads yc-sync — render.html loads it in normal internal mode only
  (never external, whose landing host has no `/js/yc-sync.js`): it re-reads GET
  `/api/forms/latest`; a clean form repopulates through `refresh()` and raises
  the draft banner; a form with unsaved typing is never repopulated — it shows
  the newer draft's banner and HOLDS its autosave (which would replace the
  newer draft whole) until Restore / Discard or a save. Fenced on its own
  autosave echo (`_api` stamps draft POSTs, 1.5 s), parked while hidden, mid-save
  or typed in. The older hand-built form pages (casedetails, casedetails-bk,
  341notes, issn, contact-form) do not load yc-sync — the card says so.
- Off switch `casey_forms_enabled` (on unless '0', casey section, sort 64).
  Tests: `tests/caseyForms.test.js`, gated `tests/caseyForms.mysql.test.js`,
  `tests/formRender.sync.test.js`, `tests/assistantUi.test.js`,
  `tests/ycSync.test.js`.

**Deferred** (`ref/plans.md`), each with its reason; discard, PDF filing and
appointment records shipped in A12.2, submit in A12.3:
- **Template editing / publishing / visibility / version restore /
  deletion** — form-builder operations.
- **Unlinking a submission** — no screen does it.
- **The hand-built form pages on the bus** — they do not load yc-sync.

#### A12.2: Forms — draft discard, PDF filing, appointment records shipped 2026-11-11

Fred (2026-11-09): "Casey can do *at least* anything the user can do in the
UI." This slice went through the form controls that work on ONE row. Two had no
card yet: the draft banner's **Discard** (on every form page) and the Form
Inbox's **File** button. Both now have cards. The A12 cards also take
appointment records, because the builder, the renderer and the inbox's adopt
dialog all accept them.

**What the UI does, read from the pages.**
- **Submit is not one route.** yc-forms' `save()` runs the whole Submit in the
  browser:
  1. it validates;
  2. it stops with "No changes to save" when the form equals its baseline;
  3. it PATCHes the record's apiColumn fields to `onSubmit.patch.url`;
  4. it POSTs `/api/forms/submit`;
  5. it DELETEs the draft (fire-and-forget);
  6. it starts each `onSubmit.workflow(s)` entry (up to 3) through
     `/workflows/:id/start` with `make_pdf`, fire-and-forget — a PDF exists
     only if a workflow renders one;
  7. it POSTs `/api/log`.

  `formService.submitForm` inserts the row and emits `form.submitted`. It
  validates nothing, PATCHes nothing, starts nothing and leaves the draft, so
  this slice built no submit card on it. The atomic route is POST
  `/api/forms/submissions/submit-draft` (`services/formSubmitService.js`,
  Fred's go 2026-11-11), which runs the chain server-side for a stored draft;
  its card is A12.3.
- **Discard** → DELETE `/api/forms/draft?form_key&link_type&link_id`
  (`formService.deleteDraft`). It deletes the one draft row matched under
  general_ci and answers `{deleted}` (false when nothing matched) plus its
  query's `form_key` / `link_type` / `link_id`, which yc-sync announces as
  `form:<link_type>:<link_id>` when a row was deleted. Submit also calls it
  (step 5).
- **File** → POST `/api/forms/submissions/:id/pdf/file` {filename?}
  (`formPdfService.fileSubmissionPdf` → `filePlacementService.placeAndRegister`).
  It renders the submitted row; a draft is a plain Error, so the route answers
  a 500 "submission N is a draft — only submitted forms can be rendered" before
  any upload. The template-less 404s come from `getSubmissionForRender`. It
  uploads with `mode:'add', autorename:true` and registers a `documents` row
  (linked to the case or contact; appointment and unlinked submissions get no
  link), which emits `document.created` / `document.linked`. It is NOT
  idempotent by design: a second filing is a second copy. **Nothing records
  that a submission was filed** — no column on the submission, no link from
  the document. The inbox button refiles without any check.
- **Appointment records.** `formTemplateService` LINK_TYPES (case / contact /
  appt), the builder's link-type select, render.html's `appt_id`, customView's
  `open_form` and the inbox's adopt dialog (an id input) all accept them. No
  live template or submission links to one today (verified 2026-11-11: the
  template link types are `case`; the submission link types are `case` and
  `contact`). The code accepts them throughout.

**Shipped contract.** Two kinds behind A12's `casey_forms_enabled`, which needs
no new key:
- `form.draft.delete.v1` {submission_id (the DRAFT row), evidence}
- `form.pdf.file.v1` {submission_id, filename?, evidence}

Both A12 kinds also take `link_type` "appt" (link_id = the exact appt_id).
- **Refused by name**, on every form card, before anything is read: the
  route-owned columns, any key shaped like another form operation (the
  sentence names each form card's one operation, the submit card included),
  and any unknown key — `again` on a PDF card, and
  `form_key` / `link_type` / `link_id` / `data` on a discard card (the request
  is built from the stored row).
- **Discard.** The evidence cites the draft row (`submission_id`) AND its
  record's row (case_id / contact_id / appt_id). Refused: a gone row; a
  SUBMITTED row (no screen deletes a submission); a row with no record or an
  unknown link type; a gone record (no form page opens it); a row that is no
  longer the draft of its form and record (`getLatest`). A form with no
  template (the hand-built pages) is allowed: its answers are listed by key.
  - **Disclosed:** the form and the record; who saved the draft and when;
    EVERY answer it holds (the template's labels; keys not on the current form
    marked; 40 listed, the count said); the latest submission untouched; no
    event; no pipeline step.
  - **Danger, always:** NO UNDO (the answers are gone for good). THE CLIENT'S
    DRAFT when the client saved it on the public link (with server drafts, the
    link has nothing left to offer them). RECENT DRAFT BY SOMEONE ELSE (< 24 h:
    their open form's next autosave saves a new draft).
  - **Open copies:** the route answers only `{deleted}`, so an open copy keeps
    its banner, Restore there still fills from what it loaded, and its next
    autosave after typing saves a NEW draft.
- **PDF.** The evidence cites the submission AND, when it is linked and the
  record exists, the record's row. Refused: a gone row; a draft; an unknown
  link type; the render's own 404s (no template, no published definition),
  read first through `getSubmissionForRender`.
  - **The file name** is formPdfService's exactly: `{firm-local created
    date} {title} (#id).pdf`, or the override sanitized to 130 characters.
    `filename` is text of at most 200 characters, with no control characters.
  - **The folder** follows the ladder, read-only:
    - a case with `case_dropbox` → `case_folder_cache.path_lower` + `/Forms`
      (the cache never holds `path_display`; the upload is built from the same
      lowercased path);
    - a case with none → CASE FOLDER CREATED (danger: the route creates and
      links a folder and raises a task);
    - a gone case → UNSORTED (danger: the bin's per-case subfolder plus a move
      task);
    - a contact, appointment or unlinked submission → the unsorted bin root
      (`dropbox_unsorted_forms_path`, else the default), with
      `formPdfService._identityPrefix`.
  - **ALREADY FILED** (danger, never a refusal — the inbox button refiles
    without a check; manager ruling, 2026-11-11): active `documents` named
    `LIKE '%(#<id>)%.pdf'`, the default core the inbox route and the
    workflow's `render_submission_pdf` both use. The warning names the first
    copy and the count, and says Casey cannot see a copy filed under a custom
    name. With none, an effect says the same. An override without "(#id)" is
    disclosed as invisible to a later card.
  - **Also disclosed:** the registration (linked to the case / contact, or
    nothing); the trigger rules listening on the document events (listed, not
    run — the row does not exist yet); the version-matched rendering (or that
    the current form is used); that the ~4-hour download link is not kept.
  - Always danger.
- **Appointment records** (both A12 kinds and the discard). The record is read
  as GET `/api/appts/:id` names it: `appointment #<id> (<type>, <firm-local
  date> firm time, <client>[, <status>])`. A link's identity check is against
  the appointment's client; there is no intake gate and no pipeline steps.
- **Freshness:** `expected` holds the draft's id + updated_at + the SHA-256 of
  its canonical stored JSON (discard), or the submission's status + link +
  version (PDF). The click re-reads the record (GET `/api/cases/:id`,
  `/api/contacts/:id` or `/api/appts/:id`), then GET `/api/forms/latest`
  (discard) or GET `/api/forms/submissions/:id` (PDF), and refuses on any
  difference before the claim. The copy count is NOT re-read: no route returns
  it exactly (the documents search is full-text), and it only feeds a warning.
- **Outcomes:**
  - Discard: `{deleted:false}` is a refusal ("already gone").
  - PDF: the 404s (submission, template, published definition) and the draft
    500 (its exact message, thrown before the upload) are refusals.
    Everything else stays ambiguous — an upload failure may already have
    created a case folder.
- **Receipt:** the reviewed `submission_id` for both. The applied PDF card
  keeps the verdict's path, file name, placement, `document_id` and warnings,
  never its `temp_link`. Families `form_discard` and `form_pdf`.
- **Sync:** yc-sync announces the discard (DELETE `/api/forms/draft`, only
  when a row was deleted — an open render.html copy drops its banner; a
  hand-built form page does not listen, and the card says which). The filing
  is not announced: its documents are refreshed by hand.
- Tests: `tests/caseyFormDiscardPdf.test.js` (mocked; browser lifted by name),
  gated `tests/caseyFormDiscardPdf.mysql.test.js` (real routes; Dropbox and
  the PDF renderer stubbed at their boundaries), `tests/caseyForms.test.js`,
  `tests/assistantUi.test.js`, `tests/assistantPromptKinds.test.js`,
  `tests/caseyActionPermissions.test.js`.

**Deferred** (`ref/plans.md`):
- **Template editing / publishing / visibility / version restore /
  deletion** — form-builder operations, not row controls.
- **Unlinking a submission** — no screen does it.
- **The hand-built form pages on the bus.**
- **Native gaps:** the filing is silent on yc-sync; nothing
  records that a submission's PDF was filed (so a re-file is caught only by
  name).

#### A12.3: Forms — submitting a stored draft shipped 2026-11-11

Fred (2026-11-09): "Casey can do *at least* anything the user can do in the
UI." The form page's **Submit** is the one form control A12.2 left without a
card. POST `/api/forms/submissions/submit-draft` {submission_id,
expected_updated_at?} (`services/formSubmitService.js`, staff JWT only) now
runs the page's whole Save chain server-side for a STORED draft, in the page's
order: validate, PATCH the record's apiColumn diff, record the submission,
delete the draft, start each `onSubmit` workflow, write the `form_submit` log
entry. Its header is the contract; this card is its reviewed front.

**Shipped contract.** One kind behind A12's `casey_forms_enabled` (no new
key): `form.submit.v1` {submission_id (the DRAFT row), evidence} → that route
with `expected_updated_at` = the draft's updated_at the card read. Real-engine
twin: `tests/caseyFormSubmit.mysql.test.js`.
- **Refused by name**, before anything is read: the route-owned columns, any
  other form operation, any unknown key — `data`, `form_key`, `link_type`,
  `link_id` among them (the card submits the stored draft exactly as saved; a
  changed answer is a `form.draft.v1` card first).
- **Refused with the route's own reasons, before the click.** The evidence
  cites the draft row AND its record. Refused: a gone row; a SUBMITTED row; a
  row with no record or an unknown link type; a gone record; a row that is no
  longer the draft of its form and record; no published template (404); another
  link type (409); another `schema_version` (409, both versions named — the
  user restores and re-saves the draft on the current version); a non-object
  payload (422); a load / patch URL the route cannot stand in for (422 — the
  route's own message, from `resolvePatchTarget` / `resolveBase`); a docket the
  route's guard refuses (`caseService.docketWriteRefusal`, its message); a gone
  patch record.
- **Every failing answer.** `extFormService.validateValues` stops at the first
  failure, and the route's 400 names that one. The card loops the real
  validator: it records the field named, relaxes that declaration to a bare
  text field in a DEEP CLONE of the definition (values kept, so another
  field's `requiredWhen` still reads them), and runs it again; a field that
  fails again once relaxed holds a value no field accepts (an object, an
  over-long string), so its value is cleared in the clone; an unknown key is
  dropped from the clone; a repeater failure is named by the repeater's key, as
  the route names it. No rule is re-implemented. The refusal lists every label.
- **The diff is the route's.** The card calls formSubmitService's own
  `resolvePatchTarget`, `resolveBase`, `computeDiffAndPatch` and `wfListOf`
  (exported for it — a second copy would drift). The twin pins that the
  columns the card disclosed are exactly the columns the route patched.
- **Disclosed** (always danger — NO UNDO: no screen un-submits a submission):
  - the form, the record, who saved the draft and when, EVERY answer by
    template label (40 listed, the count said), the version it becomes;
  - the answers that differ from the form as loaded (the log entry's diff);
  - RECORD WRITTEN FIRST: each column the patch writes, before → after (the
    record's value as its GET returns it); for a case, A7's code-measured
    readers (`CASE_FIELDS_SURFACES`) per column and a CLIENT-VISIBLE COLUMNS
    warning for a portal-visible one, the docket review (A7e's
    `caseFieldsDocketReview`) when a docket column is in the diff, and the
    judge / trustee links the server re-resolves;
  - every `onSubmit` workflow (name, description, its initData keys, the
    system fields with `make_pdf`) — each start independent and reported,
    never fatal; WORKFLOW WILL NOT START for one that does not exist, was never
    published or is inactive (start_workflow's own refusals, read-only);
  - the trigger rules, dry-run (preview lane, nothing dispatched): the
    record's `case.updated` (source "manual") or `contact.updated` envelope
    when the patch changes something, then `form.submitted` as `submitForm`
    builds it (the next version; a stand-in submission id);
  - the draft consumed (deleted after the submission is recorded; an open
    copy keeps its banner, and its next autosave re-creates a draft); the log
    entry (type form, action form_submit, the diff); the pipeline steps a
    submitted form of this key satisfies (case forms); THE CLIENT'S DRAFT and
    RECENT DRAFT BY SOMEONE ELSE as A12.2's discard says them.
- **Freshness:** `expected` holds the draft's id + updated_at + the SHA-256 of
  its canonical stored JSON, the published `schema_version` + a hash of the
  definition, the latest submission's id (the version it becomes; a snapshot
  form's baseline), and — when the form has an `onSubmit.patch` — the patch
  record's type, id and a hash of its row as its GET returns it. The click
  re-reads the link record, GET `/api/forms/latest`, GET
  `/api/form-templates/render/:form_key` and the patch record (GET
  `/api/cases/:id` / `/api/contacts/:id`), refuses on ANY difference before the
  claim, and sends `expected_updated_at`, so the route's 409 is the last line.
  The record hash is deliberately the whole row: any edit to the record
  between card and click refuses (a changed loaded field can change the diff).
- **Outcomes:** every 4xx the route answers is written before its first write
  — the 409s included (the stale draft, link type and form version precede
  everything; the docket refusal precedes `updateCase`; the contact writer's
  conflicts are thrown inside its rolled-back transaction) — so the family is
  `refusal409`. The 400 with `fields` is a refusal naming them. A 500 stays
  ambiguous (after the record write it names the columns written). On
  success the browser keeps `submission.id`, the version, `patched` (a column
  the card did not show is a problem line), `draft_deleted`, `workflows[]`
  (a `started:false` entry is a problem line naming the workflow) and
  `log_id`: any problem reads "Applied with problems".
- **Receipt:** the NEW submitted row's id (the ledger's rule — the route
  returns it; the reviewed draft row is deleted by the submit). Family
  `form_submit`.
- **Sync:** the route already announces itself on yc-sync (`form:<type>:<id>`
  plus the record's `changes`); this slice adds no matcher.
- Tests: `tests/caseyFormSubmit.test.js` (mocked; browser lifted by name),
  gated `tests/caseyFormSubmit.mysql.test.js` (the real route and
  formSubmitService; workflow starts and domain events stubbed at the
  boundary), `tests/caseyFormDiscardPdf.test.js`, `tests/assistantUi.test.js`,
  `tests/assistantPromptKinds.test.js`, `tests/caseyActionPermissions.test.js`
  (the route is staff-JWT only: an API key is 403).

**Not built**, each with its reason:
- **Submitting answers the draft does not hold** — the route submits the
  stored draft; a change is a draft card first, then a submit card.
- **Contact-writer refusals before the click** — `updateContact`'s blocked
  columns and its other refusals live inside the writer, not in an exported
  rule; the route answers them as a 400 before anything is written, and the
  browser reads it as a refusal.
- **A live scan of stored readers** (reports, form templates, pipeline steps
  naming a patched column — A7's `caseFieldsReaders`): the card discloses A7's
  code-measured surfaces only.
- **Template editing / publishing / visibility / version restore /
  deletion, unlinking a submission** — as A12.2.

#### A13: Message triage — mail read state and case link shipped 2026-11-02 (no drafts: none exist)

The slice as planned: mark a known message read/unread, link one message to a
case, or prepare a non-sent email/SMS draft where a canonical draft operation
exists. A draft must be visibly non-sent. Never reinterpret an endpoint that
sends immediately as a draft endpoint.

**What exists, and what that leaves out.**
- **No drafts.** No draft operation exists anywhere in the mail or phone hub:
  `routes/api.mail.js`, `routes/api.phoneComms.js` and `services/mailbox/*`
  have no draft route, table or service (the comms hub's unsent composer state
  lives in the page and dies with it). The only "draft" is the Ask Casey send
  card's own `draft_id`. So drafts are not in this slice; Casey says there is
  no mail draft operation and never turns a draft request into a send
  (`/api/mail/send` and the phone-line SMS route send at once — A14 is their
  card).
- **No SMS / call triage.** The phone hub has no read-marking and no case-link
  route, so texts and calls are out. A message here is an email in the comms
  hub's store (`mail_messages`).
- **The mail hub's routes** (`routes/api.mail.js`, guard `jwtOrApiKey` +
  `requireJwt`: a staff JWT only — grants and read state belong to a person;
  `services/mailbox/mailReadService.js`): POST / DELETE
  `/api/mail/messages/:id/read` → `setRead` (per-user `mail_read_state`, row
  present = read; INSERT … ON DUPLICATE KEY UPDATE / DELETE, idempotent;
  answers `{id, unread}`); POST `/api/mail/read` {ids | all} → `markRead` —
  BULK, not used; POST `/api/mail/messages/:id/case-link` {case_id} →
  `caseLink`. Every one resolves the message through `loadVisible`: its
  mailbox readable (grant, SU, the attorney read bypass) or a readable alias
  slice admits it, else 404 — exactly as missing.
- **What `caseLink` does** (read whole; pinned on a real engine): in a
  transaction (`retries: 1`, pure DB) it locks the message row and picks a log
  row in this order — the message's own `log_id` stamp, else the lowest-id
  COPY (same RFC Message-ID) carrying a stamp, else another ingest source's
  `email_ingest_executions` row keyed by the Message-ID or a provider id
  (`priorLogId`) — and only when none exists CREATES one with
  `logService.createLogEntry`: type `email`, link `email` → the other party
  (the sender of incoming mail, the first To of the firm's own), about the
  case, written by the user, From / To / Subject and the message's text (the
  plain-text part, else text derived from the HTML — never the HTML; cut at
  50,000 characters), dated when it was sent but never later than it was
  stored. It refuses (409) while the mail sync may still emit the message, and
  for a store-only folder for 10 minutes after it was stored; 422 when there is
  no usable address; 404 for the case or the message. It stamps
  `mail_messages.log_id` when it was NULL and sets the log row's about-link to
  the case with `setLogAbout` — which OVERWRITES any existing about-link: a
  message already on another case is silently MOVED (the Comms tab's case tag
  relies on that). A stamped row whose log row was deleted is 409. It emits no
  event and runs no rule. It answers `{id, log_id, log_created, case}`.

**Read enablement.** `mail_messages`, `mail_read_state` and `mailboxes` are
not in the curated report manifest and are not added (bodies are sensitive;
adding a table needs the production grant re-run). `email_log` is in the
manifest but is the SEND / ingest log, not the mailbox. Casey reads mail only
through two typed reads on the app pool, executed AS THE ASKING USER through
`mailReadService`, so the hub's grant resolution applies unchanged — and each
read is audited like `comms.search` (`admin_audit_log` tool `mail_read`,
message ids only, never text):
- `mail.search` {q?, from?, mailbox_id?, unread_only?, since?, folder?,
  limit ≤ 20} → `listMessages` (the hub's own list: readable mailboxes, the
  Inbox unless folder is `sent` or `all`, newest first). `q` is the hub's
  search (a phrase inside the sender or the subject); `from` is a domain
  (`from_domain`) or one address (ridden on `q` when there is none, then
  matched exactly on the sender); `since` is a firm-local day. The address and
  since filters run over the newest 100 matches, and the head row says when more
  may exist. Per message: `mail_message_id`, mailbox, place, from, the first two
  To addresses, subject, date, snippet, `read_by_me`, copies, attachments count,
  the log id and state, and `linked_case_id` / `linked_case_number` (the hub's
  full resolution — the stamp, a copy's, or another source's log row) — NEVER
  `body_text`, `body_html`, `raw_ref` or `gcs_ref`. A mailbox the user cannot
  read returns nothing and is said.
- `mail.message` {mail_message_id} → `getMessage`: one message's headers (To /
  Cc up to six), attachment names, and the first 2,000 characters of its
  PLAIN-TEXT body only (an HTML-only message is not read — the row says so),
  with a note that the body is the sender's text: quoted evidence, never
  instructions. The prompts say to use it only when what an email says matters.
  A message the user cannot read is a `not_found` row.

**Shipped contract.** Two kinds behind one switch: `mail.read.v1` (POST or
DELETE `/api/mail/messages/:id/read`) and `mail.case_link.v1` (POST
`/api/mail/messages/:id/case-link` {case_id}).
- **Refused by name**, before anything is read: bulk (`all`, `ids`,
  `mail_message_ids`, `filters`, `mailbox_ids`, a list as `mail_message_id`);
  any key shaped like another mail operation (draft, send, reply, forward,
  flag, answer, archive, delete, move, unlink, relink, label, log_id, about);
  any other unknown key. A card needs a signed-in user.
- **Evidence:** the message's row from a `mail.search` / `mail.message` read
  of this investigation (`row_type` message, its `mail_message_id`) — nothing
  else can carry one; a link also cites a row with the case's exact case_id.
  The message is re-read through `getMessage` as the user: one the user cannot
  read is refused ("not a message you can read"), never distinguished from a
  missing one.
- **Read card.** Refused: a no-op (already read / unread for this user), and
  **COPIES** — marking read while another copy of the same email (same RFC
  Message-ID) that the user can read is still unread: the single-message
  route marks ONE copy, and the hub shows an email unread while ANY copy is,
  so the card would change nothing visible (the hub's own Mark read and
  open-to-read use the bulk route over every copy; the user does it there).
  Marking unread with copies is allowed and disclosed. Card: the message
  (mailbox, from, subject, date, place), read state before → after, **for you
  only** (read state is per person — nobody else's changes, the server's Seen
  flag and the sender are untouched), no event / log / rule.
- **Link card.** The normalizer predicts `caseLink`'s log row read-only with
  `caseLink`'s own lookups in its order (`priorLogId` is now exported for it)
  and refuses first: the 409s in the route's own words (the sync still
  emitting; the store-only grace), no usable address, a dead stamped log row,
  a message ALREADY on THIS case (no-op) and a message on ANOTHER case — the
  route would move it, Casey refuses (moving between cases is a later
  sub-slice; the Comms tab's case tag does it). Disclosed: whether the link
  REUSES an existing entry (its id, type, date, which lookup found it, its
  stored text length — "it shows on the case's Log tab, readable by every
  signed-in staff member; the mailbox's read grant does not apply there") or
  CREATES one (type, the other party, the text length and source, the date —
  "the message text becomes part of the case's log, readable by anyone who
  reads the case") — and what the row can hold: `log_message` is
  varchar(10000), so a longer text keeps its first 10,000 characters there
  (said), and a data copy over the TEXT column's 65,535 bytes is cut mid-way
  (danger; both cut silently under the relaxed sql_mode, pinned on the engine);
  an existing about-link to something other than a case is REPLACED (danger); the case's Comms tab lists it from then on (its mail card
  shows to staff who can read the mailbox); the client portal never shows it
  (the portal reads no log rows of any type — its field whitelist excludes log
  columns); no event, rule or send. **Identity:** the sender of incoming mail
  (every outside To / Cc address of the firm's own mail) against the case's
  contacts' emails (`contacts.contact_email` plus every `contact_emails` row,
  ended ones included, case-insensitive): a match is shown, a mismatch is a
  danger warning ("not a contact on this case"), a case with no contacts is
  IDENTITY NOT CHECKED (danger) — never a refusal.
- **Freshness:** `expected` = the read state (read card); the message's
  `log_id` stamp, the resolved log id (or none) and the case's contacts as GET
  `/api/cases/:id/contacts` returns them (`contact_id:contact_email`, sorted —
  link card). The click re-reads GET `/api/mail/messages/:id` (a 404 refuses:
  gone or no longer readable) and, for a link, GET `/api/cases/:id` and
  `/api/cases/:id/contacts`, and refuses before the claim on any difference —
  the read state flipped, the message linked (this case or another) or logged
  since, the contacts changed.
- **Idempotency:** none added — read state is idempotent in the route, and a
  second link card is refused by its re-read.
- **Outcomes:** the link route's three 409s are before-write refusals (all
  thrown inside its transaction, which rolls back); 404 / 422 / 400 are
  refusals by the shared 4xx rule; a bare 409, any 5xx or an answer that does
  not echo the message, the case or a log id stays ambiguous. The read route's
  404 is a refusal; an answer whose `unread` is not the reviewed state is
  ambiguous.
- **Receipt:** the integer `mail_message_id` (read) and the `log_id` the route
  answers (link). Two browser families (`mail_read`, `mail_link`); an email
  entity opens a "find it in Comms → Email" note.
- **Sync (fixed in this slice):** no `/api/mail` route had a matcher, no log
  writer announces anything (POST `/api/log`, PUT `/api/log/:id/about`), and
  neither reader loaded yc-sync — a read or a link was invisible to an open hub
  or Comms tab until it reloaded. Both routes now announce the MESSAGE as
  `mail:<id>` with the answered values (`{unread}`; `{log_id, case_id}`), and a
  link also `comms:case:<case_id>` (a marker). The comms hub (`comms.html`)
  repaints the row and the open card from `unread` (a merged row stays unread
  while any copy is), re-reads its list quietly on a link and repaints the open
  card's log line; a case's Comms tab (`entityCommunications.html`) re-reads
  its feed on its `comms:case` address, and any Comms tab showing the message
  under another case re-reads on `mail:<id>`; parked while hidden, skipped on
  its own write. The bulk POST `/api/mail/read` (a count, no ids) is not
  matched — the hub repaints its own rows.
- Off switch `casey_mail_triage_enabled` (on unless '0', casey section, sort
  65). Tests: `tests/caseyMailTriage.test.js`, gated
  `tests/caseyMailTriage.mysql.test.js`, `tests/caseyMailTriage.panes.test.js`,
  `tests/assistantUi.test.js`, `tests/ycSync.test.js`.

**Deferred** (`ref/plans.md`): bulk read, SMS / call triage (no route),
drafts (none exist), unlinking, flags (flagged / answered), archive, reading
an HTML-only body. Since 2026-11-11 a link to a message already on ANOTHER
case is not refused: the card moves it, disclosed as a danger line (MOVES THE
EMAIL OFF ANOTHER CASE) — Fred's standing rule, the Comms case tag makes the
same move silently; the A13b filing card's Link behaves the same.

#### A13b: File an email's attachments to a case — shipped 2026-11-10

One kind, `mail.attachments.file.v1` {mail_message_id, case_id, parts, confirm?,
move?, link?, folder?, notify?} → ONE `POST
/api/mail/messages/:id/attachments/file`, the Comms "File attachments"
dialog's own route (`emailAttachmentCommsService.fileOne`;
`ref/EMAIL_ATTACHMENTS_DESIGN.md` §9). The route is the whole engine: move
(when asked) → file the picks through the docs@ filing engine → link. Staff
JWT only (`requireJwt` — an API key is 403); its authority is READ access on
the email (`mailReadService.loadVisible` — a grant, SU, the attorney read
bypass, an alias slice); an unreadable email is a 404, never an oracle.

**The read.** `mail.attachments.preview` {mail_message_id, case_id?} →
`emailAttachmentCommsService.preview` for that ONE message, on the app pool,
as the asking user, audited like the other mail reads (`admin_audit_log` tool
`mail_read`, action `assistant_attachments_preview`, message ids only). Rows:
a head (`attachments_preview`: the message, the case asked for or the ONE case
the matcher places it in — `case_source` asked / suggested — the matcher's
verdict, the cases named in the subject, what the email has filed elsewhere and
the dialog's default move tick, the review-notice recipient with `is_you`, the
confirm policy), one `attachment` row per part (≤ 60: part id, file name, size
estimate, class file / optional / skip with `skip_reason`, `needs_confirm`
type / size, where it is filed, a duplicate, the dialog's default tick) and the
`case_candidate` rows (suggestions only, `why` match / subject_name). An
unreadable message, an unknown case (`asked_case_id` — never a citable
`case_id`) and a pruned copy are `not_found` rows.

**Evidence.** The message's row from a `mail.search` / `mail.message` read
(A13's rule), a `mail.attachments.preview` row of THAT message (head or
attachment row), and a row carrying the exact case_id (a case read, or the
preview row naming it). The normalizer re-runs the preview itself for the one
message and the card's case — it never trusts the evidence's copy.

**Refused by name**, before anything is read: bulk (`message_ids`, `all`,
`ids`, a list as `mail_message_id` — one card per email, A13's
`MAIL_BULK_KEY`; Comms' Select mode files many), another mail operation, any
other field (the notice `batch` is the browser's), a malformed part list or
boolean, and a folder the route's own `exactFolder` refuses (its words: `.` /
`..`, `\ : * ? " < > |`, control characters, a blank name, a name ending in a
dot or space, > 6 levels, > 120 characters a name). After the preview: a part
not on the email; a skip-class part (`NEVER FILED` — an image inside the
email, too large, a blocked type, no usable type); a part already filed to
this case (nothing to do), filed elsewhere (never twice — `move` carries it)
or being filed; a part whose `needs_confirm` is set but is not in `confirm`
(`NEEDS A SECOND CONFIRMATION`, naming each file and why — the route would
409; Casey never adds a confirmation itself); a `confirm` entry for a part not
on the card or needing none; `move: true` with nothing filed elsewhere; nothing
to file; with Link on, the case-link route's own refusals (the sync still
emitting, the store-only grace, no usable address, a dead stamped log entry —
`LINK REFUSED`, offering `link: false`).

**Disclosed.** The case — the matcher's own case, a subject-name suggestion,
or none — and `NOT THE MATCHED CASE` (danger) when the matcher places the
email in another case; each file (name, part, size); where it lands (the
default `Client Uploads/Emailed YYMMDD` by its real name — the email's
firm-local date, `renderFolder` — or a typed folder taken exactly, checked
against `caseFolders`: exists, exists in another letter case, `NEW FOLDER`
(danger, naming a near miss that differs only in spaces or case), or unknown
when Dropbox did not answer / the listing is cut); `NO CASE FOLDER` (danger:
the ladder auto-creates one with a task, or bins); an optional part (unticked
in Comms); each confirmed part as a danger line ("… needs a second
confirmation, and this card carries it"); a `DUPLICATE` (danger); the parts
left on the email and those never filed; the move (default from the preview:
out of Unsorted on, out of another case off — `MOVES FILES OUT OF ANOTHER
CASE` danger when asked); the registry (one record per attachment, staff-only
documents, filed by the user); the review notice (sent to the reviewer, none
when the user is the reviewer, no reviewer set, or `notify: false`); the case
link through A13's `mailLinkPrediction` in filing mode (create / reuse /
"already linked" no-op, the identity check, and `MOVES THE EMAIL OFF ANOTHER
CASE` danger — the route's `setLogAbout` overwrites, which the A13 card
refuses); the trigger rules listening for `document.created` /
`document.updated` / `document.linked` (listed, not run: the rows do not exist
yet).

**Browser** (family `mail_attachments`, danger = any warning). The request
sends `move` and `link` as explicit booleans (the route reads an absent one as
false), the folder exactly, and — only when the notice goes out — `batch` =
`cy` + the draft id (≤ 30, the route's `BATCH_RE`). The precheck re-reads GET
`/api/cases/:id` (the case's Dropbox link), POST
`/api/mail/attachments/preview` (the message, each card part's verdict —
class, reason, confirm, filed, duplicate — the move, the reviewer) and, when it
links, GET `/api/mail/messages/:id` (stamp, resolved log entry, linked case),
refusing on any difference before the claim. The dispatch files, then sends
`POST /api/mail/attachments/notice {batch}` when something landed (Comms'
order); a notice failure rides on the answer, never fails the card. The result
requires every card part in `files[]`, the reviewed case, `refiled` when it
moves and `linked` or a `link_error` when it links; a failed file and a
`link_error` are "Applied with problems", never applied-clean. A 409
`needs_confirmation` at the click is a refusal naming the files; 400 / 404 /
422 refuse by the shared rule; a 5xx stays ambiguous. No Idempotency-Key: the
filing registry makes every part idempotent, and the ledger's one claim per
draft stands. Receipt: the integer `mail_message_id`. Sync: the route is on
`public/js/yc-sync.js` already (`doclink:case:<id>`; linked: `mail:<id>` +
`comms:case:<id>`) — nothing added.

Off switch `casey_mail_attachments_enabled` (on unless '0', casey section,
sort 67; the read stays). Tests: `tests/caseyMailAttachments.test.js` (the
read, the normalizer and the browser, mocked services), gated
`tests/caseyMailAttachments.mysql.test.js` (the real routes and services: the
card's verdicts = the preview route's, the omitted confirmation refused by the
card AND 409'd, a blocked part refused AND 422'd, the file landing with its
registry rows, link log row, notice batch and document events, the precheck
after a policy change, access, the Unsorted move, the predicted link refusal =
the route's link_error, a leading-space folder, a duplicate),
`tests/assistantUi.test.js`, `tests/caseyActionPermissions.test.js` (79 kinds
/ 67 mounts; the API key 403 and the no-grant 404 on the file and preview
routes), `tests/assistantPromptKinds.test.js`, `tests/automationRead.test.js`.

#### A14: Outbound email and SMS — SHIPPED 2026-10-27 (direct send, ruling 15)

Sending is an irreversible external side effect and is not an extension of a
draft slice. Use distinct proposal kinds for email and SMS/MMS through their
canonical routes. Review the resolved from identity, exact recipients, subject
and body, attachments/media, schedule, link/audit destination, opt-out or
consent constraints, and audience count. Require a fresh send confirmation,
strong idempotency, and an unambiguous delivered/queued/failed result.

**As shipped.** Two kinds on the P1 card engine, `sms.send.v1` →
`POST /api/phone-lines/:id/sms` `{to, message}` and `email.send.v1` →
`POST /api/mail/send` `{mailbox_id, to:[address], subject, body_text}` — the
comms hub's own routes, so the user's per-channel `can_send` grant, SU step-up,
per-user send rate, daily mail budget and `admin_audit_log` row all apply
unchanged. These are the one family whose route IS an authorization seat
(P2 matrix: 36 kinds, 32 mounts since A16).

- **Recipient:** never typed. One evidence row must carry the exact
  `contact_id` and `phone_id` / `email_id`; the normalizer reloads the row
  (on that contact, `end_date IS NULL`) and records its consent — the row's
  `sms_optout` / `email_optout`, the one consent flag every sender reads
  (`services/optoutService.js`, ruling 2026-10-27) — as
  `recipient.opted_out`. An opted-out recipient is NOT refused (ruling 17):
  the card states "This recipient opted out of SMS|email" up front, as a
  danger line and in the review dialog. Measured live 2026-10-26: 1 of 1,113
  active phones opted out, 0 of 1,108 emails. The email address is run
  through the mail route's own `parseRecipient`.
- **Click-time freshness (correction 1):** the card's `precheck` re-reads
  `GET /api/contacts/:id` and `GET /api/contacts/:id/{phones|emails}` and
  refuses — before the ledger claim, so nothing is spent — when the row ended,
  its opt-out state differs from the reviewed one (either way), or its value /
  `updated_at` moved. A failed read leaves the card retryable.
- **Opt-out acknowledgement (ruling 17):** the send goes through
  `public/js/optoutAck.js`, exactly as Comms: the route answers 409
  `opted_out` (before the limiter and the idempotency claim), the user's
  explicit `confirm` resends ONCE with `acknowledge_optout:true` under the same
  `Idempotency-Key`, and the route's `admin_audit_log` send row carries
  `acknowledged_optout`. The fixed request builder never sets the flag; a
  cancel reads "Cancelled — nothing was sent"; a second 409 after the
  acknowledged resend is a refusal. Automation sends keep refusing.
- **Sender:** a literal `line_id` / `mailbox_id` the user can send from
  (`mailboxService.getAccess` can_send + active line; `mailboxSendService
  .resolveIdentity` for a mailbox). Omitted → the user's ONLY explicit
  `channel_grants` send grant among sendable senders (an SU's bypass is not
  a grant); otherwise refused with the list, for the repair stage. The route
  stays the authority at click time.
- **Body:** resolved at proposal time with `resolverService.resolve({strict})`
  against `contacts` (+ `cases` when a cited, linked `case_id` is given); an
  unresolved placeholder, a dotless `{{…}}`, or any surviving `{{` / `}}`
  refuses. The card shows — and the fixed builder sends — exactly the
  resolved text, trimmed/normalized the way the route would (SMS trim; email
  CRLF→LF and trim; the subject one line before and after resolution).
  Neither route re-resolves placeholders (traced to the adapters). Caps mirror
  the routes: SMS 1000 characters (`phoneCommsService.validateMessage`, run
  at proposal), subject 500, body 200,000 (pinned against `validateSendBody`).
  The card shows an approximate segment count (GSM-7 160/153, UCS-2 70/67). A
  resolved `{{contacts.contact_ssn}}` is allowed (2026-09-24 ruling) and the
  card warns; so does any 3-2-4 number in the text.
- **Idempotency:** both routes take an optional `Idempotency-Key` (scopes
  `phone_lines.sms_send`, `mail.send`); the card sends its `draft_id`. Unlike
  the creates, a failed send KEEPS its claim unless the route refused with a
  4xx before dispatch (`releaseOnRefusalOnly`): a provider timeout / 5xx after
  the call may have delivered, so the same key is 409 `in_flight` → `unknown`,
  never a second provider call. A replay is not audited as a send.
- **Outcome:** a 4xx or a plain 409 (inactive line, a box that cannot send —
  audited: both routes 409 only before dispatch; `refusal409`) reads "refused —
  nothing written". An idempotency 409, any 5xx or a dead socket reads
  *Outcome unknown — check the contact's Communications tab or the comms log
  before resending* and the write control is gone; reopening a chat whose
  ledger row never got a receipt shows the same wording. Success shows
  "accepted by the provider (status …)" (SMS — the provider's own status, no
  YisraCase log id exists at send time) or "sent — the mail server accepted it
  (email log #N)". The ledger receipt is the contact id; **Open conversation**
  opens the contact on its Communications tab.
- **Off switch:** `casey_send_enabled` ('0' = both kinds do not exist).

**Deliberate narrowings:** no attachments, MMS/media, cc/bcc, HTML body,
reply threading (`in_reply_to_message_fk`), scheduling, multi-recipient or
bulk sends, and the email's composer Case field (`case_id` → case link) is
NOT sent — a case only feeds placeholders. Appointment cards carry their own
client confirmation under this bar (A4.1 *Client confirmations*). Each narrowing
is filed in `ref/plans.md`. **Humans and Casey:** since the opt-out
ruling (2026-10-27) both native routes WARN a person sending from Comms (409
`opted_out` until `acknowledge_optout:true`), and Casey's card takes the same
confirm (ruling 17).
**Sync bus:** neither send route has a `yc-sync` matcher, for human
and Casey sends alike (the record arrives later through the provider echo /
mail ingest); no Casey-only emit was added.

#### A15: E-signature lifecycle

Separate send, remind, resend, recall, and mark-satisfied-externally. Resolve
the envelope, template/file, signers, routing order, message, expiration, and
case/document links server-side. Show all recipients and external effects.
File bytes remain browser-owned, and recall or external satisfaction requires
especially clear finality and stale-state checks.

#### A16: Reports — SHIPPED 2026-10-27 (report draft + save; ruling 16)

Fred's ask (2026-10-27): a staff member asked for "a list of contacts with
parameters x, y and z" — Casey produces it and the user exports it. Save,
update, run, share/lock and delete remain distinct proposal kinds; the first
one is shipped.

**What Reports is, measured.** Reports has no structured spec: a definition
IS SQL text (`report_definitions.sql_text` plus an ordered `params` array bound
to `?` placeholders), and the only validator (`lib/reportSchema/validator`
`validateSql`) validates SQL. Every staff JWT already authors and previews SQL
by hand, the Reports AI author has a model write it, and Casey's `sql.read`
runs model-written SQL through the same validator and the least-privilege
`yc_report` pool (109 runs in 90 days, measured live 2026-10-26). Ruling 16
follows: Casey drafts report SQL, and the Reports engine is the authority.
Live ground (2026-10-26): 13 saved definitions (4 views, 1 AI-sourced, 12
locked, none since 2026-08-31), the largest 2,570 characters; 73 saved-report
runs in 90 days, the largest 711 rows. CSV export is browser-side from a saved
report's Run (`reports.html` `downloadCsv`), not a server route, and is not
logged — its use cannot be measured.

**As shipped.** Kind `report.draft.v1` on the card engine →
`POST /api/reports` (the Reports editor's own create route).

- **The draft** carries exactly the create body — title, category,
  description, sql, params, columns_meta, caveats, row_limit, an optional
  `viz`, 0-8 optional evidence refs. The normalizer runs the create route's own validators
  (`validateParams`, `validateSql` with the declared param count) plus the
  chat-denied column names, then **previews** the definition through
  `reportService.execute` — the core `POST /api/reports/preview` calls — on the
  `yc_report` pool with the definition's own defaults (a required param with no
  default refuses), logged to `report_runs` as `assistant_report_draft`.
  `sanitizeColumnsMeta` runs against the columns the engine actually returned
  and a warning refuses the card, so what is stored is what was reviewed.
  Widths are capped at the columns' (title 150, category 40) because relaxed
  sql_mode would truncate. An engine or validator error is a 422 the repair
  stage reads.
- **Display (`viz`, 2026-10-27 review):** the model may choose how the saved
  report opens — the Reports engine's own chart enum (`validator.js`
  `VIZ_TYPES` = `reportCharts.js` `CHART_TYPES`: table, bar, line, area, pie,
  doughnut, combo, stat). Omitted → table. `assistantService.reportDraftViz`
  refuses, with the allowed values for the repair stage, anything the route's
  lenient `sanitizeViz` would drop or change (unknown fields, a series type /
  axis / format outside the enum) and anything Reports could not draw from
  the previewed result: x / y / series keys must be returned aliases, metric
  columns numeric by the field type codes `reportCharts.profileColumns` uses,
  a chart needs x and a metric, pie/doughnut exactly one metric, table no
  other field. The card shows a **Display** line in the Reports editor's
  words; the builder sends the server's normalized viz.
- **Server-fixed fields:** the `report_key` is minted server-side
  (`casey_<slug>_<6 hex>`); the browser's fixed builder pins `kind:'report'`
  (a view is a separate, undecided kind), `visibility:'shared'` and
  `source:'ai'`. Visibility stays pinned on purpose: `reportService` stores
  it but never enforces it (the private/shared model was rejected in S3 for
  the lock), so a Casey-chosen `private` would promise privacy that does not
  exist — the live access control is the lock.
- **The card** shows title, category, description, the tables read, the
  columns, the parameters, the real row count (and whether the saved report's
  row limit truncates it), the first 10 rows, caveats, the SSN / DOB lines, a
  privacy line ("an export of this report contains client personal
  information"), and the SQL behind a **Show the SQL** disclosure. Save is
  danger-styled when the report shows full SSNs.
- **SSN (Fred's ruling 2, same day):** `contact_ssn` appears only inside the
  canonical last-4 expression `RIGHT(REGEXP_REPLACE(contact_ssn,'[^0-9]',''),4)`
  — select list or filter — unless the user's OWN current question (the signed
  ticket's copy, never a model field) names SSNs / social security; then the
  full number is allowed and the card and dialog warn. The classifier
  (`reportSsnUse`) counts a match only where its literals are real code; any
  other reference — bare, a derived-table column, an unterminated literal — is
  full. The STORED card preview never carries a full SSN or a DOB: a column
  whose origin is `contact_ssn` / `contact_dob` (or the chat-denied
  `attachments` / `delivery_info`) is masked whatever its alias
  (`reportService.execute`'s opt-in `fieldOrigins`), and when the SQL reads one
  of them in full every expression column is hidden and SSN-shaped cells are
  masked. Casey's conversational reads still refuse `contact_ssn` /
  `contact_dob` unchanged. `contact_dob` is selectable in a report draft (the
  2026-09-24 ruling); the card says so.
- **Idempotency:** `POST /api/reports` takes an optional `Idempotency-Key`
  (scope `reports.create`, canonical — the editor and the AI author's Save are
  unchanged without one); the card sends its `draft_id`; a refused create
  releases the key.
- **Click-time freshness (correction 1), deliberately narrowed** like A17.3:
  the reviewed object is the new definition itself, which nothing else can
  change, and the route re-validates the SQL against the current manifest at
  click time; the 15-minute card TTL and the idempotent draft_id cover the
  rest. No precheck read is added.
- **Open in Reports:** the shell destination `reports.report` {id}
  (`launcher moreReports`, rest `report~<id>`); `reports.html` takes the held
  rest on a cold boot (`ycSubTab.leaf.take`) or through its
  `ycAssistantOpenDestination` bridge when warm, opens the report on its run
  panel (it auto-runs; **CSV** exports there) and reports ready. Usable by
  any native caller of `ycAssistantNavigate`.
- **Export mechanics:** the user's click on Reports' own **CSV** button —
  Casey initiates nothing past the save. The same slice neutralises CSV
  formula injection in every human export — Reports, views
  (`customView.html`), the log export (`scripts.js` `buildLogCsv`) and the SU
  db console's CSV and TSV Copy — through one helper, `public/js/csvSafe.js`
  (a cell starting with `= + - @` / tab / CR is prefixed with `'`; plain
  numbers keep their value; headers too).
- **Access:** unchanged — any logged-in staff member may create a report
  (`requireUser`; API keys 403), new rows start unlocked, the lock lives in
  `reportService`; the P2 matrix now covers 36 kinds / 32 mounts.
- **Heuristic:** `reportDraftRequested` — a report / CSV / spreadsheet / Excel
  / export noun (or a list paired with download) plus a making verb in a
  request message. "List my tasks" and "show me the contacts in Detroit" stay
  reads answered in chat; interrogatives never force a draft. The same test
  selects the report appendix (`lib/aiPrompts/assistantReportDraft.js`: SQL
  rules + the curated schema) and the 8,000-token answer ceiling, so other
  answers pay nothing for them.
- **Sync bus:** no report route is in `yc-sync.js` MATCHERS for human or Casey
  saves alike; no Casey-only emit was added.
- **Off switch:** `casey_report_authoring_enabled` ('0' = the kind does not
  exist).

**Deliberate narrowings** (each filed in `ref/plans.md`): Casey saves a
`kind:'report'` (opens in Reports, where CSV lives), not a `view` (the
customView work list with clickable rows); no update / run / lock / delete /
restore kinds yet; the card offers no CSV of its own (the export is Reports'
button, one click after Open).

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
14. **External-send sequence draft authoring is GO** (Fred, 2026-10-26):
    `send_sms`/`send_email` are allowed in sequence drafts via a sequence
    allowlist with an `external-send` class, disclosed on the card; the human
    publish remains the review gate. The blanket external-send exclusion is
    softened — workflow-draft parity is its own follow-up slice — and A14
    rises in priority. All seven timing types are allowed with guardrails
    (literal `at` only; appointment-anchored disclosed) rather than type bans.
15. **Casey sends are GO** (Fred, 2026-10-27: "casey can use placeholder.
    casey can send SMSs and emails!!! its a bad rule to say it cant. casey
    actions are all read and approved by a user!"). The external-send
    exclusion is struck; Casey may author send steps in workflow and sequence
    drafts with placeholder senders from a closed resolvable set, and A14
    direct send follows with a resolved preview + idempotency. The draft half
    shipped the same day (*Send steps in drafts* under A17.6); the
    no-model-invented-fetched-URL rule stands (email `attachment_urls` stay
    refused).
16. **Casey drafts report SQL** (Fred, 2026-10-27): the Reports engine's
    validator + `yc_report` pool are the authority, as for sql.read; the "no
    query text" sentence (f94a2f3, planning session) is struck for Reports.
    Same day, the SSN rule: a report shows `contact_ssn` in full only when the
    user's own question asks for SSNs, otherwise last-4 — shipped as A16.
17. **Casey may acknowledge an opt-out** (Fred, 2026-10-27: "casey is like
    the user"): the send card shows the opt-out up front and sends
    acknowledge_optout only on the user's explicit confirm, exactly as Comms
    does; automation sends still refuse.

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
Measured gaps, all on the human path too. The WORKFLOW half closed with A17.4
(2026-10-24, zero live rows grandfathered — measured first):

- CLOSED: an unknown or misspelled `function_name` is refused at save
  (`lib/internal_functions` `validateInternalFunctionParams`); a registered
  but meta-less function stays permissive (today all 104 carry `__meta`).
- CLOSED: undeclared param keys are refused by name; `params: null` validates
  as `{}` (required params fail at save, not run time);
  `error_policy.strategy` must be one of the four values the engine honours,
  and `error_policy` must be an object or null.
- CLOSED: the step-mutating workflow routes (insert, PUT, PATCH, DELETE,
  reorder) take an optional `expected_base` precondition — the editing
  `draft_version`, step count, and a key-order-insensitive content fingerprint
  of the target step (`lib/versionDiff.stepFingerprint`) — checked inside the
  write transaction under the parent-row lock; a mismatch is a structured 409
  naming what changed. Optional for native callers, required on every Casey
  step proposal. This is the wf27 scar turned into a route property.

The SEQUENCE half closed 2026-10-26 (zero live rows grandfathered — all 155
sms/email/task/internal_function steps measured clean first):

- CLOSED: sequence `sms`/`email`/`task`/`internal_function` steps — all four
  dispatch as `executeJob` internal_function calls — are validated at save by
  `lib/internal_functions` `__validateSequenceFunctionStep`: a missing,
  unknown, `__`-helper or workflow-only `function_name` is refused, then
  `validateInternalFunctionParams` (undeclared keys, `params: null` as {},
  required params). POST / PUT validate the whole step; PATCH only when it
  writes `action_type` / `action_config` (Fred's ruling). The `type`-key
  refusal landed earlier with the dispatch fix b087fa5.
- CLOSED: the five sequence step-mutating routes take the same optional
  `expected_base` precondition (`lib/versionDiff.sequenceStepFingerprint`
  over the six content columns), under the `sequence_templates` parent-row
  lock, structured 409 on mismatch.

Still open (the P11 remainder):

- Publish (both engines) re-runs shape and branch-target validation but
  **not** `__meta` param validation. Both publish routes carry the
  expected-base precondition (workflow A17.6, sequence A18.3).

**What Casey cannot author (initial contract).** Excluded by construction: a
STANDARD-mode `custom_code` **body** (A17.4c adds an inert stub plus copyable
code instead; safe-mode bodies are ruling 13's later revision),
every function carrying a `credential_id` or a fetched URL, `update_db` /
`insert_db` / `set_setting` (generic writes), `create_cta` (mints public bearer
links with nested step plans), `start_workflow` and `enroll_sequence` (chained
fan-out), the esign `on_signed`/`on_declined` targets, and the external senders
other than `send_sms` / `send_email` (`send_mms` — its `attachment_url` is
fetched — `esign_*`, forwards, the digests and sweeps; forwards are
authorable as INGEST rule actions since A20.2, not in workflow drafts). `send_sms` and
`send_email` ARE authorable in workflow and sequence drafts (rulings 14 and
15, class `external-send`), with the sender held to a literal firm line /
mailbox or a placeholder from the engine's closed resolvable set, and email
`attachment_urls` refused.

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

**A17.2: Validate and preview an authored step without saving. SHIPPED
2026-10-22** — as the `automation.preview_step` read kind: the dry-run core is
extracted to `services/stepPreviewService.js` and shared with test-step's
dry_run branch (response unchanged); the kind has no field that can select
live execution, the capability gate (now `lib/codeStepGate.js`, shared) runs
inside the service with the session's auth, and this.* phantom variables are
stripped exactly as the route strips them. Original spec:

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

**A17.3: Draft a new, never-published workflow (the first write). SHIPPED
2026-10-22** (Fred's GO) — kind `workflow.draft.v1` on the card engine:
steps from `lib/caseyAutomationAllowlist.js` (27 functions with side-effect
classes since ruling 15 added `send_sms` / `send_email` (`external-send`) and
`get_setting` / `get_settings` (`read`), snapshot-pinned;
expansion is a deliberate review) plus safe-mode
code steps; webhooks (A17.4b) and query_db (A17.4a) refused by name with
add-by-hand guidance; `POST /workflows/bulk` wired into requestIdempotency;
per-family flag `casey_workflow_authoring_enabled`; name collision checked at
proposal time (names are not DB-unique — click-time safety is the idempotent
draft_id + the 15-minute card TTL, a narrowing of this spec's click-time
re-read, recorded deliberately). Same slice: the investigation budget widens
to 5 rounds / 14 steps when a plan carries automation.* reads (Fred's ask —
composing needs more passes; rows/time/token caps stay global), and the
answer prompt must say when a budget starved the work instead of presenting
it as complete. Original spec:

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

**A17.4: Insert or edit one step in an existing workflow's draft. SHIPPED
2026-10-24** — kinds `workflow.step_insert.v1` and `workflow.step_edit.v1` on
the card engine, with the P11 workflow half folded in (the expected-base
precondition on all five step-mutating routes plus the four save-time
closures, all optional for native callers and required on Casey proposals;
live data measured first, nothing grandfathered). Edit covers label, note,
the param values of an allowlisted function, and — ruling 13 applied to
editing — a SAFE-mode code body; branch-target invariance is enforced by
comparing `extractBranchTargets` canonically, so then/else/next-step values
cannot move. Insert reuses A17.3's per-step normalizer verbatim
(`normalizeAuthoredStep`) and extends `requestIdempotency` to
`POST /workflows/:id/steps` (scope `workflows.step_insert`; a refusal
releases the claim). Evidence must carry the exact `workflow_id` — an
`automation.definition` read in the same investigation. The card's
precondition 409 renders as a refusal ("the workflow changed, nothing was
written"), the one audited exception to the 409-stays-ambiguous rule.
`BRANCH_TARGET_PARAMS` and the terminal sentinels moved to
`lib/versionDiff.js` (the normalizer needed them; a service must not import a
router). A17.4a (query_db), A17.4b (webhook) and A17.4c (standard-code
scaffold) below remain unbuilt. Original spec:

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

**A17.6: Publish a draft. SHIPPED 2026-10-25** — kind `workflow.publish.v1`
on the card engine. The model supplies only `{workflow_id, evidence}`; the
normalizer computes the entire impact preview onto the card (classification —
`first_publish` when `current_version` is 0 — per-step diff capped at 30,
structural reasons, validation warnings, in-flight and stranded run counts,
inbound starters via `automation.references`, external/chaining effects with
webhook URLs reduced to method + host so chat payloads never carry a
secret-bearing URL, and the no-rollback statement). `migrate_in_flight` is
pinned false in the fixed request builder and never offered.
`POST /workflows/:id/publish` gained the P11 publish precondition: optional
`expected_base {draft_version, step_count, draft_fingerprint}` — the
fingerprint is `lib/versionDiff.draftFingerprint`, the ordered per-step
fingerprints hashed together — checked inside the publish transaction, so a
draft edited after the review 409s instead of publishing blind; the native
editor is unchanged (it does not send the token yet — filed).
**RULED — Fred, 2026-10-25: safe-mode drafts ARE publishable by card.** The
refusal is narrowed to STANDARD-mode code steps only (`code_mode` absent,
`'standard'`, or unparseable config — fail closed). Safe-mode steps publish
and are disclosed on the card like every other effect. This closes the loop
ruling 13 opened: Casey can author a safe-code workflow, edit it, and walk
the user to a reviewed publish. A17.7's start refusal follows the same
mode-scoped rule. Original spec:

Fred, 2026-10-22: publish is allowed but stays its
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

**Send steps in drafts — ruling 15's draft half. SHIPPED 2026-10-27.**
`send_sms` / `send_email` join the workflow allowlist under class
`external-send` (the sequence list's name), so `workflow.draft.v1`,
`workflow.step_insert.v1` and `workflow.step_edit.v1` author and edit send
steps; their params come from `__meta` like every allowlisted function
(`attachment_urls` is neither taught nor accepted). The sender rule is per
engine, because the two template differently, and closed in
`lib/caseyAutomationAllowlist.js`:

- **Literal** (both engines): an ACTIVE `phone_lines` number / a configured
  `email_credentials` mailbox (one shared helper, real-engine tested).
- **Sequence placeholders** (`CASEY_SEQUENCE_SENDER_PLACEHOLDERS`): the
  resolver anchors `users` on the enrollment's trigger_data `user` → `user_id`
  → `appt_with` and has no settings namespace, so the set is
  `{{users.default_phone}}` (sms — 12 live steps) and `{{users.default_email}}`
  (email); plus a `{{trigger_data.X}}` sender only when the same template's
  editing version already sends from exactly it on that channel (live: template
  28's `{{trigger_data.automationsFrom}}`, supplied by its enrolling workflow).
- **Workflow placeholders** (`WORKFLOW_SENDER_SETTING_KEYS`): workflow
  templating is variables-only with no modifiers, and an unresolved
  placeholder blanks silently, so a sender placeholder must be a variable the
  NEAREST earlier writer stored from a firm sender setting (the registry's
  `senders` section by channel): `{{V}}` after `get_setting {key, output_var:V}`,
  `{{V.key}}` after `get_settings {keys, output_var:V}` — the two live forms
  (`{{settings.email_automations}}` ×7, `{{automationsFrom}}` ×4). The writer
  may be a stored step or one EARLIER IN THE SAME DRAFT: `get_setting` /
  `get_settings` are allowlisted as class `read` (manager ruling under ruling
  15), so a new draft carries the canonical pair in one card —
  `get_settings {keys: 'email_automations', output_var: 'settings'}` then a
  send from `{{settings.email_automations}}`. The settings step itself may read
  any key the functions' own contract allows, checked at proposal time with
  their run-time rules: literal keys only, not a registry secret, an existing
  `app_settings` row whose key matches byte for byte (the column is
  general_ci), and not `is_secret` (key and is_secret are read, never the
  value). Only the SENDER rule is restricted to the `senders` section.
- An edit may keep a send step's stored sender and attachment list exactly as
  stored; a changed one is held to the rule.

What a sender that resolves to nothing does: neither engine sends from
nothing. A blank workflow `from` makes `send_sms` / `send_email` throw
"requires from"; an unresolved sequence placeholder stays literal and the
send throws (no line / no mailbox for `{{…}}`). The step fails per its error
policy and nothing is sent. Cards: every send step shows its sender (a
placeholder verbatim plus the server's plain line on how it resolves) and
"this step messages <recipient> when the workflow runs, after a human
publishes it", danger-styled like the sequence card; the publish card's
effects name each send as `external-send` with its recipient expression.
Prompts (answer / plan / repair) teach sends as authorable;
`tests/assistantPromptKinds.test.js` pins the old exclusion wording out of
every stage. At run time `send_sms` / `send_email` refuse an opted-out
recipient (ruling 2026-10-27) and the engine records the step skipped — for
human-authored send steps too.

**A17.7: Start a workflow. SHIPPED 2026-10-28; reviewed input (A17.7b)
2026-11-03** — kind `workflow.start.v1`
on the card engine: ONE run of a workflow's PUBLISHED version, started now.
An irreversible fan-out, not an extension of publish: the execution row
commits and the advance is detached, so every step that sends, calls, writes
or chains runs as it is reached, and cancel (A17.8) stops only the steps a
run has not reached.

**Server half — P4 extended to starts.** `POST /workflows/:id/start` takes an
optional `Idempotency-Key` (scope `workflows.start`) through the existing
facility, under A14's SEND rule (`releaseOnRefusalOnly`), not the creates'
rule: the route's refusals — 404, inactive, never published, no draft to run,
an invalid `contact_id` — are raised BEFORE the execution INSERT and are
thrown out of the claim as status-bearing 4xx, which releases it (the
refusal's transaction still commits, so a refused start's capture sample is
kept exactly as before; `captureRefusedStart` is arm-once guarded, so a
retried key cannot capture twice). Any other failure — a 5xx, a commit whose
acknowledgement was lost — keeps the claim, so the same key is 409
`in_flight` → `unknown` and can never start a second run. A replay answers
the FIRST run's body (same `executionId`) with `replayed: true` and advances
nothing. No key = the old behaviour and zero extra queries (the editor's Run
button, x-api-key callers, every native start). Before this, every call
created another execution.

**The card.** The model supplies `{workflow_id, init_data?, contact_id?,
evidence}`; evidence must carry that exact workflow id from an
`automation.definition` read. Fixed rules:

- **Published version only.** `use_draft` is refused by name (any value) and
  the fixed request builder cannot express it — no query string, no body key.
  Running an unpublished draft is an author's own test, not a reviewed action
  (Fred, 2026-10-22). An inactive or never-published workflow refuses at
  proposal time.
- **Input is optional and reviewed** (A17.7b; Fred delegated the pick, the
  manager ruled 2026-11-03). Measured live 2026-10-28: 7,999 of 8,002 runs in
  90 days carried input, so a start with none was nearly decorative.
  - **No input** — `init_data` absent or `{}`, no `contact_id` — is the
    shipped start, unchanged: the same card envelope (no `payload` / `input`
    keys, no extra read) and the same `{init_data: {}}` body. The card lists
    the `{{placeholders}}` the version reads that no step stores
    (`output_var` / `set_vars` / `set_var`; `this` and `env.*` excluded)
    and says each resolves blank on this run.
  - **Spelling.** `init_data` only; `initData` and `input` are refused by
    name, `use_draft` stays refused by name (any value).
  - **Closed key set.** An `init_data` key must be one the PUBLISHED version
    reads: a placeholder root of its step configs that no step stores (the
    blank-list's own scan, uncapped) ∪ the keys of the workflow's
    `test_input` sample (`workflows.test_input`, the author's documentation
    of the init_data shape; `captured_input` is not consulted — a captured
    provider envelope documents what was sent, not what is read). Since
    A17.7c (2026-11-09) every workflow row of the `automation.definition`
    read carries `test_input_keys` (sorted; never the sample's values) and
    `default_contact_id_from`, so the plan stage names the keys before the
    card has to refuse them. Any other
    key is refused with the allowed set in the message. Never allowed: a name
    that cannot be a placeholder root (`.` `[` `]` `|` braces `:`
    whitespace — a dotted key would shadow a nested read, since the engine
    tries `key in variables` with the whole placeholder first), `this` /
    `env` (refused by name: an input of that name would shadow the engine's
    own), prototype names. **What the set cannot know:** a safe-mode code
    step's `input` config is scanned like any config, but the variables it
    returns are invisible and a body may read a variable no placeholder names
    — so the set can over- or under-list a key. The union is taken honestly
    and the card discloses it: a key only the test_input sample names reads
    "no step's {{placeholder}} — the workflow's test_input sample names it (a
    safe-mode code step may still read it)"; a sample key a step also stores
    says later reads see the step's value.
  - **Scalar values only** (vision-style, per `ref/CASEY_VISION.md`): *says
    yes* to every hand-fed start the firm runs today with flat values (e.g.
    the Daily Appointment Report's `{source}`); *risk* — of the 13 startable
    live workflows most are provider event handlers (message / call
    envelopes), and a hand-built envelope is a forgery, not an input: a run
    acting on a fabricated provider payload; *mitigation* — text / number /
    true/false / null only, an object or array refused by name with that
    reason; *deferred* — nested values, until a workflow needs a hand-fed
    structured input and the card can review it whole. A string is capped at
    **500 characters** and refused when it carries a line break, tab, control
    or text-direction character: the card shows every value whole and
    verbatim on one line (text in quotes, so `"12"` and `12` differ), and a
    value too long to show whole is too long to review — 500 is several card
    lines, well past the identifiers and short labels live starts carry. At
    most 20 keys per card (the blank-list's own cap).
  - **Contact only from evidence** (A8's two-source pattern: the workflow row
    and a contact row). An explicit `contact_id` needs a cited row carrying
    that exact contact_id; so does an `init_data` value the workflow's
    `default_contact_id_from` would bind the run to. The precedence is the
    engine's own `resolveExecutionContactId` (explicit beats the default);
    an explicit id and a default-bound value naming DIFFERENT contacts is
    refused (the run would be tied to one while its steps read the other).
    The card names the contact, how the run is bound (contact_id — and that it
    beats the workflow's default when one exists — or the default key), or
    "none" (and why); `contact_id` sets no `{{variable}}` and the card says
    so. A missing contact is refused.
  - **The card adds**, server-computed: one line per key with its value
    verbatim, the steps whose placeholders read it, the contact binding, and
    the blank-list minus what the payload feeds; the review warning says
    "with exactly the input listed above". `payload` is the exact request
    body; the browser builder sends it as reviewed — frozen at proposal,
    re-checked (scalar values, only `init_data` / `contact_id`, a positive
    contact id) and never rebuilt; a malformed payload sends nothing.
  - **Capture disclosure — both cards.** When the workflow is armed
    (`workflows.capture_mode` `'capturing'` or `'intercept'`, read at
    proposal time), the card carries `capture` and says this start's input
    (the values above, or its empty input) will be stored as the workflow's
    captured input sample, visible to automation staff in the editor, and
    the arm turns off — `'capturing'` stores it at the route and the run
    proceeds; `'intercept'` stores it at step 0 and HOLDS the run before
    step 1 until someone resumes it; either way unless another start reaches
    the one-shot arm first. An unarmed workflow's card carries no `capture`
    key, so the no-input envelope stays the shipped one (it gains the key
    only when armed). Not re-checked at click.
  - **Send class.** A start with input is the same class as one without: it
    already runs under A14's SEND rule (keep-the-claim idempotency), danger
    styling and a fresh confirmation, all unchanged — the input adds review
    lines, not a new class. No new kind, flag or route change.
- **The A17.6 code-step refusal, mode-scoped** (Fred, 2026-10-22, narrowed
  2026-10-25): a STANDARD-mode `custom_code` step in the published version
  (`code_mode` absent, `'standard'`, or unparseable config) refuses the card;
  safe-mode steps start and are disclosed. `standardCodeStepNumbers` is one
  helper shared with the publish card.
- **Impact preview**, all server-computed: the effects the version can
  produce (`workflowStepEffects`, shared with the publish card — sends named
  `external-send` with their recipient expression, webhooks reduced to method
  + host, chaining/write functions named, safe code disclosed), what normally
  starts it (`automation.references`), runs already in flight (`pending`,
  `active`, `processing`, `delayed`, `held`, any version), 90-day run volume
  with average steps executed (the read surface gives no per-run write
  estimate), whether an unpublished draft exists (this start runs the
  published version, not the draft), and the statement that a start is
  immediate and irreversible. Danger styling; a fresh confirmation dialog.
- **Click-time freshness** (correction 1): the precheck re-reads
  `GET /workflows/:id` and refuses before the ledger claim when the workflow
  is gone, deactivated, or its `current_version` moved. A published version's
  steps are never edited in place (every step writer targets the draft), so an
  unchanged `current_version` is an unchanged step set; with no draft the
  read returns those very steps and a standard-mode code step among them
  refuses too.
- **Outcomes** in A14's vocabulary. The route's 409s are all pre-INSERT
  (audited), so the family reads a plain 409 as a refusal (`refusal409`):
  "Refused — nothing started". An idempotency 409, any 5xx or a dead socket
  reads *Outcome unknown — check the workflow's executions before starting
  again*, and the write control is gone. The ledger receipt is the run
  (`execution_id`); success names the execution and the applied card
  deep-links to it. The deep link reuses A19.1's record-kind fix: the shell's
  `automations.workflow` destination carries a closed `records` list
  (`['execution']`), `ycAssistantNavigate(…, {id, record: 'execution'})`
  holds the rest `workflows~<id>~execution`, and the Automations manager's
  `parseAssistantRest` (now also the cold-boot parser) accepts only that
  secondary kind, handing `{id, record: 'execution'}` to the workflows pane's
  execution viewer.
- **Off switch** `casey_workflow_start_enabled` — its own, not
  `casey_workflow_authoring_enabled`: a start executes rather than authors,
  so Fred can keep authoring on with starts dark (ruling 4's per-family flag).
- **Sync bus:** no workflow route is in `public/js/yc-sync.js` MATCHERS and the
  executions pane is not bus-watched; the run's own writes are server-side
  (P6), so no Casey-only emit was added.

Known limit, as A17.6: the predicate is direct — a `start_workflow` step or a
trigger downstream may reach a workflow with standard code; transitive closure
is not chased. Also not chased: a value that is itself an id a step acts on
(e.g. a case id a write step reads) is reviewed as a value, not proved from
evidence — only the run's contact binding is. The P2 matrix covers 45 kinds /
40 mounts (with A18.4b). Tests:
`tests/caseyWorkflowStart.test.js`, gated `tests/caseyWorkflowStart.mysql.test.js`,
the UI card in `tests/assistantUi.test.js`, the deep-link grammar in
`tests/assistantSidebar.test.js`.

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
  shape after ~15 minutes. On the FIRST step the enroll call itself fails
  instead (`SCHEDULING_FAILED`) and the new row is cancelled (A18.4a).

**A18.1: Preview an enrollment (read-only).**

`POST /sequences/preview` is a zero-side-effect preview that already returns
the enrollment verdict and, per step, `computed_time`, `would_skip`,
`condition_error`, `timing_error`, `resolved_config`, `unresolved` and an
action summary. It is the single best read in either subsystem and should be
exposed early — it answers "what will this actually do to this client" without
writing anything.

**A18.2: Draft one sequence step. SHIPPED 2026-10-26** — kind
`sequence.step_insert.v1` on the card engine: ONE `sms`, `email` or `task`
step into an existing template's draft through `POST
/sequences/templates/:id/steps`. The function is pinned per type by the
sequence allowlist (`lib/caseyAutomationAllowlist.js`
`CASEY_SEQUENCE_AUTHORABLE`, ruling 14): `sms` → `send_sms` and `email` →
`send_email` under the side-effect class `external-send`, `task` →
`create_task` (`internal-record`). The browser's fixed builder writes the
function, the native editor's no-retry error policy (a retried send can reach
a client twice) and no condition or fire guard; the model supplies params and
timing only. The normalizer refuses a `type` key, any other `action_config`
key, or a different `function_name`, then runs the route's own
`__validateSequenceFunctionStep`. Guardrails beyond the route: the SMS sender
is a literal active `phone_lines` number and the email sender a configured
`email_credentials` mailbox, or (ruling 15) a sender placeholder from the
sequence engine's closed resolvable set — see *Send steps in drafts* under
A17.6 — email `attachment_urls` are refused (fetched at send time), and a
literal task assignee must be active staff. Timing takes all seven engine types (`immediate`, relative or absolute
`delay`, `next_business_day`, `business_days`, `open_delay`, `before_appt`,
`before_appt_fixed`), each closed to the keys the engine reads, with no
`timezone` key (the card renders firm time). Two guardrails replace type bans:
an absolute `delay.at` is a literal future datetime, never a `{{placeholder}}`
(one that resolves empty wedges the enrollment, A18.0); the
appointment-anchored types are disclosed on the card and in the prompts as
silently skipping once their slot has passed. Every value renders in plain
language on the card. The card states that nothing runs until a human
publishes the template, that enrollments already running stay on their version
(an insert is structural, so publish cannot migrate them), and that an
`sms`/`email` step messages clients from the first NEW enrollment after that
publish — the human publish is the review gate for the send. Evidence must
carry the exact `sequence_template_id` from an `automation.definition` read;
the normalizer reads the editing version (draft, else published), bounds
`step_number` to 1..count+1, and bakes `expected_base` (draft version, step
count, the displaced step's `sequenceStepFingerprint`). The route's 409
renders as a refusal ("the template changed, nothing was written"). The route
honours the card's `draft_id` as `Idempotency-Key` (scope
`sequences.step_insert`; a refusal releases the claim). Family flag
`casey_sequence_authoring_enabled`. No Casey-only bus emit: no sequence route
is in `public/js/yc-sync.js` MATCHERS, and the precondition is the protection.
Its P11 prerequisites:

- Sequence step saves validate the internal-function contract for these
  action types (P11 sequence half, 2026-10-26): `function_name` existence,
  workflow-only refusal, `__meta` params. The card's normalizer can call the
  same `__validateSequenceFunctionStep` the routes run.
- The step routes take the `expected_base` precondition; every A18.2 card
  must send one, built from `GET /sequences/templates/:id`
  (`template.draft_version`, `steps.length`, `sequenceStepFingerprint`).
- The `type`-key dispatch override is FIXED (b087fa5): the engine pins `type`
  last in the executeJob payload and `routes/sequences.js` refuses a `type`
  key inside `action_config` with a 400, so a stored row written around the
  route cannot redirect the dispatch either.

Sequences have no step-to-step variables and no `set_vars`, so a sequence step
proposal is simpler than a workflow one; its timing is the hard part (seven
types, two of them appointment-anchored and silently `unschedulable` once
their window passes — disclosed rather than banned, ruling 14). Measured
2026-10-26: the 15 live `sms`/`email`/`task` steps use `immediate`, relative
`delay`, `next_business_day` and `business_days`; across all 128 live steps
the appointment-anchored types are 23 (all `internal_function` or webhook),
and all 5 live absolute `delay.at` values are placeholders.

**A18.3: Publish a sequence template draft. SHIPPED 2026-10-28** — kind
`sequence.publish.v1` on the card engine, A17.6 on the sequence engine. The
model supplies only `{sequence_template_id, evidence}` (evidence must carry
that exact id from an `automation.definition` read, as A18.2); the normalizer
computes the whole impact preview onto the card with the functions `GET
/sequences/templates/:id/draft-diff` runs — `diffSequenceSteps` over the step
rows AND both version rows' `template_condition`, and the route's own
`validateSequenceDraft` (exported from `routes/sequences.js`, reused, never
copied; errors refuse the card, warnings show on it). The card shows the
classification (`first_publish` when `current_version` is 0) with the stricter
rule stated in words — content-only means an `action_config` change on an
unchanged `sms`/`email`/`task` step and nothing else; `action_type`, `timing`,
`condition`, `fire_guard`, `error_policy`, webhook / `start_workflow` /
`internal_function` config, numbering and the template-level condition are all
structural — the per-step diff (capped at 30), the running and stranded
enrollment counts, what can enroll it (`automation.references`) plus a
type-cascade line, external effects (sends named `external-send` with their
recipient expression through A17.6's shared effect helpers, webhooks reduced
to method + host, `start_workflow` named), and the no-rollback statement.
`migrate_in_flight` is pinned false by the fixed request builder and never
offered, so — the route's actual behaviour, read from code — publishing
**repoints no enrollment at all**: every running enrollment stays pinned to its
version (steps and template condition) and finishes there, no queued job is
rewritten, and only enrollments that start after the publish run the new
version. (The earlier line here — "repoints `active` enrollments only and does
not rewrite queued jobs" — describes the `migrate_in_flight` path, which Casey
never takes.) `POST /sequences/templates/:id/publish` gained the P11 publish
precondition: optional `expected_base {draft_version, step_count,
draft_fingerprint}` checked inside the publish transaction under the
parent-row `FOR UPDATE`, the same structured 409 as the step routes; absent,
the route runs as before with no extra query. The fingerprint is
`lib/versionDiff.sequenceDraftFingerprint` — the ordered per-step
`sequenceStepFingerprint`s hashed together **with the draft version row's
`template_condition`** (manager-flagged judgment call): `PUT
/sequences/templates/:id` writes the condition onto the draft row without
moving `draft_version` or touching a step, and a failing template condition
cancels the enrollment, so a steps-only hash would publish a reviewed-then-
edited condition blind. The native sequence editor does not send the token
(filed, ref/plans.md). Code steps: no sequence action type carries a runnable
code body (sms/email/task/internal_function dispatch with `type` pinned last,
no internal function loads a code runner, conditions are declarative SELECTs),
so A17.6's standard-mode refusal has nothing to bite on; the action-type
inventory is pinned against the route's `ALLOWED_ACTION_TYPES` and a stored
type outside it refuses the card. The 409 renders as a refusal ("the template
changed … nothing was written"). The publish route honours no
`Idempotency-Key` (as A17.6); the ledger claim is the single-flight. Family
flag `casey_sequence_authoring_enabled` (A17.6 shares its family's flag the
same way). The applied card deep-links to the template
(`automations.sequence`). No Casey-only bus emit: no sequence route is in
`public/js/yc-sync.js` MATCHERS, and the precondition is the protection. The
P2 matrix now asserts it equals the ledger's kind registry. Tests: `tests/caseySequencePublish.test.js`, gated
`tests/caseySequencePublish.mysql.test.js`, the UI card in
`tests/assistantUi.test.js`.

**A19.0: Create an inactive hook with one internal target. SHIPPED
2026-10-22** (Fred's ask: "make a hook to trigger something"). Kind
`hook.create.v1` on the card engine: one reviewed card creates an inbound hook
BORN INACTIVE (`active: 0`, pinned by the fixed request builder and accepted
by the extended `POST /api/hooks`, which now takes `active` + inline
`targets` validated with the target route's own rules and created in one
idempotent transaction — the card's draft_id cannot mint a second endpoint).
The single target points at an EXISTING workflow or sequence template,
verified at proposal time (an unpublished target workflow is allowed but
flagged on the card). The card never composes or echoes a slug, key, or URL —
slugs are server-generated, and activation, auth, filters, transforms and
HTTP targets stay in the Hooks editor. The route's `automations.manage` gate
stands, so the card applies only for admin/IT/SU; the permission matrix (29
kinds) documents it as the one capability-gated-for-everyone kind. Per-family
flag `casey_hook_authoring_enabled` (ruling 4). The applied card deep-links to
the hook (`automations.hook`).

**A19.1 (same day, from Fred's live test):** the card gains an OPTIONAL
user-chosen `slug` (validated `[a-z0-9-]{3,100}`, collision-checked, shown on
the card; absent, the server still generates one — the model may never invent
one) and an optional `param_map` — up to 10 workflow-variable ← envelope-path
entries (paths under body/query/headers/meta only) normalized into declarative
mapper rules on the target, reviewable line by line, never code. Also fixed:
the applied card's deep link opened the Activity EXECUTION viewer with the
record's id (workflow-56's card opened execution #56) — the focus payload now
carries a record kind that routes to the pane's own record opener; and
`automation.definition` falls back to `draft_version` when `current_version`
is 0, so Casey stops misreading unpublished workflows as empty.

**A18.4: Enroll a contact.**

Enrollment is an external-send fan-out and inherits A14's bar (resolved
preview, explicit recipients, strong idempotency, an unambiguous outcome).
Fred's ruling (2026-10-28): harden the native route first, then the card.
**A18.4a**, the first half, is that hardening — native, no schema change, no
card:

- `POST /sequences/enroll` takes an optional `Idempotency-Key` (scope
  `sequences.enroll`) under the workflows.start rule: a refusal raised before
  any enrollment row exists (400 / 404, the engine's 409s, `ENROLL_BUSY`)
  releases the claim; `SCHEDULING_FAILED` and any other 5xx keep it. A replay
  answers the first enrollment with `replayed: true`.
- The duplicate guard's SELECT and the INSERT run under a per-identity
  `GET_LOCK` (`seq_enroll_<template>_<contact>_<appt|0>_<signing request|0>`,
  5 s wait) on ONE pinned connection, in `_enrollWithTemplate` — so every
  caller (route, hook / trigger targets, `enroll_sequence`, appointment and
  e-sign reminders) is fenced. A lock not granted is `ENROLL_BUSY` (503),
  nothing inserted.
- A first step that cannot be scheduled no longer wedges the row: it is
  cancelled (`cancel_reason` `scheduling failed: …`), an
  `enrollment_schedule_failed` error alert is recorded, and the caller gets
  `SCHEDULING_FAILED` (500) with `enrollment_id`.
- Engine codes reach HTTP: `ALREADY_ENROLLED` (with `enrollment_id`),
  `NEVER_PUBLISHED`, `EMPTY_SEQUENCE` are 409; the body keeps the old
  `error` / `message` pair and adds `code`.

**A18.4b: the Casey enroll card. SHIPPED 2026-10-28; reviewed trigger_data
(A18.4c) 2026-11-04; e-sign scope (A18.4d, below) 2026-11-04** — kind
`sequence.enroll.v1`, through the hardened `POST /sequences/enroll` (the card's
`draft_id` is the `Idempotency-Key`, scope `sequences.enroll`). Direct mode by
`template_id`; `triggerData`, `payload`, `input`, `template_type` and the
TOP-LEVEL `appt_id`, `signing_request_id` and `case_id` are refused by name
(the ids ride inside `trigger_data` only). The model supplies
`{sequence_template_id, contact_id, trigger_data?, evidence}`; evidence must carry the exact
template id (an `automation.definition` row, as A18.2/A18.3) AND the exact
contact id (a row with `contact_id`, the A14 / contact-subrecord convention).
The normalizer refuses an inactive, never-published, empty or
unreviewed-action-type template, a missing contact, and an active
enrollment of that contact in that template IN THE SAME SCOPE (the engine's own
duplicate predicate, `appt_id <=> ? AND signing_request_id <=> ?` — the
payload's `appt_id` and `signing_request_id`, each NULL when absent — named by id).

- **No trigger data** — `trigger_data` absent or `{}` — is the shipped
  enroll, unchanged: the same card envelope (no `payload` / `trigger` keys,
  no extra read beyond the capture arm) and the same `trigger_data: {}` body.
- **A reviewed trigger_data (A18.4c**; Fred, 2026-11-04 — appointment-scoped
  enrollment by chat is wanted: "I think we should allow everything!").
  - **Closed key set** (`sequenceEnrollAllowedKeys`): what the PUBLISHED
    version reads from trigger data — `{{trigger_data.X}}` in a step's
    `action_config` or a placeholder `delay.at`; a step or template
    condition's params (`trigger_data.X`); `appt_time` (with `appt_id`) where
    the scheduler or fire guard reads it — `before_appt` /
    `before_appt_fixed` timing, `min_hours_before_appt` — because those ids
    feed the SCHEDULER, not a placeholder, and an appointment-dated
    enrollment must be tied to its appointment; and the ids
    `buildRefsForStep` binds tables from, wherever a step reads that table
    (`{{appts.*}}` → `appt_id`, `{{cases.*}}` → `case_id`, `{{users.*}}` →
    `appt_with`) — ∪ the keys of the template's `test_input` and
    `captured_input` samples. Keys are `[A-Za-z_]\w{0,63}` (what a
    `{{trigger_data.X}}` path can name). Any other key is refused with the
    allowed set in the message. **What the set cannot see:** what a
    `start_workflow` step's target workflow does with the values it hands on,
    a webhook's receiver, and an internal function reading trigger data by a
    name no placeholder spells — so a key can be under-listed; a sample key no
    step reads is allowed and the card says it is read by no step. The
    engine-implied keys make the set independent of whether a sample was ever
    captured (live templates were not measured for this slice: the worker had
    no read-only key — the derivation covers every appointment-anchored
    template by construction).
  - **Scalar values only**, A17.7b's caps reused as-is
    (`WORKFLOW_START_MAX_KEYS` 20, `WORKFLOW_START_MAX_STRING` 500, the
    one-line control/bidi refusal): every value is shown verbatim and whole.
  - **Refused by name inside trigger_data**, each with the engine's reason:
    `user` / `user_id` (they bind `{{users.*}}`, and no
    evidence row shape cites a user by id); `task_id` (binds `{{tasks.*}}`, a
    binding this card does not review); `contact_id` / `contact` (the
    enrollment's contact is the card's; a step reading the trigger-data value —
    a `start_workflow` contact override, a function param — would act on
    another contact); prototype names.
  - **Ids from evidence, consistent with the contact** — what the automation
    birth paths guarantee by construction (`apptService` builds trigger data
    FROM the appointment row and enrolls its own client): `case_id` (text) in a
    cited row, existing, and linked to the contact through `case_relate` (a
    `{{cases.*}}` placeholder would otherwise put another client's case in this
    contact's messages — the A14 rule); `appt_id` (a positive number) in a
    cited row (`evidenceSupportsAppt`), existing, and its `appt_client_id` IS
    the enrollment's contact — a mismatch (or a client-less appointment) is
    refused with both named. With `appt_id`: `appt_time`, when sent, must be
    that appointment's own instant (the firm-local naive `appt_date` read with
    `DATE_FORMAT` and converted in the firm zone; any spelling of the same
    instant passes, the refusal names the exact UTC value `apptService`
    sends); `appt_with`, when sent, must be its provider (so `{{users.*}}`
    binds through the cited appointment, the only user-binding route); a
    `case_id` must be the appointment's own case when it has one. `appt_time`
    or `appt_with` without `appt_id` is refused. **Deliberately not
    mirrored:** the appointment's status and whether it is in the future (a
    `no_show` sequence is born for a past No Show appointment — the card
    discloses both), and the `no_show` path's phone and one-active-no_show
    checks (that path's template-type policy, not a property of an
    enrollment).
  - **Scope.** A truthy `appt_id` makes the enrollment APPOINTMENT-scoped
    (the engine's own rule): it neither blocks nor is blocked by a
    contact-scoped enrollment of the same template + contact, the duplicate
    check and the click-time re-check use that scoped identity, and it is
    cancelled by `cancelByApptId` when the appointment is marked attended or
    no-show, cancelled or rescheduled — the card says so, or, for an
    appointment already in a terminal status, that no later status change
    cancels it.
  - **The preview and the walk run WITH the payload**, so a template dating
    step 1 from `{{trigger_data.X}}` or anchoring it to the appointment
    becomes enrollable when the payload feeds it; the unresolved list shrinks
    by what it feeds; a payload that still cannot place step 1 is refused as
    shipped. The card adds `payload` (`{trigger_data}`, the exact object sent)
    and `trigger` (per key where it is read; the scope; the appointment —
    firm time, type, status, past, provider, case; the case — label, caption,
    the contact's relation); the review warning says "with exactly the
    trigger data listed above". The browser builder sends `payload` as
    reviewed — re-checked (only `trigger_data`, placeholder-readable keys,
    none of the refused names, scalar values, a positive `appt_id`, and a
    `signing_request_id` only on the e-sign-scoped card naming that very
    request, never beside an `appt_id`), never rebuilt; a malformed payload
    sends nothing.
- **Capture disclosure — both cards.** An armed template
  (`sequence_templates.capture_mode` `'capturing'`; sequences have no
  intercept mode) stores THIS enrollment's trigger data as its
  `captured_input` at ingress — even when the enrollment is then refused as a
  duplicate — and disarms; the card carries `capture` and says so. An unarmed
  template's card carries no key.

**The preview is the engine's**: `previewEnrollmentSteps` (POST
`/sequences/preview`'s seam) with the additive option `version: 'published'` —
without it the editor's preview shows the DRAFT when one exists, and an enroll
never runs a draft (Fred, 2026-10-28: enrolling while someone is mid-edit is
legitimate, so a draft is disclosed, not refused). The option is fail-closed
(any other value throws, it never combines with the enrollment shape, a
never-published template throws) and the result carries `version`, which the
normalizer asserts equals `current_version`. Per step the card shows the
timing in words, its placement (when it runs / skipped, window passed /
timing error), the RESOLVED recipient, sender and wording for this contact,
and the placeholders the engine's `strict:false` resolution leaves as written
(with no trigger data no `{{trigger_data.*}}`, appointment, case or user
placeholder can resolve). The normalizer replays the enroll's own
first-placement walk (`scheduleFromStep` from step 1): a timing error before
any step places is the enroll failing — `SCHEDULING_FAILED`, the new row
cancelled, IT alerted — so the card is REFUSED rather than knowingly creating
that (Fred's ruling, 2026-10-28); without the trigger data they need, this is
what keeps appointment-anchored and placeholder-dated templates off the card.
A later step's timing error is
disclosed as a STALL (danger styling), and every absolute `delay.at` holding a
`{{placeholder}}` is named. Also on the card: the template condition's
verdict, effects (`sequenceStepEffects`, shared with A18.3), what normally
enrolls it, the running-enrollment count, and the fan-out statement.
Click-time precheck: `GET /sequences/templates/:id` (gone / deactivated /
`current_version` moved refuses — a published version is immutable, and the
trigger data is frozen on the card, so the walk verdict depends on nothing
else and an unchanged version is an unchanged preview) and `GET
/sequences/enrollments?contact_id=…&status=active&limit=100` (an active row of
this template in the card's scope — contact-scoped, this appointment's, or this
signing request's — refuses; a list it cannot read in full fails the re-check,
nothing claimed); an e-sign-scoped card also re-reads `GET /api/esign/:id`
(A18.4d, below).
**Outcomes** in A14's vocabulary via a family `knownOutcome` hook on the card
engine, keyed on exact status + `code` pairs (an idempotency body or anything
uncoded falls through): `ALREADY_ENROLLED` 409 → refused, naming the existing
enrollment; `NEVER_PUBLISHED` / `EMPTY_SEQUENCE` 409 → refused, stale card;
`ENROLL_BUSY` 503 → refused, try again in a moment; `SCHEDULING_FAILED` 500 →
"Failed — nothing will send", naming the enrollment; the A18.4d codes
`SIGNING_REQUEST_NOT_FOUND` / `_NOT_LIVE` / `_CLAIMED` 409 → refused, stale card,
and `SIGNING_REQUEST_WRITEBACK_FAILED` 500 with `cancelled: true` → "Failed —
enrollment cancelled", naming it (with `cancelled: false` it stays unknown); a plain 4xx (400 / 404) →
refused; any other 409 / 5xx / dead socket → unknown, write control removed.
201 → success with the enrollment id and when its first step runs (or that
none could be scheduled), `replayed` disclosed. Ledger receipt
`enrollment_id`; the applied card deep-links to the enrollment
(`ycAssistantNavigate('automations.sequence', {id, record: 'enrollment'})` →
rest `sequences~<id>~enrollment`, the A17.7 closed `records` grammar; the
sequences pane's `onFocusRecord` already opens a non-`sequence` record in its
enrollment viewer). Own off switch `casey_sequence_enroll_enabled`, on unless
`'0'` like every Casey flag (it first shipped dark-unless-`'1'`; Fred ruled
2026-10-28, same day: ONE polarity for all Casey flags — a family that must
start dark gets an explicit `'0'` row seeded at land time, never an inverted
code default — and all `casey_*` settings live in their own settings section). Sync bus: `POST /sequences/enroll` has no `public/js/yc-sync.js`
matcher and no enrollment view is bus-watched; the card adds no write route.
Tests: `tests/caseySequenceEnroll.test.js`, gated
`tests/caseySequenceEnroll.mysql.test.js`, the UI card in
`tests/assistantUi.test.js`, the deep-link grammar in
`tests/assistantSidebar.test.js`; A18.4d in `tests/caseySequenceEnrollEsign.test.js`
and gated `tests/caseySequenceEnrollEsign.mysql.test.js`.

**A18.4d: e-sign-scoped enrollments and the reminder pointer. SHIPPED
2026-11-04** (Fred, 2026-11-04: "allow everything"; "ok" to this slice). No
new kind, flag or write route. A18.4c refused `trigger_data.signing_request_id`
for two measured reasons — no Casey read carried a signing request id (so
evidence could not cite one), and `POST /sequences/enroll` never wrote
`signing_requests.seq_instance_id`, the pointer `esignService.applyStatus`
cancels the reminder enrollment through when a request goes terminal, so a
chat-born e-sign enrollment would have kept reminding after signing. This
slice closes both.

- **The typed read `esign.requests`** (`{"contact_id":N}` or
  `{"case_id":"…"}`, exactly one; `assistantService.esignRequestsRead`, app
  pool — the report manifest's `signing_requests` has neither the pointer nor
  the reminder contact). A contact's read lists its contact-linked requests
  and the requests of every case it is related to; a case's read, that case's.
  Newest first, capped at 20 (a summary head row says when more exist). Per
  row: `signing_request_id` (named so evidence matches the trigger key),
  `status`, `awaiting_signature` (`OUTSTANDING_STATUSES`: sent / viewed /
  partially_signed / bounced), `terminal` (signed / declined / expired /
  recalled / satisfied_external), `document_name`, `kind`, `template_id` +
  `template_name`, `tracking_id`, `linkable_type`, `case_id`, `contact_id` +
  `contact_name` — the request's REMINDER contact, resolved by
  `esignPrefillService.buildContext` (the send's own call: a case's Primary,
  MIN(contact_id) tiebreak, or a contact-linked request's own contact; a
  Secondary reads its case's Primary) — the four timestamps, `seq_instance_id`
  + `reminder_status` + `reminder_template_id`, and `enrollable`. Finished
  requests are RETURNED, marked (Casey answering "did X sign?" wants them); the
  normalizer refuses enrolling on one. The SELECT is an allow-list and the row
  mapping is explicit: `recipients` (signer emails / IPs), `provider_id`,
  `raw_payload` (the provider's payloads — where a signing link could live),
  `placement_json`, the signed / certificate PDF paths and
  `completion_targets` are never read, and no signing link is stored anywhere.
  `tracking_id` is exposed: it is printed on the debtor's own document and no
  route looks a request up by it, and the send puts it in trigger_data. Posture:
  any staff JWT, as `GET /api/esign` (A11.1's — no capability beyond the
  assistant's own).
- **`signing_request_id` inside trigger_data** is evidence-bound like
  `appt_id`, but ONLY to a cited `esign.requests` row (`row_type`
  `signing_request`; a `sql.read` row aliasing an id does not count — it does
  not carry the send's contact resolution); a positive number. It is the e-sign
  SCOPE key: accepted whether or not a step reads it (the engine reads it — the
  duplicate identity and the scope column — and the route ties the request to
  it), and kept out of the listed allowed set so A18.4c's refusal text is
  unchanged.
- **Consistency, mirroring `esignSendService._tryEnrollReminders`.**
  Mirrored: the request's reminder contact IS the enrollment's contact (both
  named on a mismatch; a request with no Primary refused — the send would not
  enroll anyone); the request has been sent and is still awaiting signature (a
  TERMINAL one never transitions again, so `applyStatus` — which cancels on the
  transition INTO a terminal status — would never end the chain; a `draft` has
  nothing at the provider and the send enrolls its own reminders when it goes
  out — and a draft that later sends would overwrite the pointer, orphaning a
  chat-born chain); its pointer names no ACTIVE enrollment (named — one live
  reminder chain per request); `document_name`, `tracking_id` and a
  case-linked request's `case_id`, when sent, are the request's own (the send
  builds them from the row; the refusal names the value). Not mirrored, on
  purpose: WHICH sequence the send would pick (the document template's
  `reminder_seq_id` or the firm default — the user names the template) and the
  template's `reminders_off` (an explicit request is the user's call); the card
  names the template either way. **Both scopes at once** (`appt_id` AND
  `signing_request_id`) is refused by name: measured on the engine, it files
  the row under both scope columns (its identity and lock carry both), but no
  birth path ever makes one, so neither cancel was designed to share a chain.
- **A pointer to a finished enrollment** (cancelled, completed, or a missing
  row) does not block: it is disclosed ("Earlier reminders: … is cancelled —
  this enrollment replaces it") and becomes the base the write-back replaces —
  as `resendPipeline` re-arms over a finished enrollment.
- **The write-back lives in the ROUTE** (`routes/sequences.js`
  `esignPointerBase` / `writeEsignPointer`), so every caller of `POST
  /sequences/enroll` is safe, not only the card — a browser-side write after the
  enroll could be cut off by a closed tab, leaving exactly the orphan this
  prevents. It does not touch `esignSendService`, which calls the engine
  directly and writes its own pointer. For a body whose trigger_data carries a
  truthy `signing_request_id` (the engine's own scope rule), in both modes:
  BEFORE any row — the request exists, is awaiting signature and is unclaimed,
  else 409 `SIGNING_REQUEST_NOT_FOUND` / `_NOT_LIVE` / `_CLAIMED` (claim given
  back; 400 `SIGNING_REQUEST_INVALID` for a non-id); AFTER the engine enrolls —
  ONE conditional `UPDATE signing_requests SET seq_instance_id = <new> WHERE id
  = ? AND seq_instance_id <=> <base read before> AND status IN
  (OUTSTANDING_STATUSES)`. A concurrent claim or a terminal transition in
  between matches nothing (`applyStatus` writes its status before it reads the
  pointer: it either sees ours and cancels it, or ours matches nothing). A miss
  or a throw CANCELS the enrollment (`cancelEnrollment`: the row and its pending
  jobs, `cancel_reason` `esign pointer not written: …`) and answers 500
  `SIGNING_REQUEST_WRITEBACK_FAILED` with `enrollment_id` and `cancelled`
  (claim kept — a row existed); a cancel that also fails records an
  `esign_pointer_orphan` error alert (the one shape `applyStatus` cannot
  reach). Caveat, disclosed: an immediate first step's dispatch may already be
  on its way when the cancel lands; cancelling stops every step not yet run.
  A body without a signing request issues no new query.
- **The card**: scope `esign` with `trigger.esign` (request id, document name,
  kind, status, sent time, case, `pointer_base`, `prior_enrollment`); the scope
  line names the request, its status and the reminder contact and says the
  enrollment is cancelled when the document is signed, declined, expires, is
  recalled or is satisfied outside e-sign — true because the route records it
  as the request's reminder enrollment (the twin proves `applyStatus` cancelling
  it); a bounced request's line (esign_remind skips a bounced request until
  re-sent); a "Signing request check" line. The duplicate distinction covers
  all three scopes — contact-, appointment- and e-sign-scoped enrollments never
  block each other. Click-time: the scoped enrollment re-read plus `GET
  /api/esign/:id` — still awaiting signature, `seq_instance_id` still the
  reviewed base. The no-payload and appointment-scoped paths are unchanged
  (no `esign` key, no `signing_requests` read; pinned).
- **Sync bus:** nothing in `public/js/yc-sync.js` watches `signing_requests` or
  enrollments, so the pointer write needs no matcher (no open view shows it).
- **Not this slice:** `user` / `user_id` / `task_id` stay refused
  (`ref/plans.md`). The `enroll_sequence` internal function and hook / trigger
  enroll targets call the engine directly, so a signing_request_id handed to
  them still gets no pointer (filed in `ref/plans.md`).

**A18.4e: the sends' recipients' consent on the card. SHIPPED 2026-11-09**
(manager pick, Fred's overnight standing go). No new kind, flag, route or
refusal. The engine never fails a send step on an opt-out: `send_sms` /
`send_mms` / `send_email` call `optoutService.assertNotOptedOut` and
`lib/sequenceEngine` turns that refusal into a SKIP that advances whatever
the error policy says (`sequence_step_log` status `skipped`, reason
`recipient_opted_out`) — so the card now says which step that will be.
- **The read is the send's own.** For every preview step whose
  `action_summary.function_name` is `send_sms` / `send_mms` / `send_email`
  with a RESOLVED recipient (`to` without a `{{placeholder}}`, not blank),
  `sequenceEnrollConsent` asks `optoutService.findOptedOut` the way the
  step's send will: operational SMS for the text functions (an SMS STOP
  blocks), operational email for `send_email` — which NO opt-out blocks
  (D18) — unless the stored params mark the step promotional (C7:
  `params.promotional`, truthy the way `communication.js` reads it), then
  marketing klass with the step's `params.topic`. Each such step carries
  `consent: {step_number, channel, destination, opted_out, version
  [, klass:'marketing', topic]}`; `version` is `optoutService.consentVersions`'
  consent version (it moves on ANY consent change for the destination). A
  check that throws — a promotional step with no topic, which the send
  itself refuses — carries `error` instead and is not re-checked at click.
  The card lists the flagged steps in `optout_steps`.
- **The card.** A flagged step line reads "OPTED OUT — <destination> has
  opted out of texts | marketing email [on topic "…"]: the engine SKIPS this
  step (logged "skipped — recipient opted out") and goes on to the next"; the
  Sends line names the steps that would be skipped; the stale-check line
  says consent is re-read. A card with no checkable recipient is
  byte-identical to A18.4d's (pinned).
- **Freshness.** `expected.consent` carries the checked entries; the click
  re-reads `/api/contacts/:id/phones` and `/emails` (only the channels it
  needs — `row.consent` is the server's own read) and refuses before the
  claim when a reviewed destination's version moved or, for an operational
  entry, its opted_out flipped (a marketing-scoped entry compares the
  version only: `row.consent` is operational). A destination that is not one
  of this contact's active rows cannot be re-read there and is checked at
  proposal only (`ref/plans.md`).
- Tests: `tests/caseySequenceEnroll.test.js` (the dual read, D18, the
  promotional branch, the unresolved recipient), `tests/assistantUi.test.js`
  (card text, the re-check's refusals and passes), and the real-engine twin
  `tests/caseySequenceEnroll.mysql.test.js`, which proves the disclosure IS
  the send's read: the flagged destination is the one
  `assertNotOptedOut` refuses on the engine, the operational email one is
  not, and a lifted STOP clears the flag and moves the version.

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
- `code` mode runs in the QuickJS guest in the sandbox child (`lib/guestCode.js`)
  with a 15 s limit; saving or test-drafting it needs `automations.manage`
  (`lib/triggerCodeGate.js`).
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

#### A20: Email and phone ingest rules

Planned 2026-10-26 on Fred's ask ("sooner than later"); phone ingest rules are
in scope with email — Fred: "practically the same", and it is: the
`routes/api.phoneIngest.js` rule/rule-action/test-match/test-transform surface
mirrors `routes/api.emailIngest.js` one-for-one. Ordering ruled the same day:
A18.2 finishes first, then A20. Rungs A20.0/A20.1 are read-shaped and may land
as one bundle under the 2026-10-26 gate-bundling rule (targeted suites per
slice; one full suite, survey and land per bundle).

**Measured ground (code + schema, 2026-10-26).** Ingest rules were nowhere in
this plan before today, and Casey cannot even read them: `automationReadService`
covers workflows (P12a) and sequences (P12b) only. The rules are live-on-save
and unversioned (AI_CONTEXT §26: NOT covered by automation versioning) — the
same property that deferred trigger-rule authoring — but with two differences
that change the answer: `email_ingest_rules.active` exists (tinyint, **default
1**, so a create must pin `active: 0` explicitly), and rule actions are per-row
CRUD by id (`addAction`/`updateAction`/`deleteAction` in
`emailIngestRuleService`), not the trigger-rules DELETE+REINSERT. Rules carry
`updated_at`; actions carry none, and an action write does NOT touch the parent
rule's `updated_at` (traced in A20.0, pinned on a real engine by
`tests/automationReadIngest.mysql.test.js`) — while every MATCH does: the
fire-and-forget `match_count`/`last_matched_at` bump is an UPDATE on the rule
row, and `ON UPDATE CURRENT_TIMESTAMP` moves `updated_at` with it (live
2026-10-26: 16 of the 18 email rules that ever matched, and 2 of 3 phone rules,
have `updated_at` equal to `last_matched_at`). So `updated_at`
is not "last edited", and a guard on it would refuse spuriously on a busy rule
(court emails: 940 matches) whenever mail arrived between review and click.
**The edit stamp, the change log and the precondition (slice 1 of the
A20.2/A20.3 build, Fred's go 2026-10-27 for both schema changes)** are built
canonically, ahead of any Casey kind, so the native editor gets them too:
`definition_updated_at` (DATETIME(3)) on both rules tables is moved ONLY by a
real definition change — the rule's own fields or any of its action rows
(an action write moves its PARENT's stamp) — inside the edit's transaction,
strictly increasing, never by a match; every such change appends a row to
`email_ingest_rule_changes` / `phone_ingest_rule_changes` (kind, actor, the
rule WITH its action rows before and after; `http` URL and literal header
values redacted; append-only); and every rule / rule-action write route
(rule PUT/DELETE, duplicate, action POST/PUT/DELETE) takes an optional
`expected_base: { definition_updated_at }`, checked under the rule's
`FOR UPDATE` lock — stale is P11's structured 409, nothing written. A save
that changes nothing moves no stamp and logs nothing. Code:
`services/ingestRuleChangeLog.js`; migration
`scripts/ingestRuleEditStampAndChangeLog.js`
(`ref/migrations/2026-10-27_ingest_rule_edit_stamp_change_log.sql`); no read
route for the log yet (SU console / readonly SQL).
`action_type` is `workflow|sequence|hook|internal_function|http`; `match_mode`
is `conditions|code` and `transform_mode` `passthrough|mapper|code`. Rule
`position` orders evaluation, so insertion position is part of review. The
hard semantics (throwing match = non-match, NULL `match_config` = non-match,
failed transform = matched but actions do not fire) and the three-layer model
are in AI_CONTEXT §26-27 and `manual/03-YisraFlow/10-ingest.md`; the explainer
grounds there, never in model memory. `email_ingest_sources` (live keys) stays
out of every rung; `http` action configs get the P12 URL redaction on reads.

**A20.0: Explain an ingest rule or an ingest execution (read-only). SHIPPED
2026-10-26** — the same four P12 kinds, new id keys (no new kind):
`automation.definition` / `automation.references` take `email_ingest_rule_id`
/ `phone_ingest_rule_id` (the rule, its action rows with each target's live
state, and what each action starts); `automation.run` takes
`email_ingest_execution_id` / `phone_ingest_execution_id` (status → the layer
the message stopped at, matched rules by name, every action outcome with the
synthetic `transform` / `rule_evaluation` / `skipped_test_envelope` meanings,
suppressions, a duplicate's original) or a rule id for that rule's latest
matching execution (`MEMBER OF`, numeric bind); `automation.list` gains six
types — the rules, the suppressions (Layer-2 context), and an executions
finder (sender/recipient/subject or phone-number search, firm-local
`since`/`until`). Served by `services/automationReadService.js`, names hydrated
through the executions services' own `_hydrateNames`. Redaction: `http` actions
are method + host + credential label (a whitelist); other action types drop any
`url`/`headers` key; `code` bodies are readable in ≤2,500-char `code_part`
rows (the largest live body is 10,775 chars); `raw_input` is never selected and
`email_ingest_sources` never touched (the source name comes from
`email_log.source`). Ingest starters joined the workflow and sequence
`automation.references` output (and so the publish card's impact preview).
The reading rules live in `lib/aiPrompts/automationRunExplainer.js`
`INGEST_RULE_EXPLAINER`, appended to the answer stage only when an ingest row
or preview was read. Measured against the code, two of this section's
semantics differ from the brief that framed it: a THROWING match is NOT
recorded on the execution (console warning only — the trigger engine records
it, ingest does not), and email firm-to-firm mail DOES run Layer 3 (only
suppression and the log write are skipped). Original spec:

Extends the P12 typed read kinds over `email_ingest_rules`/`phone_ingest_rules`, their
action rows, and `email_ingest_executions`/`phone_ingest_executions` (plus the
Layer-2 suppression tables, which decide only the structured log write). The
run-explain payload is the ingest analog of A17.1: which rules matched and why,
what the transform produced, which actions fired with what outcome, and the
layer the message stopped at. `code`-mode match/transform bodies are readable
per ruling 9's logic; `http` URLs and literal header values redacted.

**A20.1: Preview a rule against a message (read-only). SHIPPED 2026-10-26** —
kind `automation.preview_ingest_rule`. The four native endpoints' core moved to
`services/ingestRulePreviewService.js` (route responses unchanged — pinned,
queries included, against a golden recorded before the move:
`tests/ingestRulePreview.routes.test.js`). The kind evaluates through the
production `_evaluateMatch` / `_runTransform`, never `evaluateRules`: no
dispatch, no execution row, no `match_count` bump (real-engine proof: a full
row snapshot of every reachable table is unchanged, no write statement is
issued, dispatch tripwires stay silent). Message source: exactly one of the
channel's execution id (its recorded envelope via the sample fetchers), a
`sample` object (≤ 8,000 chars), or a `window` (≤ 40 messages, firm-local
bounds, match only). Output: matched + WHY not (the matcher's warning text,
captured — a throwing match is otherwise invisible), the transform output
(run only when the rule matches, exactly the live order), and per active
action what it WOULD do (workflow inactive/unpublished refusals, a sequence's
missing contact id, a hook's state, an internal function's resolved params,
an `http` host — never its URL). Deliberate narrowings: the kind previews a
STORED rule only — it refuses every native body field, because a `code` body
then ran in this process via `new Function` and a model-supplied one would
have been model-composed code executing in-process (the native routes accept
that only from holders of `automations.manage` — `lib/ingestCodeGate.js`).
Since 2026-10-26 code bodies run in the QuickJS guest (`lib/guestCode.js`);
the narrowing stands until Fred rules otherwise (`ref/plans.md`); and it prepares an email
envelope the way `evaluateRules` does (`body` = text || html), which the
native tester does not on full-fidelity rows (filed). A20.2 needed no draft
(unsaved) preview: a Casey-created rule is stored inactive, so this kind
previews it as soon as it exists; and the ReDoS answer for model-written
patterns is that A20.2 writes none (a pattern the edited rule already runs may
be kept). Original spec: the native
`POST .../rules/test-match` and `.../rules/test-transform` endpoints are the
dry-run surface, like A17.2's step preview: zero side effects, no actions run.
The kind must be unable to express anything but those two endpoints.

**A20.2: Author an ingest rule (the write). SHIPPED 2026-10-27** (with A20.3,
on slice 1's stamp / log / precondition). Ruled 2026-10-26:
**create-inactive is the draft/publish substitute** for this family — a rule
born `active: 0` matches nothing and fires nothing, the same born-unrunnable
property as A17.3's v0 workflow and A19.0's inactive hook. Six kinds on the
card engine, both channels, each ONE request to the rule editor's own route
(the route prefix comes from a closed two-entry map in the browser, never the
draft): `ingest_rule.create.v1` (`POST /api/{ch}-ingest/rules`),
`ingest_rule.update.v1` and `ingest_rule.set_active.v1` (`PUT …/rules/:id`),
`ingest_rule.action_add.v1` (`POST …/rules/:id/actions`),
`ingest_rule.action_update.v1` / `ingest_rule.action_remove.v1` (`PUT` /
`DELETE …/rule-actions/:id`). One card = one change = one request, so every
card is atomic and carries one precondition. Per-family flag
`casey_ingest_authoring_enabled`. The P2 matrix covers 42 kinds / 37 mounts.

- **Create.** The fixed builder pins `active: 0` (the column defaults to 1)
  and sends the rule with its actions in ONE request: `POST …/rules` takes
  optional inline `actions` (≤ 10, the action route's own shape validator up
  front, its reference validator inside the create's transaction, rows
  inserted before the change row so the 'create' log entry holds them — a
  refused reference rolls the rule back) and an optional `Idempotency-Key`
  (scope `{email,phone}_ingest.rules_create`; the card sends its draft_id).
  Native callers send neither and are unchanged. The card shows the
  conditions, the transform, each action in plain words, any notes (a
  non-catalog match path, a name another rule has, an unpublished target),
  and the position's evaluation order. Click-time safety is the idempotent
  draft_id + the 15-minute TTL (A17.3's narrowing — there is no existing
  record to re-read).
- **Grammar, built field by field** (services/assistantService.js
  `normalizeIngestRuleAction`). Conditions: a group tree (`and`/`or`, depth
  ≤ 5, ≤ 40 leaves) of `{path, op, value}` leaves, ops from hookFilter's own
  set; an EMPTY group is refused (an empty `and` matches every message).
  Mapper: `{to, from | template | value, transforms?}` with transform names
  from hookTransforms' registry. **No new regex:** hookFilter's `matches` and
  the mapper's `regex:` run on V8's backtracking engine, in-process, on every
  inbound message (conditions and mapper are not in the guest), so a pattern
  is admitted only when the rule being edited already runs exactly it (the
  court rules' live `regex:` descriptors survive an edit); the canonical
  fix — both on the linear engine — is filed to `ref/plans.md`. Measured live
  2026-10-27: 0 `matches` conditions; 44 `regex:` descriptors in 28 mapper
  fields across 5 email rules (6-10, the court mapper rules), every one of
  which compiles on V8's linear engine — so the canonical fix would
  grandfather nothing.
- **Actions** target only EXISTING records the route accepts (workflow by id,
  active; sequence template BY ID, active — `template_type` is refused
  because "whichever is active" cannot be pinned on a card; hook by slug,
  active) or an `internal_function` from the A17 allowlist whose
  `params_mapping` keys are its declared params (required ones present) and
  pass the route's `__validateParamsMapping`. `send_email` / `send_sms` send
  from a QUOTED LITERAL firm mailbox / line (`literalFirmSender`), never a
  value from the message; the card says who receives it and when the
  recipient comes from the message itself. A QUOTED LITERAL `to` is a forward
  by another name, so it gets the forward's review surface
  (`ingestLiteralDestination`, shared with forwards): one address / one
  10-digit number, classified firm/staff vs OUTSIDE THE FIRM on the summary
  and notes, and refused at authoring when opted out; a JSON-value `to`
  (passed to the function as-is, unclassifiable) is refused — a literal is a
  quoted string, a dot path reads the message. **`http` actions are deferred** —
  the vision says yes; the risk is that an ingest http action ships every
  matching client message to a URL, and A17.4b's literal-URL /
  named-credential contract is not built anywhere yet; the mitigation is to
  build that contract once (A17.4b) and reuse it here. Existing http actions
  may be renamed, toggled, moved or removed — never re-pointed (Casey cannot
  see their URL).
- **Forwards** (Fred's yes, 2026-10-27, ruling 15's logic): `forward_as_email`
  / `forward_as_sms` are ingest-action authorable, class `external-send`, from
  a separate list (`lib/caseyAutomationAllowlist.js`
  `CASEY_INGEST_ACTION_EXTRA` / `caseyIngestActionClass`). Measured: 4 of the
  13 live ingest internal-function actions are forwards, every one with
  `event: "$"`, a quoted literal firm sender and a quoted literal staff
  destination on a passthrough rule — the closed form the card admits. The
  destination is a quoted literal NEVER taken from the message (no live rule
  does that, and a sender-chosen destination would make the firm a relay);
  the card says "forwards every matching message to <dest>", classifies it as
  firm / staff (a firm email domain, a mailbox, an active firm line, or an
  authorized staff member's email / phone) or OUTSIDE THE FIRM, and is
  danger-styled (every send is); an opted-out destination is refused at
  proposal time (the function refuses it at send time since 05f29bd, so the
  forward could never deliver); `event` is exactly `"$"` and the rule's
  transform must be passthrough (a mapper/code output is not an envelope —
  an update that would switch a forwarding rule's transform is refused).
  **Not workflow-draft authorable:** the native workflow picker hides them
  (`__meta.uiHidden`), no live workflow / sequence / hook step uses one, and
  the workflow sender guardrail does not model a forward's destination —
  extending it is filed (`ref/plans.md`). `court_extract` stays off both
  lists.
- **Edits** (A20.2 for an inactive rule, A20.3 for an active one — the SAME
  kinds; `live` says which): update covers name, description, position, and
  match / transform (mode and config always travel together, because the
  route's gate and validator read an absent mode as the stored one; a switch
  to passthrough sends `transform_config: null`); `active` is its own kind;
  action update covers name, config, position, active (never the type). A
  no-op proposal is refused. **Every edit's `expected_base` is the
  `definition_updated_at` of the cited `automation.definition` rule row** —
  the read surface carries the stamp as an ISO instant — and the normalizer
  refuses when the live stamp no longer equals it (a human edit between
  Casey's read and the proposal); the browser re-reads `GET …/rules/:id` at
  click time and refuses before the claim if it moved (correction 1); the
  route's 409 is the backstop and renders as a refusal ("the rule changed,
  nothing was written").
- **Code modes:** Casey may author code-mode match / transform bodies. The
  vision says yes; ingest code runs in the QuickJS guest since 8327d9e, the
  boundary that made safe-mode workflow code Casey-authorable (ruling 13);
  the remaining risk is a wrong body acting on live mail once the rule is
  active. Mitigations: the card shows the whole body, a create is inactive
  (preview it with A20.1 first), and the request goes through the canonical
  ingest code gate, which Fred keeps — so the user's own capability decides:
  only an `automations.manage` holder can apply it, a plain staff user's card
  is refused 403 by the route with nothing written, and the card says so up
  front. **Confirmed by Fred, 2026-10-27.** Relaxing the gate stays Fred's
  call after the soak.
- **Read surface:** `automation.definition` on an ingest rule adds
  `definition_updated_at` to the rule row and the latest five change-log
  rows as `change` rows (kind, actor, firm-local time, a field-level
  before/after diff), readable by every staff member like the rule itself
  (the log holds nothing the rule does not; http URLs and header values were
  redacted at write) — **confirmed by Fred, 2026-10-27**. That is the "what
  changed" explanation and the revert path: Casey can prepare the reverse
  edit as a card.
- **Not built here:** a deep link from the applied card (the automations
  manager has no ingest-rule record opener; the card names where to find
  it), rule delete / duplicate, and a draft (unsaved) preview. Sync bus: no
  ingest route is in `public/js/yc-sync.js` MATCHERS and no Casey-only emit
  is added; the precondition is the protection.

**A20.3: Edit an active ingest rule. SHIPPED 2026-10-27** (with A20.2). Ruled
its own slice (Fred, 2026-10-26: "it should also be able to edit — that's
just its own slice"). An active-rule edit is live-on-save, so it rests on the
two pieces the trigger decision prescribes, built canonically in slice 1: the
append-only change log (the review diff and the revert path) and the
`definition_updated_at` precondition, mandatory on every Casey edit — an
action write moves its parent's stamp, so the one value guards the rule and
all of its actions. The edit kinds are A20.2's; on an ACTIVE rule the card is
danger-styled, says plainly that the change applies to the very next matching
email / call / text, shows every changed value before and after, and names the
change log as the undo. **Activation** (`ingest_rule.set_active.v1`) is in:
the vision says yes (ruling 17's logic — Casey acts as the user, and the native
editor lets any staff member flip `active`); the risk is a rule going live on
real traffic; the mitigation is the danger card naming what it will start and
on which traffic (every active action listed, the evaluation order, a code
match/transform called out) plus the change log. **Confirmed by Fred,
2026-10-27.** Deactivation uses the same card. Once this lands, trigger-rule authoring needs only its own copy of the
same two pieces (the A18 trigger decision) — the recipes should match.

#### R1: Read-loop continuation — SHIPPED

Fred, 2026-10-26: "at least it should be able to ask for more turns"
(ref/CASEY_VISION.md). An investigation that stops on its budget is a defect
against the data-synthesis goal, not a safety feature, so the full shape
ships: when the loop stops on a round, step, row, time, or controller-token
budget rather than `model_finished`, the answer names the budget and what is
still unknown, and the message carries a **Keep going** control. Each click
grants one fresh budget of every kind (the automation widening sticks) and
the SAME investigation resumes — original signed context, prior evidence,
plan passes and operation fingerprints carried forward, steps a budget left
unrun executed first, rounds and q-ids numbered globally, citations spanning
every pass — across as many clicks as the user grants. Grants are per click,
never automatic.

- **Evidence is server-sealed, never client-supplied.** Evidence authorizes
  action cards (the evidence rule), so the carried state travels as an
  AES-256-GCM token (`lib/assistantContinuation.js`, key HKDF'd from
  JWT_SECRET under its own label): a forged, tampered, wrong-key, or
  plan-ticket token is refused before any read or model call; the token is
  bound to the user and to the chat (`chat_id`, owner-checked), and the route
  reads no evidence from the body. No migration: a server-held table was the
  alternative and the stateless seal needs none.
- **No grant cap** (the vision's default): runaway spend is mitigated by
  per-click grants, the execute rate limit (60/hour), the firm monthly spend
  cap checked on every continuation, the chat message cap, and visibility —
  the control shows passes, reads, rows and the investigation's approximate
  AI cost so far.
- **Evidence ceiling** grows by `MAX_EVIDENCE_CHARS` (60k) per grant up to
  360k characters (~110k tokens, well inside both model modes' 1M context);
  past it the existing newest-first trim applies and is disclosed per step.
  Per-cell 3,000 characters and the answer's max_tokens rules are unchanged.
- **Freshness:** 15 minutes per seal (the action-card window, since a
  continued answer may carry a card), sliding with each grant. The token is
  never saved with the chat, so a reopened chat offers **Ask Casey again**
  (the same rule as cards never being writable from history). The frozen
  workspace context of the original question governs; navigating since does
  not invalidate the continuation.
- A controller truncated at its output ceiling is now `token_budget` (it was
  reported as `model_finished`, measured live 2026-10-22); other controller
  failures are `controller_unavailable`, disclosed but not continuable.

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

The controlled multi-round dependency-read test ran live and passed 2026-10-28
(the Read-loop release gate section records the run). Still open: a
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
  (Later families add exceptions: `hook.create.v1` needs `automations.manage`,
  A14's two send kinds reach the comms hub routes, which check the
  caller's per-channel `can_send` grant and make an SU step up, and an A20
  ingest-rule card that carries a code body meets the ingest code gate.)
- **There is no firm/tenant axis.** The schema has no `firm_id` or `tenant_id`,
  so "cross-firm" has no expression here; the row constraints that exist are
  the normalizer's (evidence must name the exact id, the parent must match, the
  link must exist) plus the A5 subrecord preconditions.
- **The write route is NOT a validation authority for assignee or provider
  eligibility, and mostly not for terminal state.** `taskService.createTask`
  contains no SELECT at all and never looks `to` up in `users`;
  `apptService.createAppt` never checks `appt_with`. For these fields the
  normalizer's proposal-time check is the only one, so a user disabled between
  proposal and click still receives the write. The 15-minute TTL and the
  no-write-from-history rule bound the exposure window; they do not close it.
  The contact-subrecord family is the exception: its `expected_updated_at` /
  `expected_primary_id` preconditions make the route the authority, which is
  what P3 should generalize.

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

Still open from P4's full scope: replays and other fan-out are not wired
(their families are not built yet), and an ambiguous outcome is only logged
server-side, not alerted — that belongs to P7. Sends are wired (A14), with the
stricter keep-the-claim-on-failure rule described there, and so are workflow
starts (A17.7, scope `workflows.start`, the same rule) and sequence
enrollments (A18.4b, scope `sequences.enroll`, the same rule plus
`ENROLL_BUSY` releasing).

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

**Workflow half SHIPPED 2026-10-24 with A17.4** (expected-base precondition on
the five step-mutating routes; unknown `function_name`, undeclared param keys,
`params: null`, and the `error_policy` shape + strategy enum all refused at
save — see the measured-gaps list above for exactly what closed and what
remains). **Sequence half SHIPPED 2026-10-26** (same precondition on the five
sequence step routes; sms/email/task/internal_function step validation). The
workflow publish precondition shipped with A17.6, the sequence one with A18.3
(2026-10-28); open: param re-validation at publish (both engines).
Fred's ruling on the human-path divergence: validate only
the fields being written — an existing step whose function was since renamed
keeps its label editable; a PUT that rewrites the whole step is validated
whole (implemented that way).

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
workflows, CTA links and (A20.0) email/phone ingest-rule actions. A20.0 put
ingest rules on the same four kinds with their own id keys.

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

#### P13: Workspace context for automations — SHIPPED 2026-10-24 (with A17.4)

The workflows and sequences sub-pages now report their open record to the
manager shell (`ycSubRecordChanged`), which owns the workspace segment:
`open=tabMore~moreAutomations~workflows~27`. `normalizeWorkspaceContext`
derives `workspace.automation = {kind:"workflow"|"sequence_template", id}`
deterministically from the canonical URL (outside `active`, so the browser's
byte-compared `active` object and the signed-ticket round trip both survive),
and `validateWorkspaceContext` verifies the record exists — a dead id is
refused like a dead case file — and attaches its name as `label` on the plan
path. "Explain this workflow" now resolves without asking. Free side effect:
the segment rides the workspace URL, so a reload reopens the record through
the existing `wsBootSubPage` deep-link restore; `automations.sequence` joined
the shell's destination map and the sequences pane's `onFocusRecord` for the
same reason. Deliberately NOT done: executions/jobs/hooks sub-pages don't
report a record yet (their read kinds take explicit ids), and the
model-offered answer-destination registry still carries only
`automations.court_review` — destinations cannot carry a record id today, and
applied cards already deep-link, so extending that grammar is its own small
slice if explain-answers should link back to a specific record.

## Recommended execution order

0. The 2026-10-21 fix package landed (`7c8f225`); the P1 browser extraction
   landed after it, then minimal P4 (`3eb7a99`) and the P5 ledger (`49f2475`),
   both ahead of A6 per course correction 2.
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
   A17.6 and A18.3 publish additionally need P3 generalized. A17.7 start
   shipped on A14's send machinery, and so did A18.4b enrollment (after A18.4a's native hardening). A20 (ingest rules)
   follows A18.2 (Fred, 2026-10-26); its read rungs A20.0/A20.1 have no
   prerequisite beyond the P12 pattern and may bundle.
6. Expand via P10 gates. Keep destructive/admin/bulk/autonomous work outside
   the ordinary roadmap until separately approved.

For the upcoming review, the key decisions are whether this ordering is right,
which scalar fields A7 takes (decided — every case field except case_id, see
A7 groups B/C), whether delete variants in A6 should be deferred entirely, and what operational bar must be met before the
first external-send or fan-out action. A5 deliberately excluded hard delete;
after the fix package, P1 extraction and minimal P4/P5, the next action slice
is A6 contact relations and roles.
