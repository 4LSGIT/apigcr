# Part 13 — The Template System (YisraForm Templates)

Parts 1–12 describe hand-built forms: a standalone HTML file per form with a `YCForm` config block. The template system sits **on top of** that runtime — a form is a JSON `definition` stored in the database, and one generic renderer (`public/forms/render.html`) turns it into a working `YCForm` at load time. No per-form code, no deploy to change a form.

The five hand-built forms (`contact-form`, `issn`, `341notes`, `casedetails`, `casedetails-bk`) are untouched and keep working exactly as documented in the earlier parts. The template system is for **new** forms.

**Governing contract:** `ref/FORM_TEMPLATE_SCHEMA_V1.md` — the authoritative spec for the definition JSON, validation rules, and publish semantics. This chapter is the working-knowledge version.

---

## The Pieces

| Piece | File / table | Purpose |
|-------|--------------|---------|
| Templates table | `form_templates` | One row per `form_key`; holds the published definition AND the working draft |
| Version history | `form_template_versions` | Append-only — one row per publish |
| API | `routes/api.formTemplates.js` + `services/formTemplateService.js` | CRUD, publish, version history, restore |
| Renderer | `public/forms/render.html` | Turns a definition into a live YCForm |
| Builder | `public/formBuilder.html` | Visual editor for definitions — see [14-form-builder.md](14-form-builder.md) |
| Submissions | `form_submissions` (unchanged) | Templated forms save drafts/submissions exactly like hand-built ones |

---

## Template vs Draft vs Published

Each template row carries **two** definition columns:

- **`definition`** — the **published** definition. This is what `render.html` serves to real forms. `NULL` means the template has never been published and no live form exists for it yet.
- **`draft_definition`** — the **working copy** the builder edits. Saving in the builder writes here; nothing users see changes.

Editing is therefore always safe: the live form keeps rendering the published definition until you explicitly **Publish**, which copies draft → published in one step. There is no "half-saved" state visible to users.

`form_key`, `title`, and `link_type` live on the row, not inside the JSON — the row is the single source of truth for identity. `form_key` is renameable only while the template has **never been published and has no submissions**; after that it is permanent (render URLs and submission rows reference it).

---

## Schema Versions

`schema_version` tracks the published definition and exists for one reason: **draft recovery warnings** (Part 7). Every draft and submission records the schema version it was written against; when a recovered draft predates the current schema, the user sees a version warning.

On publish, the server compares the **field set** — the sorted list of `(name, type)` pairs across all fields, including repeater fields — between the draft and the currently published definition:

- Field set changed (field added, removed, renamed, or retyped) → `schema_version` bumps.
- Only labels, layout, options, validation, or behavior changed → version stays.

A rename counts as remove + add, so it correctly bumps. You never set the version by hand; the publish flow decides.

Every publish — bumped or not — appends a row to `form_template_versions`. The builder's History tab labels same-field-set republishes "no schema change" so the list stays honest about which publishes actually moved the schema.

---

## The Definition JSON (working level)

The full grammar is contract §3–§4. The shape:

```json
{
  "dataMode": "live",
  "toggle": true,
  "endpoints": { "load": { "method": "GET", "url": "/api/cases/{linkId}", "path": "case" } },
  "onSubmit": {
    "patch":    { "method": "PATCH", "url": "/api/cases/{linkId}" },
    "workflow": { "id": 7, "initData": { "source": "templated_form" } }
  },
  "hooks": null,
  "sections": [
    { "title": "Details", "rows": [ { "fields": [ { "name": "trustee", "type": "text", "label": "Trustee", "apiColumn": "case_trustee" } ] } ] },
    { "repeater": "vehicles", "title": "Vehicles", "addLabel": "+ Add Vehicle",
      "fields": [ { "name": "veh_desc", "type": "text", "label": "Description" } ] }
  ]
}
```

Top-level keys mirror the YCForm config options from Part 3 (`dataMode`, `autosave`, `toggle`, `warningText`, `saveLabel`). Sections contain rows of fields, or are repeaters (contract §4.2 — repeater fields are limited to `text`, `number`, `date`, `select`, `checkbox`, with no masks/validation/conditions inside). `showWhen` conditions on sections, rows, and fields compile to the same `data-yc-show-*` attributes Part 9 documents.

