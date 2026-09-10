// tests/contactRoles.roleForms.test.js
//
/**
 * Role Forms slice — schema-driven role attrs, role-type CRUD routes, and
 * the contacts-list role filter.
 *
 * The proof obligations, in charter order:
 *
 *   1. ROUND-TRIP: a trustee's chapter attrs pushed through the FORM's write
 *      path (updateRole) explode through lib/trusteeRoster IDENTICALLY to
 *      the pre-edit attrs — form edits cannot disturb 7A consumers. The
 *      roster module is REQUIRED AND CALLED, never reimplemented here.
 *
 *   2. VALIDATION MATRIX: required-missing rejected on attach; wrong-typed
 *      values rejected (the string '7' where the number 7 belongs is the
 *      named case — trusteeMatch rule 0 keys on numeric case_type);
 *      undeclared keys pass through byte-for-byte; a NULL schema accepts
 *      any object (pre-m7 behavior, judge rows before their schema landed).
 *
 *   3. ROLE FILTER SQL SHAPE: role present → EXISTS subquery pinned to
 *      active = 1, composing with query/type; role omitted → the SQL is
 *      BYTE-IDENTICAL to the pre-slice literal (embedded below — if a later
 *      slice legitimately changes listContacts SQL, update the literal AND
 *      re-verify the no-op property, that is the point of the pin).
 *
 *   4. ROUTES: inventory; role_code immutability (PUT attempting a code
 *      change → 400); :roleRowId ownership scoping (a row belonging to
 *      another contact → 404, never a cross-contact write).
 *
 * House idioms throughout: dispatch-on-SQL-text db stubs (scriptGuard —
 * never scripted result arrays), express + node http over an ephemeral
 * socket with lib/auth.jwtOrApiKey jest-mocked (the trusteesRoute /
 * slice456 idiom).
 */

const roleService = require('../services/contactRoleService');
const contactService = require('../services/contactService');
const roster = require('../lib/trusteeRoster');

// The LIVE seeded schemas (verified against contact_role_types 2026-09-10).
const TRUSTEE_SCHEMA = [
  { key: 'chapter',   type: 'multi_select', label: 'Chapters',      options: [7, 11, 12, 13], required: true },
  { key: 'zoom_link', type: 'url',          label: '341 Zoom link', required: false, placeholder: 'https://\u2026zoom.us/j/\u2026' },
];
const JUDGE_SCHEMA = [
  { key: 'judge_3', type: 'text', label: 'Docket suffix (3-letter)', required: true, placeholder: 'lsg' },
];

// ─────────────────────────────────────────────────────────────
// Shared stub — dispatch on SQL text, never on call order
// ─────────────────────────────────────────────────────────────

/** attachRole-path db: role type exists, contact exists, INSERT captured.
 *  `schema` feeds _loadAttrsSchema (null = column NULL). */
function schemaDb({ schema = null, contactExists = true } = {}) {
  const inserts = [];
  return {
    inserts,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      // MOST SPECIFIC FIRST: _loadAttrsSchema's SQL also contains the
      // assertValidRole fragment matched two branches down.
      if (/SELECT attrs_schema FROM contact_role_types WHERE role_code/.test(s)) {
        return [[{ attrs_schema: schema == null ? null : JSON.stringify(schema) }]];
      }
      if (/FROM contact_role_types WHERE role_code/.test(s)) {
        return [[{ role_code: params[0] }]];               // assertValidRole hit
      }
      if (/SELECT contact_id FROM contacts WHERE contact_id/.test(s)) {
        return [contactExists ? [{ contact_id: params[0] }] : []];
      }
      if (/^INSERT INTO contact_roles/.test(s)) {
        inserts.push({ s, params });
        return [{ insertId: 91 }];
      }
      throw new Error('schemaDb: unscripted query — ' + s);
    },
  };
}

