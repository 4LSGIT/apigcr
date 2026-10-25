# MAILBOX_GMAIL_PARITY — Gmail IMAP pilot (S1-G): checklist, gate, parity window, retirement

Status: LIVING RUNBOOK — 2026-10-09; All-Mail ruling 2026-10-11; first close check 2026-10-25: NOT retired,
the window re-opens at the FETCH-merge fix's deploy (§4). Opened by slice S1-G of the mailbox arc
(`ref/MAILBOX_SYSTEM_DESIGN.md`); moves to `ref/archive/` when the Apps Script
source retires (step 6). Companion script: `ref/MAILBOX_GMAIL_PARITY.console.js`.

The Workspace account is ingested over Gmail IMAP by the mailbox worker and,
once verified, emits under the **`gmail-firm`** source keyed by
**hex(X-GM-MSGID)** — the same `(source, message_id)` key the Apps Script
adapter (`ref/gas.js`, `forwardEmailsToIngest()`) has always posted — so both
feeders collapse into ONE `email_log` row and can run side by side (ruling
Q1a). Why that matters: `email_log` dedupe is **per source only** (AI_CONTEXT
§27); a message reaching the pipeline under two sources fires Layer 3 twice.

**Nothing emits until the gate (step 3) passes.** The id equality is
documented by Google (X-GM-MSGID is "the decimal equivalent" of the web/API
hex id) and was proven on live data by G2 (51 of 51, 2026-10-10).

**The mailbox polls `[Gmail]/All Mail` ONLY** (ruling 2026-10-11, step 3b):
one copy of inbound, sent and label-filed mail — the Apps Script covers all
three, so this is the configuration that can replace it. All Mail ALONGSIDE
any other folder is the thing never to do (every labelled message stored
twice). Drafts are never stored or emitted (design §4.1).

---

## 0. Pre-flight facts (2026-10-09) — they shape the checklist

