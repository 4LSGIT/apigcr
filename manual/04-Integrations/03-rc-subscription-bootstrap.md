# 3 — RC Subscription Bootstrap

## For operators

This is a one-time manual setup that connects RingCentral's webhook subscriptions to the three RC hooks (`rc-message-in`, `rc-message-out`, `rc-call`). After this:

- RC pushes inbound SMS, outbound SMS, and call-disconnect events to YisraCase
- Each event drives a log row via workflow 15 (SMS) or workflow 16 (calls)
- The daily renewal job (`scheduled_jobs` id=374, chapter 4) keeps the subscriptions alive indefinitely — each one renews on day 5 of its 7-day lifecycle

You'll come back here when:

| Scenario | Where to go |
|---|---|
| Initial production bootstrap (one time) | Follow this doc top to bottom |
| Got an **IT alert** "RC Subscription removed: \<slug\>" | Skip ahead to **Operational runbook → Failure mode 1: re-bootstrap a single subscription** |
| Wiping all three subscriptions and starting over | **Rollback** first, then top of doc |
| Renewal job failing every day | **Operational runbook → Failure mode 3** |

**Estimated time:** ~10 minutes for a full three-subscription bootstrap. Run during business hours so the live tests verify the path end-to-end without paging anyone.

---

## Technical reference

### Prerequisites — confirm before bootstrapping

Run each query. **If any returns unexpected results, stop and triage before continuing.** Bootstrapping against a broken foundation produces orphan subscriptions on RC's side that don't clean up automatically.

```sql
-- 1. Renewal job present and active
SELECT id, name, recurrence_rule, status, scheduled_time
  FROM scheduled_jobs
 WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.function_name')) = 'rc_renew_subscriptions';
```

Expect one row, `status = 'pending'`, recurrence_rule a daily cron. Production at the time this doc shipped: id=374, cron `30 7 * * *`. **The cron is interpreted in UTC** (the `scheduled_jobs` table has no timezone column), so `30 7 * * *` = 07:30 UTC = pre-dawn Detroit. If this row is missing, the daily renewal won't fire — fix Slice 5 setup first.

```sql
-- 2. Three RC hooks present, api_key auth, with verification tokens stored
SELECT id, slug, auth_type,
       JSON_UNQUOTE(JSON_EXTRACT(auth_config, '$.key')) AS verification_token,
       active
  FROM hooks
 WHERE slug IN ('rc-message-in', 'rc-message-out', 'rc-call');
```

Expect three rows, `auth_type = 'api_key'`, `active = 1`, each with a 32-char hex `verification_token`. If any token is NULL or the row is missing/inactive, the bootstrap will fail at the validation handshake step — fix hook config first.

```sql
-- 3. RingCentral credential connected and scoped correctly
SELECT id, name, oauth_status, allowed_urls FROM credentials WHERE id = 9;
```

Expect one row: name `RingCentral`, `oauth_status = 'connected'`, `allowed_urls` contains `https://platform.ringcentral.com/*`. If `oauth_status` is `refresh_failed` or `revoked`, re-authorize via Connections (chapter 15) before bootstrapping — the renewal job needs this credential too.

```sql
-- 4. Bootstrap has not already been done
SELECT `value` FROM app_settings WHERE `key` = 'rc_subscriptions';
```

Expect **zero rows**. If a value is present, RC already has subscriptions registered to this deployment. Do not run the bootstrap blindly — re-creating subscriptions while old ones still exist on RC's side leaves orphans. Use **Rollback** to clear them first, or use **Failure mode 1** to re-bootstrap a single slug.

---

### The validation handshake

When you POST to RC's `/subscription` endpoint, RC immediately hits your hook URL with an **empty POST containing a `Validation-Token` header**. The receiver must echo that header back with a 200 within ~10 seconds, or RC refuses the subscription with a `validation` error.

`routes/api.hooks.js` handles this transparently — the very first thing it does on `POST /hooks/:slug` is check for the `Validation-Token` header and echo it back **before** any DB lookup, auth check, or pipeline work. Nothing to configure on the operator side.

**If a subscription POST ever returns 4xx/5xx mentioning "validation" or "failed to validate":**

