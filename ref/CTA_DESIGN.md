# CTA (Call To Action) — Design v2

**Status:** ratified 2026-10-07 (Fred) · 3-worker consolidated review 2026-10-07:
**approve with changes** (verified @ `9e7fabae`) · all amendments folded below.
**Shipped:** S0–S4 live 2026-10-07 (WF27 **v8 published**; S4 independently
reviewed, see §11). Open: watch gate (first organic spam hit end-to-end),
manager UI (index.html Admin-tab pane), S5 login tier (§7).
**This file (`ref/CTA_DESIGN.md`) is canonical**; the project doc
`claude/CTA_DESIGN.md` mirrors it.
**Arc:** CTA / email action buttons · scratch `ns=fred` key `cta_state`

## 1. What this is

An SU tool: mint a tokenized link (or set of option buttons) that executes a
**pre-authorized action plan** when the recipient agrees — and, with
`result_template`, that returns curated information to the clicker. Compose
with Claude, paste one `apiSend` to mint, embed the URLs in an email/SMS/chat,
or hand the bare token to a person or an AI agent.

Canonical first uses:
- "Mark as spam" button in an ad-hoc email to SS about a suspect lead.
- RG spam-alert "Not spam — re-run intake" button (WF27): plan =
  `start_workflow` 27 with the formatter's expected envelope keys in
  `init_data` plus `spam_override` (there is **no** `raw_input` variable —
  see §10 S4).
- A live lookup link: repeatable CTA + `result_template` = always-current
  "click for contact's email" with no account and no key.
- A scoped, expiring action grant handed to a Claude session. (Framing note,
  per R3: the token is stored plaintext and readable by any RO-key holder, so
  this is a *delegation convenience* scoped against outsiders — not a security
  boundary against key holders.)

### Positioning vs decisions

`request_decision` stays untouched: a **workflow-pausing HITL gate** built on
a single-use atomic claim + timeout resume. CTA is the **standalone**
primitive: no execution to resume, optionally repeatable, plans attached per
option. Workflows mint CTAs via a new non-pausing `create_cta` internal
function. CTA subsumes "standalone decisions" — do not build those into
`decision_requests`.

## 2. Ratified decisions

2026-10-07 (design round):
1. Separate table (`cta_links`) + namespace (`/c/`), not an extension of
   `decision_requests` — repeatable mode is incompatible with the decision
   claim model.
2. Plans execute **internal functions** (registry), never replayed
   REST/apiSend calls. No credentials in the token; registry guardrails
   (WRITE_POLICY etc.) apply; execution runs as user 0.
3. Protection levels `none` / `password` / `login`; password = mint-set
   secret verified on the public host; login tier deferred to S5. **CTA
   passwords are never YisraCase user passwords** (§8).
4. Expiry always set. `cta_default_timeout_once` = 3d,
   `cta_default_timeout_repeatable` = 30d; explicit max 365d. Expiry
   extendable via PATCH — no re-mint.
5. `max_uses` in v1 (atomic guarded increment).
6. Agent/JSON surface = content negotiation on the same `/c/` routes.
7. `timeout_option` (mode=once only): option auto-run at expiry if unused.

2026-10-07 (review round — B/NB/R numbers refer to the consolidated review):
8. **B1:** `mint_source ENUM('su','workflow')` + `source_execution_id`. The
   active-SU click-check applies **only** to `mint_source='su'` — user 0
   (`automations`) is not SU, so workflow mints would otherwise never execute.
9. **B2:** layered eligibility (§4): registry predicate + seeded denylist +
   **runtime guard** + param validation + Jest snapshot of the eligible set.
10. **B3/B4/R1:** timeout model = recurring **`cta_expiry_sweep`** (~5 min,
    `uiHidden`, one `scheduled_jobs type='recurring'` row inserted by the
    migration with an `idempotency_key`). No per-CTA cleanup jobs; PATCH is a
    plain UPDATE. The timeout path **claims before running** (§6).
