# YisraCase Plans & Future Ideas

Living doc. Deferred work, design ideas, and known cleanups — not active development. Move to a session/slice plan when you actually start.

---

## Settings vs Config (ratified 2026-09-24; built by the settings arc, 2026-10)

Two operator surfaces:

- **My Settings** (settings.html): personal only — account (with booking
  calendars), password, signature, **My access** (the caller's mailbox and
  phone-line access) and **Manage access** (a grant editor for the channels
  where the caller holds a real `can_manage` grant).
- **YisraCase Config** (caseConfigManager.html): the firm-wide editors —
  vocabulary tabs (Types & Subtypes, Pipelines, Custom Fields, Contact Roles,
  Calendar Types, Lists), read-only for anyone without `firm.settings`; the
  **Firm** tab (`firm.settings`: the firm's settings, Launcher, Who sees what);
  the **System** tab (`system.settings`: it + su). Rule of admission: Config
  gets definitions that have no manager of their own; one editor per setting,
  never two.

`lib/settingsRegistry.js` gives every app_settings key its kind and its ONE
editor home (AI_CONTEXT §32). A new key is a registry entry in the same slice.

Deferred from the arc:
- **Automations' information security — its own arc** (Fred, 2026-10-17). Any
  staff member can author and test-run workflows (`POST /workflows/test-step`
  is plain jwtOrApiKey), so every internal function is a staff-wide surface:
  get_setting reads any non-secret setting, query_db reads its allow-listed
  tables, records leak into execution logs. The settings arc closed only the
  app_settings WRITE path (a registered key needs `automation: true` in the
  registry). Making workflows admin-only is the easy way out Fred does not
  want.
- **The comms knobs' home.** The comms arc picks it; until then the
  registry's home `comms` renders in the System tab.
- **Interim access lists → capabilities (access A6).** `comms_archive_admins`
  / `comms_eval_reviewers` are registered kind `access` (SU console only, no
  editor). `archives.purge` exists and admin holds it.
- **YC 3.0 provisioning seeds.** The registry's kind IS tenancy open decision
  16's classification: firm / vocab = tenant-configured, system =
  platform-provisioned, state = starts empty, secret = per-tenant credentials.
  A per-key seed value lands with the provisioning slice — never 4LSG's
  values. `app_url` / `landing_hosts` / `landing_redirect` become
  `tenant_hosts` data then, not settings.
- **Rollout flags still at their final value** (kept, Fred 2026-10-17):
  `landing_redirect` (the instant revert until `tenant_hosts`),
  `trustee_validation_live` (the dry-run switch). Kill switches stay:
  `cloud_tasks_enabled`, `documents_sync_enabled`, `court_ingest_live`,
  `portal_live`, the comms modes.
- **Manage access for a line held without Read.** settings.html lists
  phone lines from `GET /api/phone-lines/readable` (by `can_read` grant for a
  non-attorney), so a send- or manage-only line grant shows in neither My
  access nor Manage access (none exists today; only SU manages lines).
  Fix: an any-grant phone listing for the caller.
- **`quo_api_key` → a credentials row** like `comms_stt_credential_id`;
  `rc_token` / `rc_subscriptions` go with the RingCentral retirement.
- **The legacy `settings` table** has no reader (AUDIT_TENANCY §B4): drop it.
- **`fe-*` shipping.** Every `fe-` row ships to every staff browser through
  `/api/firm-data`; a registry flag could replace the prefix (YC 3.0).
- **Terminology layer** (YC 3.0: the case / matter label map) — a future
  Firm-tab section; a structured document, so ui_config-shaped, not
  app_settings scalars.

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
settings/config split (done 2026-10: `lib/settingsRegistry.js` enumerates
every app_settings key the code reads with its kind — the classification
provisioning seeds from; see "Settings vs Config" above), access-control arc
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
15. GCS per-tenant buckets vs prefixes (§3-15). 16. **RESOLVED 2026-10-17**
    (§3-16): the classification is `lib/settingsRegistry.js`'s `kind` per
    key (firm / vocab tenant-configured, system platform-provisioned, state,
    secret, access, retired), reviewed key by key against the live table.
    17. External health probing; `/api/version` reads
    tenant data (§3-17 + §E4).

### Domains & starter websites (ratified with amendments 2026-10-21)

The "YCv3 — Domains and Starter Websites" plan (resolution order = today's
`routes/pageLanding.js`; links minted from config) is ratified with six
amendments, which bind every slice that touches hosts:
1. **The portal never serves on the pages origin.** `/api/portal/verify-pin`
   mints a token the portal keeps in localStorage, which staff-authored page
   JS on the same origin could read. Constraint: a token-minting role never
   serves authored content — portal on the app host or a third origin.
2. **Pages bind to registered public hosts.** `pages.host` must be a
   registered public (landing / `tenant_hosts` pages-role) host, never the app
   host. The v2 fix (POST /api/pages host check + `pageHostMiddleware`'s
   non-landing branch) is the 2026-10-21 review's P0 #2, its own slice.
3. **The platform host stays the canonical app origin.** Custom app domains
   later, as additional hosts, never alias-redirects: OAuth redirect URIs and
   `targetMatchesAppUrl` pin one hostname.
4. **A dedicated callback host** for machine traffic (Cloud Tasks and the
   hook spool target `cfg('app_url')` today — `lib/hookSpool.js`).
5. **Per-site page binding.** Multi-site needs `pages.site_id` (today every
   root slug serves on every public host), and token links mint on the
   primary site's canonical host.
6. **Registrable-domain separation for public sites.** Tenant pages under
   `*.p.yisracase.com` share a registrable domain with the app hosts (the
   same-site cookie trap): get `p.yisracase.com` onto the Public Suffix List,
   or serve public sites from a separate registrable domain.

---

## From the access-control arc (2026-10-14) — deferred

- **jwt_api_audit_log retention** (~90 days): 167K rows since April, never
  pruned. Bodies and query are shapes-only since SEC-2 and credential headers
  are dropped by name (2026-10-27, history scrubbed by
  `scripts/auditLogCredHeaderScrub.js`), so retention is size, not secrecy.
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
- **Bind `POST /api/public/upload-complete` to a real upload**: it is
  anonymous (rate limit only) and trusts the body's `case_id`, so anyone who
  knows a case id can send staff a "client uploaded" email and write a client
  log row with a comment of their choosing (escaped, ≤ 2000 chars). Document
  registration can't be spoofed (it lists the case's real folder). Fix: have
  `get-upload-link` issue a short-lived signed token and require it here.
  (Docs review 2026-10-27.)
- **`comms.read_all` and `archives.purge` have no server gate**: both are
  defined in `lib/capabilities.js` (and mirrored in `public/index.html`) but no
  route, lib or service checks them — mailbox access reads the role from the
  DB instead. Wire them, or drop them from the registry so its descriptions
  stop overstating what is enforced. (Docs review 2026-10-27.)
- **Require scopes on new yck_ mints**: today omitted scopes = NULL =
  legacy full surface; flip to required once the existing integrations are
  scoped.
- **Session-key scopes for app settings** (Fred, 2026-10-27): add `ycro_` key
  scopes (`lib/capabilities.js` `KEY_SCOPES`), e.g. `settings.read` /
  `settings.write`, SU-minted like `sql.ro.sensitive`. Today `app_settings` is
  denied to every key (`lib/sqlGuard` `SECRET_TABLES`), so AI sessions cannot
  check even a non-secret setting (the 2026-10-27 opt-out sweep had to go to
  the SU console). Contract: secrets stay excluded even with the scope
  (`settingsRegistry.isSecret`); reads via a projection that never selects a
  secret value, not raw SQL on the table; writes only through the
  registry-governed editor route; audited; child keys never inherit write.
- **connections.html reads P.AUTH_STATE.jwt** (SU-guard fallback) — the one
  pane besides liveHost violating "panes never read the token"; drop the
  fallback and read firmData.currentUser.roles only. (Graduated from
  docs-debt 2026-10-14.)
