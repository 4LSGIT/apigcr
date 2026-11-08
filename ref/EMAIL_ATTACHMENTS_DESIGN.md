# EMAIL_ATTACHMENTS_DESIGN — email attachments → Dropbox (docs@ first)

Status: S1 (plumbing) landed 2026-11-06 (cdf2050). S2 (the docs@ workflow)
landed 2026-11-06 (367d8b3); shadow live since 2026-11-06 (workflow 55, rule
24 action 28). S2b (2026-11-08): case numbers and legacy ids name the case.
S3 (Comms UI) not started. Rulings: Fred, 2026-11-06 and 2026-11-08 (§1).
Living design doc — edit claims in place when a slice changes them.

## 1. Goal and rulings

Mail to **docs@4lsg.com** (clients sending documents) used to produce only a
digest email to SB (Shoshana, user 5) naming the attachments; staff then saved
the files by hand. Goal: file each attachment where it belongs — the case's
`Client Uploads`, else an unsorted folder — and send SB one email saying where
everything went and what to do. More generally: **email attachments become
material any automation can use**, for any mailbox and any provider.

Rulings (2026-11-06):
- **Provider-neutral.** Attachments are read from YisraCase's own mailbox store
  (`mail_messages`) over IMAP — Gmail today, Migadu after the provider move. No
  Gmail-specific code. The Apps Script feeder (no bytes, no mailbox reference)
  was retired the same day (`ref/MAILBOX_GMAIL_PARITY.md` §4), so every
  `gmail-firm` envelope now comes from the worker and names its stored row.
- **Open case** = stage Open, Pending or Filed. Several open → the one retained
  (`pipeline_phase = 'case'`) case, else undecided.
- **The email names the case first** (Fred, 2026-11-08): a case id — any
  vintage, new Crockford or legacy — or a case number (`case_number` /
  `case_number_full`) in the subject wins over the sender's own cases; the
  body only when the subject names none. (Replaces the 2026-11-06 ruling
  "new-style ids only": MY0PZ04I, a legacy id, went unsorted.)
- **Named case vs sender** — a named case that is none of a known client's
  cases while that client has open ones is a **conflict**: unsorted +
  flagged, never the named case; the notice offers both as buttons. One of
  the client's own cases at any stage (a closed one too) is not a conflict.
- **One folder per day**: `Client Uploads/Emailed YYMMDD`.
- **Notice by email only** (no task), recipient in the workflow's config.
- Idea, parked: one notice per burst of emails from a sender (§8).
- Idea, adopted for S2: when no case is chosen but candidates exist, the email
  carries one button per candidate case (`request_decision`) that moves the
  files there.

## 2. Bytes — the mailbox store, not the envelope

Design D1 of the mailbox system: the worker stores attachment STRUCTURE only
(`mail_messages.attachments` = `[{part, filename, size, mime, cid?}]`, size =
the ENCODED size); bytes stay on the mail server. `services/mailbox/
mailAttachmentService.js` is the server-side path to them:

- `resolveMessage(db, ref)` — three reference forms: `{mail_message_id}`;
  `{mailbox_id, folder, uid}`; `{source, message_id}` (the ingest dedupe
  identity, resolved through each mailbox's emission config — provider id or
  RFC Message-ID).
- `fileableParts(row)` — kept: extension on the client-upload allowlist
  (`portalDocsService.ALLOWED_EXTENSIONS`; no extension → from the MIME type);
  skipped with a reason: cid-referenced inline images under 20 KB (signature
  logos — NOT every inline image: Apple Mail sends photographed documents as
  inline images, `mail_messages` 3206), refused types (`.eml`, `.ics`, `.zip`,
  `.exe`, …), estimated over 40 MB.
- `fetchPartBuffer(db, row, part)` — `imapTransport.fetchPart`'s identity
  guard (UIDVALIDITY + Message-ID), buffered with a hard byte cap. Coded
  errors: `BAD_REF`, `MAILBOX_GONE`, `RESYNC_PENDING`, `PART_GONE`,
  `TOO_LARGE`. The browser route (`GET /api/mailboxes/:id/messages/:mid/
  parts/:part`) is NOT refactored onto it: it streams with its own response
  mapping, and the guard both rely on is the transport's.

The worker's envelope carries the handle (additive, S1):
`mailbox.message_row_id` (= `mail_messages.id`; stored before emission, so
always set) and `attachments[].part`. Envelope `url` stays null.

## 3. Which case — `emailCaseMatchService`

E = the cases the email names, by case id or case number (subject first; the
body only when the subject names none, quoted history cut). S = the sender's
OPEN client cases (active `contact_emails` → `case_relate` Primary/Secondary —
the Comms `related()` rule).

| Situation | Result |
|---|---|
| \|E\| > 1 | none, `multiple_case_ids` |
| \|E\| = 1, S empty | E (a relative or employer with the id; a client with no open case) |
| \|E\| = 1, E ∈ S | E |
| \|E\| = 1, E is another of the sender's cases (any stage) | E |
| \|E\| = 1, otherwise | none, `conflict` |
| no id, \|S\| = 1 | S |
| no id, \|S\| > 1 | the one retained case, else none, `multiple_open_cases` |
| no id, S empty | none, `no_open_case` (known contact) / `unknown_sender` |

