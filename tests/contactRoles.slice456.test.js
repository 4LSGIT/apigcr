// tests/contactRoles.slice456.test.js
//
/**
 * CONTACT ROLES — slices 4–6.
 *
 *   lib/caseRoleResolver      — suffix hit; name fallback absorbing a
 *                               middle-initial variant; garbage suffix →
 *                               null; roster entry without contact_id →
 *                               null; never-throws contract.
 *   contactRoleService        — role-code validation (unknown role rejected),
 *                               dup-attach mapped to a clear error.
 *   GET /api/judges           — read-through: same URL, same response KEYS
 *                               (judge_id / judge_3 / judge_name), now fed by
 *                               contact_roles JOIN contacts.
 *   caseService.updateCase    — twin derived alongside a case_judge write;
 *                               explicit twin write respected (no override).
 *   seedRoleContacts          — parseTrusteeName on the live roster's three
 *                               hard shapes (comma-form, mid-name suffix,
 *                               lname-authoritative), mergeChapters.
 *
 * STUB CONVENTION: dispatch-on-SQL-text (tests/contactOrgKind.test.js idiom)
 * — NOT the scripted-array idiom scriptGuard exists to catch.
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const resolver = require('../lib/caseRoleResolver');
const roleService = require('../services/contactRoleService');
const { parseTrusteeName, mergeChapters } = require('../scripts/seedRoleContacts');

// ─────────────────────────────────────────────────────────────
// caseRoleResolver — judges
// ─────────────────────────────────────────────────────────────

/**
 * db stub for resolveJudge's three passes, dispatched on SQL text:
 *   suffix  → JSON_EXTRACT(cr.attrs …)
 *   exact   → LOWER(c.contact_name)
 *   relaxed → LOWER(c.contact_fname)
 */
function judgeDb({ bySuffix = {}, byName = {}, byParts = {} } = {}) {
  const seen = [];
  return {
    seen,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      seen.push({ s, params });
      if (/JSON_EXTRACT\(cr\.attrs/.test(s)) {
        const hit = bySuffix[params[0]];
        return [hit ? [].concat(hit).map(id => ({ contact_id: id })) : []];
      }
      if (/LOWER\(c\.contact_name\)/.test(s)) {
        const hit = byName[String(params[0]).toLowerCase()];
        return [hit ? [].concat(hit).map(id => ({ contact_id: id })) : []];
      }
      if (/LOWER\(c\.contact_fname\)/.test(s)) {
        const hit = byParts[`${params[0]} ${params[1]}`.toLowerCase()];
        return [hit ? [].concat(hit).map(id => ({ contact_id: id })) : []];
      }
      return [[]];
    },
  };
}

