# Connections — Credential Management

YisraCase's "Connections" system manages firm-wide credentials used by outbound HTTP requests in YisraFlow (hooks, workflows, sequences, scheduled jobs) and by the admin API Tester.

Hosted at `/connections.html`, accessible from the SU section in `a.html`. Admin-only — non-SU users get "Admin only" on load.

## What it stores

Two tables, two tabs in the UI:

### `credentials` — API auth credentials

Five types:
- **internal** — uses `INTERNAL_API_KEY` env var. No secret stored.
- **bearer** — static bearer token (encrypted)
- **api_key** — static key + custom header name (encrypted)
- **basic** — static username + password (encrypted)
- **oauth2** — full OAuth 2.0 flow with refresh tokens, expiry tracking, alerts (encrypted)

For oauth2, the system stores access_token + refresh_token + expiries + flow state + failure tracking. Auth-code flow is the only supported grant.

### `email_credentials` — SMTP senders

Per-sender SMTP config (`host`/`port`/`user`/`pass`/`secure`/`from_name`) plus `provider` enum (`smtp` | `pabbly`). Pabbly senders bypass SMTP entirely — they route through Pabbly's webhook, configured at pabbly.com. The row exists here only for routing in `services/emailService.sendEmail`.

`smtp_pass` is currently plaintext (deferred encryption). Don't add encryption logic at the read sites without a coordinated migration.

## Architecture

```
                          ┌─────────────────────────┐
                          │  public/connections.html │  (admin UI, in a.html SU section)
                          └────────────┬─────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────────┐
              │                        │                             │
   ┌──────────▼──────────┐  ┌──────────▼──────────┐  ┌──────────────▼──────────────┐
   │  routes/api.hooks.js│  │  routes/api.oauth.js│  │  routes/api.emailCredentials │
   │  (credentials CRUD) │  │  (OAuth dance)      │  │  (email CRUD + test)         │
   └──────────┬──────────┘  └──────────┬──────────┘  └──────────────┬──────────────┘
              │                        │                             │
              └────────────────────────┼─────────────────────────────┘
                                       │
                          ┌────────────▼─────────────┐
                          │  services/oauthService.js│
                          │  (auth, refresh, revoke) │
                          └────────────┬─────────────┘
                                       │
                          ┌────────────▼─────────────┐
                          │  lib/credentialCrypto.js │
                          │  (AES-256-GCM, ENCv1:)   │
                          └──────────────────────────┘

OUTBOUND USE (everywhere YisraFlow makes HTTP calls):

           lib/credentialInjection.js
                       │
        ┌──────────────┴──────────────┐
        │   buildHeadersForCredential │  ← ASYNC. Use this. Handles oauth2 lazy refresh.
        │   buildAuthHeaders          │  ← SYNC. Skips oauth2 (returns {} for oauth2).
        │   checkUrlScope             │  ← Pre-flight scope check, returns reason.
        └──────────────┬──────────────┘
                       │
       ┌───────────────┼───────────────────────┐
       │               │                       │
  hookService    webhookExecutor          admin.apiTester
  (hooks)        (workflows + sjobs)      (API Tester UI)
                  └─ sequenceEngine
                     (sequences)
```

## Critical: sync vs async injection

`buildAuthHeaders(credential, url)` is **synchronous** and **does not handle oauth2** — it short-circuits to `{}`. This is intentional: oauth2 needs DB access to lazily refresh expiring tokens, which can't happen in a sync function.

`buildHeadersForCredential(db, credentialId, url)` is **asynchronous** and handles all five types including oauth2. **All outbound HTTP call sites must use this one.**

If a call site uses the sync `buildAuthHeaders` against an oauth2 credential, the request goes out with no Authorization header → 401 from the provider → confusing "restricted by allowed_urls" error in the UI (since the empty headers also indicate scope rejection).

This pitfall was the cause of a Slice 5.x bug discovered live: `routes/admin.apiTester.js` and `services/hookService.js` were both using the sync function, breaking oauth2 in the API Tester and YisraHook HTTP targets. Fixed; verified working in workflows, sequences, scheduled jobs, hooks, and API Tester. Document this asymmetry prominently — it's a class of bug that recurs.

