# 8 — Asset Manager

## For operators

One place for the images and files the firm reuses — email headers, logos,
letterhead graphics, anything that needs a stable URL to point at.

**More → Asset Manager.** Upload, tag, group into collections, search, replace.
The picker in the communication tools reads from here, so an image uploaded once
is available everywhere.

**Delete is a soft delete.** The row is hidden, the stored file is deliberately
kept. Anything already pointing at that URL — an email sent last month, a
landing page — keeps working. If you need a file genuinely destroyed, that's a
separate request, not this button.

Uploads are capped at **25MB** by default.

---

## Technical reference

### Files

```
routes/api.assets.js        HTTP surface — upload, list, edit, soft-delete
services/assetService.js    Row registry: create / list / update / softDelete
services/storageService.js  Object storage: putStream / putBuffer
public/assetManager.html    The UI
```

The route performs **no direct storage or raw-SQL work** — object bytes go
through `storageService`, rows through `assetService`. All routes are under
`jwtOrApiKey`; `req.auth.userId` identifies the uploader.

### API

| Route | Method | Purpose |
|---|---|---|
| `/api/assets` | POST | Upload — multipart `file` **or** base64 JSON; optional register |
| `/api/assets` | GET | List — `q`, `collection`, `mime`, `sort`, `limit`, `offset`, `include_deleted` |
| `/api/assets/:id` | PATCH | Edit title, tags, collection |
| `/api/assets/:id` | DELETE | Soft delete — the stored object is intentionally retained |

**Legacy shims**, kept until the communication callers migrate to the shared
picker: `POST /api/upload` (maps to the `comms-images` collection),
`GET`/`POST /api/image-library`, `DELETE /api/image-library/:id` (now a soft
delete).

### Upload size handling

Default cap 25MB, hard ceiling 500MB. busboy's `fileSize` limit is set to
`effectiveMaxBytes + 1` **on purpose**, so that `storageService.putStream`'s own
byte counter is the sole size authority.

The reason is a busboy quirk: a file truncated *exactly at* the limit emits no
error, and would otherwise be stored as a corrupt "success". Setting the limit
one byte high guarantees the overflow is observed by the counter that actually
reports it.
