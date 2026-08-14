# Part 11 — API Reference

All endpoints in `routes/api.forms.js`, delegating to `services/formService.js`. All require `jwtOrApiKey` auth.

---

## GET /api/forms/latest

Fetch the latest submission and current draft for a form + entity.

**Query params:** `form_key`, `link_type`, `link_id` (all required)

**Response:**
```json
{
  "status": "success",
  "submitted": {
    "id": 42, "version": 3, "schema_version": 1,
    "data": { "fname": "Fred", "phone": "3135551234" },
    "updated_at": "2026-04-07T15:30:00.000Z",
    "submitted_by": 2, "user_name": "Stuart Sandweiss"
  },
  "draft": {
    "id": 43, "schema_version": 1,
    "data": { "fname": "Frederick", "phone": "3135551234" },
    "updated_at": "2026-04-07T16:02:15.000Z",
    "submitted_by": 2, "user_name": "Stuart Sandweiss"
  }
}
```

Either field can be `null`.

**Console test:**
```js
await apiSend("/api/forms/latest?form_key=contact_info&link_type=contact&link_id=1001", "GET");
```

---

## POST /api/forms/draft

Upsert a draft. Called by autosave.

**Body:** `form_key`, `link_type`, `link_id`, `data` (required). `schema_version` (optional, default 1).

**Response:**
```json
{ "status": "success", "id": 43, "updated_at": "2026-04-07T16:02:15.000Z" }
```

Uses `INSERT ... ON DUPLICATE KEY UPDATE` on the `draft_key` unique index — no race conditions.

**Console test:**
```js
await apiSend("/api/forms/draft", "POST", {
  form_key: "contact_info", link_type: "contact", link_id: "1001",
  schema_version: 1, data: { fname: "Fred" }
});
```

---

## POST /api/forms/submit

Record an explicit submission. Called on Save.

**Body:** Same as `/draft`.

**Response:**
```json
{ "status": "success", "id": 44, "version": 4, "updated_at": "2026-04-07T16:05:00.000Z" }
```

`version` auto-increments per form+entity (1, 2, 3...). Drafts are always version 0.

**Console test:**
```js
await apiSend("/api/forms/submit", "POST", {
  form_key: "contact_info", link_type: "contact", link_id: "1001",
  schema_version: 1, data: { fname: "Frederick" }
});
```

---

## DELETE /api/forms/draft

Delete a draft (user clicked "Discard").

**Query params:** `form_key`, `link_type`, `link_id` (all required)

**Response:**
```json
{ "status": "success", "deleted": true }
```

Returns `"deleted": false` if no draft existed.

**Console test:**
```js
await apiSend("/api/forms/draft?form_key=contact_info&link_type=contact&link_id=1001", "DELETE");
```

---

## GET /api/forms/history

Submission history, newest first.

**Query params:** `form_key`, `link_type`, `link_id` (required). `limit` (optional, default 10, max 50).

**Response:**
```json
{
  "status": "success",
  "submissions": [
    { "id": 44, "version": 4, "schema_version": 1, "data": {...}, "updated_at": "...", "submitted_by": 2, "user_name": "Stuart" },
    { "id": 42, "version": 3, "schema_version": 1, "data": {...}, "updated_at": "...", "submitted_by": 1, "user_name": "Fred" }
  ]
}
```

**Console test:**
```js
await apiSend("/api/forms/history?form_key=contact_info&link_type=contact&link_id=1001&limit=5", "GET");
```

---

## GET /api/forms/submissions

Admin browse over `form_submissions` — summary columns only, no `data` bodies. Added for the Form Builder's History tab (see [14-form-builder.md](14-form-builder.md)); useful anywhere a cross-entity view of submissions is needed.

**Query params (all optional):** `form_key`, `link_type`, `link_id`, `status` (`draft` | `submitted` — anything else is a 400), `limit` (default 50, max 200), `before_id` (keyset cursor — pass the smallest `id` from the previous page to get the next one), **`unlinked=1`** (X4 — only rows with `link_type=''`, the anonymous-external convention; the plain `link_type` filter can't express it), **`linked=1`** (X4 — the inverse, `link_type <> ''`; passing both is a 400, since together they'd select nothing and read as "no results"), **`with_data=1`** (X4 — include the `data` bodies; the Form Inbox uses this for its name/email/phone preview). Rows also carry `linked_by` / `linked_at` (X4 — NULL unless the row was adopted from the Form Inbox).

**Response:**
```json
{
  "status": "success",
  "limit": 50,
  "submissions": [
    { "id": 253, "form_key": "test_quick_notes", "link_type": "case", "link_id": "uT7EU36v",
      "status": "submitted", "version": 1, "schema_version": 2,
      "submitted_by": 6, "user_name": "Fred",
      "created_at": "2026-07-27T21:36:52.000Z", "updated_at": "2026-07-27T21:36:52.000Z" }
  ]
}
```

Newest first (`ORDER BY id DESC`). A page shorter than `limit` means you've reached the end.

**Console test:**
```js
await apiSend("/api/forms/submissions?form_key=test_quick_notes&status=submitted&limit=20", "GET");
```

---

## GET /api/forms/submissions/:id

One submission row **including** `data`. 404 when the id is unknown.

**Response:**
```json
{
  "status": "success",
  "submission": {
    "id": 253, "form_key": "test_quick_notes", "link_type": "case", "link_id": "uT7EU36v",
    "status": "submitted", "version": 1, "schema_version": 2,
    "data": { "quick_note": "hello", "vehicles": [] },
    "submitted_by": 6, "user_name": "Fred",
    "created_at": "2026-07-27T21:36:52.000Z", "updated_at": "2026-07-27T21:36:52.000Z"
  }
}
```