Case ids: "case <id>" (any letter case; also `case:`, `case #`, `case id`,
`case no.`) in subject or body; a bare token of uppercase letters and digits in
the subject only. 8 base64url characters with at least one letter — new
Crockford ids and the legacy ones (13 legacy ids are all caps, e.g. MY0PZ04I).
Looked up case-insensitively, which is exact: `cases.case_id` is the general_ci
primary key, so no two ids differ only in case.

Case numbers: dockets are opaque (`26-52011`, `26-52011-mar`,
`1:26-cv-00546-JLR`, `18-LV02229`), so nothing parses their shape. Every
subject token, and in the body the token after `case` / `case number` /
`case no.` / `case #` (the gap may cross a line: "Case number:\n26-52011"),
is cleaned of end punctuation and, if 5–40 characters with 4+ digits and not
an address or URL, compared for EQUALITY with `case_number` and
`case_number_full` (trimmed, case-insensitive). The floor bounds the lookup;
equality does the deciding. ≤ 10 candidates per kind and source. When an id
and a number name the same case the method says `case_id_*`.

Methods: `case_id_in_subject`, `case_number_in_subject`, `case_id_in_body`,
`case_number_in_body`, `sender_open_case`, `sender_retained_case`. The
patterns read any email anyone sends, so they are linear (the 2026-11-06
prefix and quote patterns were quadratic in a whitespace run — 1.9 s at 32 K
spaces); the unit test pins 128 K-character worst cases.

Live data (2026-11-06): of contacts with an email and an open case, 728 have
exactly one, 11 have two or more. Of 1,425 cases, 453 carry a case number
(none shared, 2026-11-08).

## 4. Filing — `emailAttachmentFilingService`

Per fileable part: **claim** → fetch → `filePlacementService.placeAndRegister`
(the client-upload ladder + documents registry) → **complete**.

Where:
- case chosen → `<case folder>/Client Uploads/Emailed {yymmdd}` (template
  param; `{yymmdd}` = the message date, firm-local). A case without a working
  folder gets the ladder's rung 2 (auto-create + task) or rung 3 (the bin's
  `{case_id} - {name}` folder) — **no per-file move task** (a 14-file email
  would raise 14); the notice says it instead.
- no case → the unsorted client-uploads bin (`dropbox_unsorted_uploads_path`),
  in `Emailed {yymmdd} - {sender}` (sender = the contact's lfm name, else the
  address), registered to the sender's contact when there is one.
  `placeAndRegister` gained `unsortedSubfolder` for this (loose rung only, one
  sanitized segment, no trailing `.`/space).

**`mail_attachment_filings`** (`ref/migrations/2026-11-06_mail_attachment_filings.sql`):
UNIQUE(mail_message_id, part) is the claim. INSERT IGNORE 'filing' → upload →
'filed' (path, Dropbox id, document id, link, match method); DELETE on failure.
A 'filing' claim older than 15 min is re-claimed; a fresh one is reported
`in_progress`. A re-run files only what is missing. Dropbox ids are stamped
from `documents.external_id` after the batch (the refile handle). No FK to
`mail_messages`: the record outlives a purged or pruned mail copy.

Failure posture: throws only when there is nothing to report on (`BAD_REF`,
`MESSAGE_NOT_STORED`, `CASE_NOT_FOUND`, `CONTACT_NOT_FOUND`, `BAD_TARGET`).
Per-file failures are results, listed in the notice; one fetch retry each.

**Refile** (`refileMessageAttachments`): every 'filed' part of a message →
the case's `Client Uploads/Emailed {yymmdd}`, moved BY DROPBOX ID (follows
staff renames/moves), keeping the current name; re-linked to the case
(relation 'upload'); the row rewritten (`match_method = 'refiled'`). A file
already in the destination is only re-linked. The emptied unsorted folder is
left in place.

## 5. The notice — `emailAttachmentNotice`

Pure renderer, ported from the docs@ digest transform's layout (Outlook-safe
tables). Outputs `notice_subject`, `notice_html`, `notice_text`, and — when
`needs_decision` — `notice_html_decision`: the same HTML with
`[[options_html]]` in the where-box, for `request_decision`'s `email_html`.
Subject: `<prefix><who> (N files) — filed to case X` / `— UNSORTED, needs a
case` / `— NOT FILED` / `(no files)`; S2 passes the old digest's prefix
(`New email to Docs@4LSG.com — `) so SB's mail filters still match.
Every email-derived string is HTML-escaped, square brackets included
(`&#91;`): request_decision expands `[[…]]` tokens in email_html and subject
and throws on an unknown `[[respond_url:X]]`, so mail text must never carry
one in. The subject breaks `[[`/`]]` apart.

## 6. Internal functions — `lib/internal_functions/emailAttachments.js`

| Function | Engines | CTA |
|---|---|---|
| `email_case_match` | both | **denied** — a read returning a client's cases |
| `email_attachments_file` | workflow only | eligible (SU-minted, frozen plans) |
| `email_attachments_refile` | workflow only | eligible — "file these to case X" is its point |

