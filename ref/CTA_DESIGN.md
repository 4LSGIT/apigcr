# CTA (Call To Action) — Design

**Status:** ratified 2026-10-07 (Fred), pending independent review
**Arc:** CTA / email action buttons · scratch `ns=fred` key `cta_state`
**Author:** manager session (Claude), decisions by Fred

## 1. What this is

An SU tool: mint a tokenized link (or set of option buttons) that executes a
**pre-authorized action plan** when the recipient agrees. Compose with Claude,
paste one `apiSend` to mint, embed the URLs in an email/SMS/chat — or hand the
bare token to a person or an AI agent.

Canonical first uses:
- "Mark as spam" button in an ad-hoc email to SS about a suspect lead.
- RG spam-alert "Not spam — re-run intake" button (WF27 step 25, from the
  2026-10-04 AI-gate direction): plan = `start_workflow` 27 with the original
  `raw_input` + `spam_override`.
- A scoped, expiring write capability handed to a Claude session (execute
  option X when checks pass) — no write key needed.

### Positioning vs decisions

`request_decision` stays untouched: it is a **workflow-pausing HITL gate**
built around a single-use atomic claim + timeout resume. CTA is the
**standalone** primitive: no execution to resume, optionally repeatable, plans
attached per option. Workflows mint CTAs via a new non-pausing `create_cta`
internal function. CTA subsumes "standalone decisions" — do not build those
into `decision_requests`.

## 2. Ratified decisions (2026-10-07)

1. Separate table (`cta_links`) + namespace (`/c/`), not an extension of
   `decision_requests`. Repeatable mode is incompatible with the decision
   claim model.
2. Plans execute **internal functions** (registry), never replayed REST/apiSend
   calls. No credentials in the token; registry guardrails (WRITE_POLICY etc.)
   apply; execution runs as user 0.
3. Three protection levels: `none` / `password` / `login`. Password = secret
   set by SU at mint, verified on the public host. Login tier deferred to S5
   (see §7). **CTA passwords are never YisraCase user passwords** (§8).
4. Expiry always set. Defaults: `cta_default_timeout_once` = 3d,
   `cta_default_timeout_repeatable` = 30d (new settings). Explicit max 365d.
   Expiry is **extendable** via PATCH — no re-mint needed.
5. `max_uses` included in v1 (atomic guarded increment).
6. Agent/JSON surface = content negotiation on the same `/c/` routes.
7. Timeout default action: `timeout_option` (mode=once only) names the option
   whose plan runs at expiry if nobody responded.

## 3. Schema (S1 migration)

```sql
CREATE TABLE cta_links (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token         VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
                COMMENT 'CTA bearer (/c/<t>); 22-char base62 via lib/token; _bin: case-sensitive',
  name          VARCHAR(120) NOT NULL COMMENT 'internal label for the SU list',
  prompt        TEXT NOT NULL COMMENT 'shown to the recipient',
  context_html  MEDIUMTEXT NULL COMMENT 'TRUSTED HTML, same contract as decision_requests.context_html',
  options       JSON NOT NULL COMMENT '[{value,label,plan:[{fn,params}],confirm_text?}]',
  mode          ENUM('once','repeatable') NOT NULL DEFAULT 'once',
  max_uses      INT UNSIGNED NULL COMMENT 'repeatable only; NULL = until expiry',
  uses_count    INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at    DATETIME NOT NULL,
  timeout_option VARCHAR(64) NULL COMMENT 'once only: option value auto-run at expiry if unused',
  protection    ENUM('none','password') NOT NULL DEFAULT 'none',
  password_hash VARCHAR(100) NULL COMMENT 'bcrypt, BCRYPT_ROUNDS=12; never a user password',
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  attributed_user_id INT NULL COMMENT 'attribute responses to this user in logs (assertion by mint, not authentication)',
  status        ENUM('active','used','disabled','cancelled') NOT NULL DEFAULT 'active',
  minted_by     INT NOT NULL,
  link_type     VARCHAR(20) NULL,
  link_id       VARCHAR(40) NULL COMMENT 'outcome-log linkage (case/contact) — mirror tasks.task_link_* types exactly',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cta_token (token),
  KEY idx_cta_status_expires (status, expires_at)
);

CREATE TABLE cta_executions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cta_id        BIGINT UNSIGNED NOT NULL,
  option_value  VARCHAR(64) NOT NULL,
  status        ENUM('success','failed') NOT NULL,
  plan_result   JSON NULL COMMENT 'per-step [{fn, ok, output|error, ms}]',
  responded_via ENUM('link','app','api','timeout') NOT NULL,
  responder_user_id INT NULL,
  responder_ip  VARCHAR(45) NULL,
  executed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ctaexec_cta (cta_id)
);
```

