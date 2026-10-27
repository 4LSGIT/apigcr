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
// COST. One fork per call (at most MAX_CHILDREN at once, split into LANES
// below): ~40 ms on a dev laptop (measured 2026-10-26 —
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

// At most this many sandbox children at once from this module. Each child is a
// whole Node process — ~85 MB RSS measured 2026-10-26 — and the service runs
// 1 GiB at concurrency 80, so an unbounded burst of webhooks / ingests could
// take the instance down. The total is unchanged by the lanes below (same
// memory budget); the time limit still starts when a call's child is forked,
// not while it waits for a slot.
const MAX_CHILDREN = (() => {
  const raw = Number(process.env.GUEST_CODE_MAX_CHILDREN);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
})();

// LANES (review 2026-10-27). Every site shares the MAX_CHILDREN pool, so one
// kind of caller could starve the rest: a webhook burst on hooks whose filter
// AND transform are code (rc-message-out / rc-call — two forks per event) plus
// one slow body held every slot, and every trigger, ingest rule and
// suppression on the instance queued behind it with no bound. Each call now
// names its lane:
//   events  — trigger match/transform, email/phone ingest rule match/transform,
//             email/phone log suppressions: the internal event pipeline;
//   hooks   — live hook filters and hook/target transforms (incl. replays):
//             webhook-driven, request-bound;
//   preview — editor tests, dry runs, rule previews (batchRunner), Casey's
//             rule reads. The DEFAULT: a call that names no lane lands here,
//             so a forgotten site can never starve a production lane.
// A lane may take a free slot only if the slots left after it still cover
// every OTHER lane's unmet reservation. With the default 4: events is
// guaranteed 2 (up to 3 when the rest idle), hooks 1 (up to 2), preview none
// (at most 1) — no mix of hooks and previews can take the events floor, and
// no events burst can take the last hook slot. When a slot frees, waiting
// lanes are served in the order events → hooks → preview, FIFO within a lane.
const LANES = Object.freeze({ events: 'events', hooks: 'hooks', preview: 'preview' });
const LANE_ORDER = Object.freeze(['events', 'hooks', 'preview']);
const RESERVED = Object.freeze({
  events: Math.floor(MAX_CHILDREN / 2),
  hooks: MAX_CHILDREN >= 3 ? 1 : 0,
  preview: 0,
});

function _envPositiveInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

// QUEUE-WAIT BUDGET per lane: a waiter that gets no slot within it FAILS
// CLOSED (err.code 'GUEST_CODE_BUSY' — every site already maps an error to its
// failure semantics) instead of waiting behind a stuck slot forever. A healthy
// body holds a slot ~40 ms (one fork), so a queue only grows while slots are
// held by slow bodies (up to the 15 s limit + 2 s kill grace each); waiting
// out a full 17 s stall is the failure being bounded.
//   hooks 1 s   — request-bound: filter and transform run one after the
//                 other before the response (live peak 4 events/s, 11/min
//                 over 14 days), and RingCentral counts an answer slower than
//                 3 s as a failed delivery — ~10 min of failures blacklist
//                 the subscription. The busiest live hooks (22, 23) run a
//                 code filter AND a code transform, so the worst saturated
//                 answer is 2 waits + 2 forks + the fast targets (one
//                 workflow start, ~100–300 ms with its Cloud Tasks enqueue):
//                 2×1000 + 2×~100 + ~300 ≈ 2.5 s, inside 3 s (was 2×3 s —
//                 6 s before any fork). The budget is PER CALL, not per
//                 event. A body that RUNS slowly (up to the 15 s limit) still
//                 blows RC's window — a queue budget cannot help that.
//                 Each hook_executions row keeps raw_input, so a hook that
//                 failed closed here can be replayed.
//   events 10 s — mostly detached chains with no request waiting, but every
//                 second queued is a second the chain can die with the
//                 instance; ingest posts are request-bound (Apps Script's
//                 fetch allows 60 s). Long enough to ride out a burst, well
//                 short of a stall.
//   preview 5 s — a person is watching a spinner.
const QUEUE_WAIT_MS = Object.freeze({
  events: _envPositiveInt('GUEST_CODE_QUEUE_WAIT_MS_EVENTS', 10000),
  hooks: _envPositiveInt('GUEST_CODE_QUEUE_WAIT_MS_HOOKS', 1000),
  preview: _envPositiveInt('GUEST_CODE_QUEUE_WAIT_MS_PREVIEW', 5000),
});
// QUEUE LENGTH per lane: beyond it a call fails closed AT ONCE. Sized to
// roughly what the lane could drain inside its wait budget at a healthy
// ~100 ms per fork on Cloud Run's 1 vCPU — a waiter further back would almost
// surely time out anyway, so it is refused before it holds its input (up to
// the 512 KB hook raw-input cap) in memory for nothing. hooks: 2 slots ×
// 1000 ms / ~100 ms = 20.
const MAX_QUEUE = Object.freeze({
  events: _envPositiveInt('GUEST_CODE_MAX_QUEUE_EVENTS', 100),
  hooks: _envPositiveInt('GUEST_CODE_MAX_QUEUE_HOOKS', 20),
  preview: _envPositiveInt('GUEST_CODE_MAX_QUEUE_PREVIEW', 10),
});

