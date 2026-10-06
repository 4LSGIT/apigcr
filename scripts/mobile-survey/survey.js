#!/usr/bin/env node
// scripts/mobile-survey/survey.js
//
// Boots the REAL shell (public/index.html) against the mock origin in
// server.js, at phone widths, and walks every surface it hosts:
//
//   tabs     every sidebar tab
//   panels   every More Features / Admin panel ([data-target] tiles)
//   files    a case file and a contact file, every one of their tabs
//   dialogs  the shell-level form dialogs (new client/case/appt/event, …)
//
// For each one it records HORIZONTAL OVERFLOW — the shell document, the pane
// document, any visible nested frame, and an open SweetAlert popup — plus a
// screenshot and any page errors. Exit code 1 if anything overflows, so it can
// gate a UI change. It does NOT judge looks; read the screenshots for that.
//
//   node scripts/mobile-survey/survey.js [options]
//     --widths 320,375,414   viewport widths (default 375)
//     --only tabs,panels,files,dialogs
//     --out DIR              screenshots + report.json (default
//                            $TMPDIR/yc-mobile-survey)
//     --fail-on-errors       page errors also fail the run
//
// Needs Chrome/Chromium: PUPPETEER_EXECUTABLE_PATH, else the usual install
// locations (see findChrome). puppeteer-core is already a dependency.

'use strict';

const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const puppeteer = require('puppeteer-core');
const { start, fakeJwt } = require('./server');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const WIDTHS = String(arg('widths', '375')).split(',').map(Number).filter(Boolean);
const ONLY   = new Set(String(arg('only', 'tabs,panels,files,dialogs')).split(','));
const OUT    = arg('out', path.join(os.tmpdir(), 'yc-mobile-survey'));
const FAIL_ON_ERRORS = !!arg('fail-on-errors', false);

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

