# 10 — Comms archive (recordings, voicemails, MMS)

## For operators

YisraCase keeps its own private copy of every call recording, voicemail and
picture / file text (MMS) the phone systems hold — RingCentral deletes call
recordings after 90 days, Quo is not durable either. The copy lives in a
private Google Cloud Storage bucket; nothing in it is ever public. Design and
internals: `ref/COMMS_ARCHIVE_DESIGN.md`.

### Where people see it — Comms → Phone

In a phone conversation (see [Phone lines — Comms](08-mailboxes.md#phone-lines--comms)):

- **A call** with a recording has **Listen** (plays in the call's box) and,
  once it has been transcribed, **Transcript**. When a summary exists it is
  shown in the call's box.
- **A voicemail** shows on the call it was left on, with **Listen** (and
  **Transcript** when there is one — for now that can be the phone system's
  own automatic transcript).
- **No Transcript button?** The box says why, in one grey line under Listen:
  "Transcript in progress — check back soon" (waiting its turn, being
  transcribed, or held until the monthly budget allows), "Not transcribed —
  too short (about 9 s)", "Not transcribed — too long", "Not transcribed" (any
  other reason — the box does not say which), or "Transcription failed" (tell
  IT). No line means it is not
  queued for transcription (yet).
- **A text with a picture or file** shows pictures inline (click one for full
  size) and other files as a chip (**PDF · 2.4 MB**, **File · 1 KB** …); a PDF
  opens in a viewer with **New tab**, anything else downloads. A file still
  being copied says "archiving, check back soon".
- **Transcripts** come from the transcription job
  ([Comms Transcription](09-comms-transcription.md)) — none for restricted
  calls, numbers on the do-not-transcribe list, or calls under 15 seconds of
  audio.
- **Every transcript and summary is labelled** "AI-generated — check the
  recording before relying on it" (the phone system's own transcript says it
  is the phone provider's automatic transcript). Speaker labels are guesses.

Bubbles fill in on the next refresh after the archive catches up — usually
minutes after the call.

### Re-summarise — Comms → Phone

Anyone who can read a call (not only admins) can ask for a fresh summary:
**Re-summarise…** next to Listen / Transcript (**Summarise…** when the call
has a transcript but no summary yet — even a short one). The dialog offers
**Use the better model (Sonnet)** (on by default) and an optional **note** of up
to 500 characters — tell it what the call was about or who the speakers are.
The note is shown under the summary it shaped ("Guided by a note from …"), as
is the model when it was Sonnet — a new note appears with the new summary. While the new summary is being made the call says
**Re-summarising…** and the old summary stays until the new one lands
(usually within two minutes; the page checks by itself for about five, then
says "Still working — check back later"). Restricted calls can't be
re-summarised, and voicemails show their summary under the voicemail too.

### Searching what was said — Comms → Phone

The search box in Comms → Phone (see [Phone lines — Comms](08-mailboxes.md#phone-lines--comms))
also looks inside call and voicemail **transcripts**: below the matching
conversations an **In call transcripts** group lists the calls whose words
match, newest first — who, when, and a line of the transcript with the
searched words highlighted. **More** loads older matches. Click one to open
its conversation and the transcript at that moment.

- It searches **whole words from their start**: "bank" finds "bankruptcy",
  every word you type must appear, and the order doesn't matter. There is no
  "exact phrase" search.
- Words under **3 letters or digits** and very common words ("the", "about", "with"…)
  are skipped — the group says which. A search of only those shows nothing.
- A **reference number** typed with its # ("#12345") finds that one text or
  call and is not looked for in transcripts.
- It covers what you can read: the same lines, restricted calls only for
  archive admins, and only finished transcripts.
- The words you search for are not kept in any log.

### Who sees what

- **Access follows the phone line.** Anyone who can read a line in Comms can
  listen to its recordings, voicemails and files — superusers and attorneys
  everywhere, everyone else on the lines granted to them
  ([Phone-line access](08-mailboxes.md#who-can-read-and-send--connections--phone-lines--access)).
- **Restricted** items are seen only by **archive admins** (below). Everyone
  else sees the call or text as if nothing had been recorded — not a lock.
- A voicemail RingCentral recorded without saying which number it was left on
  has no line, so only superusers and attorneys can open it.
- Every Listen, file open and transcript view is written to
  `admin_audit_log` (tool `comms_archive`, the action and the item number —
  never the content or the link).

### Restrict and purge — archive admins

**Archive admins** are the superusers plus the people listed in the app
setting `comms_archive_admins` (user numbers, comma-separated; editable only
from the SU DB console). They see a **⋯** button next to every archived
recording, voicemail and file in Comms → Phone:

- **Restrict** hides the item (and anything made from it — transcript,
  summary) from everyone but archive admins. A reason is required.
  **Unrestrict** undoes it. Restricted items carry a **Restricted** badge.
- **Purge…** deletes the item from the archive for good, with everything made
  from it. It asks for a reason, the item number typed back, **and your own
  password**. Five wrong passwords lock purging for you for 15 minutes. The
  record that the call or text happened stays; so do the copies the phone
  systems themselves still hold (RingCentral deletes its own after 90 days —
  delete a Quo one in the Quo app if needed). A purged item shows admins a
  note: "… purged <date> by <name>: <reason>".
- Purge is limited to 20 per person per hour. Every attempt — refused ones
  included — is in `admin_audit_log` (tool `comms_archive`); the password
  never is.
- Purging needs an account password. Every user has one today; an account
  without one cannot purge until a password is set.

### Health — System Alerts → Comms archive (SU)

**Admin → System Alerts (SU)** has a collapsed **Comms archive** section. Open
it to see:

- **Archive items** by kind (call recording, voicemail, MMS file, vendor
  transcript) and provider: how many are archived, waiting (pending), had
  nothing to fetch (none), were already gone at the provider (gone), failed,
  or were purged; and how many are restricted.
- **Waiting** — the oldest call / message still waiting per kind, and since
  when; **Why they wait** — the commonest reasons (e.g. Quo refusing a line).
- **Sweeps** — each archive job's schedule, last run and its counts.
- **Transcripts and summaries** — how many transcripts are in each state, why any were skipped (e.g. `over_cap` — see [Comms Transcription](09-comms-transcription.md)), the oldest still waiting, how many are being redone and since when (see *Redoing transcripts or summaries* there), and this month's transcription spend (the figure the monthly cap uses).
- **Open archive alerts** — the archive's own unresolved alerts (manage them
  in the table below as usual).

It reads only when opened, and again on **Refresh** while open. Like every SU
tool it needs [elevation](README.md).
