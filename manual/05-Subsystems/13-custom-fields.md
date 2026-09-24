# 13 — Custom Fields

**Where:** Sidebar → Settings → **Custom Fields**.
**Table:** `field_defs`.
**Design:** `ref/CUSTOM_FIELDS_DESIGN.md` — a living doc; its §7 table says which
parts of the feature have shipped. This chapter grows as they do.

## For operators

Custom fields are the firm's own fields on cases and contacts — a Clio matter
number, a referral source — added from a settings screen instead of by a
developer.

**What works today:** this screen *defines* fields. Nothing displays them or
stores values in them yet — the case and contact forms, reports, and
automations pick them up in later releases. Defining a field now is safe: it
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
- **Deactivate** retires a field. There is no delete. **Reactivate** brings it
  back exactly as it was.
- **Indexed** is shown but not editable — it's a speed setting the system will
  manage.

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

### Reading defs from code

`listActive(db, entity)` and `getByKey(db, entity, key, { includeInactive })`
read an in-process cache and return **frozen** rows. Every mutation in the
service invalidates it (`bump()`) — but only on the instance that took the
write; the other Cloud Run instances pick the change up within the 60-second
TTL. `getByKey` is active-only unless asked, so a consumer can tell a retired
key from an unknown one. `listAll` (the editor's list) always reads the DB.

### Columns worth knowing

- `options` — `[{ value, label }]`, select / multiselect only, NULL otherwise.
- `validation` — the v1 keys above; stored now, enforced when values exist.
- `show_when` — conditional display, **stored but not yet evaluated**. The
  screen has no editor for it and never sends it on Save, so a value set
  through the API survives edits here.
- `indexed` — owned by the future reconciler; the API refuses to change it.
