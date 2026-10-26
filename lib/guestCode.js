'use strict';
// Code BODIES — trigger rules, email/phone ingest rules, email/phone log
// suppressions, hook filters and transforms — run here, in the QuickJS guest
// engine (lib/safeCodeRunner.js) inside the scrubbed, killable sandbox child
// (lib/customCodeRunner.js + lib/customCodeHarden.js). Never in this process.
//
// WHY. These bodies used to run in-process: triggers under node:vm, the other
// five sites through `new Function('input', code)`. Neither is a boundary. A
// `new Function` body is ordinary server code — `process.env` (the DB
// credentials) is a global it can simply read — and a vm body walks back to
// the host through the host object it was handed
// (`input.constructor.constructor('return process')()`). QuickJS is a
// different engine: the guest has no `process`, `require`, `fetch`, timers,
// filesystem or network, and only JSON crosses the wall. The child adds what
// the guest cannot give: a runaway body (an infinite loop, a catastrophic
// regex, an allocation bomb) is interrupted in the guest or killed with the
// child — it no longer parks this process's event loop, and `new Function`
// had no time limit at all.
//
// NO FALLBACK, FAIL CLOSED. A child that cannot start, dies, or answers with
// garbage is an ERROR at the call site, which maps it to that site's failure
// semantics (a match / filter / suppression that cannot run is a non-match; a
// transform that cannot run fails). Nothing here ever retries in vm or
// `new Function`; there is no path back.
//
// THE CONTRACT KEPT. A body is a function body, `input` in scope, using
// `return` — exactly what `new Function('input', code)` compiled. The guest
// source below wraps it in the same shape, so every existing body keeps its
// meaning. What differs is the engine, and that is visible only where V8 and
// QuickJS differ:
//   - no `Intl`: `Intl.*` throws, and locale `Date` methods
//     (toLocaleString & co.) do NOT throw — they ignore `timeZone` and return
//     a fixed format, silently wrong. A body needing firm-local dates computes
//     them itself (manual/03-YisraFlow/14-custom-code.md has the pattern);
//   - the inputs cross as JSON (every live input is JSON-born — trigger
//     envelopes are Date-normalised by lib/domainEvents.buildEnvelope, ingest
//     and hook inputs are parsed request bodies), and a mutation of `input`
//     no longer reaches the caller's object;
//   - engine error TEXT differs ("cannot read property 'x' of undefined" vs
//     V8's wording) — the error is still an error, mapped the same way;
//   - `console.log/warn/error/info/debug` exist and are collected; the parent
//     prints them, labelled, after the call (the guest cannot reach a stream).
// The value crosses with the same lossless tags workflow custom_code uses
// (Date / undefined / non-finite survive — customCodeRunner.revive), and a
// thrown value's `.message` crosses as the body's own value (a thrown string
// has message undefined, exactly as `err.message` read it before).
//
// COST. One fork per call (at most MAX_CHILDREN at once): ~40 ms on a dev laptop (measured 2026-10-26 —
// in-process QuickJS ~1 ms, the old vm ~0.2 ms). Live volume is a handful of
// calls per inbound event, so production pays it; the rule previews, which
// evaluate one body against up to a few hundred messages, use runBodies /
// batchRunner so the whole corpus is ONE child.

const { revive, customCodeChildOptions } = require('./customCodeRunner');

// Default time limit for the ingest / suppression / hook sites (triggers keep
// their own TRIGGER_CODE_TIMEOUT_MS). WALL clock, like every limit here: the
// same Cloud Run CPU-throttling exposure triggerService documents applies —
// hooks and ingest bodies are reached from detached trigger chains through
// `hook` actions — so it matches the trigger ceiling rather than a tight
// request budget. A good body runs in ~1 ms; a runaway no longer blocks the
// process while it waits, so a generous ceiling costs nothing.
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.GUEST_CODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15000;
})();

// Grace on top of the guest's own deadline before the parent kills the child —
// the backstop for anything the guest's interrupt handler cannot stop.
const KILL_GRACE_MS = 2000;

// Largest corpus one child evaluates (the native test-match clamps at 300).
const MAX_BATCH = 1000;

// At most this many sandbox children at once from this module; further calls
// queue (FIFO). Each child is a whole Node process — ~85 MB RSS measured
// 2026-10-26 — and the service runs 1 GiB at concurrency 80, so an unbounded
// burst of webhooks / ingests could take the instance down. The time limit
// starts when a call's child is forked, not while it queues.
const MAX_CHILDREN = (() => {
  const raw = Number(process.env.GUEST_CODE_MAX_CHILDREN);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
})();
let activeChildren = 0;
const childQueue = [];
function _acquireChild() {
  if (activeChildren < MAX_CHILDREN) { activeChildren += 1; return Promise.resolve(); }
  return new Promise((resolve) => childQueue.push(resolve));
}
function _releaseChild() {
  const next = childQueue.shift();
  if (next) next();            // hand the slot straight over
  else activeChildren -= 1;
}

