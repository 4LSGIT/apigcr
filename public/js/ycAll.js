/* public/js/ycAll.js — the All tab and the Ctrl-K / ⌘K command palette
 * (ui-custom S2).
 *
 * Two views over ONE list, ycLauncher.effectiveRegistry() — every launcher
 * item this user has (admin-gated and entitlement-denied items already out),
 * in All order — and ONE way to act on an entry, ycLauncher.exec(id), which
 * clicks the item's real launcher element. Neither view re-implements what a
 * launcher button does, and neither draws a copy of one: the entries here are
 * neutral buttons carrying data-yc-item, NEVER data-target /
 * data-exclusive-group (the drill-in machinery in index.html queries those
 * page-wide, and a second node per panel would corrupt it).
 *
 *   All tab   #tabAll in index.html. Grouped by origin (ycLauncher.groups()
 *             order); a search box above it ranks with the palette's matcher
 *             (ycLauncher.rank) — the phone's way in. Enter runs the top hit.
 *   Palette   Ctrl-K / ⌘K from anywhere once signed in, focused inputs and
 *             same-origin pane iframes included — except an editor that binds
 *             Ctrl-K itself (Quill's insert-link). Arrows + Enter run, Esc (or
 *             a click outside) closes and gives focus back. Stands down while a
 *             SweetAlert dialog (not a toast) is open, while the "Customize my
 *             launcher" editor is open (ycLayoutEditor.js), and before login.
 *
 * Re-renders on the 'ycLauncherAccess' window event, which
 * ycLauncher.applyAccess() fires after login and when the custom tab changes.
 * Styles: the #tabAll / #ycPalette block in index.html (theme.css tokens).
 */
