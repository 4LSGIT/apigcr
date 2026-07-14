// public/automation/paramsMapping.js
//
// ─────────────────────────────────────────────────────────────
// Shared params-mapping row editor (params-mapping Slice).
//
// Replaces the near-triplicated render/build/collect trios that lived in:
//   1. emailIngest.html — renderActionParamsMapping / buildActionParamRow /
//                         collectActionParamsMapping  (classes swal-apm-*)
//   2. phoneIngest.html — byte-identical mirror of the above
//   3. hooks.html       — renderParamsMapping / buildParamMappingRow /
//                         collectParamsMapping        (classes swal-pm-*)
//
// Loaded the same way as fnPicker.js: a plain <script src> on the (non-module)
// automation sub-pages, exposing its API on `window`.
//
// CLASS NAMES: unified on pm-key / pm-val / pm-del. The old swal-apm-* /
// swal-pm-* names were referenced NOWHERE outside their own render+collect
// pair (grep-verified across all of public/), and no stylesheet targets them —
// they were pure JS selectors. This module owns render, collect AND seed, so
// the selectors can't drift out of sync with each other.
//
// DATALIST ID stays per-page (parameterized via opts.datalistId) because it
// must match the `list=` attribute AND the shell-generated <datalist id>:
//   emailIngest / phoneIngest → 'a-pm-source-datalist'
//   hooks                     → 'pm-source-datalist'
//
// ─────────────────────────────────────────────────────────────
// API
//
//   pmRender(containerEl, mapping, opts)
//     Paint a saved mapping. Undecorated — no meta is consulted, so opening an
//     existing action/target shows exactly the rows that are stored, nothing
//     more. Empty mapping → one blank scaffold row (unchanged behavior).
//
//   pmAddRow(containerEl, opts) → the appended row element
//     Append one blank row. Backs each page's "Add param" button.
//
//   pmCollect(containerEl) → { param: source, ... }
//     Harvest the rows. Rows with a blank KEY are skipped (unchanged), and —
//     NEW — rows with a blank/whitespace VALUE are dropped too. Seeded rows the
//     operator never filled in are scaffolding, not mapping entries; persisting
//     them as `{ subject: "" }` would resolve to `getByPath(output, '')` →
//     undefined at dispatch (lib/actionDispatchers.resolveParamsMapping), i.e.
//     a param silently forced to undefined. Verified safe against live data:
//     all 9 internal_function mapping configs in production (7 email + 2 phone
//     + 0 hook) have a non-empty value on every key, so nothing is lost.
//     NOTE the emptiness TEST trims but the STORED value does not — a quoted
//     literal space ("' '") survives, exactly as before.
//
//   pmSeedFromMeta(containerEl, fnMeta, existingMapping, opts)
//     Meta-driven seeding, fired from the function <select>'s `change` event.
//     MERGE, NEVER CLOBBER:
//       - every existing row is kept, in order, INCLUDING keys absent from the
//         schema (undeclared forensic keys are tolerated by design — the param
//         validator only checks DECLARED params, so out-of-schema keys are a
//         supported pattern, e.g. court_extract's raw envelope dot-paths);
//       - one row is appended per declared param not already present, in
//         declaration order;
//       - value prefill = quoted literal of the param's `default` when it has
//         one ("'0'", "'Fwd:'"), else blank. Quoted because
//         resolveParamsMapping strips exactly one outer single-quote pair to
//         yield a literal; an unquoted "0" would be read as a dot-path.
//     `existingMapping` is optional: pass null (the normal case) and the merge
//     base is read straight off the CURRENT DOM, so switching functions
//     preserves whatever the operator has already typed.
//
//     Rows whose key matches a declared param are decorated from the meta:
//     a red * marker for required params, the param `description` as the key
//     input's tooltip, and — for enum params — the value list in the value
//     input's placeholder (boundary-truncated) and tooltip (in full).
//
// The `fnMeta` shape is the same on all three pages after the meta-projection
// widening (emailIngestMetaService / phoneIngestMetaService now carry `type`,
// `enum`, `description` and `multiline` through). hooks.html has always
// received the raw, unprojected __meta from /workflows/functions.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const KEY_CLASS = 'pm-key';
  const VAL_CLASS = 'pm-val';
  const DEL_CLASS = 'pm-del';
  const REQ_CLASS = 'pm-req';

  const DEFAULT_DATALIST_ID = 'pm-source-datalist';
  const VALUE_PLACEHOLDER   = "field  or  a.b.c  or  'literal'";

  // Local — the module can't borrow each page's `esc()` (it loads before the
  // page script and must not depend on it). Byte-identical to the pages'.
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _datalistId(opts) {
    return (opts && opts.datalistId) || DEFAULT_DATALIST_ID;
  }

  // Shell helper (automationManager.html: fdParamSourceDatalistHtml). GUARDED:
  // emailIngest/phoneIngest already guarded it, hooks.html called it bare and
  // would have thrown if the shell ever lagged. One guard now covers all three.
  function _datalistHtml(datalistId) {
    try {
      const P = window.parent;
      if (P && typeof P.fdParamSourceDatalistHtml === 'function') {
        return P.fdParamSourceDatalistHtml(datalistId);
      }
    } catch { /* shell absent / cross-origin → degrade to no datalist */ }
    return '';
  }

  // Rows are <div> children; the datalist injected by _datalistHtml is a
  // <datalist> child, so `> div` never picks it up. (Same selector shape the
  // three pages used.)
  function _rowEls(containerEl) {
    return containerEl ? Array.from(containerEl.querySelectorAll(':scope > div')) : [];
  }

  // Read the live DOM as [key, value] pairs. Keys are trimmed; values are NOT
  // (an intentional leading space inside a quoted literal is the operator's).
  // Blank rows come back as ['', ''] — callers filter.
  function _readRows(containerEl) {
    return _rowEls(containerEl).map((row) => {
      const k = row.querySelector('.' + KEY_CLASS);
      const v = row.querySelector('.' + VAL_CLASS);
      return [
        k && typeof k.value === 'string' ? k.value.trim() : '',
        v && typeof v.value === 'string' ? v.value : '',
      ];
    });
  }

  // A value cell shows a string as-is; anything else (a number/bool/object that
  // came straight out of the stored JSON) is JSON-stringified so it round-trips
  // through the text input without becoming "[object Object]".
  function _display(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return JSON.stringify(value);
  }

  // Enum hint for the value input's placeholder. Truncates on a `|` boundary so
  // a value is never cut in half; the FULL list always lives in the tooltip.
  function _enumPlaceholder(list) {
    const joined = list.join(' | ');
    if (joined.length <= 56) return 'one of: ' + joined;
    let acc = '';
    for (const v of list) {
      const next = acc ? acc + ' | ' + v : String(v);
      if (next.length > 48) break;
      acc = next;
    }
    if (!acc) acc = String(list[0]);
    return 'one of: ' + acc + ' | … (' + list.length + ')';
  }

  // Build one row. `spec` is the matching __meta param (or null on the plain
  // render path, where no meta is consulted).
  function _buildRow(key, value, opts, spec) {
    const datalistId = _datalistId(opts);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';

    const required = !!(spec && spec.required);
    const keyTitle = (spec && spec.description) ? spec.description : '';

    let valPlaceholder = VALUE_PLACEHOLDER;
    let valTitle       = '';
    if (spec && Array.isArray(spec.enum) && spec.enum.length) {
      valPlaceholder = _enumPlaceholder(spec.enum);
      valTitle       = 'one of: ' + spec.enum.join(' | ') + '\n\n' + VALUE_PLACEHOLDER;
    }

    // The required marker is a fixed-width span rather than a placeholder: a
    // seeded key input HAS a value, so its placeholder would never be visible.
    // Always emitted (blank when not required) to keep the columns aligned.
    row.innerHTML = `
      <input class="${KEY_CLASS}" placeholder="param name" value="${esc(key)}"${keyTitle ? ` title="${esc(keyTitle)}"` : ''} style="flex:1;padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px">
      <span class="${REQ_CLASS}"${required ? ' title="required"' : ''} style="flex:0 0 7px;text-align:center;color:#ef4444;font-size:13px;font-weight:700;line-height:1">${required ? '*' : ''}</span>
      <span style="color:var(--muted);font-size:14px">=</span>
      <input class="${VAL_CLASS} mono" list="${esc(datalistId)}" placeholder="${esc(valPlaceholder)}"${valTitle ? ` title="${esc(valTitle)}"` : ''} value="${esc(_display(value))}" style="flex:2;padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px">
      <button type="button" class="${DEL_CLASS}" style="padding:4px 8px;font-size:11px;background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;color:#ef4444" title="Remove"><i class="fa-solid fa-times"></i></button>`;

    row.querySelector('.' + DEL_CLASS).addEventListener('click', () => row.remove());
    return row;
  }

  // Repaint the container from an ordered [key, value] list. `specByName` may be
  // null (plain render) — then no row is decorated.
  function _paint(containerEl, entries, opts, specByName) {
    containerEl.innerHTML = _datalistHtml(_datalistId(opts));
    if (!entries.length) {
      containerEl.appendChild(_buildRow('', '', opts, null));
      return;
    }
    for (const [k, v] of entries) {
      const spec = specByName ? (specByName.get(k) || null) : null;
      containerEl.appendChild(_buildRow(k, v, opts, spec));
    }
  }

  // ── Public API ───────────────────────────────────────────────

  window.pmRender = function pmRender(containerEl, mapping, opts) {
    if (!containerEl) return;
    const entries = (mapping && typeof mapping === 'object' && !Array.isArray(mapping))
      ? Object.entries(mapping)
      : [];
    _paint(containerEl, entries, opts, null);
  };

  window.pmAddRow = function pmAddRow(containerEl, opts) {
    if (!containerEl) return null;
    const row = _buildRow('', '', opts, null);
    containerEl.appendChild(row);
    return row;
  };

  window.pmCollect = function pmCollect(containerEl) {
    const mapping = {};
    if (!containerEl) return mapping;
    for (const [key, val] of _readRows(containerEl)) {
      if (!key) continue;                       // no key → scaffold row
      if (String(val).trim() === '') continue;  // no value → unfilled seed row
      mapping[key] = val;
    }
    return mapping;
  };

  window.pmSeedFromMeta = function pmSeedFromMeta(containerEl, fnMeta, existingMapping, opts) {
    if (!containerEl) return;

    const specs = (fnMeta && Array.isArray(fnMeta.params)) ? fnMeta.params : [];

    // Merge base: an explicit mapping if given, else whatever is on screen now
    // (minus blank-key scaffold rows). A key-but-no-value row is KEPT here —
    // the operator started it; only pmCollect drops it, and only at save time.
    const base = (existingMapping && typeof existingMapping === 'object' && !Array.isArray(existingMapping))
      ? Object.entries(existingMapping)
      : _readRows(containerEl).filter(([k]) => k !== '');

    const merged = base.slice();
    const seen   = new Set(merged.map(([k]) => k));

    for (const spec of specs) {
      if (!spec || !spec.name || seen.has(spec.name)) continue;
      seen.add(spec.name);
      // Quoted literal so resolveParamsMapping yields the default VALUE rather
      // than treating it as a dot-path: 0 → "'0'", 'Fwd:' → "'Fwd:'".
      const prefill = spec.default !== undefined ? "'" + String(spec.default) + "'" : '';
      merged.push([spec.name, prefill]);
    }

    const specByName = new Map(specs.filter(s => s && s.name).map(s => [s.name, s]));
    _paint(containerEl, merged, opts, specByName);
  };
})();