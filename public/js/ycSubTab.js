/* public/js/ycSubTab.js — the workspace URL's sub-state token (wsurl S1).
 *
 * The shell's address bar (?files= / ?open=, see the WORKSPACE URL block in
 * index.html) names the open files and the active view. A "rest" says WHERE
 * inside that view: each frame layer owns one segment and hands the remainder
 * to its child, e.g. files=cABCD2345~documents (case file → Documents tab).
 *
 * A rest is segments joined by '~':
 *   · a segment is [A-Za-z0-9_-]{1,32} — vocabulary tokens and surrogate DB
 *     ids ONLY, never names, search text, phones or emails: the shell's URL
 *     rides the Referer header into jwt_api_audit_log, redacted by key only;
 *   · at most 4 meaningful segments and 128 characters in all;
 *   · an EMPTY segment means "this layer's default" and drops everything after
 *     it (a~~b → a); trailing empties are stripped;
 *   · any non-empty segment outside the charset, or a rest over a cap, makes
 *     the whole rest invalid. The caller then drops the rest at its layer and
 *     keeps the file / tab itself.
 *
 * window.ycSubTab.parse(rest) / valid(rest) / normalize(rest), and two roles:
 *
 * ycSubTab.host — a page that hosts frames (the shell; case/contact from S1b).
 * Caches are keyed by the frame ELEMENT (WeakMap, so a closed file's frame
 * frees its entries):
 *   hold(frame, rest)    a pending rest for a COLD child, until it boots
 *   take(frame)          that pending rest, ONCE (then cleared); null if none
 *   noteReport(frame, r) the child said where it is now
 *   lastRest(frame)      the child's last report — and a rest handed down by
 *                        hold() counts as its report until it reports itself
 *
 * ycSubTab.leaf — a page inside a host's frame (S1b's case/contact, later
 * panes):
 *   report(rest)  → parent.ycReportSubTab(frameElement, rest)
 *   take()        → parent.ycTakeSubTab(frameElement)
 * Both are no-ops on a page that isn't framed (parent === window) or whose
 * host has no hook (an older host build, a cross-origin parent).
 *
 * Plain script: no dependencies, no DOM access at load.
 */
(function () {
  'use strict';

  var SEG = /^[A-Za-z0-9_-]{1,32}$/;
  var MAX_DEPTH = 4;
  var MAX_LEN = 128;

  /** The rest's segments ([] = default), or null when the rest is invalid. */
  function parse(rest) {
    if (rest == null || rest === '') return [];
    if (typeof rest !== 'string' || rest.length > MAX_LEN) return null;
    var parts = rest.split('~');
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    var out = [], ended = false;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') { ended = true; continue; }
      if (!SEG.test(parts[i])) return null;
      if (!ended) out.push(parts[i]);
    }
    return out.length > MAX_DEPTH ? null : out;
  }

  function valid(rest) { return parse(rest) !== null; }

  /** The canonical form of a valid rest ('' = default), or null if invalid. */
  function normalize(rest) {
    var p = parse(rest);
    return p === null ? null : p.join('~');
  }

  // ── host ──────────────────────────────────────────────────────────────────
  var held = new WeakMap();
  var last = new WeakMap();

  function isKey(frame) { return frame !== null && typeof frame === 'object'; }

  function hold(frame, rest) {
    if (!isKey(frame)) return;
    var r = normalize(rest);
    if (r === null || r === '') { held.delete(frame); return; }
    held.set(frame, r);
    last.set(frame, r);           // handed down = the child's report, for now
  }

  function take(frame) {
    if (!isKey(frame) || !held.has(frame)) return null;
    var r = held.get(frame);
    held.delete(frame);
    return r;
  }

  function noteReport(frame, rest) {
    if (!isKey(frame)) return;
    var r = normalize(rest);
    if (r !== null) last.set(frame, r);
  }

  function lastRest(frame) {
    return isKey(frame) && last.has(frame) ? last.get(frame) : null;
  }

  // ── leaf ──────────────────────────────────────────────────────────────────
  function hostOf() {
    try {
      if (window.parent === window || !window.frameElement) return null;
      return window.parent;
    } catch (_) { return null; }   // cross-origin parent
  }

  function report(rest) {
    var p = hostOf();
    if (!p) return;
    try {
      if (typeof p.ycReportSubTab === 'function') p.ycReportSubTab(window.frameElement, rest);
    } catch (_) { /* host mid-navigation, or an older build */ }
  }

  function leafTake() {
    var p = hostOf();
    if (!p) return null;
    try {
      return typeof p.ycTakeSubTab === 'function' ? p.ycTakeSubTab(window.frameElement) : null;
    } catch (_) { return null; }
  }

  window.ycSubTab = {
    SEG: SEG, MAX_DEPTH: MAX_DEPTH, MAX_LEN: MAX_LEN,
    parse: parse, valid: valid, normalize: normalize,
    host: { hold: hold, take: take, noteReport: noteReport, lastRest: lastRest },
    leaf: { report: report, take: leafTake },
  };
})();