11. **B5/B5b/R2 (Fred-ratified):** `result_template` is the curated public
    output, v1. Raw `plan_result` never on public surfaces; it lives on
    `GET /api/cta/:id/executions`; per-CTA `return_plan_result` flag opts the
    JSON respond surface back in for agent cases. Result-bearing CTAs default
    `protection='password'` (auto-secret), overridable to `'none'` by explicit
    SU choice, never required; mint response names the applied default.
12. **NB2:** mint auto-generates the password (22-char base62 via
    `lib/token`), returned **once** in the mint response; SU-supplied secrets
    accepted only ≥12 chars.
13. **B7/R4:** `cta_executions.status` = `running → success|failed`; row
    inserted before step 1. Re-enable from `used` resets `uses_count=0` and
    re-runs the **whole** plan — check `plan_result` first.
14. **R3:** tokens and `password_hash` stay plaintext-at-rest/bcrypt in v1
    (every sibling token is plaintext; RO keys are Fred+SS). Exposure filed to
    the access-control arc. **Standing rule: never add `cta_links` or
    `cta_executions` to `QUERY_DB_ALLOWED_TABLES` or `WRITE_POLICY`.**
15. **R8:** `status='cancelled'` = permanent kill via PATCH; never re-enable.
16. **R6:** `/d/:token/respond` limiter wired immediately (standalone patch,
    2026-10-07) — `postLimited` was declared 2026-08-17 and never called.

## 3. Schema (S1 migration)

```sql
CREATE TABLE cta_links (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token         VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
                COMMENT 'CTA bearer (/c/<t>); 22-char base62 via lib/token; _bin: case-sensitive',
  name          VARCHAR(120) NOT NULL COMMENT 'internal label (SU list); never shown publicly',
  prompt        TEXT NOT NULL COMMENT 'shown to the recipient; ESCAPED text — context_html is the only raw-HTML slot',
  context_html  MEDIUMTEXT NULL COMMENT 'TRUSTED HTML, same contract as decision_requests.context_html',
  options       JSON NOT NULL COMMENT '[{value,label,plan:[{fn,params}],confirm_text?,result_template?}] 1-10; value "respond" reserved',
  mode          ENUM('once','repeatable') NOT NULL DEFAULT 'once',
  max_uses      INT UNSIGNED NULL COMMENT 'repeatable only; NULL = until expiry',
  uses_count    INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at    DATETIME NOT NULL,
  timeout_option VARCHAR(64) NULL COMMENT 'once only: option value auto-run at expiry if unused',
  protection    ENUM('none','password') NOT NULL DEFAULT 'none',
  password_hash VARCHAR(100) NULL COMMENT 'bcrypt, BCRYPT_ROUNDS=12; never a user password',
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  return_plan_result TINYINT NOT NULL DEFAULT 0 COMMENT 'JSON respond surface may include raw plan_result (agent mints)',
  attributed_user_id INT NULL COMMENT 'log attribution for link/password responses (assertion by mint, not authentication); never used by timeout executions',
  status        ENUM('active','used','disabled','cancelled') NOT NULL DEFAULT 'active',
  mint_source   ENUM('su','workflow') NOT NULL DEFAULT 'su',
  source_execution_id BIGINT UNSIGNED NULL COMMENT 'workflow mints: the minting execution',
  minted_by     INT NOT NULL,
  link_type     VARCHAR(20) NULL COMMENT 'logService ABOUT_TYPES value set (log_link_type family), app-validated',
  link_id       VARCHAR(255) NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cta_token (token),
  KEY idx_cta_status_expires (status, expires_at)
);

CREATE TABLE cta_executions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cta_id        BIGINT UNSIGNED NOT NULL,
  option_value  VARCHAR(64) NOT NULL,
  status        ENUM('running','success','failed') NOT NULL DEFAULT 'running',
  plan_result   JSON NULL COMMENT 'per-step [{fn, ok, output|error, ms}], outputs truncated ~2k/step; readable via RO keys - redact accordingly',
  responded_via ENUM('link','app','api','timeout') NOT NULL,
  responder_user_id INT NULL,
  responder_ip  VARCHAR(45) NULL,
  executed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ctaexec_cta (cta_id)
);
```

