# Ask Casey

Ask Casey is the user-facing name for the firm's YisrAI assistant. Its searches
are read-only; its reviewed Task, Event, Appointment, and contact-subrecord
actions are performed by the signed-in user after explicit review. It can answer
questions about firm records, how YisraCase itself works, general knowledge,
and current weather. Open it from the persistent **Ask Casey** button at the
bottom of the left sidebar. **More → Ask Casey** opens the same assistant in a
wider sidebar; it does not create a second chat or replace the workspace.

The case, contact, appointment, or tool already on screen remains visible.
Opening or collapsing Casey does not change the workspace URL, cancel a
request, discard attachments, or reload the assistant. On a phone, the same
assistant uses the full-width sidebar sheet.

## Asking a question

Type naturally. Useful questions include:

- “What is the story with the person who emailed about tractors a few weeks ago?”
- “Which open matters have appointments in the next two weeks?”
- “What happened recently on this case?”
- “How do locked reports work?”

Casey knows which staff user is asking from the signed-in session. First-person
questions such as “What is my next appointment?”, “Show my open tasks”, or
“Which calls did I handle?” use that exact staff ID. They do not match by name,
and a similarly named contact is not treated as the signed-in staff member.

The composer starts with a removable **current view** chip. When present, the
question includes the canonical ID-only workspace snapshot and its parsed
meaning. Remove the chip when the current screen is irrelevant. The snapshot
is frozen when Send is pressed: moving to another screen while the answer is
being prepared does not silently retarget the question. The server validates
case/contact references and signs the snapshot into the same user-bound ticket
as the read plan. Workspace context is evidence about what is on screen, not
permission to read or change it.

Read-only searches run automatically. The assistant may search ordinary data,
the phone-call archive, the YisraCase manual, or current weather. Generated SQL
and its success or rejection are retained in the developer report-run log so a
failed answer can be diagnosed without asking staff to review query syntax.

For a question that needs another fact, Casey can make up to three bounded read
passes in the same request. The server allows at most eight operations, 250
returned rows, three minutes, and 7,000 investigation-controller output tokens
(with separately capped repair and answer calls). Each pass must target a
specific missing fact; an exact repeated operation stops the loop. If a budget
ends first, the answer uses the evidence already found, says which limit
stopped it (read passes, read steps, rows, time, or the controller's planning
limit) and what remains unknown. These automatic passes are reads only.

### Keep going

When a limit, rather than Casey's own judgment that the evidence is enough,
ended the investigation, the answer shows a **Keep going** button with what was
read so far (passes, reads, rows, and the approximate AI cost of this
investigation). Each click grants exactly one more set of the same limits and
continues the SAME investigation: Casey keeps everything already read, does not
re-run earlier reads, numbers the new passes after the old ones, and writes a
fresh answer whose sources can come from any pass. A continued answer can stop
on a limit again and offer another Keep going; there is no fixed number of
clicks, and nothing ever continues without one. Each continuation counts like a
question against the hourly search limit, the chat's message limit, and the
firm's monthly AI spending limit.

The evidence travels sealed (encrypted and tamper-proof) in the page, so the
browser can neither read nor change it, and only the same signed-in user, in
the same chat, can continue it. A continuation lasts 15 minutes and is never
saved with the chat: after that, or in a chat reopened from **Recent chats**,
the button becomes **Ask Casey again**, which refills the original question.

### The answer as it is written

Once the reads are done, the answer's words appear as Casey writes them, with a
blinking cursor, instead of all at once when it is finished. The streamed text
is a preview: when the answer is complete it is replaced by the finished
answer — with its sources, record links, suggestions and any action card — and
that finished answer is what is saved with the chat. The two are normally the
same; when they differ (for example, a card could not be prepared and the text
says so), the finished answer wins. If the connection drops while the answer
is being written, the bubble reads **Answer interrupted — retrying…** and
Casey writes the answer once more from the evidence it already read, without
searching again; if that also fails, the ordinary error is shown. The off
switch is the `casey_answer_streaming_enabled` setting (**Casey streams its
answers**): `0` restores answers that arrive whole.

After execution, the answer includes source rows for important claims. When a
source contains a case, contact, appointment, event, or task id, visible buttons
under the citation open those records directly in YisraCase. Open those sources when an answer
affects a deadline, filing, client communication,
or other consequential decision. The assistant can misunderstand incomplete or
ambiguous records.

