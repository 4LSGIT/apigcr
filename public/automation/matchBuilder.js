// public/automation/matchBuilder.js
//
// ─────────────────────────────────────────────────────────────
// Shared match-builder (condition-tree) component — Trigger System T2.
//
// EXTRACTION LINEAGE: the mb* functions below are the reusable match-builder
// that emailIngest.html lifted from hooks.html and namespaced (.mb-* /
// .cond-*). This module ports that copy VERBATIM (conservative-extraction
// contract, same as lib/actionDispatchers.js) into a standalone script so
// triggers.html can consume it without a third inline copy.
//
// DELIBERATE NON-MIGRATION: emailIngest.html and phoneIngest.html still carry
// their own inline copies. They are live, tested surfaces; pointing them at
// this module is a follow-up slice, not this one. Until then, behavioral
// changes here do NOT propagate to the ingest pages — keep the three copies
// aligned if any of them changes.
//
// Loaded the same way as fnPicker.js / paramsMapping.js: a plain
// <script src> on a (non-module) automation sub-page, exposing its API on
// `window`. The consuming page must include the .cond-* / .mb-add-btn CSS
// block (triggers.html carries it; copied from emailIngest.html).
//
// PUBLIC API (all on window):
//   mbRender(rootEl, state, opts)  — render a condition tree; mutates `state` live.
//     opts.availableFields : [{ value, label }]  (curated dropdown; custom escape hatch auto-added)
//     opts.operators       : [{ value, label }] or ['equals',...]  (falls back internally)
//     opts.onChange        : fn()  (fired on any edit)
//   mbCollect(rootEl)              — harvest current DOM → { operator, conditions }
//   mbAddCondition(rootEl, cond)   — push a condition into the live state and
//                                    re-render (backs sample-panel click-to-insert)
//   MB_FALLBACK_OPERATORS, MB_VALUELESS_OPS — exported constants
// ─────────────────────────────────────────────────────────────