- **Old referer header rows in jwt_api_audit_log**: SEC-2 shaped bodies and
  query_params; credential headers are dropped by name and SEC-1 redacts
  referer credentials, but rows older
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
  - *Pin `placeErrors`' unknown-section guard.* No test sends the PERSONAL
    editor a 400 naming `placed.homeIcons` (a section it doesn't show), which
    must land in the banner, not throw (`public/js/ycLayoutEditor.js`).
  - *Make `tests/helpers/uiConfigStore.js` reorder JSON keys on write*, as
    MySQL does (CLAUDE.md: a dry-run store must store JSON the way MySQL
    does). A deep key sort is enough; the S6c-3 reviewer showed the launcher
    suites already pass that way.

## From the communications-feeds arc (2026-10-19) — deferred

The case / contact Communications tab (AI_CONTEXT §20, manual
01-YisraCase-overview/16-communications-tab.md). Known limits:

- **Feed performance — move filter and page into SQL.** Every request loads
  ALL readable `mail_messages` rows and ALL `phone_event_log` rows on readable
  lines into memory (3.7 MB per request, measured by the 5edc88d review), then
  identity-matches, filters, searches, sorts and offset-pages in JS. The
  bridge lookups run unindexed: EXPLAIN (2026-10-21) shows type ALL on
  `mail_messages.log_id`, `phone_event_log.log_id` (~11k rows),
  `email_ingest_executions.log_id` (~32k rows) and `mail_sends.case_id`.
  Rework: push the case/contact predicates, kind/direction and a keyset page
  into SQL, and add those four indexes (migration first).
- **Webhook SMS case-association bridge.** A real text sent from a case's
  Send / log… is absent from the strict case feed: the send writes no
  frontend log (ingest writes it seconds later — Quo through hook 16 → wf 18,
  RingCentral through the outbound delivery sync that hook 22 pokes (AI_CONTEXT
  §28) — with phone numbers but no case). Needs a pending-send record the
  webhook can claim (line + to + body + window) to stamp
  `log_about_type='case'`.
- **RULED (Fred, 2026-10-22): accept for now.** Logged-only rows stay ungated (parity with the Log tab, four trusted staff); make the real call inside a future roles/access arc. The `/api/log` fallback-suppression alignment below stays wanted, low priority. Original question kept for that arc: Logged-only feed rows mirror the
  Log tab's exposure — no mailbox / phone-line grant check — while
  source-backed rows are grant-gated. Fred to rule whether Logged-only email /
  sms / call rows should be gated (and how, given they have no channel), and
  whether `/api/log` should share the feed's fallback suppression (a log row
  whose source sits in an unreadable mailbox is hidden in the feed but listed
  on the Log tab).
## From the phone-delivery arc (2026-10-21, arc closed) — deferred

(Design + vocabulary: `ref/PHONE_DELIVERY_DESIGN.md`. S1–S4 and the S3c
failed-send dispatch are live; wf 54 sends the notices.)

- **Failed-texts daily digest** — one grouped email from the
  `phone_event_log.delivery_*` columns, the noise-free alternative if wf 54's
  per-failure emails get loud (the known shape: a chronically unreachable
  number fails again on every weekly reminder). Build only if asked.
- **Quo read side** — `quo.listOutbound` + `capabilities.outboundSync: true`
  once Quo's API is confirmed to expose delivery status for listing; the core
  sync needs zero changes. Today a failed Quo send is invisible (hook 16
  fires on `message.delivered` only).
- **Inbound parsing into adapters** — the DB-stored hook transforms (16/17/21)
  still carry per-provider parsing + hardcoded line maps; a future
  "ingest parsing into drivers" arc should move phone AND email sides together
  (`adapter.parseWebhook`). Ruled out of the phone-delivery arc 2026-10-21.
- **Per-number dispatch cooldown** — if the weekly-repeat emails annoy before
  the digest exists, a small `(to, reason)` cooldown in the S3c dispatch is
  the surgical fix.
- **Archive sweeps bypass the adapter registry** — `commsArchiveSweep.js` and
  `commsArchiveMediaSweep.js` lazy-require `adapters/phone/*` directly instead
  of `phoneService.getAdapter()`, and the archive read functions are not
  declared in `capabilities`. Flagged to the comms-archive arc 2026-10-14;
  either route through the registry or state the direct-require as deliberate
  in the sweep headers + COMMS_ARCHIVE_DESIGN §6.

## From the log-comm-date arc (2026-10-22, arc closed) — deferred

(Live: eab6b88, a170bf1, ac49dac. Manual: 01-YisraCase-overview/06-activity-log
and 16-communications-tab; AI_CONTEXT §20.)

- **comms.html date filtering** — held by Fred 2026-10-22. Its Mail and Phone
  views page by keyset over plan-pinned index walks (phoneCommsService header,
  mailReadService), so a date range must join each walk's plan and be proven
  with EXPLAIN; manual call logs never appear there anyway. Build when someone
  needs date search in Mail or Phone.
- **Engine-written backdates are unmarked** — create_log / phone_log forward
  their params wholesale to createLogEntry, so a step passing `date` writes a
  backdated row with no log_extra.logged_at and no "entered" marker. No live
  definition does (checked 2026-10-22). If one ever should, stamp logged_at in
  those shims, or strip `date` there.
- **Log Call tab overhangs 1px at 320px** in communicate.html's tab bar
  (pre-existing; identical on the pre-arc page). Cosmetic.

## From the Gmail parity close check (2026-10-25) — deferred

Found while deciding the Apps Script retirement (`ref/MAILBOX_GMAIL_PARITY.md`
§4, close check). The two live defects are fixed (imapTransport FETCH ROWS ARE
MERGED PER UID; emailIngestService `_jsonColumnText`); these are what they
showed and the slice left alone:

- **Quarantined mail has no re-emit tool.** Poison messages are now
  quarantined (mailboxIngestService header, POISON MESSAGES — built
  2026-10-26): after 3 consecutive failures on one UID the new pass skips it
  for good and alerts. Its emission never completed (the rules may or may not
  have run); a stored one sits in `mail_messages` with `log_id` NULL, and
  staff finish it by hand (manual/08-Admin-Tools/08-mailboxes.md,
  "Quarantined messages").
  If quarantines happen in practice: an SU re-emit — (mailbox, folder, uid) →
  re-fetch, emit once under the box's identity, stamp `log_id`, drop the
  quarantine record.
- **The backfill pass loses an emission that throws.** A re-key's backfill
  emits only rows it INSERTS (`inserted && backfill_emit_after`), and
  processMessage stores before it emits — so a pipeline throw leaves the row
  stored with `log_id` NULL, the retry finds it present, and it is never
  emitted (the error execution row is the only trace). Re-key windows only,
  rare. Fix: in backfill, also re-emit a present row with `log_id` NULL whose
  date is past `backfill_emit_after` (the new pass's crash-window rule).
- **docs@ attachments → Dropbox** (wanted, Fred 2026-10-26; NOT a retirement
  prerequisite). The Pabbly docs@ workflow only ever sent a digest email —
  replaced by the `docs@ digest (replaces Pabbly)` ingest rule
  (`ref/MAILBOX_GMAIL_PARITY.md` §5). Uploading the files needs their bytes:
  the worker stores attachment STRUCTURE only (design D1); the on-demand part
  route already streams one from IMAP. Shape: a rule action that, per
  attachment, fetches the part and files it into the case's Dropbox folder —
  the case from the sender's contact or an id in the subject (the digest
  transform already parses one), unmatched → a review queue. The envelope's
  attachment `url` is null from both feeders, so the action keys on the
  stored row (mailbox, folder, uid, part) — worker-fed mail only.
- **hookService stores a 512 KB SLICE of JSON TEXT in a JSON column.**
  `hook_executions.raw_input` and `hooks.captured_sample` are `json`; the
  oversized-payload path (`rawInputStr.slice(0, 512 * 1024)`, both the
  capture and the received row) writes truncated text, which is never valid
  JSON — MySQL refuses the INSERT (`ER_INVALID_JSON_TEXT`) for every payload
  over 512 KB, so such a hook call fails at its first write. Fix the
  emailIngestService way: a marker object (`_truncated`, size, string
  `preview`) through a surrogate-safe writer. Untested live — no >512 KB hook
  payload has been seen.
- **phoneIngestService `_writeExecution` has no lone-surrogate guard.** Same
  writer shape as email's before `_jsonColumnText`. It never truncates, so
  only a malformed provider payload could hit it; port `_jsonColumnText` when
  next touching it.
- **`imapTransport.fetchPart` takes imapflow's first row for the UID**
  (`fetchOne`): a flag update arriving before the data fails the identity
  check, and the attachment request errors (a retry works — visible, not
  silent). Fold its rows the fetchMessages way if it ever shows up in the
  alerts.

## custom_code containment — what the child process does NOT close (2026-10-22)

Execution moved into a forked, scrubbed child (CLAUDE.md's invariant list has
the shape). That removes `process.env` — the DB credentials — from the escape
path and costs legitimate steps nothing, because all 97 live steps are pure
transforms (verified: none references `process`, `require`, `constructor` or
`global`; the one `process` hit is the word in a comment and the `require`
hits are English prose in string literals). It is **blast-radius reduction,
not containment**, and the difference matters for any decision that leans on
it:

