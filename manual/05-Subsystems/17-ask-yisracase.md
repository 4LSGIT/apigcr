# Ask Casey

Ask Casey is the user-facing name for the firm's YisrAI assistant. Its searches
are read-only; its reviewed task actions are performed by the
signed-in user after explicit review. It can answer
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
ends first, the answer uses the evidence already found and must say what remains
unknown. These automatic passes are reads only.

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

## Reviewed task actions

Ask Casey can prepare one evidence-backed task action for explicit review.
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
3. Read the confirmation warning and continue only if every value is correct.

The confirmed button calls the ordinary authenticated task route with only the
reviewed, server-normalized fields. Creation uses `POST /api/tasks`; ordinary
edits use `PATCH /api/tasks/:id`; complete, cancel, reopen, and transfer use
their established transition routes. The signed-in staff user remains the
actor. Creation and transfer may notify an assignee, completion may notify the
assigner, and date changes may schedule or cancel reminders. **Copy details**
remains available; **Discard** changes no YisraCase record. Casey cannot draft a
bill-linked task because the legacy `bill` task-link enum has no verifiable bill
record source.

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

## Models and files

The model selector offers two product-level choices:

- **Better quality** uses Claude Opus.
- **Faster speed** uses Claude Sonnet.

The selected mode applies to both planning and answering and is remembered with
the chat. Provider model identifiers are controlled by the server rather than
accepted from the browser.

**Attach file** adds up to four temporary PDF or image files to the next
question. All attachments together must be 6 MB or less. Temporary files are
sent for that question but are not silently registered as firm documents and
their bytes are not stored in chat history. The message history retains only
the filenames and sizes.

**YisraCase document** searches the existing Documents registry and attaches a
PDF or image by its stable document id. YisrAI reloads the file through the
normal document source and refuses to continue if the document changed between
planning and answering.

A temporary attachment has a separate **Save to case** control. Choosing it,
then choosing a case, is the explicit filing action: the browser uploads the
original file through the established Dropbox upload flow and YisraCase
registers and links the resulting document to that case. Merely attaching or
asking about a file does not save it.

## What read-only means

Assistant searches and task proposals cannot change anything. YisrAI cannot
send email, edit a contact, save/create a task record, fill a form, or create a
workflow. It can return the typed task draft described above; the staff member
must manually review and assign it in My Tasks. The separate,
user-invoked **Save to case** attachment control is the one current write; it
uses the existing Documents upload API rather than a model-authored action.
Searches run through the same SELECT-only database connection and validation used by Reports, with
tighter limits for conversational use.

It also cannot expose passwords, credentials, bearer tokens, SSNs/EINs, dates
of birth, raw custom-field JSON, email attachments, or delivery metadata.
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

Chats are private to the signed-in user. **Recent chats** keeps the 30 most
recently used conversations and lets their owner reopen or delete them. The
latest eight user and assistant messages are included as context for a
follow-up. Older visible messages are history, not model context, so YisrAI
suggests starting a fresh chat after the fourth question. For best results,
keep one chat about one person, matter, or task.

Query result text is untrusted data. A separate investigation controller may
use it only to identify one fact still needed for the original question and
request another operation through the same read-only validator and budgets.
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
or other sensitive client facts in a shared YisrAI link. Anyone creating or
sharing such a link is responsible for deciding whether its question is safe to
put in a URL.

## Future actions

The plan format names every operation by type. Enabled executable operations
remain read-only: `sql.read`, `manual.search`, `comms.search`, and the narrowly
scoped `weather.lookup` external read. The answer may additionally contain one
server-validated `task.create.v1`, `task.update.v1`, `task.complete.v1`,
`task.cancel.v1`, `task.reopen.v1`, or `task.transfer.v1` proposal. The proposal
itself changes no record. A signed-in user can perform that exact action only
through the card's explicit review and confirmation, which invokes the ordinary
authenticated task route.

Future action types can use a visible plan, signed approval and execution
record, but they must be introduced separately. Read-only auto-run does not
carry over to writes. Composing an email and sending
it are different operations: a draft may be safe to generate automatically,
while sending requires a fresh approval showing the exact recipient, subject
and body. Filling a record or form needs a field-level before/after preview.
Creating a workflow needs validation and a draft version before anything can be
published. No action becomes available merely because the model names it.
