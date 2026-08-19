// tests/scriptGuardCoverage.test.js
//
/**
 * BACKSTOP FOR THE NEXT AUTHOR  (T9 Part 4)
 *
 * tests/helpers/scriptGuard.js closes the script-drift trap for every suite
 * wired to it today. This file is what keeps it closed tomorrow.
 *
 * The scripted-DB stub is a copy-paste idiom: a new suite gets one by lifting
 * the factory out of a sibling file. If someone lifts a PRE-guard copy — from
 * git history, from a stale branch, from memory — the new suite silently
 * inherits the exact failure mode T8 hit, and nothing anywhere complains.
 *
 * So the enforcement is structural, in the same spirit as
 * tests/eventRegistryCoverage.test.js (every emit site must have an
 * EVENT_TYPES entry) and tests/schemaConventions.test.js (every table must
 * carry the house collation): find the pattern mechanically, require the
 * guard, fail loudly with the fix spelled out.
 *
 * WHAT COUNTS AS THE IDIOM
 *   a call to `.shift()` on an identifier, inside a file inside tests/.
 * That is deliberately broad — broader than "a mysql2 stub" — because the trap
 * is a property of consuming an ordered script, not of what is being stubbed.
 * Genuine non-DB uses (a fetch-body sequence, a queue drain in the code under
 * test) are listed in EXEMPT with a reason, which is the point: an exemption
 * is a written statement, not an omission.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;

/**
 * Files that shift() from an array but are NOT scripted-DB stubs. Each entry
 * must say why. Adding one is a deliberate act; forgetting to add one fails
 * the suite instead of silently reintroducing the trap.
 */
const EXEMPT = {
  'esignProvider.zoho.test.js':
    'mockFetchJson() sequences HTTP response BODIES, not DB rows, and does so ' +
    'with sticky-last semantics (`bodies.length > 1 ? bodies.shift() : bodies[0]`) ' +
    'so the final body repeats forever by design. Its DB stub (makeDb) matches on ' +
    'SQL text and has no script array at all. Neither drift direction applies.',
  'scriptGuardCoverage.test.js':
    'this file — its own source text contains the pattern it searches for.',
};

/** `.shift()` called on something that looks like a script array. */
const SHIFT_RE = /\b[A-Za-z_$][\w$]*\s*\.\s*shift\s*\(\s*\)/;

