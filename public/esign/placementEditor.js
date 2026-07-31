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
  // `required:false` = the signer may skip it (server default is required, so
  // only the false form is carried — an absent key IS "required"). Offered for
  // the choice/input types only: an optional SIGNATURE on a legal document is
  // a footgun the editor refuses to hand out, even though the server would
  // accept it.
  if ((src.type === 'input_text' || src.type === 'checkbox' ||
       src.type === 'dropdown'   || src.type === 'radio') && src.required === false) {
    out.required = false;
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
 * External <img> URL extraction (authoring-time image inliner, 2026-07-22).
 *
 * MVP scope, ratified: <img src> ONLY. css url(), @font-face, <link href>
 * and every other external reference stay fail-loudly at render
 * (ESIGN_RENDER_EXTERNAL_REF) — inlining those is explicitly out of scope.
 *
 * Regex-over-tags rather than DOM parsing so the same function runs in the
 * browser (templateAdmin's confirm dialog) AND under node jest. http:// urls
 * are extracted too — the server rejects them (https_only) and the failure
 * shows in the summary, which beats silently not offering them.
 *
 * @param {string} html
 * @returns {string[]} unique urls, first-seen order
 */
var PE_IMG_TAG_RE = /<img\b[^>]*>/gi;
var PE_IMG_SRC_RE = /\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i;
function peExtractExternalImageUrls(html) {
  var s = String(html == null ? '' : html);
  var seen = {};
  var out = [];
  var m;
  PE_IMG_TAG_RE.lastIndex = 0;
  while ((m = PE_IMG_TAG_RE.exec(s)) !== null) {
    var sm = PE_IMG_SRC_RE.exec(m[0]);
    if (!sm) continue;
    var url = String(sm[2] != null ? sm[2] : sm[3]).trim();
    if (!/^https?:\/\//i.test(url)) continue;   // data:, relative, blank — skip
    if (!Object.prototype.hasOwnProperty.call(seen, url)) {
      seen[url] = true;
      out.push(url);
    }
  }
  return out;
}

/** Escape a literal for use inside a RegExp. */
function _peEscRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Swap fetched images into the body: every src="URL" / src='URL' whose URL is
 * a key of `map` becomes the mapped data URI, quote style preserved. Exact
 * URL match only — a URL the map does not name is left byte-identical.
 *
 * @param {string} html
 * @param {Object<string,string>} map  url → data URI
 * @returns {string}
 */
function peInlineImageSrcs(html, map) {
  var s = String(html == null ? '' : html);
  Object.keys(map || {}).forEach(function (url) {
    var dataUri = map[url];
    if (!dataUri) return;
    var re = new RegExp(
      '(src\\s*=\\s*)("' + _peEscRe(url) + '"|\'' + _peEscRe(url) + '\')', 'g');
    s = s.replace(re, function (_full, pre, quoted) {
      var q = quoted.charAt(0);
      return pre + q + dataUri + q;
    });
  });
  return s;
}

/**
 * Placement ↔ schema key diff (editor-key auto-create, 2026-07-22 slice).
 *
 * The placement editor's Key input lets an author TYPE a key that no schema
 * row declares yet; the server then rejects the save with
 * ESIGN_UNDECLARED_PLACEHOLDER (the pdf-type mirror cross-check). This helper
 * feeds templateAdmin's auto-create prompt: which placed text-field keys are
 * missing from the declared schema, unique, in order of first appearance.
 *
 * Accepts the neutral placement shape ({fields:[...]}), a bare fields array,
 * or null/undefined. Only type==='text' fields carry a key — signer-class
 * fields (signature/initial/date/input_text/checkbox/dropdown/radio) have no
 * schema counterpart and are ignored.
 *
 * PROMPT, NOT SILENT (ratified): the caller must confirm with the author
 * before appending rows — silent add turns typo'd keys into real schema rows.
 *
 * @param {object|Array|null} placements  neutral placement JSON or fields array
 * @param {string[]} schemaKeys           declared prefill-schema keys
 * @returns {string[]}                    missing keys, unique, first-seen order
 */
function peDiffPlacementKeys(placements, schemaKeys) {
  var fields = Array.isArray(placements)
    ? placements
    : (placements && Array.isArray(placements.fields) ? placements.fields : []);
  var declared = {};
  (schemaKeys || []).forEach(function (k) {
    if (k != null && k !== '') declared[String(k)] = true;
  });
  var seen = {};
  var missing = [];
  fields.forEach(function (f) {
    if (!f || f.type !== 'text') return;
    var key = f.key != null ? String(f.key).trim() : '';
    if (!key) return;
    if (declared[key] || Object.prototype.hasOwnProperty.call(seen, key)) return;
    seen[key] = true;
    missing.push(key);
  });
  return missing;
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

// ─── PLACEMENT TEXT KEYS (2G) ────────────────────────────────
//
// TWO different things in this codebase are called a "key", and conflating
// them is how a bad key reaches the server:
//
//   PE_KEY_RE       TEMPLATE PREFILL-SCHEMA keys (esignTemplateService.KEY_RE)
//                   — lowercase, must start with a letter, ≤40. This is the
//                   identifier a template BODY writes as {{key}}.
//   PE_TEXT_KEY_RE  PLACED TEXT-FIELD keys (services/esign/placements.js
//                   TEXT_KEY_RE) — the name on an amber fill-in box. Looser,
//                   because the ad-hoc upload flow mints its own: any of
//                   A-Z a-z 0-9 _ . - , 1..64 chars.
//
// A placed key must satisfy PE_TEXT_KEY_RE or the SERVER THROWS. In the
// template flow it must ALSO name a declared schema key — that second rule is
// already reported by peDiffPlacementKeys and stays a warning, not a block.
//
// Before 2G neither rule was checked in the browser at all: an illegal key
// survived the whole authoring session and surfaced at SEND time as a Swal
// reading "Send failed" whose body was a raw regex literal. Staff read that as
// the provider rejecting the document. It was us.
var PE_TEXT_KEY_RE  = /^[A-Za-z0-9_.\-]{1,64}$/;
var PE_TEXT_KEY_MAX = 64;

/**
 * THE SAME TRAP AGAIN, for `label`.
 *
 *   PE_LABEL_MAX (80)           esignTemplateService's PREFILL-SCHEMA ROW
 *                               label — the human name of a row in the
 *                               template's schema table.
 *   PE_PLACEMENT_LABEL_MAX (60) services/esign/placements.js LABEL_MAX — the
 *                               "shown to signer" string rendered INSIDE a
 *                               placed box on the provider's signing page.
 *
 * They are different limits on different strings. Using 80 for a placed
 * label lets an author type 61–80 characters that the server then refuses.
 */
var PE_PLACEMENT_LABEL_MAX = 60;

/** Mirror of placements.OPTION_TEXT_MAX — dropdown options, radio group/value. */
var PE_OPTION_TEXT_MAX = 100;

/** Characters a placed key may contain — used for the "remove X" hint. */
var PE_TEXT_KEY_CHAR_RE = /[A-Za-z0-9_.\-]/;

/**
 * Human sentence for an illegal placed key, '' when it is fine. Shown INLINE
 * under the key input as it is typed — the constraint has to be visible where
 * the mistake is made, not in a modal three screens later.
 *
 * @param {string} key
 * @returns {string} '' if valid, else a sentence naming the offending chars
 */
function peTextKeyError(key) {
  var k = typeof key === 'string' ? key : '';
  if (!k) return 'Give this box a key.';
  if (k.length > PE_TEXT_KEY_MAX) {
    return 'Key is too long \u2014 ' + k.length + ' characters, max ' + PE_TEXT_KEY_MAX + '.';
  }
  if (PE_TEXT_KEY_RE.test(k)) return '';
  var bad = [], seen = {};
  for (var i = 0; i < k.length; i++) {
    var c = k.charAt(i);
    if (PE_TEXT_KEY_CHAR_RE.test(c) || seen[c]) continue;
    seen[c] = true;
    bad.push(c === ' ' ? 'spaces' : '"' + c + '"');
  }
  return 'A key names the box \u2014 letters, numbers, _ . and - only' +
    (bad.length ? ' (remove ' + bad.join(', ') + ')' : '') + '.';
}

/**
 * Coerce arbitrary text into a legal placed key. Illegal runs collapse to one
 * underscore; leading/trailing underscores go. '$1,000 fee' → '1_000_fee'.
 * Never returns '' — an unnamable string becomes 'field'.
 */
function peSlugifyKey(s) {
  var out = String(s == null ? '' : s)
    .replace(/[^A-Za-z0-9_.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, PE_TEXT_KEY_MAX);
  return out || 'field';
}

/** First `base_N` (N from 1) not already used by a text field in `fields`. */
function peNextFreeKey(fields, base) {
  var b = peSlugifyKey(base || 'field');
  var taken = {};
  (Array.isArray(fields) ? fields : []).forEach(function (f) {
    if (f && f.type === 'text' && typeof f.key === 'string' && f.key) taken[f.key] = true;
  });
  for (var n = 1; n <= 9999; n++) {
    if (!taken[b + '_' + n]) return b + '_' + n;
  }
  return b + '_' + Date.now();
}

/**
 * Comfortable default box size in POINTS for TAP-TO-PLACE.
 *
 * Deliberately NOT PE_MIN_SIZES: the minimum is what a box may be shrunk TO
 * by a deliberate drag, not a sensible size to hand somebody who never
 * dragged one. A 120×24pt signature (the floor) is a cramped smear; 170×40
 * is a signature.
 */
var PE_DEFAULT_SIZES = {
  signature:  { w: 170, h: 40 },
  initial:    { w: 62,  h: 34 },
  date:       { w: 110, h: 22 },
  text:       { w: 140, h: 16 },
  input_text: { w: 140, h: 20 },
  checkbox:   { w: 16,  h: 16 },
  dropdown:   { w: 130, h: 22 },
  radio:      { w: 16,  h: 16 },
};

/** Default {w,h} in points for a tapped field of `type`. */
function peDefaultSize(type) {
  var d = PE_DEFAULT_SIZES[type] || PE_DEFAULT_SIZES.text;
  return { w: d.w, h: d.h };
}

/**
 * One-line description of a field for the inspector's field list. Pure so the
 * list and the on-page tag can never drift into two different vocabularies.
 */
function peFieldSummary(f) {
  if (!f || !f.type) return '';
  if (f.type === 'text') return 'Fill-in \u00b7 ' + (f.key || 'no key');
  if (f.type === 'radio') {
    return 'Radio \u00b7 ' + (f.group || '?') + ': ' + (f.value || '?') +
      (f.required === false ? ' \u00b7 optional' : '');
  }
  var NAMES = {
    signature: 'Signature', initial: 'Initial', date: 'Date',
    input_text: 'Signer text', checkbox: 'Checkbox', dropdown: 'Dropdown',
  };
  return (NAMES[f.type] || f.type) + (f.label ? ' \u00b7 ' + f.label : '') +
    (f.required === false ? ' \u00b7 optional' : '');
}

/**
 * Every problem that would make the SERVER reject these fields, found in the
 * browser. Returns [] when clean. Each problem carries the uid so the caller
 * can select + scroll to the offending box instead of describing it.
 *
 * Mirrors the subset of services/esign/placements.js that an author can
 * actually get wrong in the editor; the server stays authoritative.
 *
 * @param {object[]} fields  editor fields (uid-bearing)
 * @returns {{uid:number, page:number, message:string}[]}
 */
function peFindProblems(fields) {
  var out = [];
  var list = Array.isArray(fields) ? fields : [];
  var groups = {};   // group → { signer, values:{}, checked:0 }

  list.forEach(function (f) {
    function bad(msg) { out.push({ uid: f.uid, page: f.page, message: msg }); }

    if (f.type === 'text') {
      var ke = peTextKeyError(f.key);
      if (ke) bad('Fill-in box on page ' + f.page + ': ' + ke);
      return;
    }
    if (f.label != null && String(f.label).length > PE_PLACEMENT_LABEL_MAX) {
      bad('"Shown to signer" on page ' + f.page + ' is over ' +
          PE_PLACEMENT_LABEL_MAX + ' characters.');
    }
    if (f.type === 'dropdown' && (!Array.isArray(f.options) || !f.options.length)) {
      bad('Dropdown on page ' + f.page + ' has no options to pick from.');
    }
    if (f.type === 'dropdown' && Array.isArray(f.options) && f.default &&
        f.options.indexOf(String(f.default).trim()) === -1) {
      bad('Dropdown default "' + f.default + '" is not one of its options.');
    }
    if (f.type === 'radio') {
      if (!f.group) { bad('Radio box on page ' + f.page + ' has no group name.'); return; }
      if (!f.value) { bad('Radio box in "' + f.group + '" has no option name.'); return; }
      var g = groups[f.group];
      if (!g) { g = groups[f.group] = { signer: f.signer, values: {}, checked: 0 }; }
      else if (g.signer !== f.signer) {
        bad('Radio group "' + f.group + '" is split across signer ' + g.signer +
            ' and ' + f.signer + ' \u2014 a group belongs to one signer.');
      }
      if (g.values[f.value]) {
        bad('Radio group "' + f.group + '" has two boxes named "' + f.value + '".');
      }
      g.values[f.value] = true;
      if (f.checked === true && ++g.checked > 1) {
        bad('Radio group "' + f.group + '" has more than one default.');
      }
    }
  });
  return out;
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
    peExtractExternalImageUrls: peExtractExternalImageUrls,
    peInlineImageSrcs: peInlineImageSrcs,
    peDiffPlacementKeys: peDiffPlacementKeys,
    peValidateSchemaRow: peValidateSchemaRow,
    peValidateSchemaRows: peValidateSchemaRows,
    peValidateBasics: peValidateBasics,
    peSignerTag: peSignerTag,
    peParseOptions: peParseOptions,
    peCarryProps: peCarryProps,
    PE_TEXT_KEY_RE: PE_TEXT_KEY_RE,
    PE_TEXT_KEY_MAX: PE_TEXT_KEY_MAX,
    PE_PLACEMENT_LABEL_MAX: PE_PLACEMENT_LABEL_MAX,
    PE_OPTION_TEXT_MAX: PE_OPTION_TEXT_MAX,
    PE_DEFAULT_SIZES: PE_DEFAULT_SIZES,
    peTextKeyError: peTextKeyError,
    peSlugifyKey: peSlugifyKey,
    peNextFreeKey: peNextFreeKey,
    peDefaultSize: peDefaultSize,
    peFieldSummary: peFieldSummary,
    peFindProblems: peFindProblems,
  };
}

/* ══════════════════════════════════════════════════════════════
   SECTION 2 — BROWSER ONLY (the component)

   ── 2H LAYOUT: A BARE BAR AND ONE PULL-OUT DRAWER ────────────
   The authoring controls have been in three places at once, and every
   revision so far only moved which two:

     2D/2F  ONE sticky flex-wrap toolbar above the pages carried all fourteen
            controls. On a phone it wrapped to five or six rows, so you drew a
            box at the bottom of page 3, scrolled to the TOP to name it,
            scrolled back down, then scrolled past the whole document to type
            its value in the send form's list at the BOTTOM.
     2G     Per-field properties moved into a side panel — but the field-type
            picker stayed in the bar (top) and the send form's value list
            stayed under the pages (bottom). Same trip, shorter.

   2H puts the whole authoring loop in one surface:

     .pe-bar      the document, and nothing else: zoom, page N of M.
     .pe-drawer   pick what to add, place it, name it, say what it prints,
                  review every field. Absolutely positioned OVER the pages
                  and closed by default, so the document is full width until
                  you ask for the controls. A tab on the right edge pulls it
                  out; the tab is anchored to the editor frame (not the
                  scrolling page), so it stays in one place over the page's
                  right margin however far you scroll — and it can be dragged
                  up or down if it ever sits on something.

   The drawer has TWO modes and swaps between them on its own:
     ADD    nothing selected — the type grid and the field list.
     EDIT   a field selected — its properties, its value, delete/duplicate.

   Choosing a type CLOSES the drawer (you asked to place something; you need
   to see the page). Placing a field that needs a decision — a fill-in with no
   value yet, a radio with no group, anything flagged — REOPENS it on that
   field. A signature or a date, which need nothing, are placed silently, so a
   run of them is one gesture each.

   ── INPUT: POINTER EVENTS, AND TAP-TO-PLACE ──────────────────
   The 2D/2F build listened for mousedown/mousemove/mouseup only. Touch
   browsers synthesise a click after a tap but never the mousemove stream a
   drag needs, so on a phone or tablet drawing, moving and resizing did
   nothing at all. Everything below is Pointer Events with setPointerCapture.

   Drag-to-draw cannot simply be enabled for touch: the overlay covers the
   page, so a drag that draws is a drag that no longer SCROLLS. The rule:

     mouse            drag on empty page draws; click places (or deselects).
     touch / pen      the page scrolls normally. "Place on the page" arms the
                      next tap; that tap drops a correctly-sized box and
                      disarms. Boxes themselves are always draggable — they
                      carry touch-action:none, the overlay does not.
   ══════════════════════════════════════════════════════════════ */
if (typeof window !== 'undefined') (function () {
  'use strict';

  /** Local, so the component stays loadable without esignActions.js. */
  function peEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Friendly type names — the neutral value stays the wire form. */
  var PE_TYPE_NAMES = {
    signature: 'Signature', initial: 'Initial', date: 'Date',
    text: 'Fill-in', input_text: 'Text box',
    checkbox: 'Checkbox', dropdown: 'Dropdown', radio: 'Radio',
  };

  /** Sub-label in the type grid: whose job the field is. Two classes of field
      look identical on the page and behave nothing alike, so say it here. */
  var PE_TYPE_WHO = {
    signature: 'signer draws it', initial: 'signer initials',
    date: 'date they sign', text: 'WE type it',
    input_text: 'signer types', checkbox: 'signer ticks',
    dropdown: 'signer picks', radio: 'pick one of',
  };

  var PE_TYPE_ICON = {
    signature: 'fa-signature', initial: 'fa-pen-nib', date: 'fa-calendar-day',
    text: 'fa-i-cursor', input_text: 'fa-keyboard',
    checkbox: 'fa-square-check', dropdown: 'fa-list', radio: 'fa-circle-dot',
  };

  /** One-line "what is this for", shown under the type select in EDIT mode. */
  var PE_TYPE_HELP = {
    signature: 'The signer draws or adopts a signature here.',
    initial:   'A small initials box for the signer.',
    date:      'Filled with the date the signer signs.',
    text:      'WE fill this in before sending. The signer cannot edit it.',
    input_text: 'An empty box the SIGNER types into on the signing page.',
    checkbox:  'A tick box the signer can check.',
    dropdown:  'A list the signer picks one option from.',
    radio:     'One circle of a pick-one group. Give every circle the same Group.',
  };

  /** Types that get placed silently — nothing about them needs a decision, so
      reopening the drawer would only be something else to close. */
  var PE_SILENT_PLACE = { signature: 1, initial: 1, date: 1, checkbox: 1, input_text: 1 };

  var PE_ZOOM_STEPS = [50, 75, 100, 125, 150, 200];

  // ── styles (guarded single injection — esignActions.js idiom) ──
  function injectStyles() {
    if (document.getElementById('pe-styles')) return;
    var style = document.createElement('style');
    style.id = 'pe-styles';
    style.textContent = [
      '.pe-root { text-align:left; --pe-drawer-w:320px; --pe-tab-w:28px; }',
      '.pe-root button { font-family:inherit; }',

      /* ── the bar: the DOCUMENT, and nothing else ── */
      '.pe-bar { display:flex; align-items:center; gap:9px; flex-wrap:wrap;',
      '  padding:7px 9px; background:#f7f7f7; border:1px solid #ddd;',
      '  border-radius:4px 4px 0 0; font-size:13px; position:sticky; top:0; z-index:6; }',
      '.pe-bar label { font-weight:bold; }',
      '.pe-grp { display:inline-flex; align-items:center; gap:6px; }',
      '.pe-bar-sep { width:1px; height:20px; background:#ddd; }',
      '.pe-spacer { flex:1 1 auto; }',
      '.pe-hint { color:#888; font-size:11px; }',
      '.pe-btn { font-size:13px; padding:6px 10px; border:1px solid #bbb; border-radius:4px;',
      '  background:#fff; cursor:pointer; line-height:1.15; }',
      '.pe-btn:hover { background:#f0f0f0; }',
      '.pe-btn.pe-primary { background:#2563eb; border-color:#2563eb; color:#fff; font-weight:600; }',
      '.pe-btn.pe-primary:hover { background:#1d4fd7; }',
      '.pe-btn.pe-danger { color:#b91c1c; border-color:#e5b4b4; }',
      '.pe-btn.pe-danger:hover { background:#fef2f2; }',
      '.pe-btn[disabled] { opacity:.45; cursor:default; }',
      '.pe-zoombtn { width:30px; padding:6px 0; text-align:center; }',
      '.pe-zoomval { min-width:42px; text-align:center; font-size:12px; color:#555; }',
      '.pe-jump { width:50px; padding:6px; font-size:13px; }',
      /* live "what happens if you touch the page now" */
      '.pe-mode { font-size:12px; font-weight:600; color:#1d4fd7; display:none;',
      '  align-items:center; gap:6px; }',
      '.pe-mode.on { display:inline-flex; }',
      '.pe-mode .pe-mode-x { border:none; background:none; color:#888; cursor:pointer;',
      '  font-size:15px; line-height:1; padding:0 2px; }',

      /* ── body: pages full width, drawer OVER them ── */
      '.pe-body { position:relative; border:1px solid #ddd; border-top:none;',
      '  border-radius:0 0 4px 4px; background:#e5e7eb; overflow:hidden; }',
      '.pe-pages { max-height:74vh; overflow:auto; padding:14px 0;',
      '  -webkit-overflow-scrolling:touch; overscroll-behavior:contain; }',
      '.pe-page { position:relative; margin:0 auto 8px; box-shadow:0 1px 4px rgba(0,0,0,.35);',
      '  background:#fff; }',
      '.pe-page canvas { display:block; }',
      '.pe-overlay { position:absolute; inset:0; cursor:crosshair; touch-action:auto; }',
      /* Armed (touch): the overlay claims the gesture so a drag can size a box. */
      '.pe-pages.pe-armed .pe-overlay { touch-action:none; background:rgba(37,99,235,.05); }',
      '.pe-pagelabel { text-align:center; color:#6b7280; font-size:11px; margin:0 0 12px; }',
      '.pe-empty { padding:30px; text-align:center; color:#888; }',

      /* ── placed boxes ── */
      '.pe-box { position:absolute; box-sizing:border-box; border:2px solid;',
      '  background:rgba(37,99,235,.12); cursor:move; font-size:10px; touch-action:none; }',
      '.pe-box.pe-s2 { background:rgba(5,150,105,.12); }',
      '.pe-box.pe-text { background:rgba(217,119,6,.10); }',
      '.pe-box.pe-bad { border-style:dashed; box-shadow:0 0 0 2px rgba(220,38,38,.35); }',
      '.pe-box .pe-tag { position:absolute; top:-1px; left:-1px; color:#fff;',
      '  font-weight:bold; font-size:9px; padding:0 4px; border-radius:0 0 3px 0;',
      '  white-space:nowrap; pointer-events:none; line-height:13px; max-width:100%;',
      '  overflow:hidden; text-overflow:ellipsis; }',
      '.pe-box.pe-selected { border-style:solid; box-shadow:0 0 0 2px rgba(255,255,255,.7),',
      '  0 0 0 4px rgba(0,0,0,.25); z-index:3; }',
      '.pe-handle { position:absolute; right:-7px; bottom:-7px; width:13px; height:13px;',
      '  border:1px solid #fff; border-radius:2px; cursor:nwse-resize; display:none;',
      '  touch-action:none; }',
      '.pe-box.pe-selected .pe-handle { display:block; }',
      /* Fat touch target without a fat visual. */
      '.pe-handle::after { content:""; position:absolute; inset:-11px; }',
      '.pe-ctl { position:absolute; top:-22px; right:-1px; display:none; gap:3px; }',
      '.pe-box.pe-selected .pe-ctl { display:flex; }',
      '.pe-ctl button { font-size:11px; min-width:22px; padding:0 6px; line-height:19px;',
      '  border:1px solid #999; border-radius:3px; background:#fff; cursor:pointer;',
      '  touch-action:none; }',
      '.pe-rubber { position:absolute; border:1.5px dashed #374151;',
      '  background:rgba(55,65,81,.08); pointer-events:none; }',

      /* ── THE DRAWER ── absolutely positioned over the pages, closed by
         default. Width is fixed, so opening it never changes the pages
         column and never triggers a re-render. ── */
      '.pe-drawer { position:absolute; top:0; right:0; bottom:0;',
      '  width:var(--pe-drawer-w); max-width:86%;',
      '  display:flex; flex-direction:column; background:#fff;',
      '  border-left:1px solid #cfcfcf; box-shadow:-7px 0 20px rgba(0,0,0,.17);',
      '  transform:translateX(100%); transition:transform .2s ease-out;',
      '  z-index:20; font-size:13px; }',
      '.pe-drawer.pe-open { transform:translateX(0); }',

      /* The pull tab rides on the drawer's outer edge, so it sits at the frame
         edge when closed and at the drawer's edge when open. Anchored to the
         FRAME, not the scroller, so it holds one position over the page's
         right margin however far the document scrolls. */
      '.pe-tab { position:absolute; left:calc(-1 * var(--pe-tab-w)); top:44%;',
      '  width:var(--pe-tab-w); height:78px; padding:0;',
      '  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px;',
      '  background:#374151; color:#fff; border:none; border-radius:6px 0 0 6px;',
      '  cursor:pointer; box-shadow:-2px 0 7px rgba(0,0,0,.22); touch-action:none;',
      '  opacity:.82; transition:opacity .15s; }',
      '.pe-tab:hover, .pe-drawer.pe-open .pe-tab { opacity:1; }',
      '.pe-tab i { font-size:13px; }',
      '.pe-tab-n { font-size:10px; font-weight:700; background:rgba(255,255,255,.22);',
      '  border-radius:8px; padding:0 5px; line-height:15px; min-width:15px; text-align:center; }',
      '.pe-tab-grip { font-size:9px; opacity:.55; letter-spacing:1px; }',

      '.pe-drawer-head { display:flex; align-items:center; gap:7px; padding:9px 11px;',
      '  border-bottom:1px solid #e5e7eb; background:#fafafa; flex:0 0 auto; }',
      '.pe-panel-title { font-weight:700; font-size:13px; flex:1 1 auto;',
      '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.pe-panel-dot { width:10px; height:10px; border-radius:2px; flex:0 0 auto; }',
      '.pe-panel-x, .pe-back { border:none; background:none; font-size:19px; line-height:1;',
      '  color:#888; cursor:pointer; padding:0 4px; }',
      '.pe-back { display:none; font-size:21px; }',
      '.pe-drawer.pe-edit .pe-back { display:block; }',
      '.pe-drawer-scroll { flex:1 1 auto; overflow:auto; padding:11px;',
      '  -webkit-overflow-scrolling:touch; }',

      /* ── ADD mode: the type grid ── */
      '.pe-addgrid { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-bottom:11px; }',
      '.pe-tt { display:flex; flex-direction:column; align-items:flex-start; gap:1px;',
      '  padding:9px 8px; border:1px solid #d5d5d5; border-radius:6px; background:#fff;',
      '  cursor:pointer; text-align:left; line-height:1.25; }',
      '.pe-tt:hover { border-color:#2563eb; background:#f5f8ff; }',
      '.pe-tt.on { border-color:#2563eb; background:#eef4ff; box-shadow:inset 0 0 0 1px #2563eb; }',
      '.pe-tt-n { font-size:12.5px; font-weight:700; color:#111; }',
      '.pe-tt-n i { color:#2563eb; margin-right:5px; width:14px; text-align:center; }',
      '.pe-tt.pe-tt-fill .pe-tt-n i { color:#d97706; }',
      '.pe-tt-w { font-size:10.5px; color:#777; }',
      '.pe-place { width:100%; padding:11px; font-size:14px; }',
      '.pe-sect { font-size:11px; font-weight:700; color:#666; text-transform:uppercase;',
      '  letter-spacing:.4px; margin:0 0 6px; }',

      /* ── EDIT mode fields ── */
      '.pe-f { margin-bottom:11px; }',
      '.pe-f > label { display:block; font-weight:700; font-size:11px; color:#444;',
      '  text-transform:uppercase; letter-spacing:.4px; margin-bottom:4px; }',
      '.pe-f input[type=text], .pe-f input[type=number], .pe-f select {',
      '  width:100%; box-sizing:border-box; padding:8px; font-size:14px;',
      '  border:1px solid #ccc; border-radius:4px; background:#fff; color:#111; }',
      '.pe-f input:focus, .pe-f select:focus { outline:2px solid #93c5fd; outline-offset:-1px; }',
      '.pe-f .pe-sub { font-size:11px; color:#777; margin-top:4px; line-height:1.4; }',
      '.pe-f .pe-err { font-size:11.5px; color:#b91c1c; margin-top:4px; font-weight:600; }',
      '.pe-f input.pe-invalid { border-color:#dc2626; background:#fef2f2; }',
      '.pe-f .pe-check { display:flex; align-items:center; gap:8px; font-weight:normal;',
      '  text-transform:none; letter-spacing:0; font-size:13px; }',
      '.pe-f .pe-check input { width:auto; }',
      '.pe-row2 { display:flex; gap:8px; }',
      '.pe-row2 > * { flex:1 1 0; min-width:0; }',
      '.pe-seg { display:flex; }',
      '.pe-seg button { flex:1 1 0; padding:8px 4px; font-size:13px; border:1px solid #bbb;',
      '  background:#fff; cursor:pointer; }',
      '.pe-seg button:first-child { border-radius:4px 0 0 4px; }',
      '.pe-seg button:last-child { border-radius:0 4px 4px 0; border-left:none; }',
      '.pe-seg button.on { color:#fff; font-weight:700; border-color:transparent; }',
      '.pe-acts { display:flex; gap:6px; margin:14px 0 4px; }',
      '.pe-acts .pe-btn { flex:1 1 0; }',
      '.pe-adv { margin-top:2px; }',
      '.pe-adv > summary { cursor:pointer; font-size:11.5px; color:#2563eb; padding:3px 0; }',
      /* resolver binding — the HOST owns resolvers; this is just the doorway */
      '.pe-bind { display:flex; align-items:center; gap:6px; width:100%;',
      '  padding:8px; font-size:12.5px; border:1px dashed #c9c9c9; border-radius:4px;',
      '  background:#fafafa; cursor:pointer; text-align:left; color:#444; }',
      '.pe-bind:hover { border-color:#2563eb; color:#1d4fd7; background:#f5f8ff; }',
      '.pe-bind.on { border-style:solid; border-color:#059669; background:#f0fdf8; color:#065f46; }',
      '.pe-bind i { flex:0 0 auto; }',
      '.pe-bind span { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',

      /* field list */
      '.pe-list { border-top:1px solid #e5e7eb; padding:9px 11px 16px; }',
      '.pe-li { display:flex; align-items:center; gap:7px; width:100%; text-align:left;',
      '  padding:7px 6px; border:none; border-bottom:1px solid #f0f0f0;',
      '  background:none; cursor:pointer; font-size:12.5px; color:#222; }',
      '.pe-li:hover { background:#f5f8ff; }',
      '.pe-li.on { background:#eef4ff; font-weight:600; }',
      '.pe-li .pe-li-dot { width:9px; height:9px; border-radius:2px; flex:0 0 auto; }',
      '.pe-li .pe-li-txt { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.pe-li .pe-li-pg { color:#999; font-size:11px; flex:0 0 auto; }',
      '.pe-li.bad .pe-li-txt { color:#b91c1c; }',
      '.pe-none { color:#888; font-size:12px; padding:4px 0 8px; line-height:1.5; }',

      /* problems banner */
      '.pe-probs { background:#fef2f2; border:1px solid #fecaca; border-radius:5px;',
      '  padding:8px 10px; margin-bottom:11px; font-size:12px; color:#991b1b; }',
      '.pe-probs b { display:block; margin-bottom:3px; }',
      '.pe-probs button { display:block; margin-top:5px; background:none; border:none;',
      '  color:#991b1b; text-decoration:underline; cursor:pointer; padding:2px 0;',
      '  font-size:12px; text-align:left; }',

      '@media (max-width:820px) {',
      '  .pe-root { --pe-drawer-w:330px; }',
      '  .pe-pages { max-height:64vh; }',
      '}',
      /* Coarse pointers get bigger grab targets regardless of width. */
      '@media (any-pointer:coarse) {',
      '  .pe-handle { width:17px; height:17px; right:-9px; bottom:-9px; }',
      '  .pe-ctl button { min-width:30px; line-height:25px; font-size:13px; }',
      '  .pe-ctl { top:-28px; }',
      '  .pe-root { --pe-tab-w:34px; }',
      '  .pe-tab { height:92px; }',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  /**
   * PlacementEditor(container, opts)
   *
   *   opts.onChange   fn()      — fired after any field mutation (dirty tracking)
   *   opts.pdfjs      object    — pdf.js lib; default window.pdfjsLib
   *   opts.workerSrc  string    — set on GlobalWorkerOptions if given
   *   opts.keySuggest string[]  — declared prefill keys (template flow). When
   *                               present a newly drawn fill-in claims the next
   *                               UNPLACED one instead of minting field_N.
   *   opts.textValue  object    — optional, supplied by the one-time upload
   *                               flow, which OWNS the ad-hoc values:
   *         get(key) → string          current value
   *         set(key, value)            store it
   *         binding(key) → string      optional: label of a bound resolver, ''
   *                                    if none — rendered as a chip
   *         onBind(key)                optional: host opens its own resolver
   *                                    picker. The component never learns what
   *                                    a resolver IS; it only offers the door.
   *
   * API:
   *   await loadPdf(arrayBuffer, placementJson)  render + seed fields
   *   getPlacements() → neutral JSON (sorted)
   *   setPlacements(json)                        replace fields, re-render
   *   setZoom(pct)                               50…200
   *   validate() → [{uid, page, message}]        browser-side mirror of the
   *                                              server rules; [] when clean
   *   revealField(uid)                           select + scroll a box into view
   *   refreshTags()                              repaint tags after the host
   *                                              changed values behind us
   *   openDrawer(bool)                           show/hide the control drawer
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
    // Phase 2F sticky draw-state: the panel value is applied to the NEXT box
    // of its type AND live-updates the selected one. `checked` is deliberately
    // NOT sticky — a default belongs to one box, and drawing five pre-checked
    // boxes by accident is exactly the mistake it would make easy.
    // 2G note: _drawKey is GONE. Fill-in keys are minted (see _mintTextKey);
    // a sticky key silently welded two boxes to one value, which reads as a
    // bug every time it is not exactly what was wanted.
    this._drawMaxLen  = null;  // input_text
    this._drawDefault = '';    // input_text prefill
    this._drawOptions = [];    // dropdown choices
    this._drawDdDefault = '';  // dropdown default
    this._drawGroup   = '';    // radio group (sticky ACROSS boxes of a group)
    this._drawValue   = '';    // radio option value
    this._renderSeq = 0;
    this._scrollRaf = null;
    this._panelSig = null;
    this._lastRenderW = 0;
    this._armed = false;
    this._open = false;

    // Touch AVAILABLE (not "touch only") — a touchscreen laptop needs the
    // place button for its finger and free drag for its mouse, both at once.
    this._touch = !!(window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches);

    container.classList.add('pe-root');
    container.innerHTML =
      '<div class="pe-bar">' +
        '<span class="pe-grp">' +
          '<button type="button" class="pe-btn pe-zoombtn pe-zoom-out" title="Zoom out">\u2212</button>' +
          '<span class="pe-zoomval">100%</span>' +
          '<button type="button" class="pe-btn pe-zoombtn pe-zoom-in" title="Zoom in">+</button>' +
        '</span>' +
        '<span class="pe-bar-sep"></span>' +
        '<span class="pe-grp">' +
          '<label>Page</label>' +
          '<input class="pe-jump" type="number" min="1" value="1" title="Jump to page" ' +
            'spellcheck="false" autocomplete="off">' +
          '<span class="pe-pagecount pe-hint">of \u2013</span>' +
        '</span>' +
        '<span class="pe-spacer"></span>' +
        '<span class="pe-mode">' +
          '<span class="pe-mode-t"></span>' +
          '<button type="button" class="pe-mode-x" title="Cancel">\u00d7</button>' +
        '</span>' +
      '</div>' +
      '<div class="pe-body">' +
        '<div class="pe-pages"><div class="pe-empty">No document rendered yet.</div></div>' +
        '<div class="pe-drawer">' +
          '<button type="button" class="pe-tab" title="Fields \u2014 drag to move">' +
            '<i class="fa-solid fa-chevron-left pe-tab-i"></i>' +
            '<span class="pe-tab-n">0</span>' +
            '<span class="pe-tab-grip">\u22ee\u22ee</span>' +
          '</button>' +
          '<div class="pe-drawer-head">' +
            '<button type="button" class="pe-back" title="Back to all fields">\u2039</button>' +
            '<span class="pe-panel-dot" style="background:#bbb"></span>' +
            '<span class="pe-panel-title">Add a field</span>' +
            '<button type="button" class="pe-panel-x" title="Close">\u00d7</button>' +
          '</div>' +
          '<div class="pe-drawer-scroll">' +
            '<div class="pe-insp"></div>' +
            '<div class="pe-list"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var self = this;

    // ── bar wiring ───────────────────────────────────────────
    container.querySelector('.pe-zoom-out').addEventListener('click', function () { self._stepZoom(-1); });
    container.querySelector('.pe-zoom-in').addEventListener('click', function () { self._stepZoom(1); });
    container.querySelector('.pe-mode-x').addEventListener('click', function () {
      self._setArmed(false);
      self.openDrawer(true);
    });

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

    // ── drawer wiring: ONE delegated listener per event kind ──
    // Rebuilding the inspector re-creates its inputs, so per-input listeners
    // would have to be re-attached on every rebuild — and a rebuild mid-typing
    // would steal focus. Delegation plus a rebuild guarded by a signature
    // (see _renderPanel) means the input being typed into is never replaced.
    var drawer = container.querySelector('.pe-drawer');
    drawer.addEventListener('input',  function (e) { self._onPanelInput(e, false); });
    drawer.addEventListener('change', function (e) { self._onPanelInput(e, true); });
    drawer.addEventListener('click',  function (e) { self._onPanelClick(e); });

    container.querySelector('.pe-panel-x').addEventListener('click', function () {
      self.openDrawer(false);
    });
    container.querySelector('.pe-back').addEventListener('click', function () {
      self._select(null);          // EDIT → ADD, drawer stays open
    });
    this._wireTab(container.querySelector('.pe-tab'));

    this._keyHandler = function (e) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
                         t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (self._armed) { self._setArmed(false); self.openDrawer(true); return; }
        if (!typing && self.selectedUid != null) self._select(null);
        else if (!typing && self._open) self.openDrawer(false);
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (typing || self.selectedUid == null) return;
      e.preventDefault();
      self._deleteSelected();
    };
    document.addEventListener('keydown', this._keyHandler);

    // Rotating a phone changes the fit-width scale. Re-render only on a real
    // width change — a soft keyboard opening fires resize too, and re-rendering
    // every page because somebody tapped an input is not a feature. (Opening
    // the drawer can never trigger this: it is absolutely positioned, so the
    // pages column keeps its width.)
    this._onResize = function () {
      clearTimeout(self._resizeT);
      self._resizeT = setTimeout(function () {
        if (!self.pdfDoc) return;
        var pagesEl = self.container.querySelector('.pe-pages');
        if (!pagesEl || Math.abs(pagesEl.clientWidth - self._lastRenderW) < 40) return;
        self._renderAll();
      }, 260);
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);

    this._renderPanel(true);
    this._syncMode();
  }

  PlacementEditor.prototype.destroy = function () {
    document.removeEventListener('keydown', this._keyHandler);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    clearTimeout(this._resizeT);
    if (this.pdfDoc && this.pdfDoc.destroy) { try { this.pdfDoc.destroy(); } catch (_) { } }
    this.pdfDoc = null;
    this.container.innerHTML = '';
  };

  PlacementEditor.prototype.hasDocument = function () { return !!this.pdfDoc; };

  /** Scroll a page into view. Public — the send/admin UI can deep-link. */
  PlacementEditor.prototype.goToPage = function (n) {
    var wrap = this.container.querySelector('.pe-page[data-page="' + n + '"]');
    if (wrap) wrap.scrollIntoView({ block: 'start' });
  };

  /** Select a field AND bring it on screen, with the drawer open on it.
      Public — preflight uses it to point at the box it is complaining about
      instead of describing it. */
  PlacementEditor.prototype.revealField = function (uid) {
    var f = this.fields.find(function (o) { return o.uid === uid; });
    if (!f) return;
    this._select(uid);
    var el = this.container.querySelector('.pe-box[data-uid="' + uid + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
    else this.goToPage(f.page);
    this.openDrawer(true);
  };

  /** Browser-side mirror of the server placement rules. [] when clean. */
  PlacementEditor.prototype.validate = function () {
    return peFindProblems(this.fields);
  };

  /**
   * Repaint every box tag. Public because the HOST owns fill-in values
   * (opts.textValue) and can change them behind the editor's back — binding a
   * resolver and filling from the case both do. Without this the page would
   * show a blank the drawer says is filled.
   */
  PlacementEditor.prototype.refreshTags = function () {
    var self = this;
    this.fields.forEach(function (f) { self._liveTag(f); });
    this._renderPanel(true);
  };

  /** Show / hide the control drawer. */
  PlacementEditor.prototype.openDrawer = function (on) {
    this._open = !!on;
    var d = this.container.querySelector('.pe-drawer');
    if (d) d.classList.toggle('pe-open', this._open);
    var i = this.container.querySelector('.pe-tab-i');
    if (i) i.className = 'fa-solid pe-tab-i ' + (this._open ? 'fa-chevron-right' : 'fa-chevron-left');
    return this._open;
  };

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

  // ── the pull tab ───────────────────────────────────────────

  /**
   * Click toggles; a vertical drag moves the tab.
   *
   * The tab is the one piece of chrome that sits over the document, so it is
   * the one piece that can cover something. Two things keep it out of the way:
   * it is anchored to the editor FRAME rather than the scrolling page (so it
   * holds a single position over the right margin no matter how far you
   * scroll), and if that position ever lands on something it can be dragged
   * anywhere up or down the edge.
   */
  PlacementEditor.prototype._wireTab = function (tab) {
    var self = this;
    var moved = false;

    tab.addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      moved = false;
      var body = self.container.querySelector('.pe-body');
      var startY = ev.clientY;
      var startTop = tab.getBoundingClientRect().top - body.getBoundingClientRect().top;
      try { tab.setPointerCapture(ev.pointerId); } catch (_) { }

      function onMove(ev2) {
        if (ev2.pointerId !== ev.pointerId) return;
        if (Math.abs(ev2.clientY - startY) < 5) return;
        moved = true;
        var h = body.clientHeight || 400;
        var top = Math.min(Math.max(startTop + (ev2.clientY - startY), 4), h - tab.offsetHeight - 4);
        tab.style.top = top + 'px';
      }
      function onUp(ev2) {
        if (ev2.pointerId !== ev.pointerId) return;
        tab.removeEventListener('pointermove', onMove);
        tab.removeEventListener('pointerup', onUp);
        tab.removeEventListener('pointercancel', onUp);
        try { tab.releasePointerCapture(ev.pointerId); } catch (_) { }
        if (!moved) self.openDrawer(!self._open);
      }
      tab.addEventListener('pointermove', onMove);
      tab.addEventListener('pointerup', onUp);
      tab.addEventListener('pointercancel', onUp);
    });

    // Keyboard / synthetic clicks (and jsdom) never see the pointer sequence.
    tab.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (ev.detail === 0 || !ev.isTrusted) self.openDrawer(!self._open);
    });
  };

  // ── bar mode chip ──────────────────────────────────────────

  /** "What happens if you touch the page right now", in the bar. */
  PlacementEditor.prototype._syncMode = function () {
    var el = this.container.querySelector('.pe-mode');
    var txt = this.container.querySelector('.pe-mode-t');
    if (!el || !txt) return;
    var name = PE_TYPE_NAMES[this._drawType] || this._drawType;
    if (this._armed) {
      txt.textContent = 'Tap the page to place a ' + name;
      el.classList.add('on');
    } else if (!this._open && !this._touch) {
      txt.textContent = 'Drag to draw a ' + name;
      el.classList.add('on');
    } else {
      el.classList.remove('on');
    }
  };

  PlacementEditor.prototype._setArmed = function (on) {
    this._armed = !!on;
    var pages = this.container.querySelector('.pe-pages');
    if (pages) pages.classList.toggle('pe-armed', this._armed);
    // Arming means "the next tap is a placement" — a selected box would make
    // that tap a dismiss instead, which is the one thing it must not do.
    if (this._armed && this.selectedUid != null) this._select(null);
    this._syncMode();
  };

  PlacementEditor.prototype._stepZoom = function (dir) {
    var i = PE_ZOOM_STEPS.indexOf(this.zoom);
    if (i === -1) i = PE_ZOOM_STEPS.indexOf(100);
    var next = PE_ZOOM_STEPS[Math.min(Math.max(i + dir, 0), PE_ZOOM_STEPS.length - 1)];
    if (next !== this.zoom) this.setZoom(next);
  };

  // ── loading + rendering ────────────────────────────────────

  PlacementEditor.prototype.loadPdf = async function (arrayBuffer, placementJson) {
    if (this.pdfDoc && this.pdfDoc.destroy) { try { this.pdfDoc.destroy(); } catch (_) { } }
    this.pdfDoc = await this.pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    this._syncPageCount();
    if (placementJson) this._seed(placementJson); // silent — loading isn't a user edit
    await this._renderAll();
    this._renderPanel(true);
    // A fresh document has nothing on it: lead with the controls rather than
    // a blank page and a tab somebody has to notice.
    this.openDrawer(this.fields.length === 0);
    this._syncMode();
  };

  PlacementEditor.prototype.setZoom = async function (pct) {
    this.zoom = pct;
    var lbl = this.container.querySelector('.pe-zoomval');
    if (lbl) lbl.textContent = pct + '%';
    var out = this.container.querySelector('.pe-zoom-out');
    var inn = this.container.querySelector('.pe-zoom-in');
    if (out) out.disabled = pct <= PE_ZOOM_STEPS[0];
    if (inn) inn.disabled = pct >= PE_ZOOM_STEPS[PE_ZOOM_STEPS.length - 1];
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
    this._renderPanel(true);
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
    this._renderFieldList();   // safe on every keystroke: the list holds no inputs
    this._syncTabCount();
    if (typeof this.opts.onChange === 'function') this.opts.onChange();
  };

  PlacementEditor.prototype._syncTabCount = function () {
    var n = this.container.querySelector('.pe-tab-n');
    if (!n) return;
    var bad = peFindProblems(this.fields).length;
    n.textContent = bad ? '!' + bad : String(this.fields.length);
    n.style.background = bad ? '#dc2626' : 'rgba(255,255,255,.22)';
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
    this._lastRenderW = pagesEl.clientWidth;
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

  PlacementEditor.prototype._fieldColor = function (f) {
    return f.type === 'text'
      ? PE_TEXT_COLOR
      : (PE_SIGNER_COLORS[f.signer] || PE_SIGNER_COLORS[1]);
  };

  PlacementEditor.prototype._renderFields = function () {
    var self = this;
    var badUids = {};
    peFindProblems(this.fields).forEach(function (p) { badUids[p.uid] = true; });

    this.container.querySelectorAll('.pe-box').forEach(function (el) { el.remove(); });
    this.fields.forEach(function (f) {
      var vp = self.viewports[f.page];
      var wrap = self.container.querySelector('.pe-page[data-page="' + f.page + '"]');
      if (!vp || !wrap) return;    // field beyond the rendered page count — kept in data, not drawn
      var r = peNeutralToViewport(f, vp);
      var isText = f.type === 'text';
      var color = self._fieldColor(f);
      var box = document.createElement('div');
      box.className = 'pe-box' + (!isText && f.signer === 2 ? ' pe-s2' : '') +
        (isText ? ' pe-text' : '') +
        (badUids[f.uid] ? ' pe-bad' : '') +
        (f.uid === self.selectedUid ? ' pe-selected' : '');
      box.dataset.uid = String(f.uid);
      box.style.left = r.x + 'px';
      box.style.top = r.y + 'px';
      box.style.width = r.w + 'px';
      box.style.height = r.h + 'px';
      box.style.borderColor = color;
      box.innerHTML =
        '<span class="pe-tag" style="background:' + color + '">' + peEsc(self._tagFor(f)) + '</span>' +
        '<span class="pe-ctl">' +
          (isText ? '' :
            '<button class="pe-swap" title="Switch signer">S' + (f.signer === 1 ? 2 : 1) + '</button>') +
          '<button class="pe-del" title="Delete (Del)">\u00d7</button>' +
        '</span>' +
        '<span class="pe-handle" style="background:' + color + '"></span>';
      self._wireBox(box, f);
      wrap.appendChild(box);
    });
    this._syncTabCount();
  };

  /** On-page tag. Fill-ins show the VALUE once one exists — the point of the
      box is what it prints, and a page of boxes all reading "FILL · field_3"
      tells the author nothing about the document they are assembling. */
  PlacementEditor.prototype._tagFor = function (f) {
    if (f.type !== 'text') return peSignerTag(f);
    var tv = this.opts.textValue;
    var v = (tv && typeof tv.get === 'function' && f.key) ? (tv.get(f.key) || '') : '';
    if (v) return String(v).slice(0, 28);
    return 'FILL \u00b7 ' + (f.key || '?');
  };

  PlacementEditor.prototype._select = function (uid) {
    this.selectedUid = uid;
    var f = this._selected();
    if (f) {
      // The drawer mirrors the selection, and the selection's properties become
      // the sticky draw-state for the next box of that type.
      this._drawType = f.type;
      if (f.type !== 'text') {
        this._drawSigner = f.signer;
        if (f.type === 'input_text') {
          this._drawMaxLen  = (typeof f.max_length === 'number') ? f.max_length : null;
          this._drawDefault = f.default || '';
        } else if (f.type === 'dropdown') {
          this._drawOptions   = Array.isArray(f.options) ? f.options.slice() : [];
          this._drawDdDefault = f.default || '';
        } else if (f.type === 'radio') {
          this._drawGroup = f.group || '';
          this._drawValue = f.value || '';
        }
      }
    }
    this._renderFields();
    this._renderPanel();
    this._syncMode();
  };

  PlacementEditor.prototype._deleteSelected = function () {
    var uid = this.selectedUid;
    if (uid == null) return;
    this.fields = this.fields.filter(function (f) { return f.uid !== uid; });
    this.selectedUid = null;
    this._renderFields();
    this._renderPanel();
    this._changed();
  };

  PlacementEditor.prototype._retype = function (f, type) {
    if (f.type === type) return;
    f.type = type;
    // Per-type properties do NOT survive a retype — a dropdown retyped to a
    // checkbox that silently kept `options` would fail server validation (or
    // worse, pass it and confuse the provider). Strip everything the NEW type
    // doesn't own, then let the drawer re-apply its current values.
    delete f.max_length; delete f.default; delete f.checked;
    delete f.options; delete f.group; delete f.value;
    if (type === 'text') {
      delete f.signer;                       // server THROWS on text+signer
      delete f.label;
      if (!f.key) f.key = this._mintTextKey();
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
    this._select(f.uid);   // drawer must mirror the now-stripped properties
    this._changed();
  };

  /**
   * A key for a NEW fill-in box.
   *
   * Template flow (opts.keySuggest non-empty): claim the next DECLARED key
   * that is not placed yet. Minting field_N there would guarantee a
   * "placed key not in the schema" warning on every single box.
   *
   * Upload flow: mint field_1, field_2… The author never has to invent an
   * identifier — which is the whole reason a key of "$1000" was ever typed.
   * They rename it only when two boxes should share one value.
   */
  PlacementEditor.prototype._mintTextKey = function () {
    var sug = this.opts.keySuggest || [];
    if (sug.length) {
      var used = {};
      this.fields.forEach(function (f) { if (f.type === 'text' && f.key) used[f.key] = true; });
      for (var i = 0; i < sug.length; i++) if (!used[sug[i]]) return sug[i];
      return '';   // every declared key is already placed — the author picks
    }
    return peNextFreeKey(this.fields, 'field');
  };

  // ══ THE DRAWER ══════════════════════════════════════════════

  /**
   * Rebuild the drawer body, but ONLY when the thing it describes changed
   * identity — otherwise a keystroke would replace the input being typed into
   * and focus would jump to the top on every character.
   */
  PlacementEditor.prototype._renderPanel = function (force) {
    var f = this._selected();
    var sig = f ? (f.uid + '|' + f.type) : ('add|' + this._drawType);
    var insp = this.container.querySelector('.pe-insp');
    if (!insp) return;
    if (force || sig !== this._panelSig) {
      this._panelSig = sig;
      insp.innerHTML = f ? this._inspectorHtml(f) : this._addModeHtml();
    }
    var drawer = this.container.querySelector('.pe-drawer');
    if (drawer) drawer.classList.toggle('pe-edit', !!f);
    this._syncPanelChrome();
    this._renderFieldList();
    this._syncTabCount();
  };

  PlacementEditor.prototype._syncPanelChrome = function () {
    var f = this._selected();
    var dot   = this.container.querySelector('.pe-panel-dot');
    var title = this.container.querySelector('.pe-panel-title');
    if (!dot || !title) return;
    if (f) {
      dot.style.background = this._fieldColor(f);
      title.textContent = (PE_TYPE_NAMES[f.type] || f.type) +
        (f.type === 'text' ? '' : ' \u00b7 Signer ' + f.signer) +
        ' \u00b7 p' + f.page;
    } else {
      dot.style.background = '#bbb';
      title.textContent = 'Add a field';
    }
  };

  /**
   * ADD mode. The type grid used to be a <select> in the bar; here it has room
   * to say what each type IS, which matters because `text` and `input_text`
   * look identical on the page and are opposites — one we fill before sending,
   * one the signer types into.
   */
  PlacementEditor.prototype._addModeHtml = function () {
    var self = this;
    var probs = peFindProblems(this.fields);
    return this._problemsHtml(probs) +
      '<div class="pe-sect">Add a field</div>' +
      '<div class="pe-addgrid">' +
        PE_FIELD_TYPES.map(function (t) {
          return '<button type="button" class="pe-tt' +
            (t === self._drawType ? ' on' : '') + (t === 'text' ? ' pe-tt-fill' : '') +
            '" data-pe="addtype" data-t="' + t + '">' +
            '<span class="pe-tt-n"><i class="fa-solid ' + PE_TYPE_ICON[t] + '"></i>' +
              peEsc(PE_TYPE_NAMES[t] || t) + '</span>' +
            '<span class="pe-tt-w">' + peEsc(PE_TYPE_WHO[t] || '') + '</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<button type="button" class="pe-btn pe-primary pe-place" data-pe="place">' +
        '<i class="fa-solid fa-crosshairs"></i> ' +
        (this._touch ? 'Place on the page' : 'Place \u2014 or drag on the page') +
      '</button>' +
      '<div class="pe-none" style="margin-top:9px">' +
        (this._touch
          ? 'Tap a placed box to name it, set what it prints, or delete it.'
          : 'Drag on the page to draw one at any size. Click a placed box to edit it.') +
      '</div>';
  };

  PlacementEditor.prototype._problemsHtml = function (probs) {
    if (!probs.length) return '';
    return '<div class="pe-probs"><b>' + probs.length +
      (probs.length === 1 ? ' thing needs fixing' : ' things need fixing') + ' before sending</b>' +
      probs.slice(0, 6).map(function (p) {
        return '<button type="button" data-pe="goto" data-uid="' + p.uid + '">' +
          peEsc(p.message) + '</button>';
      }).join('') +
      (probs.length > 6 ? '<div>\u2026and ' + (probs.length - 6) + ' more</div>' : '') +
      '</div>';
  };

  /** EDIT mode: everything about the selected field. */
  PlacementEditor.prototype._inspectorHtml = function (f) {
    var h = '';
    var isText = f.type === 'text';

    h += '<div class="pe-f"><label>Field type</label>' +
      '<select data-pe="type">' +
        PE_FIELD_TYPES.map(function (t) {
          return '<option value="' + t + '"' + (t === f.type ? ' selected' : '') + '>' +
            peEsc(PE_TYPE_NAMES[t] || t) + '</option>';
        }).join('') +
      '</select>' +
      '<div class="pe-sub">' + peEsc(PE_TYPE_HELP[f.type] || '') + '</div></div>';

    if (isText) {
      h += this._textInspectorHtml(f);
    } else {
      h += '<div class="pe-f"><label>Who signs this</label>' +
        '<div class="pe-seg">' +
          '<button type="button" data-pe="signer" data-v="1"' +
            (f.signer === 1 ? ' class="on" style="background:' + PE_SIGNER_COLORS[1] + '"' : '') +
            '>Signer 1</button>' +
          '<button type="button" data-pe="signer" data-v="2"' +
            (f.signer === 2 ? ' class="on" style="background:' + PE_SIGNER_COLORS[2] + '"' : '') +
            '>Signer 2</button>' +
        '</div></div>';

      if (f.type !== 'radio') {
        h += '<div class="pe-f"><label>Shown to signer</label>' +
          '<input type="text" data-pe="label" maxlength="' + PE_PLACEMENT_LABEL_MAX + '" ' +
            'placeholder="e.g. Client initials" spellcheck="false" autocomplete="off" ' +
            'value="' + peEsc(f.label || '') + '">' +
          '<div class="pe-sub">Optional. What the signer reads inside the box.</div></div>';
      }

      if (f.type === 'input_text') {
        h += '<div class="pe-row2">' +
          '<div class="pe-f"><label>Max length</label>' +
            '<input type="number" data-pe="maxlen" min="1" max="2048" placeholder="\u2013" ' +
              'value="' + (f.max_length != null ? peEsc(f.max_length) : '') + '"></div>' +
          '<div class="pe-f"><label>Prefill</label>' +
            '<input type="text" data-pe="idefault" placeholder="optional" spellcheck="false" ' +
              'autocomplete="off" value="' + peEsc(f.default || '') + '"></div>' +
          '</div>' +
          '<div class="pe-sub" style="margin:-6px 0 11px">Prefilled text the signer can still edit.</div>';
      } else if (f.type === 'checkbox') {
        h += '<div class="pe-f"><label class="pe-check">' +
          '<input type="checkbox" data-pe="checked"' + (f.checked === true ? ' checked' : '') + '> ' +
          'Ticked by default</label></div>';
      } else if (f.type === 'dropdown') {
        h += '<div class="pe-f"><label>Options</label>' +
          '<input type="text" data-pe="options" placeholder="Chapter 7, Chapter 13" ' +
            'spellcheck="false" autocomplete="off" ' +
            'value="' + peEsc((f.options || []).join(', ')) + '">' +
          '<div class="pe-sub">Comma-separated, in the order the signer sees them.</div></div>' +
          '<div class="pe-f"><label>Pre-selected</label>' +
          '<input type="text" data-pe="ddefault" placeholder="optional" spellcheck="false" ' +
            'autocomplete="off" value="' + peEsc(f.default || '') + '">' +
          '<div class="pe-sub">Must be one of the options above.</div></div>';
      } else if (f.type === 'radio') {
        h += '<div class="pe-f"><label>Group</label>' +
          '<input type="text" data-pe="group" maxlength="' + PE_OPTION_TEXT_MAX + '" placeholder="e.g. Approve?" ' +
            'spellcheck="false" autocomplete="off" value="' + peEsc(f.group || '') + '">' +
          '<div class="pe-sub">Every circle of one question shares this. It is also what the signer reads.</div></div>' +
          '<div class="pe-f"><label>This option means</label>' +
          '<input type="text" data-pe="rvalue" maxlength="' + PE_OPTION_TEXT_MAX + '" placeholder="e.g. Yes" ' +
            'spellcheck="false" autocomplete="off" value="' + peEsc(f.value || '') + '"></div>' +
          '<div class="pe-f"><label class="pe-check">' +
          '<input type="checkbox" data-pe="rchecked"' + (f.checked === true ? ' checked' : '') + '> ' +
          'Selected by default</label></div>';
      }
    }

    // Optional/required — the choice & input types only. Signature, initial
    // and date stay mandatory: an optional signature on a legal document is a
    // hole, not a feature (the server would allow it; the editor won't).
    if (!isText && (f.type === 'input_text' || f.type === 'checkbox' ||
                    f.type === 'dropdown'   || f.type === 'radio')) {
      h += '<div class="pe-f"><label class="pe-check">' +
        '<input type="checkbox" data-pe="req"' + (f.required === false ? '' : ' checked') + '> ' +
        'Signer must complete this</label>' +
        (f.type === 'radio'
          ? '<div class="pe-sub">Applies to the whole "' + peEsc(f.group || '?') + '" group.</div>'
          : '<div class="pe-sub">Untick to let the signer skip it.</div>') +
        '</div>';
    }

    h += '<div class="pe-acts">' +
      '<button type="button" class="pe-btn" data-pe="dup"><i class="fa-solid fa-clone"></i> Duplicate</button>' +
      '<button type="button" class="pe-btn pe-danger" data-pe="del"><i class="fa-solid fa-trash-can"></i> Delete</button>' +
      '</div>';
    return h;
  };

  /**
   * Fill-in inspector. VALUE first, key demoted to an "advanced" disclosure.
   *
   * The key exists so several boxes can share one value and so a value can be
   * bound to a case resolver. For the overwhelmingly common one-box-one-value
   * case it is pure ceremony — and being asked to "name" a box is exactly what
   * produced a key of "$1000": the author was told to name the thing and
   * answered with what belongs IN it. So the box names itself and the primary
   * input asks the question the author is actually holding in mind.
   *
   * The resolver binding is a DOOR, not a control: the host owns resolvers
   * (they are a send-flow concept), so this renders a chip and calls
   * opts.textValue.onBind. The component never learns what a resolver is.
   */
  PlacementEditor.prototype._textInspectorHtml = function (f) {
    var tv = this.opts.textValue;
    var h = '';
    if (tv && typeof tv.get === 'function') {
      h += '<div class="pe-f"><label>Value \u2014 what prints here</label>' +
        '<input type="text" data-pe="value" spellcheck="false" autocomplete="off" ' +
          'placeholder="e.g. $1,000.00" value="' + peEsc(tv.get(f.key) || '') + '">' +
        '<div class="pe-sub">Typed onto the PDF before it is sent. The signer cannot change it.</div></div>';

      if (typeof tv.onBind === 'function') {
        var bound = (typeof tv.binding === 'function' ? (tv.binding(f.key) || '') : '');
        h += '<div class="pe-f">' +
          '<button type="button" class="pe-bind' + (bound ? ' on' : '') + '" data-pe="bind">' +
            '<i class="fa-solid ' + (bound ? 'fa-link' : 'fa-wand-magic-sparkles') + '"></i>' +
            '<span>' + (bound
              ? 'From the case: ' + peEsc(bound)
              : 'Pull this from the case\u2026') + '</span>' +
          '</button></div>';
      }
    }
    var err = peTextKeyError(f.key);
    var sug = this.opts.keySuggest || [];
    h += '<details class="pe-adv"' + (err ? ' open' : '') + '>' +
      '<summary>Key: <b>' + peEsc(f.key || '(none)') + '</b> \u2014 ' +
        (err ? 'needs fixing' : 'change only to reuse a value') + '</summary>' +
      '<div class="pe-f" style="margin-top:7px"><label>Key</label>' +
        '<input type="text" data-pe="key" class="' + (err ? 'pe-invalid' : '') + '" ' +
          (sug.length ? 'list="pe-key-list-' + this._uid + '" ' : '') +
          'spellcheck="false" autocomplete="off" value="' + peEsc(f.key || '') + '">' +
        (sug.length
          ? '<datalist id="pe-key-list-' + this._uid + '">' +
            sug.map(function (k) { return '<option value="' + peEsc(k) + '">'; }).join('') +
            '</datalist>'
          : '') +
        '<div class="pe-err" data-pe-err="key"' + (err ? '' : ' style="display:none"') + '>' +
          peEsc(err) + '</div>' +
        '<div class="pe-sub">Letters, numbers, _ . and - only. Two boxes with the same key print the same value.</div>' +
        (err ? '<button type="button" class="pe-btn" style="margin-top:6px" data-pe="fixkey">' +
               'Fix it for me \u2192 ' + peEsc(peSlugifyKey(f.key)) + '</button>' : '') +
      '</div></details>';
    return h;
  };

  PlacementEditor.prototype._renderFieldList = function () {
    var self = this;
    var el = this.container.querySelector('.pe-list');
    if (!el) return;
    if (!this.fields.length) { el.innerHTML = ''; return; }
    var bad = {};
    peFindProblems(this.fields).forEach(function (p) { bad[p.uid] = true; });
    var tv = this.opts.textValue;
    el.innerHTML = '<div class="pe-sect">' + this.fields.length + ' field' +
      (this.fields.length === 1 ? '' : 's') + ' on this document</div>' +
      peSortFields(this.fields).map(function (f) {
        // Fill-ins list what they PRINT when they have it — this list is also
        // the "check everything before sending" surface that used to live in
        // the send form, below the document.
        var txt = peFieldSummary(f);
        if (f.type === 'text' && tv && typeof tv.get === 'function') {
          var v = tv.get(f.key) || '';
          if (v) txt = 'Fill-in \u00b7 ' + v;
        }
        return '<button type="button" class="pe-li' +
          (f.uid === self.selectedUid ? ' on' : '') + (bad[f.uid] ? ' bad' : '') +
          '" data-pe="goto" data-uid="' + f.uid + '">' +
          '<span class="pe-li-dot" style="background:' + self._fieldColor(f) + '"></span>' +
          '<span class="pe-li-txt">' + peEsc(txt) + '</span>' +
          '<span class="pe-li-pg">p' + f.page + '</span></button>';
      }).join('');
  };

  /** Refresh a box's on-page tag without a full re-render (per-keystroke). */
  PlacementEditor.prototype._liveTag = function (f) {
    var el = this.container.querySelector('.pe-box[data-uid="' + f.uid + '"] .pe-tag');
    if (el) el.textContent = this._tagFor(f);
    this._refreshBadFlags();
  };

  /**
   * Toggle the "this box would be rejected" outline on the boxes already in
   * the DOM. Cheap enough for a keystroke (one pass over fields, then a class
   * toggle) and — unlike _renderFields — it does not replace elements, so a
   * drag or a focused input is never yanked out from under the user.
   */
  PlacementEditor.prototype._refreshBadFlags = function () {
    var bad = {};
    peFindProblems(this.fields).forEach(function (p) { bad[p.uid] = true; });
    this.container.querySelectorAll('.pe-box').forEach(function (el) {
      el.classList.toggle('pe-bad', !!bad[el.dataset.uid]);
    });
    this._syncTabCount();
  };

  /**
   * Delegated drawer input. `commit` distinguishes the 'change' event (blur /
   * Enter / select) from 'input' (per keystroke): keystrokes update the model
   * and the on-page tag cheaply, commits do the full re-render.
   */
  PlacementEditor.prototype._onPanelInput = function (ev, commit) {
    var t = ev.target;
    var what = t && t.dataset ? t.dataset.pe : null;
    if (!what) return;
    var f = this._selected();
    if (!f) return;
    var v = t.value;

    switch (what) {
      case 'type':
        if (commit || t.tagName === 'SELECT') {
          this._drawType = v;
          this._retype(f, v);
          this._renderPanel(true);
        }
        return;

      case 'label':
        if (f.type === 'text') return;
        if (v.trim()) f.label = v.trim(); else delete f.label;
        this._liveTag(f);
        break;

      case 'key': {
        if (f.type !== 'text') return;
        var next = v.trim();
        var tv = this.opts.textValue;
        // Carry the typed value across a rename, or renaming a box silently
        // blanks what it prints.
        if (tv && typeof tv.set === 'function' && f.key && next && next !== f.key) {
          var carried = tv.get(f.key);
          if (carried) tv.set(next, carried);
        }
        f.key = next;
        var err = peTextKeyError(next);
        var errEl = this.container.querySelector('[data-pe-err="key"]');
        if (errEl) {
          errEl.textContent = err;
          errEl.style.display = err ? '' : 'none';
        }
        t.classList.toggle('pe-invalid', !!err);
        this._liveTag(f);
        break;
      }

      case 'value': {
        if (f.type !== 'text') return;
        var tvs = this.opts.textValue;
        if (tvs && typeof tvs.set === 'function') tvs.set(f.key, v);
        this._liveTag(f);
        break;
      }

      case 'maxlen': {
        if (f.type !== 'input_text') return;
        var n = parseInt(v, 10);
        this._drawMaxLen = (isFinite(n) && n >= 1) ? Math.floor(n) : null;
        if (this._drawMaxLen != null) f.max_length = this._drawMaxLen; else delete f.max_length;
        break;
      }

      case 'idefault':
        if (f.type !== 'input_text') return;
        this._drawDefault = v;
        if (v) f.default = v; else delete f.default;
        break;

      case 'checked':
        if (f.type !== 'checkbox') return;
        if (t.checked) f.checked = true; else delete f.checked;
        commit = true;
        break;

      case 'req': {
        // Stored only in the false form — absent means required (server
        // default), so ticking the box DELETES the key rather than writing
        // required:true noise into every field.
        var applyReq = function (o) {
          if (t.checked) delete o.required; else o.required = false;
        };
        if (f.type === 'radio') {
          // The server validates required PER GROUP (mixed groups throw), so
          // the editor keeps every circle of the group in agreement.
          var grp = f.group;
          this.fields.forEach(function (o) {
            if (o.type === 'radio' && o.group === grp) applyReq(o);
          });
        } else if (f.type === 'input_text' || f.type === 'checkbox' || f.type === 'dropdown') {
          applyReq(f);
        } else return;
        this._renderFieldList();   // '· optional' markers follow the toggle live
        commit = true;
        break;
      }

      case 'options':
        if (f.type !== 'dropdown') return;
        this._drawOptions = peParseOptions(v);
        f.options = this._drawOptions.slice();
        break;

      case 'ddefault':
        if (f.type !== 'dropdown') return;
        this._drawDdDefault = v.trim();
        if (this._drawDdDefault) f.default = this._drawDdDefault; else delete f.default;
        break;

      case 'group':
        if (f.type !== 'radio') return;
        this._drawGroup = v.trim();
        f.group = this._drawGroup;
        this._liveTag(f);
        break;

      case 'rvalue':
        if (f.type !== 'radio') return;
        this._drawValue = v.trim();
        f.value = this._drawValue;
        this._liveTag(f);
        break;

      case 'rchecked': {
        if (f.type !== 'radio') return;
        if (t.checked) {
          // A group has ONE default — mirror the server rule here rather than
          // letting the author save into a guaranteed rejection.
          this.fields.forEach(function (o) {
            if (o !== f && o.type === 'radio' && o.group === f.group) delete o.checked;
          });
          f.checked = true;
        } else {
          delete f.checked;
        }
        commit = true;
        break;
      }

      default:
        return;
    }

    if (commit) this._renderFields(); else this._refreshBadFlags();
    // Fill-in key/value changes must reach the host on EVERY keystroke: the
    // send form's dirty tracking is driven by onChange, and the blur-'change'
    // event is unreliable here (clicking the PDF preventDefault()s the
    // pointerdown, so no blur fires).
    this._changed();
  };

  PlacementEditor.prototype._onPanelClick = function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-pe]') : null;
    if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'SELECT') return;
    var what = btn.dataset.pe;
    var f = this._selected();

    if (what === 'goto') {
      this.revealField(parseInt(btn.dataset.uid, 10));
      return;
    }
    if (what === 'addtype') {
      this._drawType = btn.dataset.t;
      this._renderPanel(true);
      // Choosing a type means "I am about to place one" — get out of the way.
      // Touch needs the arm as well; a mouse can just drag.
      if (this._touch) this._setArmed(true);
      this.openDrawer(false);
      this._syncMode();
      return;
    }
    if (what === 'place') {
      if (this._touch) this._setArmed(true);
      this.openDrawer(false);
      this._syncMode();
      return;
    }
    if (what === 'signer' && f) {
      this._setSigner(f, parseInt(btn.dataset.v, 10) || 1);
      this._renderPanel(true);
      return;
    }
    if (what === 'del' && f) { this._deleteSelected(); return; }
    if (what === 'dup' && f) { this._duplicate(f); return; }
    if (what === 'bind' && f && f.type === 'text') {
      var tv = this.opts.textValue;
      if (tv && typeof tv.onBind === 'function') tv.onBind(f.key);
      return;
    }
    if (what === 'fixkey' && f && f.type === 'text') {
      var fixed = peSlugifyKey(f.key);
      var tvf = this.opts.textValue;
      if (tvf && typeof tvf.set === 'function' && f.key) {
        var carried = tvf.get(f.key);
        if (carried) tvf.set(fixed, carried);
      }
      f.key = fixed;
      this._renderFields();
      this._renderPanel(true);
      this._changed();
    }
  };

  PlacementEditor.prototype._setSigner = function (f, to) {
    if (f.type === 'text' || f.signer === to) return;
    this._drawSigner = to;
    if (f.type === 'radio') {
      // A group belongs to exactly one signer (server rule) — moving one
      // circle must carry its siblings, or the next save is a guaranteed
      // rejection the author did not ask for.
      var g = f.group;
      this.fields.forEach(function (o) {
        if (o.type === 'radio' && o.group === g) o.signer = to;
      });
    } else {
      f.signer = to;
    }
    this._renderFields();
    this._changed();
  };

  /** Copy the selected box a little up-page. Cheap, and the difference
      between placing twelve initials boxes and placing one twelve times. */
  PlacementEditor.prototype._duplicate = function (f) {
    var copy = JSON.parse(JSON.stringify(f));
    copy.uid = ++this._uid;
    delete copy.checked;                          // a default belongs to ONE box
    if (copy.type === 'text') copy.key = this._mintTextKey();
    if (copy.type === 'radio') copy.value = '';   // never mint a duplicate value
    var vp = this.viewports[f.page];
    var size = vp ? pePageSize(vp) : { w: 612, h: 792 };
    var r = peNormalizeRect({ x: f.x, y: f.y - f.h - 6, w: f.w, h: f.h },
                            copy.type, size.w, size.h);
    copy.x = r.x; copy.y = r.y; copy.w = r.w; copy.h = r.h;
    this.fields.push(copy);
    this._select(copy.uid);
    this._changed();
  };

  // ── interactions ───────────────────────────────────────────

  /** Pointer position in a page wrapper's CSS-px space. */
  function localPoint(wrap, ev) {
    var rect = wrap.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /** Movement below this (CSS px) is a tap, not a drag. */
  var PE_TAP_SLOP = 6;

  /** Drop a default-sized box of the current type centred on a page point. */
  PlacementEditor.prototype._placeAt = function (pageNum, ptPx) {
    var vp = this.viewports[pageNum];
    if (!vp) return;
    var size = pePageSize(vp);
    var d = peDefaultSize(this._drawType);
    // Size is defined in POINTS, so convert a zero-area point to neutral and
    // grow it there — the box is the same physical size at every zoom.
    var at = peViewportToNeutral({ x: ptPx.x, y: ptPx.y, w: 0, h: 0 }, vp);
    var r = peNormalizeRect(
      { x: at.x - d.w / 2, y: at.y - d.h / 2, w: d.w, h: d.h },
      this._drawType, size.w, size.h);
    this._commitNewField(pageNum, r);
  };

  /** Shared tail of both placement paths (drag-drawn and tap-placed). */
  PlacementEditor.prototype._commitNewField = function (pageNum, r) {
    var self = this;
    var f = {
      uid: ++this._uid, page: pageNum,
      x: r.x, y: r.y, w: r.w, h: r.h,
      type: this._drawType,
    };
    if (this._drawType === 'text') {
      f.key = this._mintTextKey();
    } else {
      f.signer = this._drawSigner;
      // Phase 2F: sticky properties transfer to the new box so a run of
      // same-shaped fields (five dropdowns with the same choices; the circles
      // of one radio group) doesn't mean re-typing per box.
      if (this._drawType === 'input_text') {
        if (this._drawMaxLen != null) f.max_length = this._drawMaxLen;
        if (this._drawDefault) f.default = this._drawDefault;
      } else if (this._drawType === 'dropdown') {
        f.options = this._drawOptions.slice();
        if (this._drawDdDefault) f.default = this._drawDdDefault;
      } else if (this._drawType === 'radio') {
        f.group = this._drawGroup;
        // The sticky VALUE transfers only if no sibling already claims it —
        // drawing "Yes" then a second circle should demand a new name, not
        // silently mint a duplicate the server will reject.
        var taken = this.fields.some(function (o) {
          return o.type === 'radio' && o.group === self._drawGroup &&
                 o.value === self._drawValue && self._drawValue !== '';
        });
        f.value = taken ? '' : this._drawValue;
        if (taken) this._drawValue = '';
      }
    }
    this.fields.push(f);
    this._select(f.uid);
    this._changed();

    // Reopen the drawer only for a field that needs a decision. A signature or
    // a date needs nothing, so a run of them stays one gesture each; a fill-in
    // with no value, or anything the validator flags, gets the drawer back.
    var needs = !PE_SILENT_PLACE[f.type] || peFindProblems([f]).length > 0;
    if (needs) this.openDrawer(true);
  };

  PlacementEditor.prototype._wireOverlay = function (overlay, pageNum) {
    var self = this;

    overlay.addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      // Touch/pen only claims the gesture when armed — otherwise the finger
      // belongs to the scroller, which is the whole reason the arm exists.
      // A mouse always draws.
      var isMouse = ev.pointerType === 'mouse' || ev.pointerType === undefined;
      if (!isMouse && !self._armed) return;

      ev.preventDefault();
      var wrap = overlay.parentNode;
      var start = localPoint(wrap, ev);
      var moved = false;
      var rubber = document.createElement('div');
      rubber.className = 'pe-rubber';
      wrap.appendChild(rubber);
      try { overlay.setPointerCapture(ev.pointerId); } catch (_) { }

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
        if (ev2.pointerId !== ev.pointerId) return;
        var r = toRect(ev2);
        if (r.w > PE_TAP_SLOP || r.h > PE_TAP_SLOP) moved = true;
        rubber.style.left = r.x + 'px'; rubber.style.top = r.y + 'px';
        rubber.style.width = r.w + 'px'; rubber.style.height = r.h + 'px';
      }
      function onUp(ev2) {
        if (ev2.pointerId !== ev.pointerId) return;
        overlay.removeEventListener('pointermove', onMove);
        overlay.removeEventListener('pointerup', onUp);
        overlay.removeEventListener('pointercancel', onUp);
        try { overlay.releasePointerCapture(ev.pointerId); } catch (_) { }
        rubber.remove();

        if (moved) {
          var vp = self.viewports[pageNum];
          var size = pePageSize(vp);
          var neutral = peViewportToNeutral(toRect(ev2), vp);
          if (self._armed) self._setArmed(false);
          self._commitNewField(pageNum, peNormalizeRect(neutral, self._drawType, size.w, size.h));
          return;
        }

        // A TAP on empty page.
        //   armed (touch)            → place, then disarm.
        //   something selected       → dismiss it.
        //   nothing selected (mouse) → place, so a click is never a dead end.
        if (self._armed) {
          self._setArmed(false);
          self._placeAt(pageNum, start);
        } else if (self.selectedUid != null) {
          self._select(null);
        } else {
          self._placeAt(pageNum, start);
        }
      }
      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerup', onUp);
      overlay.addEventListener('pointercancel', onUp);
    });
  };

  PlacementEditor.prototype._wireBox = function (box, f) {
    var self = this;

    var del = box.querySelector('.pe-del');
    del.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      self.selectedUid = f.uid;
      self._deleteSelected();
    });

    var swap = box.querySelector('.pe-swap'); // absent on text boxes
    if (swap) {
      swap.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
      swap.addEventListener('click', function (ev) {
        ev.stopPropagation();
        self._setSigner(f, f.signer === 1 ? 2 : 1);
        self._select(f.uid);
      });
    }

    // move (drag the box) — live in px, committed to neutral on pointerup
    box.addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      if (ev.target.classList.contains('pe-handle')) return;   // resize path
      ev.preventDefault();
      ev.stopPropagation();
      var wasSelected = self.selectedUid === f.uid;
      if (!wasSelected) self._select(f.uid);
      var el = self.container.querySelector('.pe-box[data-uid="' + f.uid + '"]');
      if (!el) return;
      var wrap = el.parentNode;
      var start = localPoint(wrap, ev);
      var orig = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
      var w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      var movedAny = false;
      try { el.setPointerCapture(ev.pointerId); } catch (_) { }

      function onMove(ev2) {
        if (ev2.pointerId !== ev.pointerId) return;
        var p = localPoint(wrap, ev2);
        var nx = Math.min(Math.max(orig.x + (p.x - start.x), 0), wrap.clientWidth - w);
        var ny = Math.min(Math.max(orig.y + (p.y - start.y), 0), wrap.clientHeight - h);
        // 3px, not 1: sub-pixel mouse jitter between down and up was
        // classifying plain clicks as drags, so the tap-to-edit drawer (see
        // onUp) never opened and the label/required controls looked missing.
        if (Math.abs(nx - orig.x) > 3 || Math.abs(ny - orig.y) > 3) movedAny = true;
        el.style.left = nx + 'px'; el.style.top = ny + 'px';
      }
      function onUp(ev2) {
        if (ev2.pointerId !== ev.pointerId) return;
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        try { el.releasePointerCapture(ev.pointerId); } catch (_) { }
        if (movedAny) { self._commitBoxRect(f, el); return; }
        // A tap on a box (rather than a drag) is a request to edit it.
        self.openDrawer(true);
      }
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });

    // resize (corner handle)
    box.querySelector('.pe-handle').addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (self.selectedUid !== f.uid) self._select(f.uid);
      var el = self.container.querySelector('.pe-box[data-uid="' + f.uid + '"]');
      if (!el) return;
      var handle = el.querySelector('.pe-handle');
      var wrap = el.parentNode;
      var left = parseFloat(el.style.left), top = parseFloat(el.style.top);
      var start = localPoint(wrap, ev);
      var ow = parseFloat(el.style.width), oh = parseFloat(el.style.height);
      try { handle.setPointerCapture(ev.pointerId); } catch (_) { }

      function onMove(ev2) {
        if (ev2.pointerId !== ev.pointerId) return;
        var p = localPoint(wrap, ev2);
        var nw = Math.min(Math.max(ow + (p.x - start.x), 6), wrap.clientWidth - left);
        var nh = Math.min(Math.max(oh + (p.y - start.y), 6), wrap.clientHeight - top);
        el.style.width = nw + 'px'; el.style.height = nh + 'px';
      }
      function onUp(ev2) {
        if (ev2.pointerId !== ev.pointerId) return;
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(ev.pointerId); } catch (_) { }
        self._commitBoxRect(f, el);   // min size re-enforced in points here
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
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
