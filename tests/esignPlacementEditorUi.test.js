// tests/esignPlacementEditorUi.test.js
//
/**
 * PLACEMENT EDITOR — BROWSER BEHAVIOUR (Phase 2G).
 *
 * tests/esignPlacementEditor.test.js covers the PURE section by require()ing
 * the file under node. That leaves the half that actually broke untested: the
 * component. This file boots the REAL public/esign/placementEditor.js inside
 * jsdom against a stub pdf.js and drives it the way a person would — draw,
 * tap, select, rename, retype, duplicate, delete — then hands the result to
 * the REAL server validator.
 *
 * Idiom lifted from tests/formRender.slice2.test.js: jest's environment stays
 * 'node', a JSDOM is built per boot with runScripts:'dangerously', and every
 * window is closed in afterAll so jsdom-side timers don't hold jest open.
 *
 * WHY THIS FILE EXISTS. Two shipped defects motivated 2G and neither could
 * have been caught by a pure-function test:
 *
 *   1. The 2D/2F build listened for mousedown/mousemove/mouseup only. Touch
 *      browsers synthesise a click after a tap but never the mousemove stream
 *      a drag needs, so on a phone or tablet drawing, moving and resizing did
 *      nothing whatsoever. The touch describe-block below is the regression
 *      guard: un-armed touch must NOT draw (the finger belongs to the
 *      scroller), armed touch MUST place.
 *
 *   2. A fill-in keyed "$1000" passed every browser check, because there were
 *      none, and was refused by OUR OWN validator at send time inside a Swal
 *      titled "Send failed" — which staff read as the provider rejecting the
 *      document. The "$1000 path" block walks that exact session and asserts
 *      the objection now lands on the keystroke, names the character rather
 *      than a regex, and offers a one-tap repair.
 *
 *   npx jest tests/esignPlacementEditorUi.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT  = path.join(__dirname, '..');
const PE_JS = fs.readFileSync(path.join(ROOT, 'public/esign/placementEditor.js'), 'utf8');
const placements = require('../services/esign/placements');

// Close every window so jsdom timers (the resize debounce) don't hold jest open.
const DOMS = [];
afterAll(() => DOMS.forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));

/** US Letter viewport with pdf.js's own transform contract. */
function mkViewport(scale) {
  const W = 612, H = 792;
  return {
    width: W * scale, height: H * scale, viewBox: [0, 0, W, H],
    convertToPdfPoint: (x, y) => [x / scale, H - y / scale],
    convertToViewportPoint: (ux, uy) => [ux * scale, (H - uy) * scale],
  };
}

/** Two-page stub standing in for pdf.js. */
function mkPdfjs(numPages = 2) {
  return {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages,
        getPage: () => Promise.resolve({
          getViewport: ({ scale }) => mkViewport(scale),
          render: () => ({ promise: Promise.resolve() }),
        }),
        destroy() { /* noop */ },
      }),
    }),
  };
}

/**
 * Boot the component in a fresh jsdom.
 *
 * jsdom does no layout, so clientWidth/clientHeight/getBoundingClientRect are
 * stubbed from the inline styles the component itself writes — which is enough
 * for fit-width scaling and for localPoint() to turn clientX/clientY into
 * page-space pixels. Everything else is the real file.
 *
 * @param {object}  o
 * @param {boolean} o.coarse   report a touch pointer to matchMedia
 * @param {object}  o.opts     extra PlacementEditor options (keySuggest, textValue…)
 * @param {object}  o.seed     initial placement JSON
 */
