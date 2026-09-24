# 13 — Custom Fields

**Where:** More → **YisraCase Config** → the **Fields** tab (moved there from
the Settings page in CFG-1 — one editor per setting, never two).
**Table:** `field_defs`.
**Design:** `ref/CUSTOM_FIELDS_DESIGN.md` — a living doc; its §7 table says which
parts of the feature have shipped. This chapter grows as they do.

## For operators

Custom fields are the firm's own fields on cases and contacts — a Clio matter
number, a referral source — added from a config screen instead of by a
developer.

**What works today:** this screen *defines* fields, and fields can *hold
values* — written by automations (`update_case`, `update_contact`) and by the
API. Each active field is also kept as a read-only column of the same name on
the cases or contacts table, which the system adds and removes by itself (see
*Columns* below). Nothing *displays* fields yet: the case and contact forms,
reports, and placeholders pick them up in later releases. Defining a field is
safe: it changes nothing anyone else sees.

### Adding a field

1. Pick the **Cases** or **Contacts** tab at the top.
2. Type the **label** — what staff will see. The **key** fills itself in from
   the label (`Clio matter` → `cf_clio_matter`). Change it if you like, but
   once the field is created **the key is permanent**.
3. Choose the **type**: `text`, `number`, `date`, `select` (pick one),
   `multiselect` (pick several), or `boolean` (yes/no).
4. For `select` / `multiselect`, add the **options**. Each option has a
   **value** (what gets stored, 255 characters at most) and a **label** (what
   staff see). The value follows the label until you type your own. Pick
   values you won't want to change — once fields hold data, the stored value
   is what everything matches on.
5. Optional **validation**: *Required* on any type; *Max length* (up to 255)
   and *Pattern* (a regular expression) on text; *Min* and *Max* on numbers.
6. **+ Add Field.** If something's wrong, the message under the button names
   every problem at once.

### Changing and retiring fields

- **Edit** on a field's card opens its options and validation. Label, type,
  options and validation can all change; press that card's **Save**. The key
  never changes — to "rename" one, deactivate it and create a new field.
- **Reordering:** drag a card by its handle (or use the arrows). The order
  saves immediately — there is no separate sort-order box; position is the
  order.
- **Usage badges:** each card shows how many records hold a value (or
  *unused*). The count and the locks below come from the same check, so what
  the badge says is what the save will enforce.
- **Once any record holds a value, two things lock** (the editor shows them
  locked, and the save is refused with a message if forced another way):
  - the **type** — changing it would silently change how every stored value
    compares. To really change a type, create a new field and have the values
    copied across.
  - each **option value** — the stored value is what everything matches on.
    The editor freezes the values of a field that holds data (a lock icon
    marks them); their *labels* still change freely. On a field with no data,
    values and options stay fully editable and deletable.
- **Retiring an option** (the **Retire** button on its row) keeps the records
  that hold it readable and hides it from pickers; **Reactivate** brings it
  back. Retired options show dimmed with a *retired* chip, and saving the
  card keeps them retired.
- **Deactivate** retires a field. There is no delete. **Reactivate** brings it
  back exactly as it was. Values already stored stay stored; while the field
  is inactive nothing can write it, and its column is removed (it comes back
  on reactivate, values and all).
- **Indexed** is shown but not editable here — it's a speed setting for fields
  that get searched a lot, set by a developer for now. It never applies to a
  `multiselect` field.
- **Every add, edit, deactivate and reactivate is recorded** in the admin audit
  log, with who did it.

### Merging cases

When two cases are merged, custom fields follow the same rules as every other
field. A field the surviving case doesn't have is copied over from the absorbed
case. A field both cases hold with the same value is left alone. A field both
hold with **different** values is a conflict: it blocks the merge, listed as
`custom.<key>` (for example `custom.cf_referral`), until you merge anyway —
then the surviving case keeps its own value. The absorbed case's values are
kept in the merge's log entry either way. Blank values count as not set, but
`0` and *no* are real values.

### Writing values

Automations and API callers write a custom field by its **key**, right next
to ordinary columns:

```json
{ "function_name": "update_case",
  "params": { "case_id": "{{caseId}}",
              "fields": { "case_stage": "Filed", "cf_referral": "Google", "cf_fee": 1500 } } }
```

