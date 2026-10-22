'use strict';
// Preloaded (--require) into the custom_code child before its runner starts.
// Everything here is defence in depth, not a boundary: it raises the cost of
// an escape from `vm`, which is not a security boundary on its own.
//
// What an escaped script reaches for, in order of usefulness, and what this
// takes away:
//   1. `process.mainModule.require` — the standard route from a walked-back
//      `process` to arbitrary modules. mainModule is cleared.
//   2. outbound network — on Cloud Run the instance metadata server
//      (169.254.169.254) hands out a service-account access token, which is
//      plausibly worth more than the DB password that `env: {}` already
//      removed. Socket creation is refused.
//   3. the environment — already empty, done by the parent's `env: {}`.
//
// A determined escape can still reach native bindings this does not cover —
// and one bypass is DEMONSTRATED, not theoretical: under this exact preload, a
// probe still obtained `process.getBuiltinModule('child_process').execFile`
// and `process.getBuiltinModule('fs').readFileSync` (Node 22+ API, 2026-10-22
// investigation in local/casey-code-investigation/report.txt). The
// `Module._load` denial below only covers `require`. Do NOT read this file as
// a boundary; it is cost, not containment.
// The honest fix for that is an isolate with no reachable host realm
// (isolated-vm) or egress restriction on the child; this file is what is
// available without a native dependency. A code step has never needed any of
// it: the sandbox has only ever held `{ input, console }`, and all 97 live
// steps are pure transforms (verified 2026-10-22).

// INERT ON IMPORT. Everything below runs ONLY when this file is preloading
// the sandbox child, which the parent marks with `--custom-code-child` in
// argv. It patches process-global state (the module loader, net, dns), so a
// plain `require` of it anywhere else — a suite that loads every file under
// lib/, a doc tool, a linter — would patch THAT process instead. Measured
// before this guard existed: dropping this file into a clean, green tree
// turned 6 suites and 231 tests red, every one of them a route suite that
// opens a socket, with empty error bodies that read as a broken commit.
if (process.argv.includes('--custom-code-child')) {

// 1. No module graph to require through.
//
// Deferred, and that is load-bearing: a --require preload runs BEFORE Node
// loads the main module, and Node SETS process.mainModule when it does. So
// clearing it here synchronously is undone a moment later — which is how the
// first version of this file shipped ineffective, caught by its own test.
// setImmediate lands after the main module is in place and long before any
// step code runs, which only ever happens on an IPC message.
setImmediate(() => { process.mainModule = undefined; });

// 2. No outbound sockets. net is the floor every higher-level client
// (http/https/dns-over-tcp, and any vendor SDK) builds on, so refusing
// connect here refuses all of them without patching each.
const refuse = (what) => {
  const e = new Error(`custom code may not open a ${what} connection`);
  e.code = 'CUSTOM_CODE_NO_NETWORK';
  return e;
};

try {
  const net = require('net');
  net.Socket.prototype.connect = function () { throw refuse('network'); };
  // Redundant today — net.connect builds a Socket and calls the prototype
  // method above, so removing this line alone changes nothing and the pair is
  // only provable jointly. Kept as insurance against Node's internals
  // changing, not as a second gate.
  net.connect = net.createConnection = function () { throw refuse('network'); };
} catch (_) { /* nothing to patch means nothing to reach */ }

try {
  const tls = require('tls');
  tls.connect = function () { throw refuse('TLS'); };
} catch (_) { /* as above */ }

try {
  const dgram = require('dgram');
  dgram.createSocket = function () { throw refuse('UDP'); };
} catch (_) { /* as above */ }

try {
  const dns = require('dns');
  const die = () => { throw refuse('DNS'); };
  dns.lookup = dns.resolve = dns.resolve4 = dns.resolve6 = die;
  if (dns.promises) { dns.promises.lookup = die; dns.promises.resolve = die; }
} catch (_) { /* as above */ }

// 3. The loader itself, for the common `require('child_process')` pivot.
try {
  const Module = require('module');
  const load = Module._load;
  const DENY = new Set(['child_process', 'worker_threads', 'cluster', 'inspector', 'v8', 'repl']);
  Module._load = function (request, parent, isMain) {
    if (DENY.has(request) || DENY.has(String(request).replace(/^node:/, ''))) {
      throw refuse(`module (${request})`);
    }
    return load.apply(this, arguments);
  };
} catch (_) { /* as above */ }

} // end: only when preloading the sandbox child