Everything is validated server-side on save and publish (contract §7) — a structurally broken definition never reaches the renderer.

---

## apiColumn — the dual role

`apiColumn` on a field names a database column on the linked entity (`cases`, `contacts`, `appts`) and does two jobs at once:

1. **Load** (live mode): the field populates from that column of the loaded entity (`apiMap`).
2. **Save**: the entity PATCH payload is an explicit whitelist — **changed fields that declare `apiColumn`**, excluding `readonly` fields. A field without `apiColumn` never touches the entity; its value lives only in the submission JSON.

In snapshot mode the load half doesn't apply (values load from the latest submission), but the save half still does. This whitelist is deliberately narrower than the default `_buildPatchPayload` — the renderer overrides it.

---

## Prefill

For data **outside** the loaded entity (joins, lookups), a field can carry a `prefill` resolver expression, e.g. `{{cases.case_trustee}}` or `{{cases.case_number_full|default:no docket on file}}`. The renderer batches every prefill expression into one `POST /resolve` call on load and writes the results honoring `prefillMode`:

- `ifEmpty` (default) — fill only when the field is empty.
- `always` — overwrite on every load.

Data that lives on the entity itself should use `apiColumn`, not prefill. Prefill (and hooks) never run in the builder's Preview.

---

## Custom Logic — where it goes

**Executable code is never stored in the database.** The routing rule:

| Need | Mechanism |
|------|-----------|
| Do something server-side after save | `onSubmit.workflow` → YisraFlow workflow (custom_code steps run in the server VM) |
| Compute/fetch values on load | `prefill` resolver expressions |
| Client-side DOM behavior on this form | Repo hook file — `hooks: "myform"` names `/forms/hooks/myform.js`, which may define `window.ycHooks = { onLoad(form, data), onSave(form, result) }` |

Hook files live in the repo, get code review, and are loaded by name only (the name is validated against `^[a-zA-Z0-9_-]{1,50}$` — no paths). See `public/forms/hooks/README.md` for the interface.

---

## Template API

All `jwtOrApiKey`, envelope `{ status: 'success', ... }`. Service errors carry `.status` and map to real 400/404 responses.

```
GET    /api/form-templates                    — list (summary columns)
GET    /api/form-templates/:id                — full row (draft + published definitions)
POST   /api/form-templates                    — create { form_key, title, link_type, draft_definition }
PUT    /api/form-templates/:id                — update { title?, draft_definition?, form_key? }
POST   /api/form-templates/:id/publish        — publish; returns { schema_version, bumped }
DELETE /api/form-templates/:id                — never-published AND no-submissions only
GET    /api/form-templates/render/:form_key   — published projection render.html consumes (404 if unpublished)

GET    /api/form-templates/:id/versions             — publish history; each row carries a computed
                                                      schema_changed flag (vs the previous publish).
                                                      No definition bodies in the list.
GET    /api/form-templates/:id/versions/:versionId  — one version row incl. definition
POST   /api/form-templates/:id/versions/:versionId/restore
                                                    — copy that version's definition into
                                                      draft_definition (published untouched)
```

**Restore** is draft-only: the published form keeps serving whatever is published until you re-publish the restored draft. The restored definition is not re-validated on restore — it passed validation when originally published, and save/publish re-validate anyway.

Submissions browsing (`GET /api/forms/submissions[...]`) is in [11-api-reference.md](11-api-reference.md).

---

## Rendering a Templated Form

A published template renders at:

```
/forms/render.html?form_key=my_form&case_id=rIxpyvYG
```

The id param name follows the template's `link_type` (`case_id` / `contact_id` / `appt_id`). Host it in an iframe exactly like a hand-built form (Part 10) — the renderer uses the same `waitForParent`/`P.apiSend` boot pattern and the same parent-as-data-source flow. For a standalone browser tab, `/forms/liveHost.html?form_key=...&case_id=...` supplies the parent frame the renderer needs.

External/portal (unauthenticated) rendering is **deferred to the client-portal build** — every template route requires auth today.