## OAuth2 flow

### Connect

1. Admin clicks "Connect" on a saved oauth2 credential
2. `POST /api/credentials/:id/authorize` builds the auth URL (with `state` and PKCE if enabled), persists `oauth_state` + `oauth_pkce_verifier`, sets `oauth_status='pending_auth'`
3. UI opens auth URL in a popup
4. User authorizes at the provider
5. Provider redirects browser to `${APP_URL}/auth/oauth/callback?state=...&code=...`
6. Callback looks up the credential by `state`, exchanges code for tokens, encrypts and stores them, sets `oauth_status='connected'`, clears `oauth_state` + `oauth_pkce_verifier`
7. Callback HTML posts `{type: 'oauth_success'}` to `window.opener` and auto-closes
8. UI editor reloads with the connected credential

### Refresh

Two paths:
- **Lazy:** every time an outbound HTTP call uses the credential, `getValidAccessToken` checks expiry. If within 120 seconds of expiring, refreshes inline.
- **Scheduled:** daily at 03:00 (Detroit time), the `refresh_expiring_oauth_credentials` internal function scans for credentials with `refresh_token_expires_at < NOW() + 48 hours` OR `access_token_expires_at < NOW() + 1 hour`, and refreshes each.

Both paths use a per-credential MySQL `GET_LOCK` to prevent thundering-herd refreshes across multiple Cloud Run instances. In-process, a Map dedupes concurrent refresh attempts to a single HTTP call.

### Refresh failure

`refresh_failure_count` increments on each failed refresh, resets on success. At exactly count=2, `oauth_status` flips to `'refresh_failed'` and one alert fires to Pabbly (the existing alert URL used by `ringcentralService`). No further alerts fire from the same failure run; admin must re-authorize manually.

### Revoke

