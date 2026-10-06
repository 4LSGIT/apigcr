// tests/checklistView.autoGrow.test.js
//
// checklistView.html's note bodies size themselves with scripts.js autoGrow()
// (2026-10-06), the helper the case Overview's notes box moved to first.
//
// Before: render() and the sync-bus repaint called the one-shot
// resizeTextarea(). A body filled while this frame's tab was HIDDEN — the
// commonest case being a note saved on the case Overview while Notes & Lists
// sits loaded in the background — measured 0, dropped to the 58px floor and
// stayed there. autoGrow re-fits on show; its mechanics are pinned in
// tests/autoGrow.test.js. What THIS file pins is the page's side:
//
//   · every note body — user notes AND the native case-notes card — is bound
//     to autoGrow with the page's one ceiling (NOTE_BODY_MAX_PX);
//   · render() fits them all once attached (eventform.html's iframe sizing
//     measures right after a render, so this must stay synchronous);
//   · the bus repaint of a native card re-fits it (no input event fires for a
//     programmatic .value write);
//   · the ceiling lives in ONE place — no CSS max-height to keep in step —
//     and resizeTextarea() is gone for good.
//
// BOOTS THE REAL PAGE in jsdom against a stub shell (window.top === window,
// so the page's api() finds window.apiSend), with the real yc-sync.js and
// scripts.js evaluated first. autoGrow is wrapped — not replaced — so every
// call still runs the real helper.
//
//   npx jest tests/checklistView.autoGrow.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/checklistView.html'), 'utf8');
const YCSYNC  = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');
const CASE_ID = 'AAAAAAAA';

const DOMS = [], TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach(fn => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) {} });
});
const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));

function note(over) {
  return Object.assign({
    id: 501, kind: 'note', title: 'Call log', body: 'first line\nsecond line',
    status: 'open', link_type: 'case', link: CASE_ID, items: [],
    created_date: '2026-10-01 10:00:00', updated_date: '2026-10-01 10:00:00',
  }, over);
}

async function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: `https://app.4lsg.com/checklistView.html?link_type=case&link=${CASE_ID}`,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => false });

  window.apiSend = async (url, method) => {
    let data = { status: 'success' };
    if (url === `/api/cases/${CASE_ID}` && method === 'GET') {
      data = { case: { case_id: CASE_ID, case_notes: 'stored case notes' } };
    } else if (url === '/checklists' && method === 'GET') {
      data = { checklists: [note()] };
    } else if (url === `/api/cases/${CASE_ID}/contacts`) {
      data = { data: [] };
    }
    window.setTimeout(() => {
      try { window.YC && window.YC._sniff(method, url, data); } catch (_) {}
    }, 0);
    return data;
  };
  window.Swal = {
    mixin: () => ({ fire: () => {} }), fire: async () => ({ isConfirmed: false }),
    close() {}, stopTimer() {}, resumeTimer() {},
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  // Wrap the REAL helper: record every element bound and every fit, keep
  // the behaviour. (Same handle object either way, so counts stay exact.)
  // Installed from INSIDE the single eval below — scripts.js's `const E` and
  // friends are scoped to the eval that declares them, so scripts.js and the
  // page must share one (see tests/caseUi.sync.test.js's header).
  const bound = [], fits = [];
  window.__wrapAutoGrow = (real) => (el, opts) => {
    const fresh = el && !el._autoGrow;
    const h = real(el, opts);
    if (fresh && h) {
      bound.push({ el, max: opts && opts.max });
      const fit = h.fit;
      h.fit = () => { fits.push(el); fit(); };
    }
    return h;
  };

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = noComments.replace(/[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*/i, '');
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  window.eval([SCRIPTS, 'autoGrow = window.__wrapAutoGrow(autoGrow);', ...inline].join('\n;\n'));
  await tick(window, 150);
  return { window, errors, bound, fits };
}

const bodies = (w) => [...w.document.querySelectorAll('.ck-note-body')];

describe('checklistView note bodies use autoGrow', () => {
  test('EVERY note body — the native case-notes card and a user note — is bound, with the one ceiling', async () => {
    const { window, errors, bound } = await boot();
    expect(errors).toEqual([]);
    const tas = bodies(window);
    expect(tas.map(t => t.value)).toEqual(expect.arrayContaining(['stored case notes', 'first line\nsecond line']));
    expect(tas.length).toBeGreaterThanOrEqual(2);
    for (const ta of tas) {
      expect(ta._autoGrow && typeof ta._autoGrow.fit).toBe('function');
      expect(bound.find(b => b.el === ta).max).toBe(300);
    }
  });

  test('render() fits every body once attached — synchronously, for eventform\'s frame sizing', async () => {
    const { window, fits } = await boot();
    const tas = bodies(window);
    for (const ta of tas) expect(fits).toContain(ta);
    // …and a later render() does it again for the rebuilt bodies.
    const before = fits.length;
    window.reloadChecklists();
    await tick(window, 100);
    const rebuilt = bodies(window);
    expect(rebuilt.every(ta => !tas.includes(ta))).toBe(true);   // new elements
    for (const ta of rebuilt) expect(fits.slice(before)).toContain(ta);
  });

  test('a bus write to the native card re-fits it (no input event fires for .value)', async () => {
    const { window, fits } = await boot();
    const native = bodies(window).find(t => t.value === 'stored case notes');
    const before = fits.filter(el => el === native).length;
    window.YC.emit(`case:${CASE_ID}`,
      { case_notes: { from: 'stored case notes', to: 'saved on the Overview\nline 2\nline 3' } }, 'test');
    await tick(window, 100);
    expect(native.value).toBe('saved on the Overview\nline 2\nline 3');
    expect(fits.filter(el => el === native).length).toBe(before + 1);
  });
});

describe('one ceiling, one helper', () => {
  test('.ck-note-body carries NO CSS max-height — NOTE_BODY_MAX_PX is the only ceiling', () => {
    const rule = HTML.match(/\.ck-note-body\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const decls = rule[1].replace(/\/\*[\s\S]*?\*\//g, '');   // the comment explains the history
    expect(decls).not.toMatch(/max-height/);
    expect(decls).toMatch(/resize:\s*none/);              // render() rebuilds — no drag here
    expect(HTML).toMatch(/const NOTE_BODY_MAX_PX = 300;/);
  });

  test('resizeTextarea() is gone — no definition, no callers', () => {
    expect(SCRIPTS).not.toMatch(/function resizeTextarea\s*\(/);
    for (const f of ['public/checklistView.html', 'public/case.html']) {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/resizeTextarea\s*\(/);
    }
  });
});