Migration also inserts: settings `cta_default_timeout_once`=`3d`,
`cta_default_timeout_repeatable`=`30d`; one `scheduled_jobs` row
(`type='recurring'`, `function_name='cta_expiry_sweep'`, ~5 min
`recurrence_rule`, `idempotency_key='cta_expiry_sweep'`) — worker copies the
`recurrence_rule`/`data` shape from an existing recurring row.

Worker notes: relaxed SQL mode — enums are app-validated too; schema facts as
COMMENTs per `ref/SCHEMA_CONVENTIONS.md`; verify the ABOUT_TYPES value list
against `services/logService.js` at build time.

## 4. Plans

Per **option**: `plan: [{fn, params}]`, 1–20 steps. Params are **frozen
literals at mint** — no clicker-supplied inputs (v2, §9) and no `{{...}}`
resolution at click time. `create_cta` mints get the engine's normal
`{{...}}` pass before the function runs, so dynamic content freezes into the
row; `create_cta` strips engine-injected `_`-prefixed params before
persisting.

### Eligibility (B2 — layered)

1. **Predicate (as shipped; S1 ruling):** `typeof fn === 'function' &&
   fn.__meta && !fn.__meta.controlFlow && !name.startsWith('__')` — the
   `controlFlow` exclusion was added at S1 (the review's literal predicate
   would have accepted wait_for/schedule_resume/request_decision only for
   the runtime guard to fail them at click). The `__` prefix excludes the
   module exports/self-adds, some of which are plain data (`__WRITE_POLICY`,
   `__USER_*`); same rule as the UI picker (`db.js:928`).
2. **Denylist:** exported `CTA_FN_DENYLIST`, as shipped:
   `wait_until_time` (the one flagless `delayed_until` returner — do **not**
   set `controlFlow` on it; that routes it through controlTarget
   normalization and the runaway-loop guard), `cta_expiry_sweep`,
   `decision_timeout_cleanup`, `set_test_var` (internal plumbing / dev-only),
   and `create_cta` (needs a live `_execution_id`; links must not mint
   links).
3. **Runtime guard:** the plan runner **fails any step whose result carries
   `delayed_until` or `next_step`** — filter completeness is not load-bearing
   against future flagless timing functions.
4. **Mint-time:** reject `_`-prefixed param keys (engine-injection namespace)
   and any unresolved `{{...}}` in params (the resolver renders them `''` —
   `workflow_engine.js:36` — which would e.g. re-run WF27 with empty input,
   unattended); run `__validateFunctionParams` per step, dry_run included.
5. **Jest snapshot** of the eligible-function set — every registry addition
   becomes a reviewed exposure decision.
6. `workflowOnly` is NOT a filter — `start_workflow` carries it only to stay
   out of the sequence picker and must remain eligible.

Chromium-backed functions (`render_submission_pdf`,
`document_generate_from_template`) stay eligible; mint warns when
`mode='repeatable'` (public fan-out = load).

### Execution

1. Insert the `cta_executions` row (`running`) — before step 1, so a crash
   mid-plan is visible; `cta_expiry_sweep` alerts on `running` rows older
   than 15 min.
2. Steps sequential: `await fns[fn](params, db)`; a throw or
   `success === false` or a tripped runtime guard stops the plan →
   execution `failed`, IT alert (`severity='error'`, `group_key='cta:<id>'`),
   generic failure page/JSON (no internals).
3. Finalize row; per-step outputs truncated (~2k) into `plan_result`.
4. `set_vars` returns ignored (no variable context; chaining is v2 — §9).
5. Identity: runs as user 0. SU-active check on `minted_by` applies only to
   `mint_source='su'` (B1).
6. Outcome log: one `logService` entry per execution (mirror
   `logDecisionOutcome`), linked via `link_type`/`link_id`;
   `by = responder_user_id || attributed_user_id || 0` (timeout: always 0).