async function boot({ coarse = false, opts = {}, seed = { fields: [] } } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="mount"></div></body></html>',
    { runScripts: 'dangerously', pretendToBeVisual: true,
      url: 'https://app.4lsg.com/esign/sendForm.html' },
  );
  DOMS.push(dom);
  const w = dom.window;

  w.matchMedia = (q) => ({
    matches: /coarse/.test(q) ? coarse : false,
    media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  });
  w.HTMLCanvasElement.prototype.getContext = () => ({});
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.setPointerCapture = function () {};
  w.HTMLElement.prototype.releasePointerCapture = function () {};
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      if (this.classList.contains('pe-page')) return parseFloat(this.style.width) || 0;
      return 800;
    },
  });
  Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      if (this.classList.contains('pe-page')) return parseFloat(this.style.height) || 0;
      return 600;
    },
  });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const width  = parseFloat(this.style.width)  || 0;
    const height = parseFloat(this.style.height) || 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height };
  };

  const script = w.document.createElement('script');
  script.textContent = PE_JS;
  w.document.head.appendChild(script);

  const changes = { n: 0 };
  const ed = new w.PlacementEditor(w.document.getElementById('mount'), {
    pdfjs: mkPdfjs(),
    onChange: () => { changes.n += 1; },
    ...opts,
  });
  await ed.loadPdf(new ArrayBuffer(8), seed);

  const $  = (sel) => ed.container.querySelector(sel);
  const $$ = (sel) => Array.from(ed.container.querySelectorAll(sel));
  const overlay = (page = 1) => $(`.pe-page[data-page="${page}"] .pe-overlay`);

  function ptr(el, type, x, y, pointerType = 'mouse') {
    const ev = new w.Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, button: 0, pointerType });
    el.dispatchEvent(ev);
  }
  /** Drag always draws, selection or not — the mouse path. */
  function drag(x1, y1, x2, y2, page = 1) {
    const ov = overlay(page);
    ptr(ov, 'pointerdown', x1, y1);
    ptr(ov, 'pointermove', x2, y2);
    ptr(ov, 'pointerup',   x2, y2);
  }
  /** A tap: places when nothing is selected, dismisses when something is. */
  function tap(x, y, page = 1, pointerType = 'mouse') {
    const ov = overlay(page);
    ptr(ov, 'pointerdown', x, y, pointerType);
    ptr(ov, 'pointerup',   x, y, pointerType);
  }
  const type  = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input',  { bubbles: true })); };
  const pick  = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const last  = () => ed.fields[ed.fields.length - 1];
  const open  = () => ed.container.querySelector('.pe-drawer').classList.contains('pe-open');

  /** Pick a type from the drawer's grid — the ONLY place a type is chosen
      since 2H. Needs ADD mode, so deselect first. */
  const chooseType = (t) => {
    ed._select(null);
    ed.openDrawer(true);
    click($(`.pe-drawer [data-pe="addtype"][data-t="${t}"]`));
  };

  return { w, ed, $, $$, overlay, ptr, drag, tap, type, pick, click, last, open, chooseType, changes };
}

