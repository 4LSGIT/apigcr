'use strict';
// "Safe mode" for custom_code steps: the step's body runs in QuickJS compiled
// to WebAssembly (quickjs-emscripten), a guest engine, not in Node.
//
// WHY A GUEST ENGINE. Node's `vm` shares the realm with the host, so a
// sandboxed script can walk back to the real `process` through any host
// object, and the post-escape hardening is monkey-patching that was bypassed
// in practice (`process.getBuiltinModule`, demonstrated 2026-10-22 —
// ref/plans.md). QuickJS is a different engine: `process`, `require`, `fetch`,
// the filesystem and the network do not exist in the guest universe, and the
// only thing that crosses the wall is data through an explicit handle API.
// That is a boundary, not a cost. It is what makes a safe-mode step authorable
// by Casey (model output) rather than only by a trusted human.
//
// WHAT IT COSTS. QuickJS is not V8: this build has NO `Intl`, so
// `Intl.DateTimeFormat` and locale `Date` methods throw. Safe steps take
// date/locale values through `input` instead. That is also why the 97
// existing standard steps are not migrated here (4 published workflows use
// Intl — ref/plans.md).
//
// CONTRACT PARITY with lib/customCodeRunner.js, deliberately: `input` and
// `console.log` in scope, the script's FINAL EXPRESSION is the result, the
// return value crosses as JSON with the same `__cc` tags (Date / undefined /
// non-finite survive), and the result shape is the same
// `{ ok, valueJson, logs } | { ok:false, timedOut, elapsed, message }` the
// parent already consumes. The parent cannot tell the engines apart except by
// what an escape attempt finds.
//
// This module still runs INSIDE the scrubbed, killable child (env:{},
// hardening preload, parent kill timer) — the child is the backstop for a
// WASM-level runaway the interrupt handler cannot stop. Loaded lazily by the
// child only when the message says engine:'quickjs', so standard steps never
// pay the WASM load.

// Guest memory ceiling. The vm path has no memory limit at all (an allocation
// bomb OOMs the child); here the runtime refuses the allocation and the step
// fails with its own error instead. 64MB is ~100x the largest live step's
// working set.
const SAFE_MEMORY_BYTES = 64 * 1024 * 1024;

// Same tagger the vm prelude embeds (customCodeRunner.prelude), kept
// byte-for-byte in sync so both engines ship the identical transport scheme
// and the parent's single `revive` inverts both.
const TAG_FN = `
  globalThis.__tag = function (value, seen) {
    if (value === undefined) return { __cc: 'undef' };
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !isFinite(value)) return { __cc: 'num', v: String(value) };
      return value;
    }
    if (value instanceof Date) return { __cc: 'date', v: value.getTime() };
    if (seen.indexOf(value) !== -1) {
      throw new Error('custom code returned a value containing a cycle, which cannot leave the sandbox');
    }
    seen.push(value);
    let out;
    if (Array.isArray(value)) {
      out = [];
      for (let i = 0; i < value.length; i++) out.push(globalThis.__tag(value[i], seen));
    } else {
      out = {};
      for (const k of Object.keys(value)) out[k] = globalThis.__tag(value[k], seen);
    }
    seen.pop();
    return out;
  };
`;