### result_template (B5b)

Per-option, optional — the **curated public output**:

```json
{ "value": "get_email", "label": "Show current email",
  "plan": [{ "fn": "lookup_contact", "params": { "contact_id": 1001 } }],
  "result_template": "Current email: [[1.output.contact_email]]" }
```

`[[N.output.path]]` resolves against step outputs after a **successful** plan;
rendered (HTML-escaped, decisions `[[...]]` resolver convention) on the
success page and returned as `result` in the JSON respond response. Unknown
step index → mint-time throw (mirrors `[[respond_url:X]]`). Failures always
get the generic page. When any option carries a `result_template`, mint
defaults `protection='password'` (auto-secret; overridable — §2.11).

### Registry gap filled in S1

No internal function cancels a workflow execution — the logic is inline in
`POST /executions/:id/cancel` (routes/workflows.js). Extract to a service
(transaction span + post-commit task dismissal preserved), route delegates,
add `cancel_workflow_execution` (reason required). Per R7: idempotent
`{success, output:{skipped}}` on non-cancellable targets; status-guard the
UPDATE (small **deliberate** behavior change closing the pre-existing
overwrite-completed race — flag in the report); block self-cancel
(`target == _execution_id`).

## 5. Surfaces

### 5.1 Public — `4lsg.com/c/…` (routes/ctaActions.js, auto-mounted)

Mirror of `/d/`: GET never mutates (SafeLinks/Gmail prefetch), mutation
behind form POST, `Cache-Control: no-store`, `noindex`, limiter buckets
(reads 30/min/IP; respond 10/min/IP — **wired**, unlike /d/ pre-R6).

- `GET /c/:token` — landing: prompt (escaped), context block, one button per
  option. Password-protected CTAs render the password field **here too** (the
  landing form posts straight to /respond), not only on the `:value` page.
  Terminal pages for used/disabled/cancelled/expired/exhausted.
- `GET /c/:token/:value` — pre-selected confirm page (email buttons link
  here). Option value `respond` is reserved/rejected at mint.
- `POST /c/:token/respond` — body `value` (+ `password` when protected; form
  or JSON field only, never query string, never logged). Success page shows
  the rendered `result_template` when present, else a generic receipt.
  Failure page is generic + execution id.

**pageLanding.js — three sets + an ordering rule (B6):**

```js
const C_ROUTE_RE  = /^\/c\/[A-Za-z0-9_-]{10,40}$/;
const C_VALUE_RE  = /^\/c\/[A-Za-z0-9_-]{10,40}\/[A-Za-z0-9_-]{1,64}$/;
const C_POST_RE   = /^\/c\/[A-Za-z0-9_-]{10,40}\/respond$/;
```

Added to `landingAllowed`, **`isMigratedPath`** (else `app.4lsg.com/c/<t>`
renders staff-authored `context_html` on the JWT origin — `/t/`,`/d/` are in
all three sets, pageLanding.js:556-560), and `isCredentialedPath`. In
`landingAllowed`, test `C_POST_RE` **before** `C_VALUE_RE` (`:value` matches
the literal `respond`; wrong order silently kills the only mutating /c/
route on the landing host). Mirror the /d/ LOCK tests
(`tests/pageLanding.originsep.test.js:863-888`).

### 5.2 Agent/API — same routes, content negotiation

Keyed on explicit `Accept: application/json` (not `*/*`).
- `GET /c/:token` → descriptor `{prompt, options:[{value,label}], mode,
  protection, expires_at, uses_remaining, status}`. **Excludes** `name`
  (internal), plans, and `result_template`.
- `POST /c/:token/respond` body `{value, password?}` →
  `{ok, status, execution_id, result?}` — `result` only when the option has a
  `result_template` and the plan succeeded. `plan_result` included **only**
  when the CTA was minted with `return_plan_result=1` (B5). Generic failure
  message otherwise.

### 5.3 SU management — routes/api.cta.js, superuser-gated (lib/auth.superuser)

