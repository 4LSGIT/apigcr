// tests/apptsPicker.pager.test.js
//
/**
 * apptform2.html — pkPageWindow(), the picker pager's page-number window.
 *
 * Pure function, so it is lifted out of the page's inline script and run
 * directly rather than driven through a browser. What is worth pinning:
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
 *               page is its own button; from 8 up a gap is unavoidable, since
 *               the window spans at most 2*span+1 consecutive pages plus the
 *               first and last.
 *
 * Run:  npx jest tests/apptsPicker.pager.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'apptform2.html'), 'utf8');

/**
 * Lift one top-level `function name(...) {...}` out of the page source. Relies
 * on the file's own formatting — a top-level function closes with a `}` in
 * column 0 — which is the same assumption tests/unifiedEventsU9.shell.test.js
 * makes when it slices inline script blocks by their banners.
 */
function lift(name) {
  const start = HTML.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = HTML.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  // eslint-disable-next-line no-new-func
  return new Function(`${HTML.slice(start, end + 2)}; return ${name};`)();
}

const pkPageWindow = lift('pkPageWindow');

/** Render a window the way the footer reads: numbers 1-based, gaps as '…'. */
const shape = (cur, pages, span) =>
  pkPageWindow(cur, pages, span).map((p) => (typeof p === 'object' ? '…' : String(p + 1)));

describe('shape', () => {
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
        const nums = pkPageWindow(cur, pages).filter((p) => typeof p === 'number');
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
    const [, , , gap] = pkPageWindow(0, 90);
    expect(gap).toEqual({ from: 3, to: 88 });
  });

  test('both gaps are ranged independently when the window sits in the middle', () => {
    const gaps = pkPageWindow(44, 90).filter((p) => typeof p === 'object');
    expect(gaps).toEqual([{ from: 1, to: 41 }, { from: 47, to: 88 }]);
  });

  test('no gap is empty, and together with the numbers they cover every page once', () => {
    for (let pages = 1; pages <= 60; pages++) {
      for (let cur = 0; cur < pages; cur++) {
        const seen = [];
        pkPageWindow(cur, pages).forEach((p) => {
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
    pkPageWindow(cur, pages, span).some((p) => typeof p === 'object');

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
        pkPageWindow(cur, pages)
          .filter((p) => typeof p === 'object')
          .forEach((g) => expect(g.to - g.from).toBeGreaterThanOrEqual(1));
      }
    }
  });
});