// `deadlineAt` (optional, epoch ms) caps this run below its own `timeout` —
// runBatch passes the batch's deadline so a batch can never outlive its one
// budget, whatever the number of inputs.
async function run({ code, inputJson, timeout, deadlineAt }) {
  // Lazy so merely requiring this file (tests, doc tools) loads no WASM.
  const { getQuickJS } = require('quickjs-emscripten');
  const QuickJS = await getQuickJS();

  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(SAFE_MEMORY_BYTES);
  const startedAt = Date.now();
  const ownDeadline = startedAt + (timeout > 0 ? timeout : 60000);
  const deadline = Number.isFinite(deadlineAt) ? Math.min(ownDeadline, deadlineAt) : ownDeadline;
  // Fires periodically during guest execution; returning true interrupts the
  // guest wherever it is, including a `while(true){}`.
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const ctx = runtime.newContext();

  // evalCode returns a handle that must be disposed on both outcomes, or the
  // WASM heap leaks across steps in a reused process (the tests reuse one).
  const evalIn = (src) => {
    const r = ctx.evalCode(src);
    if (r.error) {
      const dumped = ctx.dump(r.error);
      r.error.dispose();
      const message = dumped && typeof dumped === 'object'
        ? String(dumped.message || dumped.name || 'error') : String(dumped);
      return { threw: true, message };
    }
    return { value: r.value };
  };

  const readLogs = () => {
    const r = evalIn('JSON.stringify((globalThis.__logs || []).slice(0, 200).map(String))');
    if (r.threw) return [];
    const json = ctx.dump(r.value);
    r.value.dispose();
    try { return JSON.parse(json); } catch (_) { return []; }
  };

  try {
    // The whole sandbox is built from inside, exactly as the vm prelude does:
    // input arrives as a JSON string literal and is parsed in the guest, so
    // nothing host-created exists there even as a handle.
    const prelude = `
      globalThis.__logs = [];
      globalThis.console = {
        log: function () {
          const parts = [];
          for (let i = 0; i < arguments.length; i++) {
            const a = arguments[i];
            parts.push(typeof a === 'string' ? a
              : (function () { try { return JSON.stringify(a); } catch (_) { return String(a); } })());
          }
          globalThis.__logs.push(parts.join(' '));
        },
      };
      globalThis.input = JSON.parse(${JSON.stringify(inputJson)});
      ${TAG_FN}
    `;
    const p = evalIn(prelude);
    if (p.threw) return { ok: false, logs: [], message: `safe-mode prelude failed: ${p.message}` };
    p.value.dispose();

    const r = evalIn(code);
    if (r.threw) {
      const logs = readLogs();
      if (/interrupted/i.test(r.message)) {
        return { ok: false, logs, timedOut: true, elapsed: Date.now() - startedAt,
          message: `Script execution timed out after ${timeout}ms` };
      }
      return { ok: false, logs, message: r.message };
    }

    // Tag and stringify inside the guest, so what crosses is a string.
    ctx.setProp(ctx.global, '__value', r.value);
    r.value.dispose();
    const s = evalIn('JSON.stringify(globalThis.__tag(globalThis.__value, []))');
    if (s.threw) {
      return { ok: false, logs: readLogs(),
        message: `custom code returned a value that could not leave the sandbox: ${s.message}` };
    }
    const valueJson = ctx.dump(s.value);
    s.value.dispose();
    const logs = readLogs();
    // `undefined` as the final expression stringifies to undefined (not a
    // string) only at the top level when __tag was bypassed — __tag maps it to
    // {"__cc":"undef"}, so valueJson is always a string here.
    return { ok: true, logs, valueJson };
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}

// One body, many inputs, one child: the code-body sites (lib/guestCode.js)
// send every call through here — production with one input, the rule
// previews with up to a few hundred. Each input still gets its OWN runtime and
// context (nothing a body does to its globals reaches the next input), and the
// whole batch shares ONE time budget, so the parent's kill timer is a single
// known number. An input reached after the budget is spent is not evaluated
// and reports as a timeout — never as a silent success.
async function runBatch({ code, inputJsons, timeout, budget }) {
  const startedAt = Date.now();
  const total = budget > 0 ? budget : (timeout > 0 ? timeout : 60000);
  const deadlineAt = startedAt + total;
  const results = [];
  for (const inputJson of Array.isArray(inputJsons) ? inputJsons : []) {
    if (Date.now() >= deadlineAt) {
      results.push({ ok: false, logs: [], timedOut: true, elapsed: Date.now() - startedAt,
        message: `Script execution timed out after ${timeout}ms (not evaluated: the batch's ${total}ms budget was spent before this input)` });
      continue;
    }
    results.push(await run({ code, inputJson, timeout, deadlineAt }));
  }
  return { ok: true, batch: results };
}

module.exports = { run, runBatch, SAFE_MEMORY_BYTES };
