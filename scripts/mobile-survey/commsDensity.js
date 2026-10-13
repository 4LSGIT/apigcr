#!/usr/bin/env node
// scripts/mobile-survey/commsDensity.js
//
// The Comms Email tab's DENSITY GATE (mailbox slice S2P, §D): boots the real
// shell on the mock origin (server.js, fixtures/api/mail/*), opens the Comms
// tab and MEASURES — in shell-viewport pixels, real Chromium — where the list
// and an opened email actually start, then ASSERTS the S2P targets (a script,
// not an eye):
//
//   viewport     first list row top   opened email body (iframe) top
//   1440×900     ≤ 239 (no regression)   ≤ 450      (baseline 2026-10-12: 793)
//   1280×800     ≤ 239                   ≤ 420      (baseline: 750)
//   390×844      ≤ 200 (filters closed)  ≤ 520      (baselines: 312 / 788)
//
// Exit 1 when a target is missed. Also captures the S2P screenshot set
// (list · opened thread with the ⋯ menu · the filters sheet · the Task modal
// · a reply with the Case field · the case picker over New message) at
// 1440 light AND dark, and GATES that picker being topmost; the 375/320 set
// rides the main survey (node scripts/mobile-survey/survey.js).
//
//   node scripts/mobile-survey/commsDensity.js [--out DIR]
//
// Needs Chrome/Chromium like survey.js (PUPPETEER_EXECUTABLE_PATH or the
// usual install locations).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { start, fakeJwt } = require('./server');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const OUT = arg('out', path.join(os.tmpdir(), 'yc-comms-density'));

const TARGETS = [
  { w: 1440, h: 900, rowTop: 239, bodyTop: 450 },
  { w: 1280, h: 800, rowTop: 239, bodyTop: 420 },
  { w: 390, h: 844, rowTop: 200, bodyTop: 520 },
];

function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
  ].filter(Boolean);
  const hit = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (!hit) { console.error('No Chrome found. Set PUPPETEER_EXECUTABLE_PATH.'); process.exit(2); }
  return hit;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMS_FRAME = `(() => {
  const t = [...document.querySelectorAll('.tab-main')].find(t => t.style.display === 'block');
  return t && [...t.querySelectorAll('iframe')].find(f => f.offsetParent && f.src);
})()`;

/** `sel`'s top edge inside `frame`, in SHELL viewport pixels. */
async function topOf(page, frame, sel) {
  const inFrame = await frame.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? el.getBoundingClientRect().top : null;
  }, sel);
  if (inFrame == null) return null;
  const frameTop = await page.evaluate((js) => {
    const f = eval(js);
    return f ? f.getBoundingClientRect().top : null;
  }, COMMS_FRAME);
  return frameTop == null ? null : Math.round(frameTop + inFrame);
}

