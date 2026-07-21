// public/esign/placementEditor.js
//
// ─────────────────────────────────────────────────────────────
// PLACEMENT EDITOR — visual signature-field authoring (Phase 2D).
//
// Loaded like esignActions.js: a plain <script src> on non-module pages
// (esign/templateAdmin.html today; the Phase 4 upload-PDF send flow later),
// exposing its API on `window`. The component is SEND-FLOW-AGNOSTIC on
// purpose: it takes any PDF ArrayBuffer + a neutral placement JSON and hands
// back an edited neutral placement JSON. It knows nothing about templates.
//
// TWO SECTIONS, mirroring esignActions.js:
//
//   1. PURE HELPERS — no DOM, no network, no pdf.js require. The viewport↔
//      neutral coordinate transforms, min-size/clamp/round normalization,
//      the canonical field sort, and the template-admin mirrors (placeholder
//      scan, prefill-schema row validation, basics validation). The admin
//      mirrors live HERE rather than inline in templateAdmin.html because the
//      repo's test environment is node-only jest — an .html file can't be
//      require()d, this file can (guarded module.exports below, same idiom as
//      esignActions.js). templateAdmin.html loads this script anyway.
//
//      MIRROR WARNING: the validation mirrors restate SERVER rules —
//      services/esignTemplateService.js (KEY_RE, name/kind/label/expiration
//      bounds, PLACEHOLDER_RE) and services/esign/placements.js (field types,
//      1-based pages). The server remains authoritative; these exist for UX.
//      tests/esignPlacementEditor.test.js drift-guards them against the real
//      service exports.
//
//   2. BROWSER SECTION — the PlacementEditor component (pdf.js rendering,
//      draw/move/resize/delete interactions, zoom). Guarded behind
//      `typeof window !== 'undefined'`.
//
// ── COORDINATES: THE WHOLE GAME ──────────────────────────────
// pdf.js renders each page into a VIEWPORT: top-left origin, CSS pixels,
// scaled. The neutral placement schema (services/esign/placements.js) is PDF
// USER SPACE: bottom-left origin, points, x from the page's LEFT edge and y
// from its BOTTOM edge — i.e. relative to the VISIBLE page (the cropbox),
// because that is what the Zoho provider's percentage math divides by.
//
// The transforms below therefore:
//   • use the viewport's own convertToPdfPoint / convertToViewportPoint —
//     pdf.js's inverse/forward page transform, which is correct under any
//     page rotation and any scale, and
//   • subtract / add the page's viewBox origin (viewport.viewBox[0..1]),
//     so a PDF whose cropbox does not start at (0,0) still yields
//     "points from the visible page's bottom-left corner". For the app's own
//     chromium-rendered PDFs the viewBox origin is (0,0) and this is a no-op;
//     for arbitrary uploaded PDFs (Phase 4) it is the difference between a
//     signature on the line and a signature in the margin.
//
// Both corners of the rect are converted and min/abs-normalized, so the pair
// round-trips exactly (float noise only) at every zoom and rotation.
// ─────────────────────────────────────────────────────────────

/* ══════════════════════════════════════════════════════════════
   SECTION 1 — PURE HELPERS (node-safe, Jest-covered)
   ══════════════════════════════════════════════════════════════ */

/** Neutral field types — mirror of services/esign/placements.js
    NEUTRAL_FIELD_TYPES (drift-guarded by tests). */
var PE_FIELD_TYPES = ['signature', 'initial', 'date', 'text',
  'input_text', 'checkbox', 'dropdown', 'radio'];

/** Minimum field sizes in PDF POINTS (2D spec). Enforced in points — never in
    pixels — so the floor is the same physical size at every zoom. */
var PE_MIN_SIZES = {
  signature:  { w: 120, h: 24 },
  initial:    { w: 40,  h: 18 },
  date:       { w: 60,  h: 16 },
  text:       { w: 60,  h: 14 },
  // Phase 2F signer-input types. checkbox/radio are square-ish tick targets
  // (Zoho renders the control inside the box); input_text/dropdown match the
  // text-entry family.
  input_text: { w: 60,  h: 14 },
  checkbox:   { w: 12,  h: 12 },
  dropdown:   { w: 60,  h: 16 },
  radio:      { w: 12,  h: 12 },
};

/** Signer color code (2D spec: pick one and document it).
    Signer 1 = blue #2563eb, signer 2 = green #059669. Green matches the
    'signed' chip family in esignActions.js; blue is the app's link-ish blue
    family. Consistent with nothing else by design — it only means "signer". */
var PE_SIGNER_COLORS = { 1: '#2563eb', 2: '#059669' };

/** Text (fill-in) fields — amber, deliberately outside the signer family:
    a text box is OURS to fill (pdfFill draws the value before sending),
    not a signer's. */
var PE_TEXT_COLOR = '#d97706';

/** Signer-field tag: the author's label when set, else TYPE · S#. */
function peSignerTag(f) {
  // Radio boxes have no label — the tag shows GROUP · VALUE so two circles of
  // the same group read as siblings at a glance, plus the signer.
  if (f.type === 'radio') {
    return (f.group || '?') + ': ' + (f.value || '?') + ' \u00b7 S' + f.signer;
  }
  var TAG_NAMES = { input_text: 'INPUT', checkbox: 'CHECK', dropdown: 'DROP' };
  return f.label
    ? f.label + ' \u00b7 S' + f.signer
    : (TAG_NAMES[f.type] || f.type.toUpperCase()) + ' \u00b7 S' + f.signer;
}

/** Dropdown options come from ONE comma-separated toolbar input. Trim, drop
    empties, keep order, keep duplicates — the server validator is the voice
    that rejects dupes, and silently deduping here would make the saved value
    disagree with what the author can see in the input. */
