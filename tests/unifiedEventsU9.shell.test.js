// tests/unifiedEventsU9.shell.test.js
//
/**
 * Unified Events U9 — the shell's Calendar tab (public/index.html).
 *
 * WHY A FENCE AND NOT A FULL BOOT
 *
 * index.html is 5,000 lines and boots against auth, firmData, a sync bus and a
 * dozen iframes. tasksUi.boot.test.js and pipelineBoardUi.sync.test.js boot
 * SUB-PAGES for real because a sub-page is a self-contained document; the shell
 * is not, and a harness that stubbed enough of it to run would be testing the
 * harness. So this file does two cheaper things that catch the failures that
 * actually happen to this file:
 *
 *   1. SYNTAX. The tab is ~300 lines of inline script inside a 5,000-line HTML
 *      document. A stray brace does not fail a build here — there is no build.
 *      It fails at runtime, in the browser, as a WHITE SHELL: the block throws
 *      at parse, every function declared in it is gone, and so is every one in
 *      the blocks after it. `node --check` on each extracted block is the
 *      cheapest possible guard against shipping that.
 *
 *   2. WIRING. The tab is reachable only if the sidebar item, the tab-main div
 *      and the opener agree on one id. Those three live ~600 lines apart, and a
 *      rename that updates two of them leaves a sidebar button that does
 *      nothing — silently, because openMainTab() on a missing id throws inside
 *      an onclick and never reaches a user.
 *
 * The RENDERING is not asserted here; it is asserted where it is decided, in
 * tests/unifiedEventsU9.range.test.js, against the service that produces every
 * field the tab prints.
 *
 * Run:  npx jest tests/unifiedEventsU9.shell.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os   = require('os');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/**
 * Inline <script> bodies, in document order.
 *
 * The `(?![^>]*\bsrc=)` guard skips the loader tags. One "block" this returns
 * is not JS at all: an HTML COMMENT in the head contains the literal text
 * "<script>" while explaining how to disable a block, and no regex that does
 * not parse HTML can tell that from a real tag. It is filtered by shape below
 * rather than by index, so inserting or removing a block cannot silently point
 * the filter at the wrong one.
 */
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** A comment-fragment "block" opens with prose and a `-->`, not with code. */
const isRealScript = (body) => !/^[\s\S]{0,400}?-->/.test(body);

describe('index.html — every inline script block parses', () => {
  const blocks = inlineScripts(HTML).filter(isRealScript);

  test('there are blocks to check, and the filter did not eat them all', () => {
    expect(blocks.length).toBeGreaterThan(5);
  });

  test.each(blocks.map((b, i) => [i, b]))('block %i is syntactically valid JS', (i, body) => {
    const f = path.join(os.tmpdir(), `ycshell_${process.pid}_${i}.js`);
    fs.writeFileSync(f, body);
    try {
      // `node --check` and not `new Function`: the latter accepts a `return`
      // at top level and rejects nothing else these blocks could contain, so
      // it would pass code the browser refuses to parse.
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } finally {
      fs.unlinkSync(f);
    }
  });
});

describe('Calendar tab wiring (U9)', () => {
  test('the sidebar item, the tab-main div and the opener agree on tabCalendar', () => {
    expect(HTML).toMatch(/<div class="sb-item" data-tab="tabCalendar" onclick="openCalendarTab\(\)"/);
    expect(HTML).toMatch(/<div id="tabCalendar" class="tab-main">/);
    expect(HTML).toMatch(/function openCalendarTab\(\)/);
    expect(HTML).toMatch(/openMainTab\('tabCalendar'\)/);
  });

  test('it sits BETWEEN Appointments and Events in the sidebar', () => {
    // Position is the slice's own statement about what the tab is: a third
    // list beside the two it unifies, for one release, so the new answer can
    // be checked against the old two.
    const at = (t) => HTML.indexOf(`data-tab="${t}"`);
    expect(at('tabAppts')).toBeLessThan(at('tabCalendar'));
    expect(at('tabCalendar')).toBeLessThan(at('tabEvents'));
  });

  test('its icon is distinct from both neighbours', () => {
    const icon = (tab) => {
      const i = HTML.indexOf(`data-tab="${tab}"`);
      return (HTML.slice(i, i + 400).match(/fa-solid (fa-[a-z-]+)/) || [])[1];
    };
    const cal = icon('tabCalendar');
    expect(cal).toBeTruthy();
    expect(cal).not.toBe(icon('tabAppts'));
    expect(cal).not.toBe(icon('tabEvents'));
  });

  test('THE OLD TABS ARE UNTOUCHED — U9 adds a third list, it does not retire two', () => {
    // Explicitly out of scope for this slice (U9b owns the retirement). If a
    // later edit deletes one of these, this test is where that decision has to
    // be made on purpose rather than as a side effect.
    expect(HTML).toMatch(/<div id="tabAppts" class="tab-main">/);
    expect(HTML).toMatch(/<div id="tabEvents" class="tab-main">/);
    expect(HTML).toMatch(/function openApptsTab\(\)/);
    expect(HTML).toMatch(/function openEventsTab\(\)/);
  });
});

