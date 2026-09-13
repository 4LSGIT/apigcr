/* public/js/ycPager.js — the shared list pager / footer.
 *
 * ONE pager for every offset-paginated list. Born as apptform2.html's picker
 * pager (the pk-* block, Sep 2026) merged with the feature set of scripts.js's
 * renderLogFooter (the "logs standard": range text, per-page select, expand
 * switch, Print, Export). Before this file the repo carried FOUR separate
 * pager families plus two verbatim ports of renderLogPagination into the
 * ingest pages, made "because the shell's copy isn't reachable" — which is the
 * whole reason this is a standalone script and not a scripts.js export:
 * anything can <script src="/js/ycPager.js"> it, shell page or nested iframe,
 * exactly like /js/assetpicker.js.
 *
 * The engine (window math, ellipsis-as-jump, one-shot input) is the picker's,
 * moved here verbatim; tests/ycPager.test.js pins it (the file supersedes
 * tests/apptsPicker.pager.test.js, which lifted the same functions out of the
 * page source by string-slicing).
 *
 * CSS is injected once per document under .yc-pager* CLASSES — deliberately
 * not an id. scripts.js scoped the old footer styles to #logTableFoot, and the
 * price was a rescoped copy in tasks.html (#tasksTableFoot) and another in
 * each ingest page. A class costs nothing and composes with any container.
 * Controls are a literal 28px tall — the same value theme.css's --ctl-h
 * carries, kept literal on purpose: wiring a density token has a second file
 * (the themeCustom UNUSED list, per the density-arc rule), and that wiring is
 * a density-arc slice's call, not this module's.
 *
 * PAGE-SIZE MEMORY. One localStorage entry, `yc.pager.limits`, holds a JSON
 * map of surface-key → rows-per-page, so every list remembers its own size
 * independently (the shell's five tabs used to share one `limit` global — the
 * lever moved for all of them at once). Callers read their stored size at
 * boot with getLimit(key, default) and pass `persistKey: key` to renderFooter
 * so the select writes it back. getLimit also falls back to the pre-module
 * per-tab prefs (`yc.log.limit`, `yc.tasks.limit`) so nobody's saved size
 * resets on the day this ships. localStorage is same-origin-shared, so a key
 * used by both a shell tab and an iframe (e.g. 'log' in index/case/contact)
 * is the SAME remembered size everywhere — that sharing is per-key and chosen
 * by the caller, not imposed by the store.
 *
 * API (all on window.YcPager; CommonJS-exported for jest):
 *   pageWindow(current, pages, span=2)   pure — which page numbers to render
 *   snapBackOffset(total, limit, offset) pure — recovery target for a page
 *                                        past the end, or -1 to stay put
 *   getLimit(key, dflt) / setLimit(key, n)
 *   renderPages(el, opts)                just the ‹ 1 2 … n › strip
 *   renderFooter(el, opts)               the full strip; opts:
 *     total, limit, offset, shown        counts (shown = rows on this page)
 *     onPage(p)                          REQUIRED. p is a 0-BASED page index —
 *                                        offset callers do p*limit, page-param
 *                                        callers do p+1
 *     sizes                              per-page choices; default
 *                                        [25,50,100,200,500] when onLimit set
 *     onLimit(n), persistKey             size-select change: the store is
 *                                        written first (when persistKey), then
 *                                        onLimit(n) refetches at page 0
 *     expand: {label, checked, inputId, onChange}   the logs "Expand rows"
 *                                        switch; presentation only, the caller
 *                                        owns what expanding MEANS
 *     onPrint                            true → window.print(), or a function
 *     onExport                           function → an Export button
 */
