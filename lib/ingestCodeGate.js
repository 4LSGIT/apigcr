'use strict';
// The ingest code gate — email + phone ingest RULES (match and transform) and
// SUPPRESSIONS, and the four native dry-run endpoints. Same policy as
// lib/codeStepGate.js (custom_code steps) and routes/api.hooks.js (hooks):
// a request that CARRIES a code body needs automations.manage ('Manage
// workflows, sequences and trigger rules'; su / it / admin).
//
// Why: an ingest code body is not sandboxed at all. The rule and suppression
// services run it IN THIS PROCESS with `new Function('input', code)` — on
// every inbound message once saved, and immediately on the test endpoints,
// whose response returns what it computed. `process` is reachable from that
// body, and process.env carries the DB credentials, JWT_SECRET and
// CREDENTIALS_ENCRYPTION_KEY. Until this gate every ingest management route
// was plain jwtOrApiKey, so any staff JWT could read them. This is the gate,
// not containment (ref/plans.md, the custom_code containment entry).
//
// Only requests that carry code are gated: conditions / passthrough / mapper
// editing and testing stays open to all staff, the house pattern of
// codeStepGate's safe-vs-standard split. Detection FAILS CLOSED:
//   - a mode is code-carrying unless it is literally one of the known non-code
//     modes ('conditions' for match; 'passthrough' / 'mapper' for transform),
//     so an absent, misspelled or unknown mode is gated, never waved through;
//   - on a write, a config that is shaped like code (a string, or an object
//     with a `code` key) is gated whatever the mode says. No non-code config
//     takes either shape (conditions = object without `code`, mapper = array,
//     passthrough = null), and it closes the PATCH race: a config-only update
//     validated against a mode someone else flips to 'code' a moment later.
// The body is read with the services' own `!== undefined` semantics, so the
// gate sees exactly the fields the service will write.
//
// A write is judged by what it TOUCHES: an update that leaves the match side
// (match_mode + match_config) or the transform side alone is not refused for
// the code already stored there. The native editors always send the whole
// record, so a staff user without the capability cannot save ANY edit (name,
// active, position) to a rule or suppression that is in code mode.
//
// Returns null when allowed, or { status, missingCapability, error, message };
// the route answers status with the rest as the JSON body (sendRefusal).

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

// The match side of a rule or suppression write. `existing` is the stored row
// on an update, null on a create.
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

function suppressionWriteCarriesCode(body, existing = null) {
  return _matchWriteCarriesCode(_obj(body), existing);
}

// test-match runs body.match_config only when match_mode is 'code'; anything
// but the literal 'conditions' is gated (an unknown mode would 400 anyway).
function testMatchCarriesCode(body) {
  return !NON_CODE_MATCH_MODES.has(_obj(body).match_mode);
}

function testTransformCarriesCode(body) {
  return !NON_CODE_TRANSFORM_MODES.has(_obj(body).transform_mode);
}

function refuseIngestCodeWithoutCapability(auth, carriesCode) {
  if (!carriesCode) return null;
  if (can(auth, 'automations.manage')) return null;
  return {
    status: 403,
    missingCapability: 'automations.manage',
    error: 'code-mode ingest rules and suppressions require the automations.manage capability',
    message: 'Code mode runs arbitrary server-side code, so writing or testing it needs the automations.manage capability (admin / IT). Conditions, mapper and passthrough modes are open to all staff — or ask an administrator.',
  };
}

// Answer a refusal (status + body without `status`). Returns true when sent.
function sendRefusal(res, refusal) {
  if (!refusal) return false;
  const { status, ...body } = refusal;
  res.status(status).json(body);
  return true;
}

module.exports = {
  refuseIngestCodeWithoutCapability,
  sendRefusal,
  ruleWriteCarriesCode,
  suppressionWriteCarriesCode,
  testMatchCarriesCode,
  testTransformCarriesCode,
};
