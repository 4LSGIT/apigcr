# CLAUDE.md — YisraCase (apigcr)

Node.js/Express + MySQL legal case management for a small bankruptcy firm
(4LSG). One repo, one Cloud Run service (`svpcac`, project `lsg-api-425223`,
us-east1, node:24-slim). Sole developer: Fred. Small user base, live
production data — correctness beats speed.

## Behavior

- State assumptions; if multiple readings exist, present them — don't pick silently.
- Trust code over documentation. Read the actual file before making a claim.
- Surgical edits only: match existing style, touch nothing outside the task.
- Report structural divergences from spec before proceeding — never code around them.
- Push back when Fred is wrong. He wants a working system, not validation.

## How we build

Work runs in **arcs** (a feature/fix effort) cut into **slices** — each slice
independently deployable and scope-bounded. Three execution models; Fred
picks per task:

1. **Direct** — focused, single-context tasks: the session executes itself.
2. **Manager–worker** — a manager session plans, verifies, and writes worker
   prompts; separate worker sessions execute; Fred shuttles prompts/reports
   and makes all final calls. Workers report BEFORE shipping: judgment calls
   within spec latitude flagged explicitly; structural divergences stop work
   pending a ruling. Managers keep arc state in scratch (see Scratch below).
3. **Arc executor + reviewer** — one session (often Fable) executes the whole
   arc end-to-end; an independent session (usually Opus) reviews at
   checkpoints or at the end. The reviewer gets the spec + the actual diff
   and verifies from the code, not from the executor's summary.

Gates beyond Commands & gates below, every model:
- Verification-first: ground claims about schema, rows, or behavior in the
  live DB and actual source before writing code or prompts.
- Scripted edits are anchored: `assert src.count(old) == 1` before every
  replace. Complete files (not fragments) for non-trivial edits.
- New test assertions are mutation-checked (break the code, watch the test
  fail); no mocking the module under test; real-engine harnesses preferred.

## Living documentation — the standing rule

These docs are LIVING. Every arc is expected to leave them better; **an arc
is not closed until its learnings are filed and its `fred/<arc>_state`
scratch key reflects the close.**

- **At discovery:** doc says X, code does Y → file it, don't work around it:
  `PUT /api/scratch/docs/<YYYYMMDD>_<slug>` with
  `{"v":"{\"file\":…,\"section\":…,\"says\":…,\"actually\":…}"}`. 30 seconds.
- **At arc close**, route each earned learning to its ONE home:

| Learning | Home |
|---|---|
| Cross-cutting invariant, method, pitfall | this file (keep it lean) |
| Column/table fact or landmine | schema COMMENT via migration → flows into `ref/database.sql` |
| Subsystem contract/invariant | its `ref/AI_CONTEXT.md` section (register density: what + invariants + pointers) |
| Operator-facing behavior | its `manual/` chapter (update the section README TOC) |
| Deferred idea / known cleanup | `ref/plans.md` |
| Applied migration / definition payload | `ref/migrations/` (dated) — only what outlives `ref/database.sql` |
| Dead working doc | `ref/archive/` |

- Never duplicate: AI_CONTEXT points at the manual and the generated files;
  the fastest-rotting doc is the one that restates another.
- The weekly docs review (`ref/DOCS_REVIEW.md`) drains the debt queue, folds
  deltas, audits scratch, and reports. Told the docs are wrong? They probably
  are — fix or file, never shrug.

## Scratch — fast-moving state

Committed docs hold what's DURABLE; scratch holds what's IN MOTION.
Mechanics: AI_CONTEXT §22 (`v` is string-only — stringify JSON yourself).

- `fred/<arc>_state` — the arc's working state, written for a cold reader:
  goal, current slice, decisions made, open questions, next step. **This is
  how a fresh manager self-boots on a long arc** — update at session end and
  after every major decision, not just at arc close.
- `docs/*` — the doc-debt queue (above) + `review_<date>` run records.
- Session-scoped keys die with their arc (the docs review sweep flags stale
  ones); durable conclusions graduate OUT of scratch via the table above.