- `POST /api/cta` — mint. Auto-generates the password when
  `protection='password'` and no secret supplied (returned once); defaults
  protection per §2.11 and names the applied default in the response.
  `dry_run: true` → full validation (incl. per-step param validation and
  `result_template` step refs) + per-option URLs with a `<token>` placeholder
  + rendered default email HTML, no insert.
- `GET /api/cta` — list with uses/exec counts; `GET /api/cta/:id/executions`
  — full `plan_result` lives here and only here.
- `PATCH /api/cta/:id` — extend `expires_at` (naive datetimes are FIRM_TZ via
  `parseUserDateTime`, stored UTC; ≤365d out), raise/clear `max_uses`,
  `disabled` ↔ `active`, `cancelled` (permanent). Status-guarded UPDATE;
  409 on already-claimed `once`. Re-enable: from `disabled` freely; from
  `used` only when the latest execution `failed` — resets `uses_count=0`
  (else the sweep claim is permanently dead) and re-runs the whole plan on
  next click; re-enabling an already-expired link without extending in the
  same PATCH → 400.
- Mint/PATCH/disable write `admin_audit_log` explicitly
  (`superuserOnlyFor('cta')` audits only rejections on its own).

## 6. Semantics

**once (default):** password verified **before** the claim; claim is the
single arbiter:

```sql
UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW()
 WHERE id=? AND status='active' AND expires_at > NOW();
```

affectedRows=0 → re-read, terminal page. Plan runs after the claim; a failed
plan leaves `used` + a `failed` execution row (PATCH re-enable per §5.3).

**repeatable:** password verified **before** the increment (a wrong password
must not burn a use):

```sql
UPDATE cta_links SET uses_count = uses_count + 1, updated_at=NOW()
 WHERE id=? AND status='active' AND expires_at > NOW()
   AND (max_uses IS NULL OR uses_count < max_uses);
```

Each click = one execution row. `timeout_option` rejected at mint for
repeatable. Client retries can duplicate executions — `max_uses` caps it;
nonce idempotency is §9.

**Expiry — `cta_expiry_sweep`** (recurring, ~5 min, `uiHidden`): over due
rows, the timeout path **claims first** (B3):

```sql
UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW()
 WHERE id=? AND status='active' AND mode='once' AND uses_count=0
   AND timeout_option IS NOT NULL AND expires_at <= NOW();
```

Plan only on affectedRows=1 (`responded_via='timeout'`, `by=0` — never
`attributed_user_id`). `<= NOW()` vs. the respond claim's `> NOW()` restores
the decisions mutual exclusion (pool `timezone:"Z"`; `NOW()` = UTC).
Duplicate/overlapping sweep runs are benign by construction. Rows without
`timeout_option` just stay expired (derived everywhere from `expires_at`).
The sweep also warn-alerts on `running` executions older than 15 min.
PATCH never touches jobs — there are none per CTA.

**Password brute force:** dedicated limiter 5 attempts/15 min/token+IP
(per-instance memory — real ceiling is 5×instances; accepted),
`failed_attempts` counter. Alerts (`group_key='cta:<id>'`): `warn` at 20
cumulative — **record-only by design** (`alert_email_min_severity='error'`);
escalates to `error` (emails IT) at 100. No auto-disable: an attacker must
not be able to kill a live link (accepted DoS trade-off).

## 7. Protection levels

| level | surface | who it's for | identity |
|---|---|---|---|
| `none` | 4lsg.com/c | low-stakes, anyone with the link | none (optional `attributed_user_id`) |
| `password` | 4lsg.com/c + password field | powerful plans, result-bearing CTAs, recipients without YC accounts, agents | holder-of-secret (+ `attributed_user_id`) |
| `login` (S5, deferred) | app.4lsg.com shell deep-link `#cta=<token>` → pane → `apiSend POST /api/cta/:token/respond` | destructive plans for staff | authenticated JWT user |

Login tier deferred: the JWT rides only the shell's `apiSend` (frozen
bindings, root-relative) — a standalone app-origin page can't read it, so the
tier needs a shell pane. Password + attribution covers the near-term cases.

