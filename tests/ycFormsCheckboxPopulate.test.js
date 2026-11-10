/**
 * yc-forms populate() — a checkbox given false / 0 / '0' / 'false' must read
 * UNTICKED (2026-11-11, Fred's go).
 *
 * The bug: populate() ran every value through _formatForDisplay, which
 * returns String(value) for a checkbox, then set `el.checked = !!value` —
 * so false became 'false' and 0 became '0', both non-empty strings, both
 * ticked. A draft's Restore therefore ticked every box the draft had left
 * unticked, and the next Save submitted true; a snapshot form, the read-only
 * submission view and a checkbox bound to a 0 column showed the same. The
 * repeater branch read the raw value but through `!!`, so '0' and 'false'
 * (strings a draft or a query string can carry) ticked there too.
 *
 * The fix: YCForm.checkboxOn(value) decides from the RAW value — true / 1 /
 * '1' / 'true' / 'on' / 'yes' tick; false / 0 / '0' / 'false' / '' / null /
 * undefined do not — and both populate branches use it before any display
 * formatting.
 *
 * Harness: the real public/js/yc-forms.js evaluated in a bare jsdom window
 * (it only assigns window.YCForm at load), the static helper called
 * directly, and populate() driven on an object carrying the prototype with
 * the minimum state it reads (el, config, a no-op resetBaseline) — no
 * network, no render page.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/yc-forms.js'), 'utf8');

function boot(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only' });
  dom.window.eval(SRC);
  return dom;
}

const TICK = [true, 1, '1', 'true', 'TRUE', ' on ', 'yes'];
const UNTICK = [false, 0, '0', 'false', 'False', '', null, undefined, 'off', 'no'];

describe('YCForm.checkboxOn', () => {
  const dom = boot('');
  afterAll(() => dom.window.close());

  test('ticks for true / 1 / "1" / "true" / "on" / "yes" and nothing else', () => {
    const { YCForm } = dom.window;
    for (const v of TICK) expect([v, YCForm.checkboxOn(v)]).toEqual([v, true]);
    for (const v of UNTICK) expect([v, YCForm.checkboxOn(v)]).toEqual([v, false]);
  });
});

describe('populate() on a checkbox', () => {
  function form(dom) {
    const { YCForm } = dom.window;
    const f = Object.create(YCForm.prototype);
    f.el = dom.window.document.getElementById('f');
    f.config = {
      fields: {
        flag: { el: '[name="flag"]', type: 'checkbox' },
        note: { el: '[name="note"]', type: 'text' },
      },
      repeaters: {},
    };
    f.resetBaseline = () => {};
    return f;
  }

  test('false, 0, "0" and "false" read UNTICKED; true, 1, "1" and "true" read ticked; the text field still formats', () => {
    const dom = boot('<form id="f"><input type="checkbox" name="flag"><input type="text" name="note"></form>');
    try {
      const f = form(dom);
      const box = () => dom.window.document.querySelector('[name="flag"]').checked;
      for (const v of UNTICK) {
        dom.window.document.querySelector('[name="flag"]').checked = true; // start ticked: the bug left it so
        f.populate({ flag: v, note: 'x' });
        expect([v, box()]).toEqual([v, false]);
      }
      for (const v of TICK) {
        f.populate({ flag: v, note: 'x' });
        expect([v, box()]).toEqual([v, true]);
      }
      expect(dom.window.document.querySelector('[name="note"]').value).toBe('x');
    } finally { dom.window.close(); }
  });

  // populate() looks as if it accepts JSON text (`typeof data === 'string' ?
  // JSON.parse(data)`), but its first line replaces any non-object — a string
  // included — with {}, so that parse never runs: a stringified draft
  // populates NOTHING. Found while writing this test (2026-11-11); no caller
  // passes a string today, so it is left as is and pinned here so a future
  // caller learns it from a test, not from an empty form.
  test('populate() given JSON text populates nothing (the parse line is unreachable) — pinned, not fixed', () => {
    const dom = boot('<form id="f"><input type="checkbox" name="flag"><input type="text" name="note" value="keep"></form>');
    try {
      const f = form(dom);
      f.populate(JSON.stringify({ flag: true, note: 'x' }));
      expect(dom.window.document.querySelector('[name="flag"]').checked).toBe(false);
      expect(dom.window.document.querySelector('[name="note"]').value).toBe('');
    } finally { dom.window.close(); }
  });

  test('a checkbox never goes through _formatForDisplay (a mask or date rule cannot touch it)', () => {
    const dom = boot('<form id="f"><input type="checkbox" name="flag"></form>');
    try {
      const f = form(dom);
      f._formatForDisplay = () => { throw new Error('formatted a checkbox'); };
      f.populate({ flag: false });
      expect(dom.window.document.querySelector('[name="flag"]').checked).toBe(false);
    } finally { dom.window.close(); }
  });
});

describe('the repeater branch', () => {
  test('_addRepeaterItemWithData reads a checkbox through checkboxOn (source pin — the branch is 8 lines inside a 100-line builder)', () => {
    expect(SRC).toContain("input.checked = YCForm.checkboxOn(data[fName]);");
    expect(SRC).not.toMatch(/input\.checked = !!data\[fName\];/);
    expect(SRC).not.toMatch(/el\.checked = !!value;/);
  });
});
