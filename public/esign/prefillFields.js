// public/esign/prefillFields.js
//
// ─────────────────────────────────────────────────────────────
// PREFILL FIELD RENDERER (G3) — the fill-in-fields block shared by the two
// pages that turn a contract template into a document:
//
//   /esign/sendForm.html        template → envelope (signatures)
//   /documents/generateForm.html  template → filed PDF (no signatures)
//
// EXTRACTED VERBATIM from sendForm.html's renderFields / gatherValues /
// mdyToIso / isoToMdy. The markup is byte-identical to what sendForm shipped
// — including the deliberately-unescaped `data-key="${e.key}"` (schema keys
// are validated to [a-z0-9_] by esignTemplateService, so there is nothing to
// escape, and changing it now would be a silent DOM diff on a page whose only
// regression net is a human smoke test).
//
// Loaded as a plain <script src> on non-module pages, exposing
// window.buildPrefillFields — the same shape as automation/esignTplPanel.js,
// including the injected `esc` (these pages get theirs from esignActions.js
// as `esignEsc`; the module refuses to reach for a global it wasn't handed).
//
// ── WHY A FACTORY AND NOT FOUR LOOSE FUNCTIONS ───────────────
// The original pair was coupled through the DOM: renderFields wrote into
// #sf-fields and gatherValues read `.sf-f` off `document`. A second page
// mounting the same block would have had to either duplicate those ids or
// accept a cross-page global query. The factory closes over ONE container id,
// so the coupling becomes an argument instead of a convention.
//
// The `.sf-*` class names travel with the markup on purpose: they are this
// module's classes now, and every consumer therefore needs sendForm's field
// CSS (.sf-row / .req / .sf-hint / .sf-missing). generateForm.html carries a
// copy for exactly that reason.
//
// ── VALUE FORMAT ─────────────────────────────────────────────
// Values arrive FORMATTED from the prefill endpoints (money '$1,234.50', date
// 'MM/DD/YYYY'). Overrides are re-parsed server-side by formatValue, so a text
// input sending '1234.5' and a date input sending ISO yyyy-mm-dd are both
// fine. gather() converts date inputs BACK to MM/DD/YYYY so a gathered object
// can be handed straight back to render() without a lossy round trip.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  /** 'MM/DD/YYYY' → 'YYYY-MM-DD' (what <input type=date> wants), '' if not. */
  function mdyToIso(v) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v || '').trim());
    return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
  }
  /** 'YYYY-MM-DD' → 'MM/DD/YYYY'; anything else passes through untouched. */
  function isoToMdy(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    return m ? `${m[2]}/${m[3]}/${m[1]}` : v;
  }

  /**
   * @param {object} o
   * @param {string} o.containerId  the element the rows are written into
   * @param {function} o.esc        HTML escaper (esignEsc on these pages)
   * @returns {{render:function, gather:function, markMissing:function,
   *            schema:function, mdyToIso:function, isoToMdy:function}}
   */
  function buildPrefillFields({ containerId, esc }) {
    let lastSchema = [];

    const box = () => document.getElementById(containerId);

    /** The missing-required note, one string so render and markMissing agree. */
    const MISSING_HTML =
      ' <span class="sf-missing"><i class="fa-solid fa-triangle-exclamation"></i>' +
      ' required — not resolved from the case</span>';

    // prefill_schema entries: {key, label, type(text|number|date|money|options),
    // resolver, default, required}.
    function render(schema, values, missing) {
      const el = box();
      lastSchema = Array.isArray(schema) ? schema : [];
      if (!el) return;
      const missingSet = new Set(missing || []);
      const vals = values || {};
      el.innerHTML = lastSchema.length
        ? lastSchema.map(e => {
            const val = vals[e.key] != null ? vals[e.key] : '';
            const isMissing = missingSet.has(e.key) && e.required;
            let input;
            if (e.type === 'options') {
              const list = Array.isArray(val) ? val : [];
              input = `<textarea class="sf-f" data-key="${e.key}" rows="${Math.min(8, Math.max(3, list.length))}" ` +
                `spellcheck="false" style="font-family:inherit;">${esc(list.join('\n'))}</textarea>` +
                `<div class="sf-hint">One choice per line — the dropdown the signer picks from.</div>`;
            } else if (e.type === 'date') {
              input = `<input type="date" class="sf-f" data-key="${e.key}" value="${mdyToIso(val)}">`;
            } else {
              const ph = e.type === 'money' ? '$0.00' : (e.type === 'number' ? '0' : '');
              input = `<input type="text" class="sf-f" data-key="${e.key}" ` +
                `inputmode="${e.type === 'text' ? 'text' : 'decimal'}" placeholder="${ph}" ` +
                `value="${esc(val).replace(/"/g, '&quot;')}">`;
            }
            return `<div class="sf-row">` +
              `<label${isMissing ? ' style="color:#b45309"' : ''}>${esc(e.label)}` +
              `${e.required ? ' <span class="req">*</span>' : ''}:</label>` +
              input +
              (isMissing ? MISSING_HTML : '') +
              `</div>`;
          }).join('')
        : '<div class="sf-hint">This template has no fill-in fields.</div>';
    }

    function gather() {
      const el = box();
      const out = {};
      if (!el) return out;
      el.querySelectorAll('.sf-f').forEach(f => {
        const v = f.type === 'date' ? isoToMdy(f.value) : f.value.trim();
        if (v !== '') out[f.dataset.key] = v;
      });
      return out;
    }

    /**
     * Re-apply the render-time missing-required treatment to an ALREADY
     * rendered block, in place.
     *
     * The server can also report missing keys AFTER the fact (a 400 carrying
     * `missing` from ESIGN_MISSING_PREFILL), and re-render is the wrong tool
     * there: it would throw away everything the user just typed to tell them
     * one field is empty. An `options` field would additionally come back
     * wrong, because gather() flattens its array to newline text and render()
     * only accepts an array.
     *
     * @param {string[]} keys  missing required keys; [] clears the treatment
     */
    function markMissing(keys) {
      const el = box();
      if (!el) return;
      const set = new Set(keys || []);
      const required = new Set(lastSchema.filter(e => e.required).map(e => e.key));
      el.querySelectorAll('.sf-f').forEach(f => {
        const row = f.closest('.sf-row');
        if (!row) return;
        const on = set.has(f.dataset.key) && required.has(f.dataset.key);
        const label = row.querySelector('label');
        if (label) label.style.color = on ? '#b45309' : '';
        const note = row.querySelector('.sf-missing');
        if (on && !note) row.insertAdjacentHTML('beforeend', MISSING_HTML);
        if (!on && note) note.remove();
      });
    }

    /** The schema the last render() drew, for callers that need the types. */
    function schema() { return lastSchema; }

    return { render, gather, markMissing, schema, mdyToIso, isoToMdy };
  }

  if (typeof window !== 'undefined') {
    window.buildPrefillFields = buildPrefillFields;
    // Statics, for a caller that needs the date conversion without a block.
    window.buildPrefillFields.mdyToIso = mdyToIso;
    window.buildPrefillFields.isoToMdy = isoToMdy;
  }
})();
