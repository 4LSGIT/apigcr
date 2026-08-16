// X-appearance (2026-08-16 — ref/EXTERNAL_CODE_CSS_DECISION.md §Q1): the
// EXTERNAL-SAFE per-form styling channel — external.appearance.{bgFrom,bgTo}
// as strict hex-color CSS custom property VALUES, the sanctioned alternative
// to free-form css (which stays refused on external surfaces, §4).
//
// Covers:
//   validateDefinition — exact-key appearance object; strict hex enforcement
//     (rejects named colors, url(), overlong, non-strings); tolerated
//     absent/null; unknown external keys still rejected.
//   scanExternalRefusals — appearance does NOT trip the refusal scan (being
//     servable externally is its point); fieldSignature unaffected (a color
//     change never bumps schema_version).
//   GET /api/ext/forms route hoist — appearance rides the response top level
//     (never inside the projected definition); the per-key hex re-filter
//     drops out-of-shape values (belt and suspenders); absent appearance →
//     no response key.
//   render.html EXT boot — body gets class yc-ext; validated values land as
//     --yc-ext-bg-from/--yc-ext-bg-to via setProperty; out-of-shape values
//     are NOT applied; absent appearance still gets the class (defaults keep
//     today's flat background).
//   builder — the appearance inputs are editable by PLAIN STAFF (deliberately
//     not form_dev-gated), write MODEL.external.appearance, and clearing both
//     deletes the object (canonical-minimal).
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'services', 'formTemplateService.js'));

// ═════════════════════════════════════════════════════════════════════════════
// validateDefinition + scan/signature
// ═════════════════════════════════════════════════════════════════════════════

const baseDef = () => ({
  sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }],
});

