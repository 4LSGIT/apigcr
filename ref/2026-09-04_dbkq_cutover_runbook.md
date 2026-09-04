# DBKQ cutover runbook — JotForm → YisraForm

**Slice:** D3. **Written:** 2026-09-04. **Run by:** Fred.
Companion doc: `ref/2026-09-04_dbkq_workflow_spec.md` (the workflow and the
`onSubmit` block this runbook installs).

Readonly SQL for every verification step:
`POST https://app.4lsg.com/api/readonly/sql`, header `X-Readonly-Api-Key`.

**Hook 39 and wf48 stay live throughout.** Nothing in this runbook touches
them. They are the JotForm tail's whole machinery and the entire rollback.

**Order is not negotiable.** Steps 1–2 arm the new path without exposing it;
step 3 proves it end to end on one case; step 4 is the only irreversible-ish
moment (three link emitters flip together); steps 5–7 are aftercare.

---

## Step 1 — Build the workflow

Per `2026-09-04_dbkq_workflow_spec.md` §3, in the builder. Publish it. **Leave
it active.** It is unreachable until step 2 — the only thing that can start it
is a `dbkq` submission dispatch, and `dbkq.definition.onSubmit` is still NULL.

Record the id it gets; §4 of the spec calls it `<NEW_ID>`.

**Verify — the workflow exists, is published, and has exactly 5 steps at its
current version:**

```sql
SELECT w.id, w.name, w.active, w.current_version, w.default_contact_id_from,
       COUNT(s.id) AS steps
FROM workflows w
LEFT JOIN workflow_steps s
       ON s.workflow_id = w.id AND s.version = w.current_version
WHERE w.name = 'YisraForm - Detailed BK Questionnaire'
GROUP BY w.id;
```

Expect: `active=1`, `current_version>=1`, `default_contact_id_from` NULL,
`steps=5`.

**Verify — the two replicated configs match wf48's:**

```sql
SELECT step_number, label, config, error_policy
FROM workflow_steps
WHERE workflow_id = <NEW_ID>
  AND version = (SELECT current_version FROM workflows WHERE id = <NEW_ID>)
ORDER BY step_number;
```

Check by eye against wf48 v3 steps 18/19 (query_db + cancel_sequences) and 22
(update_case). The three intended divergences are listed in the spec §3 step 4;
anything else differing is a transcription error.

---

## Step 2 — Add the `onSubmit` block and republish `dbkq`

Paste the JSON from `2026-09-04_dbkq_workflow_spec.md` §4 into the `dbkq`
template's definition (substituting `<NEW_ID>`), then **publish** — a draft
does not dispatch.

**Verify — the published definition carries it:**

```sql
SELECT form_key, visibility, schema_version, published_at,
       JSON_EXTRACT(definition, '$.onSubmit.pdf')                AS pdf,
       JSON_LENGTH(definition, '$.onSubmit.workflows')           AS n_wf,
       JSON_EXTRACT(definition, '$.onSubmit.workflows[0].id')    AS wf0,
       JSON_EXTRACT(definition, '$.onSubmit.workflows[1].id')    AS wf1,
       JSON_LENGTH(definition, '$.onSubmit.workflows[0].initData.labels') AS n_labels
FROM form_templates
WHERE form_key = 'dbkq';
```

Expect: `pdf=true`, `n_wf=2`, `wf0=40`, `wf1=<NEW_ID>`, `n_labels=16`.

**Verify — publishing did not disturb the rest of the definition:**

```sql
SELECT JSON_LENGTH(definition, '$.sections')             AS sections,
       JSON_EXTRACT(definition, '$.external.serverDrafts') AS server_drafts,
       JSON_EXTRACT(definition, '$.external.badLink')      AS bad_link,
       JSON_EXTRACT(definition, '$.autosaveMs')            AS autosave_ms
FROM form_templates WHERE form_key = 'dbkq';
```

Expect: `sections=148`, `server_drafts=true`, `bad_link="degrade"`,
`autosave_ms=10000`. A changed section count means the paste replaced more than
the `onSubmit` key — stop and restore.

**Still safe to stop here.** No client has the new link yet.

---

## Step 3 — End to end on `uT7EU36v`

`uT7EU36v` is Bankruptcy / Chapter 7 and currently carries
`case_detailed_form = '6339362100717999458'` (a legacy JotForm id) plus a live
`case_detailed_link` — so it exercises the legacy tab branch **before** and the
`yf:` branch **after**, and it exercises the "both columns populated" state
`detTabSrc` has to resolve correctly.

**Baseline first** (you will diff against this):

