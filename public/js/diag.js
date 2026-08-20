/* public/js/diag.js
 *
 * Client diagnostics ring buffer — the payload behind "Help & Support".
 *
 * WHY IT EXISTS. Until this file there was no window.onerror and no
 * unhandledrejection handler anywhere in the client, so the single most useful
 * thing a bug report could carry — the JS error that fired thirty seconds
 * before the user gave up and pressed the button — was already gone by the
 * time they pressed it.
 *
 * WHY IT IS ITS OWN FILE AND NOT PART OF scripts.js. Three pages that badly
 * need instrumenting — automation/phoneIngest.html, automation/emailIngest.html
 * and automation/courtReview.html — CANNOT load scripts.js. Each declares a
 * top-level `const P = window.parent;` (and courtReview a top-level `const E`
 * and `const Toast`), and scripts.js declares the same names at top level.
 * Classic scripts share one global lexical environment, so the duplicate
 * `const` is a parse-time SyntaxError that kills the ENTIRE second script block
 * — i.e. adding scripts.js to those pages would silently blank them. This file
 * declares exactly one global (`window.ycDiag`) from inside an IIFE, so it can
 * be dropped into any page in the app without colliding with anything.
 *
 * LOAD IT BEFORE scripts.js. It then also catches errors thrown by scripts.js
 * itself and by anything that loads after it.
 *
 * ONE BUFFER, MANY FRAMES. Every frame writes into window.top's buffer, so a
 * report carries errors from the iframe the user was actually looking at, not
 * just the shell. Frames are same-origin; the try/catch covers the future case
 * where one isn't (a vanity/landing host), which degrades to a private
 * per-frame buffer rather than throwing at load.
 *
 * BOUNDED BY DESIGN. 30 entries, 600 chars each, consecutive identical entries
 * collapsed to a count — a render loop can throw hundreds of times a second and
 * must neither evict the one error that matters nor inflate a report body.
 * Worst case is ~18KB of strings per top-level document.
 *
 * COST. Two idle event listeners (free until something fires) plus a
 * console.error tee. The tee's only real cost is that DevTools then attributes
 * every console.error to THIS file instead of the line that called it, which
 * costs you click-to-source while debugging. Turn it off per-browser with:
 *
 *     localStorage.setItem('yc.diagConsoleHook', 'off');   // then reload
 *
 * window.onerror, unhandledrejection and the apiSend tee are unaffected by that
 * switch — you keep the three highest-value signals either way.
 */
(function ycDiagInit() {
  'use strict';

  // Idempotent: safe if a page ends up including this file twice.
  if (window.ycDiag) return;

  var TOP;
  try { TOP = (window.top && window.top.document) ? window.top : window; }
  catch (_) { TOP = window; }          // cross-origin top → private buffer

  if (!TOP.__ycDiag) TOP.__ycDiag = { max: 30, entries: [] };
  var buf = TOP.__ycDiag;

  function trunc(s, n) {
    s = (s == null) ? '' : String(s);
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }

  function frameTag() {
    try {
      if (window === TOP) return 'shell';
      return trunc(location.pathname + location.search, 120);
    } catch (_) { return 'frame'; }
  }

  function push(type, detail) {
    try {
      var entry = {
        t: new Date().toISOString(),
        type: type,
        frame: frameTag(),
        detail: trunc(detail, 600)
      };
      var last = buf.entries[buf.entries.length - 1];
      if (last && last.type === entry.type && last.detail === entry.detail
          && last.frame === entry.frame) {
        last.n = (last.n || 1) + 1;
        last.t = entry.t;
        return;
      }
      buf.entries.push(entry);
      if (buf.entries.length > buf.max) {
        buf.entries.splice(0, buf.entries.length - buf.max);
      }
    } catch (_) { /* diagnostics must never break the page they diagnose */ }
  }

  // CAPTURE phase on purpose: a resource-load failure (404 on a script, img or
  // link) fires 'error' on the ELEMENT and does not bubble, so a bubble-phase
  // listener never sees it. A missing FA/SweetAlert CDN asset is a real cause
  // of "the buttons look wrong and nothing works".
  window.addEventListener('error', function (ev) {
    try {
      if (ev && ev.target && ev.target !== window && ev.target.tagName) {
        push('resource', (ev.target.tagName || '?') + ' failed to load: '
          + (ev.target.src || ev.target.href || '(no url)'));
        return;
      }
      var stack = ev && ev.error && ev.error.stack;
      push('error',
        (ev && ev.message ? ev.message : 'Error')
        + (ev && ev.filename ? ' @ ' + ev.filename + ':' + ev.lineno + ':' + ev.colno : '')
        + (stack ? '\n' + stack : ''));
    } catch (_) { }
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev && ev.reason;
      push('rejection', (r && (r.stack || r.message)) || String(r));
    } catch (_) { }
  });

  // console.error tee. Everything still reaches the real console — this only
  // copies into the buffer, because a great deal of this app's failure
  // reporting is a caught error logged and swallowed, which is exactly the
  // class of failure a user describes as "it just didn't do anything".
  // Opt-out is per-browser (see the header note on DevTools attribution).
  var hookOff = false;
  try { hookOff = localStorage.getItem('yc.diagConsoleHook') === 'off'; } catch (_) { }

  if (!hookOff) {
    var origConsoleError = console.error;
    console.error = function () {
      try {
        push('console.error', Array.prototype.map.call(arguments, function (a) {
          if (a instanceof Error) return a.stack || a.message;
          if (a && typeof a === 'object') {
            try { return JSON.stringify(a); } catch (_) { return String(a); }
          }
          return String(a);
        }).join(' '));
      } catch (_) { }
      return origConsoleError.apply(console, arguments);
    };
  }

  // Per-frame handle onto the shared buffer. apiSend() pushes failed calls
  // through this; the report dialog reads entries() off it.
  window.ycDiag = {
    push: push,
    consoleHooked: !hookOff,
    entries: function () {
      try { return (TOP.__ycDiag && TOP.__ycDiag.entries) || []; }
      catch (_) { return []; }
    },
    clear: function () {
      try { TOP.__ycDiag.entries.length = 0; } catch (_) { }
    }
  };
})();
