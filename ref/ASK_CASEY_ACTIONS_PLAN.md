# Ask Casey typed actions plan

Status: A0/A0.1, A1, A2, and A3 implemented 2026-10-20. A2 covers the complete
task lifecycle; A3 covers reviewed Event create/update/complete/cancel through
the existing authenticated routes. No general action executor is introduced.

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

## Explicitly deferred

- Appointments lifecycle actions; notes, contact/case field changes, forms,
  reports, and workflow drafts;
- sending arbitrary email or SMS (normal task notifications remain part of the
  existing task-creation behavior disclosed by the confirmation);
- multiple-action plans or conditional execution;
- personality changes;
- broader or longer autonomous read budgets; and
- any general-purpose tool/API/URL invocation chosen by the model.

These are separate slices with their own schemas, review language, permission
checks, idempotency, audits, and rollback behavior.
