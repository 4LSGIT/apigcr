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

**What works today:** everything. Define a field here and it shows up by
itself — on the case and contact records for staff to fill in, in reports, in
trigger conditions and in document and message templates. Nobody writes any
code for a new field. Automations (`update_case`, `update_contact`) and the
API write values too. Each active field is also kept as a read-only column of
the same name on the cases or contacts table, which the system adds and
removes by itself (see *Columns* below).

See **Using a field** below for the walkthrough from "add a field" to "it's in
a report".

> **The firm's first two fields are the Clio ids** — **Clio Matter ID** on
> cases and **Clio Contact ID** on contacts, migrated out of hidden database
> columns on 2026-09-25. They were never on any screen before; they are now,
> and staff can edit them. Everything else is still yours to add: doing so is
> safe and reversible — deactivate a field and every trace disappears from the
> screens again, with the stored values kept.

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
   *Required* means **required on the record screen** — see *Using a field*.
6. Optional **Show this field only when…** — leave the first box empty and the
   field always shows. Fill it in and the field appears on the record only
   when the condition holds:
   - the **field** box takes any column on that record (`case_chapter`,
     `contact_kind`) or another custom field's key (`cf_band`). The list
     suggests your other custom fields; you can type any column name.
   - the **test** is *is* / *is not* / *is one of* / *is filled in* / *is
     empty*. *is one of* takes **one value per line** — not a comma list,
     because an option value may itself contain a comma.
   - for a multiselect source, *is* and *is one of* ask whether that option is
     **among** the ones picked.
   - for a yes/no source, write `true` or `false`.
   - it is a display rule, not a privacy one: a hidden field's value is still
     in the record, still reportable and still in templates.
7. Optional **Default** — a value stamped onto **new** records of that kind as
   they are created. See *Defaults* below; the one thing to know here is that
   it never changes a record that already exists.
8. **+ Add Field.** If something's wrong, the message under the button names
   every problem at once.

### Using a field

Once a field is active it appears everywhere by itself. A worked example — a
*Referral source* on contacts:

1. **Define it.** More → YisraCase Config → Fields → **Contacts** tab. Label
   `Referral source`, key fills in as `cf_referral_source`, type `select`,
   options `google` / `friend` / `attorney` with friendly labels. **+ Add
   Field.**
2. **See it on the record.** Open any contact. Under *Roles* there is now a
   **Custom Fields** panel with a *Referral source* dropdown. On a case the
   panel sits under the Overview box, above Pipeline. Pick a value and press
   **Save** — it saves only the custom fields you changed, and nothing else on
   the record.
   - If something is wrong (a value too long, an option that no longer
     exists), the message appears right under the fields, in the server's own
     words. Nothing is saved until it is right.
   - Fields marked **Required** must be filled in before that Save goes
     through. A field hidden by its *show only when* condition is not
     required while it is hidden.
   - A **yes/no** field is a dropdown with three choices — blank, Yes, No —
     not a tickbox, because "No" and "never answered" are different answers
     and a tickbox can only tell you one of them.
   - The panel is only there when the firm has at least one active field for
     that record type. With none defined, there is no panel at all.
3. **Report on it.** More → Reports → ask for what you want in plain English.
   The report author already knows the field exists, what type it is and which
   option values it accepts — it is told about every active custom field on
   every request, so "how many contacts came from Google this year" just
   works. A report written by hand can use `cf_referral_source` like any
   column.
4. **Trigger on it.** In a trigger rule's conditions, match on
   `changes.cf_referral_source.to` to fire when the field is *set to*
   something, or on `data.cf_referral_source` for the value the record now
   holds.
5. **Put it in a template.** `{{contacts.cf_referral_source}}` in an email,
   SMS or document works like any other column, including a fallback:
   `{{contacts.cf_referral_source|default:not recorded}}`.
6. **See who changed it.** A custom-field edit on a **contact** appears in
   that contact's log as an update entry naming each key that changed, the
   same way a change to a built-in contact field does. Case records don't log
   field edits at all — custom or built-in — so a case's custom-field changes
   are visible in automations and reports, not in its log.

### Changing and retiring fields