(function matchBuilderModule() {
  'use strict';

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const MB_CUSTOM = '__custom__';

  const FALLBACK_OPERATORS = [
    'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
    'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists', 'in', 'not_in', 'matches',
  ];
  // Operators that take NO value input (value box hidden/disabled).
  const VALUELESS_OPS = new Set(['exists', 'not_exists']);

  // Normalize an operators arg ([{value,label}] or ['equals',...] or undefined)
  // into a stable [{value,label}] list, falling back to FALLBACK_OPERATORS.
  function mbNormalizeOperators(operators) {
    let list = Array.isArray(operators) && operators.length ? operators : FALLBACK_OPERATORS;
    return list.map(o => {
      if (typeof o === 'object' && o) {
        const value = o.value ?? o.op ?? '';
        return { value, label: o.label ?? String(value).replace(/_/g, ' ') };
      }
      return { value: o, label: String(o).replace(/_/g, ' ') };
    });
  }

  // Render a match-builder into rootEl. `state` is the {operator, conditions}
  // tree and is mutated live as the user edits. opts carries the field catalog
  // and operator list (both injected — the reusability contract).
  function mbRender(rootEl, state, opts) {
    if (!rootEl) return;
    const cfg = {
      fields:    (opts && opts.availableFields) || [],
      operators: mbNormalizeOperators(opts && opts.operators),
      onChange:  (opts && typeof opts.onChange === 'function') ? opts.onChange : function () {},
    };
    rootEl.classList.add('cond-root');
    rootEl._state = state;
    rootEl._mbcfg = cfg;        // stash config so re-renders after mutation reuse it
    rootEl.innerHTML = '';
    rootEl.appendChild(mbBuildGroup(state, true, cfg));
  }

  // Re-render the nearest containing match-builder root after a structural
  // mutation (add/remove condition or group). Reuses the stashed config.
  function mbRerenderRoot(el) {
    const root = el.closest('.cond-root');
    if (root && root._state) mbRender(root, root._state, { availableFields: root._mbcfg.fields, operators: root._mbcfg.operators, onChange: root._mbcfg.onChange });
  }

  function mbBuildGroup(group, isRoot, cfg) {
    const div = document.createElement('div');
    div.className = 'cond-group';
    div._group = group;

    // head: AND/OR selector + hint + (remove, if subgroup)
    const head = document.createElement('div');
    head.className = 'cond-group-head';
    const opSel = document.createElement('select');
    opSel.innerHTML = `
      <option value="and" ${group.operator === 'and' ? 'selected' : ''}>AND</option>
      <option value="or"  ${group.operator === 'or'  ? 'selected' : ''}>OR</option>`;
    opSel.addEventListener('change', e => { group.operator = e.target.value; cfg.onChange(); });
    head.appendChild(opSel);
    const hint = document.createElement('span');
    hint.className = 'cond-group-hint';
    hint.textContent = group.operator === 'or' ? 'Any condition may match' : 'All conditions must match';
    opSel.addEventListener('change', () => { hint.textContent = group.operator === 'or' ? 'Any condition may match' : 'All conditions must match'; });
    head.appendChild(hint);
    if (!isRoot) {
      const rm = document.createElement('button');
      rm.className = 'cond-remove'; rm.title = 'Remove group';
      rm.innerHTML = '<i class="fa-solid fa-times"></i>';
      rm.addEventListener('click', () => { div.remove(); cfg.onChange(); });
      head.appendChild(rm);
    }
    div.appendChild(head);

    // body: child leaves + subgroups
    const body = document.createElement('div');
    body.className = 'cond-group-body';
    (group.conditions || []).forEach(cond => {
      if (cond && cond.operator) body.appendChild(mbBuildGroup(cond, false, cfg));
      else body.appendChild(mbBuildLeaf(cond, cfg));
    });
    div.appendChild(body);

    // foot: add-condition / add-group
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:6px;margin-top:6px';
    foot._group = group;
    const addC = document.createElement('button');
    addC.className = 'mb-add-btn';
    addC.innerHTML = '<i class="fa-solid fa-plus"></i> Condition';
    addC.addEventListener('click', () => { group.conditions = group.conditions || []; group.conditions.push({ path: '', op: 'equals', value: '' }); cfg.onChange(); mbRerenderRoot(addC); });
    const addG = document.createElement('button');
    addG.className = 'mb-add-btn';
    addG.innerHTML = '<i class="fa-solid fa-layer-group"></i> Group';
    addG.addEventListener('click', () => { group.conditions = group.conditions || []; group.conditions.push({ operator: 'and', conditions: [{ path: '', op: 'equals', value: '' }] }); cfg.onChange(); mbRerenderRoot(addG); });
    foot.appendChild(addC); foot.appendChild(addG);
    div.appendChild(foot);

    return div;
  }

  // A single condition row: curated field dropdown (+ custom escape hatch),
  // operator dropdown (injected list), value input (hidden for valueless ops).
  function mbBuildLeaf(cond, cfg) {
    const row = document.createElement('div');
    row.className = 'cond-row';
    row._cond = cond;
    const curPath = cond.path || '';
    const known = cfg.fields.some(f => f.value === curPath);
    const startCustom = curPath !== '' && !known;

    // field <select>
    const fieldSel = document.createElement('select');
    fieldSel.className = 'cond-field';
    fieldSel.innerHTML =
      cfg.fields.map(f => `<option value="${esc(f.value)}" ${(!startCustom && f.value === curPath) ? 'selected' : ''}>${esc(f.label)}</option>`).join('') +
      `<option value="${MB_CUSTOM}" ${startCustom ? 'selected' : ''}>Custom path…</option>`;
    // if path is empty and there are fields, default the model to the first field
    if (!startCustom && curPath === '' && cfg.fields.length) { cond.path = cfg.fields[0].value; fieldSel.value = cfg.fields[0].value; }
    row.appendChild(fieldSel);

    // custom-path free-text input (shown only in custom mode)
    const customInput = document.createElement('input');
    customInput.className = 'cond-path-custom';
    customInput.placeholder = 'custom.path';
    customInput.value = startCustom ? curPath : '';
    customInput.style.display = startCustom ? '' : 'none';
    row.appendChild(customInput);

    // operator <select> (injected list)
    const opSel = document.createElement('select');
    opSel.className = 'cond-op';
    opSel.innerHTML = cfg.operators.map(o => `<option value="${esc(o.value)}" ${cond.op === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    if (!cond.op) cond.op = cfg.operators[0]?.value || 'equals';
    row.appendChild(opSel);

    // value input
    const valInput = document.createElement('input');
    valInput.className = 'cond-value';
    valInput.placeholder = 'value';
    valInput.value = cond.value ?? '';
    row.appendChild(valInput);

    // remove button
    const rm = document.createElement('button');
    rm.className = 'cond-remove'; rm.title = 'Remove';
    rm.innerHTML = '<i class="fa-solid fa-times"></i>';
    row.appendChild(rm);

    // ── wiring ──
    const syncValueDisabled = () => {
      const off = VALUELESS_OPS.has(opSel.value);
      valInput.disabled = off;
      valInput.style.display = off ? 'none' : '';
      if (off) { cond.value = ''; valInput.value = ''; }
    };
    const syncPath = () => {
      if (fieldSel.value === MB_CUSTOM) {
        customInput.style.display = '';
        cond.path = customInput.value.trim();
      } else {
        customInput.style.display = 'none';
        cond.path = fieldSel.value;
      }
    };
    fieldSel.addEventListener('change', () => { syncPath(); cfg.onChange(); });
    customInput.addEventListener('input', () => { cond.path = customInput.value.trim(); cfg.onChange(); });
    opSel.addEventListener('change', () => { cond.op = opSel.value; syncValueDisabled(); cfg.onChange(); });
    valInput.addEventListener('input', () => { cond.value = valInput.value; cfg.onChange(); });
    rm.addEventListener('click', () => { row.remove(); cfg.onChange(); });

    syncValueDisabled();
    return row;
  }

  // Harvest the live DOM back into a { operator, conditions } object. This is
  // the authoritative save-time read (the live-mutated state can drift if a row
  // was removed). Reads field from .cond-field (or .cond-path-custom when the
  // field select is on the custom escape hatch). Valueless ops emit no value.
  function mbCollect(rootEl) {
    if (!rootEl) return { operator: 'and', conditions: [] };
    const top = rootEl.querySelector(':scope > .cond-group') || rootEl.querySelector('.cond-group');
    return mbCollectGroup(top);
  }
  function mbCollectGroup(groupEl) {
    if (!groupEl) return { operator: 'and', conditions: [] };
    const operator = groupEl.querySelector(':scope > .cond-group-head select')?.value || 'and';
    const body = groupEl.querySelector(':scope > .cond-group-body');
    const conditions = [];
    if (body) {
      for (const child of body.children) {
        if (child.classList.contains('cond-group')) {
          conditions.push(mbCollectGroup(child));
        } else if (child.classList.contains('cond-row')) {
          const fieldSel = child.querySelector('.cond-field');
          const customInput = child.querySelector('.cond-path-custom');
          const path = (fieldSel && fieldSel.value === MB_CUSTOM)
            ? (customInput?.value?.trim() || '')
            : (fieldSel?.value || '');
          const op = child.querySelector('.cond-op')?.value;
          if (!path || !op) continue;        // drop incomplete rows
          const cond = { path, op };
          if (!VALUELESS_OPS.has(op)) cond.value = child.querySelector('.cond-value')?.value ?? '';
          conditions.push(cond);
        }
      }
    }
    return { operator, conditions };
  }

  // Push a condition into the live state tree's ROOT group and re-render.
  // Backs the sample panel's click-to-insert (Trigger T2 addition — not part
  // of the ingest copies).
  function mbAddCondition(rootEl, cond) {
    if (!rootEl || !rootEl._state) return;
    const state = rootEl._state;
    state.conditions = state.conditions || [];
    state.conditions.push({ path: cond.path || '', op: cond.op || 'equals', value: cond.value ?? '' });
    mbRender(rootEl, state, { availableFields: rootEl._mbcfg.fields, operators: rootEl._mbcfg.operators, onChange: rootEl._mbcfg.onChange });
    if (rootEl._mbcfg.onChange) rootEl._mbcfg.onChange();
  }

  // ── expose ──
  window.mbRender = mbRender;
  window.mbCollect = mbCollect;
  window.mbAddCondition = mbAddCondition;
  window.MB_FALLBACK_OPERATORS = FALLBACK_OPERATORS;
  window.MB_VALUELESS_OPS = VALUELESS_OPS;
})();
