# 14 — Connections: Live Test Playbook

## For operators

This is a manual end-to-end test plan for the Connections credential management system after Slice 5. Run it once against a real OAuth provider (Clio is the recommended pilot) before opening the system to production traffic. Each test has explicit pass criteria; if any test fails, stop and triage before proceeding.

Estimated time: ~45 minutes.

---

## Pre-flight checklist

Confirm before starting:

| Item | How to check | Why |
|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` set in env | `gcloud run services describe …` or local `.env` | Required at module load — `lib/credentialCrypto.js` throws if missing or wrong length |
| `APP_URL` set in env | Same | Required to build the OAuth callback URL — `routes/api.oauth.js` throws `MISSING_APP_URL` if absent |
| Callback URL registered with Clio | Clio developer portal → your OAuth app → Redirect URIs | Must be `${APP_URL}/auth/oauth/callback` exactly. Trailing slashes matter. |
| Clio dev app credentials in hand | Clio developer portal | `client_id`, `client_secret`, `auth_url`, `token_url` |
| You have SU access | Login → Connections tab visible | All tests require superuser |

If `CREDENTIALS_ENCRYPTION_KEY` was not set before any credentials were created, the encrypted `client_secret` and tokens in the DB are unreadable — wipe and recreate.

---

## Test 1: Create an OAuth credential (no connect yet)

**Steps**

1. Admin → Connections (SU)
2. Click "+ New Credential"
3. Fill the form:
   - Name: `Clio (test)`
   - Type: `oauth2`
   - Verbose: checked
4. Provider config:
   - `client_id`: from Clio
   - `client_secret`: from Clio (plaintext — encryption happens server-side)
   - `auth_url`: `https://app.clio.com/oauth/authorize`
   - `token_url`: `https://app.clio.com/oauth/token`
   - `scopes`: `read` (one per line)
