/* ═══════════════════════════════════════════════════════════════════════════
   YisraCase — cross-frame theme sync

   Load as a plain BLOCKING <script src> in <head>, immediately after
   theme.css. Not defer, not async, not module. If it runs after first paint
   the frame flashes light before correcting itself, which is very visible
   against a dark shell.

   WHY window.top AND NOT postMessage
   ----------------------------------
   The original handoff specified a postMessage broadcast from the shell over
   document.querySelectorAll('iframe'). That only reaches DIRECT children, and
   this app nests three deep:

     index.html → automationManager.html → automation/triggers.html
     index.html → caseConfigManager.html → caseconfig/fields.html
     index.html → portalManager.html     → portaladmin/*.html
     index.html → case.html              → caseForm / 341 / det / tasksFrame / …

   It also misses the SweetAlert modal frames (calendar, apptform2, eventform,
   etch), which are injected long after the shell has booted.

   window.top has none of those problems: depth-independent, no relay through
   intermediate frames, and works for frames created at any time. This is not a
   new idea here — pipelineBoard.html, tasks.html, customView.html and
   reports.html already run exactly this pattern against body.dark today. This
   file is that pattern, generalised and moved to data-theme.

   Cross-origin frames throw on T.document and land in the catch, where the
   localStorage value already read above stands. No '*' origin anywhere.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var el = document.documentElement;

  function set(t) {
    t = (t === 'dark') ? 'dark' : 'light';
    if (el.getAttribute('data-theme') === t) return;
    el.setAttribute('data-theme', t);
    // Pages that bake colours in at construction (reports.html builds Chart.js
    // axes from the computed palette) listen for this instead of polling.
    try {
      window.dispatchEvent(new CustomEvent('yc-theme', { detail: { theme: t } }));
    } catch (_) {}
  }

  // 1. Pre-paint: last known theme. Correct for a standalone page, and the
  //    right first guess for a framed one.
  var stored = null;
  try { stored = localStorage.getItem('yc-theme'); } catch (_) {}
  el.setAttribute('data-theme', stored === 'dark' ? 'dark' : 'light');

  // 2. Framed: follow the shell live, at whatever depth we are.
  try {
    var T = window.top;
    if (T === window) return;               // top-level page — stored value stands

    var sync = function () {
      set(T.document.documentElement.getAttribute('data-theme'));
    };
    sync();
    new MutationObserver(sync).observe(T.document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  } catch (_) {
    // cross-origin, or top not reachable — stored value stands
  }
})();
