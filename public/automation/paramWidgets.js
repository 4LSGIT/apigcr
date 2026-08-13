// public/automation/paramWidgets.js
//
// ─────────────────────────────────────────────────────────────
// {{placeholder}} toggle for NON-TEXT internal_function params.
//
// THE BUG THIS FIXES
//
// The metadata-driven step editors (workflows.html wfRenderParamField /
// sequences.html seqRenderParamField) render a param's control from its
// declared `type`:
//
//   integer / number → <input type="number">
//   enum             → <select>
//   object / array   → JSON <textarea>
//
// All three make a {{placeholder}} UNTYPEABLE, even though the server
// explicitly permits one on any param carrying `placeholderAllowed: true`
// (lib/internal_functions/index.js validateParamsAgainstMeta — the
// placeholder bypass runs BEFORE _validateType, so the declared type is
// irrelevant once the value matches PLACEHOLDER_RE):
//
//   • <input type="number"> runs the HTML value-sanitization algorithm and
//     silently drops every keystroke that can't build a floating-point
//     number, so "{{alertUserId}}" can never be entered.
//   • <select> only offers the declared enum members.
//   • the JSON textarea accepts the text, but gather JSON.parse()s it and
//     toasts "not valid JSON" — which is a SAVE LOCK, not just an authoring
//     gap: wf39 s4 `foreach { list: "{{docList}}" }` cannot be saved from
//     form mode at all today, no matter which field you actually edited.
//
// Both renderers already degrade an ALREADY-STORED placeholder to a plain
// text input (integer/number) or a "(custom)" option (enum), so existing
// configs round-trip — but there was no way to AUTHOR one except Edit-as-JSON.
//
// 14 params across 10 functions are affected (everything with
// placeholderAllowed on a non-string type):
//
//   integer  query_ai.file_asset_id, create_appointment.appt_with,
//            request_decision.recipient_id, esign_send_from_template.template_id,
//            create_event.event_with, update_log.log_id,
//            create_task.assigned_to, create_task.assigned_by
//   enum     create_log.link_type, create_log.direction,
//            phone_log.link_type, phone_log.direction, create_task.link_type
//   array    foreach.list
//
// ─────────────────────────────────────────────────────────────
// THE WIDGET
//
// A compact {{}} button rides in the field's <label>. It flips the control
// between two modes:
//
//   native — exactly the control the page rendered before this module existed
//            (number input with step/min/max, enum select, JSON textarea)
//   ph     — a plain monospace text input for a {{token}}
//
// The control keeps the SAME element id in both modes, so the pages' gather
// (`document.getElementById('e-pf-' + spec.name).value`) needs no change.
//
// NODE IDENTITY: for integer/number the toggle mutates `el.type` in place,
// so the node — and every listener bound to it — survives. That matters:
// esignTplPanel.js binds an `input` listener to #e-pf-template_id, which is
// integer + placeholderAllowed and therefore togglable. enum/object/array
// DO replace the node; no page code binds listeners to any of those params
// today, and a `pw:swap` CustomEvent fires on document if one ever needs to.
//
// STASH: switching ph → native would otherwise destroy the token (a number
// input blanks it, a select can't hold it). The token is stashed on the
// wrapper and restored on the way back, so a mis-click is undoable.
//
// Loaded as a plain <script src> on the two non-module editor pages, same as
// fnPicker.js / esignTplPanel.js / paramsMapping.js.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // Mirrors lib/internal_functions/index.js PLACEHOLDER_RE and the pages'
  // WF_PLACEHOLDER_RE / SEQ_PLACEHOLDER_RE.
  const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

  // Types whose native control can't accept free text. `string`,
  // `placeholder_string`, `duration` and `iso_datetime` already render as
  // text inputs, so they never need a toggle. `boolean` is deliberately
  // absent: _validateType hard-rejects a non-boolean and no boolean param
  // declares placeholderAllowed, so the checkbox is correct.
  const HANDLED = new Set(['integer', 'number', 'enum', 'object', 'array']);

  const MONO = "'SF Mono','Fira Code',ui-monospace,monospace";

  const TOG_BASE =
    'margin-left:6px;padding:0 5px;height:16px;line-height:14px;font-size:10px;' +
    'font-weight:700;font-family:' + MONO + ';border-radius:3px;cursor:pointer;' +
    'vertical-align:middle;border:1px solid ';

  // Local esc — this module loads before the page script and must not depend
  // on it. Byte-identical to the pages' esc()/paramsMapping.js's.
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isPlaceholder(v) {
    return typeof v === 'string' && v !== '' && PLACEHOLDER_RE.test(v);
  }

  // The slice of the spec pwToggle needs to rebuild the native control. Kept
  // small because it rides in a data- attribute on the wrapper (the page
  // hands the full spec to the render call, but the toggle fires later, from
  // an onclick, with nothing but the element id).
  function miniSpec(spec) {
    const m = { t: spec.type, r: !!spec.required };
    if (Array.isArray(spec.enum)) m.e = spec.enum;
    if (spec.min !== undefined) m.min = spec.min;
    if (spec.max !== undefined) m.max = spec.max;
    return m;
  }

  // Textarea display: a string shows as-is (so a stored "{{docList}}" isn't
  // re-quoted); anything else is pretty-printed JSON. Mirrors the pages'.
  function display(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  }

  // The control the page would have rendered without this module. Kept
  // behaviourally identical, INCLUDING the enum "(custom)" preservation for
  // legacy out-of-enum values that are not placeholders.
  function nativeHtml(id, m, value) {
    switch (m.t) {
      case 'integer':
      case 'number': {
        const v    = (value === null || value === undefined) ? '' : value;
        const step = m.t === 'integer' ? 'step="1"' : '';
        const min  = m.min !== undefined ? `min="${esc(m.min)}"` : '';
        const max  = m.max !== undefined ? `max="${esc(m.max)}"` : '';
        return `<input id="${id}" type="number" ${step} ${min} ${max} value="${esc(v)}">`;
      }
      case 'enum': {
        const opts   = m.e || [];
        const blank  = m.r ? '' : '<option value=""></option>';
        const isOut  = typeof value === 'string' && value !== '' && !opts.includes(value);
        const custom = isOut ? `<option value="${esc(value)}" selected>${esc(value)} (custom)</option>` : '';
        const list   = opts.map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('');
        return `<select id="${id}">${blank}${custom}${list}</select>`;
      }
      default: {
        // object / array
        const ph = m.t === 'array' ? '[]' : '{}';
        return `<textarea id="${id}" rows="4" placeholder="${ph}">${esc(display(value))}</textarea>`;
      }
    }
  }

  function phHtml(id, m, value) {
    const v = (value === null || value === undefined) ? '' : String(value);
    return `<input id="${id}" value="${esc(v)}" placeholder="{{variable}}" spellcheck="false"`
         + ` style="font-family:${MONO};font-size:12px">`;
  }

  function styleTog(btn, active) {
    btn.style.cssText = TOG_BASE + (active ? 'var(--blue)' : 'var(--border)') + ';'
      + (active
        ? 'color:var(--blue);background:rgba(79,142,247,0.12)'
        : 'color:var(--muted);background:transparent');
    btn.title = active
      ? 'Using a {{placeholder}} — click to go back to the normal input'
      : 'Click to enter a {{placeholder}} instead';
  }

  // ── Public API ───────────────────────────────────────────────

  /** Does this param need the toggle? */
  window.pwHandles = function pwHandles(spec) {
    return !!(spec && spec.placeholderAllowed && HANDLED.has(spec.type));
  };

  window.pwIsPlaceholder = isPlaceholder;

  /** The {{}} button. Goes INSIDE the field's <label>. */
  window.pwToggleHtml = function pwToggleHtml(id, value) {
    const active = isPlaceholder(value);
    const style  = TOG_BASE + (active ? 'var(--blue)' : 'var(--border)') + ';'
      + (active
        ? 'color:var(--blue);background:rgba(79,142,247,0.12)'
        : 'color:var(--muted);background:transparent');
    const title = active
      ? 'Using a {{placeholder}} — click to go back to the normal input'
      : 'Click to enter a {{placeholder}} instead';
    return `<button type="button" class="pw-tog" data-pw-for="${id}"`
         + ` onclick="pwToggle('${id}')" title="${esc(title)}" style="${style}">{{}}</button>`;
  };

  /** The control, wrapped so pwToggle can find its spec and mode. */
  window.pwControlHtml = function pwControlHtml(id, spec, value) {
    const m  = miniSpec(spec);
    const ph = isPlaceholder(value);
    return `<div class="pw-ctl" data-pw-id="${id}" data-pw-mode="${ph ? 'ph' : 'native'}"`
         + ` data-pw-spec="${esc(JSON.stringify(m))}">`
         + (ph ? phHtml(id, m, value) : nativeHtml(id, m, value))
         + `</div>`;
  };

  window.pwToggle = function pwToggle(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const box = el.closest('.pw-ctl');
    if (!box) return;

    let m;
    try { m = JSON.parse(box.dataset.pwSpec || '{}'); } catch { m = {}; }

    const toPh = box.dataset.pwMode !== 'ph';
    const cur  = el.value;

    // Carry the value across, and stash a token on the way OUT of ph mode so
    // the trip back restores it instead of the field coming up empty.
    let next;
    if (toPh) {
      next = box.dataset.pwStash || cur;
      delete box.dataset.pwStash;
    } else if (isPlaceholder(cur)) {
      box.dataset.pwStash = cur;
      next = '';
    } else {
      next = cur;
    }
    box.dataset.pwMode = toPh ? 'ph' : 'native';

    let target;
    if (m.t === 'integer' || m.t === 'number') {
      // Retype in place — keeps the node and its listeners alive
      // (esignTplPanel.js binds to #e-pf-template_id / #se-pf-template_id).
      // Type first, then value: assigning a token to a still-numeric input
      // would be sanitized away.
      el.type = toPh ? 'text' : 'number';
      el.value = next;
      el.style.fontFamily = toPh ? MONO : '';
      target = el;
    } else {
      box.innerHTML = toPh ? phHtml(id, m, next) : nativeHtml(id, m, next);
      target = document.getElementById(id);
    }

    const tog = document.querySelector(`.pw-tog[data-pw-for="${id}"]`);
    if (tog) styleTog(tog, toPh);

    if (target) {
      target.focus();
      // Feed the pages' debounced side-panels (esign template fields, the 6R /
      // CP-1 contract panels) exactly as typing would.
      target.dispatchEvent(new Event('input',  { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Extension point: only fires for the node-REPLACING types (enum /
    // object / array). Nothing binds listeners to those params today; if
    // something ever does, re-wire it here.
    document.dispatchEvent(new CustomEvent('pw:swap', {
      detail: { id, mode: box.dataset.pwMode },
    }));
  };
})();
