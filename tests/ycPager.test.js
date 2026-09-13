// tests/ycPager.test.js
//
/**
 * public/js/ycPager.js — the shared list pager/footer.
 *
 * Supersedes tests/apptsPicker.pager.test.js: the engine under test began as
 * apptform2.html's picker pager, and that file's tests lifted pkPageWindow out
 * of the page source by string-slicing. The module is a real CommonJS export,
 * so these tests require it directly. Every invariant the old file pinned is
 * pinned here under the same names, plus the pieces that moved in with the
 * extraction: snapBackOffset, the per-surface limit store, and the DOM the
 * two renderers emit.
 *
 *   SHAPE       first page, last page, and current ± span, de-duplicated and
 *               ordered. Anything else is a gap.
 *   GAP RANGE   a gap is not a decoration — it carries the inclusive range of
 *               pages it hides, and the jump-to-page control renders that
 *               range as its placeholder ("6–89"). A wrong range would offer
 *               the user a jump target that is not actually hidden there.
 *   THE 8-PAGE  the footer's jump affordance IS the ellipsis, so "few pages
 *   INVARIANT   never need it, many pages always offer it" has to hold or the
 *               control silently disappears at some page count. Below 8 every
 *               page is its own button; from 8 up a gap is unavoidable.
 *
 * Run:  npx jest tests/ycPager.test.js
 */

'use strict';

const { JSDOM } = require('jsdom');
const {
  pageWindow, snapBackOffset, getLimit, setLimit, renderPages, renderFooter,
} = require('../public/js/ycPager.js');

/** Render a window the way the footer reads: numbers 1-based, gaps as '…'. */
const shape = (cur, pages, span) =>
  pageWindow(cur, pages, span).map((p) => (typeof p === 'object' ? '…' : String(p + 1)));

describe('pageWindow shape', () => {
  test('every page is its own button while they all fit', () => {
    // 7 pages is the largest set the default span can cover with no gap:
    // first + last + 5 consecutive.
    expect(shape(3, 7)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(shape(0, 1)).toEqual(['1']);
    expect(shape(0, 2)).toEqual(['1', '2']);
  });

  test('a long set collapses to first, a window, and last', () => {
    expect(shape(0, 90)).toEqual(['1', '2', '3', '…', '90']);
    expect(shape(44, 90)).toEqual(['1', '…', '43', '44', '45', '46', '47', '…', '90']);
    expect(shape(89, 90)).toEqual(['1', '…', '88', '89', '90']);
  });

  test('the window never repeats a page or runs past either end', () => {
    for (let pages = 1; pages <= 40; pages++) {
      for (let cur = 0; cur < pages; cur++) {
        const nums = pageWindow(cur, pages).filter((p) => typeof p === 'number');
        expect(nums).toEqual([...new Set(nums)]);                 // no duplicates
        expect([...nums].sort((a, b) => a - b)).toEqual(nums);     // ascending
        expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...nums)).toBeLessThan(pages);
        expect(nums).toContain(cur);                              // you can see where you are
        expect(nums).toContain(0);
        expect(nums).toContain(pages - 1);
      }
    }
  });
});

describe('gap ranges', () => {
  test('a gap carries exactly the pages its neighbours skip', () => {
    // ['1', '2', '3', '…', '90'] — the ellipsis stands for pages 4 through 89,
    // which 0-based is 3 through 88. That pair is the jump input's placeholder.
    const [, , , gap] = pageWindow(0, 90);
    expect(gap).toEqual({ from: 3, to: 88 });
  });

  test('both gaps are ranged independently when the window sits in the middle', () => {
    const gaps = pageWindow(44, 90).filter((p) => typeof p === 'object');
    expect(gaps).toEqual([{ from: 1, to: 41 }, { from: 47, to: 88 }]);
  });

  test('no gap is empty, and together with the numbers they cover every page once', () => {
    for (let pages = 1; pages <= 60; pages++) {
      for (let cur = 0; cur < pages; cur++) {
        const seen = [];
        pageWindow(cur, pages).forEach((p) => {
          if (typeof p === 'number') return seen.push(p);
          expect(p.to).toBeGreaterThanOrEqual(p.from);   // a gap hides >= 1 page
          for (let n = p.from; n <= p.to; n++) seen.push(n);
        });
        // Nothing double-counted, nothing unreachable: every page is either a
        // button or inside exactly one gap's jump range.
        expect(seen).toEqual([...Array(pages).keys()]);
      }
    }
  });
});