```sql
SELECT case_id, case_detailed_form, case_detailed_link
FROM cases WHERE case_id = 'uT7EU36v';

SELECT id, contact_id, template_id, template_version, status, current_step,
       cancel_reason, enrolled_at
FROM sequence_enrollments
WHERE JSON_UNQUOTE(JSON_EXTRACT(trigger_data, '$.case_id')) = 'uT7EU36v'
ORDER BY id DESC LIMIT 5;
```

### 3a. Enrol it

Open the case → Sending Form tab → questionnaire action with **enroll on** →
send. (SMS/email to yourself, or to whatever test recipient the case carries.)

This is the un-deployed sendingform, so the link it texts is still the old one
— irrelevant, you are testing the enrolment and the blanking, not the link.

**Verify:**

```sql
SELECT case_id, case_detailed_form FROM cases WHERE case_id = 'uT7EU36v';
```
Expect `case_detailed_form` **NULL** (the blanking at `sendingform-bk.html`
`case_detailed_form: null`).

```sql
SELECT id, contact_id, template_id, status, current_step
FROM sequence_enrollments
WHERE JSON_UNQUOTE(JSON_EXTRACT(trigger_data, '$.case_id')) = 'uT7EU36v'
  AND status = 'active'
ORDER BY id DESC LIMIT 1;
```
Expect one **active** row on template 29. Note its `id` — call it `<ENR>`.

### 3b. Submit the YisraForm

Open `https://4lsg.com/f/dbkq?case_id=uT7EU36v` — **type the URL yourself**, do
not use the link the send just emitted. Fill enough to be recognisable (at
minimum first/last name, and a couple of the 16 labelled fields so the email
has content). Submit.

You should land on the thank-you panel from `external.postSubmit.message`.

### 3c. Verify, in this order

**(i) The submission was recorded and linked:**

```sql
SELECT id, form_key, link_type, link_id, status, schema_version,
       submitted_by, draft_key, created_at
FROM form_submissions
WHERE form_key = 'dbkq' AND link_id = 'uT7EU36v'
  AND status = 'submitted'          -- drafts live in this table too
ORDER BY id DESC LIMIT 1;
```
Expect `link_type='case'`, `link_id='uT7EU36v'`, `submitted_by` NULL
(NULL = external, by convention), and `draft_key` NULL (the generated column is
NULL for submitted rows). Note the `id` — call it `<SUB>`.

Also confirm the draft row is gone — the submit path deletes it fire-and-forget:

```sql
SELECT id, status, draft_key, updated_at FROM form_submissions
WHERE form_key = 'dbkq' AND link_id = 'uT7EU36v' AND status = 'draft';
```
Expect zero rows. A surviving draft is cosmetic (the next visit shows a stale
restore banner), not a failure — note it and move on.

If `link_type` is `''`: **the credential did not resolve.** Stop. That is the
degrade path, and it means the URL, not the code, was wrong.

**(ii) The case was stamped:**

```sql
SELECT case_id, case_detailed_form, case_detailed_link
FROM cases WHERE case_id = 'uT7EU36v';
```
Expect `case_detailed_form = 'yf:<SUB>'` and `case_detailed_link` **unchanged
from the baseline** (the new workflow deliberately does not write it).

**(iii) The drip was cancelled:**

```sql
SELECT id, status, cancel_reason, current_step
FROM sequence_enrollments WHERE id = <ENR>;
```
Expect `status='cancelled'`, `cancel_reason='dbkq_submitted'`.

**(iv) The log row landed** (wf40 step 8):

```sql
SELECT log_id, log_type, log_subject, log_direction, log_link_type, log_link_id,
       log_by, log_date
FROM log
WHERE log_link_type = 'case' AND log_link_id = 'uT7EU36v'
ORDER BY log_id DESC LIMIT 3;
```
Expect a `form`-typed row, `log_direction='incoming'`, `log_by=0`, subject
`Detailed Bankruptcy Questionnaire received` — the same subject wf48 step 20
wrote, so the case log reads continuously across the cutover.

**(v) The PDF was filed:** open the case's Dropbox folder → **`Forms`**
subfolder (`formPdfService.SUBFOLDER`). Expect one new PDF named for the form
and submitter.

Note this is a **new location**: wf48 filed the JotForm PDF elsewhere in the
case folder. Tell SB, or she will look where it used to be.

**(vi) SB's email arrived.** Fred confirms by eye. Check: the subject reads
`Detailed BK Questionnaire — <last name>`, the body is a short table of the
answered subset (not 252 rows), and **the PDF is attached**. Sender is
`stuart@4lsg.com`, not `automations@4lsg.com` — expected, see the spec §4.

