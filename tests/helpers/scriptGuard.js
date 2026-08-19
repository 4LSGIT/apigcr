// tests/helpers/scriptGuard.js
//
/**
 * SCRIPT DRIFT GUARD  (T9 Part 4)
 *
 * Sixteen suites stub mysql2 by scripting DB results as an ordered array that
 * each query() call shifts from. The idiom is compact and readable, and it has
 * exactly one catastrophic failure mode:
 *
 *   Insert one query in the middle of the code under test and EVERY later
 *   scripted result shifts by one. Assertions in the middle then check against
 *   the wrong fixture data, and the suite stays green while lying.
 *
 * The stubs already guarded exhaustion —
 *
 *     if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
 *
 * — but that guard can fire into a void. services/pipelineService.advanceStage
 * ends with RELEASE_LOCK inside a `finally` that deliberately swallows errors
 * (so a failed release cannot mask the real error from the try block). That
 * `finally` is correct and must stay; the consequence is that the ONE signal
 * script drift produces lands exactly where production correctly eats it.
 *
 * This happened. During T8, six advanceStage guard tests kept passing against
 * shifted data after a phase-role lookup was added inside the transaction. It
 * was caught because a reported number failed to reconcile — not because a
 * test failed.
 *
 * WHAT THIS FIXES
 * Drift is now caught in BOTH directions, and neither depends on an exception
 * escaping the code under test:
 *
 *   over-consumption   code ran MORE queries than scripted. The stub records
 *                      the overrun on the guard BEFORE throwing, so the record
 *                      survives any swallow downstream.
 *   under-consumption  code ran FEWER queries than scripted, leaving script
 *                      entries unconsumed. Equally a signal that the fixture no
 *                      longer describes the code, and previously invisible.
 *
 * Guards register themselves at construction. tests/scriptGuard.setup.js
 * installs a global afterEach (via jest.config.js setupFilesAfterEnv) that
 * drains the registry and fails the test on either condition. Nothing is
 * per-test and nothing is opt-in: a stub built through scriptGuard() is
 * checked, always.
 *
 * tests/scriptGuardCoverage.test.js is the backstop for the NEXT author — it
 * greps tests/ for the shift idiom and fails if a suite uses it without a
 * guard, so a copy-pasted stub cannot silently reintroduce the trap.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 *
 *   const { scriptGuard } = require('./helpers/scriptGuard');
 *
 *   function stubDb(script) {
 *     const calls = [];
 *     const guard = scriptGuard('stubDb', script);
 *     return {
 *       calls,
 *       query: async (sql, params) => {
 *         calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
 *         if (!script.length) guard.overrun(sql);
 *         return [script.shift()];
 *       },
 *     };
 *   }
 *
 * overrun() records and then THROWS the same Error the hand-written guard
 * threw, so any test that relies on the throw (control flow, rejects
 * assertions) behaves identically.
 *
 * ── ESCAPE HATCHES ────────────────────────────────────────────────────────
 * Both are deliberately loud: they take a reason and name a count, so an
 * exemption is a documented statement about the fixture rather than silence.
 *
 *   guard.expectOverruns(n, reason)   the test EXERCISES a swallowed query
 *                                     failure on purpose (e.g. "the log INSERT
 *                                     throws and the caller still succeeds").
 *                                     Exactly n overruns must occur — fewer
 *                                     fails too, so the scenario can't quietly
 *                                     stop happening.
 *   guard.allowLeftovers(reason)      the script is intentionally over-supplied
 *                                     (shared fixture, branch-dependent query
 *                                     count). Prefer trimming the fixture.
 *
 * Neither hatch is needed for an intentionally EMPTY script asserting that no
 * query happens — that already passes cleanly: nothing consumed, nothing left.
 */

'use strict';

/**
 * Guards constructed since the last drain.
 *
 * ON globalThis, NOT a module-level const. Jest gives each test FILE its own
 * module registry AND its own global object, so either would be correctly
 * per-file and never shared across concurrently running suites. The
 * difference is `jest.resetModules()`:
 *
 *   a module-level array   → the suite re-requires this file, gets a FRESH
 *                            registry, and registers into it — while the
 *                            afterEach in tests/scriptGuard.setup.js still
 *                            holds the ORIGINAL instance and drains an array
 *                            nothing writes to any more. The guard silently
 *                            degrades to a no-op for the rest of that suite.
 *   globalThis             → survives resetModules, so both sides keep
 *                            addressing the same array.
 *
 * This was measured, not theorised: with a module-level const, a probe that
 * called jest.resetModules() and then left three script entries unconsumed
 * passed green. Five suites in tests/ call resetModules or isolateModules
 * today (none of them scripted-DB suites — yet), and nothing stops the next
 * one from being both.
 *
 * A checker that can be silently disarmed is the exact failure mode this file
 * exists to close, so it must not have one of its own.
 */
