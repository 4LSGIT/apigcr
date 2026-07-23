/**
 * Tests for the PURE section of public/esign/placementEditor.js (Phase 2D)
 * plus the new GET /api/esign/template-meta route.
 *
 * THE TRANSFORM IS THE WHOLE GAME: peViewportToNeutral / peNeutralToViewport
 * are exercised against a MockPageViewport that replicates pdf.js's
 * PageViewport transform math exactly (rotation 0/90/180/270, viewBox
 * offsets, arbitrary scale) — pdf.js mocked at the viewport-interface level,
 * per the repo's node-only test environment (no browser infra). Round-trips
 * are asserted exact to 0.1pt across page sizes × zooms × rotations ×
 * cropbox-offset fixtures.
 *
 * The template-admin mirrors (placeholder scan, schema-row validation,
 * basics) are drift-guarded against the REAL service exports where
 * importable (KEY_RE, PREFILL_TYPES, name/kind/expiration bounds) and
 * BEHAVIORALLY against validateTemplateInput where the constant is not
 * exported (label bounds) — same posture as tests/esignActionsUi.test.js.
 *
 *   npx jest tests/esignPlacementEditor.test.js
 */

const pe = require('../public/esign/placementEditor');
const templateService = require('../services/esignTemplateService');
const prefillService  = require('../services/esignPrefillService');
const placements      = require('../services/esign/placements');

// ─────────────────────────────────────────────────────────────
// MockPageViewport — pdf.js display/display_utils.js PageViewport, verbatim
// math: transform matrix construction + applyTransform/applyInverseTransform.
// convertToPdfPoint/convertToViewportPoint are the only members the pure
// transforms touch (plus viewBox), so this IS the interface under test.
// ─────────────────────────────────────────────────────────────

