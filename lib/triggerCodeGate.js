'use strict';
// The trigger code gate — trigger RULES (match and transform) and the native
// draft tester. A sibling of lib/ingestCodeGate.js (ingest rules and
// suppressions); routes/api.hooks.js (hooks) and lib/codeStepGate.js
// (STANDARD custom_code steps) are the gates that still require
// automations.manage ('Manage workflows, sequences and trigger rules';
// su / it / admin) of every staff caller.
//
// Policy: a code body is open to ANY staff JWT, exactly as a SAFE custom_code
// step is. An API key that carries one still needs automations.manage — a
// NULL-scopes (legacy) key holds every capability, a scoped key only when its
// scopes name it (lib/capabilities can) — so a key scoped to a route is not
// thereby a code author. Every other auth shape is refused.
//
// Why it was gated: a trigger code body used to run IN THIS PROCESS under
// node:vm, which is not a security boundary — `input` was a host object, so
// `input.constructor.constructor('return process')()` walked out to the real
// `process`, and process.env carries the DB credentials, JWT_SECRET and
// CREDENTIALS_ENCRYPTION_KEY. Once saved it runs on every matching domain
// event; on POST /api/triggers/test-draft it runs immediately and the response
// returns what it computed.
// Why it is open now: triggerService._runCode runs every body in the QuickJS
// guest engine in the sandbox child (lib/guestCode.js) — no process, require,
// network or host object, a 64 MB heap and a wall-clock limit — a real
// boundary, the one that already makes a SAFE custom_code step authorable by
// all staff (Fred's ruling, ref/plans.md). A rule's ACTIONS are unaffected:
// they are not code and never were gated here.
//
// Detection stays, and still FAILS CLOSED, because it decides what an API key
// may do: a request that carries no code is never judged at all;
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
// the code already stored there.
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
  // Any staff JWT (jwtOrApiKey issues type 'jwt' only for a verified,
  // staff-audience, authorized token): the body runs in the guest engine.
  if (auth && auth.type === 'jwt') return null;
  // An API key: unchanged — it needs the capability (its scopes, or NULL).
  if (auth && auth.type === 'api_key' && can(auth, 'automations.manage')) return null;
  return {
    status: 403,
    missingCapability: 'automations.manage',
    error: 'code-mode trigger rules from an API key require the automations.manage capability',
    message: 'This API key may not write or test code-mode trigger rules: a key needs the automations.manage capability in its scopes. Conditions, mapper and passthrough modes need no capability, and staff users may author code mode.',
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