// ── measurement (runs inside a document) ───────────────────────────────────
// docW > clientW means the document scrolls sideways. The offenders are the
// OUTERMOST elements past the right edge — anything inside a scroll box (or
// already counted through its parent) is skipped, so the list names the
// element to fix rather than its 200 descendants.
function measureDoc() {
  const w = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if ((!r.width && !r.height) || r.right <= w + 1) continue;
    let a = el.parentElement, skip = false;
    while (a && a !== document.body) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(a).overflowX)) { skip = true; break; }
      if (a.getBoundingClientRect().right > w + 1) { skip = true; break; }
      a = a.parentElement;
    }
    if (skip) continue;
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
    offenders.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls} (${Math.round(r.width)}px)`);
  }
  return { docW: document.documentElement.scrollWidth, clientW: w, offenders: offenders.slice(0, 6) };
}

// Three ways a dialog overflows: the card itself is off-screen; something
// pokes out of the card (swal2 lets overflow show); or the content box scrolls
// sideways — .swal2-html-container is overflow:auto, so a too-wide field is
// CONTAINED there and the card's own scrollWidth never sees it.
function measurePopup() {
  const p = document.querySelector('.swal2-popup');
  if (!p) return null;
  const vw = innerWidth, r = p.getBoundingClientRect();
  const hc = p.querySelector('.swal2-html-container');
  const poking = [...p.querySelectorAll('*')].filter((el) => {
    const b = el.getBoundingClientRect();
    return (b.width || b.height) && getComputedStyle(el).visibility !== 'hidden' && b.right > r.right + 1;
  }).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')).slice(0, 4);
  return {
    popupW: Math.round(r.width), offScreen: r.right > vw + 1 || r.left < -1, poking,
    contentScroll: hc ? hc.scrollWidth > hc.clientWidth + 1 : false,
  };
}

// ── surface walkers ─────────────────────────────────────────────────────────
async function frameOf(page, js) {
  const h = await page.evaluateHandle(js);
  const el = h.asElement();
  return el ? el.contentFrame() : null;
}

async function measure(page, frame) {
  const m = { shell: await page.evaluate(measureDoc) };
  if (frame) {
    m.pane = await frame.evaluate(measureDoc);
    m.nested = [];
    for (const cf of frame.childFrames()) {
      try {
        const fe = await cf.frameElement();
        if (!fe || !(await fe.isVisible())) continue;
        m.nested.push({ src: cf.url().replace(/^https?:\/\/[^/]+/, ''), ...(await cf.evaluate(measureDoc)) });
      } catch (_) { /* detached mid-walk */ }
    }
  }
  const owner = frame || page;
  m.popup = await owner.evaluate(measurePopup).catch(() => null);
  return m;
}

function overflowOf(m) {
  const bad = [];
  if (m.shell.docW > m.shell.clientW) bad.push(`shell ${m.shell.docW}/${m.shell.clientW} ${m.shell.offenders.join(', ')}`);
  if (m.pane && m.pane.docW > m.pane.clientW) bad.push(`pane ${m.pane.docW}/${m.pane.clientW} ${m.pane.offenders.join(', ')}`);
  for (const n of m.nested || []) if (n.docW > n.clientW) bad.push(`nested ${n.src} ${n.docW}/${n.clientW} ${n.offenders.join(', ')}`);
  if (m.popup && (m.popup.offScreen || m.popup.contentScroll || m.popup.poking.length)) {
    bad.push(`popup${m.popup.offScreen ? ' off-screen' : ''}${m.popup.contentScroll ? ' content-scrolls-sideways' : ''}${m.popup.poking.length ? ' poking: ' + m.popup.poking.join(', ') : ''}`);
  }
  return bad;
}

const VISIBLE_TAB_FRAME = `(() => {
  const t = [...document.querySelectorAll('.tab-main')].find(t => t.style.display === 'block');
  return t && [...t.querySelectorAll('iframe')].find(f => f.offsetParent && f.src);
})()`;

async function walk(page, W, record) {
  const shot = async (key) => {
    const file = path.join(OUT, `${W}_${key.replace(/[^\w.-]+/g, '_')}.png`);
    await page.screenshot({ path: file });
    return file;
  };

  if (ONLY.has('tabs')) {
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#appSidebar [data-tab]')].map((e) => e.dataset.tab));
    for (const t of tabs) {
      await page.evaluate((t) => openMainTab(t), t); await sleep(1500);
      await record(`tab:${t}`, await measure(page, await frameOf(page, VISIBLE_TAB_FRAME)), await shot('tab_' + t));
    }
  }

  if (ONLY.has('panels')) {
    const panels = await page.evaluate(() => [...document.querySelectorAll('#tabMore > [data-target], #tabAdmin > [data-target]')]
      .map((b) => ({ id: b.dataset.target, hub: b.closest('.tab-main').id })));
    for (const { id, hub } of panels) {
      await page.evaluate((hub) => { openMainTab(hub); const t = E(hub); if (t.classList.contains('drill-active')) exitDrillMode(t); }, hub);
      await page.evaluate((id) => document.querySelector(`[data-target="${id}"]`).click(), id); await sleep(2000);
      const fr = await frameOf(page, `document.querySelector('#${id} iframe')`);
      await record(`panel:${id}`, await measure(page, fr), await shot('panel_' + id));
    }
  }

  if (ONLY.has('files')) {
    for (const [kind, label, id] of [['case', '26-99999', 'TESTCASE1'], ['client', 'Jane Testcase', '9001']]) {
      await page.evaluate((k, l, i) => addFile(l, k, i), kind, label, id); await sleep(3000);
      const fr = await frameOf(page, VISIBLE_TAB_FRAME);
      await fr.evaluate(() => window.Swal && Swal.close());
      const tabs = await fr.evaluate(() => [...document.querySelectorAll('.tab')].filter((t) => t.offsetParent)
        .map((t, i) => ({ i, text: t.textContent.trim().replace(/\s+/g, ' ') })));
      for (const t of tabs) {
        if (t.text === 'Refresh') continue;           // opens a reload confirm
        await fr.evaluate((i) => [...document.querySelectorAll('.tab')].filter((t) => t.offsetParent)[i].click(), t.i);
        await sleep(1800);
        await fr.evaluate(() => window.Swal && Swal.close());
        await record(`${kind}:${t.text}`, await measure(page, fr), await shot(`${kind}_${t.i}_${t.text}`));
      }
    }
  }

  if (ONLY.has('dialogs')) {
    const DIALOGS = [
      ['new-client', 'newContact()'],
      ['new-case', 'NewCaseForm()'],
      ['new-appt', 'newApptDialog({ contactPick: true, casePick: true })'],
      ['new-event', 'newEventDialog({ linkPick: true })'],
      ['reschedule', "apptUpdate(7000, 'Reschedule', '2026-10-07T10:00')"],
      ['appt-calendar', 'tabApptsCal()'],
      ['show-appt', 'showAppt(7000)'],
    ];
    for (const [key, js] of DIALOGS) {
      await page.evaluate(() => Swal.close()); await sleep(300);
      await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error(e); } }, js); await sleep(1800);
      const fr = await frameOf(page, `document.querySelector('.swal2-popup iframe')`);
      await record(`dialog:${key}`, await measure(page, fr), await shot('dialog_' + key));
    }
    await page.evaluate(() => Swal.close());
  }
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, url } = await start(0);
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
  const report = [];
  let overflowCount = 0, errorCount = 0;

  try {
    for (const W of WIDTHS) {
      const page = await browser.newPage();
      await page.setViewport({ width: W, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.evaluateOnNewDocument((jwt) => { try { localStorage.setItem('jwt', jwt); } catch (_) { } }, fakeJwt());
      let errors = [];
      page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 160)));
      await page.goto(url + '/', { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => window.firmData && document.getElementById('appSidebar').style.display === 'flex', { timeout: 15000 });

      await walk(page, W, async (key, m, shotFile) => {
        const bad = overflowOf(m);
        const errs = [...new Set(errors)]; errors = [];
        overflowCount += bad.length ? 1 : 0;
        errorCount += errs.length ? 1 : 0;
        report.push({ width: W, surface: key, overflow: bad, errors: errs, screenshot: shotFile });
        const tag = bad.length ? 'OVERFLOW' : (errs.length ? 'errors  ' : 'ok      ');
        console.log(`${W}  ${tag}  ${key}${bad.length ? '\n          ' + bad.join('\n          ') : ''}${errs.length ? '\n          ! ' + errs.join('\n          ! ') : ''}`);
      });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`\n${report.length} surfaces, ${overflowCount} overflowing, ${errorCount} with page errors.  Screenshots + report.json: ${OUT}`);
  process.exit(overflowCount || (FAIL_ON_ERRORS && errorCount) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
