// tests/campaignDesigner.test.js
//
/**
 * YisraMail C3b — the Designer editor mode, without a browser:
 *   - public/js/campaignDesigner.js's pure helpers (text derivation, the
 *     editor's own export check, payloads / routes of the FIXED
 *     /api/email-designs contract, rejection messages, the merge-tag list,
 *     the starter template's marker-only footer, the pinned libraries)
 *   - lazy loading: the pinned files are injected with their SRI hashes, in
 *     order, once
 *   - public/campaign.html's wiring (JSDOM boot, same idiom as
 *     tests/campaignC2.ui.test.js): the third editor mode, the signature
 *     greyed out, save = POST/PUT with the contract's body, a 400's rule and
 *     detail shown, Create carrying the compiled body + design_id and never a
 *     signature.
 * GrapesJS itself only runs in tests/campaignDesigner.browser.test.js; here a
 * stand-in editor object plays it (the module under test is never mocked).
 * Run: npx jest tests/campaignDesigner.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const D = require('../public/js/campaignDesigner.js');
const DESIGNER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'campaignDesigner.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'campaign.html'), 'utf8');
const SLOT = '<!-- yc:footer-slot -->';
const DOMS = [];
afterAll(() => { for (const d of DOMS) d.window.close(); });
const { DOMParser } = new JSDOM('').window;

// ── fixtures ─────────────────────────────────────────────────────────────
function footerJson(inner) {
  return { type: 'mj-section', attributes: { 'css-class': 'yc-footer' }, components: [
    { type: 'mj-column', components: [{ type: 'mj-text', components: inner || [{ type: 'comment', content: ' yc:footer-slot ' }] }] }] };
}
function designJson(bodyKids) {
  return { assets: [], styles: [], pages: [{ frames: [{ component: { type: 'wrapper', components: [
    { type: 'mjml', components: [{ type: 'mj-body', components: bodyKids }] }] } }] }] };
}
const SECTION = { type: 'mj-section', components: [{ type: 'mj-column', components: [{ type: 'mj-text', components: [{ type: 'textnode', content: 'Hello' }] }] }] };
const GOOD_HTML = `<html><head><title>t</title></head><body><div>Hello</div><div>${SLOT}</div></body></html>`;
const GOOD = () => ({ design_json: designJson([SECTION, footerJson()]), html: GOOD_HTML, text: 'Hello' });

/** A stand-in for a GrapesJS editor: what exportDesign / insertMergeTag call, nothing more. */
function fakeEditor({ html = GOOD_HTML, design = designJson([SECTION, footerJson()]), editing = false } = {}) {
  const calls = [];
  let edit = editing ? { getView: () => ({ disableEditing: async () => { calls.push('disableEditing'); edit = null; } }) } : null;
  return {
    calls,
    getEditing: () => edit,
    getProjectData: () => { calls.push('getProjectData'); return JSON.parse(JSON.stringify(design)); },
    getHtml: () => '<mjml></mjml>',
    // While a text is still being edited, its last keystrokes are not in the model (findings Q1).
    runCommand: (id) => { calls.push(id); return { html: edit ? html.replace('Hello', 'STALE') : html, errors: [] }; },
  };
}

