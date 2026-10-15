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
//        reporter) and in ?open=; (3c) a case's converges on its own segment
//   (7)  a report from a HIDDEN file's frame changes nothing in the URL, and
//        shows once that file is activated
//   (8)  a report from a frame inside a Swal is ignored
//   (9)  injection / over-long / over-deep rests are rejected (by report and
//        by URL): the URL is unchanged and the file is kept
//   (10) non-SU: ?open=tabAdmin, tabAdmin~x and a random element id land on
//        Home; SU: tabAdmin is allowed
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
async function boot(browser, base, query, { su = true, labels = {}, caseType = null, casePatch = null, search = null, blockHosts = [] } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
  const hits = { casesList: 0, log: 0 };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/cases' && req.method() === 'GET') hits.casesList++;
    if (u.pathname === '/api/log' && req.method() === 'GET') hits.log++;
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
      const { page, ctx } = await boot(browser, url, '?open=tabComms~a~b~c');
      check('(3s) a 3-segment rest round-trips in ?open=',
        q(page.url()).open === 'tabComms~a~b~c' && (await activeTab(page)) === 'tabComms', page.url());
      const held = await page.evaluate(() => window.ycTakeSubTab(document.querySelector('#tabComms > iframe')));
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
    for (const [query, su, want] of [
      ['?open=tabAdmin', false, 'tabHome'],
      ['?open=tabAdmin~x', false, 'tabHome'],
      ['?open=appSidebar', false, 'tabHome'],
      ['?open=automationsDiv', true, 'tabHome'],
      ['?open=tabAdmin', true, 'tabAdmin'],
      ['?open=tabMore', false, 'tabMore'],
    ]) {
      const { page, ctx } = await boot(browser, url, query, { su });
      const got = await activeTab(page);
      check(`(10) ${su ? 'SU' : 'non-SU'} ${query} → ${want}`, got === want, `landed on ${got}`);
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
