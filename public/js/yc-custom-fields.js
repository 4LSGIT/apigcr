/* public/js/yc-custom-fields.js — the Custom Fields section (custom-fields arc S4)
 *
 * ONE schema-driven renderer for `field_defs`, mounted on both record
 * surfaces (case.html → Overview; forms/contact-form.html → after Roles).
 * Design: ref/CUSTOM_FIELDS_DESIGN.md §2 (type map) and §3 (rules).
 * Operator chapter: manual/05-Subsystems/13-custom-fields.md.
 *
 * It is the generalization of the role-card renderer (contact-form.html
 * roleFieldHtml — whose charter says "deliberately not generalized"). That
 * one renders contact_role_types.attrs_schema, a DIFFERENT and smaller
 * vocabulary (text/url/number/select/multi_select, options as bare values).
 * The two schemas converging is a later question — design doc §9, "Registry
 * unification" — so this file imitates that renderer's shape and idiom
 * rather than sharing its code.
 *
 * ── WHAT IT OWNS ────────────────────────────────────────────────────────────
 *
 *   · Rendering one input per ACTIVE def, per its field_type.
 *   · `validation.required` — enforced HERE and only here. The write
 *     chokepoint deliberately does NOT check it (design doc §7 S4 row): a
 *     partial PATCH that omits a required key must not fail, or every
 *     automation and every aggregate form save breaks the moment an admin
 *     ticks Required.
 *   · `show_when` v1 — conditional display, evaluated client-side. See
 *     SHOW_WHEN below.
 *   · Sending ONLY the cf_ keys whose value actually changed, through the
 *     surface's existing update route. Everything else about the write —
 *     validation, the 255 cap, option membership, clearing — belongs to the
 *     chokepoint, and its 400/409 message is shown to staff VERBATIM.
 *
 * ── WHAT IT DOES NOT OWN ────────────────────────────────────────────────────
 *
 *   · It never writes core columns, and never rides an aggregate form save.
 *     Its Save is its own PATCH carrying cf_ keys and nothing else — the
 *     same fence the Roles section keeps ("Roles never ride the aggregate
 *     PATCH — per-card Save is the only writer").
 *   · It never validates a value itself. Mirroring the chokepoint's rules in
 *     JS would give staff two verdicts that drift apart; `maxlength` on text
 *     inputs is the one exception, and it is a typing aid, not a gate.
 *
 * ── DEGRADE QUIETLY ─────────────────────────────────────────────────────────
 *
 * Zero active defs → the section never renders (no empty state: a firm that
 * defines no custom fields must not grow a permanently empty panel on every
 * record). A failed def fetch → console.warn and stay hidden. A record page
 * must never break because the registry was unreachable.
 *
 * ── VALUES ──────────────────────────────────────────────────────────────────
 *
 * Read from the record payload the page already loaded — `GET /api/cases/:id`
 * and `GET /api/contacts/:id` are both `SELECT *`, so they carry the raw
 * `custom` bag AND S3's virtual cf_ columns. Both say the same thing on a
 * freshly fetched row (proved against a real engine), because the columns ARE
 * the bag — generated from it. normalizeValue folds either carrier to one
 * value: the bag holds what the chokepoint stored (a JSON number, true/false,
 * 'YYYY-MM-DD', an array), the columns arrive driver-coerced (DECIMAL as
 * '42.0000', TINYINT as 1/0, DATE as an ISO string).
 *
 * THE COLUMN WINS, and only falls back to the bag when the row has no such
 * column (a def created before the reconciler has run). The two disagree in
 * exactly one situation, and it is a common one: the sync bus. Its sniff
 * emits the PATCH body — `{cf_matter: 'M-8'}` — and the host Object.assigns
 * that onto its cached row, so after any write from another frame or tab the
 * COLUMN is current and the bag is whatever the last full GET returned. Bag
 * first meant a saved value visibly reverting on the next repaint.
 *
 * (Reading the bag in the browser is not the §3 "nothing compares on raw
 * custom->>'$.k'" rule: that rule is about SQL comparison surfaces, and this
 * is a display read of a staff payload. The bag reaching a STAFF page is the
 * §2 policy posture — what is structurally closed is the portal, envelopes,
 * reports, the resolver and external egress, all of which stay closed.)
 *
 * ── SHOW_WHEN v1 ────────────────────────────────────────────────────────────
 *
 *   { "field": "<core column | cf_ key, same entity>",
 *     "op":    "eq" | "ne" | "in" | "not_empty" | "empty",
 *     "value": <scalar for eq/ne, array for in, omitted for the two empties> }
 *
 * ONE condition, no nesting, no and/or. Evaluated against the record's
 * current values — the loaded row overlaid with whatever the staff member
 * has typed into this section — and re-evaluated on every change in it.
 *
 * Comparison follows services/hookFilter.js, the house's existing condition
 * vocabulary, so there is one mental model: eq/ne/in compare as STRINGS
 * (`String(actual) === String(want)`), with two deliberate refinements —
 * a boolean source compares as a boolean (so `value: 1` and `value: true`
 * both match a stored Yes), and a MULTISELECT source tests MEMBERSHIP
 * (`in`/`eq` ask "does the picked set contain this", which is the only
 * reading of an array that isn't a trap; the string form would compare
 * against the comma-joined list).
 *
 * ANYTHING THAT IS NOT EXACTLY THIS SHAPE — extra keys, a nested group, a
 * bad op, `in` without an array — is left STORED UNTOUCHED, treated as
 * "always show", and console.warned once. Strictness is the point: a later
 * v2 vocabulary must not be half-evaluated by v1 and silently hide fields.
 *
 * A REQUIRED FIELD HIDDEN BY show_when IS NOT ENFORCED. Required means
 * "visible and required" — the alternative is an unsaveable record whose
 * blocking field is off screen.
 *
 * ── EXPORTS ─────────────────────────────────────────────────────────────────
 *
 * Browser: `window.YCCustomFields`. Also CommonJS (the ycPager.js /
 * reportCharts.js idiom) so the pure halves — normalizeValue, show_when,
 * the required gate, the diff — are unit-testable without a DOM.
 */