// ── 1. pure helpers ──────────────────────────────────────────────────────
describe('campaignDesigner.js — pinned libraries and constants', () => {
  test('the exact versions and sha384 hashes of the spike findings', () => {
    expect(D.LIBS.css).toEqual({ href: 'https://cdn.jsdelivr.net/npm/grapesjs@0.23.8/dist/css/grapes.min.css', integrity: 'sha384-ipHR7uZK8wuUZWD8zZ09XYemZDqShtJpYjZibAX8L1f5rAUb4W78/j43sKG32Ip4' });
    expect(D.LIBS.scripts).toEqual([
      { src: 'https://cdn.jsdelivr.net/npm/grapesjs@0.23.8/dist/grapes.min.js', integrity: 'sha384-TKFOGgR9J4dEbVZg+n/JLhw8KtA6TLRGeBjxCNQg3hxN5BR3Vz7gEJitzEWKgELK' },
      { src: 'https://cdn.jsdelivr.net/npm/grapesjs-mjml@1.0.8/dist/index.js', integrity: 'sha384-Hu3AC9+4h23WQ4NmDvVQ5C8C2H5K18m9NUdiDGZrAs5cjiLHzLbxbsvl+BwqXHHH' },
    ]);
    expect(D.FOOTER_SLOT).toBe(SLOT);   // = campaignService.FOOTER_SLOT (C2)
    expect(D.FOOTER_SLOT).toBe(require('../services/campaignService').FOOTER_SLOT);
  });

  test('the canvas CSP of findings Q4 Mitigation A', () => {
    expect(D.CANVAS_FRAME_CONTENT).toBe(`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'"></head><body></body></html>`);
  });

  test('the block allowlist of findings Q3 (no mj-raw)', () => {
    expect([...D.BLOCKS]).toEqual(['mj-1-column', 'mj-2-columns', 'mj-text', 'mj-button', 'mj-image', 'mj-divider', 'mj-spacer']);
  });
});

describe('starter template — the footer holds ONLY the invisible marker', () => {
  const mjml = D.starterMjml('https://app.example.test');
  test('exactly one marker, inside the yc-footer section, which is the last section of mj-body', () => {
    expect(mjml.split(SLOT).length - 1).toBe(1);
    const footer = mjml.slice(mjml.lastIndexOf('<mj-section'), mjml.indexOf('</mj-body>'));
    expect(footer).toMatch(/^<mj-section css-class="yc-footer"/);
    expect(footer).toContain(SLOT);
  });
  test('no visible text in the footer section — tags and the marker only', () => {
    const footer = mjml.slice(mjml.lastIndexOf('<mj-section'), mjml.indexOf('</mj-body>'));
    expect(footer.replace(SLOT, '').replace(/<[^>]*>/g, '').trim()).toBe('');
  });
  test('images are on the app origin (https in production), never data:', () => {
    expect(mjml).toContain('src="https://app.example.test/assets/icon-512.png"');
    expect(mjml).not.toMatch(/data:/);
  });
});

describe('deriveText — the design row\'s plain-text version', () => {
  test('links visible as "label (url)", the bare url when label = url, merge tags kept', () => {
    const t = D.deriveText('<body><p>Hi {{contacts.contact_fname|cap}},</p><p><a href="https://4lsg.com/b/x?c={{contacts.contact_token}}">Book now</a> or <a href="https://4lsg.com">https://4lsg.com</a></p></body>', DOMParser);
    expect(t).toBe('Hi {{contacts.contact_fname|cap}},\n\nBook now (https://4lsg.com/b/x?c={{contacts.contact_token}}) or https://4lsg.com');
  });
  test('head, style, title, comments and the hidden preheader are dropped; <br> breaks a line, blocks leave one blank line; entities decoded', () => {
    const t = D.deriveText(`<html><head><title>T</title><style>p{}</style></head><body><div style="display:none;max-height:0">PREHEADER</div>${SLOT}<p>a &amp; b<br>c</p><div>d&nbsp;e</div></body></html>`, DOMParser);
    expect(t).toBe('a & b\nc\n\nd e');
  });
  test('an image link takes its alt as the label; a javascript: href is not printed', () => {
    expect(D.deriveText('<a href="https://x.test"><img alt="Logo"></a><a href="javascript:alert(1)">bad</a>', DOMParser)).toBe('Logo (https://x.test)bad');
  });
});

