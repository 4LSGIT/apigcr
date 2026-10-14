// tests/sessionKeysUi.test.js
//
/**
 * Session-key UI + the create-hook cosmetic hide — access-control B3
 * (public/readonlyKeys.html, public/pageManager.html).
 *
 * WHAT IS LOCKED (both pages driven in jsdom, their own scripts running)
 *   - readonlyKeys.html: the copy says "session key"; the scopes picker is
 *     built from the server's vocabulary (no copy in the page) with exactly
 *     the default trio pre-ticked and every temp.* unticked, the temp.*
 *     warning shown; Create sends the ticked scopes (a temp.* when ticked);
 *     nothing ticked → no request; the list shows a key's scopes and
 *     "all (legacy)" for a NULL-scopes key.
 *   - pageManager.html: the "Create hook for this page" button renders for
 *     su / it / admin and is replaced by a sentence for everyone else.
 *
 * Run: npx jest tests/sessionKeysUi.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { KEY_SCOPES } = require('../lib/capabilities');

const ROOT = path.join(__dirname, '..');
const flush = () => new Promise(r => setTimeout(r, 0));
const VOCAB = Object.entries(KEY_SCOPES).map(([name, v]) => ({ name, desc: v.desc }));

function bootKeys({ keys = [] } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'readonlyKeys.html'), 'utf8');
  const sent = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(w) {
      w.alert = (m) => sent.push({ alert: m });
      w.apiSend = async (url, method, body) => {
        sent.push({ url, method, body });
        if (method === 'GET' && url.startsWith('/api/readonly-keys?')) {
          return { ok: true, keys, max_ttl_days: 3, scope_vocabulary: VOCAB, default_scopes: ['sql.ro', 'scratch', 'alert'] };
        }
        if (method === 'POST') {
          return { ok: true, key: 'ycro_x', label: body.label, scopes: body.scopes, expiresAt: new Date().toISOString(), ttlMinutes: 1440 };
        }
        return { ok: true };
      };
    },
  });
  return { w: dom.window, sent };
}

describe('readonlyKeys.html — session keys', () => {
  test('the copy says session key', async () => {
    const { w } = bootKeys();
    await flush();
    expect(w.document.title).toBe('Session Keys');
    expect(w.document.body.textContent).toMatch(/Create a session key/);
    expect(w.document.body.textContent).not.toMatch(/readonly key/i);
  });

  test('picker: from the vocabulary, default trio ticked, temp.* unticked, warning shown', async () => {
    const { w } = bootKeys();
    await flush(); await flush();
    const boxes = [...w.document.querySelectorAll('.scope-box')];
    expect(boxes.map(b => b.value)).toEqual(Object.keys(KEY_SCOPES));
    expect(boxes.filter(b => b.checked).map(b => b.value)).toEqual(['sql.ro', 'scratch', 'alert']);
    for (const b of boxes.filter(x => x.value.startsWith('temp.'))) expect(b.checked).toBe(false);
    expect(w.document.getElementById('tempWarn').textContent).toMatch(/external provider/);
  });

  test('Create sends the ticked scopes, a temp.* included when ticked', async () => {
    const { w, sent } = bootKeys();
    await flush(); await flush();
    w.document.getElementById('newLabel').value = 'clio task';
    w.document.querySelector('.scope-box[value="temp.clio"]').checked = true;
    w.document.querySelector('.scope-box[value="alert"]').checked = false;
    await w.createKey();
    const post = sent.find(s => s.method === 'POST');
    expect(post.body).toEqual({ label: 'clio task', scopes: ['sql.ro', 'scratch', 'temp.clio'] });
    expect(w.document.getElementById('newKeyArea').textContent).toMatch(/Scopes: sql\.ro, scratch, temp\.clio/);
  });

  test('nothing ticked → no request, an explanation instead', async () => {
    const { w, sent } = bootKeys();
    await flush(); await flush();
    w.document.getElementById('newLabel').value = 'empty';
    for (const b of w.document.querySelectorAll('.scope-box')) b.checked = false;
    await w.createKey();
    expect(sent.some(s => s.method === 'POST')).toBe(false);
    expect(sent.some(s => s.alert && /at least one scope/.test(s.alert))).toBe(true);
  });

  test('the list shows scopes, and "all (legacy)" for a NULL-scopes key', async () => {
    const future = new Date(Date.now() + 864e5).toISOString();
    const { w } = bootKeys({ keys: [
      { id: 75, key_prefix: 'ycro_0a1b2c3', label: 'claude long key', scopes: null, expires_at: future, use_count: 3 },
      { id: 90, key_prefix: 'ycro_Ab3dE9x', label: 'new', scopes: ['sql.ro', 'scratch'], expires_at: future, use_count: 0 },
    ] });
    await flush(); await flush();
    const cells = [...w.document.querySelectorAll('#keysTbody .scope-cell')].map(td => td.textContent.trim());
    expect(cells).toEqual(['all (legacy)', 'sql.ro, scratch']);
  });
});

describe('pageManager.html — create-hook button', () => {
  function bootPages(roles) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'pageManager.html'), 'utf8');
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      beforeParse(w) {
        w.firmData = { currentUser: { user: 5, roles } };
        w.apiSend = async () => ({ status: 'success', pages: [] });
      },
    });
    return dom.window;
  }

  for (const [roles, shown] of [['su', true], ['it', true], ['it,admin', true], ['admin,staff,attorney', true],
                                 ['staff', false], ['staff,attorney', false], ['form_dev', false], ['', false]]) {
    test(`roles "${roles}" → button ${shown ? 'shown' : 'hidden'}`, async () => {
      const w = bootPages(roles);
      await flush();
      w.renderHookRow({ id: 4, slug: 'promo', hook_slug: null });
      const row = w.document.getElementById('hook-row');
      expect(!!row.querySelector('#create-hook-btn')).toBe(shown);
      if (!shown) expect(row.textContent).toMatch(/needs the admin, IT or super-user role/);
    });
  }

  test('a page that already has a hook shows it for everyone', async () => {
    const w = bootPages('staff');
    await flush();
    w.renderHookRow({ id: 4, slug: 'promo', hook_slug: 'lp-promo' });
    expect(w.document.getElementById('hook-row').textContent).toMatch(/lp-promo/);
  });
});