(function (global) {
  'use strict';

  /** design doc §2 type map — the v1 vocabulary this renderer covers. */
  var FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'boolean'];

  /** show_when v1 operators. Extending this list is a doc change too. */
  var SHOW_WHEN_OPS = ['eq', 'ne', 'in', 'not_empty', 'empty'];

  /** The only keys a v1 show_when may carry. Anything else voids it. */
  var SHOW_WHEN_KEYS = ['field', 'op', 'value'];

  /** fieldDefService.STRING_MAX_LEN — the S3 VARCHAR width. A typing aid on
   *  text inputs only; the chokepoint is the gate and says so in its 400. */
  var STRING_MAX_LEN = 255;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
  }

  /** A value v1 knows how to compare. Anything richer belongs to a later
   *  vocabulary and voids the whole condition. */
  function isScalar(v) {
    return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  }

  /** "No value" across every type — the shape a cleared key has. */
  function isEmpty(v) {
    return v == null || v === '' || (Array.isArray(v) && v.length === 0);
  }

  /** The chokepoint's boolean vocabulary (fieldDefService.validateValue). */
  function toBool(v) {
    var b = typeof v === 'string' ? v.trim().toLowerCase() : v;
    if (b === true || b === 1 || b === '1' || b === 'true') return true;
    if (b === false || b === 0 || b === '0' || b === 'false') return false;
    return null;
  }

  /** A JS Date → 'YYYY-MM-DD' in UTC components.
   *
   *  The pool runs `timezone: 'Z'` (startup/db.js), so mysql2 builds a DATE at
   *  UTC midnight — 2026-09-25 becomes 2026-09-25T00:00:00.000Z. Reading LOCAL
   *  components off that is a DAY EARLY anywhere west of UTC, which is every
   *  staff machine here: FIRM_TZ is America/Detroit. (Measured: local
   *  components give 2026-09-24 under TZ=America/Detroit and the correct
   *  2026-09-25 under TZ=Asia/Jerusalem — which is why a developer east of UTC
   *  cannot reproduce it.)
   *
   *  In a browser this branch is unreachable today — JSON has no Date type, so
   *  a date always arrives as the ISO string the branch below slices. It fires
   *  for a Node caller holding a real mysql2 row, and it must be right there
   *  too, or a server-side consumer of valuesFrom silently shifts a day. */
  function dateOut(d) {
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  /**
   * Fold a value from either carrier (the `custom` bag or the driver-coerced
   * virtual column) into the bag's shape. `null` uniformly means "no value",
   * so the diff and the required gate need no per-type emptiness rules.
   */
  function normalizeValue(def, raw) {
    if (raw == null || raw === '') return null;
    switch (def && def.field_type) {
      case 'number': {
        var n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        return Number.isFinite(n) ? n : null;
      }
      case 'date': {
        if (raw instanceof Date) return isNaN(raw.getTime()) ? null : dateOut(raw);
        var s = String(raw);
        return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
      }
      case 'boolean':
        return toBool(raw);
      case 'multiselect': {
        var arr = raw;
        if (typeof arr === 'string') {
          try { arr = JSON.parse(arr); } catch (_) { return null; }
        }
        if (!Array.isArray(arr) || !arr.length) return null;
        return arr.map(String);
      }
      default:
        return String(raw);
    }
  }

  /**
   * Every value for one record, folded per def. The bag wins over the
   * columns: same data, better types (see VALUES in the header).
   */
  function valuesFrom(defs, record) {
    var row = record || {};
    var bag = isPlainObject(row.custom) ? row.custom
            : (typeof row.custom === 'string' ? safeParse(row.custom) : null);
    var out = {};
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var col = pick(row, d.field_key);
      var raw = col !== undefined
        ? col
        : (bag && Object.prototype.hasOwnProperty.call(bag, d.field_key) ? bag[d.field_key] : null);
      out[d.field_key] = normalizeValue(d, raw);
    }
    return out;
  }

  function safeParse(s) {
    try { var v = JSON.parse(s); return isPlainObject(v) ? v : null; } catch (_) { return null; }
  }

  /** Case-insensitive property read — MySQL column names are. */
  function pick(obj, key) {
    if (obj == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    var lk = String(key).toLowerCase();
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && k.toLowerCase() === lk) return obj[k];
    }
    return undefined;
  }

  // ─────────────────────────────────────────────────────────────
  // show_when v1
  // ─────────────────────────────────────────────────────────────

  var _warned = {};

  /**
   * Validate a stored show_when against the v1 shape.
   * @returns {{field,op,value}|null} null = always show (absent OR unreadable)
   */
  function parseShowWhen(showWhen, label) {
    if (showWhen == null) return null;
    var bad = function (why) {
      var tag = (label || '?') + ':' + why;
      if (!_warned[tag]) {
        _warned[tag] = 1;
        if (global.console && console.warn) {
          console.warn('[custom-fields] show_when on "' + (label || '?') + '" is not the v1 shape (' +
            why + ') — the field is always shown. Stored value left untouched.');
        }
      }
      return null;
    };
    if (!isPlainObject(showWhen)) return bad('not a single condition object');
    for (var k in showWhen) {
      if (Object.prototype.hasOwnProperty.call(showWhen, k) && SHOW_WHEN_KEYS.indexOf(k) < 0) {
        return bad('unknown key "' + k + '"');
      }
    }
    var field = showWhen.field, op = showWhen.op;
    if (typeof field !== 'string' || !field) return bad('missing field');
    if (SHOW_WHEN_OPS.indexOf(op) < 0) return bad('unknown op "' + op + '"');
    // The VALUE is type-checked too, not just present. A later vocabulary is
    // most likely to arrive by enriching this slot — `value: {ref: 'x'}`, or
    // `value: [{...}]` — and v1 must refuse the whole condition rather than
    // stringify the object and compare against '[object Object]'.
    if (op === 'in') {
      if (!Array.isArray(showWhen.value)) return bad('in needs an array value');
      if (!showWhen.value.length) return bad('in needs a non-empty array');
      if (!showWhen.value.every(isScalar)) return bad('in values must be scalars');
    } else if (op === 'eq' || op === 'ne') {
      if (showWhen.value === undefined) return bad(op + ' needs a value');
      if (!isScalar(showWhen.value)) return bad(op + ' needs a scalar value');
    } else if (showWhen.value !== undefined) {
      return bad(op + ' takes no value');
    }
    return { field: field, op: op, value: showWhen.value };
  }

  /** One scalar comparison — hookFilter's `equals`, plus the boolean refinement. */
  function scalarEq(actual, want) {
    if (typeof actual === 'boolean') return actual === toBool(want);
    return String(actual == null ? '' : actual) === String(want == null ? '' : want);
  }

  /**
   * Evaluate a PARSED condition against a record's current values.
   * A multiselect source (an array) tests membership — see SHOW_WHEN.
   */
  function evalShowWhen(cond, values) {
    if (!cond) return true;
    var actual = pick(values, cond.field);
    if (cond.op === 'not_empty') return !isEmpty(actual);
    if (cond.op === 'empty') return isEmpty(actual);

    var wants = cond.op === 'in' ? cond.value : [cond.value];
    var hit = wants.some(function (w) {
      return Array.isArray(actual)
        ? actual.some(function (a) { return scalarEq(a, w); })
        : scalarEq(actual, w);
    });
    return cond.op === 'ne' ? !hit : hit;
  }

  // ─────────────────────────────────────────────────────────────
  // Required gate + diff (pure)
  // ─────────────────────────────────────────────────────────────

  /**
   * Labels of the VISIBLE required fields left empty. Hidden fields are
   * exempt by design (see SHOW_WHEN) — a blocking field off screen is an
   * unsaveable record.
   */
  function requiredErrors(defs, values, visible) {
    var errs = [];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      if (!(d.validation && d.validation.required)) continue;
      if (visible && visible[d.field_key] === false) continue;
      if (isEmpty(values[d.field_key])) errs.push(d.label || d.field_key);
    }
    return errs;
  }

  /**
   * Changed keys only — compared as JSON text, exactly as the chokepoint's
   * buildCustomChanges does, so "changed" means the same thing on both ends.
   * A cleared key is sent as null (multiselect: []), the chokepoint's clear.
   */
  function diff(defs, baseline, current) {
    var out = {};
    for (var i = 0; i < defs.length; i++) {
      var k = defs[i].field_key;
      var from = baseline ? baseline[k] : null;
      var to = current[k];
      if (JSON.stringify(from == null ? null : from) === JSON.stringify(to == null ? null : to)) continue;
      out[k] = to == null ? (defs[i].field_type === 'multiselect' ? [] : null) : to;
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // Rendering
  // ─────────────────────────────────────────────────────────────

  /** Options a picker offers: active ones, plus any RETIRED value this record
   *  actually holds (design doc §3 — retired is hidden from pickers but still
   *  labels the records that hold it). */
  function optionsFor(def, value) {
    var held = Array.isArray(value) ? value.map(String) : (value == null ? [] : [String(value)]);
    var all = Array.isArray(def.options) ? def.options : [];
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var o = all[i];
      var retired = o.active === false;
      if (!retired || held.indexOf(String(o.value)) >= 0) {
        out.push({ value: String(o.value), label: String(o.label == null ? o.value : o.label), retired: retired });
      }
    }
    return out;
  }

  function fieldHtml(def, value) {
    var key = esc(def.field_key);
    var req = (def.validation && def.validation.required) ? ' <span class="ycf-req" title="Required">*</span>' : '';
    var label = '<label class="ycf-label" for="ycf-' + key + '">' + esc(def.label || def.field_key) + req + '</label>';
    var inner;

    if (def.field_type === 'select') {
      var opts = ['<option value=""></option>'];
      optionsFor(def, value).forEach(function (o) {
        var sel = (value != null && String(value) === o.value) ? ' selected' : '';
        opts.push('<option value="' + esc(o.value) + '"' + sel + '>' +
          esc(o.label) + (o.retired ? ' (retired)' : '') + '</option>');
      });
      inner = '<select id="ycf-' + key + '" data-ycf-key="' + key + '">' + opts.join('') + '</select>';

    } else if (def.field_type === 'multiselect') {
      var picked = Array.isArray(value) ? value.map(String) : [];
      inner = '<div class="ycf-checks">' + optionsFor(def, value).map(function (o) {
        var on = picked.indexOf(o.value) >= 0 ? ' checked' : '';
        return '<label class="ycf-check"><input type="checkbox" data-ycf-key="' + key +
          '" data-ycf-opt="' + esc(o.value) + '"' + on + '> ' +
          esc(o.label) + (o.retired ? ' <span class="ycf-retired">(retired)</span>' : '') + '</label>';
      }).join('') + '</div>';

    } else if (def.field_type === 'boolean') {
      // A SELECT, not a checkbox. Storage has three states — unset, true,
      // false — and a checkbox can only express two, so "No" would be
      // indistinguishable from "never answered". That is not cosmetic: a
      // REQUIRED boolean rendered as a checkbox can only ever be satisfied by
      // ticking it, i.e. the only saveable answer is Yes.
      inner = '<select id="ycf-' + key + '" data-ycf-key="' + key + '">' +
        '<option value=""' + (value == null ? ' selected' : '') + '></option>' +
        '<option value="1"' + (value === true ? ' selected' : '') + '>Yes</option>' +
        '<option value="0"' + (value === false ? ' selected' : '') + '>No</option>' +
        '</select>';

    } else if (def.field_type === 'date') {
      inner = '<input type="date" id="ycf-' + key + '" data-ycf-key="' + key +
        '" value="' + esc(value == null ? '' : value) + '">';

    } else if (def.field_type === 'number') {
      inner = '<input type="number" step="any" id="ycf-' + key + '" data-ycf-key="' + key +
        '" value="' + esc(value == null ? '' : value) + '">';

    } else {
      var max = (def.validation && Number.isInteger(def.validation.max_len))
        ? Math.min(def.validation.max_len, STRING_MAX_LEN) : STRING_MAX_LEN;
      inner = '<input type="text" id="ycf-' + key + '" data-ycf-key="' + key +
        '" maxlength="' + max + '" value="' + esc(value == null ? '' : value) + '">';
    }

    return '<div class="ycf-field" data-ycf-field="' + key + '">' + label + inner + '</div>';
  }

  /** Injected once per document — the section looks the same on both hosts,
   *  and neither page's stylesheet has to learn about it. case.html is in
   *  QUIRKS MODE (no doctype), so font-size is declared here rather than
   *  inherited. */
  var CSS = [
    '.ycf-wrap{font-size:13px;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-end}',
    '.ycf-field{display:flex;flex-direction:column;gap:3px;min-width:180px;flex:1 1 180px}',
    '.ycf-field.ycf-hidden{display:none}',
    '.ycf-label{font-size:11px;color:var(--text-muted,#777);font-weight:600}',
    '.ycf-field input[type=text],.ycf-field input[type=date],.ycf-field input[type=number],.ycf-field select{font-size:13px;padding:3px 5px;width:100%;box-sizing:border-box}',
    '.ycf-checks{display:flex;flex-wrap:wrap;gap:3px 12px;padding-top:3px}',
    '.ycf-check{font-weight:400;display:inline-flex;align-items:center;gap:4px}',
    '.ycf-req{color:var(--danger,#c00)}',
    '.ycf-retired{color:var(--text-muted,#777);font-size:11px}',
    '.ycf-foot{display:flex;align-items:center;gap:10px;margin-top:8px;flex-basis:100%}',
    '.ycf-status{font-size:11px;color:var(--text-muted,#777)}',
    '.ycf-status.ycf-err{color:var(--danger,#c00);white-space:pre-wrap}',
    '.ycf-status.ycf-ok{color:var(--accent-2,#2a7)}',
  ].join('');

  function injectCss(doc) {
    if (doc.getElementById('ycf-style')) return;
    var st = doc.createElement('style');
    st.id = 'ycf-style';
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  /** apiSend rejections carry the server message on .body.message (the
   *  contact-form idiom) or .message. 400/409 text is shown VERBATIM. */
  function errText(err) {
    return (err && err.body && err.body.message) || (err && err.message) || 'Unknown error';
  }

  // ─────────────────────────────────────────────────────────────
  // The section
  // ─────────────────────────────────────────────────────────────

  /**
   * @param {object}   o
   * @param {string}   o.entity      'case' | 'contact'
   * @param {Element}  o.host        the element to render into
   * @param {Element} [o.section]    shown/hidden as a whole (default: host)
   * @param {function} o.apiSend     (path, method, body) => Promise<body>
   * @param {string}   o.patchPath   e.g. '/api/cases/ABC' — cf_ keys only
   * @param {function}[o.onSaved]    (changedKeys[], values) after a good save
   * @param {boolean} [o.readOnly]
   */
  function create(o) {
    var host = o.host;
    var section = o.section || host;
    var doc = (host && host.ownerDocument) || global.document;
    var defs = null;      // active defs, sort_order order
    var baseline = null;  // values as loaded — the diff's left-hand side
    var record = null;    // the whole row, for show_when on core columns
    var visible = {};
    var bound = false;    // host listeners are attached once, not per render

    function show(on) { if (section) section.style.display = on ? '' : 'none'; }

    function status(msg, kind) {
      var el = doc.getElementById('ycfStatus');
      if (!el) return;
      el.textContent = msg || '';
      el.className = 'ycf-status' + (kind ? ' ycf-' + kind : '');
      if (kind === 'ok' && msg) {
        global.setTimeout(function () { if (el.textContent === msg) { el.textContent = ''; el.className = 'ycf-status'; } }, 3000);
      }
    }

    /** Current values: the inputs, folded per def. */
    function collect() {
      var out = {};
      for (var i = 0; i < defs.length; i++) {
        var d = defs[i], k = d.field_key;
        var els = host.querySelectorAll('[data-ycf-key="' + k.replace(/"/g, '') + '"]');
        if (!els.length) { out[k] = baseline ? baseline[k] : null; continue; }
        if (d.field_type === 'multiselect') {
          var on = [];
          Array.prototype.forEach.call(els, function (el) { if (el.checked) on.push(el.getAttribute('data-ycf-opt')); });
          out[k] = on.length ? on : null;
        } else {
          // boolean included: its select yields '' | '1' | '0', which
          // normalizeValue folds to null | true | false.
          out[k] = normalizeValue(d, els[0].value);
        }
      }
      return out;
    }

    /** The show_when context: the loaded row overlaid with what's on screen. */
    function context(values) {
      var ctx = {};
      var k;
      for (k in (record || {})) if (Object.prototype.hasOwnProperty.call(record, k)) ctx[k] = record[k];
      for (k in values) if (Object.prototype.hasOwnProperty.call(values, k)) ctx[k] = values[k];
      return ctx;
    }

    /** Re-evaluate visibility in place — never a re-render, or typing into a
     *  field that drives a show_when would lose focus on every keystroke. */
    function applyVisibility() {
      var ctx = context(collect());
      visible = {};
      for (var i = 0; i < defs.length; i++) {
        var d = defs[i];
        var on = evalShowWhen(parseShowWhen(d.show_when, d.label || d.field_key), ctx);
        visible[d.field_key] = on;
        var el = host.querySelector('[data-ycf-field="' + d.field_key.replace(/"/g, '') + '"]');
        if (el) el.className = 'ycf-field' + (on ? '' : ' ycf-hidden');
      }
    }

    /**
     * Lock or unlock the rendered controls. Exposed on the returned handle so
     * a host with its own view/edit toggle can drive it between renders,
     * instead of reaching into this section's DOM itself.
     */
    function setReadonly(on) {
      host.querySelectorAll('input, select').forEach(function (el) {
        if (el.tagName === 'SELECT' || el.type === 'checkbox') el.disabled = on;
        else el.readOnly = on;
      });
      var b = host.querySelector('.ycf-save');
      if (b) b.style.display = on ? 'none' : '';
    }

    /** Read-only NOW. `o.readOnly` may be a boolean or a thunk — a host whose
     *  view/edit state TOGGLES must pass the thunk, because a boolean is read
     *  once and a section rendered while the page happened to be in view mode
     *  would have no Save button and no way to grow one. */
    function readOnlyNow() {
      return typeof o.readOnly === 'function' ? !!o.readOnly() : !!o.readOnly;
    }

    function render() {
      var vals = baseline || {};
      var ro = readOnlyNow();
      host.innerHTML =
        '<div class="ycf-wrap">' +
        defs.map(function (d) { return fieldHtml(d, vals[d.field_key]); }).join('') +
        '<div class="ycf-foot">' +
        // ALWAYS rendered, hidden when read-only. A button that is absent
        // cannot be un-hidden by the host's own readonly toggle later.
        '<button type="button" class="ycf-save" id="ycfSave"' +
        (ro ? ' style="display:none"' : '') + '>Save</button>' +
        '<span class="ycf-status" id="ycfStatus"></span>' +
        '</div></div>';

      setReadonly(ro);
      var btn = doc.getElementById('ycfSave');
      if (btn) btn.addEventListener('click', save);
      // Once, explicitly. innerHTML replaces the children but not `host`, so
      // these survive a re-render and must not be re-added per paint. (They
      // would not actually pile up — addEventListener de-duplicates an
      // identical type/callback/capture triple, and applyVisibility is one
      // stable reference — but relying on that silently is a trap for the
      // next edit that wraps it in a closure.)
      if (!bound) {
        bound = true;
        host.addEventListener('change', applyVisibility);
        host.addEventListener('input', applyVisibility);
      }
      applyVisibility();
      show(true);
    }

    async function save() {
      var btn = doc.getElementById('ycfSave');
      var values = collect();
      applyVisibility();

      var missing = requiredErrors(defs, values, visible);
      if (missing.length) {
        return status('Required: ' + missing.join(', '), 'err');
      }
      var patch = diff(defs, baseline, values);
      var keys = Object.keys(patch);
      if (!keys.length) return status('No changes', 'ok');

      if (btn) btn.disabled = true;
      status('Saving…');
      try {
        await o.apiSend(o.patchPath, 'PATCH', patch);
        baseline = values;
        status('Saved', 'ok');
        if (o.onSaved) o.onSaved(keys, values);
      } catch (err) {
        status(errText(err), 'err');   // 400/409 from the chokepoint, verbatim
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    /**
     * Fetch the registry and paint. Safe to call again on a record reload.
     * Never throws: a registry that can't be read leaves the section hidden.
     * @param {object} rec the loaded record row (SELECT * shaped)
     */
    async function load(rec) {
      record = rec || null;
      try {
        if (!defs) {
          var resp = await o.apiSend('/api/field-defs', 'GET', { entity: o.entity });
          defs = (resp && resp.defs ? resp.defs : [])
            .filter(function (d) { return d.active && FIELD_TYPES.indexOf(d.field_type) >= 0; });
        }
      } catch (err) {
        if (global.console && console.warn) console.warn('[custom-fields] defs load failed:', errText(err));
        defs = null;
        return show(false);
      }
      if (!defs.length) return show(false);   // no defs, no section — by design

      // A REPAINT MUST NOT EAT AN UNSAVED EDIT. Hosts call load() again on
      // every refresh — a sibling form saving, a sync-bus message, another
      // tab writing the record — and a blind re-render would discard whatever
      // is half-typed here, invisibly. Same fence the case-notes textarea
      // keeps, and derived the same way: a comparison, never a latch. The
      // show_when context still updates, so a core column changed elsewhere
      // still shows/hides the right fields.
      // …and it must not steal FOCUS either. render() replaces the section
      // with innerHTML, which blurs whatever is focused and closes an open
      // picker, so a host that repaints on a timer or a bus message could
      // take the caret out of a field mid-edit even before anything is typed
      // (a click into a select, then a sibling form saves).
      if (baseline && (host.contains(doc.activeElement) ||
                       Object.keys(diff(defs, baseline, collect())).length)) {
        return applyVisibility();
      }
      injectCss(doc);
      baseline = valuesFrom(defs, record);
      render();
    }

    return {
      load: load, save: save, setReadonly: setReadonly,
      _collect: collect, _defs: function () { return defs; },
    };
  }

  var api = {
    create: create,
    // pure halves — exported for tests and for anyone who needs the rules
    normalizeValue: normalizeValue,
    valuesFrom: valuesFrom,
    parseShowWhen: parseShowWhen,
    evalShowWhen: evalShowWhen,
    requiredErrors: requiredErrors,
    diff: diff,
    optionsFor: optionsFor,
    FIELD_TYPES: FIELD_TYPES,
    SHOW_WHEN_OPS: SHOW_WHEN_OPS,
    STRING_MAX_LEN: STRING_MAX_LEN,
  };

  global.YCCustomFields = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