describe('the jump affordance appears exactly when it is needed', () => {
  const hasGap = (cur, pages, span) =>
    pageWindow(cur, pages, span).some((p) => typeof p === 'object');

  /* Three bands, stated as formulas because the numbers move with span:
       pages <= span + 3        nothing is ever hidden, wherever you stand
       pages >= 2*span + 6      something is always hidden, wherever you stand
       in between               depends where you are — the window is truncated
                                at the ends, so an edge position orphans pages a
                                centred one does not.
     The upper bound is what makes the ellipsis a sound place to put the jump
     control: past it, the control cannot vanish on the user. */
  const NEVER  = (span) => span + 3;
  const ALWAYS = (span) => 2 * span + 6;

  test.each([1, 2, 3, 4])('span=%i: at or below span+3 pages nothing is hidden', (span) => {
    for (let pages = 1; pages <= NEVER(span); pages++) {
      for (let cur = 0; cur < pages; cur++) {
        expect({ pages, cur, gap: hasGap(cur, pages, span) }).toEqual({ pages, cur, gap: false });
      }
    }
  });

  test.each([1, 2, 3, 4])('span=%i: at or above 2*span+6 pages something always is', (span) => {
    for (let pages = ALWAYS(span); pages <= ALWAYS(span) + 60; pages++) {
      for (let cur = 0; cur < pages; cur++) {
        expect({ pages, cur, gap: hasGap(cur, pages, span) }).toEqual({ pages, cur, gap: true });
      }
    }
  });

  test('the bands are tight — one page either side flips each of them', () => {
    // span=2: 5 never hides, 6 hides from the edge; 9 has one safe spot, 10 none.
    expect([0, 1, 2, 3, 4].some((c) => hasGap(c, 5, 2))).toBe(false);
    expect([...Array(6).keys()].some((c) => hasGap(c, 6, 2))).toBe(true);
    expect([...Array(9).keys()].every((c) => hasGap(c, 9, 2))).toBe(false);
    expect([...Array(10).keys()].every((c) => hasGap(c, 10, 2))).toBe(true);
  });

  test('a hidden run of one is rendered as that page, never as an ellipsis', () => {
    // pages=5 / cur=0: the window reaches 1..3, the last page is 5, and page 4
    // is the single page between them. It gets a button, not an ellipsis.
    expect(shape(0, 5)).toEqual(['1', '2', '3', '4', '5']);
    // Every gap that survives therefore stands for at least two pages.
    for (let pages = 1; pages <= 120; pages++) {
      for (let cur = 0; cur < pages; cur++) {
        pageWindow(cur, pages)
          .filter((p) => typeof p === 'object')
          .forEach((g) => expect(g.to - g.from).toBeGreaterThanOrEqual(1));
      }
    }
  });
});

describe('snapBackOffset', () => {
  test('an offset past the end lands on the last real page', () => {
    // 2232 rows at 25/page: last page starts at 2225. An offset stranded at
    // 2250 (the set shrank) comes back to 2225.
    expect(snapBackOffset(2232, 25, 2250)).toBe(2225);
    expect(snapBackOffset(10, 25, 25)).toBe(0);
  });

  test('the retry only ever moves strictly backwards — the termination guard', () => {
    // A count that disagrees with the rows must not retarget the offset it is
    // already on (that recursion is the tab-killing loop the guard exists for).
    expect(snapBackOffset(100, 25, 75)).toBe(-1);   // 75 IS the last page
    expect(snapBackOffset(100, 25, 50)).toBe(-1);   // mid-set stays put
  });

  test('zero and first-page cases never snap', () => {
    expect(snapBackOffset(0, 25, 50)).toBe(-1);     // nothing to land on
    expect(snapBackOffset(90, 25, 0)).toBe(-1);     // already at the start
  });

  test('exact multiples: the last page is a full one, not a phantom empty one', () => {
    // total 100 / limit 50 → pages end at offset 50. This is the off-by-one
    // class the shell tabs' hand-rolled pagers had (`total >= (i-1)*limit`
    // printed page 3 of 2).
    expect(snapBackOffset(100, 50, 100)).toBe(50);
  });
});

