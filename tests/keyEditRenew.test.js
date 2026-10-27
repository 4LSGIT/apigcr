// tests/keyEditRenew.test.js
//
/**
 * Edit scopes + renew expiry — access-control D2, the no-DB half (the SQL
 * paths are tests/keyEditRenew.mysql.test.js).
 *
 * WHAT IS LOCKED
 *   - The shared rules (routes/api.readonlyKeys _rules): one copy for mint,
 *     edit and renew. rootTtlMinutes: the mint is lax (junk = default, an
 *     ordinary over-long ask clamps — its pre-D2 behaviour), a renew is strict
 *     (junk and over-cap are 400s); sensitive is 400 over 24h either way.
 *     childExpiresAt: ≤ 24h, ≤ the parent, whole seconds, a lapsed parent 400.
 *   - Refusals decided before the DB: PATCH with no / NULL scopes, an unknown
 *     scope (the retired temp.ringcentral included); machine setScopes /
 *     setExpiry the same.
 *   - Route ordering: /children/:id/renew vs the SU /:id/renew.
 *   - Machine edits invalidate this instance's lookup cache.
 *   - Both panes (jsdom, their own scripts): edit / renew offered only on keys
 *     not dead for good; a child's picker is the trio; a legacy key's dialog
 *     starts from its legacy surface; the bodies sent; the renew notice shows
 *     the new stamp; the machine dialog starts from the key's routes + caps.
 *
 * Run: npx jest tests/keyEditRenew.test.js
 */
'use strict';

process.env.JWT_SECRET = 'key-edit-renew-d2-test-secret';
process.env.SU_RATE_LIMIT_READONLYKEYS = '10000';

const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');

const keysRouter = require('../routes/api.readonlyKeys');
const { Refusal, sessionScopes, rootTtlMinutes, childExpiresAt, childScopesWithin, stampExpiry } = keysRouter._rules;
const apiKeys = require('../lib/apiKeys');
const { KEY_SCOPES, CAPABILITIES } = require('../lib/capabilities');
const { hashKey } = require('../lib/auth.readonly');
const { mintElevationToken } = require('../lib/auth.superuser');

const ROOT = path.join(__dirname, '..');
const MIN = 60e3;
const flush = () => new Promise(r => setTimeout(r, 0));
const refusal = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('did not throw'); };

// ─────────────────────────────────────────────────────────────────────────────
// The shared rules
// ─────────────────────────────────────────────────────────────────────────────

describe('rootTtlMinutes — the mint (lax) and the renew (strict)', () => {
  test('defaults: ordinary 1 day, sensitive 4h, in both modes', () => {
    for (const strict of [false, true]) {
      expect(rootTtlMinutes(undefined, { sensitive: false, strict })).toBe(1440);
      expect(rootTtlMinutes(null, { sensitive: false, strict })).toBe(1440);
      expect(rootTtlMinutes(undefined, { sensitive: true, strict })).toBe(240);
    }
  });

  test('ordinary over 3 days: the mint clamps (as it always has), a renew refuses', () => {
    expect(rootTtlMinutes(9999, { sensitive: false, strict: false })).toBe(4320);
    const e = refusal(() => rootTtlMinutes(4321, { sensitive: false, strict: true }));
    expect(e).toBeInstanceOf(Refusal);
    expect([e.status, e.body.maxTtlMinutes]).toEqual([400, 4320]);
    expect(e.body.error).toMatch(/at most 4320 minutes \(3 days\); asked for 4321/);
    expect(rootTtlMinutes(4320, { sensitive: false, strict: true })).toBe(4320);
    expect(rootTtlMinutes('60', { sensitive: false, strict: true })).toBe(60);
  });

  test('junk: the mint reads it as "not given", a renew refuses', () => {
    for (const junk of ['soon', 0, -3, 1.5, '']) {
      // (the lax mint parseInt()s: 1.5 → 1 minute — its pre-D2 behaviour, kept)
      expect(rootTtlMinutes(junk, { sensitive: false, strict: false })).toBe(junk === 1.5 ? 1 : 1440);
      const e = refusal(() => rootTtlMinutes(junk, { sensitive: false, strict: true }));
      expect([junk, e.status]).toEqual([junk, 400]);
      expect(e.body.error).toMatch(/positive whole number/);
    }
  });

  test('sensitive over 24h is a 400 in BOTH modes', () => {
    for (const strict of [false, true]) {
      const e = refusal(() => rootTtlMinutes(1441, { sensitive: true, strict }));
      expect([e.status, e.body.maxTtlMinutes]).toEqual([400, 1440]);
      expect(rootTtlMinutes(1440, { sensitive: true, strict })).toBe(1440);
    }
  });
});

