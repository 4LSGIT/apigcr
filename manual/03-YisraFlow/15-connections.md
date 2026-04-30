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

# Connections — Usage Recipes

Append to or alongside `manual/03-YisraFlow/15-connections.md`. Concrete patterns
for using a Connection-stored credential in YisraCase code.

## Recipe 0 — When to use Connections at all

Use Connections for any **outbound HTTP request to a third-party API** that
requires authentication (Authorization header, API key header, basic auth,
or OAuth2 bearer). Examples: Clio API calls, Slack webhooks, Mailchimp,
HubSpot, OpenAI, generic webhook endpoints exposed by partners.

**Don't use Connections for:**
- SMTP password — those live in `email_credentials` (a separate table, same UI tab)
- Inbound auth on YisraCase routes — that's `lib/auth.jwtOrApiKey` and
  `lib/auth.superuser`
- Pabbly bridge URLs — those are URLs, not credentials. Stored in env vars
  or `app_settings`.
- RingCentral / Dropbox — currently bespoke (see §16 of the AI context doc;
  parallel-run migration deferred)

## Recipe A — Use a Connection from a YisraFlow webhook (no code)

The 90% case. Admin work only, no developer changes:

1. Connections UI → "+ New Credential" → fill provider details → Save
2. Click Connect (for oauth2) → authorize at provider → connection complete
3. In Automation Manager → Hooks (or Workflows or Sequences or Scheduled Jobs):
   - Create or edit a webhook step / HTTP target
   - In the "Credential" dropdown, pick the credential by name
   - Save
4. The webhook now sends with that credential's auth headers attached

No code changes anywhere. The credential injection layer handles everything,
including OAuth refresh.

## Recipe B — Use a Connection from a route handler (one-off API call)

For routes that need to call an external API directly. Pattern:

```js
// routes/api.someRoute.js
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { buildHeadersForCredential } = require('../lib/credentialInjection');

router.post('/api/sync-from-clio/:caseId', jwtOrApiKey, async (req, res) => {
  const url = `https://app.clio.com/api/v4/matters/${req.params.caseId}`;

  // Look up the Clio credential by name (or hardcode the ID if you prefer)
  const [[cred]] = await req.db.query(
    `SELECT id FROM credentials WHERE name = ? AND type = 'oauth2' LIMIT 1`,
    ['Clio YisraCase']
  );
  if (!cred) {
    return res.status(503).json({ error: 'Clio credential not configured' });
  }

  const headers = await buildHeadersForCredential(req.db, cred.id, url);
  if (!headers || Object.keys(headers).length === 0) {
    // Empty headers = credential missing/disconnected/out-of-scope.
    // DO NOT send the request unauthenticated as a fallback.
    return res.status(503).json({
      error: 'Credential not connected, refresh failed, or URL out of scope'
    });
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: { ...headers, 'Accept': 'application/json' },
    timeout: 30000,
  });

  if (!response.ok) {
    return res.status(response.status).json({
      error: `Clio returned ${response.status}: ${await response.text()}`
    });
  }

  const data = await response.json();
  res.json({ status: 'success', data });
});

module.exports = router;
```

### What the headers look like

For `oauth2`: `{ Authorization: 'Bearer <decrypted-access-token>' }`. If the
token is within 120 seconds of expiry, `buildHeadersForCredential` refreshes
it inline (multi-instance safe via GET_LOCK) before returning the header.

For `bearer`: same shape with the static stored token.

For `api_key`: `{ <header_name>: '<key>' }`.

For `basic`: `{ Authorization: 'Basic <base64(user:pass)>' }`.

For `internal`: `{ 'x-api-key': process.env.INTERNAL_API_KEY }`.

## Recipe C — Use a Connection from a service or internal function

Same shape as Recipe B but with `db` from the function signature instead
of `req.db`. The internal-function executor passes `db` as the second arg.

```js
// lib/internal_functions.js (or any service file)
const { buildHeadersForCredential } = require('./credentialInjection');
const fetch = require('node-fetch');

