# 5 — Dropbox

## For operators

YisraCase talks to the firm's Dropbox directly (no Pabbly in the middle). Three things matter day-to-day:

1. **Every case gets one Dropbox folder, and the system finds it by its shared link** — the link is stored on the case (the Dropbox embed on the case page). Staff can freely **move or rename** case folders in Dropbox; the link keeps working and the system keeps finding the folder. Do not delete the shared link in Dropbox.
2. **Folders are created automatically** when a case is created at intake. If a case is missing its folder (the case page shows a **Create Dropbox Folder** button instead of the embed), press the button — it creates the folder in the right place for the case's stage:
   - No bankruptcy case number yet → under **Potential Cases**, with a `Client Uploads` subfolder.
   - Case number present (filed) → under **Active Cases**, with the four staff subfolders (Docket / Drafts / Client Docs / Correspondence).
3. **Leading spaces in folder names are deliberate** — they control sort order in Dropbox. The system preserves them exactly. Don't "fix" them, and when editing naming conventions (below), count the spaces carefully: one wrong space creates a parallel folder tree.

Folder naming conventions are editable without a deploy in `app_settings` under `dropbox_case_folder_templates` (ask a developer, or see Setup below).

---

## Technical reference

### Files

```
services/dropboxService.js        Native Dropbox API v2 client (Connections-based)
routes/api.dropbox.js             REST wrappers (jwtOrApiKey)
routes/internal/dropbox.js        Case-page "Create Dropbox Folder" button → ensure
services/caseService.js           ensureCaseDropboxFolder + folder-template machinery
routes/api.intake.js              Calls ensure post-response on case creation
routes/api.checklists.js          /api/public/get-upload-link (docReq client-direct upload)
lib/internal_functions.js         dropbox_* action functions (DROPBOX section)
```

Retired: `routes/dropbox.js` + `services/dropboxServiceLegacy.js` (env-var auth, zero traffic per legacy_route_log), and the Pabbly `create_dropbox_folder` / `dropbox_create_folder` workflows.

### Auth model

Standard Connections oauth2 credential — **credential 8 "DropBox"** by default, overridable per call via `credential_id` and globally via `app_settings.dropbox_credential_id`. Headers come from `buildHeadersForCredential` (the async builder; the sync one returns `{}` for oauth2). Token refresh, the 2-strike alert, and `refresh_failed` handling are all oauthService's job.

The credential's `allowed_urls` must cover **both** API hosts or every call fails with a "no Authorization header" error:

```
https://api.dropboxapi.com/*       RPC endpoints
https://content.dropboxapi.com/*   upload/download
```

### Path semantics — spaces are data

The firm uses leading spaces in folder/file names as a manual sort mechanism (`/  Law Office/   Cases/ ...`). `normalizePath` / `joinPath` in dropboxService normalize **slashes only** (ensure leading, collapse doubles, strip trailing) and never touch whitespace. This is a hard invariant — any helper added to the service must preserve it. Dropbox paths are case-insensitive; `path_lower` from metadata is a valid handle and keeps its spaces.

### Shared-link-as-handle

`cases.case_dropbox` stores a public shared link created when the folder is born. Because shared links survive moves and renames, every location-taking operation accepts **either** `path` **or** `shared_link` (resolved via `sharing/get_shared_link_metadata` → `path_lower`, one extra API call). Workflows should prefer `{{cases.case_dropbox}}` over hardcoded paths.

### Stage-aware case folders — `caseService.ensureCaseDropboxFolder(db, caseId, {force})`

The single operation behind intake, the case-page button, and the `dropbox_ensure_case_folder` internal function:

1. No-op if `case_dropbox` is set (returns the existing link; `force: true` recreates and overwrites).
2. Stage: `case_number` or `case_number_full` non-empty → **active**, else **potential**.
3. Names from the **Primary** contact (`case_relate_type = 'Primary'`, falling back to lowest contact id).
4. Path + subfolders from the template map; folder created with a shared link; link written to `cases.case_dropbox`.

Template resolution per stage, most-specific first: `map[stage]["Type:Subtype"]` → `map[stage]["Type"]` → `map[stage].default` → hardcoded default in caseService. Composite keys use a colon (`"Bankruptcy:Chapter 13"`) and are only needed when the path *structure* differs by subtype — within one template `{{case_subtype}}` already varies per case. Subfolders: `map[stage].subfolders` → hardcoded (stage-level only, not per-key).

