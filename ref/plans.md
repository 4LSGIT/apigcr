# YisraCase Plans & Future Ideas

Living doc. Deferred work, design ideas, and known cleanups — not active development. Move to a session/slice plan when you actually start.

---

## Settings vs Config (2026-09-24)

Two operator surfaces, ratified:

- **My Settings** (settings.html, slimmed): personal — account, password, signature,
  custom tab.
- **YisraCase Config** (caseConfigManager.html, renamed from "Case Config"): every
  firm-wide vocabulary editor as a first-class tab — types/subtypes, pipelines,
  calendar types, custom fields (CFG-1), contact roles (CFG-2), eventually contact
  relation types. Rule of admission: **Config gets definitions that have no manager of
  their own** — checklists and form templates are content with their own authoring
  surfaces and stay there. One editor per setting, never two (CFG-1 deletes the
  settings.html Case Types editor: it writes fe-case_types with no usage check or
  template repoint, unlike caseconfig/types.html — a live footgun, not just clutter).

PENDING (parallel session; do not bake in):
- CFG-3: whether app_settings category sections become a "Firm Settings" tab in the
  Config shell, and how tool-grouped settings split between tool managers and that
  tab. Gate finding (2026-09-24): PUT/POST /api/app-settings/* is `jwtOrApiKey` +
  per-row `is_editable` — no role tier exists; moving knobs into a role-gated shell is
  an access-control change and needs its own ruling.
- Machine-state rows (sweep watermarks, counters, rc_subscriptions…) are a fourth
  kind — automation-minted runtime state hiding behind is_editable=0, which ALSO means
  "SU-only boundary" (landing_hosts). Likely: separate flag + read-only diagnostics
  view. Don't design against is_editable semantics meanwhile.
- Collision: ui-custom arc decided "the tenant admin tool is just the role-gated
  firm-settings editor" — that editor and the Config shell must converge on ONE
  surface.

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
  → `ref/CUSTOM_FIELDS_DESIGN.md` (living doc; v2 pilot S0–S6 built, S5-B gated on a soak).
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
tenant binding). Infra intents, **gated on funding approval**: Cloud Run
`min_instances=1` and the Cloud SQL migration; the pool connection budget
(per-pool limit × max resident pools per instance × max instances) is sized
after that move, LRU machinery deferred until the budget shows it's needed.

### Open decisions (audit §3; answer before the affected slice)

1. **RESOLVED 2026-10-05** (SHOW TRIGGERS pasted): 13 triggers definer
   `sgkmtgfarbwxw@localhost` (SiteGround primary user, still extant or writes
   would fail), 2 definer `uai6bp5cbi4ij@35.227.91.145` (`contact_name_*`,
   2026-09-08); per-trigger saved sql_mode is heterogeneous (3 variants) —
   harmless, but provisioning stamps the session mode at creation. Ruling:
   strip DEFINER on every dump/import; the migration account becomes definer
   everywhere and is permanent. **⚠ Cloud SQL migration gotcha, independent of
   tenancy: importing a SiteGround dump with DEFINER clauses intact breaks
   (`sgkmtgfarbwxw@localhost` won't exist there) — strip them.** Still patch
   `lib/schemaDump.js` to record DEFINER + per-trigger sql_mode.
2. Stored routines (§3-2; dump has none — confirm with SHOW PROCEDURE/FUNCTION
   STATUS from phpMyAdmin). 3. Shared MySQL server vs instance-per-tenant
   (§3-3; decides GET_LOCK + JSON_OVERLAPS-probe severity). 4. sql_mode
   provenance (§3-4).
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
    (§3-11). 12. **RESOLVED 2026-10-05**: not built — it was the concept
    that motivated SU landing pages. Storage
    (`app_settings.clio_login_code`), authed `GET /clio-code`, and the shell
    button exist; the generic shape goes to
    the ui-customization arc as a declarative launcher **action** primitive
    (config: fetch endpoint → Swal/display), a third registry kind beside
    iframe panes and iframe tools — config, not authored code (§3-12).
13. Heartbeat per-tenant vs platform (§3-13).
14. Provider-console webhook URL inventory at migration time (§3-14).
15. GCS per-tenant buckets vs prefixes (§3-15). 16. Freeze §B4's
    firm/platform key classification against the ratified settings/config
    taxonomy (§3-16). 17. External health probing; `/api/version` reads
    tenant data (§3-17 + §E4).

---

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

- **Custom fields: per-case-type scoping as data (if it gets common).** Since 2026-10-06 a case field meant for some types is a `show_when` on `case_type` (one Custom Fields section, mounted by every Case Details variant). `show_when` v1 is ONE condition, so a type-scoped field cannot also carry a second condition. If that bites, add a first-class `case_types` (JSON list) to `field_defs`, ANDed with `show_when`, rather than growing v1 into and/or trees.


- **SMS auth-only migration (active now, not really "future").** `quoService.js` and `ringcentralService.js` move from `app_settings.quo_api_key` / `app_settings.rc_token` + parallel OAuth state to `buildHeadersForCredential(db, credential_id, url)`. Quo first (smaller blast radius), RC after. Cleanup deletes `loadToken`, `refreshAccessToken`, the boot-time load, and the `routes/internal/mms.js` `loadToken` middleware. The same pattern applies to email (`emailService.js`) once SMS is done — `email_credentials.smtp_pass` plaintext column also goes away as part of email's migration to Connections.

---

## Security cleanups (mostly blocked on legacy frontend retirement)

- **Plaintext `password` column removal** on the users table — blocked on old frontend retirement.

- **`/db` and raw-SQL endpoint kill** — blocked on old frontend retirement.

- **`// TODO: REMOVE` markers** scattered across the codebase — clean sweep at the same time.

- **`email_credentials.smtp_pass` plaintext** — replace with Connections `basic`-type credential row. Either as part of email's auth migration (above), or as its own pass.

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

- **Cloud Scheduler interval.** Currently 5 minutes (set conservatively at launch). Drop to ~30 seconds when comfortable. Pure GCP config change, no code.

- **Single-instance vs multi-instance Cloud Run rate-limiting.** Bottleneck limiters in `ringcentralService` are per-process — multiple instances each have their own limiter and don't coordinate. Latent issue at current volume. Future fix is Cloud Tasks per-credential queues; design captured in the shelved driver doc §2.10. Don't act unless rate-limit failures actually surface.

---

## Hygiene

- **SweetAlert2 cross-frame inline-onclick audit.** `Swal` popups render in the parent window's DOM, so inline `onclick="…"` attributes inside a Swal `html:` template literal resolve against parent scope and fail with `ReferenceError` for any iframe-defined function. Three instances of this bug in image-library delete buttons (`campaign.html`, `communicate.html`, `sendingform.html`) fixed in May 2026 — but the pattern is easy to repeat. Sweep all iframes (`case.html`, `contact.html`, `automationManager.html`, etc.) for `onclick=` inside any Swal `html:` block; replace with `class` + `data-*` attributes bound inside `didOpen`.

- **`rc_messages_log` table rename.** Quo also logs there despite the `rc_` prefix. Rename to `sms_messages_log` (or similar) when there's a quiet window — touches every SMS-related call site, so bundle with another sweep, don't do it standalone.

- **Route handler naming.** `scripts/updateRoutes.js` writes `ref/routes.md` — a grep-able access-control matrix with middleware and handler columns per route. Handlers passed as inline arrows (`router.get('/x', mw, (req, res) => {...})`) show as `<anonymous>` in the handler column; named function declarations, `const`-bound arrows, and named function expressions all get picked up by `Function.prototype.name`. When you touch a route file for any reason, name the handlers in it — verb+noun matching URL semantics (`getCases`, `createWorkflow`, `cancelExecution`). No dedicated naming pass. Worst-offender files visible by skimming `ref/routes.md` for sections heavy on `—` in the Handler column. Pairs with the `requireAuth` self-naming convention (see Slice 1 of the client portal work) — together they make `ref/routes.md` a navigable auth + routing map.

- **UI consistency leftovers (mobile arc, closed 2026-10-06).** Labels and hints are unified (AI_CONTEXT §12); still open:
  - **Injected-CSS load order — root cause.** `scripts.js` appends its `<style>` blocks before `style.css`'s link, so every tie goes to style.css; four dialogs needed a specificity bump (CLAUDE.md). Moving the injection after the sheet fixes it at the source but flips EVERY tie at once — needs a full before/after harness at 320–1280, not a drive-by.
  - **Checkbox/radio option labels** ("Active", "Notify assigner…", "All-day event", "SMS") vary: 13px `--text-2`, 0.9em, inherited. The next "one look" layer.
  - **yc-forms sizes are rem-based** — `.yc-label` 0.92rem (14.72px), `.yc-sublabel` 0.8rem (12.8px) against the app's 14/12px tokens. Converge when yc-forms is next touched; check that every page loading it also loads `theme.css` first.
  - **The mobile survey asserts overflow only.** The label/hint uniformity checks were session-scratch Playwright scripts; a `--looks` mode in `scripts/mobile-survey/` would make them a gate.

- **Documentation currency** now has a mechanism (2026-09-14): doc≠code divergences are filed to scratch `ns=docs` at discovery; the weekly docs review (`ref/DOCS_REVIEW.md`) drains the queue and updates `ref/AI_CONTEXT.md`'s currency header. No more ad-hoc drift sweeps.

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

*Last updated: 2026-10-07*