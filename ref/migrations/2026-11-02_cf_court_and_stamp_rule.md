# 2026-11-02 — the Court field (cf_court), its stamp rule, and the backfill

The record of three production definition payloads applied 2026-11-02. Code
landed the same day: `2d0d39b` (court_processed carries the sender;
update_case `only_if_empty`) and `8955812` (`scripts/cfCourtBackfill.js`).

## 1. The field: cf_court (field_defs id 3)

`POST /api/field-defs` (seed snippet, run by Fred, GO):

- `entity: case`, `field_key: cf_court`, `label: Court`, `field_type: select`,
  `sort_order: 0`
- `options`: 88 `{value, label}` pairs — value = the court short name shown in
  lists (MIEB, 36D, Wayne, Probate-Oakland…), label = the full court name.
  The vocabulary is SS's court list (Dropbox "List of Courts.xlsx"), approved
  by SS 2026-11-02 with seven typo fixes (Livonia, Woodhaven, Oakland, two
  "District" spellings, "Court" capitalization, probate-prefix spacing).
  The live def is the authority on the current option set; new courts are
  added in Config → Custom Fields.

## 2. The stamp rule: trigger rule 24

`POST /api/triggers/rules` (install snippet, run by Fred, GO — rule #24,
"Stamp cf_court from the court email sender"):

- `event_type: case.court_processed`, active
- `match_mode: conditions`:
  `{operator:'and', conditions:[{path:'data.from_email', op:'contains', value:'uscourts.gov'}]}`
- `transform_mode: code`:

```js
// Sender domain -> court short name (cf_court option VALUES, field_defs id 3).
// psc.uscourts.gov (PACER service center) is deliberately unmapped: a PACER
// notice names no court. An unmapped sender throws -> transform failed ->
// no action, visible in trigger executions.
const from = String((input.data && input.data.from_email) || '').toLowerCase();
const m = from.match(/@([a-z0-9-]+)\.uscourts\.gov$/);
const COURTS = { mieb: 'MIEB', miwb: 'MIWB', mied: 'MIED', nysd: 'NYSD', ca6: 'USCOA' };
const court = m ? COURTS[m[1]] : null;
if (!court) throw new Error('no court mapping for sender: ' + from);
return { case_id: input.case_id, fields: { cf_court: court } };
```

- action: `internal_function`, config
  `{function_name:'update_case', params_mapping:{case_id:'case_id', fields:'fields', only_if_empty:['cf_court']}}`
  — `only_if_empty` is the fill-never-overwrite stamp semantics landed in
  `2d0d39b`; `params_mapping` resolves top-level strings as paths into the
  transform output, so the transform returns the whole `fields` object and
  the array rides as a literal.

Adding an emailing court later = extend `COURTS` in the rule's transform AND
make sure the short name is an active cf_court option. Michigan state courts
(TrueFiling/MiFILE — one sender for many courts) wait until their mail routes
into court_extract; that slice owns their mapping, likely off the court-name
line rather than the sender.

## 3. The backfill: scripts/cfCourtBackfill.js --apply

Run by Fred 2026-11-02 from the landed SHA (`8955812`), GO:

- **388 cases stamped** (387 MIEB, 1 MIWB — the jtg/Gregg case), 0 evidence
  conflicts, read back and re-planned clean. Plan ledger:
  `local/cf-court-backfill-2026-11-02T01-43-37-244Z.json` (Fred's machine).
- **14 docketed bankruptcy cases had no evidence** (no resolvable court email,
  no judge suffix, no mapped judge) and were left blank for staff:
  5P74DJQ7, 825WJECF, 97PTVKGZ, 9A7TYNX1, AABMTZA0, BA2KMHYY, CJDPHSKC,
  DwimOaEV, E5SSB8PG, hjSFMabb, NH2T3R46, QA3KPM5B, TYL6KJN8, uT7EU36v
- The script stays runnable (it is guarded on the virtual column staying
  empty), but its evidence maps are frozen literals checked against the live
  option set at run time — a renamed option value makes it refuse.