| Fact | Evidence | Consequence |
|---|---|---|
| The Apps Script account is **stuart@4lsg.com** | its Gmail holds `Trigger Label` + `IT/Test Trigger` (Gmail connector label listing); Fred confirmed | the mailbox row is `stuart@4lsg.com` (mailbox **2**, created 2026-10-09; X-GM-EXT-1 confirmed: `provider_id_kind: 'gmail'`) |
| `Trigger Label` is a **queue**, applied by the Gmail filter `deliveredto:@4lsg.com` (Fred) and removed by GAS once a thread posts — and it covers **everything**: every one of 111 messages Gmail received 2026-10-06…09 (63 in INBOX, newsletters included; 48 filed out of INBOX by other filters) has a gmail-firm `email_log` row (Gmail connector ids vs `email_log.message_id`) | the "skipped newsletters" are **Layer-2 suppression**: 40 of the 111 executions are `skipped_suppression` (LinkedIn, list mail …), 61 `logged`, 10 firm-to-firm | emitting all of INBOX at step 4 adds **no** new Layer-3/log exposure (same source, same suppressions). G2's `gas_never_posted` re-checks it live |
| **~43% of what GAS posts lives OUTSIDE INBOX/Sent** (48 of the 111): skip-inbox filters file it under labels (`IT`, `Marketing/*`, `Clio/*`, `Management - Vendors/*`, `Student Loan Grads`, `Court News/*` …) | same sample; label listing | the worker (INBOX + Sent) never sees it → W2 class 4 will be large. Two **automations depend on it**: rule **21** (Clio payment failed, ~66 / 30 d — 0 of them in INBOX; label `Clio/Clio Team - Payments`) and rule **18** (Adobe Sign sent tracking, ~14 / 30 d; `Management - Vendors/Adobe Sign - Sent`). Retiring GAS without polling those folders would silently stop both. **Resolved (ruling 2026-10-11): the mailbox polls `[Gmail]/All Mail` ONLY (step 3b)** — every label's mail, in one copy |
| INBOX **62,012** messages, Sent **26,206**, All Mail **136,929** | same listing | full backfill would pull GBs over Gmail IMAP (≈2.5 GB/day download cap per account — a lockout also hits Stuart's own IMAP clients) and multiply the SiteGround DB (897 MB) → every folder runs **`backfill:false`** (store only mail arriving after first sight) |
| GAS posts every message of every thread under `Trigger Label`, **including the firm's own replies** | `forwardEmailsToIngest()` walks `thread.getMessages()`; ~30% of 30-day gmail-firm volume is from firm domains | and it posts ALL sent mail: all 51 sent messages of the 50 newest sent threads (2026-10-08…10) have gmail-firm rows, sent-only threads included (14 firm-to-firm skipped, 37 logged). **Ruling 2026-10-11: sent mail EMITS for this provider-id mailbox** (design §4.1 amendment; "store-only Sent" was the §4.1 per-folder policy, mislabelled D6 here before) — parity, not new exposure; firm-to-firm skip applies |
| Gmail keeps drafts in All Mail and re-creates a draft as a new message on every autosave — and does **not** set the `\Draft` FLAG on them there, only the `\Draft` LABEL | Gmail IMAP semantics; the Apps Script adapter skips drafts in code (`isDraft()`). The flag half is live evidence: step 3c's first run (2026-10-11) found a test draft stored as row 99, FLAGS `\Seen`, labels `["\Draft"]` — the S1-G guard keyed on the flag alone | the worker's **DRAFT GUARD**: a draft (`\Draft` flag OR Gmail `\Draft` label — label added 2026-10-11) is never stored nor emitted, its bodies never downloaded; counted in `ingest_state.<folder>.drafts_skipped_total` (design §4.1). Rows stored before the label guard: **step 3d** |
| The S2 comms hub scoped its default list and unread counts to the `INBOX` folder | `services/mailbox/mailReadService.js` (`scopeWhere`, `summary`) | after step 3b the mailbox's new mail listed only under **All folders**, sent mail not told apart (SS sees this box through the attorney READ bypass). **Resolved by S2-L (2026-10-11, design OQ5):** X-GM-LABELS stored per row at ingest; the hub's Inbox = `mail_messages.in_inbox` (folder INBOX OR `\Inbox`). Rows stored between step 3b and the S2-L deploy are labelled by **step 3c** |
| GAS runs two side jobs: Pabbly **docs@** relay, **Clio "Payment method submitted"** forward | `processOneMessage()` | disabling the GAS trigger kills both — **retirement prerequisite** (§5) |
| Court NEFs are single-part **text/html**; GAS `text` is Gmail's `getPlainBody()`, the worker's is `htmlToText()` | 316/316 sampled court executions `content_type text/html` | the text Layer 3 sees differs by feeder; and from step 4 whichever feeder arrives FIRST runs Layer 3 — so text parity is part of the **gate**, before anything emits (G4) |
| **htmlToText now matches Gmail where it matters** (S1-G follow-up, 2026-10-09) | Before: 80 recent court NEFs replayed through the gate script → **STOP**, 151 court VALUE differences (links dropped — Gmail renders `label <url>` — plus CRLF, `&nbsp`). The follow-up renders `<a href>` as `label <url>` (quoted / unquoted, `HREF=`), LF line ends, bare `&nbsp` decoded, `<hr>` as a break, `<img alt>` as its alt. After: the same 80 → **REVIEW, 0 VALUE** (prod-matched rules: 136 format, 12 gas-tail-cut, 6 gmail-render, 1 gmail-css-leak, 1 gmail-input-artifact); with rules 8/12/15/16/22 forced onto all 80 → still 0 VALUE (rule 16's 57 and rule 8's 7 differences are all gmail-input-artifact). Rules 9/10 (341 meetings) identical throughout | The residual differences are Gmail's renderings, and in each the worker's value is equal or better (complete filer names, the claims-NEF tail Gmail drops, no `*`/`&nbsp`/CSS junk). They are the **documented REVIEW-pass classes** (§2 G4) |

---

## 1. Pilot checklist

`<ID>` = the new mailbox id. Console blocks run in a logged-in SU tab
(`apiSend` handles the elevation prompt). SQL runs in the SU DB console
(Admin → DB) or through a session `ycro_` key — none of it names
`email_ingest_sources`.

**Deploy first** (absolute order): `ref/migrations/2026-10-09_mailbox_s1g.sql`
→ push (backend + pane) → steps below. The S1-G backend selects the new
columns; deployed before the SQL it fails every ingest tick. From the SU
console run the migration's four plain **fallback** statements + section C
through `/admin/db/batch` (`allowWrite: true, stopOnError: true`) — its
guarded PREPARE groups need one connection (a mysql client), which the
console's pool does not guarantee.

### Step 0 — app password
On stuart@4lsg.com: 2-Step Verification on; Workspace admin allows app
passwords and IMAP (Admin console → Apps → Gmail → End-user access → IMAP);
Gmail settings → Forwarding and POP/IMAP → IMAP enabled. Mint an app password
named "YisraCase IMAP". It is typed once, into step 1's prompt — never into
chat, SQL or a file.

### Step 1 — create the mailbox (ingest OFF), then list folders
```js
const created = await apiSend('/api/mailboxes', 'POST', {
  address: 'stuart@4lsg.com', display_name: 'Stuart — Workspace (Gmail)',
  imap_host: 'imap.gmail.com', imap_port: 993, imap_user: 'stuart@4lsg.com',
  imap_secret: prompt('Gmail app password (16 letters, spaces removed)'),
  ingest_enabled: false,
  ingest_folders: {
    'INBOX':             { emit_to_rules: false, backfill: false },
    '[Gmail]/Sent Mail': { emit_to_rules: false, backfill: false },
  },
});
const ID = created.id;
const f = await apiSend(`/api/mailboxes/${ID}/folders`, 'GET');
console.log('provider_id_kind:', f.provider_id_kind, ' mailbox id:', ID);
console.table(f.configured);
console.table(f.folders.map(x => ({ path: x.path, special_use: x.special_use, messages: x.messages })));
```
Expect `provider_id_kind: 'gmail'`; both configured folders `exists: true`,
`all_mail: false`. Sent's name is localized — if `[Gmail]/Sent Mail` is
missing, PATCH `ingest_folders` with the path whose `special_use` is `\Sent`.
`provider_id_kind: null` → STOP: the server is not handing out X-GM-MSGID.
(Executed 2026-10-09 as INBOX + Sent; step 3b replaces both with All Mail.
**Never** list the `\All` folder ALONGSIDE others — `warnings` carries
`ALL_MAIL_ALONGSIDE_OTHER_FOLDERS` if anyone does.)

### Step 2 — enable, first run, provider capture
```js
await apiSend(`/api/mailboxes/${ID}`, 'PATCH', { ingest_enabled: true });
const s = await apiSend('/mailbox-ingest', 'POST');
console.log(s.emitted, s.noProviderId, s.details.filter(d => d.mailbox_id === ID));
```
First run = baseline only (both folders `ok`, nothing stored, nothing
emitted; `ingest_state.<folder>.backfill_skipped_below` set). New mail is
stored from the next 5-minute tick. After a few hours run **G1** (§2).

### Step 3 — the verification gate (store-only; still nothing emits)
After ≥ 20 INBOX messages have been stored for ≥ 30 minutes (usually within a
working day), run **G1–G3** (§2) and the **G4** script. PASS = G1 and G2 pass,
G3 explains every LOOKALIKE row, and G4 is PASS — or REVIEW with its examples
read and accepted by the manager's ruling (the follow-up's 80-NEF replay in §0
is the reference distribution). **On FAIL everything stays store-only and the
worker reports (G-outputs attached) — no fallback is improvised live.** G4
needs the htmlToText follow-up deployed: before it, STOP is the known result.

