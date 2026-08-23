/* public/js/yc-sync.js — the YisraCase sync bus (Slice 1)
 *
 * Cross-frame + cross-browser-tab data consistency. One announcement channel:
 * a writer says "case AAAA's case_stage is now Filed", and every frame in
 * every tab that cares updates itself. No hub, no fanout, no hop counter —
 * BroadcastChannel is same-origin broadcast by construction and reaches every
 * frame at any depth AND every other browser tab of this app.
 *
 * Design: ref/YISRACASE_STORE_AND_BUS_DESIGN_V2.md
 *
 * ── THE ONE RULE (design §3.6) ──────────────────────────────────────────────
 *
 *   A HANDLER TRIGGERED BY A BUS MESSAGE MUST NEVER EMIT.
 *
 * This is load-bearing, and it is the only thing standing between this file
 * and an infinite loop. It holds today because every write path is a USER
 * gesture and every bus handler is a programmatic paint:
 *
 *   · bindValue sets `.value` in script → no `change` event fires → no PATCH
 *     → no response → no sniff → no emit.
 *   · YCForm.refresh() populates; it never saves.
 *   · checklistView's subscriber writes cl.body and repaints; it never calls
 *     saveBody().
 *
 * If you add a subscriber, it may read, merge, and paint. It may NOT call an
 * API writer, dispatch a synthetic `change`, or call YC.emit. Keep it that
 * way.
 *
 * ── What rides the bus ───────────────────────────────────────────────────────
 *
 * VALUES, not invalidations (§3.1): `{field: newValue}`. A subscriber never
 * has to re-fetch to find out what changed. Emits are idempotent — the same
 * message delivered twice is a no-op, which is why duplicate coverage (a
 * writer that both auto-sniffs and emits explicitly) is free.
 *
 * SCALARS only. Aggregate arrays (a contact's phones/emails/addresses) do NOT
 * ride the bus; they refresh through the existing `form-saved` path.
 *
 * ── Addresses ───────────────────────────────────────────────────────────────
 *
 *   'case:AAAAAAAA'  'contact:1001'  'appt:55'  'event:12'
 *
 * Subscribe to a specific entity, or to `'case:*'` for every case (the Cases
 * tab's "something, somewhere, changed" subscription). The wildcard is a
 * PREFIX match on the type, so 'case:*' never matches 'contact:1'.
 */
