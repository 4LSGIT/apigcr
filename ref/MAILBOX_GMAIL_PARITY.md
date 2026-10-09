# MAILBOX_GMAIL_PARITY — Gmail IMAP pilot (S1-G): checklist, gate, parity window, retirement

Status: LIVING RUNBOOK — 2026-10-09. Opened by slice S1-G of the mailbox arc
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
hex id) but is a hypothesis here until G2 proves it on live data.

---

## 0. Pre-flight facts (2026-10-09) — they shape the checklist

| Fact | Evidence | Consequence |
|---|---|---|
| The Apps Script account is **stuart@4lsg.com** | its Gmail holds `Trigger Label` + `IT/Test Trigger` (Gmail connector label listing) | the mailbox row is `stuart@4lsg.com` — **Fred confirms** |
| INBOX **62,012** messages, Sent **26,206** | same listing | full backfill would pull GBs over Gmail IMAP (≈2.5 GB/day download cap per account — a lockout also hits Stuart's own IMAP clients) and multiply the SiteGround DB (897 MB) → both folders run **`backfill:false`** (store only mail arriving after first sight) |
| GAS posts every message of every thread under `Trigger Label`, **including the firm's own replies** | `forwardEmailsToIngest()` walks `thread.getMessages()`; ~30% of 30-day gmail-firm volume is from firm domains | in Gmail IMAP a sent reply lives in `[Gmail]/Sent Mail`, which is **store-only** (D6). After retirement those outgoing log rows stop unless Sent is opted in — a **retirement decision** (§5) |
| GAS runs two side jobs: Pabbly **docs@** relay, **Clio "Payment method submitted"** forward | `processOneMessage()` | disabling the GAS trigger kills both — **retirement prerequisite** (§5) |
| Court NEFs are single-part **text/html**; GAS `text` is Gmail's `getPlainBody()`, the worker's is `htmlToText()` | 316/316 sampled court executions `content_type text/html` | the text Layer 3 sees differs by feeder; and from step 4 whichever feeder arrives FIRST runs Layer 3 — so text parity is part of the **gate**, before anything emits (G4) |
| **htmlToText diverges materially today** | 80 recent court NEFs replayed through rules 8/9/10/15/16/22 (S1-G worker report): rules **9/10 (341 meetings) identical**; rule **8** `filer` differs in 7/80 (Gmail's wrap truncates names — the worker's is the complete one); rules **15/22** `message`/`description` lose the **docket / doc1 links** (htmlToText drops `href`s; Gmail renders `text <url>`) and differ in wrapping / `*bold*`; rule **16** differs only by `* name *` vs `name` | **G4 returns STOP with the current htmlToText.** Ruling needed before step 4 (worker report: prototype link rendering + CRLF/`&nbsp` fixes leave only wrap/bold format differences) |

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
**Never** list the `\All` folder (All Mail repeats every labelled message).
`provider_id_kind: null` → STOP: the server is not handing out X-GM-MSGID.

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
working day), run **G1–G3** (§2) and the **G4** script. PASS = all four pass.
**On FAIL everything stays store-only and the worker reports (G-outputs
attached) — no fallback is improvised live.** (G4 is expected to STOP until
the htmlToText ruling in §0 lands.)

### Step 4 — emit: ONE atomic PATCH, then a live test
Override and INBOX emission in the SAME request (one UPDATE — there is no
tick on which INBOX emits under the default `mailbox-imap` identity, which
would double-fire every message GAS also posts):
```js
await apiSend(`/api/mailboxes/${ID}`, 'PATCH', {
  emit_source_name: 'gmail-firm', emit_id_kind: 'provider',
  ingest_folders: {
    'INBOX':             { emit_to_rules: true,  backfill: false },
    '[Gmail]/Sent Mail': { emit_to_rules: false, backfill: false },
  },
});
console.log('WINDOW_START_UTC =', new Date().toISOString().slice(0, 19).replace('T', ' '));
```
Send an external email to stuart@4lsg.com with a unique subject; after ≤ 10
min:
```sql
SELECT e.id, e.status, (e.remote_ip IS NULL) AS worker, e.created_at
  FROM email_ingest_executions e JOIN email_log l ON l.id = e.email_log_id
 WHERE l.source = 'gmail-firm' AND l.subject = '<SUBJECT>' ORDER BY e.id;
```
Expect **exactly one email_log row and two executions**: one processed
(`logged` / `skipped_*`) and one `duplicate`, one with `worker = 1`, one with
`worker = 0`.

**Rollback** (any surprise): one PATCH
`{emit_source_name: null, emit_id_kind: null, ingest_folders: {…INBOX emit_to_rules:false…}}`.
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
1. Re-home or consciously drop the GAS side jobs (§5).
2. Disable the Apps Script **time-based trigger** (Triggers → delete
   `forwardEmailsToIngest`). Code stays; `gmail-firm` row stays active (the
   worker owns it now; its `last_used_at` freezes — it is only stamped by HTTP
   auth).
3. Severity rider: in `services/mailbox/mailboxIngestService.js` set
   `limits.soleFeederSources: ['gmail-firm']` (one line; commit + deploy) —
   INBOX failure streaks on this mailbox then alert `error`, not `warning`.
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

