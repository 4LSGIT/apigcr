# YisraCase Plans & Future Ideas

Living doc. Deferred work, design ideas, and known cleanups — not active development. Move to a session/slice plan when you actually start.

---

## SaaS-readiness (deferred indefinitely)

Abstractions that would matter for offering YC to a second firm. Not relevant to 4LSG-only operation. Each can be picked up independently when a second customer is real.

- **Provider driver abstraction (SMS / email / future channels).** Pluggable per-line driver layer with a registry, dispatcher, and template-driver hook for non-quirky providers via a `provider_templates` DB table. Design doc shelved in `ref/SMS_DRIVER_ARCHITECTURE_DESIGN.md`. The auth half is being collapsed into the existing services as a separate, smaller refactor (Quo and RC `services/*Service.js` migrating to `buildHeadersForCredential`); the dispatch/registry/template work is what's deferred.

- **Calendar abstraction.** `services/calendarService.js` is currently hardcoded around Jewish holidays + Shabbos via Hebcal. Replace with a generic `blocked_dates` table (and possibly a `block_rules` source-table for recurring rules like "every Saturday" or "Hebcal feed for org X"). Per-firm operators populate it through Connections UI.

- **Public-page templating.** `/public/*.html` is hardcoded with 4LSG branding, logos, copy. SaaS deployment would need a template layer (Handlebars or similar) reading per-tenant config — name, logo URL, color tokens, custom domain. Custom-page authoring is an entirely separate problem deferred even further.

- **Multi-tenancy decision.** Even if you stay one-firm-per-deployment, decide before any of the above whether `phone_lines`, `email_credentials`, `credentials`, `contacts`, etc. get a `tenant_id` column. Adding it to clean tables now is cheap; retrofitting later is expensive. Plausible within ~2 years → add as `NOT NULL DEFAULT 1` now.

---

## In-flight migration

Active surfaces with known next steps.

- **Phase 6: iframe conversion of remaining `index.html` tabs.** Iframe boot pattern is established (`(function waitForParent() { if (P.apiSend) return init(); setTimeout(waitForParent, 100); })();`). Continue tab-by-tab.

- **JotForm swap in `case.html`.** Smart fallback is currently in place. Replace with internal YisraForms versions once ISSN and Detailed Questionnaire are built.

- **Remaining YisraForms.** ISSN (tabs + repeaters, snapshot mode) and Detailed Questionnaire (JSON-only storage, most complex). The biggest remaining YisraForms work.

- **Legacy frontend retirement.** Old `index.html` and any `/db` raw-SQL endpoints stay alive during gradual migration. Once Phase 6 completes and the new frontend is verified, these all come out together.

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

- **Documentation drift sweeps.** Periodically diff `manual/`, `13-cookbook.md`, and `YISRACASE_AI_CONTEXT.md` against actual code. Drift accumulates.

---

*Last updated: 2026-05-17*