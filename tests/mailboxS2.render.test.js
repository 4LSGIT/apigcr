/**
 * @jest-environment node
 *
 * tests/mailboxS2.render.test.js — hostile mail HTML (public/js/mailRender.js)
 * Mailbox-system arc, slice S2. Run: npx jest tests/mailboxS2.render.test.js
 *
 * The REAL vendored DOMPurify (public/js/vendor/purify-3.4.16.min.js) and the
 * REAL renderer load into jsdom as classic scripts — nothing stubbed.
 *
 * THREE LAYERS, EACH SHOWN TO BITE ALONE. Each layer has a check that answers
 * "does this layer hold?" for a hostile message. Every check is run twice:
 * against the shipped renderer (must hold) and against a copy of the renderer
 * with exactly that layer cut out by an anchored source edit (must NOT hold).
 * A check that passes on the mutant is not a gate, so the mutant runs are
 * part of the suite, not a one-off:
 *   1. sanitize   purify.sanitize → identity          scripts/handlers survive
 *   2. sandbox    the sandbox setAttribute deleted      frame has no sandbox
 *   3. remote     the afterSanitizeAttributes hook off  remote URLs survive
 *   (+ CSP)       the CSP <meta> deleted                srcdoc has no policy
 * jsdom enforces neither sandbox nor CSP; tests/mailboxS2.renderBrowser.test.js
 * (gated on PUPPETEER_EXECUTABLE_PATH) proves in real Chrome that each of
 * sanitize / sandbox / CSP stops the payload ON ITS OWN.
 *
 * SINKS. comms.html and mailRender.js are grepped: no innerHTML / outerHTML /
 * insertAdjacentHTML / document.write anywhere; `srcdoc` is assigned in
 * exactly one place.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PURIFY_PATH = path.join(ROOT, 'public/js/vendor/purify-3.4.16.min.js');
const PURIFY = fs.readFileSync(PURIFY_PATH, 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/js/mailRender.js'), 'utf8');
const COMMS = fs.readFileSync(path.join(ROOT, 'public/comms.html'), 'utf8');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });

function load(renderSrc = RENDER) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const w = dom.window;
  for (const src of [PURIFY, renderSrc]) {
    const s = w.document.createElement('script');
    s.textContent = src;
    w.document.head.appendChild(s);
  }
  if (!w.YCMailRender) throw new Error('renderer did not load');
  return w;
}

/** Cut one layer out of the renderer (anchored: the edit must apply exactly once). */
function mutant(old, neu) {
  const n = RENDER.split(old).length - 1;
  if (n !== 1) throw new Error(`mutation anchor matched ${n} times: ${old.slice(0, 60)}`);
  return RENDER.replace(old, neu);
}

const HOSTILE = `<html><head>
<style>@import url(https://evil.test/x.css); body{background:url('https://t.test/body.gif')}
.a{background-image:image-set("https://t.test/set.png" 1x)} .b{background:url(cid:bg@x)}</style>
<meta http-equiv="refresh" content="0;url=https://evil.test"><link rel="stylesheet" href="https://evil.test/l.css">
<base href="https://evil.test/"></head>
<body onload="parent.pwned=1">
<script>parent.pwned=1</script>
<img src="https://track.test/pixel.gif?r=opposing" onerror="parent.pwned=1">
<img src="//track.test/proto-relative.gif"><img src="/api/log"><img src="relative.png">
<img srcset="https://t.test/1.png 1x, https://t.test/2.png 2x"><img src="cid:logo@sender">
<img src="data:image/png;base64,iVBORw0KGgo=">
<a href="javascript:parent.pwned=1">js</a><a href="https://ok.test/doc" target="_top">ok</a>
<a href="/api/cases">rel</a><a href="#frag">frag</a><a href="mailto:x@y.test">mail</a>
<table background="https://t.test/bg.png"><tr><td style="background:url(https://t.test/td.png);color:red">x</td></tr></table>
<video poster="https://t.test/poster.png" src="https://t.test/v.mp4"></video>
<form action="https://phish.test"><input name="pw" type="password"><button formaction="https://phish.test">Go</button></form>
<svg><image href="https://t.test/svg.png"/></svg><iframe src="https://evil.test/frame"></iframe>
<object data="https://evil.test/o"></object><embed src="https://evil.test/e">
<p style="color:green" data-x="1">plain paragraph</p></body></html>`;

