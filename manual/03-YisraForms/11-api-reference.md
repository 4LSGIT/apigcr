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

## Service Layer

```js
const formService = require('../services/formService');

formService.getLatest(db, formKey, linkType, linkId)
formService.upsertDraft(db, formKey, linkType, linkId, schemaVersion, data, userId)
formService.submitForm(db, formKey, linkType, linkId, schemaVersion, data, userId)
formService.deleteDraft(db, formKey, linkType, linkId)
formService.getHistory(db, formKey, linkType, linkId, limit)
```

`userId` is set from `req.auth.userId` in the route handlers.