Staff identity answers use the `roles` assigned in Admin → Users. Login status,
the ability to host appointments, and calendar activity are not treated as a
person's job title. Appointment starts and ends are shown in the firm's
configured timezone (normally America/Detroit). The stored `appt_date` is that
firm-local wall time; `appt_date_utc` is its separate real-UTC twin used for
scheduling and integrations.

## Reviewed actions

Ask Casey can prepare one evidence-backed action for explicit review. Only one
proposal appears in an answer. Task actions are described first; Event,
Appointment, and contact-subrecord actions follow below.
Ask naturally—for example, “Make a task for SS to review Ask Casey next
week.” Casey should look up the active numeric staff ID behind initials or a
name, verify any requested case/contact/appointment/event link, and return a
**Task draft — not saved** card. If a missing fact is supplied in a short
follow-up, the recent conversation keeps the explicit task-draft request in
scope.

The card is not an approval and changes nothing merely by appearing. Casey can
propose creating, editing, completing, canceling, reopening, or transferring a
task. Cancel is YisraCase's reversible soft-delete; reopening restores a
completed or canceled task. To perform the action:

1. Review the exact task, action, values, assignee, dates, link, and optional
   note shown on the card.
2. Select the card's **Review & …** button.
3. Read the YisraCase confirmation dialog and continue only if every value is
   correct.

A card is offered for writing only while it is fresh. Casey checks the records
when it answers, not when you click, so a card more than 15 minutes old, or any
unapplied card in a chat reopened from **Recent chats**, shows **Ask Casey
again** instead: it puts your earlier question back in the composer so Casey
can prepare the action against the records as they are now. After a write
succeeds, Casey saves "applied" with the chat before the button frees up; if
that save fails, the card and a warning dialog say the action WAS applied and
must not be repeated.

The confirmed button calls the ordinary authenticated task route with only the
reviewed, server-normalized fields. Creation uses `POST /api/tasks`; ordinary
edits use `PATCH /api/tasks/:id`; complete, cancel, reopen, and transfer use
their established transition routes. The signed-in staff user remains the
actor. Creation and transfer may notify an assignee, completion may notify the
assigner, and date changes may schedule or cancel reminders. **Copy details**
remains available; **Discard** changes no YisraCase record. Casey cannot draft a
bill-linked task because the legacy `bill` task-link enum has no verifiable bill
record source.

For creation, assignee, title, and a clear description are required (the API
has a defensive empty-description fallback, but the native Tasks UI requires a
description). Start is optional and means “not actionable before”; it stays
blank unless the request actually specifies a start date. Creating today does
not imply starting today. Due is optional but recommended when the request has
a real deadline. When the user does not specify completion notification, Casey
defaults it off for self-assignment and on when assigning somebody else. Link
is optional. The browser fixes `source` to `Casey`, leaves assignment email at
its normal enabled default, and never sends a model-selected assigner.

This user-through-browser pattern is the core action boundary: Casey proposes
the fixed fields, but the staff member's click sends the request from that
person's authenticated browser. The existing application endpoint—not the
model—enforces permissions, identifies the actor, writes the audit trail, and
runs normal product behavior. A new Casey-specific action endpoint should be a
last resort, considered only when no existing user-facing endpoint can safely
perform the exact reviewed action.

Each future action must also be checked against YisraCase's sync/event bus. If
the canonical write affects data visible in another open frame or browser tab,
the canonical operation—not Casey-specific code—must publish the normal update
for every caller.

### Event actions

Casey can also prepare one reviewed Event action: create, update allowed Event
fields, complete, or cancel. It cannot delete or reopen an Event because the
Events API has no such route, and it cannot use this card to create a batch.

An Event creation card requires a title, type, firm-local date, and an explicit
all-day choice. A timed Event also requires a firm-local time. Times are wall
times in the firm's configured timezone (normally America/Detroit), not UTC;
the card rejects `Z` and numeric timezone suffixes. Optional values are a
1–1,440-minute duration, location, URL, note, one verified case/contact/docket
link, availability scope, and one reminder task. For a timed Event with no
duration, Google Calendar uses 60 minutes. An all-day Event has no time or
duration and uses firm-wide availability scope.

The type is resolved against the Calendar Item Type registry. A known type is
shown with its canonical label and kind. A custom type is shown as `other`.
Meeting types belong to Appointments and are not available through an Event
card. The linked case, contact, or docket is fixed at creation; updating an
Event cannot move it to another record. Availability scope is shown as
firm-wide, nobody, or one verified appointment provider. A reminder is shown
with its exact assignee and date and creates a normal Task linked to the Event.