function peParseOptions(str) {
  if (typeof str !== 'string') return [];
  return str.split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

/**
 * Copy a signer field's Phase 2F per-type properties from `src` onto `out`,
 * sanitized. ONE function on purpose: it runs on the way IN (_seed) and on
 * the way OUT (getPlacements), so the two can never disagree about which
 * properties survive the round-trip — a property dropped on either leg is a
 * property silently STRIPPED from the stored template on the next save.
 * Pure and exported so jest (node-only) can cover the round-trip even though
 * the component itself is browser-guarded.
 */
function peCarryProps(src, out) {
  if (src.type === 'input_text') {
    if (typeof src.max_length === 'number' && src.max_length >= 1) out.max_length = Math.floor(src.max_length);
    if (typeof src.default === 'string' && src.default) out.default = src.default;
  } else if (src.type === 'checkbox') {
    if (src.checked === true) out.checked = true;
  } else if (src.type === 'dropdown') {
    out.options = Array.isArray(src.options)
      ? src.options.filter(function (o) { return typeof o === 'string' && o.trim(); })
                   .map(function (o) { return o.trim(); })
      : [];
    if (typeof src.default === 'string' && src.default.trim()) out.default = src.default.trim();
  } else if (src.type === 'radio') {
    out.group = typeof src.group === 'string' ? src.group.trim() : '';
    out.value = typeof src.value === 'string' ? src.value.trim() : '';
    if (src.checked === true) out.checked = true;
  }
  return out;
}

// ── validation mirrors of services/esignTemplateService.js ──
// (server authoritative; tests drift-guard KEY_RE + types by import and the
//  unexported bounds behaviorally via validateTemplateInput)
var PE_KEY_RE   = /^[a-z][a-z0-9_]{0,39}$/;
var PE_NAME_MIN = 3,  PE_NAME_MAX = 128;
var PE_KIND_MAX = 64;
var PE_LABEL_MIN = 1, PE_LABEL_MAX = 80;
var PE_EXP_MIN  = 1,  PE_EXP_MAX  = 90;
/** Mirror of PLACEHOLDER_RE — /\{\{([^{}]*)\}\}/g with trim + first-seen dedupe. */
var PE_PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

// ─── coordinate transforms ───────────────────────────────────

/**
 * Viewport-space rect (CSS px, top-left origin) → neutral field geometry
 * (points, from the visible page's bottom-left corner).
 *
 * `viewport` is a pdf.js PageViewport (or anything implementing
 * convertToPdfPoint(x, y) → [ux, uy] and carrying viewBox). Both corners are
 * converted, then min/abs-normalized — correct under rotation, where "top
 * left in viewport" is not "top left on the page".
 *
 * @param {{x:number,y:number,w:number,h:number}} rectPx
 * @param {object} viewport
 * @returns {{x:number,y:number,w:number,h:number}} points (unrounded)
 */
function peViewportToNeutral(rectPx, viewport) {
  var vb = viewport.viewBox;
  var p1 = viewport.convertToPdfPoint(rectPx.x, rectPx.y);
  var p2 = viewport.convertToPdfPoint(rectPx.x + rectPx.w, rectPx.y + rectPx.h);
  return {
    x: Math.min(p1[0], p2[0]) - vb[0],
    y: Math.min(p1[1], p2[1]) - vb[1],
    w: Math.abs(p2[0] - p1[0]),
    h: Math.abs(p2[1] - p1[1]),
  };
}

/**
 * Neutral field geometry → viewport-space rect (CSS px, top-left origin) for
 * the CURRENT viewport. The exact inverse of peViewportToNeutral.
 *
 * @param {{x:number,y:number,w:number,h:number}} field  points
 * @param {object} viewport  pdf.js PageViewport (convertToViewportPoint + viewBox)
 * @returns {{x:number,y:number,w:number,h:number}} CSS px
 */
function peNeutralToViewport(field, viewport) {
  var vb = viewport.viewBox;
  var p1 = viewport.convertToViewportPoint(field.x + vb[0], field.y + vb[1]);
  var p2 = viewport.convertToViewportPoint(field.x + field.w + vb[0],
                                           field.y + field.h + vb[1]);
  return {
    x: Math.min(p1[0], p2[0]),
    y: Math.min(p1[1], p2[1]),
    w: Math.abs(p2[0] - p1[0]),
    h: Math.abs(p2[1] - p1[1]),
  };
}

/** Visible-page size in points from a viewport's viewBox — rotation-proof
    (viewport.width/height swap under 90°/270°; the viewBox never does). */
function pePageSize(viewport) {
  var vb = viewport.viewBox;
  return { w: Math.abs(vb[2] - vb[0]), h: Math.abs(vb[3] - vb[1]) };
}

/** Snap a rect (points) up to the type's minimum size. Unknown type → the
    smallest floor (date) so nothing degenerates to a zero-area box. */
function peEnforceMin(rect, type) {
  var min = PE_MIN_SIZES[type] || PE_MIN_SIZES.date;
  return {
    x: rect.x, y: rect.y,
    w: Math.max(rect.w, min.w),
    h: Math.max(rect.h, min.h),
  };
}

/**
 * Clamp a rect (points) into the page [0,pageW]×[0,pageH]. Oversized rects
 * are shrunk to the page; in-size rects are shifted, not shrunk.
 */
function peClampToPage(rect, pageW, pageH) {
  var w = Math.min(rect.w, pageW);
  var h = Math.min(rect.h, pageH);
  var x = Math.min(Math.max(rect.x, 0), pageW - w);
  var y = Math.min(Math.max(rect.y, 0), pageH - h);
  return { x: x, y: y, w: w, h: h };
}

/** Round to 0.01pt — the storage precision. (Tests require round-trips exact
    to 0.1pt; storing at 0.01pt keeps px-space error invisible at all zooms.) */
function peRound(n) { return Math.round(n * 100) / 100; }

/**
 * Full commit-time normalization: min size (points) → clamp to page → round.
 * Order matters — the min floor first, so clamping a floored box near an edge
 * shifts it inward instead of letting the edge shrink it below the floor.
 */
function peNormalizeRect(rect, type, pageW, pageH) {
  var r = peClampToPage(peEnforceMin(rect, type), pageW, pageH);
  return { x: peRound(r.x), y: peRound(r.y), w: peRound(r.w), h: peRound(r.h) };
}

/** Canonical output order (2D spec): page asc, y DESC (top of page first —
    y is from the bottom), x asc. Returns a sorted copy. */
function peSortFields(fields) {
  return (Array.isArray(fields) ? fields.slice() : []).sort(function (a, b) {
    if (a.page !== b.page) return a.page - b.page;
    if (a.y !== b.y) return b.y - a.y;
    return a.x - b.x;
  });
}

// ─── template-admin mirrors ──────────────────────────────────

/** Mirror of esignTemplateService.extractPlaceholders: unique {{keys}} in
    first-appearance order, trimmed. Drift-guarded against the real one. */
function peExtractPlaceholders(body) {
  var seen = {};
  var out = [];
  var m;
  PE_PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PE_PLACEHOLDER_RE.exec(String(body == null ? '' : body))) !== null) {
    var key = m[1].trim();
    if (!Object.prototype.hasOwnProperty.call(seen, key)) {
      seen[key] = true;
      out.push(key);
    }
  }
  return out;
}

/**
 * Body ↔ schema cross-check for the live chip display.
 * @returns {{placeholders:string[], undeclared:string[], unused:string[]}}
 *   undeclared — in the body, not in the schema (server BLOCKS save)
 *   unused     — in the schema, not in the body (server warns only)
 */
function peScanBody(body, schemaKeys) {
  var placeholders = peExtractPlaceholders(body);
  var keys = {};
  (schemaKeys || []).forEach(function (k) { keys[k] = true; });
  var inBody = {};
  placeholders.forEach(function (p) { inBody[p] = true; });
  return {
    placeholders: placeholders,
    undeclared: placeholders.filter(function (p) { return !keys[p]; }),
    unused: (schemaKeys || []).filter(function (k) { return !inBody[k]; }),
  };
}

/**
 * One prefill-schema row → error strings (empty = valid). Mirrors the server
 * checks a row can fail on its own; duplicate keys are a rows-level concern
 * (peValidateSchemaRows).
 * @param {object} row  {key,label,type,resolver,default,required}
 * @param {object} opts {types:[], resolvers:[]} from GET /api/esign/template-meta
 */
