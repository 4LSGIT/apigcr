// tests/sharedValuesPage.test.js
//
/**
 * Admin → Shared values (public/sharedValues.html), run for REAL in jsdom:
 * the page's own markup and whole inline script, under a parent window
 * playing the shell (apiSend, firmData). Its apiSend calls the REAL router +
 * service (routes/api.shared.js → services/sharedValuesService.js) over
 * tests/helpers/sharedValuesEngine.js with a signed staff JWT, and throws the
 * shell's ApiError shape (message, status, body) — so every response the page
 * reads is the route's own, never one written from memory.
 *
 * WHAT IS LOCKED
 *   - The listing (name, description, write rule, key count, creator by NAME),
 *     creating a namespace, drilling in.
 *   - A namespace: its keys (preview, rev, writer), "More keys" paging, adding
 *     a key, editing rules (the creator; another user sees the server's 403
 *     sentence), deleting it only after its name is typed — and its history
 *     still opening afterwards through "History by name" (a deleted
 *     namespace is not listed); that box refuses a bad name before any call
 *     and opens a live namespace's own page.
 *   - A key: the full value, a compare-and-set save; a 409 shows what is there
 *     now and "Retry my change" keeps the user's draft on the new rev; delete
 *     (confirm) with its rev; the key's history (before → after, who).
 *   - EVERY staff-typed string reaches the DOM as text: a value / description
 *     / key carrying markup creates no element, runs nothing.
 *   - The page sets no inline handlers and never assigns data to innerHTML.
 *   - Phone width: every table cell carries its column header (data-label),
 *     rows added after the first paint included (the CSS card layout).
 *   - The tile: on the Admin page (firm:admin), gate firm.settings, the panel div loads the page.
 *
 * Run: npx jest tests/sharedValuesPage.test.js
 */
'use strict';

process.env.JWT_SECRET = 'shared-values-page-test-secret';
process.env.JWT_VERSION = '1';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeEngine } = require('./helpers/sharedValuesEngine');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'sharedValues.html'), 'utf8');
const strip = (html) => html.replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const USERS = [{ user: 5, user_name: 'Rena' }, { user: 7, user_name: 'Stuart' }, { user: 9, user_name: 'Admin Al' }];
const token = (sub, roles = ['staff']) => jwt.sign({ sub, username: 'u' + sub, user_type: 'staff', user_auth: 'authorized', aud: 'staff', ver: 1, roles },
  process.env.JWT_SECRET, { expiresIn: '1h' });

