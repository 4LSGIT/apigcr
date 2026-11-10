# EMAIL_ATTACHMENTS_DESIGN — email attachments → Dropbox (docs@ first)

Status: S1 (plumbing) landed 2026-11-06 (cdf2050). S2 (the docs@ workflow)
landed 2026-11-06 (367d8b3); shadow live since 2026-11-06 (workflow 55, rule
24 action 28); cut over to SB 2026-11-08. S2b (2026-11-08): case numbers and
legacy ids name the case. S2c (2026-11-09): per-file links, the Docs Needed
list. S2d (2026-11-09): one notice per burst (§8). S3 (2026-11-10): File
attachments from Comms, any mailbox (§9).
Rulings: Fred, 2026-11-06, 2026-11-08, 2026-11-09 and 2026-11-10 (§1, §9).
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
- **One notice per burst** (Fred, 2026-11-09; parked 2026-11-06): files are
  still filed the moment each email arrives; the NOTICE waits until the
  sender has been quiet for 5 minutes (measured at ingest), or 30 minutes
  after the burst's first un-notified email. One pick-the-case email per
  burst, whose answer moves all of the burst's unsorted files (§8).
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
- `fileableParts(row, {staffPick, blocked})` — kept: extension on the
  client-upload allowlist (`portalDocsService.ALLOWED_EXTENSIONS`; no
  extension → from the MIME type; a person's pick also names `.zip` / `.eml` /
  `.msg` by type); skipped with a reason: cid-referenced inline images under
  20 KB (signature logos — NOT every inline image: Apple Mail sends
  photographed documents as inline images, `mail_messages` 3206), types off
  the allowlist (`.eml`, `.ics`, `.zip`, `.exe`, …), estimated over 40 MB. A
  skipped type a PERSON may still file carries `optional` (+ `ext`,
  `est_bytes`); one on the never-file list carries `blocked`. With
  `staffPick` (Comms, §9) any type but the blocked ones is kept.
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
| no id, S empty | none, `no_open_case` (known contact) / `unknown_sender` / `firm_sender` |

A sender on a firm address — a firm domain (`email_domains`, subdomains too)
or a YisraCase mailbox's own address — is nobody's client: S is empty and
contact is null, so only a case the email names matches (`firm_sender`
otherwise). Staff forwarding a client's documents is not the client sending
them; Stuart's own contact is Primary on his personal cases (2026-11-10).

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

`parts` (Comms, §9): only these part ids are filed, a person's pick (any
type but the blocked ones); the rest are reported `not_selected` ("left out
by the person who filed these"). `reason` replaces the notice's default
"why it went there" line.

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

The job it hands staff is "review, rename, move, and check it off their list"
(Fred, 2026-11-09):
- **Each file links to itself**: `files[].link` = the folder's shared link +
  `&preview=<name>` — Dropbox opens that file inside the folder view. No
  shared link per file: the folder links are PUBLIC (`dropboxService.
  getOrCreateSharedLink`, as `cases.case_dropbox` always was), and one per file
  would multiply capability URLs. Only for files in that folder; a file
  renamed since just opens the folder.
- **The Docs Needed list** (`docs_checklist`), when a case was chosen, a file
  landed and the case has one — `portalDocsService.listDocs`' scope
  (`checklists` tag `docs_needed`, or the legacy title `Docs Needed`): a link
  to the case's Checklists tab (`lib/shellLinks.caseLink(base, id,
  'checklists')` → `/?files=c<id>~checklists&open=file:0`), "N of M still
  needed" with the first 12 open items, and "check them off the Docs Needed
  list" in the instructions. The pick-the-case path sends no notice after the
  move, so it carries no list link (the candidates' case links open the case).
  Live 2026-11-09: 280 cases carry a docs list.
Every email-derived string is HTML-escaped, square brackets included
(`&#91;`): request_decision expands `[[…]]` tokens in email_html and subject
and throws on an unknown `[[respond_url:X]]`, so mail text must never carry
one in. The subject breaks `[[`/`]]` apart.

