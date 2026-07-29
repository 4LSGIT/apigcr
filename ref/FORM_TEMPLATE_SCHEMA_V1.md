# YisraForm Template Schema — Contract v1

**Status:** For review — freeze point before Slice 1
**Consumers:** `forms/render.html` (renderer), builder UI (Slice 3), template CRUD API
**Principle:** The builder is an editor for a template record; the renderer is the product. The renderer derives a complete `YCForm` config from `definition` JSON — no per-form code. Existing 5 hand-built forms are untouched.

---

## 1. Database

```sql
CREATE TABLE form_templates (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  form_key         VARCHAR(50)  NOT NULL,           -- immutable once any form_submissions row exists for it
  title            VARCHAR(150) NOT NULL,
  link_type        VARCHAR(20)  NOT NULL,           -- 'case' | 'contact' | 'appt'
  schema_version   INT UNSIGNED NOT NULL DEFAULT 1, -- of the PUBLISHED definition
  definition       JSON NULL,                       -- published definition; NULL = never published
  draft_definition JSON NOT NULL,                   -- working copy the builder edits
  published_at     DATETIME NULL,
  updated_by       INT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY idx_form_key (form_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE form_template_versions (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  template_id    INT UNSIGNED NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  definition     JSON NOT NULL,
  published_by   INT UNSIGNED NULL,
  published_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tpl (template_id, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```

Single row per `form_key`; published + draft coexist as two JSON columns (no duplicate-key dance). Publish = copy `draft_definition` → `definition`, bump `schema_version` if the field set changed (see §6), append a `form_template_versions` row.

**mysql2 hazard (known):** native `json` columns come back as parsed objects and must be `JSON.stringify()`-ed before binding to `?` placeholders.

---

## 2. API routes (`routes/api.formTemplates.js`, auto-mounted)

All `jwtOrApiKey`. Response envelope `{ status: 'success', ... }` matching `api.forms.js` style.

```
GET    /api/form-templates                    — list: id, form_key, title, link_type, schema_version, published_at, updated_at
GET    /api/form-templates/:id                — full row (draft + published definitions)
POST   /api/form-templates                    — create { form_key, title, link_type, draft_definition }
PUT    /api/form-templates/:id                — update { title?, draft_definition? }; form_key change rejected if any
                                                form_submissions row exists for the old key
POST   /api/form-templates/:id/publish        — publish flow (§6); returns { schema_version, bumped: bool }
DELETE /api/form-templates/:id                — allowed only if never published AND no submissions
GET    /api/form-templates/render/:form_key   — published { title, link_type, schema_version, definition } only.
                                                What render.html consumes. 404 if unpublished.
GET    /api/form-templates/:id/versions             — publish history (Slice 4): id, schema_version,
                                                      published_by, published_at + computed schema_changed
                                                      (field-set signature vs the chronologically previous
                                                      row; first publish = true). No definition bodies.
GET    /api/form-templates/:id/versions/:versionId  — one version row incl. definition (404 on ownership
                                                      mismatch)
POST   /api/form-templates/:id/versions/:versionId/restore
                                                    — copy the version's definition into draft_definition
                                                      (SQL column-to-column; published untouched; no
                                                      re-validation — PUT/publish remain the gates)
```

Server-side validation on create/update: `form_key` matches `^[a-z0-9_]{1,50}$`; `link_type` in the allowed set; `draft_definition` passes structural validation (§7). External/public access to the render route is a Slice 4 concern — v1 is authed only.

---

## 3. Definition JSON — top level

```json
{
  "dataMode": "live",
  "autosave": true,
  "autosaveMs": 3000,
  "toggle": true,
  "warningText": "You must press SAVE to keep changes!",
  "saveLabel": "Save",
  "endpoints": {
    "load": { "method": "GET", "url": "/api/cases/{linkId}?include=clients", "path": "case" }
  },
  "onSubmit": {
    "patch":    { "method": "PATCH", "url": "/api/cases/{linkId}" },
    "workflow": { "id": 7, "initData": { "source": "templated_form" } }
  },
  "hooks": null,
  "sections": [ ... ]
}
```