**G2 — the equality hypothesis.** PASS iff `eligible ≥ 20`, `match_pct ≥ 95`
and `from_mismatch = 0`. A `match_pct` near 0 means X-GM-MSGID ≠ the Apps
Script id → STOP (the slice's premise is false). Anything between 5 and 95 is
an anomaly → STOP and report G3. `subject_mismatch` is informational (header
decoding / folding can differ).
```sql
SELECT COUNT(*) AS eligible,
       SUM(l.id IS NOT NULL) AS matched,
       ROUND(100 * SUM(l.id IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS match_pct,
       SUM(l.id IS NOT NULL AND LOCATE(LOWER(l.from_email), LOWER(m.from_addr)) = 0) AS from_mismatch,
       SUM(l.id IS NOT NULL AND TRIM(l.subject) <> TRIM(COALESCE(m.subject, ''))) AS subject_mismatch
  FROM mail_messages m
  LEFT JOIN email_log l ON l.source = 'gmail-firm' AND l.message_id = m.provider_id
 WHERE m.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
   AND m.folder = 'INBOX' AND m.provider_id IS NOT NULL
   AND m.ingested_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE;
```

**G3 — what did not match** (expected: only mail GAS never posted — outside
the `Trigger Label` filter).
```sql
SELECT m.id, m.uid, m.provider_id, m.ingested_at, LEFT(m.from_addr, 60) AS from_addr, LEFT(m.subject, 80) AS subject
  FROM mail_messages m
  LEFT JOIN email_log l ON l.source = 'gmail-firm' AND l.message_id = m.provider_id
 WHERE m.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
   AND m.folder = 'INBOX' AND m.provider_id IS NOT NULL
   AND m.ingested_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE
   AND l.id IS NULL
 ORDER BY m.id DESC LIMIT 50;
```

**G4 — text parity, pre-emission.** Paste `ref/MAILBOX_GMAIL_PARITY.console.js`
into an SU tab's console. For every INBOX message that GAS logged and that
matched a rule in production, it runs each matched rule's PRODUCTION transform
on GAS's envelope and on the same envelope carrying the worker's text/html
(`GET …/emit-preview`, the worker's own derivation) and classifies every
output field: `format` (equal once `*` and whitespace are normalized) or
`VALUE`. PASS / REVIEW (format-only) / **STOP (any court-mail VALUE
difference)**. A STOP is a finding for the manager, never a tweak made live.

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
Class 2 must be 0 (or each row explained); class 3 sizes the outgoing-mail
decision; class 4 sizes mail GAS sees outside INBOX/Sent; class 5 is mail the
`Trigger Label` filter never covered (the worker now logs it — new Layer-3
exposure, review it).
```sql
SELECT c.cls, COUNT(*) AS n
  FROM (
    SELECT CASE
             WHEN f.by_gas = 1 AND f.by_worker = 1 THEN '1 both feeders'
             WHEN f.by_worker = 1 THEN '5 worker only (GAS never posted it - Trigger Label filter gap)'
             WHEN EXISTS (SELECT 1 FROM mail_messages mi
                           WHERE mi.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
                             AND mi.folder = 'INBOX' AND mi.provider_id = f.mid)
               THEN '2 GAS only, worker HAS it in INBOX (worker miss - investigate)'
             WHEN EXISTS (SELECT 1 FROM mail_messages ms
                           WHERE ms.mailbox_id = (SELECT id FROM mailboxes WHERE address = 'stuart@4lsg.com')
                             AND ms.provider_id = f.mid)
               THEN '3 GAS only, worker stored it store-only (Sent) - expected'
             ELSE '4 GAS only, not in a polled folder (archived / skip-inbox / other label)'
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
(`email_log.processed_at` is Eastern — hence the CONVERT_TZ; restricting to
rows FIRST logged in the window keeps GAS's whole-thread re-posts of old mail
out of the count.)

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
            AND mi.folder = 'INBOX' AND mi.provider_id = f.mid))
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
   other than the worker; W5 (a) and (b) = 0; worker failures in W1 explained.
2. **No text divergence on court mail**: W4 verdict PASS — or REVIEW with the
   format-only differences accepted by an explicit ruling.
3. No open `mailbox_ingest_failing` / `mailbox_ingest_no_provider_id` /
   `mailbox_ingest_source_missing` alert for this mailbox.
4. §5's decisions made and their prerequisites done.

## 5. Decisions the retirement needs (not code in S1-G)

- **Outgoing mail** (W2 class 3): GAS logs the firm's replies in labelled
  threads; the worker stores Sent but never emits it (D6). Either accept that
  outgoing gmail-firm log rows end at retirement, or opt `[Gmail]/Sent Mail`
  into `emit_to_rules` — safe under provider ids (the Sent copy collides with
  any INBOX copy of the same Gmail message), but a D6 change.
- **Mail outside INBOX/Sent** (W2 class 4): skip-inbox filters / other labels.
  Size it; accept or add folders (never All Mail).
- **GAS side jobs**: the Pabbly **docs@** relay (~60 messages / 30 days) and
  the **Clio "Payment method submitted"** forward live only in the Apps Script
  (`processOneMessage()`). Rebuild as ingest rules (their removal notes in
  `ref/gas.js` spell it out) or drop consciously — before step 6.
- **Test-trigger replays** (`forwardTestTrigger()`) stop with the trigger;
  the function stays runnable by hand.
