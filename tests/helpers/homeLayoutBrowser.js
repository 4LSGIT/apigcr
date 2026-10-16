// tests/helpers/homeLayoutBrowser.js
//
// Real-Chrome proof for ui-custom S6b, run as a CLEAN NODE SUBPROCESS by
// tests/launcherS6b.browser.test.js — NOT a jest test itself (same reason as
// tests/helpers/mailRenderBrowser.js: puppeteer-core in a plain node process).
// It boots the real shell on the mobile-survey mock origin
// (scripts/mobile-survey/server.js), swapping /api/firm-data's `ui.user` per
// scenario, and measures what jsdom can't lay out:
//   rows      Home with the DEFAULT layout keeps its 3 / 3 / 3 / … rows at
//             1300 and 375; a layout of 8 items and no break puts 5+ across
//             at 1300 and wraps inside the screen at 375.
//   sticky    a 1300×600 window, a sidebar taller than it: scrolled to the
//             bottom, Home is still at the sidebar's top and on top (it takes
//             the click there), the section labels keep their height, the edge
//             appears only once scrolled, the Open Files header still toggles
//             its list; the same in skinny mode and in the phone drawer (375).
//   all       the icon-only #homeAll opens All (a real click), muted until
//             hover; a placed `logout` shortcut on Home opens the Log Out
//             confirm (cancelled).
//
// Contract: prints ONE JSON line { ok, checks, info, error? }; exit 0 iff all
// checks pass. Requires PUPPETEER_EXECUTABLE_PATH. S6B_SHOTS_DIR (optional):
// a directory for screenshots.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const { start, fakeJwt } = require(path.join(ROOT, 'scripts/mobile-survey/server.js'));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/mobile-survey/fixtures/firm-data.json'), 'utf8'));
const SHOTS = process.env.S6B_SHOTS_DIR || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = {};
const info = {};
// Eight Home tiles and no break: the other default tiles removed (bills is
// firm-locked in the fixture, so it is one of the eight).
const EIGHT = {
  placed: { home: ['cases', 'contacts', 'appts', 'bills', 'events', 'tasks', 'comms', 'logout'].map((item) => ({ item })) },
  removed: { home: ['pipeline', 'newClient', 'log', 'custom', 'moreFeatures'] },
};

async function open(browser, url, { width, height = 900, user = {}, mobile = width < 769 }) {
  const fd = JSON.parse(JSON.stringify(FIXTURE));
  fd.ui.user = user;
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  await page.evaluateOnNewDocument((jwt) => { try { localStorage.setItem('jwt', jwt); localStorage.setItem('yc-theme', 'light'); } catch (_) { /* none */ } }, fakeJwt());
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/firm-data') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fd) });
    return req.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(url + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.firmData && window.ycLauncher && window.ycLauncher.isReady() &&
    document.getElementById('appSidebar').style.display === 'flex', { timeout: 20000 });
  await page.evaluate(() => openMainTab('tabHome'));
  await page.mouse.move(width - 1, height - 1);
  await sleep(400);
  page.errors = errors;
  return page;
}
const shot = async (page, name, sel) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const el = sel ? await page.$(sel) : null;
  await (el || page).screenshot({ path: path.join(SHOTS, name + '.png') });
};
// Tiles per row on Home, top to bottom; and whether every tile is inside the viewport.
const rows = (page) => page.evaluate(() => {
  const tiles = [...document.querySelectorAll('#tabHome .home-grid > .home-btn')].filter((b) => b.offsetParent);
  const by = {};
  tiles.forEach((t) => { const y = Math.round(t.getBoundingClientRect().top); by[y] = (by[y] || 0) + 1; });
  const vw = document.documentElement.clientWidth;
  return {
    perRow: Object.keys(by).sort((a, b) => a - b).map((y) => by[y]),
    inside: tiles.every((t) => { const r = t.getBoundingClientRect(); return r.left >= 0 && r.right <= vw + 0.5; }),
    sideways: document.documentElement.scrollWidth > vw,
  };
});
// The sidebar Home entry vs the sidebar, plus the section labels' heights.
const sidebarState = (page) => page.evaluate(() => {
  const sb = document.getElementById('appSidebar');
  const home = sb.querySelector(':scope > .sb-item[data-tab="tabHome"]');
  const s = sb.getBoundingClientRect(), h = home.getBoundingClientRect();
  const mid = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2);
  return {
    scrollTop: sb.scrollTop, overflow: sb.scrollHeight - sb.clientHeight,
    homeTop: h.top, sbTop: s.top, homeH: h.height,
    onTop: !!(mid && home.contains(mid)),
    shadow: getComputedStyle(home).boxShadow,
    bg: getComputedStyle(home).backgroundColor,
    labels: [...sb.querySelectorAll(':scope > .sb-section-label')].filter((l) => l.offsetParent).map((l) => Math.round(l.getBoundingClientRect().height * 10) / 10),
  };
});
const edgeOn = (shadow) => !!shadow && shadow !== 'none' && !/rgba\(0, 0, 0, 0\)|transparent/.test(shadow);