describe('checkExport — the editor\'s own pre-save check (not a security boundary)', () => {
  test('a well-formed export passes', () => {
    expect(D.checkExport(GOOD())).toEqual([]);
  });
  test('no marker, or two markers, fail', () => {
    expect(D.checkExport({ ...GOOD(), html: '<body>x</body>' }).join(' ')).toMatch(/exactly once \(found 0\)/);
    expect(D.checkExport({ ...GOOD(), html: `<body>${SLOT}${SLOT}</body>` }).join(' ')).toMatch(/exactly once \(found 2\)/);
  });
  test('a data: image fails', () => {
    expect(D.checkExport({ ...GOOD(), html: `<body><img src="data:image/png;base64,AA">${SLOT}</body>` }).join(' ')).toMatch(/asset library/);
  });
  test('the footer not last, or missing, fails', () => {
    expect(D.checkExport({ ...GOOD(), design_json: designJson([footerJson(), SECTION]) }).join(' ')).toMatch(/last block/);
    expect(D.checkExport({ ...GOOD(), design_json: designJson([SECTION]) }).join(' ')).toMatch(/last block/);
  });
  test('URL attributes: a tag-started or relative address fails (server rule 6); https / mailto / tel / unsubscribe tags pass', () => {
    const withAttrs = (attrs) => ({ ...GOOD(), design_json: designJson([{ type: 'mj-section', components: [{ type: 'mj-column', components: [{ type: 'mj-button', attributes: attrs }] }] }, footerJson()]) });
    expect(D.checkExport(withAttrs({ href: '{{contacts.contact_email}}' })).join(' ')).toMatch(/starts with a merge tag/);
    expect(D.checkExport(withAttrs({ href: 'www.4lsg.com' })).join(' ')).toMatch(/not a full https/);
    expect(D.checkExport(withAttrs({ src: '/assets/icon-512.png' })).join(' ')).toMatch(/not a full https/);
    for (const ok of ['', 'https://4lsg.com/b/x?c={{contacts.contact_token}}', 'mailto:{{contacts.contact_email}}', 'tel:+12485550000', '{{send.unsubscribe_url}}', '{{send.preferences_url}}', '#top']) {
      expect(D.checkExport(withAttrs({ href: ok }))).toEqual([]);
    }
    expect(D.urlProblem('{{firm.website}}/x')).toBe('starts with a merge tag');
  });
  test('an image inside a text block fails (images are mj-image components)', () => {
    const d = designJson([{ type: 'mj-section', components: [{ type: 'mj-column', components: [{ type: 'mj-text', components: [{ type: 'image', attributes: { src: 'https://x.test/a.png' } }] }] }] }, footerJson()]);
    expect(D.checkExport({ ...GOOD(), design_json: d }).join(' ')).toMatch(/Image block/);
  });
  test('visible text in the footer fails (Fred\'s rule: marker only)', () => {
    const d = designJson([SECTION, footerJson([{ type: 'textnode', content: '[Footer goes here]' }, { type: 'comment', content: ' yc:footer-slot ' }])]);
    expect(D.checkExport({ ...GOOD(), design_json: d }).join(' ')).toMatch(/only the footer slot/);
  });
});

describe('rejectionMessage — a 400 design_rejected is legible', () => {
  test('names the rule number, its name and the server\'s detail', () => {
    const err = Object.assign(new Error('Design rejected'), { status: 400, body: { error: 'Design rejected', code: 'design_rejected', rule: 9, detail: 'the footer slot is not the last child of mj-body' } });
    expect(D.rejectionMessage(err)).toEqual({ title: 'The server refused this design', text: 'Rule 9 (footer slot): the footer slot is not the last child of mj-body' });
  });
  test('any other failure shows its message', () => {
    expect(D.rejectionMessage(Object.assign(new Error('HTTP 500'), { status: 500, body: {} }))).toEqual({ title: 'Save failed', text: 'HTTP 500' });
  });
});

