/**
 * /forms/hooks/case_details_bk.js — hook for the `case_details` template.
 *
 * casedetails-bk.html is the densest hand-built form and the clearest test of
 * how much a template can absorb. Five behaviours have no schema representation;
 * all five are re-added here.
 *
 *   A. TRUSTEE DROPDOWN. Options come from app_settings['fe-trustees'] via
 *      firmData.settings.trustees, grouped into <optgroup> by chapter, with a
 *      flagged option injected when the stored value is not in the list so a
 *      legacy value is never silently dropped. The template can only carry a
 *      static `options` array (a build-time snapshot, which WILL go stale).
 *      → REPORT.md gap 5: `optionsFrom`.
 *
 *   B. 341 LINK. Changing trustee rewrites the hidden case_341_link from that
 *      trustee's `link` (read by appointment automation T19). No schema concept
 *      of "field B is derived from field A's option payload".
 *
 *   C. DERIVED DATES. Four suggestions filled only when empty:
 *        case_objection  = case_341_initial + 60d
 *        case_180        = case_file_date  + 180d
 *        case_preference = case_file_date  − 90d
 *        docs_due        = case_341_current − 14d
 *      Filled in onLoad specifically so they land BEFORE init step 13c's
 *      resetBaseline — otherwise the form reports dirty forever on a form
 *      nobody touched, which also blocks versionGuard's forced reload.
 *      → REPORT.md gap 6: `derive`.
 *
 *   D. DOCKET SPLIT. One visible case_number field writes TWO columns
 *      (case_number short + case_number_full). apiColumn is 1:1, so the
 *      renderer's _buildPatchPayload is wrapped.
 *
 *   E. CHAPTER MIRROR. case_chapter also writes case_subtype ("Chapter 7").
 *
 * D and E work by wrapping form._buildPatchPayload. render.html assigns its
 * apiColumn-whitelist version BEFORE calling init(), and this hook runs inside
 * init (step 13), so the wrap is always applied to the renderer's version and
 * never to a stale one.
 */