For update, complete, and cancel, the evidence must contain the exact
`event_id`. Casey reloads the Event before returning the card and accepts only
a current Scheduled Event that has not been superseded. Update is limited to
type, title, date, time, all-day, duration, location, URL, note, availability
scope, and reminder. Complete records `met` for a deadline by default and
`held` for other kinds; a deadline may instead be marked `moot`. Staff do not
mark a deadline `missed` through this action—the calendar sweep owns that
outcome. Cancel records `cancelled` by default; a deadline may instead be
marked `moot`.

The card and confirmation spell out calendar and reminder effects. Creation
attempts to add the Event to the firm's default Google Calendar. Updating its
title, date, time, all-day setting, duration, location, or URL recreates an
existing synced entry; changing type, note, or availability scope does not
rewrite that Google entry. Completing keeps the past Google entry. Canceling
deletes it by default unless the reviewed card explicitly says it will be kept.
Completing or canceling also cancels active reminder Tasks for the Event.

After a successful action, Casey opens the ordinary Event view. The result is
saved with the chat, so reopening the conversation offers **Open event** rather
than the same write again. The normal Events sync bus refreshes other open
Events, Calendar, case, and contact views.

### Appointment actions

Casey can prepare one reviewed Appointment action: create, narrow update,
attended, no-show, cancel, reschedule to a new slot, or mark for rescheduling
later. Appointment and Event actions remain different contracts even though
both appear on the calendar.

Creation requires an existing client contact, active meeting type, length,
platform/location, future firm-local date and time, and active appointment
provider. A case linked to that contact and a note are optional. The card displays the firm's timezone,
exact provider, client, case, type key, duration, and whether the type is a
singleton.