describe('the /api/email-designs contract (C3a)', () => {
  const calls = [];
  const api = async (url, method, body) => { calls.push({ url, method, body }); return { success: true, id: 9 }; };
  beforeEach(() => { calls.length = 0; });
  test('the save body is exactly {name, design_json, html, text}', () => {
    const p = D.designPayload('June', { ...GOOD(), mjml: '<mjml/>', warnings: [] });
    expect(Object.keys(p).sort()).toEqual(['design_json', 'html', 'name', 'text']);
  });
  test('new → POST /api/email-designs; existing → PUT /api/email-designs/:id', async () => {
    await D.saveDesign(api, null, { name: 'a' });
    await D.saveDesign(api, 12, { name: 'b' });
    expect(calls).toEqual([{ url: '/api/email-designs', method: 'POST', body: { name: 'a' } }, { url: '/api/email-designs/12', method: 'PUT', body: { name: 'b' } }]);
  });
  test('list (q, include_archived), get, archive / restore', async () => {
    await D.listDesigns(api, 'june news', true);
    await D.listDesigns(api, '', false);
    await D.getDesign(api, 4);
    await D.setArchived(api, 4, true);
    await D.setArchived(api, 4, 0);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', '/api/email-designs?q=june+news&include_archived=1', undefined],
      ['GET', '/api/email-designs', undefined],
      ['GET', '/api/email-designs/4', undefined],
      ['PATCH', '/api/email-designs/4', { archived: true }],
      ['PATCH', '/api/email-designs/4', { archived: false }],
    ]);
  });
});

