# Ask Casey typed actions plan

Status: implementation-ready design, no action writes enabled.

This plan follows the shipped Ask Casey workspace-context and bounded
autonomous-read slices. It covers the next small slice only: a typed,
server-validated **task proposal** rendered in the conversation. The proposal
is a draft. It cannot save a task, change a record, send a message, schedule a
reminder, or invoke an arbitrary application route.

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
- allow only the existing task link vocabulary: `contact`, `case`, `appt`,
  `bill`, or `event`; verify the referenced record exists before returning the
  draft;
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

Do not use the existing generic `POST /api/tasks` route from the browser. Its
defaults can send an assignment email, and suppressing that email still does
not suppress start/due reminder scheduling.

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

## Slice A1, deliberately separate: reviewed task creation

A1 may add a Create button only after A0 has shipped and been observed. It must
not treat the existing signed read ticket as write approval. Read tickets are
replayable within their lifetime; a write needs a stateful, one-time approval
record bound to:

- authenticated staff user;
- exact normalized action JSON and a digest of it;
- originating chat/message and workspace snapshot;
- creation and short expiry times;
- `pending`, `executing`, `succeeded`, `failed`, or `expired` state; and
- the resulting task ID or a stable failure record.

The review card must show the exact new task values (`before` is no task;
`after` is the complete normalized task). Any edit invalidates the prior
approval and requires server revalidation plus a fresh approval record.
Execution atomically claims a pending record so retries cannot create a second
task.

Before A1, change the canonical task service to support an explicit,
server-enforced notification policy. `send_assignment_email: false` is not
enough: a start or due date currently schedules reminder email. The first
reviewed write should use `notification_policy: none`; enabling assignment or
reminder delivery is a later, separately visible choice.

The eventual executor calls `taskService.createTask` directly after rechecking
the assignee and linked entity. It does not call the broad public task route,
accept arbitrary request-body fields, expose the returned action token, or let
the model select an endpoint.

## Explicitly deferred

- actually creating, updating, completing, transferring, or deleting tasks;
- notes, contact/case field changes, forms, reports, and workflow drafts;
- sending email or SMS, including task assignment and reminder email;
- multiple-action plans or conditional execution;
- personality changes;
- broader or longer autonomous read budgets; and
- any general-purpose tool/API/URL invocation chosen by the model.

These are separate slices with their own schemas, review language, permission
checks, idempotency, audits, and rollback behavior.