### Step 3b — switch to All Mail ONLY (store-only; ruling 2026-10-11)
Sequence: deploy the All-Mail slice (comment-only SQL
`ref/migrations/2026-10-11_mailbox_s1g_allmail.sql` first by convention, then
push) → this PATCH → the new baseline → after ≥ 1 working day, G1 + G2 on the
All Mail rows → step 4. The PATCH asserts the base it expects and the result:
```js
const ID = 2, ALL = '[Gmail]/All Mail';
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
const base = (await apiSend('/api/mailboxes', 'GET')).mailboxes.find(m => Number(m.id) === ID);
const cur = J(base && base.ingest_folders);
if (!base || base.address !== 'stuart@4lsg.com' || base.emit_source_name || base.emit_id_kind
    || Object.keys(cur).sort().join('|') !== ['INBOX', '[Gmail]/Sent Mail'].sort().join('|')
    || Object.values(cur).some(c => c.emit_to_rules)) {
  throw new Error('unexpected base: ' + JSON.stringify({ address: base && base.address, emit: base && [base.emit_source_name, base.emit_id_kind], folders: cur }));
}
const before = await apiSend(`/api/mailboxes/${ID}/folders`, 'GET');
const all = before.folders.find(f => f.special_use === '\\All');
if (before.provider_id_kind !== 'gmail' || !all || all.path !== ALL) throw new Error('All Mail is ' + JSON.stringify(all));
await apiSend(`/api/mailboxes/${ID}`, 'PATCH', { ingest_folders: { [ALL]: { emit_to_rules: false, backfill: false } } });
const after = await apiSend(`/api/mailboxes/${ID}/folders`, 'GET');
console.table(after.configured);
if (after.warnings.length || after.configured.length !== 1 || !after.configured[0].all_mail
    || after.configured[0].emit_to_rules || after.emit_override.emit_source_name) throw new Error('post-PATCH state wrong');
const s = await apiSend('/mailbox-ingest', 'POST');
console.log(s.skipped ? 'lock held: the scheduler tick baselines it; verify via SQL' : s.details.filter(d => d.mailbox_id === ID));
```
Expect one detail row (`[Gmail]/All Mail`, `outcome: 'ok'`, nothing stored).
Then:
```sql
SELECT JSON_EXTRACT(ingest_state, '$."[Gmail]/All Mail"') AS all_mail,
       JSON_EXTRACT(ingest_state, '$.INBOX.last_uid') AS old_inbox_cursor
  FROM mailboxes WHERE address = 'stuart@4lsg.com';
```
`all_mail` carries `last_uid`, `backfill_skipped_below` = its UIDNEXT at first
sight, no `errors`. The INBOX / Sent keys stay as breadcrumbs (ignored once
the folders are gone); their stored rows stay too. Mail that arrived between
the last INBOX poll and the baseline is not stored by the worker — harmless
while store-only (GAS still logs it; nothing has emitted yet). After ≥ 1
working day re-run **G1** (expect an All Mail row: `no_provider_id = 0`,
`hex_shaped = stored_rows`) and **G2** (per folder; All Mail now includes sent
and label-filed mail, all of which GAS posts — expect `lookalike_unmatched = 0`;
`gas_never_posted` near 0, G3 says what any are). G4 need not re-run: the text
derivation is unchanged and G4 compares by message, not folder.

### Step 3c — label the All Mail rows (S2-L; store-only, any time after its deploy)
Sequence: `ref/migrations/2026-10-11_mailbox_s2l_labels.sql` FIRST (the S2-L
worker INSERTs `gmail_labels` — a backend before it fails every tick), then
push. From the deploy on, every new row carries its labels; this block labels
the rows stored since step 3b's baseline (the re-snapshot route reads labels
by UID under the ingest lock and writes nothing else). It asserts the base and
retries while a tick holds the lock:
```js
const ID = 2, ALL = '[Gmail]/All Mail';
const lst = await apiSend(`/api/mailboxes/${ID}/folders`, 'GET');
if (lst.provider_id_kind !== 'gmail' || lst.warnings.length || lst.configured.length !== 1
    || lst.configured[0].folder !== ALL || !lst.configured[0].all_mail) {
  throw new Error('unexpected base: ' + JSON.stringify({ configured: lst.configured, warnings: lst.warnings }));
}
let after = 0, r = null; const tot = { scanned: 0, updated: 0, gone: 0, mismatched: 0, unlabelled: 0 };
do {
  try {
    r = await apiSend(`/api/mailboxes/${ID}/labels/snapshot`, 'POST', { folder: ALL, after_uid: after, limit: 500 });
  } catch (e) {
    if (e.status === 409 && e.body && e.body.retry) { await new Promise((ok) => setTimeout(ok, 30000)); continue; }
    throw e;
  }
  if (r.folder !== ALL || r.labels_supported !== true) throw new Error('unexpected answer: ' + JSON.stringify(r));
  for (const k of Object.keys(tot)) tot[k] += r[k];
  after = r.next_after_uid;
} while (!r || !r.done);
console.table(tot); // expect mismatched 0; gone = rows deleted in Gmail since (harmless)
```
Then, with any `ycro_` key:
```sql
SELECT folder, COUNT(*) AS n, SUM(gmail_labels IS NULL) AS no_labels, SUM(in_inbox) AS inbox,
       SUM(CONCAT(CONVERT(CHAR(92) USING utf8mb4), 'Sent') MEMBER OF (gmail_labels)) AS sent,
       SUM(CONCAT(CONVERT(CHAR(92) USING utf8mb4), 'Draft') MEMBER OF (gmail_labels)) AS draft_labelled
  FROM mail_messages WHERE mailbox_id = 2 GROUP BY folder;
```
Expect, on the `[Gmail]/All Mail` row: `no_labels = 0`; `inbox` + `sent` +
archived ≈ `n`; **`draft_labelled = 0`**. A non-zero `draft_labelled` means
drafts are being stored and — once step 4 flips emission — would be EMITTED,
which the Apps Script never does: **STOP before step 4**. (The INBOX and Sent
Mail breadcrumb rows keep NULL labels; they are read by folder.)

