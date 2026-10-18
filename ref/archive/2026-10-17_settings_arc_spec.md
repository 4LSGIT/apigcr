<!-- Archived 2026-10-18 at the settings / config-split arc's close: the worker
     contract for lanes W1–W7. Not current — the contract as built is
     ref/AI_CONTEXT.md §32, ref/plans.md "Settings vs Config" and
     manual/05-Subsystems/15-firm-and-system-settings.md. -->

# Settings / Config split arc — worker contract (2026-10-17)

You are a WORKER on one lane of this arc. The arc manager (another session)
merges every lane; Fred makes final calls. Read this whole file, then
`/home/user/apigcr/CLAUDE.md` (the project rules — they bind you), then the
files your lane names. Base commit for every lane: `400e935` (branch
`claude/settings-arc-custom-views-roles-t7tp19`), which already contains
`lib/settingsRegistry.js` (READ IT FIRST — it is the contract's spine),
`tests/settingsRegistry.test.js` and the `system.settings` capability.

## 1. What the arc does (rulings by Fred, 2026-10-17)

Two operator surfaces (ratified 09-24): **My Settings** (`public/settings.html`)
becomes PERSONAL ONLY; **YisraCase Config** (`public/caseConfigManager.html`)
holds every firm-wide editor. The registry (`lib/settingsRegistry.js`) is the
spine: one entry per app_settings key, with its kind, ONE editor home, section,
type and edit posture; the DB keeps only values (its metadata columns describe
UNREGISTERED rows only — "automation variables" a person created).

Homes (who edits what):
- `firm` → Config → **Firm** tab (`public/caseconfig/firm.html`), sections
  identity, senders, routing, booking, dropbox, esign, + "Automation
  variables" (unregistered rows). Write capability `firm.settings`
  (admin / it / su). Readable by any staff (as today).
- `portal` → Portal Manager → Settings (`public/portaladmin/portalSettings.html`).
  `firm.settings`.
- `config` → Config vocabulary tabs: **Lists** (`fe-lead_sources`,
  `fe-event_types`) and Types & Subtypes (`fe-case_types`, unchanged).
  `firm.settings`.
- `system` and `comms` → Config → **System** tab (new, it + su only:
  capability `system.settings`, which `admin` does NOT hold). Read AND write
  need `system.settings`. State rows show read-only there.
- `cta` → CTA Links (`public/ctaManager.html`, an SU tool) — `system.settings`.
- `console` → no editor (secrets, interim access lists, retired keys): never
  served by any settings API.

Other rulings:
- Config vocabulary WRITES (custom fields, calendar types, pipelines, contact
  role types) need `firm.settings`; non-holders see Config read-only.
- Contact Roles editor moves from settings.html to a Config tab (CFG-2).
- Settings history: every human write is versioned (`app_settings_versions`)
  with History + restore in the editors.
- Automation (set_setting / update_db) may write a REGISTERED key only when the
  registry says `automation: true` (today: `clio_login_code` only);
  unregistered non-secret rows stay writable; secrets never.
- Two rollout flags retire at their final value: `unified_singleton_enabled`
  (always on) and `esign_webhook_hmac_mode` (always enforce). Their rows are
  deleted AFTER deploy (migration stage 2).
- My Settings gains "My access" (read-only view of the caller's mailbox /
  phone-line grants) and "Manage access" (grant editor for channels where the
  caller holds a real `can_manage` grant — two non-SU staff did, with no
  UI). No new authz: the grant routes already accept can_manage holders.
- Automations' broader info security is OUT of scope (Fred: its own arc).

## 2. The API contract (lane W1 implements it; every UI lane builds on it)

### GET /api/app-settings  (jwtOrApiKey — any staff; machine keys pass)
Query: optional `home=<home>` filter (comma-separated allowed).
```json
{ "status": "success",
  "caps": { "firm": true, "system": false },
  "sections": { "<home>": [ { "id": "identity", "title": "Firm identity", "icon": "building" } ] },
  "settings": [ ROW, ... ] }
```
`caps.firm = can(req.auth,'firm.settings')`, `caps.system = can(req.auth,'system.settings')`.
`sections` = registry `SECTIONS` for every home present in `settings`.

ROW:
```json
{ "key": "firm_name", "value": "…" , "updated_at": "…", "exists": true,
  "registered": true, "kind": "firm", "home": "firm", "section": "identity",
  "type": "string", "options": null, "label": "Firm name", "description": "…",
  "sort_order": 5, "edit": "ui", "editor": null, "env": null,
  "can_edit": true, "category": "Firm identity" }
```
- `value` / `updated_at` are `null` and `exists:false` when a REGISTERED key
  has no row yet (the UI shows "not set — the code's default applies"; a PUT
  creates the row).
- `can_edit` = `edit === 'ui'` AND the caller passes the home's WRITE cap.
- `category`: registered → the section's title; unregistered → the DB category.
- Rows served:
  - registered, kind not in `NEVER_SERVED` (secret/access/retired), whose
    home's READ cap is null or passed by the caller — with or without a row;
  - unregistered rows with `is_editable = 1` AND `is_secret = 0`, as
    `registered:false, kind:'variable', home:'firm', section:'variables'`,
    `type` = the DB type (may be anything a migration wrote — e.g. `text`),
    `label` = DB label or the key, `description` = DB description,
    `edit:'ui'`, `can_edit` = `firm.settings`;
  - NEVER: any secret (registry kind secret OR row `is_secret = 1`), access,
    retired, unregistered `is_editable = 0` rows.
- Order: home (registry HOME_CAPS order), section order, sort_order, key.

### PUT /api/app-settings/:key   body `{ value: string }`
Mount: `requireAuth({ audience:'staff', allowApiKey:true })` (any staff;
NULL-scope machine keys pass), then per-key checks:
- non-string value → 400; length > 60000 → 400 (as today).
- REGISTERED key:
  - kind secret/access/retired/state, or `edit === 'console'` → 403
    `{ status:'error', message:'<label> is changed from the SU db console only' }`
  - caller fails the home's WRITE cap → 403
    `{ status:'error', message:'Changing <label> needs the <cap> permission' }`
  - `reg.validate(key, value)` → 400 with the reason.
  - row missing → INSERT (`key`, `value`, is_secret 0, is_editable 1; metadata
    columns NULL). Else UPDATE.
- UNREGISTERED key: today's rules — 404 if no row; 403 unless is_editable=1
  and not secret; needs `firm.settings`; validated by the row's DB type
  (`reg.validateByType(row.type, value)`).
- Unchanged value (equal to the stored string, byte for byte) → 200 with the
  current row, NO write, NO version row.
- The write and its version row in ONE transaction (`req.db.withTransaction`,
  retries:1 — pure DB). Then `firmConfig.invalidate()`.
- Response (yc-sync contract, unchanged): `{ status:'success', setting:{ key, value, updated_at } }`.

### POST /api/app-settings  (create an automation variable)
As today (firm.settings + JWT only, KEY_RE, SETTING_TYPES, verbatim value)
PLUS: a registered key → 409 `{ message:'"<key>" is a registered setting —
change it in <home title>' }` whether or not its row exists. Writes a version
row (old_value NULL) in the same transaction.

### GET /api/app-settings/:key/history?limit=50  (limit 1..200)
Caller must pass the key's WRITE cap (unregistered: firm.settings); never-served
or secret keys → 404. Response:
`{ status, key, versions:[ { id, old_value, new_value, changed_by, changed_by_name, changed_via, changed_at } ] }`
newest first. `changed_via` ∈ `ui | api_key | restore | create`.

### POST /api/app-settings/:key/restore   body `{ version_id }`
Sets the value back to that version's `old_value` ("restore the value before
this change"; NULL old_value → ''). Same checks as PUT (cap, edit posture,
validation of the restored value). Writes a version row `changed_via:'restore'`.
Response exactly like PUT. **New write route on the `setting` bus entity →
add its matcher to `public/js/yc-sync.js` + a ycSync test in the same lane
(CLAUDE.md sync-bus rule).**