describe('Calendar tab contract with the rest of the shell', () => {
  /** The tab's own script block, found by its banner rather than by index. */
  const block = inlineScripts(HTML).find((b) => b.includes('CALENDAR TAB — Unified Events U9'));

  test('the block exists and is the only one claiming that banner', () => {
    expect(block).toBeDefined();
    expect(inlineScripts(HTML).filter((b) => b.includes('CALENDAR TAB — Unified Events U9'))).toHaveLength(1);
  });

  test('it reads the unified range endpoint and nothing else', () => {
    // If this tab ever starts calling /api/events or /api/appts directly it
    // has stopped being the unified list and become a third bespoke one.
    expect(block).toContain(`apiSend('/api/calendar-range', 'GET', params)`);
    expect(block).not.toMatch(/apiSend\(['"]\/api\/(events|appts)/);
  });

  test('it opens rows through the shell openers, not through its own iframes', () => {
    // One way to open an appointment, one way to open an event, application
    // wide. A private Swal here would be a second one that drifts.
    expect(block).toContain('showAppt(r.source_id)');
    expect(block).toContain('showEvent(r.source_id)');
    expect(block).not.toContain('apptform2.html');
    expect(block).not.toContain('eventform.html');
  });

  test('it asks for the labels and attendees it renders', () => {
    // The anchor and With columns are rendered from `display` and
    // `attendees[]`, both of which are OPT-IN on the read layer. Forgetting a
    // flag renders a column of em-dashes rather than an error.
    expect(block).toMatch(/include_labels:\s*1/);
    expect(block).toMatch(/include_attendees:\s*1/);
  });

  test('it is a READER: it subscribes to the bus and emits nothing', () => {
    // §3.6 — a reader that emits is an infinite loop.
    expect(block).toMatch(/\['event:\*',\s*'appt:\*'\]/);
    expect(block).toContain('YC.on(topic');
    expect(block).not.toMatch(/YC\.emit/);
  });

  test('it defaults to today → +30d', () => {
    expect(block).toMatch(/calxSetRange\(30\);/);
  });

  test('every identifier it declares AT TOP LEVEL is calx/openCalendarTab-prefixed', () => {
    // The block shares one global scope with 5,000 lines of shell. `limit`,
    // `offsets`, `events` and `appts` are all live shell globals up there; a
    // bare `let limit` here would silently repoint the OTHER tabs' pagination.
    //
    // TOP LEVEL ONLY. A `const row` inside a render loop is scoped to that
    // function and collides with nothing, so demanding a prefix there would be
    // a naming rule dressed up as a safety rule. The base indentation is
    // derived from the block rather than hard-coded, so re-indenting the file
    // cannot turn this test into a no-op that silently passes everything.
    const decls = [...block.matchAll(/^([ \t]*)(?:let|const|var|(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => ({ indent: m[1].length, name: m[2] }));
    expect(decls.length).toBeGreaterThan(8);

    const base = Math.min(...decls.map((d) => d.indent));
    const topLevel = decls.filter((d) => d.indent === base).map((d) => d.name);
    expect(topLevel).toContain('openCalendarTab');
    expect(topLevel.length).toBeGreaterThan(8);

    const stray = topLevel.filter((n) => !/^(calx|CALX_|openCalendarTab$)/.test(n));
    expect(stray).toEqual([]);
  });
});
