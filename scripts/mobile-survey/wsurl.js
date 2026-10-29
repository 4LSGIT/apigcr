#!/usr/bin/env node
// scripts/mobile-survey/wsurl.js — real-browser round trips for the
// workspace URL's sub-state (wsurl S1a).
//
// Boots the REAL shell (public/index.html) on the mobile-survey mock server
// (server.js start(): no DB, no auth, synthetic fixtures) in headless Chrome,
// one viewport, and ASSERTS — never just prints — that:
//
//   (2)  ?files=c<id>~documents&open=file:0 settles to the same URL, and a
//        reload settles there again
//   (3s) a 3-segment rest round-trips in ?files= (a bill: no frame, no
//        reporter) and in ?open= (tabTasks: no leaf); (3c) a case's converges
//        on its own segment
//   (7)  a report from a HIDDEN file's frame changes nothing in the URL, and
//        shows once that file is activated
//   (8)  a report from a frame inside a Swal is ignored
//   (9)  injection / over-long / over-deep rests are rejected (by report and
//        by URL): the URL is unchanged and the file is kept
//   (10) non-SU: ?open=firm:admin, the old tabAdmin / tabAdmin~x and a
//        random element id land on Home; SU: firm:admin (and the old tabAdmin,
//        an alias since launcher-nits C2) opens the Admin page; non-SU
//        firm:more / tabMore opens More Features
//   (11) ?open=tabCases~x calls the Cases opener exactly once (one GET
//        /api/cases), and drops the rest (tabCases has no pane to read it)
//   (13) after a report, ycReloadUrl() === location.href
//
// S1b — the case / contact pages own their inner tab (real case.html on
// fixture TESTCASE1, contact.html on 9001, inside the real shell):
//   (b1) a tab click → the file's token is exactly c<id>~<tok> / p<id>~<tok>
//   (b2) a reload restores that tab, and the URL settles unchanged
//   (b3) EVERY on-screen [data-ws-tab] of both pages, enumerated from the
//        DOM: click → URL → reload → the same tab is shown
//   (b4) ~bogus: no "Error loading …" toast, the default tab, the type row on
//        screen, the log fetched, and the URL settles on c<id> (contact too)
//   (b5) legacy ?case=<id>,documents opens Documents; ~ISSN on a NON-BK case
//        (TESTCASE1 is Bankruptcy, so /api/cases/TESTCASE1 is rewritten to
//        another type for that run) falls back to Overview; on BK it restores
//   (b6) the shell's dedup refocus with a new tab switches the tab AND the
//        file's token follows, through the page's own ycApplySubTab + report
//   (b7) a case boot that throws AFTER its tab strip is up (dropins.js
//        blocked, a case with case_dropbox: loadIframes' Dropbox.embed
//        throws) still shows the restored tab, and the URL settles
//
// S2 — the open More Features / Admin drill panel is in the URL (registry
// ids). Since launcher-nits C4 both are FIRM PAGES (#ycPages, firm:more /
// firm:admin — the fixture's, as production's since C3), so the heads are
// their item ids; their tab ids are per session and resolved from the DOM:
//   (d1) SU: drill into a More panel → firm:more~<id>; a reload reopens it (its
//        pane loaded ONCE); switching panels moves the id; the All pill → firm:more
//   (d2) Admin as SU round-trips; non-SU firm:admin~<id> → Home, pane never loaded
//   (d3) refusals → the grid, no dialog: denied, firm-hidden, an action tile
//        (moreSettings, a tab switch; SU: adminEtch, a Swal), newClient (no
//        More tile), firm:x, a bogus id
//   (d4) a panel's pane: a synthetic report → firm:more~<id>~<rest>; from the
//        same frame while another tab is active → no URL change
//   (d5) ?manual= + ?open=firm:more~<id> → the manual wins
//   (d6) old links (C2 aliases): tabMore~<id>~<rest> / tabAdmin~<id> open the
//        page with that panel and the URL settles on firm:more~… / firm:admin~…
//
// S5c-a — the manager panes own their sub-tab (real automationManager.html
// and caseConfigManager.html in their drill panels):
//   (a1) Automations: a Triggers click → open=firm:more~moreAutomations~triggers
//   (a2) …a reload shows Triggers, URL unchanged, the pane loaded ONCE
//   (a3) the same URL in a FRESH context → Triggers
//   (a4) ~bogus → Workflows, the URL settles on firm:more~moreAutomations
//   (a5) Config: ~pipelines round-trips a reload; ~firm (gated, revealed by
//        the mock's can_edit_firm) → Firm, URL unchanged
//
// S6c-4 — the panel stage (#ycPanels; page-scoped drill, per-page memory):
//   (s1) SU: the firm-placed Users tile on More opens Users IN PLACE →
//        open=firm:more~adminUsers; the panel is the stage's child; a reload
//        reopens it on MORE (exec told the page)
//   (s2) Admin shows its own grid (per-page memory), drilling it shows ONE
//        stage panel, back on More shows Users again, Cases hides the stage
//   (s3) THE NO-RELOAD PROOF: text typed into Automations' pane survives
//        Cases → Admin (DB Console) → More → Manuals → Automations; the
//        frame's performance.timeOrigin is unchanged; the pane loaded ONCE
//   (s4) non-SU firm:more~adminUsers → the More grid, no tile, empty stage
//
// S6c-5 — pages (#ycPages: the firm's and the user's own page tabs):
//   (p1) SU: exec('user:my-desk') opens the user's page tab (a .tab-main.yc-hub
//        carrying data-yc-page), its sidebar neutral lit; the URL carries NO
//        open= there; a reload lands on Home (Fred's ruling Q4, v1)
//   (p2) a panel tile on the page opens the panel IN PLACE (page drilled, one
//        stage panel, URL still without open=); the strip shows exactly the
//        page's tiles' pills; the SAME Automations iframe is seen from More
//        and from the page: text typed into its pane survives page → More →
//        Cases → page, performance.timeOrigin unchanged, loaded ONCE
//   (p3) ?open=<the page's tab id> → Home (never a restorable head)
//   (p4) the firm page firm:ops (visible_to it, admin): present for SU — a tab,
//        a tile on More, exec opens it; GONE for staff — no tab, no tile, exec
//        refuses, not in the effective registry
//   (p5) staff: the user page shows no su tile (adminUsers, adminDbConsole)
//        and its strip has no pill for them
//   (pt1) launcher-nits C1: a panel no page shows (the fixture's adminScratch: off
//        Admin, on no page) opens on the PANEL TAB, headed with its name, the
//        URL reading tabPanel~adminScratch; a reload brings it back there
//   (p6) launcher-nits L4a: a FIRM page IS named — exec('firm:ops') writes
//        ?open=firm:ops, a panel opened on it firm:ops~<its id>, and a reload
//        comes back to that page with that panel open on it; ?open=firm:nope
//        → Home; staff (firm:ops is not theirs) ?open=firm:ops → Home
//
// S-links — the links the server emits (lib/shellLinks), opened cold:
//   (L1) /?files=c<id>&open=file:0 in a FRESH context (no label cache), the
//        search answering the exact row → the case file opens, URL settles
//   (L2) the same for /?files=p<id>&open=file:0 → the contact file
//   (L3) the search answering a DIFFERENT id → "could not be reopened", no file
//
// S3 — comms.html owns its tab (email / phone / team):
//   (c1) a Phone click → ?open=tabComms~phone; (c2) a reload shows Phone,
//        URL unchanged; (c3) an Email click → ?open=tabComms
//   (c4) ?open=tabComms~bogus → Email, the URL settles on tabComms
//   (c5) ?open=tabComms~team → Team
//   (c6) a report from comms' frame while another tab is active changes
//        nothing in the URL, and shows once Comms is back
//
// The mock's /api/search answers nothing, so every scenario seeds the
// sessionStorage label cache (ycFileLabels) the way a same-tab reload would
// find it. Roles: /api/firm-data is intercepted and currentUser.roles
// rewritten (su in it or not) — loadUserContext's isAdmin reads exactly that.
//
// Exits 1 on any failure, with one GO / NO-GO line. Run it ONLY through the
// machine's heavy-gate browser slot:
//   bash local/heavy-gate.sh browser "<who>: wsurl harness" -- node scripts/mobile-survey/wsurl.js
// Do not edit files under public/ while it runs: the server reads them live.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { start, fakeJwt } = require('./server');

