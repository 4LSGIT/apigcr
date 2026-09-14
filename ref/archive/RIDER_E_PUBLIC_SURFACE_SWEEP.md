# Rider E — public-surface sweep (2026-08-17)

**Method, so you can audit it:** every file in `routes/` + `routes/internal/`
(110 files) was classified by (a) presence of an auth middleware
(`jwtOrApiKey` / SU / portal / readonly-key / shared-secret) and (b) whether
it emits HTML. The criterion for a MIGRATE finding is the origin-separation
one: **a no-auth handler that renders staff-authored or DB-sourced content
into HTML on the app origin.** Files failing only (a) were then read
individually. Live probes were used where the repo could not settle a
question (badge routes). Nothing below was migrated or patched in this
program — report only, per the charter.

## Findings that meet the criterion (the class /v/ was in)

| Surface | Routes | Auth | Staff-authored HTML? | Token in URL? | Rate limit? | Recommendation |
|---|---|---|---|---|---|---|
| **Task actions** `routes/taskActions.js` | GET `/t/:token`, POST `/t/:token/{complete,cancel}`, GET `/t/:token/status.svg` | none (bearer token authorizes the *action*) | **YES** — task title, description, link title, and the completion note are all staff-typed and rendered (escaped; desc gets a bold-prefix transform) | yes — `task_action_token` in path | **none** | **Migrate + limit — but read the caveat below** |
| **Decision actions** `routes/decisionActions.js` | GET `/d/:token`, GET `/d/:token/:value`, POST `/d/:token/respond` | none (same model, documented as mirroring `/t/`) | **YES** — `decision_requests.question` and option labels are staff-configured workflow content, rendered escaped | yes — token in path | **none** | Same charter as `/t/` — they are one slice |
| **Video landing** `routes/videoLanding.js` | `/v/:slug`, `/api/v/:slug/*` | none | YES | no (the `?c=` problem is Rider D) | was none | **DONE this program** (Riders A/B/C) |

**The `/t/` + `/d/` caveat the prompt demanded:** these render staff-authored
content, so by the letter of the criterion they are security items. But the
*severity* is a notch below `/v/`: the author population is the same trusted
staff who are the victims, the content renders through `htmlEscape` with no
scheme-carrying `href` built from authored input (the only anchors point at
`APP_URL()` and the token base — repo-built), and I found **no injection sink
equivalent to the actions-URL hole** on a full read of both files. So the
honest classification is: **same class as `/m/:token` (bearer-token action
surface on the app host) — a coherence + defense-in-depth migration, plus the
genuinely missing rate limiter** (both files: none; POSTs mutate tasks /
resume workflows; `status.svg` is an unauthenticated per-request DB read that
email clients re-fetch). One slice for both: allowlist entries
(`/t/:token…`, `/d/:token…` — enumerated, noindex: token-in-path, same class
as `/m/`), `makeLimiter` + `getClientIp`, and the `APP_URL()` links inside
the pages **stay app-host on purpose** (they are staff log-in links). One
wrinkle to decide in that slice: task/decision emails embed absolute
`APP_URL()`-based `/t/`//`/d/` links minted in `taskService` /
`decisions.js` — moving the surface means those minters switch to the
landing host, and old emailed links ride the 302 like everything else.

## Read but NOT in the criterion — flagged so the sweep is complete

| Surface | What it is | Why flagged | Recommendation |
|---|---|---|---|
| `GET /db` (`routes/dbQuery.js`) | Legacy: **username+password in the query string**, plaintext-vs-`users.password` check, then **arbitrary multi-statement SQL execution** | Credential-gated so not "unauthenticated", but creds ride in GET query strings (request logs, history) against a plaintext password column, gating full SQL. **2,717 trapped hits in `legacy_route_log`** — still in use by something | **Retire with priority.** Identify the caller from the trap's headers/UA (that is what the trap stores), move it to the readonly SQL API or jwtOrApiKey, delete the route. This predates the trap program and is known — but it should not outlive another quarter |
| `POST /auth/P_validate` (`temp_auth_validate.js`) | Legacy auth-validate; JWT path OK, but the fallback is plaintext username+password and returns `SELECT *` user rows | 84 trapped hits — a live caller exists | Identify caller via trap, migrate it, delete |
| `GET /db64` (`db64.js`) | Same family as `/db` | **Zero rows in `legacy_route_log`** — nothing calls it since the trap went in | Delete now; cheapest win on this page |
| `/logEmail` (`logs.js`) | Already a canary that logs-and-rejects | 6,216 trapped hits = scanners/stragglers hitting a dead route | Working as designed; delete when the trap program closes |
| `POST /badge/ask`, `GET /badge/last.wav` (`badge-ask-route.js`) | STT→Claude(+web search) proxy — an unauth hole here would burn Groq/Anthropic credits | Auth is a shared secret that is **optional-by-env** (`if (DEVICE_TOKEN && …)`) — a footgun shape. **Probed live: both return 401 "bad token"**, so `BADGE_DEVICE_TOKEN` IS set on the current revision | Fine today. Consider making the token mandatory in code so a future revision without the env var fails closed instead of open |
| `pages.js` (`/api`, `/appt`, `/docs`, `/newpath`), `functions.js` (`/date`, `/myip`, `/parseName`), `api.version.js`, `alert-test.js` | Static files / utility JSON / fixtures | No staff-authored content, no writes | Leave (or delete the test fixtures at leisure). Note `/appt`+`/docs` duplicate what the `/:page` catch-all already serves |
| `routes/internal/*` | All 12 routes across 7 files individually carry `jwtOrApiKey` (verified per-file) | The `internal.js` mounter adds no gate itself — protection is per-route convention | OK today; a mounter-level gate would make the convention structural. Low priority |
| `api.ext.forms.js`, `f.js`, `booking.js`, `manage.js`, `api.redirects.js`, `pageLanding.js`, portal routes | Deliberately public / separately authed | Already governed by the origin-separation program | n/a |
| `api.streak.js` | Standalone, own credential scheme, no YisraCase tables | Self-contained by design | Leave |
| `_aitest/_courtexec/_errtest` | Env-flag-inert + per-route shared-secret headers | Fail closed | Leave; delete when their slices close |

## Pattern verdict

Two misses in two days was the worry. The systematic pass says the *class*
is now enumerated: `/t/` and `/d/` are the only remaining no-auth
staff-content HTML surfaces, and they are the mild end of the class. The
sharper finding of the sweep is outside the criterion — the legacy `/db`
route's 2,717 hits. Suggested order: charter `/t/`+`/d/` (one slice, mostly
mechanical, template exists), and separately run the `/db` caller
identification, which is a 10-minute `legacy_route_log` read.