- **Edit** on a field's card opens its options, validation and show-only-when
  condition. Label, type, options, validation and the condition can all
  change; press that card's **Save**. The key never changes — to "rename" one,
  deactivate it and create a new field.
- **An advanced condition set through the API** that this screen can't draw is
  shown read-only, as the stored text, with a note saying so. Saving the card
  leaves it exactly as it is — the editor never overwrites a condition it
  can't display.
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

### Defaults

A field can carry a **Default** — a value written onto **new** records of that
kind at the moment they are created. Set it in the field's **Edit** panel; the
box matches the type (a dropdown of the options for `select`, a date picker for
`date`, Yes/No for a boolean). Leave it empty for no default, and blank it again
to remove one.

**What a default does**

- A case or contact created from then on is born holding that value, exactly as
  if someone had typed it in. It is in the record, in reports, in templates and
  in automation conditions from the first moment.
- It applies however the record was created — the contact screen, an intake
  form, a website submission, a booking, a workflow, the petition import.
- It applies even to a field hidden by *Show this field only when…*. A default
  is about the data, not the screen. (That is deliberate: the alternative is a
  value that exists or not depending on an unrelated field's state.)

**What a default does NOT do — read this one**

- **It never touches records that already exist.** Adding a default today does
  nothing to the cases and contacts already in the system, and neither does
  changing or removing one. Those records keep whatever they hold, including
  nothing at all. This is the single most common surprise: setting a default
  does *not* fill in the blanks you were hoping to fill.
  If you want existing records filled in too, that is a separate one-off job —
  ask for it, and it gets done as a deliberate data change with a record of
  what it touched. There is no button for it, on purpose.
- **It is not a "required" substitute.** A default gives a starting value;
  *Required* makes someone confirm one. You can use both.
- **It cannot mean "clear this field".** A default is a value. Emptying the box
  removes the default; it does not make new records blank a field.

**Rules the screen enforces**

- The default has to be a legal value for its own field — the right type, a
  real date, inside the field's own Max length / Min / Max / Pattern, within
  255 characters. If it isn't, the save is refused with a message naming the
  default.
- For `select` / `multiselect` the dropdown offers **active** options only: a
  default staff can't pick makes no sense. If you **retire** the option a
  default currently points at, that save is refused — clear the default in the
  same save and it goes through. An option retired *after* it was made the
  default keeps working on new records; it simply can't be chosen as a new one.
- Changing a field's **type** while its default no longer fits is refused the
  same way (clear the default in the same save). A default that still fits is
  converted — a text default of `0001234` on a field becoming `number` becomes
  `1234`, zeros and all gone. If the leading zeros matter, keep the field
  `text`.
- A default can be set, changed or cleared at **any** time, including on a
  field that already holds data on thousands of records — because it changes
  none of them.

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
  required field must not fail, or every automation would break the moment
  someone ticks *Required*. It is enforced where a person is filling the
  field in: the Custom Fields panel on the record blocks its Save until every
  visible required field has a value.
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
- **Defaults are validated as values.** A default must pass every rule its own
  field applies to a typed-in value, and for `select`/`multiselect` it must name
  an option that is still **active**. Unlike the type and the option values, a
  default carries **no lock** — it can be set, changed or cleared at any time,
  because doing so changes no stored record.
- **Show-only-when is one condition** — a field, a test, and a value. There is
  no *and* / *or*, and no nesting. A condition that isn't one of those five
  tests is ignored and the field simply always shows (with a note in the
  browser console for a developer).

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
| `public/js/yc-custom-fields.js` | S4: THE renderer. The Custom Fields section on both records — typed inputs, `show_when` v1, the `required` gate, the changed-keys-only save. Also CommonJS, so its pure halves are unit-testable. |
| `public/case.html` / `public/forms/contact-form.html` | S4 mount points (`cfSection` under the Overview box; `customFieldsSection` after Roles). Neither rides an aggregate form save. |
| `lib/reportSchema/customFieldsAppendix.js` | S4: the registry-driven appendix to the (hand-maintained) report manifest, merged into the report author's prompt per request via `aiService`'s `systemAppend`. |
| `ref/migrations/2026-09-25_field_defs_default_value.sql` | S6: `field_defs.default_value`. Plain nullable JSON, `ALGORITHM=INSTANT`; the COMMENT carries the semantics. |
| `ref/migrations/2026-09-25_field_defs_default_value_comment.sql` | S6-B: the COMMENT names the chokepoints after the extraction (comment only). |
| `services/caseService.js` | S6-B: `createCase` — **the only `INSERT INTO cases`**. Mints the id, retries on collision, gates the columns, stamps the defaults, reads the cf_ columns back for the envelope. Plus `NOW_FIRM`, the firm-local-now sentinel. |
| `services/intakeService.js` / `routes/api.intake.petition.js` | The two case create CALLERS. Each keeps its own linking, log row and `case.created` emit, spreading the returned `custom_fields` into that envelope's `data`. The petition route's *other* branch UPDATEs an existing case and deliberately does not stamp. |
| `tests/customFields.s6.test.js` | S6: the scalar-JSON reader trap, def-save validation incl. the active-option rule, merged-row re-validation, `defaultsObject`/`customCreateValue`, the createContact stamp + the cf_-at-create refusal, never-retroactive, the two case sites, and the create-site greps. |
| `tests/customFields.s4.test.js` | S4: normalisation from both carriers, the `show_when` truth table, the required gate, retired-option display, the log rows, the envelope read-back, the trigger/placeholder/report demonstrations, the appendix. |

### API

Every route is `jwtOrApiKey` — the same gate as `/api/contact-role-types`, the
editor this one was cloned from. Envelope `{ status: 'success', … }` /
`{ status: 'error', message }`.

| Route | Does |
|---|---|
| `GET /api/field-defs?entity=` | Every def for the entity (`case` or `contact`), inactive included, ordered `sort_order, id`. |
| `GET /api/field-defs/usage?entity=` | `{ field_key: count }` of records holding a value, every def incl. inactive. Shares the type-lock's data-exists predicate, so the editor's badges and the 409s below always agree. |
| `POST /api/field-defs` | Create → `201 { id, entity, field_key }`. Duplicate key → `409`. |
| `PATCH /api/field-defs/:id` | `label`, `field_type`, `options`, `validation`, `show_when`, `default_value`, `sort_order`. The **merged** row is validated whole, so select → text needs `options: null` in the same patch — and a patch that leaves `default_value` out still re-validates the STORED default against the new type and options (S6). |
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

### Consumers (S4)

Three of the five needed no plumbing — the virtual columns had already made
them work, and S4 only proves and pins them.

- **The record sections** are one module, `public/js/yc-custom-fields.js`,
  mounted twice. It reads the record payload the page already loaded (both
  `GET` routes are `SELECT *`, so the bag and the cf_ columns both ride
  along). `normalizeValue` folds either carrier to one value — the bag holds
  what the chokepoint stored, the columns arrive driver-coerced (DECIMAL as a
  string, TINYINT as 1/0, DATE as an ISO string) — so either works.
  - **The COLUMN wins**, with the bag as the fallback when a row has no such
    column yet. They agree on a freshly fetched row, and disagree after a
    sync-bus message: the sniff emits the PATCH body and the host
    `Object.assign`s it onto its cached row, so the column is current and the
    bag is whatever the last full GET returned. Bag-first made a just-saved
    value visibly revert on the next repaint.
  - Dates are read in **UTC** components. The pool runs `timezone:'Z'`, so a
    DATE is built at UTC midnight; local components are a day early anywhere
    west of UTC — which is every staff machine here, and no machine east of
    it, so the bug is invisible to half the people who could introduce it.
  - The contact form hands the section an **apiMap-renamed** row
    (`contact_kind` → `kind`), so it maps the nine renames back before
    evaluating a `show_when`; a condition can name either spelling.
  - Zero active defs ⇒ nothing renders. A failed registry read ⇒ hidden,
    `console.warn`, no throw. A record page must never break on this panel.
  - A repaint (a sibling form saving, a bus message) **never clobbers an
    unsaved edit**, and never steals focus — same comparison fence as the
    case-notes textarea, plus an `activeElement` check, because a re-render
    replaces the section wholesale.
  - The save sends only the keys whose value changed, and shows the
    chokepoint's 400/409 verbatim, inline. It never re-implements a
    validation rule; `maxlength` on text is a typing aid, not a gate.
- **Reports:** `lib/reportSchema/manifest.js` stays hand-maintained — it
  carries semantics no introspection recovers. Admin-defined fields can't be
  in it (staff create them with no deploy), so they are rendered per request
  by `customFieldsAppendix.js` and appended to the author's system prompt via
  `aiService.call({ systemAppend })`. There is no separate cache: the def
  cache IS the cache. `systemAppend` is an append, not a `{{var}}`, precisely
  so a caller that forgets it ships today's prompt rather than literal
  braces.
- **Trigger conditions** and **placeholders** needed no code. The condition
  evaluator resolves any dot-path into the envelope, and the resolver's
  `^\w+$` identifier check passes a `cf_` name.
  - `case.updated`'s `data` is built as "the pre-read row overlaid with what
    we wrote", and cf_ values live in `custom`, which is not overlaid — so
    until S4 `data.cf_x` was the value from **before** the write while
    `contact.updated` (which re-fetches post-commit) already had the new one.
    `updateCase` now **reads the written cf_ columns back** after its UPDATE,
    rather than overlaying the JSON values: `data.cf_x` must be the column's
    shape (`'1234.5000'`, `1`, an ISO date) because that is what the contact
    re-fetch carries, and conditions compare with `String()`. Guarded and
    never fatal. Core columns are not re-read — that would change `data` for
    every existing rule. `changes.cf_x.to` holds the JSON value and was
    correct on both sides throughout.
- **The log** (closes the §9 open item): a cf_ change on a **contact** writes
  one app-side `logService.createLogEntry` row from inside `updateContact`'s
  transaction, shaped like `after_contact_update`'s (`previous_<key>` /
  `new_<key>`) so the existing log view renders it with no change. The two
  writers cannot double-log: the trigger compares 17 named columns and
  `custom` is not one of them, so a cf_-only save leaves it with nothing to
  say. **Cases write no row** — `updateCase` logs no core-column edit either
  (there is no `after_case_update`), so custom fields are exactly as logged
  as core columns there. The case-log gap is its own job (`ref/plans.md`).

