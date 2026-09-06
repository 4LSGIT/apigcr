# FIL-1 — Trustee validation: deploy, test, arm. Plus the Pabbly cutover checklist.

## A. Deploy order (trustee validation)

1. **Deploy code first**: `lib/trusteeMatch.js`, `lib/internal_functions/trustee.js`
   (auto-registers via the directory scan — no entry-point edit). A trigger rule
   naming an unregistered function errors on every 341 notice, so code before SQL.
2. **Run** `ref/2026-09-06_FIL1_trustee_validation.sql` (3 standalone statements).
3. Nothing else. The rule is live-but-dry immediately.

## B. Dry-run test (before arming)

- **Passive**: wait for the next real MIEB 341 notice. Expect: a
  `[TrusteeVal DRY]` email to it@4lsg.com stating status + what a live run
  would have written; on a no-match, a `[DRY RUN] Trustee needs review — <docket>`
  task assigned to user 6 (dedupe key `trustee-val-dry:<case_id>`).
- **Active** (test on a real case now): run the function from the workflow
  tester or a one-step scratch workflow with
  `{"function_name":"validate_case_trustee","params":{"case_id":"<id>"}}`.
  The gate forces dry regardless. Good probes on live data:
  - a case whose trustee already matches the roster exactly → `matched`, `would_update: nothing` (or `case_341_link` if the link column is empty);
  - the known drift case (`case_trustee = 'Michael Stevenson'`) → `matched (lname)`, `would_update: case_trustee, case_341_link`;
  - a case with a garbage trustee → dry alert task to user 6.
- Idempotency check: run it twice on the same unmatched case — second run must
  say `alert_deduped: true` and create no second task.

## C. Arm

```sql
UPDATE app_settings SET `value` = '1' WHERE `key` = 'trustee_validation_live';
```

From then on: live runs write `cases.case_trustee` (canonical roster spelling)
and `cases.case_341_link` (roster Zoom link), log a `status` entry on the case,
and route no-match alerts to Rena (user 22, dedupe key `trustee-val:<case_id>`).
The alert text tells staff to pick the trustee in the Case Info form (which
auto-fills the 341 link) or add a genuinely new trustee to the roster first.

Note: the 341 **appt**'s `connection_info` is deliberately untouched — the
court executor already stores the email's verbatim meeting-id/passcode/phone
there, which is per-case and richer than the roster's generic URL. "Both
destinations" is satisfied by the two writers, not by one overwriting the other.

---

## D. Remaining FIL config — DRAFTS (do not run yet; each is its own decision)

### D1. Stage/status → Filed on the voluntary petition (Fred ruling 2026-09-06: fire on voluntary_petition)

`advanceStage` sets `case_stage='Filed'` and `case_status='Filed'`
(internal_label; pipelineService.js:1080). Pabbly wrote `case_status='Case Filed'`
— if anything keys on that exact string it predates the pipeline registry;
none found in code, but eyeball saved reports/filters before running.

```sql
INSERT INTO trigger_rules
  (event_type, name, description, active, position, min_interval_s, match_mode, match_config, transform_mode)
VALUES
  ('case.court_processed', 'Voluntary petition -> filed stage',
   'FIL: advance the pipeline to filed when the court executor settles a voluntary_petition NEF. Note: at this moment the case usually carries only the SHORT docket.',
   1, 90, 0, 'conditions',
   '{"operator":"and","conditions":[{"op":"exists","path":"case_id"},{"op":"equals","path":"data.classification","value":"voluntary_petition"}]}',
   'passthrough');
```
```sql
INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config)
SELECT id, 'advance to filed', 1, 1, 'internal_function',
  '{"function_name":"advance_stage","params_mapping":{"case_id":"case_id","stage":"''filed''","note":"''Auto: voluntary petition (court)''","only_from":"''retained,docs,none''"}}'
FROM trigger_rules WHERE name = 'Voluntary petition -> filed stage' LIMIT 1;
```
`only_from` VERIFIED against live pipeline_stages (templates 2 & 3, 2026-09-06):
the only pre-`filed` stage keys are `retained` and `docs`; `none` covers cases
not yet on a pipeline (the same convention the four live court rules use).

### D2. Dropbox move on filing (wf28 → real)

wf28 already implements move-to-Active + the 4 staff subfolders with an
ensure fallback, matching `app_settings.dropbox_case_folder_templates`.
To go live: set wf28 active, rename it (drop "EXAMPLE:"), and attach it to the
same moment as D1 — cleanest as a second ACTION ROW on the D1 rule
(`{"workflow_id": 28}`, action_type 'workflow', position 2), so filing =
stage flip + folder move in one place. Decide whether the trigger should
instead be `case.stage_advanced` stage_key='filed' (fires on MANUAL stage
flips too — probably what you want).

### D3. CS "case filed" notification

Nothing native sends it today (wf47 emails the CLIENT). Options: a
`create_task` action row (to Rena, link to case) on the D1 rule, or a
`send_email` step appended to wf28/wf47. Recommend the task — visible,
dedupable, no inbox dependency.

### D4. Client notice-of-filing PDF (wf47)

Already built end-to-end with a readiness gate (missing fields → task to
user 6, nothing emailed). Arming = flip trigger rule 15 active:
```sql
UPDATE trigger_rules SET active = 1 WHERE id = 15;  -- 'Case filed -> notice of filing to client'
```
Depends on D1 existing (nothing currently emits stage_key='filed').

---

## E. Pabbly cutover checklist (the two 341-notice workflows)

Pre-conditions to disable each Pabbly branch, per function it carries:

| Pabbly function | Native replacement must be true |
|---|---|
| 341 appt + sequence | Already neutered (court executor) — done |
| cases UPDATE: trustee + 341 link | trustee validation ARMED (`trustee_validation_live='1'`) and observed on ≥1 real notice |
| cases UPDATE: stage/status Filed | D1 rule live and observed |
| cases UPDATE: judge/chapter/objection/file_date | Court executor CASE_FIELD_POLICY — already live; verify on next notice they land without Pabbly |
| cases UPDATE: `case_number_full` | **NOT natively written** — CAL II spec pending. Until then, disabling Pabbly loses the full-docket backfill at 341 time. Either accept manual entry, or hold this as the last blocker |
| cases UPDATE: `case_341_initial`, `case_180` | No native writer; CAL/U10 territory (appt row is the source of truth for 341 dates; `case_180` is derivable). Decide: spec for CAL II or accept the columns going stale |
| Dropbox move + subfolders | D2 live and observed |
| Ch7/Ch13 deadline events | wf23/24/25 — live now; verify events appear on the next notice of each chapter |
| Client PDF email | D4 (rule 15) live |
| CS notification | D3 live |
| Clio custom fields | Skipped pending Stuart's ruling (default: retire) |

Post-disable watch-gates (mirror the 341 pattern): on the next REAL notice of
each chapter after disabling, verify each native writer fired — trustee
canonical + link set (or alert task raised), stage Filed, Dropbox folder in
the Active tree with 4 subfolders, deadline events present, client notice
emailed (or gate task raised), CS task created. Keep the Pabbly workflows
paused-not-deleted for one cycle.
