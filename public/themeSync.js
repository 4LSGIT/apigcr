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

   USER TOKEN OVERRIDES  (yc-theme-vars)
   -------------------------------------
   themeCustom.html lets a user set their own value for any token in theme.css.
   The overrides live in localStorage under `yc-theme-vars`, per mode:

     { "v":1, "preset":"warm-paper",
       "light": { "--accent":"#b5651d" }, "dark": { "--surface":"#101018" } }

   They are applied here, and only here, because this file is the one thing that
   already runs pre-paint in every in-arc page. A second script would mean
   touching 69 <head>s.

   WHY INLINE STYLE AND NOT AN INJECTED <style>
   An injected sheet carries both modes at once and so never needs re-applying
   on a theme flip, which is tempting. But it means building CSS text out of
   user-supplied values, and one unescaped `}` writes arbitrary rules into every
   page in the app with no in-app way back. setProperty() hands the value to the
   CSS parser AS a value — it validates it, and it structurally cannot escape
   into a rule. book.html and manage.html already set --accent this way from
   firm config, so it is the established pattern here.

   The cost is that inline style on <html> is mode-blind, so the set has to be
   swapped when data-theme changes. That is the MutationObserver in step 2 — on
   our OWN documentElement, deliberately not the 'yc-theme' event: the shell's
   applyTheme() sets the attribute without dispatching anything, and only the
   framed path below dispatches. Watching the attribute covers the shell, every
   frame, and any future setter.

   ESCAPE HATCH: /index.html?notheme=1 disables overrides for the whole browser
   tab — the flag goes in sessionStorage, which is shared with same-origin
   frames at every depth, so it reaches the framed pages that carry no query
   string of their own. ?notheme=0 clears it. A user who has made the app
   unreadable can always get back that way.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var el = document.documentElement;
  var VARS_KEY = 'yc-theme-vars';
  var OFF_KEY = 'yc-theme-vars-off';

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

  // 2. Pre-paint: the user's own token values, on top of theme.css. Runs
  //    BEFORE the step 3 early-out, or top-level pages never get them.
  var applied = [];

  function off() {
    try {
      if (/[?&]notheme=1(&|$)/.test(location.search)) sessionStorage.setItem(OFF_KEY, '1');
      else if (/[?&]notheme=0(&|$)/.test(location.search)) sessionStorage.removeItem(OFF_KEY);
      return sessionStorage.getItem(OFF_KEY) === '1';
    } catch (_) { return false; }
  }

  function applyVars() {
    // Clear what we set last time first: dropping an override has to
    // removeProperty, or the stale inline value outlives the deletion.
    for (var i = 0; i < applied.length; i++) el.style.removeProperty(applied[i]);
    applied = [];

    if (off()) return;

    var raw = null;
    try { raw = localStorage.getItem(VARS_KEY); } catch (_) {}
    if (!raw) return;

    var vars;
    try {
      vars = (JSON.parse(raw) || {})[el.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'];
    } catch (_) { return; }                 // corrupt blob — stock theme stands
    if (!vars || typeof vars !== 'object') return;

    // setProperty is the real guard; the name shape and the two caps are
    // defence in depth and a cheap ceiling on a runaway writer.
    var names = Object.keys(vars).slice(0, 200);
    for (var j = 0; j < names.length; j++) {
      var n = names[j];
      if (!/^--[a-zA-Z0-9-]{1,60}$/.test(n)) continue;
      var v = String(vars[n]);
      if (!v || v.length > 120) continue;
      el.style.setProperty(n, v);
      applied.push(n);
    }

    try { window.dispatchEvent(new CustomEvent('yc-theme-vars')); } catch (_) {}
  }

  applyVars();

  // themeCustom.html re-applies its own document after every edit (the writer
  // gets no storage event). Exported rather than reimplemented there so the
  // caps, the name check and the removeProperty bookkeeping cannot drift.
  window.ycApplyThemeVars = applyVars;

  // Mode flip → swap the set. See the header note on why this watches the
  // attribute rather than listening for 'yc-theme'. It cannot loop: applyVars
  // touches inline style, never the attribute.
  try {
    new MutationObserver(applyVars).observe(el, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  } catch (_) {}

  // Edits from the theme page land in every OTHER same-origin document — the
  // shell plus every open frame, at any depth, no postMessage plumbing. The
  // writer gets no storage event of its own, so themeCustom.html re-applies
  // locally itself. A null key means the whole store was cleared.
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key === VARS_KEY) applyVars();
  });

  // 3. Framed: follow the shell live, at whatever depth we are.
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
