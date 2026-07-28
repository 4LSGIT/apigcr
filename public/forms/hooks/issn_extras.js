/**
 * /forms/hooks/issn_extras.js — hook for the `issn` template (DRAFT).
 *
 * The ISSN template is the stress test, not a shipping form. This hook restores
 * what the schema cannot express so the gaps can be measured rather than argued
 * about:
 *
 *   1. CHECKGROUP-DRIVEN VISIBILITY. Four employment blocks and three debt
 *      blocks are shown/hidden by individual checkboxes inside a checkgroup.
 *      showWhen cannot target them: _evaluateConditionals resolves its watched
 *      field with querySelector('[name=…]') and checkgroup members have no
 *      name attribute. → REPORT.md gap 3.
 *
 *   2. PER-ROW REPEATER CONDITIONAL. A vehicle row shows lease_end_date and
 *      hides total_owed when ownership === 'Lease'. Contract §4.2 explicitly
 *      excludes showWhen inside repeaters. → REPORT.md gap 10.
 *
 *   3. CONTACT WRITE-BACK ON SAVE. The hand-built onSave PATCHes the primary
 *      contact and creates-or-updates the co-debtor (intake POST + case_relate
 *      POST). onSubmit has exactly two verbs — patch (one entity) and workflow —
 *      so a second-entity write has nowhere to live. → REPORT.md gap 11.
 *
 * NOT restored: the five tabs (contract §9 reserves `tabs`, no renderer support)
 * and the Ash Auto Calendly iframe (no embeddable field type).
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
      s.onerror = function () { console.warn('[issn_extras] util failed to load'); resolve(null); };
      document.head.appendChild(s);
    });
    return window.__ycUtilPromise;
  }

  var PC_MAP = {
    contact_id: 'client_id', contact_name: 'client_name',
    contact_fname: 'client_fname', contact_mname: 'client_mname', contact_lname: 'client_lname',
    contact_phone: 'client_phone', contact_email: 'client_email',
    contact_dob: 'client_dob', contact_ssn: 'client_ssn',
    contact_address: 'client_address', contact_city: 'client_city',
    contact_state: 'client_state', contact_zip: 'client_zip',
  };
  var SC_MAP = {
    contact_id: 'cd_id', contact_name: 'cd_name',
    contact_fname: 'cd_fname', contact_mname: 'cd_mname', contact_lname: 'cd_lname',
    contact_phone: 'cd_phone', contact_email: 'cd_email',
    contact_dob: 'cd_dob', contact_ssn: 'cd_ssn',
  };

  window.ycHooks = {
    async onLoad(form) {
      var U = await loadUtil();
      if (!U) return;
      var e = U.entity(form);
      var c = U.clients(form);

      U.setIfEmpty(form, 'case_id', e.case_id);
      U.setIfEmpty(form, 'case_number', e.case_number_full || e.case_number);

      if (c.primary) {
        Object.keys(PC_MAP).forEach(function (k) { U.setIfEmpty(form, PC_MAP[k], c.primary[k]); });
        U.setRadioIfEmpty(form, 'marital_status', c.primary.contact_marital_status);
      }
      if (c.secondary) {
        Object.keys(SC_MAP).forEach(function (k) { U.setIfEmpty(form, SC_MAP[k], c.secondary[k]); });
        U.setIfEmpty(form, 'cd_contact_id', c.secondary.contact_id);
        // A Secondary client on the case implies married + co-debtor unless the
        // user already said otherwise.
        U.setRadioIfEmpty(form, 'marital_status', 'Married');
        U.setRadioIfEmpty(form, 'is_codebtor', 'Yes');
      }

      // ── 1. checkgroup-driven blocks ─────────────────────────────────────
      U.bindCheckgroupToggle(form, 'employed', ['Debtor'], U.rowOf(form, 'debtor_job'));
      U.bindCheckgroupToggle(form, 'employed', ['Spouse'], U.rowOf(form, 'spouse_job'));
      U.bindCheckgroupToggle(form, 'employed', ['Debtor 2nd Job'], U.rowOf(form, 'debtor_2nd_job'));
      U.bindCheckgroupToggle(form, 'employed', ['Spouse 2nd Job'], U.rowOf(form, 'spouse_2nd_job'));

      U.bindCheckgroupToggle(form, 'debt_type',
        ['Wage Garnishment - Active', 'State Tax Garnishment - Active'],
        U.rowOf(form, 'garnishment_start'));
      U.bindCheckgroupToggle(form, 'debt_type',
        ['Lawsuit pending (pre-judgment)', 'Pre-Foreclosure', 'Post-Foreclosure', 'L/T Judgment'],
        document.getElementById('ycRep_lawsuits') ? document.getElementById('ycRep_lawsuits').parentNode : null);
      U.bindCheckgroupToggle(form, 'debt_type',
        ['HELOC?', 'Payday Loans', 'Student Loans'],
        U.rowOf(form, 'loan_date'));

      // ── 2. per-row vehicle conditional ──────────────────────────────────
      var veh = document.getElementById('ycRep_vehicles');
      if (veh) {
        var applyRow = function (item) {
          var sel = item.querySelector('[name="ownership"]');
          if (!sel) return;
          var isLease = sel.value === 'Lease';
          var lease = item.querySelector('[name="lease_end_date"]');
          var owed = item.querySelector('[name="total_owed"]');
          if (lease && lease.closest('.yc-field')) lease.closest('.yc-field').style.display = isLease ? '' : 'none';
          if (owed && owed.closest('.yc-field')) owed.closest('.yc-field').style.display = isLease ? 'none' : '';
        };
        veh.addEventListener('change', function (ev) {
          if (!ev.target.matches('[name="ownership"]')) return;
          var item = ev.target.closest('.yc-repeater-item');
          if (item) applyRow(item);
        });
        // Rows added later by the Add button also need it. MutationObserver
        // rather than patching addRepeaterItem, so nothing in yc-forms is touched.
        new MutationObserver(function (muts) {
          muts.forEach(function (m) {
            Array.prototype.forEach.call(m.addedNodes, function (n) {
              if (n.nodeType === 1 && n.classList.contains('yc-repeater-item')) applyRow(n);
            });
          });
        }).observe(veh, { childList: true });
        veh.querySelectorAll('.yc-repeater-item').forEach(applyRow);
      }
    },

    // ── 3. contact write-back ─────────────────────────────────────────────
    async onSave(form) {
      var U = window.ycHookUtil;
      if (!U) return;
      var d = form.collect();

      if (d.client_id) {
        var pc = {};
        [['client_fname', 'contact_fname'], ['client_mname', 'contact_mname'],
         ['client_lname', 'contact_lname'], ['client_phone', 'contact_phone'],
         ['client_email', 'contact_email'], ['client_dob', 'contact_dob'],
         ['client_ssn', 'contact_ssn'], ['client_address', 'contact_address'],
         ['client_city', 'contact_city'], ['client_state', 'contact_state'],
         ['client_zip', 'contact_zip']].forEach(function (p) {
          if (d[p[0]]) pc[p[1]] = d[p[0]];
        });
        if (Object.keys(pc).length) {
          U.api('/api/contacts/' + d.client_id, 'PATCH', pc)
            .catch(function (err) { console.warn('[issn] primary contact update failed:', err); });
        }
      }

      if (d.is_codebtor !== 'Yes' || !d.cd_fname) return;

      var cd = { contact_fname: d.cd_fname, contact_lname: d.cd_lname };
      if (d.cd_mname !== undefined) cd.contact_mname = d.cd_mname;
      ['phone', 'email', 'dob', 'ssn'].forEach(function (k) {
        if (d['cd_' + k]) cd['contact_' + k] = d['cd_' + k];
      });
      if (d.cd_address_type === 'Same as Debtor') {
        cd.contact_address = d.client_address; cd.contact_city = d.client_city;
        cd.contact_state = d.client_state; cd.contact_zip = d.client_zip;
      } else if (d.cd_address_type === 'Different') {
        ['address', 'city', 'state', 'zip'].forEach(function (k) {
          if (d['cd_' + k]) cd['contact_' + k] = d['cd_' + k];
        });
      }

      if (d.cd_contact_id) {
        U.api('/api/contacts/' + d.cd_contact_id, 'PATCH', cd)
          .catch(function (err) { console.warn('[issn] co-debtor update failed:', err); });
        return;
      }

      try {
        var body = {
          firstName: d.cd_fname, middleName: d.cd_mname || '', lastName: d.cd_lname,
          phone: d.cd_phone || '', email: d.cd_email || '',
        };
        ['contact_dob', 'contact_ssn', 'contact_address', 'contact_city',
         'contact_state', 'contact_zip'].forEach(function (k) { if (cd[k]) body[k] = cd[k]; });

        var created = await U.api('/api/intake/contact', 'POST', body);
        var newId = created && (created.contact_id || created.id);
        if (!newId) return;
        await U.api('/api/cases/' + d.case_id + '/contacts', 'POST',
          { contact_id: newId, relate_type: 'Secondary' });
        U.setAlways(form, 'cd_contact_id', newId);
        U.setAlways(form, 'cd_id', newId);
      } catch (err) {
        console.warn('[issn] co-debtor create failed:', err);
      }
    },
  };
})();