### Retiring a column into a custom field (S5)

The pilot migration, and the **template for retiring any surplus column**.
Done once for real on 2026-09-25: `cases.clio_matter` (240 values) and
`contacts.contact_clio_id` (245) became `cf_clio_matter` and `cf_clio_id`;
`cases.case_clio_id` (0 values) was dropped outright. The design doc's §7 S5
row is the ruling; this is the procedure.

The names could NOT be kept: `field_key` must match `^cf_`, and the registry
refuses a key that collides with a real column. So every consumer moves too,
which is why the census comes first.

**Phase A — migrate and freeze. Nothing is destroyed.**

1. **Census, before any write.** Sweep the repo AND the live config tables for
   the column name: `workflow_steps`, `sequence_steps`, `trigger_rules` +
   `trigger_rule_actions`, `report_definitions` (+versions), `portal_cards`,
   `contract_templates`, the `email_ingest_*` / `phone_ingest_*` rules and
   actions, `hooks` / `hook_targets`, `form_templates`, and the `tools` table.
   Escape the `_` in a `LIKE` or `clio_matter` also matches `clioXmatter`.
   Classify every hit as repoint-now / clean-up-later / **no-op** — and take
   the no-ops seriously. Two of the six live hits in this migration were a
   step's prose *note* and a `create_log` payload whose JSON key happened to
   be `clio_matter`; "fixing" the second would have corrupted every log row
   the workflow writes. Also check the DB triggers in `ref/database.sql`
   (`grep`), which no config sweep will show you.