An appointment card sends the client nothing unless you ask for a
confirmation ("book it and text her the details"). Create, cancel and
reschedule can then carry the appointment's own confirmation text and/or
email. The card shows the message already filled in from the records, the
number or address it goes to (the client's phone and email on the contact),
the firm line or sender it comes from, and the email subject; what you see is
what is sent, except the client's manage link, shown as
*[secure manage link …]* and filled in when the message goes out. It goes to
the client as soon as the appointment saves and cannot be recalled. A client
who opted out of texts or email cannot get a confirmation on that channel: the
card is refused, because confirmations are automatic messages. To message an
opted-out client anyway, ask for a separate text or email card (see
*Sending a text or email*), which lets you confirm past the opt-out.

Creating an Appointment attempts to create both a firm Google Calendar entry
and a provider-calendar entry when that provider has a separate calendar. The
firm entry includes the client attendee, but Google update emails are disabled.
Creation cancels active no-show sequences and enrolls normal pre-appointment
automation. A singleton meeting type may supersede an existing live
Appointment for that case and remove the old calendar entries; the card says
so before confirmation.

For an existing Appointment, current evidence must contain its exact
`appt_id`. Casey reloads the record and its contact, case, provider, status,
time, and calendar state before returning the card. Canceled and Rescheduled
Appointments are terminal. Attended and No Show can correct one another;
cancel or reschedule may also follow either status, matching the native UI.

The generic Appointment PATCH endpoint does not update Google Calendar or
appointment automation. Casey therefore limits ordinary update to replacing
the complete note or changing/removing the case link; a new case must be linked
to the Appointment's contact. A date/time change uses
the dedicated reschedule operation. Type, length, platform, provider, status,
calendar identifiers, reference IDs, and actor/source fields cannot be sent
through the update card.

No-show enrollment defaults off. When reviewed on, it may start the normal
no-show sequence; an eligible intake case may also move to its no-show pipeline
stage. Attended and no-show cancel Appointment automation but keep existing
calendar entries. Cancel defaults to deleting both calendar entries and not
creating a follow-up Task. No cancellation SMS/email is sent unless you asked
for a confirmation; the optional follow-up Task is displayed explicitly. Canceling an appointment that is
already Canceled, or rescheduling one that is already Rescheduled, is refused
for every caller (Casey card, native form, second tab), so a repeat never sends
a second notice or creates a second successor.

Reschedule-now marks the old Appointment Rescheduled, removes its calendar
entries and automation, and creates a lineage-linked successor with the same
client, case, type, length, platform, and provider at the reviewed new time.
The successor receives new calendar entries and automation; no client message
is sent. Reschedule-later creates no successor;
it removes the old calendar entries and automation and may create the reviewed
follow-up Task. A successful reschedule-now opens the successor; other actions
open the affected Appointment.

The browser maps each fixed proposal kind to the ordinary authenticated
`/api/appts*` route and exact allowlisted body. It never accepts a route,
method, source, or acting user from the model. Results are saved with the chat,
and the normal Appointment sync bus refreshes open Appointment, Calendar,
case, and contact views—including both predecessor and successor after a
reschedule.

### Contact phone, email, and address actions

Casey can prepare one reviewed create, narrow update, or end action for one
contact phone, email, or address row. It cannot use these actions to edit the
contact's scalar identity fields, relations, or roles, and it cannot combine
several rows in one proposal.

Creation requires current evidence containing the exact parent `contact_id`.
Phone and email values are normalized by the native services and cannot be
force-transferred from another contact; an active ownership collision is
rejected. Address creation requires at least one of street line 1, city,
state, or ZIP. Native labels and defaults are preserved: opt-outs default off,
MMS capability defaults on, country defaults to US, and the first-ever row in
that family becomes primary unless the reviewed proposal says otherwise.
An omitted phone/email start date is normalized to “since forever” when the
value has no ownership history or the day after its latest ended window; an
address with no stated start keeps none (“since forever”), as the native form
does. The exact result appears in the card.

Making a new or existing row primary demotes the current active primary row
and recomputes the contact's scalar phone, email, or address mirror. The card
shows the current primary value that will be demoted. SMS/email opt-outs and
MMS capability are consent or delivery settings, so Casey changes them only
when the request states the value explicitly.

Phone and email values themselves are immutable on the dedicated PATCH routes.
A narrow update may change their label, notes, primary promotion, and relevant
opt-out/MMS settings. Address updates may additionally change the address
parts. `verified`, ownership start-date edits, force transfer, and explicit
primary demotion are excluded.

An end action records a non-future firm-local end date and a required reason of
at most 40 characters (the stored field's width; a longer reason is refused
rather than cut short). It
keeps the row in contact history and is not the irreversible DELETE route.
Only active rows can be updated or ended. Existing actions require one current
evidence row containing both the exact parent `contact_id` and exact
`phone_id`, `email_id`, or `address_id`, then reload the row server-side.

Each reviewed update/end carries the row's server-owned `updated_at` version;
a primary-changing write also carries the reviewed current-primary identity.
The canonical route locks and rejects the write if either changed after Casey
prepared the proposal. Successful actions save their result in
chat history and open the parent contact. Canonical `yc-sync` matchers announce
create and PATCH responses to every open recipient contact; native forced
phone/email transfers continue to announce the donor too. No Casey-only bus
event or execution endpoint exists.

### Sending a text or email

Ask Casey can send ONE text message or ONE email to ONE client, now, when you
ask it to ("text Pat that her hearing moved", "email the client the 341
date"). Every send is a card you read and confirm; nothing goes out until you
click **Review & send** and confirm the dialog that says *This sends NOW to …
It cannot be recalled.*

- **Who it goes to.** The recipient is always one of the contact's own active
  phone numbers or email addresses, found in Casey's lookup — never an address
  typed into the chat. The card names the person, the exact number or
  address, and its label.
- **Opted-out recipients.** Casey works like you do in Comms: it can still
  prepare a send to a number or address that has opted out (the SMS / email
  opt-out on that phone or email row), and says so. The card shows *This
  recipient opted out of SMS* (or *email*) in red at the top, before anything
  else. When you confirm the send, you get the same "Send anyway?" question
  Comms asks; **OK** sends it and the send is recorded as an acknowledged
  opt-out, **Cancel** sends nothing. Send anyway only when the client asked
  for the message. Automations (workflows, sequences) still never message an
  opted-out recipient.
- **Who it comes from.** A phone line or mailbox you can send from (your own
  send access in Comms). When you don't name one and you have exactly one,
  Casey uses it; otherwise it asks which.
- **What it says.** Casey may write placeholders such as
  `{{contacts.contact_fname}}`; they are filled in BEFORE the card is shown,
  and the card shows the finished text — exactly what is sent, word for word.
  A placeholder that can't be filled in for this person stops the card. Texts
  are plain text up to 1000 characters and the card shows roughly how many SMS
  segments it will take; emails are a one-line subject and a plain-text body.
  If the message contains a Social Security number the card warns you.
- **What it doesn't do.** No attachments, pictures (MMS), cc/bcc, replies into
  an existing thread, scheduled sends, or messages to several people. The
  email is not filed to a case by the card (a case is only used to fill in
  case placeholders). An appointment's own confirmation rides on its
  appointment card instead (see *Appointment actions*).
- **When you click.** Casey re-checks the number or address first; if it ended,
  changed, or its opt-out changed since the card was prepared, nothing is sent
  and the card says why (ask again — the new card shows the current opt-out). The send then goes through the same Comms send that a person
  uses — your send access, superuser password step-up, and the per-person send
  limit all apply.
- **The result.** A sent card says *Sent* and **Open conversation** opens the
  contact on its Communications tab (the text or email appears there once the
  phone provider or mailbox records it). If the result is unclear — a timeout,
  a provider error after the message left — the card says *Outcome unknown*
  and offers no way to send again: check the Communications tab or the comms
  log before asking Casey to send it again. A refusal you can read (no send
  access, an inactive line, the send limit) says nothing was sent.

The off switch is the `casey_send_enabled` setting.

### Making a report or an exportable list

Ask Casey can turn "a list of contacts with x, y and z" into a saved report
you can export: ask it to *make a report*, *export a list*, or *give me a
spreadsheet / CSV* of what you need. (A plain "list the open cases for Mike"
is answered in the chat as usual — up to 50 rows — and Casey may offer to make
it an exportable report.)

- **What the card shows.** The report's title, category and description, the
  tables it reads, its columns and any filters you can change when you run it,
  how many rows it returns right now, the first rows, any caveats, and the
  query itself behind **Show the SQL**. The rows come from actually running the
  report, so what you see is what you will get.
- **Chart or table.** The **Display** line says how the report opens in
  Reports: a table, or one of the Reports charts (bar, line, area, pie, donut,
  combo, or figures) — ask for one ("…as a bar chart by month") or Casey picks
  a chart when the result is plainly a breakdown or a trend. The chart is only
  the starting view: Reports' chart switcher changes it, and the table and CSV
  are the same either way. Casey always saves a shared report (Reports has no
  private reports; use the lock to stop others editing it).
- **What Save does.** **Review & save report** saves ONE new report in
  More → Reports. It changes no client record and sends nothing. Reports are
  firm-wide: everyone can see and run it, and edit it unless someone locks it.
  The report is labelled as AI-written in Reports.
- **Exporting.** After saving, the card's button opens the report in Reports;
  it runs immediately, and **CSV** there downloads the rows. The file contains
  client personal information — treat it as confidential client data.
- **Social Security numbers.** Unless you ask for SSNs, a report shows only
  the last four digits. Ask for the numbers themselves ("…with their SSNs") and
  the report shows them in full — the card and the confirmation then warn that
  anyone at the firm can run it and export them. Dates of birth can be
  included. The card's own preview hides SSN and date-of-birth values either
  way (they are kept out of the chat history); the saved report shows them.
- **When you click.** The save goes through the same Reports save a person
  uses, which checks the query again. If the server refuses it, the card says
  nothing was saved; ask Casey to prepare it again.

Casey saves a plain report, not a work-list *view* with clickable rows, and
does not yet change, run, lock or delete existing reports. The off switch is
the `casey_report_authoring_enabled` setting.

### Email and phone ingest rules

Casey can write the rules that act on incoming mail, calls and texts (More →
Automations → Email / Phone; how rules work is in the YisraFlow ingest
chapter). Ask naturally — "make an email rule that starts the deadline workflow
for 341 notices from the court", "turn off the phone rule for 202", "add a
task to rule 12", "undo yesterday's change to the court rule". Casey reads the
rule first (and the records an action points at), then prepares ONE card for
ONE change:

- **Create a rule.** The new rule is created **inactive**: it matches nothing
  and fires nothing until someone activates it, so you can preview it against
  real messages first. The card shows the conditions, the transform, every
  action in plain words, and where the rule would sit in the evaluation order.
- **Edit a rule** — its name, description, position, conditions, or
  transform — and **add, edit, or remove one action**.
- **Activate or deactivate a rule.** Activation is styled as a warning and
  lists every action that will start firing on live traffic.

When the rule is **active**, the card says so in plain words: the change
applies to the very next matching email, call or text — there is no draft and
no publish step. The card shows each changed value before and after. Every
change is recorded in the rule's change history, so Casey can tell you what
changed, when and by whom, and can prepare the reverse edit to undo it.

If anyone changes the rule after Casey read it, the card refuses — Casey
checks when it prepares the card, the page checks again when you click, and
the server checks a third time — and nothing is written; ask Casey to prepare
it again.

Actions start an existing workflow, enroll the contact in an existing sequence
(the card names where the contact id comes from), pass the message to an
existing hook, or run one of the functions Casey may author — including
sending an email or text **from one of the firm's own mailboxes or lines**
(never from an address taken out of the incoming message; the card says who
receives it), and **forwarding** every matching message by email or text to an
address or number you name. A forward's card says "forwards every matching
message to …", marks a destination outside the firm in capitals, and is styled
as a warning; Casey never forwards to an address taken from the message, and
refuses a destination that has opted out. Forwards need the rule's transform to
stay "passthrough" (the whole message). Casey does not write new regular expressions (they run on every
message), a rule that matches every message, or actions that send the message
to an outside web address; it tells you to add those by hand. A rule whose
conditions or transform are code can be written by Casey too, and the card
shows the code — but only an administrator, IT or SU user can apply it (the
server refuses it for everyone else). The off switch is the
`casey_ingest_authoring_enabled` setting.

## Models and files

The model selector offers two product-level choices:

- **Better quality** uses Claude Opus.
- **Faster speed** uses Claude Sonnet.

The selected mode applies to both planning and answering and is remembered with
the chat. Provider model identifiers are controlled by the server rather than
accepted from the browser.

The firm has a monthly Ask Casey spending limit
(`assistant_ai_monthly_cap_cents`, set from the SU db console; unset means
$200). When the month's Casey model spend reaches it, new questions are refused
until the next month or until the limit is raised.

**Attach file** adds up to four temporary PDF or image files to the next
question. All attachments together must be 6 MB or less. Temporary files are
sent for that question but are not silently registered as firm documents and
their bytes are not stored in chat history. The message history retains only
the filenames and sizes.

**YisraCase document** searches the existing Documents registry and attaches a
PDF or image by its stable document id. Casey reloads the file through the
normal document source and refuses to continue if the document changed between
planning and answering.

A temporary attachment has a separate **Save to case** control. Choosing it,
then choosing a case, is the explicit filing action: the browser uploads the
original file through the established Dropbox upload flow and YisraCase
registers and links the resulting document to that case. Merely attaching or
asking about a file does not save it.

## What read-only means

Assistant searches and action proposals cannot change anything by themselves.
Casey cannot edit scalar contact identity fields or fill a form on its own. It
can return the typed Task, Event, Appointment, contact-subrecord, send, or
automation proposal described above; the signed-in
staff member must review and confirm the card before the ordinary application
route performs it. The separate,
user-invoked **Save to case** attachment control is another explicit write; it
uses the existing Documents upload API rather than a model-authored action.
Searches run through the same SELECT-only database connection and validation used by Reports, with
tighter limits for conversational use.

Casey's searches refuse to name passwords, credentials, bearer tokens,
SSNs/EINs, dates of birth, raw custom-field JSON, email attachments, or
delivery metadata. These are checks on the query text made by the application
(Casey's own list plus the Reports validator), not database permissions: the
read-only database account behind Reports and Casey can read the whole schema,
so the checks are the boundary.
Phone-call and voicemail searches go through the existing archive permission
checks, so a person cannot discover a call they are not allowed to open.

Current weather is fetched through the fixed Open-Meteo adapter; the model
cannot choose an arbitrary network address. Other time-sensitive outside facts
such as breaking news do not yet have a live source, though the assistant can
answer stable general-knowledge questions directly.

The server—not a confirmation button—is the security boundary. It validates the
signed plan again at execution, limits every result, rejects expensive plans,
times out work, and records SQL runs and model cost. A collation mismatch, an
over-expensive query, or a query shape unsupported by the deployed MySQL
version gets one automatic planner repair; the replacement must pass the same
validation and execution limits. The repair remains inside the same bounded
investigation and keeps the original signed staff and workspace context.

## Conversation and follow-ups

In YisraCase, chats are private to the signed-in user: **Recent chats** keeps
the 30 most recently used conversations and lets only their owner reopen or
delete them. They are ordinary database rows, so developer read-only database
keys can also read them. One chat holds up to 200 messages; start a new chat
after that. The
latest eight user and assistant messages are included as context for a
follow-up. Older visible messages are history, not model context, so Casey
suggests starting a fresh chat after the fourth question. For best results,
keep one chat about one person, matter, or task.

Query result text is untrusted data. The investigation controller (and the
one automatic query repair) see it, so a row's text can influence which further
READ Casey makes — always through the same read-only validator and budgets,
never a write. The controller may use it only to identify one fact still
needed for the original question.
Instructions found in a database row, call, manual page, or attachment cannot
authorize or redirect that pass. Short user follow-ups such as “what day of the
week is it?” resolve against the date or record most recently discussed when
that reference is unambiguous.

Attached file content is also untrusted data. Instructions printed in a PDF or
image cannot authorize another query, save the file, or perform an action.

When it is relevant, an answer can offer **Open Court Review**. This is a safe
semantic destination, not model-supplied browser code: YisraCase checks the
signed-in user's launcher access, opens Automations through the normal launcher,
loads the tool if it is cold, selects Court Review, and waits for the child page
to report ready.

## Links that prefill a question

An internal link can open Casey over an existing workspace with a draft
question in the composer:

`/?open=tabCases&ask=Which+341+meetings+are+coming+up%3F`

The question is filled in but **never run automatically**. The `ask` parameter
is removed from the address bar as soon as the shell captures it.

The original link can nevertheless remain in browser history, messaging or
email systems, server/proxy request logs, screenshots, and any place where the
link was pasted. Avoid names, contact details, medical or financial information,
or other sensitive client facts in a shared Ask Casey link. Anyone creating or
sharing such a link is responsible for deciding whether its question is safe to
put in a URL.

## Reviewed action kinds and future actions

The plan format names every operation by type. Enabled executable operations
remain read-only: `sql.read`, `manual.search`, `comms.search`, the narrowly
scoped `weather.lookup` external read, and the typed automation reads —
`automation.list`, `automation.definition`, `automation.run`, and
`automation.references` — which let Casey explain a workflow or sequence, one
of its runs or enrollments, and what can start or enroll it. Those projections redact webhook URLs to method + host + credential
label and omit resolved payloads; code-step bodies are readable so Casey can
explain them.

The same four reads cover the **email and phone ingest rules** (More →
Automations → Email Ingest / Phone Ingest): Casey can list the rules and the
log-suppression rules, read one rule with its actions and what each starts,
find a message by sender, subject or phone number within a date range, and
explain what happened to it — which rules matched, what each action did, and
the layer where it stopped (a duplicate never reaches the rules; a suppressed
message still fires them). A separate read, `automation.preview_ingest_rule`, is
a dry run: it tests an EXISTING rule against a recorded message or a sample and
reports whether it matches, why not (including a rule whose code throws, which
the executions table never records), what its transform produces, and what each
action would do — without starting anything, writing anything, or counting a
match. Casey can also change ingest rules through reviewed cards (see *Email
and phone ingest rules*). The answer may additionally contain one
server-validated `task.create.v1`, `task.update.v1`, `task.complete.v1`,
`task.cancel.v1`, `task.reopen.v1`, or `task.transfer.v1` proposal. The proposal
may instead be one `event.create.v1`, `event.update.v1`, `event.complete.v1`,
or `event.cancel.v1` proposal. It may instead be one `appt.create.v1`,
`appt.update.v1`, `appt.attended.v1`, `appt.no_show.v1`, `appt.cancel.v1`,
`appt.reschedule.v1`, or `appt.reschedule_later.v1` proposal. It may instead be
one `contact.phone.*.v1`, `contact.email.*.v1`, or `contact.address.*.v1`
create/update/end proposal described above. It may instead be one
`sms.send.v1` or `email.send.v1` proposal: one text or one email sent now to
one contact row, with the fully resolved message on the card (see *Sending a
text or email*). It may instead be one
`job.code_safe.create.v1` proposal: a one-time scheduled job whose JavaScript
body runs in safe mode (the isolated QuickJS engine — no network, no database,
no email/SMS; see the workflows chapter's `custom_code` section). It may
instead be one `workflow.draft.v1` proposal: a complete but NEVER-PUBLISHED
workflow (version 0 — nothing can start it until a human publishes it in the
editor), with steps limited to the authoring allowlist (control flow, record
lookups, task/event/log creation, and text/email sends) plus safe-mode code;
webhooks, MMS and e-signature sends, and database writes are not authorable
and Casey says which steps to add by hand. A text or email step shows its
sender and says who it messages once a human publishes the workflow; the card
is styled as a warning. The sender is one of the firm's own lines or mailboxes,
or a firm sender setting that an earlier step of the workflow reads (for
example `{{settings.email_automations}}` after a step that reads the firm
settings — Casey can add that settings step itself; it never reads a secret
setting);
Casey never adds email attachments. The same applies when Casey inserts or
edits a step in an existing workflow, and the publish card names every send
step and its recipient.
It may instead be one `workflow.start.v1` proposal: starting ONE run of an
active workflow's published version now, with no input — no contact and no
variables; the card lists the placeholders that will therefore be blank.
Casey never runs a draft (testing a draft is the editor's Run button) and
never starts a version that contains a standard-mode code step. The card
shows what the run can send, call, write and start, what normally starts the
workflow, and how many runs are already in flight, and it is styled as a
warning: a start cannot be undone — cancelling the run later stops only the
steps it has not reached. If the workflow is deactivated or a new version is
published before you confirm, nothing starts. If the outcome cannot be
confirmed, the card says so and offers no second start; check the workflow's
executions. Once applied, the card opens the new run. The off switch is the
`casey_workflow_start_enabled` setting.
It may instead be one `ingest_rule.create.v1`, `ingest_rule.update.v1`,
`ingest_rule.set_active.v1`, `ingest_rule.action_add.v1`,
`ingest_rule.action_update.v1`, or `ingest_rule.action_remove.v1` proposal for
an email or phone ingest rule (see *Email and phone ingest rules*): a new rule
is created inactive, and every edit carries the rule's last-edited stamp so a
rule changed in the meantime is refused.
It may instead be one `report.draft.v1` proposal: one new report definition,
previewed on the card and saved to Reports only when you confirm (see *Making
a report or an exportable list*); it is the one proposal whose content is a
query, checked by the same report validator and run on the same read-only
report connection as Casey's own lookups.
It may instead be one `hook.create.v1` proposal: an inbound hook created
INACTIVE with one internal target pointing at an existing workflow or sequence
template. Nothing fires through it until a human activates it in the Hooks
editor, where the endpoint URL and authentication live — the card never shows
a slug, key, or URL. Creating hooks requires the automations.manage
capability, so this card applies only for admin, IT, or SU users. It may
instead be one `sequence.step_insert.v1` proposal: ONE text, email, or task
step inserted into an existing sequence template's DRAFT. The step type fixes
what runs (a text step sends an SMS, an email step sends an email, a task step
creates a task); the sender is one of the firm's own lines or mailboxes, or
the enrolling user's own default phone or email (`{{users.default_phone}}` /
`{{users.default_email}}`, shown on the card with a line explaining that it is
filled in per enrollment);
every message value and the timing are shown in plain language, including when
an appointment-based step would be skipped because its time has already
passed. Nothing runs until someone publishes the template in the sequence
editor. Enrollments already running stay on their version; a text or email
step then messages clients from the first new enrollment after the publish.
Conditions, fire guards, and other step types are added by hand. It may
instead be one `sequence.publish.v1` proposal: publishing a sequence
template's draft. The card is the review — what changed (with the rule that
only a change to the message or task details of an unchanged text, email
or task step counts as content-only; everything else, including timing and the template's own
condition, is structural), the enrollments currently running (they stay on
their version and finish there; only enrollments that start after the publish
use the new one), what can enroll contacts in it, every text or email step and
whom it messages, and the fact that there is no rollback. If anyone edits the
draft — a step or the template condition — after the card was prepared, the
publish is refused and nothing changes. The off switch for both sequence cards
is the `casey_sequence_authoring_enabled` setting. The card
shows the full code for review, the browser pins the safe engine in the
request, and the system off switch is the `casey_code_actions_enabled`
setting. The proposal
itself changes no record. A signed-in user can perform that exact action only
through the card's explicit review and confirmation, which invokes the ordinary
authenticated route for that record family.

Future action types can use a visible plan, signed approval and execution
record, but they must be introduced separately. Read-only auto-run does not
carry over to writes. Composing an email and sending
it are different operations: a draft may be safe to generate automatically,
while sending requires a fresh approval showing the exact recipient, subject
and body. Filling a record or form needs a field-level before/after preview.
Creating a workflow needs validation and a draft version before anything can be
published. No action becomes available merely because the model names it.
