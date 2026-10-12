// public/js/phoneSendable.js
//
// YCPhoneSendable.filterSelect(select, apiSend, { preferred })
//
// The UX half of the S-PH send gate (mailbox-system arc, ruling 2026-10-12).
// Since S-PH the staff SMS/MMS send path (/internal/sms|mms/send) refuses a
// staff user who lacks can_send on the line they text from. The pickers that
// feed it — the contact Communicate tab (communicate.html) and the case
// sending forms (sendingform.html, sendingform-bk.html) — fill their "From"
// select from the shell's firmData.phoneLines (every ACTIVE line: the same
// list automation editors use, so it is not filtered at the source). This
// narrows ONE such select to the lines the signed-in user may send from:
// GET /api/phone-lines/sendable (SU: every line; others: their can_send
// grants — the attorney READ bypass does not send).
//
//   - an option whose value (the line's 10-digit number) is not sendable is
//     REMOVED — never shown, then refused;
//   - if the selected line went, `preferred` (the user's default line) is
//     selected when it survived, else the first remaining; a `change` event
//     fires so dependent UI (the MMS section) follows;
//   - nothing left → one disabled placeholder; the select is disabled;
//   - the fetch failing (older backend, network) leaves the select as it was
//     — the server still enforces.
//
// Builds DOM with createElement/textContent only. Resolves
// { filtered: boolean, sendable: number|null }.
(function (root) {
  'use strict';

  async function filterSelect(select, apiSend, opts) {
    const o = opts || {};
    if (!select || typeof apiSend !== 'function') return { filtered: false, sendable: null };
    let data;
    try {
      data = await apiSend('/api/phone-lines/sendable', 'GET');
    } catch (_) {
      return { filtered: false, sendable: null };
    }
    const lines = data && Array.isArray(data.lines) ? data.lines : null;
    if (!lines) return { filtered: false, sendable: null };
    const ok = new Set(lines.map((l) => String(l && l.phone_number)));
    const before = select.value;
    for (const opt of Array.from(select.options)) {
      if (!ok.has(String(opt.value))) opt.remove();
    }
    const left = Array.from(select.options);
    if (!left.length) {
      const ph = select.ownerDocument.createElement('option');
      ph.value = '';
      ph.textContent = 'No line you can text from — ask whoever manages the lines';
      select.appendChild(ph);
      select.value = '';
      select.disabled = true;
    } else if (!left.some((x) => x.value === before)) {
      const pref = o.preferred != null ? left.find((x) => x.value === String(o.preferred)) : null;
      select.value = (pref || left[0]).value;
    }
    if (select.value !== before) {
      select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
    }
    return { filtered: true, sendable: left.length };
  }

  root.YCPhoneSendable = { filterSelect };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.YCPhoneSendable;
})(typeof window !== 'undefined' ? window : globalThis);
