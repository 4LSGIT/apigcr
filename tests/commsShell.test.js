// tests/commsShell.test.js
//
/**
 * Comms in the shell (public/index.html) — mailbox arc S2 follow-up,
 * 2026-10-11: the comms hub leaves its Admin pilot tile for a first-class
 * tab with a sidebar item (unread badge) and a Home button, in the place
 * Settings had; Settings moves to More Features (row 1, beside Theme), Get
 * Clio Code to the cat's old slot, and Casey keeps its way in through a paw
 * under the grid.
 *
 * Same approach as tests/unifiedEventsU9.shell.test.js — a fence, not a full
 * boot (the shell is not a self-contained document): the WIRING the shell
 * needs to agree on across ~3,000 lines (sidebar item ↔ tab-main div ↔
 * opener; the grids' full-rows rule), plus the badge functions themselves,
 * extracted from the page and RUN in jsdom against a stub apiSend.
 * The real shell is exercised by the mobile survey and the Chrome shots.
 *
 * Mutation-checked: badge shown with zero mailboxes / hidden on a failed
 * fetch / total miscounted; the 5-minute refresh ignoring visibility;
 * updateSidebarActive dropping data-tab-also; a Settings sidebar item left
 * behind; the Admin comms tile left behind; a 7th More row.
 *
 * Run:  npx jest tests/commsShell.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// The shell as the parser sees it: the launcher markup (sidebar items, Home
// tiles, the More/Admin grids) is rendered from public/js/featureRegistry.js
// at parse time since ui-custom S1 — see tests/helpers/shellHtml.js.
const HTML = require('./helpers/shellHtml').expandedShellHtml();

/** The source text between two exact markers (inclusive of the first). */
function between(start, end) {
  const a = HTML.indexOf(start);
  const b = HTML.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${start.slice(0, 40)} … ${end.slice(0, 40)}`);
  return HTML.slice(a, b + end.length);
}
const noComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

describe('wiring: Comms is a sidebar tab, Settings lives in More Features', () => {
  const sidebar = noComments(between('<nav id="appSidebar"', '</nav>'));

  test('sidebar: a Comms item (always shown — no wait on a fetch) opening tabComms, with its badge; no Settings item', () => {
    expect(sidebar).toMatch(/<div class="sb-item" id="sbComms" data-tab="tabComms" onclick="openMainTab\('tabComms'\)" title="Comms">/);
    expect(sidebar).toMatch(/<span class="sb-badge" id="sbCommsBadge" style="display:none"/);
    expect(sidebar).not.toMatch(/data-tab="tabSettings"/);
    // Comms sits in Records, between Tasks and Log
    expect(sidebar.indexOf('data-tab="tabTasks"')).toBeLessThan(sidebar.indexOf('data-tab="tabComms"'));
    expect(sidebar.indexOf('data-tab="tabComms"')).toBeLessThan(sidebar.indexOf('data-tab="tabLogs"'));
    expect(sidebar).toMatch(/<div class="sb-item" data-tab="tabMore" data-tab-also="tabSettings" onclick="openMainTab\('tabMore'\)"/);
  });

  test('the tab: one tab-main div whose own iframe lazy-loads /comms.html; the Admin pilot tile and panel are gone', () => {
    expect(HTML).toMatch(/<div id="tabComms" class="tab-main">\s*<iframe data-src="\/comms.html" title="Comms"><\/iframe>\s*<\/div>/);
    expect(HTML).not.toMatch(/commsDiv/);
    const admin = noComments(between('<div id="tabAdmin"', '<div id="sequencesDiv"'));
    expect((admin.match(/class="big-button"/g) || []).length).toBe(14); // 13 + Mailboxes (row 5, short by design)
    expect(admin).toMatch(/data-target="mailboxesDiv"/);
  });

  test('Home: Comms took Settings\' button (always shown, like the sidebar item); Settings is still one click from the greeting', () => {
    const home = noComments(between('<div id="tabHome"', '<div class="home-search">'));
    expect(home).toMatch(/<button id="homeComms" class="home-btn" onclick="openMainTab\('tabComms'\)">/);
    expect(home).not.toMatch(/tabSettings/);
    expect(HTML).toMatch(/<span class="hdr-greeting" onclick="openMainTab\('tabSettings'\)"/);
    expect(HTML).toMatch(/<div id="tabSettings" class="tab-main">/);
  });

  test('More Features: row 5 three since Get Clio Code left for the firm row (ui-custom S3.3b), Ask Casey alone in row 7 (YisrAI, 2026-10-19) — Settings in row 1 beside Theme, no mascot tile', () => {
    const grid = noComments(between('<div id="tabMore" class="tab-main yc-hub">', '<div class="more-egg-row">'));
    const rows = grid.split(/\n\s*<br><br>\s*\n/).map((r) => (r.match(/<button class="big-button"[^>]*>[\s\S]*?<\/button>/g) || []).map((b) => b.replace(/<[^>]+>/g, '').trim()));
    expect(rows.map((r) => r.length)).toEqual([4, 4, 4, 4, 3, 4, 1]);
    expect(rows[0]).toEqual(['Manuals', 'Settings', 'Theme', 'Feature Requests']);
    expect(rows[4]).toEqual(['Availability Manager', 'Booking Manager', 'Court Preview']);
    expect(rows[6]).toEqual(['Ask Casey']);   // the assistant stands alone (featureRegistry DEFAULT_LAYOUTS.more)
    expect(grid).not.toMatch(/Get Clio Code|showClioCode/);   // a firm tool now (ref/tools/clio-code.html)
    expect(grid).toMatch(/<button class="big-button" onclick="openMainTab\('tabSettings'\)"/);
    expect(grid).not.toMatch(/fa-cat/);
  });

  test('Casey: a paw under the grid (not a tile) runs the old tile\'s handler, and drill-in hides it', () => {
    expect(HTML).toMatch(/<div class="more-egg-row"><button type="button" class="more-egg" onclick="toggleMascot\(\)" title="Casey the YisraCat"/);
    expect(HTML).toMatch(/\.drill-active > \.more-egg-row \{ display:none; \}/);
    expect(HTML).toMatch(/function toggleMascot\(\)/);
  });
});

describe('the badge and the active item, run for real', () => {
  const BADGE_SRC = between('    function commsBadgeSet(total) {', '    }, 5 * 60 * 1000);');
  const ACTIVE_SRC = (() => {
    const a = HTML.indexOf('    function updateSidebarActive(tabName) {');
    const b = HTML.indexOf('\n    }\n', a);
    if (a < 0 || b < 0) throw new Error('updateSidebarActive not found');
    return HTML.slice(a, b + 6);
  })();

  function boot({ api, signedIn = true } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><body>
      <nav id="appSidebar">
        <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div>
        <div class="sb-item" id="sbComms" data-tab="tabComms"><span class="sb-badge" id="sbCommsBadge" style="display:none">0</span></div>
        <div class="sb-item" id="sbMore" data-tab="tabMore" data-tab-also="tabSettings"></div>
      </nav>
      <button id="homeComms"></button></body>`, { runScripts: 'outside-only' });
    const w = dom.window;
    const calls = [];
    const intervals = [];
    w.eval(`var E = (id) => document.getElementById(id); var user = ${signedIn ? '{ user: 5 }' : 'null'};`);
    w.apiSend = async (url, method) => { calls.push([method, url]); return api(url); };
    w.setInterval = (fn, ms) => { intervals.push([fn, ms]); return 1; };
    w.eval(BADGE_SRC + '\n' + ACTIVE_SRC + '\nwindow.updateSidebarActive = updateSidebarActive;');
    const shown = (id) => w.document.getElementById(id).style.display !== 'none';
    return { w, calls, intervals, shown, badge: () => w.document.getElementById('sbCommsBadge') };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test('readable mailboxes → badge = INBOX unread over them; the entry + Home button stay shown', async () => {
    const t = boot({ api: () => ({ mailboxes: [{ inbox_unread: 3 }, { inbox_unread: '4' }, {}] }) });
    await t.w.commsBadgeRefresh();
    expect(t.calls).toEqual([['GET', '/api/mail/mailboxes']]);
    expect([t.shown('sbComms'), t.shown('homeComms'), t.shown('sbCommsBadge'), t.badge().textContent]).toEqual([true, true, true, '7']);
    // all read: entry stays, badge goes
    t.w.commsBadgeSet(0);
    expect([t.shown('sbComms'), t.shown('sbCommsBadge')]).toEqual([true, false]);
  });

  test('S3-R: an alias box next to its readable parent adds nothing to the badge (the hub\'s All mail is the parent\'s Inbox); alone it counts', async () => {
    const t = boot({ api: () => ({ mailboxes: [
      { id: 2, alias_of: null, inbox_unread: 2 },
      { id: 7, alias_of: 2, inbox_unread: 5 },     // it@ — a slice of box 2, which this reader reads
      { id: 8, alias_of: 99, inbox_unread: 1 },    // an alias of a box this reader does not read
    ] }) });
    await t.w.commsBadgeRefresh();
    expect(t.badge().textContent).toBe('3');
  });

  test('no mailbox shared → the entries stay (the hub says nothing is shared), no badge; a failed fetch clears a stale badge', async () => {
    const none = boot({ api: () => ({ mailboxes: [], viewer: { su: false, role: null, can_send: false } }) });
    await none.w.commsBadgeRefresh();
    expect([none.shown('sbComms'), none.shown('homeComms'), none.shown('sbCommsBadge')]).toEqual([true, true, false]);
    const down = boot({ api: () => { throw new Error('502'); } });
    down.w.commsBadgeSet(5);
    expect(down.shown('sbCommsBadge')).toBe(true);
    await down.w.commsBadgeRefresh();
    expect([down.shown('sbComms'), down.shown('homeComms'), down.shown('sbCommsBadge')]).toEqual([true, true, false]);
  });

  test('signed out → no fetch; the 5-minute refresh runs only while the page is visible', async () => {
    const out = boot({ api: () => ({ mailboxes: [{ inbox_unread: 1 }] }), signedIn: false });
    await out.w.commsBadgeRefresh();
    expect(out.calls).toEqual([]);
    const t = boot({ api: () => ({ mailboxes: [{ inbox_unread: 1 }] }) });
    expect(t.intervals.map(([, ms]) => ms)).toEqual([300000]);
    Object.defineProperty(t.w.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    t.intervals[0][0]();
    await tick();
    expect(t.calls).toEqual([]);
    Object.defineProperty(t.w.document, 'visibilityState', { configurable: true, get: () => 'visible' });
    t.intervals[0][0]();
    await tick();
    expect(t.calls).toEqual([['GET', '/api/mail/mailboxes']]);
  });

  test('the sidebar lights Comms on tabComms, and More Features while you are in Settings (data-tab-also)', () => {
    const t = boot({ api: () => ({}) });
    const active = () => [...t.w.document.querySelectorAll('.sb-item.active')].map((e) => e.id);
    t.w.updateSidebarActive('tabComms');
    expect(active()).toEqual(['sbComms']);
    t.w.updateSidebarActive('tabSettings');
    expect(active()).toEqual(['sbMore']);
    t.w.updateSidebarActive('tabMore');
    expect(active()).toEqual(['sbMore']);
  });
});
