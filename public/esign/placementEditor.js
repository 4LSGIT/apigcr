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
var PE_FIELD_TYPES = ['signature', 'initial', 'date'];

/** Minimum field sizes in PDF POINTS (2D spec). Enforced in points — never in
    pixels — so the floor is the same physical size at every zoom. */
var PE_MIN_SIZES = {
  signature: { w: 120, h: 24 },
  initial:   { w: 40,  h: 18 },
  date:      { w: 60,  h: 16 },
};

/** Signer color code (2D spec: pick one and document it).
    Signer 1 = blue #2563eb, signer 2 = green #059669. Green matches the
    'signed' chip family in esignActions.js; blue is the app's link-ish blue
    family. Consistent with nothing else by design — it only means "signer". */
var PE_SIGNER_COLORS = { 1: '#2563eb', 2: '#059669' };

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
      opts.resolvers.indexOf(row.resolver) === -1) {
    errs.push('resolver: unknown');
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
    this._renderSeq = 0;

    container.classList.add('pe-root');
    container.innerHTML =
      '<div class="pe-toolbar">' +
        '<label>Field:</label>' +
        '<select class="pe-type">' +
          PE_FIELD_TYPES.map(function (t) {
            return '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>';
          }).join('') +
        '</select>' +
        '<label>Signer:</label>' +
        '<select class="pe-signer">' +
          '<option value="1" style="color:' + PE_SIGNER_COLORS[1] + '">1 (blue)</option>' +
          '<option value="2" style="color:' + PE_SIGNER_COLORS[2] + '">2 (green)</option>' +
        '</select>' +
        '<label>Zoom:</label>' +
        '<select class="pe-zoom">' +
          '<option value="75">75%</option><option value="100" selected>100%</option>' +
          '<option value="125">125%</option><option value="150">150%</option>' +
        '</select>' +
        '<span class="pe-hint">Click-drag on the page to draw a field \u00b7 click a box to select \u00b7 Del removes it</span>' +
      '</div>' +
      '<div class="pe-pages"><div class="pe-empty">No document rendered yet.</div></div>';

    var self = this;
    container.querySelector('.pe-type').addEventListener('change', function (e) {
      self._drawType = e.target.value;
      // With a box selected, the type select retypes it (min size re-enforced).
      var f = self._selected();
      if (f) { self._retype(f, e.target.value); }
    });
    container.querySelector('.pe-signer').addEventListener('change', function (e) {
      self._drawSigner = parseInt(e.target.value, 10) || 1;
      var f = self._selected();
      if (f && f.signer !== self._drawSigner) {
        f.signer = self._drawSigner;
        self._renderFields();
        self._changed();
      }
    });
    container.querySelector('.pe-zoom').addEventListener('change', function (e) {
      self.setZoom(parseInt(e.target.value, 10) || 100);
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

  // ── loading + rendering ────────────────────────────────────

  PlacementEditor.prototype.loadPdf = async function (arrayBuffer, placementJson) {
    if (this.pdfDoc && this.pdfDoc.destroy) { try { this.pdfDoc.destroy(); } catch (_) { } }
    this.pdfDoc = await this.pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
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
        return {
          uid: ++self._uid,
          page: (typeof f.page === 'number' && f.page >= 1) ? Math.floor(f.page) : 1,
          x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h),
          type: f.type,
          signer: (typeof f.signer === 'number' && f.signer >= 1) ? Math.floor(f.signer) : 1,
        };
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
        return { page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, type: f.type, signer: f.signer };
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
      var color = PE_SIGNER_COLORS[f.signer] || PE_SIGNER_COLORS[1];
      var box = document.createElement('div');
      box.className = 'pe-box' + (f.signer === 2 ? ' pe-s2' : '') +
        (f.uid === self.selectedUid ? ' pe-selected' : '');
      box.dataset.uid = String(f.uid);
      box.style.left = r.x + 'px';
      box.style.top = r.y + 'px';
      box.style.width = r.w + 'px';
      box.style.height = r.h + 'px';
      box.style.borderColor = color;
      box.innerHTML =
        '<span class="pe-tag" style="background:' + color + '">' +
          f.type.toUpperCase() + ' \u00b7 S' + f.signer + '</span>' +
        '<span class="pe-ctl">' +
          '<button class="pe-swap" title="Switch signer">S' + (f.signer === 1 ? 2 : 1) + '</button>' +
          '<button class="pe-del" title="Delete (Del)">\u00d7</button>' +
        '</span>' +
        '<span class="pe-handle" style="background:' + color + '"></span>';
      self._wireBox(box, f);
      wrap.appendChild(box);
    });
  };

  PlacementEditor.prototype._select = function (uid) {
    this.selectedUid = uid;
    var f = this._selected();
    if (f) {
      // Toolbar mirrors the selection so the next draw matches, and so the
      // toolbar selects can retarget the selected box.
      this.container.querySelector('.pe-type').value = f.type;
      this.container.querySelector('.pe-signer').value = String(f.signer);
      this._drawType = f.type;
      this._drawSigner = f.signer;
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
    var vp = this.viewports[f.page];
    var size = vp ? pePageSize(vp) : { w: 612, h: 792 };
    var r = peNormalizeRect(f, type, size.w, size.h);
    f.x = r.x; f.y = r.y; f.w = r.w; f.h = r.h;
    this._renderFields();
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
          type: self._drawType, signer: self._drawSigner,
        };
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
    box.querySelector('.pe-swap').addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    box.querySelector('.pe-swap').addEventListener('click', function (ev) {
      ev.stopPropagation();
      f.signer = f.signer === 1 ? 2 : 1;
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