// ═══════════════════════════════════════════════════════════════
describe('2H layout — a bare bar and one pull-out drawer', () => {
  test('the bar carries document-level controls only', async () => {
    const { $$, chooseType, open } = await boot();
    // Was fourteen: type, signer, label, key, maxlen, prefill, pre-checked,
    // options, default, group, option, radio-default, zoom, page. On a phone
    // that wrapped to five or six rows of sticky chrome above the document.
    const controls = $$('.pe-bar select, .pe-bar input, .pe-bar button');
    expect(controls.length).toBeLessThanOrEqual(5);
  });

  test('an EMPTY document opens the drawer \u2014 lead with the controls', async () => {
    const { $$, open } = await boot();
    expect($$('.pe-page').length).toBe(2);
    expect(open()).toBe(true);
  });

  test('a document that already has fields opens closed \u2014 show the document', async () => {
    const seed = { coord_space: 'pdf_user_space', fields: [
      { page: 1, x: 40, y: 600, w: 170, h: 40, type: 'signature', signer: 1 },
    ] };
    const { open } = await boot({ seed });
    expect(open()).toBe(false);
  });

  test('the tab pulls the drawer out and pushes it back', async () => {
    const { $, click, open } = await boot();
    const tab = $('.pe-tab');
    expect(tab).toBeTruthy();
    click(tab);                                   // starts open on an empty doc
    expect(open()).toBe(false);
    click(tab);
    expect(open()).toBe(true);
  });

  test('choosing a type CLOSES the drawer \u2014 you asked to place something', async () => {
    const { chooseType, open } = await boot();
    chooseType('signature');
    expect(open()).toBe(false);
  });

  test('placing a field that needs nothing does not reopen the drawer', async () => {
    // A signature needs no decision, so a run of them stays one gesture each.
    const { ed, drag, chooseType, open } = await boot();
    chooseType('signature');
    drag(100, 100, 260, 140);
    expect(ed.fields).toHaveLength(1);
    expect(open()).toBe(false);
  });

  test('placing a field that needs a decision reopens the drawer on it', async () => {
    const { ed, drag, chooseType, open } = await boot();
    chooseType('text');                            // a fill-in has no value yet
    drag(100, 300, 240, 320);
    expect(open()).toBe(true);
    expect(ed.selectedUid).toBe(ed.fields[0].uid);
  });

  test('\u2039 back returns to ADD mode without closing the drawer', async () => {
    const { $, ed, drag, click, open } = await boot();
    drag(100, 100, 260, 140);
    ed.openDrawer(true);
    expect($('.pe-drawer').classList.contains('pe-edit')).toBe(true);
    click($('.pe-back'));
    expect(ed.selectedUid).toBeNull();
    expect($('.pe-drawer').classList.contains('pe-edit')).toBe(false);
    expect(open()).toBe(true);                     // still open, now on the grid
    expect($('.pe-drawer [data-pe="addtype"]')).toBeTruthy();
  });

  test('the tab badge counts fields, and shouts when any is broken', async () => {
    const { $, drag, chooseType, type } = await boot();
    chooseType('signature');
    drag(100, 100, 260, 140);
    expect($('.pe-tab-n').textContent).toBe('1');
    chooseType('text');
    drag(100, 300, 240, 320);
    type($('.pe-drawer [data-pe="key"]'), '$1000');
    expect($('.pe-tab-n').textContent).toBe('!1');
  });

  test('opening the drawer never changes the pages column \u2014 no re-render', async () => {
    // The drawer is absolutely positioned OVER the pages. If it were a flex
    // sibling, every open/close would change the fit-width scale and force a
    // full re-render of every page.
    const { $, ed } = await boot();
    const before = $('.pe-page[data-page="1"]').style.width;
    ed.openDrawer(true);
    ed.openDrawer(false);
    expect($('.pe-page[data-page="1"]').style.width).toBe(before);
  });

  test('the field list mirrors the document and jumps to a box', async () => {
    const { $$, ed, drag, click, chooseType, open } = await boot();
    drag(100, 100, 260, 140);
    drag(100, 300, 260, 340);
    expect($$('.pe-list .pe-li')).toHaveLength(2);
    ed._select(null);
    click($$('.pe-list .pe-li')[0]);
    expect(ed.selectedUid).not.toBeNull();
  });
});

describe('2H placement — mouse', () => {
  test('a drag draws a box of the chosen type', async () => {
    const { ed, drag, $$, chooseType, open } = await boot();
    drag(100, 100, 260, 140);
    expect(ed.fields[0].type).toBe('signature');
    expect($$('.pe-box')).toHaveLength(1);
  });

  test('a click with nothing selected places a comfortably sized box', async () => {
    const { ed, tap, chooseType, open } = await boot();
    tap(400, 400);
    expect(ed.fields).toHaveLength(1);
    // The DEFAULT size, not the 120x24 minimum — a floor is what a box may be
    // shrunk to, not a sensible size to hand somebody who never dragged one.
    expect(ed.fields[0].w).toBeCloseTo(170, 0);
    expect(ed.fields[0].h).toBeCloseTo(40, 0);
  });

  test('a click WITH a selection dismisses rather than placing', async () => {
    const { ed, drag, tap, chooseType, open } = await boot();
    drag(100, 100, 260, 140);
    tap(400, 400);
    expect(ed.fields).toHaveLength(1);
    expect(ed.selectedUid).toBeNull();
  });

  test('choosing a type to ADD does not retype the selected box', async () => {
    // The 2D/2F build did exactly that, because the bar WAS the inspector —
    // so choosing the type you wanted to place NEXT silently converted the box
    // you had just placed. Retyping lives in the drawer's own Field type
    // select, beside the box it applies to.
    const { ed, drag, chooseType } = await boot();
    drag(100, 100, 260, 140);
    chooseType('text');
    expect(ed.fields[0].type).toBe('signature');
    expect(ed._drawType).toBe('text');
  });

  test('the drawer\u2019s type select DOES retype, and strips foreign properties', async () => {
    const { ed, $, drag, pick, chooseType, open } = await boot();
    chooseType('dropdown');
    drag(100, 100, 260, 140);
    type_(ed, $, 'options', 'A, B');
    expect(ed.fields[0].options).toEqual(['A', 'B']);
    pick($('.pe-drawer [data-pe="type"]'), 'checkbox');
    expect(ed.fields[0].type).toBe('checkbox');
    expect(ed.fields[0].options).toBeUndefined();   // server would reject it
  });

  function type_(ed, $, name, v) {
    const el = $(`.pe-drawer [data-pe="${name}"]`);
    el.value = v;
    el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
  }
});