## Map

- `server.js` → `routes/` → `services/` (business logic) → MySQL. `lib/` shared helpers, `lib/internal_functions/` = workflow-engine function registry.
- `public/` — frontend. `public/index.html` is the only top-level shell; the other 55 HTML files are panes it loads in iframes, and some of those (`case.html`, `contact.html`) host nested iframes of their own. Shell-level edits go in `index.html` only. Iframes wait for parent `apiSend` via the `waitForParent` poll pattern.
- `manual/` — product docs, served in-app. Section READMEs are load-bearing (`routes/manuals.js` harvests their TOC tables at request time; `tests/manualReadmeCoverage.test.js` guards them). Update the README when adding/moving a chapter.
- `ref/` — **read `ref/README.md` first**; it defines the three tiers and is the authority on what belongs where. Living reference at root, plus `migrations/` (applied SQL + definition payloads; historical, several unsafe to copy — see `manual/03-YisraFlow/16-versioning.md`), `archive/` (dead working docs), and `manual/`, `pages/`, `templates/`. `ref/database.sql` and `ref/routes.md` are auto-generated — never hand-edit; regenerate with `node scripts/dump-schema.js` and `node scripts/updateRoutes.js`. `ref/SCHEMA_CONVENTIONS.md` for schema style. Dated files still at `ref/` root are pinned (read by tests/scripts at those paths) — `grep -rn "ref/<name>" tests/ scripts/` before moving one.
- `TRACKED_FILES.txt` — canonical file list, regenerated by the pre-commit hook.
- Deep context: `ref/AI_CONTEXT.md` — read its CURRENCY header first; §0 holds the newest deltas and overrides the body sections where they conflict. Code comments and manual chapters cite it by section ("AI_CONTEXT §21" is the outbound-auth trap below).
- `ref/DOCS_REVIEW.md` — the weekly procedure that keeps AI_CONTEXT and `manual/` honest. Its primary input is the doc-debt queue in scratch `ns=docs`: **file debt there the moment you hit doc↔code drift**, rather than fixing prose mid-task.

## Commands & gates

