# YisraCase Plans & Future Ideas

Living doc. Deferred work, design ideas, and known cleanups — not active development. Move to a session/slice plan when you actually start.

---

## Settings vs Config (2026-09-24)

Two operator surfaces, ratified:

- **My Settings** (settings.html, slimmed): personal — account, password,
  signature.
- **YisraCase Config** (caseConfigManager.html, renamed from "Case Config"): every
  firm-wide vocabulary editor as a first-class tab — types/subtypes, pipelines,
  calendar types, custom fields (CFG-1), contact roles (CFG-2), eventually contact
  relation types. Rule of admission: **Config gets definitions that have no manager of
  their own** — checklists and form templates are content with their own authoring
  surfaces and stay there. One editor per setting, never two (CFG-1 deletes the
  settings.html Case Types editor: it writes fe-case_types with no usage check or
  template repoint, unlike caseconfig/types.html — a live footgun, not just clutter).

PENDING (parallel session; do not bake in):
- CFG-3: which app_settings category sections move into the Config shell's **Firm**
  tab (it exists since ui-custom S3.2: public/caseconfig/firm.html, a host of
  sections shown on GET /api/ui-config `can_edit_firm`; Launcher is its first
  section), and how tool-grouped settings split between tool managers and that
  tab. The role tier exists: since access A4, PUT/POST /api/app-settings* are
  `requireAuth({audience:'staff', can:'firm.settings', allowApiKey:true})`
  (routes/api.appSettings.js; GET stays jwtOrApiKey; per-row `is_editable` still
  applies), so moving knobs into the Firm tab needs no new gate.
- Machine-state rows (sweep watermarks, counters, rc_subscriptions…) are a fourth
  kind — automation-minted runtime state hiding behind is_editable=0, which ALSO means
  "SU-only boundary" (landing_hosts). Likely: separate flag + read-only diagnostics
  view. Don't design against is_editable semantics meanwhile.
- Collision, settled (Fred, 2026-10-15): the ui-custom firm editor and the Config
  shell are ONE surface — the Config shell's Firm tab. ui-custom owns its Launcher
  and Who sees what sections (the latter is the entitlements editor: per-user
  denies, plus role scoping through ui_config `visible_to` — ui-custom S3.4); the
  settings arc adds its own sections there.

---

## YC 3.0 direction (2026-09-14)

Early direction only — v2 work continues; nothing here is active development.
Direction being explored: a domain-agnostic platform; multi-tenancy is a v3
maybe at most — explicitly not v2. Generic architecture, vertical
go-to-market (legal first). Principles, not commitments.

- **Customization moves from code to data.** This is the real v3 shift, more
  than tenancy. Every customizable feature = schema-validated config + a
  renderer/executor, versioned with undo. Forms renderer, settings, views,
  and trigger rules already fit this shape. "Ask AI" buttons then come nearly
  free: AI emits config that must pass the validator — never code or raw SQL.
  Inner-platform guard: only make configurable what a real second tenant
  demonstrably needs; hardcode the rest until proven.
- **Terminology is a display layer.** case/matter/sale/order is a per-tenant
  label map in settings. No schema renames; tables stay `cases`.
- **Tenancy model: DB-per-tenant — RATIFIED 2026-10-05.** Full design,
  invariants, phases, and open decisions live in the dedicated "YC 3.0 —
  Tenancy plan" section below. Supersedes the tenant_id-column item under
  SaaS-readiness below.
- **Evolve, don't rewrite.** Strangler: make v2 progressively v3-shaped
  (terminology layer, config-as-data subsystem by subsystem, event-bus
  unification), 4LSG as tenant zero; tenancy extraction happens only if/when
  a real tenant #2 exists. Corollary: MySQL stays. Postgres only becomes
  right if a fresh codebase ever wins (RLS, JSONB indexing, transactional
  DDL, native schemas).
- **Automation unification: one event bus.** Everything emits events;
  triggers subscribe; tasks/sequences/workflows are just subscribers. Kills
  the "multiple ways to cause things" confusion.