async function fetchClioMatter(db, params) {
  const credentialId = params.credential_id;     // passed in by caller
  const matterId     = params.matter_id;
  const url          = `https://app.clio.com/api/v4/matters/${matterId}`;

  const headers = await buildHeadersForCredential(db, credentialId, url);
  if (Object.keys(headers).length === 0) {
    throw new Error(`Credential ${credentialId} not connected or out of scope`);
  }

  const response = await fetch(url, { headers, timeout: 30000 });
  if (!response.ok) {
    throw new Error(`Clio API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

module.exports = { fetchClioMatter };
```

## Recipe D — Look up a credential by name

Hardcoding credential IDs is brittle (deletes/recreates change the ID).
Prefer name-based lookup:

```js
async function getClioCredentialId(db) {
  const [[cred]] = await db.query(
    `SELECT id FROM credentials
      WHERE name = ? AND type = 'oauth2' AND oauth_status = 'connected'
      LIMIT 1`,
    ['Clio YisraCase']
  );
  return cred ? cred.id : null;
}
```

Filtering by `oauth_status = 'connected'` ensures you don't try to use a
revoked or refresh-failed credential. If null comes back, surface a clear
error to the caller instead of attempting the API call.

## Recipe E — Pre-flight scope check (optional, for better error messages)

`buildHeadersForCredential` returns `{}` when a URL is outside the credential's
`allowed_urls` scope, which Recipe B treats as a failure. If you want a more
specific error message ("URL out of scope" vs "credential not connected"),
use `checkUrlScope` first:

```js
const { buildHeadersForCredential, checkUrlScope } = require('../lib/credentialInjection');

const [[cred]] = await req.db.query(
  `SELECT id, name, type, config, allowed_urls, oauth_status FROM credentials WHERE id = ?`,
  [credentialId]
);
if (!cred) return res.status(404).json({ error: 'Credential not found' });

const scopeCheck = checkUrlScope(cred, url);
if (!scopeCheck.allowed) {
  return res.status(403).json({
    error: `URL out of scope: ${scopeCheck.reason}`
  });
}

if (cred.type === 'oauth2' && cred.oauth_status !== 'connected') {
  return res.status(503).json({
    error: `Credential is ${cred.oauth_status}. Re-authorize via Connections.`
  });
}

const headers = await buildHeadersForCredential(req.db, cred.id, url);
// ... continue with the request
```

This pattern is what `routes/admin.apiTester.js` does — see it for the full
five-rejection-status implementation.

## Critical rules (read once, follow always)

1. **Always pass the destination `url`** to `buildHeadersForCredential`. The
   `allowed_urls` scope check needs it. Passing nothing or `undefined` causes
   credentials with scope to reject.

2. **Empty headers means "do not send the request."** Never fall back to
   sending unauthenticated. The empty result indicates either:
   - The credential ID is invalid
   - The URL is outside the credential's scope
   - The oauth2 credential isn't connected
   - The credential refresh just failed

   Each is an error the caller should surface, not paper over.

3. **Never call `credentialCrypto.decrypt()` outside of `oauthService` or
   `routes/api.oauth.js`'s reveal route.** Decryption is the injection
   layer's job. If you decrypt manually, you bypass the lazy-refresh logic
   and risk using expired tokens.

4. **Use `buildHeadersForCredential`, not `buildAuthHeaders`.** The sync
   `buildAuthHeaders` returns `{}` for oauth2 — silent break. This trap
   has bitten the codebase before; `services/hookService.js` and
   `routes/admin.apiTester.js` both had to be fixed for it.

5. **Pass `db` correctly.** In a route, `req.db`. In a service or internal
   function, `db` from the function args. The injection layer needs DB
   access to refresh tokens.

6. **Handle errors from the actual fetch separately from credential errors.**
   A 401 from the provider after `buildHeadersForCredential` returned non-empty
   headers means the token was refreshed but the provider still rejected —
   could be a stale refresh, scope mismatch, or revoked-on-provider-side.
   Worth logging the credential id in the error so you can investigate.

## Anti-patterns (don't do these)

```js
// ❌ Don't decrypt manually
const cred = await db.query(...);
const token = credentialCrypto.decrypt(cred.access_token); // bypasses lazy refresh
const headers = { Authorization: `Bearer ${token}` };

// ❌ Don't use the sync builder for oauth2
const headers = buildAuthHeaders(cred, url); // returns {} for oauth2, request goes out unauth'd

// ❌ Don't fall back to unauthenticated on empty headers
const headers = await buildHeadersForCredential(db, id, url);
const response = await fetch(url, { headers }); // sends unauthenticated if empty!

// ❌ Don't hardcode tokens in env vars for new integrations
process.env.CLIO_TOKEN  // bypasses the whole Connections system, no refresh, no audit

// ❌ Don't skip the URL parameter
const headers = await buildHeadersForCredential(db, id); // scope check rejects
```

## Quick checklist before writing new code

- [ ] Is this an outbound HTTP call? → use Connections
- [ ] Will the credential be reused, or is it truly one-off? Reused → Connection.
      One-off → still use a Connection; future-you will thank present-you.
- [ ] OAuth2 with refresh tokens? → Connections handles it. Don't reinvent.
- [ ] Static API key? → Use type `api_key` in Connections, not env var.
      Env vars are for things that genuinely belong in deployment config
      (DB credentials, encryption keys, base URLs).
- [ ] Imported `buildHeadersForCredential`, not `buildAuthHeaders`?
- [ ] Passing the destination URL to the builder?
- [ ] Handling empty-headers case as an error, not a fallback?
- [ ] Logging the credential id when external API errors occur, for debugging?