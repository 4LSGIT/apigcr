# YisraCase — AI Context Document
# Last updated: 2026-09-14 — compressed to skeleton form (~900 lines from ~3,100); §0 deltas folded into body; per-column facts moved to schema COMMENTs in ref/database.sql

<!-- ================= CURRENCY ================= -->
<!-- Reviewed-through: 9821110 (docs review #2, 2026-10-13). This doc is a   -->
<!-- SKELETON: what each subsystem is + the non-guessable invariants +       -->
<!-- pointers. Depth lives in manual/, schema truth in ref/database.sql      -->
<!-- (read its COMMENTs), route truth in ref/routes.md, working rules in     -->
<!-- CLAUDE.md, deferred work in ref/plans.md.                               -->
<!-- KNOWN MISSING SECTIONS (debt: docs/20260914_coverage_gaps): e-sign,     -->
<!-- portal, YisraForms/templates, reports, pipeline engine, document sync,  -->
<!-- booking landings. manual/ is authoritative for those meanwhile.        -->
<!-- CONSCIOUS DEFERRALS (review #2): the seven sections above --            -->
<!-- large, one arc of their own; U9b calendar-tab doc deltas stay with the  -->
<!-- U9b arc (its manual chapter + bus-design E12 supersession).             -->
<!-- Tools (29) is fully filed.                                              -->
<!-- Doc-debt queue: scratch ns=docs. File doc≠code divergences there at    -->
<!-- discovery; the weekly docs review (DOCS_REVIEW.md) drains it and       -->
<!-- updates this block.                                                     -->
<!-- ============================================ -->

## 0. RECENT DELTAS AWAITING A SECTION HOME

*Entries live here only until their subsystem section exists (see coverage
gaps above); everything else from the September delta pass is folded into the
body. Governing migrations in `ref/migrations/`.*

- **Court NEF dedupe + quiet empty-pool cancel (10-13):** `court_extract`
  claims sha256(normWs(subject)+'\n'+normWs(body)) in `court_email_hashes`
  BEFORE the AI call; a different message_id with an owned hash = duplicate
  delivery → no AI call, `court_ai_log` outcome 'none' /
  `duplicate_of:<owner>` on the copy's id; the same id = Re-extract, proceeds.
  `-test-` ids bypass; errors fail open; no time window. Covers
  `court_extract` ONLY — under the §27 cross-source double-fire it skips the
  second copy when the texts normalize equal; every other Layer-3 rule still
  fires twice. Executor `cancel_event` with no match and NO Scheduled event
  on the case (empty pool or only dead rows) skips `cancel_nothing_tracked`
  (+ dead-pool `event_ids`), no review; no match with a Scheduled event
  present still queues `cancel_no_match`. Manual:
  `manual/05-Subsystems/10-court-pipeline.md`.

- **Comms S2P (10-13):** `mail_sends` is the hub-send ATTRIBUTION source (one
  row per send, best-effort post-dispatch; thread reads join it by
  `message_id` / `provider_id`, latest `sent_at` wins) and carries the
  composer Case field's state (`case_link_state`: pending/linked/failed).
  `log_status` resolution (mailReadService.logStatusFor) is READ-ONLY — it
  reuses priorLogId's bridge keys for display; only `caseLink` writes stamps
  or log rows. New one-time job type **`mail_sent_case_link`**
  (lib/job_executor → mailboxSendService.linkSentCase): find-copy-first (the
  read-seed's probe), then `caseLink` AS THE SENDER; 409/not-stored retry,
  403/404 and the final attempt are terminal (ONE `error` alert). The list
  merges copies per email AFTER the raw page cut — the keyset cursor stays
  the last RAW row's `(date, id)`. Design: `ref/MAILBOX_SYSTEM_DESIGN.md`
  §4.4 "As built (S2P)"; operators: `manual/08-Admin-Tools/08-mailboxes.md`.

- **Maintenance mode / hook spool (10-12):** `MAINTENANCE_MODE=1` on a revision
  = write freeze. `lib/maintenance.js` gate (mounted in `server.js` after cors +
  build stamp, BEFORE body parsers / static / the 5xx observer — order is tested)
  503s everything except `POST /hooks/:slug`, which captures the authenticated
  event to the PAUSED Cloud Tasks queue `yc-hook-spool` (`lib/hookSpool.js`)
  instead of executing; replay is `POST /internal/hook-replay`
  (`routes/internal/hookReplay.js`, internal key only, idempotent on
  `raw_input.meta.spool_id`). Operator procedure `ref/INFRA_GCP.md` §9; hook-side
  behaviour `manual/03-YisraFlow/09-yisrahook.md`. Invariants:
  - **`hookSpool.put()` REJECTS on failure — the opposite of `lib/taskQueue.js`**
    (which swallows). During a freeze the task is the only copy of the event;
    the receiver turns a rejection into a 503 so the sender retries. It also
    ignores the `cloud_tasks_enabled` kill switch.
  - **A new MACHINE-facing entry point that acks-then-works (2xx regardless of
    its own failure) needs its own capture path** or it loses events during a
    freeze — today the hook receiver is the only such route. Everything else is
    safe to 503: it retries (Gmail Apps Script, schedulers, Cloud Tasks) or is a
    caller that reads the response. Landing-page form posts
    (`routes/pageLanding.js`, "always 303") are the same shape with a PERSON on
    the other end: pages are not served during a freeze and a stale tab's POST
    gets the maintenance page.
  - **The spool queue has unlimited attempts (`max-attempts -1`) on purpose.**
    Cloud Tasks deletes a task when its attempts run out, on any status; here a
    task must leave the queue only on a 2xx from the replay route. So that
    route's 2xx means "this event is finished with" — never answer 2xx for
    something that should be retried.
  - The gate does not stop non-Express writers; a maintenance revision runs on
    the read-only DB user as the hard lock.
- **Comms hub read side is live (mailbox S2, 10-09):** `routes/api.mail.js`
  → `services/mailbox/mailReadService.js`; pane `public/comms.html` (the
  shell's Comms tab `tabComms` + sidebar badge — `commsBadgeSet`/`Refresh` in
  index.html, fed by the pane; Settings moved to More Features 10-11); design `ref/MAILBOX_SYSTEM_DESIGN.md` §4.3/§4.4 "As built";
  operators `manual/08-Admin-Tools/08-mailboxes.md`. What a session touching
  unrelated code needs to know:
  - **Mail HTML has ONE sink:** `public/js/mailRender.js` → the `srcdoc` of an
    iframe whose sandbox has no `allow-scripts`/`allow-same-origin`, after the
    vendored DOMPurify (`public/js/vendor/purify-3.4.16.min.js`, hash-pinned in
    `tests/mailboxS2.render.test.js`), with a CSP `<meta>` first. Never render
    `body_html` any other way; `body_html`/`body_text` leave the API only from
    the thread / single-message routes, never the list.
  - **`users.roles` 'attorney' = READ on every mailbox** (`mailboxService.roleBypass`,
    DB-sourced). READ only: `getAccess` keeps `su:false` and send/manage from
    the grant row — routes that test `access.su` still mean SU.
  - **`logService.createLogEntry` takes an optional `date`** (UTC instant →
    EST5EDT like NOW()); omitted = NOW(), unchanged for every other caller.
    The case-link route uses it for store-only mail logged after the fact.
  - **Case-link is the ONE cross-source log match** (`mailReadService.priorLogId`):
    before creating a log row for stored mail it reuses any live log row an
    `email_ingest_executions` row carries under the RFC Message-ID or a
    provider id (gmail-firm keys Workspace mail by Gmail id = `provider_id`).
    The pipeline itself still dedupes per source only (§27).
  - **A Content-ID does not make an attachment inline** — Gmail gives every
    attachment one. Inline = an image the HTML body references as `cid:`
    (`mailReadService.markInline`; the API's `inline` flag). Anything listing
    or forwarding attachments (S3 compose) uses that flag, never `cid`.
  - **`mail_image_senders` is read on EVERY Comms thread / message open**
    (`markTrust`) — per-user "always show images from" addresses. Migration
    `2026-10-09_mail_image_senders.sql` goes BEFORE that backend.
  - **Viewing a mail attachment in-page means a `blob:` URL on the APP
    origin** — comms.html re-types the blob itself (PDF / raster images only,
    `viewKind`); never widen that list to SVG/HTML or trust the part route's
    type. Saving one to a case reuses `/api/documents/upload-link` →
    Dropbox → `/upload-commit` (no new server path).
  - **`mailboxes.color`** (migration `2026-10-09_mailbox_s2.sql`): stored
    `#rrggbb` per box, cosmetic, manager-editable like `display_name`; random
    unused `PALETTE` default on create. Every mailbox projection selects it —
    so the S2 backend needs the column (SQL first). Palette, validation and
    the per-theme drawing rule live in ONE module shared by server and panes:
    `public/js/mailboxColor.js` (its SURFACES mirror `theme.css`, test-pinned —
    retune the surfaces there and that test tells you to follow).
  - **Per-row subquery filters on the list are SCALAR, never `EXISTS`**
    (`client_only`, `has_files`: `0 < (SELECT COUNT(*) …)`). MySQL flattens
    an EXISTS into a semi-join: measured, that lost the per-branch backward
    index walk AND made mark-all's `INSERT … SELECT` mark nothing while the
    list was right. Per-row address lookups go through a `JSON_TABLE`
    JOINed to `contact_emails` (an index probe); `col IN (<per-row exprs>)`
    scans the table per row. `JSON_TABLE` string columns take the
    CONNECTION collation unless declared — declare `utf8mb4_general_ci`.
  - **"Inbox" is `mail_messages.in_inbox`** (mailbox S2-L, 10-11): a
    generated VIRTUAL column — folder `INBOX` OR the row's Gmail label snapshot
    (`gmail_labels`, X-GM-LABELS stored at ingest) holds `\Inbox` — indexed
    `(mailbox_id, in_inbox, date)`. Every Inbox-scoped read (list, summary /
    sidebar badge, view counts, mark-all) goes through it; never re-derive it
    from `folder`. Labels are a snapshot (archiving in Gmail later is not
    seen); the SU route `POST /api/mailboxes/:id/labels/snapshot` re-fetches
    them under the ingest lock. The label's backslash comes from
    `CONVERT(CHAR(92) USING utf8mb4)`: the shorter `CHAR(92 USING …)` is
    printed back WITHOUT the USING, and the stored column then matches
    nothing (measured 8.0 + 8.4). Migration `2026-10-11_mailbox_s2l_labels.sql` goes BEFORE
    that backend (the worker INSERTs `gmail_labels`).
  - **A Gmail draft is the `\Draft` LABEL, not the flag** (10-11, live):
    seen through All Mail, Gmail sets no `\Draft` flag on drafts, so the
    flag-only DRAFT GUARD stored one (mailbox 2, FLAGS `\Seen`, labels
    `["\Draft"]`). The guard is now flag OR label — one definition,
    `imapTransport.hasDraftLabel`, read by the transport (no body download)
    and by `mailboxIngestService.isDraft`. The S1-G guard's real-server
    proof ran on Dovecot; the Gmail runbook's step-3c `draft_labelled` gate
    caught it. Gmail IMAP semantics need a check on Gmail itself.
  - **`OrphanAdoptDialog(value, type, onDone, opts)`** (scripts.js) takes
    `opts.earliest` (another first sighting; the start date defaults to the
    earlier of it and the log's) and `opts.name` (search + Create-new
    prefill). Comms' "add to client" is its second caller; the log tab
    passes no opts.
- **Comms hub send side is live (mailbox S3, 10-11):** `GET /api/mail/identities`,
  `GET /api/mail/messages/:id/reply`, `POST /api/mail/send` in `routes/api.mail.js`
  → `services/mailbox/mailboxSendService.js`; design `ref/MAILBOX_SYSTEM_DESIGN.md`
  §4.2 "As built (S3)"; operators `manual/08-Admin-Tools/08-mailboxes.md`
  "Sending mail". What a session touching unrelated code needs to know:
  - **`emailService.sendEmailDirect` takes HUB-ONLY options** (`cc`, `bcc`,
    `in_reply_to`, `references`, `message_id`, `thread_id`); the public
    `sendEmail` strips them (`HUB_ONLY_OPTIONS`) and the smtp / gmail adapters
    set each header only when its option is present — every automation caller
    builds the message it always did (`tests/mailboxS3.adapters.test.js` pins
    the baseline). The grant check stays OUT of emailService (D6: on the
    interactive route only; automation sends are grant-blind by design).
  - **`imapTransport.appendSent` is the transport's one writer** (APPEND to
    the Sent folder) and refuses any X-GM-EXT-1 server — Gmail files its own
    sends; a copy would double-store and double-emit. The send service also
    never calls it for a `gmail` credential.
  - **`scheduled_jobs` `data.type` `mail_sent_read_seed`** (`one_time`,
    dispatched in `lib/job_executor`): marks a hub send's stored copy read for
    its sender once ingest has stored it; throws to retry, completes quietly
    on its last attempt.
  - **List filter `sent_only`** (`mailReadService.SENT_WHERE`): the Gmail
    `\Sent` label is a BOUND parameter — written into SQL text as `'\Sent'`
    MySQL eats the backslash and it matches nothing.
  - Knobs: `app_settings.mail_send_daily_budget` (`{"gmail":n,"smtp":n}`;
    defaults 1500 / 300 per sending account, counted from `email_log`); alert
    kinds `mailbox_send_budget` (error) / `mailbox_send_append_failed`
    (warning); `admin_audit_log` tool `mail_send`.
  - **Alias (send-only) boxes** (S3.1 + S3-R, 10-12): a mailbox row with
    `alias_of` is a send-as ALIAS of that parent box — THE send-only
    definition (`mailReadService.SEND_ONLY_SQL`; the old Ingest-off+no-secret
    inference is dead). Created in the pane's "send-as address" mode:
    connection copied from the parent, ingest forced off, `alias_of`
    SU-re-pointable (connection re-copied; never cleared, never on a full
    box), `alias_label` (the Gmail filter label, user labels only)
    SU-editable; connection/ingest/emit fields refused on alias rows.
    `mailboxService.assertSinglePoller` still refuses a second active,
    ingest-enabled box on one IMAP host + login. A `can_read` grant on an
    alias reads its SLICE of the parent (`mailReadService` ALIAS SLICE:
    labelled `alias_label` OR the address pinned in From/To/Cc; From = the
    alias = the slice's Sent, everything else its Inbox — `in_inbox` never
    applies, and neither does `\Sent`: internal mail TO the alias is \Sent
    to Gmail); slice rows PRESENT as the alias box (list binds the alias
    id, thread re-tags, part route accepts the alias id and streams through
    the PARENT's connection), the summary row carries the slice's Inbox
    counts (the sidebar badge counts them — except next to a readable
    parent: the totals skip an alias whose parent is in the set, as the
    list does), and the sent-copy read seed probes the alias's parent.
    Engine twin `tests/mailboxS3R.mysql.test.js` holds `sliceMatchJs` (the
    JS twin loadVisible + the part route apply) to the SQL. Reply identity = the address the mail came from / was sent to,
    before its box — over an SU's explicit grant rows first (S3.2); "own"
    mail is judged against that identity. Identities list real boxes first
    (`send_only` flag; `mailReadService.sendOnlyIds` is the one rule).
    Design §4.2 "Per-address READING"; migration
    `ref/migrations/2026-10-12_mailbox_s3r_alias.sql`.
  - **`/mailbox-ingest` is also the comms hub's Refresh** (10-12): staff-JWT
    runs throttled to one per 30 s for all staff, non-SU callers get counts
    only (`routes/mailboxIngest.js`); the scheduler's x-api-key tick is
    never throttled.
- **Comms Phone tab + phone-line grants are live (mailbox S-PH, 10-12):**
  `routes/api.phoneComms.js` → `services/phoneCommsService.js`, access via
  `mailboxService` (one chokepoint, both channels); design
  `ref/MAILBOX_SYSTEM_DESIGN.md` §4.4 "As built (S-PH)"; operators
  `manual/08-Admin-Tools/08-mailboxes.md` "Phone lines — Comms". What a
  session touching unrelated code needs to know:
  - **`/internal/sms/send` and `/internal/mms/send` are grant-checked for
    STAFF JWTs** (`can_send` on the `from` line, `staffSendGate`); API-key
    callers stay grant-blind (D6). They are the live staff send path
    (communicate.html, sendingform*.html — whose From lists go through
    `public/js/phoneSendable.js`). A new staff SMS surface goes through the
    same gate; a new automation path does not.
  - **`phone_event_log.line_number`** (generated, `(line_number,
    processed_at)` index) is THE line attribution (incoming → `to_number`,
    else `from_number`). Name the COLUMN, not the IF() — generated-column
    substitution is collation-fragile; per-line walks FORCE the index.
    `phoneIngest*` never writes it (its INSERT names columns).
  - **A phone conversation is texts AND calls** — the list
    (`GET …/conversations`, `last.kind`) and the thread
    (`GET …/conversations/:party`, items `kind: 'sms'|'call'`); a number that
    only called has one. Calls are ingested when they END, so the pane
    orders a thread by `at` (the call's start), not the server's
    `processed_at` order. **All numbers** (`GET /api/phone-lines/all/…`,
    every READABLE line at once, items tagged `line_id`) is routed BEFORE
    the `/:id` routes — keep it first; sending from it posts to the picked
    line's own `/:id/sms`.
  - **The attorney READ bypass covers phone lines**; send/manage never
    bypass. **Grant routes pin their channel** — a mailbox route refuses a
    `phone_line` body and vice versa (the ids overlap).
  - **`jwt_api_audit_log` stores no request VALUES** (SEC-2): `body` and
    `query_params` are per-key SHAPES — `{"to":"[str 11]","ids":"[arr 3]",
    "password":"[secret]"}`, one level, keys kept, values never
    (`lib/auditShape.js` `shapeTop`; history rewritten by
    `scripts/sec2ScrubAuditShapes.js`). The two URL strings — route and
    Referer — keep their diagnostic shape with credential-named params
    (SEC-1, `redactUrlParams`) and the search term `q` (B2,
    `redactSearchParams`) redacted. The table is in `SENSITIVE_TABLES`
    (SEC-3: readable only by a `sql.ro.sensitive` session key).
  - `routes/internal/phoneTest.js` is gone. Migration
    `2026-10-12_phone_sph.sql` goes BEFORE the backend (it seeds the
    default-line grants the gate needs).
- **CTA links are live end to end (10-07, arc S0–S4):** SU-minted bearer
  links (`4lsg.com/c/<token>`) whose option buttons run frozen plans of
  registry internal functions as user 0. Design (canonical, review-folded):
  `ref/CTA_DESIGN.md`; operators: `manual/08-Admin-Tools/07-cta-links.md`;
  code: `services/ctaService.js` (substrate), `routes/ctaActions.js` (/c/),
  `routes/api.cta.js` (SU mgmt + send), `lib/ctaLinks.js` ([[tokens]]/email),
  `lib/internal_functions/cta.js` (`cta_expiry_sweep`, `create_cta`),
  `public/ctaManager.html` (Admin → CTA Links pane; mirrors `deriveState` /
  `isStaleRunning` / `CTA_FN_DENYLIST` client-side as hints only).
  What a session touching unrelated code needs to know:
  - **A new internal function with `__meta` is CTA-eligible by default**
    (unless `controlFlow`, `__`-prefixed, or in `CTA_FN_DENYLIST`). The
    explicit eligible-set test in `tests/ctaService.test.js` fails on every
    registry addition, so eligibility is a reviewed decision, not a
    surprise. Low stakes — mints are SU-gated and audited, plans are frozen
    at mint, and a runtime guard fails any step returning
    `delayed_until`/`next_step` — but decide, don't rubber-stamp.
  - **Standing rule (review R3): `cta_links`/`cta_executions` never enter
    `QUERY_DB_ALLOWED_TABLES` or `WRITE_POLICY`** — tokens and password
    hashes live there in the clear (v1 posture; hashing filed to the
    access-control arc).
  - **Clicker inputs are live (10-08, §12):** options may declare typed,
    length-capped inputs bound via `[[input:name]]` into params a function
    opens with `__meta.ctaInputParams` (snapshot:
    `tests/ctaInputs.test.js` — opening a param is the same reviewed
    decision as function eligibility) — as the param's whole value, or
    (S3i, 10-11) inline inside a `kind:'content'` param's text, never a
    recipient, and **only on SU mints** — `create_cta` text has been
    through `{{...}}` and may be a lead's words, so a marker in it stays a
    mint error. `ctaService.applyBindings` is the ONE substitution (mint
    samples and click alike): per-occurrence, one pass, function
    replacement — keep it that way. Non-html inputs bound into
    `html:true` params are escaped at substitution. Enums may carry
    page-only `display:'radio'` + `choice_labels`; the value is always the
    choice. **Landmine:** input
    `pattern`s run on V8's linear-time regex engine — the Dockerfile `CMD`'s
    `--enable-experimental-regexp-engine` is load-bearing; if the boot log
    says UNAVAILABLE, pattern-bearing mints refuse.
  - /c/ lives in ALL THREE pageLanding sets (allowed, migrated,
    credentialed), `C_POST_RE` tested before `C_VALUE_RE`; raw `plan_result`
    is SU-only (`/api/cta/:id/executions`); timeouts run via the recurring
    `cta_expiry_sweep` job (claim-first, no per-CTA jobs — PATCH never
    touches scheduled_jobs); CTA passwords are mint-scoped bcrypt secrets,
    never user passwords; workflow mints (`create_cta`) are exempt from the
    active-SU click check via `mint_source='workflow'` and refuse password
    protection and `dry_run`.
- **Custom fields are live end to end (arc S0–S6 + CFG-1, 09-24 → 10-13):** admin-defined
  fields on cases and contacts. `field_defs` is the registry; values live in
  one JSON column per entity (`cases.custom`, `contacts.custom`); a reconciler
  keeps one typed **VIRTUAL generated column named exactly the `field_key`**
  (always `cf_*`) per active def. Design: `ref/CUSTOM_FIELDS_DESIGN.md`
  (living; §7 says what shipped). Operators: `manual/05-Subsystems/13-custom-fields.md`.
  What a session touching unrelated code needs to know:
  - **`SELECT *` on `cases`/`contacts` now carries `cf_` columns** you did not
    write and cannot write — they are generated. Never UPDATE one (ER 3105);
    `mergeCases` skips them via `GENERATION_EXPRESSION <> ''`.
  - **The raw `custom` bag never travels whole**: it is on the domainEvents
    scrub list, `resolverService.BLOCKED_COLUMNS`, the report `DENIED_COLUMNS`,
    `query_db`, and stripped from the petition egress. Only NAMED `cf_`
    columns ride those surfaces. Do not "fix" that by adding the bag back.
  - **Never read or compare `custom->>'$.k'` in SQL** — the virtual column is
    the only comparison surface (a matching functional index can silently flip
    raw `->>` results; measured). `tests/customFields.s2.test.js` greps
    `lib/ services/ routes/` for it, comments included.
  - **The only writers** are `caseService.updateCase` / `contactService.updateContact`;
    `fieldDefService.splitCustomFields` + `customAssignment` compose one
    `JSON_SET`/`JSON_REMOVE` into the same UPDATE as the core columns. At
    creation the only thing written is a def's `default_value` (S6), stamped
    once by the create chokepoints below; a `cf_` key in a create payload is a
    400 — values go through PATCH.
  - **One INSERT per table:** `caseService.createCase` is the ONLY
    `INSERT INTO cases` and `contactService.createContact` the only
    `INSERT INTO contacts` — both pinned by a filesystem-grep test, so a new
    create path calls them rather than writing its own INSERT.
  - **`validation.required` is enforced ONLY by the renderer**
    (`public/js/yc-custom-fields.js`), never the chokepoint — a partial PATCH
    that omits a required key must succeed.
  - **Reports:** `lib/reportSchema/manifest.js` stays hand-maintained; the
    custom fields are appended per request by
    `lib/reportSchema/customFieldsAppendix.js` through the new
    `aiService.call({ systemAppend })` option.
  - **Log:** a cf_ change on a CONTACT writes an app-side row from inside
    `updateContact`'s transaction, shaped like `after_contact_update`'s.
    Cases write none — `updateCase` logs no core-column edit either, and there
    is no `after_case_update` trigger (`ref/plans.md`).
  - **The Clio ids are custom fields:** `cf_clio_matter` (case) and
    `cf_clio_id` (contact), migrated 09-25 (S5-A). The old columns
    `cases.clio_matter`, `cases.case_clio_id` and `contacts.contact_clio_id`
    were DROPPED 10-13 (S5-B) — read and write the Clio ids only by the `cf_`
    keys.
- **SSN is an ordinary column (09-24):** `contacts.contact_ssn` stopped being
  special. Removed: `resolverService.BLOCKED_COLUMNS.contacts`, the
  `contact_ssn` / `contact_dob` entries in `lib/reportSchema/manifest.js`
  `DENIED_COLUMNS`, the strip in `update_contact`, and the omission from
  `lookup_contact`'s SELECT. `contactService.stripSsn` turned out to be DEAD
  CODE — defined, exported, imported by caseService, called nowhere — so the
  "never returned by any function in this service" header rule had been false
  for some time; `getContact` returns it via `SELECT *`, `getCase`'s clients
  include via `SELECT co.*`, and `public/case.html` renders it in the Clients
  table. Rationale: the firm files Form 121 and staff read the number all day.
  STILL REFUSED, for reasons that are NOT secrecy-from-staff — do not "fix"
  these: `lib/portalCardEngine.js` (its own deny-by-default whitelist; those
  values reach a CLIENT browser), `lib/domainEvents.js` (envelopes persist
  independently of the contact row), and the external-forms prefill ceiling
  (public unauthenticated endpoint). `listContacts` still omits it — payload
  size, not secrecy. New modifiers `ssn_mask` (`xxx-xx-6789`) and `ssn_last4`,
  added to BOTH chains (`services/resolverService.js`, `lib/unplacehold.js`)
  and matching `esignPrefillService.ssnMasked`. Column COMMENT corrected by
  `ref/migrations/2026-09-24_contact_ssn_comment.sql`.
- **G2 document generation (09-01):** `contract_templates.purpose`
  ('esign'|'generate'|'both') + `file_subfolder`;
  `services/documentGenerateService.js`; internal fn
  `document_generate_from_template` (workflow-only, needs `template_id` +
  `linkable_id`, `on_missing:'task'`). Non-esign twin of send-from-template.
- **G4/G4.2 Notice of Filing (09-01..02):** workflow 47 v2 fires on stage →
  `filed`; pre-checks raw columns in `query_db` + `custom_code` BEFORE
  rendering (chromium renders serialize on the 1GiB container). v1 not
  retired (3 executions reference it).
- **BK Worksheet W1 (09-01):** SS's sheet as a YisraView + per-row
  `open_form` (form `bk_worksheet`) → normal `PATCH /api/cases/:id`. First
  write affordance from a view; the view stays read-only. 10-06: view gained
  `notes` (⚠ alert + case_notes; no alerts column — ~1 live row) before Lead
  Source, and Primary `phone` (formatted) / `dob` around Email; form v2 a
  Notes & Alerts section (`ref/migrations/2026-10-06_bk_worksheet_notes.console.js`).
  Same day, customView cells went one-line + row-click expand (log tri-state at
  row grain, `Expand rows` switch per view); the >60-char auto-wrap is retired.
- **DBKQ (09-04..06):** legacy debtor questionnaire is now a YisraForm
  (definition v1.2, pinned at ref/ root). Treat as an ordinary form.
- **FIL1 trustee validation (09-06):** internal fn `validate_case_trustee`
  (`lib/internal_functions/trustee.js`) on 341-notice ingest, gated by
  app_setting `trustee_validation_live` ('0' = dry-run, writes nothing).
  10-04: `courtExecutor.landTrusteeColumn` lands `create_appointment.trustee`
  on `cases.case_trustee` + its `_contact_id` twin, on create AND on
  `appt_exists` replay; ingest rule 17's match is broadened to
  OR(`meeting_*` classification, applied_types contains `create_appointment`,
  applied_fields contains `case_trustee`); sequence template 19 v2 runs a
  `validate_case_trustee` self-heal step before the missing-link alert.
- **Manage self-service policy (09-06):** `/m/<token>` links reach clients;
  `manage_allow_reschedule` / `manage_allow_rebook` / `manage_allow_cancel`
  app_settings read by `loadManageSettings` (routes/manage.js). Reschedule +
  rebook seeded closed; rebook must track reschedule.
- **SYNC-1 delete grace (09-08):** `documents.pending_delete_at` — provider
  delete stamps instead of flipping status; re-add clears; sweeper finalizes
  after grace. Fixes the 09-07 vanish-and-refill incident.
- **UDS density presets (09-23):** the `yc-theme-vars` localStorage store is
  two-axis — `preset` (palette) and `density` (compact/comfortable), density
  values written into BOTH mode sets. Axis membership is the ONE regex
  `/^--(fs|ctl-h|pad|gap)/` in `themeCustom.html`; `applyPreset`/`applyDensity`
  each rebuild only their own axis's keys. A token theme.css does NOT restate
  under `[data-theme="dark"]` is mode-shared (`isShared`): writers put it in
  both sets and `resetMode` sweeps it from both — it emptied one set only
  until 2026-09-23, so the page reported a state the app was not in.
  `scripts/checkThemePresets.js` lifts `PRESETS` only — density values must
  stay out of it. In `style.css`,
  `body` and `.logTable` carry `font-size: var(--fs)` (the table restatement
  is load-bearing: `case.html`/`contact.html` are quirks-mode, no doctype,
  and quirks tables don't inherit font-size — flip filed in `ref/plans.md`);
  `.tab-row` caps at `max(850px, 53.125em)`. Depth: `ref/THEME-CHEATSHEET.md`;
  mode + overrides roam with the account (ui_config user `prefs`, ui-custom
  S5d; localStorage is its write-through cache, adopted at boot and written
  through on change by `ycThemePrefs` in index.html; values validated by
  `lib/uiConfigShape.js` `themeValueProblem`).

## 1. SYSTEM OVERVIEW

Node.js/Express + MySQL case management, built by and for 4LSG (small
general-practice firm), Google Cloud Run, ~8 staff accounts.

### Framing invariants — read before asserting anything
1. **Not BK software.** `cases.case_type`/`case_subtype` drive behavior; the
   pipeline/trigger/form/workflow/document/event subsystems are type-neutral.
   Bankruptcy is the dominant vertical (~92%), so ~20 BK columns still sit on
   `cases` — legacy shape, not architecture. Every prior AI session got this
   wrong.
2. 4LSG runs 42 practice areas in Clio; YisraCase covers one well.
3. Clio = billing + litigation-calendar system of record. YisraCase = source
   of truth for cases, contacts, automation; stores Clio ids for linkage.
4. Documents live in Dropbox (153k indexed). Doc storage is not moving.
5. Human usage is low by design constraint (2–3 active staff, intake fell
   ~90% Apr 2026). Don't diagnose "nobody uses it" without that context.

### The engines (the old "Three Engines" framing is outdated)
- **Workflow** (`lib/workflow_engine.js`) — multi-step, branching, variables,
  audited executions.
- **Sequence** (`lib/sequenceEngine.js`) — contact-tied drip series that
  cancel themselves when the reason no longer applies.
- **Scheduled jobs** (`routes/scheduled_jobs.js`) — one-time/cron actions, no
  contact context.
- **Trigger system** (§26) — rules on internal domain events.
- Plus the rule layers that share the same primitives
  (`hookFilter`/`hookMapper`/`lib/actionDispatchers`): YisraHook (§16) and
  email/phone ingest (§27–28).

Shared: `scheduled_jobs` unified queue; `lib/internal_functions/` registry;
`resolverService` ({{table.column}}); `calendarService` (Jewish business
calendar); `smsService`/`emailService` (routed via `phone_lines` /
`email_credentials`); `settingsService`; `timezoneService`; `pabblyService`
(retiring bridge). All job types drain through `/process-jobs` (Cloud
Scheduler ~5 min) → per-type handlers in `job_executor.js` / engine modules.

## 2. DATABASE — CONCEPTUAL MODEL

Schema truth: `ref/database.sql` (auto-generated; **read the COMMENTs** — 
landmines are annotated in-schema). Style: `ref/SCHEMA_CONVENTIONS.md`.
Connection: mysql2 pool as `req.db`; `req.db.query(sql, params)` directly.
Server: Cloud SQL for MySQL 8.4; production connects over the `/cloudsql`
socket (`lib/dbTarget.js`), a developer machine through the Auth Proxy.
Instance facts, the load-bearing flags (`sql_mode` is an explicit flag, not a
default) and local setup: `ref/INFRA_GCP.md` §2, §7, §10.

**Timezone:** human-entered times firm-local (America/Detroit), machine times
UTC. `appt_date` firm-local naive + `appt_date_utc` computed;
`scheduled_jobs.scheduled_time` UTC.

**Identifiers:** `cases.case_id` = 8-char alphanumeric varchar. `users.user`
is the PK (tinyint; NOT user_id); user 0 = automation actor (`task_from`,
`log_by`); `req.auth.userId` in routes. Role columns on users are additive
booleans (`user_type` = human, `does_appts`, …) — add with DEFAULT 1.

**Contacts:** `contact_kind` ('person'|'org') is the entity axis; orgs live
in the same table (no org table); org name triggers copy `contact_org_name`
into all three derived name columns; EIN in `contact_ssn` by design.
`contact_name`/`contact_lfm_name`/`contact_rname` are trigger-computed —
never write. Scalar `contact_phone`/`contact_email`/address fields are
server-maintained MIRRORS of the primary-active row in `contact_phones` /
`contact_emails` / `contact_addresses` (`lib/contactMirror.js`); children
carry lifecycle (`start_date` NULL = since forever, `end_date`,
`end_reason`) + generated-column uniqueness: one active primary per contact,
one active row per phone/email VALUE globally (addresses exempt — households
share; address edits are UPDATE-in-place, phones/emails end-and-replace).
Relationships: `contact_relations` + `contact_relation_types` catalog
(directional flag + reverse_label). Roles: `contact_roles` +
`contact_role_types` (open vocab, app-validated).

**Cases:** `case_number`/`case_number_full` opaque free text (docket parsing
client-only). `case_judge`/`case_trustee` free text AUTHORITATIVE with
`*_contact_id` twins (fill on match, NULL on miss, never block a write).
Judge resolution keys on docket suffix → the judge role's `judge_3` attr; trustee
vocab = the contact roster (`contact_roles` role rows via `lib/trusteeRoster`;
`fe-trustees` setting and `judges`/`trustees` tables removed 2026-09-24). `bk_*` columns deliberately
loose (sheet parity) — don't tighten. `case_relate` links contacts
(Primary/Secondary/Other/Bystander); portal visibility requires
Primary|Secondary.

**Linkable pattern:** `*_link_type` + `*_link_id` on tasks/log/checklists/
events; bare `*_link` columns are legacy. For log `link_type` 'phone'/'email',
`link_id` carries the normalized VALUE — contact attribution happens at read
time via date-windowed join on the child tables. Court emails: `log_link`
carries the SHORT docket (writer truncates via
`logService._truncateDocketLink`).

**Checklists:** one table, two shapes via `kind` ('checklist'|'note') — see
§19. Tag-identifying queries MUST also constrain `kind`
(`uq_link_kind_tag`).

**Credentials:** shared outbound-auth store, 5 types
(internal/bearer/api_key/basic/oauth2), `ENCv1:`-prefixed encrypted fields —
see §21.

**sql_mode is relaxed** (no STRICT_TRANS_TABLES / ONLY_FULL_GROUP_BY /
NO_BACKSLASH_ESCAPES): over-length writes truncate silently, unknown enum
values coerce to '', NOT-NULL columns take implicit defaults. Never enable
strict mode (case creation + listCases depend on relaxed). Widen enums BEFORE
deploying code that writes new values.

## 3. AUTH & CODE PATTERNS

`jwtOrApiKey` (lib/auth.jwtOrApiKey.js): `x-api-key` vs the internal key
(yci_, two slots), then the external `api_keys` (yck_), then Bearer JWT. A
yck_ key with `scopes` reaches only its `route:/` paths (403
`forbidden_scope` otherwise); capability gates judge it by the capability
names it carries; NULL scopes = everything (access-control B2,
lib/capabilities routeAllowed / can). Everything requires it except the public surface:
`GET /isWorkday`, `GET /api/public/docs/:caseId` (10/min),
`POST /api/public/get-upload-link`, `POST /hooks/:slug` (120/min per
slug+IP), `GET /r/:slug` (60/min), `GET /auth/oauth/callback`, external
forms, portal routes. Login limiter still 100/15min (tighten to 10 —
ref/plans.md).

**Respond-first:** external actions (SMS, email, GCal, sequences) run AFTER
`res.json()` — never block the response. Consequence: the UI can report
success while a post-commit side effect fails; verify via DB, not UI.

**Signature quirks:** `smsService.sendSms(db, from, to, message)` positional;
`emailService.sendEmail(db, {from,to,subject,text?,html?,attachments?})`
object. `/internal/mms/send` takes singular `attachment_url`.

**Pabbly** is a retiring bridge (`pabblyService.send`, fire-and-forget):
still carries Gmail sends, GCal for appts, some Dropbox ops. Replace
natively when convenient; never build new dependencies on it.

**Client token discipline (2026-10-05):** exactly two sanctioned ways to put
the JWT on the wire — the shell's `apiSend` (JSON + `responseType`
blob/text/response) and `uploadWithProgress` (multipart XHR, for progress
events). Both live in `public/index.html`, attach the token themselves,
enforce a root-relative endpoint (absolute/protocol-relative throws — the
Bearer never leaves origin), set `redirect:'error'` (no authed route
redirects; the 302s are all public: /r, /d, /f, pageLanding), and are
frozen non-writable on `window` so late-loading code can't swap in a MITM
wrapper. Panes never read `AUTH_STATE.jwt` or localStorage `jwt`; role-gated
panes read `firmData.currentUser.roles` (a csv string from the MySQL SET;
cosmetic — the server enforces; `user_auth` is authn status only since
access-control A2b, 2026-10-14).
ONE exception: `public/forms/liveHost.html` is a standalone tab outside the
shell with its own apiSend clone (same guards) reading localStorage — it pins
the token to localStorage until the token-storage decision (ref/plans.md).
New raw `fetch` with a lifted token is a regression, not a pattern.

**Serving invariants (2026-10-05, verified):**
- *No Authorization persistence:* the token exists in exactly one durable
  place, localStorage `jwt`. Nothing logs or stores auth headers: the hook
  receiver strips `authorization`/`cookie`/`x-api-key` before persisting
  captures (api.hooks.js SENSITIVE_HEADER_DENYLIST), the apiTester audit log
  redacts the same set, the client diag ring records method/url/status only.
  Keep new logging/capture sites on this side of the line.
- *No authored-executable MIME on the app origin:* operator-authored bytes
  never execute on app.4lsg.com. Authored page HTML serves only on
  landing/vanity hosts (pageLanding host gate — never register the app host
  as a vanity host); asset/video uploads serve from the GCS origin; the one
  app-origin route serving variable-mime bytes (documents raw) allowlists
  pdf/images by OUR extension map + nosniff, attachment otherwise — copy that
  pattern (api.documents.js RAW_INLINE_MIME) for any new byte-serving route.

## 4. REST API — CONVENTIONS

Full inventory: `ref/routes.md` (auto-generated — middleware + handler per
route). Conventions:
- `GET /api/firm-data` → `{currentUser, phoneLines, emailFrom, users,
  settings, denied, ui, firmTimezone}` (field notes: the route's header).
  `users` includes user 0 — filtering is the CONSUMER's job (§12 pattern).
- List endpoints: `?q, limit, offset, sort_by, sort_dir` → `{data, total}`.
  Detail endpoints take `?include=` and return only what's requested.
- **Contacts aggregate PATCH:** body may carry `phones`/`emails`/`addresses`
  arrays — each array is AUTHORITATIVE for its kind (omitting a current row
  ENDS it). Primary rules: 0 incoming primaries = keep current; 1 = switch;
  2+ = 400. 409 returns structured `conflicts` (cross-contact ownership);
  `?force=true` transfers silently. Response embeds the fresh contact.
  Dedicated child CRUD routes exist too; phone/email VALUE change is
  aggregate-only.
- **Log reader semantics:** contact scope = contact rows + legacy NULL-typed
  + phone/email-typed rows the contact owned at log_date (date-windowed);
  case scope = case rows + that expansion over `case_relate` contacts
  (`case_relate_filter=default|all|none`). Exported
  `_buildContactLogWhere`/`_buildCaseLogWhere` are the single source — all
  readers must produce identical results.
- **Checklist API kind rules:** rejects `items` on a note / `body` on a
  checklist by KEY PRESENCE (`items: []` is a 400 — pass null for "not
  supplied"); PATCH rejects `kind`; `status` writable on notes only.
- Date filters `from`/`to` = YYYY-MM-DD; `to` is inclusive via
  `< DATE_ADD(?, INTERVAL 1 DAY)`.

## 5. INTERNAL FUNCTIONS

Registry: `lib/internal_functions/` — `index.js` auto-loads sibling files, so
new function files need no consumer edits. Contract:
`async (params, db) => { success, output? }`; workflow steps consume output
via `{{this.output.*}}` and `set_vars`. Catalog: `GET /workflows/functions`
(workflow + sequence-filtered lists) or `manual/03-YisraFlow/05`.
`query_db` is the guarded generic read: JSON descriptor, allowlisted tables,
parameterized ops only, sensitive tables/columns blocked, limit clamps at
1000 silently. `update_db`/`insert_db` (db.js) carry per-table
allow/block maps (e.g. checklists blocks `kind`). app_settings (§32):
`set_setting` / `update_db` write a REGISTERED key only when
lib/settingsRegistry.js marks it `automation: true` (today `clio_login_code`
only), an unregistered non-secret row (an automation variable) freely; a
secret — registry kind or row flag — is never read or written by
get_setting / get_settings / set_setting / update_db.

## 6. WORKFLOW ENGINE

Executions: `active → processing → delayed → completed |
completed_with_errors | failed | cancelled`. Start:
`POST /workflows/:id/start` → `{executionId}`.
Variables: `{{name}}` (init_data/set_vars), `{{this.output.field}}`,
`{{this.[0]}}`, `{{env.now|executionId|stepNumber}}`.
Steps: `{type, config:{function_name, params, set_vars}, error_policy}`;
policies `ignore` (default) | `abort` | `retry_then_ignore` |
`retry_then_abort`.
**isControlStep rule:** a function's next_step is honored only when its
`__meta.controlFlow` is true (evaluate_condition, set_next, foreach,
request_decision, schedule_resume, wait_for) — pinned with
`BRANCH_TARGET_PARAMS` by tests/control.flow.test.js. Max 20 steps per
invocation, then self-schedules continuation. Deferred steps become
`workflow_resume` jobs. In-loop status writes are guarded on
`status='processing'` — a cancel halts a running invocation at the next step
boundary. **Loops:** every pass must pause (wait ≥1 min / request_decision)
or loop back onto a foreach. Publish rejects other cycles (versionDiff
`findPauseFreeCycles`); at runtime the 21st back-jump without a pause, or
foreach pass 1,001, fails the run + critical alert (manual/03-YisraFlow/02
§ Loop protection). Versioning (draft/publish) per
`manual/03-YisraFlow/16` — workflows + sequences only, NOT trigger rules.

## 7. SEQUENCE ENGINE

Enroll: `POST /sequences/enroll {contact_id, template_type, trigger_data}`.
**Cascade match:** `sequence_template_types.priority_fields` (ordered,
most-specific first) scores template `filters` against trigger_data —
position i contributes 2^(N-1-i); wildcard never disqualifies; specific
mismatch or missing demanded field disqualifies; best score wins (id ASC
tiebreak). Manage Types UI edits `priority_fields`.
**Check chain per step:** enrollment active? → template condition (fail =
CANCEL enrollment) → fire guard → step condition (fail = skip step) →
resolve → act → log → schedule next.
Timing types: immediate / delay / next_business_day / business_days /
before_appt_fixed / before_appt (all calendar-aware, firm-TZ timeOfDay).
Conditions: parameterized SELECT + `assert` map against the row.
Cancellation is UPDATE (status trail), never DELETE.

## 8. UNIVERSAL RESOLVER

`resolverService.resolve({db, text, refs, strict})` →
`{status, text, unresolved, errors}`.
- `strict:true` does NOT throw on unresolved — returns `status:'failed'`;
  callers must check.
- DB infrastructure errors DO throw (so job retries work). `throw` =
  transient infra; `status:'failed'` = permanent semantic.
- `POST /resolve` always HTTP 200 — check body.
Filters: `|date:fmt`, `|phone`, `|upper`, chained `|default:`.

## 9. CALENDAR SERVICE

Jewish business calendar (Hebcal). Shabbos window Fri 18:00 → Sat 22:00;
Yom Tov days similarly 18:00-eve → 22:00; Sunday non-business in
`nextBusinessDay()`. Hebcal fails OPEN (returns []) — never blocks
scheduling. Routes: `GET /isWorkday` (no auth), `POST /nextBusinessDay`,
`POST /prevBusinessDay` (attempts ladder).

## 10. SCHEDULED JOBS

Unified `scheduled_jobs` queue, index (status, scheduled_time), drained by
`/process-jobs`. Scheduling types: `one_time`, `recurring` (cron,
`max_executions`/`expires_at`); execution flavors in `data.type`: `webhook`,
`internal_function`, `custom_code` (vm sandbox, 5s). Engine-internal:
`workflow_resume`, `sequence_step` (hidden from list unless
`?internal=true`). App-managed: `task_due_reminder`, `task_daily_digest`,
`hook_retry` (3 attempts, 120s backoff), `campaign_send`, `mail_sent_read_seed`
(mailbox S3, §0). Effective retry
backoff floor = the poll cadence (~5 min). Recurring `internal_function`
jobs are the house pattern for daily services (oauth refresh, event digest).

## 11. APPOINTMENT LIFECYCLE

All through `apptService`; every mutation follows the same shape — status
UPDATE → cancel reminder workflow → sequence effects → optional
comms/task → log → non-blocking GCal:
- `createAppt`: insert (+utc) → log → 341 Meeting updates
  `cases.case_341_current` → cancel no_show sequences → confirm SMS/email →
  GCal (fire-and-forget) → start reminder workflow (execution id stored on
  the appt).
- `markNoShow`: enroll no_show sequence unless already enrolled.
- `markAttended` / `cancelAppt` / `rescheduleAppt` (old → 'Rescheduled',
  new appt runs full createAppt chain) / `rescheduleLater`.
- Follow-up task (`cancelAppt` / `rescheduleLater`, `create_task`):
  `createFollowUpTask` assigns to the acting user, else app_setting
  `default_task_assignee` (API-key callers such as wf50 carry no userId);
  neither → no task + `appt_followup_no_assignee` alert. task_from stays the
  acting user (0 for automations). Never throws.
- Provider cancel notice (`notifyProviderOfUnattendedCancel`): a `cancelAppt`
  with no acting user and source ≠ 'client' texts appt_with (users.phone;
  not allow_sms-gated). Staff clicks silent; client cancels ride
  `notifyStaffOfClientAction` (roster ∪ provider) — never both. Both send from
  sms_staff_from → sms_default_from: sms_default_from alone is the provider's
  own line in prod (self-text).
Status values are Title Case with spaces ('No Show', 'Canceled' one L).
`appt_end` is GENERATED.

## 12. FRONTEND ARCHITECTURE

**Shell:** `public/index.html` is the ONLY top-level shell (the other 55
HTML files are panes it loads in iframes; some, like `case.html` /
`contact.html`, nest their own). It owns JWT auth + `apiSend()` — apiSend
MUST stay in the shell; iframes use `const P = window.parent; P.apiSend(...)`.
`apiSend(endpoint, method='GET', payload=null, extraHeaders={})` → parsed
JSON (204 → null); re-login + one retry on 401; **non-2xx throws `ApiError`**
(`.message .status .statusText .body .url .method`) — structured 4xx callers
read `.body` directly. (`contact-form.html` still uses the pre-ApiError
direct-fetch bypass — refactor pending, plans.md.)

**firmData:** loaded once from `/api/firm-data`, relayed to iframes
(`window.firmData = P.firmData`). Includes user 0 by design. Role filtering
is declarative: `<select class="userslist" data-userlist-filter="does_appts">`
— the populate loop filters by that boolean column; no attribute = all users
(intentional for task_from/log_by filters). Swal-built dropdowns inline the
same `.filter(u => u.user_type)`. MySQL booleans arrive as 1/0 — truthy
checks fine, never `=== true`.

**entityData (parent-as-data-source):** `case2.html`/`contact2.html` load
the entity once into `window.entityData`; child form iframes read it (a
form's `endpoints.load.path` doubles as the lookup key) instead of
fetching. contact2 flattens phones/emails/addresses INTO
`entityData.contact` for the repeaters.

**Save → refresh → push:** ONLY `yc-forms.js` sends the `form-saved`
postMessage (forms sending their own = double refresh). Parent
`refreshEntityData`: re-fetch from API (never trust form-sent data) →
update header/tables → scan iframes for `ycForm` (try/catch — cross-origin
iframes throw SecurityError) → push fresh data into non-dirty forms
(`populate()` + re-run `onLoad`); dirty forms untouched. `_original`
re-snapshots after `onLoad` so computed fields don't look dirty.

**Boot:** iframes sourced during parent init use the `waitForParent` poll
(`if (P.apiSend) return init()`); lazy-loaded admin iframes skip it.
Content-height iframes post `{type:'iframe-resize'}`; parent sets height
(ResizeObserver + last-height dedupe on the form side).

**Repeaters (yc-forms.js)** are minimal — per-form glue that's always
needed: masks don't bind on cloned rows (`_setupMasks` runs once at init —
use a delegated capture-phase blur handler); `collect()` does NOT strip
masks on repeater inputs (server normalizes); primary-checkbox exclusivity
+ auto-promote logic is form-side; save-time "no primary" guard is the UI's
job (server aggregate path never auto-promotes).

**Key pages:** case2/contact2 (tabs of iframes: forms/*, sendingform,
communicate), `automationManager.html` (Workflows/Sequences/Jobs/Hooks
tabs), `campaign.html`, `checklistView(s).html` (§19), `eventform.html`,
`connections.html` (§21). Swal popups render in the PARENT DOM — inline
`onclick=` in Swal html resolves against parent scope and breaks for
iframe-defined functions; bind in `didOpen` instead.

**Phone layout (≤768px):** one breakpoint, everything phone-specific inside
it, desktop untouched. Shared patterns, all documented where they live:
`.yc-filters` list filter bars (style.css; mobile Filters toggle + active
count via `ycFilters*` in scripts.js), `.yc-stack` for the older inline
`.input-label` forms (style.css — labels above full-width controls),
`swalWide()` for iframe-hosting dialogs (scripts.js). Tables scroll in their
own box rather than widen the page; case/contact tab rows WRAP (a swipeable
single line was tried and rejected 2026-10-06). Gate:
`scripts/mobile-survey/` (CLAUDE.md, Commands & gates).

**Field labels (all widths):** one look — bold, `--text`, `--fs-sm`
(matches yc-forms' `.yc-label`); group headings ("Docket (optional)",
"Reminder (optional)") one step up: bold `--fs` with a rule above; no
trailing colons. Set in four places that must move together: style.css
`.input-label` (carries the note), scripts.js dialog CSS (`.ncf-`/`.na-`/
`.ne-`/`.cad-`/`.oad-` labels + `.yc-flabel` for inline labels), tasks.html
`.tk-dlg-grid`, and pane-local copies on theme.css-only Admin panes
(ctaManager.html, caseconfig/firm.html, caseconfig/contactRoles.html and
settings.html's My access / Manage access sections declare
`.yc-flabel`/`.yc-hint` with these values, and connections.html scoped to its
`#noTxDialog` — style.css and scripts.js don't load there). Known divergences:
toolManager.html styles labels as `.field label` and portaladmin/portalSettings.html
as plain `label` + `.hint` (uppercase 11px `--text-muted`), and settings.html's
older sections keep `label.fld` — a different look. Hoisting `.yc-flabel`/`.yc-hint` into
theme.css would collapse this to one definition (plans.md).

**Hints (help text under a field, a dialog's explanatory note):** one look —
`--fs-xs`, `--text-muted`, weight 400 (≈ yc-forms' `.yc-sublabel`). Use the
class, never inline font/colour: `.yc-hint` (scripts.js dialog CSS — loaded on
pages without style.css too) for dialogs, `.sub-label` (style.css) in the
`.input-label` forms, where it is a 200px control-column box (on its own line,
pad it with an empty `.input-label` — hidden on phones). Warnings keep
`--warn`/`--danger`; list-row secondary text (`.cp-sub`, quick-search rows) is
not a hint.

**Self-sizing textareas:** `autoGrow(el, { max })` (scripts.js) — fits on
input AND re-fits when the box is shown or re-wraps (ResizeObserver on its
width), so it survives being filled while hidden; `max` caps only the
automatic height, and with CSS `resize: vertical` (and no CSS max-height) a
user drag becomes a floor. Call `.fit()` after setting `.value` from code.
Why it exists: case/contact `.tab-content` panes are `display:none` until
`openTab()`, and both pages fill them BEFORE showing one — anything measured
during load reads 0 (the Overview notes box sat at its 100px floor on every
load until 2026-10-06). Users: the Overview notes box (draggable) and
checklistView's note bodies (`resize: none` — render() rebuilds them, so a
drag could not last). The old one-shot `resizeTextarea()` is gone; use
autoGrow for any textarea that should fit its text.

**Content-sized checklistView frames:** `fitFrameToContent(iframe)`
(`/js/yc-frame-fit.js`, its own file because apptform2.html does not load
scripts.js) — call from the frame's onload; returns `{ fit, stop }`. Watches
the framed body for DOM changes AND inline-style changes: a note body
re-fitted from code (the bus repaint of a native card — `.value` plus an
autoGrow height write, no DOM change) left the old DOM-only watch 100px short
with a scrollbar inside the host. Users: eventform.html, checklistsView.html,
apptform2.html (which `stop()`s the previous appointment's watch on remount).
The framed page must be standards-mode with a content-sized body.

**Manual viewer** (`manuals.html` + `routes/manuals.js`): the pane's place is
its hash — `#/<sec>/<file>/<anchor>`, anchors = GitHub heading slugs;
`search` is reserved (`#/search/<q>` results, and `/manual/search` is
registered before `/manual/:section` — no manual folder may take the name); a
hit links `#/<sec>/<file>/~<n>/<q>`, n = the heading's ordinal among the
chapter's h1..h6, replaced by the heading's id on arrival. Shell deep link:
`/?manual=<sec>/<file>/<anchor>`. Chapter titles = the H1 minus its `N — `
counter; section labels + card blurbs = `manual/README.md`'s Sections table.
Search index is in-process, built on the first query (chapter bodies, not
READMEs); the server's heading count must match what marked renders —
`scripts/mobile-survey/manualOrdinals.js` checks it (rerun after a marked pin
bump or a parser change). Contracts: the route file's header.

**Workspace URL:** the shell's address bar is a live workspace snapshot
(`syncWorkspaceUrl`: replaceState, one write per microtask, gated until boot;
the version guard reloads through `window.ycReloadUrl`):
`?files=c<case_id>|p<contact_id>|b<id>[~rest],…` + `?open=file:<n>` (a file's
rest lives in its token) or `?open=<mainTabId>[~rest]`. A rest = one
`~`-joined segment per frame layer, each layer owning its vocabulary (case /
contact: `data-ws-tab`; comms: email|phone|team; tabMore/tabAdmin: the open
drill panel's FEATURE_REGISTRY id; automationManager / caseConfigManager:
their `SUB_PAGES` id, e.g. `tabMore~moreAutomations~triggers`). Grammar in `public/js/ycSubTab.js`:
`[A-Za-z0-9_-]{1,32}`, depth ≤4, ≤128, empty = default, invalid → dropped at
its layer (file/tab kept). Vocabulary or surrogate DB ids ONLY: the URL rides
Referer into jwt_api_audit_log, redacted by key (credentials, `q`), not value.
A leaf reports from its ONE switch function (`ycSubTab.leaf.report` → parent
`window.ycReportSubTab(frameElement, rest)`) and takes the handed-down rest
ONCE at boot (`leaf.take` → `ycTakeSubTab`); file pages add `ycApplySubTab`
for the dedup refocus. The shell accepts only a file's / main tab's own pane
frame or a drill panel's direct iframe (not Swal / tool dialogs), shows only
the ACTIVE view's rest, and never opens anything on a report. `?open=`'s head
must be a tab the effective registry offers (`wsMainTabAllowed`, after
applyAccess; else Home); a drill panel reopens ONLY via `ycLauncher.exec(id,
{ page })`, for a plain registry id whose tile ON THAT PAGE has `data-target`
— its default tile, or a neutral the firm placed there (S6c-4: `tabMore~
adminUsers` reopens Users on More) — never action/dialog tiles, firm-unplaced
tiles or `firm:` ids. The panels live on the stage (`#ycPanels`, below);
`wsDrillPanels(tab)` maps a page's tiles to stage panels, `wsFrameOwner` maps
a stage pane to the active page when it has a tile for the panel, else the
first drill page that has. Leaves: case.html, contact.html, comms.html, and two drill-panel
panes, automationManager.html + caseConfigManager.html (a gated sub-tab —
Config's Firm or System — is taken at boot but opened only after its reveal, and only
if the default is still showing). A new pane: load ycSubTab.js; report from its one
switch; take once AFTER the content deciding which choices are visible;
restore by clicking / calling its own switch; never throw on a token. Server:
`lib/shellLinks.js` builds staff deep links by exact id; legacy `?case=` /
`?contact=` (a limit=1 search) is accepted forever. Gate:
`scripts/mobile-survey/wsurl.js` (heavy-gate `browser`) + `tests/wsurlS*.test.js`.
Detail: index.html's WORKSPACE URL comment; deferred levels: plans.md.

## 13. WORKFLOWS IN PRODUCTION — retired section
Query the live `workflows` / `sequence_templates` tables; a static list here
was stale by definition.

## 14. PENDING / TODO — retired section
Deferred work lives in `ref/plans.md` (still-live items merged 2026-09-14).

## 15. QUIRKS THAT BITE

Cross-cutting invariants live in CLAUDE.md; schema-level ones are COMMENTs
in ref/database.sql. The rest:
1. Title-Case-with-spaces status enums; 'Canceled' one L.
2. `task_status` 'Deleted' (not 'Canceled'); 'Incomplete' is a frontend
   filter = IN (Pending, Due Today, Overdue).
3. Sequence/job cancellation = UPDATE to a terminal status, never DELETE.
4. Enum migrations: expand → data UPDATE → contract. Never out of order,
   and always BEFORE code that writes new values (relaxed sql_mode coerces
   unknown enum writes to '' silently).
5. `query_db` limit silently clamps at 1000.
6. Campaign retry backoff floor = poll cadence (~5 min).
7. `email_default_from` is the app_settings key (not email_from_default).
8. Deferred `require()` inside function bodies for circular imports
   (sequenceEngine ↔ internal_functions).
9. Per-row validators keep `is_primary: undefined` distinct from `false`
   ("didn't say" = auto-promote eligible on dedicated POST; aggregate path
   never auto-promotes). Reconciler demotes the displaced primary only when
   the new primary is a DIFFERENT row, and demote runs before inserts or
   `uk_one_active_primary` fires.
10. Cloud Run filesystem is case-sensitive — iframe `src=` casing matters.
11. `ALTER TABLE … DROP COLUMN` succeeds while a DB trigger still names the
    column — then EVERY UPDATE of that table fails `1054 Unknown column … in
    'OLD'`. A zero-row UPDATE does not show it; a one-row no-op does. Rebuild
    the trigger first (`ref/migrations/2026-10-13_custom_fields_s5b_drop_clio_columns.sql`).

## 16. YISRAHOOK — WEBHOOK RECEIVER & AUTOMATION ROUTER

One route `POST /hooks/:slug` replaces per-integration endpoints; each hook
is a DB row describing auth → filter → transform → ordered delivery
targets. 200 returns immediately; processing is async with per-execution +
per-delivery logs. Depth: `manual/03-YisraFlow/09-yisrahook.md`.

Target types: `http` (default) | `workflow` (transform output = init_data;
INSERT retries cleanly but async advance failure does NOT re-trigger
delivery retry) | `sequence` (enrollContact; duplicate enrolls throw) |
`internal_function` (`params_mapping` with literal/'flat'/dot-path sources;
NOT inherently idempotent — retried side effects can duplicate). All share
filter/transform/conditions/retry (`hook_retry` jobs). Internal deliveries
log synthetic `internal://…` URLs.

**Capture-before-publish (09-03):** the init-data capture block runs BEFORE
the never-published/inactive gate at all four execution-creation sites;
`hook_delivery_logs.status` includes 'captured'. Arming capture on a new
workflow stores the payload as its sample instead of losing it.

Tables: `hooks`, `hook_targets`, `hook_executions` (raw_input capped 512KB),
`hook_delivery_logs`, shared `credentials`. Files: `services/hookService.js`
(+ hookTransforms/hookMapper/hookFilter), `routes/api.hooks.js`. UI:
automationManager Hooks tab. `server.js` mounts rawBody on `/hooks` for
HMAC.

## 17. CAMPAIGN SYSTEM

Bulk SMS/email as ONE `campaign_send` job per contact (Cloud Run timeout
constraint), idempotency_key `campaign:{id}:{contactId}`, UNIQUE
(campaign_id, contact_id) on `campaign_results` backs recordResult's
upsert. executeSend: bail-as-skipped if canceled → opt-out check → channel
check → strict resolve → send → recordResult + checkCompletion (finalizes
sent/failed/partial_fail).
**Error classification:** skips + permanent errors record and return;
transient (socket/timeouts, SMTP 4xx, HTTP 429/5xx, DB blips, resolver
throws) THROW for job retry — except on the final attempt, where transient
is recorded as failed so completion can finalize. Unrecognized errors
default PERMANENT (duplicate sends are worse than one-attempt failures).
Cancellation deletes pending jobs by name prefix; in-flight jobs re-check
status and record 'skipped'. Contact refs only in resolver context.

## 18. TASK SYSTEM

`taskService` + `routes/api.tasks.js`; response `{data, total}`.
Flow: Pending → Due Today (digest run, on due date) → Overdue → Completed /
Deleted, both reversible via reopen (status recomputed from due date).
Transitions cancel/reschedule the `task_due_reminder` job
(`tasks.task_due_job_id`); reminder fires 8 AM firm time. Daily digest
(cron 13:00 UTC): ALWAYS refreshes statuses, sends only on workdays, per
`task_remind_freq`, optional SMS counts. Every event writes a linked log
row (created/updated/completed/deleted/reopened/transferred). Depth:
`manual/` task chapter + `TASK_SYSTEM_REFERENCE.md`.
**Session-key tasks (D3, §30):** `routes/api.keyTasks.js` — a `tasks.own`
key creates tasks (owned via `tasks.task_session_key_id`, NEVER
task_source) and manages only its own (else 404). task_source
`session_key:<id>` ("Session key #N"); log rows carry `{via:'session_key',
keyId}`. createTask names task_session_key_id only when given
`session_key_id`; the mutators take an optional `logExtra`.
**Assignee pickers vs lists:** /api/firm-data `users` lists EVERY user (pages
resolve names on old records through it — never filter it server-side); each
row carries boolean `active` (user_auth LIKE 'authorized%', the login gate =
findAssignableStaff's). ASSIGN pickers filter `u.user_type && u.active !==
false` (tasks.html transfer + create; edit always keeps the current assignee);
list FILTERS and lookups keep everyone. Same rule at every other ASSIGN site
(D3b, tests/assignPickersActive.test.js): scripts.js newContact/newApptDialog
appt_with, newEventDialog reminder (+user_type) and "Blocks calendar of",
eventform.html event_with, ctaManager attribution, automationManager user
suggestions; checklistsView "Lists for" puts inactive users under an
"Inactive — view only" optgroup. Where a picker shows a stored value it is
KEPT whatever filter excludes it (event_with: inactive, lost does_appts, or
missing — '0' = Nobody, never user 0).

## 19. NOTES & LISTS (checklists tables)

One table, two shapes via `checklists.kind`: 'checklist' (N `checkitems`,
`status` DERIVED by `computeAndSaveStatus` — never write it) | 'note'
(`body` text, zero items, `status` manual). The compute fn early-returns on
notes — one guard covering all five call sites including
`caseService.mergeCases`. Tagged rows unique per
(link_type, link, kind, tag) — **every tag-identifying query must also
constrain `kind`** (a note titled/tagged "Docs Needed" beside the real list
otherwise gets checkitems written onto it while the portal reads the
checklist — renders empty, no error). `FIND_DOCS_SQL` carries the kind
predicate; workflow 42 v3 fixed the same hole in DB-stored config.

**Docs Needed upsert** (`POST /checklists/upsert-items`): find-or-create the
case's checklist; each item replaces prior items matching on first 22 name
chars; public docs page returns incomplete items only.

**NATIVE_NOTES:** pinned virtual cards that read/write the legacy notes
COLUMNS (cases.case_notes, contacts.contact_notes, appts.appt_note,
events.event_note) — a VIEW, not a migration; client PATCHes the entity.
`cases.case_notes` cannot move (searchCases hot path, report 10, 3 form
templates, merge, tabLeads). `341_notes` deliberately unmapped (no write
path exists; form template 5 maps elsewhere). Known wart: case_notes
editable in two surfaces, last write wins.

**noteLimits:** `NOTE_MAX_CHARS=10000` (String.length) enforced in code at
six sites because relaxed sql_mode truncates silently (four appt_notes were
found cut mid-sentence at exactly 1000). Machine append paths (merge
concat, appt audit CONCATs) exempt by design. `update_db` can still bypass
for `checklists.body` — accepted gap.

**Frontend (all have bitten):** body save must NOT re-render (caret dies);
filtered-out cards must not be built-and-hidden (index matching); native
cards need synthetic draft keys (id is null); `flushBodies()` before
refetch; failed saves keep the draft; plain text only — never innerHTML a
body (no sanitizer exists in this repo).

**Merge:** loser→survivor consolidation matches on tag AND kind; notes fold
body across. Generic `update_db` blocks flipping `kind`.

## 20. COMMUNICATION UI

`communicate.html` (contact2 tabSend iframe): SMS / Email (Quill) / Log
Call panels; log-without-sending options; posts to `/internal/sms|mms|email/
send` + `/api/log`. `sendingform.html` (case2): modular doc-request actions,
server-side assembly via `POST /api/compose-docs-message`, Docs Needed →
`/checklists/upsert-items`.

## 21. CONNECTIONS — CREDENTIAL MANAGEMENT

Admin-only UI `connections.html`; manual chapters 14/15 in 03-YisraFlow.
Two tables: `credentials` (5 types) and `email_credentials` (smtp_pass is
ENCv1-encrypted at POST/PUT in routes/api.emailCredentials.js; decrypted
only in the SMTP adapter + /reveal, and the adapter hard-fails on a
non-encrypted value; one-time backfill scripts/encrypt-smtp-passwords.js
has run — folding email_credentials into Connections proper stays on
plans.md).

**Encryption:** AES-256-GCM, wire format `ENCv1:` + base64(iv||tag||ct);
`isEncrypted` is a literal prefix check — the old length/charset heuristic
false-positived on provider secrets and silently left plaintext; never
reintroduce heuristics. Encrypted: oauth2 access/refresh tokens +
config.client_secret; bearer token; api_key key; basic password.
`CREDENTIALS_ENCRYPTION_KEY` env (32B base64) — boot fails fast without it.

**Injection (recurring trap):** `buildHeadersForCredential(db, id, url)` —
async, all 5 types — for ALL outbound HTTP. Sync `buildAuthHeaders` returns
`{}` for oauth2: request goes out unauthenticated, provider 401s, UI blames
allowed_urls. `checkUrlScope` pre-flights URL scoping.

**OAuth2** (`services/oauthService.js`): auth-code + PKCE(S256), state
lookup, refresh-token rotation handled. Refresh is hybrid: lazy
(`getValidAccessToken`, refreshes within 120s of expiry) + daily 03:00
Detroit internal-function job scanning expiring tokens. Both paths take
per-credential `GET_LOCK` + in-process dedupe (both layers required).
Failures: 2-strike before status flips to refresh_failed + one alert
(accommodates the daily-refresh window); admin re-authorizes in UI.
Initial exchange may lack a refresh_token (Google needs
access_type=offline + prompt=consent in extra_authorize_params) — UI warns.

**PUT is deep-merge** (one level) — single-field saves preserve the rest;
changing `type` wholesale-replaces config and wipes oauth state. Redirect
URI must exactly match `${APP_URL}/auth/oauth/callback`.

## 22. AI SESSION DB ACCESS (READONLY + SCRATCH)

A **session key** (the concept's name since access-control B3; formerly
"readonly key" — prefix, header, table and routes unchanged): header
`X-Readonly-Api-Key: ycro_<22 base62>_<expiry stamp>` (keys minted before B3:
64 hex; identity is only `ycro_<body>`, the stamp an editable note) —
SU-managed, max TTL 3 days, shown once. Every call logs to `readonly_query_log` (full SQL + params).

**Scopes (access-control B1):** a key reaches only the surfaces in its
`readonly_api_keys.scopes` — `sql.ro`, `sql.ro.sensitive`, `scratch`,
`alert`, `keys.mint`, `temp.clio`, `temp.dropbox`, `temp.ringcentral`,
`temp.zohosign` (vocabulary `lib/capabilities.js` KEY_SCOPES; each route mounts
`requireKeyScope`). NULL (every key minted before B1) = all of them EXCEPT an
`explicit` scope — today `sql.ro.sensitive` and `keys.mint`, which a legacy
key never holds. A `keys.mint` (manager) key mints its own child keys — §30.
New mints default to `sql.ro`+`scratch`+`alert` — a `temp.*` proxy must be
named at mint. A miss is a 403 whose body names `missingScope`.

**Table tiers (SEC-3, ACCESS_CONTROL_DESIGN §5.7, `lib/sqlGuard.js`):**
`SECRET_TABLES` (`app_settings`, `email_ingest_sources`) — refused to every
key (400). `SENSITIVE_TABLES` (`jwt_api_audit_log`, `ai_calls`,
`comms_transcripts`, `comms_no_transcribe`, `comms_summary_guides`,
`admin_audit_log`, `readonly_query_log`) — a 403 naming `sql.ro.sensitive` unless the key holds
it. The `ai_spend` VIEW (ai_calls minus `error` / `request_excerpt` /
`response`; not in `ref/database.sql` — schemaDump dumps base tables only, its
definition is `ref/migrations/2026-10-14_access_sec3_sensitive_tier.sql`) is
the ordinary key's spend monitor. A `sql.ro.sensitive` mint needs `sql.ro`
too and is TTL-capped (24h max, default 4h — a longer ask is a 400);
`readonly_query_log.sensitive_key` = 1 on every row such a key writes.
Matching is a bare-word regex over the whole statement, so a sensitive name
inside a string literal (an information_schema size query naming
`ai_calls`) is refused too.

**`POST /api/readonly/sql`** `{sql, params?, maxRows?, timeoutMs?}` →
`{ok, rows, fields, rowCount, truncated, durationMs}`. First keyword must
be SELECT/SHOW/DESCRIBE/DESC/EXPLAIN (comments stripped first). `WITH`
rejected deliberately (MySQL 8 allows WITH…UPDATE) — use subqueries.
Defense stack: SELECT-only DB grant, no multi-statements, keyword
allowlist, OUTFILE reject, per-query MAX_EXECUTION_TIME (default 30s / max
120s), row cap (default 5000 / max 20000, payload-truncating). The grant is
SELECT-only (`yc_ro@%` on Cloud SQL), so `information_schema.TRIGGERS`,
`ROUTINES` and `EVENTS` come back EMPTY to it — MySQL hides objects you hold
no privilege on. An empty answer there is not "none exist": ask Fred to run
the query in the SU db console, which connects as the app user.

**Scratch:** `PUT /api/scratch/:ns/:k` `{v, meta?}` — `v` STRING-ONLY
(JSON.stringify objects yourself; meta may be JSON), MEDIUMTEXT ceiling.
`DELETE /api/scratch/:ns/:k`; `DELETE /api/scratch/:ns?confirm=1` wipes.
`ns`/`k` match `^[a-zA-Z0-9_\-]{1,64}$`. Reads go through the SQL endpoint
against `rw_scratch`. Live namespaces: `fred` (manager session state),
`docs` (doc-debt queue — see currency header).

**IT alert:** `POST /api/alert/it` `{subject<=200, message<=10000 (plain
text), severity: info|warn|critical}` — same key/header. No `channel` param
(a 400): delivery DERIVES from severity — info/warn email IT, critical also
SMS. Reuses the `email_it`/`alert_from_email`/`alert_critical_sms_to`/
`sms_staff_from` settings; 10/hr per ROOT key (a child shares its parent's —
§30); audits to `admin_audit_log`
tool=it_alert. Synchronous — a send that throws is a 502, but
`sent.email:true` only means the relay took the handoff; confirm real
delivery via `email_log.delivery_info`. Usage rules: CLAUDE.md "AI session
data access".

Targeted queries over table dumps — tokens cost. Files:
`routes/api.readonly.js`, `routes/api.scratch.js`, `routes/api.alertIt.js`,
`lib/sqlGuard.js`, `startup/dbReadonly.js`.

## 23. EVENTS SUBSYSTEM

`events` = dated obligations/milestones — distinct from appts (attendee +
attendance lifecycle) and tasks (a user's to-do). ONE link target:
'case' | 'contact' | **'case_number'** | NULL. Schema + column semantics:
ref/database.sql.

**Docket linking (case_number):** court deadlines must calendar before an
internal case exists. `event_link_id` = docket VERBATIM (trim only; never
parse). Resolution is QUERY-SIDE and self-healing — rows never rewritten:
case-scoped listEvents ORs in case_number rows matching either docket
column; `resolved_case_id` comes from a shared correlated subquery (LIMIT
1, never a JOIN — fan-out). Clickability keys off resolved_case_id. Event
LOG rows write `log_link_type='case'` + docket in link_id (the log table's
existing court-email convention). Enum is expand-only.

**Invariant:** `event_all_day=1 ⇔ event_time IS NULL` (service-enforced).
**Input normalization throws on garbage** (relaxed sql_mode would store
`9/9/2024` → 0000-00-00 and `4:00 PM` → 04:00:00): accepts ISO, M/D/YYYY,
combined date+time, 12h AM/PM; TZ suffixes rejected (firm-local).

Service (`eventService`): GCal via native `gcalService` (NOT the dead
/internal/gcal) — all-day `{date}` + exclusive end, timed local-ISO;
reschedule = delete + create (appt pattern); per-event `event_calendar_id`
(NULL = default calendar, 'none' = skip incl. teardown). Reminders are
TASKS (`task_link_type='event'`), created on create/PATCH (reminder key
PRESENCE — even null — means act); complete/cancel deletes them. Side
effects post-commit, non-blocking. Batch create: ≤50, sequential per-item
results, no idempotency (double-fire duplicates), all-fail → 400,
partial → 200 'warning'.

**Statuses:** Scheduled | Completed | Canceled | **Rescheduled** (U6c —
status AND supersession pointer coexist, mirroring appts; liveness queries
ask "is this Scheduled?"). **Approaching (U8):**
`calendar_item_types.approaching_offsets` (JSON days-before; NULL/[] =
off) + claim table `calendar_approaching_emitted`; nightly
`emit_calendar_approaching` emits `calendar.approaching` events; a trigger
RULE decides what a reminder does — policy is data, zero emissions until
configured.

**Digest:** single implementation `run_event_digest` internal fn as a
recurring job (deliberately no job_executor branch). Sends on workdays;
window = tomorrow → next workday INCLUSIVE (covers closures). Recipients:
`event_digest_recipients` → `email_default_to` → FIRM_EMAIL → abort.

**fe-\* settings pattern:** firmData exposes app_settings keyed `fe-*` only
(prefix stripped, JSON-parsed) — frontend-readable settings without
backend changes; secrets stay non-fe. First user: `fe-event_types`.

Frontend: shell tabEvents + `event-updated` broadcast; entity tabs lazy
`refreshEvents()`; `newEventDialog` shared; rows return raw date/time,
client formats. Events hold their own notes/lists (event-scope is the only
unambiguous anchor for docket-linked rows).

## 24. YISRAVIDEO — ASSET PREP

Player `views/v.html` (`/v/<slug>`): `preload="metadata"`, so MP4 MUST be
faststart (moov before mdat) or iOS stalls. If already H.264+AAC, remux
losslessly (`-c copy -movflags +faststart`) — don't re-encode. Poster
1280×720 JPG (doubles as link preview — pick a clean frame). GIF 480×270
~12fps ~3.5s two-pass palette; Outlook freezes GIFs to frame 1, so start
on a camera-facing frame. Uploader gates: mp4 ≤500MB; insertion variants
auto-drop when poster/GIF absent. Depth: manual 11-YisraVideo.

## 25. SCHEMA REF AUTO-GENERATION

`ref/database.sql` regenerates itself: the pre-commit hook runs
`scripts/dump-schema.js` SYNCHRONOUSLY by default (the
schema change lands in the SAME commit — the old detached default missed
`court_item_*` by 14 seconds). `SCHEMA_DUMP_ASYNC=1` backgrounds it for one
commit; `SKIP_SCHEMA_DUMP=1` skips it (`SCHEMA_DUMP_SYNC=1` still forces
sync — a no-op unless the hook default is flipped back). A structural
fingerprint (7 information_schema queries + a `database()` probe, volatile
fields excluded) gates the full dump — no diff churn. Commands:
`npm run db:ref` (`--force`, `--check`, `--timing`). DB failure warns and
exits 0. The hook does NOT touch `ref/routes.md` — regenerate that by hand
(`node scripts/updateRoutes.js`). A laptop reaches the DB through the Cloud
SQL Auth Proxy, which `dump-schema.js` (and `npm run dev`) start on demand
via `scripts/ensure-sql-proxy.js` — opt-in by `DEV_SQL_PROXY_INSTANCE` in
`.env`, inert on Cloud Run and CI; proxy down = the hook warns, skips the
schema step and the commit goes through (`ref/INFRA_GCP.md` §10).
**Schema COMMENTs are the annotation channel**
— landmine notes go into the live DB via migration and flow into the dump
(see 2026-09-14_schema_comment_backfill.sql).

## ═══════════════════════════════════════════════════════════════
## 26. TRIGGER SYSTEM — DOMAIN EVENTS
## ═══════════════════════════════════════════════════════════════

*The fourth engine — §1's "Three Engines" framing predates it. Rules that
fire on INTERNAL domain events; third consumer of the shared automation
primitives (`hookFilter` / `hookMapper` / `lib/actionDispatchers`) after
YisraHook (§16) and the ingest rule layers (§27–28). Operator docs:
`manual/03-YisraFlow/15-triggers.md`; every table/column:
`manual/03-YisraFlow/12-database-schema.md`.*

### emit() contract (`lib/domainEvents.js`)
Fire-and-forget, NEVER throws/rejects — call it bare from service
post-commit zones, no `.catch()`. Engine failures are console.error'd and
alerted (`trigger_engine_error`); the caller's flow is never affected.

### Envelope
`{ event, ts, depth, chain, source ('manual'|'system'|'client'|'booking'|null),
actor:{user_id}|null, contact_id, case_id, data (row AFTER mutation),
changes ({field:{from,to}} — update-class events only), extra }`.
`contact_ssn` is stripped from `data` unconditionally — envelopes persist
into `trigger_executions.envelope`.

### Split-phase dispatch (2026-08-30)
`emit()` only INSERTs into `domain_event_queue` and rings a Cloud Tasks
doorbell. `lib/domainEventDrain.js` evaluates the tree request-bound
(`POST /process-domain-event/:id`; 60s `/process-jobs` cron fallback) at
full CPU. The queue row is the scheduling authority; the task is a doorbell.
(Before: detached post-response tail = CPU-throttled, unbounded wall time.)

### Tables
- `trigger_rules` — per `event_type`; `match_mode` `conditions|code`,
  `transform_mode` `passthrough|mapper|code`, `min_interval_s` throttle,
  `match_count`/`error_count` metrics. Live SQL edits propagate — no cache.
  NOT covered by automation versioning (that is workflows + sequences only).
- `trigger_rule_actions` — ordered; `action_type`
  `workflow|sequence|internal_function|http|hook` (`hook` re-enters the
  YisraHook pipeline). **The UI DELETE+REINSERTs these rows on every save —
  never patch by action `id` (§15 pitfalls / CLAUDE.md).**
- `trigger_executions` — exactly ONE row per processed event
  (`matched|partial|no_match|no_rules|depth_capped|error`), carrying the
  envelope. `no_match`/`no_rules` rows are kept ON PURPOSE — they are the
  sample-envelope source for the trigger UI's field-discovery panel.
- `trigger_execution_rules` — per-rule outcome detail.

### Hard semantics (carried from the ingest rule engine — do not soften)
- A THROWING match counts as NON-match (fail-safe), and is RECORDED —
  warning on the execution row + `error_count` bump + `trigger_match_failed`
  alert. Fail-safe, not fail-quiet.
- `NULL match_config` in conditions mode = NON-match, NOT match-all.
  Explicit always-match is `{operator:'and', conditions:[]}`.
- A failed transform → rule counts as MATCHED (metrics) but its actions do
  NOT fire. Never feed garbage to actions.
- Action failures are isolated — one failure aborts neither the rule's
  remaining actions nor later rules.

### Loop guard
Actions run inside `runAsAction(ruleId, fn)` (AsyncLocalStorage): re-emitted
events carry `depth+1` and the rule id on `chain`; events at
`depth >= MAX_DEPTH` are dropped with a `depth_capped` row + alert. Known
limitation: workflow steps deferred through `scheduled_jobs` resume with a
fresh ALS scope (depth resets) — acceptable, executor cadence throttles them.

### Replay
`POST /api/triggers/replay` is execution_id-ONLY (review item S10): it
re-dispatches a RECORDED envelope — real actions, new execution row. Raw
envelopes are not accepted.

### Event vocabulary (live in code, 2026-09-14)
`appt.created/attended/no_show/cancelled/rescheduled/reschedule_later`,
`calendar.scheduled/rescheduled/cancelled/resolved/approaching`,
`case.updated/stage_advanced/stage_aged/contact_linked/contact_unlinked/
court_processed/trustee_validated`, `contact.created/updated`,
`document.created/updated/linked`, `esign.sent/status_changed`,
`form.submitted`. Nightly synthetic emitters follow one house pattern
(`emit_stage_aged`, `emit_calendar_approaching`; catalog in the manual).

## ═══════════════════════════════════════════════════════════════
## 27. EMAIL INGEST
## ═══════════════════════════════════════════════════════════════

*The front door for inbound (and outbound-copy) email. Operator docs:
`manual/03-YisraFlow/10-ingest.md`.*

### Entry
`POST /api/email/ingest` (`routes/api.emailIngest.js`, rate-limited),
api-key auth against `email_ingest_sources`. Adapters normalize and push:
SiteGround PHP (domain mailboxes) and Google Apps Script for the Gmail firm
account — the deployed GAS source is tracked at `ref/gas.js` and code
comments cite it by FUNCTION name, never line number. It carries no secrets —
the ingest key and Pabbly URL live in its Script Properties (`INGEST_API_KEY`,
`PABBLY_DOCS_RELAY_URL`); the key was committed here 2026-06-03 → rotated 2026-10-08.

**In-process source `mailbox-imap` (mailbox S1, 2026-10-08):** the IMAP worker
(`services/mailbox/mailboxIngestService.js`, `ALL /mailbox-ingest`, Cloud
Scheduler every 5 min) calls `ingestEmail` directly — no HTTP, no key (the
row's key is unpresentable by construction; ref/migrations/2026-10-08_mailbox_s1.sql).
It emits only folders flagged `emit_to_rules`, and only mail arriving after a
folder's first poll (history is stored, never emitted). Its
`headers.message_id` is the RFC Message-ID; `gmail-firm` posts Gmail's
INTERNAL id. **Dedupe is per source** — `(source, message_id)` — so one email
reaching both sources is logged twice and Layer 3 fires twice: never emit a
mailbox whose mail is already forwarded into the Workspace inbox. Inactive
source row = emit kill switch for every mailbox emitting under it.
**Emission override (S1-G):** `mailboxes.emit_source_name` + `emit_id_kind`
(SU PATCH only, as a pair, active source, `provider` never under
`mailbox-imap`, one provider-keyed mailbox per source) let a mailbox emit
under another source — the Gmail mailbox emits as `gmail-firm` keyed by
`mail_messages.provider_id` = hex(X-GM-MSGID), the Apps Script's own key, so
both feeders collide into one log row. A provider-keyed message without a
provider id is stored + alerted, NEVER emitted under the RFC id. In-process
emission reads source `id`/`name`/`active` only — never `api_key`, never
stamps `last_used_at` (that column = last HTTP post). Feeder tell in
`email_ingest_executions`: `remote_ip` NULL = worker, set = HTTP adapter.
**Gmail = `[Gmail]/All Mail` as the ONLY folder** (ruling 2026-10-11): one
copy of inbound, sent and label-filed mail; never All Mail ALONGSIDE other
folders (double store — `GET /api/mailboxes/:id/folders` warns). A
provider-id mailbox emits its sent mail too (the Apps Script posts it — design
§4.1 amendment). **Drafts are never stored nor emitted** (worker DRAFT
GUARD: the `\Draft` flag OR the Gmail `\Draft` label — Gmail does not flag
drafts in All Mail — and Gmail re-creates drafts per autosave). Gmail labels
(X-GM-LABELS) are stored per row as a snapshot for the comms hub
(`mail_messages.gmail_labels`, S2-L) and never ride the envelope; `\Draft`
is the one label the worker acts on.
Pilot, gate and retirement runbook: `ref/MAILBOX_GMAIL_PARITY.md`.
Operators: manual/08-Admin-Tools/08-mailboxes.md.

### Three layers — and the independence invariant
1. **Forensic** — `email_log` row for EVERY ingest, including firm-to-firm
   and duplicates: the byte-level record. Dedup is a pre-check on
   `(source, message_id)` + race-safe `INSERT IGNORE`.
2. **Suppression (Layer 2)** — decides the structured LOG WRITE only.
3. **Automation (Layer 3)** — ALWAYS runs, regardless of suppression AND of
   the downstream log-write outcome (Slice 2.3.1 hoisted it above the log
   step precisely so this holds on error branches). Matching rules'
   transforms run; actions fire via `lib/actionDispatchers` + hookService.

Then conditional `logService.createLogEntry` (skipped iff suppressed;
`INVALID_LOG_LINK_ID` → `error` execution row that still carries Layer-3
outcomes in metadata). One `email_ingest_executions` row on EVERY path,
including auth failures (written by the route).

### Direction & firm-to-firm
`from.email` domain ∈ `EMAIL_DOMAINS` → `outgoing`, else `incoming`.
All addresses on firm domains → firm-to-firm: forensic row yes, structured
log no.

### Tables
`email_log`, `email_ingest_sources`, `email_ingest_rules`,
`email_ingest_rule_actions`, `email_ingest_log_suppressions`,
`email_ingest_executions`. The `email_router_*` tables are DEAD (tear-out
pending). Collation: `court_ai_log.message_id` and `email_log.message_id`
are both `utf8mb4_general_ci` live (verified 2026-10-05) — the explicit
`COLLATE` clauses on the court-side joins are no-ops kept as insurance
against re-divergence (CLAUDE.md).

## ═══════════════════════════════════════════════════════════════
## 28. PHONE / SMS INGEST
## ═══════════════════════════════════════════════════════════════

*Calls, SMS, and other provider phone events. Operator docs:
`manual/03-YisraFlow/10-ingest.md`.*

### Entry chain
RingCentral / Quo webhook → YisraHook receiver (§16) → workflow → `phone_log`
internal function (`lib/internal_functions/log.js`) →
`services/phoneIngestService.js`. The pipeline body is a verbatim extraction
of the old inline `phone_log` implementation; Layer 3 was wired in after,
mirroring email.

### Line resolution lives in the hook transforms (DB-stored)
The firm line an SMS belongs to (`phone_event_log.line_number`, which drives
the Comms phone views and the comms archive's credential) is picked by the
hook's code transform, not by app code — and each transform carries its own
HARDCODED line map. **Adding a line in Connections → Phone Lines is not
enough: add it to the provider's map too.**
- `rc-message-in` (hook 21): `LINES` — RC numbers; the first `to[]` entry in
  the map is the line, else `to[0]`.
- `quo-message` (hook 16, v3): `QUO_LINES` — Quo `phoneNumberId` (=
  `phone_lines.provider_id`) → number. Incoming: the line is the inbox the
  webhook fired for; an unknown inbox falls back to the first recipient.
  Quo sends a GROUP text's `to` as one comma-joined string (v2 ran the digits
  together); v3 splits it and emits `recipients` (wf 18 does not forward it
  today). Outgoing group send: line = `from`, other party = the FIRST
  recipient that is not the line, so it threads under that client only.
  Source + install: `ref/migrations/2026-10-15_hook16_quo_message_group_to.console.js`;
  `tests/quoMessageTransform.test.js` runs those exact bytes.
- A group text to a RC line AND a Quo line arrives once per provider → one
  event per line (no fan-out, no firm-to-firm suppression: `firmToFirm`
  tests the SENDER). The all-lines contact thread shows both copies.

### Pipeline (per event)
1. **firmToFirm enrichment** — stamped as `extra.firmToFirm`, a MATCH FIELD,
   not a hardcoded skip: suppressing firm-to-firm traffic is an operator
   choice via a normal suppression rule. (Hence no `skipped_firm_to_firm`
   status on phone — it surfaces as `suppressed` or `logged`.)
2. **MTH-2 dedup pre-check** — SELECT on the unique `(provider,
   provider_ref)` key BEFORE Layers 2/3. A TRUE redelivery of an
   already-TERMINAL event returns a `duplicate` execution row that ECHOES
   the original outcome, and Layers 2/3 do NOT re-run — redelivery can
   never re-fire automation. `log_id` alone is NOT the terminal test (the
   suppressed path never writes a log). Skipped when either key half NULL.
3. **`phone_event_log` forensic catch-all** — ALWAYS, idempotent upsert.
4. **Layer 2 suppression** — LOG WRITE only (design call 1A); never halts
   the surrounding workflow. `output.suppressed` surfaced for branching.
5. **Layer 3 rules** — ALWAYS, independent of suppression and log outcome.
6. Conditional `createLogEntry`; exactly one `phone_ingest_executions` row
   (`logged|suppressed|error|duplicate`).

### Tables
`phone_event_log`, `phone_ingest_rules`, `phone_ingest_rule_actions`,
`phone_log_suppressions`, `phone_ingest_executions`. The firm-number cache
has a reset hook (`resetFirmNumberCache`) re-exported through the internal
function registry for tests.

## ═══════════════════════════════════════════════════════════════
## 29. TOOLS — SU-AUTHORED, DB-STORED PAGES
## ═══════════════════════════════════════════════════════════════

Internal HTML utilities stored in the DB and served on the app origin. An SU
authors a page in the manager; it is served at `/tool/<key>` and runs as an
iframe child of the shell and reaches it through the tool shell API,
`window.parent.ycTool` (runtime contract below); `parent.apiSend`, the
customView-style contract, still works and is legacy.

Code: `routes/api.tools.js` — **its header block is the contract; read it
before changing anything here.** UI `public/toolManager.html` (Admin tab →
Tools (SU)). Manual `manual/08-Admin-Tools/06-tools.md`. Tests
`tests/apiTools.routes.test.js`.

### Tables
- `tools` — `tool_key` varchar(80) UNIQUE (`/^[a-z0-9-]{1,80}$/`), `title`,
  `status` enum('draft','live'), `html` mediumtext, `updated_by` varchar(100).
- `tool_versions` — save history, FK → `tools` ON DELETE CASCADE.

No migration is filed for either table: plain DDL, wholly captured by
`ref/database.sql` (retention rule in `ref/README.md`). Absence of a file in
`ref/migrations/` is not evidence the change never happened.

### Invariants — do not soften
1. **Same-origin is deliberate.** A tool is authored code, not user content.
   The boundary is *who may write the table*, not what the HTML may do. Never
   reason about a tool body as if it were untrusted input, and never "fix"
   this by sandboxing the output.
2. **`/tool/*` and `/api/tools/*` stay OFF the `routes/pageLanding.js`
   allowlist**, so they dead-end on the landing host. Locked by test. Nothing
   in this subsystem touches the `pages` table or the landing-host system.
3. **Write path is SU-only with step-up.** Every `/api/tools/*` route carries
   `superuserOnlyFor('tools')` — JWT-only + SU + `X-SU-Elevation` + per-tool
   rate limit; API keys are refused 403. `superuserOnlyFor` audits only
   REJECTIONS, so each successful create/update/delete/restore audits itself
   via `auditAdminAction` (same pattern as `admin.systemAlerts.js`). Reads
   are not audited.
4. **Serve path is public and unauthenticated.** `GET /tool/:key` is gated
   only by `status='live'` — a draft 404s. Treat a live tool's body as
   readable by anyone holding the URL. 404 is plain text, deliberately not
   the `deadPage` firm-site redirect: an internal utility URL is not
   marketing surface.
5. **Versioning (single source of truth).** On any save where `html` is
   provided AND differs from stored, a `tool_versions` row is appended with
   the NEW html — so the newest row always equals `tools.html` and restore is
   literally "copy row N back". A title/status-only PATCH appends nothing; a
   no-op restore appends nothing; deleting the newest version row is a 400.
   The append is non-transactional by house style — a crash between the two
   statements loses one history row, never the tool.

### Runtime contract — the tool shell API (ui-custom S3.3)
- **What:** `window.ycTool` on the shell, defined beside `openToolDialog` in
  `public/index.html`'s `<script id="ycToolDialogJs">` (its header comment is
  the contract); a tool reaches it as `window.parent.ycTool`. `version` 1;
  `apiSend(path, method, body, {quiet})`, `authReady()`, `toast(msg, kind)`,
  `close(win)`, `resize(size, win)`, `openCase(id, win)`,
  `openContact(id, win)`, `exec(id)`.
- **Invariants:** token-free — no member returns or exposes the JWT or
  `AUTH_STATE` (the two-transport rule, §3); `apiSend` delegates to the
  shell's frozen apiSend with every guard, and `quiet` rejects
  `ToolAuthError` instead of the blocking login when the client-held session
  is missing or expired — it does not suppress apiSend's prompts on a server
  401: the SU step-up (`elevation_required`) and the re-login still appear.
  `close` / `resize` /
  the dialog-closing half of `openCase` act only when `win` is the open
  dialog's page or nested in it — an API contract, not a boundary
  (invariant 1). Dialog sizes are presets end to end (`compact` | `large`):
  firm item `action.size` (lib/uiConfigShape.js `SIZES`; optional, absent =
  large and stays absent), `openToolDialog(url, {size})`, `resize`. The object
  is frozen and non-writable; `parent.apiSend` keeps working for older tools
  and customView.
- **Firm actions are tools** (2026-10-15): there is no declarative `action`
  launcher kind. An SU writes a tool; a firm admin places it as a `tool` firm
  item (the More grid's firm row, All, Ctrl-K). Reference copies of DB-stored
  tools live in `ref/tools/` (`clio-code.html`, kept byte-identical to the
  live row).
- **The one sanctioned exception** (2026-10-16): `ref/tools/clio-code-2.html`
  does the same job as `clio-code` but draws its popup with `window.top.Swal`
  — the shell's SweetAlert2 — instead of rendering in its own frame, to keep
  the pre-S3.3 dialog at full screen size rather than boxed in the 480x480
  card. Same origin, no `sandbox`, so it works; it is a contract break, not a
  boundary break, and its header says so at length. The token rule is NOT
  bent: data still rides `ycTool` and nothing reads `AUTH_STATE`. Both tools
  may be live at once; `clio-code` is the pattern to copy.
  It reaches the shell in exactly TWO places, and a test asserts that count
  (`tests/clioTool2.test.js`, the `top.` set): `top.Swal` to draw, and
  `top.document.head` to append a `<style>` hiding `#ycToolDialog` while the
  popup is up — the whole dialog, not just `.yc-td`, because the dialog's own
  `--backdrop` would otherwise stack under swal's and dim the app twice.
  The WRITE is the sharper half: a read cannot leave damage, but a `<style>`
  orphaned in the shell's head by a mid-flow throw would make every later tool
  dialog in that tab invisible. Hence removal on every exit plus a `pagehide`
  backstop; the residual risk was weighed and accepted (2026-10-16). The
  sanctioned fix, if a second tool ever wants this, is a `ycTool` member the
  shell owns and resets in `close()` — additive to v1, testable, no orphan
  state possible.
- **Pointers:** manual `manual/08-Admin-Tools/11-tool-actions.md`; tests
  `tests/toolShellS33.test.js`, `tests/clioTool.test.js` (shell harness
  `tests/helpers/toolShell.js`).

## ═══════════════════════════════════════════════════════════════
## 30. ACCESS CONTROL — ROLES, CAPABILITIES, ENTITLEMENTS, KEY SCOPES
## ═══════════════════════════════════════════════════════════════

Built 2026-10-14 (access-control arc; design = ref/ACCESS_CONTROL_DESIGN.md,
the living authority — this section is the register).

**Staff authz.** `users.user_auth` is AUTHN STATUS ONLY ('authorized' /
'disabled'); the 'authorized - SU' string regime is deleted repo-wide and a
literal-guard test (tests/accessA2bCollapse.test.js) keeps it out. SU = the
`su` member of `users.roles` SET('it','admin','staff','attorney',
'automation','form_dev','su'), minted into the 24h staff JWT.
`lib/auth.superuser.isSuperuser(auth)` / `rowIsSuperuser(row)` are the only
SU predicates (row variant requires user_auth startsWith 'authorized' — a
DISABLED user is never SU). Capabilities: lib/capabilities.js CAPABILITIES
(root-grade vs firm-grade; `su` passes all, `it` passes non-root, others via
ROLE_CAPS) + `can(auth, cap)`; gate expression
`requireAuth({audience:'staff', can:'<capability>', allowApiKey:true})`.
Mounted today: firm.settings (ui-config firm writes, entitlements, the Config
vocabulary writes — field-defs, calendar-types-admin, pipeline-admin,
contact-role-types — and app-settings writes of firm / portal / config keys),
system.settings (app-settings writes AND reads of system / comms / cta keys —
it + su; admin does not hold it), automations.manage (/api/hooks management +
pages create-hook). app-settings decides the capability PER KEY from its
registry home (§32). Roles UI: users pane
(su grants/revokes need an SU caller; nobody removes their own su).

**Entitlements (launcher denies).** `entitlement_denies` (deny-only rows;
scope firm(''), role, user; UNIQUE over the triple), resolver
services/entitlementService.deniedFor → `denied[]` in /api/firm-data
(fail-soft []). item_key = public/js/featureRegistry.js keys or `firm:<slug>` ids;
`moreSettings` + `helpSupport` undeniable (write-reject AND resolve-strip).
Visibility-only; CRUD behind firm.settings. Editor: the Firm tab's "Who sees what" section (public/caseconfig/firm.html, ui-custom S3.4) — per-USER denies only; ROLE scoping is the firm registry_overrides `visible_to` allow-list (lib/uiConfigShape.js; su implicit), never role denies.
A deny (`data-yc-denied`) only HIDES launcher elements — the delegated
`[data-target]` handler never checks it — so programmatic opens (URL restore,
§12 Workspace URL; the palette) go through `ycLauncher.exec`, which refuses
denied / admin-gated / firm-hidden ids (wsurl S2, F2 of its review).

**Key scopes.** Both key tables carry `scopes` JSON; NULL = legacy full
surface MINUS `explicit` scopes (sql.ro.sensitive — a legacy key never
gains it). Vocabulary + keyAllows/routeAllowed in lib/capabilities.js.
Session (ycro_) keys: surface scopes (sql.ro, scratch, alert, temp.*);
mints default sql.ro+scratch+alert; new bodies are 22-char base62 (old
64-hex keys valid forever; identity = sha256 of the first two _-segments).
Machine (yck_) keys: route:/<path> prefix scopes enforced in jwtOrApiKey
(403 forbidden_scope, audited under the key label) + capability scopes on
requireAuth({can}) routes; the two Cloud Scheduler keys are route-scoped.
Optional `api_keys.expires_at` (B6; NULL = never — every pre-B6 key and the
infrastructure keys): an expired key is refused exactly like a revoked one
(lookup → null → the JWT fall-through), and the 60s lookup cache re-checks
the cached row's expiry on every hit, so only REVOCATION and edits keep the
≤60s cross-instance lag. Mint input `ttlMinutes` (the session-key mint's shape;
1 min–5 years, junk = 400, never a silent "never"). The api-keys pane's scope
picker is served by the GET (`scope_vocabulary`: CAPABILITIES + route
families walked from the live router, lib/routeFamilies); the POST stays the
judge. Table tiers + sql.ro.sensitive: §22.

**Delegated session keys (D1, design §5.8).** A session key holding
`keys.mint` (SU-minted, explicit) mints / lists / revokes its OWN children:
`POST|GET /api/readonly-keys/children`, `DELETE …/children/:id`
(session-key authed; another key's child = 404). Child scopes ⊆
CHILD_SCOPES (sql.ro, scratch, alert) ∩ parent — never keys.mint, sensitive,
temp.*, route or capability; TTL ≤ 24h and ≤ the parent's; anything over /
outside = 400, never clamped or dropped; 10 mints / rolling hour / parent,
DB-counted under a parent row lock (429). `readonly_api_keys.parent_key_id`
(FK RESTRICT; child created_by = parent's). lib/auth.readonly joins the
parent on every request: parent revoked/missing/expired → 401
`rejected_parent_revoked|expired`, no write to the child row; child scopes =
`childEffectiveScopes` (own ∩ trio ∩ parent, per request). `req.auth` carries
`parentKeyId` + `rootKeyId` — per-identity budgets (the IT-alert 10/h) key on
rootKeyId. A manager renews its own children (`POST …/children/:id/renew`).
`ip_allowlist` is RETIRED (never enforced; mint 400s on it; column
dropped post-deploy by stage 2 of scripts/accessD1ParentKey.js).

**Editing scopes + expiry (D2, design §5.9).** SU: `PATCH
/api/readonly-keys/:id {scopes}`, `POST /api/readonly-keys/:id/renew
{ttlMinutes?}`, `PATCH /api/api-keys/:id {scopes}`, `POST
/api/api-keys/:id/expiry {ttlMinutes}|{never:true}`. The mint's validators,
reused; a revoked key is a 409 (terminal, no un-revoke); no key is ever set
back to NULL scopes (legacy → scoped is the retrofit); adding
sql.ro.sensitive needs ≤24h left; renew = now + ttl within the mint caps for
the key's kind, 400 over (never clamped), works on an expired key, replies
`expiresStamp`. Editing a parent never writes its children. Machine edits
invalidateCache() locally; other instances ≤60s (old scopes / old expiry).
Audited before/after.

**Session-key tasks (D3, design §5.10) — the first app-table write.**
`tasks.own` (explicit; never a child's) → `/api/key-tasks` (POST, GET,
GET|PATCH /:id, PATCH /:id/complete|reopen|delete), all through
taskService. Ownership = `tasks.task_session_key_id` (no FK); foreign or
missing = 404. Assignee = active staff (taskService.findAssignableStaff:
user_auth 'authorized%' AND user_type <> 0). from = key's created_by; log
via session_key + keyId; assignment email default on; completion email to
the minter (`notify`) default on; 20 creates / rolling
hour / root key (DB count under GET_LOCK); the action token never leaves.
Not a sync-bus write (no /api/tasks* MATCHER exists).

**Audit log.** jwt_api_audit_log stores SHAPES, never content
(lib/auditShape; credential-named keys → [secret] with no length); URL/
referer redaction (SEC-1 credentials + the separate exact-name `q` rule)
unchanged; full history scrubbed 2026-10-14.

## ═══════════════════════════════════════════════════════════════
## 31. LAUNCHER & UI CONFIG (ui-customization arc, Oct 2026)
## ═══════════════════════════════════════════════════════════════

**What.** `public/js/featureRegistry.js` holds `FEATURE_REGISTRY` (one entry
per launcher button; the id is API surface — never renamed, never reused; its
header lists retired ids; an item's `gate` — `'su'` or a lib/capabilities
name — is what its routes enforce) and `DEFAULT_LAYOUTS` (home / sidebar /
more / admin as `{item}|{break}|{label}`, plus the icon rows homeIcons /
moreIcons / adminIcons — `{item}` only, ≤12: the small buttons under each
grid, Casey's paw and All). `window.ycLauncher` (public/index.html) renders
the seven surfaces at parse time, then `applyAccess({ isAdmin, roles, denied,
ui })` (from loadUserContext; re-run after any editor save) applies
the overlays. `computeEffective` (pure) = registry − gated (a `gate` the
user's roles don't pass by `can()`'s rule, su passes all; the Admin PAGE item
has no gate — the firm's `visible_to` decides it) − `denied`
(entitlement_denies, §30) − firm `hidden` − role-restricted (firm
`visible_to`) + firm items + the user's own buttons ("Mine"), renames applied.
`ycLauncher.exec(id)` is the ONE programmatic activation (All, Ctrl-K, user
shortcuts, URL restore) and refuses anything not effective. The All tab +
palette live in `public/js/ycAll.js`, whose single keydown dispatcher also
runs user shortcuts (the All tab never lists `all` itself; the palette does);
the personal editor is `public/js/ycLayoutEditor.js` (All > Customize my
launcher; its lists are the user step over the firm's `layout`); the firm
editor is the Config shell's Firm tab (`public/caseconfig/firm.html`: the
firm's settings sections (§32), then Launcher + Who sees what, History over
both firm documents), whose "Arrange
pages and defaults…" opens the same `ycLayoutEditor` in firm mode
(`open({ scope:'firm' })`, drawn in the top document; edits the firm `layout`
over all seven surfaces and the firm's pages, ONE PUT with `base`, 409 →
Reload; the More list closes with the firm row while the firm has no
`placed.more`; `open({ scope:'firm', section:'pages', page })` lands on one
firm page's block — firm.html's "Arrange its tiles…" on a Page item).
**Pages (S6c-5).** A firm item or a user's button of kind `{ type:'page' }`
is a main tab of its own like More / Admin: `ycLauncher.buildPages` (from
applyAccess) draws one `<div class="tab-main yc-hub" id="ycPage-N"
data-yc-page="<item id>">` per effective page item into `#ycPages` (between
`#tabAdmin` and the stage) — heading as text + ycIcon, tiles as neutrals
(a panel item's with `data-target`, opening in place on the stage), a
`.page-egg-row`; contents from that tier's `layout.pages[id]` (`{ tiles,
icons }`, no base: the lists ARE the page; non-effective items not drawn);
`exec(pageId)` → `openMainTab`; a sidebar neutral for a page carries its
tab in `data-tab`. The tab id is per session and opaque: the WORKSPACE URL
never writes it and refuses it as a head (F5 on a page lands on Home —
Fred's ruling Q4, v1). The class is `yc-hub`, NOT the design's `yc-page`:
`/js/ycPager.js` owns `.yc-page` in the shell document. The drawer kind is
called **List** in every UI string; its stored type stays `drawer`.

**Storage.** One table, `ui_config` (scope firm|user; `user_id` 0 / `role`
'' sentinels are load-bearing for the UNIQUE; `role` reserved). Firm
`registry_overrides` = `{ hidden, renames, locked, items, visible_to, retired }`
and firm `layout` = `{ placed, removed, pages? }` over every surface (the
firm's default; More, Admin and their icon rows are firm-only) plus
`pages { 'firm:<slug>': { tiles?, icons? } }` (S6c-5; ≤50 keys, tiles the
grid grammar ≤100, icons items-only ≤12, keys of the scope's own id shape) —
both versioned in `ui_config_versions`, optimistic `base` → 409. User keys:
`layout` `{ placed, removed, pages? }` per surface (home, sidebar, homeIcons;
`pages` keyed `user:<slug>`), `shortcuts` `{ bindings }`,
`items` (own buttons, ≤50, `user:<slug>`; a button may be a drawer,
`{ type:'drawer', items:[ref…] }` — ≤30 refs, one level deep — or a page,
`{ type:'page' }`, at both tiers), `prefs` `{ theme }`. `retired`
lists are server-managed (a deleted firm/user item id never comes back —
layouts and shortcuts point at ids). Strict validator `lib/uiConfigShape.js`
(linear regexes, timing-tested); `services/uiConfigService.js`;
`routes/api.uiConfig.js`; delivered to the shell in `/api/firm-data` `ui`.
Boundary: scalar firm facts with server-side consumers (logo, site URL,
phone) stay in `app_settings` `fe-*` / `lib/firmConfig.js`; structured
UI-layout documents live here. No tenant column by design: under the
DB-per-tenant plan (ref/plans.md) firm scope simply becomes the tenant's.

**Invariants.**
- Visibility only: every hide — deny, firm hide, `visible_to`, a user's
  removal — hides tiles; routes enforce their own gates.
- Removal HIDES, reorder MOVES: default launcher elements always stay in the
  DOM (ids like sbAdmin / sbComms / badges are looked up elsewhere), hidden by
  attribute (`data-yc-denied`, `data-yc-unplaced`) + `!important`, never
  `style.display`. Added placements are neutral `exec` shortcuts — except a
  PANEL item's tile on a grid page, which carries the item's `data-target`
  and no listener (S6c-4): the page's delegated handler opens the panel in
  place.
- The panel stage (S6c-4): every More / Admin panel div is a child of ONE
  container after the tabs, `#ycPanels` (not a `.tab-main`), and never
  moves — a moved `<iframe>` reloads and loses unsaved work. The drill is
  page-scoped: a tile's page is `closest('.tab-main')` (More, Admin or a
  custom page in `#ycPages`), each page remembers the panel it last opened
  (`drillMemory`), `openMainTab` shows the active page's remembered panel or
  hides the stage (`stageSync`), `exitDrillMode` forgets; a panel's
  `display` is '' iff it is the one on the stage now. One panel may sit on
  any number of pages (one element). `exec` of a grid item routes by page:
  `opts.page`, the active page, More, Admin, the firm pages, the user's
  pages — the first that SHOWS a tile for it; else the hidden default tile.
  Panel CSS targets `#ycPanels > div`; the hubs' phone grid rules and the
  egg rows key on `.yc-hub` / `.page-egg-row` (every hub carries `yc-hub`).
  Pane pages reach the shell via `window.parent`, unchanged; the Simple
  Forms → Form Builder hand-off goes through `exec('moreFormBuilder')`.
- A page (S6c-5) deleted or restricted while open: `buildPages` opens Home
  first, forgets its drill memory (`exitDrillMode` — the memory is keyed by
  the tab id, which the item keeps for the session), removes the tab. A
  gated / hidden / denied item placed on a page is not drawn there and gets
  no pill — the page shows only what its viewer may open (fuzzed in
  `tests/launcherS6c5.test.js`). Blocking a page (`visible_to` / hide /
  deny on its id) hides its openers everywhere; its contents stay reachable
  through All. Per-tier page count = the items cap (50).
- Layouts resolve shipped → firm → user with ONE merge rule applied twice
  (`resolveLayout`): a firm Home / sidebar change only ADDS for a user who
  already arranged that surface (`locked` is how the firm insists). More /
  Admin grids are firm-editable, never user-editable: every grid item keeps
  its tile under any layout — found by id, hidden by `data-yc-unplaced` when
  left out (the wsurl drill restore depends on `elementsOf(id).more/.admin`
  and refuses an unplaced tile); the More firm row draws only while the firm
  has no `placed.more`.
- Layout entries are `{item}`, `{break}` (Home and the grids) and `{label}`
  (sidebar) ONLY: no pixel spacing and no stored column counts — how many
  tiles fit a row is CSS's call per viewport. The one extension the design
  allows is a per-list density preset; anything else is a design decision
  first.
- All (`all`) is GUARANTEED in Home's icon row and in Ctrl-K (ruling
  2026-10-16): undeniable, and the resolver puts it back whatever a layout
  says; the sidebar's All is an ordinary, removable item.
- The Admin page follows the firm's `visible_to` on `admin` (live: it, admin;
  su always); each Admin tile follows its own `gate` (today every tool but
  Etch is `su`), so a non-su sees the page with only what they can open.
- DB-authored items carry no code: kinds url | tool | view | page (S6c-5,
  both tiers: the action is just its type — its tiles live in the tier's
  `layout.pages`), plus drawer for a user's own buttons (a list of ids;
  `exec` opens it as the `#ycDrawer` menu, listing only entries effective
  right now). Tool/view
  open in the tool dialog (they need the parent shell's `apiSend`) or, a
  user's own with `present:'tab'`, in the button tab (`window.ycButtonTabs`,
  `#tabUserItem`: ≤3 pages kept, LRU; never in `?open=`); links open
  a new window (noopener), never embedded. Custom behaviour for a firm = an
  SU-authored tool (§29), talking through `window.parent.ycTool`.
- Icons (S6a): ONE stored grammar,
  `^(?:(?:solid|regular|brands):)?[a-z0-9-]{1,40}$` (a bare slug is solid,
  so every value stored before S6a renders as it did), and ONE renderer,
  `public/js/ycIcon.js`, for every place that draws a stored icon (launcher,
  All / palette, both editors, the picker, firm.html via `window.top`). A
  value outside the grammar renders `fa-circle-question`, never a class built
  from it. The server's copy (`lib/uiConfigShape.js` `ICON_RE`) and the
  launcher's are pinned to it by `tests/ycIconS6a.test.js`. The picker
  (`ycIconPicker.js`) reads `/js/faIcons-6.5.0.json`, which matches the Font
  Awesome the shell loads (index.html's CDN link): upgrade the two together.
- NO_ELEMENT (S6b): an effective item with no rendered element — the
  registry's "More actions" placed in no default layout (`myTasks`,
  `logout`) — runs through `exec`'s CLOSED dispatch of named page functions
  (the fixed header's own calls), never an eval of the registry's `onclick`
  string. A new element-less registry item needs an entry there, or `exec`
  refuses it ("no rendered element"). An icon-row button is clicked in
  place, with no tab switch.
- `visible_to` is an allow-list ("Hidden, except [roles]"): su always sees
  everything; a role added later sees nothing restricted until ticked.
  `moreSettings` / `helpSupport` / `all` can never be hidden or restricted.
- Editors start from a fresh `GET /api/ui-config` (a stale tab or a fail-soft
  login read can never wipe a surface); the theme account value wins at login,
  localStorage is its write-through cache (the pre-paint script reads it).

**Pointers.** Operator docs: manual 05/14 (Firm launcher, Firm pages), 01/15
(your launcher: Lists, Pages), 08/11 (tool actions). Tests:
`tests/launcherS*.test.js` (pages: `launcherS6c5`, `launcherS6c5editor`),
`tests/uiConfigS*.test.js` (`uiConfigS6c5`), `tests/firmTab.test.js`,
`tests/themePrefsS5d.test.js`.

## 32. SETTINGS — REGISTRY, HOMES, CONFIG SHELL (settings arc, Oct 2026)
## ═══════════════════════════════════════════════════════════════

**What.** `lib/settingsRegistry.js` is the one list of `app_settings` keys the
code knows (code, not config — the capabilities / featureRegistry pattern):
per key its `kind` (firm · vocab · system · secret · state · access ·
retired), ONE editor `home`, `section`, `type` (the validator + control:
string, template, number, bool, email, csv, phone, url, json, json_array,
date, enum + `options`, and the picker types user · user_csv · credential ·
sequence, plus duration), `edit` posture (`ui` | `console`), `env` (the
firmConfig fallback), `editor` (a dedicated editor renders it), `required`
(blank refused) and `automation: true` (automation may write it). The row in
`app_settings` keeps only the VALUE; its category / label / description /
type / sort_order / is_editable columns describe UNREGISTERED rows only — the
"automation variables" a person creates in the Firm tab. A new key = a
registry entry in the same slice (tests/settingsInventory fails otherwise).
Kind is also the YC 3.0 provisioning classification (plans.md open decision
16): firm / vocab tenant-configured, system platform-provisioned, state
starts empty, secret per-tenant credentials.

**Homes → capabilities (derived, never per key — `HOME_CAPS`).** firm (Config
→ Firm), portal (Portal Manager → Settings), config (Config vocabulary tabs:
Lists; Types & Subtypes for `fe-case_types`) — read any staff, write
`firm.settings`; cta (CTA Links → Link defaults) — read any staff, write
`system.settings`; system and comms (Config → System; comms until the comms
arc gives its knobs a home) — read AND write `system.settings` (it + su);
console — never served (secrets, the interim access lists
`comms_archive_admins` / `comms_eval_reviewers`, retired keys). A row whose
`is_secret = 1` is a secret whatever the registry says (`isSecret`).

**API** (`routes/api.appSettings.js`). GET `/api/app-settings[?home=]` (any
staff) → `{ caps: { firm, system }, sections, settings: [ROW] }`: every
registered key the caller may read — with `exists:false, value:null` when it
has no row — plus the unregistered editable non-secret rows as home firm /
section `variables`; `can_edit` computed server-side. PUT `/:key {value}`:
staff mount, then the home's write capability per key (a machine key is gated
by that capability on the mount — a scoped key passes on the capability
alone), console posture / state / secret → 403, `reg.validate` → 400, a
missing registered row is INSERTed, an unchanged value writes nothing.
POST (create an automation variable, firm.settings JWT only) refuses a
registered key (409 naming its home). History: every human write and its
`app_settings_versions` row (key, old, new, changed_by, changed_via ui ·
api_key · create · restore) commit in ONE transaction; GET `/:key/history`
(the write capability) and POST `/:key/restore {version_id}` (puts back that
version's OLD value; same checks as PUT). Secrets are never written there:
the routes never write a secret. `firmConfig.invalidate()` after a change.
The restore route is on the sync bus (yc-sync MATCHERS, `setting:<key>`).

**Automation (§5).** set_setting / update_db: a registered key only with
`automation: true` (today `clio_login_code`, written by phone-ingest rule 4 —
verified the sole automation writer, 2026-10-17); unregistered non-secret
rows freely; secrets never (reads too). Automations' wider information
security is its own arc (plans.md).

**Config shell** (`caseConfigManager.html`). Tabs: Types & Subtypes,
Pipelines, Custom Fields, Contact Roles, Calendar Types, Lists, Firm (gate
`firm`), System (gate `system`). ONE `GET /api/ui-config` answers both gates
(`GATE_FLAGS`: can_edit_firm, can_edit_system — revealed only on `=== true`)
and `P.configCanEdit` (a getter: true / false, null while pending or when the
probe failed). Every loaded sub-page gets `window.onAccess({ canEdit })` when
the answer arrives, a later-loading one from its iframe load. Vocabulary
sub-pages start read-only (`<body class="cc-ro">`), apply
`ccApplyAccess(P.configCanEdit)` at init and in `onAccess`, hide write
controls (`.cc-w`), disable what they render (`ccLock`), open detail dialogs
view-only (`ccView`) and refuse every non-GET in their `api()` while
read-only; the shell hides topbar Save / New / Delete and shows the read-only
banner on ungated tabs. The server is the authority: vocabulary writes are
`requireAuth({ can:'firm.settings', allowApiKey:true })` (§30).

**My Settings** (`settings.html`) is personal only — account (+ booking
calendars), password, signature, **My access** (`GET /api/mailboxes` +
`GET /api/phone-lines/readable`: Read / Send / Manage, "via role" for the
attorney read bypass) and **Manage access** (for a non-SU `can_manage` grant:
the channel grant routes, no elevation — a grant is the authority). It calls
no settings API.

**Invariants.**
- One editor per setting: the registry's `home` is the only place a key is
  edited; the generic row renderer is `public/js/ycSettingRows.js`.
- Values are stored VERBATIM (Dropbox folder names carry load-bearing
  spaces); validators check a trimmed copy, never mutate; blank always passes
  a type — `required` is the only way to refuse blank.
- Metadata of a registered key comes from code; never read it from the DB.
- **Keys are exact; the column is not.** `app_settings.key` is
  utf8mb4_general_ci PAD SPACE — `WHERE key = 'Firm_Name '` reads the
  firm_name row — while the registry matches exactly, so an unknown spelling
  is gated as an automation variable. Anything that judges a key by name and
  then acts on the row it reads compares the row's own `key` with the asked
  one byte for byte: the per-key routes 404 another spelling, set_setting /
  get_setting refuse it as missing, POST refuses a key that folds onto a
  registered one (`registeredSpelling`); get_settings and update_db's guard
  judge the row's own key. Missing this let an alias walk past every
  per-key gate (review F1, 2026-10-18). The column comment says so.
- Retired keys stay registered (`kind: 'retired'`) so a name is never reused.
  `unified_singleton_enabled` (singleton supersession always on) and
  `esign_webhook_hmac_mode` (a set webhook secret always enforces) retired in
  this arc; their rows are deleted post-deploy by
  `scripts/settingsArcMigrate.js --stage2` (deleting first would read as off
  to the old build).

**Pointers.** Migration: `scripts/settingsArcMigrate.js` (stage 1 before the
deploy: `app_settings_versions`, column comments, `pabbly_internal_url`
secret, the two probe rows — and a NO-GO while a retired flag is off its
final value; stage 2 after) + `ref/migrations/2026-10-18_settings_arc.sql`.
Operator docs: manual 05/15 (Firm and system settings), 05/16 (Contact
roles), 08/08 (Manage access), 06/02 (portal settings), 08/07 (Link defaults).
Tests: `settingsRegistry`, `settingsInventory`, `settingsAutomationGuard`,
`appSettingsRegistry`, `appSettingsGate`, `settingsArcMigrate`,
`vocabWriteGates`, `configShellAccess`, `configReadOnly`, `mySettings`,
`contactRolesConfig`, `settingsToolHomes`, `ycSettingRows`, `firmTab`,
`configSystemTab`, `configListsTab`. Lists draws `fe-event_types` with a
dedicated editor (duplicates refused, a removal asks); System draws runtime
state as text, never controls.

## 33. ASK CASEY / YISRAI — READ-ONLY CONVERSATIONAL ASSISTANT

**Surface.** The persistent bottom-of-sidebar Ask Casey control and the
secondary More/All item both open one stable `public/assistant.html` iframe.
Compact/wide/mobile presentations change CSS classes only; the iframe is never
moved or recreated. Opening/collapsing it does not call `openMainTab` or URL
sync, so the active workspace and canonical `open=` target remain intact.
Staff JWT only.
`POST /api/assistant/plan {question,history,model_mode,temporary_attachments?,document_ids?,workspace_context?}`
returns a direct answer/refusal or
a plan; the UI immediately sends its ticket to `POST /api/assistant/execute`.
There is deliberately no confirmation for read-only operations. Plans are
HMAC-signed with `JWT_SECRET`, expire after 20 minutes and are bound to the
issuing user, so review and execution may land on different Cloud Run instances
without trusting client-returned SQL.

**Workspace context.** `ycAssistantContext()` is a narrow collector over
`currentOpenFilesUrl()` plus live shell labels; it does not reuse diagnostics.
Its submitted `snapshot` contains only `v`, canonical `/index?files=&open=`,
parsed file `{kind,id,rest}` records, and the parsed active file/tab. `ask=` and
all other one-shot parameters are excluded; display labels remain outside the
snapshot. The composer shows a removable chip and deep-clones the selection
before its first await. `assistantService` re-parses the URL, requires the
browser's parsed form to match, checks referenced case/contact rows, then signs
the normalized snapshot into the user-bound plan ticket. Planning, the one
repair pass, and answering receive that same immutable server-verified block.
It is evidence, never authority.

**Semantic navigation.** The first allowlisted destination is
`automations.court_review`. The shell checks `moreAutomations` in the effective
launcher registry, holds `courtReview` for the cold manager iframe, opens via
`ycLauncher.exec`, and resolves only after `automationManager.html` reports its
Court Review child loaded. An already-loaded manager uses the same narrow
bridge. The assistant cannot submit selectors, coordinates, URLs, or script.

**Operation vocabulary.** v1 enables `sql.read`, `manual.search`,
`comms.search`, and `weather.lookup`. Weather is a narrow adapter that accepts
only a location and constructs fixed Open-Meteo geocoding/forecast URLs in
`assistantWeatherService`; it is not arbitrary web access. Unknown kinds fail
closed. This is the extension seam for a
future action phase: compose/send email, field/form writes and workflow draft/
publish remain distinct operations and are NOT enabled by v1.

**Separation and bounded-loop invariant.** `assistant_plan` sees the
question/history and curated report schema, never rows. It emits the initial
read plan. SQL is validated by the report validator at plan time, signed,
revalidated from the ticket, then run
through `reportService.execute` (SELECT-only pool, EXPLAIN/timeout/row caps and
`report_runs` logging). The assistant layer additionally requires terminal
LIMIT ≤50, bounds `log`/`email_log` by date and refuses conversational reads of
SSN/EIN, DOB, tokens, attachments and delivery metadata. `comms.search` calls
`commsArchiveSearch` with the staff auth object, preserving phone-line grants,
restricted-media rules and snippet caps. `manual.search` reads only shipped
manual Markdown. Planner SQL explicitly collates both sides of text equalities
to `utf8mb4_general_ci`, insulating generated joins from legacy general/unicode
schema drift. `model_mode` is server-allowlisted: `better_quality` maps to
`claude-opus-5`, while `faster_speed` maps to `claude-sonnet-4-6`; arbitrary
provider model ids never cross the browser contract. The normal AI call ledger
records the resolved model and remains cost-aware. Assistant
SQL is retained in `report_runs` for developer diagnosis. If a SQL step hits
MySQL's illegal-mix error, the EXPLAIN workload gate, or the deployed server's
`LIMIT & IN/ALL/ANY/SOME subquery` incompatibility, the planner gets one repair
attempt inside the same server request. The last
case is rewritten as a direct ordered query or a JOIN to a limited derived
table; raw database errors are not returned to staff after repair is exhausted.

After each successful pass, `assistant_investigate` receives the immutable
signed viewer/workspace context plus accumulated evidence marked as untrusted.
It can return only `finish` or another read plan. Every follow-up is revalidated
and assigned server-owned citation ids; normalized duplicate operations stop
instead of running. The whole execute call owns the state—evidence and
follow-up plans never round-trip through the browser. Hard budgets are three
passes, eight attempted operations, 250 returned rows, 180 seconds, 7,000
controller output tokens, the existing 60,000-character evidence cap, and one
safe repair. The controller is also structurally limited to two calls; repair
and answer retain their prompt-level 4,000/2,500 output caps. `assistant_answer`
always writes the final response and is told the stop reason so it cannot imply
an exhaustive search after a budget stop.

**Staff roles and appointment time.** `users.roles` is exposed to this curated
surface and is the canonical answer to staff-role/capability questions;
`user_auth` is only login status and `does_appts` is only provider eligibility.
The planner must not infer a job title from calendar activity. `appts.appt_date`
and generated `appt_end` are naive wall times in `FIRM_TIMEZONE` (normally
America/Detroit), while `appt_date_utc` is the real UTC twin. Because the mysql2
pool runs with `timezone: 'Z'`, a raw local DATETIME can reach Node as a Date
whose ISO rendering misleadingly ends in `Z`. The planner uses `DATE_FORMAT`
with `*_local` aliases for display; the evidence compactor also labels raw
appointment Date values as firm-local so the answerer cannot mistake that
transport marker for timezone data. Planning context includes both real UTC and
the current firm-local instant.

**Current-user semantics.** Before each non-deterministic planning call,
`assistantService.loadViewer` resolves the JWT's `userId` against `users` and
loads only `user`, `user_name`, `user_initials`, and `roles`. The resulting
server-verified `<current_staff>` block is supplied to the planner, stored in
the HMAC-signed ticket, and supplied again to investigation, repair, and answer.
The browser cannot submit a viewer identity. Planner rules bind I/me/my/mine to
that numeric staff id (for example `appts.appt_with = user_id`), never a display
name or a similarly named contact. Old in-flight tickets without the block
remain executable and fall back to their already-bound ticket owner id.

Rows go only to `assistant_answer`, whose contract has no operation/SQL shape;
row text is untrusted data. It returns plain text plus `{query_id,row_number}`
citations that the service resolves against actual returned rows. Those
resolved rows also expose typed shell actions for stable `case_id`,
`contact_id`, `appt_id`, `event_id`, and `task_id` aliases; the UI dispatches to
`addFile`, `showAppt`, `showEvent`, or `showTask`. Follow-up suggestions are
`{label,query}` objects so display prose is never copied as the next question.
Text found in an email/log/call may be evidence for a bounded follow-up read but
is never instructions and cannot expand the original question. Initial planning,
investigation, and answering use `logContent:false`; `ai_calls` keeps
usage/cost/status, not client content.

**State/history.** `assistant_chats` and `assistant_chat_messages` hold the 30
most recently touched chats per `users.user`; every CRUD statement includes the
authenticated user ownership boundary. Messages store displayed text and the
assistant's structured citation/entity/suggestion payload, never SQL (that
remains in `report_runs`). The model still receives at most the latest eight
messages. The UI recommends a new chat at four user turns, while allowing the
person to continue. Migration:
`ref/migrations/2026-10-19_yisrai_chat_history.sql`.

**Attachments.** `assistantAttachmentService` accepts at most four PDFs/images
and 6 MB decoded bytes in aggregate, keeping the request under the app's 10 MB
JSON ceiling. Browser-selected bytes are transient: the browser sends base64
to plan and execute, the signed ticket binds SHA-256/name/media type, and chat
history stores metadata only. Existing files arrive as numeric document ids;
the service loads active rows through `documentService` and
`documentSourceService` and binds `rev`/`content_hash`, refusing execution if
the file changed after planning. All AI passes receive the files under
`aiService`'s attachment injection guard. **Save to case** is deliberately not
a model operation: an explicit user click reuses `/api/documents/upload-link`
→ direct browser-to-Dropbox upload → `/api/documents/upload-commit`.

**Reviewed task lifecycle.** `assistant_answer` may return one evidence-backed,
server-normalized create, update, complete, cancel, reopen, or transfer proposal.
The card is inert and visibly marked not applied. Its fixed **Review & …**
control opens the shell's SweetAlert confirmation with the exact target and
values, then maps only allowlisted fields to
the corresponding existing authenticated `/api/tasks` route. The route sees
the signed-in user as actor and preserves canonical audit, linking, reminders,
and notifications. The model cannot choose the endpoint, method, or extra
fields. Applied results persist in chat history so reopening the chat does not
offer the same write again.

For `task.create.v1`, Casey requires assignee/title/description. Start is a
not-before date and remains null unless requested; due is optional but suggested
for a stated deadline. Completion notice defaults false for self-assignment and
true otherwise unless explicitly specified. The fixed browser body stamps
`source:'Casey'`, omits `from` so the route uses `req.auth.userId`, and omits
`send_assignment_email` so canonical assignment email remains enabled.

This is the governing Casey action pattern: the user performs the action by
clicking a fixed control in their own authenticated browser. Prefer mapping
normalized fields into an existing application endpoint so user permissions,
actor identity, audit, and ordinary product semantics stay canonical. Treat a
new Casey-specific action endpoint as an architectural exception that requires
another design review, not the default way to add an action.

Every new action review must also audit the sync/event bus. If the canonical
write changes data visible in another frame or tab, its ordinary endpoint or
service must provide the canonical bus/domain-event signal and response shape.
Fix missing propagation for every caller; never add a Casey-only emit. The
`/api/tasks` family currently has no `yc-sync` matcher, matching the native
Tasks UI's established behavior; cross-frame task propagation belongs in a
canonical Tasks/bus arc.

**Reviewed Events lifecycle (Ask Casey A3, 10-20).** `assistant_answer` may
also return one `event.create.v1`, `event.update.v1`, `event.complete.v1`, or
`event.cancel.v1`. `assistantService` rejects extra fields, resolves the Event
type to a canonical label/key/kind, refuses meeting kinds, validates firm-local
ISO date/time, resolves creation-time links/providers/reminder assignees, and
requires 1–8 current evidence references. Existing-event actions additionally
need a cited row containing the exact `event_id`; the service reloads the row
and accepts only Scheduled, non-superseded targets.

Create requires type/title/date/all-day and a time when timed. Optional duration
is 1–1,440 minutes; null means the Event service's 60-minute Google default.
All-day normalizes time/duration to null and scope to firm-wide. Link is one
verified `case|contact|case_number` pair and is never updateable. Scope is null
(all providers), `0` (none), or a verified `does_appts` user. Reminder is null
or an assignable user plus a non-past firm-local date and uses the canonical
linked-Task side effect. Update exposes only type/title/date/time/all-day/
duration/location/URL/note/scope/reminder—not status, resolution, kind,
`type_key`, calendar id, dedupe, `skip_gcal`, link identity, or actor.

Complete and cancel use their dedicated `/api/events/:id/*` routes. Resolution
is server-defaulted and displayed (`deadline` complete → `met`, other complete
→ `held`, cancel → `cancelled`); only allowed staff-facing per-kind values
survive (`missed` remains sweep-owned). Cancel
also defaults and displays `delete_gcal:true`. The card/SweetAlert describes
Google Calendar and reminder effects. The browser fixes the four route/method/
body mappings and never sends `acting_user_id`; the authenticated Events route
stamps the actor. Single-flight/retry/history-result behavior mirrors Tasks,
and success opens `showEvent`.

No bus change was needed. `public/js/yc-sync.js` already maps the canonical
create/update/complete/cancel calls to `event:<id>` refetch markers, and the
Events tab, Calendar, case, and contact readers already subscribe. There is no
Casey emit. Event batch, delete/reopen, and calendar selection are not part of
A3; Appointments use the separate A4 contract below.

**Reviewed Appointments lifecycle (Ask Casey A4/A4.1, 10-20).** Seven closed
kinds are enabled: `appt.create.v1`, `appt.update.v1`, `appt.attended.v1`,
`appt.no_show.v1`, `appt.cancel.v1`, `appt.reschedule.v1`, and
`appt.reschedule_later.v1`. `assistantService` rejects extra fields, requires
1–8 current evidence references, resolves contacts/cases/provider/type labels
again, accepts only an active registry `meeting` type and active `does_appts`
provider, and validates future firm-local `YYYY-MM-DD HH:MM[:SS]` without a
timezone suffix. Create additionally requires contact, 1–1,440 minute length,
platform, and time; a case linked to that contact, note, and reviewed SMS/email
confirmation are optional. The normalized type carries the server-owned `type_key` and
singleton flag.

Existing actions need evidence containing the exact `appt_id`; the service
reloads joined current status/contact/case/provider/calendar state. Canceled
and Rescheduled are terminal. Attended and No Show can correct one another;
cancel and either reschedule form also accept those native correction states.
The broad canonical PATCH does not update calendars or automation, so Casey's
update body is intentionally limited to `appt_note` and `appt_case_id`; a new
case link is verified against the Appointment contact.
Date/time changes use the reschedule service; type, length, platform, provider,
status, GCal/ref/view/hook fields, `source`, and actor are excluded.

No-show defaults `enroll:false` and the review states possible no-show sequence
and intake-pipeline effects. Cancel defaults `cancel_gcal:true`,
`create_task:false`, and both outbound channels off; a chosen channel requires
the exact displayed message. Reschedule-now retires the predecessor, removes
old firm/provider calendar entries and automation, creates a lineage-linked
successor with new calendar/automation, optionally confirms the client, and
opens the successor. Reschedule-later creates no successor, removes calendar/
automation, and optionally creates the reviewed follow-up Task. Create review
also discloses firm/provider calendar attempts, no-show cancellation,
pre-appointment enrollment, and registry singleton supersession.

The browser owns seven fixed kind→route/method/body mappings through the
ordinary `/api/appts*` routes. Routes stamp authenticated actor and
`source:'staff'`; neither comes from the model. SweetAlert review, dialog/write
single-flight, retryable errors, persisted results, and canonical open-record
behavior mirror Tasks/Events. `yc-sync` already covers create, PATCH,
attended/no-show, cancel, and both old/new reschedule IDs, so no bus code or
Casey emit changed.

**Question deep links.** `ask=<encoded question>` may accompany any canonical
workspace `open=` target. It
captures a maximum-2,000-character draft in the shell, synchronously removes
`ask` from the address bar before auth/API fetches, and exposes it through the
one-shot `ycTakeAssistantDraft()`. The assistant assigns it only to
`textarea.value`; it never executes from a GET. Raw question URLs are an
accepted product risk and the operator manual warns that the original URL may
remain in browser/email/chat/proxy/server history. The canonical workspace URL
continues to contain IDs only.

**Pointers.** `services/assistantService.js`,
`services/assistantKnowledgeService.js`, `services/assistantChatService.js`,
`services/assistantAttachmentService.js`, `lib/assistantTicket.js`,
`services/assistantWeatherService.js`,
`lib/aiPrompts/assistantPlan.js`, `lib/aiPrompts/assistantInvestigate.js`,
`lib/aiPrompts/assistantAnswer.js`,
`routes/api.assistant.js`. Operator docs: manual 05/17. Tests:
`assistantService`, `assistantAttachmentService`, `assistantTicket`, plus
`assistantSidebar`, `featureRegistry` and manual coverage.
