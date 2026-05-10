// startup/init.js
//
// HISTORICAL: this used to call ringcentralService.loadToken() to pre-warm
// the legacy in-memory RC token cache at server boot. Both the cache and
// loadToken are gone — credentials live in the credentials table and are
// loaded lazily by oauthService.getValidAccessToken on first use.
//
// Kept as a no-op so existing `require('./startup/init')` calls don't break.
// Safe to delete once the entry-point file (server.js / index.js / app.js)
// drops its require + invocation of this module.

module.exports = async function init(_db) {
  // intentionally empty
};

// # 1. Verify zero references remain
// grep -rn "smsService\|quoService\|ringcentralService" --include="*.js" \
//   | grep -v node_modules | grep -v "\.claude/worktrees" | grep -v local/files
// # Expected: only doc-comment hits in services/oauthService.js. No active require()s.

// # 2. Delete the legacy service files
// rm services/smsService.js
// rm services/quoService.js
// rm services/ringcentralService.js

// # 3. After 1+ week of empty [LEGACY-RINGCENTRAL] traps in Cloud Run logs:
// rm routes/ringcentral.js

// # 4. Once you're confident nobody is calling /internal/phone-test/*:
// rm routes/internal/phoneTest.js

// # 5. Drop startup/init.js and remove the require + invocation from your
// #    server entry point.
// rm startup/init.js



// -- Drop legacy app_settings rows (tokens + key now live in credentials)
// DELETE FROM app_settings WHERE `key` IN ('rc_token', 'quo_api_key');

// -- Contract the column once everything is stable:
// ALTER TABLE phone_lines MODIFY credential_id INT NOT NULL;