## 8. Security analysis

- **No user passwords on the public host — rejected by design.** Verifying
  YisraCase account passwords on 4lsg.com would (a) train staff that typing
  their YC password into non-app origins is normal — the phishing pattern
  origin separation (2026-08-17) exists to prevent; a cloned /c/ page becomes
  a harvester for the whole app vs. one CTA's throwaway secret; (b) widen
  where real credentials transit; (c) couple CTA auth to the access-control
  arc mid-redesign. Authenticated identity = login tier (S5).
- Bearer-token model matches /t/ and /d/: possession executes. Mitigations:
  mandatory expiry, kill switch, rate limits, single-use default, password
  tier for anything powerful, plans frozen at mint.
- Public surfaces never leak plan internals: `plan_result` is SU-side;
  `result_template` is the only curated public output; failures are generic
  (B5). `lookup_contact`-class outputs (SSN column, DOB, notes) are exactly
  why.
- `mint_source` governs the click-time check (B1): `su` mints refuse when
  `minted_by` is no longer an active SU. Note: exactly one users row is
  `'authorized - SU'` — that row's `user_auth` is a **global kill switch**
  for every su-minted CTA.
- `prompt` is escaped text; `context_html` is the only raw-HTML slot (same
  trust contract as decisions) — and staff-authored HTML on the landing host
  is why /c/ lives there, in all three pageLanding sets.
- At-rest exposure (R3): accepted for v1; filed to the access-control arc.
  Standing rule: `cta_links`/`cta_executions` never enter
  `QUERY_DB_ALLOWED_TABLES` or `WRITE_POLICY`.
- Tokens: 22-char base62 (`lib/token.generateToken`), `utf8mb4_bin`,
  path-only, `isCredentialedPath` + `noindex` + `no-store`.

## 9. Deferred (v2 candidates — ref/plans.md at arc close)

- Clicker-supplied inputs; step chaining beyond `result_template` tokens.
- Login tier S5 (shell pane + authed respond route).
- Manager UI pane (db-tools page as interim list/disable surface).
- `min_interval_seconds` cooldown; nonce idempotency
  (`UNIQUE(cta_id, nonce)`).
- Per-execution retry-from-failed-step endpoint (R4 v1 = re-enable + full
  rerun).
- Token/password-hash hashing at rest + rotate-PATCH (access-control arc).
- DB-backed exponential backoff before bcrypt on password attempts.

## 10. Slices

*S0–S4 shipped 2026-10-07 — repo commits 9eb124b (S0), 02fb1f2 (S1), 7c27f30
(S2), 2f58c47 (S3); S4 is live workflow/DB state (WF27 v8), its console
scripts were run from the arc chat. S4 below is updated to AS-BUILT.*

- **S0 — done 2026-10-07:** /d/ respond limiter patch (R6).
- **S1 — substrate.** Migration (§3: tables, settings, sweep job row);
  `services/ctaService.js` (mint validation incl. eligibility §4 +
  `result_template` refs, plan runner with running-row lifecycle + runtime
  guard + truncation, claim/increment/timeout-claim SQL, PATCH logic, sweep
  core); `cta_expiry_sweep` internal function (uiHidden; copy
  recurrence/data shape from an existing recurring job row);
  cancel-execution extraction + `cancel_workflow_execution` (§4/R7).
  Jest: eligibility snapshot + predicate/denylist cases
  (start_workflow eligible, `wait_until_time` denied, `__WRITE_POLICY`
  denied), runtime guard, once-claim race, repeatable max_uses race,
  password verify-before-claim and verify-before-increment, timeout
  claim-before-plan + double-run attempt, running-row crash visibility,
  re-enable resets uses_count, template render + escaping + unknown-step
  throw. Mutation-check new assertions; no mocking ctaService.