describe('2H placement — touch (the flow that did nothing at all before)', () => {
  test('an un-armed tap does not draw \u2014 the finger belongs to the scroller', async () => {
    const { ed, tap, chooseType, open } = await boot({ coarse: true });
    tap(150, 150, 1, 'touch');
    expect(ed.fields).toHaveLength(0);
  });

  test('Place arms the next tap, which places and disarms', async () => {
    const { ed, $, click, tap, chooseType, open } = await boot({ coarse: true });
    ed.openDrawer(true);
    const arm = $('.pe-place');
    expect(arm).toBeTruthy();
    click(arm);
    expect(ed._armed).toBe(true);
    tap(150, 150, 1, 'touch');
    expect(ed.fields).toHaveLength(1);
    expect(ed._armed).toBe(false);
  });

  test('arming clears the selection so the aiming tap cannot be a dismiss', async () => {
    const { ed, $, click, drag } = await boot({ coarse: true });
    drag(100, 100, 260, 140);
    expect(ed.selectedUid).not.toBeNull();
    ed.openDrawer(true);
    click($('.pe-back'));                 // EDIT \u2192 ADD, where Place lives
    click($('.pe-place'));
    expect(ed._armed).toBe(true);
    expect(ed.selectedUid).toBeNull();
  });

  test('a mouse still draws freely on a touch-capable device', async () => {
    // A touchscreen laptop needs the arm button for its finger and free drag
    // for its mouse, at the same time.
    const { ed, drag, chooseType, open } = await boot({ coarse: true });
    drag(100, 100, 260, 140);
    expect(ed.fields).toHaveLength(1);
  });

  test('a mouse-only device gets the same button, worded for a mouse', async () => {
    const { $, ed, click } = await boot({ coarse: false });
    ed.openDrawer(true);
    expect($('.pe-place').textContent).toMatch(/drag/i);
    // …and it does NOT arm: a mouse has no gesture conflict to resolve.
    click($('.pe-place'));
    expect(ed._armed).toBe(false);
  });
});

describe('2G — the "$1000" path, end to end', () => {
  async function fillInSession() {
    const values = {};
    const h = await boot({
      opts: { textValue: { get: (k) => values[k] || '', set: (k, v) => { values[k] = v; } } },
    });
    h.chooseType('text');
    h.drag(100, 300, 240, 320);
    return { ...h, values };
  }

  test('a new fill-in names itself \u2014 nobody is asked to invent an identifier', async () => {
    const { ed } = await fillInSession();
    expect(ed.fields[0].key).toBe('field_1');
    expect(ed.fields[0].signer).toBeUndefined();   // server throws on text+signer
  });

  test('the VALUE is edited in the panel, beside the box', async () => {
    const { $, type, values, ed } = await fillInSession();
    const input = $('.pe-drawer [data-pe="value"]');
    expect(input).toBeTruthy();
    type(input, '$1,000.00');
    expect(values.field_1).toBe('$1,000.00');
    // …and the on-page tag shows what will print, not the machine name.
    expect($(`.pe-box[data-uid="${ed.fields[0].uid}"] .pe-tag`).textContent).toContain('1,000');
  });

  test('the key is demoted into a disclosure, not the primary question', async () => {
    const { $ } = await fillInSession();
    expect($('.pe-drawer [data-pe="key"]').closest('details')).toBeTruthy();
  });

  test('an illegal key is refused at the KEYSTROKE, naming the character', async () => {
    const { $, type, ed } = await fillInSession();
    const key = $('.pe-drawer [data-pe="key"]');
    type(key, '$1000');

    const err = $('.pe-drawer [data-pe-err="key"]');
    expect(err.style.display).not.toBe('none');
    expect(err.textContent).toContain('$');
    expect(err.textContent).not.toContain('[A-Za-z');   // never a raw regex
    expect(key.classList.contains('pe-invalid')).toBe(true);
    expect(ed.validate()).toHaveLength(1);
  });

  test('the offending box turns red immediately, without a re-render', async () => {
    const { $, type, ed } = await fillInSession();
    type($('.pe-drawer [data-pe="key"]'), '$1000');
    expect($(`.pe-box[data-uid="${ed.fields[0].uid}"]`).classList.contains('pe-bad')).toBe(true);
  });

  test('renaming a box carries its value across', async () => {
    const { $, type, values } = await fillInSession();
    type($('.pe-drawer [data-pe="value"]'), '$1,000.00');
    type($('.pe-drawer [data-pe="key"]'), 'fee');
    expect(values.fee).toBe('$1,000.00');
  });

  test('one tap repairs it into something the server accepts', async () => {
    const { $, type, click, ed } = await fillInSession();
    type($('.pe-drawer [data-pe="key"]'), '$1000');
    ed._renderPanel(true);
    const fix = $('.pe-drawer [data-pe="fixkey"]');
    expect(fix).toBeTruthy();
    click(fix);
    expect(ed.fields[0].key).toBe('1000');
    expect(ed.validate()).toHaveLength(0);
    expect(placements.TEXT_KEY_RE.test(ed.fields[0].key)).toBe(true);
  });
});

