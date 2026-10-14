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