const REMOTE_URL = /(https?:)?\/\/(t|track|evil|phish)\.test/;

// ── The layer checks: true = the layer holds ───────────────────────────────

/** 1. Sanitizer: nothing executable survives. */
function sanitizerHolds(w) {
  const out = w.YCMailRender.sanitize(HOSTILE, {}).html;
  return !/<script/i.test(out) && !/\son\w+\s*=/i.test(out) && !/javascript:/i.test(out) &&
    !/<(form|input|button|iframe|object|embed|svg|meta|link|base)\b/i.test(out);
}

/** 2. Sandbox: the frame carries the sandbox, with no script / same-origin. */
function sandboxHolds(w) {
  const { frame } = w.YCMailRender.createFrame(w.document, { body_html: HOSTILE }, {});
  if (!frame.hasAttribute('sandbox')) return false;
  const toks = frame.getAttribute('sandbox').split(/\s+/);
  return !toks.includes('allow-scripts') && !toks.includes('allow-same-origin') && !toks.includes('allow-forms') &&
    !toks.includes('allow-top-navigation');
}

/** 3. Remote strip: no remote / relative load URL survives sanitizing (blocked mode). */
function remoteStripHolds(w) {
  const { html, blocked } = w.YCMailRender.sanitize(HOSTILE, {});
  const doc = new w.DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('*')) {
    for (const a of ['src', 'srcset', 'background', 'poster']) {
      const v = el.getAttribute(a);
      if (v != null && !/^data:/i.test(v.trim())) return false;
    }
    const st = el.getAttribute('style');
    if (st && /url\(\s*['"]?\s*(?!data:)/i.test(st)) return false;
  }
  for (const s of doc.querySelectorAll('style')) {
    if (/@import|url\(\s*['"]?\s*(?!data:)|image-set\(\s*['"]?\s*(https?:)?\/\//i.test(s.textContent)) return false;
  }
  return !REMOTE_URL.test(html.replace(/href="https:\/\/ok\.test\/doc"/, '')) && blocked.remote > 0;
}

/** CSP: the srcdoc's first <head> element is the blocking policy. */
function cspHolds(w) {
  const { frame } = w.YCMailRender.createFrame(w.document, { body_html: HOSTILE }, {});
  const doc = new w.DOMParser().parseFromString(frame.srcdoc, 'text/html');
  const first = doc.head.firstElementChild;
  if (!first || first.tagName !== 'META' || first.getAttribute('http-equiv') !== 'Content-Security-Policy') return false;
  const csp = first.getAttribute('content');
  return /default-src 'none'/.test(csp) && /img-src data:;/.test(csp) && !/img-src[^;]*https?:/.test(csp);
}

describe('each layer holds on the shipped renderer — and its check bites when that layer is cut out', () => {
  const LAYERS = [
    ['sanitize', sanitizerHolds,
      "clean = purify.sanitize(String(html == null ? '' : html), {",
      "clean = (function (x) { return x; })(String(html == null ? '' : html), {"],
    ['sandbox', sandboxHolds,
      "    frame.setAttribute('sandbox', SANDBOX);\n", ''],
    ['remote strip', remoteStripHolds,
      "purify.addHook('afterSanitizeAttributes', function (node) {",
      "(function () {})('afterSanitizeAttributes', function (node) {"],
    ['CSP', cspHolds,
      "'<meta http-equiv=\"Content-Security-Policy\" content=\"' + (opts.allowRemote ? CSP_REMOTE : CSP_BLOCKED) + '\">' +", ''],
  ];
  test.each(LAYERS)('%s', (_name, holds, old, neu) => {
    expect(holds(load())).toBe(true);
    expect(holds(load(mutant(old, neu)))).toBe(false);
  });

  test('a SANDBOX that grows allow-scripts / allow-same-origin refuses to render', () => {
    for (const bad of ['allow-scripts', 'allow-same-origin']) {
      const w = load(mutant("var SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';",
        `var SANDBOX = 'allow-popups allow-popups-to-escape-sandbox ${bad}';`));
      expect(() => w.YCMailRender.createFrame(w.document, { body_html: '<p>x</p>' }, {})).toThrow(new RegExp(bad));
    }
  });
});

describe('sanitizer detail', () => {
  test('links: absolute web / mail only, always a new tab without opener or referrer', () => {
    const w = load();
    const doc = new w.DOMParser().parseFromString(w.YCMailRender.sanitize(HOSTILE, {}).html, 'text/html');
    const links = [...doc.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]);
    expect(links).toEqual([
      ['js', null, null, null],
      ['ok', 'https://ok.test/doc', '_blank', 'noopener noreferrer'],
      ['rel', null, null, null],
      ['frag', null, null, null],
      ['mail', 'mailto:x@y.test', '_blank', 'noopener noreferrer'],
    ]);
  });

  test('blocked elements are marked; counts split remote vs inline (cid)', () => {
    const w = load();
    const r = w.YCMailRender.sanitize(HOSTILE, {});
    expect(r.blocked.inline).toBe(2); // <img src=cid:…> and url(cid:…)
    expect(r.blocked.remote).toBeGreaterThanOrEqual(10);
    const doc = new w.DOMParser().parseFromString(r.html, 'text/html');
    expect(doc.querySelectorAll('img[data-yc-blocked="remote"]').length).toBe(4); // https, //, /api, relative
    expect(doc.querySelectorAll('img[data-yc-blocked="inline"]').length).toBe(1);
    expect(doc.querySelector('img[src^="data:image/png"]')).not.toBeNull(); // self-contained data: kept
    expect(doc.querySelector('p').getAttribute('style')).toBe('color:green');
    expect(doc.querySelector('p').hasAttribute('data-x')).toBe(false);
  });

  test('"Show images": http(s) images allowed; @import, relative and unresolved cid still not', () => {
    const w = load();
    const r = w.YCMailRender.sanitize(HOSTILE, { allowRemote: true, cidMap: { 'logo@sender': 'data:image/png;base64,AAAA' } });
    const doc = new w.DOMParser().parseFromString(r.html, 'text/html');
    const srcs = [...doc.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual(expect.arrayContaining([
      'https://track.test/pixel.gif?r=opposing', '//track.test/proto-relative.gif', 'data:image/png;base64,AAAA',
    ]));
    expect(srcs).not.toContain('/api/log');
    expect(srcs).not.toContain('relative.png');
    expect(r.html).not.toMatch(/@import/);
    expect(r.html).not.toMatch(/<script/i);
  });

  test('cid: URLs resolve URL-encoded and case-insensitively (RFC 2392)', () => {
    const w = load();
    const r = w.YCMailRender.sanitize('<img src="cid:Logo%40Sender.Test"><img src="CID:<logo@sender.test>">', { cidMap: { 'logo@sender.test': 'data:image/png;base64,AAAA' } });
    const doc = new w.DOMParser().parseFromString(r.html, 'text/html');
    expect([...doc.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA']);
    expect(r.blocked.inline).toBe(0);
  });

  test('a cidMap entry that is not a data:image URL is ignored', () => {
    const w = load();
    const r = w.YCMailRender.sanitize('<img src="cid:a@b">', { cidMap: { 'a@b': 'https://evil.test/x.png' } });
    expect(r.html).not.toMatch(/evil/);
    expect(r.blocked.inline).toBe(1);
  });

  test('a url( the parser cannot split is still neutralized when blocking', () => {
    const w = load();
    const css = w.YCMailRender.scrubCss('a{background:url("https://t.test/a)b.png")}', false, { remote: 0, inline: 0 });
    expect(css).not.toMatch(/url\(/);
  });

  test('text mode escapes; a message with no HTML renders its text', () => {
    const w = load();
    const { frame, mode } = w.YCMailRender.createFrame(w.document, { body_html: null, body_text: '<script>x</script> & <b>' }, {});
    expect(mode).toBe('text');
    expect(frame.srcdoc).toContain('<pre>&lt;script&gt;x&lt;/script&gt; &amp; &lt;b&gt;</pre>');
    expect(frame.srcdoc).not.toContain('<script>x');
  });

  test('createFrame does not insert the frame, sets the sandbox before srcdoc, and estimates a bounded height', () => {
    const w = load();
    const order = [];
    const proto = w.HTMLIFrameElement.prototype;
    const set = proto.setAttribute;
    const desc = Object.getOwnPropertyDescriptor(proto, 'srcdoc');
    proto.setAttribute = function (k, v) { order.push(k); return set.call(this, k, v); };
    Object.defineProperty(proto, 'srcdoc', { configurable: true, get: desc.get, set(v) { order.push('srcdoc'); desc.set.call(this, v); } });
    try {
      const r = w.YCMailRender.createFrame(w.document, { body_html: '<p>' + 'word '.repeat(4000) + '</p>' }, {});
      expect(r.frame.isConnected).toBe(false);
      expect(order.indexOf('sandbox')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('sandbox')).toBeLessThan(order.indexOf('srcdoc'));
      expect(r.height).toBeLessThanOrEqual(1400);
      expect(r.height).toBeGreaterThan(200);
    } finally {
      proto.setAttribute = set;
      Object.defineProperty(proto, 'srcdoc', desc);
    }
  });

  test('remote mode widens only img-src', () => {
    const w = load();
    const { frame } = w.YCMailRender.createFrame(w.document, { body_html: '<p>x</p>' }, { allowRemote: true });
    expect(frame.srcdoc).toContain(w.YCMailRender.CSP_REMOTE);
    expect(w.YCMailRender.CSP_REMOTE.replace('img-src data: https: http:', 'img-src data:')).toBe(w.YCMailRender.CSP_BLOCKED);
  });
});

describe('sinks (grep-provable)', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  test('comms.html and mailRender.js never write markup from strings', () => {
    for (const [name, src] of [['comms.html', strip(COMMS)], ['mailRender.js', strip(RENDER)]]) {
      for (const re of [/\.innerHTML\s*[+]?=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /document\.write/, /createContextualFragment/, /\bDOMParser\b/]) {
        expect([name, re.source, re.test(src)]).toEqual([name, re.source, false]);
      }
    }
  });

  test('srcdoc is assigned exactly once, in mailRender.js', () => {
    const assigns = strip(RENDER).match(/\.srcdoc\s*=/g) || [];
    expect(assigns).toHaveLength(1);
    expect(strip(COMMS)).not.toMatch(/srcdoc/);
  });

  test('comms.html never reads a body field except to hand it to the renderer', () => {
    const src = strip(COMMS);
    const uses = src.match(/\bbody_html\b/g) || [];
    // hasHtml check + nothing else: the message object itself goes to R.createFrame.
    expect(uses.length).toBe(2);
    expect(src).toMatch(/R\.createFrame\(document, m,/);
  });
});

describe('vendored DOMPurify', () => {
  test('is the pinned, byte-identical npm dist (dompurify@3.4.16 dist/purify.min.js)', () => {
    expect(crypto.createHash('sha256').update(fs.readFileSync(PURIFY_PATH)).digest('hex'))
      .toBe('2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2');
    expect(PURIFY.slice(0, 40)).toBe('/*! @license DOMPurify 3.4.16 | (c) Cure');
  });

  test('comms.html loads it, then the renderer, before its own script', () => {
    const a = COMMS.indexOf('<script src="/js/vendor/purify-3.4.16.min.js"></script>');
    const b = COMMS.indexOf('<script src="/js/mailRender.js"></script>');
    const c = COMMS.indexOf('<script>\n"use strict";');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