describe('open-assets — the image-picker command is stateless', () => {
  test('registered as a bare function: a stop member makes GrapesJS mark it active after one run and silently no-op every later image double-click (picker opened once per editor, 2026-11-04)', () => {
    expect(DESIGNER_SRC).toMatch(/Commands\.add\('open-assets', function \(/);
    expect(DESIGNER_SRC).not.toMatch(/'open-assets',\s*\{/);
  });
});

describe('merge tags — the compose list is the only list', () => {
  test('placeholdersFrom reads #c-placeholder-email (optgroups kept, the empty option skipped)', () => {
    const dom = new JSDOM(HTML);
    DOMS.push(dom);
    const list = D.placeholdersFrom(dom.window.document.getElementById('c-placeholder-email'));
    expect(list[0]).toEqual({ value: '{{contacts.contact_fname}}', label: 'First Name', group: null });
    expect(list.find((p) => p.value === '{{contacts.contact_token}}')).toEqual({ value: '{{contacts.contact_token}}', label: 'Contact Token (raw)', group: 'Booking (set slug)' });
    expect(list.length).toBe([...dom.window.document.querySelectorAll('#c-placeholder-email option')].filter((o) => o.value).length);
  });
  test('tagSelectHtml escapes values and labels', () => {
    const h = D.tagSelectHtml([{ value: '"><img src=x onerror=1>', label: '<b>x</b>', group: 'g&"' }], 'c', '{{ }}');
    expect(h).not.toMatch(/<img|<b>/);
    expect(h).toContain('&quot;&gt;&lt;img src=x onerror=1&gt;');
    expect(h).toContain('<optgroup label="g&amp;&quot;">');
  });
});

describe('exportDesign — ends rich-text editing BEFORE it reads the design (findings Q1)', () => {
  beforeAll(() => { global.DOMParser = DOMParser; });   // the browser's; deriveText needs one
  afterAll(() => { delete global.DOMParser; });
  test('an active text edit is ended first, so the last keystrokes are in the export', async () => {
    const ed = fakeEditor({ editing: true });
    const out = await D.exportDesign(ed);
    expect(ed.calls[0]).toBe('disableEditing');
    expect(out.html).toContain('Hello');
    expect(out.html).not.toContain('STALE');
    expect(Object.keys(out).sort()).toEqual(['design_json', 'html', 'mjml', 'text', 'warnings']);
  });
  test('no edit in progress → nothing to end', async () => {
    const ed = fakeEditor();
    await D.exportDesign(ed);
    expect(ed.calls).not.toContain('disableEditing');
  });
});

// ── 2. lazy loading ──────────────────────────────────────────────────────
describe('loadLibs — the pinned files, SRI, in order, once', () => {
  test('css + grapesjs first; the plugin only after grapesjs loaded; memoized', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
    DOMS.push(dom);
    const w = dom.window;
    w.eval(DESIGNER_SRC);
    const p1 = w.YcDesigner.loadLibs(w);
    const p2 = w.YcDesigner.loadLibs(w);
    expect(p2).toBe(p1);
    const tags = () => [...w.document.querySelectorAll('[data-yc-designer]')];
    expect(tags().map((t) => t.tagName)).toEqual(['LINK', 'SCRIPT']);
    const [link, s1] = tags();
    expect([link.getAttribute('href'), link.getAttribute('integrity'), link.getAttribute('crossorigin')]).toEqual([D.LIBS.css.href, D.LIBS.css.integrity, 'anonymous']);
    expect([s1.getAttribute('src'), s1.getAttribute('integrity'), s1.getAttribute('crossorigin')]).toEqual([D.LIBS.scripts[0].src, D.LIBS.scripts[0].integrity, 'anonymous']);
    w.grapesjs = { init() {}, version: '0.23.8' };
    s1.onload();
    await new Promise((r) => setTimeout(r, 0));
    const s2 = tags()[2];
    expect([s2.getAttribute('src'), s2.getAttribute('integrity'), s2.getAttribute('crossorigin')]).toEqual([D.LIBS.scripts[1].src, D.LIBS.scripts[1].integrity, 'anonymous']);
    w['grapesjs-mjml'] = { default: function plugin() {} };
    s2.onload();
    const libs = await p1;
    expect(libs.grapesjs).toBe(w.grapesjs);
    expect(typeof libs.plugin).toBe('function');
    expect(tags().length).toBe(3);
  });

  test('a file that fails (network or integrity) rejects, and a retry starts over', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
    DOMS.push(dom);
    const w = dom.window;
    w.eval(DESIGNER_SRC);
    const p1 = w.YcDesigner.loadLibs(w);
    w.document.querySelector('script[data-yc-designer]').onerror();
    await expect(p1).rejects.toThrow(/integrity check/);
    const p2 = w.YcDesigner.loadLibs(w);
    expect(p2).not.toBe(p1);
    p2.catch(() => {});
  });
});

// ── 3. campaign.html wiring ──────────────────────────────────────────────
const SIG_SENDER = { email: 'ops@firm.test', from_name: 'Ops', signature_html: '<p>SIG</p>' };

function boot(answer, { swal } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://app.4lsg.com/campaign.html', runScripts: 'outside-only' });
  DOMS.push(dom);
  const w = dom.window;
  const calls = [];
  const toasts = [];
  const dialogs = [];
  const parent = {
    apiSend: async (url, method, body) => { calls.push({ url, method, body }); return answer(url, method, body); },
    Swal: {
      mixin: () => ({ fire(o) { toasts.push(o); } }),
      fire: async (...a) => { dialogs.push(a); return swal ? swal(a) : { isConfirmed: false }; },
      close() {},
    },
    firmData: { emailFrom: [SIG_SENDER], phoneLines: [{ phone_number: '2485550000', mms_capable: 0 }] },
  };
  Object.defineProperty(w, 'parent', { value: parent, configurable: true });
  w.Quill = function () { return { on() {}, root: { innerHTML: '' } }; };
  w.Quill.import = () => class { static create() { return {}; } static value() { return {}; } };
  w.Quill.register = () => {};
  w.eval(DESIGNER_SRC);
  const m = HTML.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  const body = m[1].replace(/\(function waitForParent\(\)[\s\S]*$/, '');
  w.eval(`${body}
;phoneLines = P.firmData.phoneLines; emailAddresses = P.firmData.emailFrom; quill = new Quill();
window.__t = { onChannelChange, toggleEditorMode, syncCampaignSig, createCampaign, saveCurrentDesign, getBody, designer, startNewDesign, openDesignById,
  setSelected: (a) => { selectedContacts = a; }, mode: () => currentEditorMode };`);
  return { w, calls, toasts, dialogs, $: (id) => w.document.getElementById(id) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('campaign.html — Designer is the third editor mode, loaded only when picked', () => {
  test('the option exists; a plain boot injects nothing; picking it boots the editor in #designer-canvas with the compose list', async () => {
    const b = boot(() => ({}));
    expect([...b.$('c-editor-mode').options].map((o) => o.value)).toEqual(['richtext', 'html', 'designer']);
    b.w.__t.onChannelChange();
    expect(b.w.document.querySelectorAll('[data-yc-designer]').length).toBe(0);
    const seen = [];
    b.w.YcDesigner.createEditor = async (container, opts) => { seen.push({ container, opts }); return { on() {}, getProjectData: () => ({}) }; };
    b.$('c-editor-mode').value = 'designer';
    b.w.__t.toggleEditorMode();
    await flush();
    expect(seen.length).toBe(1);
    expect(seen[0].container).toBe(b.$('designer-canvas'));
    expect(seen[0].opts.placeholders.map((p) => p.value)).toEqual([...b.w.document.querySelectorAll('#c-placeholder-email option')].map((o) => o.value).filter(Boolean));
    expect(b.$('designer-wrap').classList.contains('hidden')).toBe(false);
    expect(b.$('quill-wrap').style.display).toBe('none');
    expect(b.$('html-editor').style.display).toBe('none');
    b.$('c-editor-mode').value = 'html';
    b.w.__t.toggleEditorMode();
    expect(b.$('designer-wrap').classList.contains('hidden')).toBe(true);
  });

  test('a designer that cannot load says so and falls back to the previous mode', async () => {
    const b = boot(() => ({}));
    b.w.__t.onChannelChange();
    b.w.YcDesigner.createEditor = async () => { throw new Error('Could not load grapes (integrity)'); };
    b.$('c-editor-mode').value = 'designer';
    b.w.__t.toggleEditorMode();
    await flush(); await flush();
    expect(b.dialogs.some((d) => d[0] === 'Designer unavailable' && /integrity/.test(d[1]))).toBe(true);
    expect(b.$('c-editor-mode').value).toBe('richtext');
    expect(b.$('designer-wrap').classList.contains('hidden')).toBe(true);
  });
});

describe('campaign.html — Designer → Rich Text with edited HTML, "Stay in HTML" (review nit 6)', () => {
  test('the HTML editor is shown again and the mode follows the select', async () => {
    const b = boot(() => ({}), { swal: () => ({ isConfirmed: false }) });
    b.w.__t.onChannelChange();
    b.$('c-editor-mode').value = 'html';
    b.w.__t.toggleEditorMode();
    b.$('html-editor').value = '<table><tr><td>hand-edited</td></tr></table>';   // differs from Quill's last output
    b.w.YcDesigner.createEditor = async () => ({ on() {}, getProjectData: () => ({}) });
    b.$('c-editor-mode').value = 'designer';
    b.w.__t.toggleEditorMode();
    await flush();
    b.$('c-editor-mode').value = 'richtext';
    b.w.__t.toggleEditorMode();
    await flush(); await flush();
    expect(b.dialogs.some((d) => d[0] && d[0].title === 'Switch to Rich Text?')).toBe(true);
    expect(b.$('c-editor-mode').value).toBe('html');
    expect(b.w.__t.mode()).toBe('html');
    expect(b.$('html-editor').style.display).toBe('block');
    expect(b.$('quill-wrap').style.display).toBe('none');
    expect(b.$('designer-wrap').classList.contains('hidden')).toBe(true);
  });
});

describe('campaign.html — unsaved design changes are confirmed before New / Open replace them (review should-fix 2)', () => {
  function dirtyDesigner(b) {
    b.w.__t.designer.editor = fakeEditor();
    b.w.__t.designer.booting = Promise.resolve(b.w.__t.designer.editor);
    b.w.__t.designer.cleanJson = '{"older":true}';   // the design differs from its last load / save
  }
  test('dirty + "Keep editing": New does not replace the design', async () => {
    const b = boot(() => ({}), { swal: () => ({ isConfirmed: false }) });
    b.w.__t.onChannelChange();
    dirtyDesigner(b);
    let replaced = 0;
    b.w.YcDesigner.newDesign = () => { replaced++; return { repaired: false }; };
    await b.w.__t.startNewDesign();
    expect(b.dialogs.map((d) => d[0] && d[0].title)).toContain('Discard unsaved changes?');
    expect(replaced).toBe(0);
  });
  test('dirty + "Keep editing": Open does not even fetch the other design', async () => {
    const b = boot(() => ({ design: { id: 3, name: 'x', design_json: designJson([SECTION, footerJson()]) } }), { swal: () => ({ isConfirmed: false }) });
    b.w.__t.onChannelChange();
    dirtyDesigner(b);
    expect(await b.w.__t.openDesignById(3, false)).toBe(false);
    expect(b.calls.some((c) => c.url === '/api/email-designs/3')).toBe(false);
  });
  test('dirty + confirmed: New proceeds; clean: no question asked', async () => {
    const b = boot(() => ({}), { swal: () => ({ isConfirmed: true }) });
    b.w.__t.onChannelChange();
    dirtyDesigner(b);
    let replaced = 0;
    b.w.YcDesigner.newDesign = () => { replaced++; return { repaired: false }; };
    await b.w.__t.startNewDesign();
    expect(replaced).toBe(1);
    const n = b.dialogs.length;
    b.w.__t.designer.cleanJson = JSON.stringify(b.w.__t.designer.editor.getProjectData());
    await b.w.__t.startNewDesign();
    expect(replaced).toBe(2);
    expect(b.dialogs.length).toBe(n);
  });
});

describe('campaign.html — signature append is disabled in Designer (design §6.3)', () => {
  test('greyed out with the reason in Designer; active again in Rich Text', async () => {
    const b = boot(() => ({}));
    b.w.__t.onChannelChange();
    b.w.__t.syncCampaignSig();
    expect(b.$('c-include-sig').disabled).toBe(false);
    b.$('c-include-sig').checked = true;
    b.w.YcDesigner.createEditor = async () => ({ on() {}, getProjectData: () => ({}) });
    b.$('c-editor-mode').value = 'designer';
    b.w.__t.toggleEditorMode();
    expect(b.$('c-include-sig').disabled).toBe(true);
    expect(b.$('c-include-sig').checked).toBe(false);
    expect(b.$('c-sig-note').textContent).toMatch(/Designer/);
    expect(b.$('c-sig-block').style.display).toBe('none');
    b.$('c-editor-mode').value = 'richtext';
    b.w.__t.toggleEditorMode();
    expect(b.$('c-include-sig').disabled).toBe(false);
  });
});

describe('campaign.html — save, rejection, create', () => {
  function withEditor(b, opts) {
    b.w.__t.designer.editor = fakeEditor(opts);
    b.w.__t.designer.booting = Promise.resolve(b.w.__t.designer.editor);
    b.$('c-editor-mode').value = 'designer';
    b.w.__t.toggleEditorMode();
  }

  test('Save design POSTs the contract body (rich-text editing ended first); a second save PUTs; Save as new POSTs', async () => {
    let n = 0;
    const b = boot((url) => (url.startsWith('/api/email-designs') ? { success: true, id: url === '/api/email-designs' ? ++n + 40 : 41 } : {}));
    b.w.__t.onChannelChange();
    withEditor(b, { editing: true });
    b.$('d-name').value = 'June newsletter';
    expect(await b.w.__t.saveCurrentDesign(false)).toBe(true);
    let c = b.calls.filter((x) => x.url.startsWith('/api/email-designs'));
    expect(c[0].url).toBe('/api/email-designs');
    expect(c[0].method).toBe('POST');
    expect(Object.keys(c[0].body).sort()).toEqual(['design_json', 'html', 'name', 'text']);
    expect(c[0].body.name).toBe('June newsletter');
    expect(c[0].body.html).toBe(GOOD_HTML);          // not the stale pre-RTE-end copy
    expect(c[0].body.design_json).toEqual(designJson([SECTION, footerJson()]));
    expect(b.w.__t.designer.id).toBe(41);
    await b.w.__t.saveCurrentDesign(false);
    await b.w.__t.saveCurrentDesign(true);
    c = b.calls.filter((x) => x.url.startsWith('/api/email-designs'));
    expect(c.map((x) => `${x.method} ${x.url}`)).toEqual(['POST /api/email-designs', 'PUT /api/email-designs/41', 'POST /api/email-designs']);
  });

  test('a 400 design_rejected is shown with its rule and detail; nothing is marked saved', async () => {
    const b = boot((url) => {
      if (url.startsWith('/api/email-designs')) throw Object.assign(new Error('Design rejected'), { status: 400, body: { error: 'Design rejected', code: 'design_rejected', rule: 4, detail: 'attribute "onerror" on img' } });
      return {};
    });
    b.w.__t.onChannelChange();
    withEditor(b);
    b.$('d-name').value = 'x';
    expect(await b.w.__t.saveCurrentDesign(false)).toBe(false);
    expect(b.dialogs.pop()).toEqual(['The server refused this design', 'Rule 4 (attribute): attribute "onerror" on img', 'error']);
    expect(b.w.__t.designer.id).toBe(null);
  });

  test('a save warning (Gmail clipping size) is shown, and the save stands', async () => {
    const b = boot((url) => (url.startsWith('/api/email-designs') ? { success: true, id: 5, warning: 'html is 97 KB; Gmail clips past ~102 KB' } : {}));
    b.w.__t.onChannelChange();
    withEditor(b);
    b.$('d-name').value = 'big';
    expect(await b.w.__t.saveCurrentDesign(false)).toBe(true);
    expect(b.dialogs.pop()).toEqual(['Saved — with a warning', 'html is 97 KB; Gmail clips past ~102 KB', 'warning']);
  });

  test('the editor\'s own check stops a broken export before any request', async () => {
    const b = boot(() => ({ success: true, id: 1 }));
    b.w.__t.onChannelChange();
    withEditor(b, { html: '<body>no marker</body>' });
    b.$('d-name').value = 'x';
    expect(await b.w.__t.saveCurrentDesign(false)).toBe(false);
    expect(b.calls.some((x) => x.url.startsWith('/api/email-designs'))).toBe(false);
    expect(b.dialogs.pop()[0]).toBe('Design problem');
  });

  test('Create sends the compiled html as the body + design_id — and never the signature, even if the box were forced on', async () => {
    const b = boot((url) => (url === '/api/campaigns' ? { campaignId: 9, status: 'sending' } : url.startsWith('/api/email-designs') ? { success: true, id: 7 } : { campaigns: [] }), { swal: () => ({ isConfirmed: true }) });
    b.w.__t.onChannelChange();
    withEditor(b);
    b.$('d-name').value = 'June';
    await b.w.__t.saveCurrentDesign(false);
    b.w.__t.setSelected([{ contact_id: 42 }]);
    b.$('c-subject').value = 'June news';
    const sig = b.$('c-include-sig');
    sig.disabled = false; sig.checked = true;
    b.$('c-sig-block').innerHTML = '<p>SIG</p>';
    await b.w.__t.createCampaign();
    const post = b.calls.find((x) => x.url === '/api/campaigns' && x.method === 'POST');
    expect(post.body.body).toBe(GOOD_HTML);
    expect(post.body.design_id).toBe(7);
    expect(post.body.body).not.toContain('SIG');
  });

  test('changes since the last save: "Send without saving" creates with no design_id', async () => {
    const b = boot((url) => (url === '/api/campaigns' ? { campaignId: 9, status: 'sending' } : { campaigns: [] }), {
      swal: (a) => (a[0] && a[0].showDenyButton ? { isConfirmed: false, isDenied: true } : { isConfirmed: true }),
    });
    b.w.__t.onChannelChange();
    withEditor(b);
    b.w.__t.designer.id = 7;
    b.w.__t.designer.savedHtml = '<body>older</body>';
    b.w.__t.setSelected([{ contact_id: 42 }]);
    b.$('c-subject').value = 'June news';
    await b.w.__t.createCampaign();
    const post = b.calls.find((x) => x.url === '/api/campaigns' && x.method === 'POST');
    expect(post.body.body).toBe(GOOD_HTML);
    expect('design_id' in post.body).toBe(false);
  });

  test('getBody in Designer is the compiled html', async () => {
    const b = boot(() => ({}));
    b.w.__t.onChannelChange();
    withEditor(b);
    expect(await b.w.__t.getBody()).toBe(GOOD_HTML);
  });
});
