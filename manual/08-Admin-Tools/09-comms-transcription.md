# 9 — Comms Transcription (SU)

## For operators

Archived call recordings and voicemails are transcribed by **AssemblyAI**. A
background job, **Comms Transcribe Sweep**, runs every 2 minutes. Every
transcript is AI-generated, so check the recording before relying on it. There
is no settings screen for it: you control it with `app_settings` rows from the
**DB Console**, and it tells you what's wrong through **System Alerts**.
Transcripts are read in Comms → Phone ([Comms archive](10-comms-archive.md)).

### The switch: `comms_transcribe_mode`

| Value | What happens |
|---|---|
| `off` | Nothing NEW is sent to AssemblyAI. Calls already sent are still collected and saved, and AssemblyAI's copies keep being deleted. |
| `sample` | Only the recordings in the evaluation sample (`comms_eval_items`). Stereo Quo calls are transcribed both ways, for comparison. |
| `on` | Every archived call recording and voicemail, newest first. |

Anything else counts as `off`, and a warning alert says so. It's read on every
run, so a change takes effect within 2 minutes.

### What never gets transcribed

- **Restricted calls.** A call someone marked private is never sent to
  AssemblyAI. If it is unrestricted later, it is transcribed on the next run.
  A call restricted after it was already sent is still saved, but its
  transcript is hidden exactly like the call.
- **Numbers on the do-not-transcribe list.** Add one from the DB Console:
  `INSERT INTO comms_no_transcribe (phone, note, created_by) VALUES ('2485551234', 'why', <your user id>);`
  The audio is still archived. Adding a number later does **not** remove
  transcripts it already has; use Restrict or Purge for those.
- **Calls with under 15 seconds of audio** (`comms_min_transcribe_s`). This is
  measured from the recording itself, not the call log: the call log counts
  ringing, so a "24-second call" can hold one second of sound. Voicemails are
  always transcribed, however short.
- **Recordings over 300 minutes** (`comms_stt_max_min_per_call`) are skipped
  as `over_cap`. To release one, run this from the DB Console and the next run
  sends it:
  `UPDATE comms_transcripts SET state = 'pending', skip_reason = NULL, cap_released_by = <your user id>, next_attempt_at = NULL, last_error = NULL WHERE id = <id> AND state = 'skipped' AND skip_reason = 'over_cap';`

### The monthly spending cap: `comms_ai_monthly_cap_cents`

Each run adds up this month's transcription cost (and, later, the summary
cost). Every job ever sent to AssemblyAI this month counts, including retries
and jobs that failed. A job that has finished counts at its billed price; one
still in progress counts at its estimate. A recording
that would push the total past the cap waits; nothing is lost and archiving
never stops. The first day the cap is hit you get a **warning** alert; if it
stays hit for more than a day, an **error**.

The cap starts at **7500** ($75) to cover the one-time backfill of older calls.
**Once the backfill has finished, lower it to $25/month yourself.** Nothing
does this automatically:

`` UPDATE app_settings SET `value` = '2500' WHERE `key` = 'comms_ai_monthly_cap_cents'; ``

A missing or non-numeric cap counts as 0: nothing is sent.

### The other settings

| Setting | Default | Meaning |
|---|---|---|
| `comms_stt_credential_id` | 14 | The AssemblyAI credential (Connections). |
| `comms_stt_quo_stereo` | `diarize` | How a two-channel recording is transcribed in `on`. `diarize`: one mixed track with speaker labels (cheaper). `multichannel`: one transcript per channel, billed per channel. |
| `comms_stt_max_speakers` | `2` (set to `0` since 2026-10-15) | The most speakers a mixed (one-track) transcript may have — mono calls, voicemails, and stereo calls in `diarize`. Extra voices are merged into existing speakers; without it AssemblyAI sometimes splits a two-person call into many "speakers". `0` = no limit — the current choice: a limit also merged real voices (a hearing or 341 meeting dialled into, a hold message, an IVR). Anything other than a whole number 0–10 stops transcription (alert `comms_transcribe_config`). Not used for `multichannel`. |
| `comms_stt_keyterms` | `[]` | JSON list of names or phrases to help recognition, up to 6 words each. Leave empty unless needed: it adds $0.05 per audio hour. |
| `comms_stt_language_detection` | `1` | `1` means AssemblyAI detects the language. Anything else means English only. |

