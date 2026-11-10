# Ask Casey

Ask Casey is the user-facing name for the firm's YisrAI assistant. Its searches
are read-only; its reviewed actions (each family is described below) are
performed by the signed-in user after explicit review. It can answer
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
the phone-call archive, your email (the mailboxes you can read in Comms), the
YisraCase manual, or current weather. Generated SQL
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
whose number opted out of texts cannot get a text confirmation: the card is
refused, because confirmations are automatic messages. To text an opted-out
client anyway, ask for a separate text card (see *Sending a text or email*),
which lets you confirm past the opt-out. An email opt-out ("No marketing
email") covers marketing only and never stops an email confirmation.

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
contact's scalar identity fields, and it cannot combine several rows in one
proposal (relationships, roles and contact notes are their own cards, below).

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

### Relationships and roles

Casey can add ONE relationship between two contacts ("record Sam as Dana's
son", "Acme is Dana's employer"), or give a contact ONE role ("make Jane Smith
a chapter 13 trustee"), through the same routes as the contact page's
**Relationships** tab and the contact form's **Roles** section. It can also
edit a relationship's status, start date, notes or type (and, once it has
ended, its end date and end reason), or replace an active role's details (for
a trustee: chapters and 341 Zoom link; for a judge: the docket suffix). And it
can do what those pages' end, remove and reactivate controls do — see
*Ending, reactivating and deleting* below.

Casey first reads the contact's relationships and roles together with the
firm's lists of relationship types and roles — it never invents a type: an
unknown or retired one is refused and the refusal names the ones that exist.
For a new relationship it also reads the other contact. The card names both
contacts and shows, in plain words, how each contact's page will read — "On
Dana Client's record: Parent of Sam Client" and "On Sam Client's record: Child
of Dana Client" — so the direction of a one-way type is never ambiguous.

- **No duplicates.** Two contacts can have each type of relationship once. A
  pair that already has that type, in either direction and even if the
  existing one is inactive, is refused — including the reverse of a one-way
  type (Dana cannot be both Sam's parent and Sam's child); a type change onto
  such a type is refused the same way. A contact that already holds a role, or
  holds an inactive row for it, is refused too (reactivate the old row
  instead).
- **Role details are checked as the Roles section checks them**: a trustee
  needs at least one chapter, a judge needs the docket suffix. A role card
  says what reads the role: trustees appear on the trustee roster that case
  trustee matching and the case-details list use; a judge's suffix resolves
  cases' judges from their docket numbers — and a suffix another active judge
  already carries is flagged in warning style, because resolution for it then
  falls back to the judge's name. A role update replaces the whole set of
  details; anything the new set leaves out is listed as removed.
- **A type change** keeps the direction (the first contact stays first) and
  shows how both records will read afterwards; a status or end reason the new
  type does not allow must be changed in the same card.
- **Not available to Casey**: changing either contact of a relationship, and
  managing the lists of types and roles. Do these on the contact page or in
  YisraCase Config.
- **Freshness.** When you confirm, the card re-reads the contact's
  relationships or roles first. If the pair became related, the relationship
  was edited, ended or reactivated, or the role was added, edited, deactivated
  or reactivated since the card was prepared, nothing is written. If the route refuses (for example a
  duplicate added a moment earlier), the card says nothing was written.
- Once applied, the card opens the contact. Other open pages show the change
  after a reload — exactly as for an edit made on the contact page itself.

#### Ending, reactivating and deleting

- **End a relationship** ("Dana and Sam divorced — end their spouse
  relationship"): the relationship becomes inactive with an end date (today
  unless you name one; never in the future or before its start date) and an
  end reason from that type's list. It stays on the Relationships tab's
  **All** view as history. An already-ended relationship is refused.
- **Reactivate a relationship**: an ended one becomes active again and its end
  date and end reason are cleared (the card shows the old values). Refused
  when the type has been retired, or when the two contacts already have
  another active relationship of that type.
- **Delete a relationship**: the row is gone for good, with no undo — the card
  says so in warning style and, for an active one, points out that ending it
  keeps the history. Use it for a relationship added in error.
