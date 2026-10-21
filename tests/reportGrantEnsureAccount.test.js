// tests/reportGrantEnsureAccount.test.js
//
// ensureAccount fails closed around MySQL's CREATE USER IF NOT EXISTS trap:
// on an existing account that statement silently KEEPS the old password, so
// --apply refuses an existing user unless --rotate was asked for, and
// --rotate refuses a missing user (a typo must not create a second account).

'use strict';

const { ensureAccount } = require('../scripts/reportGrantUserProvision');

function conn(exists) {
  const ran = [];
  return {
    ran,
    query: async (sql, params = []) => {
      ran.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/FROM mysql\.user WHERE user = \? AND host = \?/.test(sql)) return [[{ n: exists ? 1 : 0 }]];
      if (/^(CREATE|ALTER) USER/.test(sql)) return [{}];
      throw new Error('unscripted: ' + sql);
    },
  };
}

const ACC = { account: "'yc_report'@'%'", userName: 'yc_report', userHost: '%', password: 'pw' };
const mutated = (c, re) => c.ran.some((r) => re.test(r.sql));

describe('ensureAccount', () => {
  test('missing account, no --rotate: CREATE USER runs', async () => {
    const c = conn(false);
    const r = await ensureAccount(c, { ...ACC, rotate: false });
    expect(r.ok).toBe(true);
    expect(r.did).toMatch(/CREATE USER/);
    expect(mutated(c, /^CREATE USER/)).toBe(true);
  });

  test('existing account, no --rotate: NO-GO, nothing written (old password would silently survive)', async () => {
    const c = conn(true);
    const r = await ensureAccount(c, { ...ACC, rotate: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/--rotate/);
    expect(mutated(c, /^(CREATE|ALTER) USER/)).toBe(false);
  });

  test('existing account with --rotate: ALTER USER sets the new password', async () => {
    const c = conn(true);
    const r = await ensureAccount(c, { ...ACC, rotate: true });
    expect(r.ok).toBe(true);
    expect(mutated(c, /^ALTER USER .* IDENTIFIED BY/)).toBe(true);
    const alter = c.ran.find((x) => /^ALTER USER/.test(x.sql));
    expect(alter.params).toEqual(['pw']);
  });

  test('missing account with --rotate: NO-GO, nothing written', async () => {
    const c = conn(false);
    const r = await ensureAccount(c, { ...ACC, rotate: true });
    expect(r.ok).toBe(false);
    expect(mutated(c, /^(CREATE|ALTER) USER/)).toBe(false);
  });
});

const { grantsToRevokes } = require('../scripts/reportGrantUserProvision');

describe('grantsToRevokes (targeted, never global — Cloud SQL root cannot run REVOKE ALL)', () => {
  const ACCT = "'yc_report'@'%'";

  test('USAGE is skipped; real grants become matching REVOKEs', () => {
    const out = grantsToRevokes([
      "GRANT USAGE ON *.* TO `yc_report`@`%`",
      "GRANT SELECT (`a`, `b`) ON `db1`.`t1` TO `yc_report`@`%`",
      "GRANT SELECT ON `db1`.`t2` TO `yc_report`@`%`;",
    ], ACCT);
    expect(out).toEqual([
      "REVOKE SELECT (`a`, `b`) ON `db1`.`t1` FROM 'yc_report'@'%'",
      "REVOKE SELECT ON `db1`.`t2` FROM 'yc_report'@'%'",
    ]);
  });

  test('a fresh account (USAGE only) revokes nothing', () => {
    expect(grantsToRevokes(["GRANT USAGE ON *.* TO `yc_report`@`%`"], ACCT)).toEqual([]);
  });

  test('an unrecognized grant line throws instead of guessing', () => {
    expect(() => grantsToRevokes(['GRANT `some_role` TO `yc_report`@`%`'], ACCT)).toThrow(/unexpected grant line/);
  });
});