## 6. Internal functions — `lib/internal_functions/emailAttachments.js`

| Function | Engines | CTA |
|---|---|---|
| `email_case_match` | both | **denied** — a read returning a client's cases |
| `email_attachments_file` | workflow only | eligible (SU-minted, frozen plans) |
| `email_attachments_digest` | workflow only | **denied** — plumbing: claims a sender's queued notices (§8) |
| `email_attachments_refile` | workflow only | eligible — "file these to case X" is its point; a burst by `digest_key` + `digest_of` |

Reference params on the first three: `mail_message_id` | `mailbox_id`+`folder`+`uid`
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
fields). The table is **v2**, the notice-per-email version S2 shipped; v3
(§8) wraps steps 3–6 around it for the burst digest:

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

## 8. S2d — one notice per burst (`emailAttachmentDigestService`)

**Why** (live 2026-11-08): a client emailed docs@ 26 times in 43 minutes, one
phone photo at a time — 26 notices to SB. The files must still be filed at
once (staff may open the case meanwhile); only the notice waits.

**The rule** (Fred, 2026-11-09). A burst = a sender's emails (From address,
lowercased; an email without one is never grouped) whose notice has not gone
out yet, under one `digest_key`. It ends when the sender has sent nothing new
for **5 minutes** — measured on `mail_messages.ingested_at`, when the worker
stored the mail, not the sender's Date header — or **30 minutes** after its
oldest email, whichever comes first. Then one notice covers the burst; a
burst of one is the single-email notice of §5, byte for byte. The mailbox
worker's 2-minute tick (2026-11, `ref/INFRA_GCP.md`) is what makes a 5-minute
quiet time meaningful: at the old 5-minute tick the next email of a burst
could land just past the window.

**State** — `mail_attachment_notices` (`ref/migrations/2026-11-09_mail_attachment_notices.sql`),
one row per (digest, email): `sender`, `ingested_at`, `result` (MEDIUMTEXT
JSON — not a JSON column: email-derived text cut at fixed lengths can split a
surrogate pair, which a JSON column refuses), `digest_of` + `notified_at`
once claimed. Rows sharing `digest_of` (the claiming email) ARE the burst.