const active = { events: 0, hooks: 0, preview: 0 };
const queues = { events: [], hooks: [], preview: [] };
let activeTotal = 0;

function _canGrant(lane) {
  if (activeTotal >= MAX_CHILDREN) return false;
  let heldForOthers = 0;
  for (const other of LANE_ORDER) {
    if (other !== lane) heldForOthers += Math.max(0, RESERVED[other] - active[other]);
  }
  return MAX_CHILDREN - activeTotal > heldForOthers;
}

function _grant(lane) { active[lane] += 1; activeTotal += 1; }

// Hand freed capacity to waiters, highest-priority lane first, re-checking
// from the top after every grant (a grant changes what the others may take).
function _pump() {
  for (let granted = true; granted;) {
    granted = false;
    for (const lane of LANE_ORDER) {
      if (queues[lane].length && _canGrant(lane)) {
        const waiter = queues[lane].shift();
        clearTimeout(waiter.timer);
        _grant(lane);
        waiter.resolve();
        granted = true;
        break;
      }
    }
  }
}

function busyError(lane, reason) {
  const e = new Error(reason === 'queue_full'
    ? `code sandbox busy: the ${lane} lane queue is full (${MAX_QUEUE[lane]} waiting) — failed closed, the body did not run`
    : `code sandbox busy: no ${lane} slot within ${QUEUE_WAIT_MS[lane]}ms — failed closed, the body did not run`);
  e.code = 'GUEST_CODE_BUSY';
  e.lane = lane;
  e.reason = reason;
  return e;
}

// SATURATION ALERTS (CLAUDE.md alert severity convention). Saturation is
// transient by nature — a burst, or a slow body that the time limit will end
// — so the first episode for a lane records a WARNING (system_alerts, rides
// the digest, never emails on its own). A lane that saturates again within
// REPEAT_WINDOW_MS of its last alert is no longer a blip: ERROR, which emails
// IT. Alerts are folded to at most one per lane per ALERT_MIN_GAP_MS (the
// count rides the next alert), so a burst of rejections is one row, not a
// hundred. preview never escalates past warning: an editor's test failing is
// visible to the person who ran it, and nothing in production depends on it.
// Every rejection is still logged. The db is injected at boot
// (startup/init.js → setAlertDb); without it (tests, scripts) only the log
// line is written — this module never opens a pool of its own.
const ALERT_MIN_GAP_MS = 60 * 1000;
const REPEAT_WINDOW_MS = 30 * 60 * 1000;
let alertDb = null;
const saturation = { events: { lastAlertAt: 0, folded: 0 }, hooks: { lastAlertAt: 0, folded: 0 }, preview: { lastAlertAt: 0, folded: 0 } };
const LANE_FAILURE = {
  events: 'trigger / ingest-rule / suppression code evaluated as a non-match or a failed transform (no actions fired)',
  hooks: 'a hook filter or hook transform failed its execution (status failed, no target ran — a Quo sender was answered 503 and redelivers; others were answered 200) and a target transform failed that target (one retry about 60 s later) — each event is replayable from hook_executions',
  preview: 'editor tests and previews returned an error',
};

function setAlertDb(db) { alertDb = db || null; }

function _saturated(lane, reason) {
  const s = saturation[lane];
  s.folded += 1;
  console.warn(`[guestCode] ${lane} lane saturated (${reason}): ${active[lane]} running in the lane, ` +
    `${activeTotal}/${MAX_CHILDREN} children, ${queues[lane].length} queued — failed closed`);
  const now = Date.now();
  if (s.lastAlertAt && now - s.lastAlertAt < ALERT_MIN_GAP_MS) return;
  const repeated = !!s.lastAlertAt && now - s.lastAlertAt < REPEAT_WINDOW_MS;
  const severity = repeated && lane !== 'preview' ? 'error' : 'warning';
  const count = s.folded;
  s.folded = 0;
  s.lastAlertAt = now;
  if (!alertDb) return;
  try {
    const { alert } = require('./alerting'); // deferred require (circular-dep safety convention)
    Promise.resolve(alert(alertDb, {
      source: 'app', kind: 'guest_code_saturated', severity,
      group_key: `guest_code_saturated:${lane}`,
      title: `Code sandbox ${lane} lane saturated${repeated ? ' again' : ''}`,
      message: `${count} code call(s) in the ${lane} lane could not get a sandbox slot (${reason === 'queue_full' ? 'queue full' : 'queue wait budget spent'}) and failed closed: ` +
        `${LANE_FAILURE[lane]}. Usually a burst or a slow body holding slots; repeated saturation means the lane is undersized or a body needs fixing.`,
      context: { lane, reason, count, lane_active: active[lane], active: activeTotal, max_children: MAX_CHILDREN,
        queued: queues[lane].length, queue_wait_ms: QUEUE_WAIT_MS[lane], max_queue: MAX_QUEUE[lane] },
    })).catch(() => {});
  } catch (_) { /* alerting unavailable — already logged */ }
}