function peValidateSchemaRow(row, opts) {
  var errs = [];
  var types = (opts && opts.types) || ['text', 'number', 'date', 'money'];
  var key = String(row && row.key != null ? row.key : '');
  if (!PE_KEY_RE.test(key)) {
    errs.push('key: lowercase letter first, then lowercase letters, digits or underscores, at most 40 characters');
  }
  var label = String(row && row.label != null ? row.label : '').trim();
  if (label.length < PE_LABEL_MIN || label.length > PE_LABEL_MAX) {
    errs.push('label: ' + PE_LABEL_MIN + '\u2013' + PE_LABEL_MAX + ' characters');
  }
  if (types.indexOf(row && row.type) === -1) {
    errs.push('type: one of ' + types.join(', '));
  }
  if (row && row.resolver != null && opts && Array.isArray(opts.resolvers) &&
      opts.resolvers.indexOf(row.resolver) === -1 &&
      // 2E: a {{…}} EXPRESSION is legal too — table/column policy and column
      // existence are the SERVER's save-time checks (esignTemplateService);
      // the inline mirror only refuses what could never be either form.
      !(typeof row.resolver === 'string' &&
        row.resolver.length > 4 &&
        row.resolver.slice(0, 2) === '{{' && row.resolver.slice(-2) === '}}')) {
    errs.push('resolver: unknown name (or wrap a custom expression in {{ }})');
  }
  return errs;
}

/**
 * All rows: per-row errors + duplicate-key detection.
 * @returns {{rowErrors:Array<string[]>, dupKeys:string[], ok:boolean}}
 */
function peValidateSchemaRows(rows, opts) {
  var list = Array.isArray(rows) ? rows : [];
  var counts = {};
  list.forEach(function (r) {
    var k = String(r && r.key != null ? r.key : '');
    counts[k] = (counts[k] || 0) + 1;
  });
  var dupKeys = Object.keys(counts).filter(function (k) { return k && counts[k] > 1; });
  var rowErrors = list.map(function (r) {
    var errs = peValidateSchemaRow(r, opts);
    var k = String(r && r.key != null ? r.key : '');
    if (k && counts[k] > 1) errs.push('key: duplicate');
    return errs;
  });
  return {
    rowErrors: rowErrors,
    dupKeys: dupKeys,
    ok: rowErrors.every(function (e) { return e.length === 0; }),
  };
}

/** Basics-section mirror: name / kind / expiration_days. */
function peValidateBasics(o) {
  var errs = [];
  var name = String(o && o.name != null ? o.name : '').trim();
  if (name.length < PE_NAME_MIN || name.length > PE_NAME_MAX) {
    errs.push('Template name must be ' + PE_NAME_MIN + '\u2013' + PE_NAME_MAX + ' characters.');
  }
  var kind = String(o && o.kind != null ? o.kind : '').trim();
  if (kind.length < 1 || kind.length > PE_KIND_MAX) {
    errs.push('Template kind must be 1\u2013' + PE_KIND_MAX + ' characters.');
  }
  var exp = Number(o && o.expirationDays);
  if (!(Number.isInteger ? Number.isInteger(exp) : exp === Math.floor(exp)) ||
      exp < PE_EXP_MIN || exp > PE_EXP_MAX) {
    errs.push('Expiration must be a whole number between ' + PE_EXP_MIN + ' and ' + PE_EXP_MAX + ' days.');
  }
  return errs;
}

/* Guarded export — tests/esignPlacementEditor.test.js requires the pure
   section under node jest. In the browser `module` is undefined. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PE_FIELD_TYPES: PE_FIELD_TYPES,
    PE_MIN_SIZES: PE_MIN_SIZES,
    PE_SIGNER_COLORS: PE_SIGNER_COLORS,
    PE_KEY_RE: PE_KEY_RE,
    PE_NAME_MIN: PE_NAME_MIN, PE_NAME_MAX: PE_NAME_MAX,
    PE_KIND_MAX: PE_KIND_MAX,
    PE_LABEL_MIN: PE_LABEL_MIN, PE_LABEL_MAX: PE_LABEL_MAX,
    PE_EXP_MIN: PE_EXP_MIN, PE_EXP_MAX: PE_EXP_MAX,
    peViewportToNeutral: peViewportToNeutral,
    peNeutralToViewport: peNeutralToViewport,
    pePageSize: pePageSize,
    peEnforceMin: peEnforceMin,
    peClampToPage: peClampToPage,
    peRound: peRound,
    peNormalizeRect: peNormalizeRect,
    peSortFields: peSortFields,
    peExtractPlaceholders: peExtractPlaceholders,
    peScanBody: peScanBody,
    peValidateSchemaRow: peValidateSchemaRow,
    peValidateSchemaRows: peValidateSchemaRows,
    peValidateBasics: peValidateBasics,
    peSignerTag: peSignerTag,
    peParseOptions: peParseOptions,
    peCarryProps: peCarryProps,
  };
}

/* ══════════════════════════════════════════════════════════════
   SECTION 2 — BROWSER ONLY (the component)
   ══════════════════════════════════════════════════════════════ */
