'use strict';
// The child process a custom_code step runs in.
//
// WHY A CHILD AT ALL. `vm` is not a security boundary: a sandbox holding any
// host-created object can be walked back to the host realm
// (`input.constructor.constructor('return process')()` hands back the real
// `process`, with a working `mainModule.require`). In-process that reached
// `process.env` — the app's own DB credentials — so a workflow code step was
// arbitrary server-side execution for anyone who could save or test one.
//
// A code step has never been able to use any of that: the sandbox has only
// ever held `{ input, console }`, with no `require`, no `db`, no `process` and
// no network. All 97 live code steps are pure transforms (checked 2026-10-22:
// none references process, require, constructor or global — the one `process`
// hit is the word in a comment and the `require` hits are English prose in
// string literals). So moving execution into a scrubbed child costs legitimate
// steps nothing and takes the credentials off the escape path.
//
// TWO BOUNDARIES, deliberately:
//   1. The process. `env` is emptied by the parent, so an escape lands in a
//      process holding no secrets, no DB handle and no pool.
//   2. The context. Nothing host-created is placed in the sandbox at all —
//      `input` arrives as a JSON string embedded in the prelude and is parsed
//      INSIDE the context, and `console` is built inside the context too. So
//      the usual walk-back finds only this context's own intrinsics, and
//      `constructor.constructor('return process')()` evaluates to undefined
//      rather than to the host `process`.
//
// WHAT THIS DOES NOT DO: it is not a general sandbox. A step that escapes the
// vm inside this child still has that child's network access, which on Cloud
// Run includes the metadata server. Closing that means a real isolate
// (isolated-vm) or a network-restricted runtime, and is only worth it if code
// steps ever stop being pure transforms. Recorded in ref/plans.md.
//
// execArgv is inherited from the parent on purpose: the Dockerfile's
// `--enable-experimental-regexp-engine` is load-bearing (CLAUDE.md), and
// inheriting it keeps a step's regexes behaving exactly as they do today —
// including the linear-engine protection against catastrophic backtracking in
// a step's own pattern.

const vm = require('vm');

// The prelude runs before the step's code and builds the whole sandbox from
// inside. `__inputJson` is embedded as a JSON string literal, so no host
// object ever enters the context.
function prelude(inputJson) {
  return `
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

    // Lossless transport. The value crossing the IPC boundary must mean the
    // same thing it meant in-process, where it became context.this and
    // {{this.x}} resolved against it directly. Plain JSON would turn a
    // returned Date into an ISO string and NaN into null — and 28 of the 97
    // live steps do date math and declare set_vars, so that is a real
    // difference, not a theoretical one. Dates and non-finite numbers are
    // tagged here and revived by the parent.
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
}

// Mirror of the in-context tagger. Functions and symbols still cannot cross —
// a transform step has no business returning one, and {{this.fn}} could never
// have resolved to anything useful.
function revive(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.__cc === 'string') {
    if (value.__cc === 'undef') return undefined;
    if (value.__cc === 'date') return new Date(value.v);
    if (value.__cc === 'num') return Number(value.v);
  }
  if (Array.isArray(value)) return value.map(revive);
  const out = {};
  for (const k of Object.keys(value)) out[k] = revive(value[k]);
  return out;
}

function run({ code, inputJson, timeout }) {
  const context = vm.createContext(Object.create(null));
  vm.runInContext(prelude(inputJson), context, { timeout });

  const startedAt = Date.now();
  let value;
  try {
    value = vm.runInContext(code, context, { timeout });
  } catch (err) {
    const logs = readLogs(context);
    if (/Script execution timed out/i.test((err && err.message) || '')) {
      return { ok: false, logs, timedOut: true, elapsed: Date.now() - startedAt,
        message: (err && err.message) || 'Script execution timed out' };
    }
    return { ok: false, logs, message: (err && err.message) || String(err) };
  }

  // Tag and serialize inside the context, so what crosses the boundary is a
  // string and never a live cross-realm object.
  let valueJson;
  try {
    context.__value = value;
    valueJson = vm.runInContext('JSON.stringify(globalThis.__tag(globalThis.__value, []))',
      context, { timeout });
  } catch (err) {
    return { ok: false, logs: readLogs(context),
      message: `custom code returned a value that could not leave the sandbox: ${(err && err.message) || err}` };
  }
  return { ok: true, logs: readLogs(context), valueJson };
}

function readLogs(context) {
  try {
    const json = vm.runInContext('JSON.stringify(globalThis.__logs || [])', context, { timeout: 1000 });
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.slice(0, 200).map(String) : [];
  } catch (_) {
    return [];
  }
}

// Only when this file IS the child, which the parent states with an argv flag.
// NOT `require.main === module`: customCodeHarden clears process.mainModule to
// take away the require() an escaped script would pivot through, and in CJS
// `require.main` IS process.mainModule — so that guard silently became false
// and the child never answered. Guarded at all so that importing this file
// (the tests do, to exercise `run` and `revive` directly) never installs a
// message listener on the parent.
if (process.argv.includes('--custom-code-child')) {
  process.once('message', (msg) => {
    let out;
    try {
      out = run(msg || {});
    } catch (err) {
      out = { ok: false, logs: [], message: (err && err.message) || String(err) };
    }
    // The send callback matters: exiting before the parent has the frame loses
    // the result and the step would read as a crash.
    process.send(out, () => process.exit(0));
  });
}

module.exports = { run, prelude, revive };