/** The real router over the engine, reached the way the shell's apiSend reaches the server. */
function makeApi(db) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(require('../routes/api.shared'));
  const server = app.listen(0);
  const calls = [];
  const as = { sub: 5, roles: ['staff'] };
  const live = { pending: 0 };
  function apiSend(url, method = 'GET', payload = null) {
    calls.push([method, url, payload]);
    live.pending++;
    const done = (fn) => (x) => { live.pending--; fn(x); };
    return new Promise((res0, rej0) => {
      const resolve = done(res0), reject = done(rej0);
      const body = payload == null ? null : JSON.stringify(payload);
      const req = http.request({ port: server.address().port, path: url, method,
        headers: Object.assign({ authorization: 'Bearer ' + token(as.sub, as.roles) }, body ? { 'content-type': 'application/json' } : {}) }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json; try { json = JSON.parse(data); } catch (_) { json = { _raw: data }; }
          if (res.statusCode >= 400) {
            const err = new Error((json && (json.message || json.error)) || `HTTP ${res.statusCode}`);
            err.name = 'ApiError'; err.status = res.statusCode; err.body = json;
            return reject(err);
          }
          resolve(json);
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  return { apiSend, calls, as, live, close: () => server.close() };
}

const open = [];
afterEach(() => { while (open.length) open.pop()(); });

async function boot(seed) {
  const db = makeEngine();
  db.seed(seed || { shared_namespaces: [], shared_values: [] });
  const A = makeApi(db);
  const top = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() }).window;
  top.apiSend = A.apiSend;
  top.firmData = { users: USERS };
  const f = top.document.createElement('iframe');
  top.document.body.appendChild(f);
  await flush(5);
  const w = f.contentWindow;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.document.open(); w.document.write(strip(PAGE)); w.document.close();
  open.push(() => { A.close(); top.close(); });
  const t = {
    db, A, w, top, errors,
    $: (s) => w.document.querySelector(s),
    $$: (s) => [...w.document.querySelectorAll(s)],
    text: (s) => (w.document.querySelector(s) || {}).textContent,
    click: async (el) => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await flush(); },
    type: (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    // Settled = no API call in flight for several ticks in a row (the page
    // chains calls: a save, then a reload, then its history).
    settle: async () => {
      for (let quiet = 0, i = 0; quiet < 4 && i < 400; i++) {
        await new Promise((r) => setTimeout(r, 5));
        await flush(3);
        quiet = A.live.pending === 0 ? quiet + 1 : 0;
      }
    },
    writes: () => A.calls.filter(([m]) => m !== 'GET').map(([m, u, b]) => [m, u, b]),
  };
  await t.settle();
  return t;
}

const ns = (n, extra = {}) => ({ ns: n, description: null, write_mode: 'staff', max_value_bytes: 65536, max_keys: 1000, created_by: 5,
  created_at: '2026-10-28 00:00:00', updated_at: '2026-10-28 00:00:00', ...extra });
const val = (n, k, v, rev = 1, by = 5) => ({ ns: n, k, v, rev, updated_by: by, updated_act: null, created_at: '2026-10-28 00:00:00', updated_at: '2026-10-28 00:00:00' });
const EVIL = '<img src=x onerror="window.__pwned=1">';

describe('the listing', () => {
  test('namespaces with description, write rule, key count and the creator by name; a click drills in', async () => {
    const t = await boot({ shared_namespaces: [ns('carve', { description: 'Office high score', created_by: 7 })], shared_values: [val('carve', 'best', '{"score":10}')] });
    const cells = t.$$('tbody tr[data-ns="carve"] td').map((td) => td.textContent);
    expect(cells.slice(0, 5)).toEqual(['carve', 'Office high score', 'Any staff member', '1', 'Stuart']);
    // phone cards: every cell carries its column's (static) header
    expect(t.$$('tbody tr[data-ns="carve"] td').map((td) => td.getAttribute('data-label')))
      .toEqual(['Namespace', 'What it is for', 'Who writes', 'Keys', 'Created by', 'Updated']);
    await t.click(t.$('tbody tr[data-ns="carve"]'));
    await t.settle();
    expect(t.$$('#keyRows tr').map((tr) => tr.dataset.k)).toEqual(['best']);
    expect(t.text('#crumbs')).toMatch(/Namespaces\s*\/\s*carve/);
    expect(t.errors).toEqual([]);
  });

  test('create a namespace: POST, then its page; the server\'s refusal shows as text', async () => {
    const t = await boot();
    t.$('#newNs').value = 'Bad Name';
    await t.click(t.$('#createNs'));
    await t.settle();
    expect(t.text('#flash')).toMatch(/lowercase letters/);
    t.$('#newNs').value = 'scores';
    t.$('#newDesc').value = 'A board';
    t.$('#newMode').value = 'creator';
    await t.click(t.$('#createNs'));
    await t.settle();
    expect(t.db.tables.shared_namespaces.map((n) => [n.ns, n.description, n.write_mode, n.created_by])).toEqual([['scores', 'A board', 'creator', 5]]);
    expect(t.w.SharedValuesPage.state).toMatchObject({ view: 'ns', ns: 'scores' });
    expect(t.text('#flash')).toBe('Created "scores".');
  });
});

describe('a namespace', () => {
  test('keys page with "More keys"; add a key', async () => {
    const values = Array.from({ length: 105 }, (_, i) => val('big', 'k' + String(i).padStart(3, '0'), 'v' + i));
    const t = await boot({ shared_namespaces: [ns('big')], shared_values: values });
    t.w.SharedValuesPage.go('ns', 'big');
    await t.settle();
    expect(t.$$('#keyRows tr')).toHaveLength(100);
    await t.click(t.$('#moreKeys'));
    await t.settle();
    expect(t.$$('#keyRows tr')).toHaveLength(105);
    expect(t.$('#moreKeys')).toBeNull();
    t.$('#newKey').value = 'zz';
    t.$('#newVal').value = 'hello';
    await t.click(t.$('#addKey'));
    await t.settle();
    expect(t.writes()).toEqual([['PUT', '/api/shared/big/zz', { v: 'hello', rev: null }]]);
    expect(t.w.SharedValuesPage.state).toMatchObject({ view: 'key', ns: 'big', k: 'zz' });
  });

  test('edit rules as the creator; another user sees the server\'s 403 sentence; nothing changes', async () => {
    const t = await boot({ shared_namespaces: [ns('board', { created_by: 5 })], shared_values: [] });
    t.w.SharedValuesPage.go('ns', 'board');
    await t.settle();
    await t.click(t.$('#editRules'));
    expect(t.$('#rulesEditor').hidden).toBe(false);
    t.$('#ruleMode').value = 'own_key';
    t.$('#ruleKeys').value = '50';
    await t.click(t.$('#saveRules'));
    await t.settle();
    expect(t.db.tables.shared_namespaces[0]).toMatchObject({ write_mode: 'own_key', max_keys: 50 });
    t.A.as.sub = 7;
    t.w.SharedValuesPage.go('ns', 'board');
    await t.settle();
    await t.click(t.$('#editRules'));
    t.$('#ruleKeys').value = '9';
    await t.click(t.$('#saveRules'));
    await t.settle();
    expect(t.text('#flash')).toBe('Only the creator of "board" (or an admin) may change it');
    expect(t.db.tables.shared_namespaces[0].max_keys).toBe(50);
  });

  test('delete only after the name is typed; afterwards its history still opens', async () => {
    const t = await boot({ shared_namespaces: [ns('gone')], shared_values: [] });
    t.w.SharedValuesPage.go('ns', 'gone');
    await t.settle();
    await t.click(t.$('#delNs'));
    expect(t.$('#delNsGo').disabled).toBe(true);
    t.type(t.$('#delNsName'), 'gon');
    expect(t.$('#delNsGo').disabled).toBe(true);
    t.type(t.$('#delNsName'), 'gone');
    expect(t.$('#delNsGo').disabled).toBe(false);
    await t.click(t.$('#delNsGo'));
    await t.settle();
    expect(t.db.tables.shared_namespaces).toEqual([]);
    expect(t.text('#flash')).toBe('Deleted "gone" and 0 value(s). Its history is kept.');
    // no longer listed — reached through "History by name"
    expect(t.$('tbody tr[data-ns="gone"]')).toBeNull();
    t.$('#lookupNs').value = 'gone';
    await t.click(t.$('#lookupGo'));
    await t.settle();
    expect(t.w.SharedValuesPage.state).toMatchObject({ view: 'ns', ns: 'gone' });
    expect(t.text('#view .muted')).toBe('"gone" does not exist (now). Any history it had is below.');
    expect(t.$$('#histRows tr td.hist-op').map((td) => td.textContent)).toEqual(['namespace deleted']);
  });

  test('History by name: a bad name is refused before any call; a live name opens its page; Enter works', async () => {
    const t = await boot({ shared_namespaces: [ns('carve')], shared_values: [] });
    const gets = () => t.A.calls.filter(([m, u]) => m === 'GET' && u !== '/api/shared').length;
    const before = gets();
    for (const bad of ['Carve', 'a b', '-x', '', 'x'.repeat(65)]) {
      t.$('#lookupNs').value = bad;
      await t.click(t.$('#lookupGo'));
      expect([bad, t.w.SharedValuesPage.state.view]).toEqual([bad, 'list']);
      expect(t.text('#flash')).toMatch(/lowercase letters, digits/);
    }
    expect(gets()).toBe(before);                                // nothing asked of the server
    t.$('#lookupNs').value = 'carve';
    t.$('#lookupNs').dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await t.settle();
    expect(t.w.SharedValuesPage.state).toMatchObject({ view: 'ns', ns: 'carve' });
    expect(t.$('#editRules')).not.toBeNull();                   // the live page, not the deleted-history view
  });
});

describe('a key', () => {
  test('the value in full; save with its rev; the history shows before → after and who', async () => {
    const t = await boot({ shared_namespaces: [ns('carve')], shared_values: [] });
    await t.A.apiSend('/api/shared/carve/best', 'PUT', { v: '{"score":10}', rev: null });
    t.w.SharedValuesPage.go('key', 'carve', 'best');
    await t.settle();
    expect(t.text('#keyValue')).toBe('{"score":10}');
    expect(t.text('#keyMeta')).toMatch(/^rev 1 · last written by Rena/);
    t.$('#editVal').value = '{"score":42}';
    await t.click(t.$('#saveVal'));
    await t.settle();
    expect(t.db.tables.shared_values[0]).toMatchObject({ v: '{"score":42}', rev: 2 });
    expect(t.text('#flash')).toBe('Saved — now rev 2.');
    const rows = t.$$('#histRows tr').map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    expect(t.$$('#histRows tr')[0].querySelector('td:nth-child(5)').getAttribute('data-label')).toBe('Before');   // rows added later are labelled too
    expect(rows.map((r) => [r[1], r[2], r[3], r[4], r[5]])).toEqual([
      ['Rena', 'changed → rev 2', 'best', '{"score":10}', '{"score":42}'],
      ['Rena', 'created → rev 1', 'best', '', '{"score":10}'],
    ]);
  });

  test('a 409: what is there now, by whom — and "Retry my change" keeps the draft on the new rev', async () => {
    const t = await boot({ shared_namespaces: [ns('carve')], shared_values: [val('carve', 'best', 'mine-was-read', 1)] });
    t.w.SharedValuesPage.go('key', 'carve', 'best');
    await t.settle();
    t.$('#editVal').value = 'my draft';
    // someone else writes first
    t.A.as.sub = 7;
    await t.A.apiSend('/api/shared/carve/best', 'PUT', { v: 'theirs', rev: 1 });
    t.A.as.sub = 5;
    await t.click(t.$('#saveVal'));
    await t.settle();
    expect(t.$('#conflict').hidden).toBe(false);
    expect(t.text('#conflict p')).toBe('Someone changed it first — it is now rev 2, written by Stuart:');
    expect(t.text('#conflictValue')).toBe('theirs');
    expect(t.db.tables.shared_values[0]).toMatchObject({ v: 'theirs', rev: 2 });
    await t.click(t.$('#conflictRetry'));
    expect(t.$('#editVal').value).toBe('my draft');
    expect(t.text('#keyMeta')).toMatch(/^rev 2 /);
    await t.click(t.$('#saveVal'));
    await t.settle();
    expect(t.db.tables.shared_values[0]).toMatchObject({ v: 'my draft', rev: 3, updated_by: 5 });
  });

  test('delete asks first and sends its rev; declined → nothing', async () => {
    const t = await boot({ shared_namespaces: [ns('carve')], shared_values: [val('carve', 'best', 'x', 4)] });
    t.w.SharedValuesPage.go('key', 'carve', 'best');
    await t.settle();
    t.w.confirm = () => false;
    await t.click(t.$('#delKey'));
    expect(t.writes()).toEqual([]);
    t.w.confirm = () => true;
    await t.click(t.$('#delKey'));
    await t.settle();
    expect(t.writes()).toEqual([['DELETE', '/api/shared/carve/best?rev=4', null]]);
    expect(t.db.tables.shared_values).toEqual([]);
    expect(t.w.SharedValuesPage.state).toMatchObject({ view: 'ns', ns: 'carve' });
  });
});

describe('staff-typed text is only ever text', () => {
  test('markup in a value, a description, history and a creator name creates no element and runs nothing', async () => {
    const t = await boot({ shared_namespaces: [ns('evil', { description: EVIL })], shared_values: [] });
    t.top.firmData.users.push({ user: 11, user_name: EVIL });
    await t.A.apiSend('/api/shared/evil/k', 'PUT', { v: EVIL, rev: null });
    t.w.SharedValuesPage.go('list');
    await t.settle();
    t.w.SharedValuesPage.go('ns', 'evil');
    await t.settle();
    t.w.SharedValuesPage.go('key', 'evil', 'k');
    await t.settle();
    expect(t.text('#keyValue')).toBe(EVIL);
    expect(t.$$('#histRows pre').map((p) => p.textContent)).toContain(EVIL);
    expect(t.w.document.querySelectorAll('img')).toHaveLength(0);
    expect(t.w.__pwned).toBeUndefined();
    expect(t.errors).toEqual([]);
  });

  test('the source: no inline handlers; innerHTML is never assigned; el() sets text, not HTML', () => {
    const script = PAGE.slice(PAGE.indexOf('<script>'));
    expect(PAGE).not.toMatch(/\son[a-z]+="/);
    expect(script).not.toMatch(/\.innerHTML\s*=/);
    expect(script).not.toMatch(/insertAdjacentHTML|outerHTML\s*=|document\.write/);
  });
});

describe('the tile', () => {
  test('Admin page (a firm page since launcher-nits C4), gate firm.settings (visibility only), the panel div loads the page', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'featureRegistry.js'), 'utf8');
    const entry = src.match(/adminSharedValues: \{([\s\S]*?)\n {2}\},/)[1];
    expect(entry).toMatch(/target: 'sharedValuesDiv', group: 'admin'/);
    expect(entry).toMatch(/gate: 'firm\.settings'/);
    // Admin is the firm's page firm:admin: its tile sits after Scratch there (the C3 data step's copy of the old grid)
    const tiles = require('./helpers/hubPages').hubPages()['firm:admin'].tiles.map((e) => e.item || '|');
    expect(tiles[tiles.indexOf('adminSharedValues') - 1]).toBe('adminScratch');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    expect(html).toMatch(/<div id="sharedValuesDiv" style="display:none; margin-top:10px;">\s*<iframe data-src="\/sharedValues\.html"/);
  });
});