Settings (via migration INSERT, not new infrastructure):
`cta_default_timeout_once` = `3d`, `cta_default_timeout_repeatable` = `30d`.

Worker notes: relaxed SQL mode — enums are app-validated too; verify
`tasks.task_link_id` / `task_link_type` exact types before finalizing
`link_type`/`link_id`; schema notes as COMMENTs per SCHEMA_CONVENTIONS.

## 4. Plans

Per **option**: `plan: [{fn, params}]`, 1–20 steps. Params are **frozen
literals at mint** — no clicker-supplied inputs, no `{{...}}` resolution at
click time (v2 candidates, §9). When a workflow mints via `create_cta`, the
engine's normal `{{...}}` pass resolves before the function runs, so dynamic
content freezes into the row for free.

**Eligibility (mint-time validation):** `fn` must exist in the
`lib/internal_functions` registry and have neither `__meta.controlFlow` nor
`__meta.uiHidden`, and not be in `CTA_FN_DENYLIST` (exported constant, seeded
empty or with stragglers). Explicitly: `workflowOnly` is **not** the filter —
`start_workflow` is `workflowOnly: true` only to stay out of the sequence
picker (composition.js comment) and must remain CTA-eligible; it is the
load-bearing function for the not-spam button. **Worker verification step:**
dump the registry, list every function the filter rejects and accepts, and
eyeball both lists; anything accepted that needs `_execution_id` or returns
`delayed_until`/`next_step` goes into the denylist.

