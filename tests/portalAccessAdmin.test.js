// tests/portalAccessAdmin.test.js
//
// Portal Manager — Access tab backend (routes/api.portalAccessAdmin.js):
//   • searchContacts: default view = recent successful logins; q searches
//     name/pname/email/phone LIKE + exact numeric id; limit clamped.
//   • setPortalEnabled: strict 0/1 validation, 404 before write, immediate
//     effect noted (requireAuth re-checks per request — enforced there).
//   • forceLogout: portal_session_version + 1, enabled untouched, new
//     version returned.
//
// Stub pattern from tests/portalCardsAdmin.test.js (scripted mysql2 pool).
//
// Run:
//   npx jest tests/portalAccessAdmin.test.js

'use strict';

const admin = require('../routes/api.portalAccessAdmin');
// T9 script-drift guard: registers this file's scripted stubs so a global
// afterEach can fail on over- OR under-consumption of the script array.
// See tests/helpers/scriptGuard.js.
const { scriptGuard } = require('./helpers/scriptGuard');

// Sequential scripted pool stub (portalCardsAdmin pattern).
function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,                       // escape hatches: expectOverruns() / allowLeftovers()
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      let next = script.shift();
      if (typeof next === 'function') next = next(sql, params);
      if (next instanceof Error) throw next;
      return [next];
    },
  };
}

function contactRow(over = {}) {
  return Object.assign({
    contact_id: 2003, contact_name: 'Jane Doe', contact_pname: 'Jane Doe',
    contact_email: 'jane@x.test', contact_phone: '3135551234',
    portal_enabled: 1, portal_session_version: 3,
    last_login: '2026-08-05 10:00:00', login_count: 4,
  }, over);
}

// ─────────────────────────────────────────────────────────────────────────────
// searchContacts
// ─────────────────────────────────────────────────────────────────────────────

describe('searchContacts', () => {
  test('empty q → recent-logins view (last_login required, ordered desc)', async () => {
    const db = stubDb([[contactRow()]]);
    const rows = await admin._searchContacts(db, {});
    expect(rows).toHaveLength(1);
    const { sql, params } = db.calls[0];
    expect(sql).toContain('ll.last_login IS NOT NULL');
    expect(sql).toContain('ORDER BY ll.last_login DESC');
    expect(sql).toContain('FROM portal_login_pins');
    expect(sql).toContain('consumed_at IS NOT NULL');       // successful logins only
    expect(params).toEqual([25]);                           // default limit
  });

  test('text q → LIKE across name/pname/email/phone; non-numeric id param is -1', async () => {
    const db = stubDb([[]]);
    await admin._searchContacts(db, { q: '  jane ', limit: 10 });
    const { sql, params } = db.calls[0];
    expect(sql).toContain('c.contact_id = ?');
    expect((sql.match(/LIKE \?/g) || [])).toHaveLength(4);
    expect(params).toEqual([-1, '%jane%', '%jane%', '%jane%', '%jane%', 10]);
  });

  test('numeric q also matches contact_id exactly', async () => {
    const db = stubDb([[contactRow()]]);
    await admin._searchContacts(db, { q: '2003' });
    expect(db.calls[0].params[0]).toBe(2003);
    expect(db.calls[0].params[1]).toBe('%2003%');           // digits in phone too
  });

  test('limit clamps to [1, 100]', async () => {
    const d1 = stubDb([[]]); await admin._searchContacts(d1, { limit: 9999 });
    expect(d1.calls[0].params.at(-1)).toBe(100);
    const d2 = stubDb([[]]); await admin._searchContacts(d2, { limit: 0 });
    expect(d2.calls[0].params.at(-1)).toBe(25);             // 0 → default
    const d3 = stubDb([[]]); await admin._searchContacts(d3, { limit: -5 });
    expect(d3.calls[0].params.at(-1)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setPortalEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe('setPortalEnabled', () => {
  test('accepts 0/1/"0"/"1"/bool; writes and returns the fresh row', async () => {
    for (const [input, expected] of [[0, 0], ['0', 0], [false, 0], [1, 1], ['1', 1], [true, 1]]) {
      const db = stubDb([
        [contactRow()],                                     // 404 guard fetch
        {},                                                 // UPDATE
        [contactRow({ portal_enabled: expected })],         // fresh
      ]);
      const row = await admin._setPortalEnabled(db, 2003, input);
      expect(row.portal_enabled).toBe(expected);
      expect(db.calls[1].sql).toContain('UPDATE contacts SET portal_enabled = ?');
      expect(db.calls[1].params).toEqual([expected, 2003]);
    }
  });

  test('rejects anything not 0/1-ish → 400, nothing written', async () => {
    for (const bad of ['yes', 2, null, undefined, {}, 'true']) {
      const db = stubDb([]);
      await expect(admin._setPortalEnabled(db, 2003, bad))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining('portal_enabled') });
      expect(db.calls).toHaveLength(0);
    }
  });

  test('unknown contact → 404 before any write', async () => {
    const db = stubDb([[]]);
    await expect(admin._setPortalEnabled(db, 999, 0)).rejects.toMatchObject({ status: 404 });
    expect(db.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forceLogout
// ─────────────────────────────────────────────────────────────────────────────

describe('forceLogout', () => {
  test('increments portal_session_version only; returns the new version', async () => {
    const db = stubDb([
      [contactRow()],                                       // 404 guard
      {},                                                   // UPDATE +1
      [contactRow({ portal_session_version: 4 })],          // fresh
    ]);
    const out = await admin._forceLogout(db, 2003);
    expect(out).toEqual({ contact_id: 2003, portal_session_version: 4 });
    expect(db.calls[1].sql).toContain('portal_session_version = portal_session_version + 1');
    expect(db.calls[1].sql).not.toContain('portal_enabled');   // access untouched
    expect(db.calls[1].params).toEqual([2003]);
  });

  test('unknown contact → 404 before any write', async () => {
    const db = stubDb([[]]);
    await expect(admin._forceLogout(db, 999)).rejects.toMatchObject({ status: 404 });
    expect(db.calls).toHaveLength(1);
  });
});