(function () {
  'use strict';

  var UTIL = '/forms/hooks/_yc_hook_util.js';
  function loadUtil() {
    if (window.ycHookUtil) return Promise.resolve(window.ycHookUtil);
    if (window.__ycUtilPromise) return window.__ycUtilPromise;
    window.__ycUtilPromise = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = UTIL;
      s.onload = function () { resolve(window.ycHookUtil); };
      s.onerror = function () { console.warn('[case_details_bk] util failed to load'); resolve(null); };
      document.head.appendChild(s);
    });
    return window.__ycUtilPromise;
  }

  var T_GROUP_LABEL = { 7: 'Chapter 7', 13: 'Chapter 13', 12: 'Chapter 12' };

  // ── date helpers (parse YYYY-MM-DD as LOCAL to avoid UTC drift) ──────────
  function addDays(dateStr, days) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(d)) return '';
    d.setDate(d.getDate() + days);
    return fmt(d);
  }
  function dateFromDatetime(dtStr, offsetDays) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dtStr || '');
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    if (isNaN(d)) return '';
    d.setDate(d.getDate() + offsetDays);
    return fmt(d);
  }
  function fmt(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /**
   * "25-44545-mar" → { short:'25-44545', full:'25-44545-mar' }
   * "25-44545"     → { short:'25-44545', full:null }
   * anything else  → { short:<raw>,      full:null, ok:false }  (keep the data)
   */
  function splitDocket(raw) {
    var v = (raw || '').trim();
    if (!v) return { short: '', full: null, ok: true };
    var m = /^(\d{2}-\d{5})(-[A-Za-z]+)$/.exec(v);
    if (m) return { short: m[1], full: v, ok: true };
    if (/^\d{2}-\d{5}$/.test(v)) return { short: v, full: null, ok: true };
    return { short: v, full: null, ok: false };
  }

  var DERIVED = [
    { src: 'case_341_initial', tgt: 'case_objection', calc: function (v) { return addDays(v, 60); } },
    { src: 'case_file_date', tgt: 'case_180', calc: function (v) { return addDays(v, 180); } },
    { src: 'case_file_date', tgt: 'case_preference', calc: function (v) { return addDays(v, -90); } },
    { src: 'case_341_current', tgt: 'docs_due', calc: function (v) { return dateFromDatetime(v, -14); } },
  ];

  window.ycHooks = {
    async onLoad(form) {
      var U = await loadUtil();
      if (!U) return;
      var e = U.entity(form);
      var c = U.clients(form);

      // ── client names ────────────────────────────────────────────────────
      if (c.primary) U.setIfEmpty(form, 'debtor_name', c.primary.contact_name);
      if (c.secondary) U.setIfEmpty(form, 'codebtor_name', c.secondary.contact_name);

      // case_number's apiColumn is case_number_full (matching the original
      // apiMap); fall back to the short column when full is empty.
      U.setIfEmpty(form, 'case_number', e.case_number);

      // ── A. trustee dropdown ─────────────────────────────────────────────
      var sel = U.elFor(form, 'case_trustee');
      var linkEl = U.elFor(form, 'case_341_link');
      var list = (U.firmData().settings && U.firmData().settings.trustees) || [];

      if (sel) {
        if (!list.length) {
          // formBuilder.html relays apiSend but NOT firmData, so a Live-tab
          // render has no trustee list. Keep the snapshot options rather than
          // blanking the control. See REPORT.md gap 9 (one-line shell fix).
          console.warn('[case_details_bk] firmData.settings.trustees unreachable — keeping snapshot options');
        } else {
          buildTrusteeOptions(sel, list, e.case_trustee || '');
        }
        sel.addEventListener('change', function () {
          var name = sel.value;
          if (!linkEl) return;
          if (name === '') { linkEl.value = ''; return; }
          var t = list.filter(function (x) { return String(x.name) === String(name); })[0];
          if (t) linkEl.value = t.link || '';   // unlisted legacy value → leave link untouched
        });
      }

      // ── C. derived dates (must be here, not after init) ─────────────────
      DERIVED.forEach(function (rule) {
        var s = U.elFor(form, rule.src), t = U.elFor(form, rule.tgt);
        if (!s || !t) return;
        if (!t.value && s.value) t.value = rule.calc(s.value);
        s.addEventListener('change', function () { t.value = rule.calc(s.value); });
      });

      // ── D + E. patch payload wrap ───────────────────────────────────────
      var inner = form._buildPatchPayload.bind(form);
      form._buildPatchPayload = function () {
        var payload = inner();
        var diff = this.getDiff();

        if ('case_number' in diff) {
          var s = splitDocket(diff.case_number[1]);
          payload.case_number = s.short;
          payload.case_number_full = s.full;   // NULL when no judge suffix was typed
        }
        if ('case_chapter' in diff) {
          var ch = String(diff.case_chapter[1] || '').trim();
          payload.case_chapter = ch;
          payload.case_subtype = ch ? 'Chapter ' + ch : '';
        }
        return payload;
      };
    },
  };

  /** Rebuild the trustee <select> grouped by chapter and re-apply the stored value. */
  function buildTrusteeOptions(sel, list, stored) {
    while (sel.firstChild) sel.removeChild(sel.firstChild);

    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— select trustee —';
    sel.appendChild(blank);

    // Stored value not in the list (legacy / dirty data) → flagged option, so
    // the value still displays and is never silently dropped on save.
    var known = list.some(function (t) { return String(t.name) === String(stored); });
    if (stored && !known) {
      var o = document.createElement('option');
      o.value = stored;
      o.setAttribute('data-unlisted', '1');
      o.textContent = '\u26A0 ' + stored + ' (not in trustee list)';
      sel.appendChild(o);
    }

    var groups = {};
    list.forEach(function (t) {
      var ct = Number(t.case_type) || 0;
      (groups[ct] = groups[ct] || []).push(t);
    });
    var order = [7, 13, 12].concat(Object.keys(groups).map(Number))
      .filter(function (ct, i, arr) { return groups[ct] && groups[ct].length && arr.indexOf(ct) === i; });

    order.forEach(function (ct) {
      var og = document.createElement('optgroup');
      og.label = T_GROUP_LABEL[ct] || ('Chapter ' + ct);
      groups[ct].forEach(function (t) {
        var o = document.createElement('option');
        o.value = String(t.name || '');
        o.textContent = String(t.name || '');
        og.appendChild(o);
      });
      sel.appendChild(og);
    });

    sel.value = stored || '';
  }
})();