Reference params on all three: `mail_message_id` | `mailbox_id`+`folder`+`uid`
| `source`+`message_id`. Once filed, files are ordinary Dropbox documents for
`parse_pdf`, `query_ai` file inputs and `send_email` `attachment_urls`.
Operator reference: `manual/03-YisraFlow/05-internal-functions.md` → Email
attachments.

## 7. S2 — the docs@ workflow

Data, written by two assert-first console scripts (CLAUDE.md conventions),
plus one code change: `request_decision.options` takes a single
`{{placeholder}}` (`placeholderAllowed`; the engine's single-placeholder path
hands the step the ARRAY, and request_decision still refuses at run time
anything but 1–10 `{label, value}` objects — an unset variable resolves to
`''` and fails the step).

**Workflow "docs@ intake"** — init data = rule 24's transform output
(`mail_message_id`, `source`, `message_id`; the shadow adds the digest
fields):

| # | Step | Notes |
|---|---|---|
| 1 | `noop` set_vars `notify_email`, `notify_user_id` | THE recipient setting — every message below reads it. Shadow: it@4lsg.com / 6. |
| 2 | `email_attachments_file` → `filing` | ref = all three forms (row id, else source + message_id); prefix `New email to Docs@4LSG.com — ` (SB's mail filters key on it), title `docs@4lsg.com`; set_vars `needs_decision` = `'true'`/`'false'` (a STRING: evaluate_condition's loose `==` makes `"true" == true` false). retry_then_abort ×2 |
| 3 | `evaluate_condition` `needs_decision == 'true'` → 6, else 4 | |
| 4 | `send_email` notice → `{{notify_email}}` | `notice_subject` / `notice_html` / `notice_text`. retry_then_abort ×2 |
| 5 | `set_next end` | |
| 6 | `request_decision` → user `{{notify_user_id}}` | options `{{filing.decision_options}}` (candidates + "Leave it in Unsorted"), email_html `{{filing.notice_html_decision}}`, subject `notice_subject`, 7d → `unsorted`, no task, result `chosen_case`, resumes at 7. retry_then_abort ×1 |
| 7 | `evaluate_condition` `chosen_case != 'unsorted'` → 8, else end | |
| 8 | `email_attachments_refile` `{{filing.mail_message_id}}` → `{{chosen_case}}` → `refiled` | set_vars `refile_failed` = `{{this.output.failed.length}}`. retry_then_abort ×1 |
| 9 | `evaluate_condition` `refile_failed > 0` → 10, else end | |
| 10 | `send_email` "NOT MOVED — …" → `{{notify_email}}` | plain text only: no email-derived string goes into HTML. retry_then_abort ×2 |

Every side-effect step aborts the run on failure (the error sweep pages IT
for a failed execution); the default `ignore` would carry on to a notice
built from nothing.

**Rule 24** (`docs@ digest (replaces Pabbly)`, live state captured in
`ref/migrations/2026-10-26_docs_digest_transform.json`): match widened from
`envelope.recipient` / `to.0` to docs@ in any of the first ten To and Cc
slots (hookFilter's `equals` String()s an array, so slots are enumerated;
both feeders lowercase addresses). It never had a firm-domain exclusion and
still has none: staff can forward client mail to docs@, and a typed
`case XXXXXXXX` files it — the cost is that firm mail cc'ing docs@ gets filed
too (unsorted, sender = staff).

**Shadow** — `ref/migrations/2026-11-06_docs_intake_shadow.console.js`:
creates + publishes the workflow (step 1 → it@ / user 6), extends the
transform's last line with the reference (digest fields proven unchanged on
a real execution), adds the `workflow` action beside the digest action 27.
NOT dry: from the first docs@ email the files are filed for real while SB
still gets the old digest. **Cutover** —
`ref/migrations/2026-11-06_docs_intake_cutover.console.js`, after 3–5 days:
refuses while no shadow run exists or one failed; step 1 → SB / user 5
(draft, only step 1 changed, publish), then deletes action 27, cuts the
transform to the reference, renames the rule "docs@ intake". Recipient
first, so a stop mid-run duplicates one email rather than losing one.

Tests: `tests/emailAttachments.workflow.test.js` reads the JSON blocks out of
both scripts and runs the workflow on the real engine (stubbed filing
service, mail and request_decision; the decision params then pass the real
request_decision's checks), the save + publish validators, MATCH on the
production matcher, and both transforms in the guest — the shadow edit
against the captured live code. Both scripts were dry-run verbatim through
the real shell `apiSend` against the real routers on a local MySQL holding
the prod schema and the live rule/executions, with refusal controls.

## 8. Deferred / follow-ups

- **S3, Comms UI**: an attachment chip shows "Filed → case X" from
  `mail_attachment_filings`; a "File all to case" action for unsorted mail.
- **One notice per burst** (parked, Fred 2026-11-06): add `notified_at`; the
  first email from a sender opens a ~15-min window that one atomic UPDATE
  claims, and one email covers the burst. Conflicts with per-message decision
  buttons — revisit after S2 has run.
- Refile leaves the emptied unsorted day folder behind.