- `npm test` — jest; 232 suites / ~7,120 tests in ~25s. Run before and after any change; CI runs the same.
  Behavioural suites that animate (the mascot's) must fast-forward their own clock rather than wait in wall
  clock — one such file put the whole run at 70s before it did. See the header of `tests/mascotSkins.test.js`.
- `node --check <file>` on every modified JS file, including inline `<script>` blocks extracted from HTML.
- `npm run db:ref:check` — schema-drift check against the live DB.
- Pre-commit hook (`.githooks/pre-commit`, enable once via `git config core.hooksPath .githooks`) refreshes `ref/database.sql` + `TRACKED_FILES.txt`, costing ~4s per commit. `SCHEMA_DUMP_ASYNC=1` backgrounds the schema step for one commit; `SKIP_SCHEMA_DUMP=1` skips it when the DB is unreachable. The hook does not touch `ref/routes.md` — regenerate that by hand.

## Deploy

- Order is absolute: **SQL migration → backend deploy → frontend deploy.** Never reverse.
- Push to `main` triggers Cloud Build. Commits not touching `package*.json` reuse the npm layer cache.

## Load-bearing invariants (silent-breakage list)

These five are the ones that have actually bitten:

- **Outbound auth:** use async `buildHeadersForCredential(db, id, url)` everywhere — it handles all 5 credential types. Sync `buildAuthHeaders(cred, url)` returns `{}` for OAuth2: a silent break.
- **Post-commit side effects** (GCal sync, SMS, sequence enrollment) are fire-and-forget with `.catch()` — the UI reports success even when they fail. Verify outcomes via DB queries, not UI behavior.
- **Trigger rules:** the UI DELETE+REINSERTs action rows on every save — SQL patches keyed on action `id` silently no-op. Fix trigger actions through the UI.
- **Transactions:** everything goes through `withTransaction(fn, opts)`. `retries:1` only for pure-DB spans; any external side effect (SMS, email, webhook, GCal) in-span requires `retries:0` — or move it post-commit. Verify where commit actually lands before asserting retry semantics.
- **SQL mode is relaxed** — no `STRICT_TRANS_TABLES`, `ONLY_FULL_GROUP_BY`, or `NO_BACKSLASH_ESCAPES`. Never enable strict mode: `cases` has NOT-NULL columns without defaults and `listCases` relies on relaxed GROUP BY. Escape LIKE wildcards (`%`, `_`, `\`) in user search input. Enum-ish varchar columns are app-validated, not DB-enforced.

The rest, in no particular order:

- Dockets: `case_number` / `case_number_full` are opaque free text server-side. Docket-shape parsing is BK-specific and lives client-side ONLY. The server stores opaque strings and collision-checks by equality — never parse or validate docket shape server-side.
- Collation: `documents.external_id` and `case_folder_cache.folder_external_id` are `utf8mb4_bin` (case-sensitive Dropbox IDs — load-bearing). `court_ai_log.message_id` vs `email_log.message_id` differ; joins need explicit `COLLATE utf8mb4_general_ci` on the court side.
- Timezone: `FIRM_TZ=America/Detroit`; the DB pool runs UTC; `appt_date` is firm-local naive. Use `CONVERT_TZ`/`DATE_FORMAT`; Luxon server-side.
- Contact phone/email `start_date` NULL means "since forever". Never `COALESCE(?, CURDATE())` on insert.
- Contacts: `contact_kind` ('person'|'org') is the entity axis; `contact_type` is a dirty free-text role label — never overload it. Org EIN lives in `contact_ssn` (inherits masking + resolver block by design).
- Portal visibility requires `case_relate_type IN ('Primary','Secondary')` — never demote a portal user to 'Other'.
- Deliberately separate: `caseService.searchCases` (picker-shaped) vs `listCases` (display-shaped). Do not converge them.
- Cloud Tasks delivers at-least-once — every handler needs a dedup key / idempotency.
- Sync bus: handlers triggered by a bus message must never emit on the same bus. Dirty-fence echo stamps go at fetch START, not completion.
- Module resolution: `require('./internal_functions')` resolves to its `index.js` — adding function files needs no consumer updates.

## AI session data access

- Readonly SQL: `POST https://app.4lsg.com/api/readonly/sql` `{sql, params?}`, header `X-Readonly-Api-Key` (session key from Fred — never commit one). SELECT/SHOW/DESCRIBE/EXPLAIN; CTEs blocked — use subqueries. Targeted queries over table dumps.
- Scratch (cross-session notes): `PUT/DELETE /api/scratch/:ns/:k` `{v, meta?}`; read from `rw_scratch` via the SQL endpoint. Manager state lives in `ns=fred`.
- IT alert (push a finding to Fred without a human round-trip): `POST /api/alert/it` `{subject, message, severity?}`, same `X-Readonly-Api-Key` header. Delivery is DERIVED from severity — `info`/`warn` email IT, `critical` also SMS; a `channel` key is a 400. Message is plain text (escaped, no sanitizer). Synchronous: a send that throws is a 502 — but `sent.email:true` only means the SMTP relay took the handoff, so confirm real delivery via `email_log.delivery_info` (the relay's queue id) rather than the response. 10/hour per key — fold overflow into one digest. Use it for things that are actually burning, not status updates.
- Remote agents fetch the repo fresh: `curl -sL "https://codeload.github.com/4LSGIT/apigcr/tar.gz/refs/heads/main?cb=$(date +%s)"`. Never trust raw.githubusercontent for current state.

## Two one-way doors

- Never commit API keys (`yci_`/`ycro_`/`yck_`/`ycp_` prefixes) or secrets.
- Never reverse the SQL → backend → frontend deploy order. It is the only mistake here that takes production down rather than merely breaking a build.
