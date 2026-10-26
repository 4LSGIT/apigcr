'use strict';
// The trigger code gate — trigger RULES (match and transform) and the native
// draft tester. Same policy as lib/ingestCodeGate.js (ingest rules and
// suppressions), lib/codeStepGate.js (custom_code steps) and
// routes/api.hooks.js (hooks): a request that CARRIES a code body needs
// automations.manage ('Manage workflows, sequences and trigger rules';
// su / it / admin).
//
// Why: a trigger code body runs IN THIS PROCESS. triggerService._runCode
// executes it with node:vm, which is not a security boundary — `input` is a
// host object, so `input.constructor.constructor('return process')()` walks
// out to the real `process`, and process.env carries the DB credentials,
// JWT_SECRET and CREDENTIALS_ENCRYPTION_KEY. Once saved it runs on every
// matching domain event; on POST /api/triggers/test-draft it runs immediately
// and the response returns what it computed. Until this gate every trigger
// route was plain jwtOrApiKey. This is the gate, not containment
// (ref/plans.md, the custom_code containment entry).
//
// Only requests that carry code are gated: conditions / passthrough / mapper
// editing and testing stays open to all staff. Detection FAILS CLOSED:
//   - a mode is code-carrying unless it is literally one of the known non-code
//     modes ('conditions' for match; 'passthrough' / 'mapper' for transform),
//     so an absent, misspelled, case-variant or non-string mode is gated, never
//     waved through;
//   - on a write, a config that is shaped like code (a string, or an object
//     with an own `code` key) is gated whatever the mode says. No non-code
//     config takes either shape (conditions = object without `code`, mapper =
//     array, passthrough = null), and it closes the PUT race: a config-only
//     update judged against a mode someone else flips to 'code' a moment later.
// The body is read with updateRule's own `!== undefined` semantics, so the
// gate sees exactly the columns the service will write. A PUT that sends no
// mode is judged against the STORED mode — the one the written config will run
// under. A rule's `actions` carry no code (workflow / sequence /
// internal_function / http / hook targets) and are not inspected.
//
// A write is judged by what it TOUCHES: an update that leaves the match side
// (match_mode + match_config) or the transform side alone is not refused for
// the code already stored there. The native editor (automation/triggers.html)
// always sends the whole rule, so a staff user without the capability cannot
// save ANY edit (name, active, position, actions) to a rule that is in code
// mode.
//
// Deliberately a sibling of lib/ingestCodeGate.js, not a shared module: the
// mode vocabularies are each owned by their own service (triggerService's
// validator + the trigger_rules ENUMs here), and a shared allowlist would let a
// vocabulary change on one side silently move the other's gate.
//
// Returns null when allowed, or { status, missingCapability, error, message };
// the route answers status with the rest as the JSON body (sendRefusal), in
// the routes' { status:'error', message } envelope.

const { can } = require('./capabilities');

const NON_CODE_MATCH_MODES = new Set(['conditions']);
const NON_CODE_TRANSFORM_MODES = new Set(['passthrough', 'mapper']);

function _obj(body) {
  return (body != null && typeof body === 'object') ? body : {};
}

function _codeShaped(config) {
  if (typeof config === 'string') return true;
  return config != null && typeof config === 'object' && !Array.isArray(config)
    && Object.prototype.hasOwnProperty.call(config, 'code');
}

// The match side of a rule write. `existing` is the stored row on an update,
// null on a create. An absent match_mode on a create is gated (createRule
// would default it to 'conditions'; the editor always sends it).
function _matchWriteCarriesCode(b, existing) {
  const touched = b.match_mode !== undefined || b.match_config !== undefined;
  if (!touched) return false;
  const mode = b.match_mode !== undefined ? b.match_mode : (existing ? existing.match_mode : undefined);
  if (!NON_CODE_MATCH_MODES.has(mode)) return true;
  return b.match_config !== undefined && _codeShaped(b.match_config);
}

function _transformWriteCarriesCode(b, existing) {
  const touched = b.transform_mode !== undefined || b.transform_config !== undefined;
  if (!touched) return false;
  // createRule defaults an ABSENT transform_mode to passthrough; on an update
  // the stored mode stands. An explicit null is not defaulted here (the
  // validator 400s it) — it is simply not a known non-code mode.
  const mode = b.transform_mode !== undefined ? b.transform_mode
    : (existing ? existing.transform_mode : 'passthrough');
  if (!NON_CODE_TRANSFORM_MODES.has(mode)) return true;
  return b.transform_config !== undefined && _codeShaped(b.transform_config);
}

function ruleWriteCarriesCode(body, existing = null) {
  const b = _obj(body);
  return _matchWriteCarriesCode(b, existing) || _transformWriteCarriesCode(b, existing);
}

// test-draft (evaluateDraft) runs body.match_config when match_mode is 'code'
// and body.transform_config when transform_mode is 'code'. Anything but the
// literal non-code modes is gated on either side — including an absent or
// falsy mode, which evaluateDraft would default to a non-code one.
function draftCarriesCode(body) {
  const b = _obj(body);
  return !NON_CODE_MATCH_MODES.has(b.match_mode) || !NON_CODE_TRANSFORM_MODES.has(b.transform_mode);
}

function refuseTriggerCodeWithoutCapability(auth, carriesCode) {
  if (!carriesCode) return null;
  if (can(auth, 'automations.manage')) return null;
  return {
    status: 403,
    missingCapability: 'automations.manage',
    error: 'code-mode trigger rules require the automations.manage capability',
    message: 'Code mode runs arbitrary server-side code, so writing or testing it needs the automations.manage capability (admin / IT). Conditions, mapper and passthrough modes are open to all staff — or ask an administrator.',
  };
}

// Answer a refusal in the trigger routes' envelope. Returns true when sent.
function sendRefusal(res, refusal) {
  if (!refusal) return false;
  const { status, ...body } = refusal;
  res.status(status).json({ status: 'error', ...body });
  return true;
}

module.exports = {
  refuseTriggerCodeWithoutCapability,
  sendRefusal,
  ruleWriteCarriesCode,
  draftCarriesCode,
};