function applyTransform(p, m) {
  return [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
}
function applyInverseTransform(p, m) {
  const d = m[0] * m[3] - m[1] * m[2];
  return [
    (p[0] * m[3] - p[1] * m[2] + m[2] * m[5] - m[4] * m[3]) / d,
    (-p[0] * m[1] + p[1] * m[0] + m[4] * m[1] - m[5] * m[0]) / d,
  ];
}

class MockPageViewport {
  constructor({ viewBox, scale, rotation = 0 }) {
    this.viewBox = viewBox;
    this.scale = scale;
    this.rotation = rotation;
    const centerX = (viewBox[2] + viewBox[0]) / 2;
    const centerY = (viewBox[3] + viewBox[1]) / 2;
    let rotateA, rotateB, rotateC, rotateD;
    rotation %= 360;
    if (rotation < 0) rotation += 360;
    switch (rotation) {
      case 180: rotateA = -1; rotateB = 0;  rotateC = 0;  rotateD = 1;  break;
      case 90:  rotateA = 0;  rotateB = 1;  rotateC = 1;  rotateD = 0;  break;
      case 270: rotateA = 0;  rotateB = -1; rotateC = -1; rotateD = 0;  break;
      case 0:   rotateA = 1;  rotateB = 0;  rotateC = 0;  rotateD = -1; break;
      default:  throw new Error('rotation must be a multiple of 90');
    }
    let offsetCanvasX, offsetCanvasY, width, height;
    if (rotateA === 0) {
      offsetCanvasX = Math.abs(centerY - viewBox[1]) * scale;
      offsetCanvasY = Math.abs(centerX - viewBox[0]) * scale;
      width  = Math.abs(viewBox[3] - viewBox[1]) * scale;
      height = Math.abs(viewBox[2] - viewBox[0]) * scale;
    } else {
      offsetCanvasX = Math.abs(centerX - viewBox[0]) * scale;
      offsetCanvasY = Math.abs(centerY - viewBox[1]) * scale;
      width  = Math.abs(viewBox[2] - viewBox[0]) * scale;
      height = Math.abs(viewBox[3] - viewBox[1]) * scale;
    }
    this.width = width;
    this.height = height;
    this.transform = [
      rotateA * scale, rotateB * scale, rotateC * scale, rotateD * scale,
      offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
      offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
    ];
  }
  convertToViewportPoint(x, y) { return applyTransform([x, y], this.transform); }
  convertToPdfPoint(x, y)      { return applyInverseTransform([x, y], this.transform); }
}

// fixtures
const LETTER = [0, 0, 612, 792];
const LEGAL  = [0, 0, 612, 1008];
const A4     = [0, 0, 595.28, 841.89];
const OFFSET = [30, 40, 642, 832];   // Letter-sized cropbox, nonzero origin
const SCALES = [0.75, 1, 1.25, 1.5, 1.3333];

// ─── transform: known values ─────────────────────────────────

describe('peViewportToNeutral — known values', () => {
  test('Letter @ scale 1, rotation 0: y flips from the bottom', () => {
    const vp = new MockPageViewport({ viewBox: LETTER, scale: 1 });
    // A 100×50 box whose viewport top-left is (72, 72): its bottom edge sits
    // at viewport y 122 → 792 - 122 = 670 points from the page bottom.
    const n = pe.peViewportToNeutral({ x: 72, y: 72, w: 100, h: 50 }, vp);
    expect(n.x).toBeCloseTo(72, 6);
    expect(n.y).toBeCloseTo(670, 6);
    expect(n.w).toBeCloseTo(100, 6);
    expect(n.h).toBeCloseTo(50, 6);
  });

  test('Letter @ scale 2: pixels halve into points', () => {
    const vp = new MockPageViewport({ viewBox: LETTER, scale: 2 });
    const n = pe.peViewportToNeutral({ x: 144, y: 144, w: 200, h: 100 }, vp);
    expect(n.x).toBeCloseTo(72, 6);
    expect(n.y).toBeCloseTo(670, 6);
    expect(n.w).toBeCloseTo(100, 6);
    expect(n.h).toBeCloseTo(50, 6);
  });

  test('nonzero cropbox origin: neutral coords are relative to the VISIBLE page', () => {
    const vp = new MockPageViewport({ viewBox: OFFSET, scale: 1 });
    // Viewport (0,0) is the cropbox top-left. A box at viewport (0, h-10) of
    // size 10×10 hugs the visible bottom-left corner → neutral (0, 0).
    const n = pe.peViewportToNeutral({ x: 0, y: vp.height - 10, w: 10, h: 10 }, vp);
    expect(n.x).toBeCloseTo(0, 6);
    expect(n.y).toBeCloseTo(0, 6);
    // …and the raw pdf.js user-space point WOULD have been (30, 40): prove the
    // offset is what got subtracted, i.e. this is not accidentally a no-op.
    const raw = vp.convertToPdfPoint(0, vp.height);
    expect(raw[0]).toBeCloseTo(30, 6);
    expect(raw[1]).toBeCloseTo(40, 6);
  });

  test('rotation 90: min/abs corner normalization keeps w/h positive and placed', () => {
    const vp = new MockPageViewport({ viewBox: LETTER, scale: 1, rotation: 90 });
    // Rotated Letter renders 792 wide × 612 tall.
    expect(vp.width).toBeCloseTo(792, 6);
    expect(vp.height).toBeCloseTo(612, 6);
    const n = pe.peViewportToNeutral({ x: 10, y: 20, w: 100, h: 40 }, vp);
    expect(n.w).toBeGreaterThan(0);
    expect(n.h).toBeGreaterThan(0);
    // A 100×40 viewport box on a 90°-rotated page is 40×100 in page space.
    expect(n.w).toBeCloseTo(40, 6);
    expect(n.h).toBeCloseTo(100, 6);
  });
});

describe('peNeutralToViewport — known values', () => {
  test('Letter @ scale 1: inverse of the flip', () => {
    const vp = new MockPageViewport({ viewBox: LETTER, scale: 1 });
    const r = pe.peNeutralToViewport({ x: 72, y: 670, w: 100, h: 50 }, vp);
    expect(r.x).toBeCloseTo(72, 6);
    expect(r.y).toBeCloseTo(72, 6);
    expect(r.w).toBeCloseTo(100, 6);
    expect(r.h).toBeCloseTo(50, 6);
  });

  test('a field saved on an offset-cropbox page renders inside the viewport', () => {
    const vp = new MockPageViewport({ viewBox: OFFSET, scale: 1.25 });
    const r = pe.peNeutralToViewport({ x: 0, y: 0, w: 120, h: 24 }, vp);
    expect(r.x).toBeCloseTo(0, 4);
    expect(r.y).toBeCloseTo(vp.height - 24 * 1.25, 4);
  });
});

// ─── transform: exhaustive round-trips ───────────────────────

describe('round-trip precision (≤0.1pt) across sizes × zooms × rotations × offsets', () => {
  const boxes = [
    { x: 72, y: 144, w: 216, h: 36 },       // the schema's own example
    { x: 0, y: 0, w: 120, h: 24 },          // page corner
    { x: 400.55, y: 601.25, w: 60.4, h: 16.2 }, // fractional
  ];
  const cases = [];
  for (const viewBox of [LETTER, LEGAL, A4, OFFSET]) {
    for (const scale of SCALES) {
      for (const rotation of [0, 90, 180, 270]) {
        cases.push({ viewBox, scale, rotation });
      }
    }
  }

  test.each(cases)('viewBox=$viewBox scale=$scale rot=$rotation', ({ viewBox, scale, rotation }) => {
    const vp = new MockPageViewport({ viewBox, scale, rotation });
    for (const neutral of boxes) {
      const px = pe.peNeutralToViewport(neutral, vp);
      const back = pe.peViewportToNeutral(px, vp);
      expect(Math.abs(back.x - neutral.x)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(back.y - neutral.y)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(back.w - neutral.w)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(back.h - neutral.h)).toBeLessThanOrEqual(0.1);
    }
  });

  test('px→neutral→px also round-trips (draw-then-render path), scale 1.3333', () => {
    const vp = new MockPageViewport({ viewBox: LETTER, scale: 1.3333 });
    const rect = { x: 101.7, y: 300.2, w: 180.3, h: 40.9 };
    const n = pe.peViewportToNeutral(rect, vp);
    const back = pe.peNeutralToViewport(n, vp);
    for (const k of ['x', 'y', 'w', 'h']) {
      expect(Math.abs(back[k] - rect[k])).toBeLessThanOrEqual(0.1 * vp.scale);
    }
  });

  test('storage rounding (0.01pt) stays within 0.1pt after a full commit cycle', () => {
    for (const scale of SCALES) {
      const vp = new MockPageViewport({ viewBox: LEGAL, scale });
      const rect = { x: 33.337, y: 777.77, w: 133.33, h: 41.41 };
      const n = pe.peViewportToNeutral(rect, vp);
      const size = pe.pePageSize(vp);
      const committed = pe.peNormalizeRect(n, 'signature', size.w, size.h);
      const n2 = pe.peViewportToNeutral(pe.peNeutralToViewport(committed, vp), vp);
      expect(Math.abs(n2.x - committed.x)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(n2.y - committed.y)).toBeLessThanOrEqual(0.1);
    }
  });
});

// ─── page size from viewBox ──────────────────────────────────

describe('pePageSize', () => {
  test('rotation-proof: viewBox, not viewport.width/height', () => {
    const v0 = new MockPageViewport({ viewBox: LETTER, scale: 1.5, rotation: 0 });
    const v90 = new MockPageViewport({ viewBox: LETTER, scale: 1.5, rotation: 90 });
    expect(pe.pePageSize(v0)).toEqual({ w: 612, h: 792 });
    expect(pe.pePageSize(v90)).toEqual({ w: 612, h: 792 });
  });
  test('offset cropbox: visible size, not media size', () => {
    const vp = new MockPageViewport({ viewBox: OFFSET, scale: 1 });
    expect(pe.pePageSize(vp)).toEqual({ w: 612, h: 792 });
  });
});

// ─── min-size / clamp / normalize (POINTS, per 2D spec) ──────

describe('minimum sizes are enforced in points', () => {
  test('the spec floors', () => {
    expect(pe.PE_MIN_SIZES.signature).toEqual({ w: 120, h: 24 });
    expect(pe.PE_MIN_SIZES.initial).toEqual({ w: 40, h: 18 });
    expect(pe.PE_MIN_SIZES.date).toEqual({ w: 60, h: 16 });
  });

  test('a tiny drawn rect snaps up per type; a big one is untouched', () => {
    const tiny = { x: 10, y: 10, w: 5, h: 5 };
    expect(pe.peEnforceMin(tiny, 'signature')).toEqual({ x: 10, y: 10, w: 120, h: 24 });
    expect(pe.peEnforceMin(tiny, 'initial')).toEqual({ x: 10, y: 10, w: 40, h: 18 });
    expect(pe.peEnforceMin(tiny, 'date')).toEqual({ x: 10, y: 10, w: 60, h: 16 });
    const big = { x: 10, y: 10, w: 300, h: 60 };
    expect(pe.peEnforceMin(big, 'signature')).toEqual(big);
  });

  test('the floor is zoom-independent because it lives in points: the same 30px box at two zooms', () => {
    // 30×10 CSS px at 75% (scale .75 → 40×13.3pt) and 150% (scale 1.5 → 20×6.7pt):
    // BOTH are floored to 120×24pt for a signature.
    for (const scale of [0.75, 1.5]) {
      const vp = new MockPageViewport({ viewBox: LETTER, scale });
      const n = pe.peViewportToNeutral({ x: 30, y: 30, w: 30, h: 10 }, vp);
      const size = pe.pePageSize(vp);
      const r = pe.peNormalizeRect(n, 'signature', size.w, size.h);
      expect(r.w).toBe(120);
      expect(r.h).toBe(24);
    }
  });

  test('clamp: shifted inside the page, not shrunk (unless bigger than the page)', () => {
    expect(pe.peClampToPage({ x: 600, y: -10, w: 120, h: 24 }, 612, 792))
      .toEqual({ x: 492, y: 0, w: 120, h: 24 });
    expect(pe.peClampToPage({ x: 0, y: 0, w: 5000, h: 24 }, 612, 792).w).toBe(612);
  });

  test('normalize order: min floor FIRST, then clamp — an edge draw shifts inward at floor size', () => {
    // 5×5 draw at the far bottom-right corner: floored to 120×24, then shifted in.
    const r = pe.peNormalizeRect({ x: 610, y: 790, w: 2, h: 2 }, 'signature', 612, 792);
    expect(r).toEqual({ x: 492, y: 768, w: 120, h: 24 });
  });

  test('committed geometry is a valid neutral placement (server validator agrees)', () => {
    const r = pe.peNormalizeRect({ x: -50, y: 9999, w: 1, h: 1 }, 'date', 612, 792);
    expect(() => placements.validatePlacements({
      coord_space: 'pdf_user_space',
      fields: [{ page: 1, ...r, type: 'date', signer: 1 }],
    })).not.toThrow();
  });
});

// ─── canonical sort ──────────────────────────────────────────

describe('peSortFields — page asc, y desc (top of page first), x asc', () => {
  test('sorts and does not mutate the input', () => {
    const input = [
      { page: 2, x: 10, y: 700, type: 'date', signer: 1 },
      { page: 1, x: 300, y: 100, type: 'signature', signer: 2 },
      { page: 1, x: 100, y: 100, type: 'signature', signer: 1 },
      { page: 1, x: 100, y: 650, type: 'initial', signer: 1 },
    ];
    const frozen = JSON.stringify(input);
    const out = pe.peSortFields(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(out.map((f) => [f.page, f.y, f.x])).toEqual([
      [1, 650, 100], [1, 100, 100], [1, 100, 300], [2, 700, 10],
    ]);
  });
});

// ─── placeholder-scan mirror (drift guard) ───────────────────

describe('peExtractPlaceholders mirrors esignTemplateService.extractPlaceholders', () => {
  const bodies = [
    '<p>{{a}} and {{b}} and {{a}} again</p>',
    'no placeholders here',
    '{{ spaced }}{{trailing }}{{}}',
    '{{a{{b}} nested-ish {{c}}',
    'unicode {{name}} — {{fee_2}} {{Bad-Key!}}',
    '{{x}}{{y}}{{x}}{{z}}{{y}}',
  ];
  test.each(bodies)('identical output for %j', (body) => {
    expect(pe.peExtractPlaceholders(body)).toEqual(templateService.extractPlaceholders(body));
  });

  test('peScanBody splits declared/undeclared/unused', () => {
    const scan = pe.peScanBody('{{a}} {{b}} {{c}}', ['b', 'c', 'd']);
    expect(scan.placeholders).toEqual(['a', 'b', 'c']);
    expect(scan.undeclared).toEqual(['a']);
    expect(scan.unused).toEqual(['d']);
  });
});

// ─── image-inliner pure helpers (2026-07-22 slice) ───────────

describe('peExtractExternalImageUrls — <img src> only, MVP scope', () => {
  test('extracts http(s) img srcs, both quote styles, unique, first-seen order', () => {
    const html =
      '<p>x</p><img src="https://cdn.example.com/logo.png" style="max-width:100%">' +
      "<img class='a' src='https://cdn.example.com/seal.jpg'>" +
      '<img src="https://cdn.example.com/logo.png">' +      // dup
      '<img src="http://insecure.example.com/x.gif">';       // http extracted; server rejects it
    expect(pe.peExtractExternalImageUrls(html)).toEqual([
      'https://cdn.example.com/logo.png',
      'https://cdn.example.com/seal.jpg',
      'http://insecure.example.com/x.gif',
    ]);
  });

  test('data URIs, relative srcs, srcless imgs and non-img refs are all ignored', () => {
    const html =
      '<img src="data:image/png;base64,AAAA">' +
      '<img src="/local/logo.png"><img alt="no src">' +
      '<link href="https://fonts.example.com/f.css">' +           // not an <img> — out of MVP scope
      '<div style="background:url(https://cdn.example.com/bg.png)"></div>';
    expect(pe.peExtractExternalImageUrls(html)).toEqual([]);
  });

  test('tolerates whitespace around = and null input', () => {
    expect(pe.peExtractExternalImageUrls('<img src = "https://a.example.com/x.png">'))
      .toEqual(['https://a.example.com/x.png']);
    expect(pe.peExtractExternalImageUrls(null)).toEqual([]);
  });
});

describe('peInlineImageSrcs — swap fetched urls for data URIs', () => {
  const URI = 'data:image/png;base64,AAAA';

  test('swaps every occurrence, both quote styles, quote preserved', () => {
    const html =
      '<img src="https://a.example.com/x.png">' +
      "<img src='https://a.example.com/x.png'>" +
      '<img src="https://b.example.com/y.png">';
    const out = pe.peInlineImageSrcs(html, { 'https://a.example.com/x.png': URI });
    expect(out).toBe(
      `<img src="${URI}">` +
      `<img src='${URI}'>` +
      '<img src="https://b.example.com/y.png">');
  });

  test('exact-match only: unmapped urls and near-misses stay byte-identical', () => {
    const html = '<img src="https://a.example.com/x.png?v=2">';
    expect(pe.peInlineImageSrcs(html, { 'https://a.example.com/x.png': URI })).toBe(html);
  });

  test('regex metacharacters in the url are literal (the ?v=2 case, mapped)', () => {
    const html = '<img src="https://a.example.com/x.png?v=2">';
    expect(pe.peInlineImageSrcs(html, { 'https://a.example.com/x.png?v=2': URI }))
      .toBe(`<img src="${URI}">`);
  });

  test('whitespace around = survives the swap; empty map is a no-op', () => {
    const html = '<img src = "https://a.example.com/x.png">';
    expect(pe.peInlineImageSrcs(html, { 'https://a.example.com/x.png': URI }))
      .toBe(`<img src = "${URI}">`);
    expect(pe.peInlineImageSrcs(html, {})).toBe(html);
    expect(pe.peInlineImageSrcs(html, null)).toBe(html);
  });
});

// ─── editor-key auto-create diff (2026-07-22 slice) ──────────

describe('peDiffPlacementKeys — placed text keys missing from the schema', () => {
  const F = (type, key, extra) => Object.assign({ type, page: 1, x: 10, y: 10, w: 60, h: 14 }, key != null ? { key } : {}, extra || {});

  test('unique missing keys, first-seen order, declared ones excluded', () => {
    const placements = { coord_space: 'pdf_user_space', fields: [
      F('text', 'client_name'), F('text', 'fee'), F('text', 'client_name'),
      F('text', 'case_no'), F('text', 'fee'),
    ] };
    expect(pe.peDiffPlacementKeys(placements, ['fee']))
      .toEqual(['client_name', 'case_no']);
  });

  test('only type=text carries a key — every signer-class type is ignored', () => {
    const placements = { fields: [
      F('signature', null, { signer: 1 }), F('initial', null, { signer: 1 }),
      F('date', null, { signer: 1 }),
      F('input_text', null, { signer: 1, label: 'Middle name' }),
      F('checkbox', null, { signer: 1 }),
      F('dropdown', null, { signer: 1, options: ['a', 'b'] }),
      F('radio', null, { signer: 1, group: 'G', value: 'v1' }),
      F('text', 'the_only_key'),
    ] };
    expect(pe.peDiffPlacementKeys(placements, [])).toEqual(['the_only_key']);
  });

  test('accepts a bare fields array, null, and shapes without fields', () => {
    expect(pe.peDiffPlacementKeys([F('text', 'k1')], [])).toEqual(['k1']);
    expect(pe.peDiffPlacementKeys(null, ['a'])).toEqual([]);
    expect(pe.peDiffPlacementKeys({}, ['a'])).toEqual([]);
    expect(pe.peDiffPlacementKeys({ fields: 'nope' }, [])).toEqual([]);
  });

  test('blank/whitespace keys and empty schema entries never match or emit', () => {
    const placements = { fields: [F('text', ''), F('text', '   '), F('text', 'real')] };
    expect(pe.peDiffPlacementKeys(placements, ['', null, undefined]))
      .toEqual(['real']);
  });

  test('all declared → empty diff (the no-dialog path)', () => {
    const placements = { fields: [F('text', 'a'), F('text', 'b')] };
    expect(pe.peDiffPlacementKeys(placements, ['a', 'b', 'c'])).toEqual([]);
  });
});

// ─── schema-row validation mirrors (drift guards) ────────────

describe('schema-row mirrors vs the server', () => {
  test('PE_KEY_RE is byte-identical to the service KEY_RE', () => {
    expect(pe.PE_KEY_RE.source).toBe(templateService.KEY_RE.source);
    expect(pe.PE_KEY_RE.flags).toBe(templateService.KEY_RE.flags);
  });

  test('field types mirror placements.NEUTRAL_FIELD_TYPES', () => {
    expect(pe.PE_FIELD_TYPES).toEqual(placements.NEUTRAL_FIELD_TYPES.slice());
  });

  test('exported bounds mirror the service constants', () => {
    expect(pe.PE_NAME_MIN).toBe(templateService.MIN_NAME);
    expect(pe.PE_NAME_MAX).toBe(templateService.MAX_NAME);
    expect(pe.PE_KIND_MAX).toBe(templateService.MAX_KIND);
    expect(pe.PE_EXP_MIN).toBe(templateService.MIN_EXPIRATION_DAYS);
    expect(pe.PE_EXP_MAX).toBe(templateService.MAX_EXPIRATION_DAYS);
  });

  test('row validation: key regex, label bounds, type, resolver whitelist', () => {
    const opts = { types: [...templateService.PREFILL_TYPES], resolvers: ['debtor1.name'] };
    expect(pe.peValidateSchemaRow(
      { key: 'fee', label: 'Fee', type: 'money', resolver: null }, opts)).toEqual([]);
    expect(pe.peValidateSchemaRow(
      { key: 'Fee', label: 'Fee', type: 'money' }, opts).join()).toMatch(/key/);
    expect(pe.peValidateSchemaRow(
      { key: '1fee', label: 'Fee', type: 'money' }, opts).join()).toMatch(/key/);
    expect(pe.peValidateSchemaRow(
      { key: 'a'.repeat(41), label: 'Fee', type: 'money' }, opts).join()).toMatch(/key/);
    expect(pe.peValidateSchemaRow(
      { key: 'fee', label: '', type: 'money' }, opts).join()).toMatch(/label/);
    expect(pe.peValidateSchemaRow(
      { key: 'fee', label: 'x'.repeat(81), type: 'money' }, opts).join()).toMatch(/label/);
    expect(pe.peValidateSchemaRow(
      { key: 'fee', label: 'Fee', type: 'currency' }, opts).join()).toMatch(/type/);
    expect(pe.peValidateSchemaRow(
      { key: 'fee', label: 'Fee', type: 'money', resolver: 'nope' }, opts).join()).toMatch(/resolver/);
  });

  test('label bounds BEHAVIORALLY mirror the server (MIN/MAX_LABEL not exported)', () => {
    // Client accepts 1 and 80, rejects '' and 81 — assert the server draws the
    // same line via validateTemplateInput, so a silent server change fails here.
    const mk = (label) => ({
      name: 'A valid name', kind: 'other',
      body: '<p>{{k}}</p>',
      prefillSchema: [{ key: 'k', label, type: 'text', resolver: null, default: null, required: false }],
      placementJson: { fields: [] }, expirationDays: 14,
    });
    expect(() => templateService.validateTemplateInput(mk('x'), prefillService.RESOLVER_NAMES)).not.toThrow();
    expect(() => templateService.validateTemplateInput(mk('x'.repeat(80)), prefillService.RESOLVER_NAMES)).not.toThrow();
    expect(() => templateService.validateTemplateInput(mk(''), prefillService.RESOLVER_NAMES)).toThrow(/label/);
    expect(() => templateService.validateTemplateInput(mk('x'.repeat(81)), prefillService.RESOLVER_NAMES)).toThrow(/label/);
    expect(pe.peValidateSchemaRow({ key: 'k', label: 'x', type: 'text' }, {})).toEqual([]);
    expect(pe.peValidateSchemaRow({ key: 'k', label: 'x'.repeat(80), type: 'text' }, {})).toEqual([]);
    expect(pe.peValidateSchemaRow({ key: 'k', label: '', type: 'text' }, {}).length).toBe(1);
    expect(pe.peValidateSchemaRow({ key: 'k', label: 'x'.repeat(81), type: 'text' }, {}).length).toBe(1);
  });

  test('rows-level: duplicate keys flagged on every duplicate row', () => {
    const v = pe.peValidateSchemaRows([
      { key: 'fee', label: 'Fee', type: 'money' },
      { key: 'fee', label: 'Fee 2', type: 'money' },
      { key: 'name', label: 'Name', type: 'text' },
    ], { types: ['text', 'money'] });
    expect(v.dupKeys).toEqual(['fee']);
    expect(v.rowErrors[0].join()).toMatch(/duplicate/);
    expect(v.rowErrors[1].join()).toMatch(/duplicate/);
    expect(v.rowErrors[2]).toEqual([]);
    expect(v.ok).toBe(false);
  });

  test('peValidateBasics mirrors name/kind/expiration', () => {
    expect(pe.peValidateBasics({ name: 'Retainer', kind: 'other', expirationDays: 14 })).toEqual([]);
    expect(pe.peValidateBasics({ name: 'ab', kind: 'other', expirationDays: 14 }).join()).toMatch(/name/);
    expect(pe.peValidateBasics({ name: 'Retainer', kind: '', expirationDays: 14 }).join()).toMatch(/kind/);
    expect(pe.peValidateBasics({ name: 'Retainer', kind: 'other', expirationDays: 0 }).join()).toMatch(/Expiration/);
    expect(pe.peValidateBasics({ name: 'Retainer', kind: 'other', expirationDays: 91 }).join()).toMatch(/Expiration/);
    expect(pe.peValidateBasics({ name: 'Retainer', kind: 'other', expirationDays: 14.5 }).join()).toMatch(/Expiration/);
  });
});

// ─── GET /api/esign/template-meta (Deliverable 0) ────────────

describe('GET /api/esign/template-meta', () => {
  const templatesRouter = require('../routes/api.esign.templates');

  function handlerOf(path, method) {
    const layer = templatesRouter.stack.find(
      (l) => l.route && l.route.path === path && l.route.methods[method]
    );
    return layer.route.stack.slice(-1)[0].handle;
  }

  test('sources from the REAL exported constants, never a hand-copied list', async () => {
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT DISTINCT kind FROM contract_templates')) {
          return [[{ kind: 'retainer_custom' }, { kind: 'schedules' }]];
        }
        return [[]];
      }),
    };
    const req = { db, params: {}, query: {}, body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
    await handlerOf('/api/esign/template-meta', 'get')(req, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const out = res.json.mock.calls[0][0];
    expect(out.resolvers).toEqual([...prefillService.RESOLVER_NAMES].sort());
    expect(out.types).toEqual([...templateService.PREFILL_TYPES]);
    // legalKinds = static KINDS ∪ active-template kinds, deduped
    const sendService = require('../services/esignSendService');
    expect(out.kinds).toEqual([...new Set([...sendService.KINDS, 'retainer_custom', 'schedules'])]);
  });
});
// ─── Phase 2F — signer-input types in the editor's pure layer ─────────────────

