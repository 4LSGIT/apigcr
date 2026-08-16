/**
 * Form-dev gate — builder UI half (2026-08-16,
 * ref/EXTERNAL_CODE_CSS_DECISION.md §Q5). public/formBuilder.html under
 * jsdom, same harness as formBuilder_slice26.test.js but booted as a PLAIN
 * STAFF session (roles 'staff', no form_dev / it / SU) — the server enforces;
 * this suite locks that the UI never offers an action that will 403.
 *
 * Covers:
 *   - Custom code / Hooks / Custom CSS editors are disabled with the
 *     "requires form-developer authorization" note.
 *   - A visibility flip off-internal is refused CLIENT-SIDE with the legible
 *     message, the select reverts, and NO /visibility POST is sent.
 *   - Flip back to internal is offered (select enabled; visFlow proceeds to
 *     the server for it).
 *   - The standing "dark externally" badge shows when visibility is
 *     portal/public and the PUBLISHED definition carries refused keys, and
 *     stays hidden otherwise.
 *   - A form-dev session (SU) keeps the editors enabled (control case).
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/formBuilder.html'), 'utf8');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

const cleanDef = {
  sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text', label: 'A' }] }] }],
};
const codeDef = { ...cleanDef, code: 'window.ycHooks = {};' };

function bootBuilder({ currentUser, rowOver } = {}) {
  const ROW = {
    id: 1, form_key: 'gate_ui', title: 'Gate UI', link_type: 'case',
    schema_version: 1, published_at: null, definition: null,
    visibility: 'internal',
    draft_definition: JSON.parse(JSON.stringify(cleanDef)),
    ...(rowOver || {}),
  };
  const sent = [];   // every non-GET apiSend
  const dom = new JSDOM(HTML, {
    url: 'https://app.4lsg.com/formBuilder.html?id=1',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.firmData = { currentUser: currentUser || { user_auth: 'authorized', roles: 'staff' } };
      window.apiSend = async (url, method, body) => {
        if (method === 'GET' && url === '/api/form-templates/1') {
          return { status: 'success', template: JSON.parse(JSON.stringify(ROW)) };
        }
        sent.push({ url, method, body: body ? JSON.parse(JSON.stringify(body)) : undefined });
        if (method === 'PUT' && url === '/api/form-templates/1') {
          return { status: 'success', template: JSON.parse(JSON.stringify(ROW)) };
        }
        if (method === 'POST' && url === '/api/form-templates/1/visibility') {
          ROW.visibility = body.visibility;
          return { status: 'success', visibility: body.visibility };
        }
        throw new Error('unexpected apiSend ' + method + ' ' + url);
      };
    },
  });
  DOMS.push(dom);
  return { dom, win: dom.window, doc: dom.window.document, sent };
}

async function ready(p) {
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

describe('form-dev gate — builder UI (plain staff session)', () => {
  test('code / hooks / css editors are locked with the authorization note', async () => {
    const p = await ready(bootBuilder({ rowOver: { draft_definition: JSON.parse(JSON.stringify(codeDef)) } }));
    p.win.showTab('settings');

    for (const label of ['Custom code (advanced)', 'Hooks file', 'CSS (advanced)']) {
      const prop = settingsPropByLabel(p.doc, label);
      expect(prop).toBeTruthy();
      const input = prop.querySelector('textarea, input');
      expect(input.disabled).toBe(true);
      const helps = [...prop.querySelectorAll('.help')].map(h => h.textContent).join(' ');
      expect(helps).toContain('form-developer authorization');
      expect(helps).toContain('form_dev');
    }
  });

  test('off-internal visibility flip: legible refusal, select reverts, NO POST sent', async () => {
    const p = await ready(bootBuilder());
    const sel = p.doc.getElementById('visSelect');
    expect(sel.value).toBe('internal');
    expect(sel.title).toContain('form-developer authorization');

    sel.value = 'public';
    sel.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    await sleep(30);

    expect(sel.value).toBe('internal');                              // reverted
    const err = p.doc.getElementById('errBar').textContent;
    expect(err).toContain('form-developer authorization');
    expect(err).toContain('form_dev');
    expect(p.sent.filter(s => s.url.endsWith('/visibility')).length).toBe(0);
  });

  test('flip BACK to internal is offered and goes to the server', async () => {
    const p = await ready(bootBuilder({ rowOver: { visibility: 'public', definition: cleanDef, published_at: 'p' } }));
    const sel = p.doc.getElementById('visSelect');
    expect(sel.value).toBe('public');
    expect(sel.disabled).toBe(false);

    sel.value = 'internal';
    sel.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    await sleep(30);

    const posts = p.sent.filter(s => s.url.endsWith('/visibility'));
    expect(posts.length).toBe(1);
    expect(posts[0].body).toEqual({ visibility: 'internal' });
    expect(sel.value).toBe('internal');
  });

  test('standing "runs in clients’ browsers" badge: shown when exposed + published executing keys, hidden otherwise', async () => {
    const dark = await ready(bootBuilder({ rowOver: {
      visibility: 'public', published_at: 'p',
      definition: JSON.parse(JSON.stringify(codeDef)),
    } }));
    const badge = dark.doc.getElementById('extDarkBadge');
    expect(badge.style.display).not.toBe('none');
    expect(badge.textContent).toContain('runs in clients');
    expect(badge.title).toContain('code');
    expect(badge.title).toContain('third-party');

    // Clean published definition, same visibility → no badge.
    const clean = await ready(bootBuilder({ rowOver: {
      visibility: 'public', published_at: 'p',
      definition: JSON.parse(JSON.stringify(cleanDef)),
    } }));
    expect(clean.doc.getElementById('extDarkBadge').style.display).toBe('none');

    // Internal template carrying code → no badge (nothing served externally).
    const internal = await ready(bootBuilder({ rowOver: {
      visibility: 'internal', published_at: 'p',
      definition: JSON.parse(JSON.stringify(codeDef)),
    } }));
    expect(internal.doc.getElementById('extDarkBadge').style.display).toBe('none');
  });
});

describe('form-dev gate — control case (SU session keeps editors enabled)', () => {
  test('SU: code editor enabled; hooks/code mutual exclusion still governs', async () => {
    const p = await ready(bootBuilder({
      currentUser: { user_auth: 'authorized - SU', roles: 'it,admin' },
    }));
    p.win.showTab('settings');
    const code = settingsPropByLabel(p.doc, 'Custom code (advanced)').querySelector('textarea');
    expect(code.disabled).toBe(false);
    const css = settingsPropByLabel(p.doc, 'CSS (advanced)').querySelector('textarea');
    expect(css.disabled).toBe(false);
  });

  test('roles form_dev (non-SU) also unlocks', async () => {
    const p = await ready(bootBuilder({
      currentUser: { user_auth: 'authorized', roles: 'staff,form_dev' },
    }));
    p.win.showTab('settings');
    const code = settingsPropByLabel(p.doc, 'Custom code (advanced)').querySelector('textarea');
    expect(code.disabled).toBe(false);
  });
});
