// tests/scriptGuard.setup.js
//
// Installs the global afterEach that enforces script-fixture honesty for every
// suite in the repo. Wired through jest.config.js `setupFilesAfterEnv` — which
// runs AFTER the test framework is installed (so `afterEach` exists) and in the
// same module registry as the test file (so it shares tests/helpers/scriptGuard's
// instance and sees the guards that file registered).
//
// Why global rather than a per-file hook: a per-test — or even per-file —
// assertion is something a future author can forget, and forgetting is exactly
// what produced the T8 silent-drift incident. Registration happens inside the
// stub factory, which is written once per suite and copy-pasted from a sibling,
// so the check travels with the idiom it protects.
//
// This afterEach runs for EVERY suite, including the ~93 that never touch
// scriptGuard. For those the registry is empty and the hook is a no-op array
// splice — measured at well under a millisecond per test.
//
// See tests/helpers/scriptGuard.js for the full rationale and escape hatches.

'use strict';

const { drainScriptGuards } = require('./helpers/scriptGuard');

afterEach(() => {
  const problems = drainScriptGuards();
  if (problems.length) {
    throw new Error(
      'Scripted-DB fixture drift detected (tests/helpers/scriptGuard.js):\n\n  ' +
      problems.join('\n\n  ') + '\n'
    );
  }
});
