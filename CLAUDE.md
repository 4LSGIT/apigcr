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
independently deployable and scope-bounded. Four execution models; Fred
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
4. **Parallel local team** — model 2 without the shuttling: manager and
   workers all run as local Claude Code sessions on this machine, messaging
   each other directly (SendMessage); Fred opts in per arc (it buys
   throughput at the cost of his attention — not the default) and still
   makes all final calls, including every landing. Mechanics, proven
   2026-10-13 (U9b P1–P3, three slices planned→landed→deployed in a day):
   - One git worktree + branch per worker off the agreed base commit
     (`git worktree add ../apigcr-pN -b <slice> <base>`; symlink
     node_modules from the main checkout). Non-overlapping file lanes,
     fixed in the boot prompt; a worker wanting another lane's file routes
     the finding to its owner via the manager — never a drive-by edit.
   - Workers commit on their branch (`--no-verify` — worktrees lack .env,
     and the three generated files must stay untouched there), never push,
     never merge. Report-before-shipping and divergence-stops-work rules
     are unchanged from model 2.
   - Manager verifies from COMMITTED SHAs in a detached worktree — never
     in a worker's live tree. Bitten same day it was invented: a manager
     spot-mutation `git checkout` in a worker's tree silently reverted the
     worker's in-flight edit; count-asserted anchors caught it.
   - Landing = manager squash-merges the branch onto main (hook regenerates
     the generated files), on Fred's explicit go; workers then
     `git reset --hard origin/main`.
   - The push itself is `bash /Users/FRED/apigcr/local/land.sh "<who: what>"
     [--no-jest] [--dry-run]`, run from a fresh worktree (node_modules + .env
     symlinked) holding ONE squashed commit — never from Fred's main checkout,
     which another lander may be mid-squash in (it refuses). Inside the
     heavy-gate `land` slot it fetches, rebases (a conflict in the three
     generated files takes origin/main's copy; any other conflict aborts),
     amends so the hook regenerates them over the combined tree (rebase runs
     no hook), runs full jest (skip only for doc-only), pushes, and ends on
     one GO / NO-GO. The slot queues the next lander; `heavy-gate.sh status`
     shows who holds it. Never `git reset --soft origin/main` to dodge a
     conflict: the commit still sits on its old base, so the recommit reverts
     whatever landed since. Do NOT broadcast push notices: a peer message
     wakes every idle session for a full turn. Message only a session whose
     files you touched.
   - A hand-off patch is cut from `git merge-base HEAD origin/main` after a
     fresh fetch, and only when that base equals the target checkout's HEAD
     and `git diff --name-only` lists exactly the slice's files. `origin/main`
     is shared by every worktree: once someone fetches, a diff against it
     reverses whatever landed since your rebase, and `git apply --check`
     passes that patch clean (ui-custom S2, 2026-10-15).
   - Manager turns end with a fixed last block: `NEEDS FRED:` + numbered
     asks, each self-contained (exact command, path, hash) — or
     `NEEDS FRED: nothing`. Fred skims that, not the chat. Approvals are
     given in the manager's own chat; a peer-relayed "go" is not Fred's.
   - Drawback: every session shares ONE machine. Workers running headless-
     browser gates at once (mobile survey, mockup screenshots) crashed it
     (2026-10-13). The manager serializes browser-heavy runs across workers
     and checks free disk before a long one.
   - Suite TEST COUNTS are environment-conditional (same commit measured
     ±3 tests across worktrees) — compare before/after figures within one
     environment only, never across.
   - This structure is crash-proof by construction — proven when a machine
     reset killed a worker session mid-sweep (2026-10-13): worktrees held
     the edits, scratch held the state, and the delete-debt-keys-only-at-
     landing rule left a legible ledger; a replacement rebuilt the
     disposition from the diff alone. Keep it that way: no state that
     exists only in a session's context.

Gates beyond Commands & gates below, every model:
- Verification-first: ground claims about schema, rows, or behavior in the
  live DB and actual source before writing code or prompts.
- Scripted edits are anchored: `assert src.count(old) == 1` before every
  replace. And FAIL CLOSED: the commit/next step must not run when the
  edit step failed — verify the NEW text is on disk before acting on it
  (two silent no-op edits shipped past green runs, 2026-10-14: a mutation
  that never applied and a doc edit whose landing commit claimed it). Complete files (not fragments) for non-trivial edits.
- New test assertions are mutation-checked (break the code, watch the test
  fail); no mocking the module under test; real-engine harnesses preferred.
- Retiring a VALUE (an enum string, a magic constant): inventory by the
  COLUMN/claim name, never the literal — comparison idioms
  (indexOf('SU'), startsWith) don't contain the literal. Two frontend SU
  gates survived an arc-wide literal grep AND a literal-guard test
  (2026-10-14).
- A harness that PRINTS an anomaly instead of asserting it is not a gate.
  UDS S4 (2026-09-23): a 288-check matrix logged leftover other-mode keys as
  a `note:` line. That residue WAS the bug, and it shipped through the gate,
  the checkpoint report and the reviewer packet before a reviewer caught it.
- Console scripts that mutate automation definitions (workflow / sequence
  steps via `apiSend`) assert the base they expect (step count + labels)
  before writing, and assert the resulting draft before publishing — a
  printed draft-diff is not a check. wf27 v6 (2026-09-22): a "PUT 1–31,
  POST-append 32–39" script run against a 39-step base shipped a duplicated
  block → runaway loop, 480 tasks + emails.
  Compare stored config/params key-order-insensitively (sort keys, then
  stringify): MySQL JSON re-orders object keys on write, so `JSON.stringify`
  of what you sent never equals what you read back. wf50 (2026-10-14): a
  correct draft failed its check on key order alone and was discarded. A
  dry-run harness must store JSON the way MySQL does, or it can't catch this.

## Living documentation — the standing rule

These docs are LIVING. Every arc is expected to leave them better; **an arc
is not closed until its learnings are filed and its `fred/<arc>_state`
scratch key reflects the close.**

- **At discovery:** doc says X, code does Y → file it, don't work around it:
  `PUT /api/scratch/docs/<YYYYMMDD>_<slug>` with
  `{"v":"{\"file\":…,\"section\":…,\"says\":…,\"actually\":…}"}`. 30 seconds.
- **Your own slice falsifies a doc claim → fix the doc in the same slice,**
  not the debt queue. This includes design docs (`ref/*_DESIGN*.md` and
  kin): they are living documents, not frozen records — edit the stale
  claim in place, present tense, committed with the code change that
  falsified it. No dated strike-throughs or "superseded" notes: git history
  carries the dating. Change ONLY now-false claims; dated verification
  records that are still accurate stay; if the doc has a "verified against
  <date>" header, adjust it so it doesn't vouch for newer content. Filed
  debt whose edit you ship: delete the scratch key when the fix lands (not
  before — until then it's still honest debt).
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
- `public/` — frontend. `public/index.html` is the only top-level shell; the other top-level HTML files are panes it loads in iframes, and some of those (`case.html`, `contact.html`) host nested iframes of their own. Shell-level edits go in `index.html` only. Iframes wait for parent `apiSend` via the `waitForParent` poll pattern.
- `manual/` — product docs, served in-app. Section READMEs are load-bearing (`routes/manuals.js` harvests their TOC tables at request time; `tests/manualReadmeCoverage.test.js` guards them). Update the README when adding/moving a chapter.
- `ref/` — **read `ref/README.md` first**; it defines the three tiers and is the authority on what belongs where. Living reference at root, plus `migrations/` (applied SQL + definition payloads; historical, several unsafe to copy — see `manual/03-YisraFlow/16-versioning.md`), `archive/` (dead working docs), and `manual/`, `pages/`, `templates/`. `ref/database.sql` and `ref/routes.md` are auto-generated — never hand-edit; regenerate with `node scripts/dump-schema.js` and `node scripts/updateRoutes.js`. `ref/SCHEMA_CONVENTIONS.md` for schema style. What lands at `ref/` root is decided by KIND, not by who reads it: an applied migration goes to `migrations/` even when a test loads it. The dated dbkq files at root are the one dated set that is neither a migration nor a fixture — `grep -rn "ref/<name>" tests/ scripts/` before moving one.
- `TRACKED_FILES.txt` — canonical file list, regenerated by the pre-commit hook (never edit; see Commands & gates).
- Deep context: `ref/AI_CONTEXT.md` — read its CURRENCY header first; §0 holds the newest deltas and overrides the body sections where they conflict. Code comments and manual chapters cite it by section ("AI_CONTEXT §21" is the outbound-auth trap below).
- `ref/DOCS_REVIEW.md` — the weekly procedure that keeps AI_CONTEXT and `manual/` honest. Its primary input is the doc-debt queue in scratch `ns=docs`: **file debt there the moment you hit doc↔code drift**, rather than fixing prose mid-task.

## Commands & gates

- `npm test` — jest; the whole suite runs in well under a minute. Run before and after any change; CI runs the same.
  Behavioural suites that animate (the mascot's) must fast-forward their own clock rather than wait in wall
  clock — one such file put the whole run at 70s before it did. See the header of `tests/mascotSkins.test.js`.
- `node --check <file>` on every modified JS file, including inline `<script>` blocks extracted from HTML.
- `npm run db:ref:check` — schema-drift check against the live DB.
- Local DB access goes through the Cloud SQL Auth Proxy. `npm run dev`, `npm run db:ref[:check]` and the pre-commit hook start it on demand (`scripts/ensure-sql-proxy.js`; opt-in via `DEV_SQL_PROXY_INSTANCE` in `.env`, inert everywhere else); `npm run db:proxy` / `db:proxy:stop` by hand. New-machine setup and troubleshooting: `ref/INFRA_GCP.md` §10.
- UI changes: the mobile survey at `320,375,414,800,1000,1200` — one gated call per width (loop in `local/heavy-gate.sh`'s header) — boots the real shell on a mock API and fails on any horizontal overflow (every tab, panel, case/contact tab, dialog), on visible elements cut off at the right edge even when the page fits (fixed chrome), and on window errors; screenshots for the eye check. The mid widths are not optional: between the phone rules and a full desktop the header clipped Log Out and five tables pushed the page sideways for months, unseen by a phone-only run (Oct 2026). `scripts/mobile-survey/README.md`.
- Pre-commit hook (`.githooks/pre-commit`, enable once via `git config core.hooksPath .githooks`) regenerates and stages THREE files on every commit: `ref/database.sql` (from the live schema; skipped with a warning, commit still goes through, when the DB or the proxy is unreachable), `ref/routes.md` (from `routes/*.js`, no DB) and `TRACKED_FILES.txt` (`git ls-files`). `SCHEMA_DUMP_ASYNC=1` backgrounds the schema step for one commit; `SKIP_SCHEMA_DUMP=1` / `SKIP_ROUTES_DUMP=1` skip a step.
- **Never edit those three files — not by hand, not by script, not in a patch or diff you hand Fred.** Their contents carry timestamps and totals that drift between your checkout and his, so a hunk on them makes the whole patch fail to apply (`patch failed: ref/routes.md:1`). Leave them out; the commit regenerates them. A new table only reaches `ref/database.sql` once its migration has run on the live DB — that's expected, not a gap to fill by hand.

## Deploy

- Order is absolute: **SQL migration → backend deploy → frontend deploy.** Never reverse.
- Push to `main` triggers Cloud Build. Commits not touching `package*.json` reuse the npm layer cache.
- **Hand-run production operations** (anything Fred types into Cloud Shell: a data move, a freeze, an infra rebuild) ship as ONE uploaded script with short, re-runnable stage commands — never pasted blocks, no prompts, a time limit on every external call, one unmistakable GO / NO-GO line per stage that names the next command — and every command is dry-run with its exact text against the real app on a local harness before Fred sees it. A stand-in `gcloud` only knows what was modelled, and a parse check stops before gcloud's own client-side checks, which run after it has read the live resource: run every command that CHANGES something through the real gcloud CLI against a stub API too (it refused `--clear-vpc-connector` on production 2026-10-13, after the stand-in and the parse check had both passed it). Worked example and the reasons: `ref/archive/DB_MIGRATION_2026-10.md`. Write freeze: `ref/INFRA_GCP.md` §9.
- **A migration that needs a session** — `lock_wait_timeout`, a particular `sql_mode`, `LOCK TABLES`, a smoke test in a rolled-back transaction — ships as a node script on ONE connection from `.env` (read-only CHECK by default; `--apply` asserts the live state, writes, verifies the end state, and resumes from wherever a failed run stopped; one GO / NO-GO line), never as SU-console statements: `/admin/db/batch` runs each statement on whichever pooled connection is free, so no session setting reaches the statement it is for. Any ALTER or LOCK TABLES on a live table sets `lock_wait_timeout` low first — the global default is a year, and a metadata lock queued behind a long transaction stalls every query on the table. Worked example: `scripts/customFieldsS5bDrop.js` (+ `ref/migrations/2026-10-13_custom_fields_s5b_drop_clio_columns.sql`).
  When the migration must run BEFORE its slice lands (SQL → backend), run the script from the COMMITTED SHA, not a worker's live tree: `git worktree add --detach ../apigcr-verify-<slice> <sha>`, symlink `node_modules` and `.env` from the main checkout (the script loads `.env` from its own `scripts/..`), hand Fred `cd ../apigcr-verify-<slice> && node scripts/<x>.js [--apply]`. The manager may run the read-only CHECK itself first, so Fred's `--apply` follows a known GO. Before landing, verify the end state live (RO SQL on information_schema), then squash-merge. Proven on access D1 (2026-10-15).

## Load-bearing invariants (silent-breakage list)

These five are the ones that have actually bitten:

- **Outbound auth:** use async `buildHeadersForCredential(db, id, url)` everywhere — it handles all 5 credential types. Sync `buildAuthHeaders(cred, url)` returns `{}` for OAuth2: a silent break.
- **Post-commit side effects** (GCal sync, SMS, sequence enrollment) are fire-and-forget with `.catch()` — the UI reports success even when they fail. Verify outcomes via DB queries, not UI behavior.
- **Trigger rules:** the UI DELETE+REINSERTs action rows on every save — SQL patches keyed on action `id` silently no-op. Fix trigger actions through the UI.
- **Transactions:** everything goes through `withTransaction(fn, opts)`. `retries:1` only for pure-DB spans; any external side effect (SMS, email, webhook, GCal) in-span requires `retries:0` — or move it post-commit. Verify where commit actually lands before asserting retry semantics.
- **SQL mode is relaxed** — no `STRICT_TRANS_TABLES`, `ONLY_FULL_GROUP_BY`, or `NO_BACKSLASH_ESCAPES`. It is an explicit Cloud SQL database flag, not a server default (`ref/INFRA_GCP.md` §7). Never enable strict mode: `cases` has NOT-NULL columns without defaults and `listCases` relies on relaxed GROUP BY. Escape LIKE wildcards (`%`, `_`, `\`) in user search input. Enum-ish varchar columns are app-validated, not DB-enforced.

The rest, in no particular order:

- Dockets: `case_number` / `case_number_full` are opaque free text server-side. Docket-shape parsing is BK-specific and lives client-side ONLY. The server stores opaque strings and collision-checks by equality — never parse or validate docket shape server-side.
- Collation: `documents.external_id` and `case_folder_cache.folder_external_id` are `utf8mb4_bin` (case-sensitive Dropbox IDs — load-bearing). `court_ai_log.message_id` and `email_log.message_id` are both `utf8mb4_general_ci` (verified live 2026-10-05); the explicit `COLLATE` clauses on the court-side joins are no-ops kept as insurance against re-divergence.
- Timezone: the firm zone is `America/Detroit` — env var `FIRM_TIMEZONE` (`FIRM_TZ` is the JS identifier it's read into, six module-scope captures); the DB pool runs UTC; `appt_date` is firm-local naive. Use `CONVERT_TZ`/`DATE_FORMAT`; Luxon server-side.
- Contact phone/email `start_date` NULL means "since forever". Never `COALESCE(?, CURDATE())` on insert.
- Contacts: `contact_kind` ('person'|'org') is the entity axis; `contact_type` is a dirty free-text role label — never overload it. Org EIN lives in `contact_ssn` (inherits masking + resolver block by design).
- Portal visibility requires `case_relate_type IN ('Primary','Secondary')` — never demote a portal user to 'Other'.
- Deliberately separate: `caseService.searchCases` (picker-shaped) vs `listCases` (display-shaped). Do not converge them.
- Cloud Tasks delivers at-least-once — every handler needs a dedup key / idempotency.
- Sync bus: handlers triggered by a bus message must never emit on the same bus. Dirty-fence echo stamps go at fetch START, not completion. A new write endpoint on a bus-watched entity (cases, contacts, their children) is SILENT to every other open frame until it is registered in `public/js/yc-sync.js` MATCHERS and its response carries the field diff (`changes`) — the writing page repaints itself from the response, so the gap is invisible in the page you test from. Bitten by `/pipeline/move` (Oct 2026): moves wrote the DB and the case page, and no open board heard it. Adding a write route = add the matcher + its ycSync test in the same slice.
- Alert severity convention: transient (timeout / socket / 429 / 5xx) AND first occurrence for its subject → `warning`; repeated or non-transient → `error`. Warnings still record to `system_alerts` but never email on their own (`alert_email_min_severity` = 'error'). Born of alerts 152–154 (Sept 2026): three error-severity IT pages for self-healing blips, zero action needed. Sites: `documentSyncService.syncAll` ("repeat" = `root.last_error` still set when the tick claimed the root), `fieldDefReconciler` boot connect-fail and boot lock-busy (a boot backstop losing GET_LOCK to a sibling running the same idempotent diff is a no-op; a MUTATION trigger losing it still pages — no periodic reconcile sweeps up after it). New alert sites follow this.
- A SQL boolean expression (`(x LIKE 'y%') AS flag`) reaches JS from mysql2 as 1/0, not true/false — map it with `!!` before a client checks `=== false` / `!== false`, or a 0 slips through (`0 !== false` is true). Caught in review (access D3, firmData `active`, 2026-10-15).
- Module resolution: `require('./internal_functions')` resolves to its `index.js` — adding function files needs no consumer updates.
- New internal function = a CTA exposure decision: any registry function with `__meta` (not controlFlow/`__`-prefixed) becomes eligible for SU-minted `/c/` link plans unless added to `CTA_FN_DENYLIST`; the explicit eligible-set test fails on every addition so the choice is deliberate. Low risk — mints are SU-gated + audited, plans frozen at mint, runtime guard on timing returns — so this is a 30-second review, not a security crisis. Deny plumbing and anything needing engine context. ref/CTA_DESIGN.md §4. Same deal for opening a param to clicker input (`__meta.ctaInputParams`, snapshot in tests/ctaInputs.test.js — §12); and the Dockerfile `CMD`'s `--enable-experimental-regexp-engine` is load-bearing for input patterns (boot log `[CTA] linear regexp engine`).
- Client JWT rides exactly two transports — the shell's `apiSend` / `uploadWithProgress` (frozen bindings, root-relative-only, `redirect:'error'`); panes never read the token (liveHost.html is the one standalone exception). Authored bytes never serve executable on the app origin — new byte-serving routes copy the documents-raw allowlist+nosniff pattern. Details: AI_CONTEXT §3.
- `case.html` and `contact.html` render in quirks mode (no doctype): tables there don't inherit `font-size` — declare it on the table (`.logTable` does). Expect other quirks (box model) until the doctype slice in `ref/plans.md` lands.
- `scripts.js` injects its dialog CSS from `<head>`, BEFORE `style.css`'s `<link>` — an injected rule that only TIES a style.css rule loses. The usual winner is style.css's global `input:not([type=radio]):not([type=checkbox])` (0,2,1, 200px wide). Win on specificity (scope through `.swal2-html-container` or the dialog's container), never by load order. Bit four dialogs in the Oct 2026 mobile arc.
- Form labels and hints have one look each, set by CLASS, never inline font/colour: labels `.input-label` / `.yc-flabel` / the dialog label rules, hints `.sub-label` / `.yc-hint`. Where each is defined: AI_CONTEXT §12.

## AI session data access

- The `ycro_` session key is scope-governed (access B1): legacy NULL-scope keys keep the historical full surface (readonly SQL, scratch writes, IT alerts, the temp.* provider proxies); NEW mints default to `sql.ro`+`scratch`+`alert` only — `temp.*` is an explicit grant. A 403 names the missing scope. Vocabulary: lib/capabilities.js KEY_SCOPES; a `keys.mint` (SU-minted manager) key mints its own child keys at `/api/readonly-keys/children` — `sql.ro`/`scratch`/`alert` ∩ the parent's only, ≤24h and ≤ the parent's expiry, dead with it, sharing its alert budget; the manager may also renew its own children (`POST …/children/:id/renew`). A `tasks.own` key (SU-granted; never a child) may create tasks for any active staff member and manage only the tasks it created, via `/api/key-tasks`. A slice scope saying "no live-DB writes" means app tables; it never covers scratch: filing `ns=docs` debt at discovery is expected from every session, workers mid-slice included.
- Readonly SQL: `POST https://app.4lsg.com/api/readonly/sql` `{sql, params?}`, header `X-Readonly-Api-Key` (session key from Fred — never commit one). SELECT/SHOW/DESCRIBE/EXPLAIN; CTEs blocked — use subqueries. Table tiers (lib/sqlGuard, access SEC-3): `app_settings` + `email_ingest_sources` are denied to EVERY key (live credentials — SU db console only). The seven SENSITIVE content tables (`jwt_api_audit_log`, `ai_calls`, `comms_transcripts`, `comms_no_transcribe`, `comms_summary_guides`, `admin_audit_log`, `readonly_query_log`) need a key holding `sql.ro.sensitive` (SU-minted, 4h default / 24h max; legacy NULL-scope keys do NOT hold it). Spend/meta questions about AI calls: query the `ai_spend` view. Targeted queries over table dumps.
- Scratch (cross-session notes): `PUT/DELETE /api/scratch/:ns/:k` `{v, meta?}`; read from `rw_scratch` via the SQL endpoint. Manager state lives in `ns=fred`.
- IT alert (push a finding to Fred without a human round-trip): `POST /api/alert/it` `{subject, message, severity?}`, same `X-Readonly-Api-Key` header. Delivery is DERIVED from severity — `info`/`warn` email IT, `critical` also SMS; a `channel` key is a 400. Message is plain text (escaped, no sanitizer). Synchronous: a send that throws is a 502 — but `sent.email:true` only means the SMTP relay took the handoff, so confirm real delivery via `email_log.delivery_info` (the relay's queue id) rather than the response. 10/hour per root key — fold overflow into one digest. Use it for things that are actually burning, not status updates.
- Remote agents clone the repo fresh each session: `add_repo(owner="4LSGIT", repo="apigcr", access="read")` then `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/4LSGIT/apigcr` (generous timeout; don't interrupt index-pack). codeload.github.com tarballs are DEAD through the agent proxy — 403 with a JSON body that curl happily saves as a .tar.gz, failing later with a misleading "not in gzip format". raw.githubusercontent.com works for a quick single current file.

## Two one-way doors

- Never commit API keys (`yci_`/`ycro_`/`yck_` prefixes — the only three that exist; portal tokens are unprefixed JWTs) or secrets — including unprefixed ones (ingest keys, hook keys, webhook URLs). Enforced since access B4 by a pre-commit scan (`scripts/secret-scan.js`, step 0 of the hook): staged ADDED lines, key prefixes (both body shapes: legacy 64-hex and the B3 22-char base62) + common secret shapes; a deliberate fake in a test rides with a `secret-scan: allow` line marker; `SKIP_SECRET_SCAN=1` skips with a warning. A refusal names file:line and never prints the whole secret. Reference copies of code deployed elsewhere (`ref/gas.js`) read secrets from that host's secret store (Apps Script Script Properties), never a CONFIG literal, so repo == deployed stays safe to round-trip. The gmail-firm ingest key sat in `ref/gas.js` in this public repo from 2026-06-03 to its 2026-10 rotation.
- Never reverse the SQL → backend → frontend deploy order. It is the only mistake here that takes production down rather than merely breaking a build.
