'use strict';
/**
 * tests/guestCode.test.js
 *
 * lib/guestCode.js — the engine every code BODY now runs in (trigger rules,
 * email/phone ingest rules, email/phone log suppressions, hook filters and
 * transforms): the QuickJS guest engine inside the scrubbed sandbox child.
 * This suite pins the engine-level contract; tests/codeBodySites.guest.test.js
 * pins each call site's semantics on top of it.
 *
 * REAL ENGINE, NO MOCKS: every case forks the real child and runs the real
 * QuickJS guest. Nothing here dispatches anything.
 *
 * Escape assertions observe the property DIRECTLY — the body reports what it
 * can see, and the test asserts that value; nothing is conditional on an
 * escape having happened first (CLAUDE.md, "an assertion that can only run
 * once the thing it guards has already failed is not a gate").
 */

const guestCode = require('../lib/guestCode');
const { runBody, runBodies, batchRunner, guestSource } = guestCode;

jest.setTimeout(30000);

const errOf = async (p) => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); };

describe('the contract every existing body was written against', () => {
  test('a function body over `input`, using `return` — the value crosses losslessly', async () => {
    const v = await runBody(
      'var d = new Date(Date.UTC(2026, 9, 26)); return { a: input.x + 1, d: d, u: undefined, n: NaN, i: -Infinity, arr: [1, "b", null] };',
      { x: 41 });
    expect(Object.keys(v).sort()).toEqual(['a', 'arr', 'd', 'i', 'n', 'u']);
    expect(v.a).toBe(42);
    expect(v.d).toBeInstanceOf(Date);
    expect(v.d.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(v.u).toBeUndefined();
    expect(Number.isNaN(v.n)).toBe(true);
    expect(v.i).toBe(-Infinity);
    expect(v.arr).toEqual([1, 'b', null]);
  });

  test('a body without `return` resolves undefined (as new Function did)', async () => {
    await expect(runBody('var x = 1;', {})).resolves.toBeUndefined();
  });

  test('truthy mode reduces IN the guest to a real boolean', async () => {
    await expect(runBody('return input.n', { n: 0 }, { truthy: true })).resolves.toBe(false);
    await expect(runBody('return input.n', { n: 3 }, { truthy: true })).resolves.toBe(true);
    await expect(runBody('return "x"', {}, { truthy: true })).resolves.toBe(true);
    await expect(runBody('return null', {}, { truthy: true })).resolves.toBe(false);
  });

  test('a thrown Error rejects with its message; a thrown non-Error has message undefined, as err.message read it in-process', async () => {
    expect((await errOf(runBody('throw new Error("boom")', {}))).message).toBe('boom');
    const s = await errOf(runBody('throw "just a string"', {}));
    expect(s.message).toBeUndefined();
    expect(`${s.message}`).toBe('undefined');
    expect((await errOf(runBody('throw 1', {}))).message).toBeUndefined();
    expect((await errOf(runBody('throw null', {}))).message).toBe('threw null');
  });

  test('a syntax error is an error, not a value', async () => {
    const e = await errOf(runBody('return (', {}));
    expect(typeof e.message).toBe('string');
    expect(e.message.length).toBeGreaterThan(0);
  });

  test('a body that closes its wrapper is an error, never a value read off whatever the script left behind', async () => {
    // Balanced so it PARSES: the wrapper is closed early and the script's
    // completion value becomes an `if (0)` statement's (undefined) — no result
    // shape at all. (A breakout CAN forge a well-shaped {ok:true, value}; that
    // is no more than `return value` would give it, so the shape check is a
    // sanity check against garbage, not a boundary.)
    const breakout = 'return 0 \n})(__ycInput); return { ok: true, value: __ycResult }; } catch (e) { return { ok: false }; } })(globalThis.input); if (0) (function (__ycInput) { try { var __ycResult = (function (input) {';
    const r = await runBodies(breakout, [{}]);
    expect(r[0].ok).toBe(false);
    expect(r[0].error.message).toMatch(/escaped its function wrapper/);
  });

  test('a returned function cannot cross and reads as undefined — never a crash in the parent', async () => {
    await expect(runBody('return function () {}', {})).resolves.toBeUndefined();
  });

  test('console.warn / console.error lines reach the server log as warnings, labelled; console.log as logs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runBody('console.warn("careful", { a: 1 }); console.log("fyi"); console.error("bad"); return {};', {}, { label: 'unit' });
      expect(warn.mock.calls.map((c) => c.join(' '))).toEqual(['[unit] careful {"a":1}', '[unit] bad']);
      expect(log.mock.calls.map((c) => c.join(' '))).toEqual(['[unit] fyi']);
    } finally { warn.mockRestore(); log.mockRestore(); }
  });

  test('input mutations stay in the guest (the caller\'s object is untouched)', async () => {
    const input = { a: 1 };
    await runBody('input.a = 2; input.b = 3; return input;', input);
    expect(input).toEqual({ a: 1 });
  });

  test('the guest source wraps the body as a function body', () => {
    const src = guestSource('return 1', { truthy: true });
    expect(src).toContain('(function (input) { return 1');
    expect(src).toContain('!!__ycResult');
    expect(guestSource('return 1')).not.toContain('!!__ycResult');
  });
});