- **Tenant-defined fields:** JSON column + field-definitions table + indexed
  generated columns for hot fields. Never EAV. Design ratified 2026-09-22
  → `ref/CUSTOM_FIELDS_DESIGN.md` (living doc; v2 pilot S0–S6 shipped, S5-B's column drops included).
- **Billing (unbuilt): agnostic core** — billables → invoices → payments,
  processor drivers. Flag: trust accounting (IOLTA) is the one genuinely
  non-generic legal requirement — table stakes for the legal vertical,
  skippable elsewhere.
- **Driver pattern extends** beyond SMS/email/calendar (SaaS-readiness below)
  to payments, storage, e-sign, telephony.
- **Tools / landing-pages origin ruling (2026-10-05, supersedes the earlier
  "sandboxed plugin surface" note).** SU-authored tool pages stay same-origin
  with the existing `P.apiSend` contract — no sandbox, no postMessage bridge.
  Invariant: **tool authoring = root within the tenant** (a top capability in
  the access-control arc, never a mid-tier role); if authoring ever opens
  below SU, that content moves to the pages treatment. Any-user-authored
  landing pages serve only from the sessionless **pages origin** (Tenancy
  plan below) — the generalization of today's landing_hosts/pageLanding
  origin split (`routes/pageLanding.js:314-336` documents the security
  property to carry over).

---

## YC 3.0 — Tenancy plan (ratified 2026-10-05)

Ratified design + sequencing, **not active development**. Grounded in
`ref/AUDIT_TENANCY.md` (read-only repo audit, 2026-10-05, combined v2) — read it
before working any slice; its §1 carries the file:line-level P0 slice list.
External reviews were consulted 2026-10-05; in-house architecture knowledge
trumps them where they conflict.

**Direction.** One MySQL server → one database per tenant (identical base
shape) + a `yc_master` control plane → tenant resolved by hostname → auth
independently verified against that tenant. 4LSG is tenant #1 with zero
behavior change; **app.4lsg.com never stops working** — it is simply the first
custom (vanity) host, supported from day one. Rejected alternatives:
shared-schema `tenant_id` (invasive rewrite of a codebase whose queries are
already tenant-correct via `req.db` — audit: 0 db-qualified SQL, 0 service-level
pool captures — plus a missed-WHERE catastrophic failure mode); Postgres
(engine migration with no demonstrated payoff; the custom-fields design is
MySQL-native).

### Invariants (copy into every tenancy slice spec)

1. **Hostname selects tenant context; authentication never switches it.**
   Mismatched host + token/key/session = 403, never a redirect. The resolver
   trusts the GFE/LB `Host` header only; `x-original-host` is honored solely
   when accompanied by the fronting Worker's shared-secret header — otherwise
   it is a client-spoofable tenant selector on public routes.
2. **Tokens carry a tenant binding verified against the resolved tenant**
   (P0-7). JWT `sub` is a bare per-tenant integer and means nothing without it;
   external identity is `(tenant_id, user_id)`, never a bare id.
3. **`yc_master` is control plane only** — no business data, ever.
4. **No connection is created outside the tenant DB module.** `getDb()` takes a
   validated internal tenant object from the registry — never a
   client-supplied hostname/slug/db-name string.
5. **Unknown, disabled, or mismatched host = hard failure.** No fallback to
   4lsg; no default tenant once the registry exists. Legacy queued jobs get a
   bounded, dated compatibility path, then it is removed.
6. **Every async entry (job, Cloud Task, cron tick, webhook) carries explicit
   trusted tenant identity** — URL path/header or trusted envelope, never
   request-body data. Idempotency keys and task names are tenant-prefixed.
7. **Schema changes happen only via versioned migrations** (id + checksum +
   per-tenant applied ledger; canary order 4lsg → demo → rest; expand → deploy
   → migrate → contract — DDL implicit-commits, so no pretending a migration
   file is one transaction). `ref/database.sql` is demoted to generated
   snapshot/provisioning accelerator. 4lsg's schema is **baselined, never
   recreated**. Drift check compares each tenant DB against **its** expected
   schema = base migrations + the generated columns derivable from its own
   `field_defs` manifest — never tenant-vs-tenant (custom fields make physical
   schemas legitimately diverge).
8. **Provisioning requirements** (audit §E5): relaxed sql_mode (no
   STRICT_TRANS_TABLES / ONLY_FULL_GROUP_BY / NO_BACKSLASH_ESCAPES — MySQL 8.4
   defaults are strict and break `listCases` + `cases` inserts on day one);
   `utf8mb4_bin` on `documents.external_id` and
   `case_folder_cache.folder_external_id`; triggers created by the permanent
   migration/provisioning account with DEFINER clauses stripped on import, so
   that account is the definer everywhere (ruled 2026-10-05 — open decision 1
   has the inventory); `log_bin_trust_function_creators=ON` as a server flag;
   the dead `test` table and its 2 triggers are excluded from tenant
   provisioning (13 triggers / 6 tables ship). Provisioning is restartable;
   tenant stays non-active until schema + credentials + config + first admin
   all succeed. Never copy live
   4lsg settings/credentials/users as "defaults".
9. **Credential isolation is staged.** `tenants.credential_ref` exists from day
   one (initially all rows → one account). Per-tenant MySQL users (GRANT only
   on own schema) and per-tenant genuinely-read-only users for
   `/api/readonly/sql` are a **prerequisite for the first paying tenant**.
   Registry lookups use a separate narrowly-privileged master connection;
   migration credentials never ride request execution.
10. **Tool authoring = root within the tenant** (see the origin ruling above).
    The pages origin issues no sessions and serves no token-minting routes.

### Registry (`yc_master`)

    tenants:      id (immutable), slug, db_name, status, db_cluster_id,
                  credential_ref, created_at
    tenant_hosts: hostname (UNIQUE, normalized), tenant_id,
                  role app|pages, type platform|custom, status, verified_at

Day-one rows for 4lsg: `app.4lsg.com` (app/custom — unchanged behavior),
`4lsg.yisracase.com` (app/platform), `4lsg.p.yisracase.com` (pages/platform).
Label order matters: tenant label directly under `p.` so **two wildcard certs
cover everything forever** (`*.yisracase.com` + `*.p.yisracase.com`; wildcards
match one label — `p.<slug>.yisracase.com` would need a cert per tenant).
Vanity/custom domains are direct host bindings (CNAME, or A/ALIAS for an apex)
with their own managed cert — never redirects. Current state
(registrar-verified 2026-10-05): `app.4lsg.com` (CNAME
`ghs.googlehosted.com`) and the `4lsg.com` apex (Google anycast A/AAAA set)
are both direct Cloud Run domain mappings, no proxy/CDN in front — and
`4lsg.com`/`www.4lsg.com` are already `landing_hosts` rows (pages role in
today's terms) with dead-ends redirecting to `fe-firm_site_url`. Front door:
direct Cloud Run domain mappings are a dev/demo compromise only (Preview, not
production-recommended, no wildcard certs); HTTPS LB + Certificate Manager
DNS-auth wildcard certs (~$18/mo) before paying tenants — rides the
funding-gated productionization wave with Cloud SQL.

### Identity ruling

Per-tenant users for the transition; **global identity deliberately deferred**
with stable identifiers preserved — not assumed free later. Guardrails now:
`(tenant_id, user_id)` everywhere outside a tenant DB; email is never a merge
or identity key; operator/support access is a separate audited
explicit-elevation workflow (strong auth, explicit tenant selection,
time-limited), never a bypass account.

### Phases (each a no-behavior-change deploy for 4lsg; audit §1 has slice detail)

- **P0 — chokepoint + tenanting groundwork.** P0-0 delete
  `routes/db64.js`/`dbQuery.js` (check `legacy_route_log` first) → P0-1
  resolver middleware (seat: ahead of `pageHostMiddleware`, `server.js:135`;
  copy the spoof-resistant host-candidate union from
  `pageLanding.js:314-336`) → P0-2 `getDb`/`getRoDb` registries (preserve the
  retry wrappers + bound `withTransaction`) → P0-3 flip `req.db` → P0-4a–e the
  boot consumers (appBuild, pageLanding closure, observers, process guards →
  platform alert sink, init/reconciler loop) → **P0-4f firmConfig tenanting —
  the real P0** (39 consumer files, synchronous `cfg()`; AsyncLocalStorage
  tenant ambient, precedent `lib/domainEvents.js:99`; its own sub-arc; also
  closes the cross-tenant `yci_` acceptance) → P0-5 tenant-key the ~24
  process-global caches, auth-critical first (`lib/apiKeys.js`, `update_db`
  schema cache, `fieldDefService`) → P0-6 tenant-suffix the 5 `GET_LOCK`
  names → **P0-7 token tenancy — must land before any second tenant exists**
  (tenant claim in staff/portal/elevation JWTs + the uploadTicket/booking
  HMACs; `JWT_VERSION` scoping) → P0-8 Cloud Tasks/cron tenanting (tenant in
  dispatch path/header, tenant-prefixed task names, envelope field at
  `lib/domainEvents.js:184`, the 3 `process_jobs` handlers) → P0-9 scripts
  gain `--tenant`. The former P1/P2 (registry, pools) are absorbed into
  P0-1/P0-2.
- **Isolation completion — prerequisite for any usable tenant 2.** Per-tenant
  integration credentials (the audit's ~27 CRITICAL flush items: Dropbox
  credential 8 + 4 folder paths, Google credential 11 + `'primary'` calendars
  + user ids 1/5, pinned proxy credentials, `@4lsg.com` from-fallbacks,
  `api.sending.js` client-comms hardcodes, and the firm assumptions INSIDE
  trigger bodies — `after_contact_update` hardcodes
  `CONVERT_TZ(NOW(),'UTC','America/New_York')` and `log_by = 1`),
  FIRM_TIMEZONE parameterization (6 module captures + frontend
  `America/New_York` false-parity comments), GCS/storage scoping, legacy-route
  retirement (`trap()`-tracked), per-tenant MySQL + RO users, and a
  **two-tenant staging fixture with deliberately colliding user/contact/case
  ids + a cross-tenant isolation test suite** (mismatched hosts, keys, tokens
  — not just happy path).
- **Demo tenant** (synthetic data; external side effects disabled or
  sandboxed) → **tenant-only restore drill** (Cloud SQL PITR restores an
  instance, not a schema — write and exercise the restore-aside → extract →
  import procedure, files included) → **LB front door** → first external firm.

### Prerequisite arcs (finish before tenancy implementation starts)

Custom-fields pilot (supplies the per-tenant schema manifest, invariant 7),
settings/config split (defines what provisioning seeds — audit §B4's 48
firm-config keys are the raw inventory; no single registry enumerates the
settings surface today, which is itself a finding), access-control arc
(roles/membership = the auth half of invariant 1-2; scoped keys = webhook/RO
tenant binding). Infra intent, **gated on funding approval**: Cloud Run
`min_instances=1`. The Cloud SQL migration is done (2026-10-13,
`ref/archive/DB_MIGRATION_2026-10.md`), so the pool connection budget
(per-pool limit × max resident pools per instance × max instances) can now be
sized against the instance's real `max_connections` (4030); LRU machinery
deferred until the budget shows it's needed.

### Open decisions (audit §3; answer before the affected slice)

1. **RESOLVED 2026-10-05** (SHOW TRIGGERS pasted): 13 triggers definer
   `sgkmtgfarbwxw@localhost` (SiteGround primary user, still extant or writes
   would fail), 2 definer `uai6bp5cbi4ij@35.227.91.145` (`contact_name_*`,
   2026-09-08); per-trigger saved sql_mode is heterogeneous (3 variants) —
   harmless, but provisioning stamps the session mode at creation. Ruling:
   strip DEFINER on every dump/import; the migration account becomes definer
   everywhere and is permanent. **Applied 2026-10-13 by the Cloud SQL move:**
   `scripts/dbmigrate/dump.sh` strips DEFINER and all 15 triggers are now owned
   by the app's account (the definers above no longer exist anywhere). Still
   patch `lib/schemaDump.js` to record DEFINER + per-trigger sql_mode.
2. **RESOLVED 2026-10-12** — stored routines (§3-2): one unused function
   existed on the old server and was dropped before the Cloud SQL move; there
   are none now, and no events (`scripts/dbmigrate/parity.js` compares the
   count; `dump.sh` does not carry routines). 3. Shared MySQL server vs
   instance-per-tenant (§3-3; decides GET_LOCK + JSON_OVERLAPS-probe
   severity). 4. **RESOLVED 2026-10-13** — sql_mode provenance (§3-4): an
   explicit Cloud SQL database flag, per instance (`ref/INFRA_GCP.md` §7).
5. **RESOLVED 2026-10-05** (registrar records): no proxy in front of either
   host — both are direct Cloud Run domain mappings; Host arrives via Google's
   front end. `x-original-host` applies only to any Worker-fronted landing
   domains and is trusted only per invariant 1. 6. Grants model + per-tenant
   RO users (§3-6). 7. Cron fan-out: per-tenant Cloud Scheduler jobs (lean, at
   low N) vs platform fan-out endpoint (§3-7). 8. Is `CLOUD_TASKS_TARGET_URL`
   set? (§3-8 — if set, it pins dispatch to one host). 9. Queue topology:
   lean single `yc-jobs` queue + tenant-prefixed names at low N (§3-9).
10. `JWT_SECRET`: lean shared-secret + tenant claim (simpler rotation,
    upgradeable to per-tenant later); same ruling pass for
    `CREDENTIALS_ENCRYPTION_KEY` (§3-10). 11. Live Cloud Run env inventory
    (§3-11). 12. **RESOLVED 2026-10-15**: not built as a landing page — it
    was the concept that motivated SU landing pages. Storage
    (`app_settings.clio_login_code`) and authed `GET /clio-code` exist. Firm
    custom actions are SU-authored tool pages placed as firm launcher items
    (ui-customization arc, S3.3): Get Clio Code is the tool `clio-code`
    (reference copy `ref/tools/clio-code.html`) on the token-free tool shell
    API (`window.ycTool`; `manual/08-Admin-Tools/11-tool-actions.md`). The
    declarative launcher **action** kind was dropped (2026-10-15): config
    cannot cover the permutations firms ask for. The shell's own Get Clio
    Code tile and `showClioCode()` retired once the tool was installed
    (ui-custom S3.3b, 2026-10-15) (§3-12).
13. Heartbeat per-tenant vs platform (§3-13).
14. Provider-console webhook URL inventory at migration time (§3-14).
15. GCS per-tenant buckets vs prefixes (§3-15). 16. Freeze §B4's
    firm/platform key classification against the ratified settings/config
    taxonomy (§3-16). 17. External health probing; `/api/version` reads
    tenant data (§3-17 + §E4).

---

## From the access-control arc (2026-10-14) — deferred

- **jwt_api_audit_log retention** (~90 days): 134K rows / ~126MB since
  April, never pruned. Shapes-only since SEC-2, so this is size, not
  secrecy.
- **schemaDump views**: lib/schemaDump.js dumps BASE TABLEs only; `ai_spend`
  (the schema's first view) never reaches ref/database.sql and db:ref:check
  cannot see it drift. Its migration record is its definition of record
  meanwhile.
- **automations.manage siblings**: the capability gates only hooks (+ pages
  create-hook). Workflows / sequences / triggers / ingest management in the
  same Automation Manager stay open to all staff — a visible inconsistency,
  accepted as the first step.
- **Deny rows the Firm tab never shows** (ui-custom S3.4 review N4): Who sees
  what lists per-USER denies of items that exist. (a) A per-user deny of a firm
  item later deleted stays in `entitlement_denies` with no row to remove it from
  — harmless, since S4a `retired` means firm ids are never reused; clean such
  orphans up when an item is deleted. (b) role / firm deny rows written through
  the API (0 live 2026-10-16) still hide items while the editor says "Everyone"
  — add a read-only "also hidden by an older rule" note if any ever appear.
- **sbAdmin widening**: the Admin sidebar stays su-only until the first
  firm-grade admin tile exists (the CFG-3 firm tab) — then widen
  tile-by-tile, not by taxonomy.
- **Require scopes on new yck_ mints**: today omitted scopes = NULL =
  legacy full surface; flip to required once the existing integrations are
  scoped.
- **connections.html reads P.AUTH_STATE.jwt** (SU-guard fallback) — the one
  pane besides liveHost violating "panes never read the token"; drop the
  fallback and read firmData.currentUser.roles only. (Graduated from
  docs-debt 2026-10-14.)
- **Old referer header rows in jwt_api_audit_log**: SEC-2 shaped bodies and
  query_params; HEADERS were already write-redacted (SEC-1) but rows older
  than 2026-10-12 may still carry credential-bearing referers. The table is
  sensitive-tier-gated now, so exposure is to diagnostic keys only; a
  one-off header scrub is optional hygiene.

### Delegation addendum (D1–D3b, 2026-10-15) — deferred

- **Strict session-key mint TTL**: `POST /api/readonly-keys` still clamps an
  over-3-day ttl to 3 days and reads junk as "not given"; renew (D2) is
  strict (400). Make the mint strict too — a behaviour change, so its own
  slice.
- **Completion email wording for key-completed tasks**: when a `tasks.own`
  key completes its own task, taskService names the actor (the minter), so
  the minter is emailed "<minter> completed…". Name the key instead.
- **Comms task-to picker** (comms.html create-task-from-message) still lists
  inactive users — handed to the comms arc (S4) with the D3 pattern.
- **does_appts loss on scripts.js "Blocks calendar of"** is fixed (D3b keep-
  current is filter-agnostic); other pickers keyed on does_appts were not
  audited for the same silent fallback.

## From the ui-customization arc (2026-10-17) — deferred

(The arc's other leftover sits above, the Firm tab's unseen deny rows; the
workspace URL's deferred levels have their own entry further down.)

- **Per-role firm layouts.** `ui_config.role` is reserved (writes refuse
  anything but `''`), kept so a firm layout per role can slot in as one more
  step — shipped → firm → role → user — through the same merge rule, with no
  other change. Deferred while there was no role model; roles exist since
  access A2b/A3, so this is now a plain feature decision.
- **A framed outside page.** Links open a new window, never embedded; Fred
  will allow an embedded view only for a concrete need, and then only with a
  permanent banner naming the domain and saying it is outside YisraCase, a
  sandboxed iframe, and an automatic new-window fallback for sites that
  refuse framing.
- **Firm items opening as a tab.** A user's own tool / view button may open in
  the button tab (`present:'tab'`, S5c-b); a firm item is modal-only — the
  validator refuses `present:'tab'` at the firm tier ("not available yet",
  `lib/uiConfigShape.js` TAB_NOT_YET). Lifting it: accept it in the firm's
  ACTION_SHAPES, an "Opens in" choice on firm.html's tool / view rows, and
  `exec`'s firm path handing it to `window.ycButtonTabs` like a user's.
- **Retire `data-exclusive-group`.** Since S6c-4 the drill is page-scoped
  (`closest('.tab-main')`), and nothing reads the attribute; the launcher's
  mount still writes it on every panel tile and `ensureStrip` copies it onto
  each pill, and `public/js/ycAll.js`'s header still says the drill machinery
  uses it. Drop the attribute, the pill copy and the stale comments
  (`featureRegistry.js`'s `target, group` note too). Inventory by both
  spellings, `data-exclusive-group` and `exclusiveGroup` (the dataset form).
- **Page entries whose page is gone** (S6c-5 review). Deleting a firm page
  item in firm.html, or changing its kind, leaves its `layout.pages['firm:…']`
  entry: the firm editor carries entries it has no page for as stored, and
  the shell ignores them. `retired` means such an id never comes back, so it
  is harmless, but each one counts toward the 50-key cap (a firm that fills
  it can no longer save its layout) and History's View lists it by raw id.
  The same holds for a user's page button changed to another kind (a deleted
  one cascades). Fix: each editor drops, at its next save, the entries whose
  key is not one of its pages — accepting that a button changed away from a
  page and back starts empty.
- **The survey shoots one panel on two hubs once.** `survey.js`'s panel loop
  lists `#tabMore > [data-target], #tabAdmin > [data-target]`; a panel the
  firm layout puts on both hubs (Users, in the fixture since S6c-1+2) is
  recorded twice as `panel:usersDiv`, and the second shot overwrites the first
  (`panel_usersDiv`). Name the hub in the key and the shot when it is not the
  panel's own.
- **S6c-3 review nits** (the firm layout editor, 2026-10-16):
  - *A "Locked for users" tag in firm mode.* Firm mode edits with
    `locked: []` by design (the firm is not locked against itself), so the
    firm can hide one of its own locked items (e.g. `bills`) from the default
    Home, and every user who hasn't arranged Home loses it. Coherent, but a
    tag on those rows would stop a surprise.
  - *Pin `placeErrors`' unknown-section guard.* No test sends the PERSONAL
    editor a 400 naming `placed.homeIcons` (a section it doesn't show), which
    must land in the banner, not throw (`public/js/ycLayoutEditor.js`).
  - *Make `tests/helpers/uiConfigStore.js` reorder JSON keys on write*, as
    MySQL does (CLAUDE.md: a dry-run store must store JSON the way MySQL
    does). A deep key sort is enough; the S6c-3 reviewer showed the launcher
    suites already pass that way.

## SaaS-readiness (deferred indefinitely)

Abstractions that would matter for offering YC to a second firm. Not relevant to 4LSG-only operation. Each can be picked up independently when a second customer is real.

- **Provider driver abstraction (SMS / email / future channels).** Pluggable per-line driver layer with a registry, dispatcher, and template-driver hook for non-quirky providers via a `provider_templates` DB table. Design doc shelved in `ref/SMS_DRIVER_ARCHITECTURE_DESIGN.md`. The auth half is being collapsed into the existing services as a separate, smaller refactor (Quo and RC `services/*Service.js` migrating to `buildHeadersForCredential`); the dispatch/registry/template work is what's deferred.

- **Calendar abstraction.** `services/calendarService.js` is currently hardcoded around Jewish holidays + Shabbos via Hebcal. Replace with a generic `blocked_dates` table (and possibly a `block_rules` source-table for recurring rules like "every Saturday" or "Hebcal feed for org X"). Per-firm operators populate it through Connections UI.

- **Public-page templating.** `/public/*.html` is hardcoded with 4LSG branding, logos, copy. SaaS deployment would need a template layer (Handlebars or similar) reading per-tenant config — name, logo URL, color tokens, custom domain. Custom-page authoring is an entirely separate problem deferred even further.

- **Multi-tenancy decision.** Even if you stay one-firm-per-deployment, decide before any of the above whether `phone_lines`, `email_credentials`, `credentials`, `contacts`, etc. get a `tenant_id` column. Adding it to clean tables now is cheap; retrofitting later is expensive. Plausible within ~2 years → add as `NOT NULL DEFAULT 1` now. **Decision 2026-09-14: hold — do NOT add tenant_id columns.** Multi-tenancy is not happening in v2 and is only a maybe for v3, where the lean is DB-per-tenant (no tenant_id columns needed either way). **Ratified 2026-10-05: DB-per-tenant confirmed — see "YC 3.0 — Tenancy plan" above; the tenant_id hold is permanent.**

---

## In-flight migration

Active surfaces with known next steps.

- **Phase 6: iframe conversion of remaining `index.html` tabs.** Iframe boot pattern is established (`(function waitForParent() { if (P.apiSend) return init(); setTimeout(waitForParent, 100); })();`). Continue tab-by-tab.

- **JotForm swap in `case.html`.** Smart fallback is currently in place. Replace with internal YisraForms versions once ISSN and Detailed Questionnaire are built.

- **Remaining YisraForms.** ISSN (tabs + repeaters, snapshot mode) and Detailed Questionnaire (JSON-only storage, most complex). The biggest remaining YisraForms work.

- **Legacy frontend retirement.** `index.html` IS the current shell and is not
  going anywhere — `a.html` never shipped, and the v1/v2 split it implied does not
  exist. What is actually queued for retirement: the pre-iframe panes the shell
  still loads directly (`case.html`, `contact.html` and the Phase 6 stragglers),
  and the `/db` raw-SQL endpoint (`routes/dbQuery.js`). These come out as Phase 6
  converts each pane; the security cleanups below are blocked on that, not on a
  shell swap.

---

## Feature plans

- **Opt-out system.** Four-step plan: (A) contact form toggles, (B) warn-but-don't-block on direct sends (Swal confirmation), (C) opted-out badges, (D) inbound STOP handler via YisraHook.

- **Image library refactor.** Picker, upload dialog, delete, and the "Save to library" checkbox are duplicated across `campaign.html`, `communicate.html`, `sendingform.html` (some with `sf` prefix to avoid collision). Extract to a standalone iframe-loadable module — e.g. `/js/imageLibrary.js` exposing `imageLibrary.pickImage()`, `imageLibrary.uploadDialog({ accept, maxMB })`, `imageLibrary.deleteImage(id)`. Each consumer drops in a `<script>` tag and gets consistent behavior. Bundle these into the refactor:
  - **File-type gating.** Email-attachment dialog (`campaign.html` ~line 1030) accepts PDFs/docs and offers "Save to library" — currently inserts the row but renders as a broken `<img>` in the picker. Either gate the checkbox to `image/*` MIME types, or rename the column/feature and teach the picker to render non-images with a file-type icon.
  - **Pagination + lazy loading.** `/api/image-library` GET has no `LIMIT`; picker renders every row eagerly with no `loading="lazy"`. Fine at current volume; add `loading="lazy"` + `LIMIT 100 ORDER BY created_at DESC` when the picker starts feeling slow (~50–80 images is where UX degrades).
  - **Search/filter.** Client-side filter by `original_name` once volume justifies it.

- **YisraHook v1.1.** Sync response, custom response shape per route, log retention policy.

- **Comms hub send — after v1 (mailbox S3, 2026-10-11; design §4.2 "As built (S3)").** Left out of v1 on purpose:
  - **Attachments** (compose + forward). Forwarding a stored message's files must use the API's `inline` flag, never `cid` (AI_CONTEXT §0). Bodies are plain text in v1 (the server builds the HTML).
  - **Forward**, **server-side drafts** (the pane keeps one in memory per page), **scheduled send**, **signature management** (v1 uses the send credential's own signature, only when its address is the box's).
  - **Reply-To** is not captured at ingest, so replies go to From. Capture it (a `mail_messages` column) if a list/no-reply sender makes that wrong in practice.
  - **Budget query cost**: the per-transport COUNT walks every `email_log` row of its `source` (ref on `ux_email_log_source_message`; ~1.7k gmail rows at ship). Add `(source, processed_at)` if outbound volume grows ~10×.
  - **Alias slice cost** (S3-R): each readable alias box's summary count (every Comms open, every 5-min badge refresh, every mark-read) and view count walks ALL of its parent's rows through the label/LIKE/REGEXP slice predicate (EXPLAIN live 2026-10-12: ref on mailbox_id, 157 rows). Fine at hundreds/thousands; if the parent grows into the tens of thousands, a multi-valued index on `gmail_labels` (`CAST(gmail_labels AS CHAR(255) ARRAY)`) serves the label half, and the address half can move to a stored `mail_messages` address list or a per-alias membership table filled at ingest.

- **Comms polish — after S2P (2026-10-13; design §4.4 "As built (S2P)").** Left out on purpose:
  - **Task → email deep link**: the task created from an email (§E) does not link back to the message; needs a task link type or a URL scheme into the hub (and the hub's side: open-by-message-id deep link). Decide with the chat/deep-link work.
  - **Shared-inbox assignment / "done"** — design doc FIRST (coordinate with phone read state: both are "conversation state", per-user vs per-box semantics must be decided together). OQ4's attribution (mail_sends) is built; assignment is not.
  - **A.4 retirement item — the one-time bridge UPDATE**: 57 live mailbox-2 rows (2026-10-13) are on the log through the Apps Script source but carry no `mail_messages.log_id` stamp, so `has_case`/`no_case` filters and viewCounts miss them while the S2P log-status line shows them bridged. At the Apps Script retirement (parity window close, ~2026-10-25), run the one-time stamp backfill (`UPDATE mail_messages m JOIN email_ingest_executions e ... SET m.log_id = e.log_id WHERE m.log_id IS NULL` keyed the priorLogId way) — then the filters agree with the display. Window rule forbade it in S2P.
- **Comms phone tab — after v1 (S-PH, 2026-10-12; design §4.4 "As built (S-PH)").** Left out of v1 on purpose:
  - **Shell gate for phone-only users** (ruling 2026-10-12): the sidebar Comms entry and Home button show only when the user can read ≥ 1 mailbox or holds a mail `can_send` (`index.html` `commsBadgeSet` / `commsBadgeRefresh`, fed by `GET /api/mail/mailboxes`). A person whose only grant is on a PHONE line never sees Comms. Every phone user at launch already reads a mailbox. Fix with the phone unread/badge work below (same shell code): count readable lines (`GET /api/phone-lines/readable`) into the show decision.
  - **Unread / badge counts** for texts and calls (per-user read state, like `mail_read_state`); the Phone tab shows no counts today.
  - **MMS send** (lines with `mms_capable`), **per-line / per-user send budgets** (only the per-user 30 / 10 min limiter exists, per instance), **outgoing calls**, the **phonebook** add-in (S-PB).
  - **A credential slot on RC voicemail rows if a second RC credential ever appears** (comms archive S1c, 2026-10-14). RC voicemails (`comms_media.source_table 'rc_message'`) have no call row, so the media sweep fetches them with THE one RC credential in `phone_lines`; with two it parks them and alerts "ambiguous" (`services/commsArchiveMediaSweep.js`) rather than guess. The fix then is to record the listing credential on the row at discovery (a column, or a per-credential source_table).
  - **Comms archive admins → a `users.roles` capability when the roles arc lands** (comms archive S1b, 2026-10-14). Interim per Fred's R9 ruling: `app_settings comms_archive_admins` (CSV of users.user ids, SU console only, seeded `1`). The swap is one function: `services/commsArchiveAdmin.isArchiveAdmin`.
  - **A release route for over-cap transcriptions** (comms archive S2, 2026-10-14 — deferred to S4, which owns `routes/api.commsArchive.js`). A call over `comms_stt_max_min_per_call` is skipped `over_cap`; until the route exists an SU releases it from the db console (the UPDATE in `ref/COMMS_ARCHIVE_DESIGN.md` §6.5 and `manual/08-Admin-Tools/09-comms-transcription.md`). The service function is `services/commsTranscribeSweep.releaseCap(db, id, {userId})`; the route adds the `isArchiveAdmin` gate, a reason, and the `release_cap` audit action (§7).
  - **Phrase search for transcripts** (comms archive S6, 2026-10-14 — deferred by ruling). `POST /api/comms-archive/search` AND-s word prefixes; quotes are dropped like any punctuation. A phrase term would be `+"w1 w2"` built ONLY from tokenized words (never the raw text) — and InnoDB matches a phrase only when every word in it is indexable (3+ characters, not a stopword).
  - **Restrict / purge per CALL (all recording parts), or cascade to sibling parts** (comms archive S4, 2026-10-14; manager ruling on J4). A call can hold more than one recording (`comms_media` rows split from one placeholder — Quo can list several per call, RC sessions too); the hub shows parts 2+ as "Part 2…" Listen buttons that follow the call's visibility, but Restrict / Purge act on ONE row and `setRestricted` cascades only to `stt_raw` children — restricting part 1 leaves part 2 readable. 0 multi-part calls live at S4.
  - **Comms archive health → its own Admin tile** (comms archive S4, 2026-10-14). The SU health read (`GET /api/comms-archive/health`) is a collapsed section of the System Alerts pane for now: the Admin grid's comms row (`public/js/featureRegistry.js`, "short by design until the comms hub's phone/phonebook admin tiles join it") was being reshaped by the access-control arc (A5 entitlements) at the time. Give it a tile of its own once that settles — file an `fred/admin_surface_coord` entry first (launcher surface).
  - **Per-contact activity flow** (Fred, 2026-10-12 — its own story, not the comms hub): on the contact page, one timeline of everything with that client — calls, texts, email, meetings — in time order.
  - **RECORDING-cue precision** (comms summary v4.2, 2026-10-16 — accepted residuals; the cues are live-measured as they stand: 0 false no-speech skips over all transcripts). `RECORDING` (`services/commsSummarizeSweep.js`) still (1) matches a receptionist's "Please leave your name and number and a brief message and he'll call you back" — this suppresses only the guided retry for that speaker, and the no-speech gate drops just that sentence; (2) misses a comma-less menu, "for billing press 1" / "to send your message press 1" — a needless summary, the safe direction; (3) misses a first-person recorded greeting "If I don't answer, please leave a message and I'll call you back" — the conditional exclusion meant for a caller's own words; also the safe direction. Any change re-runs the live gate measurement before it ships.
  - **Editable derived text** (Fred, 2026-10-13, deferred — not in the comms-archive arc's slices): let a user correct a transcript or rewrite a summary. Needs an edited-by/when stamp, the edited version winning over the AI text in display and FULLTEXT search, and a story for how it sits with the "AI-generated — check the recording" label (COMMS_ARCHIVE_DESIGN R8).
  - **Conversations-list query cost.** `listConversations` reads EVERY row of the line through `idx_phone_event_line` on each page (`event_type` / `suppressed` filter after the lookup; HAVING filters the aggregates, not the walk). Live 2026-10-12, line 1: 6.6K index rows, 801 groups, 15.7 ms (13.5 ms when the list was texts-only — calls joining cost only the bigger aggregate); every other line < 1.4K rows. **All numbers** (`listAllConversations`) groups every row of every READABLE line the same way: live 2026-10-12 for the SU (18 lines) 9.3K rows → 1,648 numbers, 20.7 ms; its merged call log walks `idx_phone_event_processed_at` backward (0.4 ms) and a merged thread `idx_phone_event_other_party` (0.2 ms). If a line grows ~10×, keep a per-line-per-number summary row (last id, count, lines) maintained at ingest, or page on a `(line_number, other_party)` index.
  - **Phone search query cost** (slice PS, 2026-10-14). `?q=` adds one predicate to the four list reads (`other_party LIKE '%digits%' OR other_party IN (…) OR id = ?`) and runs up to three matchers first — the two name matchers, and for digits (bare or `#`) the ref matcher's PRIMARY-key lookup (a const read; live 2026-10-15 4–5 ms, the endpoint's floor). Live 2026-10-14 (10.7K rows, 5 active / 20 lines): contact matcher 10–11 ms (scans `contacts`, ~1.1K rows), case matcher 9 ms (scans `cases`, ~1.1K), All-numbers list 24–27 ms (scans the log), one line's list 24 ms (forced `idx_phone_event_line`). The one that grows with the log: the merged **call log** with a RARE match walks `idx_phone_event_processed_at` backward to the end — 39–42 ms for 0 rows. If the log grows ~10×, give the number matcher an index it can use (a reversed-digits or suffix column for `LIKE 'x%'`), or drive the search reads from `idx_phone_event_other_party` with the matched number list.
  - **Pending-bubble echo** (S-PH review note): a text sent from the pane is "waiting" until a matching outgoing text arrives no earlier than a minute before the send, by the CLIENT clock. A staff machine more than a minute fast keeps a stuck "waiting" bubble beside the real one until reload; a lost webhook echo keeps it forever (no expiry). Fix: match on the send response's provider id once the ingest stores it, or expire pending bubbles after the last re-check.
  - **Suppressed-events viewer** and an **orphan view** (events on numbers that are not `phone_lines` rows — 976 live rows at ship, 538 of them inbound calls to one RingCentral number; registering a number as an INACTIVE line makes it readable without making it sendable).
  - **SU step-up asymmetry:** the hub's `POST /api/phone-lines/:id/sms` asks an SU for step-up (the mail-send rule); the staff `/internal/sms|mms/send` path does not (S-PH kept that path's behaviour and added only the grant check). Align one way or the other if it matters.
  - **Grants UI for non-SU managers:** phone-line Access lives on the SU-only Connections pane; a `can_manage` holder can use the API but has no screen (same gap the mailbox grants had).
  - **Admin access for non-SU archive admins** (comms archive NOTX, 2026-10-15 — Fred undecided beyond the first step). Done: the do-not-transcribe dialog is one module (`public/js/ycNoTranscribe.js`) opened from Connections → Phone Lines (SU-only) AND from comms.html's admin-tools slot (`#commsAdminTools`, the tabs row's right end, Phone tab, archive admins via `GET /api/comms-archive/admin` — a soft gate; the routes are the real one), so SS (roles admin,staff,attorney — not su) now has the screen through Comms. Still open for the other admin surfaces (mailbox / phone-line access, the mail tools): (1) keep them SU-only; (2) an admin tab — or more slot buttons — in comms.html: the slot is where this grows, one `ADMIN_TOOLS` registry entry per tool (a tool with another gate adds its flag), and it tears out in a handful of deletions (recipe above the registry); (3) open selected SU pages (Connections, Users) to admins, never the irreversible ones (the DB console) — needs an SU / admin / IT tier map; (4) a new small admin page with basic settings. The module can be hosted on any of them.

- **Inter-office chat (design v0, 2026-10-12)** → `ref/CHAT_DESIGN.md` (living doc; design-only, nothing built). Staff messaging anchored to cases/contacts/tasks, hosted as the comms hub's third tab; part of the clean-surface restart. Build gated on the Cloud SQL cutover settling; DM privacy (OQ1) and the pulse audit exemption (OQ4) await rulings.

- **Custom fields: per-case-type scoping as data (if it gets common).** Since 2026-10-06 a case field meant for some types is a `show_when` on `case_type` (one Custom Fields section, mounted by every Case Details variant). `show_when` v1 is ONE condition, so a type-scoped field cannot also carry a second condition. If that bites, add a first-class `case_types` (JSON list) to `field_defs`, ANDed with `show_when`, rather than growing v1 into and/or trees.


- **SMS auth-only migration (active now, not really "future").** `quoService.js` and `ringcentralService.js` move from `app_settings.quo_api_key` / `app_settings.rc_token` + parallel OAuth state to `buildHeadersForCredential(db, credential_id, url)`. Quo first (smaller blast radius), RC after. Cleanup deletes `loadToken`, `refreshAccessToken`, the boot-time load, and the `routes/internal/mms.js` `loadToken` middleware. The same pattern applies to email (`emailService.js`) once SMS is done — `email_credentials.smtp_pass` (ENCv1-encrypted since 2026-10-08) also goes away as part of email's migration to Connections.

---

## Security cleanups (mostly blocked on legacy frontend retirement)

- **Plaintext `password` column removal** on the users table — blocked on old frontend retirement.

- **`/db` and raw-SQL endpoint kill** — blocked on old frontend retirement.

- **`// TODO: REMOVE` markers** scattered across the codebase — clean sweep at the same time.

- **`jwt_api_audit_log` stores every request body** (lib/auth.jwtOrApiKey; only password-like keys are redacted). A route that refuses free text — the comms evaluation's score route accepts only numbers, booleans and tags, and audits a refusal as "invalid request" without the field — still has whatever the client sent recorded there, refused or not. Decide per route class whether bodies are logged at all (allowlist of loggable routes, or log only the key names). Found in the lane D review, 2026-10-14.

- **`email_credentials.smtp_pass` → Connections** — the column is ENCv1-encrypted (2026-10-08: API encrypts on write, SMTP adapter refuses non-encrypted values, backfill run); what remains is replacing it with a Connections `basic`-type credential row. Either as part of email's auth migration (above), or as its own pass.

- **JWT storage decision + liveHost's last token read (2026-10-05).** The
  token-binding cleanup (apiSend/uploadWithProgress as the only transports,
  frozen bindings, path guard + redirect:'error', role gates off
  firmData.currentUser — AI_CONTEXT §3 "Client token discipline") shrank the
  client token surface to ONE read outside the shell:
  `public/forms/liveHost.html`, a standalone tab that re-reads localStorage
  `jwt` per call by design (picks up a fresh login in the main tab without a
  reload). Moving the token out of localStorage/window (closure-held,
  cookie, whatever the storage decision picks) is now a shell-plus-liveHost
  change only. Decide storage; liveHost likely becomes a shell-hosted pane or
  gets a postMessage token broker.

- **`create_cta`: a resolved `{{placeholder}}` can read as an authored
  `[[input:x]]` (2026-10-11, CTA S3i review).** Inline bindings are SU-mint
  only, so the wide form is closed. The narrow one predates S3i: a workflow
  mint param whose RESOLVED value is exactly `[[input:x]]` (declared on that
  option, into an opened param) binds — `{{var}}` alone,
  `{{empty}}{{var}}`, `[[input:{{field}}]]` — because the service sees only
  resolved params. No workflow does this today (WF27's
  option declares no inputs). Fix in `lib/internal_functions/cta.js`, not the
  service: tell authored bindings from resolved text before the `{{...}}`
  pass (the engine would have to hand the step its unresolved config), or
  refuse a whole-value marker on workflow mints unless the step lists it in
  an explicit `bindings` param. `ref/CTA_DESIGN.md` §12 "Known landmine".

- **Row renders: escape every data field (app-wide sweep).** Rows are built
  as HTML strings from server data, and stored free text (names, dockets,
  statuses, labels) reaches them from intake. Done (wsurl, 2026-10-15): S0 the
  shell's file-open path (quickPick, picker, addFile), S0b every file-open
  link, S0c every field in index.html's tabCasesGet / tabContactsGet / calxGet
  / tabEventsGet / tabApptsGet / tabLogGet, case.html's tabLogGet /
  putClients, and contact.html's tabLogGet / putCases. Still raw, seen in
  passing, not hunted: case.html putAppts and contact.html putAppt (cells,
  plus status and dates quoted into apptUpdate onclick source), both pages'
  putEvents, case.html's pipeline widget (`pwOverride('${k}')`), tasks.html's
  other cells and taskModalAction, and every page outside these three. Also
  seen raw during wsurl S-links: the link TEXT cells of get_events
  (lib/internal_functions/events.js) and get_appointments (appointments.js)
  html rows, and routes/renaReminder.jsx's links (legacy, unmounted). Tools:
  escText / escAttr / fileLinkHtml in scripts.js; data-* or a bound listener,
  never data in onclick source.

- **Workspace URL — deferred levels (wsurl, 2026-10-16).** The protocol
  (ref/AI_CONTEXT.md §12 Workspace URL) stops at the levels built so far.
  Done (ui-custom S5c-a): automationManager and caseConfigManager report
  their sub-page. Next: the other drill-panel panes with sub-tabs
  (portalManager.html has the same SUB_PAGES shell); the HOST role
  inside case.html / contact.html, once a nested pane (documents, tasks,
  widgets) gains a vocabulary — today a deep link into a file keeps only its
  tab level; tasks.html as a leaf (then move the wsurl harness's (3s) ?open=
  check to a pane that still has none, or to the panel-pane path).


---

## Operational

- **Case creation's remaining gaps (the chokepoint itself is now closed).**
  `caseService.createCase` was extracted 2026-09-25 (Fred's ruling, custom-fields
  S6-B) and is the only `INSERT INTO cases` in the repo, guarded by a test. What
  it deliberately did NOT absorb, because the two callers genuinely differ, is
  still open: (a) **no transaction** — `intakeService.intakeCase` writes `cases`,
  `case_relate` and `log` as three autocommitted statements on the pool, so a
  failure between them leaves a case with no Primary link; closing that means
  absorbing the linking, which changes the petition route's idempotent
  `ensureRelate` semantics. (b) **No log row on the petition path**, where intake
  writes one — the two creation paths disagree about whether a case birth is
  logged at all. (c) **`case.created` is still a hand-built `data` subset** on
  both callers (custom fields now ride it, S6-B, but no core column was added);
  a live rule matches on `not_exists` over two of its keys, so any change there
  is a behaviour change, not a cleanup. Do these as their own slice.

- **Case field edits reach no log at all.** Found while ruling the custom-fields S4 log question (2026-09-25) and confirmed: `caseService.updateCase` writes no log row, and there is no `after_case_update` trigger — `cases` carries only `trg_cases_ct_compat_ins/upd`, which are case-type compatibility, not logging. So changing `case_status`, `case_stage`, `case_rec`, a date or anything else on a case leaves no trace in the case's log, while the equivalent edit on a contact does (the `after_contact_update` trigger covers 17 named columns). The only `type:'update'` row a case ever gets is the `mergeCases` snapshot. S4 deliberately did NOT half-close this — writing cf_ log rows on cases would have made admin-defined fields better-logged than every built-in column. Closing it properly means an app-side write in `updateCase`, which every case writer then inherits (`routes/api.cases.js`, `courtReview`, `update_case`, the inline Overview `onchange` handlers in `case.html`), so it is its own slice with its own volume question — a busy case would gain a log row per keystroke-ish save. Decide extend-vs-accept deliberately; don't let it ride into an unrelated change.

- **After the Cloud SQL move (2026-10-13) — cleanup, in this order.** Record:
  `ref/archive/DB_MIGRATION_2026-10.md`; current setup: `ref/INFRA_GCP.md`.
  (1) Now: raise the GCP budget alert (Cloud SQL alone is ≈ $53/mo; the alert
  was set for a ≈ $8 bill). (2) After a week or two of clean running: buy the
  1-year committed-use discount (≈ $53 → ≈ $40). (3) Now — there is no
  rollback window any more: staff have worked on Cloud SQL since 2026-10-13,
  and the old revisions name a connector that no longer exists. Delete the
  cutover copies of client data (the dumps, the parity output and the saved
  service settings in Cloud Shell's home; the object in the migration bucket).
  Empty SiteGround's Remote MySQL list: it still admits the released NAT
  address, which Google can now hand to anyone. Then check that nothing has
  written to the old SiteGround database since the freeze (newest rows in the
  busy tables, against 2026-10-13 06:48:48 UTC) — a newer row is a writer still
  pointed at the old host — and drop it. Cloud SQL's own backups and 7 days of
  point-in-time recovery are the safety net from here. (4) DONE: the NAT chain
  (connector, NAT, router, static address, subnet) is deleted; the app has no
  fixed egress address (`INFRA_GCP.md` §1).
  (5) No server-wide SELECT time limit exists, the old host had none either,
  and none is wanted as an instance flag: it would interrupt dumps and exports
  (`INFRA_GCP.md` §7). Only if runaway app queries ever become a problem: set
  `max_execution_time` per session in `startup/db.js`'s pool.
  (6) The 30 s pool idle recycling in `startup/db.js` was sized for the old
  host's 60 s `wait_timeout`; harmless, revisit only if connection churn ever
  shows up in a profile.

- **Cloud Scheduler interval.** Currently 5 minutes (set conservatively at launch). Drop to ~30 seconds when comfortable. Pure GCP config change, no code.

- **Single-instance vs multi-instance Cloud Run rate-limiting.** Bottleneck limiters in `ringcentralService` are per-process — multiple instances each have their own limiter and don't coordinate. Latent issue at current volume. Future fix is Cloud Tasks per-credential queues; design captured in the shelved driver doc §2.10. Don't act unless rate-limit failures actually surface.

---

## Hygiene

- **Mid-width table exposure beyond the fixtures (ui-custom H3, 2026-10-15).** H3 gave
  Events / Calendar list (shell) and case People / Appointments their own scroll box at
  769–1299px (pane 769–1079px in case.html); the survey is clean at 320–1200 on its
  synthetic rows. Not covered: `contact.html` has its own copy of the phone table rule
  and the same mid-width exposure; `forms/issn.html` has the same `.yc-section-pair`
  (the `flex-wrap: wrap` one-liner applies); with REAL data (long addresses, emails)
  the shell Cases / Contacts / Appts / Log tables, the case Events / Log tables, and
  People even at ≥1300px can still widen the page. Dropping the bands' upper bound is a
  one-line fix (a scroll-box table that fits renders identically) but would clip any
  popover inside a cell under `overflow:auto` — check cells first. Bundle with the
  next slice touching those pages.

- **Mascot behavioural tests wait in wall clock (2026-10-15).** `tests/mascotSkins.test.js`
  drives the engine on real requestAnimationFrame at `Mascot.speed(n)` and polls with
  `Date.now()`/`setTimeout`, so results depend on how many frames a loaded machine
  delivers. "a finished web starts the next one at overlap" NO-GO'd a land.sh run
  (d≈4.5 vs >12) and is `test.skip`ped until this is fixed; the file's header lists it
  and the fetcher test as known loose ends. Fix: a deterministic clock the tests can
  step (engine-side tick hook or jsdom fake timers + rAF), then un-skip. Own small arc;
  the deterministic contract checks in the same file stay the shell's engine gate.

- **Migrate the case-merge span onto `withTransaction` (docs review #2, 2026-10-13).**
  `services/caseService.js` case-merge (~:2187) is the one transaction span on a raw
  `getConnection()` with manual begin/commit/rollback — the sole exception to the
  CLAUDE.md doctrine. Fred's ruling: leave it working for now, migrate "at some point
  or another" — bundle with the next caseService slice, never standalone. While in
  there: `routes/unplacehold.js:20` calls `db.getConnection((err, c) => …)` callback-
  style on the promise pool — the callback never fires, dead logger, delete it.

- **AI_CONTEXT coverage arc (filed 2026-09-14, ruled 2026-10-13).** AI_CONTEXT has
  zero sections for: e-sign, portal, YisraForms/form templates, reports (+ the rest of
  the 09-14 census in the old debt item). Own arc, one register-density section per
  slice (what + invariants + pointers, built from a verified code read), e-sign first.

- **SweetAlert2 cross-frame inline-onclick audit.** `Swal` popups render in the parent window's DOM, so inline `onclick="…"` attributes inside a Swal `html:` template literal resolve against parent scope and fail with `ReferenceError` for any iframe-defined function. Three instances of this bug in image-library delete buttons (`campaign.html`, `communicate.html`, `sendingform.html`) fixed in May 2026 — but the pattern is easy to repeat. Sweep all iframes (`case.html`, `contact.html`, `automationManager.html`, etc.) for `onclick=` inside any Swal `html:` block; replace with `class` + `data-*` attributes bound inside `didOpen`.

- **`rc_messages_log` table rename.** Quo also logs there despite the `rc_` prefix. Rename to `sms_messages_log` (or similar) when there's a quiet window — touches every SMS-related call site, so bundle with another sweep, don't do it standalone.

- **Route handler naming.** `scripts/updateRoutes.js` writes `ref/routes.md` — a grep-able access-control matrix with middleware and handler columns per route. Handlers passed as inline arrows (`router.get('/x', mw, (req, res) => {...})`) show as `<anonymous>` in the handler column; named function declarations, `const`-bound arrows, and named function expressions all get picked up by `Function.prototype.name`. When you touch a route file for any reason, name the handlers in it — verb+noun matching URL semantics (`getCases`, `createWorkflow`, `cancelExecution`). No dedicated naming pass. Worst-offender files visible by skimming `ref/routes.md` for sections heavy on `—` in the Handler column. Pairs with the `requireAuth` self-naming convention (see Slice 1 of the client portal work) — together they make `ref/routes.md` a navigable auth + routing map.

- **UI consistency leftovers (mobile arc, closed 2026-10-06).** Labels and hints are unified (AI_CONTEXT §12); still open:
  - **Injected-CSS load order — root cause.** `scripts.js` appends its `<style>` blocks before `style.css`'s link, so every tie goes to style.css; four dialogs needed a specificity bump (CLAUDE.md). Moving the injection after the sheet fixes it at the source but flips EVERY tie at once — needs a full before/after harness at 320–1280, not a drive-by.
  - **Checkbox/radio option labels** ("Active", "Notify assigner…", "All-day event", "SMS") vary: 13px `--text-2`, 0.9em, inherited. The next "one look" layer.
  - **yc-forms sizes are rem-based** — `.yc-label` 0.92rem (14.72px), `.yc-sublabel` 0.8rem (12.8px) against the app's 14/12px tokens. Converge when yc-forms is next touched; check that every page loading it also loads `theme.css` first.
  - **The mobile survey asserts overflow only.** The label/hint uniformity checks were session-scratch Playwright scripts; a `--looks` mode in `scripts/mobile-survey/` would make them a gate.
  - **Hoist `.yc-flabel`/`.yc-hint` into theme.css.** The theme.css-only Admin panes load neither style.css nor scripts.js, so each needs a local copy (ctaManager.html has one with the §12 values; toolManager.html styles `.field label` its own way — uppercase 11px muted). One theme.css definition would collapse the four must-move-together places (AI_CONTEXT §12) to one and retire toolManager's divergence (docs review, 2026-10-13).

- **Manual viewer leftovers (manuals-ui arc, closed 2026-10-15).** The viewer itself: AI_CONTEXT §12 "Manual viewer". Deferred:
  - **Operator view.** A toggle hiding each chapter's `## Technical reference` half (29 of 82 chapters are split For operators / Technical reference). Deferred because the outline already skips it, and a hidden half must reveal itself when a search hit lands inside it.
  - **The mobile survey's sideways-scroll check is per-pane opt-in.** `measureBox` (survey.js) catches a pane whose body scrolls sideways inside its own box — a blind spot of the document-width check — but only the Manuals surfaces pass a box selector. Generic needs a per-pane "body box" selector.
  - **marked loads from a pinned CDN build.** Search lands a hit by heading ORDINAL, so the server's heading parser must count what marked renders. After any pin bump run `node scripts/mobile-survey/manualOrdinals.js` (GO/NO-GO).
- **heavy-gate.sh hands a freed slot to whichever waiter retries first, not the longest waiter** (2026-10-15: a run queued 66 min while later arrivals took the browser slot). Decision (Fred, 2026-10-15): MEASURE first — the same day's per-width survey rule and browser-before-cpu ordering removed the two big causes of long waits. Escalation, cheapest first: (1) aging — a waiter's poll interval shrinks with time waited (5 s → 0.5 s after ~10 min), so long waiters almost always win, ~3 lines, no state; (2) ticket queue (mkdir'd sequence numbers, lowest live ticket wins, dead pids reaped) — strict FIFO, ~30 lines + a stress test; (3) a launchd-run node daemon owning the queue — strict FIFO + a live queue view, but a daemon to maintain and a fallback needed when it's down. Rejected: a Claude "guard" session (tokens per poll, every message wakes a session for a full turn, must be started by hand, single point of failure) and `flock` (no FIFO guarantee either). Trigger to escalate: a run waiting 15+ min behind later arrivals. Second defect, same file: a `browser` run takes its cpu slot BEFORE waiting for the browser slot (`acquire cpu` then `acquire browser`), so every queued browser run sits on a cpu slot doing nothing — two queued surveys starve jest/landings entirely. Take browser first, then cpu. `local/` is gitignored — this entry is the only record.

- **Unify the placeholder modifier chains (docs review, 2026-10-13).** `services/resolverService.js` and `lib/unplacehold.js` carry independent private copies of every formatter (phone, email_mask, ssn_mask/ssn_last4, …) and disagree on empty source values (resolver leaves the raw placeholder; unplacehold resolves to `''`); a third copy of SSN masking lives in `esignPrefillService.ssnMasked`. Pinned by `tests/ssnModifiers.test.js`. Unify into one lib, or at least a shared formatter table — manual/03-YisraFlow/06-variables-templating.md documents the divergence meanwhile.

- **Shared home for the transient-DB-error predicate (docs review, 2026-10-13).** `startup/db.js` `isTransient()`/`TRANSIENT` and `services/fieldDefReconciler.js` carry byte-identical copies. Not importable today: `startup/db.js` module.exports IS the live pool, so requiring it from the reconciler would open a real pool in every test and break its dependency injection. Fix = a `lib/` home for the predicate, which means touching the db layer. Sibling of the SSN-masking three-copies debt (above).

- **Hook raw-input >512 KB is dropped silently (found 2026-10-12, maintenance/hook-spool slice).** `hookService.executeHook` slices the raw-input JSON *string* at 512 KB; `hook_executions.raw_input`/`hooks.captured_sample` are JSON columns, so the write fails (ERROR 3140), the receiver still answers 200, and the event vanishes with no execution row. Never hit in prod (max 24 KB over 31k rows). Fix: store a valid JSON stub (`{truncated:true, bytes:N, head:'…'}`) or reject >512 KB with a 413. Also touches the maintenance spool: a spooled event of 512–900 KB would 500 on replay until the queue's max attempts. Manual (09-yisrahook.md Truncation) documents the defect meanwhile.

- **Deadline dialogs live twice (U9b-P2, 2026-10-13).** `public/scripts.js` `eventCompleteDeadline` / `eventCancelDeadline` / `eventPatchStatus` (the Calendar list's quick actions) are copies of `eventform.html`'s `efCompleteDeadline` / `efCancelDeadline` / `efPatchStatus` — the pane's copies can't be reached from the shell. Move eventform onto the scripts.js twins (its action bar then branches exactly as the Calendar list does) and delete its copies.

- **`apptUpdate()` refetches the Appts tab from anywhere (U9b-P2, 2026-10-13).** All six of its write branches call `tabApptsGet(offsets.appts)` unconditionally, so an action from the Calendar list also costs a hidden GET /api/appts (+ calendar-types), non-silent — an empty or failed Appts fetch toasts over the Calendar tab. Dies with the old tabs at U9b-P4; if apptUpdate outlives them, gate the refetch on the Appts tab being the caller.

- **Documentation currency** now has a mechanism (2026-09-14): doc≠code divergences are filed to scratch `ns=docs` at discovery; the weekly docs review (`ref/DOCS_REVIEW.md`) drains the queue and updates `ref/AI_CONTEXT.md`'s currency header. No more ad-hoc drift sweeps.

- **case.html `loadIframes()` calls `Dropbox.embed` unguarded (wsurl S2, 2026-10-15).** dropins.js is external (www.dropbox.com); when it is blocked (an ad blocker, the network) a case with `case_dropbox` throws in boot. S1b's catch-path restore keeps a tab on screen, but the Dropbox panel and the boot's `tabLogGet(0)` are skipped. Fix: guard with `typeof Dropbox !== 'undefined'` (else show the noDB state), plus a test (the wsurl harness's (b7) already blocks dropins.js by interception).

---
---

## Carried from AI_CONTEXT §14 retirement (2026-09-14)

Still-live items from the old PENDING/TODO section; verified against code/prod
before carrying (campaign_results UNIQUE key, Pabbly→Trello swap, and the
role-convention item were confirmed done and dropped).

- **Login rate limit 100 → 10** (`routes/auth.login.js` — comment says "change
  to 10 in production"; still 100).
- **Audit-log hygiene:** one-time cleanup of pre-redaction `jwt_api_audit_log`
  rows (contain Bearer tokens) + 30-day retention cron for `jwt_api_audit_log`
  and `query_log`.
- **Sequence templates:** audit `sequence_templates`/`sequence_steps` for
  duplicate `:placeholders` (resolver now throws on DB errors — behavior change).
- **newAppt Swal wiring:** `does_appts` filter + staff dropdown in the appt
  creation Swals on case2/contact2 (drafts reference `u.user_does_appts`,
  should be `u.does_appts`).
- **contact-form.html ApiError refactor:** drop `doRawPatch` +
  `findAuthWindow`, read `err.body`/`err.status` from stock `apiSend`.
- **Slice 3 B.2.b polish backlog:** rename row-level `name="notes"` in
  repeater templates (latent collision); per-row 400 error highlighting;
  "Revive" button in history modal; last-row-removal warning; inline as-you-type
  repeater validation.
- **`contact_phone2`/`contact_email2` cleanup** (Fred): migrate the 1–2
  affected contacts into child tables, then retire the columns.
- **Checklist → task completion hook** — seam identified in
  `computeAndSaveStatus`.
- **Dropbox direct API** for the `docReq.html` uploader (replaces JotForm
  placeholder).
- **Fold `_wfNextRef` into `_wfClassifyTarget`** (`public/automation/workflows.html`):
  the Explain view and the step canvas now each carry their own copy of the
  engine's next_step sentinel table (`end`/`null`/`''`/`cancel`/`fail`/digits).
  One classifier returning a kind, with the two call sites rendering it, would
  keep them from drifting apart from `normalizeNextStep()` independently.
- **YisraHook v1.3 extras** (beyond the v1.1 bullet above): response
  transforms, per-target `no_retry` flag for non-idempotent internal_function
  targets.
- **case.html / contact.html missing `<!DOCTYPE html>`** (found UDS S4b,
  2026-09-23): both render in quirks mode. Bit once already — quirks tables
  don't inherit font-size, so density presets missed their logTables until
  `.logTable` restated `font-size: var(--fs)` in style.css. Adding the
  doctype flips them to standards mode with wide layout blast radius
  (box model, percentage heights); needs its own slice with full harness
  before/after, not a drive-by.
- **`manual/` has no theme/appearance chapter** (noted at UDS close,
  2026-09-23): the Theme page — palette presets, the density row, the
  Advanced token editor, `?notheme=1` recovery — is operator-facing and
  undocumented. One chapter under an existing section (+ README TOC row)
  covers it; `ref/THEME-CHEATSHEET.md` is the developer side, not this.

- **CTA (ref/CTA_DESIGN.md) — deferred v2 features** (§9 there has detail):
  ~~clicker-supplied input fields~~ (ratified → §12, 2026-10-08, S1i/S2i in
  flight); step chaining beyond `result_template`
  tokens; **S5 login tier** (shell deep-link pane + authed respond route);
  `min_interval_seconds` cooldown and nonce
  idempotency (`UNIQUE(cta_id, nonce)`) for repeatable links; per-execution
  retry-from-failed-step; token/password-hash hashing at rest + rotate-PATCH
  (owned by the access-control arc); DB-backed exponential backoff on
  password attempts.
- **CTA S4 residuals** (WF27 v8, 2026-10-07): anchor the recidivism email
  LIKE as `%"<email>` to kill substring matches (`bob@` ⊂ `jimbob@` — 0
  collisions in the 65-email corpus today); optional lowercased `ai_spam`
  re-emit in step 45 (step 3 compares `== 'yes'` exactly; a `"Yes"` fails
  visible, not silent); rollback note: a v8-minted CTA clicked after a
  rollback to v7 content re-gates the lead (v7 ignores `spam_override`) —
  one extra RG alert, no loop; recidivism coverage before 2026-09-17 (wf27
  v5) depends on the raw phone having been typed as contiguous digits; the
  hardcoded bad-IP ranges in the step-44 prompt rot if the campaign rotates
  subnets — revisit against gate data, together with the parked match-list
  idea.

---

*Last updated: 2026-10-13*