2. **Create the def** with `fieldDefService.createDef` — never a raw INSERT,
   which skips validation, the audit row and the reconcile that builds the
   column. `scripts/customFieldsS5Seed.js` is the worked example. Then
   **prove the virtual column exists** in `information_schema` before going on.
3. **Backfill** with one UPDATE per field:
   `SET custom = JSON_SET(custom, '$.cf_key', old_col) WHERE old_col <> ''`.
   Raw SQL on purpose — no events, no log rows, and (on contacts) no
   `contact_updated` bump, so the Google drift sweep stays quiet. `<> ''`
   matters: an empty source must leave the key **absent**, which is how "no
   value" is spelled here.
4. **Verify against the virtual column, not the JSON path** — that proves
   storage, extraction, width and collation in one go:
   `COUNT(old <> '')` = `COUNT(cf_ IS NOT NULL)`, and
   `SELECT COUNT(*) … WHERE NOT (cf_key <=> NULLIF(old_col,''))` = 0.
   Run **both**. The counts alone are not a gate: swap two rows and the
   totals still balance while the values are on the wrong records — only the
   `<=>` query catches that.
5. **Repoint the consumers** the census found. Workflow steps go through
   asserted `apiSend` scripts that check the current config before writing and
   the whole resulting draft before publishing
   (`scripts/customFieldsS5Wf37Repoint.js`); trigger-rule *actions* must be
   edited in the UI, because the editor DELETE+REINSERTs them and any SQL
   patch keyed on an action id silently does nothing.