describe('Phase 2F editor helpers', () => {
  test('min sizes exist for every neutral type — a drawn box of ANY type has a floor', () => {
    for (const t of placements.NEUTRAL_FIELD_TYPES) {
      const m = pe.PE_MIN_SIZES[t];
      expect(m && m.w > 0 && m.h > 0).toBe(true);
    }
    // tick targets are square-ish and small; text-entry family matches 'text'
    expect(pe.PE_MIN_SIZES.checkbox).toEqual({ w: 12, h: 12 });
    expect(pe.PE_MIN_SIZES.radio).toEqual({ w: 12, h: 12 });
    expect(pe.PE_MIN_SIZES.input_text).toEqual(pe.PE_MIN_SIZES.text);
  });

  test('peParseOptions: trims, drops empties, keeps order AND duplicates', () => {
    expect(pe.peParseOptions(' Chapter 7 , Chapter 13 ,, ')).toEqual(['Chapter 7', 'Chapter 13']);
    // duplicates survive — the SERVER validator is the voice that rejects
    // them; silent client dedupe would make the saved value disagree with
    // what the author sees in the input
    expect(pe.peParseOptions('A, A, B')).toEqual(['A', 'A', 'B']);
    expect(pe.peParseOptions('')).toEqual([]);
    expect(pe.peParseOptions(null)).toEqual([]);
  });

  test('peSignerTag: radio shows GROUP: VALUE; others label-or-type', () => {
    expect(pe.peSignerTag({ type: 'radio', group: 'Approve?', value: 'Yes', signer: 1 }))
      .toBe('Approve?: Yes \u00b7 S1');
    expect(pe.peSignerTag({ type: 'radio', signer: 2 })).toBe('?: ? \u00b7 S2');
    expect(pe.peSignerTag({ type: 'input_text', signer: 1 })).toBe('INPUT \u00b7 S1');
    expect(pe.peSignerTag({ type: 'checkbox', label: 'I agree', signer: 1 })).toBe('I agree \u00b7 S1');
    expect(pe.peSignerTag({ type: 'signature', signer: 2 })).toBe('SIGNATURE \u00b7 S2');
  });

  test('normalized geometry for the new types passes the server validator', () => {
    const cases = [
      ['checkbox', { signer: 1 }],
      ['radio',    { signer: 1, group: 'Approve', value: 'Yes' }],
      ['dropdown', { signer: 1, options: ['A', 'B'] }],
      ['input_text', { signer: 1, max_length: 40 }],
    ];
    for (const [type, extra] of cases) {
      const r = pe.peNormalizeRect({ x: 5, y: 5, w: 1, h: 1 }, type, 612, 792);
      expect(() => placements.validatePlacements({
        coord_space: 'pdf_user_space',
        fields: [{ page: 1, ...r, type, ...extra }],
      })).not.toThrow();
    }
  });
});

