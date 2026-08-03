/**
 * /forms/hooks/case_details_bk2.js — post-2.5B hook for the `case_details`
 * template. Successor to case_details_bk.js: everything Slice 2.5 made
 * declarative has MOVED OUT of this file into the template definition.
 *
 * Migrated out (do NOT re-add here):
 *   - Trustee dropdown rebuild + flagged unlisted option
 *       → field optionsFrom { source: "firmData.settings.trustees",
 *         value: "name", groupBy: "case_type", groupLabels: {…} }  (B1)
 *   - Derived dates (objection/180/preference/docs_due)
 *       → top-level derive rules  (B2)
 *   - Debtor / co-debtor names + case_number short-form fallback
 *       → $load prefills  (2.5A A1)
 *
 * Still here — the three behaviours with no schema representation:
 *
 *   B. 341 LINK. Changing trustee rewrites the hidden case_341_link from that
 *      trustee's `link` in firmData.settings.trustees (read by appointment
 *      automation T19). "Field B derived from field A's option payload" has
 *      no declarative form. NOTE: the SLICE_2_5_SPEC acceptance line ("hooks
 *      reduced to docket-split + chapter-mirror only") missed this one — B is
 *      deliberately retained, not an oversight.
 *
 *   D. DOCKET SPLIT. One visible case_number field writes TWO columns
 *      (case_number short + case_number_full). apiColumn is one column per
 *      direction — even the 2.5B {load, save} split — so the renderer's
 *      _buildPatchPayload is wrapped. Multi-column writes are the stated
 *      hook boundary (contract §4.3).
 *
 *   E. CHAPTER MIRROR. case_chapter also writes case_subtype ("Chapter 7").
 *      Same boundary as D.
 *
 * D and E wrap form._buildPatchPayload. render.html assigns its
 * apiColumn-whitelist version BEFORE calling init(), and this hook runs
 * inside init (step 13), so the wrap always applies to the renderer's
 * version, never a stale one.
 *
 * DEPLOY ORDER: this file ships alongside the 2.5B renderer; the case_details
 * template's staged draft update switches hooks: "case_details_bk" →
 * "case_details_bk2" in the SAME publish that adds optionsFrom/derive/$load
 * prefills — the swap is atomic at publish, so there is no window where a
 * shrunk hook runs against a template still expecting the full one.
 * case_details_bk.js stays in the repo untouched: published version 1 in the
 * history references it and must remain restorable.
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