**Console test:**
```js
await apiSend("/api/forms/submissions/253", "GET");
```

---

## GET /api/forms/submissions/:id/render (X4)

The submission **plus the definition to render it under**, in one payload — feeds render.html's `?view_submission` mode. The definition is version-matched server-side: the current published definition when its `schema_version` equals the submission's; otherwise the **newest** `form_template_versions` row carrying that `schema_version`; otherwise the current definition flagged `schema_matched: false` (the renderer warns that answers for removed fields aren't shown). 404 when the submission, the template row, or any definition is missing. `submission.data` comes back parsed.

**Response:**
```json
{
  "status": "success",
  "submission": { "id": 286, "form_key": "intake", "link_type": "", "link_id": "",
                  "schema_version": 1, "data": { "name": "…" }, "linked_by": null },
  "title": "Bankruptcy Intake",
  "link_type": "case",
  "definition": { "sections": [] },
  "definition_schema_version": 1,
  "schema_matched": true
}
```

**Console test:**
```js
await apiSend("/api/forms/submissions/286/render", "GET");
```

---

## GET /api/forms/submissions/:id/pdf (X5.1)

Render a **submitted** submission to a PDF and return the **bytes** (`application/pdf`, `Content-Disposition: inline`, `X-Form-Pdf-Filename` carrying the URL-encoded suggested name). Drafts are refused (400).

Fresh render on every call. **No Dropbox write, no task, no side effect of any kind** — this is the inbox Download/Print button, and pressing it repeatedly must not litter a folder. Filing is the separate `POST` below.

Same renderer as the filed and emailed copy (`formPdfService.renderSubmissionPdf` is the single render path), so what staff print matches what is on file.

Chromium renders are **serialized** across the container, so this is a one-to-three-second request under load, not a millisecond one.

**Console test** — note `responseType`, added to `apiSend` in X5.1 (the default `'json'` would corrupt binary):
```js
const blob = await apiSend("/api/forms/submissions/286/pdf", "GET", null, {}, { responseType: "blob" });
window.open(URL.createObjectURL(blob), "_blank");
```

---

## POST /api/forms/submissions/:id/pdf/file (X5.1)

Render **and file** to Dropbox on the X5 ladder, returning the verdict. The manual twin of the workflow's `render_submission_pdf` step — for submissions that predate the form's `onSubmit.pdf`, or when staff want a copy in the folder on demand.

Body (optional): `{ "filename": "…" }` — replaces the `{date} {form title} (#id)` core; sanitized, `.pdf` enforced, unsorted identity prefixes still applied.

**Not idempotent by design.** Dropbox autorenames, so a second call files a second copy. That is the deliberate trade: a duplicate is cheap to delete, whereas silently skipping when a similar name exists would swallow a re-file that staff explicitly asked for.

**Response:** the `fileSubmissionPdf` verdict — `path` (the path **Dropbox returned**, autorename-authoritative), `file_name`, `placement` (`case` | `unsorted`), `placement_note`, `temp_link` (~4h, best-effort, may be `null`), `temp_link_expires_note`, `warnings[]`, plus `submission_id` / `form_key` / `link_type` / `link_id`.

**Console test:**
```js
await apiSend("/api/forms/submissions/286/pdf/file", "POST");
```

---

## PATCH /api/forms/submissions/:id/link (X4)

Adopt an **unlinked** submission (`link_type=''`) onto a case / contact / appt. Body: `{ "link_type": "case"|"contact"|"appt", "link_id": "…" }`.

One-way and guarded: 404 unknown submission or missing target entity; 400 draft, bad type, or empty `link_id`; 409 already linked, template `link_type` mismatch (a case-form can't land on a contact), or a lost concurrent-adopt race. `linked_by` is stamped from the **auth principal** — anything in the body is ignored. The adopted row's `version` is renumbered `MAX+1` within the target series (anonymous rows share one counter, so the old number is meaningless in the new home).

Side-effects: a `log` entry (type `form`) on the target records the adopt (best-effort — never rolls back the linkage), and `intake` + `case` stamps `cases.case_intake_form = 'yf:<id>'` **only when it's currently empty** — closing the sequence-engine reminder gate without re-firing wf 40.

**Response:**
```json
{ "status": "success", "id": 286, "link_type": "case", "link_id": "hjSFMabb",
  "version": 1, "linked_by": 6, "intake_stamped": true, "logged": true }
```

**Console test:**
```js
await apiSend("/api/forms/submissions/286/link", "PATCH", { link_type: "case", link_id: "hjSFMabb" });
```

Unlike the older handlers in this file, the Slice-4/X4 routes map service errors carrying `.status` to real 400/404/409 responses.

---

## Service Layer

```js
const formService = require('../services/formService');

formService.getLatest(db, formKey, linkType, linkId)
formService.upsertDraft(db, formKey, linkType, linkId, schemaVersion, data, userId)
formService.submitForm(db, formKey, linkType, linkId, schemaVersion, data, userId)
formService.deleteDraft(db, formKey, linkType, linkId)
formService.getHistory(db, formKey, linkType, linkId, limit)
formService.browseSubmissions(db, { form_key, link_type, link_id, status, limit, before_id })
formService.getSubmission(db, id)
```

`userId` is set from `req.auth.userId` in the route handlers.

The template-system endpoints (`/api/form-templates/...`, including version history and restore) are documented in [13-template-system.md](13-template-system.md).