**Execution:** sequential, each step `await fns[fn](params, db)`; a throw or
`success === false` stops the plan and marks the execution `failed`. Per-step
results recorded in `plan_result` (truncate large outputs, e.g. 2k/step).
`set_vars` returns are ignored (no variable context in v1 — no step chaining).
Runs as user 0, same identity as workflow steps. Failure fires an IT alert at
`error` severity (non-transitory: a human asked for this and it didn't happen)
and renders an honest failure page/JSON to the responder.

**Outcome log:** one `logService` entry per execution (mirroring
`logDecisionOutcome`), linked via `link_type`/`link_id` when set; `by` =
`responder_user_id || attributed_user_id || 0`.

**Registry gap to fill in S1:** no internal function cancels a workflow
execution — the logic is inline in `POST /executions/:id/cancel`
(routes/workflows.js). Extract to a service, add `cancel_workflow_execution`
to the registry (reason param required, same cascade). The route delegates to
the service; behavior unchanged.

## 5. Surfaces

### 5.1 Public — `4lsg.com/c/…` (routes/ctaActions.js, auto-mounted)

Mirror of `/d/`: GET never mutates (SafeLinks/Gmail prefetch), mutation behind
form POST, `makeLimiter` buckets (reads 30/min, responds 10/min per IP),
`Cache-Control: no-store`, `noindex`.

- `GET /c/:token` — landing: prompt, context block, one button per option
  (single-option CTAs render one button). Terminal pages for
  used/disabled/cancelled/expired/exhausted, same visual family as /d/.
- `GET /c/:token/:value` — pre-selected confirm page (email buttons link
  here). Password-protected CTAs render a password field on this page.
- `POST /c/:token/respond` — body `value` (+ `password` when protected).
  Executes. `responded_via='link'`.

**pageLanding.js allowlist (load-bearing):** the public-host allowlist is
enumerated regexes. Add:

```js
const C_ROUTE_RE  = /^\/c\/[A-Za-z0-9_-]{10,40}$/;
const C_VALUE_RE  = /^\/c\/[A-Za-z0-9_-]{10,40}\/[A-Za-z0-9_-]{1,64}$/;
const C_POST_RE   = /^\/c\/[A-Za-z0-9_-]{10,40}\/respond$/;
```

…to the allowlist AND to `isCredentialedPath` (bearer in path → keep out of
indexes). Forgetting either is the silent failure mode; the originsep tests
(`tests/pageLanding.*`) get the /c/ cases added in the same slice.

### 5.2 Agent/API — same routes, content negotiation

- `GET /c/:token` with `Accept: application/json` → descriptor:
  `{name, prompt, options:[{value,label}], mode, protection, expires_at,
  uses_remaining, status}`. Plans are **never** included in the descriptor.
- `POST /c/:token/respond` with JSON body `{value, password?}` →
  `{ok, status, execution_id, plan_result}`. `responded_via='api'`.

The token is the capability. This gives an AI session a scoped, expiring,
SU-authored write grant without a write key (dovetails with the
access-control arc).

### 5.3 SU management — `routes/api.cta.js`, superuser-gated (lib/auth.superuser)

- `POST /api/cta` — mint. `dry_run: true` validates the payload and returns
  per-option URLs + rendered default email HTML without inserting.
- `GET /api/cta` — list with uses/exec counts; `GET /api/cta/:id/executions`.
- `PATCH /api/cta/:id` — the refresh/kill surface:
  - extend `expires_at` (new absolute datetime or duration; ≤365d out),
  - raise/clear `max_uses`,
  - `status`: `disabled` (kill switch) ↔ `active` (re-enable). Re-enable
    allowed from `disabled` always; from `used` only when its sole execution
    `failed` (retry-after-fix); never from `cancelled`.
- Minting Claude-side = one pasted `await apiSend('/api/cta','POST',{...})`.

## 6. Semantics

**once (default):** password verified (if protected) **before** the claim.
Claim is the single arbiter, same mutual-exclusion story as decisions:

```sql
UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW()
 WHERE id=? AND status='active' AND expires_at > NOW();
```

affectedRows=0 → re-read, render terminal page. Plan runs after the claim; a
failed plan leaves `status='used'` + a `failed` execution row (PATCH re-enable
to retry after fixing the cause).

**repeatable:** no claim; atomic guarded increment per click:

```sql
UPDATE cta_links SET uses_count = uses_count + 1, updated_at=NOW()
 WHERE id=? AND status='active' AND expires_at > NOW()
   AND (max_uses IS NULL OR uses_count < max_uses);
```

Each click = one `cta_executions` row. `timeout_option` rejected at mint for
repeatable. Extra per-token rate bucket on top of the IP bucket.

**Expiry/cleanup:** `cta_timeout_cleanup` (new uiHidden internal function),
scheduled as a `one_time` job at `expires_at`, mirrors
`decision_timeout_cleanup`:
- row gone / not active → no-op;
- `expires_at` now in the future (PATCH extended it) → re-insert itself at
  the new `expires_at`, exit. This makes PATCH trivial: never touch jobs;
- actually expired, mode=once, `timeout_option` set, `uses_count=0` → run that
  option's plan (`responded_via='timeout'`), set `status='used'`;
- otherwise just leave it (expired is derived from `expires_at` everywhere).

**Password tier:** bcrypt compare (rounds 12, same as auth.password.js).
Failed attempt → increment `failed_attempts`, dedicated limiter
(5 attempts / 15 min / token+IP), warn-severity IT alert at 20 cumulative
failures. Deliberately **no** auto-disable: an attacker burning attempts must
not be able to kill a live link (DoS trade-off, accepted). Password accepted
via form field or JSON field; never via query string; never logged.

**Attribution:** `responder_user_id` = JWT user (S5 login tier) else NULL;
`attributed_user_id` fills the outcome-log `by` for link/password responses
(documented as assertion-by-mint). Per-recipient attribution on public links =
mint one CTA per recipient; rows are cheap.

## 7. Protection levels

| level | surface | who it's for | identity |
|---|---|---|---|
| `none` | 4lsg.com/c | low-stakes, anyone with the link | none (optional `attributed_user_id`) |
| `password` | 4lsg.com/c + password field | powerful plans, recipients without YC accounts, agents | holder-of-secret (+ `attributed_user_id`) |
| `login` (S5, deferred) | app.4lsg.com shell deep-link `#cta=<token>` → pane → `apiSend POST /api/cta/:token/respond` | destructive plans for staff | authenticated JWT user |

Login tier is deferred because the JWT rides only the shell's `apiSend`
(frozen bindings, root-relative) — a standalone app-origin page can't read
it, so the tier needs a shell pane. Password + attribution covers the near-term
cases; build S5 when a destructive staff CTA actually needs authenticated
identity.

## 8. Security analysis

- **No user passwords on the public host — rejected by design.** Verifying
  YisraCase account passwords on 4lsg.com would (a) train staff that typing
  their YC password into non-app origins is normal — the exact phishing
  pattern origin separation (2026-08-17) exists to prevent; a cloned /c/ page
  becomes a credential harvester for the whole app, vs. one CTA's throwaway
  secret; (b) widen where real credentials transit and can be mis-logged;
  (c) couple CTA auth to the access-control arc mid-redesign. If
  authenticated identity is needed, that's the login tier (S5), where the
  existing session does the authenticating.
- Bearer-token model matches /t/ and /d/: possession executes. Mitigations:
  mandatory expiry, kill switch, rate limits, single-use default, password
  tier for anything powerful, plans frozen at mint.
- Plans are SU-authored at mint; the responder supplies only the option
  choice (validated against the row's options). No parameter injection
  surface in v1.
- Execution refuses if `minted_by` is no longer an active SU at click time.
- `context_html`/`prompt` are staff-authored HTML rendered on the public
  landing host — the same content class and trust contract as /d/, which is
  why /c/ lives there and not on the JWT origin.
- Tokens: 22-char base62 (`lib/token.generateToken`), `utf8mb4_bin` column,
  path-only, `isCredentialedPath` + `noindex` + `no-store`.

## 9. Deferred (v2 candidates — ref/plans.md at arc close)

- Clicker-supplied inputs (e.g. "snooze until ___") — reopens injection and
  validation questions; design separately.
- Step chaining (`[[prev.output.x]]` in later plan steps).
- Login tier S5 (shell pane + `/api/cta/:token/respond` authed route).
- Manager UI pane (or a db-tools page as the interim list/disable surface).
- `min_interval_seconds` cooldown for repeatable, if abuse shows up.

## 10. Slices

- **S1 — substrate.** Migration (§3) + settings; `services/ctaService.js`
  (mint/validate/execute/patch/disable + plan runner); eligibility filter +
  registry dump verification (§4); cancel-execution extraction +
  `cancel_workflow_execution`; `cta_timeout_cleanup`. Jest: plan validation
  (incl. start_workflow eligible, controlFlow rejected), once-claim race,
  repeatable max_uses race, password verify-before-claim, cleanup reschedule-
  on-extend, timeout_option fires only when unused. Mutation-check new
  assertions; no mocking ctaService.
- **S2 — surfaces.** `routes/ctaActions.js` (/c/ pages + JSON negotiation +
  limiters) ; pageLanding allowlist + credentialed paths + originsep test
  cases; `routes/api.cta.js` (mint/dry_run/list/executions/PATCH);
  `[[cta_url]]`, `[[respond_url:VALUE]]`, `[[options_html]]`, `[[expires_at]]`
  template tokens + default email renderer (decisions' visual family).
- **S3 — workflow mint.** `create_cta` internal function (params mirror the
  mint API; output: `cta_id`, `token`, `cta_url`, `urls` map, `options_html`).
- **S4 — first consumers.** WF27 step-25 RG alert gains the "Not spam —
  re-run intake" button (once, plan = `start_workflow` 27 with raw_input +
  `spam_override`); rides/aligns with the AI-gate slice. Ad-hoc SS spam-button
  flow documented in the manual chapter.
- **S5 — login tier.** Deferred (§7).
- **Close-out.** manual/ chapter, AI_CONTEXT section, schema COMMENTs ride the
  migration, `fred/cta_state` updated, learnings routed per CLAUDE.md table.

Deploy order per slice: migration → backend → (frontend none until S5).

## 11. Reviewer checklist

1. Claim/increment SQL: race-safe under the relaxed SQL mode and UTC pool?
   Any gap vs. the decisions claim analysis (decisionActions.js header)?
2. Eligibility filter: is `controlFlow`/`uiHidden` + denylist actually
   sufficient? Walk the registry list the worker produces.
3. pageLanding: do the three regexes + credentialed-path entries cover every
   /c/ shape, and does anything else on the public host collide with `/c/`?
4. `cta_timeout_cleanup` reschedule-on-extend: any way PATCH + fire can race
   into a double timeout_option run? (Claim-style guard on the timeout path:
   it must win the same `status='active'` UPDATE before running the plan.)
5. Password path: verify-before-claim ordering, limiter placement, no
   password in logs/plan_result, bcrypt cost consistent with auth.password.js.
6. Once-mode failed-plan → PATCH re-enable: is 'used'+failed → 'active' sound,
   or does it need a distinct status?
7. `cancel_workflow_execution` extraction: behavior-identical to the route
   (incl. decision cascade + post-commit task dismissal)?
8. Anything in §8 you'd tighten before this mints real links?