describe('childExpiresAt', () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0, 0);
  test('omitted → min(24h, parent), whole seconds', () => {
    expect(childExpiresAt(undefined, now + 48 * 60 * MIN + 999, now).getTime()).toBe(now + 1440 * MIN);
    expect(childExpiresAt(null, now + 90 * MIN + 700, now).getTime()).toBe(now + 90 * MIN);
  });
  test('given: ≤ 24h and ≤ the parent, else 400', () => {
    expect(childExpiresAt(30, now + 60 * MIN, now).getTime()).toBe(now + 30 * MIN);
    expect(refusal(() => childExpiresAt(61, now + 60 * MIN, now)).body.error).toMatch(/cannot outlive its parent/);
    expect(refusal(() => childExpiresAt(1441, now + 72 * 60 * MIN, now)).body.error).toMatch(/at most 1440 minutes/);
    for (const junk of [0, 2.5, 'x']) expect(refusal(() => childExpiresAt(junk, now + HOURS(5), now)).status).toBe(400);
  });
  test('a lapsed (or missing) parent expiry → 400, whatever the ask', () => {
    for (const p of [now - 1, now, NaN]) {
      const e = refusal(() => childExpiresAt(undefined, p, now));
      expect(e).toBeInstanceOf(Refusal);
      expect(e.body.error).toMatch(/parent key has expired/);
      expect(e.body.parentExpiresAt).toBe(Number.isNaN(p) ? null : new Date(p).toISOString());
    }
  });
  function HOURS(h) { return h * 60 * MIN; }
});