describe('caseRoleResolver.resolveJudge', () => {
  test('docket suffix is the primary key', async () => {
    const db = judgeDb({ bySuffix: { lsg: 101 } });
    const r = await resolver.resolveJudgeDetailed(db, {
      case_number_full: '26-42040-lsg', case_judge: 'Someone Entirely Different',
    });
    expect(r).toEqual({ contact_id: 101, method: 'suffix' });
    // suffix hit means the name passes never ran
    expect(db.seen).toHaveLength(1);
  });

  test('garbage suffix (abc) misses the role table and falls to the name; no name → null', async () => {
    const db = judgeDb({ bySuffix: { lsg: 101 } });
    expect(await resolver.resolveJudge(db, {
      case_number_full: '26-40001-abc', case_judge: '',
    })).toBeNull();
  });

  test("malformed docket ('26-00546 (jlr)') never even queries the suffix pass", async () => {
    const db = judgeDb({ byName: { 'lisa s. gretchko': 101 } });
    const r = await resolver.resolveJudgeDetailed(db, {
      case_number_full: '26-00546 (jlr)', case_judge: 'Lisa S. Gretchko',
    });
    expect(r).toEqual({ contact_id: 101, method: 'name_exact' });
    expect(db.seen.some(q => /JSON_EXTRACT/.test(q.s))).toBe(false);
  });

  test('name fallback absorbs the middle-initial drift (Lisa Gretchko → Lisa S. Gretchko row)', async () => {
    // No suffix, no exact-name hit — the relaxed fname+lname pass carries it.
    const db = judgeDb({ byParts: { 'lisa gretchko': 101 } });
    const r = await resolver.resolveJudgeDetailed(db, {
      case_number_full: '', case_judge: 'Lisa Gretchko',
    });
    expect(r).toEqual({ contact_id: 101, method: 'name_relaxed' });
  });

  test('ambiguity never guesses: 2+ suffix rows falls through, 2+ exact-name rows → null', async () => {
    const db = judgeDb({ bySuffix: { mar: [101, 102] }, byName: { 'mark a. randon': [101, 102] } });
    expect(await resolver.resolveJudge(db, {
      case_number_full: '26-1-mar', case_judge: 'Mark A. Randon',
    })).toBeNull();
  });

  test('never throws — a broken db resolves null', async () => {
    const db = { query: async () => { throw new Error('boom'); } };
    expect(await resolver.resolveJudge(db, {
      case_number_full: '26-42040-lsg', case_judge: 'Lisa S. Gretchko',
    })).toBeNull();
  });

  test('_docketSuffix shapes', () => {
    expect(resolver._docketSuffix('26-42040-mar')).toBe('mar');
    expect(resolver._docketSuffix('24-48734-MLO')).toBe('mlo');
    expect(resolver._docketSuffix('26-00546 (jlr)')).toBeNull();
    expect(resolver._docketSuffix('26-40001')).toBeNull(); // 5 digits, not a suffix
    expect(resolver._docketSuffix('')).toBeNull();
    expect(resolver._docketSuffix(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// caseRoleResolver — trustees
// ─────────────────────────────────────────────────────────────

const ROSTER = [
  { name: 'Basil T. Simon', lname: 'Simon', case_type: 7, contact_id: 201, link: 'https://z/s' },
  { name: 'Thomas W. McDonald', lname: 'McDonald', case_type: 12, contact_id: 210, link: 'https://z/m' },
  { name: 'Thomas W. Jr. McDonald', lname: 'McDonald', case_type: 13, contact_id: 210, link: 'https://z/m' },
  { name: 'Tammy L. Terry', lname: 'Terry', case_type: 13 }, // deliberately NO contact_id
];

describe('caseRoleResolver.resolveTrustee', () => {
  const noDb = { query: async () => { throw new Error('must not query — roster injected'); } };

  test('matched roster entry → its contact_id', async () => {
    const r = await resolver.resolveTrusteeDetailed(noDb,
      { case_trustee: 'Basil T. Simon', case_chapter: '7' }, { roster: ROSTER });
    expect(r).toMatchObject({ contact_id: 201, status: 'matched', method: 'exact' });
  });

  test('roster entry WITHOUT contact_id → null, never guessed', async () => {
    const r = await resolver.resolveTrusteeDetailed(noDb,
      { case_trustee: 'Tammy L. Terry', case_chapter: '13' }, { roster: ROSTER });
    expect(r.contact_id).toBeNull();
    expect(r.status).toBe('entry_no_contact_id');
  });

  test('chapter drives McDonald disambiguation (trusteeMatch rule 0) — both map to one contact', async () => {
    const ch13 = await resolver.resolveTrustee(noDb,
      { case_trustee: 'Thomas W. Jr. McDonald', case_chapter: '13' }, { roster: ROSTER });
    const ch12 = await resolver.resolveTrustee(noDb,
      { case_trustee: 'Thomas W. McDonald', case_chapter: '12' }, { roster: ROSTER });
    expect(ch13).toBe(210);
    expect(ch12).toBe(210);
  });

  test('blank trustee / no roster / unmatched string → null with the matcher status', async () => {
    expect((await resolver.resolveTrusteeDetailed(noDb, { case_trustee: '' }, { roster: ROSTER })).status)
      .toBe('no_trustee');
    expect((await resolver.resolveTrusteeDetailed(noDb,
      { case_trustee: 'X' }, { roster: [] })).status).toBe('no_roster');
    expect(await resolver.resolveTrustee(noDb,
      { case_trustee: 'Nobody At All', case_chapter: '7' }, { roster: ROSTER })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// contactRoleService — validation
// ─────────────────────────────────────────────────────────────

function roleDb({ roleTypes = ['judge', 'trustee'], contactExists = true, dupOnInsert = false } = {}) {
  const inserts = [];
  return {
    inserts,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/FROM contact_role_types WHERE role_code/.test(s)) {
        return [roleTypes.includes(params[0]) ? [{ role_code: params[0] }] : []];
      }
      if (/SELECT contact_id FROM contacts WHERE contact_id/.test(s)) {
        return [contactExists ? [{ contact_id: params[0] }] : []];
      }
      if (/^INSERT INTO contact_roles/.test(s)) {
        if (dupOnInsert) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
        inserts.push({ s, params });
        return [{ insertId: 55 }];
      }
      return [[]];
    },
  };
}

describe('contactRoleService', () => {
  test('attachRole rejects an unknown role code — the varchar accepts anything, the service must not', async () => {
    await expect(roleService.attachRole(roleDb(), { contact_id: 1, role: 'wizard' }))
      .rejects.toThrow(/role "wizard" is not an active contact_role_types code/);
  });

  test('attachRole rejects a missing contact', async () => {
    await expect(roleService.attachRole(roleDb({ contactExists: false }),
      { contact_id: 999, role: 'judge' })).rejects.toThrow(/contact 999 not found/);
  });

  test('attachRole stringifies attrs and maps ER_DUP_ENTRY to a clear message', async () => {
    const db = roleDb();
    const { id } = await roleService.attachRole(db,
      { contact_id: 7, role: 'judge', attrs: { judge_3: 'mar' } });
    expect(id).toBe(55);
    expect(db.inserts[0].params).toEqual([7, 'judge', JSON.stringify({ judge_3: 'mar' }), 1, 0]);

    await expect(roleService.attachRole(roleDb({ dupOnInsert: true }),
      { contact_id: 7, role: 'judge' })).rejects.toThrow(/already has role "judge"/);
  });

  test('updateRole requires at least one field; detachRole reports removed count', async () => {
    await expect(roleService.updateRole(roleDb(), 3, {})).rejects.toThrow(/at least one/);
    const db = {
      query: async (sql) => (/^DELETE FROM contact_roles/.test(String(sql))
        ? [{ affectedRows: 1 }] : [[]]),
    };
    expect(await roleService.detachRole(db, { contact_id: 7, role: 'judge' }))
      .toEqual({ removed: 1 });
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/judges — read-through shape
// ─────────────────────────────────────────────────────────────

// express in-process over a real ephemeral socket — the
// tests/trusteesRoute.test.js idiom.
const express = require('express');
const http = require('http');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { userId: 6 }; next(); }));

function judgesApp() {
  const a = express();
  a.use((req, _res, next) => {
    req.db = {
      query: async (sql) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/FROM contact_roles cr JOIN contacts c/.test(s)) {
          return [[
            { id: 1, contact_id: 501, contact_name: 'Joel D. Applebaum',
              attrs: { judge_3: 'jda' }, active: 1, sort_order: 0 },
            // mysql2 sometimes hands JSON back as a string — the service
            // normalizes; the route must survive both.
            { id: 2, contact_id: 502, contact_name: 'Lisa S. Gretchko',
              attrs: '{"judge_3":"lsg"}', active: 1, sort_order: 0 },
          ]];
        }
        return [[]];
      },
    };
    next();
  });
  a.use(require('../routes/api.users.js'));
  return a;
}

function get(a, urlPath) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
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

describe('GET /api/judges — contact_roles read-through', () => {
  test('same URL, same KEYS: judge_id / judge_3 / judge_name', async () => {
    const { status, body } = await get(judgesApp(), '/api/judges');
    expect(status).toBe(200);
    expect(body).toEqual({
      judges: [
        { judge_id: 501, judge_3: 'jda', judge_name: 'Joel D. Applebaum' },
        { judge_id: 502, judge_3: 'lsg', judge_name: 'Lisa S. Gretchko' },
      ],
    });
  });
});

// ─────────────────────────────────────────────────────────────
// caseService.updateCase — twin wiring
// ─────────────────────────────────────────────────────────────

describe('caseService.updateCase — role twins (slice 6)', () => {
  const caseService = require('../services/caseService');

  function caseDb({ priorRow, judgeSuffixHit = null } = {}) {
    const updates = [];
    return {
      updates,
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/^SELECT \* FROM cases WHERE case_id/.test(s)) return [[priorRow]];
        if (/^UPDATE cases SET/.test(s)) { updates.push({ s, params }); return [{ affectedRows: 1 }]; }
        // resolver: suffix pass
        if (/JSON_EXTRACT\(cr\.attrs/.test(s)) {
          return [judgeSuffixHit != null ? [{ contact_id: judgeSuffixHit }] : []];
        }
        // resolver: name passes / roster read — miss everything
        if (/FROM app_settings/.test(s)) return [[]];
        return [[]];
      },
    };
  }

  const PRIOR = {
    case_id: 'C1', case_number_full: '26-42040-lsg', case_judge: '',
    case_trustee: '', case_chapter: '7',
    case_judge_contact_id: null, case_trustee_contact_id: null,
  };

  test('writing case_judge derives case_judge_contact_id from the POST-state docket suffix', async () => {
    const db = caseDb({ priorRow: PRIOR, judgeSuffixHit: 101 });
    const r = await caseService.updateCase(db, 'C1', { case_judge: 'Lisa S. Gretchko' });
    expect(r.updated_fields).toEqual(expect.arrayContaining(['case_judge', 'case_judge_contact_id']));
    const upd = db.updates[0];
    expect(upd.s).toMatch(/`case_judge_contact_id` = \?/);
    const idx = r.updated_fields.indexOf('case_judge_contact_id');
    expect(upd.params[idx]).toBe(101);
  });

  test('an explicitly-written twin is respected — no auto-resolve override', async () => {
    const db = caseDb({ priorRow: PRIOR, judgeSuffixHit: 101 });
    const r = await caseService.updateCase(db, 'C1',
      { case_judge: 'Lisa S. Gretchko', case_judge_contact_id: 777 });
    const idx = r.updated_fields.indexOf('case_judge_contact_id');
    expect(db.updates[0].params[idx]).toBe(777);
    expect(r.updated_fields.filter(f => f === 'case_judge_contact_id')).toHaveLength(1);
  });

  test('resolution failure writes NULL, never throws (a filing must not bounce)', async () => {
    const db = caseDb({ priorRow: { ...PRIOR, case_number_full: '26-1-abc' } });
    const r = await caseService.updateCase(db, 'C1', { case_judge: 'Unknown Person' });
    const idx = r.updated_fields.indexOf('case_judge_contact_id');
    expect(db.updates[0].params[idx]).toBeNull();
  });

  test('an unrelated field write does NOT touch the twins', async () => {
    const db = caseDb({ priorRow: PRIOR });
    const r = await caseService.updateCase(db, 'C1', { case_stage: 'Filed' });
    expect(r.updated_fields).toEqual(['case_stage']);
  });
});

// ─────────────────────────────────────────────────────────────
// seedRoleContacts — name parsing + chapter merge
// ─────────────────────────────────────────────────────────────

describe('seedRoleContacts.parseTrusteeName — roster lname is authoritative', () => {
  test('plain middle initial', () => {
    expect(parseTrusteeName('Basil T. Simon', 'Simon'))
      .toEqual({ fname: 'Basil', mname: 'T.', lname: 'Simon', anomaly: null });
  });

  test("comma form — 'Caouette, Melissa A.'", () => {
    expect(parseTrusteeName('Caouette, Melissa A.', 'Caouette'))
      .toEqual({ fname: 'Melissa', mname: 'A.', lname: 'Caouette', anomaly: null });
  });

  test("suffix-bearing mid-name — 'Thomas W. Jr. McDonald'", () => {
    expect(parseTrusteeName('Thomas W. Jr. McDonald', 'McDonald'))
      .toEqual({ fname: 'Thomas', mname: 'W. Jr.', lname: 'McDonald', anomaly: null });
  });

  test('two-token given name keeps first as fname mechanically', () => {
    expect(parseTrusteeName('K. Jin Lim', 'Lim'))
      .toEqual({ fname: 'K.', mname: 'Jin', lname: 'Lim', anomaly: null });
  });

  test('lname absent from the display name is flagged, not guessed away', () => {
    const p = parseTrusteeName('Someone Else', 'Roster');
    expect(p.lname).toBe('Roster');
    expect(p.anomaly).toBe('lname_not_in_name');
  });
});

describe('seedRoleContacts.mergeChapters — the McDonald uk_contact_role collision', () => {
  test('scalar + scalar → sorted array; idempotent re-merge; single stays scalar', () => {
    expect(mergeChapters(12, 13)).toEqual([12, 13]);
    expect(mergeChapters([12, 13], 13)).toEqual([12, 13]);
    expect(mergeChapters(7, 7)).toBe(7);
    expect(mergeChapters(null, 13)).toBe(13);
  });
});