The first run (2026-10-11) gave **`draft_labelled = 1`**: row 99, a test
draft, FLAGS `\Seen`, labels `["\Draft"]`. Gmail does not set the `\Draft`
FLAG on drafts in All Mail, and the S1-G guard keyed on the flag alone (its
real-server proof ran on Dovecot). The guard now reads the label too (design
§4.1) — deploy it, then step 3d.

### Step 3d — drop the drafts stored before the label guard (store-only)
**Prerequisite:** the draft-label guard is deployed — otherwise the next
draft lands again. Safe while ticks run: the worker never revisits a UID
below its cursor. Asserts the base (a handful of never-emitted All Mail rows)
before deleting, and the delete count after:
```js
const PRED = "mailbox_id = 2 AND CONCAT(CONVERT(CHAR(92) USING utf8mb4), 'Draft') MEMBER OF (gmail_labels)";
const pre = await apiSend('/admin/db/query', 'POST', {
  query: `SELECT id, folder, uid, log_id, LEFT(subject, 60) AS subject FROM mail_messages WHERE ${PRED}`,
});
console.table(pre.rows);
if (!pre.rows.length) throw new Error('no draft rows: nothing to do');
if (pre.rows.length > 10 || pre.rows.some((r) => r.log_id != null || r.folder !== '[Gmail]/All Mail')) {
  throw new Error('unexpected base, stop and report: ' + JSON.stringify(pre.rows));
}
const ids = pre.rows.map((r) => Number(r.id)).join(',');
const b = await apiSend('/admin/db/batch', 'POST', { allowWrite: true, stopOnError: true, statements: [
  `DELETE FROM mail_read_state WHERE message_fk IN (${ids})`,
  `DELETE FROM mail_messages WHERE id IN (${ids}) AND ${PRED}`,
] });
if (b.errCount || b.aborted || b.results[1].rowCount !== pre.rows.length) {
  throw new Error('delete did not match: ' + JSON.stringify(b.results));
}
console.log(`deleted ${b.results[1].rowCount} draft row(s), ${b.results[0].rowCount} read-state row(s)`);
```
Then re-run step 3c's SQL (`draft_labelled = 0`), and prove the guard on
Gmail itself: in stuart@'s Gmail start a draft (any recipient), leave it
across one tick (ticks run every 5 minutes), then discard it. With any
`ycro_` key:
```sql
SELECT JSON_EXTRACT(ingest_state, '$."[Gmail]/All Mail".drafts_skipped_total') AS drafts_skipped
  FROM mailboxes WHERE id = 2;
```
Expect `drafts_skipped ≥ 1` (one per autosave revision a tick saw) and
step 3c's `draft_labelled` still 0. Either one off → **STOP before step 4**.

### Step 4 — emit: ONE atomic PATCH, then a live test
**Prerequisite:** the gate (step 3) passed, step 3b done and its G1/G2
re-check clean, step 3d's Gmail draft check passed (`drafts_skipped ≥ 1`,
`draft_labelled = 0`). Override and All Mail emission in the SAME request (one
UPDATE — there is no tick on which the box emits under the default
`mailbox-imap` identity, which would double-fire every message GAS also
posts). Asserts the base and the result:
```js
const ID = 2, ALL = '[Gmail]/All Mail';
const lst = await apiSend(`/api/mailboxes/${ID}/folders`, 'GET');
if (lst.provider_id_kind !== 'gmail' || lst.warnings.length || lst.configured.length !== 1
    || lst.configured[0].folder !== ALL || !lst.configured[0].all_mail || lst.configured[0].emit_to_rules
    || lst.emit_override.emit_source_name || lst.emit_override.emit_id_kind) {
  throw new Error('unexpected base: ' + JSON.stringify({ configured: lst.configured, override: lst.emit_override }));
}
await apiSend(`/api/mailboxes/${ID}`, 'PATCH', {
  emit_source_name: 'gmail-firm', emit_id_kind: 'provider',
  ingest_folders: { [ALL]: { emit_to_rules: true, backfill: false } },
});
console.log('WINDOW_START_UTC =', new Date().toISOString().slice(0, 19).replace('T', ' '));
const chk = await apiSend(`/api/mailboxes/${ID}/folders`, 'GET');
if (chk.emit_override.emit_source_name !== 'gmail-firm' || chk.emit_override.emit_id_kind !== 'provider'
    || chk.configured.length !== 1 || !chk.configured[0].emit_to_rules) throw new Error('post-PATCH state wrong: ' + JSON.stringify(chk));
```
Live test, two directions: send an external email TO stuart@4lsg.com with a
unique subject, and have Stuart send an external email FROM it with another;
after ≤ 10 min:
```sql
SELECT l.subject, e.id, e.status, (e.remote_ip IS NULL) AS worker, e.created_at
  FROM email_ingest_executions e JOIN email_log l ON l.id = e.email_log_id
 WHERE l.source = 'gmail-firm' AND l.subject IN ('<SUBJECT IN>', '<SUBJECT OUT>') ORDER BY l.id, e.id;
```
Expect, per subject, **exactly one email_log row and two executions**: one
processed (`logged` / `skipped_*`) and one `duplicate`, one with `worker = 1`,
one with `worker = 0`.

**Rollback** (any surprise): one PATCH
`{ emit_source_name: null, emit_id_kind: null, ingest_folders: { '[Gmail]/All Mail': { emit_to_rules: false, backfill: false } } }`.
Do NOT deactivate the `gmail-firm` source row — it is also the Apps Script
adapter's key (401 → GAS stops, labels pile up).

### Step 5 — open the 14-day window
- Followup payload (needs a `ycro_` key — any Claude session can file it):
  `PUT /api/scratch/followups/2026-10-24_gmail-parity` with
  `{"v": "{\"due\":\"<flip date + 14d>\",\"title\":\"Gmail IMAP parity window: retire Apps Script?\",\"boot\":\"Read ref/MAILBOX_GMAIL_PARITY.md §3-§5. WINDOW_START_UTC=<from step 4>. Run W1-W6, then decide retirement per §4/§5; step 6 executes it.\"}"}`
  (rename the key if the flip date moves).
