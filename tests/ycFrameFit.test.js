// tests/ycFrameFit.test.js
//
// public/js/yc-frame-fit.js fitFrameToContent() — the one copy of the
// "iframe as tall as its document" helper that eventform.html,
// checklistsView.html and apptform2.html each used to carry (2026-10-06).
//
// The behavioural change it brings: the watch now re-fits on inline-STYLE
// changes too, not only on DOM changes. A note body growing under autoGrow()
// as the user types is a height write, so the old childList-only watch left
// the host's frame short, with a scrollbar of its own.
//
// Real jsdom iframe (same-origin about:blank), the module evaluated in the
// host window. jsdom has no layout, so the frame body's scrollHeight is a
// stub the test drives.
//
//   npx jest tests/ycFrameFit.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/js/yc-frame-fit.js'), 'utf8');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) {} }); });
const flush = (w) => new Promise(r => w.setTimeout(r, 0));   // MutationObserver delivers on a microtask

function setup({ noObserver = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  DOMS.push(dom);
  const w = dom.window;
  w.eval(SRC);
  const f = w.document.createElement('iframe');
  w.document.body.appendChild(f);
  const fdoc = f.contentDocument;
  fdoc.body.innerHTML = '<div id="card"><textarea id="ta"></textarea></div>';
  const box = { h: 200 };
  Object.defineProperty(fdoc.body, 'scrollHeight', { configurable: true, get: () => box.h });
  if (noObserver) f.contentWindow.MutationObserver = undefined;
  return { w, f, fdoc, box };
}

describe('fitFrameToContent', () => {
  test('fits at once: body scrollHeight + 24', () => {
    const { w, f } = setup();
    w.fitFrameToContent(f);
    expect(f.style.height).toBe('224px');
  });

  test('re-fits on a DOM change inside the frame (a card added)', async () => {
    const { w, f, fdoc, box } = setup();
    w.fitFrameToContent(f);
    box.h = 350;
    fdoc.body.appendChild(fdoc.createElement('div'));
    await flush(w);
    expect(f.style.height).toBe('374px');
  });

  test('re-fits on an inline STYLE change — a note body autoGrow-ing as the user types', async () => {
    const { w, f, fdoc, box } = setup();
    w.fitFrameToContent(f);
    box.h = 420;
    fdoc.getElementById('ta').style.height = '260px';     // autoGrow's write; no DOM change
    await flush(w);
    expect(f.style.height).toBe('444px');
  });

  test('…but not on unrelated attribute churn (class flips stay cheap)', async () => {
    const { w, f, fdoc, box } = setup();
    w.fitFrameToContent(f);
    box.h = 999;
    fdoc.getElementById('card').className = 'ck-card dirty';
    await flush(w);
    expect(f.style.height).toBe('224px');
  });

  test('no ratchet: re-fitting unchanged content keeps the same height', async () => {
    const { w, f, fdoc } = setup();
    const h = w.fitFrameToContent(f);
    h.fit(); h.fit();
    fdoc.body.appendChild(fdoc.createElement('span'));
    await flush(w);
    expect(f.style.height).toBe('224px');
  });

  test('stop() disconnects the watch', async () => {
    const { w, f, fdoc, box } = setup();
    const h = w.fitFrameToContent(f);
    h.stop();
    box.h = 500;
    fdoc.body.appendChild(fdoc.createElement('div'));
    await flush(w);
    expect(f.style.height).toBe('224px');
  });

  test('without MutationObserver it polls — and stop() clears the interval (apptform2 remounts)', () => {
    const { w, f } = setup({ noObserver: true });
    const started = [], cleared = [];
    const si = w.setInterval, ci = w.clearInterval;
    w.setInterval = (fn, ms) => { const id = si(fn, ms); started.push({ id, ms }); return id; };
    w.clearInterval = (id) => { cleared.push(id); ci(id); };
    const h = w.fitFrameToContent(f);
    expect(started).toHaveLength(1);
    expect(started[0].ms).toBe(700);
    h.stop();
    expect(cleared).toEqual([started[0].id]);
  });
});

describe('the three hosts use it, and only it', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
  const code = (f) => read(f).replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  test.each(['eventform.html', 'checklistsView.html', 'apptform2.html'])('%s loads the module and fits through it', (f) => {
    const src = code(f);
    expect(src).toMatch(/<script src="\/js\/yc-frame-fit\.js"><\/script>/);
    expect(src).toMatch(/fitFrameToContent\(f\)/);
    // no private copy left behind
    expect(src).not.toMatch(/new f\.contentWindow\.MutationObserver/);
  });

  test('apptform2 stops the previous appointment\'s watch before fitting the next', () => {
    expect(code('apptform2.html')).toMatch(/if \(notesFit\) notesFit\.stop\(\);\s*notesFit = fitFrameToContent\(f\);/);
  });
});