/** updateRole-path db: the role+schema JOIN lookup, UPDATE captured. */
function updateDb({ role = 'trustee', schema = TRUSTEE_SCHEMA, rowExists = true } = {}) {
  const updates = [];
  return {
    updates,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/SELECT cr\.role, crt\.attrs_schema/.test(s)) {
        return [rowExists
          ? [{ role, attrs_schema: schema == null ? null : JSON.stringify(schema) }]
          : []];
      }
      if (/^UPDATE contact_roles SET/.test(s)) {
        updates.push({ s, params });
        return [{ affectedRows: 1 }];
      }
      throw new Error('updateDb: unscripted query — ' + s);
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 1. Round-trip — the form's write path cannot disturb 7A consumers
// ─────────────────────────────────────────────────────────────

describe('round-trip: updateRole → loadTrusteeRoster', () => {
  const CONTACT_COLS = {
    contact_name: 'Thomas W. McDonald', contact_lname: 'McDonald',
    contact_email: 'tmcd@example.com', contact_phone: '3135551212',
    contact_address: '607 Shelby St, Suite 700', contact_city: 'Detroit',
    contact_state: 'MI', contact_zip: '48226',
  };

  function rosterDb(attrsJson) {
    return {
      query: async (sql) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (!/FROM contact_roles cr JOIN contacts c/.test(s)) {
          throw new Error('rosterDb: unscripted query — ' + s);
        }
        return [[{ contact_id: 210, attrs: attrsJson, ...CONTACT_COLS }]];
      },
    };
  }

  test('form-saved chapter attrs explode identically to the pre-edit roster', async () => {
    const ATTRS = { chapter: [12, 13], zoom_link: 'https://lsg.zoom.us/j/1' };

    // Pre-edit roster: what 7A consumers see today.
    const before = await roster.loadTrusteeRoster(rosterDb(JSON.stringify(ATTRS)));
    expect(before).toHaveLength(2); // the multi-chapter explode itself

    // The FORM's save path: PATCH {attrs} → updateRole. Capture the JSON
    // the service actually stores.
    const db = updateDb();
    await roleService.updateRole(db, 9, { attrs: ATTRS });
    expect(db.updates).toHaveLength(1);
    const storedJson = db.updates[0].params[0];
    expect(storedJson).toBe(JSON.stringify(ATTRS)); // byte-level identity
    expect(JSON.parse(storedJson).chapter.every((c) => typeof c === 'number')).toBe(true);

    // Post-edit roster from the STORED value — must be deep-equal.
    const after = await roster.loadTrusteeRoster(rosterDb(storedJson));
    expect(after).toEqual(before);
    expect(after.map((e) => e.case_type)).toEqual([12, 13]);
    expect(after.every((e) => typeof e.case_type === 'number')).toBe(true);
    expect(after.every((e) => e.contact_id === 210)).toBe(true);
    expect(after.every((e) => e.link === 'https://lsg.zoom.us/j/1')).toBe(true);
  });

  test("the string-'7' chapter — trusteeMatch rule 0's poison — never reaches storage", async () => {
    const db = updateDb();
    await expect(roleService.updateRole(db, 9, {
      attrs: { chapter: ['7'], zoom_link: '' },
    })).rejects.toThrow(/attrs\.chapter: "7" has the wrong type — the option is 7 \(number\), not "7" \(string\)/);
    expect(db.updates).toHaveLength(0); // rejected BEFORE the UPDATE
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Validation matrix
// ─────────────────────────────────────────────────────────────

describe('attachRole attrs validation (schema-driven)', () => {
  test('required missing on attach → rejected before the INSERT', async () => {
    const db = schemaDb({ schema: TRUSTEE_SCHEMA });
    await expect(roleService.attachRole(db, { contact_id: 7, role: 'trustee', attrs: { zoom_link: '' } }))
      .rejects.toThrow(/attrs\.chapter is required/);
    await expect(roleService.attachRole(db, { contact_id: 7, role: 'trustee', attrs: { chapter: [] } }))
      .rejects.toThrow(/attrs\.chapter is required/); // empty multi_select = blank
    expect(db.inserts).toHaveLength(0);
  });

  test('wrong-typed values rejected: string-in-number, non-http url, non-string text', async () => {
    const numDb = schemaDb({ schema: [{ key: 'n', type: 'number', label: 'N' }] });
    await expect(roleService.attachRole(numDb, { contact_id: 7, role: 'x', attrs: { n: '7' } }))
      .rejects.toThrow(/attrs\.n must be a number \(got the string "7"\)/);

    const tDb = schemaDb({ schema: TRUSTEE_SCHEMA });
    await expect(roleService.attachRole(tDb, { contact_id: 7, role: 'trustee',
      attrs: { chapter: [7], zoom_link: 'zoom.us/j/1' } }))
      .rejects.toThrow(/attrs\.zoom_link must be an http\(s\) URL/);
    await expect(roleService.attachRole(tDb, { contact_id: 7, role: 'trustee',
      attrs: { chapter: [7], zoom_link: 'ftp://z' } }))
      .rejects.toThrow(/attrs\.zoom_link must be an http\(s\) URL/);

    const jDb = schemaDb({ schema: JUDGE_SCHEMA });
    await expect(roleService.attachRole(jDb, { contact_id: 7, role: 'judge', attrs: { judge_3: 7 } }))
      .rejects.toThrow(/attrs\.judge_3 must be text/);
  });

  test('multi_select: duplicates and out-of-options values rejected; valid set inserts', async () => {
    const db = schemaDb({ schema: TRUSTEE_SCHEMA });
    await expect(roleService.attachRole(db, { contact_id: 7, role: 'trustee',
      attrs: { chapter: [7, 7] } })).rejects.toThrow(/attrs\.chapter must not contain duplicates/);
    await expect(roleService.attachRole(db, { contact_id: 7, role: 'trustee',
      attrs: { chapter: [7, 9] } })).rejects.toThrow(/9 is not one of the allowed options/);

    await roleService.attachRole(db, { contact_id: 7, role: 'trustee',
      attrs: { chapter: [12, 13], zoom_link: '' } });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].params[2]).toBe(JSON.stringify({ chapter: [12, 13], zoom_link: '' }));
  });

  test('select: strict membership with number identity', async () => {
    const sDb = () => schemaDb({ schema: [{ key: 'ch', type: 'select', label: 'Ch', options: [7, 11] }] });
    await expect(roleService.attachRole(sDb(), { contact_id: 7, role: 'x', attrs: { ch: '7' } }))
      .rejects.toThrow(/wrong type/);
    const ok = sDb();
    await roleService.attachRole(ok, { contact_id: 7, role: 'x', attrs: { ch: 7 } });
    expect(JSON.parse(ok.inserts[0].params[2])).toEqual({ ch: 7 });
  });

  test('UNDECLARED keys pass through byte-for-byte — never stripped, never rejected', async () => {
    const db = schemaDb({ schema: TRUSTEE_SCHEMA });
    const attrs = { chapter: [7], zoom_link: '', legacy_note: 'keep me', nested: { deep: [1, '2'] } };
    await roleService.attachRole(db, { contact_id: 7, role: 'trustee', attrs });
    expect(db.inserts[0].params[2]).toBe(JSON.stringify(attrs));
  });

  test('NULL schema accepts any object (pre-m7 behavior) but still rejects non-objects', async () => {
    const db = schemaDb({ schema: null });
    await roleService.attachRole(db, { contact_id: 7, role: 'x',
      attrs: { anything: true, chapter: 'not even checked' } });
    expect(db.inserts).toHaveLength(1);

    await expect(roleService.attachRole(schemaDb({ schema: null }),
      { contact_id: 7, role: 'x', attrs: [1, 2] }))
      .rejects.toThrow(/attrs must be a JSON object or null/);
  });

  test('updateRole: attrs write against a missing row → not found (the JOIN lookup doubles as the check)', async () => {
    await expect(roleService.updateRole(updateDb({ rowExists: false }), 44, { attrs: { chapter: [7] } }))
      .rejects.toThrow(/contact_roles row 44 not found/);
  });

  test('updateRole: active-only update runs NO schema lookup (path unchanged from slice 4)', async () => {
    const calls = [];
    const db = { query: async (sql, params = []) => {
      calls.push(String(sql).replace(/\s+/g, ' '));
      return [{ affectedRows: 1 }];
    } };
    await roleService.updateRole(db, 5, { active: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^UPDATE contact_roles SET active = \?/);
  });
});

// ─────────────────────────────────────────────────────────────
// 2b. attrs_schema vocabulary validator (shared by the type routes)
// ─────────────────────────────────────────────────────────────

describe('validateAttrsSchema — the shared vocabulary', () => {
  const V = roleService.validateAttrsSchema;

  test('null / empty array / "[]" / "null" all normalize to null', () => {
    expect(V(null)).toBeNull();
    expect(V(undefined)).toBeNull();
    expect(V([])).toBeNull();
    expect(V('[]')).toBeNull();
    expect(V('null')).toBeNull();
  });

  test('the live trustee schema validates and round-trips unchanged', () => {
    expect(V(TRUSTEE_SCHEMA)).toEqual(TRUSTEE_SCHEMA);
    expect(V(JSON.stringify(TRUSTEE_SCHEMA))).toEqual(TRUSTEE_SCHEMA);
  });

  test.each([
    ['not json',                          /attrs_schema must be valid JSON/],
    ['{"key":"x"}',                       /must be a JSON array/],
    [[{ key: 'x', label: 'X', type: 'blob' }], /type must be one of text, url, number, select, multi_select/],
    [[{ key: 'x', label: 'X', type: 'select' }], /options is required for select/],
    [[{ key: 'x', label: 'X', type: 'text', options: [1] }], /options is only allowed for select \/ multi_select/],
    [[{ key: 'x', label: 'X', type: 'text' }, { key: 'x', label: 'Y', type: 'text' }], /key "x" is duplicated/],
    [[{ key: 'Judge-3', label: 'X', type: 'text' }], /key must be 1–40 chars/],
    [[{ key: 'x', label: '', type: 'text' }], /label is required/],
    [[{ key: 'x', label: 'X', type: 'text', requried: true }], /unknown property "requried"/],
    [[{ key: 'x', label: 'X', type: 'text', required: 'yes' }], /required must be true or false/],
    [[{ key: 'x', label: 'X', type: 'select', options: [7, 7] }], /options must be unique/],
    [[{ key: 'x', label: 'X', type: 'select', options: ['', 7] }], /options entries must be non-empty strings or finite numbers/],
  ])('rejects %j', (schema, re) => {
    expect(() => V(schema)).toThrow(re);
  });

  test('every problem is reported at once, joined by "; "', () => {
    try {
      V([{ key: 'Bad Key', label: '', type: 'blob' }]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.message).toMatch(/key must be/);
      expect(e.message).toMatch(/label is required/);
      expect(e.message).toMatch(/type must be one of/);
      expect(e.message.split('; ')).toHaveLength(3);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 2c. Role-type CRUD service
// ─────────────────────────────────────────────────────────────

describe('createRoleType / updateRoleType', () => {
  test('createRoleType: slug-validated code, label bounds, ER_DUP_ENTRY mapped', async () => {
    await expect(roleService.createRoleType({}, { role_code: 'Bad Code', label: 'X' }))
      .rejects.toThrow(/role_code must be 1–40 chars/);
    await expect(roleService.createRoleType({}, { role_code: 'ok', label: '' }))
      .rejects.toThrow(/label is required/);
    await expect(roleService.createRoleType({}, { role_code: 'ok', label: 'x'.repeat(61) }))
      .rejects.toThrow(/60 characters or fewer/);

    const dup = { query: async () => { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; } };
    await expect(roleService.createRoleType(dup, { role_code: 'judge', label: 'Judge' }))
      .rejects.toThrow(/role type "judge" already exists/);

    const inserts = [];
    const db = { query: async (sql, params) => { inserts.push(params); return [{ insertId: 3 }]; } };
    await roleService.createRoleType(db, { role_code: 'mediator', label: ' Mediator ', attrs_schema: [] });
    expect(inserts[0]).toEqual(['mediator', 'Mediator', null, 0, 1]); // [] normalized to NULL
  });

  test('updateRoleType: role_code is immutable — a rename attempt throws, nothing is queried', async () => {
    const db = { query: async () => { throw new Error('must not query'); } };
    await expect(roleService.updateRoleType(db, 'judge', { role_code: 'magistrate', label: 'X' }))
      .rejects.toThrow(/role_code is immutable — deactivate this type and create a new one instead/);
    // An ECHO of the same code is not a rename — it must pass through.
    const updates = [];
    const ok = { query: async (sql, params) => { updates.push({ sql: String(sql).replace(/\s+/g, ' '), params }); return [{ affectedRows: 1 }]; } };
    await roleService.updateRoleType(ok, 'judge', { role_code: 'judge', label: 'Judge!' });
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/^UPDATE contact_role_types SET label = \? WHERE role_code = \?$/);
    expect(updates[0].params).toEqual(['Judge!', 'judge']);
  });

  test('updateRoleType: at-least-one, not-found, schema validated on the way in', async () => {
    await expect(roleService.updateRoleType({}, 'judge', {}))
      .rejects.toThrow(/at least one of label, sort_order, active, attrs_schema/);

    const miss = { query: async () => [{ affectedRows: 0 }] };
    await expect(roleService.updateRoleType(miss, 'ghost', { label: 'G' }))
      .rejects.toThrow(/role type "ghost" not found/);

    await expect(roleService.updateRoleType({}, 'judge', { attrs_schema: [{ key: 'x', label: 'X', type: 'select' }] }))
      .rejects.toThrow(/options is required for select/);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. listContacts role filter — SQL shape pinned
// ─────────────────────────────────────────────────────────────

/* The PRE-SLICE default-state SQL, captured from the baseline commit
 * (git show baseline:services/contactService.js) before the role filter
 * existed. The no-role path MUST stay byte-identical to it: the filter is
 * an add-on, never a rewrite. */
const PRE_SQL_MAIN = "SELECT\n     c.contact_id, c.contact_type, c.contact_name,\n     c.contact_fname, c.contact_mname, c.contact_lname,\n     c.contact_phone, c.contact_email,\n     c.contact_address, c.contact_city, c.contact_state, c.contact_zip,\n     c.contact_tags,\n     IFNULL(DATE_FORMAT(c.contact_dob, '%M %e, %Y'), '') AS dob,\n     JSON_ARRAYAGG(\n       JSON_OBJECT(\n         'case_number', COALESCE(ca.case_number_full, ca.case_number, ca.case_id),\n         'case_id',      ca.case_id,\n         'case_type',    ca.case_type,\n         'case_subtype', ca.case_subtype\n       )\n     ) AS cases\n   FROM contacts c\n   LEFT JOIN case_relate cr ON c.contact_id = cr.case_relate_client_id\n   LEFT JOIN cases ca ON cr.case_relate_case_id = ca.case_id\n   \n   GROUP BY c.contact_id\n   ORDER BY c.contact_lname ASC\n   LIMIT ? OFFSET ?";
const PRE_SQL_COUNT = "SELECT COUNT(DISTINCT c.contact_id) AS total\n   FROM contacts c\n   LEFT JOIN case_relate cr ON c.contact_id = cr.case_relate_client_id\n   LEFT JOIN cases ca ON cr.case_relate_case_id = ca.case_id\n   ";

function captureDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return calls.length === 1 ? [[]] : [[{ total: 0 }]];
    },
  };
}

describe('listContacts role filter', () => {
  test('role omitted / null / "" → SQL byte-identical to the pre-slice literal', async () => {
    for (const opts of [{}, { role: null }, { role: '' }]) {
      const db = captureDb();
      await contactService.listContacts(db, opts);
      expect(db.calls[0].sql).toBe(PRE_SQL_MAIN);
      expect(db.calls[0].params).toEqual([50, 0]);
      expect(db.calls[1].sql).toBe(PRE_SQL_COUNT);
      expect(db.calls[1].params).toEqual([]);
    }
  });

  test('role present → EXISTS subquery pinned to active = 1, on BOTH queries', async () => {
    const db = captureDb();
    await contactService.listContacts(db, { role: 'trustee' });
    for (const call of db.calls) {
      const s = call.sql.replace(/\s+/g, ' ');
      expect(s).toMatch(/EXISTS \( SELECT 1 FROM contact_roles crl WHERE crl\.contact_id = c\.contact_id AND crl\.role = \? AND crl\.active = 1 \)/);
      expect(s).not.toMatch(/JOIN contact_roles/); // EXISTS, never a row-multiplying JOIN
    }
    expect(db.calls[0].params).toEqual(['trustee', 50, 0]);
    expect(db.calls[1].params).toEqual(['trustee']);
  });

  test('composes with query + type: role rides the same AND chain, params in clause order', async () => {
    const db = captureDb();
    await contactService.listContacts(db, { query: 'smith', type: 'Client', role: ' trustee ' });
    const s = db.calls[0].sql.replace(/\s+/g, ' ');
    expect(s).toMatch(/WHERE .*AND c\.contact_type = \? AND EXISTS/);
    const p = db.calls[0].params;
    expect(p.slice(-3)).toEqual(['trustee', 50, 0]); // trimmed, after the type param
    expect(p).toContain('Client');
    expect(db.calls[1].params.slice(-1)).toEqual(['trustee']);
  });

  /* ROLE_NONE — the negation of the same axis. Same EXISTS shape, NOT'd and
     with the role predicate dropped: "holds no active role", not "holds
     something other than trustee". It contributes NO param, which is the
     easy thing to get wrong (a stray push shifts LIMIT/OFFSET). */
  test('ROLE_NONE → NOT EXISTS over active rows, no role param, on BOTH queries', async () => {
    const db = captureDb();
    await contactService.listContacts(db, { role: contactService.ROLE_NONE });
    for (const call of db.calls) {
      const s = call.sql.replace(/\s+/g, ' ');
      expect(s).toMatch(/NOT EXISTS \( SELECT 1 FROM contact_roles crl WHERE crl\.contact_id = c\.contact_id AND crl\.active = 1 \)/);
      expect(s).not.toMatch(/crl\.role = \?/);   // no code predicate at all
      expect(s).not.toMatch(/JOIN contact_roles/);
    }
    expect(db.calls[0].params).toEqual([50, 0]);   // LIMIT/OFFSET only
    expect(db.calls[1].params).toEqual([]);
  });

  test('ROLE_NONE composes with query + type, and survives whitespace', async () => {
    const db = captureDb();
    await contactService.listContacts(db, { query: 'smith', type: 'Client', role: ' -none ' });
    const s = db.calls[0].sql.replace(/\s+/g, ' ');
    expect(s).toMatch(/WHERE .*AND c\.contact_type = \? AND NOT EXISTS/);
    expect(db.calls[0].params.slice(-3)).toEqual(['Client', 50, 0]); // no role param between type and LIMIT
  });

  /* A role_code can never contain '-' (contactRoleService SLUG_RE), so the
     sentinel cannot be shadowed by a real role type — but an unknown code
     must still take the positive path and simply match nothing, rather than
     falling through to "no roles" and returning 1000 contacts. */
  test('an unknown role code stays on the EXISTS path', async () => {
    const db = captureDb();
    await contactService.listContacts(db, { role: 'none' });
    const s = db.calls[0].sql.replace(/\s+/g, ' ');
    expect(s).toMatch(/ EXISTS \(/);
    expect(s).not.toMatch(/NOT EXISTS/);
    expect(db.calls[0].params).toEqual(['none', 50, 0]);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Routes — express + fetch over an ephemeral socket
// ─────────────────────────────────────────────────────────────

const express = require('express');
const http = require('http');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { userId: 6 }; next(); }));

/** In-memory role-world db: two contacts, one trustee row owned by 210. */
function routeDb() {
  const state = {
    types: [
      { role_code: 'judge',   label: 'Judge',   attrs_schema: JSON.stringify(JUDGE_SCHEMA),   sort_order: 0, active: 1 },
      { role_code: 'trustee', label: 'Trustee', attrs_schema: JSON.stringify(TRUSTEE_SCHEMA), sort_order: 1, active: 1 },
      { role_code: 'retired', label: 'Retired', attrs_schema: null,                            sort_order: 9, active: 0 },
    ],
    roleRows: [
      { id: 40, contact_id: 210, role: 'trustee',
        attrs: JSON.stringify({ chapter: [12, 13], zoom_link: '' }),
        active: 1, sort_order: 0, created_at: '2026-09-01' },
    ],
    typeUpdates: [], typeInserts: [], rowUpdates: [], rowDeletes: [], rowInserts: [],
  };
  const db = {
    state,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/SELECT role_code, label, attrs_schema, sort_order, active FROM contact_role_types/.test(s)) {
        const all = /WHERE active = 1/.test(s) ? state.types.filter(t => t.active) : state.types;
        return [all];
      }
      if (/^INSERT INTO contact_role_types/.test(s)) {
        if (state.types.some(t => t.role_code === params[0])) {
          const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e;
        }
        state.typeInserts.push(params);
        return [{ insertId: 9 }];
      }
      if (/^UPDATE contact_role_types SET/.test(s)) {
        const code = params[params.length - 1];
        state.typeUpdates.push({ s, params });
        return [{ affectedRows: state.types.some(t => t.role_code === code) ? 1 : 0 }];
      }
      if (/SELECT attrs_schema FROM contact_role_types WHERE role_code/.test(s)) {
        const t = state.types.find(x => x.role_code === params[0]);
        return [t ? [{ attrs_schema: t.attrs_schema }] : []];
      }
      if (/FROM contact_role_types WHERE role_code/.test(s)) {         // assertValidRole
        const t = state.types.find(x => x.role_code === params[0] && x.active);
        return [t ? [{ role_code: t.role_code }] : []];
      }
      if (/SELECT contact_id FROM contacts WHERE contact_id/.test(s)) {
        return [[210, 500].includes(params[0]) ? [{ contact_id: params[0] }] : []];
      }
      if (/SELECT id, contact_id, role, attrs, active, sort_order, created_at FROM contact_roles WHERE id/.test(s)) {
        const r = state.roleRows.find(x => x.id === params[0]);
        return [r ? [{ ...r }] : []];
      }
      if (/SELECT cr\.role, crt\.attrs_schema/.test(s)) {              // updateRole lookup
        const r = state.roleRows.find(x => x.id === params[0]);
        if (!r) return [[]];
        const t = state.types.find(x => x.role_code === r.role);
        return [[{ role: r.role, attrs_schema: t ? t.attrs_schema : null }]];
      }
      if (/SELECT cr\.id, cr\.contact_id, cr\.role, crt\.label/.test(s)) { // listContactRoles
        return [state.roleRows.filter(r => r.contact_id === params[0])
          .map(r => ({ ...r, label: (state.types.find(t => t.role_code === r.role) || {}).label }))];
      }
      if (/^INSERT INTO contact_roles/.test(s)) { state.rowInserts.push(params); return [{ insertId: 41 }]; }
      if (/^UPDATE contact_roles SET/.test(s)) { state.rowUpdates.push({ s, params }); return [{ affectedRows: 1 }]; }
      if (/^DELETE FROM contact_roles/.test(s)) { state.rowDeletes.push(params); return [{ affectedRows: 1 }]; }
      throw new Error('routeDb: unscripted query — ' + s);
    },
  };
  return db;
}

function rolesApp(db) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.db = db; next(); });
  a.use(require('../routes/api.contactRoles.js'));
  return a;
}

function call(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port, path: urlPath, method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('role-type routes', () => {
  test('GET /api/contact-role-types: active only by default, all with include_inactive', async () => {
    const db = routeDb();
    const def = await call(rolesApp(db), 'GET', '/api/contact-role-types');
    expect(def.status).toBe(200);
    expect(def.body.types.map(t => t.role_code)).toEqual(['judge', 'trustee']);
    // attrs_schema arrives PARSED — the settings editor and contact form
    // consume it as an array, never a JSON string.
    expect(Array.isArray(def.body.types[1].attrs_schema)).toBe(true);
    expect(def.body.types[1].attrs_schema[0].options).toEqual([7, 11, 12, 13]);

    const all = await call(rolesApp(db), 'GET', '/api/contact-role-types?include_inactive=true');
    expect(all.body.types.map(t => t.role_code)).toEqual(['judge', 'trustee', 'retired']);
  });

  test('POST creates (201) with a slugged code; a bad slug and a dup are 400', async () => {
    const db = routeDb();
    const ok = await call(rolesApp(db), 'POST', '/api/contact-role-types',
      { role_code: 'mediator', label: 'Mediator' });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ status: 'success', role_code: 'mediator' });
    expect(db.state.typeInserts).toHaveLength(1);

    const bad = await call(rolesApp(db), 'POST', '/api/contact-role-types',
      { role_code: 'Bad Code', label: 'X' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/role_code must be/);

    const dup = await call(rolesApp(db), 'POST', '/api/contact-role-types',
      { role_code: 'judge', label: 'Judge' });
    expect(dup.status).toBe(400);
    expect(dup.body.message).toMatch(/already exists/);
  });

  test('PUT: role_code is IMMUTABLE — a rename attempt is 400 and touches nothing', async () => {
    const db = routeDb();
    const res = await call(rolesApp(db), 'PUT', '/api/contact-role-types/judge',
      { role_code: 'magistrate', label: 'Magistrate' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/role_code is immutable/);
    expect(db.state.typeUpdates).toHaveLength(0);

    // Same-code echo (the settings editor PUTs its row back) is fine.
    const echo = await call(rolesApp(db), 'PUT', '/api/contact-role-types/judge',
      { role_code: 'judge', label: 'Judge!', sort_order: 2, active: 1, attrs_schema: JUDGE_SCHEMA });
    expect(echo.status).toBe(200);
    expect(db.state.typeUpdates).toHaveLength(1);
  });

  test('PUT surfaces the schema validator verbatim (400) and unknown codes as 404', async () => {
    const db = routeDb();
    const bad = await call(rolesApp(db), 'PUT', '/api/contact-role-types/judge',
      { attrs_schema: [{ key: 'x', label: 'X', type: 'select' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/attrs_schema\[0\]\.options is required for select/);

    const miss = await call(rolesApp(db), 'PUT', '/api/contact-role-types/ghost', { label: 'G' });
    expect(miss.status).toBe(404);
    expect(miss.body.message).toMatch(/role type "ghost" not found/);
  });
});

describe('per-contact role-row routes', () => {
  test('route inventory: GET rows (incl. inactive path), POST attach → 201', async () => {
    const db = routeDb();
    const list = await call(rolesApp(db), 'GET', '/api/contacts/210/roles');
    expect(list.status).toBe(200);
    expect(list.body.roles).toHaveLength(1);
    expect(list.body.roles[0]).toMatchObject({ id: 40, role: 'trustee' });
    expect(list.body.roles[0].attrs).toEqual({ chapter: [12, 13], zoom_link: '' }); // parsed

    const attach = await call(rolesApp(db), 'POST', '/api/contacts/500/roles',
      { role: 'trustee', attrs: { chapter: [7], zoom_link: '' } });
    expect(attach.status).toBe(201);
    expect(attach.body.id).toBe(41);
    expect(JSON.parse(db.state.rowInserts[0][2])).toEqual({ chapter: [7], zoom_link: '' });
  });

  test('POST: schema violations come back 400 with the validator message', async () => {
    const db = routeDb();
    const res = await call(rolesApp(db), 'POST', '/api/contacts/500/roles',
      { role: 'trustee', attrs: { chapter: ['7'] } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/wrong type/);
    expect(db.state.rowInserts).toHaveLength(0);
  });

  test('OWNERSHIP: a row belonging to another contact is 404 for PATCH and DELETE — never a cross-contact write', async () => {
    const db = routeDb();
    const patch = await call(rolesApp(db), 'PATCH', '/api/contacts/500/roles/40', { active: 0 });
    expect(patch.status).toBe(404);
    expect(patch.body.message).toBe('Role row not found on this contact');
    const del = await call(rolesApp(db), 'DELETE', '/api/contacts/500/roles/40');
    expect(del.status).toBe(404);
    expect(db.state.rowUpdates).toHaveLength(0);
    expect(db.state.rowDeletes).toHaveLength(0);
  });

  test('PATCH on the owner: attrs are schema-validated; active-only passes through', async () => {
    const db = routeDb();
    const bad = await call(rolesApp(db), 'PATCH', '/api/contacts/210/roles/40',
      { attrs: { chapter: [] } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/attrs\.chapter is required/);

    const ok = await call(rolesApp(db), 'PATCH', '/api/contacts/210/roles/40', { active: 0 });
    expect(ok.status).toBe(200);
    expect(db.state.rowUpdates).toHaveLength(1);
    expect(db.state.rowUpdates[0].s).toMatch(/^UPDATE contact_roles SET active = \?/);
  });

  test('DELETE on the owner: HARD detach via (contact_id, role) — the created-in-error path', async () => {
    const db = routeDb();
    const res = await call(rolesApp(db), 'DELETE', '/api/contacts/210/roles/40');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', removed: 1 });
    expect(db.state.rowDeletes).toHaveLength(1);
    expect(db.state.rowDeletes[0]).toEqual([210, 'trustee']);
  });

  test('non-integer ids are 400/404, never queries', async () => {
    const db = routeDb();
    const res = await call(rolesApp(db), 'PATCH', '/api/contacts/abc/roles/40', { active: 0 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/contact id must be an integer/);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. UI surfaces still parse (the unifiedEventsU9 shell idiom)
// ─────────────────────────────────────────────────────────────

describe('role-forms UI surfaces — inline scripts parse', () => {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const os = require('os');

  function checkInlineScripts(relPath) {
    const html = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const [i, block] of blocks.entries()) {
      const tmp = path.join(os.tmpdir(), `roleforms-${path.basename(relPath)}-${i}.js`);
      fs.writeFileSync(tmp, block);
      try {
        execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
      } catch (e) {
        throw new Error(`${relPath} inline script #${i} failed node --check:\n` +
          String(e.stderr || e.message));
      } finally {
        fs.unlinkSync(tmp);
      }
    }
    return html;
  }

  test('contact-form.html parses and carries the roles section contract', () => {
    const html = checkInlineScripts('public/forms/contact-form.html');
    expect(html).toMatch(/id="rolesSection"/);
    expect(html).toMatch(/applyRolesReadonly\(on\);/);        // view/edit gating wired
    expect(html).toMatch(/f\.options\[\+el\.dataset\.opt\]/); // index → option VALUE (number identity)
    // The section must sit OUTSIDE the form element (dirty-tracking invisibility).
    expect(html.indexOf('id="rolesSection"')).toBeGreaterThan(html.indexOf('</form>'));
  });

  test('settings.html parses and carries the role-type editor contract', () => {
    const html = checkInlineScripts('public/settings.html');
    expect(html).toMatch(/id="contactRolesSection"/);
    expect(html).toMatch(/\/api\/contact-role-types/);        // the TABLE routes, not app_settings
    expect(html).toMatch(/The code is permanent/);
  });

  test('index.html carries the role filter wired to the lazy loader', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
    expect(html).toMatch(/id="tabContactsRole"/);
    expect(html).toMatch(/tabContactsRolesLoad\(\)/);
    expect(html).toMatch(/if \(roleSel && roleSel\.value\) params\.role = roleSel\.value;/);
  });
});
