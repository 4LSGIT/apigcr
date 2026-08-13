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

**X1 (2026-08-11, ref/EXTERNAL_FORMS_DESIGN.md §3):** `visibility ENUM('internal','portal','public') NOT NULL DEFAULT 'internal'` added (`ref/2026-08-11_form_templates_visibility.sql`). Policy lives in this COLUMN, not the definition JSON — external routes serve the PUBLISHED definition only, and only when visibility permits; `internal` serves nothing externally. Flipping is an explicit act (its own route below), refused off-`internal` while the published definition carries `code`, `css`, `hooks`, or an `embed` field (§4-of-the-external-doc refusal invariant — refuse, never strip).

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
                                                (+ external_refusals: string[] advisory, X1 — present only
                                                when the row is externally visible AND the just-published
                                                definition carries refused keys; publish never blocks on it)
POST   /api/form-templates/:id/visibility     — X1: { visibility: 'internal'|'portal'|'public' }.
                                                Refused (400, keys named) off-internal while the PUBLISHED
                                                definition carries code/css/hooks/embed; back-to-internal
                                                always allowed; never-published templates may hold any value
                                                (nothing serves until publish; X2 re-scans per request).
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
| `hooks` | string or null | Names a repo file `/forms/hooks/{hooks}.js`. If set, renderer loads it via `<script>`; the file may define `window.ycHooks = { onLoad(form, data), onSave(form, result) }`, called at the same points hand-built forms use them. Since 2.6 the repo-hook boundary is **SHARED code** (`_yc_hook_util.js`, multi-form reuse, anything wanted in git); per-form logic defaults to the `code` key below. **Mutually exclusive with `code`.** |
| `code` | string, optional | **(2.6)** Per-form JavaScript stored in the definition itself. ≤ 32,768 chars; syntax-checked at validation via `new Function(code)` (parsed, never executed server-side); **mutually exclusive with `hooks`**. The renderer executes it synchronously (`new Function(code)()` in try/catch) at exactly the point the hooks file would load — before `init()`, same boot-branch structure — so it may define `window.ycHooks = { onLoad, onSave }` with the standard interface, wired identically to file hooks; broken code warns and degrades, never aborts init. (Direct call rather than an injected `<script>` element: appended-script execution is task-queue-scheduled and its ordering vs init's await chain is environment-dependent; the direct call is strictly before init everywhere.) **NEVER executed in preview** (any preview mode). Security posture: see §8/§9 — DB-stored `code` and `css` execute on INTERNAL surfaces only; any future external/portal render route MUST REFUSE (never strip) templates carrying `code`, `css`, or `hooks`, pending the portal security review. |
| `note` | string, optional | **Documentation only, explicitly ignored** (2.5A). Valid at form, section, row, and field level. Never rendered, never validated beyond being ignored, never part of the schema signature (§6 hashes `(name, type)` only). The migration ports use it to record why a field exists. |
| `derive` | rule[], optional | **(2.5B B2)** Date suggestions from a fixed verb registry — no expressions, no eval. Each rule: `{ "target": "case_180", "from": "case_file_date", "op": "addDays", "n": 180 }`. Verbs: `addDays` (date + N days; `n` REQUIRED, may be negative) and `dateFromDatetime` (date part of a `datetime` value ± N days; `n` optional, absent = pure extraction). Semantics — the casedetails-bk lessons, now contract: (1) fill **only when the target is empty**, inside the generated `onLoad`, i.e. BEFORE init 13c's `resetBaseline` — later than that and the form reports dirty forever on a form nobody touched, which also blocks versionGuard's forced reload; (2) a derived value the user never edits is not in `getDiff()` and is **not persisted** — it is a deterministic function of its source, recomputed on every load; (3) a USER `change` of the source recomputes the target **unconditionally** (including clearing it when the source is cleared) — fill-only-empty is a LOAD-time rule; on live change the suggestion follows the source (this is the hand-built listener's exact behaviour). One rule per target; `target`/`from` must name existing top-level FIELDS (`target ≠ from`). Local + deterministic → active in preview too. |
| `css` | string, optional | **(2.5B B4)** Per-form CSS, injected by the renderer as a `<style>` element via `textContent` (never innerHTML) appended to `<head>` AFTER the shared stylesheet — wins ties at equal specificity. `textContent` means the string can only ever be CSS text — no element/script injection path (§8). **INTERNAL-ONLY pending the portal security review**: CSS on an untrusted rendering surface is a lower-grade but real injection channel (exfiltration selectors, UI redress) — same review bucket as `type:"embed"` and external mode (§9). |
| `external` | object, optional | **(X1/X3/X3.3, EXTERNAL_FORMS_DESIGN §6)** External-surface behavior — validated whenever present regardless of the row's visibility; ignored by internal rendering entirely. Exact-key enforced: only `badLink` and `postSubmit` allowed. **`badLink`** (X1): `"reject"` (default when absent — the standing Unauthorized-Link error page on an invalid/missing `case_id`) or `"degrade"` (intake's mode: anonymous mode — form works, submission lands unlinked, RG alert fires). Server-only, never on the wire. **`postSubmit`** (X3, Fred-ratified 2026-08-12; `redirect`/`redirectBack` X3.3, Fred-ratified 2026-08-13): the renderer's terminal state after a successful external submit — absent = pre-X3 behavior (success toast, form stays editable), byte-identical. Keys, exact-key enforced: `message` (string ≤2000; the thank-you panel text, textContent-rendered, empty/absent = default copy), `edit` (bool; "Edit response" button restoring the filled form), `new` (bool; "Submit another response" button reloading the same URL → same credential/urlParam prefill), `redirect` (string ≤2000; navigate instead of the panel — **supersedes** `message`/`edit`/`new`, which are ignored when it is set; must be a same-origin path (`"/…"`, not `//`-relative, no backslash) or an absolute `https://` URL; landing pages `/p/:slug` are the intended target — chrome lives in the pages system, never in form definitions), `redirectBack` (bool; appends the submitter's current URL as `?b=…` so the landing page can offer an "Edit your response" link — the top frame's URL when readable, so a `/p/form`-framed visitor gets the branded URL back). **`redirectBack` is refused unless `redirect` is a same-origin path**: the back-link carries the 40-bit case credential and must never ride to an off-origin target's logs/analytics. Enforced in `validateDefinition` AND re-guarded in the renderer. `b` is a reserved `urlParam` name for the same reason. The renderer navigates the top frame when the frame chain is same-origin (the `/p/form` host page leaves with the form), and navigates in-frame when the parent is cross-origin (deterministic — cross-origin top navigation can be silently blocked). |

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

**Additional field keys (X2, 2026-08-11):**

| Key | Type | Notes |
|---|---|---|
| `urlParam` | string | **(X2, Fred-ratified)** Names a URL query param that prefills this field (`?src=facebook`) — tracking, website iframe embeds, quick backup prefill. Empty/absent = not allowed (the default). Applied through the same write helper as every prefill, AFTER server/`$load`/resolver prefill and honoring `prefillMode` (`ifEmpty` default — server data wins, params fill gaps; declare `always` for param-wins). Repeated params in one URL: the **last** one wins (deliberate `getAll().pop()`; native `.get()` returns the first). Select/radio values matching no option silently don't stick. Works in internal AND external render modes. Rules (§7): token shape `^[a-zA-Z0-9_-]{1,50}$`, unique form-wide, never a reserved route/renderer param (`form_key ext preview template_id link_id case_id contact_id appt_id`), top-level fields only (not repeaters), not on embeds. Anyone can set a URL param — never a channel for sensitive or trusted values. |

**Additional field keys (2.5B):**

| Key | Type | Notes |
|---|---|---|
| `apiColumn` | string **or** `{ load?, save? }` | **(B3)** A plain string keeps meaning BOTH directions (unchanged since Slice 1). The object form maps each direction independently: `load` feeds populate (apiMap / `_mergeApiData`); `save` feeds the PATCH whitelist. At least one key required; each a non-empty string. **Save-only** (`{ "save": "col" }`) = the column never pre-fills the form — this reverts the migration's 341 behaviour change (snapshot forms whose columns must not pre-fill). **Load-only** = displayed but never PATCHed. Scope is **one column per direction** — multi-column writes (the BK docket split) and value transforms stay hooks; that is the honest boundary. `onSubmit.patch` requires at least one field with a SAVE-direction column. CAVEAT: a save-only column only prevents pre-fill when the field NAME differs from an entity column name — `_mergeApiData` passes unmapped entity keys through under their own names, so a field literally named after a column still populates via that identity path. |
| `optionsFrom` | object | **(B1)** Select only. Rebuilds the options at load time from live data: `{ "source": "firmData.settings.trustees", "value": "name", "label": "name", "groupBy": "case_type", "groupLabels": { "7": "Chapter 7" } }`. `source` is whitelisted to two prefixes: `firmData.<dot-path>` (walked off the relayed `window.parent.firmData` — case.html, contact.html, formBuilder and liveHost all relay it) and `$load.<path>` (the load payload, sharing §5.1's grammar and resolver — covers "dropdown of this contact's cases"). Must resolve to a non-empty array of objects; `value` names the item key holding the option value, `label` (optional) the display key, `groupBy` (optional) emits `<optgroup>` per distinct value in first-seen source order, `groupLabels` (optional, session extension) maps raw group values to display text (unmapped groups show the raw value). Rebuild runs in the generated `onLoad` AFTER populate/prefill; the field's current value is captured first and re-applied after — **a stored value not in the list is injected as a flagged option** (`⚠ … (not in list)`, `data-unlisted="1"`) so legacy data is never silently dropped on save (the casedetails-bk behaviour, preserved not reinvented). Unreachable/empty source → the static `options` (still REQUIRED — they are the guaranteed fallback) stay in place with a console warn; the control is never blanked. Active in preview ($load-sourced falls back without a loaded payload). |

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
| `embed` | `.yc-field` + `<iframe>` | — (not registered) | **(2.6, INTERNAL-ONLY)** Display-only https iframe. `src` required (https-only URL, ≤ 2000 chars); `height` optional positive integer px (default 600). NOT an input: no `.yc-error`, not registered in `fields`/`validation`/`apiMap`, excluded from `collect()`/diff/PATCH (exclusion = simply not registering — `collect()` walks `config.fields`). The iframe carries `src`, `loading="lazy"`, `title` (label \|\| name), `data-yc-embed="{name}"` (a stable per-form-code selector hook), and `style="width:100%;height:{h}px;border:none;"` with `h` parseInt-coerced. `showWhen` IS allowed (the wrapper hides it like any field). Rejected on an embed: `required`, `apiColumn`, `prefill`, `mask`, `options`, `optionsFrom`, `derive` (as target or source), `readonly`, `requiredWhen`; embed inside a repeater is rejected; conditions may not target an embed (it has no value). Excluded from the §6 field-set signature (no data; adding/removing one is a layout change). External exposure stays in the §9 portal-review bucket. |

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

### 4.5 Tabs & sticky regions (2.6)

Top level: **exactly one of** `sections` | `tabs`.

```json
{
  "tabs": [
    { "label": "Client Info", "sections": [ /* ordinary section objects */ ] }
  ],
  "stickyTop":    [ /* sections rendered BEFORE the tab container */ ],
  "stickyBottom": [ /* sections rendered AFTER it */ ]
}
```

Rules (enforced in §7):

- `tabs`: non-empty array. Each tab: **exactly** the keys `label` (non-empty string, ≤ 60 chars) and `sections` (non-empty array of ordinary section objects — repeater sections legal). Unknown keys on a tab object are rejected.
- `stickyTop` / `stickyBottom`: optional arrays of ordinary section objects; legal ONLY when `tabs` is present. (Empty arrays are tolerated by the validator; the builder never serializes them.)
- **Field-name scoping is unchanged**: form-wide across stickies + all tabs (+ the per-repeater rules from 2.5A) — one namespace pool, exactly as `sections` is treated today. `showWhen` / `requiredWhen` / `prefill` / `derive` / `optionsFrom` work unchanged inside tab panels, and conditions may reference fields on OTHER tabs (the conditional engine queries `[name=…]` form-wide).
- First tab renders active. No tab-level `showWhen` (out of scope). No nested tabs.

Renderer markup (issn.html classes; zero `yc-forms.js` / `yc-forms.css` changes — `setupTabs` and the `.yc-tabs/.yc-tab-bar/.yc-tab-panel/.yc-tab-sticky` styles already exist):

- One `<div class="yc-tab-sticky">` per non-empty sticky region, wrapping that region's sections, before/after the tab container.
- `<div class="yc-tabs">` containing `<div class="yc-tab-bar">` with one `<button type="button">` per tab (label via `textContent`, first gets class `active`) and one `<div class="yc-tab-panel">` per tab (first gets `active`). Panels are index-matched to bar buttons; everything renders INSIDE the form element (`setupTabs` and the conditional engine scope to `this.el`).
- After `init()` resolves, the renderer calls `form.setupTabs('.yc-tab-bar', '.yc-tab-panel')` and registers the **tab-reveal** listener: a second `#saveBtn` click listener (yc-forms binds its own in init step 1, so this one runs second; `validate()` runs synchronously before `save()`'s first await) that finds the first `.yc-error.visible` in DOM order, activates its `.yc-tab-panel` when inactive, and scrolls the `.yc-field` into view. Errors in sticky regions are always visible — scroll only. Known non-fix: an error inside a showWhen-hidden wrapper on the ACTIVE tab (A7-lint territory).

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

**Known trap (documented; 2.5B provides the cure):** `prefillMode: "ifEmpty"` runs *after* populate, so a prefill (either kind) on a field that also declares a LOAD-direction `apiColumn` is dead code whenever that column is non-empty in live mode — populate fills the field first and ifEmpty then sees a value. When this is the INTENT (a fallback: "show the full docket, fall back to the short one"), it composes correctly. When it isn't, use the 2.5B `apiColumn: { "save": "col" }` form — a save-only column never populates, so the prefill owns the load path.

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

- **Containers (2.6):** exactly one of `sections` | `tabs`. `sections` is a non-empty array. `tabs` is a non-empty array of `{ label, sections }` objects (exact keys; `label` non-empty string ≤ 60 chars; `sections` non-empty). `stickyTop`/`stickyBottom` are arrays of sections, legal only with `tabs`. Every container's sections pass the SAME per-section validation (one code path); name scoping, condition/derive/optionsFrom target checks, and the `onSubmit.patch` save-column requirement treat all containers as one pool.
- Each section has `rows` (standard) xor `repeater`+`fields`.
- `embed` fields (2.6, internal-only): `src` required — parses under `new URL` with protocol exactly `https:`, ≤ 2000 chars; `height` optional positive integer. Rejected on an embed: `required`, `apiColumn`, `prefill`, `mask`, `options`, `optionsFrom`, `readonly`, `requiredWhen`; embed inside a repeater; a `derive` rule whose `target` or `from` is an embed; a condition (`showWhen`/`requiredWhen` anywhere) targeting an embed. `showWhen` ON an embed is allowed. Embeds are excluded from the §6 field-set signature.
- `code` (2.6 addendum): string ≤ 32,768 chars; syntax-checked via `new Function(code)` in try/catch (parses, never executes; rejected with the parse error message). **`code` and `hooks` may not both be set.**
- Every field has valid `name` (regex above) and known `type`.
- **Name scoping (2.5A A4):** top-level field names AND repeater keys unique form-wide (shared data namespace); repeater field names unique within their repeater and distinct from every top-level name — two repeaters MAY share a field name. (This tightens the repeater-key rule — previously unchecked — and relaxes cross-repeater field names; every pre-2.5A published definition satisfies both.)
- `options` present iff type is select/radio/checkgroup.
- Conditions (`showWhen` anywhere, `requiredWhen` on fields): single object or non-empty array (= AND); each `field` references an existing top-level FIELD (repeater keys are not valid targets); `op` in `eq|neq|in|notEmpty|includes`; `includes` requires the target field to be a `checkgroup`.
- `columns`, if present: integer 1–3, checkgroup fields only.
- `prefill` starting with `$load` matches the §5.1 grammar regex. Other prefill strings stay free-form resolver expressions.
- `apiColumn` (2.5B): non-empty string, or `{ load?, save? }` with at least one key, each a non-empty string.
- `optionsFrom` (2.5B): select fields only; object with `source` (a `firmData.<dot-path>` — `^firmData(\.[A-Za-z0-9_]+)+$` — or a §5.1 `$load` expression), required non-empty `value`; optional non-empty `label`/`groupBy` strings; optional `groupLabels` object of string values. Static `options` remain required (the fallback).
- `derive` (2.5B): non-empty array of `{ target, from, op, n? }`; `op` in `addDays|dateFromDatetime`; `target`/`from` reference existing top-level FIELDS (repeater keys are not valid), `target ≠ from`, one rule per target; `n` is a required integer for `addDays`, optional integer for `dateFromDatetime`.
- `css` (2.5B): string.
- `requiredMessage`, if present, is a string.
- `pattern`, if present, compiles under `new RegExp`.
- `onSubmit.patch` requires at least one field with a SAVE-direction `apiColumn` (a plain string, or an object carrying `save` — load-only columns don't count).
- `hooks`, if set, matches `^[a-zA-Z0-9_-]{1,50}$` (path traversal guard).
- `external` (X1/X3/X3.3): object with only the keys `badLink` and `postSubmit`. `badLink`, if present, is `reject` or `degrade`. `postSubmit`, if present, is an object with only the keys `message` (string ≤2000), `edit`/`new`/`redirectBack` (booleans), `redirect` (non-empty string ≤2000, same-origin path or absolute `https://` URL); `redirectBack: true` requires `redirect` to be a same-origin path (the `?b=` back-link carries the case credential).
- `pattern` (X2.1): on non-internal templates, patterns are only applied to inputs of 512 chars or fewer — longer values fail the pattern without being run through the regex (ReDoS containment; staff-authored patterns can backtrack catastrophically).
- `urlParam` (X2): string matching `^[a-zA-Z0-9_-]{1,50}$`; not a reserved param; unique form-wide; top-level fields only; rejected on embeds and inside repeaters.
- `note` (form/section/row/field) is explicitly ignored — no validation, no rendering, no signature impact.

---

## 8. Renderer — `public/forms/render.html`

- URL: `render.html?form_key=X&case_id=N` (param name follows the template's `link_type`: `case_id`/`contact_id`/`appt_id`).
- Preview mode (builder): `render.html?template_id=N&preview=1[&link_id=N]` — fetches the row via `GET /api/form-templates/:id` and renders `draft_definition`; without `link_id`, skips `endpoints.load`, drafts/submissions, and prefill (pure layout preview). Preview never writes.
- Emits the required-ID skeleton itself (`toggleBtn`, `toggleLabel`, `saveStatus`, `warning`, `draftBanner`, `draftTimestamp`, `draftRestore`, `draftDiscard`, `saveBtn`) per the `toggle` flag.
- Boot: `waitForParent` loop when internal (`P.apiSend` + `P.entityData`), per the standard iframe boot pattern.
- **All template-sourced DATA strings are written via `textContent` / `setAttribute` — never `innerHTML`.** This rule governs untrusted *data* (labels, options, values) and is unchanged by 2.6. Authored code is governed separately (below).
- **Reformulated code invariant (2.6, supersedes "no browser-executed JS stored in the DB"):** DB-stored `code` and `css` execute on INTERNAL surfaces only. Any future external/portal render route **MUST REFUSE (never strip)** templates carrying `code`, `css`, or `hooks`, pending the portal security review — this external-refusal gate is a NAMED REQUIREMENT of that route. Preview never executes `code`. Template publish is superuser-gated (`superuserOnlyFor('form_templates')` on POST `/:id/publish`), so code authorship = superusers; drafts stay staff-editable.
- Tabs mode (2.6): §4.5 markup + `setupTabs` wiring in both boot branches (hooks/code and plain) + the tab-reveal saveBtn listener.
- Derivation summary: DOM from §4; YCForm config = `{ formKey, schemaVersion, linkType, linkId, container, dataMode, autosave, autosaveMs, readonly: toggle, fields, repeaters, validation, endpoints, apiMap (apiColumn→name), onSubmit }` + overridden `_buildPatchPayload` (apiColumn whitelist) + generated `onLoad` (prefill, Slice 2) + optional hook wiring.

---

## 9. Explicitly out / security buckets

- ~~Tabs reserved~~ — **DELIVERED in 2.6** (§4.5). Nested tabs and tab-level `showWhen` remain out.
- `type: "embed"` — **BUILT in 2.6, INTERNAL-ONLY** (the `css`-key precedent: an https-only URL stored in the DB is a URL, not code). External exposure of embed remains in the portal-review bucket below.
- Collapsible sections; per-repeater-field masks/validation; nested repeaters; repeater min/max enforcement.
- Public/unauthed render route + server-side portal prefill (client-portal build).
- **Portal security review bucket** (nothing here ships to external rendering before that review): the `code` key, the 2.5B `css` key, `hooks`, external embed exposure, and external/portal render mode itself. The future external route MUST REFUSE (never strip) templates carrying `code`, `css`, or `hooks` (§8). `code`/`css`/embed are live for INTERNAL forms only.
- Multi-column / value-transforming `apiColumn` — per-form `code` (or a hook file for shared logic) is the boundary (see §4.3 B3).
- `showWhen` inside repeaters (runtime cannot scope a condition to one row — 2.7 candidate); second-entity writes on save (that's a workflow, not a schema feature — the issn contact write-back stays client-side `code` pending that decision).
- Migrating any existing hand-built PAGE (cutover is a separate act; the 2.6 hook migration moved hook FILES to `code`, not pages).

---

## 10. Slice boundaries against this contract

| Slice | Delivers from this doc |
|---|---|
| 1 | §1 tables, §2 routes, §7 validation, §8 renderer for §3–§4 **minus** repeaters/showWhen/prefill (plain sections/rows/fields, all types except checkgroup-`allowOther` if time-boxed), preview mode |
| 2 | §4.2 repeaters, §4.4 showWhen, §4.3 `allowOther`, §5 prefill, `hooks` wiring |
| 3 | Builder UI editing this JSON; publish UX invoking §6 |
| 2.5A | (delivered 2026-07) §5.1 `$load` prefill; §4.3 `requiredWhen`/`requiredMessage` + checkgroup `columns` + the `note` key; §4.4 `includes` op + AND condition arrays (one yc-forms change: the checkgroup fallback in `_evaluateConditionals`); §7 per-repeater name scoping. |
| 2.5B | (delivered 2026-07) §4.3 `optionsFrom` (firmData.* AND $load.* sources, groupBy/groupLabels, flagged unlisted value, static-options fallback) + `apiColumn` `{load, save}` split; §3 `derive` (addDays/dateFromDatetime, fill-only-empty in onLoad, unconditional recompute on source change) + `css` (textContent-injected, internal-only pending portal review); B0 firmData relay in formBuilder + liveHost. ZERO yc-forms.js changes. Tabs = 2.6; `embed`/`css`-external/portal mode = the §9 portal-review bucket. |
| 4 | Admin list + history viewer + submissions browser (delivered 2026-07). **External render mode: DEFERRED out of Slice 4 to the client-portal build** — unauthed endpoints need the portal token design, and building it twice was the wrong trade. Every template route remains authed; §5's external-prefill note and §9's reservation stand. Decision recorded in the build state (`rw_scratch ns=fred k=formbuilder_build_state`). |
| 2.6 | (delivered 2026-08) §4.5 tabs/stickyTop/stickyBottom (exactly-one-of `sections`\|`tabs`; issn.html markup classes; `setupTabs` wiring + tab-reveal-on-validation-failure listener; ZERO yc-forms.js/yc-forms.css changes); §4.3 `type:"embed"` (https-only iframe, internal-only, display-only, excluded from collect/PATCH and the field-set signature); §3 `code` key (per-form DB-stored JS, ≤32KB, syntax-checked, mutually exclusive with `hooks`, never in preview) under the REFORMULATED §8 invariant — the old "no browser-executed JS stored in the DB" rule is retired for internal surfaces (workflow `custom_code` precedent; publish SU-gated); **full hook-file migration**: `notes_341` / `case_details_bk2` / `issn_extras` ported to `code`, per-form hook files deleted, `_yc_hook_util.js` + readme kept (repo hooks = SHARED code, `code` = per-form default); issn (tpl 7) draft rebuilt on tabs + 2.5A/B declarative features. Builder: flat internal model + layout tags (region/tabIndex) + TABS_META, tab strip, Move-to menu for cross-container moves, sticky pseudo-groups, tabbed-layout toggle, embed + custom-code editors. `fieldSignature` extended across all containers (embeds excluded). || X1–X3.2 | (delivered 2026-08) External-forms arc entries in THIS doc: `visibility` column + flip route (X1); `urlParam` field key + reserved-name list (X2); `external.badLink` (X1) and `external.postSubmit` `{message, edit, new}` (X3 — retroactively recorded here 2026-08-13; the amendment originally landed only in code + manual ch.15). Full arc record: `ref/EXTERNAL_FORMS_DESIGN.md`, `ref/X2_DESIGN_AMENDMENTS.md`, scratch `external_arc`. |
| X3.3 | (2026-08-13, Fred-ratified) `external.postSubmit.redirect` + `redirectBack`: navigate to a landing page after external submit instead of the panel (redirect supersedes `message`/`edit`/`new`). Same-origin-path or absolute-https targets; `redirectBack` (append `?b=<current URL>` for the landing page's Edit link) refused off a same-origin path — the back-link is the case credential. `b` added to `URL_PARAM_RESERVED`. Builder: new **External rendering** group in Form settings (badLink select + full postSubmit editor — these keys previously existed only in JSON). |