### Alerts you may see

| Alert | What to do |
|---|---|
| `comms_transcribe_no_auth:14` | AssemblyAI refused the key, or the credential doesn't cover `api.assemblyai.com`. Fix the credential. Nothing was charged. |
| `comms_transcribe_storage` | The archive bucket or URL signing failed. Before any audio leaves, each run proves signing works on a test file that is not client data. Until it passes, nothing is sent. |
| `comms_transcribe_config` | A setting above is wrong; the message names it. |
| `comms_transcribe_cap` | The monthly cap is reached (see above). |
| `comms_transcribe_drift` | AssemblyAI answered in an unexpected shape, or a recording's header couldn't be read. Those items wait. Tell IT. |
| `comms_transcribe_failed` | AssemblyAI rejected an item three times. The message has the reason. |
| `comms_transcribe_duration_drift` | Recording lengths estimated before sending disagree with AssemblyAI's. The 15-second and 300-minute rules may be misjudging. Tell IT. |
| `comms_transcribe_backlog` | Items have waited more than 48 hours. Check the cap and the other alerts. |
| `comms_transcribe_orphan` | A request to AssemblyAI got no usable answer, so AssemblyAI may hold a job we never got an id for. Each run searches AssemblyAI's list for it for 24 hours and deletes it if found. If it is never found, AssemblyAI's 30-day limit removes it. |
| `comms_transcribe_delete_owed` | AssemblyAI's copy of a transcript couldn't be deleted after several tries. Retries continue, and the 30-day limit is the backstop. |
| `comms_transcribe_breaker` | AssemblyAI's last three answers to new requests were unreadable or missing. Each might still have been a real (billed) job, so new submissions pause for 6 hours, then try again. Jobs already in progress carry on. Check AssemblyAI's status page and tell IT. |
| `comms_transcribe_anomaly` | Something a human must check. The message says exactly what. |

### Summaries

After a call is transcribed, **Claude** writes a short summary: what the call
was about, who promised what, any dates, amounts, documents asked for, and
case numbers mentioned. The summary is the text you see on the call in Comms.
It is AI-generated, so check the recording before relying on it.

- **The switch** is `comms_summarize_mode`. It works like the transcription
  switch: `off` / `sample` / `on`, and anything else counts as `off`.
- **The model** is `comms_summary_model`: `claude-sonnet-5-5` (the default) or
  `claude-haiku-5-5`.
- **The effort** is `comms_summary_effort`: `low` (the default), `medium` or
  `high`. Higher effort thinks longer and costs more.
- **What Claude is told about the firm** (so it can tell who is who on a call):
  the names of everyone who signs in to YisraCase (except automation accounts),
  and `comms_summary_firm_context` — a few lines you can edit: the firm's names,
  Sonoma (the AI receptionist), the recorded greetings, call screening, and how
  the transcriber mishears "Sandweiss". Keep it under 2,000 characters: longer
  stops the summaries (alert `comms_summarize_config`). It is read on every run.
- **Dates:** a date said on a call ("Monday", "the 15th") is kept exactly as
  said, and Claude also works out the calendar date from the call's date. That
  worked-out date is a best guess — check it against the words.
- **What is never summarised:**
  - **restricted calls**, which are never sent;
  - calls with less than `comms_min_summary_s` (30) seconds of audio (voicemails
    always are);
  - calls Claude declines. That raises a `comms_summarize_refused` warning, and
    the transcript is unaffected.
- **Every item is checked against the transcript.** A promised document, a date
  or an amount is kept only if its quoted words are really in the transcript.
  Anything else is dropped. The "jump to" time for an item comes from the
  transcript, not from the AI.
- **Cost:** summaries share the one monthly cap above with transcription. When
  the cap is reached, both wait.
- **Who saw a summary:** each time a thread shows summaries, one audit record
  lists which calls' summaries were shown (never their text). Find them in the
  admin audit log, tool `comms_archive`, action `view_summary`.
- **Purging** a call also blanks every stored AI request and reply for it.
  Their cost records stay.