- **S2 — surfaces.** routes/ctaActions.js (/c/ pages, password fields on
  both GETs, JSON negotiation, limiters **wired**); pageLanding three sets +
  C_POST_RE-before-C_VALUE_RE + LOCK tests; routes/api.cta.js (mint/dry_run/
  list/executions/PATCH + audit writes); `[[cta_url]]`,
  `[[respond_url:VALUE]]`, `[[options_html]]`, `[[expires_at]]` tokens +
  default email (decisions' visual family).
- **S3 — workflow mint.** `create_cta` internal function: params mirror the
  mint API minus `protection='password'` (**not supported from workflows in
  v1** — the auto-secret would land in `workflow_execution_steps.output_data`,
  readable via RO keys); sets `mint_source='workflow'`,
  `source_execution_id`; strips `_`-injected params; output: `cta_id`,
  `token`, `cta_url`, `urls` map, `options_html`.
- **S4 — AS BUILT (WF27 v8, published 2026-10-07; r2.1 after independent
  review).** Full-rebuild console script (v7 precedent), base- and
  draft-asserted; 50 steps. Shape: the `spam_override` gate sits at **step
  2**, BEFORE the AI chain — not on step 3 as first specced (reviewer NB4,
  accepted: no AI cost on re-entry, and an override run structurally cannot
  re-gate/re-alert/re-mint — reach(49) ∩ {gate/alert/mint steps} = ∅).
  Screening chain 41–46: recidivism via `workflow_executions` LIKE (Ruling
  1(C) — `hook_executions` stays OFF the query_db allowlist; the job_executor
  sandbox has no db, so formatter-side lookups were impossible), then the
  Haiku gate (step 44) with envelope metadata + recidivism counts + the
  advance-fee genre and a 3-way `yes|suspicious|no` verdict; `suspicious`
  still creates the lead with a ⚠ block in SS's step-12 context. CTA mint at
  step 47 (once-mode, `start_workflow` 27 with the formatter's envelope keys
  + `spam_override`) feeds the step-25 RG alert button; step 40 is an
  explicit load-bearing `end` (the publish gate rejected the v6-shaped
  fall-through). Review fixes baked in: B1 `\u0001`-prefixed no-phone/email
  sentinels (JSON-escaping at rest kills sentinel self-match), B2 indexed
  `known_contacts.N.contact_name` (mid-string object placeholders render
  `[object Object]`), R1 client-controlled site/form_type moved from the
  trusted prompt into the guarded input. Real-Haiku backtest (44 historical
  payloads, test-step): campaign 12/12 yes, real 27 no / 5 suspicious /
  0 yes.
- **S5 — login tier.** Deferred (§7).
- **Close-out.** manual/ chapter, AI_CONTEXT section, schema COMMENTs ride
  the migration, `fred/cta_state` updated, learnings routed per CLAUDE.md.

Deploy order per slice: migration → backend → (frontend none until S5).

## 11. Review record

2026-10-07 — three independent worker reviews, consolidated: **approve with
changes**, verified against `main` @ `9e7fabae` and the live DB. Blocking
items B1–B7 (+B5b feature ratification), non-blocking NB1–9, rulings R1–R8 —
all folded into this v2; the consolidated report is retained in the arc chat.
Notable negative ruling preserved: do **not** flag `wait_until_time`
`controlFlow` — denylist + runtime guard achieve the safety with zero engine
ripple (`BRANCH_TARGET_PARAMS` + `tests/control.flow.test.js` lock the
current pairing).

S4 (2026-10-07) — Fable executor + independent Opus review
(executor+reviewer model): approve-with-changes; two blocking input defects
(B1 sentinel self-match, B2 `[object Object]` contact names) found by
verification against the real resolver/serializer and fixed in r2; prompt
hygiene (R1) folded; r2.1 added a two-sentence in-practice clarifier after
the real-Haiku backtest flagged debtor-side consumer matters reading as
off-practice. The publish gate itself caught the executor's first layout
recreating the v6 fall-through cycle — the discipline stack (asserted base,
asserted draft, pause-free-cycle gate, independent review, real-model
backtest) each caught something the others missed.