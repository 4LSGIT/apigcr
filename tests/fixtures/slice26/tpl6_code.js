/*
 * case_details (template 6) per-form code — Slice 2.6. Successor to
 * /forms/hooks/case_details_bk2.js (file deleted from the repo; this code
 * lives in the definition, restorable from template history / git history).
 * Body was the hook file's IIFE verbatim — behavioural equivalence is
 * test-enforced (tests/formRender.slice26.test.js).
 *
 * The three behaviours with no schema representation:
 *   B. Trustee change rewrites hidden case_341_link from
 *      firmData.settings.trustees (read by appointment automation T19).
 *   D. Docket split: one visible case_number writes case_number (short) +
 *      case_number_full — multi-column writes are the stated code boundary
 *      (contract §4.3).
 *   E. Chapter mirror: case_chapter may also write case_subtype
 *      ("Chapter 7") — GUARDED, see below.
 * D and E wrap form._buildPatchPayload (assigned by render.html before init,
 * so the wrap always applies to the renderer's version).
 *
 * 2026-08-19: E is no longer unconditional. Kept byte-for-byte in step with
 * the hand-built public/forms/casedetails-bk.html, which is the form actually
 * wired into case.html today; this template is the candidate replacement.
 * Change the two together or they drift.
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

  /**
   * The parent shell's live case object, or null when it isn't ours to read.
   *
   * case.html mutates window.entityData.case.case_subtype in place when its
   * type/subtype selects are used, so this reflects a change made SINCE this
   * form loaded — fresher than form._liveData in the standalone-fetch path.
   * Guarded on case_id the way yc-forms init step 7 guards its own parent
   * fast-path: an embedded form pointed at a different case must not read the
   * parent's row.
   */
  function parentCase(form) {
    try {
      var pc = window.parent && window.parent.entityData && window.parent.entityData.case;
      if (pc && typeof pc === 'object' &&
          (pc.case_id == null || pc.case_id == form.config.linkId)) {
        return pc;
      }
    } catch (e) { /* cross-origin or no parent */ }
    return null;
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

          // ── case_chapter does NOT determine case_subtype ────────────────
          // For a plain Ch7/Ch13 matter the two agree, so deriving one from
          // the other is a genuine convenience and stays the default below.
          // They are INDEPENDENT for the other Bankruptcy subtypes: an
          // Adversary Proceeding under a Chapter 13 case carries
          // case_chapter='13' legitimately, and 'Creditor' likewise. Blindly
          // deriving rewrote such a case's subtype to 'Chapter 13', moving it
          // off the Adversary pipeline onto the Ch13 one — silently, because
          // resolveTemplate is a pure function of the row and simply
          // re-resolves. Live incident 2026-08-19, case 08kulmDV.
          //
          // So: derive ONLY when the stored subtype is already chapter-shaped
          // or unset. Never overwrite a subtype this field cannot speak for.
          //
          // Source of the stored value, freshest first:
          //   1. parent.entityData.case — see parentCase() above. In the
          //      normal parent-hosted path yc-forms step 7 sets _liveData to
          //      that same object, so 1 and 2 are the same reference; they
          //      differ only when step 7 fell back to the API fetch (form
          //      opened standalone).
          //   2. this._liveData — the loaded case row.
          //   3. Neither available -> write NOTHING. A missing subtype is
          //      visible (the case sits unstaged on the board) and trivially
          //      fixed from case.html's select; a wrong one files the matter
          //      on the wrong pipeline and looks correct.
          var curSub = null;
          var pc = parentCase(this);
          if (pc && 'case_subtype' in pc) {
            curSub = String(pc.case_subtype || '').trim();
          }
          if (curSub === null && this._liveData && typeof this._liveData === 'object' &&
              'case_subtype' in this._liveData) {
            curSub = String(this._liveData.case_subtype || '').trim();
          }
          if (curSub !== null && (curSub === '' || /^chapter\b/i.test(curSub))) {
            payload.case_subtype = ch ? 'Chapter ' + ch : '';
          }
        }

        return payload;
      };
    },
  };
})();
