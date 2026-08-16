// External code/css/hooks/embed reversal (2026-08-16 —
// ref/EXTERNAL_CODE_CSS_DECISION.md): authored executable content SERVES and
// EXECUTES externally. Authoring is form_dev-gated at the write; the builder
// warns at the exposure moments; nothing refuses at serve time.
//
// Locks:
//   projectDefinition — code/css/hooks survive onto the public wire; embed
//     fields ride with their height; server-only keys still stripped.
//   GET /api/ext/forms — a code+css+embed template serves 200 with the keys
//     on the wire (route-level, express in-process).
//   render.html ext boot — template `code` EXECUTES (window.ycHooks defined,
//     onLoad observed), `css` is injected as a <style data-yc-form-css>, and
//     an embed field renders its https iframe. The https-only embed-src
//     re-check still stands (http src → no iframe).
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const extSvc = require(path.join(ROOT, 'services', 'extFormService.js'));

// ═════════════════════════════════════════════════════════════════════════════
// projection
// ═════════════════════════════════════════════════════════════════════════════

const EXEC_DEF = {
  code: "window.ycHooks = { async onLoad(f) { window.__extCodeRan = true; } };",
  css: '.yc-section-title { color: rgb(15, 35, 67); }',
  sections: [{ title: 'S', rows: [{ fields: [
    { name: 'reason', type: 'text' },
    { name: 'sched', type: 'embed', src: 'https://cal.example.test/ash', height: 480 },
  ] }] }],
};

describe('projectDefinition — reversal: authored keys reach the wire', () => {
  test('code/css/hooks survive; embed keeps src+height; server-only keys still stripped', () => {
    const def = {
      ...EXEC_DEF,
      hooks: null,
      endpoints: { load: { url: '/api/cases/{linkId}' } },
      onSubmit: { workflow: { id: 40 } },
      external: { badLink: 'degrade' },
    };
    const p = extSvc.projectDefinition(def);
    expect(p.code).toBe(EXEC_DEF.code);
    expect(p.css).toBe(EXEC_DEF.css);
    const embed = p.sections[0].rows[0].fields[1];
    expect(embed).toEqual(expect.objectContaining({
      type: 'embed', src: 'https://cal.example.test/ash', height: 480,
    }));
    const flat = JSON.stringify(p);
    for (const leaked of ['endpoints', 'onSubmit', 'external', 'workflow']) {
      expect(flat).not.toContain(leaked);
    }
  });

  test('hooks (named repo file) survives too', () => {
    const p = extSvc.projectDefinition({ hooks: 'notes_341', sections: EXEC_DEF.sections });
    expect(p.hooks).toBe('notes_341');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// route — code+css+embed template serves
// ═════════════════════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');

function extApp(templateRow) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.db = {
      query: async (sql) => {
        if (/FROM form_templates/.test(sql)) return [[templateRow]];
        if (/FROM cases/.test(sql)) return [[]];
        throw new Error('unscripted query: ' + sql);
      },
    };
    next();
  });
  app.use(require(path.join(ROOT, 'routes', 'api.ext.forms.js')));
  return app;
}

function get(app, urlPath) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ port, path: urlPath }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

describe('GET /api/ext/forms — code+css+embed template serves (refusal retired)', () => {
  test('200 with the executing keys on the wire', async () => {
    const app = extApp({
      form_key: 'exec_test', title: 'Exec', link_type: 'case', schema_version: 1,
      visibility: 'public',
      definition: { ...EXEC_DEF, external: { badLink: 'degrade' } },
    });
    const { status, body } = await get(app, '/api/ext/forms/exec_test');
    expect(status).toBe(200);
    expect(body.definition.code).toBe(EXEC_DEF.code);
    expect(body.definition.css).toBe(EXEC_DEF.css);
    expect(body.definition.sections[0].rows[0].fields[1].type).toBe('embed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// renderer — code executes, css injects, embed renders (ext boot)
// ═════════════════════════════════════════════════════════════════════════════

const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    return Promise.resolve(Buffer.from(''));
  }
}

const DOMS = [];
afterAll(() => DOMS.forEach((d) => { try { d.window.close(); } catch (_) {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeExtPage(definition) {
  const dom = new JSDOM(RENDER_HTML, {
    url: 'https://app.test/forms/render.html?form_key=exec_test&ext=1',
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v) };
      window.fetch = async () => ({ ok: true, status: 200, json: async () => ({
        status: 'success', title: 'Exec', link_type: 'case', schema_version: 1,
        definition, load: null, linked: false,
      }) });
    },
  });
  DOMS.push(dom);
  return dom;
}

async function extReady(dom) {
  const w = dom.window;
  for (let i = 0; i < 200; i++) {
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none') return w;
    await sleep(20);
  }
  throw new Error('ext form never finished init');
}

describe('render.html ext boot — authored content executes (reversal)', () => {
  test('template code RUNS (ycHooks defined, onLoad observed) and css is injected', async () => {
    const w = await extReady(makeExtPage(extSvcProject(EXEC_DEF)));
    // code executed synchronously before init → ycHooks exists…
    expect(typeof w.ycHooks).toBe('object');
    // …and its onLoad actually ran during boot.
    for (let i = 0; i < 50 && !w.__extCodeRan; i++) await sleep(20);
    expect(w.__extCodeRan).toBe(true);
    // css injected as the data-tagged <style>, verbatim.
    const styleEl = w.document.querySelector('style[data-yc-form-css]');
    expect(styleEl).toBeTruthy();
    expect(styleEl.textContent).toBe(EXEC_DEF.css);
  });

  test('embed field renders its https iframe (and the https-only re-check stands)', async () => {
    const w = await extReady(makeExtPage(extSvcProject(EXEC_DEF)));
    const frame = w.document.querySelector('iframe[data-yc-embed="sched"]');
    expect(frame).toBeTruthy();
    expect(frame.getAttribute('src')).toBe('https://cal.example.test/ash');

    // http (non-https) src degrades to no iframe — the §Q belt-and-braces.
    const badDef = JSON.parse(JSON.stringify(EXEC_DEF));
    delete badDef.code; delete badDef.css;
    badDef.sections[0].rows[0].fields[1].src = 'http://cal.example.test/ash';
    const w2 = await extReady(makeExtPage(extSvcProject(badDef)));
    expect(w2.document.querySelector('iframe[data-yc-embed="sched"]')).toBeNull();
  });
});

// serve what the route would: the PROJECTED definition.
function extSvcProject(def) {
  return extSvc.projectDefinition(def);
}
