/*
 * case_details (template 6) per-form code — Slice 2.6. Successor to
 * /forms/hooks/case_details_bk2.js (file deleted from the repo; this code
 * lives in the definition, restorable from template history / git history).
 * Body is the hook file's IIFE verbatim — behavioural equivalence is
 * test-enforced (tests/formRender.slice26.test.js).
 *
 * The three behaviours with no schema representation:
 *   B. Trustee change rewrites hidden case_341_link from
 *      firmData.settings.trustees (read by appointment automation T19).
 *   D. Docket split: one visible case_number writes case_number (short) +
 *      case_number_full — multi-column writes are the stated code boundary
 *      (contract §4.3).
 *   E. Chapter mirror: case_chapter also writes case_subtype ("Chapter 7").
 * D and E wrap form._buildPatchPayload (assigned by render.html before init,
 * so the wrap always applies to the renderer's version).
 */
(function () {
  'use strict';

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

  function firmData() {
    try { return (window.parent && window.parent.firmData) || {}; }
    catch (e) { return {}; }
  }

  window.ycHooks = {
    async onLoad(form) {
      // ── B. trustee change → 341 link ────────────────────────────────────
      // The dropdown itself is rebuilt by the renderer's optionsFrom (which
      // runs BEFORE this hook in the generated onLoad); this listener only
      // maps the selected trustee to their meeting link.
      var sel = form.el.querySelector('[name="case_trustee"]');
      var linkEl = form.el.querySelector('[name="case_341_link"]');
      var list = (firmData().settings && firmData().settings.trustees) || [];
      if (sel && linkEl) {
        sel.addEventListener('change', function () {
          var name = sel.value;
          if (name === '') { linkEl.value = ''; return; }
          var t = list.filter(function (x) { return String(x.name) === String(name); })[0];
          if (t) linkEl.value = t.link || '';   // unlisted legacy value → leave link untouched
        });
      }

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
})();