**Mechanics** — no scheduler of its own; every email's own execution does it:
- `email_attachments_file` with `digest_key` writes a **placeholder** (result
  NULL) before fetching the files, then the result (plus the sender's words
  cut as the notice cuts them, and the notice wording). A placeholder counts
  as the newest email — a burst still being filed holds its notice back — for
  15 minutes at most (a dead filing must not hold a sender's notices).
- `email_attachments_digest` → `wait` (`wait` = a duration string, never under
  65 s — over the engine's 60-s pause floor, so the loop is never a
  pause-free loop), `send` (this execution sends the burst's notice) or `done`
  (another execution's notice covers this email). Everyone waits until the
  burst should end — the sooner of the newest email's quiet time and the
  oldest's cap; the first to ask after that claims every pending row with a
  result. The newest email's execution normally sends; if it died, the next
  one to wake does — no burst depends on one execution surviving.
- The claim: one transaction; the sender's pending rows are locked FOR UPDATE
  in ONE statement (index order — two checks cannot deadlock), then stamped.
  A re-check of a row this same email claimed (a retried step) sends the
  same burst again; the claim never moves.
- Several emails: `emailAttachmentNotice.renderDigest` — one where-box per
  destination (each case, with its Docs Needed list read at digest time;
  Unsorted; what could not be filed), then every email oldest first with its
  files and a short excerpt (600 chars). Subject `<prefix><who> (N files from
  M emails) — filed to case X` / `— filed to cases X, Y` / `— UNSORTED, needs
  a case` / `— NOT FILED` / `(M emails, no files)`.
- One decision per burst: options = every candidate any unsorted email
  offered, once, then "Leave them in Unsorted". The answer goes to
  `email_attachments_refile` with `digest_key` + `digest_of`: every UNSORTED
  email of the burst moves; its case-filed emails stay where they are.

**Workflow "docs@ intake" v3** — `ref/migrations/2026-11-09_docs_intake_digest.console.js`
(assert-first: the published v2 exactly, or a draft that already is v3;
preflight = a test-step of the digest on a never-queued message must answer
NOT_QUEUED, i.e. the backend and the table are live; PUT 1–10, append
11–14, verify, publish, re-read):

| # | Step | Notes |
|---|---|---|
| 1 | `noop` recipient | unchanged (SB / user 5) |
| 2 | `email_attachments_file` → `filing` | + `digest_key: 'docs@'`; no set_vars. retry_then_abort ×2 |
| 3 | `email_attachments_digest` → `digest` | `{{filing.mail_message_id}}`, `docs@`, quiet `5m`, cap `30m`; set_vars `digest_action`, `needs_decision`. retry_then_abort ×2 |
| 4 | `evaluate_condition` `digest_action == 'wait'` → 5, else 6 | |
| 5 | `wait_for` `{{digest.wait}}` → 3 | the loop's pause |
| 6 | `evaluate_condition` `digest_action == 'send'` → 7, else end | `done`: another execution sends |
| 7–10 | as v2 3–6, on `digest.*` | notice / request_decision with `{{digest.decision_options}}`, `{{digest.notice_html_decision}}`, question names `{{digest.from.email}}` |
| 11 | `chosen_case != 'unsorted'` → 12, else end | |
| 12 | `email_attachments_refile` `digest_key` + `{{digest.digest_of}}` → `{{chosen_case}}` | set_vars `refile_failed`. retry_then_abort ×1 |
| 13–14 | as v2 9–10 | "NOT MOVED" names `{{digest.unsorted_folder_path}}` / `_link` and notice `{{digest.digest_of}}` |

Executions already running on v2 (an open pick-the-case) finish on v2.

Tests: `tests/emailAttachments.mysql.test.js` "burst digest" (the rule on
real MySQL — rows aged in SQL: quiet, cap, placeholders live and stale,
senders/digests never mixed, a six-way race → one send, the burst decision
and refile, Docs Needed read late); `tests/emailAttachmentsDigest.unit.test.js`
(renderDigest, the passthrough, option merging); `tests/emailAttachments.workflow.test.js`
"v3" (the loop, send/done, the burst decision on the real engine; v3's base
= the v2 the two S2 scripts left live; save + publish gates). The console
script was dry-run verbatim through the real shell `apiSend` against the
real routers on a local MySQL holding live workflow 55: GO, re-run = nothing
to do, NO-GO without the table, stop-before-publish → re-run publishes,
stop-mid-draft → re-run refuses until the draft is discarded.

## 9. S3 — File attachments from Comms (`emailAttachmentCommsService`)

Why (live, 2026-11-10): over 60 days about 69 client emails with files went
to staff inboxes and only 37 to docs@. Processing every inbound email is
wrong (most mail in a staff box is not a client's documents); forwarding them
one by one to docs@ is slow. So Comms files them: from ANY mailbox, a person
picks the emails, the case and the files, and the docs@ engine (§4) does the
filing — same folders, names, registry and duplicate guard.

Rulings (Fred, 2026-11-10):
- **Any mailbox**; **anyone who can READ the email** may file its
  attachments (`mailReadService.loadVisible` — grant, SU, the attorney read
  bypass, an alias slice). An unreadable email is a 404 (no oracle).
- **A person may file any type** except the never-file list —
  `email_attachments_blocked_ext` (a list of extensions; blank or nothing
  usable in it = programs, scripts, installers, disk images, shortcuts —
  `mailAttachmentService.DEFAULT_BLOCKED_EXTENSIONS`; blank never unblocks
  everything).
- **A second confirmation** for a type on `email_attachments_confirm_ext`
  (blank = every type off the client-upload allowlist) or a file over
  `email_attachments_confirm_mb` (blank = 15, 0 = never) — enforced by the
  SERVER (409 `needs_confirmation` until the part is in `confirm`), not only
  the dialog.
- **Link the email to the case** — on by default (the "Link to case"
  action, `mailReadService.caseLink`).
- **The review notice** goes to `email_attachments_reviewer` (a user; SB) —
  not when the reviewer is the one filing, nor when no reviewer is set.
- **Duplicates**: a file with the same name (letter case aside) and the same
  ENCODED size as one already filed to the target case, or earlier in the
  same selection, starts unticked and says so.
- **Move what docs@ put in Unsorted**: an email's parts filed elsewhere can be
  moved into the chosen case (`refileMessageAttachments` — the whole email's
  filed parts together). Out of Unsorted it starts ticked; out of ANOTHER
  case it is offered, never ticked.
- **Any folder in the case folder** (S3b): default `Client Uploads/Emailed
  YYMMDD`; or one of the case folder's subfolders, or a typed one (created
  if missing) — for what the client did not send (a signed agreement,
  discovery, a court paper). Taken EXACTLY (`emailAttachmentFilingService.
  exactFolder`): the firm's folder names carry leading spaces on purpose
  (" 012 - Supplemental Responses"), so nothing is trimmed — a cleaned name
  would create a second folder beside the real one; what could leave the
  case folder or that Windows sync mangles is refused instead (`.` / `..`,
  `\ : * ? " < > |`, control characters, a blank name, a name ending in a
  dot or a space, > 6 levels, > 120 characters a name). A move goes to the
  same folder.
- **The default folder takes the case folder's own names** (S3c, Fred
  2026-11-10: "don't hardcode that, it's firm specific"): the rendered
  template is compared with the folders already in the case folder, level by
  level (`emailAttachmentFilingService.alignCaseFolder`) — an exact name wins,
  else one equal to it with the edges trimmed and letter case ignored; no
  match at a level = that level and below as written (created). So a case
  holding " Client Uploads" gets its files there, not in a second
  "Client Uploads". It runs for docs@ (§4) and refile too, once per email and
  only when a file is uploaded (one listing per level); a case with no folder
  link or a Dropbox failure files as written. A person's exact folder is never
  compared.
- **Names in the subject** (S3b): an email the matcher places nowhere (no
  case, no candidates — an Adobe Sign notice "… between Stuart Sandweiss and
  michele boren is Signed and Filed!") offers the cases of clients (Primary /
  Secondary) whose first AND last name are both words of the subject —
  suggestions only, never the target. Never the firm's own people: a contact
  named exactly like a staff user, or holding a firm-address email
  (`isFirmSender`), is left out (the attorney is named in every e-sign
  subject).

Routes (`routes/api.mail.js`, staff JWT):

| Route | Does |
|---|---|
| `POST /api/mail/attachments/preview` `{message_ids ≤50, case_id?}` | Read-only. Per email: every attachment as `file` (allowlist — ticked unless filed or a duplicate) / `optional` (any other type a person may file — unticked) / `skip` (`inline_image`, `too_large`, `blocked`, `type_not_allowed`), with `filed`, `duplicate`, `confirm` ('type' / 'size'), the matcher's verdict, and `move`. Target = `case_id`, else the ONE case every email with files matches (`suggested`). Also the candidates, the reviewer (`is_you`), the policy. The target and every candidate are full case cards (S3c): number, type, **subtype** (one client's two Bankruptcy cases differ only there), stage, caption, Primary client. `mailbox_id` is the box the reader sees it in (an alias's id for a slice reader — the part route's URL). |
| `POST /api/mail/attachments/folders` `{case_id}` | The case folder's subfolders for the folder choice: ONE recursive Dropbox listing of `cases.case_dropbox`, folders only, relative, exact names, ≤ 4 levels, ≤ 400. `reason`: `no_case_folder` / `unavailable` (Dropbox did not answer — type the folder). Any staff member (what `/api/dropbox/list` already gives). |
| `POST /api/mail/messages/:id/attachments/file` `{case_id, parts, confirm?, move?, link?, batch?, folder?}` | ONE email: move (when asked) → file the picks (`fileMessageAttachments` target `case`, `filed_by` the person, reason "Filed to case X by <name> from Comms.") → link. One request per email: the dialog shows progress and a retry re-runs one email (the registry makes every part idempotent). 400 a part not on the email / nothing to do; 422 a part that cannot be filed (says why); 409 `needs_confirmation`. With `batch`, the result is queued under digest key `comms-<batch>` (`mail_attachment_notices`, §8's table). The answer carries `log_id` when linked; `public/js/yc-sync.js` announces `doclink:case:<id>` (a file landed or moved in) and, when linked, case-link's `mail:<id>` + `comms:case:<id>` — an open case's Documents and Comms tabs refresh. |
| `POST /api/mail/attachments/notice` `{batch}` | Every email of the batch must be readable by the caller (checked before anything is claimed — a batch id is not a capability); claims the queued results and sends the reviewer ONE notice PER SENDER (§8's `digestOutput` — the renderer speaks for one sender), From `email_automations`, subject `Filed from Comms — …`, title "Filed by <name>". `{sent:false, reason}`: `you_are_the_reviewer` / `no_reviewer` (claimed all the same) / `nothing_to_report`. A dialog closed before this call leaves its rows unclaimed: no notice for that batch. |

Comms (`public/comms.html`): a **File to case…** button under every email's
attachments, an attachment's **Save** button (= the dialog with only that
file ticked; the viewer's Save to case too), a link on a conversation with
several emails with files, and the list's **Select** mode (☑ Select in the
list's top bar beside Filters, the icon alone without the rail; a click ticks;
All shown; Same sender; ≤ 50 at a time). The dialog: the case (suggested,
a candidate — "Suggested because the subject names …" for a name-based one —
or the case picker over it), the folder (default, or another: the case
folder's subfolders read once, or typed), per email its attachments with a
checkbox each and their tags, the move row, Link and Notify, the confirm step,
per-email results and a summary; closing it re-reads the list and the open
conversation. A file too large for the server (> 40 MB estimated) can still
be uploaded straight to the case folder by the browser (the documents upload
flow) — not recorded as filed. Every attachment shows **Filed** once it is in
the registry under its own row or any stored copy of the same email (same
RFC Message-ID, any mailbox — `mailReadService.attachFiled`), and the
**Not filed** filter (`not_filed`) lists mail with files none of which is
filed, by the same copy rule.
Ask Casey files one email's attachments through the same route — plan doc
`ref/ASK_CASEY_ACTIONS_PLAN.md` A13b (the `mail.attachments.file.v1` card, after
its `mail.attachments.preview` read of this preview).

Tests: `tests/emailAttachments.mysql.test.js` "Comms filing (S3)" (the
preview's classes, policy and reviewer; the suggestion; filed / duplicates /
moves; fileOne's picks, confirm, blocked, refusals; move; access incl. an
alias slice; link; the batch notice per sender; Not filed + Filed on real
MySQL); `tests/emailAttachmentsComms.routes.test.js` (guard, 409 passthrough);
`tests/emailAttachmentsComms.pane.test.js` (the dialog, the select mode, the
card); the mobile survey's `dialog:comms-thread-files`,
`dialog:comms-file-attachments`, `dialog:comms-select`. S3b: the mysql
"S3b folder / folders / names" tests, `exactFolder` in
`tests/emailAttachments.unit.test.js`, the pane's folder and names tests.

## 10. Deferred / follow-ups

- Refile leaves the emptied unsorted day folder behind.
- A burst's notice names a sender's emails only; mail from the same client's
  second address is its own burst.
- Comms: a batch whose dialog was closed mid-run sends no notice (its queued
  rows stay unclaimed under `comms-<batch>`); nothing prunes those rows.