5. Use PKCE: false (Clio doesn't require it for confidential clients; toggle on if your test app is configured public)
6. Client auth method: `Basic header`
7. Save

**Pass criteria**

- Credential appears in the list.
- Status column shows `—` (no oauth_status yet).
- Access-token / refresh-token expiry columns show `—`.

**DB verify** (optional)

```sql
SELECT id, name, type, oauth_status,
       JSON_EXTRACT(config, '$.client_id') AS cid,
       JSON_EXTRACT(config, '$.auth_url') AS auth,
       LEFT(JSON_UNQUOTE(JSON_EXTRACT(config, '$.client_secret')), 12) AS secret_prefix
  FROM credentials WHERE name = 'Clio (test)';
```

The `secret_prefix` should look like base64 (no recognizable plaintext). `oauth_status` should be `NULL`.

---

## Test 2: Connect (full OAuth dance)

**Steps**

1. Click the saved credential to open the editor.
2. Click "Connect".
3. Popup opens to Clio's authorization URL.
4. Log into Clio dev account, authorize the app.
5. Clio redirects back to `/auth/oauth/callback`.
6. Popup shows "Connection successful".
7. Popup auto-closes after ~2 seconds.
8. The editor parent window receives `postMessage` and reloads the credential.

**Pass criteria — UI**

The Connection Status card now shows:

- Status: `Connected`
- Access token: expires in ~Xh (Clio's default is 7 days for read scope)
- Refresh token: shows expiry or "no expiry"
- Last refreshed: just now
- Refresh failures: 0

**Pass criteria — DB**

```sql
SELECT id, oauth_status,
       LENGTH(access_token)  AS at_len,
       LENGTH(refresh_token) AS rt_len,
       access_token_expires_at,
       refresh_token_expires_at,
       oauth_state,
       oauth_pkce_verifier,
       refresh_failure_count
  FROM credentials WHERE name = 'Clio (test)';
```

Expect: `oauth_status='connected'`, `access_token` and `refresh_token` non-null and longer than ~50 chars (base64-encrypted), `access_token_expires_at` in the future, `oauth_state` and `oauth_pkce_verifier` both NULL (cleared after successful exchange), `refresh_failure_count = 0`.

**Common failures**

| Symptom | Cause | Fix |
|---|---|---|
| Popup shows `redirect_uri_mismatch` | Clio's registered callback ≠ `${APP_URL}/auth/oauth/callback` | Update Clio app config; popular gotcha is trailing slash |
| Popup shows "invalid client" | `client_secret` wrong | Re-enter; the merge will encrypt the new value (Slice 5 fix means other fields stay) |
| Callback returns blank page | `APP_URL` not set | Set the env var, restart Cloud Run service |

---

## Test 3: Reveal client_secret

**Steps**

1. With the credential open in the editor, click "Show" on Client Secret.
2. Plaintext appears, 30s countdown starts.
3. Wait or click Hide → field re-masks (empty + placeholder).

**Pass criteria — DB audit log**

```sql
SELECT created_at, tool, route, status, JSON_EXTRACT(details, '$.credential_name') AS cred
  FROM admin_audit_log
 WHERE tool = 'connections'
   AND route LIKE '%/reveal'
 ORDER BY created_at DESC LIMIT 1;
```

Expect: a row with `tool='connections'`, route ending in `/reveal`, `status='success'`, details containing the credential id+name+type. **No plaintext secret in the details JSON.**

---

## Test 4: Manual refresh

**Steps**

1. Click "Refresh now".
2. Toast shows success.
3. Editor reloads — `last_refreshed_at` updates to "just now", `access_token_expires_at` pushes forward.

**Pass criteria — DB**

```sql
SELECT id, last_refreshed_at, access_token_expires_at, refresh_failure_count,
       LENGTH(access_token) AS at_len
  FROM credentials WHERE name = 'Clio (test)';
```

Expect: `last_refreshed_at` within the last few seconds, `access_token_expires_at` later than before Test 4, `refresh_failure_count = 0`. Compare access_token length / first chars to Test 2 — should differ (a fresh token was minted).

---

## Test 5: PUT merge fix verification (Slice 5)

This test confirms that partial config updates no longer wipe other fields. Skip if you've already verified during the manual sub-step verification in the slice report.

**Steps** (use curl with a JWT, or hit the network tab in the admin UI while editing fields)

Capture the credential id from Test 1: `CRED_ID=...`.

```bash
# Sub-step 1 — change auth_url only
curl -X PUT "${APP_URL}/api/credentials/${CRED_ID}" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"config":{"auth_url":"https://app.clio.com/oauth/authorize?test=1"}}'
```

Verify in DB:

```sql
SELECT JSON_EXTRACT(config, '$.client_id')   AS cid,
       JSON_EXTRACT(config, '$.auth_url')    AS auth,
       JSON_EXTRACT(config, '$.token_url')   AS tok,
       JSON_EXTRACT(config, '$.scopes')      AS scp,
       LEFT(JSON_UNQUOTE(JSON_EXTRACT(config, '$.client_secret')), 12) AS secret_pref
  FROM credentials WHERE id = ${CRED_ID};
```

Expect: `auth` updated, `cid` / `tok` / `scp` preserved, `secret_pref` unchanged (still encrypted).

```bash
# Sub-step 2 — change client_secret only
curl -X PUT "${APP_URL}/api/credentials/${CRED_ID}" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"config":{"client_secret":"newPlaintextSecret"}}'
```

Verify: `secret_pref` is different from before (re-encrypted with fresh IV), other fields preserved.

**Important:** restore the original `client_secret` after this test — Clio will reject refreshes with the wrong secret. Either restore via PUT or just revoke + re-authorize.

---

## Test 6: Use the credential in a webhook

**Steps**

1. Automation Manager → Hooks
2. Create a test hook (any slug, e.g. `test-clio`) with one HTTP target:
   - URL: `https://app.clio.com/api/v4/users/who_am_i`
   - Method: GET
   - Credential: Clio (test)
3. Live-test the hook: `POST /api/hooks/:id/test` with any input (you can use the UI's test panel).

**Pass criteria**

- The delivery succeeds (HTTP 200 from Clio).
- Response body contains the test user's info.

**DB verify**

```sql
SELECT id, target_id, response_status, status,
       LEFT(response_body, 200) AS body_preview
  FROM hook_delivery_logs
 ORDER BY id DESC LIMIT 1;
```

Expect: `response_status = 200`, `status = 'success'`, body contains user object.

If the lazy refresh-on-use path fires (because we faked an expired access token), check that `last_refreshed_at` advanced and the request still succeeded.

---

## Test 7: Forced refresh failure → 2-strike alert

This test verifies the alert threshold logic without touching the real Clio account.

**Setup — corrupt the refresh token**

Encrypt some garbage so the format is right but the value won't decrypt as a valid token at Clio's end:

```bash
node -e "
require('dotenv').config();
const c = require('./lib/credentialCrypto');
console.log(c.encrypt('garbage-not-a-real-token'));
"
```

Copy the output, then:

```sql
UPDATE credentials
   SET refresh_token = '<paste-encrypted-garbage-here>'
 WHERE name = 'Clio (test)';
```

**Run the daily job manually** (one-time job for testing — see the **Set up the daily refresh job** appendix below for the recurring job)

In the admin UI: Automation Manager → Scheduled Jobs → New Job:

- Type: `one_time`
- Job type: `internal_function`
- Name: `OAuth refresh test (1)`
- Function: `refresh_expiring_oauth_credentials`
- Params: `{}`
- Delay: `5s`

Wait ~30 seconds (one `/process-jobs` heartbeat cycle, or trigger it manually with `POST /process-jobs`).

**Pass criteria after first run**

```sql
SELECT oauth_status, refresh_failure_count, oauth_last_error
  FROM credentials WHERE name = 'Clio (test)';
```

Expect: `oauth_status` still `connected`, `refresh_failure_count = 1`, `oauth_last_error` populated. **No alert fired yet.**

**Run again** — create a second one_time job with the same shape. After it runs:

```sql
SELECT oauth_status, refresh_failure_count, oauth_last_error
  FROM credentials WHERE name = 'Clio (test)';
```

Expect: `oauth_status = 'refresh_failed'`, `refresh_failure_count = 2`. **One Pabbly alert fired** (check Pabbly inbox for the alert workflow).

**Run a third time** — create another job.

Expect: `refresh_failure_count = 3`, status stays `refresh_failed`. **No second alert** — the threshold check is `=== 2`, not `>= 2`.

**Cleanup**

Restore the credential by revoking + re-authorizing (cleanest path):

1. Connections → Clio (test) → Revoke.
2. Connect again → re-authorize at Clio.

Or, if you don't want to revoke, manually fix the row:

```sql
-- Set status back so refresh works again, then trigger a manual refresh via UI
UPDATE credentials SET oauth_status = 'connected' WHERE name = 'Clio (test)';
```

Then click "Refresh now" in the editor — but this will only work if the live refresh_token field still represents a valid Clio token. If you wiped it, you must re-authorize.

---

## Test 8: Daily job — dry run

**Steps**

1. Set up the recurring daily job (see appendix below if not yet done).
2. Manually trigger it: in Scheduled Jobs admin, find the recurring job and click "Reschedule now" (or use `PATCH /scheduled-jobs/:id` with `scheduled_time = now`).
3. Wait one heartbeat cycle.

**Pass criteria**

Console log shows:

```
[REFRESH_EXPIRING_OAUTH] N credentials due for refresh
[REFRESH_EXPIRING_OAUTH] cred X (NAME) refreshed   ...
[REFRESH_EXPIRING_OAUTH] done — N/N refreshed, 0 failed
```

```sql
SELECT id, status, output_data
  FROM job_results
 WHERE job_id = <recurring-job-id>
 ORDER BY id DESC LIMIT 1;
```

Expect: `status = 'success'`, `output_data` contains the `{attempted, succeeded, failed, errors}` shape.

---

## Test 9: Email sender (SMTP)

**Steps**

1. Connections → Email Senders tab.
2. Create a new SMTP sender with real creds (provider, host, port, user, pass, from_name, email).
3. Click "Test".
4. Enter your own email address as recipient, send.

**Pass criteria**

- Real email arrives within ~30 seconds.
- Headers show correct From address.
- DB audit log has an entry:

```sql
SELECT created_at, route, status, JSON_EXTRACT(details, '$.recipient') AS to_email
  FROM admin_audit_log
 WHERE tool = 'connections' AND route LIKE '%/test'
 ORDER BY created_at DESC LIMIT 1;
```

---

## Cleanup after testing

Three options:

| Option | When |
|---|---|
| **Revoke + delete** the Clio (test) credential | If this was a one-time validation and you don't need it for ongoing dev |
| **Revoke** but keep the row | If you want the row for audit-log reference but no live tokens |
| **Leave it connected** | If you'll keep using it for ongoing Clio integration work |

To revoke: Connections → Clio (test) → Revoke. Tokens are cleared at the provider (best-effort) and locally regardless.

---

## Appendix: Set up the daily refresh job

The `refresh_expiring_oauth_credentials` internal function (added in Slice 5) is designed to run on a daily recurring schedule. There's no startup seeder — recurring jobs are created via the admin UI once. Steps:

1. Automation Manager → Scheduled Jobs → New Job.
2. Fields:
   - Type: `recurring`
   - Job type: `internal_function`
   - Name: `OAuth daily refresh`
   - Function: `refresh_expiring_oauth_credentials`
   - Params: `{}` (none needed)
   - Cron rule: `0 7 * * *` (07:00 UTC = 03:00 Detroit, well outside business hours)
   - Max attempts: `2`
   - Backoff seconds: `300`
3. Save.

Verify it appears in the scheduled-jobs list with type `recurring` and the correct cron.

**Why 03:00 firm-time:** any provider rate-limit hit during business hours would block a real user request. Pre-dawn batch is safe. The function is idempotent — running it twice is harmless (the underlying `refreshTokens` deduplicates in-flight refreshes via both an in-process Map and a MySQL `GET_LOCK`).

**To remove:** Scheduled Jobs → find the job → Delete.

---

## What this playbook does NOT cover

- **Performance under load** — the daily job iterates serially. If you scale past ~50 oauth2 credentials, consider parallelizing inside the function (use `Promise.all` with concurrency limit).
- **Provider-specific quirks** — Clio is a clean reference implementation. Other providers (Salesforce, GoCardless, Stripe Connect) have variations: PKCE-required, audience parameters, custom token rotation behavior. Each new provider gets its own integration test, not covered here.
- **PKCE flow** — Test 2 used confidential-client mode. To test PKCE, create a second credential with `Use PKCE: true` and run Tests 1–4 against it.
- **Email Router OAuth (if added later)** — the Email Router uses a separate api_key auth model today; OAuth wiring would be a future project.