- Alarm task: `await apiSend('/api/tasks', 'POST', { to: 6, title: 'Gmail IMAP parity window closes — retire Apps Script?', desc: 'scratch followups/2026-10-24_gmail-parity; ref/MAILBOX_GMAIL_PARITY.md', due: '<flip date + 14d>' })`.
- Spot-check W1–W6 every few days; W4 (text) on day 1.

### Step 6 — at window close (separate session, only if §4 holds and §5 is decided)
1. Re-home or consciously drop the GAS side jobs (§5). The docs@ relay cannot be re-homed
   yet: §5 decides what this step does, and while the relay stays, steps 2–5 wait.
2. Disable the Apps Script **time-based trigger** (Triggers → delete
   `forwardEmailsToIngest`). Code stays; `gmail-firm` row stays active (the
   worker owns it now; its `last_used_at` freezes — it is only stamped by HTTP
   auth).
3. Severity rider: in `services/mailbox/mailboxIngestService.js` set
   `limits.soleFeederSources: ['gmail-firm']` (one line; commit + deploy) —
   All Mail failure streaks on this mailbox then alert `error`, not `warning`.
4. AI_CONTEXT §27: ingest-source table → gmail-firm fed by the worker.
5. Move this file + the console script to `ref/archive/`; delete the followup.

---

## 2. The gate (G1–G4)

**G1 — provider-id coverage.** Expect `no_provider_id = 0` and
`hex_shaped = stored_rows` in every folder.
```sql
SELECT folder, COUNT(*) AS stored_rows, SUM(provider_id IS NULL) AS no_provider_id,
       SUM(provider_id REGEXP '^[0-9a-f]{1,16}$') AS hex_shaped
  FROM mail_messages
 WHERE mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
 GROUP BY folder;
```