// The guest source for one body. Built from inside, as the workflow prelude
// is: no host object exists in the guest, only the JSON the prelude parsed.
//   - console.warn / console.error are added (the safe prelude defines log
//     only; two live hook transforms call console.warn): their lines carry a
//     WARN_TAG the parent strips, so they still reach the server log as
//     warnings (stderr), as they did in-process. info / debug alias log;
//   - the body is compiled as a function body taking `input`, as
//     `new Function('input', code)` did, and called with the parsed input;
//   - a thrown value is caught IN the guest and reported as data, with its
//     `.message` as the body's own value. A timeout is uncatchable in QuickJS,
//     so this try/catch can never swallow one;
//   - `truthy` (match / filter / suppression) reduces the result to a boolean
//     in the guest, so nothing but true/false has to cross.
const WARN_TAG = '\u0001warn';
function guestSource(body, { truthy = false } = {}) {
  return `console.warn = console.error = function () {
  var a = [${JSON.stringify(WARN_TAG)}];
  for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
  return console.log.apply(console, a);
};
console.info = console.debug = console.log;
(function (__ycInput) {
  try {
    var __ycResult = (function (input) { ${String(body)}
})(__ycInput);
    return { ok: true, value: ${truthy ? '!!__ycResult' : '__ycResult'} };
  } catch (__ycErr) {
    return { ok: false, message: __ycErr == null ? 'threw ' + String(__ycErr) : __ycErr.message };
  }
})(globalThis.input)`;
}

function timeoutError(timeout, elapsed, detail) {
  const e = new Error(detail || `Script execution timed out after ${timeout}ms (elapsed ${elapsed}ms)`);
  e.code = 'GUEST_CODE_TIMEOUT';
  e.timedOut = true;
  e.elapsed = elapsed;
  return e;
}

// A thrown body value's `.message`, carried verbatim — may be undefined (a
// thrown string or number) exactly as `err.message` read it in-process. The
// Error constructor would coerce undefined to '', so it is assigned instead.
function thrownError(message) {
  const e = new Error('code threw');
  e.message = message;
  e.code = 'GUEST_CODE_THREW';
  return e;
}

// Fork the sandbox child, send one batch, resolve its reply. Rejects (never
// resolves a partial or guessed answer) when the child cannot start, exits
// without a reply, or outlives budget + grace. `onGone` runs exactly once,
// when the child PROCESS is gone (its 'exit', or a spawn that never made one)
// — not when the answer arrives — so the concurrency slot counts processes.
function _forkBatch(message, budget, onGone) {
  const { fork } = require('child_process');
  const runner = require.resolve('./customCodeRunner.js');
  let goneCalled = false;
  const gone = () => { if (!goneCalled) { goneCalled = true; onGone(); } };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = fork(runner, ['--custom-code-child'], customCodeChildOptions());
    } catch (err) {
      gone();
      reject(new Error(`code sandbox could not start: ${err.message}`));
      return;
    }
    child.once('exit', gone);
    // A spawn failure emits 'error' and, with no process, no 'exit'.
    child.once('error', () => { if (child.pid === undefined) gone(); });
    let settled = false;
    // Deterministic teardown on EVERY path (job_executor.runCustomCode has the
    // reason: a child left connected keeps the parent alive).
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(killAt);
      try { if (child.connected) child.disconnect(); } catch (_) { /* already gone */ }
      try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
      child.unref();
      fn();
    };
    const killAt = setTimeout(() => finish(() => reject(timeoutError(budget, budget + KILL_GRACE_MS,
      `Script execution timed out after ${budget}ms (the sandbox was killed after ${budget + KILL_GRACE_MS}ms)`))),
    budget + KILL_GRACE_MS);
    child.on('message', (out) => finish(() => resolve(out)));
    child.on('error', (err) => finish(() => reject(new Error(`code sandbox could not start: ${err.message}`))));
    child.on('exit', (codeNum, signal) => finish(() =>
      reject(new Error(`code sandbox exited without a result (code ${codeNum}, signal ${signal})`))));
    try {
      child.send(message);
    } catch (err) {
      finish(() => reject(new Error(`code sandbox could not be sent the body: ${err.message}`)));
    }
  });
}

