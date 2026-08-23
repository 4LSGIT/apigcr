/**
 * tests/helpers/bcPolyfill.js
 *
 * A shared-registry BroadcastChannel for jsdom. jsdom 26 does not implement
 * BroadcastChannel, and public/js/yc-sync.js's entire transport is one.
 *
 * ── WHY PER-WINDOW INJECTION, NOT A NODE GLOBAL ─────────────────────────────
 *
 * The harness is `testEnvironment: 'node'` with a hand-rolled `new JSDOM(...)`
 * per test (the tests/tasksUi.boot.test.js idiom), and Node 22+ ships a real
 * process-global BroadcastChannel. So there are two realms in play, and
 * yc-sync's `new BroadcastChannel(...)` resolves against whichever global the
 * script was evaluated in — the jsdom window.
 *
 * Put the polyfill on the Node global and one of two things happens: the
 * feature detect finds Node's REAL BroadcastChannel (a live libuv handle that
 * keeps jest from exiting unless closed), or the polyfill and the code under
 * test end up looking at different constructors. Either way the cross-window
 * test is measuring the wrong thing.
 *
 * So: `install(window)` per window, and every window sharing one registry is
 * what makes cross-window delivery work at all.
 *
 * Delivery is via queueMicrotask to the OTHER instances only — real
 * BroadcastChannel never delivers a message back to the context that sent it,
 * and yc-sync depends on that (it dispatches locally itself, and would
 * double-dispatch if the channel echoed).
 */

'use strict';

/** name -> Set of live channel instances, across every window. */
const registry = new Map();

/**
 * Install the polyfill onto a jsdom window.
 *
 * @param {object} window a jsdom window
 * @returns {function} teardown — closes every channel this window opened
 */
function install(window) {
  const opened = [];

  class BroadcastChannelPolyfill {
    constructor(name) {
      this.name = String(name);
      this.onmessage = null;
      this._closed = false;
      if (!registry.has(this.name)) registry.set(this.name, new Set());
      registry.get(this.name).add(this);
      opened.push(this);
    }

    postMessage(data) {
      if (this._closed) throw new Error('BroadcastChannel is closed');
      const peers = registry.get(this.name);
      if (!peers) return;
      // Structured-clone-ish: a real BC copies, so a test that mutates the
      // sent object afterwards must not change what the receiver sees.
      const payload = JSON.parse(JSON.stringify(data));
      for (const peer of peers) {
        if (peer === this) continue;            // never echo to the sender
        if (peer._closed) continue;
        queueMicrotask(() => {
          if (peer._closed || typeof peer.onmessage !== 'function') return;
          peer.onmessage({ data: payload });
        });
      }
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      const peers = registry.get(this.name);
      if (peers) {
        peers.delete(this);
        if (!peers.size) registry.delete(this.name);
      }
    }
  }

  window.BroadcastChannel = BroadcastChannelPolyfill;

  return function teardown() {
    for (const ch of opened) {
      try { ch.close(); } catch (_) { /* noop */ }
    }
    opened.length = 0;
  };
}

/** Drop every registered channel — belt-and-braces for afterEach. */
function reset() {
  for (const peers of registry.values()) {
    for (const ch of peers) { try { ch.close(); } catch (_) { /* noop */ } }
  }
  registry.clear();
}

module.exports = { install, reset };