const FIRM_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'firm-data.json'), 'utf8'));
const CASE = 'TESTCASE1';      // fixtures/api/cases/TESTCASE1.json
const CONTACT = '9001';        // fixtures/api/contacts/9001.json

function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
  ].filter(Boolean);
  const hit = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (!hit) {
    console.error('No Chrome found. Set PUPPETEER_EXECUTABLE_PATH. Looked at:\n  ' + candidates.join('\n  '));
    process.exit(2);
  }
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  — ' + detail}`);
}

/** The query as a plain object (decoded), for exact comparison. */
const q = (href) => Object.fromEntries(new URL(href).searchParams);

/**
 * A fresh, isolated tab booted at `query`, with the label cache seeded and the
 * user's roles set. Resolves once boot has handed the bar to syncWorkspaceUrl
 * and the frames have had a moment to load.
 */
async function boot(browser, base, query, { su = true, labels = {}, caseType = null, casePatch = null, search = null, blockHosts = [], firmPatch = null } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
  const hits = { casesList: 0, log: 0, automationManager: 0, dbConsole: 0 };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/cases' && req.method() === 'GET') hits.casesList++;
    if (u.pathname === '/api/log' && req.method() === 'GET') hits.log++;
    if (u.pathname === '/automationManager.html') hits.automationManager++;
    if (u.pathname === '/dbConsole.html') hits.dbConsole++;
    if (blockHosts.includes(u.hostname)) return req.abort('blockedbyclient');
    if ((caseType || casePatch) && u.pathname === `/api/cases/${CASE}` && req.method() === 'GET') {
      const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'api', 'cases', CASE + '.json'), 'utf8'));
      if (caseType) fx.case.case_type = caseType;
      Object.assign(fx.case, casePatch || {});
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fx) });
    }
    if (search && u.pathname === '/api/search') {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: search }) });
    }
    if (u.pathname === '/api/firm-data') {
      const fd = JSON.parse(JSON.stringify(FIRM_DATA));
      fd.currentUser.roles = su ? 'it,admin,form_dev,su' : 'staff';
      Object.assign(fd, firmPatch || {});
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fd) });
    }
    return req.continue();
  });
  await page.evaluateOnNewDocument((jwt, lab) => {
    try { localStorage.setItem('jwt', jwt); } catch (_) { }
    // MERGE, never replace: this runs again on every reload, and the shell
    // rewrites the cache itself on each sync — clobbering that entry would
    // leave the reloaded token uncached (the mock search answers nothing).
    try {
      const cur = JSON.parse(sessionStorage.getItem('ycFileLabels') || '{}') || {};
      sessionStorage.setItem('ycFileLabels', JSON.stringify(Object.assign({}, lab, cur)));
    } catch (_) { }
  }, fakeJwt(), labels);
  await page.goto(base + '/' + query, { waitUntil: 'networkidle2' });
  await settle(page);
  return { page, ctx, errors, hits };
}

async function settle(page) {
  await page.waitForFunction(
    () => window.firmData && document.getElementById('appSidebar').style.display === 'flex'
      && window._wsSyncEnabled === true,
    { timeout: 20000 });
  await sleep(600);   // frames boot and report; one microtask flush is plenty after that
}

const LABELS = (...toks) => Object.fromEntries(toks.map((t) => [t, 'Label ' + t]));

/** A file's pane frame (file-div<n>), once its page has shown a tab. */
async function fileFrame(page, n = 1) {
  const h = await page.$(`#file-div${n} > iframe`);
  const f = h && await h.contentFrame();
  if (!f) throw new Error('no frame in file-div' + n);
  await f.waitForFunction(() => typeof window.wsShownTab === 'function' && window.wsShownTab() !== null, { timeout: 20000 });
  return f;
}
const shownIn = (f) => f.evaluate(() => window.wsShownTab());
/** The on-screen [data-ws-tab] tokens, with the content id each opens. */
const visibleTabs = (f) => f.evaluate(() => {
  const out = [], seen = new Set();
  for (const b of document.querySelectorAll('button.tab[data-ws-tab]')) {
    if (!window.wsShown(b) || seen.has(b.dataset.wsTab)) continue;
    seen.add(b.dataset.wsTab);
    out.push({ tok: b.dataset.wsTab, target: window.wsTargetOf(b) });
  }
  return out;
});
const clickTab = (f, tok) => f.evaluate((t) => {
  const b = [...document.querySelectorAll('button.tab[data-ws-tab]')].find((x) => x.dataset.wsTab === t && window.wsShown(x));
  if (!b) throw new Error('no on-screen tab ' + t);
  b.click();
}, tok);
const shellText = (page) => page.evaluate(() => document.body.innerText);
const activeTab = (page) => page.evaluate(() => window.currentMainTabId());
/** A main tab id as is; a firm page's item id (firm:more, firm:admin, …) → its tab in #ycPages
 *  (ycPage-<n>: per session, so resolved from the DOM every time), or null when it isn't built. */
const tabOf = (page, id) => page.evaluate((i) => {
  if (!/^firm:/.test(i)) return i;
  const e = document.querySelector(`#ycPages > [data-yc-page="${i}"]`);
  return e ? e.id : null;
}, id);