if (typeof window !== 'undefined') (function () {
  'use strict';

  // ── styles (guarded single injection — esignActions.js idiom) ──
  function injectStyles() {
    if (document.getElementById('pe-styles')) return;
    var style = document.createElement('style');
    style.id = 'pe-styles';
    style.textContent = [
      '.pe-root { text-align:left; }',
      '.pe-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap;',
      '  padding:8px 10px; background:#f7f7f7; border:1px solid #ddd;',
      '  border-radius:4px 4px 0 0; font-size:13px; position:sticky; top:0; z-index:5; }',
      '.pe-toolbar label { font-weight:bold; }',
      '.pe-toolbar select { padding:4px 6px; }',
      '.pe-toolbar input.pe-jump { width:52px; padding:4px 6px; }',
      '.pe-toolbar input.pe-maxlen { width:60px; padding:4px 6px; }',
      '.pe-toolbar .pe-inline { font-weight:normal; white-space:nowrap; }',
      '.pe-itext-wrap, .pe-check-wrap, .pe-drop-wrap, .pe-radio-wrap, .pe-signer-wrap, .pe-label-wrap, .pe-key-wrap {',
      '  display:inline-flex; align-items:center; gap:6px; }',
      '.pe-hint { color:#888; font-size:11px; }',
      '.pe-pages { border:1px solid #ddd; border-top:none; border-radius:0 0 4px 4px;',
      '  background:#e5e7eb; max-height:75vh; overflow:auto; padding:14px 0; }',
      '.pe-page { position:relative; margin:0 auto 8px; box-shadow:0 1px 4px rgba(0,0,0,.35);',
      '  background:#fff; }',
      '.pe-page canvas { display:block; }',
      '.pe-overlay { position:absolute; inset:0; cursor:crosshair; }',
      '.pe-pagelabel { text-align:center; color:#6b7280; font-size:11px; margin:0 0 12px; }',
      '.pe-box { position:absolute; box-sizing:border-box; border:2px solid;',
      '  background:rgba(37,99,235,.12); cursor:move; font-size:10px; }',
      '.pe-box.pe-s2 { background:rgba(5,150,105,.12); }',
      '.pe-box.pe-text { background:rgba(217,119,6,.10); }',
      '.pe-box .pe-tag { position:absolute; top:-1px; left:-1px; color:#fff;',
      '  font-weight:bold; font-size:9px; padding:0 4px; border-radius:0 0 3px 0;',
      '  white-space:nowrap; pointer-events:none; line-height:13px; }',
      '.pe-box.pe-selected { border-style:solid; box-shadow:0 0 0 2px rgba(255,255,255,.7),',
      '  0 0 0 4px rgba(0,0,0,.25); z-index:3; }',
      '.pe-handle { position:absolute; right:-6px; bottom:-6px; width:11px; height:11px;',
      '  border:1px solid #fff; border-radius:2px; cursor:nwse-resize; display:none; }',
      '.pe-box.pe-selected .pe-handle { display:block; }',
      '.pe-ctl { position:absolute; top:-20px; right:-1px; display:none; gap:2px; }',
      '.pe-box.pe-selected .pe-ctl { display:flex; }',
      '.pe-ctl button { font-size:10px; padding:0 5px; line-height:16px; border:1px solid #999;',
      '  border-radius:3px; background:#fff; cursor:pointer; }',
      '.pe-rubber { position:absolute; border:1.5px dashed #374151;',
      '  background:rgba(55,65,81,.08); pointer-events:none; }',
      '.pe-empty { padding:30px; text-align:center; color:#888; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  /**
   * PlacementEditor(container, opts)
   *
   *   opts.onChange   fn()     — fired after any field mutation (dirty tracking)
   *   opts.pdfjs      object   — pdf.js lib; default window.pdfjsLib
   *   opts.workerSrc  string   — set on GlobalWorkerOptions if given
   *
   * API:
   *   await loadPdf(arrayBuffer, placementJson)  render + seed fields
   *   getPlacements() → neutral JSON (sorted)
   *   setPlacements(json)                        replace fields, re-render
   *   setZoom(pct)                               75/100/125/150
   *   hasDocument() → bool
   *   destroy()
   */
  function PlacementEditor(container, opts) {
    if (!(this instanceof PlacementEditor)) return new PlacementEditor(container, opts);
    injectStyles();
    this.opts = opts || {};
    this.pdfjs = this.opts.pdfjs || window.pdfjsLib;
    if (!this.pdfjs) throw new Error('pdf.js (pdfjsLib) is not loaded');
    if (this.opts.workerSrc && this.pdfjs.GlobalWorkerOptions) {
      this.pdfjs.GlobalWorkerOptions.workerSrc = this.opts.workerSrc;
    }
    this.container = container;
    this.pdfDoc = null;
    this.zoom = 100;
    this.fields = [];          // neutral coords + {uid, type, signer}
    this.selectedUid = null;
    this.viewports = {};       // 1-based page → PageViewport (CSS-px space)
    this._uid = 0;
    this._drawType = 'signature';
    this._drawSigner = 1;
    this._drawKey = '';        // key applied to the NEXT drawn text field
    // Phase 2F sticky draw-state — same idiom as _drawKey: the toolbar value
    // is applied to the NEXT drawn box of its type AND live-updates the
    // selected one. `checked` is deliberately NOT sticky: a default belongs
    // to one box, and drawing five pre-checked checkboxes by accident is
    // exactly the mistake stickiness would make easy.
    this._drawMaxLen  = null;  // input_text
    this._drawDefault = '';    // input_text prefill
    this._drawOptions = [];    // dropdown choices
    this._drawDdDefault = '';  // dropdown default
    this._drawGroup   = '';    // radio group (sticky ACROSS boxes of a group)
    this._drawValue   = '';    // radio option value
    this._renderSeq = 0;
    this._scrollRaf = null;

    // The type dropdown shows friendly names; values stay the neutral types.
    var PE_TYPE_NAMES = {
      signature: 'Signature', initial: 'Initial', date: 'Date',
      text: 'Text (we fill)', input_text: 'Text input (signer)',
      checkbox: 'Checkbox', dropdown: 'Dropdown', radio: 'Radio option',
    };

    container.classList.add('pe-root');
    container.innerHTML =
      '<div class="pe-toolbar">' +
        '<label>Field:</label>' +
        '<select class="pe-type">' +
          PE_FIELD_TYPES.map(function (t) {
            return '<option value="' + t + '">' + (PE_TYPE_NAMES[t] || t) + '</option>';
          }).join('') +
        '</select>' +
        '<span class="pe-signer-wrap"><label>Signer:</label>' +
        '<select class="pe-signer">' +
          '<option value="1" style="color:' + PE_SIGNER_COLORS[1] + '">1 (blue)</option>' +
          '<option value="2" style="color:' + PE_SIGNER_COLORS[2] + '">2 (green)</option>' +
        '</select>' +
        // What the SIGNER SEES rendered in the box on Zoho's signing page.
        // Optional; empty falls back to the provider's Type_N naming. Its own
        // wrap because RADIO hides it (the group name is the display name)
        // while keeping the signer select.
        '<span class="pe-label-wrap"><label>Shown to signer:</label>' +
        '<input class="pe-label" size="14" maxlength="60" placeholder="e.g. Client initials" ' +
          'spellcheck="false" autocomplete="off"></span>' +
        '</span>' +
        // Text fields carry a KEY instead of a signer; the two controls swap
        // visibility with the type. keySuggest (opts) feeds the datalist so
        // templateAdmin can offer the schema's declared keys.
        '<span class="pe-key-wrap" style="display:none"><label>Key:</label>' +
        '<input class="pe-key" list="pe-key-list" size="16" placeholder="prefill key" ' +
          'spellcheck="false" autocomplete="off">' +
        '<datalist id="pe-key-list">' +
          ((this.opts.keySuggest || []).map(function (k) {
            return '<option value="' + String(k).replace(/"/g, '&quot;') + '">';
          }).join('')) +
        '</datalist></span>' +
        // ── Phase 2F per-type property clusters — exactly one visible at a
        //    time (or none), driven by _syncToolbarMode.
        '<span class="pe-itext-wrap" style="display:none">' +
          '<label>Max len:</label>' +
          '<input class="pe-maxlen" type="number" min="1" max="2048" placeholder="\u2013" ' +
            'title="Longest answer the signer can type (blank = no cap)">' +
          '<label>Prefill:</label>' +
          '<input class="pe-itext-default" size="12" placeholder="optional" ' +
            'title="Pre-typed text the signer can edit" spellcheck="false" autocomplete="off">' +
        '</span>' +
        '<span class="pe-check-wrap" style="display:none">' +
          '<label class="pe-inline"><input class="pe-checked" type="checkbox"> Pre-checked</label>' +
        '</span>' +
        '<span class="pe-drop-wrap" style="display:none">' +
          '<label>Options:</label>' +
          '<input class="pe-options" size="24" placeholder="Chapter 7, Chapter 13, \u2026" ' +
            'title="The choices, comma-separated, in order" spellcheck="false" autocomplete="off">' +
          '<label>Default:</label>' +
          '<input class="pe-dd-default" size="10" placeholder="optional" ' +
            'title="Pre-selected option (must be one of the choices)" spellcheck="false" autocomplete="off">' +
        '</span>' +
        '<span class="pe-radio-wrap" style="display:none">' +
          '<label>Group:</label>' +
          '<input class="pe-group" size="10" maxlength="100" placeholder="e.g. Approve?" ' +
            'title="Boxes sharing a group are one pick-one question; the group name is what the signer sees" ' +
            'spellcheck="false" autocomplete="off">' +
          '<label>Option:</label>' +
          '<input class="pe-value" size="8" maxlength="100" placeholder="e.g. Yes" ' +
            'title="What picking THIS circle means" spellcheck="false" autocomplete="off">' +
          '<label class="pe-inline"><input class="pe-radio-checked" type="checkbox"> Default</label>' +
        '</span>' +
        '<label>Zoom:</label>' +
        '<select class="pe-zoom">' +
          '<option value="75">75%</option><option value="100" selected>100%</option>' +
          '<option value="125">125%</option><option value="150">150%</option>' +
        '</select>' +
        '<label>Page:</label>' +
        '<input class="pe-jump" type="number" min="1" value="1" title="Jump to page" spellcheck="false" autocomplete="off">' +
        '<span class="pe-pagecount pe-hint">of \u2013</span>' +
        '<span class="pe-hint">Click-drag on the page to draw a field \u00b7 click a box to select \u00b7 Del removes it</span>' +
      '</div>' +
      '<div class="pe-pages"><div class="pe-empty">No document rendered yet.</div></div>';

    var self = this;
    container.querySelector('.pe-type').addEventListener('change', function (e) {
      self._drawType = e.target.value;
      self._syncToolbarMode();
      // With a box selected, the type select retypes it (min size re-enforced).
      var f = self._selected();
      if (f) { self._retype(f, e.target.value); }
    });
    var labelInput = container.querySelector('.pe-label');
    labelInput.addEventListener('input', function (e) {
      var f = self._selected();
      if (!f || f.type === 'text') return;
      var v = e.target.value.trim();
      if (v) f.label = v; else delete f.label;
      var tagEl = self.container.querySelector('.pe-box[data-uid="' + f.uid + '"] .pe-tag');
      if (tagEl) tagEl.textContent = peSignerTag(f);
    });
    labelInput.addEventListener('change', function () {
      var f = self._selected();
      if (f && f.type !== 'text') { self._renderFields(); self._changed(); }
    });
    var keyInput = container.querySelector('.pe-key');
    keyInput.addEventListener('input', function (e) {
      self._drawKey = e.target.value.trim();
      var f = self._selected();
      if (f && f.type === 'text') {
        f.key = self._drawKey;
        // Live tag update without a full re-render per keystroke.
        var box = self.container.querySelector('.pe-box[data-uid="' + f.uid + '"] .pe-tag');
        if (box) box.textContent = 'TEXT \u00b7 ' + (f.key || '?');
      }
    });
    keyInput.addEventListener('change', function () {
      var f = self._selected();
      if (f && f.type === 'text') { self._renderFields(); self._changed(); }
    });
    container.querySelector('.pe-signer').addEventListener('change', function (e) {
      self._drawSigner = parseInt(e.target.value, 10) || 1;
      var f = self._selected();
      if (f && f.signer !== self._drawSigner) {
        if (f.type === 'radio') {
          // Same rule as the box swap button: the whole group moves.
          self.fields.forEach(function (o) {
            if (o.type === 'radio' && o.group === f.group) o.signer = self._drawSigner;
          });
        } else {
          f.signer = self._drawSigner;
        }
        self._renderFields();
        self._changed();
      }
    });

    // ── Phase 2F property inputs ─────────────────────────────
    // One idiom throughout, copied from the key input: 'input' updates the
    // sticky draw-state AND the selected box (with a cheap tag refresh where
    // the tag shows the property); 'change' commits — full re-render + dirty.
    function liveTag(f) {
      var el = self.container.querySelector('.pe-box[data-uid="' + f.uid + '"] .pe-tag');
      if (el) el.textContent = peSignerTag(f);
    }
    function commitIf(type) {
      return function () {
        var f = self._selected();
        if (f && f.type === type) { self._renderFields(); self._changed(); }
      };
    }

    var maxlenInput = container.querySelector('.pe-maxlen');
    maxlenInput.addEventListener('input', function (e) {
      var n = parseInt(e.target.value, 10);
      self._drawMaxLen = (Number.isInteger(n) && n >= 1) ? n : null;
      var f = self._selected();
      if (f && f.type === 'input_text') {
        if (self._drawMaxLen != null) f.max_length = self._drawMaxLen;
        else delete f.max_length;
      }
    });
    maxlenInput.addEventListener('change', commitIf('input_text'));

    var itextDefaultInput = container.querySelector('.pe-itext-default');
    itextDefaultInput.addEventListener('input', function (e) {
      self._drawDefault = e.target.value;
      var f = self._selected();
      if (f && f.type === 'input_text') {
        if (self._drawDefault) f.default = self._drawDefault;
        else delete f.default;
      }
    });
    itextDefaultInput.addEventListener('change', commitIf('input_text'));

    container.querySelector('.pe-checked').addEventListener('change', function (e) {
      var f = self._selected();
      if (!f || f.type !== 'checkbox') return;
      if (e.target.checked) f.checked = true; else delete f.checked;
      self._renderFields();
      self._changed();
    });

    var optionsInput = container.querySelector('.pe-options');
    optionsInput.addEventListener('input', function (e) {
      self._drawOptions = peParseOptions(e.target.value);
      var f = self._selected();
      if (f && f.type === 'dropdown') f.options = self._drawOptions.slice();
    });
    optionsInput.addEventListener('change', commitIf('dropdown'));

    var ddDefaultInput = container.querySelector('.pe-dd-default');
    ddDefaultInput.addEventListener('input', function (e) {
      self._drawDdDefault = e.target.value.trim();
      var f = self._selected();
      if (f && f.type === 'dropdown') {
        if (self._drawDdDefault) f.default = self._drawDdDefault;
        else delete f.default;
      }
    });
    ddDefaultInput.addEventListener('change', commitIf('dropdown'));

    var groupInput = container.querySelector('.pe-group');
    groupInput.addEventListener('input', function (e) {
      self._drawGroup = e.target.value.trim();
      var f = self._selected();
      if (f && f.type === 'radio') { f.group = self._drawGroup; liveTag(f); }
    });
    groupInput.addEventListener('change', commitIf('radio'));

    var valueInput = container.querySelector('.pe-value');
    valueInput.addEventListener('input', function (e) {
      self._drawValue = e.target.value.trim();
      var f = self._selected();
      if (f && f.type === 'radio') { f.value = self._drawValue; liveTag(f); }
    });
    valueInput.addEventListener('change', commitIf('radio'));

    container.querySelector('.pe-radio-checked').addEventListener('change', function (e) {
      var f = self._selected();
      if (!f || f.type !== 'radio') return;
      if (e.target.checked) {
        // A group has ONE default — mirror the server rule in the UI instead
        // of letting the author save into a guaranteed rejection.
        self.fields.forEach(function (o) {
          if (o !== f && o.type === 'radio' && o.group === f.group) delete o.checked;
        });
        f.checked = true;
      } else {
        delete f.checked;
      }
      self._renderFields();
      self._changed();
    });

    container.querySelector('.pe-zoom').addEventListener('change', function (e) {
      self.setZoom(parseInt(e.target.value, 10) || 100);
    });

    // Page jump + live current-page indicator.
    var jump = container.querySelector('.pe-jump');
    function doJump() {
      var n = parseInt(jump.value, 10);
      if (!self.pdfDoc || !n) return;
      n = Math.min(Math.max(n, 1), self.pdfDoc.numPages);
      jump.value = String(n);
      self.goToPage(n);
    }
    jump.addEventListener('change', doJump);
    jump.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doJump(); }
    });

    container.querySelector('.pe-pages').addEventListener('scroll', function () {
      if (self._scrollRaf) return;
      self._scrollRaf = requestAnimationFrame(function () {
        self._scrollRaf = null;
        self._updateCurrentPageIndicator();
      });
    });

    this._keyHandler = function (e) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (self.selectedUid == null) return;
      e.preventDefault();
      self._deleteSelected();
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  PlacementEditor.prototype.destroy = function () {
    document.removeEventListener('keydown', this._keyHandler);
    if (this.pdfDoc && this.pdfDoc.destroy) { try { this.pdfDoc.destroy(); } catch (_) { } }
    this.pdfDoc = null;
    this.container.innerHTML = '';
  };

  PlacementEditor.prototype.hasDocument = function () { return !!this.pdfDoc; };

  /** Scroll a page into view. In the lazy build this also triggers its render;
      in the eager build the page is already painted. Public — the send/admin
      UI can deep-link to a signature page. */
  PlacementEditor.prototype.goToPage = function (n) {
    var wrap = this.container.querySelector('.pe-page[data-page="' + n + '"]');
    if (wrap) wrap.scrollIntoView({ block: 'start' });
  };

  /** Reflect page count in the jump control's "of N" label and max attribute. */
  PlacementEditor.prototype._syncPageCount = function () {
    var n = this.pdfDoc ? this.pdfDoc.numPages : 0;
    var cnt = this.container.querySelector('.pe-pagecount');
    var jmp = this.container.querySelector('.pe-jump');
    if (cnt) cnt.textContent = 'of ' + (n || '\u2013');
    if (jmp) { jmp.max = String(n || 1); if (!jmp.value) jmp.value = '1'; }
  };

  /** Point the jump input at the top-most page currently in the scroll area.
      Skipped while the input is focused so it never fights the user's typing. */
  PlacementEditor.prototype._updateCurrentPageIndicator = function () {
    var pagesEl = this.container.querySelector('.pe-pages');
    var jmp = this.container.querySelector('.pe-jump');
    if (!pagesEl || !jmp || !this.pdfDoc) return;
    if (document.activeElement === jmp) return;
    var wraps = pagesEl.querySelectorAll('.pe-page');
    var top = pagesEl.getBoundingClientRect().top;
    var current = 1;
    for (var i = 0; i < wraps.length; i++) {
      var r = wraps[i].getBoundingClientRect();
      if (r.bottom > top + 40) { current = parseInt(wraps[i].dataset.page, 10) || 1; break; }
    }
    jmp.value = String(current);
  };

  // ── loading + rendering ────────────────────────────────────

  PlacementEditor.prototype.loadPdf = async function (arrayBuffer, placementJson) {
    if (this.pdfDoc && this.pdfDoc.destroy) { try { this.pdfDoc.destroy(); } catch (_) { } }
    this.pdfDoc = await this.pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    this._syncPageCount();
    if (placementJson) this._seed(placementJson); // silent — loading isn't a user edit
    await this._renderAll();
  };

  PlacementEditor.prototype.setZoom = async function (pct) {
    this.zoom = pct;
    var sel = this.container.querySelector('.pe-zoom');
    if (sel && sel.value !== String(pct)) sel.value = String(pct);
    if (this.pdfDoc) await this._renderAll();
  };

  PlacementEditor.prototype._seed = function (json) {
    var self = this;
    var fields = (json && Array.isArray(json.fields)) ? json.fields : [];
    this.fields = fields
      .filter(function (f) {
        return f && typeof f === 'object' && PE_FIELD_TYPES.indexOf(f.type) !== -1 &&
          isFinite(Number(f.x)) && isFinite(Number(f.y)) &&
          isFinite(Number(f.w)) && isFinite(Number(f.h));
      })
      .map(function (f) {
        var out = {
          uid: ++self._uid,
          page: (typeof f.page === 'number' && f.page >= 1) ? Math.floor(f.page) : 1,
          x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h),
          type: f.type,
        };
        if (f.type === 'text') {
          // Text fields carry a key, never a signer — the server validator
          // (services/esign/placements.js) THROWS on a text field with a
          // signer, so round-tripping must not invent one.
          out.key = typeof f.key === 'string' ? f.key : '';
          if (typeof f.font_size === 'number' && f.font_size > 0) out.font_size = f.font_size;
        } else {
          out.signer = (typeof f.signer === 'number' && f.signer >= 1) ? Math.floor(f.signer) : 1;
          if (f.type !== 'radio' && typeof f.label === 'string' && f.label.trim()) out.label = f.label.trim();
          // Phase 2F per-type properties — peCarryProps is the ONE carrier
          // shared with getPlacements; see its header for why.
          peCarryProps(f, out);
        }
        return out;
      });
    this.selectedUid = null;
  };

  /** Public: replace fields from a neutral JSON and re-render (user action —
      fires change). */
  PlacementEditor.prototype.setPlacements = function (json) {
    this._seed(json);
    this._renderFields();
    this._changed();
  };

  /** Public: current fields as a neutral placement object, canonically sorted. */
  PlacementEditor.prototype.getPlacements = function () {
    return {
      coord_space: 'pdf_user_space',
      fields: peSortFields(this.fields).map(function (f) {
        var out = { page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, type: f.type };
        if (f.type === 'text') {
          out.key = f.key || '';
          if (typeof f.font_size === 'number' && f.font_size > 0) out.font_size = f.font_size;
        } else {
          out.signer = f.signer;
          if (f.type !== 'radio' && typeof f.label === 'string' && f.label.trim()) out.label = f.label.trim();
          peCarryProps(f, out); // Phase 2F — same carrier as _seed
        }
        return out;
      }),
    };
  };

  PlacementEditor.prototype._changed = function () {
    if (typeof this.opts.onChange === 'function') this.opts.onChange();
  };

  PlacementEditor.prototype._renderAll = async function () {
    var seq = ++this._renderSeq;                 // stale-render guard on rapid zoom
    var pagesEl = this.container.querySelector('.pe-pages');
    pagesEl.innerHTML = '<div class="pe-empty"><i class="fa-solid fa-spinner fa-spin-pulse"></i> Rendering\u2026</div>';
    this.viewports = {};

    // Fit-width base scale from page 1 at scale 1; zoom multiplies it.
    var page1 = await this.pdfDoc.getPage(1);
    if (seq !== this._renderSeq) return;
    var base = page1.getViewport({ scale: 1 });
    var avail = Math.max(pagesEl.clientWidth - 40, 200);   // padding allowance
    var scale = (avail / base.width) * (this.zoom / 100);

    pagesEl.innerHTML = '';
    var dpr = window.devicePixelRatio || 1;

    for (var n = 1; n <= this.pdfDoc.numPages; n++) {
      var page = n === 1 ? page1 : await this.pdfDoc.getPage(n);
      if (seq !== this._renderSeq) return;
      var vp = page.getViewport({ scale: scale });
      this.viewports[n] = vp;

      var wrap = document.createElement('div');
      wrap.className = 'pe-page';
      wrap.dataset.page = String(n);
      wrap.style.width = vp.width + 'px';
      wrap.style.height = vp.height + 'px';

      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      wrap.appendChild(canvas);

      var overlay = document.createElement('div');
      overlay.className = 'pe-overlay';
      wrap.appendChild(overlay);
      this._wireOverlay(overlay, n);

      pagesEl.appendChild(wrap);
      var label = document.createElement('div');
      label.className = 'pe-pagelabel';
      label.textContent = 'Page ' + n + ' of ' + this.pdfDoc.numPages;
      pagesEl.appendChild(label);

      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
      if (seq !== this._renderSeq) return;
    }

    this._renderFields();
  };

  // ── field boxes ────────────────────────────────────────────

  PlacementEditor.prototype._selected = function () {
    var uid = this.selectedUid;
    return this.fields.find(function (f) { return f.uid === uid; }) || null;
  };

  PlacementEditor.prototype._renderFields = function () {
    var self = this;
    this.container.querySelectorAll('.pe-box').forEach(function (el) { el.remove(); });
    this.fields.forEach(function (f) {
      var vp = self.viewports[f.page];
      var wrap = self.container.querySelector('.pe-page[data-page="' + f.page + '"]');
      if (!vp || !wrap) return;    // field beyond the rendered page count — kept in data, not drawn
      var r = peNeutralToViewport(f, vp);
      var isText = f.type === 'text';
      var color = isText ? PE_TEXT_COLOR : (PE_SIGNER_COLORS[f.signer] || PE_SIGNER_COLORS[1]);
      var box = document.createElement('div');
      box.className = 'pe-box' + (!isText && f.signer === 2 ? ' pe-s2' : '') +
        (isText ? ' pe-text' : '') +
        (f.uid === self.selectedUid ? ' pe-selected' : '');
      box.dataset.uid = String(f.uid);
      box.style.left = r.x + 'px';
      box.style.top = r.y + 'px';
      box.style.width = r.w + 'px';
      box.style.height = r.h + 'px';
      box.style.borderColor = color;
      var tag = isText
        ? 'TEXT \u00b7 ' + (f.key || '?')
        : peSignerTag(f);
      box.innerHTML =
        '<span class="pe-tag" style="background:' + color + '">' + tag + '</span>' +
        '<span class="pe-ctl">' +
          (isText ? '' :
            '<button class="pe-swap" title="Switch signer">S' + (f.signer === 1 ? 2 : 1) + '</button>') +
          '<button class="pe-del" title="Delete (Del)">\u00d7</button>' +
        '</span>' +
        '<span class="pe-handle" style="background:' + color + '"></span>';
      self._wireBox(box, f);
      wrap.appendChild(box);
    });
  };

  /** Toolbar clusters vs the draw type: key input for 'text', signer select
      for every signer type (label hidden for radio — the group name is the
      display name), plus exactly one Phase 2F property cluster. */
  PlacementEditor.prototype._syncToolbarMode = function () {
    var t = this._drawType;
    var isText = t === 'text';
    var q = this.container.querySelector.bind(this.container);
    q('.pe-signer-wrap').style.display = isText ? 'none' : '';
    q('.pe-label-wrap').style.display  = (isText || t === 'radio') ? 'none' : '';
    q('.pe-key-wrap').style.display    = isText ? '' : 'none';
    q('.pe-itext-wrap').style.display  = t === 'input_text' ? '' : 'none';
    q('.pe-check-wrap').style.display  = t === 'checkbox'   ? '' : 'none';
    q('.pe-drop-wrap').style.display   = t === 'dropdown'   ? '' : 'none';
    q('.pe-radio-wrap').style.display  = t === 'radio'      ? '' : 'none';
  };

  PlacementEditor.prototype._select = function (uid) {
    this.selectedUid = uid;
    var f = this._selected();
    if (f) {
      // Toolbar mirrors the selection so the next draw matches, and so the
      // toolbar selects can retarget the selected box.
      var q = this.container.querySelector.bind(this.container);
      q('.pe-type').value = f.type;
      this._drawType = f.type;
      if (f.type === 'text') {
        this._drawKey = f.key || '';
        q('.pe-key').value = this._drawKey;
      } else {
        q('.pe-signer').value = String(f.signer);
        q('.pe-label').value = f.label || '';
        this._drawSigner = f.signer;
        // Phase 2F: property inputs mirror the selection AND become the
        // sticky values for the next draw — same as label/signer above.
        if (f.type === 'input_text') {
          this._drawMaxLen  = (typeof f.max_length === 'number') ? f.max_length : null;
          this._drawDefault = f.default || '';
          q('.pe-maxlen').value = this._drawMaxLen == null ? '' : String(this._drawMaxLen);
          q('.pe-itext-default').value = this._drawDefault;
        } else if (f.type === 'checkbox') {
          q('.pe-checked').checked = f.checked === true;
        } else if (f.type === 'dropdown') {
          this._drawOptions   = Array.isArray(f.options) ? f.options.slice() : [];
          this._drawDdDefault = f.default || '';
          q('.pe-options').value = this._drawOptions.join(', ');
          q('.pe-dd-default').value = this._drawDdDefault;
        } else if (f.type === 'radio') {
          this._drawGroup = f.group || '';
          this._drawValue = f.value || '';
          q('.pe-group').value = this._drawGroup;
          q('.pe-value').value = this._drawValue;
          q('.pe-radio-checked').checked = f.checked === true;
        }
      }
      this._syncToolbarMode();
    }
    this._renderFields();
  };

  PlacementEditor.prototype._deleteSelected = function () {
    var uid = this.selectedUid;
    if (uid == null) return;
    this.fields = this.fields.filter(function (f) { return f.uid !== uid; });
    this.selectedUid = null;
    this._renderFields();
    this._changed();
  };

  PlacementEditor.prototype._retype = function (f, type) {
    if (f.type === type) return;
    f.type = type;
    // Per-type properties do NOT survive a retype — a dropdown retyped to a
    // checkbox that silently kept `options` would fail server validation (or
    // worse, pass it and confuse the provider). Strip everything the NEW type
    // doesn't own, then let the toolbar re-apply its current values.
    delete f.max_length; delete f.default; delete f.checked;
    delete f.options; delete f.group; delete f.value;
    if (type === 'text') {
      delete f.signer;                       // server THROWS on text+signer
      delete f.label;
      f.key = this._drawKey || f.key || '';
    } else {
      if (f.key !== undefined) { delete f.key; delete f.font_size; }
      if (f.signer === undefined) f.signer = this._drawSigner || 1;
      if (type === 'radio') {
        delete f.label;                      // group name is the display name
        f.group = this._drawGroup || '';     // sticky, same as the draw path
        f.value = '';                        // never inherit a sibling's value
      } else if (type === 'dropdown') {
        f.options = (this._drawOptions || []).slice();
        if (this._drawDdDefault) f.default = this._drawDdDefault;
      } else if (type === 'input_text') {
        if (this._drawMaxLen != null) f.max_length = this._drawMaxLen;
        if (this._drawDefault) f.default = this._drawDefault;
      }
    }
    var vp = this.viewports[f.page];
    var size = vp ? pePageSize(vp) : { w: 612, h: 792 };
    var r = peNormalizeRect(f, type, size.w, size.h);
    f.x = r.x; f.y = r.y; f.w = r.w; f.h = r.h;
    // _select (not a bare re-render): the toolbar must mirror the retyped
    // field's now-stripped properties, or the inputs keep showing the OLD
    // type's values against the NEW type's box.
    this._select(f.uid);
    this._changed();
  };

  // ── interactions ───────────────────────────────────────────

  /** Pointer position in a page wrapper's CSS-px space. */
  function localPoint(wrap, ev) {
    var rect = wrap.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  PlacementEditor.prototype._wireOverlay = function (overlay, pageNum) {
    var self = this;
    overlay.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      var wrap = overlay.parentNode;
      var start = localPoint(wrap, ev);
      var rubber = document.createElement('div');
      rubber.className = 'pe-rubber';
      wrap.appendChild(rubber);
      var moved = false;

      function toRect(ev2) {
        var p = localPoint(wrap, ev2);
        p.x = Math.min(Math.max(p.x, 0), wrap.clientWidth);
        p.y = Math.min(Math.max(p.y, 0), wrap.clientHeight);
        return {
          x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
          w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y),
        };
      }
      function onMove(ev2) {
        var r = toRect(ev2);
        if (r.w > 3 || r.h > 3) moved = true;
        rubber.style.left = r.x + 'px'; rubber.style.top = r.y + 'px';
        rubber.style.width = r.w + 'px'; rubber.style.height = r.h + 'px';
      }
      function onUp(ev2) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        rubber.remove();
        if (!moved) { self._select(null); return; }   // plain click = deselect
        var vp = self.viewports[pageNum];
        var size = pePageSize(vp);
        var neutral = peViewportToNeutral(toRect(ev2), vp);
        var r = peNormalizeRect(neutral, self._drawType, size.w, size.h);
        var f = {
          uid: ++self._uid, page: pageNum,
          x: r.x, y: r.y, w: r.w, h: r.h,
          type: self._drawType,
        };
        if (self._drawType === 'text') { f.key = self._drawKey; }
        else {
          f.signer = self._drawSigner;
          // Phase 2F: sticky properties transfer to the new box so a run of
          // same-shaped fields (five dropdowns with the same choices; the
          // circles of one radio group) doesn't mean re-typing per box.
          // `checked` never transfers — a default belongs to ONE box.
          if (self._drawType === 'input_text') {
            if (self._drawMaxLen != null) f.max_length = self._drawMaxLen;
            if (self._drawDefault) f.default = self._drawDefault;
          } else if (self._drawType === 'dropdown') {
            f.options = self._drawOptions.slice();
            if (self._drawDdDefault) f.default = self._drawDdDefault;
          } else if (self._drawType === 'radio') {
            f.group = self._drawGroup;
            // The sticky VALUE transfers only if no sibling already claims it
            // — drawing "Yes" then a second circle should demand a new name,
            // not silently mint a duplicate the server will reject.
            var taken = self.fields.some(function (o) {
              return o.type === 'radio' && o.group === self._drawGroup &&
                     o.value === self._drawValue && self._drawValue !== '';
            });
            f.value = taken ? '' : self._drawValue;
            if (taken) {
              self._drawValue = '';
              var vi = self.container.querySelector('.pe-value');
              if (vi) vi.value = '';
            }
          }
        }
        self.fields.push(f);
        self.selectedUid = f.uid;
        self._renderFields();
        self._changed();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  };

  PlacementEditor.prototype._wireBox = function (box, f) {
    var self = this;

    box.querySelector('.pe-del').addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    box.querySelector('.pe-del').addEventListener('click', function (ev) {
      ev.stopPropagation();
      self.selectedUid = f.uid;
      self._deleteSelected();
    });
    var swap = box.querySelector('.pe-swap'); // absent on text boxes
    if (swap) swap.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    if (swap) swap.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var to = f.signer === 1 ? 2 : 1;
      if (f.type === 'radio') {
        // A group belongs to exactly one signer (server rule) — swapping one
        // circle must carry its siblings, or the next save is a guaranteed
        // rejection the author didn't ask for.
        self.fields.forEach(function (o) {
          if (o.type === 'radio' && o.group === f.group) o.signer = to;
        });
      } else {
        f.signer = to;
      }
      self._select(f.uid);   // re-render + toolbar sync
      self._changed();
    });

    // move (drag the box) — live in px, committed to neutral on mouseup
    box.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target.classList.contains('pe-handle')) return;   // resize path
      ev.preventDefault();
      ev.stopPropagation();
      if (self.selectedUid !== f.uid) self._select(f.uid);
      var el = self.container.querySelector('.pe-box[data-uid="' + f.uid + '"]');
      var wrap = el.parentNode;
      var start = localPoint(wrap, ev);
      var orig = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
      var w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      var movedAny = false;

      function onMove(ev2) {
        var p = localPoint(wrap, ev2);
        var nx = Math.min(Math.max(orig.x + (p.x - start.x), 0), wrap.clientWidth - w);
        var ny = Math.min(Math.max(orig.y + (p.y - start.y), 0), wrap.clientHeight - h);
        if (nx !== orig.x || ny !== orig.y) movedAny = true;
        el.style.left = nx + 'px'; el.style.top = ny + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!movedAny) return;
        self._commitBoxRect(f, el);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // resize (corner handle)
    box.querySelector('.pe-handle').addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (self.selectedUid !== f.uid) self._select(f.uid);
      var el = self.container.querySelector('.pe-box[data-uid="' + f.uid + '"]');
      var wrap = el.parentNode;
      var left = parseFloat(el.style.left), top = parseFloat(el.style.top);
      var start = localPoint(wrap, ev);
      var ow = parseFloat(el.style.width), oh = parseFloat(el.style.height);

      function onMove(ev2) {
        var p = localPoint(wrap, ev2);
        var nw = Math.min(Math.max(ow + (p.x - start.x), 6), wrap.clientWidth - left);
        var nh = Math.min(Math.max(oh + (p.y - start.y), 6), wrap.clientHeight - top);
        el.style.width = nw + 'px'; el.style.height = nh + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        self._commitBoxRect(f, el);   // min size re-enforced in points here
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  };

  /** px-space box → neutral, normalized (min in POINTS + clamp + round), then
      re-render so the on-screen box reflects the committed geometry. */
  PlacementEditor.prototype._commitBoxRect = function (f, el) {
    var vp = this.viewports[f.page];
    var size = pePageSize(vp);
    var neutral = peViewportToNeutral({
      x: parseFloat(el.style.left), y: parseFloat(el.style.top),
      w: parseFloat(el.style.width), h: parseFloat(el.style.height),
    }, vp);
    var r = peNormalizeRect(neutral, f.type, size.w, size.h);
    f.x = r.x; f.y = r.y; f.w = r.w; f.h = r.h;
    this._renderFields();
    this._changed();
  };

  window.PlacementEditor = PlacementEditor;
})();