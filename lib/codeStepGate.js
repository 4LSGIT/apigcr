'use strict';
// The custom_code capability gate, shared by every surface that accepts an
// authored step: the workflow step writers and test-step (routes/workflows.js)
// and Casey's dry-run preview kind (services/stepPreviewService.js). Moved
// here from routes/workflows.js in A17.2 so the service does not import the
// router.
//
// A STANDARD-mode custom_code step is arbitrary server-side execution, not a
// sandboxed expression: lib/job_executor runs it with vm.runInNewContext, and
// Node's vm is not a security boundary — the host realm is reachable through
// the sandbox's own `input` object, and process.env carries the DB
// credentials. So INTRODUCING one is gated on automations.manage ('Manage
// workflows, sequences and trigger rules'; su / it / admin).
//
// SAFE mode (config.code_mode === 'safe', QuickJS guest engine — see
// lib/safeCodeRunner.js) is open to ALL staff (Fred's ruling, 2026-10-22): the
// body runs where an escape finds no host realm, no process and no network, so
// a safe step is not arbitrary server-side execution. Only the literal string
// 'safe' passes ungated — absent means standard, and any other value is
// treated as standard here (the config validator 400s it anyway), so the gate
// fails closed. A wider automations role model is its own arc (ref/plans.md).
//
// Returns null when allowed, or { status, error, message }.

const { can } = require('./capabilities');

function refuseCodeStepWithoutCapability(auth, stepType, config) {
  if (stepType !== 'custom_code') return null;
  if (config != null && typeof config === 'object' && config.code_mode === 'safe') return null;
  if (can(auth, 'automations.manage')) return null;
  return {
    status: 403,
    error: 'standard custom_code steps require the automations.manage capability',
    message: 'A standard code step runs arbitrary server-side code. Use a safe-mode code step (mode "safe"), an internal_function or a webhook step — or ask an administrator.'
  };
}

module.exports = { refuseCodeStepWithoutCapability };
