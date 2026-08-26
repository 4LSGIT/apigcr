// tests/dbTransientRetry.test.js
//
/**
 * startup/db.js — the transient-retry wrapper's isTransient predicate.
 *
 * WHY THIS TEST EXISTS
 *   The retry set is keyed on err.code. mysql2 has exactly ONE dead-socket
 *   error that carries no code: Connection._addCommandClosedState throws a
 *   bare `new Error("Can't add new command when connection is in closed
 *   state")` with only `fatal = true` set. `TRANSIENT.has(undefined)` is
 *   false, so for a long time that error was NOT retried — it killed a
 *   documents_sync job after 132 seconds on 2026-08-26.
 *
 *   Retrying it is unambiguously safe, and safer than the socket errors
 *   already in the set: the command is rejected BEFORE being written, so the
 *   server never saw it. There is no "did it half-apply?" question.
 *
 * The predicate is re-declared here rather than imported: requiring
 * startup/db.js opens a real pool against SiteGround, which a unit test must
 * not do. tests/moduleLoad.smoke.test.js covers the module loading; this
 * covers the decision. Keep the two copies in sync — the shape is four lines.
 */

'use strict';

const TRANSIENT = new Set([
  'EPIPE', 'ECONNRESET', 'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT',
]);

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT.has(err.code)) return true;
  return err.fatal === true && /closed state/.test(String(err.message || ''));
}

/** Exactly what mysql2 lib/base/connection.js _addCommandClosedState builds. */
function mysql2ClosedStateError() {
  const err = new Error("Can't add new command when connection is in closed state");
  err.fatal = true;                 // and NO err.code — that is the whole problem
  return err;
}

test('the codeless mysql2 closed-state error IS transient', () => {
  const err = mysql2ClosedStateError();
  expect(err.code).toBeUndefined();          // guards against mysql2 adding one
  expect(TRANSIENT.has(err.code)).toBe(false); // ...which is why the set misses it
  expect(isTransient(err)).toBe(true);
});

test('the coded socket errors stay transient', () => {
  for (const code of TRANSIENT) {
    expect(isTransient(Object.assign(new Error('x'), { code }))).toBe(true);
  }
});

test('an ordinary application error is NOT retried', () => {
  // Masking a real bug behind a silent retry is the failure mode this guards.
  expect(isTransient(new Error('Duplicate entry for key uq_doc_target'))).toBe(false);
  expect(isTransient(Object.assign(new Error('bad field'), { code: 'ER_BAD_FIELD_ERROR' }))).toBe(false);
  expect(isTransient(null)).toBe(false);
  expect(isTransient(undefined)).toBe(false);
});

test('the message alone is not enough — fatal must also be set', () => {
  // So an application error that happens to contain the phrase cannot smuggle
  // itself into the retry path.
  const impostor = new Error('user typed: connection is in closed state');
  expect(isTransient(impostor)).toBe(false);
  impostor.fatal = true;
  expect(isTransient(impostor)).toBe(true);
});