describe('2G — radio group rules mirrored in the panel', () => {
  async function twoCircles() {
    const h = await boot();
    h.chooseType('radio');
    h.drag(100, 500, 130, 530);
    h.type(h.$('.pe-drawer [data-pe="group"]'),  'Chapter');
    h.type(h.$('.pe-drawer [data-pe="rvalue"]'), '7');
    h.drag(200, 500, 230, 530);
    return h;
  }

  test('a sibling inherits the group but never a taken value', async () => {
    const { last } = await twoCircles();
    expect(last().group).toBe('Chapter');
    expect(last().value).toBe('');
  });

  test('a completed group validates clean against the server', async () => {
    const { $, type, ed } = await twoCircles();
    type($('.pe-drawer [data-pe="rvalue"]'), '13');
    expect(ed.validate()).toHaveLength(0);
    expect(() => placements.validatePlacements(ed.getPlacements())).not.toThrow();
  });

  test('switching signer carries the WHOLE group \u2014 a group has one signer', async () => {
    const { $, type, click, ed } = await twoCircles();
    type($('.pe-drawer [data-pe="rvalue"]'), '13');
    click($('.pe-drawer [data-pe="signer"][data-v="2"]'));
    const grp = ed.fields.filter((f) => f.type === 'radio' && f.group === 'Chapter');
    expect(grp).toHaveLength(2);
    expect(grp.every((f) => f.signer === 2)).toBe(true);
  });

  test('a duplicate never mints a colliding value or a second default', async () => {
    const { $, type, click, ed } = await twoCircles();
    type($('.pe-drawer [data-pe="rvalue"]'), '13');
    $('.pe-drawer [data-pe="rchecked"]').checked = true;
    $('.pe-drawer [data-pe="rchecked"]')
      .dispatchEvent(new ed.container.ownerDocument.defaultView.Event('change', { bubbles: true }));
    click($('.pe-drawer [data-pe="dup"]'));
    expect(ed.fields[ed.fields.length - 1].value).toBe('');
    expect(ed.fields[ed.fields.length - 1].checked).toBeUndefined();
  });
});