**G2 — the equality hypothesis**, tested only where GAS demonstrably posted
the same email. GAS posts only threads that reached `Trigger Label` (§0), so a
row it never posted proves nothing either way; "GAS posted it" is decided
WITHOUT the hypothesis — a gmail-firm log row with the same sender and subject
within ±6 h. Per folder (any folder of the mailbox: INBOX / Sent before
step 3b, All Mail after). PASS iff `matched_by_id ≥ 20`, `from_mismatch = 0` and
`lookalike_unmatched = 0` (or each G3 LOOKALIKE row explained — e.g. one email
delivered into the mailbox twice). The premise is FALSE when `matched_by_id = 0`
while `lookalike_unmatched > 0` → STOP. `gas_never_posted` is informational:
with the catch-all filter it should be near 0; G3 lists what it is.
```sql
SELECT x.folder, COUNT(*) AS stored_rows,
       SUM(x.by_id) AS matched_by_id,
       SUM(x.by_id AND NOT x.from_ok) AS from_mismatch,
       SUM(NOT x.by_id AND x.lookalike) AS lookalike_unmatched,
       SUM(NOT x.by_id AND NOT x.lookalike) AS gas_never_posted
  FROM (
    SELECT m.id, m.folder,
           EXISTS (SELECT 1 FROM email_log l
                    WHERE l.source = 'gmail-firm' AND l.message_id = m.provider_id) AS by_id,
           EXISTS (SELECT 1 FROM email_log l
                    WHERE l.source = 'gmail-firm' AND l.message_id = m.provider_id
                      AND LOCATE(LOWER(l.from_email), LOWER(m.from_addr)) > 0) AS from_ok,
           EXISTS (SELECT 1 FROM email_log l
                    WHERE l.id >= f.floor_id AND l.source = 'gmail-firm'
                      AND TRIM(l.subject) = TRIM(COALESCE(m.subject, ''))
                      AND LOCATE(LOWER(l.from_email), LOWER(m.from_addr)) > 0
                      AND l.processed_at BETWEEN CONVERT_TZ(m.ingested_at, '+00:00', 'America/Detroit') - INTERVAL 6 HOUR
                                            AND CONVERT_TZ(m.ingested_at, '+00:00', 'America/Detroit') + INTERVAL 6 HOUR) AS lookalike
      FROM mail_messages m
      JOIN (SELECT id AS mb_id FROM mailboxes WHERE address = 'stuart@4lsg.com') b ON b.mb_id = m.mailbox_id
      JOIN (SELECT COALESCE(MIN(e.email_log_id), 0) AS floor_id FROM email_ingest_executions e
             WHERE e.source_id = 1
               AND e.created_at >= (SELECT MIN(mm.ingested_at) FROM mail_messages mm
                                     WHERE mm.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')) - INTERVAL 1 DAY) f
     WHERE m.provider_id IS NOT NULL
       AND m.ingested_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE) x
 GROUP BY x.folder ORDER BY x.folder;
```
(`email_log.processed_at` is Eastern — hence the CONVERT_TZ. `floor_id`
bounds the look-alike scan to log rows of the pilot's era through the
executions' `(source_id, created_at)` index; ~0.2 s on live.)

**G3 — the rows G2 did not match by id.** Class 1 (LOOKALIKE) must each be
explained; class 2 is mail GAS never posted (outside `deliveredto:@4lsg.com`,
or GAS still behind).
```sql
SELECT IF(EXISTS (SELECT 1 FROM email_log l
                   WHERE l.id >= f.floor_id AND l.source = 'gmail-firm'
                     AND TRIM(l.subject) = TRIM(COALESCE(m.subject, ''))
                     AND LOCATE(LOWER(l.from_email), LOWER(m.from_addr)) > 0
                     AND l.processed_at BETWEEN CONVERT_TZ(m.ingested_at, '+00:00', 'America/Detroit') - INTERVAL 6 HOUR
                                           AND CONVERT_TZ(m.ingested_at, '+00:00', 'America/Detroit') + INTERVAL 6 HOUR),
          '1 LOOKALIKE - GAS logged a same-sender/subject mail under another id: explain',
          '2 gas never posted') AS cls,
       m.id, m.folder, m.uid, m.provider_id, m.ingested_at, LEFT(m.from_addr, 60) AS from_addr, LEFT(m.subject, 80) AS subject
  FROM mail_messages m
  JOIN (SELECT id AS mb_id FROM mailboxes WHERE address = 'stuart@4lsg.com') b ON b.mb_id = m.mailbox_id
  JOIN (SELECT COALESCE(MIN(e.email_log_id), 0) AS floor_id FROM email_ingest_executions e
         WHERE e.source_id = 1
           AND e.created_at >= (SELECT MIN(mm.ingested_at) FROM mail_messages mm
                                 WHERE mm.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')) - INTERVAL 1 DAY) f
 WHERE m.provider_id IS NOT NULL
   AND m.ingested_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE
   AND NOT EXISTS (SELECT 1 FROM email_log l WHERE l.source = 'gmail-firm' AND l.message_id = m.provider_id)
 ORDER BY cls, m.id DESC
 LIMIT 50;
```

**G4 — text parity, pre-emission.** Paste `ref/MAILBOX_GMAIL_PARITY.console.js`
into an SU tab's console. For every stored message (any folder — one
comparison per gmail-firm log row; `folder` narrows it) that GAS logged and
that matched a rule in production, it runs each matched rule's PRODUCTION transform
on GAS's envelope and on the same envelope carrying the worker's text/html
(`GET …/emit-preview`, the worker's own derivation), and gives every differing
output field ONE class:

| Class | Meaning | Seen on live NEFs (§0) |
|---|---|---|
| `format` | equal ignoring whitespace, `*` and `_` — Gmail's ~75-column hard wrap, `*bold*` / `_underline_` markers, `____` rules | the bulk: every rule 12/15/22 text |
| `gmail-render` | equal once Gmail's renderings are undone on the GAS side: literal `&nbsp` (no semicolon), `------` lines for `<hr>`, `[image: alt]` | claims NEFs (`&nbsp &nbsp Claims Register`), docket texts after `<HR>` |
| `gas-tail-cut` | a whole-text field where GAS's text is a strict prefix of the worker's — Gmail dropped the tail | claims NEFs with an unclosed `<b>`: Gmail's text stops at "Amount Claimed"; the worker keeps the rest (document, notice list) |
| `gmail-css-leak` | a whole-text field where GAS's text = the worker's + CSS rule(s) Gmail leaked from a `<style>` block | the GovDelivery CM/ECF downtime notice |
| `gmail-input-artifact` | a rule field where the SAME rule run a third time, on GAS's text with Gmail's renderings undone (hard wraps rejoined, `*`, `&nbsp`, `------`, `[image:]`), gives the worker's value — Gmail's rendering broke the capture | rule 8 `filer` cut at a wrap ("Elizabeth Q." / "Uwedjojevwe"); rule 16's doc number hidden by `*Document Number:* 30` |
| `VALUE` | anything else | none after the follow-up |

The first five are the **REVIEW-pass classes** — in each the worker's value is
equal or better. Verdict: **STOP** on any court-mail `VALUE`; **REVIEW** when
only REVIEW-pass classes (or non-court differences) remain — read the
`byField` examples (each points at the first difference that is not
whitespace/markup), then the manager accepts by ruling; **PASS** when
identical. A STOP is a finding for the manager, never a tweak made live. The
classifier is pinned by `tests/mailboxGmailParity.console.test.js`, which runs
this file verbatim.

---

## 3. The parity window (W1–W6)

`gmail-firm` is `source_id = 1` (verified 2026-10-09; re-check:
`SELECT DISTINCT e.source_id FROM email_ingest_executions e JOIN email_log l ON l.id = e.email_log_id WHERE l.source = 'gmail-firm'`).
Feeder = `remote_ip`: the Apps Script posts over HTTP (set), the worker
emits in-process (NULL). Replace `<WINDOW_START_UTC>` with step 4's value.

**W1 — per-day executions by feeder.**
```sql
SELECT DATE(e.created_at) AS day_utc,
       SUM(e.remote_ip IS NOT NULL) AS gas_rows,
       SUM(e.remote_ip IS NULL) AS worker_rows,
       SUM(e.remote_ip IS NOT NULL AND e.status NOT IN ('duplicate', 'error', 'validation_failed')) AS gas_processed,
       SUM(e.remote_ip IS NULL AND e.status NOT IN ('duplicate', 'error', 'validation_failed')) AS worker_processed,
       SUM(e.remote_ip IS NOT NULL AND e.status IN ('error', 'validation_failed')) AS gas_failures,
       SUM(e.remote_ip IS NULL AND e.status IN ('error', 'validation_failed')) AS worker_failures
  FROM email_ingest_executions e
 WHERE e.source_id = 1 AND e.created_at >= '<WINDOW_START_UTC>'
 GROUP BY day_utc ORDER BY day_utc;
```

**W2 — every message first logged in the window, by feeder coverage.**
Class 2 must be 0 (or each row explained); class 3 is mail GAS posted that the
worker never stored (Spam / Trash are outside All Mail; a draft; mail older
than the step-3b baseline that a new reply re-threads — GAS re-posts whole
threads); class 5 is mail GAS never posted (expected near 0: GAS posts
inbound, sent and labelled mail alike). Class 3 also holds a worker MISS that
left an envelope-less row: the class-2 test matches stored rows by
`provider_id`, which such a row lacks — **W2b** counts those, and must be 0.
```sql
SELECT c.cls, COUNT(*) AS n
  FROM (
    SELECT CASE
             WHEN f.by_gas = 1 AND f.by_worker = 1 THEN '1 both feeders'
             WHEN f.by_worker = 1 THEN '5 worker only (GAS never posted it)'
             WHEN EXISTS (SELECT 1 FROM mail_messages mi
                           WHERE mi.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
                             AND mi.provider_id = f.mid)
               THEN '2 GAS only, worker HAS it stored (worker miss - investigate)'
             ELSE '3 GAS only, worker never stored it (spam/trash, draft, pre-baseline thread repost)'
           END AS cls
      FROM (
        SELECT l.id AS el_id, l.message_id AS mid,
               MAX(e.remote_ip IS NOT NULL) AS by_gas, MAX(e.remote_ip IS NULL) AS by_worker
          FROM email_log l
          JOIN email_ingest_executions e ON e.email_log_id = l.id AND e.source_id = 1
         WHERE l.source = 'gmail-firm'
           AND l.processed_at >= CONVERT_TZ('<WINDOW_START_UTC>', '+00:00', 'EST5EDT')
         GROUP BY l.id, l.message_id
      ) f
  ) c
 GROUP BY c.cls ORDER BY c.cls;
```
(`email_log.processed_at` is Eastern for every INGESTED source — hence the
CONVERT_TZ; outbound-* rows are UTC (scratch `docs/20261009_email_log_processed_at_tz`); restricting to
rows FIRST logged in the window keeps GAS's whole-thread re-posts of old mail
out of the count.)

**W2b — envelope-less rows the worker stored** (a miss W2 files under class 3).
Must be 0. Each one is a message the worker fetched without its data and will
never revisit (the cursor is past it); before the FETCH-merge fix
(imapTransport, FETCH ROWS ARE MERGED PER UID) a flag update arriving with
the fetch did this. Repair: `scripts/mailboxRepairShellRows.js`.
```sql
SELECT m.id, m.uid, m.flags, m.ingested_at
  FROM mail_messages m
 WHERE m.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
   AND m.provider_id IS NULL AND m.message_id IS NULL AND m.from_addr IS NULL AND m.date IS NULL
   AND m.ingested_at >= '<WINDOW_START_UTC>';
```
(`mail_messages.ingested_at` is UTC, like `<WINDOW_START_UTC>`.)

**W3 — the one-feeder-only rows to read** (classes 2 and 5).
```sql
SELECT f.el_id, f.mid, IF(f.by_gas, 'GAS', 'worker') AS only_feeder, LEFT(l.from_email, 50) AS from_email,
       LEFT(l.subject, 70) AS subject, l.processed_at AS processed_at_et
  FROM (
    SELECT l.id AS el_id, l.message_id AS mid,
           MAX(e.remote_ip IS NOT NULL) AS by_gas, MAX(e.remote_ip IS NULL) AS by_worker
      FROM email_log l
      JOIN email_ingest_executions e ON e.email_log_id = l.id AND e.source_id = 1
     WHERE l.source = 'gmail-firm'
       AND l.processed_at >= CONVERT_TZ('<WINDOW_START_UTC>', '+00:00', 'EST5EDT')
     GROUP BY l.id, l.message_id
  ) f
  JOIN email_log l ON l.id = f.el_id
 WHERE f.by_gas + f.by_worker = 1
   AND (f.by_worker = 1 OR EXISTS (SELECT 1 FROM mail_messages mi
          WHERE mi.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
            AND mi.provider_id = f.mid))
 ORDER BY f.el_id DESC LIMIT 50;
```

**W4 — text parity, in-window.** The console script again
(`sinceUtc: '<WINDOW_START_UTC>'` in its call at the bottom). Same verdicts.

**W5 — dedupe held.** Both must be 0.
```sql
-- (a) a gmail-firm message processed by Layer 3 more than once
SELECT COUNT(*) AS logs_processed_twice
  FROM (SELECT e.email_log_id FROM email_ingest_executions e
         WHERE e.source_id = 1 AND e.created_at >= '<WINDOW_START_UTC>'
           AND e.status IN ('logged', 'skipped_firm_to_firm', 'skipped_suppression')
         GROUP BY e.email_log_id HAVING COUNT(*) > 1) t;
-- (b) the same email (by RFC Message-ID) also logged under ANOTHER source
SELECT b.id AS gmail_log_id, a.id AS other_log_id, a.source AS other_source, LEFT(a.subject, 70) AS subject
  FROM mail_messages m
  JOIN email_log b ON b.source = 'gmail-firm' AND b.message_id = m.provider_id
  JOIN email_log a ON a.source <> 'gmail-firm' AND a.message_id = m.message_id
 WHERE m.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
   AND a.processed_at >= CONVERT_TZ('<WINDOW_START_UTC>', '+00:00', 'EST5EDT')
 LIMIT 50;
```
(b) catches a forwarded SiteGround box emitting under `mailbox-imap` — those
stay store-only until their forwarders die at the Migadu migration.

**W6 — how much Layer 3 ran on the worker's envelope** (informational).
```sql
SELECT DATE(e.created_at) AS day_utc, COUNT(*) AS worker_first_with_rules,
       SUM(JSON_CONTAINS(e.metadata->'$.matched_rules', '8') OR JSON_CONTAINS(e.metadata->'$.matched_rules', '9')
           OR JSON_CONTAINS(e.metadata->'$.matched_rules', '10') OR JSON_CONTAINS(e.metadata->'$.matched_rules', '15')) AS court_text_rules
  FROM email_ingest_executions e
 WHERE e.source_id = 1 AND e.remote_ip IS NULL AND e.status <> 'duplicate'
   AND e.created_at >= '<WINDOW_START_UTC>'
   AND JSON_LENGTH(e.metadata->'$.matched_rules') > 0
 GROUP BY day_utc ORDER BY day_utc;
```

---

## 4. Retirement criteria (all must hold)

1. **~14 clean days**: W2 class 2 = 0 or every row explained by something
   other than the worker; **W2b = 0**; W5 (a) and (b) = 0; worker failures in
   W1 explained.
2. **No text divergence on court mail**: W4 verdict PASS — or REVIEW with its
   classes (§2 G4) accepted by an explicit ruling.
3. No open `mailbox_ingest_failing` / `mailbox_ingest_no_provider_id` /
   `mailbox_ingest_source_missing` alert for this mailbox.
4. §5's decisions made and their prerequisites done.

### Close check 2026-10-25 — not retired

Window 2026-10-11 13:53:56Z → 2026-10-25. W1: no failures from either feeder
through the check (~13:00Z). W2: 1583 both feeders, class 2 = 0, class 3 = 13, class 5 = 1 (a
court notice only the worker logged). W5 (a) = 0. W5 (b) = 1, explained: a
firm-internal test mail to it@mdbl, whose box emits under `mailbox-imap` —
both copies firm-to-firm skipped. (An EXTERNAL mail addressed to both boxes
would run Layer 3 twice; that predates the window and does not depend on GAS.)

Two of the 13 class-3 rows were WORKER MISSES, caught by criterion 3 (alerts
1854 and 1947, `mailbox_ingest_no_provider_id`) and not by criterion 1 as then
written — hence W2b. One was a Chapter 13 trustee's email. imapflow had handed
back a flag update for the message being fetched (the attorney reading or
answering it during the tick) and the transport kept that row in place of the data — fixed
in imapTransport (FETCH ROWS ARE MERGED PER UID); the two rows are repaired by
`scripts/mailboxRepairShellRows.js`. The other 11 are the documented class-3
kinds: two bounces gone from All Mail before the next tick, nine old messages
of a re-posted thread.

The same day, from 13:01Z, a second worker-only failure: the executions row
of one message (a YisraCase task-summary email, an over-16-KB envelope with
emoji) could not be written — `_truncateRawInput`'s fixed-offset cut split a
surrogate pair, and MySQL refuses a lone surrogate in a JSON column
(`ER_INVALID_JSON_TEXT`). The worker retries a failed emission, so All Mail
stayed on that message tick after tick (alert 2089, `mailbox_ingest_failing`,
a warning — no email). The Apps Script logged everything meanwhile. Fixed in
emailIngestService (`_jsonColumnText`); the folder resumes on the first tick
after the deploy. Both failures were covered only because the Apps Script was
still running.

**The window RE-OPENS at the fix's deploy** (Fred, 2026-10-25):
`<WINDOW_START_UTC>` = the deploy time, ≥ 7 days, then W1–W6 with W2b, and W4
over the whole new window. Retirement is further gated on the docs@ relay
(§5).

## 5. Decisions

**Before step 4 (emission)** — all ruled:
- *"The filter skips newsletters"* (raised 2026-10-09, closed the same day by
  the 111-message check in §0): GAS posts everything; the skipping is Layer-2
  suppression, which applies to the worker's emissions identically.
- **Folder strategy** (ruling 2026-10-11): `[Gmail]/All Mail` as the ONLY
  folder — step 3b. Supersedes "add `Clio/Clio Team - Payments` +
  `Management - Vendors/Adobe Sign - Sent`": All Mail carries every label.
- **Outgoing mail** (ruling 2026-10-11, answering "do firm replies keep
  reaching the log?"): yes — sent mail emits for this provider-id mailbox
  (design §4.1 amendment). GAS posts it today (§0), so parity.
- **Drafts** (ruling 2026-10-11): never stored, never emitted (design §4.1).
  Gmail marks them with the `\Draft` LABEL, not the flag (found by step 3c's
  first run, 2026-10-11); the guard reads both — step 3d.

- **Per-message Gmail labels for the S2 hub** (design OQ5): done — S2-L
  (2026-10-11), snapshot at ingest, step 3c labels the earlier rows. Its
  draft check (`draft_labelled = 0`) gates step 4 — it caught the flag-only
  draft guard on its first run (step 3d).

**Before step 6 (retirement):**
- **GAS side jobs** — both live only in the Apps Script (`processOneMessage()`):
  - **Pabbly docs@ relay** (~60 messages / 30 days) — STAYS in the Apps Script
    (ruling 2026-10-25) until YisraCase can hand docs@ attachments to the
    Dropbox upload itself: the worker stores attachment STRUCTURE only (design
    D1) and the Pabbly workflow needs the files. So step 6 as written (delete
    the trigger) would stop the relay. Decide at step 6: (a) keep the Apps
    Script running whole — both feeders, the worker in front; steps 2–5 wait;
    or (b) a relay-only Apps Script — the ingest POST off, the relay kept. (b)
    is a `ref/gas.js` change, not a config flip: the relay runs only after a
    successful ingest POST today. The Gmail filter feeding `Trigger Label`
    can then narrow to docs@.
  - **Clio "Payment method submitted" forward** (6 in June–August 2026, none
    since) — rebuilt as an ingest rule (ruling 2026-10-25), then
    `CONFIG.clioForward.enabled = false` in the Apps Script AND in `ref/gas.js`
    at the same sitting (until then the Apps Script's forward and the rule
    would both send). The
    rule copies rule 13 (*Convert Case -> SS*): match `from.email` equals
    `notifications@clio.com` AND `subject` starts with
    `Payment method submitted by `; transform passthrough; action
    `internal_function` `forward_as_email` with params_mapping
    `{"event": "$", "to": "'shoshana@metrodetroitbankruptcylaw.com'",
    "from": "'automations@4lsg.com'", "subject_prefix": "''"}` (an empty
    prefix keeps the subject as Clio sent it, as the Apps Script's forward
    did). Test-match it on the six historical executions (2567, 3810, 8800,
    12585, 13961, 14188) before arming. One difference: the Apps Script
    forwards only a single-message thread, and Gmail threads a second notice
    with the same subject (the same client submitting again) under the first
    — the 2026-08-12 one was likely never forwarded. The rule forwards every
    notice.
- **Test-trigger replays** (`forwardTestTrigger()`) stop with the trigger;
  the function stays runnable by hand.