(function () {
  'use strict';
  var L = window.ycLauncher;
  if (!L) { console.error('[ycAll] ycLauncher missing — load order'); return; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function iconHtml(e) { return '<i class="fa-solid fa-' + esc(e.icon) + '"></i>'; }

  // ── All tab ──────────────────────────────────────────────────────────
  function allItem(e) {
    return '<button type="button" class="yc-all-item" data-yc-item="' + esc(e.id) + '" title="' + esc(e.label) + '">' +
      iconHtml(e) + '<span>' + esc(e.label) + '</span></button>';
  }

  function renderAll() {
    var list = document.getElementById('ycAllList');
    if (!list) return;
    var input = document.getElementById('ycAllSearch');
    var q = input ? input.value : '';
    var eff = L.effectiveRegistry();
    if (q.replace(/\s+/g, '')) {
      var hits = L.rank(q, eff);
      list.innerHTML = hits.length
        ? '<div class="yc-all-items">' + hits.map(allItem).join('') + '</div>'
        : '<div class="yc-all-empty">Nothing matches “' + esc(q.trim()) + '”.</div>';
      return;
    }
    list.innerHTML = L.groups().map(function (g) {
      var items = eff.filter(function (e) { return e.group === g; });
      return items.length
        ? '<section class="yc-all-group"><h2>' + esc(g) + '</h2><div class="yc-all-items">' + items.map(allItem).join('') + '</div></section>'
        : '';
    }).join('');
  }

  function wireAll() {
    var list = document.getElementById('ycAllList');
    var input = document.getElementById('ycAllSearch');
    if (list) list.addEventListener('click', function (e) {
      var b = e.target.closest('.yc-all-item');
      if (b) L.exec(b.getAttribute('data-yc-item'));
    });
    if (input) {
      input.addEventListener('input', renderAll);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var first = input.value.replace(/\s+/g, '') && list && list.querySelector('.yc-all-item');
          if (first) { e.preventDefault(); L.exec(first.getAttribute('data-yc-item')); }
        } else if (e.key === 'Escape' && input.value) {
          input.value = ''; renderAll();
        }
      });
    }
  }

  // ── Palette ──────────────────────────────────────────────────────────
  var pal = null, input = null, listEl = null, hits = [], active = 0, restoreTo = null;

  function buildPalette() {
    if (pal) return;
    pal = document.createElement('div');
    pal.id = 'ycPalette';
    pal.hidden = true;
    pal.innerHTML =
      '<div class="yc-pal" role="dialog" aria-modal="true" aria-label="Go to a feature">' +
        '<input class="yc-pal-input" type="text" placeholder="Go to…" autocomplete="off" spellcheck="false"' +
          ' role="combobox" aria-expanded="true" aria-controls="ycPalList" aria-autocomplete="list">' +
        '<div class="yc-pal-list" id="ycPalList" role="listbox"></div>' +
        '<div class="yc-pal-foot">↑ ↓ to choose · Enter to open · Esc to close</div>' +
      '</div>';
    document.body.appendChild(pal);
    input = pal.querySelector('.yc-pal-input');
    listEl = pal.querySelector('.yc-pal-list');

    input.addEventListener('input', refresh);
    input.addEventListener('keydown', function (e) {
      var n = hits.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) setActive((active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      } else if (e.key === 'Enter') {
        e.preventDefault(); run(active);
      } else if (e.key === 'Escape') {
        e.preventDefault(); closePalette(true);
      } else if (e.key === 'Tab') {
        e.preventDefault();   // the palette is modal: focus stays in its input
      } else {
        return;
      }
      e.stopPropagation();
    });
    // A click on the backdrop (outside the box) closes.
    pal.addEventListener('mousedown', function (e) { if (e.target === pal) closePalette(true); });
    // Keep focus in the input while choosing with the pointer.
    listEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
    listEl.addEventListener('mousemove', function (e) {
      var b = e.target.closest('.yc-pal-item');
      if (b && Number(b.getAttribute('data-i')) !== active) setActive(Number(b.getAttribute('data-i')));
    });
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('.yc-pal-item');
      if (b) run(Number(b.getAttribute('data-i')));
    });
  }

  function refresh() {
    hits = L.rank(input.value, L.effectiveRegistry());
    active = 0;
    listEl.innerHTML = hits.length
      ? hits.map(function (e, i) {
          return '<button type="button" class="yc-pal-item" role="option" id="ycPalOpt' + i + '" data-i="' + i + '" tabindex="-1">' +
            iconHtml(e) + '<span>' + esc(e.label) + '</span><span class="yc-pal-group">' + esc(e.group) + '</span></button>';
        }).join('')
      : '<div class="yc-pal-empty">No match</div>';
    setActive(0);
  }

  function setActive(i) {
    active = i;
    var items = listEl.querySelectorAll('.yc-pal-item');
    for (var k = 0; k < items.length; k++) {
      items[k].classList.toggle('active', k === i);
      items[k].setAttribute('aria-selected', k === i ? 'true' : 'false');
    }
    var cur = items[i];
    if (cur) {
      input.setAttribute('aria-activedescendant', cur.id);
      // Scroll the list only (scrollIntoView would also scroll the page).
      if (cur.offsetTop < listEl.scrollTop) listEl.scrollTop = cur.offsetTop;
      else if (cur.offsetTop + cur.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
        listEl.scrollTop = cur.offsetTop + cur.offsetHeight - listEl.clientHeight;
      }
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function run(i) {
    var e = hits[i];
    if (!e) return;
    closePalette(false);   // the item takes focus from here (a tab, a dialog)
    L.exec(e.id);
  }

  function isOpen() { return !!(pal && !pal.hidden); }

  /** Open the palette. srcDoc: the document the shortcut came from (a pane
   *  iframe's, or this one) — whose focused element Esc gives focus back to. */
  function openPalette(srcDoc) {
    if (!L.isReady()) return false;
    buildPalette();
    if (isOpen()) return true;
    restoreTo = {
      el: document.activeElement,
      inner: srcDoc && srcDoc !== document ? srcDoc.activeElement : null,
    };
    input.value = '';
    refresh();
    pal.hidden = false;
    input.focus();
    return true;
  }

  function closePalette(restore) {
    if (!isOpen()) return;
    pal.hidden = true;
    var r = restoreTo;
    restoreTo = null;
    if (!restore || !r) return;
    try {
      if (r.el && r.el.focus) r.el.focus();
      if (r.inner && r.inner.focus) r.inner.focus();
    } catch (_) { /* the element went away */ }
  }

  // ── The shortcut ─────────────────────────────────────────────────────
  // A modal SweetAlert is up. A toast (window.Toast is a Swal mixin, and
  // Swal.isVisible() is true for one) is not a dialog and does not count.
  function swalOpen(w) {
    try {
      if (!(w && w.Swal && w.Swal.isVisible && w.Swal.isVisible())) return false;
      var p = w.Swal.getPopup && w.Swal.getPopup();
      return !(p && p.classList.contains('swal2-toast'));
    } catch (_) { return false; }
  }

  function onKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    // An editor that owns Ctrl-K handled it first: Quill's snow theme binds it
    // to "insert link" (the Campaigns and communicate.html composers).
    if (e.defaultPrevented) return;
    if (e.key !== 'k' && e.key !== 'K' && e.code !== 'KeyK') return;
    if (!L.isReady()) return;   // before login: not ours (the browser keeps its own Ctrl-K)
    // The layout editor (ycLayoutEditor.js, S4b) is modal: an item run from
    // the palette would open behind it, and the next Esc would go to it.
    if (window.ycLayoutEditor && typeof window.ycLayoutEditor.isOpen === 'function' && window.ycLayoutEditor.isOpen()) return;
    var doc = (e.target && e.target.ownerDocument) || (e.target && e.target.nodeType === 9 ? e.target : document);
    if (swalOpen(window) || swalOpen(doc.defaultView)) return;
    e.preventDefault();
    e.stopPropagation();
    if (isOpen()) closePalette(true);
    else openPalette(doc);
  }

  // Bubble phase, so an editor's own Ctrl-K binding wins (it calls
  // preventDefault; onKey then stands aside) while a plain focused input,
  // which has none, still opens the palette. Same-origin pane iframes (and
  // their nested frames) get the same listener as they load: a key pressed
  // inside a frame never reaches this document. Cross-origin frames throw on
  // contentDocument and are skipped.
  function hookDoc(doc) {
    try {
      if (!doc || doc.__ycAllHooked) return;
      doc.__ycAllHooked = true;
      doc.addEventListener('keydown', onKey);
      doc.addEventListener('load', onLoad, true);   // iframe load doesn't bubble; capture sees it
      var frames = doc.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) hookFrame(frames[i]);
    } catch (_) { /* cross-origin */ }
  }
  function hookFrame(f) {
    try { hookDoc(f.contentDocument); } catch (_) { /* cross-origin */ }
  }
  function onLoad(e) {
    if (e.target && e.target.tagName === 'IFRAME') hookFrame(e.target);
  }

  hookDoc(document);
  wireAll();
  window.addEventListener('ycLauncherAccess', function () {
    renderAll();
    if (isOpen()) refresh();
  });
  if (L.isReady()) renderAll();

  window.ycAll = { render: renderAll, open: openPalette, close: closePalette, isOpen: isOpen };
})();