describe('sessionScopes + childScopesWithin', () => {
  test('normalized; sensitive needs sql.ro; unknown / empty refused', () => {
    expect(sessionScopes(['sql.ro', 'scratch', 'sql.ro'])).toEqual(['sql.ro', 'scratch']);
    expect(refusal(() => sessionScopes(['sql.ro.sensitive'])).body.error).toMatch(/needs sql\.ro too/);
    expect(refusal(() => sessionScopes(['sql.rw'])).body.error).toMatch(/unknown scope/);
    expect(refusal(() => sessionScopes([])).status).toBe(400);
  });
  test('childScopesWithin names what is outside', () => {
    expect(() => childScopesWithin(['sql.ro'], ['sql.ro', 'scratch', 'alert'])).not.toThrow();
    const e = refusal(() => childScopesWithin(['sql.ro', 'keys.mint', 'temp.clio'], ['sql.ro', 'scratch', 'alert']));
    expect(e.body.offendingScopes).toEqual(['keys.mint', 'temp.clio']);
  });
  test('stampExpiry is the mint format', () => {
    expect(stampExpiry(new Date('2026-10-15T14:30:59.900Z'))).toBe('20261015T1430Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session routes over a scripted db
// ─────────────────────────────────────────────────────────────────────────────

const MGR_RAW = 'ycro_d2mgrfixture_20991231T0000Z';
const suToken = () => jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', roles: ['su'], aud: 'staff' },
  process.env.JWT_SECRET, { expiresIn: '5m' });

function scriptedDb(editRow) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/WHERE k\.key_hash = \?/.test(s)) {
        return [params[0] === hashKey(MGR_RAW) ? [{ id: 50, label: 'mgr', expires_at: new Date(Date.now() + 2 * 3600e3), revoked_at: null,
          scopes: ['sql.ro', 'keys.mint'], parent_key_id: null, parent_id: null }] : []];
      }
      if (/^UPDATE readonly_api_keys SET last_used_at/.test(s)) return [{}];
      if (/admin_audit_log|jwt_api_audit_log/.test(s)) return [{ insertId: 1 }];
      if (/WHERE k\.id = \?/.test(s)) return [editRow ? [editRow] : []];
      if (/^SELECT id, expires_at, revoked_at FROM readonly_api_keys WHERE id = \? AND parent_key_id = \?/.test(s)) return [[]];
      if (/^UPDATE readonly_api_keys SET (scopes|expires_at)/.test(s)) return [{ affectedRows: 1 }];
      throw new Error('unscripted: ' + s);
    },
  };
}
async function serve(router, db, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(router);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(r => server.close(r)); }
}
async function hit(base, method, p, { key, su, body } = {}) {
  const headers = {};
  if (key) headers['x-readonly-api-key'] = key;
  if (su) { headers.authorization = 'Bearer ' + suToken(); headers['x-su-elevation'] = mintElevationToken(6); }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const writes = (db) => db.calls.filter(c => /^UPDATE readonly_api_keys SET (scopes|expires_at)/.test(c.sql));
const editReads = (db) => db.calls.filter(c => /WHERE k\.id = \?/.test(c.sql));

describe('session PATCH / renew — refusals before the DB, 409 on revoked', () => {
  test('no scopes, NULL scopes, unknown, sensitive-without-sql.ro → 400 with no row read', async () => {
    const db = scriptedDb({ id: 7, scopes: null, expires_at: new Date(Date.now() + 3600e3), revoked_at: null, parent_key_id: null });
    await serve(keysRouter, db, async (base) => {
      for (const [body, msg] of [[{}, /never set back to NULL/], [{ scopes: null }, /never set back to NULL/],
        [{ scopes: ['sql.rw'] }, /unknown scope/], [{ scopes: ['sql.ro.sensitive'] }, /needs sql\.ro too/]]) {
        const r = await hit(base, 'PATCH', '/api/readonly-keys/7', { su: true, body });
        expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
        expect(r.body.error).toMatch(msg);
      }
    });
    expect(editReads(db)).toEqual([]);
    expect(writes(db)).toEqual([]);
  });

  test('the retired temp.ringcentral (2026-10-28): a PATCH naming it is a 400 naming the scope, nothing written', async () => {
    // The stored column still naming it is the realistic case: a full-replacement PATCH that echoes it back.
    const db = scriptedDb({ id: 7, scopes: ['sql.ro', 'temp.ringcentral'], expires_at: new Date(Date.now() + 3600e3), revoked_at: null, parent_key_id: null });
    await serve(keysRouter, db, async (base) => {
      for (const scopes of [['sql.ro', 'temp.ringcentral'], ['temp.ringcentral']]) {
        const r = await hit(base, 'PATCH', '/api/readonly-keys/7', { su: true, body: { scopes } });
        expect([JSON.stringify(scopes), r.status]).toEqual([JSON.stringify(scopes), 400]);
        expect(r.body.error).toMatch(/unknown scope.*temp\.ringcentral/);
      }
    });
    expect(writes(db)).toEqual([]);
  });

  test('a revoked key → 409 on PATCH and renew, nothing written', async () => {
    const db = scriptedDb({ id: 7, scopes: ['sql.ro'], expires_at: new Date(), revoked_at: new Date(), parent_key_id: null });
    await serve(keysRouter, db, async (base) => {
      for (const [m, p, body] of [['PATCH', '/api/readonly-keys/7', { scopes: ['scratch'] }], ['POST', '/api/readonly-keys/7/renew', {}]]) {
        expect(await hit(base, m, p, { su: true, body })).toEqual({ status: 409, body: { error: 'revoked keys stay revoked — mint a new one' } });
      }
    });
    expect(writes(db)).toEqual([]);
  });

  test('a bad id → 400; a missing key → 404', async () => {
    const db = scriptedDb(null);
    await serve(keysRouter, db, async (base) => {
      expect((await hit(base, 'PATCH', '/api/readonly-keys/x', { su: true, body: { scopes: ['sql.ro'] } })).status).toBe(400);
      expect((await hit(base, 'POST', '/api/readonly-keys/0/renew', { su: true, body: {} })).status).toBe(400);
      expect((await hit(base, 'PATCH', '/api/readonly-keys/9', { su: true, body: { scopes: ['sql.ro'] } })).status).toBe(404);
      expect((await hit(base, 'POST', '/api/readonly-keys/9/renew', { su: true, body: {} })).status).toBe(404);
    });
  });

  test('route ordering: /children/:id/renew is the key-authed child renew; /:id/renew the SU one', async () => {
    const db = scriptedDb(null);
    await serve(keysRouter, db, async (base) => {
      let r = await hit(base, 'POST', '/api/readonly-keys/children/5/renew', { key: MGR_RAW, body: {} });
      expect(r).toEqual({ status: 404, body: { error: 'Not found' } });
      expect(db.calls.some(c => /AND parent_key_id = \?/.test(c.sql) && c.params[0] === 5 && c.params[1] === 50)).toBe(true);
      r = await hit(base, 'POST', '/api/readonly-keys/children/5/renew', { su: true, body: {} });
      expect(r.status).toBe(401);                                             // a JWT is not a session key
      r = await hit(base, 'POST', '/api/readonly-keys/children/renew', { key: MGR_RAW, body: {} });
      expect(r.status).toBe(401);                                             // the SU /:id/renew — a key never passes it
      expect(r.body.error).not.toMatch(/Readonly API key/);
      r = await hit(base, 'POST', '/api/readonly-keys/5/renew', { key: MGR_RAW, body: {} });
      expect(r.status).toBe(401);
    });
    expect(writes(db)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Machine: lib/apiKeys setScopes / setExpiry
// ─────────────────────────────────────────────────────────────────────────────

describe('lib/apiKeys setScopes / setExpiry', () => {
  const noDb = { query: jest.fn(async () => { throw new Error('no query expected'); }) };
  const status = async (p) => { try { await p; } catch (e) { return [e.status, e.message]; } return 'ok'; };

  test('validation precedes any query', async () => {
    for (const s of [undefined, null, [], ['sql.ro'], ['route:/'], 'firm.settings']) {
      expect((await status(apiKeys.setScopes(noDb, 1, s)))[0]).toBe(400);
    }
    for (const b of [{}, { ttlMinutes: '' }, { ttlMinutes: 0 }, { ttlMinutes: 1.5 }, { ttlMinutes: 60, never: true }, { never: 1 }, { never: false }]) {
      expect([JSON.stringify(b), (await status(apiKeys.setExpiry(noDb, 1, b)))[0]]).toEqual([JSON.stringify(b), 400]);
    }
    expect(noDb.query).not.toHaveBeenCalled();
  });

  function keyDb(row) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        const s = String(sql);
        calls.push(s);
        if (/FROM api_keys WHERE key_hash/.test(s)) return [[{ id: 3, label: 'k', revoked_at: null, expires_at: null, scopes: ['firm.settings'] }]];
        if (/FROM api_keys WHERE id = \?/.test(s)) return [[row].filter(Boolean)];
        if (/^UPDATE api_keys SET (scopes|expires_at)/.test(s)) return [{ affectedRows: row && !row.revoked_at ? 1 : 0 }];
        if (/UPDATE api_keys SET last_used_at/.test(s)) return [{}];
        throw new Error('unscripted: ' + s);
      },
    };
  }

  test('404 missing, 409 revoked (nothing written)', async () => {
    expect((await status(apiKeys.setScopes(keyDb(null), 3, ['firm.settings'])))[0]).toBe(404);
    const db = keyDb({ id: 3, revoked_at: new Date(), expires_at: null, scopes: null });
    expect(await status(apiKeys.setScopes(db, 3, ['firm.settings']))).toEqual([409, 'revoked keys stay revoked — mint a new one']);
    expect(await status(apiKeys.setExpiry(db, 3, { never: true }))).toEqual([409, 'revoked keys stay revoked — mint a new one']);
    expect(db.calls.filter(s => /^UPDATE api_keys SET (scopes|expires_at)/.test(s))).toEqual([]);
  });

  test('each edit invalidates this instance\'s cache: the next lookup SELECTs again', async () => {
    const db = keyDb({ id: 3, revoked_at: null, expires_at: null, scopes: ['firm.settings'] });
    const selects = () => db.calls.filter(s => /FROM api_keys WHERE key_hash/.test(s)).length;
    apiKeys.invalidateCache();
    await apiKeys.lookup(db, 'yck_d2cachefixture');
    await apiKeys.lookup(db, 'yck_d2cachefixture');
    expect(selects()).toBe(1);
    expect(await apiKeys.setScopes(db, 3, ['route:/process-jobs'])).toEqual({ before: ['firm.settings'], after: ['route:/process-jobs'] });
    await apiKeys.lookup(db, 'yck_d2cachefixture');
    expect(selects()).toBe(2);
    const out = await apiKeys.setExpiry(db, 3, { ttlMinutes: 60 });
    expect(out.before).toBeNull();
    expect(Math.abs(out.after.getTime() - (Date.now() + 60 * MIN))).toBeLessThan(2000);
    await apiKeys.lookup(db, 'yck_d2cachefixture');
    expect(selects()).toBe(3);
    expect((await apiKeys.setExpiry(db, 3, { never: true })).after).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The panes (jsdom)
// ─────────────────────────────────────────────────────────────────────────────

const VOCAB = Object.entries(KEY_SCOPES).map(([name, v]) => ({ name, desc: v.desc, ...(v.explicit ? { explicit: true } : {}) }));

function bootSession(keys) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'readonlyKeys.html'), 'utf8');
  const sent = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(w) {
      w.alert = (m) => sent.push({ alert: m });
      w.confirm = () => true;
      w.apiSend = async (url, method, body) => {
        sent.push({ url, method, body });
        if (method === 'GET') {
          return { ok: true, keys, max_ttl_days: 3, scope_vocabulary: VOCAB, default_scopes: ['sql.ro', 'scratch', 'alert'],
            sensitive_scope: { name: 'sql.ro.sensitive', max_ttl_minutes: 1440, default_ttl_minutes: 240 },
            child_scopes: ['sql.ro', 'scratch', 'alert'], ttl: { max_minutes: 4320, default_minutes: 1440, child_max_minutes: 1440 } };
        }
        if (method === 'PATCH') return { ok: true, id: 1, scopes: body.scopes, notes: ['keys.mint removed: 2 live child key(s) keep working'] };
        if (/\/renew$/.test(url)) return { ok: true, expiresAt: '2026-10-16T12:00:00.000Z', expiresStamp: '20261016T1200Z' };
        return { ok: true };
      };
    },
  });
  return { w: dom.window, d: dom.window.document, sent };
}

describe('readonlyKeys.html — edit + renew', () => {
  const future = new Date(Date.now() + 864e5).toISOString();
  const past = new Date(Date.now() - 6e4).toISOString();
  const keys = [
    { id: 91, key_prefix: 'ycro_M', label: 'manager', scopes: ['sql.ro', 'scratch', 'keys.mint'], expires_at: future, parent_key_id: null },
    { id: 95, key_prefix: 'ycro_K', label: 'kid', scopes: ['sql.ro'], expires_at: future, parent_key_id: 91, parent_label: 'manager', parent_revoked_at: null, parent_expires_at: future },
    { id: 94, key_prefix: 'ycro_O', label: 'orphan', scopes: ['sql.ro'], expires_at: future, parent_key_id: 88, parent_revoked_at: past, parent_expires_at: future },
    { id: 80, key_prefix: 'ycro_R', label: 'revoked', scopes: ['sql.ro'], expires_at: future, revoked_at: past, parent_key_id: null },
    { id: 70, key_prefix: 'ycro_E', label: 'lapsed', scopes: ['sql.ro'], expires_at: past, parent_key_id: null },
    { id: 75, key_prefix: 'ycro_L', label: 'legacy', scopes: null, expires_at: future, parent_key_id: null },
  ];
  const rowOf = (d, id) => [...d.querySelectorAll('#keysTbody tr')].find(tr => tr.cells[0].textContent.trim() === String(id));
  const has = (d, id, cls) => !!rowOf(d, id).querySelector('.' + cls);

  test('edit / renew on keys not dead for good — an expired key renews; revoked or orphaned rows offer neither', async () => {
    const { d } = bootSession(keys);
    await flush(); await flush();
    expect([91, 95, 94, 80, 70, 75].map(id => [id, has(d, id, 'edit-btn'), has(d, id, 'renew-btn')]))
      .toEqual([[91, true, true], [95, true, true], [94, false, false], [80, false, false], [70, true, true], [75, true, true]]);
    expect(d.getElementById('dlg').style.display).toBe('none');
  });

  test('a child\'s picker is the trio, ticked from its row; saving PATCHes the full list', async () => {
    const { w, d, sent } = bootSession(keys);
    await flush(); await flush();
    w.openScopes(95);
    const boxes = [...d.querySelectorAll('.edit-box')];
    expect(boxes.map(b => [b.value, b.checked])).toEqual([['sql.ro', true], ['scratch', false], ['alert', false]]);
    d.querySelector('.edit-box[value="alert"]').checked = true;
    await d.getElementById('dlgOk').onclick();
    expect(sent.find(s => s.method === 'PATCH')).toEqual({ url: '/api/readonly-keys/95', method: 'PATCH', body: { scopes: ['sql.ro', 'alert'] } });
    expect(d.getElementById('dlg').style.display).toBe('none');
  });

  test('a legacy key starts from its legacy surface (every non-explicit scope), with the warning', async () => {
    const { w, d } = bootSession(keys);
    await flush(); await flush();
    w.openScopes(75);
    const checked = [...d.querySelectorAll('.edit-box')].filter(b => b.checked).map(b => b.value);
    expect(checked).toEqual(Object.keys(KEY_SCOPES).filter(s => !KEY_SCOPES[s].explicit));
    expect(d.getElementById('dlgBody').textContent).toMatch(/legacy full surface/);
  });

  test('a manager\'s dialog warns about children; the server\'s notes are shown after save; nothing ticked → no request', async () => {
    const { w, d, sent } = bootSession(keys);
    await flush(); await flush();
    w.openScopes(91);
    expect(d.getElementById('dlgBody').textContent).toMatch(/children alive, without a manager/);
    d.querySelector('.edit-box[value="keys.mint"]').checked = false;
    await d.getElementById('dlgOk').onclick();
    expect(d.getElementById('noticeArea').textContent).toMatch(/keys\.mint removed: 2 live child key\(s\) keep working/);
    w.openScopes(91);
    for (const b of d.querySelectorAll('.edit-box')) b.checked = false;
    const before = sent.filter(s => s.method === 'PATCH').length;
    await d.getElementById('dlgOk').onclick();
    expect(sent.filter(s => s.method === 'PATCH').length).toBe(before);
    expect(sent.some(s => s.alert && /at least one scope/.test(s.alert))).toBe(true);
  });

  test('renew: caps hint by kind; sends ttlMinutes (or nothing); the notice carries the new stamp', async () => {
    const { w, d, sent } = bootSession(keys);
    await flush(); await flush();
    w.openRenew(95);
    expect(d.getElementById('renewHint').textContent).toMatch(/child key: at most 1440 minutes, and never past its parent \(#91/);
    w.closeDlg();
    w.openRenew(91);
    expect(d.getElementById('renewHint').textContent).toBe('Default 1440 minutes, at most 4320.');
    d.getElementById('renewTtl').value = '90';
    await d.getElementById('dlgOk').onclick();
    expect(sent.find(s => /\/renew$/.test(s.url || ''))).toEqual({ url: '/api/readonly-keys/91/renew', method: 'POST', body: { ttlMinutes: 90 } });
    expect(d.getElementById('noticeArea').textContent).toMatch(/20261016T1200Z/);
    w.openRenew(70);
    await d.getElementById('dlgOk').onclick();
    expect(sent.filter(s => /\/renew$/.test(s.url || '')).pop().body).toEqual({});
    w.openRenew(70);
    d.getElementById('renewTtl').value = '1.5';
    const n = sent.length;
    await d.getElementById('dlgOk').onclick();
    expect(sent.length).toBe(n + 1);
    expect(sent[sent.length - 1].alert).toMatch(/whole number of minutes/);
  });
});

function bootMachine(keys) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'apikeys.html'), 'utf8');
  const sent = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(w) {
      w.alert = (m) => sent.push({ alert: m });
      w.confirm = () => true;
      w.apiSend = async (url, method, body) => {
        sent.push({ url, method, body });
        if (method === 'GET' && url === '/api/api-keys') {
          return { status: 'success', keys, internal: { rotated: true },
            scope_vocabulary: { capabilities: Object.entries(CAPABILITIES).map(([name, v]) => ({ name, desc: v.desc })), route_families: ['/api/cases', '/process-jobs'] } };
        }
        if (method === 'PATCH') return { status: 'success', after: { scopes: body.scopes } };
        if (/\/expiry$/.test(url)) return { status: 'success', after: { expires_at: body.never ? null : '2026-11-14T12:00:00.000Z' } };
        return { status: 'success' };
      };
    },
  });
  return { w: dom.window, d: dom.window.document, sent };
}