1. The receiver's echo path is the suspect. Check `routes/api.hooks.js` at the top of the `POST /hooks/:slug` handler.
2. Common cause: a middleware was added in front of the handler that no longer passes through on header presence.
3. Second cause: the deployment is unreachable (502/503 from Cloud Run / GFE). Reproduce manually:

   ```bash
   curl -i -X POST https://app.4lsg.com/hooks/rc-message-in \
     -H 'Validation-Token: abc'
   ```
   Expect: `HTTP/1.1 200`, response header `Validation-Token: abc`, empty body.

The token RC sends in this header is **transport-level** — it's not the per-hook `verification_token` from `hooks.auth_config`. The handshake echo doesn't validate either way; it just proves the URL is reachable.

---

### The three subscription POSTs

Use **API Tester** (admin → SU section → API Tester) for each subscription. Same shape for all three; only the URL path, `eventFilters`, and `verificationToken` change between them.

**Common API Tester fields for every POST:**

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `https://platform.ringcentral.com/restapi/v1.0/subscription` |
| Credential | `RingCentral` (id 9) |
| Headers | (leave empty — credential injects Authorization; Content-Type auto) |
| Body | (per-subscription, see below) |

For each subscription, pull the verification_token at bootstrap time rather than copying from this doc:

```sql
SELECT JSON_UNQUOTE(JSON_EXTRACT(auth_config, '$.key'))
  FROM hooks WHERE slug = '<slug>';
```

#### Subscription 1 — `rc-message-in` (inbound SMS)

Body:

```json
{
  "eventFilters": [
    "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"
  ],
  "deliveryMode": {
    "transportType": "WebHook",
    "address": "https://app.4lsg.com/hooks/rc-message-in",
    "verificationToken": "<rc-message-in TOKEN>"
  },
  "expiresIn": 604800
}
```