describe('no host reach (asserted directly, from inside the body)', () => {
  test('process / require / the walk-back / Function("return this") all find nothing', async () => {
    const seen = await runBody(`return {
      process: typeof process,
      require: typeof require,
      globalProcess: typeof globalThis.process,
      walkBack: input.constructor.constructor('return typeof process')(),
      walkBackRequire: input.constructor.constructor('return typeof require')(),
      fnThisProcess: typeof Function('return this')().process,
      fetch: typeof fetch,
      setTimeout: typeof setTimeout,
      Buffer: typeof Buffer,
      Intl: typeof Intl,
    };`, { x: 1 });
    expect(seen).toEqual({
      process: 'undefined', require: 'undefined', globalProcess: 'undefined',
      walkBack: 'undefined', walkBackRequire: 'undefined', fnThisProcess: 'undefined',
      fetch: 'undefined', setTimeout: 'undefined', Buffer: 'undefined', Intl: 'undefined',
    });
  });

  test('the walk-back to `process` itself throws in the guest instead of returning the host process', async () => {
    const e = await errOf(runBody('return input.constructor.constructor("return process")()', {}));
    expect(e.message).toMatch(/process/);
  });
});

describe('runaways end within their bound and never hang this process', () => {
  test('an infinite loop is interrupted at the time limit', async () => {
    const t = Date.now();
    const e = await errOf(runBody('while (true) {}', {}, { timeoutMs: 400 }));
    expect(e.code).toBe('GUEST_CODE_TIMEOUT');
    expect(e.message).toMatch(/timed out after 400ms/);
    expect(Date.now() - t).toBeLessThan(400 + guestCode.KILL_GRACE_MS + 1500);
  });

  test('a timeout cannot be swallowed by the body\'s own try/catch', async () => {
    const e = await errOf(runBody('try { while (true) {} } catch (x) { return "caught"; }', {}, { timeoutMs: 300 }));
    expect(e.code).toBe('GUEST_CODE_TIMEOUT');
  });

  test('an allocation bomb fails (out of memory or time), bounded', async () => {
    const t = Date.now();
    const e = await errOf(runBody('var a = []; while (true) a.push("x".repeat(1e6)); return a.length;', {}, { timeoutMs: 1500 }));
    expect(e).toBeInstanceOf(Error);
    expect(Date.now() - t).toBeLessThan(1500 + guestCode.KILL_GRACE_MS + 1500);
    const big = await errOf(runBody('return "x".repeat(1e9).length', {}, { timeoutMs: 1500 }));
    expect(big.message).toMatch(/memory/i);
  });

  test('a batch shares ONE budget: inputs after it is spent are not evaluated and report as timeouts', async () => {
    const t = Date.now();
    const r = await runBodies('while (true) {}', [{}, {}, {}, {}], { timeoutMs: 400 });
    expect(r.map((x) => x.ok)).toEqual([false, false, false, false]);
    expect(r.every((x) => x.error.code === 'GUEST_CODE_TIMEOUT')).toBe(true);
    expect(r.slice(1).every((x) => /not evaluated/.test(x.error.message))).toBe(true);
    expect(Date.now() - t).toBeLessThan(400 + guestCode.KILL_GRACE_MS + 1500);
  });
});