**Placeholders:** `{{case_id}}` `{{case_type}}` (empty → `Other`) `{{case_subtype}}` `{{case_number}}` `{{case_number_full}}` `{{number}}` (full ‖ short ‖ case_id) `{{lfm_name}}` `{{contact_name}}` `{{date}}` (firm-local `YYYY-MM-DD`). Unknown placeholders pass through literally — a typo shows up as `{{...}}` in the folder name rather than failing.

Default conventions (hardcoded mirror of the seed below):

```
potential: /  Law Office/   Cases/  Potential Cases/  Potential - {{case_type}}/ {{lfm_name}} - {{case_id}} - {{date}}
           + subfolder: Client Uploads
active:    /  Law Office/   Cases/  Active Cases/  Active - {{case_type}}/ {{case_id}} - {{lfm_name}} - {{number}} - {{case_subtype}}
           + subfolders: Docket - {{contact_name}} - {{case_subtype}} - {{case_number}},
                         Drafts/Client Docs/Correspondence - {{contact_name}}
```

### Service API — `services/dropboxService.js`

All functions are `(db, opts)`, throw on failure (errors carry `.status` and `.errorSummary`), and accept `credentialId`:

| Function | Notes |
|---|---|
| `createFolder({path})` | Idempotent: pre-existing **folder** = success (`existed:true`); conflicting **file** throws |
| `createFolderWithOptions({path, subfolders?, shareLink?})` | One-call bootstrap; returns `shared_link` when requested |
| `getOrCreateSharedLink({path})` | Handles the create-race (409 `shared_link_already_exists`) |
| `getSharedLinkMetadata({url})` | Link → metadata (`path_lower`, `.tag`, `name`) |
| `resolveLocation(db, credId, {path\|sharedLink, expectFolder?})` | The handle resolver other ops use |
| `listFolder({path\|sharedLink, recursive?, maxEntries?})` | Auto-paginates `list_folder/continue`; default cap 2000, `truncated` flag |
| `movePath({fromPath\|fromSharedLink, toPath, autorename?})` | |
| `renamePath({path\|sharedLink, newName})` | Same-parent move; `newName` may carry leading spaces; no `/` |
| `deletePath({path\|sharedLink})` | Refuses root |
| `getTemporaryUploadLink({path\|sharedLink, filename, subfolder?, duration?})` | Browser PUTs bytes straight to Dropbox (Cloud Run friendly). No hardcoded subfolder — callers pass `'Client Uploads'` |
| `saveUrl({url, path\|sharedLink+filename, subfolder?, wait?})` | `files/save_url` — transfer runs on Dropbox's side, bytes never transit our instance. Polls ~25s by default; returns `{status:'in_progress', async_job_id}` if still running |
| `checkSaveUrlJob({asyncJobId})` | |
| `uploadFile({path\|sharedLink+filename, content, mode?, autorename?})` | Single-shot in-memory (≤150MB API cap); for URLs/large files use `saveUrl` |
| `downloadFile({path\|sharedLink})` | → `{buffer, metadata}` |

Cloud Run notes: no module-level token state (multi-instance safe); URL transfers via `saveUrl` never load file bytes into the instance.

### REST API — `routes/api.dropbox.js`

All POST with JSON bodies (deliberately RPC-style: space-laden paths stay out of query strings), jwtOrApiKey, optional `credential_id` everywhere; location ops take `path` OR `shared_link`:

| Endpoint | Body |
|---|---|
| `/api/dropbox/create-folder` | `path`, `subfolders[]?`, `share_link?` |
| `/api/dropbox/shared-link` | `path` |
| `/api/dropbox/shared-link-metadata` | `url` |
| `/api/dropbox/list` | `path?`\|`shared_link?`, `recursive?`, `max_entries?` |
| `/api/dropbox/move` | `from_path?`\|`from_shared_link?`, `to_path`, `autorename?` |
| `/api/dropbox/rename` | `path?`\|`shared_link?`, `new_name` |
| `/api/dropbox/delete` | `path?`\|`shared_link?` |
| `/api/dropbox/upload-link` | `path?`\|`shared_link?`, `filename`, `subfolder?`, `duration?` (60–14400s) |
| `/api/dropbox/save-url` | `url`, `path?`\|(`shared_link`+`filename`), `subfolder?`, `wait?` |
| `/api/dropbox/save-url-status` | `async_job_id` |
| `/api/dropbox/upload` | `content_base64` + destination as above (≈7MB practical cap — express body limit) |
| `/api/dropbox/download` | `path?`\|`shared_link?` → raw bytes, metadata in `X-Dropbox-Metadata` |