### GET /api/ui-config — gains `can_edit_system` (= can(req.auth,'system.settings')),
beside `can_edit_firm`. The Config shell reveals gated tabs from it.

### Table `app_settings_versions` (migration, SQL first)
`id int unsigned PK AI, setting_key varchar(100) NOT NULL, old_value text NULL,
new_value text NULL, changed_by tinyint NULL (users.user; NULL = machine key),
changed_via varchar(16) NOT NULL, changed_at timestamp default CURRENT_TIMESTAMP`,
index (setting_key, id). Secrets are never written (the routes never write
secrets). Table + column COMMENTs.

## 3. Lanes — files you may touch (anything else: STOP and report)

Every lane works ONLY in its own git worktree (path given in your prompt),
commits on its own branch with `git commit --no-verify`, never pushes, never
merges, and NEVER edits `ref/database.sql`, `ref/routes.md`,
`TRACKED_FILES.txt` or anything under `scripts/mobile-survey/` (the manager
owns the survey). Before each commit run `node scripts/secret-scan.js` on the
staged diff (exit 0 required). Docs: fix in your lane only the manual /
comment text your code falsifies (named below); list every other doc delta in
your report — the manager writes AI_CONTEXT, plans.md, CLAUDE.md and the
manual chapters.

- **W1 backend-routes**: `routes/api.appSettings.js`, `routes/api.uiConfig.js`
  (can_edit_system only), `public/js/yc-sync.js` (restore matcher only),
  `scripts/settingsArcMigrate.js` (NEW), `ref/migrations/2026-10-18_settings_arc.sql`
  (NEW), new tests (`tests/appSettings*.test.js`, `tests/settingsArcMigrate.test.js`,
  ycSync test for the matcher), existing `tests/apiAppSettings.validate.test.js`
  / `tests/appSettingsGate.test.js` re-pinned with intent kept.