**(vii) The case.html tab renders it:** open the case → Detailed Questionnaire
tab. Expect the submission rendered read-only (flat, with the view banner) —
not a PDF, not a blank frame. This is `detTabSrc`'s `yf:` branch, live.

**(viii) The drip actually stopped:** no further `dbkq_reminder` step fires
against `<ENR>`.

```sql
SELECT id, step_number, status, skip_reason, scheduled_at, executed_at
FROM sequence_step_log WHERE enrollment_id = <ENR> ORDER BY id;
```
Nothing executes after the cancel. (Step 1 may already have fired if you left
the enrolment sitting more than two business days between 3a and 3b — that is
expected and harmless.)

**If any of (i)–(viii) fails, stop.** Nothing client-facing has moved yet;
fixing forward is free.

---

## Step 4 — Flip the three link emitters

Only now. All three, same sitting — a half-flip means some clients get the new
form and some the old, and both drips reference whichever link their own
channel emits.

### 4a. Deploy `sendingform-bk.html` (D3 Part 1b)

Frontend deploy. Emits `https://4lsg.com/f/dbkq?case_id=<case_id>` on both SMS
and email, and in the preview pane.

### 4b. `/p/detail` — **TWO edits, not one**

Page id 6, slug `detail`, status `live`. Its own comment says the DEST constant
is "the ONLY thing to change when the YisraForm replacement goes live". **That
comment is wrong**, and following it produces the exact silent failure this
cutover is guarding against.

```js
var DEST = 'https://form.jotform.com/231694062254152';   // → 'https://4lsg.com/f/dbkq'
…
if (/^[A-Za-z0-9_-]{1,32}$/.test(id)) out.push('caseId=' + …);  // → 'case_id=' + …
var SKIP = { id: 1, caseId: 1 };                                 // → add case_id: 1
```

Flipping `DEST` alone yields `/f/dbkq?caseId=<id>`. `/api/ext/forms` never reads
`caseId`; `dbkq` is `badLink: "degrade"`; so the form renders **anonymously**,
the client fills 252 fields, and the submission lands unlinked. No error, no
alert, no case.

`SKIP` gains `case_id` for the same reason it already holds `caseId`: so a
crafted `?id=A&case_id=B` cannot beat the shape-guarded value.

The forwarded JotForm prefill keys (`name[first]`, `name[last]`, `phone[full]`)
can stay — `routes/f.js` drops nested-object query shapes, so they are inert
rather than harmful. They are also now pointless: `dbkq` declares no `urlParam`
prefills and no `endpoints.load`, so the form opens blank for everyone. Remove
them if you want the URLs shorter; either way is correct.

Also update the page's own comment, which still explains `caseId` in terms of
"what workflow 48 routes the submitted PDF on".

### 4c. `dbkq_reminder` sequence templates (template 29)

**Five** step configs carry the link — steps **1, 2, 3, 4, 5**. Step 6 is a
`create_task` and uses the internal `app.4lsg.com?case=` link; leave it.

Steps 1, 3, 5 (SMS) each contain:
`https://4lsg.com/p/detail?id={{cases.case_id}}`

Steps 2, 4 (email) each contain:
`https://4lsg.com/p/detail?id={{cases.case_id}}&name[first]=…&name[last]=…&phone[full]=…`

**Decide first:** if `/p/detail` stays in front of the reminders (4b keeps it
alive and correct), these can stay as-is — the interstitial's prep copy is worth
something on a reminder. But then the sequence emits `id=`, sendingform emits
`case_id=`, and the two channels take different paths to the same form.
The consistent alternative is to point all five straight at
`https://4lsg.com/f/dbkq?case_id={{cases.case_id}}` and drop the prefill keys
(inert, per 4b).

This is a console-script change in the parallel session; it must publish a new
template version (`sequence_templates.current_version`), not edit rows in place.

**Verify — after all three:**

```sql
SELECT step_number,
       action_config LIKE '%case_id=%'  AS has_case_id,
       action_config LIKE '%?id=%'      AS has_bare_id,
       action_config LIKE '%caseId=%'   AS has_jotform_id,
       action_config LIKE '%jotform%'   AS has_jotform_host
FROM sequence_steps
WHERE template_id = 29
  AND version = (SELECT current_version FROM sequence_templates WHERE id = 29)
ORDER BY step_number;
```

```sql
SELECT html LIKE '%case_id=%'   AS has_case_id,
       html LIKE '%caseId=%'    AS has_jotform_id,
       html LIKE '%jotform%'    AS has_jotform_host,
       html LIKE '%/f/dbkq%'    AS has_yf_dest
FROM pages WHERE slug = 'detail';
```