| Key | Type / default | Notes |
|---|---|---|
| `dataMode` | `'live'` \| `'snapshot'`, default `live` | Passed straight to YCForm |
| `autosave` / `autosaveMs` | bool default `true` / int default `3000` | |
| `toggle` | bool default `true` | `true` = view/edit toggle header, YCForm `readonly: true` start. `false` = always-edit (issn/casedetails style), `readonly: false`, toggle hidden |
| `warningText`, `saveLabel` | strings, defaults shown | |
| `endpoints.load` | optional | Same shape YCForm expects, incl. `path`. Omit for JSON-only forms |
| `onSubmit.patch` | optional | If present, PATCH payload = **changed fields that declare `apiColumn`**, excluding `readonly` fields (explicit whitelist — deliberately narrower than the default `_buildPatchPayload`; renderer overrides it) |
| `onSubmit.workflow` | optional | Same semantics as YCForm: form data spread as init vars, system fields win |
| `hooks` | string or null | Names a repo file `/forms/hooks/{hooks}.js`. If set, renderer loads it via `<script>`; the file may define `window.ycHooks = { onLoad(form, data), onSave(form, result) }`, called at the same points hand-built forms use them. **Executable code lives in the repo only — never in the DB.** |
| `note` | string, optional | **Documentation only, explicitly ignored** (2.5A). Valid at form, section, row, and field level. Never rendered, never validated beyond being ignored, never part of the schema signature (§6 hashes `(name, type)` only). The migration ports use it to record why a field exists. |

`formKey`, `linkType`, `title`, `schemaVersion` are NOT in the JSON — they come from the template row (single source of truth).

---

## 4. Sections, rows, fields

`sections` is an array. Two section kinds:

### 4.1 Standard section

```json
{
  "title": "341 Meeting Details",
  "subtitle": "optional gray text",
  "showWhen": { "field": "outcome", "op": "eq", "value": "Continued" },
  "rows": [
    { "showWhen": { ... },
      "fields": [ { ...field }, { ...field } ] }
  ]
}
```

### 4.2 Repeater section

```json
{
  "repeater": "vehicles",
  "title": "Vehicles",
  "addLabel": "+ Add Vehicle",
  "fields": [ { ...field (subset: text, number, date, select, checkbox) } ]
}
```

Renderer generates the container, `<template>`, add/remove buttons, and the YCForm `repeaters` config. Repeater fields render as one `.yc-row` per item. No masks, no validation, no nesting inside repeaters in v1 (matches current runtime capability).

### 4.3 Field object

```json
{
  "name": "trustee",
  "label": "Trustee",
  "type": "text",
  "width": "2x",
  "sublabel": "optional hint under the input",
  "placeholder": "",
  "readonly": true,
  "lockedMsg": "Set on the case record",
  "apiColumn": "case_trustee",
  "prefill": "{{cases.case_trustee}}",
  "prefillMode": "ifEmpty",
  "mask": "phone",
  "required": true,
  "minLength": 0, "maxLength": 0,
  "pattern": "", "patternMessage": "",
  "email": false,
  "options": ["Continued", "Completed"],
  "allowOther": false,
  "rows": 4,
  "showWhen": { "field": "x", "op": "eq", "value": "y" }
}
```

Only `name` and `type` are required; everything else optional. `name` matches `^[a-zA-Z0-9_]{1,50}$`.

**Name scoping (2.5A A4):** TOP-LEVEL names — standard-section field names **plus repeater keys** (they share the submission data namespace: `collect()` writes `data[repeater]` beside `data[fieldName]`) — are unique form-wide. Repeater FIELD names are unique **within their own repeater** and distinct from every top-level name, but two repeaters may share a row-field name (`collect()`/`populate()` scope repeater lookups to one `.yc-repeater-item`; only form-wide `[name=…]` queries — conditionals, `validate()` — need the top-level guarantee). Rationale: renaming to avoid a cross-repeater duplicate is **data loss** against existing submissions.

**Additional field keys (2.5A):**