const _REG = Symbol.for('yisracase.scriptGuard.registry');
if (!globalThis[_REG]) globalThis[_REG] = [];
const _registry = globalThis[_REG];

const _MAX_SQL = 200;

function _short(sql) {
  return String(sql == null ? '' : sql).replace(/\s+/g, ' ').trim().slice(0, _MAX_SQL);
}

/**
 * Register a scripted stub for drift checking.
 *
 * @param {string} label   tag used in messages, e.g. 'stubDb', 'stubTxDb(conn)'
 * @param {Array}  script  the live script array the stub shifts from — held BY
 *                         REFERENCE so the drain sees its final length
 * @returns {object} guard
 */
function scriptGuard(label, script) {
  if (!Array.isArray(script)) {
    throw new TypeError(`scriptGuard(${label}): script must be an array (got ${typeof script})`);
  }

  const guard = {
    label,
    script,
    scripted: script.length,   // snapshot for a useful drain message
    overruns: [],
    expectedOverruns: 0,
    overrunReason: null,
    leftoversOk: false,
    leftoversReason: null,

    /**
     * Record an over-consumption and throw. Message shape is unchanged from
     * the hand-written guards this replaces.
     */
    overrun(sql) {
      guard.overruns.push(_short(sql));
      throw new Error(`${label}: unscripted query: ${sql}`);
    },

    /** @see ESCAPE HATCHES */
    expectOverruns(n, reason) {
      if (!Number.isInteger(n) || n < 0) {
        throw new TypeError(`${label}.expectOverruns: n must be a non-negative integer`);
      }
      if (!reason) throw new TypeError(`${label}.expectOverruns: a reason is required`);
      guard.expectedOverruns = n;
      guard.overrunReason = reason;
      return guard;
    },

    /** @see ESCAPE HATCHES */
    allowLeftovers(reason) {
      if (!reason) throw new TypeError(`${label}.allowLeftovers: a reason is required`);
      guard.leftoversOk = true;
      guard.leftoversReason = reason;
      return guard;
    },
  };

  _registry.push(guard);
  return guard;
}

/**
 * Empty the registry and report drift. Called by the global afterEach; the
 * registry is CLEARED regardless of outcome so one bad test cannot cascade
 * into every subsequent one.
 *
 * @returns {string[]} human-readable problems (empty = clean)
 */
function drainScriptGuards() {
  const drained = _registry.splice(0, _registry.length);
  const problems = [];

  for (const g of drained) {
    const got = g.overruns.length;
    if (got !== g.expectedOverruns) {
      const consumed = g.scripted - g.script.length;
      if (got > g.expectedOverruns) {
        problems.push(
          `${g.label}: OVER-CONSUMED — ${g.scripted} result(s) scripted, ` +
          `${consumed} consumed, then ${got} more quer${got === 1 ? 'y' : 'ies'} ran with ` +
          `nothing left to return` +
          (g.expectedOverruns ? ` (expected ${g.expectedOverruns}: ${g.overrunReason})` : '') +
          `.\n    Unscripted SQL: ${g.overruns.map(s => `\n      - ${s}`).join('')}` +
          `\n    The code under test issues more queries than this fixture describes. ` +
          `Every scripted result after the new query is now off by one, so any ` +
          `assertion past that point was checking the WRONG row. Re-derive the ` +
          `script from the current code path — do not just append entries.`
        );
      } else {
        problems.push(
          `${g.label}: expected ${g.expectedOverruns} swallowed overrun(s) ` +
          `(${g.overrunReason}) but saw ${got}. The scenario this test exercises ` +
          `no longer happens — either the code stopped swallowing, or it stopped ` +
          `issuing the query at all.`
        );
      }
    }

    if (g.script.length && !g.leftoversOk) {
      const consumed = g.scripted - g.script.length;
      problems.push(
        `${g.label}: UNDER-CONSUMED — ${g.scripted} result(s) scripted, only ` +
        `${consumed} consumed, ${g.script.length} left over.\n    The fixture no ` +
        `longer describes the code: either the code stopped issuing a query this ` +
        `script still answers, or the script was over-supplied. Trim it, or call ` +
        `guard.allowLeftovers('why') if the count is genuinely branch-dependent.`
      );
    }
  }

  return problems;
}

/** Test-only: current registry depth. Used by scriptGuard's own unit test. */
function _registrySize() {
  return _registry.length;
}

module.exports = { scriptGuard, drainScriptGuards, _registrySize };