function listTestSources() {
  return fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

describe('scriptGuard coverage — the shift-from-a-script idiom cannot go unguarded', () => {
  test('every tests/*.js that shifts from a script registers a scriptGuard', () => {
    const offenders = [];

    for (const file of listTestSources()) {
      if (Object.prototype.hasOwnProperty.call(EXEMPT, file)) continue;

      const src = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');
      if (!SHIFT_RE.test(src)) continue;
      if (src.includes('helpers/scriptGuard')) continue;

      offenders.push(file);
    }

    if (offenders.length) {
      throw new Error(
        `These suites consume an ordered script with .shift() but do not register a\n` +
        `scriptGuard, so fixture drift in either direction passes silently:\n\n` +
        offenders.map((f) => `  - tests/${f}`).join('\n') +
        `\n\nFix (see tests/helpers/scriptGuard.js for the full rationale):\n` +
        `  1. const { scriptGuard } = require('./helpers/scriptGuard');\n` +
        `  2. in the stub factory:  const guard = scriptGuard('stubDb', script);\n` +
        `  3. replace the hand-written exhaustion throw with:\n` +
        `       if (!script.length) guard.overrun(sql);\n\n` +
        `If the shift() is genuinely not a scripted-DB stub, add the file to EXEMPT\n` +
        `in this test WITH A REASON.`
      );
    }
  });

  test('every EXEMPT entry still exists and still contains the idiom', () => {
    // Stops the exemption list rotting into a list of excuses for files that
    // were renamed, deleted, or have since stopped using the pattern.
    const present = new Set(listTestSources());
    const stale = [];

    for (const [file, reason] of Object.entries(EXEMPT)) {
      if (!reason || reason.length < 20) {
        stale.push(`${file}: exemption reason is missing or too thin to be a reason`);
        continue;
      }
      if (!present.has(file)) {
        stale.push(`${file}: exempted but no longer exists — drop the entry`);
        continue;
      }
      const src = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');
      if (!SHIFT_RE.test(src)) {
        stale.push(`${file}: exempted but no longer uses .shift() — drop the entry`);
      }
    }

    expect(stale).toEqual([]);
  });

  test('the guard is actually wired into jest.config.js setupFilesAfterEnv', () => {
    // The whole scheme collapses to a no-op if this line is ever dropped: the
    // guards would register and nothing would ever drain or assert them, and
    // every suite would go green again with no visible change.
    const cfg = require('../jest.config.js');
    expect(Array.isArray(cfg.setupFilesAfterEnv)).toBe(true);
    expect(cfg.setupFilesAfterEnv.some((p) => p.includes('scriptGuard.setup'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scriptGuard's own behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('scriptGuard mechanics', () => {
  // These use drainScriptGuards() DIRECTLY so the global afterEach sees a clean
  // registry afterwards — otherwise asserting on a dirty guard would fail the
  // very test that asserts it.
  const { scriptGuard, drainScriptGuards } = require('./helpers/scriptGuard');

  test('a fully consumed script reports nothing', () => {
    const script = [[{ a: 1 }], [{ b: 2 }]];
    scriptGuard('t', script);
    script.shift(); script.shift();
    expect(drainScriptGuards()).toEqual([]);
  });

  test('leftovers are reported as UNDER-CONSUMED', () => {
    const script = [[1], [2], [3]];
    scriptGuard('t', script);
    script.shift();
    const problems = drainScriptGuards();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('UNDER-CONSUMED');
    expect(problems[0]).toContain('3 result(s) scripted, only 1 consumed');
  });

  test('an overrun is reported even when the throw is swallowed', () => {
    // This is the case the hand-written guard could not catch: pipelineService's
    // RELEASE_LOCK finally eats the error, so only the recorded side effect
    // survives. Reproduced here with a bare try/catch.
    const script = [];
    const g = scriptGuard('t', script);
    try { g.overrun('SELECT RELEASE_LOCK(?)'); } catch (_) { /* swallowed, as prod does */ }
    const problems = drainScriptGuards();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('OVER-CONSUMED');
    expect(problems[0]).toContain('RELEASE_LOCK');
  });

  test('overrun() still throws the same message the hand-written guard threw', () => {
    const g = scriptGuard('stubTxDb(conn)', []);
    expect(() => g.overrun('SELECT 1')).toThrow('stubTxDb(conn): unscripted query: SELECT 1');
    drainScriptGuards();
  });

  test('expectOverruns tolerates the declared count and rejects a different one', () => {
    const g1 = scriptGuard('t', []).expectOverruns(1, 'simulated write failure');
    try { g1.overrun('INSERT 1'); } catch (_) {}
    expect(drainScriptGuards()).toEqual([]);

    // Declared but never happened → still a failure. The scenario must not
    // quietly stop being exercised.
    scriptGuard('t', []).expectOverruns(1, 'simulated write failure');
    const problems = drainScriptGuards();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('expected 1 swallowed overrun(s)');
  });

  test('allowLeftovers suppresses only the under-consumption report', () => {
    const script = [[1], [2]];
    scriptGuard('t', script).allowLeftovers('branch-dependent shared fixture');
    expect(drainScriptGuards()).toEqual([]);
  });

  test('both escape hatches demand a reason', () => {
    const g = scriptGuard('t', []);
    expect(() => g.allowLeftovers()).toThrow(/reason is required/);
    expect(() => g.expectOverruns(1)).toThrow(/reason is required/);
    expect(() => g.expectOverruns(-1, 'x')).toThrow(/non-negative integer/);
    g.allowLeftovers('cleanup');
    drainScriptGuards();
  });

  test('drain empties the registry so one dirty test cannot cascade', () => {
    const { _registrySize } = require('./helpers/scriptGuard');
    scriptGuard('t', [[1]]);
    expect(_registrySize()).toBe(1);
    drainScriptGuards();
    expect(_registrySize()).toBe(0);
  });

  test('a non-array script is a programming error, not a silent pass', () => {
    expect(() => scriptGuard('t', null)).toThrow(/must be an array/);
    expect(() => scriptGuard('t', { length: 0 })).toThrow(/must be an array/);
  });
});
