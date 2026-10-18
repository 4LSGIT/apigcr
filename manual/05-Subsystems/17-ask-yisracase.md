# Ask YisrAI

Ask YisrAI is the firm's read-only conversational assistant. It can answer
questions about firm records, how YisraCase itself works, general knowledge,
and current weather. Find it at
**More → Ask YisrAI**.

## Asking a question

Type naturally. Useful questions include:

- “What is the story with the person who emailed about tractors a few weeks ago?”
- “Which open matters have appointments in the next two weeks?”
- “What happened recently on this case?”
- “How do locked reports work?”

Read-only searches run automatically. The assistant may search ordinary data,
the phone-call archive, the YisraCase manual, or current weather. Generated SQL
and its success or rejection are retained in the developer report-run log so a
failed answer can be diagnosed without asking staff to review query syntax.

After execution, the answer includes source rows for important claims. When a
source contains a case, contact, appointment, event, or task id, visible buttons
under the citation open those records directly in YisraCase. Open those sources when an answer
affects a deadline, filing, client communication,
or other consequential decision. The assistant can misunderstand incomplete or
ambiguous records.

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

Assistant searches cannot change anything. YisrAI cannot send email, edit a
contact, create a task, fill a form, or create a workflow. The separate,
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
times out work, and records SQL runs and model cost. A collation mismatch or an
over-expensive query gets one automatic planner repair; the replacement must
pass the same validation and execution limits.

## Conversation and follow-ups

Chats are private to the signed-in user. **Recent chats** keeps the 30 most
recently used conversations and lets their owner reopen or delete them. The
latest eight user and assistant messages are included as context for a
follow-up. Older visible messages are history, not model context, so YisrAI
suggests starting a fresh chat after the fourth question. For best results,
keep one chat about one person, matter, or task.

Query result text is sent only to the answering model; it is treated as
untrusted data and cannot autonomously author another query. To investigate
further, ask another question; read-only searches run automatically. Short
follow-ups such as “what day of the week is it?” resolve against the date or
record most recently discussed when that reference is unambiguous.

Attached file content is also untrusted data. Instructions printed in a PDF or
image cannot authorize another query, save the file, or perform an action.

## Links that prefill a question

An internal link can open YisrAI with a draft question in the composer:

`/?open=tabMore%7EmoreAssistant&ask=Which+341+meetings+are+coming+up%3F`

The question is filled in but **never run automatically**. The `ask` parameter
is removed from the address bar as soon as the shell captures it.

The original link can nevertheless remain in browser history, messaging or
email systems, server/proxy request logs, screenshots, and any place where the
link was pasted. Avoid names, contact details, medical or financial information,
or other sensitive client facts in a shared YisrAI link. Anyone creating or
sharing such a link is responsible for deciding whether its question is safe to
put in a URL.

## Future actions

The plan format names every operation by type. The only enabled types today are
read operations: `sql.read`, `manual.search`, `comms.search`, and the narrowly
scoped `weather.lookup` external read.

Future action types can use a visible plan, signed approval and execution
record, but they must be introduced separately. Read-only auto-run does not
carry over to writes. Composing an email and sending
it are different operations: a draft may be safe to generate automatically,
while sending requires a fresh approval showing the exact recipient, subject
and body. Filling a record or form needs a field-level before/after preview.
Creating a workflow needs validation and a draft version before anything can be
published. No action becomes available merely because the model names it.