- **W2 backend-guards**: `lib/internal_functions/system.js`,
  `lib/internal_functions/db.js` (app_settings policy only), the vocabulary
  write routes (`routes/api.fieldDefs.js`, `routes/api.calendarTypesAdmin.js`,
  `routes/api.pipelineAdmin.js`, `routes/api.contactRoles.js` — the
  contact-role-TYPES writes only), the retired flags' readers
  (`lib/firmConfig.js`, `services/eventService.js`, `services/apptService.js`,
  `services/esignWebhookService.js` — flag code only), NEW
  `tests/settingsInventory.test.js`, their tests, and
  `manual/03-YisraFlow/05-internal-functions.md` (set_setting / get_setting /
  get_settings / update_db text).
- **W3 firm-tab**: NEW `public/js/ycSettingRows.js`, `public/caseconfig/firm.html`,
  their tests.
- **W4 my-settings**: `public/settings.html`, its tests.
- **W5 config-shell**: `public/caseConfigManager.html`, `public/caseconfig/types.html`,
  `pipelines.html`, `fields.html`, `calendarTypes.html` (read-only mode only),
  PLACEHOLDER `public/caseconfig/lists.html` and `public/caseconfig/system.html`
  (minimal pages that follow the sub-page protocol; a later lane replaces
  them), their tests.
- **W6 tool-homes**: NEW `public/caseconfig/contactRoles.html` (the Contact
  Roles editor ported out of settings.html), `public/portaladmin/portalSettings.html`,
  `public/ctaManager.html` (defaults block only), their tests.
- **W7 (phase 2, later)**: the real `lists.html` and `system.html` on
  `public/js/ycSettingRows.js`.

## 3b. The Config read-only handshake (W5 builds the shell side; every Config sub-page honours it)

- The Config shell (`caseConfigManager.html`) learns `can_edit_firm` and
  `can_edit_system` from ONE `GET /api/ui-config` (it already does this to
  reveal the Firm tab). It exposes, on its own window (sub-pages call it `P`):
  `P.configCanEdit` — a getter returning `true`, `false`, or `null` (not known
  yet / the probe failed). Sub-pages treat anything but `true` as READ-ONLY
  (fail closed for the UI; the server is the authority either way).
- When the answer arrives (and for a sub-page that loads after it), the shell
  calls the sub-page's `window.onAccess({ canEdit })` if defined. A sub-page
  applies read-only at init from `P.configCanEdit` AND re-applies in
  `onAccess`.
- Read-only means: every control that WRITES is disabled or hidden (inline
  inputs, add / delete / reorder / toggle buttons, drag handles), navigation
  and viewing still work, and the shell hides the topbar Save / New / Delete
  and shows a one-line banner: "Read-only — changing YisraCase Config needs
  the admin permission." Tests dispatch clicks / inputs on the RENDERED
  controls and assert no write call reaches apiSend.
- The Firm tab (gate `firm`) and System tab (gate `system`, revealed by
  `can_edit_system`) stay hidden from non-holders; read-only never applies to
  them.

## 4. Gates (CLAUDE.md, restated — they are not optional)
- `node --check` every modified JS file and every inline `<script>` block you
  touched (extract it).
- New test assertions are MUTATION-CHECKED: break the code, watch the test
  fail, restore, prove the tree is clean (`git diff --stat`). Report the
  mutations you ran and their results.
- No mocking the module under test; real-engine harnesses preferred (jsdom
  for pages: the repo has many `tests/*.test.js` that load a page into jsdom —
  copy their harness).
- Scripted edits are anchored: `assert src.count(old) == 1` before every
  replace, and verify the new text is on disk before committing.
- The Bash tool may run zsh: never word-split an unquoted `$VAR` list.
- Run your lane's tests plus every existing test file that names a file you
  touched (`grep -l <file> tests/*.js`). Do NOT run the full suite: six lanes
  share one 4-core machine; the manager runs it at merge. Baseline at
  400e935: 407 suites passed, 38 skipped, 0 failed.
- UI: house patterns — theme tokens from /theme.css, labels/hints by CLASS
  (`.yc-flabel` / `.yc-hint` in panes that don't load style.css; AI_CONTEXT
  §12), never inline font/colour; an inline handler must not be named like a
  document/element member (write/open/close/clear…); `overflow` on a direct
  child of a flex column pairs with `flex: 0 0 auto`; phone widths 320–1200
  must not overflow horizontally (the manager runs the survey).
- Panes reach the shell through `window.parent` / `P.apiSend`; panes never
  read the token.
- Post-commit side effects / transactions per CLAUDE.md.
- SQL mode is relaxed; MySQL JSON reorders keys — compare key-order-insensitively.

## 5. Report (your final message — the manager reads ONLY this)
1. Branch + commit SHA(s); `git diff --stat 400e935..HEAD`.
2. What you built, per spec item; anything you did NOT build and why.
3. **Judgment calls** within spec latitude — each one explicit.
4. **Structural divergences** from this spec — if any, you should have STOPPED
   before building on them; say what you found.
5. Tests: files added/changed, counts, the mutations you ran.
6. Doc deltas for the manager (file + section + what is now false).
7. Anything another lane must know (e.g. a field a UI lane relies on).