| Key | Type | Notes |
|---|---|---|
| `requiredWhen` | condition or condition[] | Conditionally required (A2). Same normalized condition shape as `showWhen` (§4.4); **an array means AND**. Compiled by the renderer into `validation.custom` — `validate()` already passes `collect()` as the second argument, so no runtime change. Use this instead of `required: true` on any field that can be hidden: `validate()` does **not** skip `display:none` fields, so a plain required field inside a hidden section blocks Save with an invisible error. Ignored (with a warn) inside repeaters. |
| `requiredMessage` | string | Error text for a failed `requiredWhen` (default "This field is required"). |
| `columns` | 1 \| 2 \| 3 | Checkgroup only (A5). Emits an inline `grid-template-columns` override (`1fr` for 1, `repeat(N,1fr)` for 2/3), matching casedetails-bk's hand-built pattern. Absent → the stylesheet default (3 columns, collapsing to 1 on mobile). NOTE: an explicit value — including an explicit 3 — is an inline style and therefore also overrides the mobile media query. |
| `note` | string | Documentation only — see §3. |

**Types → rendering → YCForm `fields` type:**

| `type` | Renders | YCForm type | Notes |
|---|---|---|---|
| `text` | `input[type=text]` | `text` | |
| `textarea` | `textarea` | `textarea` | `rows`, `maxlength` (auto counter) |
| `number` | `input[type=number]` | `number` | optional `min`/`max`/`step` |
| `date` | `input[type=date]` | `date` | `_formatForDisplay` normalizes |
| `datetime` | `input[type=datetime-local]` | `text` | auto-detected by `_formatForDisplay` |
| `select` | `select` + placeholder option | `select` | `options` |
| `radio` | `.yc-radio-group` of labels | `radio` | `options` |
| `checkbox` | single checkbox | `checkbox` | |
| `checkgroup` | `.yc-check-grid[data-yc-checkgroup="{name}"]` | `checkgroup` | `options`; `allowOther` adds the `data-yc-other` checkbox + `data-yc-other-text` input + `.yc-other-text` wrapper |
| `tags` | hidden source input | `tags` | yc-forms transforms it |
| `hidden` | `input[type=hidden]` | `text` | for workflow-only values; still collected/submitted |

`options` entries: plain strings (value = label) or `{ "value": "...", "label": "..." }`.

**Element naming:** `name` attribute = field `name`; YCForm `el` selector `[name="{name}"]`, except checkgroup → `[data-yc-checkgroup="{name}"]`.

**Every rendered field includes `<small class="yc-error"></small>`** (locked decision — 341notes lesson).

`width`: `default` | `2x` | `3x` | `fixed-sm` | `fixed-md` → the corresponding `yc-` class.

**Validation derivation:** any of `required`, `minLength`, `maxLength`, `pattern` (string, compiled with `new RegExp`), `patternMessage`, `email`, `mask` present → entry in YCForm `validation`. `mask` also sets `data-yc-mask` on the element.

### 4.4 `showWhen` (sections, rows, fields)

Normalized form: `{ "field": "<name>", "op": "eq"|"neq"|"in"|"notEmpty"|"includes", "value": "x" | ["x","y"] }`.
**An array of conditions means AND** (2.5A). The same normalized condition (single or array) is what `requiredWhen` (§4.3) accepts.

Renderer translation to runtime attrs:

| op | emitted |
|---|---|
| `eq` | `data-yc-show-when="{field}" data-yc-show-value="{value}"` |
| `neq` | `data-yc-show-value="!{value}"` |
| `in` | `data-yc-show-values="a,b,c"` |
| `notEmpty` | `data-yc-show-value="*"` |
| `includes` | `data-yc-show-includes="a,b"` (2.5A) |

`includes` (2.5A A3) requires a **checkgroup** target (enforced in §7): checkgroup member checkboxes carry no `name` attribute, so `_evaluateConditionals` resolves the `[data-yc-checkgroup="{field}"]` container instead and matches when ANY listed value is present in the comma-joined selection (`_getCheckgroup`, incl. the Other free text). This checkgroup fallback is the ONE `yc-forms.js` runtime change in 2.5A.

**AND arrays** (2.5A A3): the renderer puts condition `[0]` on the node itself (single-condition output is byte-identical to pre-2.5) and wraps one `<div class="ycr-and-wrap">` per additional condition — nested `data-yc-show-when` elements compose as AND at runtime (an outer `display:none` hides everything inside). The wrapper is `display: contents` (render.html-local CSS) so `.yc-row`'s flex layout is untouched. Zero runtime change.