- **Re-summarise one call:** anyone who can open a call can ask for its summary
  to be made again (or made at all, if it was skipped), with Sonnet by default,
  and can add a short note about the call ("this was about the Chase car loan;
  the caller is the client's wife"). It is done on the next run, usually within
  two minutes, and the old summary stays until the new one is ready. The note is
  a hint only — Claude still has to find everything in the transcript itself.
  The model and note are **kept** for that call: any later re-summarise, even a
  bulk one, uses them. A new request **without** a note clears the old note.
  Restricted calls are never sent; each person can ask 10 times an hour; the
  monthly cap applies. Each request is in the admin audit log (action
  `resummarize`), with the note's length but never its words.

| Alert | What to do |
|---|---|
| `comms_summarize_config` | A summary setting is wrong, or Claude refused the key or the request. The message says which. |
| `comms_summarize_failed` | A call could not be summarised after three tries. The transcript is still there. |
| `comms_summarize_refused` | Claude's safety checks declined to summarise a call. No action is needed; the transcript is unaffected. |

### Redoing transcripts or summaries

When transcripts were made with older settings — before the speaker limit,
or a stereo Quo call made as one mixed track — you can send them back to be
made again with today's settings. The same goes for summaries, for example
after switching `comms_summary_model`. SU only, with the password step-up.
Run it from the browser console on the app (signed in as SU):

```js
// 1. A DRY RUN (nothing changes): what would be redone, and what it would cost.
await apiSend('/api/comms-archive/redo', 'POST', { mode: 'transcript', select: { mono_min_speakers: 3 } });
// 2. The same with apply: true does it, 50 at a time (limit up to 200). Repeat until "remaining" is 0.
await apiSend('/api/comms-archive/redo', 'POST', { mode: 'transcript', select: { mono_min_speakers: 3 }, apply: true });
```

| `select` | Picks |
|---|---|
| `{ quo_stereo_diarized: true }` | Stereo Quo calls that were transcribed as one mixed track (set `comms_stt_quo_stereo` to `multichannel` first). |
| `{ mono_min_speakers: 3 }` | One-track calls with 3 or more "speakers" that were made before the speaker limit. |
| `{ capped: true }` | Calls transcribed while the speaker limit was on (it merged real voices, so it was turned off: `comms_stt_max_speakers` = 0). |
| `{ summary_model: 'claude-haiku-5-5' }` | With `mode: 'summary'`: summaries made with that model. |
| `{ media_ids: [123, 456] }` | These items, either mode. |

- **While a transcript is redone it is not shown** — Listen still works, and the
  new transcript appears in one step when it is ready (normally minutes). Redo
  items go ahead of new calls in the queue. A summary redo keeps the old summary
  visible until the new one replaces it.
- **A redo that fails keeps the old transcript.** If AssemblyAI keeps failing on
  it, or it is skipped (restricted meanwhile, on the do-not-transcribe list,
  too short or too long), the old transcript comes back and its summary is made
  again; a `comms_transcribe_redo_failed` warning lists the items.
- **Never touched:** restricted calls, numbers on the do-not-transcribe list,
  and the evaluation sample (unless you name its items in `media_ids` — then
  BOTH stored versions of its transcript are replaced, including the
  alternate the evaluation compares against). A call whose summary is being
  made right now is reported as `busy` — run it again later.
- **Money:** the dry run shows the estimate and the room left under the
  monthly cap, after what earlier redos are still waiting to spend. An apply
  that would go over it is refused (nothing changes): lower `limit`, or raise
  the cap first. It is also refused while `comms_transcribe_mode` (or, for
  summaries, `comms_summarize_mode`) is not `on`, and a transcript redo of
  calls that already have summaries is refused while summaries are off (they
  would not be made again). A refusal shows as an error in the console; its details (the same
  counts and estimate) are in the error's `body`.
- Every call, dry runs included, is recorded in the admin audit log (which
  items, never what was said).

### Privacy

- AssemblyAI does not train on our audio (an account setting), and keeps data
  for at most 30 days. Each transcript is deleted from AssemblyAI right after we
  store it.
- A **restricted** call is never sent (see above).
- **Purging** a call removes its transcript and every saved copy of it. AssemblyAI's
  copy is deleted too, or retried until it is. The one exception: if a request
  timed out and AssemblyAI's copy was never found, nothing has an id to delete
  it by, and AssemblyAI's 30-day limit removes it. Spending records are kept:
  they hold no call content.
- Transcripts can't be read through the read-only SQL path session keys use (Admin → Session Keys);
  they appear only through the app's access-checked screens.
