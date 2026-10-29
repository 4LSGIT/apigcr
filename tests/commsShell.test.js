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
 * Since launcher-nits C4 More Features and Admin are the firm's pages
 * firm:more / firm:admin, no longer markup in the shell: their grids are the
 * firm's data, fenced here as the lists production got (tests/helpers/
 * hubPages.js, the C3 script's frozen copy) over the real registry.
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
const SHELL = require('./helpers/shellHtml');
const HTML = SHELL.expandedShellHtml();
const { registry: REG } = SHELL.loadLauncher();
const { hubPages } = require('./helpers/hubPages');
const PAGES = hubPages();
/** A page part's rows: its items split at the breaks, each by registry label. */
const rowsOf = (list) => list.reduce((rows, e) => { if (e.break) rows.push([]); else rows[rows.length - 1].push(e.item); return rows; }, [[]]);

/** The source text between two exact markers (inclusive of the first). */
function between(start, end) {
  const a = HTML.indexOf(start);
  const b = HTML.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${start.slice(0, 40)} … ${end.slice(0, 40)}`);
  return HTML.slice(a, b + end.length);
}
const noComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

describe('wiring: Comms is a sidebar tab, Settings lives in More Features (the firm page firm:more since C4)', () => {
  const sidebar = noComments(between('<nav id="appSidebar"', '</nav>'));

  test('sidebar: a Comms item (always shown — no wait on a fetch) opening tabComms, with its badge; no Settings item', () => {
    expect(sidebar).toMatch(/<div class="sb-item" id="sbComms" data-tab="tabComms" onclick="openMainTab\('tabComms'\)" title="Comms">/);
    expect(sidebar).toMatch(/<span class="sb-badge" id="sbCommsBadge" style="display:none"/);
    expect(sidebar).not.toMatch(/data-tab="tabSettings"/);
    // Comms sits in Records, between Tasks and Log
    expect(sidebar.indexOf('data-tab="tabTasks"')).toBeLessThan(sidebar.indexOf('data-tab="tabComms"'));
    expect(sidebar.indexOf('data-tab="tabComms"')).toBeLessThan(sidebar.indexOf('data-tab="tabLogs"'));
    // no hub item left: More Features is the firm page firm:more (C4), placed by the firm's sidebar
    expect(sidebar).not.toMatch(/tabMore|tabAdmin/);
  });

  test('the tab: one tab-main div whose own iframe lazy-loads /comms.html; the Admin pilot tile and panel are gone', () => {
    expect(HTML).toMatch(/<div id="tabComms" class="tab-main">\s*<iframe data-src="\/comms.html" title="Comms"><\/iframe>\s*<\/div>/);
    expect(HTML).not.toMatch(/commsDiv/);
    expect(HTML).not.toMatch(/id="tabAdmin"/);   // Admin is the firm page firm:admin (C4)
    const admin = rowsOf(PAGES['firm:admin'].tiles);
    expect(admin.flat().length).toBe(14); // 13 + Mailboxes (row 5, short by design)
    expect(admin[4]).toEqual(['adminMailboxes']);
    expect(REG.adminMailboxes.target).toBe('mailboxesDiv');
    expect(HTML).toMatch(/<div id="mailboxesDiv"/);   // its panel on the stage
    expect(admin.flat().filter((id) => /comms/i.test(id) || /comms/i.test(REG[id].target || ''))).toEqual([]);
  });

  test('Home: Comms took Settings\' button (always shown, like the sidebar item); Settings is still one click from the greeting', () => {
    const home = noComments(between('<div id="tabHome"', '<div class="home-search">'));
    expect(home).toMatch(/<button id="homeComms" class="home-btn" onclick="openMainTab\('tabComms'\)">/);
    expect(home).not.toMatch(/tabSettings/);
    expect(HTML).toMatch(/<span class="hdr-greeting" onclick="openMainTab\('tabSettings'\)"/);
    expect(HTML).toMatch(/<div id="tabSettings" class="tab-main">/);
  });

  test('More Features (firm:more): row 5 three since Get Clio Code left for the firm row (ui-custom S3.3b), Ask Casey alone in row 7 (YisrAI, 2026-10-19) — Settings in row 1 beside Theme, no mascot tile', () => {
    expect(HTML).not.toMatch(/id="tabMore"/);
    const ids = rowsOf(PAGES['firm:more'].tiles);
    const rows = ids.map((r) => r.map((id) => REG[id].label));
    expect(rows.map((r) => r.length)).toEqual([4, 4, 4, 4, 3, 4, 1]);
    expect(rows[0]).toEqual(['Manuals', 'Settings', 'Theme', 'Feature Requests']);
    expect(rows[4]).toEqual(['Availability Manager', 'Booking Manager', 'Court Preview']);
    expect(rows[6]).toEqual(['Ask Casey']);   // the assistant stands alone
    expect(ids.flat().filter((id) => /clio/i.test(id) || /Clio Code|showClioCode/.test(JSON.stringify(REG[id])))).toEqual([]);   // a firm tool now (ref/tools/clio-code.html)
    expect(REG.moreSettings.onclick).toBe("openMainTab('tabSettings')");
    expect(ids.flat()).not.toContain('casey');
    expect(ids.flat().filter((id) => REG[id].icon === 'cat' || REG[id].icon === 'paw')).toEqual([]);
  });

  test('Casey: a paw in firm:more\'s icon row under the grid (not a tile) runs the old tile\'s handler, and drill-in hides it', () => {
    expect(PAGES['firm:more'].icons).toEqual([{ item: 'casey' }]);
    expect(REG.casey).toMatchObject({ icon: 'paw', onclick: 'toggleMascot()' });
    expect(HTML).toMatch(/row\.className = 'page-egg-row';/);   // a page's icon row (makePage)
    expect(HTML).toMatch(/\.drill-active > \.page-egg-row \{ display:none; \}/);
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
        <div class="sb-item" id="sbMore" data-tab="ycPage-1"></div>
        <div class="sb-item" id="sbAlso" data-tab="tabX" data-tab-also="tabY tabSettings"></div>
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

  // More Features' row is a firm PAGE item since C4: it carries its page tab
  // (S6c-5). A registry item's tabAlso (data-tab-also) still lights a row on
  // the other tabs it names.
  test('the sidebar lights Comms on tabComms, More Features on its page tab, and a data-tab-also row on each tab it names', () => {
    const t = boot({ api: () => ({}) });
    const active = () => [...t.w.document.querySelectorAll('.sb-item.active')].map((e) => e.id);
    t.w.updateSidebarActive('tabComms');
    expect(active()).toEqual(['sbComms']);
    t.w.updateSidebarActive('ycPage-1');
    expect(active()).toEqual(['sbMore']);
    t.w.updateSidebarActive('tabSettings');
    expect(active()).toEqual(['sbAlso']);
    t.w.updateSidebarActive('tabX');
    expect(active()).toEqual(['sbAlso']);
  });
});
