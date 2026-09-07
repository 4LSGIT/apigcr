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
| `/api/assets/collections` | GET | The collection list, for the picker's grouping |
| `/api/assets/:id` | DELETE | Soft delete — the stored object is intentionally retained |

**The legacy shims are gone.** `POST /api/upload` and the `/api/image-library`
family existed until the communication screens moved to the shared picker; they
no longer exist as routes. The file header in `routes/api.assets.js` still lists
them — treat that comment as stale.

### The picker

Callers don't hit these endpoints directly. `public/js/assetpicker.js` exposes
`AssetPicker.pick({...})`, and the screens that need an image — campaigns'
rich-text editor and MMS attachment, among others — go through it. That is why
there is one asset store rather than a picker per screen.

### The table is `image_library`

`assetService` reads and writes `image_library` — the name predates the asset
store and was kept rather than migrated. There is no `assets` table.

### Upload size handling

Default cap 25MB, hard ceiling 500MB. busboy's `fileSize` limit is set to
`effectiveMaxBytes + 1` **on purpose**, so that `storageService.putStream`'s own
byte counter is the sole size authority.

The reason is a busboy quirk: a file truncated *exactly at* the limit emits no
error, and would otherwise be stored as a corrupt "success". Setting the limit
one byte high guarantees the overflow is observed by the counter that actually
reports it.