Expected 200 response shape (fields shown are the ones you'll need; RC returns more):

```json
{
  "id": "<long alphanumeric>",
  "status": "Active",
  "expirationTime": "2026-MM-DDTHH:MM:SS.SSSZ",
  ...
}
```

Record `id` and `expirationTime` into the worksheet.

#### Subscription 2 — `rc-message-out` (outbound SMS via message-store change events)

Body:

```json
{
  "eventFilters": [
    "/restapi/v1.0/account/~/extension/~/message-store"
  ],
  "deliveryMode": {
    "transportType": "WebHook",
    "address": "https://app.4lsg.com/hooks/rc-message-out",
    "verificationToken": "<rc-message-out TOKEN>"
  },
  "expiresIn": 604800
}
```

Record `id` and `expirationTime`.

#### Subscription 3 — `rc-call` (telephony sessions)

Body:

```json
{
  "eventFilters": [
    "/restapi/v1.0/account/~/extension/~/telephony/sessions"
  ],
  "deliveryMode": {
    "transportType": "WebHook",
    "address": "https://app.4lsg.com/hooks/rc-call",
    "verificationToken": "<rc-call TOKEN>"
  },
  "expiresIn": 604800
}
```

Record `id` and `expirationTime`.

**About `expiresIn: 604800`** — that's 7 days, RC's maximum per their docs. Slice 5 renews at 48h pre-expiry, so each subscription gets renewed on day 5 of its lifecycle. Five days of slack remain before the IT alert would fire on a missed renewal. If RC ever changes the max, update both this doc and `RENEW_LEAD_MS` in `lib/internal_functions.js#rc_renew_subscriptions`.

---

### Worksheet

Fill this in as the three POSTs come back. Keep it open in another window — you'll paste from it into the seed SQL below.

| hook_slug      | subscription_id | expirationTime |
|----------------|-----------------|----------------|
| rc-message-in  |                 |                |
| rc-message-out |                 |                |
| rc-call        |                 |                |

---

### Seed SQL — populate `app_settings.rc_subscriptions`

One statement, runs in the DB Console. `ON DUPLICATE KEY UPDATE` makes it safe to re-run if you mistype something — it overwrites cleanly.

Replace each `<...>` placeholder with the corresponding value from the worksheet and from the verification_token queries above.

```sql
INSERT INTO app_settings (`key`, `value`, `updated_at`)
VALUES (
  'rc_subscriptions',
  JSON_ARRAY(
    JSON_OBJECT(
      'subscription_id',    '<rc-message-in subscription_id>',
      'hook_slug',          'rc-message-in',
      'credential_id',      9,
      'event_filters',      JSON_ARRAY('/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS'),
      'expires_at',         '<rc-message-in expirationTime>',
      'verification_token', '<rc-message-in TOKEN>',
      'created_at',         DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')
    ),
    JSON_OBJECT(
      'subscription_id',    '<rc-message-out subscription_id>',
      'hook_slug',          'rc-message-out',
      'credential_id',      9,
      'event_filters',      JSON_ARRAY('/restapi/v1.0/account/~/extension/~/message-store'),
      'expires_at',         '<rc-message-out expirationTime>',
      'verification_token', '<rc-message-out TOKEN>',
      'created_at',         DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')
    ),
    JSON_OBJECT(
      'subscription_id',    '<rc-call subscription_id>',
      'hook_slug',          'rc-call',
      'credential_id',      9,
      'event_filters',      JSON_ARRAY('/restapi/v1.0/account/~/extension/~/telephony/sessions'),
      'expires_at',         '<rc-call expirationTime>',
      'verification_token', '<rc-call TOKEN>',
      'created_at',         DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')
    )
  ),
  NOW()
)
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updated_at` = NOW();
```

**Verify the row landed:**

```sql
SELECT JSON_PRETTY(`value`) FROM app_settings WHERE `key` = 'rc_subscriptions';
```

Should show three JSON objects. `expires_at` values should match the worksheet exactly (RC's ISO format with millis and `Z`). The renewal job parses `expires_at` with `new Date()`, so any string `Date` accepts is fine — but matching RC's exact format makes the renewal log easier to read.

---

### Verification — live tests

These confirm RC is pushing events and the hook → workflow → log path is intact. Run them in order.

#### Test 1 — Inbound SMS

From any external phone, text Stuart's line `(248) 559-2400`.

Within ~30 seconds:

```sql
-- Did a log row land?
SELECT log_id, log_type, log_direction, log_from, log_to,
       LEFT(log_message, 60) AS preview, log_date
  FROM log
 ORDER BY log_id DESC LIMIT 5;
```

Expect: a fresh row with `log_type='sms'`, `log_direction='incoming'`, `log_from` = the external 10-digit phone, `log_to` = `2485592400`.

Cross-check at the hook layer:

```sql
SELECT id, slug, status, filter_passed,
       JSON_EXTRACT(transform_output, '$.direction') AS direction,
       created_at
  FROM hook_executions
 WHERE slug = 'rc-message-in'
 ORDER BY id DESC LIMIT 3;
```

Expect: status `delivered`, `filter_passed = 1`, `direction = "incoming"`.

#### Test 2 — Outbound SMS (and the inbound dedupe path on rc-message-out)

From the RingCentral desktop or mobile app, send a text from one of the RC lines to an external phone.

Within ~30 seconds:

```sql
SELECT log_id, log_type, log_direction, log_from, log_to,
       LEFT(log_message, 60) AS preview, log_date
  FROM log
 ORDER BY log_id DESC LIMIT 5;
```

Expect: `log_type='sms'`, `log_direction='outgoing'`. **Exactly one** new log row.

Then check what happens on inbound: have someone text Stuart's line again, then look at both hooks' executions:

```sql
SELECT id, slug, status, filter_passed,
       JSON_EXTRACT(transform_output, '$.direction') AS direction,
       JSON_EXTRACT(transform_output, '$.needs_fetch') AS needs_fetch,
       created_at
  FROM hook_executions
 WHERE slug IN ('rc-message-in', 'rc-message-out')
   AND created_at >= NOW() - INTERVAL 5 MINUTE
 ORDER BY id DESC;
```

What you should see for a single inbound SMS:

- One `rc-message-in` execution: `delivered`, `direction = "incoming"`, `needs_fetch = false`. This is the path that creates the log row.
- One `rc-message-out` execution: `delivered`, `direction = "incoming"` (resolved by wf 15 after the message-store fetch), `needs_fetch = true`. **No second log row** — wf 15 step 3 dedupes on `direction` and terminates this execution before `create_log` runs.

Confirm the dedupe worked:

```sql
SELECT COUNT(*) FROM log
 WHERE log_date >= NOW() - INTERVAL 5 MINUTE
   AND log_type = 'sms'
   AND log_direction = 'incoming';
```

Should equal the number of distinct inbound SMS messages you sent (not 2x).

#### Test 3 — Inbound call

From an external phone, call Stuart's line, let it ring, and either pick up or send to voicemail. Hang up.

Within ~60 seconds (RC's call-log indexing has lag — see "What's still pending" below):

```sql
SELECT log_id, log_type, log_direction, log_from, log_to,
       JSON_EXTRACT(log_data, '$.duration') AS duration,
       log_date
  FROM log
 ORDER BY log_id DESC LIMIT 5;
```

Expect: `log_type='call'`, `log_direction='incoming'`.

Cross-check the hook fired exactly once for the Disconnected event:

```sql
SELECT id, status, filter_passed,
       JSON_EXTRACT(transform_output, '$.direction') AS direction,
       created_at
  FROM hook_executions
 WHERE slug = 'rc-call'
   AND created_at >= NOW() - INTERVAL 5 MINUTE
 ORDER BY id DESC;
```

RC sends multiple telephony events per call (Ringing, Answered, Disconnected). The `rc-call` filter only passes on the Disconnected event for our account extension, so you should see **one** row with `filter_passed = 1` (status `delivered`), and any number of rows with `filter_passed = 0` (status `filtered`). Both are healthy.

---

### Operational runbook

#### Failure mode 1 — "RC Subscription removed" IT email

The renewal job got a 404 from RC for a specific `subscription_id`, removed it from `app_settings.rc_subscriptions`, and emailed `it@4lsg.com` to notify. **Events for that slug stopped flowing** the moment RC dropped the subscription on their side (could be hours before the alert).

The email body lists which slug is affected. Re-bootstrap **that slug only** — don't touch the other two:

1. **Pull the current verification_token for the affected slug** (don't generate a new one unless you suspect the old one leaked):
   ```sql
   SELECT JSON_UNQUOTE(JSON_EXTRACT(auth_config, '$.key'))
     FROM hooks WHERE slug = '<affected slug>';
   ```

2. **POST a fresh create-subscription** via API Tester — same body as the original bootstrap for that slug, with the current token.

3. **Record** the new `id` and `expirationTime`.

4. **Update only that slug's entry in `app_settings.rc_subscriptions`.** Simplest method — read the array, edit externally, write the whole thing back:

   ```sql
   -- Read current
   SELECT JSON_PRETTY(`value`) FROM app_settings WHERE `key` = 'rc_subscriptions';
   ```

   Copy the output, replace the affected slug's object with the new `subscription_id` / `expires_at` / fresh `created_at`, then:

   ```sql
   UPDATE app_settings
      SET `value` = '<edited JSON, single-line>',
          `updated_at` = NOW()
    WHERE `key` = 'rc_subscriptions';
   ```

5. **Verify**:
   ```sql
   SELECT JSON_PRETTY(`value`) FROM app_settings WHERE `key` = 'rc_subscriptions';
   ```
   Three entries. The affected one has the new `subscription_id`.

6. **Live-test the affected hook** — Test 1, 2, or 3 from above depending on which slug — to confirm events resume.

Total time: ~5 minutes.

#### Failure mode 2 — Events arriving but no logs landing

The hook layer is rejecting or fumbling them. Check:

```sql
SELECT slug, status, COUNT(*) AS n
  FROM hook_executions
 WHERE slug IN ('rc-message-in', 'rc-message-out', 'rc-call')
   AND created_at >= NOW() - INTERVAL 10 MINUTE
 GROUP BY slug, status;
```

Patterns:

- **All `filtered`** across the board → RC's payload shape changed, or our filter code is wrong. Capture a sample via the Hooks UI (Capture Mode), inspect, and compare against the filter code in `hooks.filter_config` for that slug. Most likely fix is a small filter update; least likely is that we need to rewrite the whole transform.

- **`delivered` but no log row** → the workflow is failing after hook delivery. Look at `workflow_executions` for workflow 15 or 16 with `status='failed'` in the last 10 minutes, then drill into `workflow_execution_steps` for the failing step. Most common: `find_contact` returns no match and a downstream step assumes one.

- **Stuck at `received` with no resolution** → `process_jobs` isn't picking up `hook_retry` rows. Check `scheduled_jobs WHERE type = 'hook_retry' AND status = 'pending'` and confirm Cloud Scheduler is still hitting `/process-jobs`.

#### Failure mode 3 — Renewal job marked failed

```sql
SELECT id, status, last_error, last_run_at FROM scheduled_jobs WHERE id = 374;

SELECT id, job_id, status, output_data, created_at
  FROM job_results
 WHERE job_id = 374
 ORDER BY id DESC LIMIT 5;
```

Most common cause: credential 9 OAuth refresh failed. Symptom: `output_data` contains `error` entries referring to 401s from RC's subscription endpoint, or the renewal log shows `[RC_RENEW] sub=... PUT failed: 401`.

Fix:

1. Connections → RingCentral (cred 9) — check `oauth_status`. If `refresh_failed`, click Revoke, then Connect to re-authorize.
2. Manually trigger the renewal job: Scheduled Jobs → 374 → Reschedule now (or wait for tomorrow's 07:30 UTC run).
3. Watch the log: `[RC_RENEW] done — N considered, X renewed, Y removed, Z error`.

If renewal still fails after re-auth: next likely cause is a 403 from RC because the OAuth app lost the `Webhooks` permission — check the RC developer portal app config (`https://developers.ringcentral.com/`).

---

### Rollback — full teardown

Use when wiping all three subscriptions cleanly (e.g., decommissioning RC integration, or starting bootstrap fresh against new tokens).

1. **DELETE each subscription on RC's side** via API Tester. For each `subscription_id` in `app_settings.rc_subscriptions`:

   ```
   Method: DELETE
   URL:    https://platform.ringcentral.com/restapi/v1.0/subscription/<subscription_id>
   Credential: RingCentral (id 9)
   ```

   Expect 204 No Content. Repeat for all three.

2. **Remove the tracking row:**

   ```sql
   DELETE FROM app_settings WHERE `key` = 'rc_subscriptions';
   ```

3. **Hooks stay in place** — they're idle now (no events delivered), but their config is intact for a future re-bootstrap. The renewal job becomes a no-op (it short-circuits on missing / empty `rc_subscriptions`).

Re-bootstrap follows the same procedure as the original — start from "Prerequisites" above.

---

### Token rotation (optional)

Verification tokens are persistent secrets. Rotate **only if there's reason to believe one leaked** — routine re-bootstrap (Failure mode 1) reuses existing tokens.

To rotate one hook's token:

1. **Generate a new token** (32 hex chars, matching the existing format):
   ```bash
   node -e "console.log(require('crypto').randomUUID().replace(/-/g, ''))"
   ```

2. **Update the hook's `auth_config.key`:**
   ```sql
   UPDATE hooks
      SET auth_config = JSON_SET(auth_config, '$.key', '<new token>')
    WHERE slug = '<slug>';
   ```

3. **DELETE the existing RC subscription** for that slug (rollback step 1, applied to just that one).

4. **Re-create the subscription** with the new token (subscription POST for that slug).

5. **Update the corresponding entry in `app_settings.rc_subscriptions`** with the new `subscription_id`, `expires_at`, **and** `verification_token`. Keep `hooks.auth_config.key` and `rc_subscriptions[*].verification_token` aligned — if they drift, you'll get silent auth failures down the road.

If you suspect any token has leaked, rotate **all three** at once.

---

### What's still pending

This bootstrap doc closes Phase 2's hook layer for production traffic. Several related items are deferred:

- **Phase 2 fix #1** — engine single-placeholder passthrough. MMS attachments arriving on `rc-message-in` are currently lost; the transform extracts attachment metadata but the workflow can't pass the full attachment object through a single-placeholder variable. Tracked separately.

- **Quo `+1` prefix + RC 10-digit canonicalization** — planned `create_log` enhancement so logs from Quo and RC store the same normalized phone shape. Today the RC hook transforms strip RC's `+1` to 10-digit (see `norm10` in `rc-message-in` transform), but Quo's inbound is passed through unmodified.

- **Call-log indexing lag** — RC's telephony "Disconnected" events fire before their call-log API has indexed the call. The `rc-call` transform builds an `rc_fetch_url` that workflow 16 then hits; on calls that just disconnected, the fetch sometimes returns an empty record. Expect a 5–15s log delay on fresh calls (known limitation B from Slice 4-D).

- **Subscription management UI** — operator-facing UI for these three subscriptions (re-bootstrap buttons, expiry display, rotation flow). Deferred per Slice 1 — the runbook above is the workflow for now.

- **Hook execution log retention** — `hook_executions` grows unbounded with RC events. A retention policy is on the post-Phase-2 list (see also `scheduled_jobs` retention; same pattern).

- **Slice 7 — Live-fire E2E plan** — broader end-to-end production tests covering edge cases. Run separately after this bootstrap.

---

*Last meaningful update: May 2026. Bootstrap procedure validated against Slice 5 renewal job id=374 in production. **If the procedure here diverges from `lib/internal_functions.js#rc_renew_subscriptions`, `routes/api.hooks.js`, or the live `hooks` table, the code (and table) win.***