(function () {
  'use strict';

  // Idempotent on double-load: two <script> tags, or a page that loads this
  // and is then re-entered, must not blow away live subscriptions.
  if (window.YC) return;

  var CHANNEL = 'yc-sync';
  var LOG_MAX = 50;

  /* addr -> field -> [handlers]. '*' is a legitimate key in the field map;
     'case:*' is a legitimate key in the addr map. Both are resolved at
     dispatch time, never at subscribe time. */
  var subs = Object.create(null);

  var bc = null;
  var warnedNoBc = false;

  /**
   * Normalize a changes object to `{field: newValue}`.
   *
   * Two input shapes are accepted, deliberately:
   *   · the API diff shape `{field: {from, to}}` — what caseService and
   *     contactService put in `data.changes`
   *   · a plain `{field: value}` — what an explicit emit sends, and what the
   *     new advance/docket `changes` keys carry
   *
   * A `{from, to}` object is recognised by having a `to` key, not by having
   * exactly two keys: `{from, to}` is the shape those services build, and a
   * legitimate scalar column value is never an object.
   */
  function normalize(changes) {
    var out = {};
    if (!changes || typeof changes !== 'object') return out;
    for (var k in changes) {
      if (!Object.prototype.hasOwnProperty.call(changes, k)) continue;
      var v = changes[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          Object.prototype.hasOwnProperty.call(v, 'to')) {
        out[k] = v.to;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** 'case:AAAA' -> 'case'. Everything before the FIRST colon. */
  function typeOf(addr) {
    var s = String(addr || '');
    var i = s.indexOf(':');
    return i === -1 ? s : s.slice(0, i);
  }

  /* Which subscription keys a concrete address should be delivered to: the
     address itself, and its type wildcard. */
  function addrKeysFor(addr) {
    return [String(addr), typeOf(addr) + ':*'];
  }

  function dispatch(msg) {
    if (!msg || !msg.addr || !msg.fields) return;

    // Ring buffer — the traceability answer. `origin` says who wrote it.
    YC._log.push(msg);
    if (YC._log.length > LOG_MAX) YC._log.shift();

    var keys = addrKeysFor(msg.addr);
    for (var i = 0; i < keys.length; i++) {
      var byField = subs[keys[i]];
      if (!byField) continue;

      // A '*' subscriber gets the whole fields object once; a field
      // subscriber gets it only if its field is present.
      var buckets = [];
      if (byField['*']) buckets.push(byField['*']);
      for (var f in msg.fields) {
        if (!Object.prototype.hasOwnProperty.call(msg.fields, f)) continue;
        if (byField[f]) buckets.push(byField[f]);
      }

      for (var b = 0; b < buckets.length; b++) {
        // Copy: a handler that unsubscribes itself must not shift the array
        // out from under this loop.
        var list = buckets[b].slice();
        for (var h = 0; h < list.length; h++) {
          try {
            list[h](msg.fields, msg);
          } catch (err) {
            // One bad subscriber must never cost the others their message.
            console.warn('[yc-sync] handler failed for ' + msg.addr + ':', err);
          }
        }
      }
    }
  }

  function openChannel() {
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = function (e) {
        // BC skips the sender's own context, so anything arriving here is
        // from another frame or another browser tab.
        try { dispatch(e && e.data); } catch (err) {
          console.warn('[yc-sync] dispatch failed:', err);
        }
      };
    } catch (err) {
      bc = null;
      if (!warnedNoBc) {
        warnedNoBc = true;
        console.warn('[yc-sync] BroadcastChannel unavailable — ' +
                     'this frame will only see its own emits.', err);
      }
    }
  }

  var YC = {
    _log: [],

    /**
     * Announce a change.
     *
     * @param {string} addr    'case:AAAA' | 'contact:1001' | 'appt:5' | 'event:9'
     * @param {object} changes {field:{from,to}} or {field: value}
     * @param {string} origin  trace string, e.g. 'checklistView:saveBody'
     */
    emit: function (addr, changes, origin) {
      if (!addr) return;
      var fields = normalize(changes);
      // Nothing changed → nothing to say. This is the guard that keeps a
      // no-op PATCH (same value written twice) off the bus entirely.
      if (!Object.keys(fields).length) return;

      var msg = {
        addr:   String(addr),
        fields: fields,
        origin: origin || null,
        ts:     Date.now(),
      };

      // Local first, then the wire. Local dispatch is what keeps the WRITING
      // frame's own state current (BC deliberately skips the sender).
      dispatch(msg);
      if (bc) {
        try { bc.postMessage(msg); }
        catch (err) { console.warn('[yc-sync] postMessage failed:', err); }
      }
    },

    /**
     * Subscribe.
     *
     * @param {string}   addr   'case:AAAA', or 'case:*' for every case
     * @param {string}   field  a column name, or '*' for any
     * @param {function} fn     (fields, msg) => void — MUST NOT EMIT (§3.6)
     * @returns {function} unsubscribe
     */
    on: function (addr, field, fn) {
      if (typeof fn !== 'function') return function () {};
      var a = String(addr);
      var f = String(field || '*');
      var byField = subs[a] || (subs[a] = Object.create(null));
      var list = byField[f] || (byField[f] = []);
      list.push(fn);

      var done = false;
      return function unsubscribe() {
        if (done) return;
        done = true;
        var i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      };
    },

    /**
     * Bind one field to one input element.
     *
     * THE DIRTY GUARD is the whole point: a bus message must never eat what
     * the user is in the middle of typing. Two fences —
     *   · the element is focused (they are in it right now)
     *   · data-yc-dirty="1" (they typed and have not saved; binding sites set
     *     this on input and clear it on a successful save)
     *
     * Sets `.value` programmatically, which fires no `change` event — that is
     * what makes this safe under §3.6.
     *
     * NOT for YCForm-managed fields: those refresh through YCForm.refresh(),
     * which carries its own dirty and typing fences.
     */
    bindValue: function (addr, field, el) {
      if (!el) return function () {};
      return YC.on(addr, field, function (fields) {
        if (!Object.prototype.hasOwnProperty.call(fields, field)) return;
        if (el === document.activeElement) return;
        if (el.dataset && el.dataset.ycDirty === '1') return;
        var v = fields[field];
        el.value = v == null ? '' : v;
      });
    },

    /**
     * Shell-only hook, called from index.html's apiSend at the success-return
     * point. Turns "an API call just succeeded" into an emit, with no work at
     * the writer.
     *
     * This is why the forget-to-emit bug class does not exist: every frame's
     * API traffic funnels through the shell's single apiSend (iframes alias
     * it, deep frames call window.top.apiSend), so ONE hook covers every
     * current and future writer of these four endpoints.
     *
     * @param {string} method    'PATCH' | 'POST' | …
     * @param {string} endpoint  the path as passed to apiSend
     * @param {*}      body      the parsed response body
     */
    _sniff: function (method, endpoint, body) {
      var m = String(method || '').toUpperCase();
      if (m !== 'PATCH' && m !== 'POST') return;

      // STRIP THE QUERY STRING before matching. The 409 cross-contact
      // transfer retries as `PATCH /api/contacts/:id?force=true`
      // (contact-form.html:696, :1399) — the save most likely to have just
      // moved data between two contacts is exactly the one a bare regex
      // would miss.
      var path = String(endpoint || '').split('?')[0];

      for (var i = 0; i < MATCHERS.length; i++) {
        var hit = MATCHERS[i][0].exec(path);
        if (!hit) continue;                       // first match wins, and ends the scan
        var type = MATCHERS[i][1];
        var changes = null;
        try { changes = MATCHERS[i][2](body); } catch (_) { changes = null; }
        if (!changes || typeof changes !== 'object') return;
        if (!Object.keys(changes).length) return;
        YC.emit(type + ':' + hit[1], changes,
                'auto:' + m + ' ' + endpoint);
        return;
      }
    },
  };

  /* Endpoint -> (type, where the diff lives in the response).
     Order matters only in that the bare `/api/cases/:id` pattern is anchored
     ($), so it cannot swallow /docket or /pipeline/advance. */
  var MATCHERS = [
    [/^\/api\/cases\/([A-Za-z0-9_-]+)$/,                    'case',    function (r) { return r && r.data && r.data.changes; }],
    [/^\/api\/contacts\/(\d+)$/,                            'contact', function (r) { return r && r.data && r.data.changes; }],
    [/^\/api\/cases\/([A-Za-z0-9_-]+)\/docket$/,            'case',    function (r) { return r && r.changes; }],
    [/^\/api\/cases\/([A-Za-z0-9_-]+)\/pipeline\/advance$/, 'case',    function (r) { return r && r.changes; }],
  ];

  openChannel();
  window.YC = YC;
})();