Field-level `showWhen` wraps the individual `.yc-field`. Conditions target TOP-LEVEL fields only (repeater keys and repeater fields are not valid targets).

---

## 5. Prefill (Slice 2)

`prefill` is a resolver expression evaluated via the existing `POST /resolve` (`resolverService`). The renderer's generated `onLoad`:

1. Collects all fields with `prefill`.
2. One batched call: `text` = expressions joined with `|||`, `refs` auto-built from linkType:
   `case` → `{ cases: { case_id: linkId } }` · `contact` → `{ contacts: { contact_id: linkId } }` · `appt` → `{ appts: { appt_id: linkId } }`.
3. Splits the result, writes values honoring `prefillMode`: `ifEmpty` (default — the snapshot-guard pattern) or `always`.
4. `resetBaseline()` is handled by the normal init flow (step 13c) — no extra work.

### 5.1 `$load` prefill (2.5A A1)

A `prefill` value beginning with `$load` resolves against the load payload (`form._loadResult` — the full `endpoints.load` response / parent `entityData`) instead of `POST /resolve`:

```
grammar:  $load ( '.' key | '[' field '=' value ']' )+      (validated: ^\$load(\.[A-Za-z0-9_]+|\[[A-Za-z0-9_]+=[^\]]+\])+$)

$load.case.case_trustee
$load.clients[relate_type=Primary].contact_fname
$load.clients[relate_type=Secondary].contact_id
```

- Dot steps are plain property access; `[field=value]` filters an array via `Array.prototype.find` with a **literal** value, compared string-loosely (`String(item[field]) === value`, so numeric ids match). Nested `$load` inside a filter value is OUT of scope (the 341 attorney two-hop stays a hook).
- Any miss (absent key, filter on a non-array, no matching item) → the write is skipped; `"undefined"` is never written. A path that resolves to an object/array is skipped with a warn.
- Writes go through the same helper as resolver prefill, so `prefillMode` (`ifEmpty`/`always`), date/datetime/mask normalization and the pre-`resetBaseline` ordering all apply.
- Runs at the **top** of the generated `onLoad`, before the resolver call — a form using both is deterministic.
- Unlike resolver prefill, `$load` prefill ALSO runs in **preview when a `link_id` is supplied** (the payload is already fetched; no extra request, no write). Without `endpoints.load` there is nothing to read — skipped with a warn.

**Known trap (documented, not fixed):** `prefillMode: "ifEmpty"` runs *after* populate, so a prefill (either kind) on a field that also declares an `apiColumn` is dead code whenever that column is non-empty in live mode — populate fills the field first and ifEmpty then sees a value.

Notes: prefill is for data **outside** the loaded entity (joins, lookups) — with `$load` covering related data already IN the load payload, and `/resolve` covering true lookups. Data on the entity itself flows through `endpoints.load` + `apiColumn` (populate/apiMap) as usual. Prefill is skipped in preview-without-entity mode. **External forms cannot use resolver prefill** (`/resolve` is authed) — portal prefill is a server-side/token concern for the portal build.

---

## 6. Publish flow & schema_version

On `POST /:id/publish`:

