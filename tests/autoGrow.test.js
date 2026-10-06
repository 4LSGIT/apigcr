// tests/autoGrow.test.js
//
// public/scripts.js autoGrow() — a textarea that fits its content, re-fits
// when it is SHOWN, and lets the user drag it taller.
//
// WHY IT EXISTS (2026-10-06): the case Overview's notes box never fitted a
// single note on load. updateHeader() filled it and called the one-shot
// resizeTextarea() while the Overview tab was still display:none (openTab
// runs after it in case.html's initial load), so scrollHeight read 0, the box
// sat at its 100px CSS floor, and nothing ever measured it again. The test
// that pins that bug is "hidden at fit time, fitted when shown".
//
// jsdom has no layout, so the box is a stub: scrollHeight / offsetWidth /
// offsetHeight / getClientRects are driven by the test, and offsetHeight
// honours the CSS min-height the way a browser would. ResizeObserver is a
// stub the test fires by hand; requestAnimationFrame runs synchronously.
// The function under test is the REAL source, extracted from scripts.js.
//
//   npx jest tests/autoGrow.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts.js'), 'utf8');
const AUTOGROW = (() => {
  const start = SRC.indexOf('function autoGrow(el, opts) {');
  const end = SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('autoGrow() not found in public/scripts.js');
  return SRC.slice(start, end + 2);
})();

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) {} }); });

/**
 * @param {object} o
 * @param {boolean} o.ro          provide a ResizeObserver
 * @param {string}  o.boxSizing   'border-box' | 'content-box'
 */
function setup({ ro = true, boxSizing = 'border-box' } = {}) {
  const dom = new JSDOM('<!doctype html><body><textarea id="t"></textarea></body>',
    { runScripts: 'outside-only' });
  DOMS.push(dom);
  const w = dom.window;
  const observers = [];
  if (ro) {
    w.ResizeObserver = class {
      constructor(cb) { this.cb = cb; this.els = []; observers.push(this); }
      observe(el) { this.els.push(el); }
    };
  }
  w.requestAnimationFrame = (f) => f();
  w.eval(AUTOGROW);

  const el = w.document.getElementById('t');
  el.style.boxSizing = boxSizing;
  el.style.border = '1px solid black';
  el.style.padding = '4px';
  const box = { shown: true, content: 60, width: 600, dragged: null, minH: 100 };
  // A display:none box measures 0 — which is the whole bug.
  Object.defineProperty(el, 'scrollHeight', { get: () => (box.shown ? box.content : 0) });
  Object.defineProperty(el, 'offsetWidth', { get: () => (box.shown ? box.width : 0) });
  Object.defineProperty(el, 'offsetHeight', {
    get: () => {
      if (!box.shown) return 0;
      if (box.dragged !== null) return box.dragged;
      return Math.max(parseFloat(el.style.height) || 0, box.minH);
    },
  });
  el.getClientRects = () => (box.shown ? [{}] : []);

  const fireRO = () => observers.forEach(o => o.cb([]));
  const type = () => el.dispatchEvent(new w.Event('input', { bubbles: true }));
  return { w, el, box, observers, fireRO, type };
}

describe('autoGrow', () => {
  test('fits the text on input — border-box adds the borders to scrollHeight', () => {
    const { w, el, box, type } = setup();
    w.autoGrow(el, { max: 300 });
    box.content = 150;
    type();
    expect(el.style.height).toBe('152px');               // 150 + 1px top + 1px bottom
  });

  test('content-box takes the padding back off instead', () => {
    const { w, el, box, type } = setup({ boxSizing: 'content-box' });
    w.autoGrow(el, { max: 300 });
    box.content = 150;
    type();
    expect(el.style.height).toBe('142px');               // 150 − 4px − 4px
  });

  test('the automatic height stops at max', () => {
    const { w, el, box, type } = setup();
    w.autoGrow(el, { max: 300 });
    box.content = 900;
    type();
    expect(el.style.height).toBe('300px');
  });

  test('HIDDEN at fit time → no write; SHOWN later → fitted (the Overview load bug)', () => {
    const { w, el, box, fireRO } = setup();
    box.shown = false;                                   // tab still display:none
    const g = w.autoGrow(el, { max: 300 });
    box.content = 220;
    g.fit();                                             // updateHeader's call
    expect(el.style.height).toBe('');                    // not a 0 → 100px floor
    fireRO();                                            // the observer sees 0-wide
    expect(el.style.height).toBe('');

    box.shown = true;                                    // openTab shows the tab
    fireRO();
    expect(el.style.height).toBe('222px');
  });

  test('a width change (a reflow that re-wraps the text) re-fits', () => {
    const { w, el, box, fireRO, type } = setup();
    w.autoGrow(el, { max: 300 });
    box.content = 100; type();
    fireRO();                                            // first observation: records the width
    box.width = 300; box.content = 200;                  // narrower → more lines
    fireRO();
    expect(el.style.height).toBe('202px');
  });

  test('a DRAG becomes a floor — typing does not snap it back, and it may pass max', () => {
    const { w, el, box, fireRO, type } = setup();
    w.autoGrow(el, { max: 300 });
    box.content = 150; type();
    fireRO(); fireRO();                                  // our own write: not a drag
    expect(el.style.height).toBe('152px');

    box.dragged = 450;                                   // the user pulls the handle
    fireRO();
    box.dragged = null;                                  // the browser now reports our height again
    box.content = 160;
    type();
    expect(el.style.height).toBe('450px');               // the floor, past the 300 cap
  });

  test('its OWN writes are never mistaken for a drag', () => {
    const { w, el, box, fireRO, type } = setup();
    w.autoGrow(el, { max: 300 });
    box.content = 250; type(); fireRO();
    box.content = 120; type(); fireRO();                 // shrinks back with the text
    expect(el.style.height).toBe('122px');
  });

  test('the CSS min-height floor is honoured, not fought', () => {
    const { w, el, box, fireRO, type } = setup();
    w.autoGrow(el, { max: 300 });
    box.content = 40; type();                            // writes 42px; renders 100
    fireRO();                                            // first report: records the width
    fireRO();                                            // a size report: 100 !== 42 must NOT read as a drag
    box.content = 60; type();
    expect(el.style.height).toBe('62px');                // no phantom 100px floor
  });

  test('idempotent — one handle, one observer, per element', () => {
    const { w, el, observers } = setup();
    const a = w.autoGrow(el);
    const b = w.autoGrow(el);
    expect(a).toBe(b);
    expect(observers).toHaveLength(1);
  });

  test('no element → null, no throw', () => {
    const { w } = setup();
    expect(w.autoGrow(null)).toBeNull();
  });

  test('WITHOUT ResizeObserver it still fits on input', () => {
    const { w, el, box, type } = setup({ ro: false });
    w.autoGrow(el, { max: 300 });
    box.content = 150;
    type();
    expect(el.style.height).toBe('152px');
  });

  test('default max is 300', () => {
    const { w, el, box, type } = setup();
    w.autoGrow(el);
    box.content = 5000;
    type();
    expect(el.style.height).toBe('300px');
  });
});