describe('validateDefinition — external.appearance', () => {
  const withAp = (ap) => ({ ...baseDef(), external: { appearance: ap } });

  test('valid hex shapes accepted (#rgb, #rgba, #rrggbb, #rrggbbaa; case-insensitive)', () => {
    for (const v of ['#fff', '#FFFa', '#0F2343', '#0f234380']) {
      expect(() => svc.validateDefinition(withAp({ bgFrom: v }))).not.toThrow();
    }
    expect(() => svc.validateDefinition(withAp({ bgFrom: '#0F2343', bgTo: '#01B0EB' }))).not.toThrow();
  });

  test('absent / null appearance tolerated; empty object tolerated', () => {
    expect(() => svc.validateDefinition({ ...baseDef(), external: { badLink: 'reject' } })).not.toThrow();
    expect(() => svc.validateDefinition(withAp(null))).not.toThrow();
    expect(() => svc.validateDefinition(withAp({}))).not.toThrow();
  });

  test('REJECTS everything that is not a strict hex color', () => {
    for (const v of ['red', 'url(https://evil.test/p.png)', 'rgb(1,2,3)', '#12345', '#gggggg',
                     ' #fff', '#fff ', 'javascript:alert(1)', '#fffffff00', 123, true]) {
      expect(() => svc.validateDefinition(withAp({ bgFrom: v })))
        .toThrow(/must be a hex color/);
    }
  });

  test('exact-key: unknown appearance keys and non-object shapes rejected', () => {
    expect(() => svc.validateDefinition(withAp({ bgMiddle: '#fff' })))
      .toThrow(/unknown key "bgMiddle"/);
    expect(() => svc.validateDefinition(withAp(['#fff'])))
      .toThrow(/must be an object/);
    // the external allowlist itself grew by exactly one key
    expect(() => svc.validateDefinition({ ...baseDef(), external: { apearance: {} } }))
      .toThrow(/allowed: badLink, postSubmit, appearance/);
  });

  test('appearance never trips scanExternalRefusals and never moves fieldSignature', () => {
    const def = withAp({ bgFrom: '#0F2343', bgTo: '#01B0EB' });
    expect(svc.scanExternalRefusals(def)).toEqual([]);
    expect(svc.fieldSignature(def)).toBe(svc.fieldSignature(baseDef()));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/ext/forms — response hoist (supertest-free: express in-process)
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
        if (/FROM cases/.test(sql)) return [[]];            // no case — anonymous path
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
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

const servableRow = (defOver) => ({
  form_key: 'ap_test', title: 'Ap', link_type: 'case', schema_version: 1,
  visibility: 'public',
  definition: {
    external: { badLink: 'degrade', ...(defOver && defOver.external) },
    sections: baseDef().sections,
    ...(defOver && defOver.top),
  },
});

describe('GET /api/ext/forms — appearance hoist', () => {
  test('validated appearance rides the response top level, never the definition', async () => {
    const app = extApp(servableRow({ external: { appearance: { bgFrom: '#0F2343', bgTo: '#01B0EB' } } }));
    const { status, body } = await get(app, '/api/ext/forms/ap_test');
    expect(status).toBe(200);
    expect(body.appearance).toEqual({ bgFrom: '#0F2343', bgTo: '#01B0EB' });
    expect('external' in body.definition).toBe(false);   // §D allowlist unchanged
  });

  test('belt-and-suspenders re-filter: out-of-shape values dropped per key', async () => {
    const app = extApp(servableRow({ external: { appearance: {
      bgFrom: 'url(https://evil.test/p.png)',   // would only exist via direct DB write
      bgTo: '#01B0EB',
    } } }));
    const { body } = await get(app, '/api/ext/forms/ap_test');
    expect(body.appearance).toEqual({ bgTo: '#01B0EB' });
  });

  test('absent appearance → no response key; everything else unchanged', async () => {
    const app = extApp(servableRow());
    const { status, body } = await get(app, '/api/ext/forms/ap_test');
    expect(status).toBe(200);
    expect('appearance' in body).toBe(false);
    expect(body.status).toBe('success');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// render.html EXT boot — class + custom properties
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

const EXT_DEF = {
  sections: [{ title: 'S', rows: [{ fields: [{ name: 'reason', type: 'text' }] }] }],
};

function makeExtPage(getBody) {
  const dom = new JSDOM(RENDER_HTML, {
    url: 'https://app.test/forms/render.html?form_key=ap_test&ext=1',
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v) };
      window.fetch = async () => ({ ok: true, status: 200, json: async () => getBody });
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

const extBody = (extra) => ({
  status: 'success', title: 'Ap', link_type: 'case', schema_version: 1,
  definition: EXT_DEF, load: null, linked: false, ...extra,
});

describe('render.html EXT boot — appearance application', () => {
  test('validated colors land as custom properties; body carries yc-ext', async () => {
    const w = await extReady(makeExtPage(extBody({
      appearance: { bgFrom: '#0F2343', bgTo: '#01B0EB' },
    })));
    expect(w.document.body.classList.contains('yc-ext')).toBe(true);
    expect(w.document.body.style.getPropertyValue('--yc-ext-bg-from')).toBe('#0F2343');
    expect(w.document.body.style.getPropertyValue('--yc-ext-bg-to')).toBe('#01B0EB');
  });

  test('out-of-shape values are NOT applied (renderer re-guard)', async () => {
    const w = await extReady(makeExtPage(extBody({
      appearance: { bgFrom: 'url(https://evil.test/p.png)', bgTo: '#01B0EB' },
    })));
    expect(w.document.body.style.getPropertyValue('--yc-ext-bg-from')).toBe('');
    expect(w.document.body.style.getPropertyValue('--yc-ext-bg-to')).toBe('#01B0EB');
  });

  test('absent appearance: yc-ext class still set, no properties written', async () => {
    const w = await extReady(makeExtPage(extBody()));
    expect(w.document.body.classList.contains('yc-ext')).toBe(true);
    expect(w.document.body.style.getPropertyValue('--yc-ext-bg-from')).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// builder — appearance inputs are staff-editable (NOT form_dev-gated)
// ═════════════════════════════════════════════════════════════════════════════

const BUILDER_HTML = fs.readFileSync(path.join(ROOT, 'public/formBuilder.html'), 'utf8');

function bootBuilder(draft) {
  const ROW = {
    id: 1, form_key: 'ap_builder', title: 'Ap', link_type: 'case',
    schema_version: 1, published_at: null, definition: null, visibility: 'internal',
    draft_definition: draft,
  };
  const dom = new JSDOM(BUILDER_HTML, {
    url: 'https://app.4lsg.com/formBuilder.html?id=1',
    runScripts: 'dangerously',
    beforeParse(window) {
      // PLAIN STAFF — the gate contrast case: appearance stays editable.
      window.firmData = { currentUser: { user_auth: 'authorized', roles: 'staff' } };
      window.apiSend = async (url, method) => {
        if (method === 'GET' && url === '/api/form-templates/1') {
          return { status: 'success', template: JSON.parse(JSON.stringify(ROW)) };
        }
        throw new Error('unexpected apiSend ' + method + ' ' + url);
      };
    },
  });
  DOMS.push(dom);
  return { dom, win: dom.window, doc: dom.window.document };
}

async function builderReady(p) {
  for (let i = 0; i < 100; i++) {
    if (p.win.FB && p.win.FB.model) return p;
    await sleep(20);
  }
  throw new Error('builder never initialized');
}

function settingsPropByLabel(doc, labelText) {
  return [...doc.querySelectorAll('#settingsPane .prop')]
    .find(pr => pr.querySelector('label') && pr.querySelector('label').textContent === labelText);
}
function fire(win, el, type) { el.dispatchEvent(new win.Event(type, { bubbles: true })); }

describe('builder — appearance inputs (staff-editable, canonical-minimal)', () => {
  test('plain staff can set both colors; clearing both deletes external.appearance', async () => {
    const p = await builderReady(bootBuilder(baseDef()));
    p.win.showTab('settings');

    const from = settingsPropByLabel(p.doc, 'Backdrop gradient — top (appearance.bgFrom)').querySelector('input');
    const to   = settingsPropByLabel(p.doc, 'Backdrop gradient — bottom (appearance.bgTo)').querySelector('input');
    expect(from.disabled).toBe(false);   // deliberately NOT form_dev-gated
    expect(to.disabled).toBe(false);

    from.value = '#0F2343'; fire(p.win, from, 'input');
    to.value   = '#01B0EB'; fire(p.win, to, 'input');
    expect(p.win.FB.model.external.appearance).toEqual({ bgFrom: '#0F2343', bgTo: '#01B0EB' });
    expect(() => svc.validateDefinition(p.win.FB.model)).not.toThrow();

    from.value = ''; fire(p.win, from, 'input');
    to.value   = ''; fire(p.win, to, 'input');
    expect(p.win.FB.model.external).toBeUndefined();   // canonical-minimal cleanup
  });

  test('invalid color is validate-blocked and never reaches the model', async () => {
    const p = await builderReady(bootBuilder(baseDef()));
    p.win.showTab('settings');
    const from = settingsPropByLabel(p.doc, 'Backdrop gradient — top (appearance.bgFrom)').querySelector('input');
    from.value = 'url(https://evil.test/p.png)'; fire(p.win, from, 'input');
    expect(p.win.FB.model.external).toBeUndefined();
  });
});