describe('the per-surface limit store', () => {
  let store;
  beforeEach(() => {
    store = {};
    globalThis.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    };
  });
  afterEach(() => { delete globalThis.localStorage; });

  test('each surface remembers its own size in one map', () => {
    setLimit('log', 200);
    setLimit('tasks', 50);
    expect(getLimit('log', 100)).toBe(200);
    expect(getLimit('tasks', 100)).toBe(50);
    // One entry, not one per surface — the map is the contract.
    expect(JSON.parse(store['yc.pager.limits'])).toEqual({ log: 200, tasks: 50 });
  });

  test('falls back to the pre-module per-tab pref, then the default', () => {
    // A size saved by the old setTabPref('log','limit',…) spelling must
    // survive the migration day rather than reset.
    store['yc.log.limit'] = '500';
    expect(getLimit('log', 100)).toBe(500);
    expect(getLimit('never-saved', 25)).toBe(25);
    // Once the map has the key, the map wins.
    setLimit('log', 50);
    expect(getLimit('log', 100)).toBe(50);
  });

  test('garbage never escapes: bad JSON, bad values, no storage', () => {
    store['yc.pager.limits'] = 'not json';
    expect(getLimit('log', 100)).toBe(100);
    setLimit('log', -5);                       // refused, not stored
    expect(store['yc.pager.limits']).toBe('not json');
    delete globalThis.localStorage;            // storage disabled entirely
    expect(getLimit('log', 100)).toBe(100);
    expect(() => setLimit('log', 50)).not.toThrow();
  });
});

/* ── DOM output ──────────────────────────────────────────────────────────
   jsdom, but the module was loaded in Node with no window: ensureStyles
   no-ops (no global document) and every builder works off el.ownerDocument.
   Handlers are assigned as element properties, so tests invoke them
   directly with the two fields they read (key, preventDefault). */

function host() {
  const dom = new JSDOM('<!doctype html><body><div id="foot"></div></body>');
  return dom.window.document.getElementById('foot');
}
const texts = (el, sel) => [...el.querySelectorAll(sel)].map((n) => n.textContent);

describe('renderPages DOM', () => {
  test('arrows + numbered buttons, current disabled and marked', () => {
    const el = host();
    const jumps = [];
    // 90 rows at 10/page, standing on page 5 (offset 40).
    renderPages(el, { total: 90, limit: 10, offset: 40, onPage: (p) => jumps.push(p) });

    const btns = [...el.querySelectorAll('button')];
    expect(btns[0].textContent).toBe('‹');
    expect(btns[btns.length - 1].textContent).toBe('›');
    const current = el.querySelector('.yc-page-current');
    expect(current.textContent).toBe('5');
    expect(current.disabled).toBe(true);
    expect(current.getAttribute('aria-current')).toBe('page');

    btns[1].onclick();                        // the "1" button
    expect(jumps).toEqual([0]);
    btns[0].onclick();                        // ‹ from page index 4
    expect(jumps).toEqual([0, 3]);
  });

  test('arrows disable at the ends; a single page renders no live target', () => {
    const el = host();
    renderPages(el, { total: 5, limit: 10, offset: 0, onPage: () => {} });
    const btns = [...el.querySelectorAll('button')];
    // ‹ [1] › — all three disabled: there is nowhere to go.
    expect(btns.map((b) => b.disabled)).toEqual([true, true, true]);
  });

  test('an exact multiple of the page size does not grow a phantom page', () => {
    const el = host();
    renderPages(el, { total: 100, limit: 50, offset: 0, onPage: () => {} });
    expect(texts(el, '.yc-page:not(.yc-gap)')).toEqual(['‹', '1', '2', '›']);
  });

  test('the ellipsis is a button that becomes the jump input', () => {
    const el = host();
    const jumps = [];
    renderPages(el, { total: 900, limit: 10, offset: 0, onPage: (p) => jumps.push(p) });

    const gap = el.querySelector('.yc-gap');
    expect(gap.tagName).toBe('BUTTON');
    gap.onclick();
    const input = el.querySelector('.yc-jump');
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe('4–89');    // exactly the hidden run, 1-based

    // Out of range = never mind, not a clamp: the control restores, no jump.
    input.value = '900';
    input.onkeydown({ key: 'Enter', preventDefault: () => {} });
    expect(jumps).toEqual([]);
    expect(el.querySelector('.yc-jump')).toBeNull();
    expect(el.querySelector('.yc-gap')).not.toBeNull();

    // In range commits 0-based.
    el.querySelector('.yc-gap').onclick();
    const input2 = el.querySelector('.yc-jump');
    input2.value = '42';
    input2.onkeydown({ key: 'Enter', preventDefault: () => {} });
    expect(jumps).toEqual([41]);
  });

  test('a poll re-render cannot yank the jump input mid-typing', () => {
    // Workflow executions / sequence enrollments rebuild their footer on a
    // 5s poll. While the jump input holds focus, a re-render must no-op —
    // the half-typed page number outranks one refresh of the counts.
    const el = host();
    renderPages(el, { total: 900, limit: 10, offset: 0, onPage: () => {} });
    el.querySelector('.yc-gap').onclick();
    const input = el.querySelector('.yc-jump');
    input.focus();
    expect(el.ownerDocument.activeElement).toBe(input);

    renderPages(el, { total: 910, limit: 10, offset: 0, onPage: () => {} });
    expect(el.querySelector('.yc-jump')).toBe(input);   // untouched, same node

    // Once the jump settles (Escape here), the next render goes through.
    input.onkeydown({ key: 'Escape', preventDefault: () => {} });
    renderPages(el, { total: 910, limit: 10, offset: 0, onPage: () => {} });
    expect(el.querySelector('.yc-jump')).toBeNull();
    expect(el.querySelector('.yc-gap')).not.toBeNull();
  });

  test('Escape restores the ellipsis without jumping', () => {
    const el = host();
    const jumps = [];
    renderPages(el, { total: 900, limit: 10, offset: 0, onPage: (p) => jumps.push(p) });
    el.querySelector('.yc-gap').onclick();
    const input = el.querySelector('.yc-jump');
    input.onkeydown({ key: 'Escape', preventDefault: () => {} });
    expect(jumps).toEqual([]);
    expect(el.querySelector('.yc-gap')).not.toBeNull();
  });
});