Expect `has_jotform_host = 0` everywhere and `has_jotform_id = 0` everywhere.
For sendingform-bk, `tests/sendingformBk.dbkqLink.test.js` is the same audit
run in CI.

**One SMS-length note:** `https://4lsg.com/f/dbkq?case_id=uT7EU36v` is 42
characters against `/p/detail?id=`'s 38. No segment boundary crossed on any of
the three SMS steps; no action needed, just don't grow the copy.

---

## Step 5 — Revisit-after-submit (already answered; confirm on the real form)

**No conflict with the re-request flow.** Verified in code, D3:

- The external GET (`api.ext.forms.js`) **never** serves the latest submitted
  row — its own comment is explicit that last time's answers are not the
  external surface's to hand back on a bearer credential. It serves the
  definition, the 3-field prefill projection, and the draft key.
- On submit, the **server draft is deleted** (`api.ext.forms.js` step 4b,
  fire-and-forget) **and the device-local draft is cleared**
  (`yc-forms.js` `_clearLocalDraft()` on the external branch).
- `dbkq.external.postSubmit` sets only `message` — no `edit`, no `new` — so the
  client sees the thank-you panel and no edit affordance.

So: blank `case_detailed_form` → resend → the same URL yields a **fresh, empty,
fillable form**. Nothing extra to do on a re-request.

**Confirm on the real form** after step 4: reload
`https://4lsg.com/f/dbkq?case_id=uT7EU36v` post-submission and check it comes up
blank with no draft-restore banner.

Two things to know rather than fix:

- The per-case submit cap is **5 valid submissions per hour** on the external
  route. A genuine re-request weeks later is unaffected; a same-day
  submit-and-resubmit loop during testing can hit it.
- A second submission does **not** supersede the first. Both rows persist; the
  new workflow re-stamps `case_detailed_form` to the newer `yf:<id>`, the tab
  follows, and the older submission stays reachable through the Form Inbox.
  wf48 behaved the same way.

---

## Step 6 — Rollback

Cheap and complete, because hook 39 and wf48 never stopped:

1. Revert `sendingform-bk.html` (redeploy the prior frontend).
2. Restore `/p/detail`: `DEST` back to the JotForm URL, `caseId=` back,
   `SKIP` back.
3. Revert the template-29 step configs if 4c changed them (publish the prior
   version back).

Optionally also clear `dbkq.definition.onSubmit` and republish — not required
for rollback (no new submissions can arrive once the links are reverted), but it
stops the new workflow firing if someone re-uses a link they already have.

Anything already submitted through YisraForm **stays** as a `yf:` row. That is
fine: `detTabSrc` handles both shapes indefinitely, and the two shapes are the
whole reason for the prefix.

---

## Step 7 — Retirement criterion for hook 39 / wf48 (state, do not execute)

Do **not** retire them as part of D3. Retire only when **both** hold:

1. **Zero active `dbkq_reminder` enrolments predating cutover.**

```sql
SELECT COUNT(*) AS stragglers
FROM sequence_enrollments
WHERE template_id = 29
  AND status = 'active'
  AND enrolled_at < '<CUTOVER_TIMESTAMP>';
```

2. **No hook-39 traffic and no wf48 executions for 21 consecutive days.** The
drip is 6 steps at 2+2+2+3+3+3 business days ≈ 15 business days ≈ 3 calendar
weeks, so a client who received the last JotForm link the hour before cutover
can still legitimately submit up to that horizon. 21 days is that window plus
slack.

```sql
SELECT MAX(created_at) AS last_hit, COUNT(*) AS hits_21d
FROM hook_executions
WHERE hook_id = 39
  AND created_at > DATE_SUB(NOW(), INTERVAL 21 DAY);

SELECT MAX(created_at) AS last_run, COUNT(*) AS runs_21d
FROM workflow_executions
WHERE workflow_id = 48
  AND created_at > DATE_SUB(NOW(), INTERVAL 21 DAY);
```

Both must come back zero. `hook_executions` is the earlier signal — it records
the inbound JotForm POST even when the workflow later aborts — so a zero there
with a non-zero `workflow_executions` count means something other than hook 39
is starting wf48, and that needs explaining before either is switched off.

When both hold: deactivate hook 39, deactivate wf48. Leave both rows in place —
they are the audit trail for 126 legacy submissions and the only documentation
of how those PDFs got where they are.

**Related, deliberately deferred:** `sendingform-bk.html` still writes
`form_id: DBKQ_FORM_ID` (the retired JotForm id) into the enrolment's
`trigger_data`. Nothing reads it — template 29's condition uses only
`trigger_data.case_id` — so it is inert provenance. Change it to
`DBKQ_FORM_KEY` whenever the file is next open; not worth a deploy of its own.
