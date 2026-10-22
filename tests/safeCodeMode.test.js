'use strict';
// Behavioural tests for custom_code SAFE MODE (code_mode: 'safe' — QuickJS
// compiled to WASM, lib/safeCodeRunner.js). These run the REAL executor, which
// forks the REAL scrubbed child and loads the REAL guest engine — nothing here
// mocks the thing under test. Style and reasoning follow
// tests/customCodeSandbox.test.js; a fork + WASM load costs ~150-400ms, so
// these are deliberately few and pointed.

const path = require('path');
const { executeJob } = require(path.join(__dirname, '..', 'lib', 'job_executor'));

const safeJob = (code, extra = {}) =>
  ({ id: 'safe-test', data: { type: 'custom_code', code_mode: 'safe', code, ...extra } });

jest.setTimeout(30000);

describe('safe mode ignores the child-process flag — no fallback to vm exists', () => {
  test('with the flag OFF, a safe step still runs in the guest engine', async () => {
    // THE property of the slice. The flag selects where a STANDARD step runs;
    // a safe step runs in QuickJS unconditionally, because the mode is a
    // stored property of the step and the author relied on the safe contract.
    // The probe distinguishes the engines by the one thing that differs: in
    // the vm (either location) the constructor walk-back compiles against a
    // host-shaped realm; in the guest there is no `process` in the universe.
    // With the flag off, the in-process vm path resolves it to the REAL
    // process (the pinned 'off is the legacy path' test proves exactly that),
    // so 'no-process-anywhere' here proves the quickjs branch ran.
    delete process.env.CUSTOM_CODE_CHILD_PROCESS; // default: off
    const got = await executeJob(safeJob(`
      var r;
      try { r = typeof input.constructor.constructor("return process")(); }
      catch (e) { r = "no-process-anywhere"; }
      r;
    `, { input: { a: 1 } }));
    expect(got).toBe('no-process-anywhere');
  });

  test('the guest universe has no Node or web capabilities at all', async () => {
    const caps = await executeJob(safeJob(`
      ({ process: typeof process, require: typeof require, fetch: typeof fetch,
         Buffer: typeof Buffer, XMLHttpRequest: typeof XMLHttpRequest,
         Intl: typeof Intl })
    `));
    // Intl pinned too: it is the documented safe-mode limitation (dates come
    // in via input). If a build upgrade ever adds Intl, this failing is the
    // signal to revisit migrating the standard steps — update, don't delete.
    expect(caps).toEqual({ process: 'undefined', require: 'undefined',
      fetch: 'undefined', Buffer: 'undefined', XMLHttpRequest: 'undefined',
      Intl: 'undefined' });
  });

  test('an unknown code_mode throws instead of running standard', async () => {
    // Fail closed at the ONE dispatch choke point: workflow engine, test-step
    // and scheduled jobs all arrive at executeJob, so this covers them all.
    await expect(executeJob(safeJob('1', { code_mode: 'definitely-not-a-mode' })))
      .rejects.toThrow(/Unknown custom code mode/);
  });
});

describe('the safe contract matches the standard one', () => {
  test('a pure transform returns the same value it would in standard mode', async () => {
    await expect(executeJob(safeJob('input.a + input.b', { input: { a: 2, b: 3 } })))
      .resolves.toBe(5);
    await expect(executeJob(safeJob('({ joined: input.xs.join("-"), n: input.xs.length })',
      { input: { xs: ['a', 'b', 'c'] } }))).resolves.toEqual({ joined: 'a-b-c', n: 3 });
  });

  test('Date, NaN, Infinity and undefined survive the boundary', async () => {
    // Same transport contract as the vm path: 28 of the 97 live steps do date
    // math and declare set_vars, so this is behaviour, not nicety.
    const out = await executeJob(safeJob('({ when: new Date(1761100000000), n: 1 })'));
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.getTime()).toBe(1761100000000);
    const odd = await executeJob(safeJob('({ a: NaN, b: Infinity })'));
    expect(Number.isNaN(odd.a)).toBe(true);
    expect(odd.b).toBe(Infinity);
    await expect(executeJob(safeJob('undefined'))).resolves.toBeUndefined();
    await expect(executeJob(safeJob('var a = {}; a.self = a; a;')))
      .rejects.toThrow(/cycle/);
  });

  test('console.log reaches the parent log, prefixed, and errors carry the step message', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await executeJob(safeJob('console.log("hello", 42); "done"'));
      expect(spy).toHaveBeenCalledWith('[CUSTOM CODE safe-test]', 'hello 42');
    } finally { spy.mockRestore(); }
    await expect(executeJob(safeJob('throw new Error("step said no")')))
      .rejects.toThrow('step said no');
  });

  test('a runaway loop is interrupted as a timeout; an allocation bomb is refused', async () => {
    await expect(executeJob(safeJob('while (true) {}', { timeout_ms: 400 })))
      .rejects.toMatchObject({ code: 'CUSTOM_CODE_TIMEOUT' });
    // The vm path has no memory ceiling at all (the bomb OOMs the child); the
    // guest runtime refuses the allocation and the step fails on its own.
    await expect(executeJob(safeJob(
      'var a = []; while (true) a.push(new Array(1000000).fill("x"));',
      { timeout_ms: 10000 }
    ))).rejects.toThrow(/out of memory|memory/i);
  });
});

// Save-time code_mode validation is pinned behaviourally in
// tests/workflows.codeStepGate.test.js, which already runs the real router
// over a real socket — the same harness that pins the type-key guard.