function _acquireChild(lane) {
  if (!queues[lane].length && _canGrant(lane)) { _grant(lane); return Promise.resolve(); }
  if (queues[lane].length >= MAX_QUEUE[lane]) {
    _saturated(lane, 'queue_full');
    return Promise.reject(busyError(lane, 'queue_full'));
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const i = queues[lane].indexOf(waiter);
      if (i < 0) return;           // already granted
      queues[lane].splice(i, 1);
      _saturated(lane, 'wait_timeout');
      reject(busyError(lane, 'wait_timeout'));
    }, QUEUE_WAIT_MS[lane]);
    queues[lane].push(waiter);
  });
}

function _releaseChild(lane) {
  active[lane] -= 1;
  activeTotal -= 1;
  _pump();
}

/** Pool accounting snapshot (tests and diagnostics). */
function _poolState() {
  return { active: { ...active }, queued: Object.fromEntries(LANE_ORDER.map((l) => [l, queues[l].length])), total: activeTotal };
}
function _resetSaturationForTests() {
  for (const lane of LANE_ORDER) { saturation[lane].lastAlertAt = 0; saturation[lane].folded = 0; }
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
 * @param {{timeoutMs?:number, truthy?:boolean, label?:string, lane?:'events'|'hooks'|'preview'}} [opts]
 *   `lane` (default 'preview') picks the slot pool — see LANES above.
 * @returns {Promise<Array<{ok:true, value:any} | {ok:false, error:Error}>>}
 *   Never rejects: a sandbox-level failure — including no slot in time
 *   (err.code 'GUEST_CODE_BUSY') — is every input's error.
 */
async function runBodies(body, inputs, { timeoutMs, truthy = false, label = 'code', lane = LANES.preview } = {}) {
  const list = Array.isArray(inputs) ? inputs : [];
  if (!list.length) return [];
  if (!LANE_ORDER.includes(lane)) {
    // A typo'd lane is a programming error: fail closed, never guess a lane.
    const err = new Error(`unknown code lane "${lane}"`);
    return list.map(() => ({ ok: false, error: err }));
  }
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
  try {
    await _acquireChild(lane);
  } catch (err) {
    return list.map(() => ({ ok: false, error: err }));
  }
  try {
    out = await _forkBatch({ engine: 'quickjs', code: guestSource(body, { truthy }),
      batch: inputJsons, timeout, budget: timeout }, timeout, () => _releaseChild(lane));
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
 * (err.code 'GUEST_CODE_TIMEOUT'), no slot in time (err.code
 * 'GUEST_CODE_BUSY') or a sandbox failure. Call sites catch and
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
  // A preview's lane (default preview) binds the batch AND every uncovered
  // call: the per-row production function passes its own lane (events), which
  // must not let a preview reach a production lane.
  const lane = opts.lane || LANES.preview;
  const results = await module.exports.runBodies(body, list, { ...opts, lane });
  const byInput = new Map();
  list.forEach((input, i) => { if (input && typeof input === 'object') byInput.set(input, results[i]); });
  const covered = `${!!opts.truthy}\u0000${String(body)}`;
  return async function runCode(b, input, o = {}) {
    if (`${!!o.truthy}\u0000${String(b)}` === covered && byInput.has(input)) {
      const r = byInput.get(input);
      if (!r.ok) throw r.error;
      return r.value;
    }
    return module.exports.runBody(b, input, { ...o, lane });
  };
}

/**
 * A runBody-compatible function pinned to `lane` — the seam a preview hands
 * the production per-row functions (their `runCode` option), so the preview
 * runs in its own lane whatever lane the production function would name.
 */
function laneRunner(lane) {
  return function runCode(b, input, o = {}) {
    return module.exports.runBody(b, input, { ...o, lane });
  };
}

module.exports = {
  runBody,
  runBodies,
  batchRunner,
  laneRunner,
  guestSource,
  setAlertDb,
  LANES,
  RESERVED,
  QUEUE_WAIT_MS,
  MAX_QUEUE,
  DEFAULT_TIMEOUT_MS,
  KILL_GRACE_MS,
  MAX_BATCH,
  MAX_CHILDREN,
  _poolState,
  _resetSaturationForTests,
};