1. Structural validation of `draft_definition` (§7) — reject on failure.
2. Compute the **field-set signature** of draft vs current published: sorted list of `(name, type)` across all fields incl. repeater fields. Different signature → `schema_version + 1`. Same signature (label/layout/option tweaks) → unchanged. (Matches the manual's §3.5 bump rule; renames count as remove+add, correctly bumping.)
3. `definition = draft_definition`, set `schema_version`, `published_at = NOW()`.
4. Insert `form_template_versions` row.

Renderer passes the row's `schema_version` into YCForm — draft-recovery version warnings work unchanged.

---

## 7. Structural validation (server-side, on create/update/publish)

Reject with a message naming the offending path:

- `sections` is a non-empty array; each section has `rows` (standard) xor `repeater`+`fields`.
- Every field has valid `name` (regex above) and known `type`.
- **Name scoping (2.5A A4):** top-level field names AND repeater keys unique form-wide (shared data namespace); repeater field names unique within their repeater and distinct from every top-level name — two repeaters MAY share a field name. (This tightens the repeater-key rule — previously unchecked — and relaxes cross-repeater field names; every pre-2.5A published definition satisfies both.)
- `options` present iff type is select/radio/checkgroup.
- Conditions (`showWhen` anywhere, `requiredWhen` on fields): single object or non-empty array (= AND); each `field` references an existing top-level FIELD (repeater keys are not valid targets); `op` in `eq|neq|in|notEmpty|includes`; `includes` requires the target field to be a `checkgroup`.
- `columns`, if present: integer 1–3, checkgroup fields only.
- `prefill` starting with `$load` matches the §5.1 grammar regex. Other prefill strings stay free-form resolver expressions.
- `requiredMessage`, if present, is a string.
- `pattern`, if present, compiles under `new RegExp`.
- `onSubmit.patch` requires at least one field with `apiColumn`.
- `hooks`, if set, matches `^[a-zA-Z0-9_-]{1,50}$` (path traversal guard).
- `note` (form/section/row/field) is explicitly ignored — no validation, no rendering, no signature impact.

---

## 8. Renderer — `public/forms/render.html`

- URL: `render.html?form_key=X&case_id=N` (param name follows the template's `link_type`: `case_id`/`contact_id`/`appt_id`).
- Preview mode (builder): `render.html?template_id=N&preview=1[&link_id=N]` — fetches the row via `GET /api/form-templates/:id` and renders `draft_definition`; without `link_id`, skips `endpoints.load`, drafts/submissions, and prefill (pure layout preview). Preview never writes.
- Emits the required-ID skeleton itself (`toggleBtn`, `toggleLabel`, `saveStatus`, `warning`, `draftBanner`, `draftTimestamp`, `draftRestore`, `draftDiscard`, `saveBtn`) per the `toggle` flag.
- Boot: `waitForParent` loop when internal (`P.apiSend` + `P.entityData`), per the standard iframe boot pattern.
- **All template-sourced strings are written via `textContent` / `setAttribute` — never `innerHTML`.** Templates are staff-authored today but portal-exposed tomorrow; no injection path from day one.
- Derivation summary: DOM from §4; YCForm config = `{ formKey, schemaVersion, linkType, linkId, container, dataMode, autosave, autosaveMs, readonly: toggle, fields, repeaters, validation, endpoints, apiMap (apiColumn→name), onSubmit }` + overridden `_buildPatchPayload` (apiColumn whitelist) + generated `onLoad` (prefill, Slice 2) + optional hook wiring.

---

## 9. Explicitly out of v1 (reserved, don't build)

- **Tabs** — reserved top-level key `tabs: [{ label, sections: [...] }]` as an alternative to `sections`; renderer support later (Detailed Questionnaire territory).
- Collapsible sections; per-repeater-field masks/validation; nested repeaters; repeater min/max enforcement.
- Public/unauthed render route + server-side portal prefill (Slice 4 / portal build).
- Migrating any existing hand-built form.

---

## 10. Slice boundaries against this contract

| Slice | Delivers from this doc |
|---|---|
| 1 | §1 tables, §2 routes, §7 validation, §8 renderer for §3–§4 **minus** repeaters/showWhen/prefill (plain sections/rows/fields, all types except checkgroup-`allowOther` if time-boxed), preview mode |
| 2 | §4.2 repeaters, §4.4 showWhen, §4.3 `allowOther`, §5 prefill, `hooks` wiring |
| 3 | Builder UI editing this JSON; publish UX invoking §6 |
| 2.5A | (delivered 2026-07) §5.1 `$load` prefill; §4.3 `requiredWhen`/`requiredMessage` + checkgroup `columns` + the `note` key; §4.4 `includes` op + AND condition arrays (one yc-forms change: the checkgroup fallback in `_evaluateConditionals`); §7 per-repeater name scoping. 2.5B (optionsFrom, derive, apiColumn load/save split, per-form css) and tabs (2.6) are separate; `embed`/css/external mode wait for the portal security review. |
| 4 | Admin list + history viewer + submissions browser (delivered 2026-07). **External render mode: DEFERRED out of Slice 4 to the client-portal build** — unauthed endpoints need the portal token design, and building it twice was the wrong trade. Every template route remains authed; §5's external-prefill note and §9's reservation stand. Decision recorded in the build state (`rw_scratch ns=fred k=formbuilder_build_state`). |