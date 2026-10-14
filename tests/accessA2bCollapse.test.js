// tests/accessA2bCollapse.test.js
//
/**
 * Access-control A2b — the legacy SU string is gone
 * (ref/ACCESS_CONTROL_DESIGN.md §2.4 items 4–5).
 *
 * Proof obligations:
 *   1. THE LITERAL. No CODE line in lib/, routes/, services/ or public/
 *      carries 'authorized - SU' or the phantom 'authorized - admin' any
 *      more (comments may name them as history). A frontend page that
 *      string-gates SU would hide every SU tool once the collapse runs.
 *   2. THE SCRIPT. scripts/accessA2bCollapse.js: CHECK writes nothing;
 *      APPLY collapses exactly user 6 and verifies; already-collapsed is a
 *      GO no-op; every unexpected base state is a NO-GO before any write —
 *      unknown user_auth values, no enabled su holder, more than one legacy
 *      row, a legacy row that is not user 6, a legacy row lacking su.
 *
 *   npx jest tests/accessA2bCollapse.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { run, COLLAPSE_SQL } = require('../scripts/accessA2bCollapse');

const REPO = path.join(__dirname, '..');

// ── 1. the literal ───────────────────────────────────────────────────────────

function codeFiles(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') out.push(...codeFiles(rel, exts)); }
    else if (exts.some(x => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

// A code line = not a //, *, /* or <!-- comment line. Trailing comments on a
// code line count as code (deliberately strict).
const isCommentLine = l => /^\s*(\/\/|\*|\/\*|<!--)/.test(l);

describe('the legacy SU / phantom admin strings are out of the code', () => {
  const files = [
    ...codeFiles('lib', ['.js']), ...codeFiles('routes', ['.js']), ...codeFiles('services', ['.js']),
    ...codeFiles('public', ['.js', '.html']),
  ];

  test('the scan covers the files that used to gate on them', () => {
    for (const f of ['public/index.html', 'public/users.html', 'public/dbConsole.html',
                     'lib/auth.superuser.js', 'lib/capabilities.js', 'services/mailboxService.js',
                     'routes/admin.users.js']) {
      expect(files).toContain(f);
    }
  });

  for (const lit of ['authorized - SU', 'authorized - admin']) {
    test(`no code line carries '${lit}'`, () => {
      const hits = [];
      for (const f of files) {
        fs.readFileSync(path.join(REPO, f), 'utf8').split('\n').forEach((l, i) => {
          if (l.includes(lit) && !isCommentLine(l)) hits.push(`${f}:${i + 1}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
});

// ── 2. the stage-3 script ────────────────────────────────────────────────────

function fakeConn(rows, { updateAffects } = {}) {
  const log = [];
  const users = rows.map(r => ({ ...r }));
  const conn = {
    log, users,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      log.push(s);
      if (/^SELECT DISTINCT user_auth FROM users/.test(s)) {
        return [[...new Set(users.map(u => u.user_auth))].map(user_auth => ({ user_auth })), []];
      }
      if (/FIND_IN_SET\('su', roles\) AND user_auth LIKE 'authorized%'/.test(s)) {
        return [users.filter(u => u.roles.split(',').includes('su') && u.user_auth.startsWith('authorized')), []];
      }
      if (/WHERE user_auth = \?$/.test(s)) return [users.filter(u => u.user_auth === params[0]), []];
      if (/^UPDATE users SET user_auth = 'authorized'/.test(s)) {
        let n = 0;
        for (const u of users) {
          if (u.user === params[0] && u.user_auth === params[1] && u.roles.split(',').includes('su')) {
            if (updateAffects !== 0) { u.user_auth = 'authorized'; n++; }
          }
        }
        return [{ affectedRows: n }, []];
      }
      if (/WHERE `user` = \?$/.test(s)) return [users.filter(u => u.user === params[0]), []];
      throw new Error('unscripted SQL: ' + s);
    },
  };
  return conn;
}

const LIVE = () => [
  { user: 1, username: 'Ssandweiss', user_auth: 'authorized', roles: 'admin,staff,attorney' },
  { user: 5, username: 'sb', user_auth: 'authorized', roles: 'staff' },
  { user: 6, username: 'IT', user_auth: 'authorized - SU', roles: 'it,admin,form_dev,su' },
];

const writes = c => c.log.filter(s => /^UPDATE/.test(s));

describe('scripts/accessA2bCollapse.js', () => {
  let out;
  beforeEach(() => { out = []; jest.spyOn(console, 'log').mockImplementation((m) => out.push(String(m))); });
  afterEach(() => jest.restoreAllMocks());
  const last = () => out[out.length - 1].trim();

  test('CHECK on the live state: GO, plan printed, nothing written', async () => {
    const c = fakeConn(LIVE());
    expect(await run(c, { apply: false })).toEqual({ ok: true });
    expect(writes(c)).toEqual([]);
    expect(last()).toMatch(/^GO — base state matches\. Next: node scripts\/accessA2bCollapse\.js --apply$/);
  });

  test('APPLY collapses exactly user 6, keeps su, verifies', async () => {
    const c = fakeConn(LIVE());
    expect(await run(c, { apply: true })).toEqual({ ok: true });
    expect(writes(c)).toHaveLength(1);
    expect(c.users.find(u => u.user === 6)).toMatchObject({ user_auth: 'authorized', roles: 'it,admin,form_dev,su' });
    expect(c.users.filter(u => u.user !== 6).map(u => u.user_auth)).toEqual(['authorized', 'authorized']);
    expect(last()).toMatch(/^GO — stage 3 applied and verified/);
  });

  test('the UPDATE is guarded on the row, the string AND the su role', () => {
    expect(COLLAPSE_SQL).toMatch(/WHERE `user` = \? AND user_auth = \? AND FIND_IN_SET\('su', roles\)/);
  });

  test('already collapsed (or saved through the pane): GO no-op, no write', async () => {
    const rows = LIVE(); rows[2].user_auth = 'authorized';
    const c = fakeConn(rows);
    expect(await run(c, { apply: true })).toEqual({ ok: true });
    expect(writes(c)).toEqual([]);
    expect(last()).toMatch(/^GO — stage 3 is already applied/);
  });

  test('NO-GO: an unknown user_auth value, before any write', async () => {
    const rows = LIVE(); rows[1].user_auth = 'authorized - admin';
    const c = fakeConn(rows);
    expect(await run(c, { apply: true })).toEqual({ ok: false });
    expect(writes(c)).toEqual([]);
    expect(last()).toMatch(/^NO-GO/);
  });

  test('NO-GO: no enabled su holder (stage 1 never ran), before any write', async () => {
    const rows = LIVE(); rows[2].roles = 'it,admin,form_dev';
    const c = fakeConn(rows);
    expect(await run(c, { apply: true })).toEqual({ ok: false });
    expect(writes(c)).toEqual([]);
    expect(out.join('\n')).toMatch(/accessA2SuRole\.js/);
  });

  test('NO-GO: two legacy rows', async () => {
    const rows = [...LIVE(), { user: 9, username: 'X', user_auth: 'authorized - SU', roles: 'su' }];
    const c = fakeConn(rows);
    expect(await run(c, { apply: true })).toEqual({ ok: false });
    expect(writes(c)).toEqual([]);
  });

  test('NO-GO: the one legacy row is not user 6', async () => {
    const rows = LIVE(); rows[2].user = 7;
    const c = fakeConn(rows);
    expect(await run(c, { apply: true })).toEqual({ ok: false });
    expect(writes(c)).toEqual([]);
  });

  test('NO-GO: the legacy row lacks su (another user holds it) — collapsing would demote', async () => {
    const rows = [
      { user: 3, username: 'RR', user_auth: 'authorized', roles: 'staff,su' },
      { user: 6, username: 'IT', user_auth: 'authorized - SU', roles: 'it,admin' },
    ];
    const c = fakeConn(rows);
    expect(await run(c, { apply: true })).toEqual({ ok: false });
    expect(writes(c)).toEqual([]);
  });

  test('NO-GO: the UPDATE does not land (affected 0) — never claims success', async () => {
    const c = fakeConn(LIVE(), { updateAffects: 0 });
    expect(await run(c, { apply: true })).toEqual({ ok: false });
    expect(last()).toMatch(/^NO-GO — verify by hand/);
  });
});
