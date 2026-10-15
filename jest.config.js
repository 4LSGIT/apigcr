// jest.config.js
//
// Minimal on purpose.
//
// setupFiles          centralizes fail-fast env seeding (tests/jest.setup.js)
//                     so test files don't each hand-roll it and `npm test`
//                     works from a clean shell with no exports. Runs BEFORE the
//                     test framework is installed — no describe/afterEach here.
//
// setupFilesAfterEnv  installs the global scripted-DB drift guard
//                     (tests/scriptGuard.setup.js). Must be AfterEnv, not
//                     setupFiles: it registers an `afterEach`, which only
//                     exists once the framework is installed. It also needs the
//                     test file's module registry so it shares the
//                     tests/helpers/scriptGuard instance the stubs registered
//                     into. See tests/helpers/scriptGuard.js for why this is
//                     global rather than opt-in.
//
// testPathIgnorePatterns  keeps Claude Code worktrees (.claude/worktrees/*)
//                     out of the run — a nested checkout's stale copy of the
//                     suite otherwise runs too, doubling the run (2026-10-15).
module.exports = {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/'],
  setupFiles: ['<rootDir>/tests/jest.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/scriptGuard.setup.js'],
};