async function openComms(browser, { w, h, theme }) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: w < 700, hasTouch: w < 700 });
  await page.evaluateOnNewDocument((jwt, th) => {
    try { localStorage.setItem('jwt', jwt); localStorage.setItem('yc-theme', th); } catch (_) {}
  }, fakeJwt(), theme);
  await page.goto(page.browser()._ycUrl + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.firmData && document.getElementById('appSidebar').style.display === 'flex', { timeout: 15000 });
  await page.evaluate(() => openMainTab('tabComms'));
  await sleep(1800);
  const frame = await (await page.evaluateHandle(COMMS_FRAME)).asElement().contentFrame();
  return { page, frame };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, url } = await start(0);
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
  browser._ycUrl = url;
  const rows = [];
  let failed = 0;

  try {
    // ── the measurements ──
    for (const t of TARGETS) {
      const { page, frame } = await openComms(browser, { ...t, theme: 'light' });
      const rowTop = await topOf(page, frame, '#msg-list .msg');
      await page.screenshot({ path: path.join(OUT, `density_${t.w}_list.png`) });

      // VERTICAL-CLIP gate (live defect 2026-10-13): with a LONG list, flex
      // shrink squashed the filter bar (overflow-x≠visible zeroes a flex
      // child's min-height floor) — chips rendered at half height, tops cut.
      // The overflow survey is horizontal-only and the density targets only
      // reward a shorter bar, so this asserts it directly: under 60 rows,
      // every child of the bar rows sits fully INSIDE its container.
      const clip = await frame.evaluate(() => {
        const base = state.messages.slice();
        const long = [];
        for (let i = 0; i < 15 && base.length; i++) {
          for (const m of base) long.push({ ...m, id: m.id + 1000 * (i + 1), message_id: `${m.message_id || 'x'}-${i}`, copies: (m.copies || []).map((c) => ({ ...c, id: m.id + 1000 * (i + 1) })) });
        }
        state.messages = long;
        renderList();
        const out = [];
        for (const el of [document.getElementById('fbar'), document.querySelector('.list-col .status-line'), document.querySelector('.list-col .bar')]) {
          if (!el || !el.offsetParent) continue;
          const r = el.getBoundingClientRect();
          const kids = [...el.children].filter((k) => k.getBoundingClientRect().height > 0);
          const clipped = kids.filter((k) => { const kr = k.getBoundingClientRect(); return kr.top < r.top - 0.5 || kr.bottom > r.bottom + 0.5; }).length;
          out.push({ el: el.id || el.className.split(' ')[0], h: Math.round(r.height), maxChild: Math.round(Math.max(0, ...kids.map((k) => k.getBoundingClientRect().height))), clipped });
        }
        state.messages = base;
        renderList();
        return out;
      });
      const clippedRows = clip.filter((c) => c.clipped > 0 || c.h + 0.5 < c.maxChild);
      if (clippedRows.length) { failed++; console.error(`${t.w}x${t.h} VERTICAL CLIP under a long list:`, JSON.stringify(clippedRows)); }

      await frame.evaluate(() => openMessage(state.messages[0]));
      await sleep(1200);
      const bodyTop = await topOf(page, frame, '.mcard:not(.collapsed) .mail-frame');
      const ok = rowTop != null && bodyTop != null && rowTop <= t.rowTop && bodyTop <= t.bodyTop && !clippedRows.length;
      if (!ok && !clippedRows.length) failed++;
      rows.push({ viewport: `${t.w}x${t.h}`, rowTop, rowTarget: t.rowTop, bodyTop, bodyTarget: t.bodyTop, clip: clippedRows.length ? 'CLIPPED' : 'ok', ok });
      await page.screenshot({ path: path.join(OUT, `density_${t.w}_thread.png`) });
      await page.close();
    }

    // ── the screenshot set at 1440, light and dark ──
    for (const theme of ['light', 'dark']) {
      const { page, frame } = await openComms(browser, { w: 1440, h: 900, theme });
      const shot = (k) => page.screenshot({ path: path.join(OUT, `1440_${theme}_${k}.png`) });
      await shot('list');
      await frame.evaluate(() => openMessage(state.messages[0]));
      await sleep(1200);
      await frame.evaluate(() => document.querySelector('.mcard .menu-btn').click());
      await sleep(300);
      await shot('thread_menu');
      await frame.evaluate(() => { closeMenu(); E('fbar-btn').click(); }); // no-op visually at 1440 (the bar shows); kept for parity
      await sleep(200);
      await shot('filters');
      await frame.evaluate(() => openTaskModal(state.thread.messages.find((m) => m.id === 301)));
      await sleep(400);
      await shot('task');
      await frame.evaluate(() => { closeTaskModal(); return openReply(state.thread.messages.find((m) => m.id === 301), false); });
      await sleep(1000);
      await shot('reply_case');

      // STACKING gate (live defect 2026-10-13): the case picker opened from
      // the New message modal's Case field rendered BEHIND the composer (two
      // .modal-backdrop at one z-index; the later DOM node wins). Replies are
      // inline, so the reply_case shot above never saw it. Assert the real
      // engine's hit test: the picker's own box is topmost where it is drawn.
      await frame.evaluate(() => { const c = state.composer; if (c) closeComposer(c, { keepDraft: false }); return openCompose(); });
      await sleep(600);
      const stack = await frame.evaluate(() => {
        const pick = document.querySelector('#compose-slot .case-row button.linkish');
        if (!pick) return { err: 'no Pick a case… button in the New message composer' };
        pick.click();
        const bd = document.getElementById('case-backdrop');
        const r = bd.querySelector('.modal').getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
        return { open: bd.classList.contains('open'), composerOpen: document.getElementById('compose-backdrop').classList.contains('open'), onTop: !!(hit && hit.closest('#case-backdrop')) };
      });
      await sleep(200);
      await shot('new_case_picker');
      if (stack.err || !stack.open || !stack.composerOpen || !stack.onTop) { failed++; console.error(`1440 ${theme} CASE PICKER NOT ON TOP of the New message modal:`, JSON.stringify(stack)); }
      else console.log(`1440 ${theme} case picker over New message: on top`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.table(rows);
  fs.writeFileSync(path.join(OUT, 'density.json'), JSON.stringify(rows, null, 1));
  console.log(`${failed ? 'FAIL' : 'ok'} — screenshots + density.json: ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