describe('2G — template flow (keySuggest, no textValue)', () => {
  // How templateAdmin.html mounts it: declared prefill_schema keys are offered,
  // and there is no ad-hoc value map — template values come from the schema.
  const SCHEMA = ['debtor_name', 'case_number', 'filing_date'];

  test('no Value input when the host owns no values', async () => {
    const { $, pick, drag, chooseType, open } = await boot({ opts: { keySuggest: SCHEMA } });
    chooseType('text');
    drag(100, 300, 240, 320);
    expect($('.pe-drawer [data-pe="value"]')).toBeNull();
    expect($('.pe-drawer [data-pe="key"]')).toBeTruthy();
  });

  test('a drawn fill-in claims the next UNPLACED declared key', async () => {
    const { $, pick, drag, ed, chooseType, open } = await boot({ opts: { keySuggest: SCHEMA } });
    chooseType('text');
    drag(100, 300, 240, 320);
    drag(100, 400, 240, 420);
    drag(100, 500, 240, 520);
    expect(ed.fields.map((f) => f.key)).toEqual(SCHEMA);
    // Minting field_N here would guarantee a "placed key not in the schema"
    // warning on every single box.
    expect(ed.fields.every((f) => SCHEMA.includes(f.key))).toBe(true);
  });

  test('once every declared key is placed, a further box asks the author', async () => {
    const { $, pick, drag, ed, chooseType, open } = await boot({ opts: { keySuggest: SCHEMA } });
    chooseType('text');
    for (let i = 0; i < 4; i++) drag(100, 200 + i * 60, 240, 220 + i * 60);
    expect(ed.fields[3].key).toBe('');
    expect(ed.validate()).toHaveLength(1);          // flagged, not silently sent
    expect(ed.validate()[0].message).toContain('key');
  });

  test('the datalist offers the declared keys', async () => {
    const { $, $$, pick, drag, chooseType, open } = await boot({ opts: { keySuggest: SCHEMA } });
    chooseType('text');
    drag(100, 300, 240, 320);
    const list = $('.pe-drawer datalist');
    expect(list).toBeTruthy();
    expect($$('.pe-drawer datalist option').map((o) => o.value)).toEqual(SCHEMA);
  });
});

describe('2G — the document survives the round trip', () => {
  test('a mixed document passes the REAL server validator', async () => {
    const values = {};
    const h = await boot({
      opts: { textValue: { get: (k) => values[k] || '', set: (k, v) => { values[k] = v; } } },
    });
    h.drag(100, 100, 260, 140);                              // signature
    h.chooseType('date');
    h.drag(300, 100, 400, 130);                              // date
    h.chooseType('text');
    h.drag(100, 300, 240, 320);                              // fill-in
    h.type(h.$('.pe-drawer [data-pe="value"]'), '$1,000.00');
    h.chooseType('dropdown');
    h.drag(100, 400, 240, 430);
    h.type(h.$('.pe-drawer [data-pe="options"]'), 'Chapter 7, Chapter 13');

    expect(h.ed.validate()).toEqual([]);
    const out = h.ed.getPlacements();
    expect(out.coord_space).toBe('pdf_user_space');
    expect(() => placements.validatePlacements(out)).not.toThrow();
  });

  test('seed \u2192 getPlacements is byte-stable', async () => {
    const h = await boot();
    h.drag(100, 100, 260, 140);
    h.drag(100, 300, 240, 340, 1);
    const out = h.ed.getPlacements();

    const h2 = await boot({ seed: out });
    expect(h2.ed.getPlacements()).toEqual(out);
  });

  test('fields on pages beyond the render are kept in the data, not dropped', async () => {
    const seed = { coord_space: 'pdf_user_space', fields: [
      { page: 9, x: 10, y: 10, w: 120, h: 24, type: 'signature', signer: 1 },
    ] };
    const { ed, $$, chooseType, open } = await boot({ seed });
    expect(ed.fields).toHaveLength(1);
    expect($$('.pe-box')).toHaveLength(0);             // nothing to draw it on
    expect(ed.getPlacements().fields[0].page).toBe(9); // …but it still ships
  });
});

describe('2G — validate() is what the send form asks', () => {
  test('an empty document reports nothing', async () => {
    const { ed, chooseType, open } = await boot();
    expect(ed.validate()).toEqual([]);
  });

  test('every problem carries a uid revealField can act on', async () => {
    const { $, pick, drag, type, ed, chooseType, open } = await boot();
    chooseType('text');
    drag(100, 300, 240, 320);
    type($('.pe-drawer [data-pe="key"]'), '$1000');
    const [p] = ed.validate();
    expect(p.uid).toBe(ed.fields[0].uid);
    expect(() => ed.revealField(p.uid)).not.toThrow();
    expect(ed.selectedUid).toBe(p.uid);
  });

  test('refreshTags repaints after the HOST changes a value behind our back', async () => {
    const values = {};
    const { $, drag, ed, chooseType } = await boot({
      opts: { textValue: { get: (k) => values[k] || '', set: (k, v) => { values[k] = v; } } },
    });
    chooseType('text');
    drag(100, 300, 240, 320);
    values.field_1 = 'from the review list';        // what sendForm's list does
    ed.refreshTags();
    expect($(`.pe-box[data-uid="${ed.fields[0].uid}"] .pe-tag`).textContent)
      .toContain('from the review');
  });
});