6. **Freeze the old column at the chokepoint.** It keeps reading; it stops
   accepting writes, with an error that names the new key
   (`"clio_matter" is retired — write "cf_clio_matter" instead`). This is
   what makes drift impossible during the soak: one write to each side and
   nobody can tell which value is current.
7. **Soak.** As long as you like — nothing is lost while both copies exist.

**Phase B — drop. This one is one-way.**

8. **Rebuild any DB trigger that names the column, in the same migration and
   BEFORE the drop.** `ALTER TABLE … DROP COLUMN` succeeds happily while a
   trigger still references the column, and then *every* write to that table
   fails with `ERROR 1054 Unknown column 'x' in 'OLD'`. Verified on 8.4.11:
   dropping `contact_clio_id` with `after_contact_update` untouched broke
   every contact update; rebuilding the trigger first, then dropping, works.
9. **Drop the column**, then remove the freeze (unknown-column rejection now
   covers it), the fn ALLOWED-list entries, the report-manifest entry, and
   whatever the census marked clean-up-later.
10. `node scripts/dump-schema.js` and `npm run db:ref:check`.

On `contacts`, a column drop is a **table rebuild** — its FULLTEXT index on
`contact_name` rules out the metadata-only path. At ~1,100 rows that is
sub-second, but it takes the table's metadata lock, so pick a quiet minute.

### Defaults — the create-time stamp (S6)

`field_defs.default_value` (JSON, nullable) holds an optional value **stamped
once, into a new record's `custom`, by the create services** — and never
consulted again. Design doc §3 "Defaults" is the ruling; the four halves:
stamped at creation only, never retroactive, stamped regardless of `show_when`,
and a default is a value (NULL = no default; there is no "default to clear").

**Validated at def save,** by `_checkDefault` → the same `validateValue` a
written value goes through, against the **merged** def. So `updateDef` refuses a
retype or an options edit that would orphan the stored default, naming
`default_value` in the 400. One rule is not `validateValue`'s: a
select/multiselect default must name an **active** option. That is asymmetric
with writes, which accept active *or* retired (§3) — so a default stored while
its option was active keeps stamping after the retire; it just can't be set as a
new one. A patch that re-normalizes the default persists it even without naming
it, so the stored def is always canonical (otherwise a `number` field could keep
the JSON string `"0001234"` and stamp it into a `DECIMAL(18,4)` column).

**Read AS-IS.** This is the one JSON column here that holds a *scalar*, and
mysql2 has already parsed it. Running it through the reader the other JSON
columns use (`_parseJson`) is silent data loss — measured on 8.4.11: `'abc'` →
null, `'0001234'` → null, `'2026-09-25'` → null, `'123'` → the *number* `123`.
Hence `_defaultIn`, and the mutation check in `tests/customFields.s6.test.js`
that demonstrates all four.

**Where it is stamped.** `fieldDefService.defaultsObject(db, entity)` →
`{cf_key: value}` over active defs that have one (cached with the def cache, so
no query per create); `customCreateValue(obj)` → the JSON text for a bound `?`,
or `null` when there is nothing to stamp (the caller then omits `custom` and the
column's own `DEFAULT (JSON_OBJECT())` supplies `{}`, byte-identical to the
pre-S6 statement). Composed **into the create INSERT** — one write, no follow-up
UPDATE, so the row is born with its defaults and `contact.created`'s post-commit
`SELECT *` picks up the virtual columns free.

