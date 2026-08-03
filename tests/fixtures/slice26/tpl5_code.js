/*
 * 341_notes (template 5) per-form code — Slice 2.6. Successor to
 * /forms/hooks/notes_341.js (file deleted from the repo; this code lives in
 * the definition, restorable from template history / git history). Body is
 * the hook file's IIFE verbatim — behavioural equivalence is test-enforced
 * (tests/formRender.slice26.test.js).
 *
 * What it does (the parts the template schema cannot express):
 *   1. Debtor / co-debtor first-middle-last from _loadResult.clients.
 *   2. Snapshot-guard prefill of case_id / case_number (full||short) /
 *      trustee / meeting_datetime.
 *   3. Attorney identity for workflow 7 (cases.341_appt_id → appts.appt_with
 *      → /resolve users.email|||user_name).
 * NOT reproduced: conditional requiredness of appearance_required /
 * new_control_datetime (pre-dates requiredWhen; unchanged by this port).
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
      s.onerror = function () { console.warn('[notes_341] util failed to load'); resolve(null); };
      document.head.appendChild(s);
    });
    return window.__ycUtilPromise;
  }

  var PC_MAP = {
    contact_fname: 'debtor_fname', contact_mname: 'debtor_mname', contact_lname: 'debtor_lname',
  };
  var SC_MAP = {
    contact_fname: 'codebtor_fname', contact_mname: 'codebtor_mname', contact_lname: 'codebtor_lname',
  };

  window.ycHooks = {
    async onLoad(form) {
      var U = await loadUtil();
      if (!U) return;

      var e = U.entity(form);
      var c = U.clients(form);
      var lr = form._loadResult || {};

      // ── 1. Header, snapshot-guarded ──────────────────────────────────────
      U.setIfEmpty(form, 'case_id', e.case_id);
      U.setIfEmpty(form, 'case_number', e.case_number_full || e.case_number);
      U.setIfEmpty(form, 'trustee', e.case_trustee);
      U.setIfEmpty(form, 'meeting_datetime', e.case_341_current);

      // ── 2. Parties ───────────────────────────────────────────────────────
      if (c.primary) {
        Object.keys(PC_MAP).forEach(function (k) { U.setIfEmpty(form, PC_MAP[k], c.primary[k]); });
        U.setIfEmpty(form, 'primary_contact_id', c.primary.contact_id);
      }
      if (c.secondary) {
        Object.keys(SC_MAP).forEach(function (k) { U.setIfEmpty(form, SC_MAP[k], c.secondary[k]); });
      }
      // The Co-Debtor SECTION uses showWhen notEmpty on codebtor_fname, so it
      // reveals itself at init step 13b once the value above is in place. No
      // display juggling needed here (the hand-built page did it by hand).

      // ── 3. Attorney for workflow 7 ───────────────────────────────────────
      var idEl = U.elFor(form, 'attorney_user_id');
      if (!idEl || idEl.value) return;                 // already carried by the snapshot

      var appts = lr.appts || [];
      if (!appts.length) {
        // The template's endpoints.load asks for include=clients,appts. If the
        // parent supplied entityData without appts we simply have nothing to
        // resolve — degrade quietly rather than firing an extra request.
        console.warn('[notes_341] no appts in load payload — attorney not resolved');
        return;
      }
      var apptId = e['341_appt_id'];
      var appt = apptId ? appts.filter(function (a) { return a.appt_id == apptId; })[0] : null;
      if (!appt || !appt.appt_with) return;

      idEl.value = appt.appt_with;
      try {
        var res = await U.api('/resolve', 'POST', {
          text: '{{users.email}}|||{{users.user_name}}',
          refs: { users: { user: appt.appt_with } },
        });
        if (res && res.status === 'success' && typeof res.text === 'string') {
          var parts = res.text.split('|||');
          // replacePlaceholders leaves unresolved tokens LITERAL — never write those.
          if (parts[0] && parts[0].indexOf('{{') === -1) U.setAlways(form, 'attorney_email', parts[0]);
          if (parts[1] && parts[1].indexOf('{{') === -1) U.setAlways(form, 'attorney_name', parts[1]);
        }
      } catch (err) {
        console.warn('[notes_341] attorney resolve failed:', err);
      }
    },
  };
})();