describe('apikeys.html — scopes + expiry', () => {
  const keys = [
    { id: 3, key_prefix: 'yck_S', label: 'scheduler', scopes: ['route:/process-jobs', 'firm.settings'], expires_at: null },
    { id: 4, key_prefix: 'yck_P', label: 'Pabbly', scopes: null, expires_at: null },
    { id: 5, key_prefix: 'yck_R', label: 'gone', scopes: null, revoked_at: new Date().toISOString() },
  ];
  const rowOf = (d, id) => [...d.querySelectorAll('#keysTbody tr')].find(tr => tr.cells[0].textContent.trim() === String(id));

  test('offered on unrevoked rows only', async () => {
    const { d } = bootMachine(keys);
    await flush(); await flush();
    expect([3, 4, 5].map(id => [!!rowOf(d, id).querySelector('.edit-btn'), !!rowOf(d, id).querySelector('.expiry-btn')]))
      .toEqual([[true, true], [true, true], [false, false]]);
  });

  test('the dialog starts from the key\'s routes + capabilities; the create picker is untouched; PATCH sends the full list', async () => {
    const { w, d, sent } = bootMachine(keys);
    await flush(); await flush();
    w.openScopes(3);
    expect([...d.querySelectorAll('#e-routeChips .chip')].map(c => c.firstChild.textContent)).toEqual(['route:/process-jobs']);
    expect([...d.querySelectorAll('.ecap-box')].filter(b => b.checked).map(b => b.value)).toEqual(['firm.settings']);
    d.getElementById('e-routeFamily').value = '/api/cases';
    w.addRouteFamily('edit');
    w.removeRoute(0, 'edit');
    expect(d.getElementById('routeChips').textContent).toBe('');            // the create form's chips
    expect([...d.querySelectorAll('.cap-box')].some(b => b.checked)).toBe(false);
    expect(w.pickedScopes()).toEqual([]);                                   // …and its state
    await d.getElementById('dlgOk').onclick();
    expect(sent.find(s => s.method === 'PATCH')).toEqual({ url: '/api/api-keys/3', method: 'PATCH', body: { scopes: ['route:/api/cases', 'firm.settings'] } });
  });

  test('an unscoped key\'s dialog warns; an empty pick sends nothing', async () => {
    const { w, d, sent } = bootMachine(keys);
    await flush(); await flush();
    w.openScopes(4);
    expect(d.getElementById('dlgBody').textContent).toMatch(/unscoped.*never goes back to unscoped/);
    await d.getElementById('dlgOk').onclick();
    expect(sent.some(s => s.method === 'PATCH')).toBe(false);
    expect(sent.some(s => s.alert && /at least one route or capability/.test(s.alert))).toBe(true);
  });

  test('expiry: days → ttlMinutes; never → {never:true}; both or neither → no request', async () => {
    const { w, d, sent } = bootMachine(keys);
    await flush(); await flush();
    const posts = () => sent.filter(s => /\/expiry$/.test(s.url || ''));
    w.openExpiry(3);
    d.getElementById('expDays').value = '30';
    await d.getElementById('dlgOk').onclick();
    expect(posts().pop()).toEqual({ url: '/api/api-keys/3/expiry', method: 'POST', body: { ttlMinutes: 43200 } });
    w.openExpiry(4);
    d.getElementById('expNever').checked = true;
    await d.getElementById('dlgOk').onclick();
    expect(posts().pop().body).toEqual({ never: true });
    expect(d.getElementById('noticeArea').textContent).toMatch(/never expires/);
    const n = posts().length;
    w.openExpiry(4);
    d.getElementById('expNever').checked = true;
    d.getElementById('expDays').value = '2';
    await d.getElementById('dlgOk').onclick();
    w.openExpiry(4);
    await d.getElementById('dlgOk').onclick();
    expect(posts().length).toBe(n);
  });
});