Two chokepoints, one per entity, each the only INSERT into its table — both
pinned by a test that fails if a second appears:

| Entity | Chokepoint | Reached from |
|---|---|---|
| contact | `contactService.createContact` | The API, both intake routes, the petition's two debtors, booking's find-or-create. |
| case | `caseService.createCase` | `intakeService.intakeCase` (`POST /api/intake/case`, `intake_case`) and the petition route's create branch — **that branch only**; its sibling UPDATEs a case that already exists, and stamping there would be the retroactive write the ruling forbids. |

`createCase` was extracted in S6-B (2026-09-25) precisely because the case side
had no chokepoint and S6 would otherwise have written the stamp twice. It owns
the id, the collision retry, the column gate, the write safeties `updateCase`
applies, the stamp, and the envelope read-back. It deliberately does **not**
own linking, the log row or the `case.created` emit — the two callers differ
there, and moving the emit would fire it before the link exists and drop
`extra.case_relate_id` from a live envelope.

**`undefined` omits a column; `null` writes NULL** — and that is not a
nicety. `cases` is mostly NOT NULL with no DB default, and a single-row INSERT
of an explicit NULL into such a column is an error *even under this session's
permissive sql_mode* (measured under production's exact mode). Omitting is the
only way to get the implicit default.

**Creation envelopes.** `contact.created` carries the stamped values free — it
is a post-commit `SELECT *`. `case.created` is hand-built, so `createCase`
returns the values **read back from the generated columns** and each caller
spreads them into `data`. That read-back is what makes `data.cf_x` mean the
same thing on both events (a boolean is `1`/`0` on each). Additive only, and
never fatal.

**The create fence stays shut.** An explicit `cf_` key passed to
`createContact` is a **400 naming the key**, telling the caller to PATCH after
create. Before S6 it was silently dropped (the function destructures a fixed
parameter list); with defaults arriving, silence would have become worse than
nothing — the caller would get the *default* where they asked for their own
value. Non-`cf_` stray keys are still ignored exactly as before, because
`POST /api/contacts` hands `req.body` over wholesale.

**Not built, deliberately:** nothing prefills a default into a form before the
record exists. The census found no create-time form that renders custom fields
(the case page needs a case; the contact form PATCHes a contact id), and a form
showing a value the database doesn't hold is the lie surface the ruling closed.
The renderer has no notion of `default_value` at all, and a test pins that.

### Columns worth knowing

- `options` — `[{ value, label, active }]`, select / multiselect only, NULL
  otherwise. `active: false` retires an option. An option sent WITHOUT
  `active` keeps its stored state (so an API caller that round-trips
  `{value, label}` can't silently reactivate anything); a new one defaults to
  `true`. The Fields editor always sends the state its toggle shows.
- `validation` — the v1 keys above; `max_len`, `pattern`, `min`, `max` are
  enforced on every write. `required` is not (renderers own it).
- `show_when` — conditional display, evaluated **client-side only**, by
  `public/js/yc-custom-fields.js`. v1 is one condition:
  `{ field, op, value }` with `op` one of `eq` / `ne` / `in` / `not_empty` /
  `empty`; `field` is a same-entity core column or a `cf_` key; `in` takes an
  array. Comparison follows `services/hookFilter.js` (string equality), with
  two refinements: a boolean source compares as a boolean, and a multiselect
  source tests membership. Anything that is not exactly that shape is stored
  untouched, treated as "always show", and console-warned — a later
  vocabulary must never be half-evaluated by v1. The Fields editor builds a
  v1 condition and sends it; a stored shape it cannot represent is shown
  read-only and **omitted** from the PATCH, which is what preserves it (the
  service only writes the keys a patch carries). It is not a security
  boundary: the value is still in the API payload and still queryable.
- `indexed` — honoured by the reconciler (`idx_<key>`; ignored for
  multiselect); the API refuses to change it — a developer sets it in SQL,
  then runs `POST /api/field-defs/reconcile`.