// One guest result → { ok:true, value } | { ok:false, error }. Every shape
// not positively recognised is an error: a reply this cannot read must never
// become a value (an unknown object is truthy — a match that is always true).
function _settleItem(item, timeout) {
  if (!item || typeof item !== 'object') {
    return { ok: false, error: new Error('code sandbox returned no result for this input') };
  }
  if (item.ok !== true) {
    if (item.timedOut) {
      return { ok: false, error: timeoutError(timeout, item.elapsed,
        /not evaluated/.test(item.message || '') ? item.message : undefined) };
    }
    return { ok: false, error: new Error(String(item.message || 'code failed with no message')) };
  }
  if (typeof item.valueJson !== 'string') {
    return { ok: false, error: new Error('code sandbox returned a value that could not be read') };
  }
  let wrapped;
  try { wrapped = revive(JSON.parse(item.valueJson)); } catch (err) {
    return { ok: false, error: new Error(`code sandbox returned unreadable JSON: ${err.message}`) };
  }
  if (!wrapped || typeof wrapped !== 'object' || typeof wrapped.ok !== 'boolean') {
    // The body's text closed the wrapper and produced its own completion
    // value. Not a result this contract recognises.
    return { ok: false, error: new Error('code body escaped its function wrapper (unbalanced braces?)') };
  }
  if (!wrapped.ok) return { ok: false, error: thrownError(wrapped.message) };
  return { ok: true, value: wrapped.value };
}

/**
 * Run one body against many inputs in ONE sandbox child.
 * @param {string}  body   the function body (uses `return`, `input` in scope)
 * @param {Array}   inputs JSON-serialisable values
 * @param {{timeoutMs?:number, truthy?:boolean, label?:string}} [opts]
 * @returns {Promise<Array<{ok:true, value:any} | {ok:false, error:Error}>>}
 *   Never rejects: a sandbox-level failure is every input's error.
 */
async function runBodies(body, inputs, { timeoutMs, truthy = false, label = 'code' } = {}) {
  const list = Array.isArray(inputs) ? inputs : [];
  if (!list.length) return [];
  if (list.length > MAX_BATCH) {
    const err = new Error(`too many inputs for one code batch (${list.length} > ${MAX_BATCH})`);
    return list.map(() => ({ ok: false, error: err }));
  }
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS;

  const inputJsons = [];
  const preErrors = new Map();
  list.forEach((input, i) => {
    try {
      const json = JSON.stringify(input === undefined ? null : input);
      inputJsons.push(json === undefined ? 'null' : json);
    } catch (err) {
      preErrors.set(i, new Error(`code input could not be serialized: ${err.message}`));
      inputJsons.push('null');
    }
  });

  let out;
  await _acquireChild();
  try {
    out = await _forkBatch({ engine: 'quickjs', code: guestSource(body, { truthy }),
      batch: inputJsons, timeout, budget: timeout }, timeout, _releaseChild);
  } catch (err) {
    return list.map(() => ({ ok: false, error: err }));
  }
  if (!out || out.ok !== true || !Array.isArray(out.batch) || out.batch.length !== list.length) {
    const err = new Error(`code sandbox failed: ${(out && out.message) || 'malformed batch reply'}`);
    return list.map(() => ({ ok: false, error: err }));
  }
  return out.batch.map((item, i) => {
    for (const line of (item && item.logs) || []) {
      const text = String(line);
      if (text.startsWith(`${WARN_TAG} `)) console.warn(`[${label}] ${text.slice(WARN_TAG.length + 1)}`);
      else console.log(`[${label}] ${text}`);
    }
    if (preErrors.has(i)) return { ok: false, error: preErrors.get(i) };
    return _settleItem(item, timeout);
  });
}

/**
 * Run one body against one input. Resolves the body's return value (for
 * `truthy`, a boolean); REJECTS with the body's error, a timeout
 * (err.code 'GUEST_CODE_TIMEOUT') or a sandbox failure. Call sites catch and
 * map to their own failure semantics, and MUST await — an un-awaited promise
 * is truthy.
 */
async function runBody(body, input, opts = {}) {
  // Through module.exports, so runBodies is the ONE observable entry point
  // every execution passes (the gate suites count executions there).
  const [r] = await module.exports.runBodies(body, [input], opts);
  if (!r) throw new Error('code sandbox returned no result');
  if (!r.ok) throw r.error;
  return r.value;
}

/**
 * Pre-run `body` over `inputs` in one child and return a runBody-compatible
 * function that answers from those results — for previews that evaluate one
 * rule against a whole corpus through the PRODUCTION per-row function. A call
 * the batch did not cover (a different body or mode, an input object not in
 * the corpus) runs normally, so the answer is correct either way; only the
 * cost changes.
 */
async function batchRunner(body, inputs, opts = {}) {
  const list = Array.isArray(inputs) ? inputs : [];
  const results = await module.exports.runBodies(body, list, opts);
  const byInput = new Map();
  list.forEach((input, i) => { if (input && typeof input === 'object') byInput.set(input, results[i]); });
  const covered = `${!!opts.truthy}\u0000${String(body)}`;
  return async function runCode(b, input, o = {}) {
    if (`${!!o.truthy}\u0000${String(b)}` === covered && byInput.has(input)) {
      const r = byInput.get(input);
      if (!r.ok) throw r.error;
      return r.value;
    }
    return module.exports.runBody(b, input, o);
  };
}

module.exports = {
  runBody,
  runBodies,
  batchRunner,
  guestSource,
  DEFAULT_TIMEOUT_MS,
  KILL_GRACE_MS,
  MAX_BATCH,
  MAX_CHILDREN,
};