// ─── peCarryProps — the ONE round-trip carrier for Phase 2F properties ───────

describe('peCarryProps (shared by _seed and getPlacements)', () => {
  const carry = (src) => pe.peCarryProps(src, {});

  test('input_text: max_length floored, default carried; absent stays absent', () => {
    expect(carry({ type: 'input_text', max_length: 50.9, default: 'pre' }))
      .toEqual({ max_length: 50, default: 'pre' });
    expect(carry({ type: 'input_text' })).toEqual({});
    expect(carry({ type: 'input_text', max_length: 0, default: '' })).toEqual({});
    expect(carry({ type: 'input_text', max_length: 'fifty' })).toEqual({});
  });

  test('checkbox: checked carried ONLY as literal true', () => {
    expect(carry({ type: 'checkbox', checked: true })).toEqual({ checked: true });
    expect(carry({ type: 'checkbox', checked: false })).toEqual({});
    expect(carry({ type: 'checkbox', checked: 'yes' })).toEqual({});
  });

  test('dropdown: options sanitized (trim, drop empties), default trimmed', () => {
    expect(carry({ type: 'dropdown', options: [' A ', '', 'B', 7, '  '], default: ' B ' }))
      .toEqual({ options: ['A', 'B'], default: 'B' });
    // options ALWAYS present on a dropdown, even when the input was garbage —
    // the server requires the key, and an absent one reads as data loss
    expect(carry({ type: 'dropdown' })).toEqual({ options: [] });
  });

  test('radio: group/value trimmed and always present; checked as literal true', () => {
    expect(carry({ type: 'radio', group: ' Approve? ', value: ' Yes ', checked: true }))
      .toEqual({ group: 'Approve?', value: 'Yes', checked: true });
    expect(carry({ type: 'radio' })).toEqual({ group: '', value: '' });
  });

  test('non-2F types carry nothing — no cross-type leakage', () => {
    expect(carry({ type: 'signature', options: ['A'], group: 'G', checked: true })).toEqual({});
    expect(carry({ type: 'date', max_length: 9 })).toEqual({});
  });

  test('round-trip stability: carry(carry(x)) === carry(x) for every 2F type', () => {
    const srcs = [
      { type: 'input_text', max_length: 40, default: 'pre' },
      { type: 'checkbox', checked: true },
      { type: 'dropdown', options: ['A', 'B'], default: 'A' },
      { type: 'radio', group: 'G', value: 'V', checked: true },
    ];
    for (const s of srcs) {
      const once = pe.peCarryProps(s, { type: s.type });
      const twice = pe.peCarryProps(once, { type: s.type });
      delete once.type; delete twice.type;
      expect(twice).toEqual(once);
    }
  });

  test('carried output passes the server validator when placed', () => {
    const geom = { page: 1, x: 72, y: 300, w: 60, h: 16 };
    const seeds = [
      { type: 'input_text', signer: 1, max_length: 40.7, default: 'x' },
      { type: 'checkbox', signer: 1, checked: true },
      { type: 'dropdown', signer: 1, options: [' A ', 'B', ''], default: ' A ' },
      { type: 'radio', signer: 1, group: ' G ', value: ' Yes ' },
    ];
    for (const s of seeds) {
      const out = pe.peCarryProps(s, { ...geom, type: s.type, signer: s.signer });
      expect(() => placements.validatePlacements({
        coord_space: 'pdf_user_space', fields: [out],
      })).not.toThrow();
    }
  });
});