(async () => {
  const { server, url } = await start(0);
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
  try {
    // ── (2) + (13): a file with a sub-tab settles, and survives a reload ────
    {
      const query = `?files=c${CASE}~documents&open=file:0`;
      const { page, ctx, errors } = await boot(browser, url, query, { labels: LABELS(`c${CASE}~documents`) });
      const want = q(url + '/' + query);
      check('(2) ?files=c<id>~documents&open=file:0 settles to the same URL',
        JSON.stringify(q(page.url())) === JSON.stringify(want), page.url());
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      check('(2) …and a reload settles there again',
        JSON.stringify(q(page.url())) === JSON.stringify(want), page.url());
      // a report from the active file's own frame, then (13)
      await page.evaluate(() => window.ycReportSubTab(document.querySelector('#file-div1 > iframe'), 'tasks~x'));
      await sleep(50);
      const now = q(page.url());
      check('(13) a report from the active file rewrites its token',
        now.files === `c${CASE}~tasks~x` && now.open === 'file:0', page.url());
      const reload = await page.evaluate(() => window.ycReloadUrl());
      check('(13) after a report, ycReloadUrl() === location.href', reload === page.url(), `${reload} vs ${page.url()}`);
      check('(2) no page errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ── (3s) a 3-segment rest round-trips in ?files= and ?open= ─────────────
    {
      // A bill: it has no frame, so nothing reports and the shell's own parse
      // → restore → serialize is all that touches the rest. (A case's rest is
      // owned by case.html since S1b — see (3c) below.)
      const query = `?files=b7~a~b~c&open=file:0`;
      const { page, ctx } = await boot(browser, url, query, { labels: LABELS('b7~a~b~c') });
      check('(3s) a 3-segment rest round-trips in ?files=', q(page.url()).files === 'b7~a~b~c', page.url());
      await ctx.close();
    }
    {
      // (3c) A case's rest belongs to case.html, which owns ONE segment: it
      // shows Documents and reports `documents`; the unowned tail is dropped,
      // and the converged URL is a fixed point.
      const query = `?files=c${CASE}~documents~x~y&open=file:0`;
      const { page, ctx } = await boot(browser, url, query, { labels: LABELS(`c${CASE}~documents~x~y`, `c${CASE}~documents`) });
      let f = await fileFrame(page);
      await sleep(200);
      const first = q(page.url()).files;
      check('(3c) a case\'s 3-segment rest: Documents shown, the URL settles on c<id>~documents',
        (await shownIn(f)) === 'tabDocuments' && first === `c${CASE}~documents`, `${await shownIn(f)} ${page.url()}`);
      const was = page.url();
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      f = await fileFrame(page);
      await sleep(200);
      check('(3c) …and that converged URL survives a reload unchanged',
        page.url() === was && (await shownIn(f)) === 'tabDocuments', `${was} → ${page.url()}`);
      await ctx.close();
    }
    {
      // tabTasks: its pane (tasks.html) has no leaf, so nothing reports and
      // the shell's own parse → hold → serialize is all that touches the rest.
      // (Comms owns its tab since S3 — see (c4).) When tasks.html becomes a
      // leaf, move this to a pane that still has none, or to the panel-pane path.
      const { page, ctx } = await boot(browser, url, '?open=tabTasks~a~b~c');
      check('(3s) a 3-segment rest round-trips in ?open=',
        q(page.url()).open === 'tabTasks~a~b~c' && (await activeTab(page)) === 'tabTasks', page.url());
      const held = await page.evaluate(() => window.ycTakeSubTab(document.querySelector('#tabTasks > iframe')));
      check('(3s) …and is held for the tab\'s pane to take()', held === 'a~b~c', String(held));
      await ctx.close();
    }

    // ── (7) a hidden file's report waits until that file is shown ───────────
    {
      const query = `?files=c${CASE},p${CONTACT}&open=file:0`;
      const { page, ctx } = await boot(browser, url, query, { labels: LABELS(`c${CASE}`, `p${CONTACT}`) });
      const before = page.url();
      await page.evaluate(() => window.ycReportSubTab(document.querySelector('#file-div2 > iframe'), 'cases'));
      await sleep(100);
      check('(7) a hidden file\'s report changes nothing in the URL', page.url() === before, `${before} → ${page.url()}`);
      await page.evaluate(() => window.openMainTab('file-div2'));
      await sleep(100);
      const now = q(page.url());
      check('(7) …and shows once that file is activated',
        now.files === `c${CASE},p${CONTACT}~cases` && now.open === 'file:1', page.url());
      await ctx.close();
    }

    // ── (8) a Swal frame's report is ignored ─────────────────────────────────
    {
      const query = `?files=c${CASE}&open=file:0`;
      const { page, ctx } = await boot(browser, url, query, { labels: LABELS(`c${CASE}`) });
      const before = page.url();
      // Not `return Swal.fire(…)`: its promise settles only when the dialog closes.
      await page.evaluate(() => { Swal.fire({ html: '<iframe id="wsSwalFrame" src="about:blank"></iframe>', showConfirmButton: false }); });
      await page.waitForSelector('#wsSwalFrame');
      await page.evaluate(() => window.ycReportSubTab(document.getElementById('wsSwalFrame'), 'tasks'));
      await sleep(100);
      check('(8) a report from a frame inside a Swal is ignored', page.url() === before, `${before} → ${page.url()}`);
      // …and stored nowhere: the URL alone can't see a stray report filed
      // under a view that isn't on screen.
      const stray = await page.evaluate(() => ({
        owner: window.wsFrameOwner(document.getElementById('wsSwalFrame')),
        main: JSON.stringify(window.wsMainRest),
        specs: [...document.querySelectorAll('#tabOpenFiles .file-button')].map((b) => [b.dataset.fileSpec, b.dataset.wsPending || null]),
      }));
      check('(8) …and stored nowhere (no owner, no main-tab or pending state)',
        stray.owner === null && stray.main === '{}' && JSON.stringify(stray.specs) === JSON.stringify([[`c${CASE}`, null]]),
        JSON.stringify(stray));
      await ctx.close();
    }

    // ── (9) bad rests: by report and by URL ─────────────────────────────────
    {
      const query = `?files=c${CASE}~documents&open=file:0`;
      const { page, ctx } = await boot(browser, url, query, { labels: LABELS(`c${CASE}~documents`) });
      const before = page.url();
      const bad = ['x"><img id=pwn src=x>', 'a'.repeat(33), 'a~b~c~d~e', ['a'.repeat(32), 'a'.repeat(32), 'a'.repeat(32), 'a'.repeat(30)].join('~')];
      await page.evaluate((list) => {
        const f = document.querySelector('#file-div1 > iframe');
        for (const r of list) window.ycReportSubTab(f, r);
      }, bad);
      await sleep(100);
      check('(9) injection / over-long / over-deep reports: URL unchanged', page.url() === before, `${before} → ${page.url()}`);
      check('(9) …nothing injected', !(await page.$('#pwn')), 'found #pwn');
      await ctx.close();
    }
    {
      const tok = `c${CASE}~x"><img id=pwn src=x>`;
      const query = `?files=${encodeURIComponent(tok)},p${CONTACT}~a~b~c~d~e&open=file:0`;
      const { page, ctx } = await boot(browser, url, query, { labels: LABELS(tok, `p${CONTACT}~a~b~c~d~e`) });
      const now = q(page.url());
      const buttons = await page.$$eval('#tabOpenFiles .file-button', (b) => b.map((x) => x.dataset.fileSpec));
      check('(9) bad rests in ?files= are dropped, the FILES kept',
        now.files === `c${CASE},p${CONTACT}` && JSON.stringify(buttons) === JSON.stringify([`c${CASE}`, `p${CONTACT}`]),
        `${page.url()} buttons=${JSON.stringify(buttons)}`);
      check('(9) …nothing injected by the URL either', !(await page.$('#pwn')), 'found #pwn');
      await ctx.close();
    }

    // ── (10) ?open= head validation, by role ────────────────────────────────
    // want: a main tab id, or a firm page's item id (its tab: per session) — a page's URL settles on its id
    for (const [query, su, want] of [
      ['?open=firm:admin', false, 'tabHome'],
      ['?open=tabAdmin', false, 'tabHome'],
      ['?open=tabAdmin~x', false, 'tabHome'],
      ['?open=appSidebar', false, 'tabHome'],
      ['?open=automationsDiv', true, 'tabHome'],
      ['?open=firm:admin', true, 'firm:admin'],
      ['?open=tabAdmin', true, 'firm:admin'],
      ['?open=firm:more', false, 'firm:more'],
      ['?open=tabMore', false, 'firm:more'],
    ]) {
      const { page, ctx } = await boot(browser, url, query, { su });
      const got = await activeTab(page), wantTab = await tabOf(page, want);
      const open = q(page.url()).open;
      check(`(10) ${su ? 'SU' : 'non-SU'} ${query} → ${want}`,
        !!wantTab && got === wantTab && (want === 'tabHome' || open === want), `landed on ${got} (want ${wantTab}) open=${open}`);
      await ctx.close();
    }

    // ── (11) the opener runs exactly once; an unreadable rest is dropped ────
    {
      const { page, ctx, hits } = await boot(browser, url, '?open=tabCases~x');
      await sleep(400);
      check('(11) ?open=tabCases~x: one GET /api/cases', hits.casesList === 1, `hits=${hits.casesList}`);
      check('(11) …lands on Cases, rest dropped (no pane reads it)',
        (await activeTab(page)) === 'tabCases' && q(page.url()).open === 'tabCases', page.url());
      await ctx.close();
    }
    // ════ S1b — the case / contact pages own their inner tab ══════════════
    for (const [kind, id, defaultTab] of [['c', CASE, 'tabOverview'], ['p', CONTACT, 'tabInfo']]) {
      const base = kind + id;
      const query = `?files=${base}&open=file:0`;
      const { page, ctx } = await boot(browser, url, query, { labels: LABELS(base, base + '~documents') });
      let f = await fileFrame(page);
      // (b1) + (b2) on Documents
      await clickTab(f, 'documents');
      await sleep(150);
      check(`(b1) ${base}: a Documents click → files=${base}~documents`, q(page.url()).files === `${base}~documents`, page.url());
      const was = page.url();
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      f = await fileFrame(page);
      check(`(b2) ${base}: a reload restores Documents, URL unchanged`,
        (await shownIn(f)) === 'tabDocuments' && page.url() === was, `${await shownIn(f)} ${page.url()}`);
      // (b3) every on-screen tab, from the DOM
      const tabs = await visibleTabs(f);
      const bad = [];
      for (const t of tabs) {
        f = await fileFrame(page);
        await clickTab(f, t.tok);
        await sleep(150);
        const want = t.target === defaultTab ? base : `${base}~${t.tok}`;
        const got = q(page.url()).files;
        await page.reload({ waitUntil: 'networkidle2' });
        await settle(page);
        f = await fileFrame(page);
        const shown = await shownIn(f);
        if (got !== want || shown !== t.target || q(page.url()).files !== want) {
          bad.push(`${t.tok}: url=${got} (want ${want}) shown-after-reload=${shown} (want ${t.target})`);
        }
      }
      check(`(b3) ${base}: every on-screen tab (${tabs.length}) clicks → URL → reload → same tab`,
        tabs.length >= (kind === 'c' ? 18 : 12) && bad.length === 0, bad.join(' | ') || `only ${tabs.length} tabs`);
      await ctx.close();
    }

    // (b4) ~bogus — case and contact
    for (const [kind, id, defaultTab, err] of [['c', CASE, 'tabOverview', 'Error loading case'], ['p', CONTACT, 'tabInfo', 'Error loading contact']]) {
      const base = kind + id;
      const { page, ctx, hits } = await boot(browser, url, `?files=${base}~bogus&open=file:0`, { labels: LABELS(base + '~bogus') });
      const f = await fileFrame(page);
      await sleep(300);
      const rowOk = kind === 'p' || await f.evaluate(() => window.wsShown(document.getElementById('bkButtons')));
      check(`(b4) ${base}~bogus: the default tab, no "${err}", the log fetched, the URL settles on ${base}`,
        (await shownIn(f)) === defaultTab && !(await shellText(page)).includes(err) && hits.log >= 1
          && q(page.url()).files === base && rowOk,
        `shown=${await shownIn(f)} url=${page.url()} log=${hits.log} row=${rowOk}`);
      await ctx.close();
    }

    // (b5) legacy ?case=<id>,documents (through quickPick → the mock search)
    {
      const { page, ctx } = await boot(browser, url, `?case=${CASE},documents`,
        { search: [{ type: 'case', id: CASE, name: 'Test Case' }] });
      const f = await fileFrame(page);
      check('(b5) legacy ?case=<id>,documents opens Documents',
        (await shownIn(f)) === 'tabDocuments' && q(page.url()).files === `c${CASE}~documents`, `${await shownIn(f)} ${page.url()}`);
      await ctx.close();
    }
    for (const [caseType, want, wantFiles] of [['Litigation', 'tabOverview', `c${CASE}`], [null, 'tabInfo', `c${CASE}~ISSN`]]) {
      const { page, ctx } = await boot(browser, url, `?files=c${CASE}~ISSN&open=file:0`,
        { labels: LABELS(`c${CASE}~ISSN`), caseType });
      const f = await fileFrame(page);
      await sleep(300);
      check(`(b5) ~ISSN on a ${caseType ? 'NON-BK (' + caseType + ')' : 'BK'} case → ${want}`,
        (await shownIn(f)) === want && q(page.url()).files === wantFiles, `${await shownIn(f)} ${page.url()}`);
      await ctx.close();
    }

    // (b7) dropins.js blocked on a case with a Dropbox link: the boot throws
    // after the strip is up; the error toast is allowed, a blank page is not.
    {
      const { page, ctx } = await boot(browser, url, `?files=c${CASE}~documents&open=file:0`, {
        labels: LABELS(`c${CASE}~documents`),
        casePatch: { case_dropbox: 'https://www.dropbox.com/sh/example' },
        blockHosts: ['www.dropbox.com'],
      });
      // Not fileFrame(): it waits for a shown tab, and a blank page is exactly
      // what this check must SEE (as a failure), not time out on.
      const h = await page.$('#file-div1 > iframe');
      const f = h && await h.contentFrame();
      await page.waitForFunction(() => document.body.innerText.includes('Error loading case'), { timeout: 15000 }).catch(() => {});
      await sleep(300);
      const threw = (await shellText(page)).includes('Error loading case');
      check('(b7) dropins.js blocked: the boot error still leaves the restored tab, URL settles',
        threw && (await shownIn(f)) === 'tabDocuments' && q(page.url()).files === `c${CASE}~documents`,
        `threw=${threw} shown=${await shownIn(f)} ${page.url()}`);
      await ctx.close();
    }

    // ════ S-links — server-emitted links, opened cold ══════════════════════
    for (const [tag, kind, id, row] of [
      ['L1', 'c', CASE, { type: 'case', id: CASE, name: 'Test Case' }],
      ['L2', 'p', CONTACT, { type: 'contact', id: Number(CONTACT), name: 'Test Contact' }],
    ]) {
      const { page, ctx } = await boot(browser, url, `?files=${kind}${id}&open=file:0`, { search: [row] });
      const specs = await page.$$eval('#tabOpenFiles .file-button', (b) => b.map((x) => x.dataset.fileSpec));
      let shown = null;
      try { shown = await shownIn(await fileFrame(page)); } catch (_) { /* no frame */ }
      check(`(${tag}) a cold /?files=${kind}<id>&open=file:0 opens that file, the URL settles`,
        JSON.stringify(specs) === JSON.stringify([kind + id]) && shown !== null
          && q(page.url()).files === kind + id && q(page.url()).open === 'file:0',
        `specs=${JSON.stringify(specs)} shown=${shown} ${page.url()}`);
      await ctx.close();
    }
    {
      const { page, ctx } = await boot(browser, url, `?files=p${CONTACT}&open=file:0`,
        { search: [{ type: 'contact', id: 9002, name: 'Someone Else' }] });
      const specs = await page.$$eval('#tabOpenFiles .file-button', (b) => b.length);
      const said = (await shellText(page)).includes('could not be reopened');
      check('(L3) the search answering a DIFFERENT id → "could not be reopened", no file',
        specs === 0 && said && !q(page.url()).files, `files=${specs} toast=${said} ${page.url()}`);
      await ctx.close();
    }

    // ════ S3 — comms.html owns its tab ═════════════════════════════════════
    async function commsFrame(page) {
      const h = await page.$('#tabComms > iframe');
      const f = h && await h.contentFrame();
      if (!f) throw new Error('no comms frame');
      await f.waitForFunction(() => typeof window.showTab === 'function' && document.getElementById('tab-phone'), { timeout: 20000 });
      await sleep(800);   // init's wiring (and its restore) has run
      return f;
    }
    const commsOn = (f) => f.evaluate(() => ['email', 'phone', 'team'].filter((k) => {
      const b = document.getElementById('tab-' + k);
      return b.classList.contains('on') && b.getAttribute('aria-selected') === 'true';
    }).join(','));
    {
      const { page, ctx } = await boot(browser, url, '?open=tabComms');
      let f = await commsFrame(page);
      await f.evaluate(() => document.getElementById('tab-phone').click());
      await sleep(150);
      check('(c1) a Phone click → open=tabComms~phone', q(page.url()).open === 'tabComms~phone', page.url());
      const was = page.url();
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      f = await commsFrame(page);
      check('(c2) a reload shows Phone (.on + aria-selected), URL unchanged',
        (await commsOn(f)) === 'phone' && page.url() === was, `${await commsOn(f)} ${page.url()}`);
      await f.evaluate(() => document.getElementById('tab-email').click());
      await sleep(150);
      check('(c3) an Email click → open=tabComms', q(page.url()).open === 'tabComms', page.url());
      // (c6) synthetic: a report from comms' frame while another tab is on screen
      await page.evaluate(() => window.openMainTab('tabCases'));
      await sleep(150);
      const before = page.url();
      await f.evaluate(() => window.ycSubTab.leaf.report('team'));
      await sleep(150);
      check('(c6) a report from comms\' frame while Cases is active: no URL change', page.url() === before, `${before} → ${page.url()}`);
      await page.evaluate(() => window.openMainTab('tabComms'));
      await sleep(150);
      check('(c6) …and it shows once Comms is back', q(page.url()).open === 'tabComms~team', page.url());
      await ctx.close();
    }
    for (const [query, want, wantOpen] of [['?open=tabComms~bogus', 'email', 'tabComms'], ['?open=tabComms~team', 'team', 'tabComms~team']]) {
      const { page, ctx } = await boot(browser, url, query);
      const f = await commsFrame(page);
      check(`(${want === 'email' ? 'c4' : 'c5'}) ${query} → ${want}, URL settles on ${wantOpen}`,
        (await commsOn(f)) === want && q(page.url()).open === wantOpen, `${await commsOn(f)} ${page.url()}`);
      await ctx.close();
    }

    // ════ S2 — More Features / Admin drill panels (firm pages since C4) ═════
    const MORE = 'firm:more', ADMIN = 'firm:admin';
    const openPanelOf = async (page, id) => {
      const t = await tabOf(page, id);
      return t ? page.evaluate((tt) => { const p = window.wsOpenPanel(tt); return p ? p.id : null; }, t) : null;
    };
    // a page's tile is a neutral (no launcher element): clicked as rendered, directly under the page
    const clickTile = async (page, id, pid) => {
      const t = await tabOf(page, pid);
      await page.evaluate((tt, i) => {
        const b = tt && document.querySelector(`#${tt} > .big-button[data-yc-shortcut="${i}"]`);
        if (!b) throw new Error(`no ${i} tile on ${tt}`);
        b.click();
      }, t, id);
    };
    const showPage = async (page, pid) => { const t = await tabOf(page, pid); await page.evaluate((tt) => window.openMainTab(tt), t); };
    const realDialog = (page) => page.evaluate(() => !!document.querySelector('.swal2-popup:not(.swal2-toast)'));
    {
      const { page, ctx, hits } = await boot(browser, url, '?open=firm:more');
      await clickTile(page, 'moreAutomations', MORE);
      await sleep(150);
      check('(d1) SU: drilling into Automations → open=firm:more~moreAutomations', q(page.url()).open === 'firm:more~moreAutomations', page.url());
      const was = page.url();
      hits.automationManager = 0;
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      check('(d1) …a reload reopens that panel, URL unchanged, its pane loaded ONCE',
        (await openPanelOf(page, MORE)) === 'moreAutomations' && page.url() === was && hits.automationManager === 1,
        `panel=${await openPanelOf(page, MORE)} url=${page.url()} loads=${hits.automationManager}`);
      await clickTile(page, 'moreManuals', MORE);
      await sleep(150);
      check('(d1) …switching panels moves the id', q(page.url()).open === 'firm:more~moreManuals', page.url());
      await page.evaluate((t) => document.querySelector(`#${t} > .feature-strip .pill-button`).click(), await tabOf(page, MORE));   // "All"
      await sleep(150);
      check('(d1) …the All pill → open=firm:more, the grid', q(page.url()).open === 'firm:more' && (await openPanelOf(page, MORE)) === null, page.url());
      await ctx.close();
    }
    {
      const { page, ctx } = await boot(browser, url, '?open=firm:admin~adminDbConsole', { su: true });
      const ok1 = (await activeTab(page)) === (await tabOf(page, ADMIN)) && (await openPanelOf(page, ADMIN)) === 'adminDbConsole'
        && q(page.url()).open === 'firm:admin~adminDbConsole';
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      check('(d2) SU: firm:admin~adminDbConsole round-trips (and survives a reload)',
        ok1 && (await activeTab(page)) === (await tabOf(page, ADMIN)) && (await openPanelOf(page, ADMIN)) === 'adminDbConsole' && q(page.url()).open === 'firm:admin~adminDbConsole', page.url());
      await ctx.close();
    }
    {
      const { page, ctx, hits } = await boot(browser, url, '?open=firm:admin~adminDbConsole', { su: false });
      check('(d2) non-SU firm:admin~adminDbConsole → Home, the pane never loaded',
        (await activeTab(page)) === 'tabHome' && hits.dbConsole === 0, `${await activeTab(page)} loads=${hits.dbConsole}`);
      await ctx.close();
    }
    // The action tiles are ones that EXIST: moreSettings (it switches to
    // tabSettings) and, for SU, adminEtch (a Swal) — not moreClioCode, which
    // ui-custom S3.3b retires (exec would refuse it as unknown, proving
    // nothing about rule (c)).
    // firm-hidden: the fixture's firm documents with one more hide (a patch of `ui` alone would drop its pages)
    const FX_UI = FIRM_DATA.ui;
    const HIDE_VIEWS = { ui: { ...FX_UI, firm: { ...FX_UI.firm, registry_overrides: { ...FX_UI.firm.registry_overrides, hidden: ['moreViews'] } } } };
    for (const [label, pid, id, firmPatch] of [
      ['denied', MORE, 'moreAutomations', { denied: ['moreAutomations'] }],
      ['firm-hidden', MORE, 'moreViews', HIDE_VIEWS],
      ['an action tile (it switches tab)', MORE, 'moreSettings', null],
      ['an action tile (a dialog, SU)', ADMIN, 'adminEtch', null],
      ['no More tile (newClient)', MORE, 'newClient', null],
      ['a firm id', MORE, 'firm:x', null],
      ['a bogus id', MORE, 'moreBogus', null],
    ]) {
      const { page, ctx, hits } = await boot(browser, url, `?open=${pid}~${encodeURIComponent(id)}`, { firmPatch });
      await sleep(1300);   // past the welcome toast; a dialog would still be up
      const tab = await activeTab(page), want = await tabOf(page, pid), open = await openPanelOf(page, pid), dlg = await realDialog(page);
      const swal = await page.evaluate(() => !!document.querySelector('.swal2-container'));
      check(`(d3) refused, ${label} (${id}) → the ${pid} grid, no dialog`,
        !!want && tab === want && open === null && !dlg && !swal && q(page.url()).open === pid && (id !== 'moreAutomations' || hits.automationManager === 0),
        `tab=${tab} (want ${want}) panel=${open} dialog=${dlg} swal=${swal} url=${page.url()} loads=${hits.automationManager}`);
      await ctx.close();
    }
    {
      const { page, ctx, hits } = await boot(browser, url, '?open=firm:more~moreAutomations');
      check('(d4) the boot opened the panel, its pane loaded once', (await openPanelOf(page, MORE)) === 'moreAutomations' && hits.automationManager === 1,
        `loads=${hits.automationManager}`);
      await page.evaluate(() => window.ycReportSubTab(document.querySelector('#automationsDiv > iframe'), 'activity'));
      await sleep(100);
      check('(d4) a report from the panel\'s pane → firm:more~moreAutomations~activity', q(page.url()).open === 'firm:more~moreAutomations~activity', page.url());
      await page.evaluate(() => window.openMainTab('tabCases'));
      await sleep(100);
      const was = page.url();
      await page.evaluate(() => window.ycReportSubTab(document.querySelector('#automationsDiv > iframe'), 'workflows'));
      await sleep(100);
      check('(d4) …from the same frame while another tab is active: no URL change', page.url() === was, `${was} → ${page.url()}`);
      await showPage(page, MORE);
      await sleep(100);
      check('(d4) …and shown once its panel is on screen again', q(page.url()).open === 'firm:more~moreAutomations~workflows', page.url());
      await ctx.close();
    }
    {
      const { page, ctx } = await boot(browser, url, '?open=firm:more~moreAutomations&manual=03-YisraFlow');
      await sleep(300);
      check('(d5) ?manual= + ?open=firm:more~moreAutomations → the manual wins',
        (await openPanelOf(page, MORE)) === 'moreManuals' && q(page.url()).open === 'firm:more~moreManuals', page.url());
      await ctx.close();
    }
    // (d6) old links and bookmarks (C2): the hubs' heads alias the pages that replaced them
    for (const [query, pid, panel, want] of [
      ['?open=tabMore~moreAutomations~triggers', MORE, 'moreAutomations', 'firm:more~moreAutomations~triggers'],
      ['?open=tabAdmin~adminDbConsole', ADMIN, 'adminDbConsole', 'firm:admin~adminDbConsole'],
    ]) {
      const { page, ctx } = await boot(browser, url, query);
      await sleep(300);
      const got = { tab: await activeTab(page), want: await tabOf(page, pid), panel: await openPanelOf(page, pid), open: q(page.url()).open };
      check(`(d6) the old ${query} opens ${pid} with ${panel}; the URL settles on ${want}`,
        !!got.want && got.tab === got.want && got.panel === panel && got.open === want, JSON.stringify(got));
      await ctx.close();
    }

    // ════ S5c-a — the manager panes' sub-tab ═══════════════════════════════
    const paneFrame = async (page, div) => {
      const h = await page.$(`#${div} > iframe`);
      const f = h && await h.contentFrame();
      if (!f) throw new Error('no pane frame in ' + div);
      await f.waitForFunction(() => document.querySelectorAll('.tab-nav-btn.active').length === 1, { timeout: 20000 });
      return f;
    };
    const subOn = (f) => f.evaluate(() => document.querySelector('.tab-nav-btn.active').id.replace(/^tabnav-/, ''));
    {
      const { page, ctx, hits, errors } = await boot(browser, url, '?open=firm:more');
      await clickTile(page, 'moreAutomations', MORE);
      let f = await paneFrame(page, 'automationsDiv');
      await f.evaluate(() => document.getElementById('tabnav-triggers').click());   // the shipped inline onclick
      await sleep(150);
      check('(a1) Automations: a Triggers click → open=firm:more~moreAutomations~triggers',
        q(page.url()).open === 'firm:more~moreAutomations~triggers' && (await subOn(f)) === 'triggers', page.url());
      const was = page.url();
      hits.automationManager = 0;
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      f = await paneFrame(page, 'automationsDiv');
      check('(a2) …a reload shows Triggers, URL unchanged, the pane loaded ONCE',
        (await subOn(f)) === 'triggers' && page.url() === was && hits.automationManager === 1,
        `sub=${await subOn(f)} url=${page.url()} loads=${hits.automationManager}`);
      check('(a1-a2) no page errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
      const fresh = await boot(browser, url, '?open=firm:more~moreAutomations~triggers');
      f = await paneFrame(fresh.page, 'automationsDiv');
      check('(a3) the same URL in a fresh context → Triggers',
        (await subOn(f)) === 'triggers' && q(fresh.page.url()).open === 'firm:more~moreAutomations~triggers', fresh.page.url());
      await fresh.ctx.close();
    }
    {
      const { page, ctx } = await boot(browser, url, '?open=firm:more~moreAutomations~bogus');
      const f = await paneFrame(page, 'automationsDiv');
      check('(a4) ~bogus → Workflows, the URL settles on firm:more~moreAutomations',
        (await subOn(f)) === 'workflows' && q(page.url()).open === 'firm:more~moreAutomations', `${await subOn(f)} ${page.url()}`);
      await ctx.close();
    }
    {
      const { page, ctx } = await boot(browser, url, '?open=firm:more~moreCaseConfig~pipelines');
      let f = await paneFrame(page, 'caseConfigDiv');
      const ok1 = (await subOn(f)) === 'pipelines' && q(page.url()).open === 'firm:more~moreCaseConfig~pipelines';
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      f = await paneFrame(page, 'caseConfigDiv');
      check('(a5) Config: ~pipelines round-trips a reload',
        ok1 && (await subOn(f)) === 'pipelines' && q(page.url()).open === 'firm:more~moreCaseConfig~pipelines', `${await subOn(f)} ${page.url()}`);
      await ctx.close();
      const g = await boot(browser, url, '?open=firm:more~moreCaseConfig~firm');
      f = await paneFrame(g.page, 'caseConfigDiv');
      await f.waitForFunction(() => document.getElementById('tabnav-firm').classList.contains('active'), { timeout: 5000 }).catch(() => {});
      check('(a5) Config: ~firm (gated, revealed) → Firm, URL unchanged',
        (await subOn(f)) === 'firm' && q(g.page.url()).open === 'firm:more~moreCaseConfig~firm', `${await subOn(f)} ${g.page.url()}`);
      await g.ctx.close();
    }

    // ════ S6c-4 — the panel stage ═════════════════════════════════════════
    // The panels live in ONE container after the tabs (#ycPanels); the drill is
    // page-scoped with a per-page memory; a panel item the firm places on
    // another page (the fixture: Users on More, row 8) opens IN PLACE there.
    const onStage = (page) => page.evaluate(() => [...document.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id));
    const stageShown = (page) => page.evaluate(() => document.getElementById('ycPanels').style.display !== 'none');
    const drilled = async (page, id) => { const t = await tabOf(page, id); return !!t && page.evaluate((tt) => document.getElementById(tt).classList.contains('drill-active'), t); };
    {
      // (s1) the firm-placed neutral opens Users on More, in place; the URL names it on More; a reload restores it THERE
      const { page, ctx, hits } = await boot(browser, url, '?open=firm:more');
      const moreTab = await tabOf(page, MORE);
      const neutral = moreTab && await page.$(`#${moreTab} > .big-button[data-yc-shortcut="adminUsers"][data-target="usersDiv"]`);
      check('(s1) SU: the firm-placed Users tile is on More with data-target', !!neutral, `no tile (More's tab ${moreTab})`);
      if (neutral) await neutral.click();
      await sleep(400);
      const s1 = { tab: await activeTab(page), want: moreTab, open: q(page.url()).open, stage: await onStage(page), more: await drilled(page, MORE), admin: await drilled(page, ADMIN) };
      check('(s1) …a click opens the panel IN PLACE on More: open=firm:more~adminUsers, Users on the stage, Admin not drilled',
        !!moreTab && s1.tab === moreTab && s1.open === 'firm:more~adminUsers' && s1.stage.join() === 'usersDiv' && s1.more && !s1.admin, JSON.stringify(s1));
      const panelWhere = await page.evaluate(() => document.getElementById('usersDiv').parentElement.id);
      check('(s1) …the panel is the stage\'s child, not the page\'s', panelWhere === 'ycPanels', panelWhere);
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page);
      const s1r = { tab: await activeTab(page), want: await tabOf(page, MORE), open: q(page.url()).open, stage: await onStage(page), more: await drilled(page, MORE) };
      check('(s1) …a reload reopens Users on MORE (exec told the page), URL unchanged',
        !!s1r.want && s1r.tab === s1r.want && s1r.open === 'firm:more~adminUsers' && s1r.stage.join() === 'usersDiv' && s1r.more, JSON.stringify(s1r));
      // (s2) per-page memory + one panel at a time + hidden off the pages
      await showPage(page, ADMIN);
      await sleep(200);
      const s2a = { open: q(page.url()).open, stage: await onStage(page), shown: await stageShown(page), admin: await drilled(page, ADMIN) };
      check('(s2) Admin shows its own grid: the stage is empty and hidden there (per-page memory)',
        s2a.open === 'firm:admin' && s2a.stage.length === 0 && !s2a.shown && !s2a.admin, JSON.stringify(s2a));
      await clickTile(page, 'adminDbConsole', ADMIN);
      await sleep(400);
      const s2b = { open: q(page.url()).open, stage: await onStage(page) };
      check('(s2) …drilling Admin into DB Console: exactly ONE stage panel, open=firm:admin~adminDbConsole',
        s2b.open === 'firm:admin~adminDbConsole' && s2b.stage.join() === 'dbConsoleDiv', JSON.stringify(s2b));
      await showPage(page, MORE);
      await sleep(200);
      const s2c = { open: q(page.url()).open, stage: await onStage(page), db: await page.evaluate(() => document.getElementById('dbConsoleDiv').style.display) };
      check('(s2) …back on More: Users again (More\'s memory), DB Console off the stage',
        s2c.open === 'firm:more~adminUsers' && s2c.stage.join() === 'usersDiv' && s2c.db === 'none', JSON.stringify(s2c));
      await page.evaluate(() => window.openMainTab('tabCases'));
      await sleep(200);
      const s2d = { stage: await onStage(page), shown: await stageShown(page), open: q(page.url()).open };
      check('(s2) …on Cases: no panel shown, #ycPanels hidden', s2d.stage.length === 0 && !s2d.shown && s2d.open === 'tabCases', JSON.stringify(s2d));
      // the pane loaded once through all of it
      check('(s2) …DB Console\'s pane loaded ONCE through all of it', hits.dbConsole === 1, `dbConsole loads=${hits.dbConsole}`);
      await ctx.close();
    }
    {
      // (s3) THE NO-RELOAD PROOF: type into a panel's pane, switch tab / page / panel and back —
      // the text is still there and the frame's performance.timeOrigin is unchanged
      const { page, ctx, hits } = await boot(browser, url, '?open=firm:more~moreAutomations');
      let f = await paneFrame(page, 'automationsDiv');
      const t0 = await f.evaluate(() => { const t = document.createElement('textarea'); t.id = 's6c4probe'; document.body.appendChild(t); t.focus(); return performance.timeOrigin; });
      await f.type('#s6c4probe', 'unsaved words');
      await page.evaluate(() => window.openMainTab('tabCases'));
      await sleep(200);
      await showPage(page, ADMIN);
      await clickTile(page, 'adminDbConsole', ADMIN);
      await sleep(400);
      await showPage(page, MORE);
      await sleep(200);
      await clickTile(page, 'moreManuals', MORE);
      await sleep(300);
      await clickTile(page, 'moreAutomations', MORE);
      await sleep(300);
      f = await paneFrame(page, 'automationsDiv');
      const after = await f.evaluate(() => ({ t: performance.timeOrigin, v: (document.getElementById('s6c4probe') || {}).value || null }));
      const s3 = { t0, ...after, loads: hits.automationManager, open: q(page.url()).open, stage: await onStage(page) };
      check('(s3) no reload: after Cases → Admin (DB Console) → More → Manuals → Automations, the typed text is still there, timeOrigin unchanged, the pane loaded ONCE',
        after.t === t0 && after.v === 'unsaved words' && hits.automationManager === 1 && s3.open === 'firm:more~moreAutomations' && s3.stage.join() === 'automationsDiv', JSON.stringify(s3));
      await ctx.close();
    }
    {
      // (s4) non-SU: firm:more~adminUsers → the More grid (Users is not effective; its tile is not drawn), no pane
      const { page, ctx } = await boot(browser, url, '?open=firm:more~adminUsers', { su: false });
      const moreTab = await tabOf(page, MORE);
      const s4 = { tab: await activeTab(page), want: moreTab, open: q(page.url()).open, stage: await onStage(page),
        neutral: !!moreTab && await page.evaluate((t) => !!document.querySelector(`#${t} > .big-button[data-yc-shortcut="adminUsers"]`), moreTab) };
      check('(s4) non-SU firm:more~adminUsers → the More grid, no tile, nothing on the stage',
        !!moreTab && s4.tab === moreTab && s4.open === 'firm:more' && s4.stage.length === 0 && !s4.neutral, JSON.stringify(s4));
      await ctx.close();
    }

    // ════ S6c-5 — pages ═══════════════════════════════════════════════════
    const pageTab = (page, id) => page.evaluate((i) => { const e = document.querySelector(`#ycPages > [data-yc-page="${i}"]`); return e ? e.id : null; }, id);
    const tilesOf = (page, tab) => page.evaluate((t) => [...document.querySelectorAll(`#${t} > .big-button`)].map((b) => b.getAttribute('data-yc-shortcut')), tab);
    const pillsOf = (page, tab) => page.evaluate((t) => [...document.querySelectorAll(`#${t} > .feature-strip .pill-button`)].slice(1).map((b) => b.dataset.target || b.textContent.trim()), tab);
    {
      // (p1) the user's page opens; nothing of it in the URL; F5 → Home
      const { page, ctx, hits } = await boot(browser, url, '?open=tabHome');
      const tab = await pageTab(page, 'user:my-desk');
      check('(p1) SU: the user page user:my-desk has a tab in #ycPages (a .tab-main.yc-hub)', !!tab && await page.evaluate((t) => document.getElementById(t).className === 'tab-main yc-hub', tab), String(tab));
      await page.evaluate(() => ycLauncher.exec('user:my-desk')); await sleep(400);
      const p1 = await page.evaluate((t) => ({ cur: currentMainTabId(), open: new URL(location.href).searchParams.get('open'),
        lit: !!document.querySelector(`#appSidebar .sb-item[data-yc-shortcut="user:my-desk"].active`), tabAttr: document.querySelector('#appSidebar .sb-item[data-yc-shortcut="user:my-desk"]').getAttribute('data-tab') }), tab);
      check('(p1) …exec opened it (its sidebar row carries the tab and is lit) and the URL carries NO open=', p1.cur === tab && p1.open === null && p1.lit && p1.tabAttr === tab, JSON.stringify(p1));
      await page.reload({ waitUntil: 'networkidle2' }); await settle(page);
      check('(p1) …a reload lands on Home', await page.evaluate(() => currentMainTabId()) === 'tabHome', await page.evaluate(() => currentMainTabId()));
      // (p2) a panel in place; the strip; the same iframe from More and the page
      await page.evaluate(() => ycLauncher.exec('user:my-desk')); await sleep(300);
      const tiles = await tilesOf(page, tab);
      await page.evaluate((t) => document.querySelector(`#${t} > .big-button[data-yc-shortcut="moreAutomations"]`).click(), tab); await sleep(2500);
      const moreTab = await tabOf(page, MORE);
      const p2 = await page.evaluate((t, mt) => ({ cur: currentMainTabId(), open: new URL(location.href).searchParams.get('open'), drilled: document.getElementById(t).classList.contains('drill-active'),
        stage: [...document.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id), moreDrilled: !mt || document.getElementById(mt).classList.contains('drill-active') }), tab, moreTab);
      check('(p2) a panel tile on the page opens Automations IN PLACE: the page is drilled, one stage panel, More not drilled, no open= in the URL',
        p2.cur === tab && p2.drilled && p2.stage.join() === 'automationsDiv' && !p2.moreDrilled && p2.open === null, JSON.stringify(p2));
      const pills = await pillsOf(page, tab);
      check('(p2) …the strip shows exactly the page\'s tiles\' pills', pills.length === tiles.length && pills.length > 5, JSON.stringify({ pills, tiles }));
      const af = await paneFrame(page, 'automationsDiv');
      check('(p2) …the Automations pane loaded', !!af, 'no pane frame');
      let same = null;
      if (af) {
        const t0 = await af.evaluate(() => { const t = document.createElement('textarea'); t.id = 's6c5probe'; document.body.appendChild(t); t.focus(); return performance.timeOrigin; });
        await af.type('#s6c5probe', 'unsaved on the page');
        await showPage(page, MORE); await sleep(300);
        await clickTile(page, 'moreAutomations', MORE); await sleep(500);
        const onMore = await page.evaluate(() => ({ cur: currentMainTabId(), stage: [...document.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id), open: new URL(location.href).searchParams.get('open') }));
        await page.evaluate(() => openMainTab('tabCases')); await sleep(300);
        await page.evaluate(() => ycLauncher.exec('user:my-desk')); await sleep(400);
        const af2 = await paneFrame(page, 'automationsDiv');
        const after = af2 ? await af2.evaluate(() => ({ t: performance.timeOrigin, v: (document.getElementById('s6c5probe') || {}).value || null, url: location.href })) : null;
        const back = await page.evaluate((t) => ({ cur: currentMainTabId(), stage: [...document.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id) }), tab);
        same = after && after.t === t0 && after.v === 'unsaved on the page' && hits.automationManager === 1 && onMore.cur === moreTab && onMore.stage.join() === 'automationsDiv' && onMore.open === 'firm:more~moreAutomations' && back.cur === tab && back.stage.join() === 'automationsDiv';
        check('(p2) …the SAME iframe from More (open=firm:more~moreAutomations there) and back on the page: typed text kept, timeOrigin unchanged, loaded ONCE', !!same,
          JSON.stringify({ t0, sameFrame: af2 === af, afUrl: af.url(), after, onMore, back, tab, loads: hits.automationManager }));
      }
      // (p3) the tab id is never a head
      await page.goto(url + '/?open=' + tab, { waitUntil: 'networkidle2' }); await settle(page);
      check('(p3) ?open=<page tab id> → Home', await page.evaluate(() => currentMainTabId()) === 'tabHome', await page.evaluate(() => currentMainTabId()));
      // (p4) the firm page for SU
      const fp = await page.evaluate(() => ({ tab: (document.querySelector('#ycPages > [data-yc-page="firm:ops"]') || {}).id || null,
        tile: !!document.querySelector('#ycPages > [data-yc-page="firm:more"] > .big-button[data-yc-shortcut="firm:ops"]'), eff: ycLauncher.effectiveRegistry().some((e) => e.id === 'firm:ops' && e.page === true) }));
      const opened = await page.evaluate(() => ycLauncher.exec('firm:ops')); await sleep(300);
      check('(p4) SU: the firm page firm:ops has a tab, a tile on More, is a page in the effective registry, and exec opens it',
        !!fp.tab && fp.tile && fp.eff && opened === true && await page.evaluate(() => currentMainTabId()) === fp.tab, JSON.stringify(fp));
      // (p6) the firm page in the address bar (L4a)
      const openNow = () => page.evaluate(() => new URL(location.href).searchParams.get('open'));
      check('(p6) on the firm page the URL names it by its item id', await openNow() === 'firm:ops', String(await openNow()));
      const panelId = await page.evaluate((t) => { const b = document.querySelector(`#${t} > .big-button[data-target]`); if (b) b.click(); return b ? b.getAttribute('data-yc-shortcut') : null; }, fp.tab);
      await sleep(1500);
      check('(p6) …a panel opened on it rides as the rest', !!panelId && await openNow() === 'firm:ops~' + panelId, JSON.stringify({ panelId, open: await openNow() }));
      await page.reload({ waitUntil: 'networkidle2' }); await settle(page); await sleep(1000);
      const p6 = await page.evaluate((t) => ({ cur: currentMainTabId(), tab: (document.querySelector('#ycPages > [data-yc-page="firm:ops"]') || {}).id || null,
        open: new URL(location.href).searchParams.get('open'), stage: [...document.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id) }));
      const tgt = await page.evaluate((id) => (document.querySelector(`#ycPages > [data-yc-page="firm:ops"] > .big-button[data-yc-shortcut="${id}"]`) || {}).getAttribute?.('data-target') || null, panelId);
      check('(p6) …a reload comes back to the page with that panel open on it, and the URL settles unchanged',
        !!p6.tab && p6.cur === p6.tab && p6.open === 'firm:ops~' + panelId && p6.stage.join() === tgt, JSON.stringify({ p6, tgt }));
      await page.goto(url + '/?open=firm:nope', { waitUntil: 'networkidle2' }); await settle(page);
      check('(p6) ?open=firm:nope → Home', await page.evaluate(() => currentMainTabId()) === 'tabHome', await page.evaluate(() => currentMainTabId()));
      await ctx.close();
    }
    {
      // (p4) / (p5) staff: the firm page is gone; the user page shows no su tile
      const { page, ctx } = await boot(browser, url, '?open=tabHome', { su: false });
      const st = await page.evaluate(() => ({ tab: !!document.querySelector('#ycPages > [data-yc-page="firm:ops"]'), more: !!document.querySelector('#ycPages > [data-yc-page="firm:more"]'),
        tile: !!document.querySelector('#ycPages > [data-yc-page="firm:more"] > .big-button[data-yc-shortcut="firm:ops"]'),
        eff: ycLauncher.effectiveRegistry().some((e) => e.id === 'firm:ops'), exec: ycLauncher.exec('firm:ops') }));
      check('(p4) staff: firm:ops has no tab, no tile on More (which they do have), is not effective, exec refuses', !st.tab && st.more && !st.tile && !st.eff && st.exec === false, JSON.stringify(st));
      await page.goto(url + '/?open=firm:ops', { waitUntil: 'networkidle2' }); await settle(page);
      check('(p6) staff: ?open=firm:ops (not their page) → Home', await page.evaluate(() => currentMainTabId()) === 'tabHome', await page.evaluate(() => currentMainTabId()));
      const utab = await pageTab(page, 'user:my-desk');
      const utiles = utab ? await tilesOf(page, utab) : [];
      // (the fixture restricts Automations to admin / attorney: staff drills the first panel tile the page gives them)
      await page.evaluate((t) => { openMainTab(t); const b = document.querySelector(`#${t} > .big-button[data-target]`); if (b) b.click(); }, utab); await sleep(1500);
      const upills = await pillsOf(page, utab);
      check('(p5) staff: the user page draws no su tile and its strip has no su pill',
        !!utab && utiles.length > 3 && !utiles.includes('adminUsers') && !utiles.includes('adminDbConsole') && !upills.includes('usersDiv') && !upills.includes('dbConsoleDiv'),
        JSON.stringify({ utiles, upills }));
      await ctx.close();
    }

    {
      // (pt1) the panel tab (launcher-nits C1)
      const { page, ctx } = await boot(browser, url, '?open=tabHome');
      const at = () => page.evaluate(() => ({ cur: currentMainTabId(), open: new URL(location.href).searchParams.get('open'),
        h1: (document.querySelector('#tabPanel > h1') || {}).textContent || null,
        stage: [...document.getElementById('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id),
        admin: !!document.querySelector('#ycPages > [data-yc-page="firm:admin"]'),
        adminDrilled: !!document.querySelector('#ycPages > [data-yc-page="firm:admin"].drill-active') }));
      const ok = await page.evaluate(() => ycLauncher.exec('adminScratch')); await sleep(800);
      const c = await at();
      check('(pt1) a panel no page shows opens on the panel tab, headed with its name; the URL names it tabPanel~adminScratch',
        ok === true && c.cur === 'tabPanel' && c.open === 'tabPanel~adminScratch' && /Scratch \(SU\)/.test(c.h1 || '') && c.stage.join() === 'scratchBrowserDiv' && c.admin && !c.adminDrilled, JSON.stringify(c));
      await page.reload({ waitUntil: 'networkidle2' }); await settle(page); await sleep(1000);
      const r = await at();
      check('(pt1) …a reload brings it back on the panel tab', r.cur === 'tabPanel' && r.open === 'tabPanel~adminScratch' && r.stage.join() === 'scratchBrowserDiv', JSON.stringify(r));
      await ctx.close();
    }

    // (b6) dedup refocus with a new tab: the page switches, its report moves the token
    {
      const { page, ctx } = await boot(browser, url, `?files=c${CASE}&open=file:0`, { labels: LABELS(`c${CASE}`) });
      let f = await fileFrame(page);
      // ~clients on purpose: People has no legacy `clientsButton` id, so only
      // the page's own ycApplySubTab can make this pass, not the shell's
      // legacy `<x>Button` click.
      await page.evaluate((id) => window.addFile('Test Case', 'case', id + '&tab=clients'), CASE);
      await sleep(300);
      f = await fileFrame(page);
      const buttons = await page.$$eval('#tabOpenFiles .file-button', (b) => b.length);
      check('(b6) dedup refocus with ~clients: the tab switches AND the token follows (one file)',
        (await shownIn(f)) === 'tabClients' && q(page.url()).files === `c${CASE}~clients` && buttons === 1,
        `${await shownIn(f)} ${page.url()} buttons=${buttons}`);
      await ctx.close();
    }
  } catch (err) {
    check('harness ran to completion', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length
    ? `NO-GO wsurl harness: ${failed.length} of ${results.length} checks failed`
    : `GO wsurl harness: ${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