`POST /api/credentials/:id/revoke` clears local tokens + sets status to `'revoked'`. If the credential's config has `revoke_url`, calls the provider's revoke endpoint best-effort (failure doesn't block local clear).

## Encryption

`lib/credentialCrypto.js` — AES-256-GCM with `CREDENTIALS_ENCRYPTION_KEY` env var (base64, 32 bytes).

Wire format: `ENCv1:` + base64(iv || authTag || ciphertext)

`isEncrypted` is a literal prefix check on `ENCv1:` — no heuristics. Earlier versions used a base64+length heuristic which produced false positives for plaintext secrets that happened to look base64-shaped (alphanumeric only, length ≥ 28 chars — common shape for provider secrets). The false positives caused encrypt-on-write to silently skip, leaving plaintext in the DB. The prefix-based contract eliminates this class of bug.

Encrypted fields:
- `credentials.access_token` (oauth2)
- `credentials.refresh_token` (oauth2)
- `credentials.config.client_secret` (oauth2 — encrypted within the JSON blob)
- `credentials.config.token` (bearer)
- `credentials.config.key` (api_key)
- `credentials.config.password` (basic)

Reveal endpoint (`GET /api/credentials/:id/reveal`) decrypts and returns plaintext for the admin UI's "Show" buttons. Audit log records the reveal action with credential id+name+type, never the secret value.

## Access tiers

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /api/credentials` | any auth user | dropdowns when configuring hooks/sequences/workflows |
| `GET /api/credentials/:id` | admin (`superuserOnlyFor('connections')`) | admin form prefill (secrets stripped) |
| `POST /api/credentials` | admin | create |
| `PUT /api/credentials/:id` | admin | deep-merge update |
| `DELETE /api/credentials/:id` | admin | hard delete |
| `GET /api/credentials/:id/reveal` | admin | decrypted secrets |
| `POST /api/credentials/:id/authorize` | admin | initiate OAuth |
| `GET /auth/oauth/callback` | **public** | OAuth provider redirect target. Security via unguessable `state`. |
| `POST /api/credentials/:id/refresh` | admin | manual refresh trigger |
| `POST /api/credentials/:id/revoke` | admin | revoke + clear |
| `GET /api/email-credentials` | any auth user | dropdowns |
| `GET /api/email-credentials/:id` | admin | full row including smtp_pass |
| `POST/PUT/DELETE /api/email-credentials` | admin | CRUD |
| `POST /api/email-credentials/:id/test` | admin | send test email |

## PUT semantics — deep merge

`PUT /api/credentials/:id` deep-merges (one level deep) `req.body.config` into the existing config. Saving any single field (e.g. just `auth_url`) preserves all the others.

Exception: when `type` is changing, config is wholesale-replaced — the old shape is meaningless to the new type. All oauth-state columns (tokens, status, expiry, etc.) are also wiped on type change.

`client_secret` follows the same merge logic — omit it from the body to preserve the existing encrypted value, supply it to update. Encryption-on-write is idempotent via `isEncrypted()`.

This was a Slice 5 fix. Pre-Slice-5, PUT replaced config wholesale, which silently wiped all-but-the-supplied field. Any oauth2 credential created/edited during the Slice-4-deployed window may have lost fields — audit with:

```sql
SELECT id, name, JSON_KEYS(config) AS keys_present
  FROM credentials
 WHERE type = 'oauth2'
   AND (JSON_EXTRACT(config, '$.client_id') IS NULL
        OR JSON_EXTRACT(config, '$.token_url') IS NULL
        OR JSON_EXTRACT(config, '$.auth_url') IS NULL);
```

## Verbose mode

Per-credential `verbose` flag (defaults off). When on, oauth2 token-exchange and refresh requests log the URL, grant type, HTTP status, presence/absence of access_token and refresh_token, and the first 8 chars + length of any returned tokens. Never logs full token values, client_secret, or the authorization code.

Toggle in the admin UI editor for any oauth2 credential.

## Daily refresh job — setup

The daily refresh isn't auto-seeded on startup (no seeder pattern exists in this codebase). Set up once via Automation Manager → Scheduled Jobs:

- Type: `recurring`
- Job type: `internal_function`
- Function: `refresh_expiring_oauth_credentials`
- Params: `{}`
- Cron: `0 7 * * *` (07:00 UTC = 03:00 Detroit)
- Max attempts: 2
- Backoff: 300

## Files

- `lib/credentialCrypto.js` — encrypt/decrypt
- `lib/credentialInjection.js` — outbound auth headers
- `services/oauthService.js` — OAuth lifecycle
- `routes/api.hooks.js` — credentials CRUD
- `routes/api.oauth.js` — OAuth flow + reveal
- `routes/api.emailCredentials.js` — email CRUD + test
- `public/connections.html` — admin UI
- Internal function `refresh_expiring_oauth_credentials` in `lib/internal_functions.js`

## Required env vars

- `CREDENTIALS_ENCRYPTION_KEY` — base64-encoded 32 bytes. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. App fails fast at boot if missing or wrong length.
- `APP_URL` — base URL for the deployment (e.g. `https://app.4lsg.com`, no trailing slash). Used to build the OAuth callback URL `${APP_URL}/auth/oauth/callback`. Must match exactly the redirect URI registered with each OAuth provider.

## Pitfalls and gotchas

- **Sync vs async injection.** Use `buildHeadersForCredential` for outbound HTTP. The sync `buildAuthHeaders` skips oauth2.
- **Redirect URI must match exactly** between the provider's registered URI and `${APP_URL}/auth/oauth/callback`.
- **Initial OAuth exchange may not return a refresh_token.** Common with Google when `access_type=offline` and `prompt=consent` aren't in `extra_authorize_params`. UI shows a warning banner if this happens.
- **PUT deep-merges config.** Don't expect wholesale replacement unless type is changing.
- **Don't put unrelated reserved-looking paths in routes.** `/auth/oauth/callback` happens to be fine, but other `/auth/*` paths can collide with IAP / Identity Platform reservations on some GCP setups.
- **Crashing on a callback hit returns 503 from GFE with no app log.** When debugging "no log entry", reproduce locally first to surface the stack trace before chasing infrastructure theories.