Plus `POST /internal/dropbox/create-folder` `{case_id}` — the case-page button; extra legacy fields are ignored, everything derives from the case row.

### Internal functions (automations)

All in the DROPBOX section of `lib/internal_functions.js`, category `dropbox`, chainable via `{{this.output.*}}`:

#### `dropbox_ensure_case_folder`
`{ case_id, force? }` → `{ existed, stage, path, shared_link, ... }`. The workflow-facing wrapper over `ensureCaseDropboxFolder`. Use at the top of filing pipelines to guarantee a folder exists; capture `{{this.output.shared_link}}`.

#### `dropbox_create_folder`
`{ path, subfolders?, share_link? }` → `{ path, existed, shared_link }`. Raw folder creation for non-case-convention needs.

#### `dropbox_get_shared_link`
`{ path }` → `{ shared_link }`.

#### `dropbox_list_folder`
`{ path | shared_link, subfolder?, recursive?, max_entries? }` → `{ entries, count, truncated }`. Branch on `{{this.output.count}}` for "did the client upload anything" checks (e.g. `shared_link: {{cases.case_dropbox}}, subfolder: Client Uploads`).

#### `dropbox_move`
`{ from_path | from_shared_link, to_path, autorename? }`. The filed-case relocation: `from_shared_link: {{cases.case_dropbox}}`, `to_path` = the Active-tree convention written with resolver placeholders in the workflow config.

#### `dropbox_rename`
`{ path | shared_link, new_name }`. Same parent; `new_name` keeps leading spaces, no `/`.

#### `dropbox_delete`
`{ path | shared_link }`. Refuses root.

#### `dropbox_save_url`
`{ url, path | shared_link + filename, subfolder?, wait? }` → `{ status, path, async_job_id? }`. Pull email attachments / generated documents into the case folder by URL.

### Setup

1. Connections: credential 8 `oauth_status = connected`, `allowed_urls` covering both hosts (above). Token type `offline` so refresh works.
2. `app_settings.dropbox_credential_id` = `8` (seeded; the hardcoded default matches).
3. Optional convention seed — **verify leading spaces against the live tree first** (`/api/dropbox/shared-link-metadata` on an existing `case_dropbox` link → `metadata.path_display`):

```sql
REPLACE INTO app_settings (`key`, `value`) VALUES (
  'dropbox_case_folder_templates',
  '{
  "potential": {
    "default": "/  Law Office/   Cases/  Potential Cases/  Potential - {{case_type}}/ {{lfm_name}} - {{case_id}} - {{date}}",
    "subfolders": ["Client Uploads"]
  },
  "active": {
    "default": "/  Law Office/   Cases/  Active Cases/  Active - {{case_type}}/ {{case_id}} - {{lfm_name}} - {{number}} - {{case_subtype}}",
    "subfolders": [
      "Docket - {{contact_name}} - {{case_subtype}} - {{case_number}}",
      "Drafts - {{contact_name}}",
      "Client Docs - {{contact_name}}",
      "Correspondence - {{contact_name}}"
    ]
  }
}'
);
```

The key is deliberately **not** `fe-` prefixed — backend-only, not shipped to the shells.

### Lifecycle summary

```
intake creates case ──► ensureCaseDropboxFolder ──► Potential folder + Client Uploads + link saved
                                                          │
case page (no link) ──► Create Dropbox Folder button ─────┤  (stage-aware repair)
                                                          │
petition filed (wf-23) ──► dropbox_move (from_shared_link) to Active tree
                           + dropbox_create_folder (4 staff subfolders)
                           — or dropbox_ensure_case_folder if no folder existed
                                                          │
docReq.html client upload ──► /api/public/get-upload-link ─► browser PUTs into Client Uploads
```
