# Documents & Storage — YCv3 Design (living doc)

**Status: DESIGN RATIFIED 2026-11-17 (Fred's rulings on §10 a–g folded in) · not active development · no arc open.**
Living doc — edit stale claims in place, present tense; git history carries the dating. Doc≠code divergences found mid-work go to the docs-debt queue (scratch `ns=docs`), per house rule.
Provenance: exploration session 2026-10-26, self-review 2026-11-16 (live figures re-measured that day through the readonly SQL endpoint). Every claim about v2 was read from source: `services/documentSourceService.js`, `services/filePlacementService.js`, `services/documentSyncService.js`, `services/caseService.js` (`ensureCaseDropboxFolder`), `ref/plans.md` ("YC 3.0 — Tenancy plan"), `ref/AUDIT_TENANCY.md`. Companion: `ref/EMAIL_ATTACHMENTS_DESIGN.md` (one writer on today's Dropbox path).
Parent: `ref/plans.md` → "YC 3.0 direction" (driver pattern extends to storage). No scratch state key: this doc is the state until an arc opens.

## 0. Invariant zero — 4LSG never breaks

This design is executed as a strangler on the live app, 4LSG as tenant zero. Each slice is a **no-behavior-change deploy for 4LSG**, and that is a gate, not a hope:

1. **Dropbox is driver #1, forever if SS wants.** Not one byte moves. Not one `documents` row is rewritten (`source='dropbox'`, `external_id` untouched). SS's tree — every leading, double and trailing space in `/  Law Office/   Cases/  Active Cases` — is never renamed, moved or "cleaned up" by the app. That tree is why YisraCase exists.
2. **Every slice ships a replay gate.** The placement ladder, folder creation and the sync tick are driven against a recording stub provider on a fixed fixture before and after the slice; the recorded provider calls (paths, names, order) must be identical. A slice that changes the recording is a behavior change and says so.
3. **Resolved-config diff.** De-hardcoding a credential id, bin path or template ships with a before/after dump of the RESOLVED values on 4LSG (the four unsorted bins, `dropbox_credential_id`, the folder templates); the dump must be identical. The double spaces are load-bearing and the diff is byte-wise.
4. **Flags default to today.** An absent setting selects today's path; a new provider is reachable only through an explicit per-tenant setting Fred flips. The GCS provider is never on 4LSG's path by default.
5. **Retiring a column or value** (`cases.case_dropbox`, the `'dropbox'` literal) follows the house gate: read-through alias first, inventory by claim name not literal, drop only after a sweep of code + schema objects + stored definitions (report SQL, workflow/trigger configs, tools).
6. **One tenant, one provider** by default (§10 b). The mechanism (`documents.source` is per row) allows mixing; the default forbids it, because splitting a case's files across providers breaks the "everything is in the case folder" property SS relies on.

## 1. What v2 already is (verified live 2026-11-16)

Scale: 155,712 active `documents` rows, ~186 GB, all `source='dropbox'`; 467 deleted; 1,428 cases, 1,105 with a bound folder (`case_dropbox`), 1,105 `case_folder_cache` rows, all resolved; 7 `document_sync_roots` (Active / Potential / Closed Cases, the odd `/   ActiveCases`, and the three unsorted bins); 36,637 machine `case` path-links, 8 machine upload-links (6 case, 2 contact), 11 human links. **119,307 active documents — 77% — carry no link at all**: registered, inside a watched root, under no bound folder (mostly the Closed Cases tree, which predates YC's case rows). Unattributed is the normal state of a registered file, not an edge case.

What exists:
- **A provider seam, read side only.** `documents.source` + `documentSourceService` (register/get, provider = plain object of async functions: `stat, tempViewUrl, download, move, rename, remove, ensureSharedLink`). Its contract: **`external_id` is whatever handle the provider keeps stable across move and rename** (Dropbox `id:…`). GCS/Drive deliberately not stubbed.
- **Ownership is metadata, not path.** `document_links (document_id, link_type 'case'|'contact'|'appt', link_id, relation, created_by)`; machine links carry `relation='path'`, `created_by NULL`, and the sync engine retracts its own false path-links on a move but never touches a human link. Also `doc_type`, `tags`, `title`, `ai_meta`.
- **Path attribution is a Dropbox-sync strategy**, not a model property: `case_folder_cache` (case → folder `external_id` + `path_lower`) and `_matchCase` walking a file's directory chain upward.
- **The placement ladder** (`filePlacementService.placeAndRegister`): case folder → auto-create via `ensureCaseDropboxFolder` (always raises a task) → the caller's unsorted bin, per-case subfolder `"{case_id} - {lfm name}"` + a move task; contact/appt/unlinked → loose in the bin with an identity prefix, no task. `esignFilingService` carries its own copy (known, deliberate, its own slice).
- **Folder creation is templated and lazy**: `dropbox_case_folder_templates` (app_settings JSON; stage `potential|active` × `case_type[:subtype]` → path template + subfolders), substituted from the case row and its primary contact; adopt-before-create probe; the shared link lands in `cases.case_dropbox` (a URL — the binding is a human link, not a handle).
- **Hard-wired to Dropbox** (bypassing the seam): every WRITER — `filePlacementService`, `esignFilingService`, `uploadTargetService`, `emailAttachmentFilingService`, `emailAttachmentCommsService`, `documentIngestService`, portal docs, `/api/documents/upload-link` → direct browser→Dropbox upload → `upload-commit` — plus `caseService.ensureCaseDropboxFolder`, the sync engine, `assistantService`, `routes/freelook.js`, `routes/api.dropbox.js` — **and the workflow engine's provider-named functions** (`lib/internal_functions/dropbox.js`: `dropbox_move`, `dropbox_create_folder`, `dropbox_ensure_case_folder`, `dropbox_save_url`, `dropbox_list_folder`, `dropbox_get_shared_link`), which live by NAME inside tenant-authored definitions: workflow 28 "Filed Case Dropbox Move" moves a case folder from the Potential tree to the Active tree when a docket number lands, and workflow 48 files Jotform PDFs (verified live 2026-11-17). Automation is a third writer class, and its function names are data, not code. The tenancy audit already lists the firm-specific residue: credential id 8 (×2), four hardcoded bin paths, `dropbox_credential_id`, `dropbox_case_folder_templates`.

## 2. The central split: human-managed vs app-owned storage

Providers fall into two classes with different truth models. The design is the pair, not a single abstraction.

**A. Human-managed (mirrored) storage** — Dropbox, Google Drive, OneDrive/SharePoint, Box, Egnyte. Staff live in the provider's own UI and move/rename freely. The registry is a **mirror**: it needs move-stable ids, a resumable change feed, a folder cache, attribution of files the app did not write, relink repair, delete grace. v2 built exactly this because SS works *in* Dropbox.

**B. App-owned storage** — a GCS bucket per tenant (the default for a tenant with no provider), or a BYO S3/R2 bucket. Nobody touches it out of band; the app is the sole writer. Then: **bytes get an immutable, opaque, app-minted object key** (e.g. `doc/<ulid>`), and *all* organization — name, logical path, links, tags — lives in the DB. Rename/move = a metadata UPDATE (instant, transactional, no copy). The external-id contract is satisfied trivially. No sync engine, no folder cache, no relink UI; "folders" are a projection the app renders.

Why not mirror real paths into GCS keys: GCS has no move-stable id — the object name *is* the id, a rename is a server-side rewrite + delete, and you would have rebuilt Dropbox's problems with none of Dropbox's UI benefit. Mirrored paths are worth their cost only when a human lives in the provider.

So a provider declares a **capability flag** `humanManaged`, which decides per source: whether the sync engine runs, whether a folder cache exists, whether `documents.path` is provider-authored (A) or app-authored (B).

Cost of B to carry: an app-owned bucket is unreadable without the DB. Mitigations in the design: a **storage export job** that materializes the logical tree into readable paths (for a tenant leaving, for audit), and the tenancy plan's restore drill ("files included") covers DB+bucket as one unit. GCS object versioning / soft delete gives the `pending_delete_at` grace for free.

## 3. Organization: links are the truth, folders are a projection

- **`document_links` is canonical ownership** for every provider. For class B the machine link is written at upload time (the app always knows the entity) — attribution-by-walking disappears; it is a class-A concern only.
- **`path` stays the one hierarchy concept**: a string the folder-template engine produces for every provider. Class A: a real folder path (or a derived one, §5). Class B: a logical path column over opaque keys. No virtual-folder-tree table: inner-platform risk, and the YC 3.0 rule is "hardcode until a second tenant demonstrably needs it".
- **The template map is the per-tenant layout customization.** `dropbox_case_folder_templates` generalizes to a provider-neutral `storage_folders` config (§6). It is how SS's double-spaced tree and a tenant's `Clients/{lfm_name}/{number} {name}` both run on one engine.
- **The entity↔folder binding generalizes.** Today `cases.case_dropbox` (URL) + `case_folder_cache`. Target: one binding row per (entity kind, entity id, source) — `external_id`, `path`, optional human link — with `case_dropbox` kept as a read-through alias until the retire gate passes. For class B tenants the "Open folder" affordance is the app's own documents view: the case documents tab *is* the folder.
- **The bin ladder survives unchanged** conceptually: bins are per-tenant settings (they already are, with 4LSG defaults); for class B a bin is a logical path prefix plus the same move task.

## 4. Provider contract (what a driver must and may offer)

Required of every provider: `stat, download, tempViewUrl, upload, ensureFolder, move, rename, remove` and the move-stable `externalId` contract. Class A additionally: `listChanges(cursor)` (resumable, page-budgeted — the sync engine's tick model stays: a `scheduled_jobs` slice, no long-running process), `attribution strategy` (§5), `nameRules` (legal characters, leading/trailing whitespace, case sensitivity, duplicate names allowed?), `roots` (namespaces: team folders, shared drives, document libraries).

Optional capabilities, each a flag the app checks rather than assumes:
- `directUpload` — a pre-authorized URL the browser can PUT to. Keeps today's two-phase `upload-link` → `upload-commit` contract; the frontend receives either a provider target or the app's own proxy endpoint and cannot tell which. Providers without it go through the app (bytes through Cloud Run; fine for documents, budgeted for video).
- `humanLink` — a folder/file URL a staffer can open in the provider's UI.
- `changeNotify` — webhook/longpoll freshness. **Optimization, never a requirement**: cursor polling on the tick is the baseline every class-A provider must support.

## 5. Provider survey — what other firms are likely to have

Confidence marks: ✓ verified against the provider's documented API model as of this writing; ~ believed, verify in the driver slice; ✗ not offered.

| Provider | Likelihood (small/mid US firm) | Move-stable id | Change feed | Names / paths | Human link | Direct upload | Attribution signal |
|---|---|---|---|---|---|---|---|
| **Dropbox** (4LSG) | high | ✓ `id:` | ✓ cursor + longpoll/webhook | path-first; case-insensitive `path_lower`; leading/double spaces preserved (4LSG proves it) | ✓ shared link | ✓ temp upload link (today) | path prefix (today) |
| **Google Drive** (Workspace) | high | ✓ `fileId` | ✓ Changes API page token; watch channels expire, must renew | **no paths**: names are not unique within a folder, `/` is legal in a name, single parent; Google-native Docs/Sheets have no bytes (export only) | ✓ `webViewLink` | ~ resumable session URI (verify the browser may PUT without an auth header) | **parent-id ancestry**, never a path string |
| **OneDrive / SharePoint** (Microsoft 365) | highest for law firms | ✓ within a drive; a cross-drive move mints a new id | ✓ delta per drive; subscriptions expire, must renew | case-insensitive; illegal `" * : < > ? / \ |`; **leading/trailing spaces and a trailing period are rejected or trimmed** (~ exact rule) — SS's tree could not be mirrored into SharePoint as-is; a document library = a drive → multi-root is first-class | ✓ `createLink` | ✓ `createUploadSession` is pre-authorized | ancestry by `parentReference.id`, or path |
| **Box** | medium | ✓ | ✓ event stream (`stream_position`) + webhooks | case-insensitive; duplicate names forbidden; path is derived (`path_collection`) | ✓ shared link | ✗ no pre-authorized URL (~ downscoped token or app proxy) | ancestry |
| **Egnyte** | low–medium | ~ `group_id` (verify stability across move) | ✓ events cursor + webhooks | path-first, case-insensitive | ✓ | app proxy | path |
| **NetDocuments / iManage / Worldox** (legal DMS) | mid-size firms | ✓ document id | ~ | **no folders as truth**: workspaces + profile metadata (client/matter); the DMS already *is* a registry | ✓ | n/a | **metadata**, not location — a third class, "DMS-native" |
| **Clio Drive / practice-suite storage** | — | | | that storage is the suite's lock-in, and the firm is leaving Clio | | | not a target |
| **On-prem file server / NAS** (SMB) | still real for small firms | ✗ | ✗ | unreachable from Cloud Run | ✗ | ✗ | out of scope: the firm fronts it with a sync client (then it is Dropbox/OneDrive to us) or goes app-owned |
| **App-owned: GCS** (default) / BYO S3, R2 | every tenant without a provider | ✓ app-minted key | not needed (sole writer); bucket notifications as an optional backstop | key is opaque; logical path in DB | app UI | ✓ signed resumable URL | DB link at write time |

What the survey forces on the plan (each is a change to the §2–3 sketch, absorbed here):

1. **Attribution strategy is per provider.** Path-prefix walking (Dropbox, Egnyte) and ancestry-by-id (Drive, Graph, Box) are two strategies behind one `_matchCase` dispatch. `case_folder_cache` already holds `folder_external_id` alongside `path_lower`; the binding row keeps both. For Drive, `documents.path` is DERIVED (and can be ambiguous — two "Petition.pdf" in one folder): never key anything on it; `external_id` + links are the keys.
2. **Name legality is per provider.** The template engine validates a template against the provider's `nameRules` at save time (a SharePoint tenant cannot save a template with a trailing space; a Drive tenant may put `/` in a name and the engine must escape it). The promise is "we preserve what the provider preserves" — on Dropbox that is every space SS typed; on SharePoint it is what SharePoint allows. 4LSG is unaffected.
3. **Multi-root is first-class.** `document_sync_roots` already models opt-in roots; a root gains a provider and a namespace handle (`ns:` team folder, shared drive id, document library drive id).
4. **Freshness stays cursor-polled** on the tick; notifications are per-provider sugar with their own renewal chores (Drive channels, Graph subscriptions expire).
5. **DMS-native is a third class, deferred.** Its attribution is profile metadata, its "case folder" is a workspace; the registry would mirror profile fields rather than paths. Nothing here precludes it; nothing here designs for it until a DMS tenant is real.
6. **Google-native documents** (no bytes) need a `download` that exports to a chosen format and a `size` that is NULL — the registry already allows NULL `size`; `mailboxSendService.loadAttachments` refuses "size unknown", which is the right behavior for them.

## 6. Folders: which entities get one, and who decides

Vocabulary, as Fred framed it (2026-11-16): a "folder" is first a **tag** — a `document_links` row saying this file belongs to this case/contact, which puts it on that entity's Documents tab — and second, for a class-A tenant, **a maintained provider folder** (created from the tenant's templates, kept bound by id).

The tag half is already generic: `link_type` carries `'case' | 'contact' | 'appt'` today, a file may hold several links, and contact/appt files are placed loose in a bin with an identity prefix. Only the physical half is case-only.

**Ruled (Fred, 2026-11-17): a SETTING, not a hardcode. The PLATFORM default is the nested `contact → case` tree; 4LSG is seeded explicitly case-only.** 4LSG's layout is 4LSG's config, not the product's default (tenancy invariant 8: never copy live 4lsg settings as defaults).

- Hardcoding "contacts get folders" is wrong for tenant zero: SS's tree has no contact folders, and the app would mint thousands he never asked for — a breach of invariant zero. Hence the explicit 4LSG seed.
- Hardcoding "contacts never get folders" is wrong for the product: a `Clients/<name>/<matter>` tree is the prevalent firm convention (the default shape in the mainstream practice-management and DMS products), which needs contact folders AND case (matter) folders nested under them. Hence the platform default.
- So `storage_folders` (per tenant, one `settingsRegistry` entry) = `{ case: { templates… }, contact: { templates… } | null }`, where a case template may reference `{contact_folder}` (the primary contact's bound folder, created on demand). The engine must support the nesting from day one — it is the default, not an option. Inner-platform guard: kinds are `case` and `contact` only; `appt` and anything else stay tag + bin, never a folder.
- **Physical placement follows the PRIMARY link: case, else contact, else bin.** Every other link is a tag only. One file, one location — a file linked to a case and two contacts sits in the case folder and shows on all three tabs.
- **Lazy creation**, as today: a folder is created on first need (intake, first file, explicit "create folder"), never for every row of the entity table.
- **Core never moves or renames a folder implicitly; automation moves it explicitly.** Today's lead→case move IS automatic — workflow 28 does it with `dropbox_move` when a docket number lands — and that is the right shape: a tenant-authored step in config, not a hidden side effect in `caseService`. v3 keeps it exactly so, with provider-neutral `storage_*` functions (§9 D1) a tenant wires into its own stage rules. Closing a case stays human on 4LSG because SS never automated it, not because the app forbids it. Id-stable bindings survive either way.

## 7. Onboarding an existing firm's storage ("work with the mess, don't organize it")

Yes — and v2 already behaves this way for 4LSG; the design keeps it:

- **Roots are opt-in.** The firm picks which folders YisraCase watches (`document_sync_roots`). Outside a root the app sees nothing. Inside a root, every file is registered — that is what the registry is for — and a file under no bound folder is simply **unattributed** (77% of 4LSG's registry today, §1). Nothing is moved, renamed, deduplicated or restructured. Ever.
- **Existing case folders are adopted, not recreated.** Today: `case_dropbox` set by hand, the relink/repair button, and the adopt-before-create probe in `ensureCaseDropboxFolder`. The one NEW onboarding feature is a **bulk binder**: it proposes folder→case matches (by docket number / name tokens inside the chosen roots), staff confirm or reject each, unmatched folders stay unbound. A proposal is never auto-applied. 4LSG is its first user: the Closed Cases tree holds the bulk of the 119k unattributed files, and a case row that exists for one of them gets its folder bound the same way.
- **Day forward**: the firm keeps working in its tree as before; the app places only the NEW files it creates, by the tenant's templates, and tags whatever staff drop into bound folders.
- What onboarding is NOT: a migration of their bytes, a cleanup, a re-foldering, or a requirement that their tree be consistent.

## 8. Tenancy fit

Bucket-per-tenant mirrors the ratified DB-per-tenant model: IAM isolation, lifecycle/retention per tenant, export = copy the bucket, deletion = delete the bucket, no cross-tenant key-prefix bugs. The storage handle comes from the tenant registry the way the DB handle does — tenancy invariant 4's analog: **no storage client is constructed outside the tenant module**; `tenants.credential_ref` already anticipates it. Precedent in-app: `gcs_bucket` is a firm-config key (videos). Class-A tenants store their own provider credential (the `credentials` table's five types cover OAuth2), which is the audit's isolation-flush work: credential 8, the four bin paths, the templates.

## 9. Sequencing — slices, each a no-behavior-change deploy for 4LSG

Independent of the tenancy P0 chain; D1–D3 are the audit's Dropbox isolation items and can land any time.

| Slice | What | 4LSG gate (§0) |
|---|---|---|
| D1 seam completion | grow the provider interface (`upload`, `ensureFolder`, `directUpload`, `listChanges`); route every writer in §1 through `documentSourceService`; fold the e-sign ladder copy in (its own sub-slice); add provider-neutral `storage_*` internal functions and keep every `dropbox_*` name as a permanent alias — those names sit inside live workflow definitions (wf 28, 48) and a rename there is a silent break of a tenant's automation | replay gate: identical recorded Dropbox calls on the fixture; wf 28 + 48 definitions byte-identical and dry-run green |
| D2 de-hardcode | credential 8, the four bins, templates → `settingsRegistry` entries, defaults = today's literals | resolved-config byte diff |
| D3 binding generalization | entity↔folder binding rows; `case_dropbox` read-through alias; `storage_folders` config with `contact: null` seeded for 4LSG | replay gate + alias inventory |
| D4 provider-dispatched attribution + name rules | `_matchCase` strategies; `nameRules` validation at template save | sync tick from the committed SHA in a detached worktree reproduces main's upserts (count + sample) |
| D5 GCS provider | class B driver, opaque keys, signed uploads, export job | never reachable on 4LSG without an explicit setting |
| D6 Drive / Graph drivers + bulk binder | when a tenant brings them | no 4LSG surface |

## 10. Open decisions — Fred rules

Ruled by Fred 2026-11-17.

a. **Opaque keys + DB path for app-owned storage.** Ruled yes.
b. **One provider per tenant** by default; `documents.source` per row stays the mechanism. Ruled yes.
c. **Portal docs, e-sign filings and generated documents follow the tenant's provider**; app-owned only when the tenant has none. Ruled yes. Note on templates: e-sign and generation TEMPLATES are not in storage at all — `contract_templates` rows (HTML body or stored PDF + `placement_json`, inline images base64 in the column), so there is nothing provider-specific to follow; only their OUTPUT (the signed / generated PDF) is placed, and it follows this ruling.
d. **Folders are a setting; the platform default is the nested `contact → case` tree; 4LSG seeded case-only.** Ruled (§6).
e. **Core never moves a folder implicitly; automation moves it explicitly** — the lead→case move already works that way (wf 28). Ruled; the original "never automatic" wording was wrong and is retired (§6).
f. **DMS-native class deferred** until a real tenant. Ruled yes — with the correction that it is deferred for lack of a tenant and of API access (NetDocuments and iManage gate their APIs behind partner programs), not for difficulty: model-wise it is the SIMPLEST class, because the DMS already holds client/matter metadata and the registry would read attribution from a profile field instead of walking anything.
g. **A new tenant may bring a messy class-A tree.** Ruled yes: the sync engine's onboarding path (page budgets, `backfill_done` semantics, the attribution sweep) is a provisioning feature to preserve, not 4LSG history.

## 11. Rejected

- A virtual folder-tree table (inner platform; `path` + templates cover it).
- Mirroring real paths as GCS object names (§2).
- Mixed providers within a tenant by default (§0.6).
- Organizing a tenant's whole provider at onboarding (§7).
- Running the sync engine for class B (the app is the sole writer; a bucket notification is a backstop, not a feed).