- **The child keeps outbound network, so the instance metadata server is still
  reachable.** On Cloud Run that hands out a service-account access token,
  which is plausibly worth more than the database password already removed.
  `lib/customCodeHarden.js` refuses sockets, DNS and the `child_process`
  pivot from the module loader, which raises the cost but is monkey-patching,
  not a boundary — native bindings it does not cover remain.
- **The module-loader denial is BYPASSED, demonstrated 2026-10-22.** Under the
  exact preload, a probe obtained
  `process.getBuiltinModule('child_process').execFile` and
  `process.getBuiltinModule('fs').readFileSync` — the Node 22+ accessor, which
  never goes through `Module._load`. So `require` is closed and the capability
  is not. Evidence: `local/casey-code-investigation/report.txt`. Patching
  `getBuiltinModule` too would be another round of the same game; the
  conclusion is that monkey-patching is the wrong tool, not that it needs one
  more patch.
- **The real fix is a guest engine, and the first slice LANDED 2026-10-22**
  (Fred's go, same day): a `custom_code` step's config may carry
  `code_mode:'safe'`, which runs the body in QuickJS compiled to WebAssembly
  (`quickjs-emscripten`, `lib/safeCodeRunner.js`) inside the existing scrubbed
  killable child — no module loader, no Node objects, no fetch, no filesystem,
  no host callbacks, with time and memory limits and the same
  input/console/final-expression/`__cc`-transport contract as the vm path.
  The dispatch in `lib/job_executor` is the one choke point every execution
  path arrives at (workflow engine, test-step, scheduled jobs) and FAILS
  CLOSED: safe ignores the child-process flag, an unknown mode throws, and
  there is no caller-selectable fallback to Node `vm`. The 97 stored standard
  bodies are untouched (absent mode = standard). S2 (same day, Fred's ruling):
  SAFE steps are open to ALL staff — the `automations.manage` gate now covers
  only standard mode, on every code writer (the workflow step routes,
  test-step, AND `POST /scheduled-jobs` + `PATCH /scheduled-jobs/:id`, which
  S2 found entirely UNGATED — the scheduled-jobs writer had been missed by the
  original gate slice); both editors (workflows + scheduled jobs) grew a Mode
  picker, new steps defaulting to safe. S3 (same day): the first Casey
  authoring kind shipped — `job.code_safe.create.v1`, a one-time safe-mode
  scheduled job on the P1 card engine (ruling 13 in
  `ref/ASK_CASEY_ACTIONS_PLAN.md` has the scope; workflow-STEP code authoring
  stays with A17.4c behind the A17 ladder). Remaining:
  migrating the 41 published standard steps, still blocked on **no `Intl`** in
  the QuickJS build (published wf27/33/49/50 use `Intl.DateTimeFormat`,
  wf27/45/54 call locale `Date` methods — supply date/locale values through
  inputs or a reviewed pure formatter, not an ad-hoc polyfill). `isolated-vm`
  remains the fallback engine if Intl ever matters more than avoiding a native
  dependency, and egress restriction on the child is the orthogonal mitigation
  that closes the metadata server for STANDARD mode.
- **The in-process code-body class is closed (2026-10-26).** Trigger rules
  (`node:vm`), email/phone ingest rules, both suppression services and hook
  filters/transforms (`new Function`) used to run stored `code` bodies in the
  MAIN process. They now run in the QuickJS guest inside the scrubbed child
  (`lib/guestCode.js`; CLAUDE.md invariant), with time, memory and
  concurrency limits. What remains is in "From the code-bodies guest-engine
  slice" below (the gates, and follow-ups).
- **The child-process flag now fails closed (2026-10-26).** `job_executor`
  used `cfg('custom_code_child_process') === '1'`, so a missing or blanked
  row silently ran every standard step on the in-process `vm` path. Now only
  an explicit `'0'` selects it. The legacy path itself still exists as the
  rollback lever; deleting it (and the flag) is the remaining step once Fred
  is satisfied the child has no rollback use left.
- **So "a code step is harmless by construction" is NOT true today**, and no
  authoring decision should be justified by the child boundary alone. The
  honest claim is that the worst case fell from "the database" to "whatever an
  escaped script can reach over the network from this instance".
- The parent's kill timer (`CUSTOM_CODE_KILL_GRACE_MS`) is a backstop with no
  behavioural test: nothing reachable from the sandbox today can outlive the
  vm timeout, so only the option value is asserted. If an async escape ever
  becomes reachable, that timer is what catches it and it should get a real
  test then.

## From the code-bodies guest-engine slice (2026-10-26) — deferred

- **Relax the `automations.manage` code gates — Fred's decision, after a
  soak.** Trigger (`lib/triggerCodeGate.js`), ingest (`lib/ingestCodeGate.js`)
  and hook (B5) code bodies now run in the QuickJS guest, the same boundary
  that let SAFE `custom_code` steps open to all staff. The gates were kept
  exactly as they were in the moving slice on purpose; whether (and when) to
  open code authoring on these sites to all staff is Fred's call once the
  guest has run live bodies for a while. Note a hook transform can still
  read inbound headers and an `http` target can still send data out — opening
  hooks is a data-flow decision, not only a sandbox one.
- **Casey's ingest preview could take unsaved bodies.** It refuses them
  because a model-composed body would have run in-process; that reason is
  gone. A separate decision (it would also need the gate question above).
- **test-match's syntax pre-check still uses V8's parser** (compile-only
  `new Function`, never called) because its error text is pinned by
  `tests/fixtures/ingestRuleTestRoutes.golden.json`. Switching it to the guest
  parser changes that text — re-record the golden deliberately when doing it.
- **One fork per code call (~40 ms locally, ~85 MB RSS per child).** Fine at
  today's volume (a handful of calls per inbound event, capped at 4
  concurrent children). If volume grows, a warm child that runs each body in
  a fresh QuickJS runtime is the next step — not in-process QuickJS, which
  would put a runaway back on the event loop.

## From the Ask Casey arc — P5 ledger follow-ups (2026-10-22)

- **A refused claim reads as `unknown` when the chat is reopened.**
  `assistant_action_ledger.status` is `enum('in_flight','applied')` with NULL
  meaning not-applied, so a row cannot express "claimed, then refused". The
  card gets this right in the session it happened in (a 4xx other than 409 is
  reported as a refusal that wrote nothing), but the row stays `in_flight`, so
  a reopen falls back to the conservative "this may already have been applied"
  wording. Costs a misleading message, never a write — the claim is spent
  either way and no state offers the write again. A third status would fix it
  and needs a migration; not worth one on its own, so fold it into the next
  ledger migration if there is one.
- **Nothing prunes `assistant_action_ledger`** either: rows are kept until the
  user is deleted (FK cascade), by design. Same shape as the
  `request_idempotency` note below, and a single age sweep could serve both.
## From the Casey automation-authoring planning session (2026-10-22) — native-side

(The slice plan is A17/A18 + P11-P13 in `ref/ASK_CASEY_ACTIONS_PLAN.md`. These
are canonical defects and gaps that session measured; none is a Casey slice,
and the two marked LIVE BUG are worth landing whether or not A17 ever ships.)

- **A staff JWT can obtain server-side code execution through the ordinary
  workflow editor.** `lib/job_executor.js` runs a `custom_code` step as
  `new vm.Script(code).runInNewContext({input, console}, {timeout})`, and
  Node's `vm` is not a security boundary: `input` is a host-realm object, so
  `input.constructor.constructor('return process')()` hands back the real
  `process` with a working `mainModule.require`. Verified empirically against a
  replica of that sandbox (2026-10-22): `{reached:"object", pid:true,
  canRequire:"function"}`. From there `process.env` carries the database
  credentials, so a code step bypasses the report validator's table allowlist,
  the `yc_report` least-privilege grants and the SENSITIVE-table gating the
  access-control arc built. Practically this is held by trust in eight
  employees rather than by a boundary, and it has been true since code steps
  shipped — a trust-boundary fact to decide about, not an incident.
  Proportionate options, cheapest first: (a) gate the `custom_code` step
  **type** behind `automations.manage` — which already exists, is described as
  covering workflows, and is held by `admin`/`it`/`su`, two of eight users —
  leaving the other step types open; (b) additionally refuse the type for
  machine keys; (c) replace `vm` with a real isolate if code steps ever need to
  be authored by anything but a trusted human.

  Two things make the gate harder to scope than one line. **The shortest path
  to execution is not the editor**: `POST /workflows/test-step`
  (`jwtOrApiKey`, `dry_run` defaulting to **false**) runs a step straight from
  the request body — no workflow id, no save, no publish, nothing persisted
  beyond logs — and accepts `custom_code`. A gate on the step-writing routes
  alone would miss it entirely. The writers to cover together are
  `POST /workflows/:id/steps`, `POST /workflows/bulk`, `PUT` and `PATCH
  /workflows/:id/steps/:stepNumber`, `POST /workflows/:id/duplicate` (it can
  move an existing code step into a workflow with a broader trigger), the
  version-materialization insert, and `POST /workflows/test-step` — a gate on
  one of those is a gate on none of them. Proven again by safe-mode S2
  (2026-10-22): `POST /scheduled-jobs` and `PATCH /scheduled-jobs/:id` also
  take a custom_code payload into the same executor and were NOT covered by
  the original gate slice — closed in S2 with the same policy (safe open to
  all staff, standard behind the capability).

  One scoping detail for whoever builds it, verified 2026-10-22: the
  save-time `type`-key guard lives in `validateInternalFunctionConfig`, which
  only the four step-writing routes call (`POST /workflows/:id/steps`,
  `POST /workflows/bulk`, `PUT` and `PATCH .../steps/:stepNumber`). Two paths
  insert into `workflow_steps` **without** it — `ensureDraft`'s draft fork and
  `POST /workflows/:id/duplicate` — because both copy existing rows. Harmless
  today (no stored row carries the key, and `b087fa5` makes a stored one inert
  at dispatch), but a gate keyed on `step.type` has to re-check those two, which
  is the same bypass shape as the config override itself.

  **And the gate is an authoring control, not containment.** It limits who can
  INTRODUCE a code step, not who can run one: `POST /workflows/:id/start` is
  `jwtOrApiKey` too, and every trigger, hook and ingest path starts workflows
  whose code steps already exist. Containment means a real sandbox (an isolate
  or a separate runtime) or retiring `custom_code`. The gate should not be
  mistaken for a fix. This finding is why A17 refuses to let Casey compose
  code at all.
- **LIVE BUG — a `type` key inside a sequence `action_config` redirects the
  step.** `sequenceEngine.executeStep` builds `jobData = { type:
  'internal_function', ...resolvedConfig }`, so the spread wins:
  `"type":"custom_code"` runs `vm` code and `"type":"webhook"` takes
  `job_executor`'s webhook path, on a step whose `action_type` says `sms`.
  `validateStepConfig` blocks neither. Not an escalation today (staff can
  already author `custom_code` workflow steps) but it voids the `action_type`
  enum's apparent guarantee and any "author only sms steps" contract. **FIXED** in
  `b087fa5`: `type` is pinned last in all THREE
  dispatch payload builders — sequence engine, workflow engine, and
  `POST /workflows/test-step` — and both save paths refuse the key. The first
  instance was fixed alone; the other two came from grepping the pattern.
- **LIVE BUG — the sequence resolver substitutes unescaped values into JSON.**
  `executeStep` does `JSON.stringify(action_config)` -> `resolverService.resolve`
  -> `JSON.parse`, and `replacePlaceholders` writes `String(value)` straight
  into the JSON text. A resolved value containing a double quote breaks the
  parse; the catch leaves the step running with its config **entirely
  unresolved**, so a client SMS or email body goes out full of literal
  `{{...}}`. Measured 2026-10-22: no `contacts` row currently holds a quote in
  `contact_name`/`contact_fname`/`contact_lname`, and live active templates do
  interpolate exactly those fields — so this was unexploded, not safe. **FIXED** in
  `b087fa5`: `resolve()` takes an opt-in
  `escape:'json'` that both serialized-config call sites pass, and plain-text
  callers are untouched.
- **A route-harness test for the SEQUENCE `type`-key guard.**
  `tests/workflows.codeStepGate.test.js` now pins the workflow half by request
  on both POST and PATCH; `routes/sequences.js` `validateStepConfig` is still
  source-asserted only. Same harness idiom applies when a sequence route next
  needs touching.
- **Registry primitives would absorb about half the 41 live code steps.**
  Measured 2026-10-22 across the published versions: 8 bodies are under 400
  bytes and 20 under 1 KB, only 2 touch `next_step`, while 22 build HTML, 17
  munge strings, 17 iterate and 12 do date work. Reading them, the same helpers
  are duplicated verbatim across workflows — a null-safe string coalesce
  (`String(v==null?'':v).trim()`, with `'null'`/`'undefined'` mapped to empty)
  recurs in wf28/37/47 and more, and an identical `MM/DD/YYYY` +
  `YYYY-MM-DD` parser appears in wf23 and wf25 character for character. Others
  are one-liners wearing a code step: "Map template → chapter" is a 236-byte key
  map, "Split docs_missing into a list" is split/trim/filter, "rounds++" is a
  counter. Candidate primitives, roughly in value order:
  1. a **template renderer** — the biggest win, because 22 of 41 are composing
     email or notice bodies in code, and they do so largely because workflow
     templating has NO modifiers and blanks unresolved tokens silently
     (`{{x|default:y}}` resolves to `''`), so there is no declarative way to
     build a body today;
  2. a null-safe coalesce/trim;
  3. a date parse/format/shift (the `shift(input.filed, 14)` pattern);
  4. a key-map lookup;
  5. a list split/trim/filter.
  Worth doing on code-quality grounds alone — testable, explainable, no sandbox
  involved — and it shrinks the attack surface of the vm escape as a side
  effect. It does NOT retire `custom_code`: the remainder is genuinely bespoke
  (wf27's 19.5 KB formatter, the 7-way Clio command router, the multi-field
  e-sign reshaping), so the execution-boundary question stays live either way.
- **No optimistic concurrency on the SEQUENCE publish route.** The WORKFLOW
  step-mutating routes take an optional `expected_base` precondition since
  A17.4 (2026-10-24), `POST /workflows/:id/publish` since A17.6
  (2026-10-25: `{draft_version, step_count, draft_fingerprint}` — the
  whole-draft hash — refused as a structured 409 inside the publish
  transaction), and the five SEQUENCE step-mutating routes since the P11
  sequence half (2026-10-26, `lib/versionDiff.sequenceStepFingerprint`).
  Still open: the sequence publish route (A18.3's half). Neither native
  editor SENDS the precondition yet, so human-vs-human stale writes and
  review-then-edit publishes remain possible there until it does — wiring
  the editors to send it is a small native slice.
- **Automation publish is not a param-validation authority.** Step saves are:
  the workflow half closed with A17.4 (unknown `function_name`, undeclared
  param keys, `params: null`, `error_policy` shape/strategy refused at save),
  the sequence half on 2026-10-26 (`sms`/`email`/`task`/`internal_function`
  steps: missing / unknown / workflow-only `function_name`, undeclared keys,
  `params: null`, required params). Still open: publish (both engines) re-runs
  shape / branch-target / `validateStepConfig` checks but never params or
  function existence, so a draft step whose function was renamed after it was
  saved publishes clean; and sequence `error_policy` is unvalidated at save
  (the engine treats any strategy other than `abort` / `retry_then_abort` as
  ignore — live rows hold `ignore`, `retry_then_ignore` or NULL).
- **Casey sequence authoring (A18.2) — what it leaves open.** (1)
  `automation.definition` for a
  sequence reads `current_version` by default even when a draft exists, so the
  evidence Casey cites can show the published steps while the card inserts
  into the draft (the card names the displaced DRAFT step and the base check
  holds, so nothing lands wrong — but the model plans against the wrong list);
  make the sequence read draft-aware (today both definition reads fall back to
  the draft only for a never-published, v0 record). (2) Not authorable yet: editing or deleting a sequence step,
  conditions, fire guards, error policies, internal_function / webhook /
  start_workflow steps, and publish (A18.3).
- **`POST /executions/:id/resume` is neither state-guarded nor atomic.** It
  refuses only `active|processing|delayed`, so `completed` and `held`
  executions are resumable; it never checks `workflows.active`; and a plain
  SELECT is followed by an unguarded `UPDATE … SET status='active'`, so two
  concurrent resumes both pass. Casey's A17.8 excludes resume until this is
  fixed.
- **`DELETE /workflows/:id` cannot delete a workflow that ever ran.**
  `fk_workflow_executions_workflow` is `ON DELETE RESTRICT`, so the delete
  rolls back as a 500 — the route comment claims executions are kept for
  history. It also checks no hook target, trigger-rule action, sequence step or
  form definition that references the id.
- **Sequence enrollment has no idempotency and a racy duplicate guard.**
  `POST /sequences/enroll` takes no `Idempotency-Key`; the duplicate guard is
  SELECT-then-INSERT over `(contact, template, appt_id, signing_request_id)`
  with no unique constraint; a scheduling throw after the enrollment INSERT
  leaves an active enrollment with no job (alerting flags it ~15 min later);
  and every engine error, `ALREADY_ENROLLED` included, surfaces as an HTTP 500
  whose `err.code` is dropped. `scheduleStepJob` is likewise check-then-insert
  with no unique index on `idempotency_key`.
- **Sequence step firing can re-send.** `executeStep` has no "already sent this
  step" check and `recoverStuckJobs` returns a job sitting in `running` for
  over 15 minutes to pending, so an SMS or email can go twice. Only
  `start_workflow` steps are retry-safe
  (`findPriorStartWorkflowResult`).
- **Trigger rules have no draft, version or history model.** Edits are live on
  save, `updateRule` DELETEs and reinserts every action row with new ids,
  `match_config`/`transform_config` structure and `code` syntax are
  unvalidated, target workflows/templates are not checked for existence or
  publication, there is no row lock, and replay re-dispatches with no
  idempotency (the stale sweep can dispatch a rule's actions twice). Giving
  trigger rules the workflow/sequence draft-publish model is the native arc
  that would unblock Casey authoring them at all.
- **`workflow_execution_steps` under-records.** `attempts` is never written
  (always 0), the enum's `skipped`/`delayed` values are never used, and
  `executeStep` hardcodes `success: true` on any non-throwing return — so a
  function returning `{success:false}` (12 sites in `esign.js`, `reports.js`,
  `system.js`) is stored as a success row with the failure inside
  `output_data`.
- **No automation route is on the sync bus.** No workflow, execution, step,
  sequence, enrollment or trigger route appears in `yc-sync.js` MATCHERS, so a
  definition or enrollment write is silent to every other open frame including
  a contact's Automations tab. A canonical automations/bus slice would close
  it; the Casey plan deliberately adds no Casey-only emit.

## From the Ask Casey arc — A20.0/A20.1 ingest reads (2026-10-26)

Found while building Casey's ingest-rule read surface (plan A20). None is a
Casey slice. (The first one filed here, ingest `code` running in the main
process, was resolved by the code-bodies guest-engine slice, 2026-10-26; the
`updated_at`-is-not-an-edit-stamp one by A20 slice 1, 2026-10-27 —
`definition_updated_at` + the change log, with the landmine in both columns'
COMMENTs.)

- **The native ingest tester skips `evaluateRules`' email `body` derivation.**
  `evaluateRules` (and `evaluateSuppressions`) set `body = text || html || ''`
  before matching; test-match / test-transform evaluate the fetched envelope
  as-is, and a full-fidelity row's envelope is the wire object, which has no
  `body` — so a `body` condition tests false on exactly the rows where
  production matches it (pinned as found: `tests/ingestRulePreview.routes.test.js`
  golden "body condition window", `tests/automationReadIngest.mysql.test.js`).
  Casey's preview applies the derivation (`ingestRulePreviewService.
  productionEnvelope`); the route adapters do not, to keep the golden. Fix: use
  `productionEnvelope` in `testMatch` / `testTransform` too, and refresh the
  golden.
- **No route or screen reads the ingest rule change log** (A20 slice 1,
  2026-10-27). `{email,phone}_ingest_rule_changes` is written on every real
  rule / action change; Ask Casey's `automation.definition` reads the latest
  five as field-level `change` rows for every staff member (A20.2 — the rows
  carry what the rule rows carry, minus the http redactions, and the rules are
  readable by all staff), and Casey can prepare the reverse edit as a card.
  There is still no native read route: an editor "History" pane with a
  "restore this version" action would make the revert a click. Gate: RULED
  (Fred, 2026-10-27) — the log is readable by all staff, like the rules. No
  retention needed at ~10 edits/month.
- **A throwing ingest match is fail-quiet.** It is a console warning only —
  no execution-row warning, no metric, no alert — where the trigger engine
  records the same case (AI_CONTEXT §26). A rule that silently throws on every
  message looks like a rule that never matches; consider recording it in
  `_parse_warnings` and an outcome the alerting sweep already watches.
- **Ingest draft preview.** The preview kind evaluates stored rules only;
  A20.2 did without one (a Casey-created rule is stored inactive, so it can be
  previewed at once). A preview of an UNSAVED edit to an ACTIVE rule ("this
  change would have matched N of the last 40 messages") would sharpen A20.3's
  card; its conditions/mapper are regex-free by construction, so the ReDoS
  question is already answered for Casey's drafts.
- **Run hookFilter `matches` and the mapper `regex:` transform on V8's linear
  engine** (A20.2, 2026-10-27). Both compile `new RegExp(pattern)` on the
  backtracking engine, in-process, for every inbound message (ingest), hook
  event and trigger — a pathological pattern any staff member can save blocks
  the event loop per message (CLAUDE.md: validator regexes stay linear). CTA
  input patterns already use the `l` flag (`services/ctaService.js`
  LINEAR_RE, enabled by the Dockerfile CMD flag). Measured: the 44 live ingest
  `regex:` descriptors all compile under `l`; hook / trigger / suppression
  patterns not yet measured. Until then Casey writes no new pattern
  (preserve-only).
- **Casey ingest `http` actions** (A20.2). They wait for A17.4b's literal-URL
  / named-credential contract (build it once, use it for webhook steps and
  ingest http actions). (Forwards shipped as ingest actions 2026-10-27, Fred's
  yes; `court_extract` stays off the allowlist.)
- **Forwards in Casey WORKFLOW drafts** (A20.2 follow-up). `forward_as_email` /
  `forward_as_sms` are ingest-action authorable only. To make them
  workflow-draft authorable, `workflowSendAnnotation` must hold a forward's
  `to` to a literal (or a closed placeholder set) the way it holds the sender,
  and the `event` param needs an envelope variable the workflow actually has
  (an ingest- or hook-started run's init data); the native workflow picker
  hides them today (`__meta.uiHidden`).
- **Applied ingest card deep link** (A20.2). The automations manager has no
  ingest-rule record opener (`ASSISTANT_RECORD_BY_SUB` covers workflows,
  sequences, jobs, hooks), so an applied card shows "find it under More →
  Automations → Email / Phone" instead of opening the rule.

## From the Ask Casey arc — A14 direct sends (2026-10-27) — deferred

- **Attachments / MMS, cc/bcc, reply threading, scheduled sends** for Casey
  send cards — each its own reviewed shape (a fetched attachment URL still
  stays model-uninventable).
- **The email Case field.** The card does not send `case_id`, so a Casey email
  is not case-linked by the hub's `mail_sent_case_link` path; offering it
  means disclosing the case-link job on the card.
- **Appointment confirmations through the A14 bar.** The appointment routes
  resolve `confirm_message` placeholders after the click, so the appointment
  cards keep forcing sends off (course correction 3). Either resolve on the
  card and send the resolved text, or keep the separate send card.
- **No `yc-sync` matcher for either send route** — an open Comms /
  Communications view does not hear a send from another frame (human or
  Casey); the record arrives later via the provider echo / mail ingest.
- **A claimed-then-refused send reopens as "outcome unknown"** (the P5 ledger
  limit below): the route's refusal is shown live, but reopening the chat
  shows the conservative wording.

## From the Ask Casey arc — A16 report drafts (2026-10-27) — deferred

- **The other report kinds.** Update (PUT, honouring the lock), run, lock /
  unlock, delete and restore are separate reviewed kinds; only create ships.
  Update needs a P3 precondition (`updated_at` or a version) — PUT today
  overwrites whatever is there, after snapshotting it.
- **Views.** Casey saves `kind:'report'` (Reports' run panel, where CSV
  lives). A work list with clickable rows is a `kind:'view'` in
  customView.html; offering it means teaching the views half of the
  reportBuild prompt (actions, select params, the default/sentinel trap).
- **A CSV control on the card itself.** Today the export is Reports' own CSV
  button, one click after Open. A card control would call the canonical run
  route and build the same CSV (through `public/js/csvSafe.js`).
- **The Reports AI author's prompt still says SSN and DOB are "forbidden
  outright"** (`lib/aiPrompts/reportBuild.js` refusal list) — stale since the
  2026-09-24 ruling, and now contradicted by ruling 2 of 2026-10-27 (last-4 by
  default, full when asked). Left unchanged: changing what the Reports Ask box
  writes is outside A16.
- **Reports does not report its open record to the workspace URL.** The
  `reports.report` destination hands `report~<id>` down, but `reports.html`
  never calls `ycSubTab.leaf.report`, so a reload does not reopen the report
  and the assistant's workspace context cannot name it.
- **Preview masking is by column origin plus a full-read rule.** A direct
  `contact_ssn` / `contact_dob` column is masked whatever its alias; when the
  SQL reads either in full, expression columns are hidden and SSN-shaped cells
  masked. A derived-table column that MySQL reports with the derived alias as
  its origin falls to the shape mask only. The definition itself is never
  masked — by design.

## Recipient opt-out (ruling 2026-10-27) — follow-ups

- **Portal login PIN is exempt by design** (`portalAuthService`: the client
  typed that destination seconds ago and asked for the code; refusing locks
  them out of the portal). Confirm.
- **Appointment confirmations skip silently-ish.** A staff-ticked
  confirm SMS/email to an opted-out recipient is skipped with a log line only;
  the appointment form could show the opt-out next to the confirm boxes.
- **Inbound STOP does not set the flag.** A carrier STOP surfaces as
  `phone_event_log.delivery_reason = 'opted_out'` on later sends, but nothing
  sets `sms_optout`; an automation (or the STOP handler above) could.
- **Sequence preview** (`previewEnrollmentSteps`) does not flag a step that
  would skip for opt-out.
- **Sending forms:** declining the opt-out confirm aborts the rest of that
  action's recipients — the page's existing any-error-aborts-the-action
  loop. Per-recipient error handling would fix both.
- **Not gated on purpose:** e-sign reminders / requests (the provider sends),
  the legacy `/ringcentral/send-sms` trap, and every staff/IT-recipient send
  (alerts, digests, task notices, decision requests to a user).

## From the contact-intake safety slices (2026-10-27) — deferred

- **A transfer's donor isn't announced on the sync bus.** "Create a separate
  new contact" announces only the new contact (`public/js/yc-sync.js`
  `intakeGetter`); open frames of the contact that lost the phone/email keep
  showing it until reload. Predates these slices; now reachable from New Client.

## From the Ask Casey arc — P4 idempotency follow-ups (2026-10-22)

The migration ran live on 2026-10-22 and `request_idempotency` is in
`ref/database.sql`, so these are open follow-ups, not blocked ones:

- **`request_idempotency.idem_key` belongs in `tests/schemaCollationBin.test.js`'s
  `BIN_COLUMNS`.** The column is deliberately `utf8mb4_bin` (an opaque token; under
  general_ci two keys differing only in case would collide into a false replay), and
  that lint is where the deliberate `_bin` columns are declared.
  `ref/SCHEMA_CONVENTIONS.md` states the general_ci rule without mentioning the
  `_bin` exception the test enforces — fix that line in the same slice.
- **Nothing prunes the table.** Rows are tiny and the firm has four users, so there
  is no pressure; `idx_request_idempotency_created` exists so an age sweep can delete
  by `created_at` whenever one is wanted.
- **Ambiguous-result observability is deliberately out of P4-minimal.** A settle that
  cannot record (`recorded:false`) and the `unknown` outcome only `console.error`
  today. P7 asks for an alert on duplicate/ambiguous writes; that is where it belongs.

## From the Ask Casey arc (fix package 2026-10-21, P2 inventory 2026-10-22) — deferred

(The actions arc's own roadmap is `ref/ASK_CASEY_ACTIONS_PLAN.md`; these are
the native-side leftovers it surfaced.)

- **The write route validates no assignee and no provider** (P2 inventory,
  2026-10-22). `taskService.createTask` has no SELECT in it: `to` is never
  looked up, so a disabled, offboarded or nonexistent user id is written to
  `task_to` by any caller, Casey's card or the native form alike (measured on a
  real engine: `to: <disabled>` and `to: 987` both succeed). `createAppt` does
  not check `appt_with` either. For Casey this means assignee eligibility is
  checked only when the proposal is built, and a staff change inside the card's
  15-minute window is invisible at click time. Fix belongs in the canonical
  services (reuse `taskService.findAssignableStaff`'s predicate — the same one
  the `user_auth = 1` bug taught us to share), which also closes it for native
  callers.
- **`assistantService.eventDraftProvider` accepts a disabled provider.** It
  filters on `does_appts = 1` only, with no `user_auth` / `user_type` test,
  unlike `APPT_PROVIDER_SQL` next to it; `public/eventform.html` filters both,
  so Casey can propose an availability scope staff cannot choose by hand.
- **Event complete/cancel accept non-Scheduled and superseded rows.**
  `eventService.completeEvent` refuses only "already Completed" and
  `cancelEvent` only "already Canceled"; neither reads
  `superseded_by_event_id`. So a Canceled event can be flipped to Completed
  with resolution `held` (cancelling its reminder tasks and emitting
  `calendar.resolved`) — a transition the native UI never offers, because
  case/contact/index only show Complete and Cancel on a Scheduled event.
- **`taskService.updateTask` has no terminal-state guard.** Only the
  `task_due` → status recompute is guarded, so title/description/start/link can
  be edited on a Completed or Deleted task; `tasks.html` offers Edit only while
  the task is open.
- **Appointment attended/no-show accept terminal rows.** `markAttended` /
  `markNoShow` guard only the same-status repeat, so a *Rescheduled*
  predecessor can be marked No Show — and since an `appts` predecessor's only
  supersession marker is its status, that erases the tombstone and the row
  counts as live again. The native path reaches the same transitions but only
  behind its "Status Correction" confirmation. Candidate for P3 (a card-carried
  precondition) rather than a service guard, since a guard would also block the
  native correction.
- **The A5 row-version precondition has one-second resolution.**
  `contact_phones.updated_at` is a `timestamp` with no fractional seconds, so
  two updates inside the same wall-clock second are byte-identical and a change
  made in the same second as the proposal's read passes the check.
- **Appointment routes answer a status conflict as 500.** `apptService` now
  throws `status:409, code:'appt_status_conflict'` for a repeat cancel /
  reschedule / reschedule-later, but `routes/api.appts.js` maps every
  non-"not found" error to 500 (the message still reaches the user). Map
  `err.status` like the PATCH route already does.
- **The generic `PATCH /api/appts/:id` writes `appt_status` raw.** Its allowlist
  includes `appt_status` (shared with `update_appointment`), so a PATCH can
  un-tombstone a Rescheduled row that already has a successor, with no
  automation or calendar effect. Not guarded in the fix package: the PATCH has
  no transition service to put a guard in, and native callers use it for
  corrections. Decide whether `appt_status` should leave that allowlist
  (transitions only through the dedicated routes).

## From the async hook receiver research (2026-10-27) — deferred

- **Trigger doorbell rings in the throttled tail — most trigger rules wait for
  the cron.** Measured 7 days (2026-10-20→27, n = 613 `domain_event_queue`
  rows): only 37% claimed within 2 s, 41% within 3 s; the rest spread 4–53 s,
  i.e. the 60 s `/process-jobs` sweep. Cause is the one `lib/domainEvents.js`
  names: `emit()` INSERTs the row and rings the Cloud Tasks doorbell AFTER the
  response, under Cloud Run's post-response CPU throttle, so the awaited
  `createTask` often starves and the task never lands. The same enqueue
  awaited BEFORE the response (hook phase 1, first-step `workflow_resume`
  jobs for wf 17/20/53, n = 640) lands 97% within 2 s. Fix is a per-site
  audit: make the ~27 `emit()` call sites `await` it where the site is not
  deliberately post-response (`advanceStage` must never block the primary
  action), or move the INSERT + doorbell into the request span and leave only
  the evaluation detached. Matters for trigger actions a person is waiting on
  (a text, a task). Research: `local/RESEARCH_async_hook_receiver_FINDINGS.md`
  §3.5. Own small slice; the async hook receiver (S0–S2) does not touch it.
- **Hook S2 — Logs tab for the queue + a Replay button.** `received` rows show
  their queued age; `POST /api/hooks/executions/:id/replay` (manageHooks)
  inserts a NEW row from the old `raw_input` with `meta.replay_of` and rings
  the doorbell — replaces "paste raw_input into Live Test". Six-width survey.
- **Hook dedup — guard a misconfigured `dedup_path`.** A path at a non-unique
  field (an event type, a line number) makes every later event for that hook a
  "duplicate": answered 200, no row, no Logs-tab trace — the only evidence is
  the receiver's `console.warn` (S3 review, 2026-10-27). Ideas: refuse a path
  whose value repeats across the hook's last N executions at save time; a
  per-hook duplicate counter surfaced in the editor; a TTL on the unique
  window. Operator-error class; S3 shipped without it.
- **Hook S3b — collapse the second hop.** A hook-started workflow now pays
  two doorbell hops (receiver → drain, drain → workflow start: ~+1–2 s, and
  the ≤ 60 s cron tail on each). Inside the drain, after `scheduleResume`,
  run the first step inline (`runJobPass(db, {jobId})`, request-bound) —
  needs `deliverWorkflow` to surface the job id. Fred accepted the hop for
  S1; build only if inbound-SMS latency is felt.

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

- **Automated birthday greetings (SS, 2026-10-27).** The Contacts tab's
  Birthdays filter + Export is the manual path (`contactService.birthdayDays`,
  built to be pulled out whole). The "top of mind" goal is a scheduled
  workflow that sends the greeting itself — a daily job over the same
  month-day predicate, with an opt-out check and a per-year dedupe key. Only
  190 of 1,108 contacts carry a DOB (live, 2026-10-27), so it is only as good
  as DOB entry at intake.

- **Contacts export: every phone and email (2026-10-27).** The Contacts tab's
  Export writes what `contactService.listContacts` returns — the primary
  `contact_phone` / `contact_email` and one address. A contact's other numbers
  and emails live in their child tables, which the list query doesn't join; an
  export carrying them needs a backend opt-in (an `include` param on
  `GET /api/contacts`, aggregated per contact) plus columns in
  `CONTACT_CSV_COLUMNS` (`public/scripts.js`). Until then a report exports any
  shape. Fred, 2026-10-27: simple → ship, complex → defer and rely on Reports.

- **Pinned pages on a second public domain (2026-10-21).** `pages.host` is bound to `landing_hosts` (pageService.assertHostAllowed), but the landing branch of `pageHostMiddleware` canonicalizes every GET on a non-first landing host to `landing_hosts[0]` BEFORE the pin lookup, so a page pinned to e.g. `www.4lsg.com` is accepted at write and never served by GET. No live row is affected (all 8 `pages` rows had `host` NULL on 2026-10-21). RULED (Fred, 2026-10-22): refuse non-canonical hosts at write — done in `pageService.assertHostAllowed` (only `landing_hosts[0]` is accepted). Revisit — check pins before canonicalizing — when a second marketing domain is wanted; converges with YCv3 multi-site (`pages.site_id`).
- **YisraMail direction (review 2026-10-21; Fred: yes, future plan, nothing
  started).** YisraMail is a bulk **transport** — an email adapter /
  credential carrying `bulk_ok` (`ref/MAILBOX_SYSTEM_DESIGN.md` §4.2: specified,
  never built) — plus campaign-audience → **sequence enrollment**. It is NOT a
  third flow engine: steps, waits, conditions, holds, dedup and versioned
  enrollments already exist in sequences, and a parallel engine contradicts
  "one event bus" (YC 3.0 direction above). Today campaigns bypass the mailbox
  system entirely (no grants, no Sent copy, no budget; the sender is free text
  matched to `email_credentials`). First slice — **campaign hardening**:
  recipient cap enforced in `campaignService.createCampaign` (API keys reach
  `POST /api/campaigns`, so a UI-only cap is none), counted against
  `mailboxSendService`'s budget via `transportOf` / `checkBudget` (today one
  300-contact SMTP campaign spends the whole 300/day smtp budget and locks the
  hub for humans), non-`bulk_ok` credentials refused above the cap, a
  campaign-send capability (every campaign route is plain `jwtOrApiKey`: any
  staff login sends as any firm address). **Cap RULED (Fred, 2026-10-22): 50
  default, firm-configurable** — live `campaigns.contact_count` was checked
  first: the largest campaign ever sent is 12 contacts, so 50 touches no real
  use today.

- **Opt-out system.** The row toggles (contact form) and the staff warn-but-don't-block on direct sends are live (ruling 2026-10-27 — see "Recipient opt-out" above). Left: opted-out badges on the contact / compose surfaces, and an inbound STOP handler via YisraHook.

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
  - **A.4 retirement item — the one-time bridge UPDATE**: 57 live mailbox-2 rows (2026-10-13) are on the log through the Apps Script source but carry no `mail_messages.log_id` stamp, so `has_case`/`no_case` filters and viewCounts miss them while the S2P log-status line shows them bridged. At the Apps Script retirement (deferred by the 2026-10-25 close check — `ref/MAILBOX_GMAIL_PARITY.md` §4–§5), run the one-time stamp backfill (`UPDATE mail_messages m JOIN email_ingest_executions e ... SET m.log_id = e.log_id WHERE m.log_id IS NULL` keyed the priorLogId way) — then the filters agree with the display. Window rule forbade it in S2P.
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

- **Plaintext `users.password`: order of the retirement** (View-as fix, 2026-10-21; RULED go — Fred, 2026-10-22: proceed; Fred switches the Pabbly connection's auth to an API key as step 1's opener, then the slices below; the column-drop gate in CLAUDE.md applies at the end). Writers today: `auth.password.js` reset + change, `admin.users.js` set-password. Code readers: `/db` (`dbQuery.js` — LIVE: Pabbly Connect as `automations`, 75 calls 2026-08-03 → 2026-10-19 in `legacy_route_log`, one as `fred`), `/db64`, `/unplacehold`, the legacy `/dropbox/*` routes. (`/auth/P_validate` was deleted in the same fix: 0 calls since 2026-07-31.) Stopping the writes first does NOT retire anything — the stale plaintext keeps authenticating `/db` with the OLD password. So: (1) move the Pabbly `/db` flow off plaintext and delete the four reader routes; (2) stop all three writers in one slice; (3) Fred-run migration NULLs the column, then DROPs it after the drop-a-column sweep (code, schema objects, stored report/workflow/tool definitions, `lib/reportSchema/manifest.js` `users_password`).

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

- **A workflow step that fails on EVERY run stays a warning.** `_scanWorkflows`
  (lib/alerting.js) files an ignore-policy step failure inside a
  completed_with_errors execution as `warning` — never emailed. wf27 step 44
  (query_ai, website-lead triage) failed on all 4 leads 2026-10-23→26
  ("aiService.call is not a function", a load-order cycle — fixed, CLAUDE.md
  lazy-require line) and nobody was told. The alert convention says repeated
  → error: escalate when the same (workflow, step) failed in N consecutive
  executions (or N within a day), the sequence scanner likewise.
- **`DELETE /workflows/:id` answers 500 on any workflow that has ever run.**
  `fk_workflow_executions_workflow` is `ON DELETE RESTRICT` (steps and
  versions CASCADE), so the route's final `DELETE FROM workflows` fails, the
  transaction rolls the step delete back, and the caller gets a generic
  500 "Failed to delete workflow" — the route's own header says so. Nothing is
  lost, but the answer reads as a server fault. Fix: inside the transaction,
  count `workflow_executions` for the id first and answer 409 "N executions —
  deactivate instead" (`PUT` `active: 0`); keep the 500 for real faults.
- **Manual workflow start and resume still DETACH `advanceWorkflow` after the
  202.** `POST /workflows/:id/start` and `POST /executions/:id/resume`
  (`mode: 'resume'`) answer, then run the advance in an unawaited async block —
  the post-response path Cloud Run CPU-throttles, which the 2026-08
  background-CPU slice removed from hook/trigger starts
  (`actionDispatchers.deliverWorkflow`: INSERT, then `await
  scheduleResume(executionId, new Date(), 1, db)` before returning). A long or
  code-heavy run started from the editor therefore crawls (the 20–45× slowdowns
  and vm-watchdog timeouts the slice measured) and dies with the instance. Fix:
  same shape as deliverWorkflow — `await scheduleResume(...)` before the 202,
  no detached block. Tradeoff for Fred: the run then starts on the queue, not
  in the request — normally within a few seconds (the ≤ 90 s Cloud Tasks
  doorbell, `enqueueResumeDispatch`), up to the 60 s `/process-jobs` tick when
  the doorbell fails — and the 202's `status: "processing"` would read
  `queued`. The single-step resume mode runs synchronously and is unaffected.
  A third site has the same detached block: the resume after a
  `request_decision` answer in `routes/decisionActions.js` (after it flips the
  execution and deletes the pending timeout resume) — fix it in the same slice.
- **WF27's decision-outcome notes are unlinked.** `logDecisionOutcome`
  (`lib/internal_functions/decisions.js`) links an outcome note to the
  execution's contact, but every WF27 ("static site hit") execution has
  `contact_id` NULL (84 of 84, 2026-10-17): the workflow sets no
  `default_contact_id_from`, and nothing fills the contact in after its
  intake step creates one, so all its outcome notes float free. Options:
  set WF27's `default_contact_id_from`; backfill the execution's
  `contact_id` from the intake step's output; or link the note through
  `lead_case_id`. Any of these changes a live workflow definition — CLAUDE.md's
  rule for scripts that mutate automation definitions applies.
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
  (1) Now: raise the GCP budget alert to ≈ $70 (the bill is ≈ $42/mo with the
  commitment, `INFRA_GCP.md` §2; the alert was set for a ≈ $8 bill). The
  Budget API is disabled on the project: set it in the console, Billing →
  Budgets & alerts. (2) DONE 2026-10-27: the 1-year
  committed-use discount, $0.05/h discounted to 2027-10-27, no auto-renew
  (`INFRA_GCP.md` §2) — decide the renewal before it ends. (3) DONE: the
  cutover copies of client data are deleted (Cloud Shell's home and the
  migration bucket, 2026-10-14) and the SiteGround database is gone
  (2026-10-25). Cloud SQL's own backups and 7 days of point-in-time recovery
  are the safety net from here. (4) DONE: the NAT chain
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

- **Test-suite governance arc (Phases 2–4 of the 2026-10-18 test-suite review;
  independent review's verdict 2026-10-21: adopt with amendments).** Phase 1's
  first pass shipped 2026-10-21 (trigger vm timeout, Dropbox backoff on a fake
  clock, caseId aggregation, wsurl microtask tick); still open from it: phone-search / form auto-advance
  fake timers, the comms wall-clock benchmark, the mascot clock (entry
  below). Remaining: (2) lanes + truthful scripts — dependency-gated suites
  (37 mysql, 3 Chromium/PDF, 1 Dovecot) out of ordinary discovery, each lane
  with a command, owner and cadence (the mysql suites run on no schedule
  today); (3) consolidate ONE feature family through an assertion-to-risk map;
  (4) runtime budgets per lane, a reason required for any new real-time test,
  flaky tests tracked as owned defects. Constraints: the default `npm test`
  stays the FULL suite; `land.sh` (the real gate — it waits for the GitHub
  Actions run on the landing SHA; cloudbuild runs no tests), `local/heavy-gate.sh` and CLAUDE.md change
  together in one slice; inventory/governance tests (settingsInventory,
  manualReadmeCoverage, CTA eligible-set, ctaInputs, scriptGuard) and
  CLAUDE.md-required timing guards are exempt from pruning (redesign a timing
  guard as a scaling ratio, never move it out); lanes are separate config
  files, not jest `projects` (a bare `npx jest` collects every project);
  pruning a slice-named suite must be mutation-proven and update every doc
  that cites the file. Review: `local/to review/TEST_SUITE_INDEPENDENT_REVIEW_2026-10-18.md`
  (gitignored).

- **Branch protection on main (remote-land-suite phase 2; Fred approved in
  principle 2026-10-27, enable ~2026-11-03 after a week of green CI lands).**
  Require status check `test`, "do not allow bypassing" — every session
  pushes as the admin account 4LSGIT, so without no-bypass the rule binds
  nobody. Before Fred clicks, three things ship: (1) a replacement for his
  `git go` alias (add + commit + push to main) that pushes a `land/fred-<sha>`
  branch, waits for green, then pushes main; (2) a written break-glass:
  while the rule is on, an Actions outage blocks EVERY deploy — a
  `land.sh --local-suite` green is invisible to GitHub and its push is
  refused too — so the steps to lift the rule and restore it (`gh api -X
  DELETE repos/4LSGIT/apigcr/branches/main/protection`, then the exact PUT
  body to restore it) are dry-run and filed with it; (3) land.sh's
  `--local-suite` NO-GO for a refused push names that break-glass. Flaky
  suites cost a rerun under the rule, not a blocked deploy.

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
- **Audit-log hygiene:** 30-day retention cron for `jwt_api_audit_log` and
  `query_log`. (No stored row carries a Bearer token — 0 match `%Bearer %`,
  2026-10-25.)
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

## Report/assistant least-privilege DB user (ratified 2026-10-21, review Q1)

The reports engine and Ask Casey run their SQL on `startup/dbReadonly` — the
`yc_ro` MySQL user, which holds `SELECT` on the WHOLE schema. The app-layer
report validator (`lib/reportSchema/validator.js`) was hardened in the
validator-containment arc (2026-10-21) so its table allowlist and `*` ban can
no longer be side-stepped by alternative join/statement spellings, with a
whole-statement word-scan belt over the sqlGuard SECRET/SENSITIVE tiers (plus
`assistant_chats` / `assistant_chat_messages`, moved to SENSITIVE that day).
That closes the known holes, but the validator is still the ONLY barrier — a
future gap in it is a breach, not a failed query.

Fred ratified the real fix: a MySQL user whose privileges are **per-table and
per-column**, generated from the manifest, replacing `yc_ro`'s schema-wide
SELECT for reports+assistant. Tables outside `ALLOWED_TABLES` (app_settings,
email_ingest_sources, the assistant chat tables, backups/junk) get no grant;
`DENIED_COLUMNS` (password/password_hash/reset_*, the access tokens, the raw
`custom` JSON bag) are withheld at the column level. Then a validator miss is a
`SELECT command denied`, not a leak.

- **Provisioning draft shipped:** `scripts/reportGrantUserProvision.js` —
  ops-script conventions (one connection from `.env`, read-only CHECK default,
  `--apply` asserts live state → writes → verifies from `SHOW GRANTS` → one
  GO / NO-GO line). It enumerates each allowlisted table's real columns from
  `information_schema` (so generated `cf_*` custom-field columns are covered),
  minus `DENIED_COLUMNS`. The new user's name/password come from env only
  (`REPORT_DB_USER` / `REPORT_DB_PASSWORD` / `REPORT_DB_HOST`), never a CLI arg,
  never committed. Fred provisions it by hand; the arc did NOT run it.
- **Provisioned live 2026-10-22** (`'yc_report'@'%'`, GO: 21 tables / 392
  columns, secrets withheld). Two Cloud SQL lessons baked into the script the
  same day: the account host is `%` (connector presents as `cloudsqlproxy~…`,
  no fixed egress IP) and revokes are TARGETED per SHOW GRANTS line — Cloud
  SQL's root cannot run the global `REVOKE ALL` (no rights on `sys`).
- **Pool split shipped (same date):** `startup/dbReport.js` carries
  reports+assistant (`services/reportService.js` requires it); the public
  `/api/readonly/sql` endpoint STAYS on `startup/dbReadonly`/`yc_ro` BY
  DESIGN — its SU-minted keys are sqlGuard-tiered and legitimately read
  outside the report manifest (`rw_scratch`, information_schema). Until the
  `user_report` / `password_report` env vars exist on the service, dbReport
  falls back to the dbReadonly pool with a loud boot line
  (`[dbReport] … RUNNING ON THE BROAD dbReadonly POOL`). The app-layer
  validator stays regardless — defense in depth and clean refusals.
- **DONE 2026-10-22 — the switch is live and verified.** Fred set
  `user_report` / `password_report` on the Cloud Run service
  (`--update-env-vars`) and in `.env`; verified: boot log shows the
  least-privilege line (not the fallback), a saved report runs, an assistant
  question runs, and a `ycro_` key still reads `rw_scratch` (readonly pool
  untouched). Any future validator miss on the report/assistant surface is
  now a `SELECT command denied`. Maintenance coupling below is the one live
  obligation left.
- **Maintenance coupling:** a new allowlisted table or a newly denied column
  means re-running `--apply` (the grant set is generated, not hand-maintained).
  Note this where the manifest is edited.
- **A dropped column leaves an orphaned grant** (proved on 8.4.11, opt-out
  drop 2026-10-27). The grant set is read from the LIVE schema, so the
  manifest's column list does not drive it, and a `DROP COLUMN` does NOT fail
  on `yc_report`'s per-column grant: the DROP succeeds and the grant stays in
  `mysql.columns_priv` / SHOW GRANTS, inert, until cleared — and it
  re-attaches to any later column of the same name. `--apply --rotate` clears
  it (its targeted REVOKE of the SHOW GRANTS line succeeds though the line
  names a dropped column; the plan, read from information_schema, no longer
  grants it), as does a root `REVOKE SELECT (<col>) ON <db>.<table> FROM
  'yc_report'@'%'`. The contacts opt-out pair is orphaned this way once
  `scripts/optoutContactColumnsDrop.js --apply` has run, until either clears
  it.

---

*Last updated: 2026-10-21*

## Contact SSN last-4 in API responses (Fred idea, 2026-10-27)

`GET /api/contacts/:id` is a `SELECT *`, so every contact load puts the full
`contact_ssn` in the browser (Casey's A14 click-time recipient re-read included,
which never shows it). Two steps:

1. **Additive, safe any time:** add a derived last-4 field to contact responses —
   strip non-digits first (`ssn.replace(/\D/g,'').slice(-4)`, `null` when empty;
   stored formats vary, 14 of 151 carry dashes). Name it neutrally
   (`tax_id_last4`): orgs keep their EIN in `contact_ssn`. Decide every route
   that returns contact rows (lists, search, case contacts) in the same slice.
2. **Breaking, opt-in:** full `contact_ssn` only when asked (e.g.
   `?include=ssn`), after a sweep of every frontend reader of `contact_ssn` from
   these responses (contact page SSN display/edit, forms prefill, sync-bus
   `changes` diffs). Server-side template resolution (`{{contacts.contact_ssn}}`,
   Form 121) reads the DB directly and is unaffected.