describe('2H — the resolver binding is a DOOR, not a control', () => {
  // Resolvers are a send-flow concept. Teaching the editor about them would
  // put the send flow's vocabulary inside a component whose whole job is not
  // knowing it. So the host supplies binding() for the chip and onBind() for
  // its own picker, and the editor renders a button.
  function hostWithBinding(bindings = {}) {
    const values = {};
    const asked = [];
    return {
      asked,
      values,
      bindings,
      textValue: {
        get: (k) => values[k] || '',
        set: (k, v) => { values[k] = v; },
        binding: (k) => bindings[k] || '',
        onBind: (k) => { asked.push(k); },
      },
    };
  }

  test('no binding button when the host offers no onBind', async () => {
    const values = {};
    const { $, drag, chooseType } = await boot({
      opts: { textValue: { get: (k) => values[k] || '', set: (k, v) => { values[k] = v; } } },
    });
    chooseType('text');
    drag(100, 300, 240, 320);
    expect($('.pe-drawer [data-pe="value"]')).toBeTruthy();
    expect($('.pe-drawer [data-pe="bind"]')).toBeNull();
  });

  test('an unbound fill-in offers the door', async () => {
    const host = hostWithBinding();
    const { $, drag, chooseType } = await boot({ opts: { textValue: host.textValue } });
    chooseType('text');
    drag(100, 300, 240, 320);
    const btn = $('.pe-drawer [data-pe="bind"]');
    expect(btn).toBeTruthy();
    expect(btn.classList.contains('on')).toBe(false);
    expect(btn.textContent).toMatch(/from the case/i);
  });

  test('clicking it hands the KEY back to the host, and nothing else', async () => {
    const host = hostWithBinding();
    const { $, click, drag, chooseType } = await boot({ opts: { textValue: host.textValue } });
    chooseType('text');
    drag(100, 300, 240, 320);
    click($('.pe-drawer [data-pe="bind"]'));
    expect(host.asked).toEqual(['field_1']);
  });

  test('a bound fill-in shows what it is bound to', async () => {
    const host = hostWithBinding({ field_1: 'contact.full_name' });
    const { $, drag, chooseType } = await boot({ opts: { textValue: host.textValue } });
    chooseType('text');
    drag(100, 300, 240, 320);
    const btn = $('.pe-drawer [data-pe="bind"]');
    expect(btn.classList.contains('on')).toBe(true);
    expect(btn.textContent).toContain('contact.full_name');
  });

  test('refreshTags rebuilds the chip after the host resolves a binding', async () => {
    // What sendForm does on confirm: record the binding, resolve it, write the
    // value back, then tell the editor. Both the chip and the on-page tag have
    // to catch up.
    const host = hostWithBinding();
    const { $, ed, drag, chooseType } = await boot({ opts: { textValue: host.textValue } });
    chooseType('text');
    drag(100, 300, 240, 320);
    expect($('.pe-drawer [data-pe="bind"]').classList.contains('on')).toBe(false);

    host.bindings.field_1 = 'contact.full_name';
    host.values.field_1   = 'Jane Debtor';
    ed.refreshTags();

    expect($('.pe-drawer [data-pe="bind"]').classList.contains('on')).toBe(true);
    expect($('.pe-drawer [data-pe="value"]').value).toBe('Jane Debtor');
    expect($(`.pe-box[data-uid="${ed.fields[0].uid}"] .pe-tag`).textContent).toContain('Jane');
  });

  test('the field list shows what each fill-in PRINTS, not its machine name', async () => {
    // This list replaced the send form's bottom-of-page value table, so it has
    // to answer "are all my values set?" on its own.
    const host = hostWithBinding();
    const { $$, ed, drag, chooseType, type, $ } = await boot({ opts: { textValue: host.textValue } });
    chooseType('text');
    drag(100, 300, 240, 320);
    type($('.pe-drawer [data-pe="value"]'), '$1,000.00');
    const row = $$('.pe-list .pe-li').find((b) => b.textContent.includes('1,000'));
    expect(row).toBeTruthy();
  });
});