describe('renderFooter DOM', () => {
  test('range text, and the stranded page reads 0-of-N rather than lying', () => {
    const el = host();
    renderFooter(el, { total: 90, limit: 25, offset: 25, shown: 25, onPage: () => {} });
    expect(el.querySelector('.yc-pager-range').textContent).toBe('26–50 of 90');

    renderFooter(el, { total: 90, limit: 25, offset: 100, shown: 0, onPage: () => {} });
    expect(el.querySelector('.yc-pager-range').textContent).toBe('0 of 90');
  });

  test('zero results: no page buttons, but the levers stay', () => {
    const el = host();
    renderFooter(el, {
      total: 0, limit: 50, offset: 0, shown: 0,
      onPage: () => {}, onLimit: () => {}, onPrint: true,
    });
    expect(el.querySelector('.yc-page')).toBeNull();
    expect(el.querySelector('.yc-pager-range').textContent).toBe('0 of 0');
    // An empty filter result must keep the size select and Print reachable —
    // the logs footer always did, and losing them strands the user.
    expect(el.querySelector('.yc-pager-size')).not.toBeNull();
    expect(el.querySelector('.yc-pager-print')).not.toBeNull();
  });

  test('the size select persists per surface, then hands off at page 0', () => {
    const store = {};
    globalThis.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    };
    try {
      const el = host();
      const got = [];
      renderFooter(el, {
        total: 90, limit: 25, offset: 0, shown: 25,
        onPage: () => {}, persistKey: 'widget', onLimit: (n) => got.push(n),
      });
      const sel = el.querySelector('.yc-pager-size');
      expect(texts(sel, 'option')).toEqual(['25', '50', '100', '200', '500']);
      expect(sel.value).toBe('25');
      sel.value = '100';
      sel.onchange();
      expect(got).toEqual([100]);                      // a number, not a string
      expect(JSON.parse(store['yc.pager.limits'])).toEqual({ widget: 100 });
    } finally {
      delete globalThis.localStorage;
    }
  });

  test('a stored size missing from the menu still shows as the selected option', () => {
    // A server-clamped or legacy size (30) must render selected — a select
    // displaying 25 over a 30-row page is the select lying.
    const el = host();
    renderFooter(el, {
      total: 90, limit: 30, offset: 0, shown: 30,
      onPage: () => {}, onLimit: () => {},
    });
    const sel = el.querySelector('.yc-pager-size');
    expect(sel.value).toBe('30');
    expect(texts(sel, 'option')).toEqual(['25', '30', '50', '100', '200', '500']);
  });

  test('expand switch: id preserved for the caller, change hands back a boolean', () => {
    const el = host();
    const seen = [];
    renderFooter(el, {
      total: 10, limit: 50, offset: 0, shown: 10, onPage: () => {},
      expand: { label: 'Expand rows', checked: true, inputId: 'logExpandData',
                onChange: (v) => seen.push(v) },
    });
    const cb = el.querySelector('#logExpandData');
    expect(cb.checked).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new (el.ownerDocument.defaultView.Event)('change'));
    expect(seen).toEqual([false]);
  });

  test('export renders only when a handler exists, and calls it', () => {
    const el = host();
    let hits = 0;
    renderFooter(el, { total: 10, limit: 50, offset: 0, shown: 10, onPage: () => {} });
    expect(el.querySelector('.yc-pager-export')).toBeNull();
    renderFooter(el, {
      total: 10, limit: 50, offset: 0, shown: 10, onPage: () => {},
      onExport: () => { hits++; },
    });
    el.querySelector('.yc-pager-export').onclick();
    expect(hits).toBe(1);
  });
});