(function (global) {
  'use strict';

  /* ── page-size memory ──────────────────────────────────────────────────── */

  var STORE_KEY = 'yc.pager.limits';

  function readStore() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
      var map = raw ? JSON.parse(raw) : null;
      return (map && typeof map === 'object') ? map : {};
    } catch (_) { return {}; }   // storage disabled, or someone else's JSON
  }

  /**
   * The remembered rows-per-page for one surface. Falls back to the legacy
   * flat pref (`yc.<key>.limit` — setTabPref's spelling) so sizes saved
   * before this module existed survive the migration, then to the caller's
   * default. Always a positive integer or the default.
   */
  function getLimit(key, dflt) {
    var map = readStore();
    var v = parseInt(map[key], 10);
    if (v > 0) return v;
    try {
      v = parseInt(global.localStorage.getItem('yc.' + key + '.limit'), 10);
      if (v > 0) return v;
    } catch (_) { /* fall through */ }
    return dflt;
  }

  function setLimit(key, n) {
    n = parseInt(n, 10);
    if (!(n > 0)) return;
    try {
      var map = readStore();
      map[key] = n;
      global.localStorage.setItem(STORE_KEY, JSON.stringify(map));
    } catch (_) { /* storage disabled or full — degrade silently */ }
  }

  /* ── pure pager math (from apptform2's pkPageWindow / pkSearch) ────────── */

  /**
   * Which page numbers the pager renders: the first, the last, and a window
   * around the current one, with a gap object standing in for each run it
   * skips. Keeps the footer a fixed width whether the result set is 3 pages
   * or 3,000.
   * @returns {Array<number|{from:number,to:number}>} 0-based page indexes; an
   *   object is an ellipsis, carrying the inclusive range of pages it hides —
   *   which is what the jump control renders as its placeholder.
   */
  function pageWindow(current, pages, span) {
    if (span === undefined) span = 2;
    var want = new Set([0, pages - 1]);
    for (var p = current - span; p <= current + span; p++) {
      if (p >= 0 && p < pages) want.add(p);
    }
    var sorted = Array.from(want).sort(function (a, b) { return a - b; });
    var out = [];
    sorted.forEach(function (pg, i) {
      var prev = sorted[i - 1];
      if (i && pg - prev > 1) {
        // A run of ONE is rendered as that page, not as an ellipsis. "1 2 3 … 5"
        // asks the user to click and type "4" to reach page 4, where a "4"
        // button fits in the identical width. Ellipses are for runs worth
        // collapsing.
        if (pg - prev === 2) out.push(prev + 1);
        else out.push({ from: prev + 1, to: pg - 1 });
      }
      out.push(pg);
    });
    return out;
  }

  /**
   * Where to land when a fetch comes back empty because the offset ran off
   * the end (the result set shrank between visits, or a filter narrowed).
   * Returns the last real page's offset, or -1 when the current offset
   * stands. The `lastPage < offset` requirement is the TERMINATION GUARD,
   * not a nicety: a count that disagrees with the rows would otherwise
   * retarget the offset it is already on and recurse until the tab dies.
   * Requiring the retry to move strictly backwards means it can only ever
   * hop once. Callers: `if (!rows.length && (back = snapBackOffset(...)) >= 0)
   * return refetch(back);`
   */
  function snapBackOffset(total, limit, offset) {
    if (!(total > 0) || !(limit > 0) || !(offset > 0)) return -1;
    var lastPage = (Math.ceil(total / limit) - 1) * limit;
    return lastPage < offset ? lastPage : -1;
  }

  /* ── styles, injected once per document ────────────────────────────────── */

  /* Injected into the document the TARGET ELEMENT lives in, not this copy's
     own global — so a renderer handed a node from another document (a test
     harness, some future cross-frame use) styles the document it drew in. */
  function ensureStyles(doc) {
    if (!doc || !doc.head || doc.getElementById('yc-pager-styles')) return;
    var style = doc.createElement('style');
    style.id = 'yc-pager-styles';
    style.textContent = '\n' +
      '.yc-pager { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; }\n' +
      '.yc-pager-pages { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }\n' +
      '.yc-page {\n' +
      '  min-width: 28px; height: 28px; padding: 0 8px;\n' +
      '  border: 1px solid var(--border-strong); border-radius: 5px;\n' +
      '  background: var(--surface); color: var(--text-2);\n' +
      '  font-family: inherit; font-size: 0.8rem; font-weight: 600;\n' +
      '  cursor: pointer; transition: all 0.15s ease;\n' +
      '}\n' +
      '.yc-page:hover:not(:disabled) { background: var(--hover); color: var(--text); border-color: var(--accent); }\n' +
      '.yc-page:disabled { opacity: 0.45; cursor: default; }\n' +
      /* The current page is a disabled button too — there is nowhere to go —
         so it has to win the dimming the arrows use to say "no further". */
      '.yc-page-current, .yc-page-current:disabled {\n' +
      '  background: var(--accent); border-color: var(--accent);\n' +
      '  color: var(--accent-text); opacity: 1;\n' +
      '}\n' +
      /* The ellipsis is a BUTTON — it opens the jump-to-page input — so it
         carries .yc-page too and wears the page buttons' own box. Borderless
         it read as inert punctuation and nobody clicked it; matching boxes is
         the whole cue that it is reachable. Only the label colour differs,
         marking it as a range rather than a page. */
      '.yc-gap { color: var(--text-muted); letter-spacing: 1px; }\n' +
      '.yc-jump {\n' +
      '  width: 66px; height: 28px; padding: 0 6px;\n' +
      '  border: 1px solid var(--accent); border-radius: 5px;\n' +
      '  background: var(--surface); color: var(--text);\n' +
      '  font-family: inherit; font-size: 0.8rem; font-weight: 600;\n' +
      '  text-align: center; outline: none;\n' +
      '  box-shadow: 0 0 0 3px var(--accent-soft);\n' +
      '}\n' +
      /* The spinners eat half the box and the control is Enter-driven anyway.
         type=number is kept for the numeric keypad and the min/max semantics. */
      '.yc-jump::-webkit-outer-spin-button, .yc-jump::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }\n' +
      '.yc-jump { -moz-appearance: textfield; appearance: textfield; }\n' +
      '.yc-pager-range { font-size: 0.8rem; color: var(--text-muted); }\n' +
      /* Everything after the range rides the right edge as one cluster. */
      '.yc-pager-right { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-left: auto; }\n' +
      '.yc-pager-size-wrap { display: flex; align-items: center; gap: 5px; font-size: 0.78rem; color: var(--text-muted); }\n' +
      '.yc-pager-size {\n' +
      '  width: auto; height: 28px; padding: 0 6px; border: 1px solid var(--border-strong);\n' +
      '  border-radius: 5px; background: var(--surface); color: var(--text);\n' +
      '  font-family: inherit; font-size: 0.78rem;\n' +
      '}\n' +
      '.yc-pager-btn {\n' +
      '  height: 28px; padding: 0 10px; border: 1px solid var(--border-strong);\n' +
      '  border-radius: 5px; background: var(--surface); color: var(--text-2);\n' +
      '  font-family: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;\n' +
      '  transition: all 0.15s ease;\n' +
      '}\n' +
      '.yc-pager-btn:hover { background: var(--hover); color: var(--text); border-color: var(--accent); }\n' +
      '.yc-pager-expand { cursor: pointer; user-select: none; display: inline-flex; align-items: center; gap: 0.5em; font-size: 0.78rem; color: var(--text-muted); }\n' +
      /* CSS-only toggle switch, carried over from scripts.js's .log-switch —
         same metrics, same tokens, same recorded contrast caveats (the knob is
         literal white by design, mode-independent like --fill-text). */
      '.yc-switch { position: relative; display: inline-block; width: 32px; height: 18px; vertical-align: middle; flex: 0 0 auto; }\n' +
      '.yc-switch input { opacity: 0; width: 0; height: 0; margin: 0; position: absolute; }\n' +
      '.yc-switch-slider {\n' +
      '  position: absolute; cursor: pointer; inset: 0;\n' +
      '  background-color: var(--border-strong);\n' +
      '  transition: background-color 0.15s; border-radius: 18px;\n' +
      '}\n' +
      '.yc-switch-slider::before {\n' +
      '  position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px;\n' +
      '  background-color: white; transition: transform 0.15s; border-radius: 50%;\n' +
      '  box-shadow: 0 1px 2px rgba(0,0,0,0.2);\n' +
      '}\n' +
      '.yc-switch input:checked + .yc-switch-slider { background-color: var(--accent); }\n' +
      '.yc-switch input:checked + .yc-switch-slider::before { transform: translateX(14px); }\n' +
      '.yc-switch input:focus-visible + .yc-switch-slider { box-shadow: 0 0 0 2px var(--accent); }\n';
    doc.head.appendChild(style);
  }

  /* ── DOM builders ──────────────────────────────────────────────────────── */

  /**
   * The ellipsis, which is also the jump-to-page control.
   *
   * WHY HERE and not a permanent "go to page" box in the footer: an ellipsis
   * exists precisely when a run of pages is hidden, and it sits exactly where
   * that run would be. So the affordance appears if and only if there is
   * somewhere to jump TO, and costs no footer width when there is not. With
   * the default span the thresholds fall out of the window arithmetic: never
   * below span + 4 pages, always from 2*span + 6. tests/ycPager.test.js pins
   * the bands against the formula rather than against the numbers.
   *
   * Click or Enter swaps the ellipsis for a number input placeholder-ed with
   * the range it stands for ("4–87"), so the control says what it accepts.
   */
  function gapControl(doc, from, to, pages, onJump) {
    var gap = doc.createElement('button');
    gap.type = 'button';
    // .yc-page for the box and the hover, .yc-gap for the muted label. Sharing
    // the page-button class is deliberate: looking like a page button is what
    // says "you can click this".
    gap.className = 'yc-page yc-gap';
    gap.textContent = '…';
    gap.title = 'Jump to a page (' + (from + 1) + '–' + (to + 1) + ' hidden here)';

    gap.onclick = function () {
      var input = doc.createElement('input');
      input.type = 'number';
      input.className = 'yc-jump';
      input.min = '1';
      input.max = String(pages);
      input.placeholder = from === to ? String(from + 1) : (from + 1) + '–' + (to + 1);
      input.setAttribute('aria-label', 'Jump to page, 1 to ' + pages);

      /* ONE-SHOT. Every exit from this input — Escape, Enter, blur, and the
         footer rebuild a successful jump triggers — detaches a FOCUSED
         element, and detaching a focused element fires blur, which is itself
         an exit. Without `settled` the handler re-enters mid-mutation and
         replaceWith throws NotFoundError. Dropping onblur before touching the
         DOM closes the same door from the other side. */
      var settled = false;
      var restore = function () {
        if (settled) return;
        settled = true;
        input.onblur = null;
        if (input.isConnected) input.replaceWith(gap);
      };
      var commit = function () {
        if (settled) return;
        var n = parseInt(input.value, 10);
        // Out of range is treated as "never mind" rather than clamped:
        // clamping a typo'd 900 to page 90 looks like the jump worked and
        // landed wrong.
        if (!n || n < 1 || n > pages) return restore();
        settled = true;
        input.onblur = null;
        // Detach BEFORE handing off. onJump re-renders this footer (a
        // synchronous consumer does it inside this very call), and the
        // rebuild-guard would read a still-attached, still-focused input as
        // a jump in progress and swallow exactly the render the jump exists
        // to cause. The jump is settled here; the input's job is done.
        if (input.isConnected) input.replaceWith(gap);
        onJump(n - 1);               // rebuilds the footer, this node included
      };

      input.onkeydown = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); restore(); }
      };
      input.onblur = restore;

      gap.replaceWith(input);
      input.focus();
    };

    return gap;
  }

  /**
   * Whether the user is mid-jump inside `el` — the ellipsis has been swapped
   * for its number input and that input holds focus. Polling consumers
   * (workflow executions, sequence enrollments, the case/contact widget)
   * rebuild their footers on a timer; a rebuild at that moment would yank the
   * input out from under the typing. Skipping one refresh is invisible;
   * losing the half-typed jump target is not — so both renderers no-op while
   * a jump is in progress and the next tick catches the footer up.
   */
  function jumpInProgress(el) {
    var doc = el.ownerDocument;
    var a = doc && doc.activeElement;
    return !!(a && a.classList && a.classList.contains('yc-jump') && el.contains(a));
  }

  /**
   * Just the ‹ 1 2 … n › strip, into `el` (cleared first).
   * opts: { total, limit, offset, onPage } — onPage gets a 0-based page index.
   */
  function renderPages(el, opts) {
    ensureStyles(el.ownerDocument);
    if (jumpInProgress(el)) return;
    var doc = el.ownerDocument;
    el.innerHTML = '';
    el.classList.add('yc-pager-pages');

    var total = Number(opts.total) || 0;
    var limit = Number(opts.limit) > 0 ? Number(opts.limit) : 1;
    var offset = Number(opts.offset) || 0;
    var onPage = opts.onPage;
    if (total <= 0) return;

    var pages = Math.max(1, Math.ceil(total / limit));
    var current = Math.min(pages - 1, Math.max(0, Math.floor(offset / limit)));

    var btn = function (label, target, o) {
      o = o || {};
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'yc-page' + (o.isCurrent ? ' yc-page-current' : '');
      b.textContent = label;
      if (o.title) b.title = o.title;
      if (o.isCurrent) b.setAttribute('aria-current', 'page');
      if (o.disabled) b.disabled = true;
      else b.onclick = function () { onPage(target); };
      el.appendChild(b);
    };

    btn('‹', current - 1, { disabled: current === 0, title: 'Previous page' });
    pageWindow(current, pages).forEach(function (p) {
      if (typeof p === 'object') {
        el.appendChild(gapControl(doc, p.from, p.to, pages, onPage));
        return;
      }
      // Numbers are 1-based for humans, indexes 0-based for the caller.
      btn(String(p + 1), p, { disabled: p === current, isCurrent: p === current });
    });
    btn('›', current + 1, { disabled: current >= pages - 1, title: 'Next page' });
  }

  /** The full footer strip. See the header comment for opts. */
  function renderFooter(el, opts) {
    ensureStyles(el.ownerDocument);
    if (jumpInProgress(el)) return;
    var doc = el.ownerDocument;
    el.innerHTML = '';
    el.classList.add('yc-pager');

    var total = Number(opts.total) || 0;
    var limit = Number(opts.limit) > 0 ? Number(opts.limit) : 1;
    var offset = Number(opts.offset) || 0;
    var shown = Number(opts.shown) || 0;

    // 1. Pages. Skipped entirely at zero results — arrows to nowhere.
    if (total > 0) {
      var nav = doc.createElement('div');
      el.appendChild(nav);
      renderPages(nav, { total: total, limit: limit, offset: offset, onPage: opts.onPage });
    }

    // 2. Range. shown === 0 with a non-zero total is a stranded page the
    // caller's snap-back could not fix; "2226–2225 of 2232" reads as a bug.
    var range = doc.createElement('span');
    range.className = 'yc-pager-range';
    range.textContent = shown
      ? (offset + 1) + '–' + (offset + shown) + ' of ' + total
      : '0 of ' + total;
    el.appendChild(range);

    // 3. Right cluster: expand switch, size select, Print, Export. Rendered
    // even at zero results — an empty filter page keeps its levers.
    var right = doc.createElement('span');
    right.className = 'yc-pager-right';

    if (opts.expand) {
      var lbl = doc.createElement('label');
      lbl.className = 'yc-pager-expand';
      lbl.title = opts.expand.title || '';
      var sw = doc.createElement('span');
      sw.className = 'yc-switch';
      var cb = doc.createElement('input');
      cb.type = 'checkbox';
      if (opts.expand.inputId) cb.id = opts.expand.inputId;
      cb.checked = !!opts.expand.checked;
      var slider = doc.createElement('span');
      slider.className = 'yc-switch-slider';
      sw.appendChild(cb);
      sw.appendChild(slider);
      var txt = doc.createElement('span');
      txt.textContent = opts.expand.label || 'Expand rows';
      lbl.appendChild(sw);
      lbl.appendChild(txt);
      right.appendChild(lbl);
      cb.addEventListener('change', function () { opts.expand.onChange(cb.checked); });
    }

    if (opts.onLimit) {
      var sizes = (opts.sizes && opts.sizes.length) ? opts.sizes.slice() : [25, 50, 100, 200, 500];
      // A stored or server-clamped size that is not on the menu still has to
      // SHOW — a select silently displaying the wrong value is the select
      // lying about the page it sits under.
      if (sizes.indexOf(limit) === -1) sizes.push(limit);
      sizes.sort(function (a, b) { return a - b; });

      var sizeWrap = doc.createElement('span');
      sizeWrap.className = 'yc-pager-size-wrap';
      var size = doc.createElement('select');
      size.className = 'yc-pager-size';
      size.title = 'Rows per page';
      sizes.forEach(function (n) {
        var o = doc.createElement('option');
        o.value = String(n);
        o.textContent = String(n);
        size.appendChild(o);
      });
      size.value = String(limit);
      // Back to page 1 is the CALLER's job in onLimit: the row the user was
      // looking at is at a different offset under a different page size, so
      // "stay where you are" has no honest answer.
      size.onchange = function () {
        var n = parseInt(size.value, 10) || limit;
        if (opts.persistKey) setLimit(opts.persistKey, n);
        opts.onLimit(n);
      };
      sizeWrap.appendChild(size);
      sizeWrap.appendChild(doc.createTextNode('per page'));
      right.appendChild(sizeWrap);
    }

    if (opts.onPrint) {
      var pr = doc.createElement('button');
      pr.type = 'button';
      pr.className = 'yc-pager-btn yc-pager-print';
      pr.textContent = 'Print';
      pr.onclick = (typeof opts.onPrint === 'function') ? opts.onPrint
        : function () { global.print(); };
      right.appendChild(pr);
    }

    if (opts.onExport) {
      var ex = doc.createElement('button');
      ex.type = 'button';
      ex.className = 'yc-pager-btn yc-pager-export';
      ex.textContent = 'Export';
      ex.onclick = function () { opts.onExport(); };
      right.appendChild(ex);
    }

    if (right.childNodes.length) el.appendChild(right);
  }

  /* ── exports ───────────────────────────────────────────────────────────── */

  var api = {
    pageWindow: pageWindow,
    snapBackOffset: snapBackOffset,
    getLimit: getLimit,
    setLimit: setLimit,
    renderPages: renderPages,
    renderFooter: renderFooter,
  };

  global.YcPager = api;
  /* jest requires this file directly (tests/ycPager.test.js); the browser
     never sees `module`. */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
