#!/usr/bin/env node
// tests/helpers/campaignDesignerSmoke.js
//
/**
 * YisraMail C3b — the Designer editor mode, driven for real: public/campaign.html
 * in a stand-in shell (it owns apiSend, firmData and SweetAlert, like
 * index.html), the real GrapesJS 0.23.8 + grapesjs-mjml 1.0.8 fetched from
 * jsdelivr with their SRI hashes, real mouse / keyboard / clipboard input.
 * Run by tests/campaignDesigner.browser.test.js (gated on
 * PUPPETEER_EXECUTABLE_PATH); prints ONE JSON verdict line
 * `{ checks: {name: true|false}, info, errors }` as its last line.
 *
 * The stand-in apiSend serves the FIXED /api/email-designs contract (C3a) from
 * memory and stores design_json the way MySQL's JSON column does (object keys
 * re-ordered: shorter first, then by bytes), so a round trip here is a round
 * trip through a re-ordering store.
 *
 * Every wait is bounded; the whole run has a hard deadline. Needs network
 * (jsdelivr). Under heavy-gate's browser slot, never beside another browser run.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const EXE = process.env.PUPPETEER_EXECUTABLE_PATH;
const DEADLINE_MS = Number(process.env.C3B_SMOKE_DEADLINE_MS) || 240000;
const FOOTER_SLOT = '<!-- yc:footer-slot -->';
const PREVIEW_TEXT = 'Compliance footer preview';

const checks = {};
const info = {};
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function bounded(p, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); }),
  ]);
}
function verdict(code) {
  process.stdout.write(`${JSON.stringify({ checks, info, errors })}\n`);
  process.exit(code);
}
const hard = setTimeout(() => { errors.push(`hard deadline ${DEADLINE_MS}ms`); verdict(2); }, DEADLINE_MS);

// The REAL save validator (C3a, lib/emailDesignRules.js) judges what the editor
// exports. C3B_VALIDATOR may point at another copy (a C3a commit exported
// before C3a reached this branch); a missing validator FAILS the checks that
// use it — never skips them.
let validateDesign = null;
const VALIDATOR = process.env.C3B_VALIDATOR || path.join(__dirname, '..', '..', 'lib', 'emailDesignRules.js');
try {
  process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('base64');
  ({ validateDesign } = require(VALIDATOR));
} catch (e) { info.validatorLoadError = String(e.message).slice(0, 300); }
function serverVerdict(designJson, html) {
  if (typeof validateDesign !== 'function') return { ok: false, rule: 'validator-missing' };
  try {
    const r = validateDesign({ design_json: designJson, html });
    return { ok: true, warning: r.warning || null };
  } catch (e) { return { ok: false, rule: e.rule, detail: String(e.detail || e.message).slice(0, 300) }; }
}

// ── the stand-in shell ─────────────────────────────────────────────────
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>shell stand-in</title>
<script src="https://cdn.jsdelivr.net/npm/sweetalert2@11.14.5/dist/sweetalert2.all.min.js"></script>
<script>
  window.__hits = [];
  window.__hit = function (l) { window.__hits.push(String(l)); };
  window.__calls = [];
  window.populateCaseTypeFilter = function () {};
  window.firmData = {
    emailFrom: [{ email: 'ops@firm.test', from_name: 'Ops', signature_html: '<p>SIGNATURE-BLOCK</p>' }],
    phoneLines: [{ phone_number: '2485550000', mms_capable: 0 }],
  };
  // MySQL's JSON column re-orders object keys (shorter first, then bytewise).
  function mysqlJson(v) {
    if (Array.isArray(v)) return v.map(mysqlJson);
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).sort(function (a, b) { return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0); }).forEach(function (k) { o[k] = mysqlJson(v[k]); });
      return o;
    }
    return v;
  }
  var designs = {};
  var seq = 0;
  function apiErr(status, body) { var e = new Error(body.error || ('HTTP ' + status)); e.name = 'ApiError'; e.status = status; e.body = body; return e; }
  window.apiSend = async function (url, method, body) {
    method = (method || 'GET').toUpperCase();
    window.__calls.push({ url: url, method: method, body: body == null ? null : JSON.parse(JSON.stringify(body)) });
    var m;
    if (url === '/api/campaigns/compose-options') return { marketing_senders: [], topics: [], operational_cap: 50, marketing_rate: 60, marketing_enabled: false, can_bulk: false, footer_slot: '<!-- yc:footer-slot -->' };
    if (url === '/api/campaigns/case-types') return { case_types: {} };
    if (url === '/api/consent/preview') return { skipped_optout: 0 };
    if (url === '/api/campaigns/preview') return { subject: body.subject, body: body.body, unresolved: [] };
    if (url === '/api/campaigns' && method === 'POST') return { campaignId: 501, status: 'sending' };
    if (url.indexOf('/api/campaigns') === 0 && method === 'GET') return { campaigns: [] };
    if (url.indexOf('/api/assets') === 0 && method === 'GET') return { total: 2, assets: [
      { id: 1, url: 'https://storage.example.test/comms-images/a.png', mime: 'image/png', title: 'a' },
      { id: 2, url: 'https://storage.example.test/comms-images/b.png', mime: 'image/png', title: 'b' },
    ] };
    if (url === '/api/email-designs' && method === 'POST') {
      if (body.name === 'REJECT ME') throw apiErr(400, { error: 'Design rejected', code: 'design_rejected', rule: 6, detail: 'href "javascript:x" is not an allowed URL' });
      seq += 1;
      designs[seq] = { id: seq, name: body.name, builder: 'grapesjs-mjml', design_json: mysqlJson(JSON.parse(JSON.stringify(body.design_json))), html: body.html, text: body.text, archived: 0, updated_at: '2026-11-04T10:00:00.000Z' };
      return { success: true, id: seq };
    }
    if ((m = /^\\/api\\/email-designs\\/(\\d+)$/.exec(url))) {
      var d = designs[m[1]];
      if (!d) throw apiErr(404, { error: 'not found' });
      if (method === 'GET') return { design: JSON.parse(JSON.stringify(d)) };
      if (method === 'PUT') { d.name = body.name; d.design_json = mysqlJson(JSON.parse(JSON.stringify(body.design_json))); d.html = body.html; d.text = body.text; return { success: true, id: d.id }; }
      if (method === 'PATCH') { d.archived = body.archived ? 1 : 0; return { success: true }; }
    }
    if (url.indexOf('/api/email-designs') === 0 && method === 'GET') {
      var inc = /include_archived=1/.test(url);
      return { designs: Object.keys(designs).map(function (k) { return designs[k]; }).filter(function (d) { return inc || !d.archived; }).map(function (d) { return { id: d.id, name: d.name, builder: d.builder, updated_at: d.updated_at, archived: d.archived }; }) };
    }
    throw apiErr(404, { error: 'stand-in: no route ' + method + ' ' + url });
  };
</script>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
</head><body><iframe id="pane" src="/campaign.html"></iframe></body></html>`;

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/' || u === '/__shell.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(SHELL); }
  if (u === '/__c3b_probe.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end("top.__hit(window.frameElement && window.frameElement.classList.contains('gjs-frame') ? 'canvas-src-script' : 'control-src-script');"); }
  const f = path.join(PUBLIC, u);
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(f).pipe(res);
});

async function main() {
  if (!EXE) { errors.push('PUPPETEER_EXECUTABLE_PATH not set'); return verdict(2); }
  const puppeteer = require('puppeteer-core');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1400 });
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message).slice(0, 300)));
    await bounded(page.goto(`${origin}/`, { waitUntil: 'networkidle0' }), 60000, 'goto');
    const pane = page.frames().find((f) => f.url().endsWith('/campaign.html'));
    if (!pane) throw new Error('campaign.html frame missing');
    await bounded(pane.waitForFunction(() => typeof quill !== 'undefined' && quill && document.getElementById('c-sender').options.length > 0, { timeout: 30000 }), 35000, 'campaign boot');
    await pane.evaluate(() => {
      window.__errs = [];
      const oe = console.error;
      console.error = function () { window.__errs.push([].map.call(arguments, (x) => (x && x.stack) || String(x)).join(' | ').slice(0, 400)); return oe.apply(console, arguments); };
    });
    const ev = (fn, ...a) => bounded(pane.evaluate(fn, ...a), 20000, 'pane.evaluate');
    const shellCalls = () => page.evaluate(() => window.__calls.slice());
    const exportNow = () => ev(async () => { const o = await YcDesigner.exportDesign(designer.editor); return { html: o.html, mjml: o.mjml, json: JSON.stringify(o.design_json), text: o.text, problems: YcDesigner.checkExport(o) }; });
    const rectOf = async (src) => {
      await ev((s) => {
        document.getElementById('designer-host').scrollIntoView({ block: 'start' });
        const c = (new Function('ed', `return (${s})`))(designer.editor);
        const win = designer.editor.Canvas.getWindow();
        const r0 = c.getEl().getBoundingClientRect();
        win.scrollBy(0, r0.top - win.innerHeight / 2 + r0.height / 2);
      }, src);
      await sleep(250);
      const pos = await ev((s) => {
        const ed = designer.editor;
        const c = (new Function('ed', `return (${s})`))(ed);
        const fr = ed.Canvas.getFrameEl().getBoundingClientRect();
        const r = c.getEl().getBoundingClientRect();
        const pf = window.frameElement.getBoundingClientRect();
        const lx = r.left + Math.min(30, r.width / 2); const ly = r.top + r.height / 2;
        const hitPane = document.elementFromPoint(fr.left + lx, fr.top + ly);
        const hitCanvas = ed.Canvas.getDocument().elementFromPoint(lx, ly);
        return { x: pf.left + fr.left + lx, y: pf.top + fr.top + ly, dbg: { fr: [fr.left, fr.top, fr.width, fr.height], r: [r.left, r.top, r.width, r.height], pf: [pf.left, pf.top], hitPane: hitPane && hitPane.tagName, hitInEl: !!(hitCanvas && c.getEl().contains(hitCanvas)) } };
      }, src);
      (info.rects = info.rects || []).push({ src: src.slice(0, 50), dbg: pos.dbg });
      return pos;
    };
    const waitEditing = async (want, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await ev(() => !!designer.editor.getEditing())) === want) return true; await sleep(100); } return false; };
    const startRte = async (src) => {
      const r = await rectOf(src);
      await page.mouse.click(r.x, r.y); await sleep(250);
      await page.mouse.click(r.x, r.y, { count: 2 });
      return waitEditing(true, 3000);
    };
    const clickAwayInCanvas = async () => {
      const r = await ev(() => { const fr = designer.editor.Canvas.getFrameEl().getBoundingClientRect(); const pf = window.frameElement.getBoundingClientRect(); return { x: pf.left + fr.left + 10, y: pf.top + fr.top + 10 }; });
      await page.mouse.click(r.x, r.y); await sleep(400);
    };
    const swalText = () => page.evaluate(() => { const p = document.querySelector('.swal2-popup.swal2-show, .swal2-popup'); return p && document.querySelector('.swal2-container') ? p.innerText : ''; });
    const swalClick = async (sel) => { await bounded(page.waitForSelector(sel, { visible: true, timeout: 8000 }), 9000, `swal ${sel}`); await page.click(sel); await sleep(300); };
    const swalCloseAll = () => page.evaluate(() => { if (window.Swal && Swal.isVisible()) Swal.close(); });

    // ── 1. Lazy load: a plain compose never fetches the designer libraries ──
    await pane.evaluate(() => showTab('tab-compose'));
    await sleep(500);
    const plain = await ev(() => ({
      grapes: typeof window.grapesjs,
      tags: document.querySelectorAll('script[src*="grapesjs"], link[href*="grapesjs"], [data-yc-designer]').length,
      mode: document.getElementById('c-editor-mode').value,
      hasDesignerOption: !!document.querySelector('#c-editor-mode option[value="designer"]'),
    }));
    checks.lazy_plain_compose_loads_no_designer_libs = plain.grapes === 'undefined' && plain.tags === 0 && plain.mode === 'richtext'
      && !requests.some((u) => /grapesjs/i.test(u));
    checks.designer_option_present = plain.hasDesignerOption;

    // signature works in Rich Text (control for the Designer check below)
    const sigRich = await ev(() => { syncCampaignSig(); const c = document.getElementById('c-include-sig'); return { disabled: c.disabled }; });

    // ── 2. Pick Designer → pinned libs with SRI, editor boots ──
    await pane.select('#c-editor-mode', 'designer');
    await bounded(pane.waitForFunction(() => designer.editor && designer.editor.getWrapper(), { timeout: 60000 }), 65000, 'designer boot');
    await sleep(800);
    const loaded = await ev(() => {
      const L = YcDesigner.LIBS;
      const s = [...document.querySelectorAll('script[data-yc-designer]')].map((e) => ({ src: e.getAttribute('src'), integrity: e.getAttribute('integrity'), co: e.getAttribute('crossorigin') }));
      const l = [...document.querySelectorAll('link[data-yc-designer]')].map((e) => ({ href: e.getAttribute('href'), integrity: e.getAttribute('integrity'), co: e.getAttribute('crossorigin') }));
      return {
        ok: s.length === 2 && l.length === 1
          && s[0].src === L.scripts[0].src && s[0].integrity === L.scripts[0].integrity
          && s[1].src === L.scripts[1].src && s[1].integrity === L.scripts[1].integrity
          && l[0].href === L.css.href && l[0].integrity === L.css.integrity
          && s.every((x) => x.co === 'anonymous') && l[0].co === 'anonymous',
        version: window.grapesjs && window.grapesjs.version,
        pinned: L.scripts[0].src.includes('grapesjs@0.23.8') && L.scripts[1].src.includes('grapesjs-mjml@1.0.8')
          && L.scripts[0].integrity === 'sha384-TKFOGgR9J4dEbVZg+n/JLhw8KtA6TLRGeBjxCNQg3hxN5BR3Vz7gEJitzEWKgELK'
          && L.scripts[1].integrity === 'sha384-Hu3AC9+4h23WQ4NmDvVQ5C8C2H5K18m9NUdiDGZrAs5cjiLHzLbxbsvl+BwqXHHH'
          && L.css.integrity === 'sha384-ipHR7uZK8wuUZWD8zZ09XYemZDqShtJpYjZibAX8L1f5rAUb4W78/j43sKG32Ip4',
      };
    });
    info.grapesjsVersion = loaded.version;
    checks.lazy_designer_loads_pinned_libs_with_sri = loaded.ok && loaded.pinned && loaded.version === '0.23.8';

    // ── 3. Signature greyed out in Designer, back in Rich Text ──
    const sig = await ev(() => { const c = document.getElementById('c-include-sig'); return { disabled: c.disabled, checked: c.checked, note: document.getElementById('c-sig-note').textContent, block: document.getElementById('c-sig-block').style.display }; });
    checks.signature_disabled_in_designer = sigRich.disabled === false && sig.disabled === true && sig.checked === false && /Designer/.test(sig.note) && sig.block === 'none';

    // ── 4. Blocks allowlist (findings Q3) + no import button (Q5 item 1) ──
    const ui = await ev(() => {
      const ed = designer.editor;
      return {
        blocks: ed.Blocks.getAll().map((b) => b.id).sort(),
        buttons: ed.Panels.getPanels().map((p) => p.get('buttons').map((b) => ({ id: b.id, cmd: typeof b.get('command') === 'string' ? b.get('command') : 'fn' }))).flat(),
      };
    });
    checks.blocks_allowlist_only = JSON.stringify(ui.blocks) === JSON.stringify(['mj-1-column', 'mj-2-columns', 'mj-button', 'mj-divider', 'mj-image', 'mj-spacer', 'mj-text', 'yc-header']);

    // ── 5. Canvas hardening (findings Q4 Mitigation A) — behaviour, not the meta ──
    const csp = await ev(async () => {
      top.__hits = [];
      const ed = designer.editor;
      const d = ed.Canvas.getDocument();
      const s = d.createElement('script'); s.textContent = "top.__hit('canvas-script')"; d.body.appendChild(s);
      const im = d.createElement('img'); im.setAttribute('src', 'x:nope'); im.setAttribute('onerror', "top.__hit('canvas-onerror')"); d.body.appendChild(im);
      // positive control: the same script in an ordinary frame of this pane DOES run
      const f = document.createElement('iframe'); document.body.appendChild(f);
      const s2 = f.contentDocument.createElement('script'); s2.textContent = "top.__hit('control-script')"; f.contentDocument.body.appendChild(s2);
      await new Promise((r) => setTimeout(r, 400));
      f.remove();
      return top.__hits.slice();
    });
    checks.canvas_control_script_runs = csp.includes('control-script');
    checks.canvas_inserted_script_and_handler_do_not_run = !csp.includes('canvas-script') && !csp.includes('canvas-onerror');
    info.cspHits = csp;
    // a SAME-ORIGIN <script src> (what script-src 'self' would allow) does not run in the canvas either
    const srcHits = await ev(async () => {
      top.__hits = [];
      const src = `${location.origin}/__c3b_probe.js`;
      const d = designer.editor.Canvas.getDocument();
      const s1 = d.createElement('script'); s1.src = src; d.body.appendChild(s1);
      const f = document.createElement('iframe'); document.body.appendChild(f);
      const s2 = f.contentDocument.createElement('script'); s2.src = src; f.contentDocument.body.appendChild(s2);
      await new Promise((r) => setTimeout(r, 800));
      f.remove();
      return top.__hits.slice();
    });
    info.srcHits = srcHits;
    checks.canvas_same_origin_script_src_does_not_run = srcHits.includes('control-src-script') && !srcHits.includes('canvas-src-script');

    // a malicious STORED design_json (findings Q4 payloads) loads without running
    const stored = await ev(async () => {
      top.__hits = [];
      const ed = designer.editor;
      const good = ed.getProjectData();
      const evil = JSON.parse(JSON.stringify(good));
      let text = null;
      (function walk(n) { if (!n || typeof n !== 'object') return; if (!text && n.type === 'mj-text') text = n; (n.components || []).forEach(walk); })(evil.pages[0].frames[0].component);
      text.components = (text.components || []).concat([
        { tagName: 'img', attributes: { src: 'x:nope', onerror: "top.__hit('stored-onerror')" } },
        { tagName: 'script', content: "top.__hit('stored-script')" },
        { tagName: 'iframe', attributes: { srcdoc: "<script>top.__hit('stored-srcdoc')<\/script>" } },
        { tagName: 'div', script: "top.__hit('stored-scriptprop')" },
      ]);
      YcDesigner.loadDesign(ed, evil);
      await new Promise((r) => setTimeout(r, 800));
      const hits = top.__hits.slice();
      YcDesigner.loadDesign(ed, good);
      return hits;
    });
    checks.canvas_stored_payloads_do_not_run = stored.length === 0;
    info.storedHits = stored;

    // ── 6. Starter template: marker only, preview in the canvas only ──
    await ev(() => { YcDesigner.newDesign(designer.editor); designer.dirty = false; });
    await sleep(500);
    const starter = await exportNow();
    const footerHtml = (() => { const i = starter.html.indexOf(FOOTER_SLOT); return i === -1 ? '' : starter.html.slice(starter.html.lastIndexOf('<div', i), starter.html.indexOf('</div>', i) + 6); })();
    const starterFooter = await ev(() => {
      const f = YcDesigner.findFooter(designer.editor);
      const json = JSON.parse(JSON.stringify(f.toJSON()));
      const leaves = [];
      (function walk(n) { if (n.type === 'comment' || n.type === 'textnode' || (n.content && String(n.content).trim())) leaves.push({ type: n.type, content: n.content }); (n.components || []).forEach(walk); })(json);
      const prev = designer.editor.Canvas.getDocument().querySelector('[data-yc-footer-preview]');
      return { leaves, previewText: prev ? prev.textContent : '', previewInFooterEl: !!(prev && f.getEl().contains(prev)) };
    });
    checks.starter_footer_is_marker_only = starter.html.split(FOOTER_SLOT).length - 1 === 1
      && starterFooter.leaves.length === 1 && starterFooter.leaves[0].type === 'comment' && starterFooter.leaves[0].content.trim() === 'yc:footer-slot'
      && footerHtml.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim() === ''
      && starter.problems.length === 0;
    checks.footer_preview_shows_in_canvas = starterFooter.previewInFooterEl && starterFooter.previewText.includes(PREVIEW_TEXT);
    checks.footer_preview_never_serialized_export = !starter.html.includes(PREVIEW_TEXT) && !starter.mjml.includes(PREVIEW_TEXT) && !starter.json.includes(PREVIEW_TEXT)
      && !starter.html.includes('data-yc-footer-preview') && !starter.json.includes('data-yc-footer-preview');
    info.starterText = starter.text.slice(0, 200);

    // The C3a validator's slot shape (MAIL_MAN relay, 2026-11-04), checked on the export:
    // html — exactly one exact marker, a real comment in <body>, inside the single element with
    // class yc-footer, nothing visible in that element (Outlook <!--[if mso]> branches included);
    // design_json — no serialized toolbar / traits, empty symbols / dataSources, no mj-raw /
    // mj-style / mj-font, 'yc:footer-slot' once, marker = comment component.
    const shape = await ev((html, json) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const els = [...doc.body.querySelectorAll('*')].filter((e) => e.classList.contains('yc-footer'));
      const el = els[0];
      const comments = [];
      if (el) { const w = doc.createTreeWalker(el, NodeFilter.SHOW_COMMENT); let n; while ((n = w.nextNode())) comments.push(n.data); }
      const markerComments = comments.filter((c) => c === ' yc:footer-slot ');
      const msoText = comments.filter((c) => /^\[if mso/.test(c)).map((c) => c.replace(/<[^>]*>/g, '').replace(/\[if[^\]]*\]>|<!\[endif\]/g, '').trim()).join('');
      const d = JSON.parse(json);
      const keys = new Set();
      const types = new Set();
      (function walk(n) { if (!n || typeof n !== 'object') return; Object.keys(n).forEach((k) => keys.add(k)); if (n.type) types.add(n.type); if (n.tagName) types.add(n.tagName); (n.components || []).forEach(walk); })(d.pages[0].frames[0].component);
      return {
        oneEl: els.length === 1,
        markerInEl: markerComments.length === 1,
        bodyMarkers: html.split('<!-- yc:footer-slot -->').length - 1,
        visible: el ? el.textContent.trim() : 'NO ELEMENT',
        msoText,
        toolbarOrTraits: keys.has('toolbar') || keys.has('traits'),
        symbols: (d.symbols || []).length, dataSources: (d.dataSources || []).length,
        refusedTypes: ['mj-raw', 'mj-style', 'mj-font'].filter((t) => types.has(t)),
        slotStrings: json.split('yc:footer-slot').length - 1,
        topKeys: Object.keys(d).sort(),
      };
    }, starter.html, starter.json);
    info.serverShape = shape;
    const vStarter = serverVerdict(JSON.parse(starter.json), starter.html);
    info.validatorStarter = vStarter;
    checks.validator_accepts_starter = vStarter.ok === true;
    checks.export_matches_server_slot_shape = shape.oneEl && shape.markerInEl && shape.bodyMarkers === 1 && shape.visible === '' && shape.msoText === '';
    checks.design_json_has_no_refused_keys = !shape.toolbarOrTraits && shape.symbols === 0 && shape.dataSources === 0 && shape.refusedTypes.length === 0
      && shape.slotStrings === 1 && shape.topKeys.every((k) => ['assets', 'styles', 'pages', 'symbols', 'dataSources'].includes(k));

    // ── 7. Q5 lock: the "Blocked" list, then the six "Not blocked" closures ──
    let r = await rectOf('YcDesigner.findFooter(ed)');
    await page.mouse.click(r.x, r.y); await sleep(300);
    const footerSel = await ev(() => { const s = designer.editor.getSelected(); return s ? s.get('type') : null; });
    await page.keyboard.press('Delete'); await sleep(200);
    await page.keyboard.press('Backspace'); await sleep(200);
    await ev(() => designer.editor.select(YcDesigner.findFooter(designer.editor)));
    await page.keyboard.press('Delete'); await sleep(200);
    const afterKeys = await ev(() => ({ footer: !!YcDesigner.findFooter(designer.editor), n: designer.editor.getWrapper().findType('mj-section').length }));
    // control: the same key deletes an unlocked section
    await ev(() => designer.editor.select(designer.editor.getWrapper().findType('mj-section')[1]));
    r = await rectOf("ed.getWrapper().findType('mj-text')[1]");
    await page.mouse.click(r.x, r.y); await sleep(250);
    const ctlBefore = await ev(() => designer.editor.getWrapper().findType('mj-text').length);
    await page.keyboard.press('Delete'); await sleep(300);
    const ctlAfter = await ev(() => designer.editor.getWrapper().findType('mj-text').length);
    checks.q5_delete_keys_refused_on_footer = footerSel === 'mj-section' && afterKeys.footer === true && ctlAfter === ctlBefore - 1;
    info.deleteKeys = { footerSel, afterKeys, ctlBefore, ctlAfter };
    // the footer text does not start the RTE
    r = await rectOf("YcDesigner.findFooter(ed).findType('mj-text')[0]");
    await page.mouse.click(r.x, r.y); await sleep(200);
    await page.mouse.click(r.x, r.y, { count: 2 }); await sleep(800);
    const footerRte = await ev(() => !!designer.editor.getEditing());
    await page.keyboard.type('HIJACK'); await sleep(200);
    checks.q5_footer_text_not_editable = footerRte === false && !(await exportNow()).html.includes('HIJACK');
    const cmds = await ev(() => {
      const ed = designer.editor;
      const n = () => ed.getWrapper().findType('mj-section').length;
      const res = {};
      ['tlb-delete', 'core:component-delete', 'tlb-clone', 'core:copy|core:paste'].forEach((id) => {
        const b = n();
        id.split('|').forEach((x) => { ed.select(YcDesigner.findFooter(ed)); try { ed.runCommand(x); } catch (e) { /* refused */ } });
        res[id] = b === n() && !!YcDesigner.findFooter(ed);
      });
      const other = ed.getWrapper().findType('mj-section')[1];
      ed.select([other, YcDesigner.findFooter(ed)]);
      const b2 = n();
      ed.runCommand('core:component-delete');
      res.multiSelect = n() === b2 - 1 && !!YcDesigner.findFooter(ed);
      ed.select(YcDesigner.findFooter(ed));
      res.styleProps = ed.StyleManager.getSectors().reduce((a, s) => a + s.getProperties().filter((p) => p.isVisible()).length, 0);
      return res;
    });
    checks.q5_toolbar_commands_refused_on_footer = cmds['tlb-delete'] && cmds['core:component-delete'] && cmds['tlb-clone'] && cmds['core:copy|core:paste'] && cmds.multiSelect;
    checks.q5_style_manager_empty_on_footer = cmds.styleProps === 0;
    info.cmds = cmds;

    // item 1: no import button, and the command refuses
    const q1 = await ev(async () => {
      const ed = designer.editor;
      ed.runCommand('mjml-import');
      await new Promise((r2) => setTimeout(r2, 300));
      const open = ed.Modal.isOpen();
      ed.Modal.close();
      return { open, footer: !!YcDesigner.findFooter(ed) };
    });
    checks.q5_1_mjml_import_removed = !ui.buttons.some((b) => b.id === 'mjml-import' || b.cmd === 'mjml-import') && q1.open === false && q1.footer;
    // item 2: history cleared after a load (new + stored)
    const q2 = await ev(() => {
      const ed = designer.editor;
      YcDesigner.newDesign(ed);
      const afterNew = ed.UndoManager.hasUndo();
      let u = 0; while (ed.UndoManager.hasUndo() && u < 100) { ed.UndoManager.undo(); u++; }
      const footerNew = !!YcDesigner.findFooter(ed) && ed.getWrapper().findType('mj-section').length === 5;
      // walked back past the load (the bug this pins), the design may have no mj-body left
      if (!footerNew) YcDesigner.newDesign(ed);
      YcDesigner.loadDesign(ed, ed.getProjectData());
      const afterLoad = ed.UndoManager.hasUndo();
      u = 0; while (ed.UndoManager.hasUndo() && u < 100) { ed.UndoManager.undo(); u++; }
      const footerLoad = !!YcDesigner.findFooter(ed) && ed.getWrapper().findType('mj-section').length === 5;
      if (!footerLoad) YcDesigner.newDesign(ed);   // leave a usable design for the steps after
      return { afterNew, afterLoad, footerNew, footerLoad };
    });
    checks.q5_2_undo_cannot_pass_the_load = q2.afterNew === false && q2.afterLoad === false && q2.footerNew && q2.footerLoad;
    // item 3: canvas-clear unexposed and refusing
    const q3 = await ev(() => { const ed = designer.editor; try { ed.runCommand('core:canvas-clear'); } catch (e) { /* refused */ } return { footer: !!YcDesigner.findFooter(ed), sections: ed.getWrapper().findType('mj-section').length }; });
    checks.q5_3_canvas_clear_refused = !ui.buttons.some((b) => b.cmd === 'core:canvas-clear') && q3.footer && q3.sections === 5;
    // item 4: nothing below the footer — the drag-time refusal (canMove) and the programmatic re-pin
    const q4 = await ev(() => {
      const ed = designer.editor;
      const body = ed.getWrapper().findType('mj-body')[0];
      const len = body.components().length;
      const below = ed.Components.canMove(body, body.components().at(1), len).result;
      const above = ed.Components.canMove(body, body.components().at(2), 0).result;
      body.append('<mj-section><mj-column><mj-text>APPENDED BELOW</mj-text></mj-column></mj-section>');
      const f = YcDesigner.findFooter(ed);
      return { below, above, last: f.index() === body.components().length - 1 };
    });
    checks.q5_4_footer_pinned_last = q4.below === false && q4.above === true && q4.last;
    // items 5 + 6: select-parent-only toolbar, no traits — section and every child
    const q56 = await ev(() => {
      const f = YcDesigner.findFooter(designer.editor);
      const all = [f].concat(f.find('*'));
      return {
        toolbars: all.filter((c) => c.get('type') !== 'comment').map((c) => (c.get('toolbar') || []).map((t) => t.command)),
        traits: all.map((c) => c.getTraits().length),
      };
    });
    checks.q5_5_footer_toolbar_select_parent_only = q56.toolbars.length >= 3 && q56.toolbars.every((t) => t.length === 1 && t[0] === 'core:component-exit');
    checks.q5_6_footer_has_no_traits = q56.traits.every((n) => n === 0);

    // ── 8. Merge tags: one list, three paths ──
    await ev(() => { YcDesigner.newDesign(designer.editor); });
    await sleep(500);
    const lists = await ev(() => ({
      outer: [...document.querySelectorAll('#c-placeholder-email option')].map((o) => o.value).filter(Boolean),
      rte: [...document.querySelectorAll('.yc-rte-merge option')].map((o) => o.value).filter(Boolean),
    }));
    checks.merge_tags_single_source = lists.outer.length > 5 && JSON.stringify(lists.outer) === JSON.stringify(lists.rte);
    const rte1 = await startRte("ed.getWrapper().findType('mj-text')[1]");
    const h = await pane.$('.yc-rte-merge');
    if (h) { await h.select('{{contacts.contact_city}}'); await sleep(300); }
    await page.keyboard.type(' ');
    await pane.select('#c-placeholder-email', '{{contacts.contact_zip}}'); await sleep(300);
    await clickAwayInCanvas();
    const tagsOut = await exportNow();
    checks.merge_tag_rte_toolbar_reaches_export = rte1 && tagsOut.html.includes('{{contacts.contact_city}}');
    checks.merge_tag_compose_list_reaches_export = tagsOut.html.includes('{{contacts.contact_zip}}');

    // EVERY text-toolbar action on a selection → export → the real validator
    // (review blocker: Strike-through wrote <strike>, which the server refuses).
    const actionNames = await ev(() => designer.editor.RichTextEditor.getAll().map((a) => a.name));
    info.rteActions = actionNames;
    checks.rte_toolbar_actions_exactly = JSON.stringify(actionNames) === JSON.stringify(['bold', 'italic', 'underline', 'link', 'wrap', 'yc-merge-tag']);
    const actionResults = { 'yc-merge-tag': { ...serverVerdict(JSON.parse(tagsOut.json), tagsOut.html), changed: tagsOut.html !== starter.html } };
    for (const name of actionNames.filter((n) => n !== 'yc-merge-tag')) {
      await ev(() => { YcDesigner.newDesign(designer.editor); });
      await sleep(400);
      const started = await startRte("ed.getWrapper().findType('mj-text')[1]");
      // select the whole line, as a user would before formatting it
      await page.keyboard.press('End');
      await page.keyboard.down('Shift'); await page.keyboard.press('Home'); await page.keyboard.up('Shift');
      await sleep(150);
      const btn = await ev((n) => {
        const a = designer.editor.RichTextEditor.getAll().find((x) => x.name === n);
        if (!a || !a.btn || !a.btn.offsetParent) return null;
        const r = a.btn.getBoundingClientRect(); const pf = window.frameElement.getBoundingClientRect();
        return { x: pf.left + r.left + r.width / 2, y: pf.top + r.top + r.height / 2 };
      }, name);
      if (btn) { await page.mouse.click(btn.x, btn.y); await sleep(400); }
      await clickAwayInCanvas();
      const o = await exportNow();
      const tags = (o.html.match(/<(b|i|u|s|strike|a|span|em|strong)\b/gi) || []).map((t) => t.slice(1).toLowerCase());
      actionResults[name] = { started, clicked: !!btn, changed: o.html !== starter.html, tags: [...new Set(tags)], ...serverVerdict(JSON.parse(o.json), o.html) };
    }
    info.rteActionResults = actionResults;
    checks.rte_every_action_passes_validator = Object.keys(actionResults).length === actionNames.length
      && Object.entries(actionResults).every(([n, r]) => r.ok === true && r.changed === true && (n === 'yc-merge-tag' || (r.started && r.clicked)));
    await ev(() => { YcDesigner.newDesign(designer.editor); });
    await sleep(400);
    info.rte1 = rte1;
    const trait = await ev(async () => {
      const ed = designer.editor;
      const b = ed.getWrapper().findType('mj-button')[0];
      ed.select(b);
      ed.runCommand('open-tm');
      await new Promise((r2) => setTimeout(r2, 400));
      const sel = [...document.querySelectorAll('.yc-url-tags')].find((s) => s.offsetParent);
      if (!sel) return { found: false };
      const inp = sel.parentNode.querySelector('input');
      inp.value = 'https://4lsg.com/x?c=';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.setSelectionRange(inp.value.length, inp.value.length);
      sel.value = '{{contacts.contact_token}}';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r2) => setTimeout(r2, 200));
      return { found: true, href: b.getAttributes().href };
    });
    const traitOut = await exportNow();
    // a merge tag at the START of an address is refused by the helper (the server refuses it too)
    const traitStart = await ev(async () => {
      const sel = [...document.querySelectorAll('.yc-url-tags')].find((x) => x.offsetParent);
      const inp = sel.parentNode.querySelector('input');
      const b = designer.editor.getWrapper().findType('mj-button')[0];
      const before = b.getAttributes().href;
      inp.value = '';
      inp.setSelectionRange(0, 0);
      sel.value = '{{contacts.contact_email}}';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r2) => setTimeout(r2, 200));
      const after = { input: inp.value, href: b.getAttributes().href };
      inp.value = before;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return { before, after };
    });
    info.traitStart = traitStart;
    checks.merge_tag_trait_refuses_tag_at_url_start = traitStart.after.input === '' && !String(traitStart.after.href || '').startsWith('{{');
    checks.merge_tag_link_trait_reaches_export = trait.found && trait.href === 'https://4lsg.com/x?c={{contacts.contact_token}}' && traitOut.html.includes('href="https://4lsg.com/x?c={{contacts.contact_token}}"');

    // ── 9. RTE ended before save: type, then Save at once (no click-away) ──
    await swalCloseAll();
    // (a) the export itself ends the edit: no click, no blur — the spike's failing path
    //     (clicking a page button blurs the canvas and GrapesJS syncs on its own, so (b)
    //     alone cannot tell whether exportDesign ends the RTE)
    const rteP = await startRte("ed.getWrapper().findType('mj-text')[4]");
    await page.keyboard.press('End');
    await page.keyboard.type(' ZZPROGRAMMATIC');
    const prog = await ev(async () => { const editing = !!designer.editor.getEditing(); const o = await designerExport(); return { editing, has: o.html.includes('ZZPROGRAMMATIC'), after: !!designer.editor.getEditing() }; });
    checks.rte_ended_by_export_without_blur = rteP && prog.editing && prog.has && prog.after === false;
    info.rteProgrammatic = prog;
    // (b) the user path
    await ev(() => { document.getElementById('d-name').value = 'Smoke design'; });
    const rte2 = await startRte("ed.getWrapper().findType('mj-text')[2]");
    await page.keyboard.press('End');
    await page.keyboard.type(' ZZTYPED-LAST');
    const stillEditing = await ev(() => !!designer.editor.getEditing());
    const callsBefore = (await shellCalls()).length;
    await pane.click('#d-save');
    await bounded((async () => { while ((await shellCalls()).length === callsBefore) await sleep(100); })(), 8000, 'save call');
    await sleep(400);
    await swalCloseAll();
    const post = (await shellCalls()).filter((c) => c.url === '/api/email-designs' && c.method === 'POST').pop();
    checks.rte_ended_before_save = rte2 && stillEditing && !!post && post.body.html.includes('ZZTYPED-LAST');

    // ── 10. Save payload + round trip: marker only, preview never saved ──
    const keys = post ? Object.keys(post.body).sort().join(',') : '';
    const postJson = post ? JSON.stringify(post.body.design_json) : '';
    checks.save_payload_shape = keys === 'design_json,html,name,text' && post.body.name === 'Smoke design' && typeof post.body.design_json === 'object'
      && typeof post.body.text === 'string' && post.body.text.includes('ZZTYPED-LAST');
    checks.save_payload_marker_only_no_preview = !!post && post.body.html.split(FOOTER_SLOT).length - 1 === 1
      && !post.body.html.includes(PREVIEW_TEXT) && !postJson.includes(PREVIEW_TEXT) && !postJson.includes('data-yc-footer-preview') && !post.body.text.includes(PREVIEW_TEXT);
    const vSaved = post ? serverVerdict(post.body.design_json, post.body.html) : { ok: false };
    info.validatorSaved = vSaved;
    checks.validator_accepts_saved_payload = vSaved.ok === true;
    const savedId = await ev(() => designer.id);
    // reopen it through the Designs picker (shell dialog), then compare
    await ev(() => { designer.dirty = false; document.getElementById('d-status').textContent = ''; });
    await pane.click('button[onclick="openDesignsPicker()"]');
    await swalClick(`button[data-act="open"][data-id="${savedId}"]`);
    await bounded((async () => { while (!(await ev(() => /— (un)?saved/.test(document.getElementById('d-status').textContent)))) await sleep(100); })(), 8000, 'reopen');
    const reopened = await exportNow();
    await sleep(600);   // any late 'update' from the load would have landed by now
    const reopenedState = await ev(() => { const ed = designer.editor; const f = YcDesigner.findFooter(ed); return { hasUndo: ed.UndoManager.hasUndo(), removable: f.get('removable'), id: designer.id, status: document.getElementById('d-status').textContent, dirty: designer.dirty }; });
    info.reopenedState = reopenedState;
    checks.reopened_design_reads_clean = reopenedState.dirty === false && reopenedState.status === `Design #${savedId} — saved`;
    checks.save_roundtrip_identical_html = !!post && reopened.html === post.body.html && reopenedState.id === savedId;
    checks.reopened_footer_relocked_history_clear = reopenedState.hasUndo === false && reopenedState.removable === false && reopened.problems.length === 0;

    // ── 11. A server rejection is shown with its rule and detail ──
    await ev(() => { document.getElementById('d-name').value = 'REJECT ME'; });
    await pane.click('button[onclick="saveCurrentDesign(true)"]');
    await bounded(page.waitForSelector('.swal2-popup', { visible: true, timeout: 8000 }), 9000, 'rejection dialog');
    await sleep(300);
    const rej = await swalText();
    checks.rejection_surfaced_with_rule_and_detail = /Rule 6/.test(rej) && /link or image address/.test(rej) && /javascript:x/.test(rej);
    await swalCloseAll();
    await sleep(300);
    await ev(() => { document.getElementById('d-name').value = 'Smoke design'; });

    // ── 12. Paste arrives as plain text (synthetic event, then the REAL clipboard) ──
    const rte3 = await startRte("ed.getWrapper().findType('mj-text')[3]");
    const syn = await ev(async () => {
      const ed = designer.editor;
      const dt = new DataTransfer();
      dt.setData('text/html', '<table><tr><td>TBLPASTE</td></tr></table><img src="data:image/png;base64,AAAA">');
      dt.setData('text/plain', 'Synthetic plain paste');
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ed.getEditing().getEl().dispatchEvent(e);
      await new Promise((r2) => setTimeout(r2, 200));
      return e.defaultPrevented;
    });
    let realPaste = { attempted: false };
    try {
      await page.browserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
      const wrote = await page.evaluate(async () => {
        try {
          await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob(['Real clipboard plain'], { type: 'text/plain' }),
            'text/html': new Blob(['<table><tr><td>REALTABLE</td></tr></table><b>Real clipboard plain</b>'], { type: 'text/html' }),
          })]);
          return 'ok';
        } catch (e) { return `fail ${e.message}`; }
      });
      await ev(() => { window.__pasteSeen = 0; designer.editor.Canvas.getDocument().addEventListener('paste', () => { window.__pasteSeen++; }, true); });
      await page.keyboard.press('End');
      await page.keyboard.press('KeyV', { commands: ['Paste'] });
      await sleep(500);
      realPaste = { attempted: true, wrote, seen: await ev(() => window.__pasteSeen) };
    } catch (e) { realPaste.error = e.message; }
    await clickAwayInCanvas();
    const pasteOut = await exportNow();
    checks.paste_synthetic_reduced_to_plain_text = rte3 && syn === true && pasteOut.html.includes('Synthetic plain paste') && !pasteOut.html.includes('TBLPASTE') && !pasteOut.json.includes('data:image');
    checks.paste_real_clipboard_reduced_to_plain_text = realPaste.wrote === 'ok' && realPaste.seen >= 1 && pasteOut.html.includes('Real clipboard plain') && !pasteOut.html.includes('REALTABLE') && !pasteOut.json.includes('REALTABLE');
    info.realPaste = realPaste;

    // ── 12b. The REAL picker, twice: styles follow the popup's DOCUMENT, and a
    // dismissal never jams the command (both from Fred's hand-check, 2026-11-04).
    // campaign.html's Swal is the SHELL's (`const Swal = P.Swal`), so the popup
    // renders in the shell document — assetpicker must style THAT document or the
    // grid is an unstyled stack. And `open-assets` must be STATELESS: registered
    // with a `stop` member, GrapesJS marks it active after the first run and
    // silently no-ops every later double-click, so the picker opens once per editor.
    r = await rectOf("ed.getWrapper().findType('mj-image')[1]");
    await page.mouse.click(r.x, r.y); await sleep(250);
    await page.mouse.click(r.x, r.y, { count: 2 });
    await bounded(page.waitForSelector('.swal2-container .ap-popup', { visible: true, timeout: 9000 }), 10000, 'real picker open 1');
    await sleep(500);
    const pickerStyle = await page.evaluate(() => {
      const p = document.querySelector('.swal2-container .ap-popup');
      const grid = p && p.querySelector('#ap-grid');
      const g = grid && getComputedStyle(grid);
      return { styles: !!document.getElementById('assetpicker-styles'), display: g ? g.display : null,
        cols: g ? g.gridTemplateColumns.split(' ').filter(Boolean).length : 0 };
    });
    info.pickerStyle = pickerStyle;
    checks.picker_styles_follow_the_popup_document = pickerStyle.styles === true && pickerStyle.display === 'grid' && pickerStyle.cols > 1;
    await page.keyboard.press('Escape');
    await sleep(500);
    const pickerJammed = await ev(() => designer.editor.Commands.isActive('open-assets'));
    r = await rectOf("ed.getWrapper().findType('mj-image')[1]");
    await page.mouse.click(r.x, r.y); await sleep(250);
    await page.mouse.click(r.x, r.y, { count: 2 });
    let pickerReopened = false;
    try {
      await bounded(page.waitForSelector('.swal2-container .ap-popup', { visible: true, timeout: 6000 }), 7000, 'real picker open 2');
      pickerReopened = true;
    } catch (_) { /* stays false */ }
    info.pickerReopen = { jammed: pickerJammed, reopened: pickerReopened };
    checks.image_picker_reopens_after_dismissal = pickerReopened === true && pickerJammed !== true;
    await page.keyboard.press('Escape');
    await sleep(400);

    // ── 13. Images go through the shared AssetPicker (stubbed here: it is the existing, tested widget) ──
    await ev(() => { window.__picks = 0; AssetPicker.pick = async () => { window.__picks++; return 'https://storage.example.test/comms-images/pic.png'; }; });
    r = await rectOf("ed.getWrapper().findType('mj-image')[1]");
    await page.mouse.click(r.x, r.y); await sleep(250);
    await page.mouse.click(r.x, r.y, { count: 2 }); await sleep(800);
    const imgOut = await exportNow();
    const picks = await ev(() => window.__picks);
    checks.image_dblclick_uses_assetpicker = picks === 1 && imgOut.html.includes('src="https://storage.example.test/comms-images/pic.png"') && !imgOut.json.includes('data:image');
    // a file dropped on the canvas never becomes a (base64) image
    const fileDrop = await ev(async () => {
      const ed = designer.editor;
      const before = ed.getWrapper().findType('mj-image').length + ed.getWrapper().findType('image').length;
      const d = ed.Canvas.getDocument();
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'x.png', { type: 'image/png' }));
      const tgt = ed.getWrapper().findType('mj-text')[0].getEl();
      const e = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      tgt.dispatchEvent(e);
      await new Promise((r2) => setTimeout(r2, 400));
      return { prevented: e.defaultPrevented, added: ed.getWrapper().findType('mj-image').length + ed.getWrapper().findType('image').length - before, b64: JSON.stringify(ed.getProjectData()).includes('base64') };
    });
    checks.file_drop_on_canvas_refused = fileDrop.prevented && fileDrop.added === 0 && !fileDrop.b64;

    // ── 14. Compose: Preview and Create carry the compiled body (+ design_id) ──
    await pane.click('#d-save');
    await sleep(800);
    await swalCloseAll();
    const saved = await ev(() => ({ id: designer.id, html: designer.savedHtml, dirty: designer.dirty }));
    await ev(() => { selectedContacts = [{ contact_id: 42, contact_name: 'Sam' }]; document.getElementById('c-subject').value = 'Designer smoke'; });
    await pane.evaluate(() => { previewCampaign(); });
    await bounded(page.waitForSelector('iframe[data-campaign-preview]', { timeout: 8000 }), 9000, 'preview dialog');
    await sleep(300);
    const prev = await page.evaluate(() => { const f = document.querySelector('iframe[data-campaign-preview]'); return { sandbox: f.getAttribute('sandbox'), srcdoc: f.srcdoc }; });
    checks.preview_renders_designer_body_sandboxed = prev.sandbox === '' && prev.srcdoc === saved.html && prev.srcdoc.includes(FOOTER_SLOT);
    await swalCloseAll();
    await sleep(300);
    // the signature checkbox cannot be forced on in Designer: even checked, nothing is appended
    await ev(() => { const c = document.getElementById('c-include-sig'); c.disabled = false; c.checked = true; document.getElementById('c-sig-block').innerHTML = '<p>SIGNATURE-BLOCK</p>'; });
    await pane.evaluate(() => { createCampaign(); });
    // wait for THIS dialog (a closing one's confirm button can still be on screen)
    await bounded((async () => { while (!(await swalText()).includes('Send Campaign?')) await sleep(100); })(), 8000, 'create confirm');
    info.createDialog = (await swalText()).slice(0, 120);
    await swalClick('.swal2-confirm');
    await sleep(800);
    const created = (await shellCalls()).filter((c) => c.url === '/api/campaigns' && c.method === 'POST').pop();
    checks.create_sends_compiled_body_and_design_id = !!created && saved.dirty === false && created.body.body === saved.html && created.body.design_id === saved.id;
    checks.create_designer_body_never_gets_signature = !!created && !created.body.body.includes('SIGNATURE-BLOCK');
    await swalCloseAll();


    const paneErrs = await ev(() => window.__errs.slice());
    info.paneConsoleErrors = paneErrs;
    info.pageErrors = pageErrors;
    checks.no_console_errors_or_page_errors = paneErrs.length === 0 && pageErrors.length === 0;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main().then(() => { clearTimeout(hard); verdict(Object.values(checks).every((v) => v === true) ? 0 : 1); })
  .catch((e) => { clearTimeout(hard); errors.push(String((e && e.stack) || e).slice(0, 1500)); verdict(2); });
