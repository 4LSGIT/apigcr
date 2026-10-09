// tests/helpers/mailRenderBrowser.js
//
// Real-Chrome proof for public/js/mailRender.js, run as a CLEAN NODE
// SUBPROCESS by tests/mailboxS2.renderBrowser.test.js — NOT a jest test itself
// (puppeteer-core is ESM-only; see tests/helpers/renderSmoke.js for why a
// child process is the faithful way to load it).
//
// What it proves — that each layer stops a LIVE payload ON ITS OWN in a real
// engine (jsdom enforces neither sandbox nor CSP):
//   A  control         raw mail, no layer at all     → the script runs and both
//                                                       tracker requests land
//                                                       (the payload is live)
//   B  sanitizer only  sanitize(), no sandbox/CSP    → no script, no request
//   C  sandbox only    raw mail, SANDBOX attr only   → no script
//   D  CSP only        raw mail, CSP <meta> only     → no script, no request
//   E  all three       createFrame()                 → no script, no request
//   F  "Show images"   createFrame({allowRemote})    → the image request lands
//                                                       (remote mode works),
//                                                       still no script
//
// Contract: prints ONE JSON line { ok, checks, hits, error? }; exit 0 iff all
// checks pass. Requires PUPPETEER_EXECUTABLE_PATH.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const PURIFY = fs.readFileSync(path.join(ROOT, 'public/js/vendor/purify-3.4.16.min.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/js/mailRender.js'), 'utf8');

const hits = [];

function payload(origin, tag) {
  return `<html><head><style>.bg{background:url(${origin}/track/${tag}-css)}</style></head><body>
<script>try { parent.__pwned = parent.__pwned || []; parent.__pwned.push('${tag}'); } catch (e) {}
try { parent.postMessage('script:${tag}', '*'); } catch (e) {}</script>
<img src="${origin}/track/${tag}-img" alt="">
<img src="x-${tag}" onerror="parent.postMessage('onerror:${tag}', '*')">
<div class="bg">styled</div><p>Hello from ${tag}</p></body></html>`;
}

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script>${PURIFY}</script><script>${RENDER}</script>
<script>
  window.__pwned = [];
  window.__messages = [];
  window.addEventListener('message', (e) => window.__messages.push(String(e.data)));
  window.mount = (tag, how, raw) => {
    const R = window.YCMailRender;
    let frame;
    if (how === 'full' || how === 'remote') {
      frame = R.createFrame(document, { body_html: raw }, { allowRemote: how === 'remote' }).frame;
    } else {
      frame = document.createElement('iframe');
      if (how === 'sandbox') frame.setAttribute('sandbox', R.SANDBOX);
      const body = how === 'sanitize' ? R.sanitize(raw, {}).html : raw;
      frame.srcdoc = how === 'csp' ? R.buildSrcdoc(raw, {}) : '<!DOCTYPE html><html><head></head><body>' + body + '</body></html>';
    }
    frame.id = 'f-' + tag;
    document.body.appendChild(frame);
  };
</script></body></html>`;

(async () => {
  const checks = {};
  let browser;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/track/')) {
      hits.push(req.url.slice(7));
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
      return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(origin + '/', { waitUntil: 'load' });
    const plan = [['A', 'none'], ['B', 'sanitize'], ['C', 'sandbox'], ['D', 'csp'], ['E', 'full'], ['F', 'remote']];
    for (const [tag, how] of plan) {
      await page.evaluate((t, h, raw) => window.mount(t, h, raw), tag, how, payload(origin, tag));
    }
    await new Promise((r) => setTimeout(r, 2500));
    const st = await page.evaluate(() => ({ pwned: window.__pwned, messages: window.__messages, title: document.title }));
    const ran = (t) => st.pwned.includes(t) || st.messages.some((m) => m.endsWith(':' + t));
    const hit = (t, kind) => hits.includes(`${t}-${kind}`);

    checks.controlScriptRuns = ran('A');
    checks.controlImageLoads = hit('A', 'img');
    checks.controlCssLoads = hit('A', 'css');
    checks.sanitizeAloneStopsScript = !ran('B');
    checks.sanitizeAloneStopsRequests = !hit('B', 'img') && !hit('B', 'css');
    checks.sandboxAloneStopsScript = !ran('C');
    checks.cspAloneStopsScript = !ran('D');
    checks.cspAloneStopsRequests = !hit('D', 'img') && !hit('D', 'css');
    checks.fullStackStopsAll = !ran('E') && !hit('E', 'img') && !hit('E', 'css');
    checks.showImagesLoadsImages = hit('F', 'img');
    checks.showImagesStillNoScript = !ran('F');
    const ok = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ ok, checks, hits: hits.sort() }));
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, checks, hits, error: `${err.code || ''} ${err.message}` }));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
})();
