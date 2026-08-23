// startup/init.js
//
// Boot-time initialization hook, invoked once from server.js:
//   require("./startup/init")(db);
//
// HISTORY: originally pre-warmed the legacy RingCentral token cache; that
// went away and this sat as a kept-alive no-op. It has a real job again:
//
// Cloud Tasks accelerator warmup (P1 follow-up, 2026-08-23). The enqueue
// call sites (lib/workflow_engine.scheduleResume, sequenceEngine
// scheduleStepJob) run in DETACHED post-response context on the hook path —
// routes/api.hooks.js responds, THEN executes the pipeline — i.e. under
// Cloud Run's request-based CPU throttling, the very condition the whole
// slice exists to dodge. A cold CloudTasksClient does its expensive one-time
// setup (ADC token, HTTP/2 + TLS to cloudtasks.googleapis.com) on the first
// createTask; doing that throttled at 20–45× risks eating the RPC deadline
// and silently degrading the first enqueue per instance to cron latency.
// Boot runs at full CPU — pay the setup cost here, once per instance.
//
// warmup() never throws, no-ops when CLOUD_TASKS_LOCATION is unset, and is
// deliberately NOT awaited: a slow metadata server must not delay serving.

module.exports = async function init(_db) {
  require('../lib/taskQueue').warmup();
};

// ── Legacy RingCentral cleanup checklist (still pending) ──
// NOTE step 5 is SUPERSEDED: this file now hosts the Cloud Tasks warmup
// and must NOT be deleted. Steps 1–4 and the SQL remain valid.
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