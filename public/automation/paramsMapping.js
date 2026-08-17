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
// and (since the trigger system) also backs:
//   4. triggers.html    — rule action editor
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
//   triggers                  → 'pm-source-datalist'
//
// ─────────────────────────────────────────────────────────────
// ROW PROVENANCE (fixes the "switching functions grows the list" bug)
//
// Every row carries a `data-pm-seeded` marker when — and only when — THIS
// MODULE created it from a function's declared-param schema. The marker is
// deleted the first time the operator types into either input of that row.
// So at any moment a row is exactly one of:
//
//   unmarked — operator-owned. Came from a saved mapping (pmRender), from the
//              "Add param" button (pmAddRow), or was seeded and then EDITED.
//   marked   — untouched scaffolding this module put there.
//
// pmSeedFromMeta drops marked rows before merging. That is the whole fix:
// picking function A seeds A's params, picking B afterwards discards A's
// untouched seeds and seeds B's, instead of accumulating A ∪ B ∪ C…
//
// Anything the operator actually typed still survives a function switch — the
// original "never clobber the operator" intent is preserved, it is just no
// longer extended to rows the operator never touched.
//
// ─────────────────────────────────────────────────────────────
// UNDECLARED-KEY WARNING (visual only — nothing is ever removed)
//
// Provenance only reclaims rows the operator never touched. A row they DID
// type into survives a function switch by design, so a mapping can still end
// up holding keys the currently-selected function does not declare. That is a
// SUPPORTED pattern — validateParamsAgainstMeta only checks declared params,
// so out-of-schema keys pass through on purpose — but it is also exactly what
// a leftover from a previously-selected function looks like, and the two are
// indistinguishable from the row alone.
//
// So the module says so rather than guessing: whenever a schema is in play, a
// row whose key is non-blank and absent from that schema gets an amber key
// input, an amber `!` in the fixed-width marker slot (where a declared
// required param shows its red `*` — mutually exclusive, since an undeclared
// key has no spec and therefore cannot be required), and a tooltip spelling
// out both readings. The row is untouched otherwise: it renders, it collects,
// it saves. The operator decides.
//
// Verified against live data 2026-08-18: all 23 stored internal_function
// mappings (11 trigger actions + 8 email-ingest + 2 phone-ingest + 2 hook
// targets) use only declared keys, so the badge starts silent everywhere.
//
// Re-evaluated on the key input's `change` event, NOT `input`: keystroke-level
// re-checking makes the badge strobe on every prefix of a valid param name
// ("s", "su", "sub", …). `change` fires on blur, which is the moment the
// operator has actually finished naming the row.
//
// ─────────────────────────────────────────────────────────────
// API
//
//   opts (all methods)
//     datalistId  string   value-input <datalist> id; per-page, see above.
//     fnMeta      __meta   OPTIONAL. When present, pmRender decorates the rows
//                          it paints (required markers, descriptions, enum
//                          hints, undeclared-key warnings) instead of painting
//                          them bare. Omit for the historical undecorated open.
//     fnName      string   OPTIONAL. Names the function in the undeclared-key
//                          tooltip. Falls back to "the selected function".
//
//   pmRender(containerEl, mapping, opts)
//     Paint a saved mapping. Undecorated unless opts.fnMeta is supplied, so by
//     default opening an existing action/target shows exactly the rows that are
//     stored, nothing more. Empty mapping → one blank scaffold row (unchanged).
//     Painted rows are operator-owned (never marked as seeded).
//     ALSO (re)sets the container's decoration context — see pmAddRow.
//
//   pmAddRow(containerEl, opts) → the appended row element
//     Append one blank row. Backs each page's "Add param" button. Operator-
//     owned (never marked), so an explicitly added row is never auto-removed.
//     Inherits the container's CURRENT decoration context (whatever schema the
//     last pmRender/pmSeedFromMeta established), so a row added after picking a
//     function warns as you name it without the call site passing fnMeta in.
//
//   pmCollect(containerEl) → { param: source, ... }
//     Harvest the rows. Rows with a blank KEY are skipped, and rows with a
//     blank/whitespace VALUE are dropped too. Seeded rows the operator never
//     filled in are scaffolding, not mapping entries; persisting them as
//     `{ subject: "" }` would resolve to `getByPath(output, '')` → undefined
//     at dispatch (lib/actionDispatchers.resolveParamsMapping), i.e. a param
//     silently forced to undefined.
//     NOTE the emptiness TEST trims but the STORED value does not — a quoted
//     literal space ("' '") survives, exactly as before.
//     Provenance and the undeclared warning are both IGNORED here: a seeded row
//     prefilled with a real default ("'1024'") is a meaningful value, and an
//     undeclared key is a supported pattern. Neither is a save gate.
//
//   pmSeedFromMeta(containerEl, fnMeta, existingMapping, opts)
//     Meta-driven seeding, fired from the function <select>'s `change` event.
//     MERGE, BUT ONLY OVER OPERATOR-OWNED ROWS:
//       - every UNMARKED existing row is kept, in order, INCLUDING keys absent
//         from the schema (undeclared forensic keys are tolerated by design —
//         the param validator only checks DECLARED params, so out-of-schema
//         keys are a supported pattern, e.g. court_extract's raw envelope
//         dot-paths). Those rows now carry the amber warning above.
//       - MARKED rows (untouched seeds from the previously-selected function)
//         are DROPPED;
//       - one row is appended per declared param not already present, in
//         declaration order, and marked;
//       - value prefill = quoted literal of the param's `default` when it has
//         one ("'0'", "'Fwd:'"), else blank. Quoted because
//         resolveParamsMapping strips exactly one outer single-quote pair to
//         yield a literal; an unquoted "0" would be read as a dot-path.
//     `existingMapping` is optional: pass null (the normal case) and the merge
//     base is read straight off the CURRENT DOM. Passing an explicit mapping
//     treats every entry as operator-owned.
//
//     Rows whose key matches a declared param are decorated from the meta:
//     a red * marker for required params, the param `description` as the key
//     input's tooltip, and — for enum params — the value list in the value
//     input's placeholder (boundary-truncated) and tooltip (in full).
//
// The `fnMeta` shape is the same on all pages after the meta-projection
// widening (emailIngestMetaService / phoneIngestMetaService now carry `type`,
// `enum`, `description` and `multiline` through). hooks.html / triggers.html
// receive the raw, unprojected __meta from /workflows/functions.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const KEY_CLASS = 'pm-key';
  const VAL_CLASS = 'pm-val';
  const DEL_CLASS = 'pm-del';
  const REQ_CLASS = 'pm-req';

  // dataset key `pmSeeded` ⇒ attribute `data-pm-seeded`.
  const SEED_KEY = 'pmSeeded';

  const DEFAULT_DATALIST_ID = 'pm-source-datalist';
  const VALUE_PLACEHOLDER   = "field  or  a.b.c  or  'literal'";

  // Literals, not var(--red)/var(--amber): the required marker was already a
  // literal #ef4444 because the host pages do not all define the same custom
  // properties (triggers.html has --amber, the ingest pages do not).
  const REQ_COLOR   = '#ef4444';
  const WARN_COLOR  = '#f59e0b';
  const WARN_BG     = '#fffbeb';

  // Written as the FULL `border` shorthand, never the borderColor longhand.
  // The key input's inline style carries `border:1px solid var(--border)`, and
  // a shorthand containing a var() is stored by CSSOM as a single pending-
  // substitution value — poking one longhand on top of it, then trying to
  // remove that longhand again, is not reliably reversible across engines.
  // Rewriting the whole shorthand each way sidesteps that entirely.
  // (`border` does not include border-radius, so the 4px corner survives.)
  const NORMAL_BORDER = '1px solid var(--border)';
  const WARN_BORDER   = '1px solid ' + WARN_COLOR;

  const WARN_TIP_TAIL =
    '\n\nIt is still passed through — the param validator only checks DECLARED '
  + 'params, so deliberate out-of-schema keys are supported. If you did not '
  + 'mean this one it is most likely left over from a function that was '
  + 'selected earlier: remove the row.';

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

  function _fnLabel(opts) {
    const n = opts && opts.fnName;
    return (typeof n === 'string' && n.trim()) ? n.trim() : 'the selected function';
  }

  // name → spec lookup, or null when there is no schema to check against.
  function _specMap(fnMeta) {
    const specs = (fnMeta && Array.isArray(fnMeta.params)) ? fnMeta.params : null;
    if (!specs) return null;
    return new Map(specs.filter(s => s && s.name).map(s => [s.name, s]));
  }

  // Shell helper (automationManager.html: fdParamSourceDatalistHtml). GUARDED:
  // emailIngest/phoneIngest already guarded it, hooks.html called it bare and
  // would have thrown if the shell ever lagged. One guard now covers all.
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

  // Read the live DOM as [key, value, seeded] triples. Keys are trimmed;
  // values are NOT (an intentional leading space inside a quoted literal is
  // the operator's). Blank rows come back as ['', '', …] — callers filter.
  function _readRows(containerEl) {
    return _rowEls(containerEl).map((row) => {
      const k = row.querySelector('.' + KEY_CLASS);
      const v = row.querySelector('.' + VAL_CLASS);
      return [
        k && typeof k.value === 'string' ? k.value.trim() : '',
        v && typeof v.value === 'string' ? v.value : '',
        row.dataset[SEED_KEY] === '1',
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

  // Paint one row's meta-driven decoration. Single source of truth for BOTH
  // the initial build and the live re-check on key `change`, so a renamed row
  // can never keep another param's required marker / description / enum hint.
  //
  //   spec        matching __meta param, or null
  //   undeclared  key is non-blank and absent from the active schema
  //   fnLabel     function name for the warning tooltip
  function _decorate(row, spec, undeclared, fnLabel) {
    const keyEl = row.querySelector('.' + KEY_CLASS);
    const reqEl = row.querySelector('.' + REQ_CLASS);
    const valEl = row.querySelector('.' + VAL_CLASS);
    if (!keyEl || !reqEl || !valEl) return;

    const required = !!(spec && spec.required);

    // Fixed-width marker slot. Red * (declared + required) and amber !
    // (undeclared) can never collide: undeclared implies spec === null.
    reqEl.textContent = required ? '*' : (undeclared ? '!' : '');
    reqEl.style.color = undeclared ? WARN_COLOR : REQ_COLOR;
    if (required)        reqEl.title = 'required';
    else if (undeclared) reqEl.title = 'not a parameter of ' + fnLabel;
    else                 reqEl.removeAttribute('title');

    if (undeclared) {
      keyEl.style.border     = WARN_BORDER;
      keyEl.style.background = WARN_BG;
      keyEl.title = 'Not a declared parameter of ' + fnLabel + '.' + WARN_TIP_TAIL;
    } else {
      keyEl.style.border = NORMAL_BORDER;
      // '' REMOVES the inline background rather than forcing a color, so the
      // field falls back to exactly what it looked like before this module
      // started decorating — no assumption about the host page's palette.
      keyEl.style.background = '';
      if (spec && spec.description) keyEl.title = spec.description;
      else keyEl.removeAttribute('title');
    }

    if (spec && Array.isArray(spec.enum) && spec.enum.length) {
      valEl.placeholder = _enumPlaceholder(spec.enum);
      valEl.title = 'one of: ' + spec.enum.join(' | ') + '\n\n' + VALUE_PLACEHOLDER;
    } else {
      valEl.placeholder = VALUE_PLACEHOLDER;
      valEl.removeAttribute('title');
    }
  }

  // Build one row.
  //   spec        matching __meta param for `key` (null on the plain render
  //               path, where no meta is consulted)
  //   seeded      module-authored scaffolding — see ROW PROVENANCE above
  //   specByName  the ACTIVE schema, or null when there is none. Drives the
  //               undeclared warning and the live re-check.
  function _buildRow(key, value, opts, spec, seeded, specByName, fnLabel) {
    const datalistId = _datalistId(opts);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';

    // Markup is emitted NEUTRAL — every meta-driven attribute (required
    // marker, tooltips, enum placeholder, warning colors) is applied by
    // _decorate below, so the build path and the live re-check cannot drift.
    // The marker span is always emitted, blank when there is nothing to say,
    // to keep the columns aligned across rows.
    row.innerHTML = `
      <input class="${KEY_CLASS}" placeholder="param name" value="${esc(key)}" style="flex:1;padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px">
      <span class="${REQ_CLASS}" style="flex:0 0 7px;text-align:center;font-size:13px;font-weight:700;line-height:1"></span>
      <span style="color:var(--muted);font-size:14px">=</span>
      <input class="${VAL_CLASS} mono" list="${esc(datalistId)}" value="${esc(_display(value))}" style="flex:2;padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px">
      <button type="button" class="${DEL_CLASS}" style="padding:4px 8px;font-size:11px;background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;color:${REQ_COLOR}" title="Remove"><i class="fa-solid fa-times"></i></button>`;

    const keyEl = row.querySelector('.' + KEY_CLASS);

    _decorate(row, spec, !!(specByName && key !== '' && !specByName.has(key)), fnLabel);

    row.querySelector('.' + DEL_CLASS).addEventListener('click', () => row.remove());

    if (seeded) {
      row.dataset[SEED_KEY] = '1';
      // First keystroke in EITHER cell promotes the row to operator-owned, so
      // the next function switch keeps it. `once` per input is enough — both
      // handlers clear the same flag and re-marking never happens in place.
      const claim = () => { delete row.dataset[SEED_KEY]; };
      keyEl.addEventListener('input', claim, { once: true });
      row.querySelector('.' + VAL_CLASS).addEventListener('input', claim, { once: true });
    }

    if (specByName) {
      // `change` (fires on blur), not `input` — see UNDECLARED-KEY WARNING.
      keyEl.addEventListener('change', () => {
        const k = keyEl.value.trim();
        _decorate(row, k ? (specByName.get(k) || null) : null,
                  !!(k && !specByName.has(k)), fnLabel);
      });
    }

    return row;
  }

  // Repaint the container from an ordered [key, value, seeded?] list.
  // `specByName` may be null (plain render) — then no row is decorated.
  //
  // The active schema + label are stashed on the container so pmAddRow can
  // inherit them without the call site threading fnMeta through. They are
  // rewritten (or cleared) on every repaint, so a reopened dialog or a
  // function switch can never leave a stale schema behind.
  function _paint(containerEl, entries, opts, specByName) {
    const fnLabel = _fnLabel(opts);
    containerEl.__pmSpecs   = specByName || null;
    containerEl.__pmFnLabel = fnLabel;
    containerEl.innerHTML = _datalistHtml(_datalistId(opts));
    if (!entries.length) {
      containerEl.appendChild(_buildRow('', '', opts, null, false, specByName, fnLabel));
      return;
    }
    for (const [k, v, seeded] of entries) {
      const spec = specByName ? (specByName.get(k) || null) : null;
      containerEl.appendChild(_buildRow(k, v, opts, spec, !!seeded, specByName, fnLabel));
    }
  }

  // ── Public API ───────────────────────────────────────────────

  window.pmRender = function pmRender(containerEl, mapping, opts) {
    if (!containerEl) return;
    // Object.entries yields [k, v] — the absent 3rd slot reads as undefined,
    // so every stored row is painted operator-owned. That is deliberate: a
    // saved mapping is the operator's, whoever originally typed it.
    const entries = (mapping && typeof mapping === 'object' && !Array.isArray(mapping))
      ? Object.entries(mapping)
      : [];
    // No opts.fnMeta → null schema → undecorated, exactly as before.
    _paint(containerEl, entries, opts, _specMap(opts && opts.fnMeta));
  };

  window.pmAddRow = function pmAddRow(containerEl, opts) {
    if (!containerEl) return null;
    // Prefer an explicitly-passed schema, else the one the last paint left on
    // the container, so an added row warns as it is named.
    const specByName = _specMap(opts && opts.fnMeta) || containerEl.__pmSpecs || null;
    const fnLabel = (opts && opts.fnName)
      ? _fnLabel(opts)
      : (containerEl.__pmFnLabel || _fnLabel(opts));
    const row = _buildRow('', '', opts, null, false, specByName, fnLabel);
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
    // MINUS blank-key scaffold rows AND minus untouched seeds from the
    // previously-selected function. A key-but-no-value row the operator TYPED
    // is kept here — only pmCollect drops it, and only at save time.
    const base = (existingMapping && typeof existingMapping === 'object' && !Array.isArray(existingMapping))
      ? Object.entries(existingMapping)
      : _readRows(containerEl).filter(([k, , seeded]) => k !== '' && !seeded);

    const merged = base.map(([k, v]) => [k, v, false]);
    const seen   = new Set(merged.map(([k]) => k));

    for (const spec of specs) {
      if (!spec || !spec.name || seen.has(spec.name)) continue;
      seen.add(spec.name);
      // Quoted literal so resolveParamsMapping yields the default VALUE rather
      // than treating it as a dot-path: 0 → "'0'", 'Fwd:' → "'Fwd:'".
      const prefill = spec.default !== undefined ? "'" + String(spec.default) + "'" : '';
      merged.push([spec.name, prefill, true]);
    }

    _paint(containerEl, merged, opts, _specMap(fnMeta));
  };
})();