test('a batch input that starts inside the budget is still cut at the budget, not its own full limit', async () => {
  // Input 0 burns ~250 ms of a 400 ms budget; input 1 loops. Capped by the
  // batch deadline it is interrupted ~150 ms after it starts, not 400.
  const body = 'if (input.ms > 0) { var t = Date.now(); while (Date.now() - t < input.ms) {} return 1; } while (true) {}';
  const r = await runBodies(body, [{ ms: 250 }, { ms: 0 }, { ms: 0 }], { timeoutMs: 400 });
  expect(r[0]).toEqual({ ok: true, value: 1 });
  expect(r[1].error.code).toBe('GUEST_CODE_TIMEOUT');
  expect(r[1].error.elapsed).toBeLessThan(330);
  expect(r[2].error.message).toMatch(/not evaluated/);
});

test('at most MAX_CHILDREN sandbox children run at once; the rest queue and still complete', async () => {
  const cp = require('child_process');
  const realFork = cp.fork;
  let live = 0;
  let peak = 0;
  const spy = jest.spyOn(cp, 'fork').mockImplementation((...args) => {
    const child = realFork(...args);
    live += 1; peak = Math.max(peak, live);
    child.once('exit', () => { live -= 1; });
    return child;
  });
  try {
    const n = guestCode.MAX_CHILDREN * 2 + 1;
    const body = 'var t = Date.now(); while (Date.now() - t < 150) {} return input.i;';
    const out = await Promise.all(Array.from({ length: n }, (_, i) => runBody(body, { i })));
    expect(out).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(spy).toHaveBeenCalledTimes(n);
    expect(peak).toBeLessThanOrEqual(guestCode.MAX_CHILDREN);
    expect(peak).toBeGreaterThan(1);
  } finally { spy.mockRestore(); }
});

describe('batches', () => {
  test('one child answers many inputs, each in its own fresh context', async () => {
    const inputs = Array.from({ length: 120 }, (_, i) => ({ i }));
    const r = await runBodies('globalThis.seen = (globalThis.seen || 0) + 1; return { i: input.i, seen: globalThis.seen };', inputs);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(r.map((x) => x.value.i)).toEqual(inputs.map((x) => x.i));
    expect(r.every((x) => x.value.seen === 1)).toBe(true);   // no state carried between inputs
  });

  test('batchRunner answers covered calls from the batch and runs anything else itself', async () => {
    const a = { s: 'yes' };
    const b = { s: '' };
    const run = await batchRunner('return input.s', [a, b], { truthy: true });
    const spy = jest.spyOn(guestCode, 'runBodies');
    try {
      await expect(run('return input.s', a, { truthy: true })).resolves.toBe(true);
      await expect(run('return input.s', b, { truthy: true })).resolves.toBe(false);
      expect(spy).not.toHaveBeenCalled();                                    // served from the batch
      await expect(run('return input.s', { s: 'other' }, { truthy: true })).resolves.toBe(true);
      await expect(run('return input.s', a, { truthy: false })).resolves.toBe('yes');
      expect(spy).toHaveBeenCalledTimes(2);                                  // uncovered → run, correctly
    } finally { spy.mockRestore(); }
  });

  test('an unserializable input fails alone; its neighbours still run', async () => {
    const cyc = {}; cyc.self = cyc;
    const r = await runBodies('return 1', [{}, cyc, {}]);
    expect(r.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r[1].error.message).toMatch(/serialized/);
  });
});