(async () => {
  const exe = process.env.PUPPETEER_EXECUTABLE_PATH;
  const { server, url } = await start(0);
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
  try {
    // ── rows ──────────────────────────────────────────────────────────────
    for (const w of [1300, 375]) {
      const p = await open(browser, url, { width: w });
      const r = await rows(p);
      info['default_' + w] = r;
      checks['defaultRowsAtMost3_' + w] = r.perRow.length === 4 && r.perRow.every((n) => n <= 3) && r.perRow[0] === 3;
      checks['defaultInside_' + w] = r.inside && !r.sideways;
      await shot(p, 'home_default_' + w, '#tabHome');
      await p.close();
    }
    {
      const p = await open(browser, url, { width: 1300, user: { layout: EIGHT } });
      const r = await rows(p);
      info.eight_1300 = r;
      checks.eightNoBreak5Across_1300 = r.perRow[0] >= 5;
      checks.eightAllOneRow_1300 = r.perRow.length === 1 && r.perRow[0] === 8;
      await shot(p, 'home_eight_1300', '#tabHome');
      // a placed logout shortcut opens the Log Out confirm — then cancel it
      await p.click('#tabHome .home-grid > [data-yc-shortcut="logout"]');
      await p.waitForSelector('.swal2-popup', { visible: true, timeout: 5000 });
      info.logoutTitle = await p.$eval('.swal2-title', (e) => e.textContent);
      checks.placedLogoutConfirms = info.logoutTitle === 'Log Out?';
      await p.click('.swal2-cancel');
      await sleep(400);
      checks.eightNoErrors = p.errors.length === 0;
      info.eightErrors = p.errors;
      await p.close();
    }
    {
      const p = await open(browser, url, { width: 375, user: { layout: EIGHT } });
      const r = await rows(p);
      info.eight_375 = r;
      checks.eightWrapsInside_375 = JSON.stringify(r.perRow) === '[3,3,2]' && r.inside && !r.sideways;
      await p.close();
    }

    // ── all ───────────────────────────────────────────────────────────────
    {
      const p = await open(browser, url, { width: 1300 });
      const a = await p.evaluate(() => {
        const b = document.getElementById('homeAll'), r = b.getBoundingClientRect();
        return { w: r.width, h: r.height, text: b.textContent.trim(), name: b.getAttribute('aria-label'), opacity: getComputedStyle(b).opacity };
      });
      info.homeAll = a;
      checks.allIconOnly = a.text === '' && a.name === 'All features' && a.w < 60 && a.h < 60;
      checks.allMuted = a.opacity === '0.45';
      await p.hover('#homeAll');
      await sleep(300);
      info.allHoverOpacity = await p.$eval('#homeAll', (b) => getComputedStyle(b).opacity);
      checks.allHoverFull = info.allHoverOpacity === '1';
      await p.click('#homeAll');
      await sleep(300);
      info.afterAllClick = await p.evaluate(() => currentMainTabId());
      checks.allOpensAll = info.afterAllClick === 'tabAll';
      checks.allNoErrors = p.errors.length === 0;
      await p.close();
    }

    // ── sticky ────────────────────────────────────────────────────────────
    for (const mode of ['wide', 'skinny']) {
      const p = await open(browser, url, { width: 1300, height: 600 });
      if (mode === 'skinny') { await p.evaluate(() => toggleSidebarSkinny()); await sleep(400); }
      // a couple of open files: the Open Files header and its list show
      await p.evaluate(() => {
        const of = document.getElementById('sbOpenFiles'); of.style.display = '';
        const list = document.getElementById('tabOpenFiles'); list.style.display = '';
        for (let i = 0; i < 2; i++) {
          const b = document.createElement('div'); b.className = 'file-button'; b.innerHTML = '<i class="fa-solid fa-file"></i><span>QA file ' + i + '</span>';
          list.appendChild(b);
        }
      });
      await p.evaluate(() => openMainTab('tabCases'));
      const top = await sidebarState(p);
      await p.evaluate(() => { const s = document.getElementById('appSidebar'); s.scrollTop = s.scrollHeight; });
      await sleep(300);
      const bottom = await sidebarState(p);
      info['sticky_' + mode] = { top, bottom };
      checks['sidebarTallerThanWindow_' + mode] = top.overflow > 50;
      checks['homePinned_' + mode] = bottom.scrollTop > 50 && Math.abs(bottom.homeTop - bottom.sbTop) < 0.6 && Math.abs(top.homeTop - top.sbTop) < 0.6;
      checks['homeOnTop_' + mode] = bottom.onTop;
      checks['homeOpaque_' + mode] = /^rgb\(/.test(bottom.bg);
      checks['edgeOnlyWhenScrolled_' + mode] = !edgeOn(top.shadow) && edgeOn(bottom.shadow);
      checks['labelsNotSquashed_' + mode] = mode === 'skinny' ? bottom.labels.length === 0
        : bottom.labels.length === 3 && JSON.stringify(bottom.labels) === JSON.stringify(top.labels) && bottom.labels.every((h) => h >= 28);
      await shot(p, 'sidebar_scrolled_' + mode + '_1300x600', '#appSidebar');
      // Home still works while pinned: a real click at its spot opens Home
      const h = await p.$('#appSidebar > .sb-item[data-tab="tabHome"]');
      await h.click();
      await sleep(200);
      checks['homeClickWhilePinned_' + mode] = (await p.evaluate(() => currentMainTabId())) === 'tabHome';
      // Open Files still toggles its list
      await p.evaluate(() => { document.getElementById('appSidebar').scrollTop = 0; });
      await sleep(200);
      await p.click('#sbOpenFiles');
      const collapsed = await p.evaluate(() => document.getElementById('tabOpenFiles').style.display === 'none');
      await p.click('#sbOpenFiles');
      const expanded = await p.evaluate(() => document.getElementById('tabOpenFiles').style.display === '');
      checks['openFilesToggles_' + mode] = collapsed && expanded;
      checks['stickyNoErrors_' + mode] = p.errors.length === 0;
      await p.close();
    }
    {
      // the phone drawer: Home pinned there too
      const p = await open(browser, url, { width: 375, height: 600 });
      await p.waitForFunction(() => !document.querySelector('.swal2-container'), { timeout: 5000 });
      await p.click('#appHeader .hdr-hamburger');
      await sleep(500);
      const top = await sidebarState(p);
      await p.evaluate(() => { const s = document.getElementById('appSidebar'); s.scrollTop = s.scrollHeight; });
      await sleep(300);
      const bottom = await sidebarState(p);
      info.sticky_drawer = { top, bottom };
      checks.drawerOpen = await p.evaluate(() => document.body.classList.contains('sidebar-mobile-open'));
      checks.drawerHomePinned = bottom.scrollTop > 50 && Math.abs(bottom.homeTop - bottom.sbTop) < 0.6 && bottom.onTop;
      checks.drawerLabelsNotSquashed = JSON.stringify(bottom.labels) === JSON.stringify(top.labels) && bottom.labels.every((x) => x >= 28);
      await shot(p, 'drawer_scrolled_375x600', '#appSidebar');
      const r = await rows(p);
      checks.drawerNoSideways = !r.sideways;
      checks.drawerNoErrors = p.errors.length === 0;
      await p.close();
    }
    const ok = Object.values(checks).every(Boolean);
    process.stdout.write(JSON.stringify({ ok, checks, info }) + '\n');
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, checks, info, error: String(err && err.stack || err) }) + '\n');
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