`update_contact`, `PATCH /api/cases/:id` and `PATCH /api/contacts/:id` take
the same shape. What each type accepts:

| Type | Send | Stored as |
|---|---|---|
| text | text (a number is taken as its text), **255 characters at most** | text, exactly as sent — *Max length* counts characters; *Pattern* must match the **whole** value, not part of it |
| number | a number, or text that is a plain number (`"42.5"`) | a number — within *Min*/*Max*, and under 100 trillion either way |
| date | `YYYY-MM-DD` — a real date (`2026-02-30` is refused) | the same text |
| boolean | `true`/`false`, `1`/`0`, `"true"`/`"false"` | true / false |
| select | one option **value** (`"yes"` matches `Yes`) | the option's value, spelled as defined |
| multiselect | a list of option values, no repeats | the list, in the options' order |

- **Clearing:** `null` or `""` (or `[]` for a multiselect) removes the value.
  `false` and `0` are values, not clears.
- **Retired options** are still accepted — a record re-saved with a retired
  value must not fail. Pickers hide them; the API does not.
- **Required** is not checked on writes — an update that doesn't mention a
  required field must not fail. The forms will enforce it when they show
  custom fields.
- **Refused, with every problem named at once:** a key no field has, a field
  that is deactivated, a value that breaks the type's rules, and `custom`
  itself (the column that stores all the values — only individual keys are
  writable).
- The update result's `updated_fields` and `changes` name each custom key
  separately, like any other column, and a `case.updated` / `contact.updated`
  trigger sees the same per-key `changes`.

### The rules

The server enforces these; the screen just helps you meet them.

- **Key:** `cf_`, then a lowercase letter, then 1–56 more of `a–z`, `0–9`,
  `_` (5–60 characters in all). It becomes a column name (and part of an index
  name, which is why it stops at 60), which is why it's strict and why it
  can't change.
- **One key per record type.** The same key can exist once on cases and once
  on contacts, not twice on either. A key can't match a column the table
  already has.
- **Option values:** not blank, no spaces at either end, 255 characters at
  most, and unique *ignoring case* — `Yes` and `yes` count as the same value.
- **Validation only where it means something:** length and pattern on text,
  min and max on numbers, min no bigger than max, and the pattern must be a
  valid regular expression. Switching a field's type drops options and
  validation that no longer apply when you save.

---

## Technical reference

### Files

| File | Role |
|---|---|
| `ref/migrations/2026-09-24_field_defs.sql` | The table. Column COMMENTs carry the invariants. |
| `services/fieldDefService.js` | Validation, the cached read API, create / update / activate. |
| `routes/api.fieldDefs.js` | HTTP mapper. |
| `public/caseconfig/fields.html` | The Fields tab of YisraCase Config (`cf*` functions) — the editor since CFG-1. |
| `tests/fieldDefs.s1.test.js` | Key regex, collision, shape, immutability, cache, gating, UI↔service pins. |
| `tests/fieldDefs.cfg1.test.js` | CFG-1: the usage endpoint, predicate parity, the settings.html deletions, the rename. |
| `ref/migrations/2026-09-24_custom_columns.sql` | S2: `cases.custom` + `contacts.custom`. A table rebuild (ALGORITHM=COPY) — see its header. |
| `services/caseService.js` / `services/contactService.js` | `updateCase` / `updateContact` — the only writers of `custom`. |
| `tests/customFields.s2.test.js` | Value rules, the one-UPDATE composition, per-key changes, post-data locks, containment, the `custom` JSON-path grep (allowlists the reconciler). |
| `services/fieldDefReconciler.js` | S3: keeps one VIRTUAL column per active def (+ its index). `reconcile`, `scheduleReconcile`, pure `planFor`. |
| `startup/init.js` | S3: one reconcile per instance boot. |
| `ref/migrations/2026-09-24_field_key_comment.sql` | S3: the `field_key` COMMENT follows the 60-char key rule (comment only). |
| `tests/customFields.s3.test.js` | Reconciler plan / idempotence / lock / MDL / audit, trigger rules, the route, the 255 caps, case-merge and petition riders. |

### API

Every route is `jwtOrApiKey` — the same gate as `/api/contact-role-types`, the
editor this one was cloned from. Envelope `{ status: 'success', … }` /
`{ status: 'error', message }`.

| Route | Does |
|---|---|
| `GET /api/field-defs?entity=` | Every def for the entity (`case` or `contact`), inactive included, ordered `sort_order, id`. |
| `GET /api/field-defs/usage?entity=` | `{ field_key: count }` of records holding a value, every def incl. inactive. Shares the type-lock's data-exists predicate, so the editor's badges and the 409s below always agree. |
| `POST /api/field-defs` | Create → `201 { id, entity, field_key }`. Duplicate key → `409`. |
| `PATCH /api/field-defs/:id` | `label`, `field_type`, `options`, `validation`, `show_when`, `sort_order`. The **merged** row is validated whole, so select → text needs `options: null` in the same patch. |
| `POST /api/field-defs/:id/deactivate` · `/reactivate` | `active` 0 / 1. Idempotent. |
| `POST /api/field-defs/reconcile` | Runs the column reconciler now and waits: `200 { result }` (`status` `ok` / `noop` / `dry_run`, `plan`, `executed`, `skipped`, `conflicts`); `409` another run held the lock through the retry; `500` a statement failed — `result.failed` names it with MySQL's error code, the full message is in the system alert. Body `{ "dry_run": true }` plans without executing. |

**Audit (S3):** every successful create / update / deactivate / reactivate
writes an `admin_audit_log` row, `tool = 'field_defs'`, `details.action` naming
the verb (fire-and-forget: an audit failure never fails the request). A
reconcile that ran DDL writes its own row (`details.action = 'reconcile'`,
`trigger`, `executed` statements), attributed to the mutation's user, or to
`system` / `BOOT` for the boot run.

Refused on PATCH with a 400: a changed `entity` or `field_key` (sending the
current value is a no-op), any `active` (use the verbs), a changed `indexed`.
Validation 400s join every problem with `; `. Unknown id → 404. A 5xx never
carries database text.

Refused on PATCH with a **409** once data exists (design doc §3): a changed
`field_type` when any record holds the key; an `options` array that drops (or
re-spells — values are byte-exact) a value some record holds. Both are probed
inside the def's row lock with `JSON_CONTAINS_PATH` / `JSON_CONTAINS`.

### Reading defs from code

`listActive(db, entity)` and `getByKey(db, entity, key, { includeInactive })`
read an in-process cache and return **frozen** rows. Every mutation in the
service invalidates it (`bump()`) — but only on the instance that took the
write; the other Cloud Run instances pick the change up within the 60-second
TTL. `getByKey` is active-only unless asked, so a consumer can tell a retired
key from an unknown one. `listAll` (the editor's list) always reads the DB.

### Storage and the write path (S2)

- `cases.custom` / `contacts.custom` — `JSON NOT NULL DEFAULT (JSON_OBJECT())`,
  one key per field. JSON null is never stored; a cleared field is a removed
  key.
- **One writer per entity.** `caseService.updateCase` and
  `contactService.updateContact` pass the payload through
  `fieldDefService.splitCustomFields` (cf_ keys out, each checked against its
  ACTIVE def by `validateValue`), then append ONE
  `custom = JSON_REMOVE(JSON_SET(custom, …), …)` assignment
  (`customAssignment`) to the same `UPDATE` as the core columns. Nothing
  reads the bag into JS and writes it back.
- `updateCase` now also refuses a key that is neither a real column nor a
  cf_ key (400, `unknown column(s)`), from a cached `information_schema` read.
  Column names match case-insensitively, as MySQL does.
- `changes` are built per key (`buildCustomChanges`) from the pre-write row;
  the string `custom` never appears in `changes` or `updated_fields`.
- **The bag never travels whole.** `custom` is stripped by name from event
  envelopes (`lib/domainEvents.js`), refused by the placeholder resolver
  (`BLOCKED_COLUMNS`) and the report validator (`DENIED_COLUMNS`), dropped
  from `query_db` rows, and stripped from the petition intake's
  `get_contacts` rows (S3 — that payload keeps `contact_ssn` by ruling, for
  Form 121 prep; no other outbound flow does). What *does* travel is each
  active field's own column: every `SELECT *` (event envelopes included)
  carries the `cf_` columns, one per field — by design.
- **No SQL reads a key out of the bag** (design doc §3) — the virtual column
  is the only place to compare on. `tests/customFields.s2.test.js` greps
  `lib/ services/ routes/` for JSON-path reads of `custom` and fails on any
  hit outside its allowlist (the reconciler, whose expressions *are* the
  columns).

### Columns — the reconciler (S3)

`services/fieldDefReconciler.js` keeps the table columns in line with the
registry: for every **active** def, a VIRTUAL generated column named exactly
`field_key` on `cases` / `contacts`, reading `custom`:

| field_type | column | expression |
|---|---|---|
| text, select | `VARCHAR(255)` utf8mb4, `COLLATE utf8mb4_general_ci` | `JSON_VALUE(custom, '$.<key>' RETURNING CHAR(255) …)` |
| number | `DECIMAL(18,4)` | `JSON_VALUE(… RETURNING DECIMAL(18,4))` |
| date | `DATE` | `JSON_VALUE(… RETURNING DATE)` |
| boolean | `TINYINT(1)` | `JSON_VALUE(… RETURNING UNSIGNED)` |
| multiselect | `JSON` | `JSON_EXTRACT(custom, '$.<key>')` — query with `MEMBER OF` |

- **Compare on the column, never on the bag.** String columns compare
  case-insensitively (`general_ci`); a value that doesn't convert reads as
  NULL, never as a fake `0`. Nothing can write the column (MySQL error 3105) —
  writes go through the chokepoint, and `mergeCases` skips every generated
  column (read fresh from `information_schema` on each merge).
- **When it runs:** once per instance boot; after a create, a deactivate or
  reactivate, and an edit that changed `field_type` (label / options /
  validation / sort order don't); and on `POST /api/field-defs/reconcile`.
  Post-mutation runs are fire-and-forget — the save never waits for DDL — and
  bursts on one instance collapse into one follow-up run.
- **What it does:** adds missing columns (`ALGORITHM=INSTANT`), drops columns
  whose def is inactive or gone and retypes a column whose type is wrong
  (`DROP COLUMN … ALGORITHM=INPLACE, LOCK=NONE` — metadata-only for a virtual
  column; INSTANT is refused unless it's the last column), and adds / drops
  `idx_<key>` to match `indexed` (never on multiselect). Dropping a column
  loses nothing — the values stay in `custom`. A second run changes nothing.
- **Safety:** one run at a time across instances (`GET_LOCK`), a 5-second
  metadata-lock timeout with one retry per statement, never inside a
  transaction. It never touches a `cf_` column it didn't make (a real or
  STORED one) — a def that wants that name is skipped and alerted. Failures
  stop the run and raise a system alert (`field_defs_reconcile_failed`,
  `…_lock_busy`, `…_conflict`); the next run picks up from the diff.
- **Capacity:** the columns count toward MySQL's 65,535-byte row limit — about
  **47 text/select fields on cases and 58 on contacts** (numbers, dates,
  yes/no and multiselects barely count). Past that, the reconcile for the new
  field fails with an alert ("Row size too large").
- **Changing the column spec** (`COLUMN_SPECS`) is a deliberate slice: two
  code versions with different specs would each retype the other's columns on
  their next run.

### Columns worth knowing

- `options` — `[{ value, label, active }]`, select / multiselect only, NULL
  otherwise. `active: false` retires an option. An option sent WITHOUT
  `active` keeps its stored state (so an API caller that round-trips
  `{value, label}` can't silently reactivate anything); a new one defaults to
  `true`. The Fields editor always sends the state its toggle shows.
- `validation` — the v1 keys above; `max_len`, `pattern`, `min`, `max` are
  enforced on every write. `required` is not (renderers own it).
- `show_when` — conditional display, **stored but not yet evaluated**. The
  screen has no editor for it and never sends it on Save, so a value set
  through the API survives edits here.
- `indexed` — honoured by the reconciler (`idx_<key>`; ignored for
  multiselect); the API refuses to change it — a developer sets it in SQL,
  then runs `POST /api/field-defs/reconcile`.