- **Deactivate a role** (the Roles section's ×): the role is kept in history
  and can be reactivated. **Reactivate a role** brings an inactive row back
  with its old details (refused for a retired role; details that no longer
  pass the role's rules are flagged). **Delete a role** works only on an
  inactive row, exactly as the Roles section offers Delete only there.
- **What else changes is spelled out.** A relationship is read only by the
  two contacts' Relationships tabs — the card says so, and also scans saved
  reports, form templates, portal cards, pipeline steps, workflow and sequence
  steps and ingest actions for any that name the table. For a **judge** or
  **trustee** role, the card counts the cases whose judge or trustee link
  would resolve to a different contact once the role is deactivated or
  reactivated — by running the same matching the case page runs — names them,
  and counts the cases that link to this contact today. Nothing changes on
  those cases until their judge, docket number or trustee is next saved; then
  the link follows the new roster. Deactivating or deleting a role, and
  deleting a relationship, are always warning-styled.
- If the route answers that the row no longer exists (someone deleted it a
  moment earlier), the card says nothing was written.

The off switch for these cards is the `casey_contact_relations_enabled`
setting (on unless set to 0).

### Case notes, case alerts and contact notes

Casey can edit three text fields, one per card: a case's **notes**, a case's
**alerts** (the banner at the top of the case), and a contact's **notes**.
Ask it to add a line ("add a note to the case that the client is sending pay
stubs Friday") or to rewrite, replace or clear the field. A case's other
fields go on the case fields card below; nothing else on a contact (names,
dates of birth, tags) is available to Casey — edit those on the contact page. A
case's pipeline stage moves only through the pipeline cards below, and a blank
case number is filled only through the case number card below.

- **Adding keeps what is there.** An added line goes at the end, on its own
  line; the existing text is kept exactly as it is. A rewrite replaces the
  whole field with the new text, and a clear empties it — the card says
  "Clears" in so many words.
- **The card shows the change, not the whole note.** Notes can run to 10,000
  characters, so the card shows the size before and after ("1,204 characters
  → 1,251 characters"), what is removed and what is added, with a little
  unchanged text either side. A card that removes or changes existing text is
  shown in warning style; a card that only adds is not.
- **Contact notes belong to the contact, not a case.** The card names the
  contact and says the same text shows wherever that contact appears, with how
  many cases they are on.
- **Limits.** Notes are capped at 10,000 characters and alerts at 5,000,
  counting the whole field after the change; Casey refuses a longer result
  rather than let it be cut.
- **Freshness.** When you confirm, the card re-reads the field. If anyone
  changed it since the card was prepared, nothing is written — ask Casey to
  prepare it again.
- Once applied, the card opens the case or contact. Other open case and
  contact pages showing the field update on their own, as they do for an edit
  made on the page.

The off switch for these cards is the `casey_record_edits_enabled` setting (on
unless set to 0).

### Any other case field

Casey can change **any other field of one case** — up to 10 per card — just
as you can on the case page: its dates (open, file, close, discharge, 341
initial, objection, docs due …), judge, trustee, chapter, caption, our role,
source, the checkboxes (garnishment, fee agreements, credit counseling,
matrix, schedules, filing fee, docs), the bankruptcy (bk) and 341 fields, and
its custom fields. Ask in plain words ("set the file date on the Smith case to
March 2", "change her trustee to Jane Trustee", "clear the show cause date").
It saves through the same route the Case Details forms use.

- **The case number** is on this card too: Casey can change or clear the case
  number or full case number, as you can in Case Details. It refuses a number
  another case already has (and checks again when you confirm), and the card
  warns what moves with the number — the events and log entries filed under
  the old number that leave the case and those under the new one that join
  it, which court mail is filed here, the header, Cases list, client portal and
  Documents label before and after, and the judge link a new full case number
  re-resolves.
- **Not on this card — each has its own card, or is not available:** the stage,
  status and next step (the pipeline cards); the Dropbox folder (the case folder card); notes and alerts (their
  own cards above); the judge and trustee contact links (set from the judge
  and trustee names — change the name); the 341 meeting date (it follows the
  341 appointment — reschedule the appointment); and the case's id. Casey says
  so and names the right card.
- **Case type and subtype are editable, as on the case page.** Changing the
  type clears the subtype (as the case page does) unless the card sets one;
  a type or subtype not on the firm's list is allowed with a warning (the
  create forms allow a free-typed one too); and the card says which pipeline
  the case will resolve to afterwards — when that changes it warns that the
  case's current stage may not exist there (the Pipeline widget and board
  then show it off the pipeline) and that, unlike "Move to another
  pipeline…", nothing is logged and no step is checked. To put the case on a
  named stage of the other pipeline as well, ask for the pipeline transfer
  card instead (below).
- **Values are checked against the field.** A date is a calendar date; the
  show cause date and time is in firm time; a choice field takes one of its
  own options; a checkbox field takes any of its own options; text must fit
  the field — Casey refuses a value too long for the field rather than let it
  be cut short, and refuses a line break where the field holds one line.
- **The card** shows each field before and after, and says **Clears** for a
  field it empties (in warning style when something stored is removed). For
  each field it lists who reads it: the client portal (the chapter is in the
  case's title there, the 341 link is on the client's 341 meeting card, and
  the open date orders the client's list of cases — "the client sees this");
  the case header and Cases list; court email; and every saved report, form,
  portal card, pipeline step, sequence or workflow step and ingest action that
  names the field. A new judge or trustee name re-links the case's judge or
  trustee contact — the card shows the link before and after, and a name that
  matches nobody leaves the link empty (a warning when there was one).
  Changing the trustee here does **not** update the 341 meeting link the way
  the Case Details form does — the card warns, and you can ask for the link
  too.
- **Automation.** A change is a "case updated" event, as an edit on the page
  is. The card checks every active rule on it and lists each that would run,
  and any whose test could not run — that one **may** run.
- **Freshness.** When you confirm, the card re-reads the case. If any of the
  fields, or the case's type or subtype, changed since the card was prepared,
  nothing is written; ask Casey to prepare it again.
- Once applied, the card opens the case. Open case pages refresh on their own.

The off switch for this card is the same `casey_record_edits_enabled` setting
as the notes and alerts cards (on unless set to 0).

### A case's contacts

Casey can add one contact to a case, change one contact's role on a case
(**Primary**, **Secondary**, **Other** or **Bystander**), or remove one contact
from a case — one change per card, through the same Contacts routes the case
page uses. Ask it in plain words ("add Sam to the Debtor case as Secondary",
"make the witness a Bystander", "take the old employer off this case").

- **The card names both records** — the case and the contact — with the old
  and new role, and lists the case's contacts as they will be afterwards.
- **It says what the role changes.** A new **Primary** becomes the client the
  case header, the case's name in lists, and the e-sign and form Primary slots
  read. **Primary** and **Secondary** can see the case in the client portal;
  **Other** counts in the case's automation lists, communications and document
  filing but not the portal; **Bystander** counts in none of them. Adding a
  contact fires the "contact linked" trigger event and removing one fires
  "contact unlinked"; changing a role fires no event.
- **Warning style** marks a card that removes a contact, gives a contact with
  portal access sight of the case, takes the case out of a contact's portal
  (once the portal is live, they no longer see it there), or would leave the
  case with two Primary contacts.
- **What Casey will not do, and says so:**
  - move a contact who has **used** the client portal from Primary or
    Secondary to Other or Bystander, or remove them while Primary or Secondary
    — that would hide the case from their portal. "Used" means any visit or
    login, and also a request for a login PIN. If the change is intended, make
    it on the case page. Any other contact may be moved or removed; the card
    warns that once the portal is live they lose sight of the case there;
  - leave a case without its Primary. To swap Primaries, have Casey make the
    new contact Primary first (the card warns that the case briefly has two),
    then change the old one;
  - remove a case's last contact;
  - add a contact who is already on the case (ask for a role change instead),
    or change a contact who holds two roles on the same case — fix that on the
    case page.
- **Freshness.** When you confirm, the card re-reads the case's contacts and
  the contact's portal access and use. If any of them changed since the card
  was prepared — including the contact using the portal in the meantime —
  nothing is written; ask Casey to prepare it again.
- Once applied, the card opens the case. Other open pages showing the case
  refresh its contacts on their own; an open contact page shows the change
  after a reload, as it does for a change made on the case page.

The off switch for these cards is the `casey_case_contacts_enabled` setting
(on unless set to 0).

### A case's pipeline stage

Casey can advance a case to its **next stage**, or move it to **one named
stage** of its own pipeline — an off-ramp such as Dead lead or Dismissed, a
skip ahead, or a step back — one change per card, through the same Advance the
case page's pipeline widget and the pipeline board use. For an intake lead it
can also **retain** the case: enter it into its chapter pipeline at that
pipeline's first stage. Ask in plain words ("advance the Smith case", "mark
this lead dead", "move the case back to Docs requested").

- **The card names both stages** — where the case is and where it goes — and
  the pipeline. It lists the case fields the advance overwrites (stage,
  status and **next step**: a hand-written next step is replaced by the new
  stage's default), whether the client's portal timeline shows the new stage,
  and the note, if any, that goes on the stage log.
- **Requirements.** The card lists every step the move passes over: required
  steps that are done or marked N/A, and **optional** steps left unfinished
  (they will read "skipped"). It also lists the steps waiting at the new stage.
  A move to an **off-ramp** (Dead lead, Dismissed) is an exit, not progress,
  so open required steps do not stop it: the card names each one in a
  warning — they read "skipped" while the case sits on the off-ramp. Bringing
  a case **back** from an off-ramp names, in a warning, every required step it
  passes that is still "skipped" — they stay skipped unless the case goes to a
  stage at or before theirs.
- **Automation.** The card dry-runs the stage change against every active
  trigger rule and lists each rule that would run, with what it does (start a
  workflow, enrol a sequence, call a function, run a hook), each that would
  fail, and any whose test could not run — that one **may** run. What those
  actions cause in turn is not followed.
- **Warning style** marks a card that retains the case (intake → case: the
  case leaves the Intake pipeline and is treated as retained everywhere from
  then on), puts it on an off-ramp, brings it back from one, moves it
  backward, or has a rule whose test could not run.
- **What Casey will not do, and says so:**
  - move a case past a **required step that is not done or N/A** (except onto
    an off-ramp, above). The answer
    names every such step, word for word. A stage card **never overrides a
    requirement** — mark the step done or N/A first, on the case's Steps
    panel or with Casey's own card for it (below), then ask again. (The case
    page's own Advance does not check requirements; Casey does.)
  - move a case onto **another pipeline** on these cards — that is the
    pipeline transfer card, below;
  - enter a chapter pipeline at any stage but its first, or enter one the
    case's subtype does not name exactly (set the subtype first);
  - advance a case sitting on an off-ramp (name the stage instead), or past
    its pipeline's last stage;
  - move a retained case along the Intake pipeline (this happens when no
    chapter pipeline matches its type and subtype — fix those on the case
    page).
- **Freshness.** When you confirm, the card re-reads the case's pipeline, its
  steps, and its phase, type and subtype. If any of them changed since the
  card was prepared — including a step that is now unmet, or, on an off-ramp
  card, a listed step finished since — nothing is written; ask Casey to
  prepare it again. If someone moved the case to the
  same stage first, nothing is written and no automation runs twice.
- Once applied, the card opens the case. Open case pages and the pipeline
  board refresh on their own.

The off switch for these cards is the `casey_case_pipeline_enabled` setting
(on unless set to 0).

Casey can also **show** a case's pipeline without proposing anything — ask
"where is the Smith case in its pipeline?" or "what is left before it can be
filed?". It reads the same pipeline the case page's Pipeline widget and Steps
panel show: the pipeline the case is on, its current stage and when it got
there, every stage (off-ramps included), and each step with its status —
done, N/A (with the note left when it was marked), skipped, waiting at the
current stage, or upcoming. It names the required steps that would stop a
move, and for an intake lead it can show the chapter pipeline the case's
subtype points to. A retained case shown on the Intake pipeline, or a case no
pipeline fits, is said plainly. This read is always on; it changes nothing.

#### Moving a case to another pipeline

Casey can move a case onto **another pipeline** at one stage — the case page's
"Move to another pipeline…" — one case per card: "move the Smith case to
Chapter 13 at Filed", "put this lead back on Intake". Name the pipeline, and
the stage if you want a particular one; with no stage the card uses the case
page's own default (the stage the case is on now, when the new pipeline has
it; otherwise the new pipeline's first stage). A case staying on its own
pipeline uses the stage cards above; a type or subtype change with no stage
goes on the case fields card.

- **Two writes.** As on the case page, the case's type and subtype are set to
  the new pipeline's own (an Intake destination changes neither and keeps the
  subtype), then the case is moved to the stage. The card shows the type and
  subtype before → after and who reads them (the client portal's case title
  among them), the stage, status and next step it overwrites, the phase when it
  changes (a lead retained, or a retained case back to intake — both in warning
  style), and the stage-log note (the route's own "Moved to …" when you give
  none). The two writes are **not one transaction**: if the stage move fails
  after the type and subtype were written (someone else moving the case at the
  same moment), the case is left on the new pipeline at its old stage, and the
  card says **Failed — partly written** rather than applied. Ask Casey to read
  the case's pipeline and finish the move.
- **Steps.** The card lists every **required** step on the new pipeline's
  stages before the destination that is not done or N/A, word for word, in a
  warning — they read "skipped" once the case is there. The case page's move
  allows this, so Casey does too, but it never marks a step done or N/A. It
  also lists the required steps left open on the pipeline the case leaves.
- **Automation.** Both events are dry-run: the type / subtype change
  (case.updated) and the stage change (case.stage_advanced), each rule that
  would run listed with what it does.
- **What Casey refuses, and says so:** the pipeline the case is already on
  (use the stage cards), an inactive or unknown pipeline or stage, and a move
  the case would not stay on — when, after the move, the case's type and
  subtype would still pick a different pipeline (for example, a duplicate
  pipeline for the same chapter, or one with no case type), which would leave
  the case shown off its pipeline's stages.
- **Freshness.** When you confirm, the card re-reads the case, its pipeline
  and position, the new pipeline and its stages, and the list of active
  pipelines; if any changed, nothing is written. Whether a step on the new
  pipeline has been finished since is not re-read.
- The card is always warning-styled; there is no undo (moving it back is
  another transfer). Open case pages and the pipeline board refresh on their
  own. It shares the `casey_case_pipeline_enabled` off switch.

#### Marking a step N/A or done

Casey can mark **one step** of a case's pipeline **N/A** or **done**, or
**clear** a step's override so it goes back to what YisraCase works out — the
Steps panel's own n/a / done / clear buttons, one step per card: "mark the
retainer step N/A on the Smith case — she paid in cash at the consult",
"clear the override on the W-2 step". Name the step as the Steps panel shows
it (or ask Casey to show the case's pipeline first). The intake steps of a
retained case can be marked too, as on the panel.

- **A reason is required** when marking a step (the panel's note is optional;
  Casey's is not): it is the only record of why the step was marked, and the
  case log quotes it. One line, up to 255 characters. If you have not said
  why, Casey asks.
- **What the system sees.** The card shows the step's own status — what its
  detector finds (or that it is a manual step only an override can complete),
  with its detail, progress or hint — beside what the override declares. For
  a clear, it shows the status the step goes back to. Marking a **required**
  step done or N/A that the system does not see done, or clearing an override
  so a required step is open again, is shown in warning style.
- **What it unblocks.** Casey's stage cards refuse a move past an open
  required step. The card names every move the override unblocks (or, for a
  clear, blocks again), and any move still blocked by other steps. The case
  page's own Advance does not check steps, so there the override only changes
  what the Steps panel shows.
- **The client portal.** If the step is client-visible and on the case's
  current or next stages, the card says how the client's Next steps card
  changes (an N/A step disappears from it; a done step shows as done).
- **The case log** gets one line, by you — "Requirement fee: marked N/A
  (override) - <your reason>" or "Requirement fee: override cleared" — and the
  override records you as the one who set it. An override that already exists
  is named with who set it, when, and its note; a new one replaces it. To
  change only the reason, ask for the same status with the new reason: the
  card says the status is unchanged and shows the old note → the new one.
- **What Casey refuses, and says so:** a status other than N/A or done; a step
  that already reads that way (done by its detector, or already overridden the
  same way with the same reason); a clear
  when the step has no override; an unknown step, or a name two steps share
  (use its key). An override is never part of a stage card — it is always its
  own card, which you ask for.
- **Freshness.** When you confirm, the card re-reads the case's steps and
  their overrides, its pipeline and position, and its phase, type and
  subtype; if anything changed, nothing is written. If someone cleared the
  override first, the clear says so and writes nothing.
- Open case pages reload their pipeline on their own. No automation runs. It
  shares the `casey_case_pipeline_enabled` off switch.

### A case's number (docket)

Casey can **add a case number to a case that has none** — the case number,
the full case number (the one with the judge's letters), or both — one case
per card, through the same route the court review queue uses to adopt a
docket. Ask in plain words ("add case number 25-12345 to the Smith case").
Casey copies the number exactly as you give it; it never reformats it or works
out one form from the other.

- **The card** shows both numbers before and after, and everything that reads
  them: the case page header; the Cases list; the client portal,
  for the case's Primary and Secondary contacts; the Documents tabs' case
  label; court email — court mail carrying the number is filed on this case
  from now on, and the first one that names the case can set its caption if it
  has none; letter, form and message templates; any events or log entries
  already filed under the number, which join the case at once (counted on the
  card); and, for a full case number, the judge link it re-resolves from the
  judge's letters (a change to an existing judge link is shown as a warning).
- **Automation.** Adding a number is a "case updated" event. The card checks
  every active rule on it and lists each that would run, and any whose test
  could not run — that one **may** run.
- **What Casey will not do, and says so:**
  - change or clear a number the case already has on this card — that goes on
    the case fields card above;
  - add a number another case already has, in either field (the card names
    that case; if they are the same matter, merge the cases on the case page);
  - save a number longer than 20 characters, or one with a line break;
  - change any other field of the case on this card (other fields go on the
    case fields card).
- **Freshness.** When you confirm, the card re-reads the case. If either
  number, the case type or (for a full case number) the judge changed since the
  card was prepared, nothing is written; ask Casey to prepare it again. If
  another case took the number in the meantime, the server refuses it and
  nothing is written.
- Once applied, the card opens the case. Open case pages and the Cases list
  refresh on their own.

The off switch for this card is the `casey_case_docket_enabled` setting (on
unless set to 0).

### Checklists and notes

Casey can make **one checklist or note** on a case, on a contact, or as your
own personal list, **add one item** to an existing checklist, **rename, check
off or reopen one item**, **rename one list or note**, **mark one note done or
not done**, **replace one note's text**, **delete one list or note** (with its
items) or **delete one item** — one change per card, through the same routes
the Notes & Lists tab uses. Ask in plain words ("make a pre-filing checklist
on the Smith case with credit report and tax transcripts", "add 2024 W-2 to
that list", "check off the credit report", "rename that list to Pre-filing
2026", "delete the old intake list").

- **A new list** shows the record it goes on, its title, whether it is a
  checklist or a note, and its starting items (up to 25 — each starts
  unchecked; make the list, then add more). If the record already has a list
  with the same title, the card warns you: this makes a second one.
- **An item card** shows the list and its record, the item before and after,
  the items already on the list, and the list's status afterwards: checking
  off its last open item completes the list; adding an item to a completed
  list, or reopening one of its items, makes it incomplete again.
- **A list or note change** shows each field before and after: the title, the
  note's done / not done, or the note's text (the new text replaces the old
  text whole). A checklist's done state follows its items, so only a note's
  can be set.
- **A delete** always shows in warning style and says it **cannot be undone**:
  a list card shows how many items go with it (done and open) and names them;
  a note card shows the length of its text; an item card shows the item and
  offers checking it off instead. It also says when the list is the case's
  Docs Needed list, a system (tagged) list, a contact's list (it disappears
  from every case board that contact is on), or — for a superuser — another
  person's personal list (only its owner or a superuser can delete one).
- **Pipeline steps.** A case's tagged checklist can satisfy a pipeline step
  (for example "Documents received"). When a delete would change a step — the
  list disappears, or deleting its last open item completes it — the card
  names the step and its status before and after, in warning style.
- **Automation.** Checking off an item can start trigger rules (an item
  completed; a list completed); so can deleting a list's last open item (a
  list completed). The card dry-runs both against every active
  rule and lists each rule that would run, and any whose test could not run —
  that one **may** run. Making a list or adding an item starts no rule.
- **Visible to the client.** An item on a case's **Docs Needed** list is shown
  to the client — in the client portal and on the case's public documents
  link, which lists every unchecked item by name. The card says so in warning
  style whenever it adds, renames, checks off, reopens or deletes such an
  item, deletes that list, or renames a list whose title alone makes it the
  documents list.
- **What Casey will not do, and says so:**
  - make or rename a case list to **Docs Needed** — that title alone makes it
    the client's documents list, which only the documents automation creates
    (add items to the existing one instead);
  - set a list's **tag**, change a list between checklist and note, or move it
    to another record;
  - put items in a particular **order** — the Notes & Lists tab cannot reorder
    items either;
  - make a list for **another person**, or on a bill, appointment, task or
    event, or change another person's personal list (a superuser may delete
    one, with a warning);
  - add items to a **note**, give a checklist a body, or set a checklist's
    done state;
  - add an item whose name is already on the list (in any capitalisation), or
    make a change that changes nothing;
  - a title longer than the list can hold.
- **Freshness.** When you confirm, the card re-reads the record's lists (a new
  list) or the list, its text and every item on it (every other card). If
  anything changed since the card was prepared, nothing is written; ask Casey
  to prepare it again.
- Once applied, the card opens the case or contact (a personal list points
  you to More → Notes & Lists). After a new list, an added item or an item
  change, an open Notes & Lists tab for that record refreshes on its own —
  unless you are typing in it; then it refreshes when you click away. After a
  list or note change or a delete it does **not** (the tab's own edits of
  these do not announce themselves either): another open Notes & Lists tab
  shows the old list until you reopen it.

The off switch for these cards is the `casey_checklists_enabled` setting (on
unless set to 0).

### Documents: title, type, tags, links and public links

Casey can read the Documents registry (every file the Dropbox sync has seen,
and which case or contact each is linked to), and it can **change one
document's title, type or tags**, **link one document to one case or
contact**, **unlink one document from one case or contact**, or **share one
document** (its public link) — one change per card, through the same routes
the Documents page's Edit, Links and Copy public link buttons use. Ask in
plain words ("retitle the petition PDF on the Smith case to Chapter 7
petition (filed)", "tag it court, filed", "link this paystub to Dana's
contact", "unlink that scan from the Smith case", "get me a public link to the
signed retainer").

- **An edit card** shows the document (file name, path, size, source), each
  field before and after, and every case or contact it is linked to — the
  places the new title shows. Tags are saved the way the Documents page saves
  them (lowercase, spaces as hyphens, comma-separated); if that differs from
  what you asked, the card shows the saved form. A type no other document has
  yet is called out as new. Send an empty value to clear a field.
- **A link card** shows the document, the record it joins, the links it
  already has, the optional relation word, and **exactly where it will show**:
  that record's Documents tab, and — under **Include related**, which is on by
  default — the Documents tab of each contact on that case (a case link) or
  each case that contact is on (a contact link), badged "via" the record. A
  document's first case link also takes it off the Documents page's "no case"
  list. A link you make is kept even if the file is later moved in Dropbox.
- **An unlink card** shows the link that goes (and whether a person or the
  Dropbox sync made it), the links left, and **exactly which Documents tabs the
  document leaves** — that record's, and under Include related the tabs it
  showed on through that record — and which it still shows on through its other
  links. Unlinking its last link is allowed; the card warns that the document
  is then linked to nothing (it goes back on the "Unlinked" list when no case
  link is left). If the file still sits in that case's Dropbox folder, the card
  warns that **the sync puts the case link back** (on a later sweep, and
  whenever the file changes) — to keep it off the case, move the file out of the
  folder in Dropbox. The file itself is never touched. There is no undo button:
  link it again if you change your mind.
- **A share card** gets the document's **permanent public link** from Dropbox —
  the Copy public link button on the Documents page. It says plainly what that
  is: **anyone who has the link can open and download the file, with no login,
  and it does not expire**; it can only be turned off in Dropbox itself. If the
  document already has a link, nothing new is made. Casey never sees the link:
  after you confirm, the card shows it (in this window only — it is not saved in
  the chat) with a **Copy public link** button. Later, copy it from the
  Documents page. Casey does not send it to anyone.
- **Automation.** Editing a document can start rules on "document updated";
  linking one, rules on "document linked". The card checks every active rule
  and lists each that would run, and any whose test could not run — that one
  **may** run. Sharing and unlinking start no rules.
- **Staff only.** The client portal does not list registered documents.
- **What Casey will not do, and says so:**
  - delete, restore or mark a document missing — no screen does that either;
    the Dropbox sync sets it;
  - rename or move the file — Dropbox owns the file;
  - use the relation word **path** — that is the Dropbox sync's own mark;
  - link or share a document that is deleted or missing, link or unlink it to
    anything but a case or a contact, or add a link that already exists;
  - work on a document already linked to more than 20 records (it warns from
    5);
  - save a value longer than the field holds, or an edit that changes nothing;
  - upload or generate documents, or register a new file — do those on the
    Documents page.
- **Freshness.** When you confirm, the card re-reads the document (and, for a
  link, the record). If the document was edited, renamed by the sync, deleted,
  shared, or gained or lost a link since the card was prepared, nothing is
  written; ask Casey to prepare it again.
- Once applied, the card opens the case or contact (an edit to a document with
  no links points you to More → Documents; a share card's button copies the
  link). Open Documents pages and tabs showing the document refresh on their
  own.

The off switch for these cards is the `casey_documents_enabled` setting (on
unless set to 0).

### A case's Dropbox folder

Casey can **link one case to one Dropbox folder** — the same confirm the
Documents page's re-link panel uses (More → Documents → **Sync**; see
[Documents — Sync & Re-linking](06-documents.md)). Ask in plain words ("link
the Smith case to its Dropbox folder", "the Jones case points at the wrong
folder — fix it"). Casey reads the case and the panel's own **folder
suggestions** for it, and works only on a folder that list shows.

- **Only a suggested folder.** The suggestions are the panel's strict ones: a
  folder whose name holds the case's docket number, or **every** required word
  of a client's name (surname and first name). Surname-only matches — usually a
  different client — are never offered by Casey (the panel shows them behind a
  toggle and a second tick). A folder you type or describe is not proposable:
  no screen takes a typed path; ask IT. Casey works for any case — also one
  with no folder at all, which the panel's queue never lists.
- **The card** names the case and the folder (its path and how many registered
  files are under it), what the case points at now, and:
  - the case's **Dropbox link is rewritten** with the folder's permanent shared
    link (Dropbox's existing link for it, or a new one anyone holding it can
    open); the old link is kept only in the case's activity log;
  - how many files **attach to the case now** — and, separately, files that
    already belong to another case through the sync (they stay there) and files
    inside another case's folder nested in this one (they stay with that case);
  - how many of the sync's links to files **outside** the folder are
    **detached** — those files leave the case's Documents tab. Links a person
    made are never touched;
  - that a folder sitting **inside another case's folder** is flagged — right
    for joint debtors, wrong otherwise;
  - that from now on the case's client uploads (portal and the documents link,
    into "Client Uploads"), filed form PDFs, signed e-sign documents and
    automation steps using the case folder go to **this** folder;
  - that a case marked dismissed in the re-link queue has the dismissal
    cleared, and every trigger rule the case update would run (any rule that could
    not be checked **may** run).
- **There is no undo.** A wrong folder is fixed by re-linking the right one —
  that also detaches the wrong folder's files — or by unlinking documents one
  by one and clearing the case's Dropbox link by hand. The activity-log entry
  keeps the old path and link. The card is always styled as a warning.
- **What Casey will not do, and says so:**
  - take a folder another case already holds (two cases never share one);
  - re-link a case to the folder it already points at;
  - re-link several cases or folders at once — there is no bulk re-link;
  - dismiss or un-dismiss a case in the queue, undo a re-link, or unlink;
  - use a surname-only match or a folder that is not suggested.
- **Freshness.** When you confirm, the card re-reads the suggestions. If the
  case was re-linked or its link changed, the folder was claimed by another
  case, dropped out of the suggestions, or its file count changed since the
  card was prepared, nothing is written; ask Casey to prepare it again. If the
  document sync is switched off, nothing is written and the card says so.
- Once applied, the card says how many files were detached and attached (and
  any notes) and opens the case. Open case pages take the new link, and the
  case's Documents tab refreshes on its own; the case page's Dropbox panel
  shows the new folder once the case is reopened.

The off switch for these cards is the `casey_document_relink_enabled` setting
(on unless set to 0).

### Forms: drafts and submission links

Casey can **save one draft of a form** for a case or contact, or **link one
submitted form that arrived unlinked** (a public form sent without a case — it
waits in the Form Inbox) to its case or contact — one per card, through the
same routes the form's own autosave and the Form Inbox's Link button use. Ask in
plain words ("prefill the 341 notes for the Smith case: trustee Jane Trustee,
meeting on November 20", "link that intake submission from Dana to her case").
Casey first reads the form itself — its fields, their types and their choices —
and uses only those.

- **A draft is only a draft.** Nothing is submitted: the form's submitted
  answers stay as they are, and no automation runs. Where the form opens for
  that record, a banner says there is an unsaved draft, with **Restore** and
  **Discard**; nothing on the form changes until someone clicks Restore.
- **A draft card** shows the form and the record, each answer before and after,
  who saved the existing draft last and when, and how many of its answers are
  **carried forward unchanged** — saving a draft replaces it whole, so Casey
  sends every answer already in it again. It warns when someone else saved the
  draft in the last 24 hours (they may still be working on it, and a copy open
  in another browser would replace the draft on its next autosave), and when
  the draft does not hold every field: **Restore fills the form from the draft,
  so each field it lacks shows blank** — check the restored form before saving
  it. Required answers left empty are listed (the form asks for them when it is
  saved). Values are stored the way the form saves them (a phone as digits
  only, a list of choices comma-separated), and the card says so.
- **Can the client see it?** Only a public form that keeps its drafts on the
  server shows a draft on the client's own form link — the client is offered
  this draft to resume, every answer in it — and the card warns when that is
  the case. Any other form's draft is staff only, and the card says so.
- **A link card** shows the submission (the form, when it arrived, its name,
  phone and email) beside the people on the case or the contact, and warns when
  those answers match no one there — check it is the right person; a link is
  never undone by the app. It shows the version the submission becomes (the
  newest of that form on the record — a form that shows its latest submission
  shows these answers from then on), the log entry the link writes, whether an
  intake form closes the case's intake reminders, and the pipeline steps that
  read as done because a submitted form now exists.
- **What Casey will not do, and says so:**
  - submit a form, make or file its PDF, edit, publish or restore a form,
    change who can see it, discard a draft, or unlink a submission — do those on
    the form, in the Form Inbox or in the form builder;
  - draft a form that was never published, or use a field the form does not
    have, a value of the wrong kind or a choice that is not on its list;
  - link a draft, a submission that is already linked, or a form to the wrong
    kind of record (a case form to a contact);
  - work on appointment-linked forms.
- **Freshness.** When you confirm, the card re-reads the record and the draft
  (or the submission). If anyone saved, restored or discarded the draft, or
  linked the submission, since the card was prepared, nothing is written; ask
  Casey to prepare it again.
- **Other open pages.** A copy of the form open in the form page in this browser
  picks up the new draft by itself; if you were typing in it, it keeps your
  typing, shows the new draft's banner and stops autosaving until you Restore or
  Discard. The older built-in form pages (Case Details, ISSN, the contact form)
  and copies open in another browser show it when reopened.

The off switch for these cards is the `casey_forms_enabled` setting (on unless
set to 0).

### Email: read state and case links

Casey can **mark one email read or unread for you**, or **link one email to
one case** — one per card, through the same actions the Comms hub's own Mark
read / Mark unread and **Link to case** use, and only on mail you can read
there (your mailbox access applies exactly as in Comms). Ask in plain words
("mark the trustee's email from this morning as read", "link Dana's last email
about pay stubs to her case"). Casey first searches your mail — sender,
subject words, a day — and works only on a message that search found.

- **Finding mail.** Casey's mail search is the Comms hub's own list: the
  mailboxes you can read, the Inbox unless you ask for sent or all mail, newest
  first. It sees each message's mailbox, sender, recipients, subject, date,
  preview, whether you have read it, how many copies of it are stored, and the
  case it is on — never the message's text. When you ask what an email says,
  Casey reads that one message: its headers and the first 2,000 characters of
  its plain text (not the formatted version). Casey treats that text as the
  sender's words — something to quote, never instructions to follow.
- **Read or unread is yours alone.** Each person has their own read state; the
  card changes only yours, and nobody else who reads that mailbox sees a
  difference. The mail server and the sender are never told.
- **Copies.** The same email can be stored more than once (two mailboxes, or a
  folder and the Inbox). Comms shows it unread while ANY copy is unread, so
  Casey will not mark one copy read while another copy you can read is still
  unread — open it in Comms (that marks every copy). Marking it unread is fine;
  the card lists the copies.
- **A link card** shows the email, the case, and the log entry the link uses:
  - an email already on the firm log reuses its existing entry (the card says
    which, and how much of the email's text it holds);
  - otherwise the link **creates one log entry on the case with the email's
    text** — the card warns that **the text becomes part of the case's log,
    readable by anyone who reads the case** (the case's Log tab shows it to
    every signed-in staff member; mailbox access does not apply there). A very
    long email does not fit a log entry whole: the card says how much is kept,
    and warns when the stored copy would be cut mid-way.
  It compares the sender (for an email the firm sent, its outside recipients)
  with the emails of the case's contacts, old addresses included: a match is
  shown, and **"not a contact on this case"** is a warning — check it is the
  right case. It also says that the case's Comms tab lists the email from then
  on, that the client portal never shows it, and that linking starts no
  automation. An open Comms hub or Comms tab in your browser updates on its own.
- **What Casey will not do, and says so:**
  - mark several emails, or a whole folder, read — use Comms;
  - draft an email: YisraCase has **no mail drafts** — Casey can send an email
    when you ask (a separate card you confirm), never a "draft" that sends;
  - work on texts or calls: they have no read or case-link action;
  - unlink an email from a case — change the case tag on the Comms tab
    (linking an email that is already on another case does move it, and the
    card warns: an email shows on one case at a time);
  - flag, archive or delete mail.
- Casey refuses when you click if the email's read state, its log entry or the
  case's contacts changed since the card was prepared — ask again.

The off switch for these cards is the `casey_mail_triage_enabled` setting (on
unless set to 0).

#### Filing an email's attachments to a case

Casey can **file one email's attachments into a case's Dropbox folder** — the
same thing Comms' **File to case…** dialog does, from any mailbox you can read,
one email per card ("file the pay stubs Dana emailed this morning to her
case"). Casey finds the email first, then reads its attachments the way the
dialog previews them, and proposes a card you confirm.

- **The case is yours to choose.** When Comms would suggest a case (the one
  case the sender's email matches, or a client whose name is in the subject),
  Casey says it is a suggestion; the card files only to the case you named or
  agreed to. If the case matcher places the email in a different case, the
  card warns you.
- **Which files.** The card lists each attachment it files (name and size) and
  the ones it leaves on the email. It never files a blocked type (programs,
  scripts and the like — the firm's `email_attachments_blocked_ext` list), an
  image inside the email (a signature or logo), a file too large to file from
  here, or a file already filed — Casey says why. A file outside the usual
  document types, or a large one, needs a **second confirmation** (the firm's
  `email_attachments_confirm_ext` / `email_attachments_confirm_mb` settings):
  Casey includes it only when you asked for that file, and the card marks it
  as a warning. A **duplicate** (the same name and size as a file already in
  the case) is filed only when you ask for it, and the card warns.
- **Where it lands.** By default `Client Uploads/Emailed YYMMDD` in the case's
  Dropbox folder, named for the email's date — the card shows the actual name.
  You can name another folder inside the case folder; it is used **exactly as
  written** (the firm's folder names often start with spaces), and the card
  says whether it exists — a folder that does not exist yet is created, with a
  warning (and the nearest real name, when yours differs only by spaces or
  capitals). A case with no Dropbox folder linked gets one created first (with
  a staff task), and the card warns.
- **What docs@ already filed.** When the email's files were already filed to
  the unsorted uploads folder, the card moves them into the case too (as the
  dialog does). Files the email filed on **another case** move only when you
  ask, with a warning naming that case.
- **Link to the case** is on by default, as in the dialog: the email goes on
  the case's log (the card says whether it reuses a log entry or creates one —
  the email's text then becomes readable by anyone who reads the case), and
  the sender is compared with the case's contacts. An email already linked to
  **another** case is moved to this one — the card warns. When the link cannot
  be made yet (an email that arrived minutes ago), Casey says so; ask it to
  file without linking and link it from Comms later.
- **The review notice** is on by default: after filing, the reviewer (the
  `email_attachments_reviewer` setting) is emailed one notice listing what
  landed — not when you are the reviewer, and not when none is set.
- **After you apply,** the chat says what was filed, what was already there,
  what moved, whether the email was linked and whether the notice went out. A
  file that failed or a link that could not be made is said plainly ("Applied
  with problems") — retry from Comms; what landed shows as Filed.
- Casey files **one email per card**; to file several at once, use Comms'
  Select mode. It refuses when you click if an attachment was filed meanwhile,
  became a duplicate or changed its blocked / confirm verdict, if what the
  email filed elsewhere, the reviewer, the case's Dropbox link or the email's
  case link changed since the card was prepared — ask again.

The off switch for this card is the `casey_mail_attachments_enabled` setting
(on unless set to 0).

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
  prepare a text to a number that has opted out of texts, and says so. The
  card shows *This recipient opted out of SMS* in red at the top, before
  anything else. When you confirm the send, you get the same "Send anyway?"
  question Comms asks; **OK** sends it and the send is recorded as an
  acknowledged opt-out, **Cancel** sends nothing. Send anyway only when the
  client asked for the message. Automations (workflows, sequences) still never
  text an opted-out number. An email card is never held up by an email
  opt-out — that one ("No marketing email") covers marketing mail only.
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
  changed, or its consent changed since the card was prepared (an opt-out or
  opt-in recorded anywhere), nothing is sent and the card says why (ask again —
  the new card shows the current opt-out). The send then goes through the same Comms send that a person
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
refuses a number that has opted out of texts (an email opt-out is marketing-only and does not stop a forward). Forwards need the rule's transform to
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
scoped `weather.lookup` external read, the typed `contact.relations` read (one
contact's relationships, roles, and the relationship-type and role lists —
those tables are outside the report schema, so it is the only way Casey sees
them), the typed `form.template` read (one form's title, who can see it,
whether it is published, and its published fields with their types and
choices — the form-template tables are outside the report schema too), the
typed mail reads — `mail.search` (the Comms hub's own email list for the
signed-in user's readable mailboxes, never message text) and `mail.message`
(one message's headers and the start of its plain text, read as the sender's
words) — the typed `document.relink.candidates` read (one case's Dropbox folder
suggestions, the Documents re-link panel's own strict list, and the folder the
case points at now), the typed `esign.requests` read (one contact's or one
case's e-signature requests — status, document, dates, the person the
reminders go to and whether reminders are running; never the signers' email
addresses, the provider's records or any signing link) — and the typed automation reads —
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
active workflow's published version now — with no input, or with the input
you give it. Input values must be for names the workflow's published steps
actually read (or that its test input sample lists — Casey sees those names
when it reads the workflow, so it can propose them without being refused
first); Casey refuses any other name and says which names are allowed. Each value is plain text (up to 500
characters, one line), a number, true/false or empty — never a nested
structure, so workflows that handle provider events (incoming messages or
calls) are not fed by hand. The card shows every value exactly as it will be
sent, which steps read it, and which placeholders stay blank. A run can be tied
to a contact only when Casey has read that contact in the conversation; the
card names the contact and whether this overrides the workflow's own default
contact.
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
is the `casey_sequence_authoring_enabled` setting. It may instead be one
`sequence.enroll.v1` proposal: enrolling ONE contact in ONE active sequence
template's published version now — with no extra data, or with the
enrollment data you give it. Data values must be for names the template's
published steps actually read (or that its test or captured sample lists);
Casey refuses any other name and says which names are allowed. Each value is
plain text (up to 500 characters, one line), a number, true/false or empty.
A case can ride along only when Casey has read it in the conversation and the
contact is linked to it. An appointment can ride along only when Casey has
read it and it is that contact's own appointment; the enrollment is then tied
to the appointment — it does not block, and is not blocked by, the contact's
ordinary enrollment in the same sequence, and it is cancelled when the
appointment is marked attended or no-show, cancelled, or rescheduled. The
appointment time must be that appointment's own (Casey is told the exact
value). An e-signature request can ride along too, for reminders about one
document: Casey first reads the contact's (or case's) signature requests —
it can also answer "did they sign?" from that read — and only a request that
is still awaiting signature, has no reminders running, and whose reminder
contact (the case's first client, the person the send itself would remind) is
that contact can be used. The enrollment is then tied to the request: it is
recorded as the request's reminder enrollment, so it is cancelled
automatically when the document is signed, declined, expires, is recalled or
is marked satisfied outside e-signature. If it cannot be recorded that way at
the moment you confirm, the new enrollment is cancelled at once and the card
says so. A template whose first step needs data the enrollment does not carry
is refused (the enrollment would fail), and placeholders the data does not
fill stay unfilled; the card lists them per step. The card shows every value
exactly as it will be sent and which steps read it, and names the appointment
(firm time and status) and the case. Casey reads both the template and the
contact first. The card shows
every step as the sequence would run it for that contact — when it runs or
that it would be skipped, and for a text or email the actual recipient,
sender and wording — plus what normally enrolls the template and how many
enrollments are running, and it is styled as a warning: every text and email
step messages the client as it comes due, and cancelling the enrollment
later stops only the steps not yet reached. A contact already enrolled in the
template the same way (ordinarily, for the same appointment, or for the same
signature request) is refused. If the template is deactivated or a new version is
published before you confirm, or the contact becomes enrolled — or the
signature request finishes or gets other reminders — nothing is
enrolled. For every text or email step the card also says whether its
recipient has opted out (texts: an SMS STOP; email: a marketing opt-out, and
only for a promotional step — an ordinary email step is never blocked): such
a step is skipped when its turn comes and the sequence goes on to the next
step, so the card marks it OPTED OUT up front; if that consent changes before
you confirm, nothing is enrolled and Casey prepares the card again. If the outcome cannot be confirmed, the card says so and offers no
second enrollment; check the sequence's enrollments. Once applied, the card
opens the new enrollment. Its off switch is the `casey_sequence_enroll_enabled`
setting (on unless set to 0, like every Casey switch). The card
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
