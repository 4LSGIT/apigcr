# YisraCase Plans & Future Ideas

Living doc. Deferred work, design ideas, and known cleanups — not active development. Move to a session/slice plan when you actually start.

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
- **Tenancy model (if multi-tenancy ever happens): leaning DB-per-tenant**
  (not shared-schema tenant_id). Buys: per-tenant AI RO keys safe by
  construction, per-tenant backup/restore, contained migration blast radius,
  eliminates the missed-WHERE cross-tenant leak bug class. Costs: migration
  fan-out (script it), small control-plane DB for provisioning/cross-tenant
  admin. Supersedes the tenant_id-column item under SaaS-readiness below.
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
  → `ref/CUSTOM_FIELDS_DESIGN.md` (living doc; v2 pilot S0–S5 in flight).
- **Billing (unbuilt): agnostic core** — billables → invoices → payments,
  processor drivers. Flag: trust accounting (IOLTA) is the one genuinely
  non-generic legal requirement — table stakes for the legal vertical,
  skippable elsewhere.
- **Driver pattern extends** beyond SMS/email/calendar (SaaS-readiness below)
  to payments, storage, e-sign, telephony.
- **SU landing pages** (get-clio-code-style tools served at the app domain):
  sandboxed plugin surface, SU-only, arbitrary-code risk acknowledged.

---

## SaaS-readiness (deferred indefinitely)

Abstractions that would matter for offering YC to a second firm. Not relevant to 4LSG-only operation. Each can be picked up independently when a second customer is real.

- **Provider driver abstraction (SMS / email / future channels).** Pluggable per-line driver layer with a registry, dispatcher, and template-driver hook for non-quirky providers via a `provider_templates` DB table. Design doc shelved in `ref/SMS_DRIVER_ARCHITECTURE_DESIGN.md`. The auth half is being collapsed into the existing services as a separate, smaller refactor (Quo and RC `services/*Service.js` migrating to `buildHeadersForCredential`); the dispatch/registry/template work is what's deferred.

- **Calendar abstraction.** `services/calendarService.js` is currently hardcoded around Jewish holidays + Shabbos via Hebcal. Replace with a generic `blocked_dates` table (and possibly a `block_rules` source-table for recurring rules like "every Saturday" or "Hebcal feed for org X"). Per-firm operators populate it through Connections UI.

- **Public-page templating.** `/public/*.html` is hardcoded with 4LSG branding, logos, copy. SaaS deployment would need a template layer (Handlebars or similar) reading per-tenant config — name, logo URL, color tokens, custom domain. Custom-page authoring is an entirely separate problem deferred even further.

- **Multi-tenancy decision.** Even if you stay one-firm-per-deployment, decide before any of the above whether `phone_lines`, `email_credentials`, `credentials`, `contacts`, etc. get a `tenant_id` column. Adding it to clean tables now is cheap; retrofitting later is expensive. Plausible within ~2 years → add as `NOT NULL DEFAULT 1` now. **Decision 2026-09-14: hold — do NOT add tenant_id columns.** Multi-tenancy is not happening in v2 and is only a maybe for v3, where the lean is DB-per-tenant (no tenant_id columns needed either way).

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


- **SMS auth-only migration (active now, not really "future").** `quoService.js` and `ringcentralService.js` move from `app_settings.quo_api_key` / `app_settings.rc_token` + parallel OAuth state to `buildHeadersForCredential(db, credential_id, url)`. Quo first (smaller blast radius), RC after. Cleanup deletes `loadToken`, `refreshAccessToken`, the boot-time load, and the `routes/internal/mms.js` `loadToken` middleware. The same pattern applies to email (`emailService.js`) once SMS is done — `email_credentials.smtp_pass` plaintext column also goes away as part of email's migration to Connections.

---

## Security cleanups (mostly blocked on legacy frontend retirement)

- **Plaintext `password` column removal** on the users table — blocked on old frontend retirement.

- **`/db` and raw-SQL endpoint kill** — blocked on old frontend retirement.

- **`// TODO: REMOVE` markers** scattered across the codebase — clean sweep at the same time.

- **`email_credentials.smtp_pass` plaintext** — replace with Connections `basic`-type credential row. Either as part of email's auth migration (above), or as its own pass.


---

## Operational

- **Cloud Scheduler interval.** Currently 5 minutes (set conservatively at launch). Drop to ~30 seconds when comfortable. Pure GCP config change, no code.

- **Single-instance vs multi-instance Cloud Run rate-limiting.** Bottleneck limiters in `ringcentralService` are per-process — multiple instances each have their own limiter and don't coordinate. Latent issue at current volume. Future fix is Cloud Tasks per-credential queues; design captured in the shelved driver doc §2.10. Don't act unless rate-limit failures actually surface.

---

## Hygiene

- **SweetAlert2 cross-frame inline-onclick audit.** `Swal` popups render in the parent window's DOM, so inline `onclick="…"` attributes inside a Swal `html:` template literal resolve against parent scope and fail with `ReferenceError` for any iframe-defined function. Three instances of this bug in image-library delete buttons (`campaign.html`, `communicate.html`, `sendingform.html`) fixed in May 2026 — but the pattern is easy to repeat. Sweep all iframes (`case.html`, `contact.html`, `automationManager.html`, etc.) for `onclick=` inside any Swal `html:` block; replace with `class` + `data-*` attributes bound inside `didOpen`.

- **`rc_messages_log` table rename.** Quo also logs there despite the `rc_` prefix. Rename to `sms_messages_log` (or similar) when there's a quiet window — touches every SMS-related call site, so bundle with another sweep, don't do it standalone.

- **Route handler naming.** `scripts/updateRoutes.js` writes `ref/routes.md` — a grep-able access-control matrix with middleware and handler columns per route. Handlers passed as inline arrows (`router.get('/x', mw, (req, res) => {...})`) show as `<anonymous>` in the handler column; named function declarations, `const`-bound arrows, and named function expressions all get picked up by `Function.prototype.name`. When you touch a route file for any reason, name the handlers in it — verb+noun matching URL semantics (`getCases`, `createWorkflow`, `cancelExecution`). No dedicated naming pass. Worst-offender files visible by skimming `ref/routes.md` for sections heavy on `—` in the Handler column. Pairs with the `requireAuth` self-naming convention (see Slice 1 of the client portal work) — together they make `ref/routes.md` a navigable auth + routing map.

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

---

*Last updated: 2026-09-23*