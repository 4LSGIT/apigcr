#!/usr/bin/env node
// scripts/mobile-survey/manualOrdinals.js
//
// Whole-corpus check that the manual's search and its viewer count headings
// the same way (manuals-ui S3). GET /manual/search returns a hit's
// `headingIndex` — its ordinal among the chapter's h1..h6, counted by the
// server's own markdown parser (routes/manuals.js parseChapter). The viewer
// (public/manuals.html) resolves that ordinal against the h1..h6 that marked,
// loaded from a CDN pin, actually rendered. If the two ever disagree, a search
// result lands on the wrong heading — silently.
//
// For every chapter in manual/ it:
//   1. compares the server's heading list (text + order) with the rendered
//      h1..h6 textContent (the permalink "#" removed), and
//   2. opens three hits (first, middle, last heading) through the real router
//      and checks each lands on that heading's id, scrolled into place.
//
// Boots the survey's mock origin (server.js — the real routes/manuals.js) and
// the real shell, like survey.js. Prints one summary line; exit 1 on any
// mismatch or page error, 2 if it could not run.
//
//   node scripts/mobile-survey/manualOrdinals.js
//
// Run it after bumping the marked pin in manuals.html, or after changing the
// heading parser in routes/manuals.js. Chrome: as survey.js
// (PUPPETEER_EXECUTABLE_PATH, else the usual install paths). No screenshots.

'use strict';

const fs        = require('fs');
const path      = require('path');
const Module    = require('module');
const puppeteer = require('puppeteer-core');
const { start, fakeJwt } = require('./server');

const ROOT = path.join(__dirname, '..', '..');

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

/** The route's parser, its one outside dependency (auth) stubbed for the
 *  require only — same scoped require.cache seed as server.js. */
function parseChapter() {
  const authPath   = require.resolve(path.join(ROOT, 'lib', 'auth.jwtOrApiKey'));
  const routerPath = require.resolve(path.join(ROOT, 'routes', 'manuals'));
  const prevAuth = require.cache[authPath];
  const stub = new Module(authPath);
  stub.filename = authPath; stub.loaded = true; stub.exports = (req, res, next) => next();
  require.cache[authPath] = stub;
  try { return require(routerPath).helpers.parseChapter; }
  finally { if (prevAuth) require.cache[authPath] = prevAuth; else delete require.cache[authPath]; }
}

const settle = (fr) => fr.waitForFunction(() => !document.querySelector('#content .state-msg'), { timeout: 15000 }).catch(() => {});

(async () => {
  const parse = parseChapter();
  const { server, url } = await start(0);
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
  const problems = [];
  const errors = [];
  let chapters = 0, headings = 0, hits = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument((jwt) => { try { localStorage.setItem('jwt', jwt); } catch (_) { } }, fakeJwt());
    page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 160)));
    await page.goto(url + '/', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.firmData && document.getElementById('appSidebar').style.display === 'flex', { timeout: 15000 });
    await page.evaluate(() => {
      const tile = document.querySelector('[data-target="manualsDiv"]');
      const hub = tile.closest('.tab-main').id;
      openMainTab(hub);
      const t = E(hub); if (t.classList.contains('drill-active')) exitDrillMode(t);
      tile.click();
    });
    await sleep(1500);
    const fr = await (await page.evaluateHandle(() => document.querySelector('#manualsDiv iframe'))).asElement().contentFrame();
    await fr.waitForFunction(() => typeof manualsLoad === 'function' && typeof hitHash === 'function', { timeout: 15000 });

    const sections = await fr.evaluate(async () => (await window.parent.apiSend('/manual', 'GET')).sections.map((s) => s.slug));
    for (const sec of sections) {
      const files = await fr.evaluate(async (s) => (await window.parent.apiSend('/manual/' + s, 'GET')).files.map((f) => f.slug), sec);
      for (const file of files) {
        chapters++;
        const md = fs.readFileSync(path.join(ROOT, 'manual', sec, file + '.md'), 'utf8');
        const server = parse(md).headings.map((h) => h.text.replace(/\s+/g, ' ').trim());
        await fr.evaluate((s, f) => manualsLoad(s, f), sec, file);
        await settle(fr);
        const dom = await fr.evaluate(() => [...document.querySelectorAll('#md-body :is(h1,h2,h3,h4,h5,h6)')].map((h) => {
          const c = h.cloneNode(true);
          c.querySelectorAll('.hd-link').forEach((a) => a.remove());
          return c.textContent.replace(/\s+/g, ' ').trim();
        }));
        headings += dom.length;
        for (let i = 0; i < Math.max(dom.length, server.length); i++) {
          if (server[i] !== dom[i]) {
            problems.push(`${sec}/${file} heading ${i}: server ${JSON.stringify(server[i] ?? null)} vs rendered ${JSON.stringify(dom[i] ?? null)}`);
            break;   // everything after the first slip is shifted anyway
          }
        }
        for (const i of [...new Set([0, Math.floor(dom.length / 2), dom.length - 1])].filter((n) => n >= 0)) {
          const r = await fr.evaluate(async (s, f, n) => {
            await go(hitHash(s, f, n, 'the'));
            const h = document.querySelectorAll('#md-body :is(h1,h2,h3,h4,h5,h6)')[n];
            const c = document.getElementById('content');
            return {
              hash: decodeURIComponent(location.hash),
              want: '#/' + s + '/' + f + (h && h.id ? '/' + h.id : ''),
              top: h ? Math.round(h.getBoundingClientRect().top - c.getBoundingClientRect().top) : null,
              atEnd: c.scrollTop + c.clientHeight >= c.scrollHeight - 2,
            };
          }, sec, file, i);
          hits++;
          if (r.hash !== r.want) problems.push(`${sec}/${file} hit ~${i}: landed on ${r.hash}, want ${r.want}`);
          // 16px = ANCHOR_GAP in manuals.html; a heading near the end can't scroll that far
          else if (r.top !== null && !(Math.abs(r.top - 16) <= 2 || (r.atEnd && r.top >= 0))) problems.push(`${sec}/${file} hit ~${i}: heading at ${r.top}px, not scrolled to`);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  for (const p of problems) console.log('  ' + p);
  for (const e of [...new Set(errors)]) console.log('  ! ' + e);
  const ok = !problems.length && !errors.length && chapters > 0;
  console.log(`${ok ? 'GO' : 'NO-GO'}  manual ordinals: ${chapters} chapters, ${headings} rendered headings, ${hits} hit landings, ${problems.length} mismatches, ${errors.length} page errors`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
