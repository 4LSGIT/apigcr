/**
 * /forms/hooks/case_clients.js
 *
 * Fills debtor / co-debtor identity fields on a case-linked templated form.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every case form in the firm shows the client's name. That name lives on
 * `contacts`, reached from `cases` through `case_relate` — and resolver prefill
 * cannot get there: render.html builds refs as `{ cases: { case_id: linkId } }`
 * and resolverService performs no relationship traversal (it LEFT JOINs only
 * the tables you hand it an anchor for). So the one thing nearly every case
 * form needs is the one thing pure JSON cannot express.
 *
 * The data is already in the load payload — `_loadResult.clients`, from
 * `?include=clients` (or case.html's entityData fast-path). This hook just
 * copies it into fields, by CONVENTION on field name.
 *
 * A template opts in with `"hooks": "case_clients"` and by naming its fields
 * from the table below. Fields that don't exist are skipped, so the same file
 * serves a 3-field summary form and a 14-field intake form.
 *
 * See REPORT.md gap 1 — the proposed `$load.*` prefill source would delete this
 * file entirely.
 */
(function () {
  'use strict';

  var UTIL = '/forms/hooks/_yc_hook_util.js';

  // render.html awaits ycHooks.onLoad, so awaiting the shared helper here is
  // race-free — unlike appending the <script> at parse time and hoping.
  function loadUtil() {
    if (window.ycHookUtil) return Promise.resolve(window.ycHookUtil);
    if (window.__ycUtilPromise) return window.__ycUtilPromise;
    window.__ycUtilPromise = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = UTIL;
      s.onload = function () { resolve(window.ycHookUtil); };
      s.onerror = function () {
        console.warn('[case_clients] ' + UTIL + ' failed to load');
        resolve(null);
      };
      document.head.appendChild(s);
    });
    return window.__ycUtilPromise;
  }

  // contact column → template field name, per role.
  var PRIMARY = {
    contact_name: ['debtor_name', 'client_name'],
    contact_fname: ['debtor_fname', 'client_fname'],
    contact_mname: ['debtor_mname', 'client_mname'],
    contact_lname: ['debtor_lname', 'client_lname'],
    contact_id: ['primary_contact_id', 'client_id'],
    contact_phone: ['client_phone'],
    contact_email: ['client_email'],
    contact_dob: ['client_dob'],
    contact_ssn: ['client_ssn'],
    contact_address: ['client_address'],
    contact_city: ['client_city'],
    contact_state: ['client_state'],
    contact_zip: ['client_zip'],
  };
  var SECONDARY = {
    contact_name: ['codebtor_name', 'cd_name'],
    contact_fname: ['codebtor_fname', 'cd_fname'],
    contact_mname: ['codebtor_mname', 'cd_mname'],
    contact_lname: ['codebtor_lname', 'cd_lname'],
    contact_id: ['secondary_contact_id', 'cd_id', 'cd_contact_id'],
    contact_phone: ['cd_phone'],
    contact_email: ['cd_email'],
    contact_dob: ['cd_dob'],
    contact_ssn: ['cd_ssn'],
    contact_address: ['cd_address'],
    contact_city: ['cd_city'],
    contact_state: ['cd_state'],
    contact_zip: ['cd_zip'],
  };

  /** Copy a contact row into whichever of the mapped fields the form declares. */
  function applyRole(U, form, contact, map) {
    if (!contact) return 0;
    var n = 0;
    Object.keys(map).forEach(function (col) {
      var v = contact[col];
      if (v == null || v === '') return;
      map[col].forEach(function (fieldName) {
        if (U.setIfEmpty(form, fieldName, v)) n++;
      });
    });
    return n;
  }

  window.ycHooks = {
    async onLoad(form) {
      var U = await loadUtil();
      if (!U) return;

      var c = U.clients(form);
      applyRole(U, form, c.primary, PRIMARY);
      applyRole(U, form, c.secondary, SECONDARY);

      // Deliberately NOT touching case-row columns here. Anything that lives on
      // `cases` should carry an apiColumn and be populated by the renderer; a
      // convenience fallback in this file would silently differ per form (e.g.
      // writing case_number_full into a form that has its own short/full split).
    },
  };
})();