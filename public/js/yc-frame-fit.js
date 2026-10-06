/* public/js/yc-frame-fit.js — a same-origin iframe as tall as its document
 *
 *   f.onload = () => { handle = fitFrameToContent(f); };   // → { fit, stop }
 *
 * Sets the frame's height to its body's scrollHeight (+24px) and keeps it
 * there: a MutationObserver inside the frame re-fits on any DOM change AND on
 * any inline-style change. The style half is the point — a textarea growing
 * under autoGrow() (scripts.js) as the user types is a height write, not a
 * DOM change, so the childList-only watch each host used to carry missed it
 * and left the frame short, with a scrollbar of its own inside the host.
 *
 * Contract with the framed page: its BODY's height must come from its
 * content (no min-height:100vh / height:100%), and it must render in
 * standards mode — in quirks mode body.scrollHeight is the viewport's, so
 * every fit would add the 24px again and the frame would creep taller.
 * (checklistView.html: doctype, content-sized body.) A fit only writes the
 * frame element in the HOST document, so it cannot re-trigger itself.
 *
 * stop() disconnects the observer and clears the polling fallback. A host
 * that re-points one frame at a new document (apptform2.html switching
 * appointments) calls it before fitting the new one; a frame that is loaded
 * once never needs it — the observer dies with the document it watches.
 *
 * Its own file, not scripts.js: apptform2.html does not load scripts.js.
 * Users: eventform.html, checklistsView.html, apptform2.html — each embeds
 * checklistView.html and each used to carry its own copy of this.
 *
 * Browser: window.fitFrameToContent. CommonJS too (the ycPager.js idiom) so
 * a test can require it.
 */
(function (global) {
  'use strict';

  var PAD = 24;
  var POLL_MS = 700;

  function fitFrameToContent(f) {
    var obs = null, timer = null;

    function fit() {
      try {
        var h = f.contentDocument && f.contentDocument.body && f.contentDocument.body.scrollHeight;
        if (h) f.style.height = (h + PAD) + 'px';
      } catch (_) { /* cross-origin or torn down — leave it */ }
    }

    fit();
    try {
      obs = new f.contentWindow.MutationObserver(fit);
      obs.observe(f.contentDocument.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['style'],
      });
    } catch (_) {
      timer = global.setInterval(fit, POLL_MS);
    }

    return {
      fit: fit,
      stop: function () {
        if (obs) { try { obs.disconnect(); } catch (_) {} obs = null; }
        if (timer) { global.clearInterval(timer); timer = null; }
      },
    };
  }

  global.fitFrameToContent = fitFrameToContent;
  if (typeof module !== 'undefined' && module.exports) module.exports = { fitFrameToContent: fitFrameToContent };
})(typeof window !== 'undefined' ? window : globalThis);
