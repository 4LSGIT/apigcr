# 13 — Custom Fields

**Where:** Sidebar → Settings → **Custom Fields**.
**Table:** `field_defs`.
**Design:** `ref/CUSTOM_FIELDS_DESIGN.md` — a living doc; its §7 table says which
parts of the feature have shipped. This chapter grows as they do.

## For operators

Custom fields are the firm's own fields on cases and contacts — a Clio matter
number, a referral source — added from a settings screen instead of by a
developer.

**What works today:** this screen *defines* fields, and fields can *hold
values* — written by automations (`update_case`, `update_contact`) and by the
API. Nothing *displays* them yet: the case and contact forms, reports, and
placeholders pick them up in later releases. Defining a field is safe: it
changes nothing anyone else sees.

### Adding a field

1. Pick **Cases** or **Contacts** at the top of the section.
2. Type the **label** — what staff will see. The **key** fills itself in from
   the label (`Clio matter` → `cf_clio_matter`). Change it if you like, but
   once the field is created **the key is permanent**.
3. Choose the **type**: `text`, `number`, `date`, `select` (pick one),
   `multiselect` (pick several), or `boolean` (yes/no).
4. For `select` / `multiselect`, add the **options**. Each option has a
   **value** (what gets stored) and a **label** (what staff see). The value
   follows the label until you type your own. Pick values you won't want to
   change — once fields hold data, the stored value is what everything matches
   on.
5. Optional **validation**: *Required* on any type; *Max length* and *Pattern*
   (a regular expression) on text; *Min* and *Max* on numbers.
6. **+ Add Field.** If something's wrong, the message under the button names
   every problem at once.

### Changing and retiring fields

- **Edit** on a field's card opens its options and validation. Label, type,
  sort order, options and validation can all change; press that card's
  **Save**. The key never changes — to "rename" one, deactivate it and create
  a new field.
- **Once any record holds a value, two things lock** (the save is refused
  with a message saying so):
  - the **type** — changing it would silently change how every stored value
    compares. To really change a type, create a new field and have the values
    copied across.
  - each **option value** that some record holds — the stored value is what
    everything matches on. Its *label* can still change freely. An option no
    record uses can be deleted outright.
- **Retiring an option** instead of deleting it keeps the records that hold it
  readable and hides it from pickers. The editor has no retire switch yet —
  it's set through the API (`"active": false` on the option; see `options`
  under *Columns worth knowing* below). Saving the card from the editor keeps
  a retired option retired.
- **Deactivate** retires a field. There is no delete. **Reactivate** brings it
  back exactly as it was. Values already stored stay stored; while the field
  is inactive nothing can write it.
- **Indexed** is shown but not editable — it's a speed setting the system will
  manage.

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
| text | text (a number is taken as its text) | text, exactly as sent — *Max length* counts characters; *Pattern* must match the **whole** value, not part of it |
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

- **Key:** `cf_`, then a lowercase letter, then 1–60 more of `a–z`, `0–9`,
  `_` (5–64 characters in all). It becomes a column name, which is why it's
  strict and why it can't change.
- **One key per record type.** The same key can exist once on cases and once
  on contacts, not twice on either. A key can't match a column the table
  already has.
- **Option values:** not blank, no spaces at either end, and unique *ignoring
  case* — `Yes` and `yes` count as the same value.
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
| `public/settings.html` | The Custom Fields section (`cf*` functions). |
| `tests/fieldDefs.s1.test.js` | Key regex, collision, shape, immutability, cache, gating, UI↔service pins. |
| `ref/migrations/2026-09-24_custom_columns.sql` | S2: `cases.custom` + `contacts.custom`. A table rebuild (ALGORITHM=COPY) — see its header. |
| `services/caseService.js` / `services/contactService.js` | `updateCase` / `updateContact` — the only writers of `custom`. |
| `tests/customFields.s2.test.js` | Value rules, the one-UPDATE composition, per-key changes, post-data locks, containment, the `custom` JSON-path grep. |

### API

Every route is `jwtOrApiKey` — the same gate as `/api/contact-role-types`, the
editor this one was cloned from. Envelope `{ status: 'success', … }` /
`{ status: 'error', message }`.

| Route | Does |
|---|---|
| `GET /api/field-defs?entity=` | Every def for the entity (`case` or `contact`), inactive included, ordered `sort_order, id`. |
| `POST /api/field-defs` | Create → `201 { id, entity, field_key }`. Duplicate key → `409`. |
| `PATCH /api/field-defs/:id` | `label`, `field_type`, `options`, `validation`, `show_when`, `sort_order`. The **merged** row is validated whole, so select → text needs `options: null` in the same patch. |
| `POST /api/field-defs/:id/deactivate` · `/reactivate` | `active` 0 / 1. Idempotent. |

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
  (`BLOCKED_COLUMNS`) and the report validator (`DENIED_COLUMNS`), and dropped
  from `query_db` rows. Event `data` does not carry cf_ values either — S3's
  per-field columns will bring them in one column each.
- **No SQL reads a key out of the bag** (design doc §3) — the S3 virtual
  column will be the only place to compare on. `tests/customFields.s2.test.js`
  greps `lib/ services/ routes/` for JSON-path reads of `custom` and fails on
  any hit.

### Columns worth knowing

- `options` — `[{ value, label, active }]`, select / multiselect only, NULL
  otherwise. `active: false` retires an option. An option sent WITHOUT
  `active` keeps its stored state (the editor round-trips `{value, label}`
  only); a new one defaults to `true`.
- `validation` — the v1 keys above; `max_len`, `pattern`, `min`, `max` are
  enforced on every write. `required` is not (renderers own it).
- `show_when` — conditional display, **stored but not yet evaluated**. The
  screen has no editor for it and never sends it on Save, so a value set
  through the API survives edits here.
- `indexed` — owned by the future reconciler; the API refuses to change it.
