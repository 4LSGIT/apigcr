// tests/caseyContactRelations.mysql.test.js
//
/**
 * A6 on REAL MySQL: every SQL predicate the Casey relation/role normalizer
 * adds, the services it reads through, and the contact.relations read kind —
 * over rows mysql2 really returns (DATE / TIMESTAMP as Date, JSON re-ordered
 * on write, utf8mb4_general_ci comparisons).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a6_test npx jest tests/caseyContactRelations.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql (live types,
 * keys, the chk_no_self CHECK, FKs — a clause referencing a table outside the
 * list is dropped). Drops run with FOREIGN_KEY_CHECKS off, in the before-hook
 * AND the after-hook, and take with them any sibling-built table whose FK
 * points at one of ours (contact_phones / contact_emails … → contacts): a
 * shared *_test DB is left with none of this suite's tables, so no sibling's
 * FK-checked DROP of contacts trips on a child this suite left behind (the
 * caseySequenceEnroll.mysql hygiene).
 *
 * WHAT IS LOCKED
 *   - The registry lookups are case-insensitive (general_ci) and the card
 *     carries the registry's own spelling; the live-code list is in sort order.
 *   - The duplicate predicate finds the pair in EITHER direction, only for that
 *     type, active or not — and agrees with the native createRelation's own
 *     UNIQUE key on what a second create would hit.
 *   - The relation update reads DATE / TIMESTAMP back as the card's strings.
 *   - The held-role predicate is case-insensitive like the route's UNIQUE key.
 *   - The judge-suffix ambiguity predicate (JSON_EXTRACT over attrs) flags only
 *     ANOTHER ACTIVE judge with the same suffix, case-insensitively.
 *   - A role update's no-change check survives MySQL's JSON key re-ordering.
 *   - The contact.relations projection over real rows, both perspectives.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const { normalizeActionDraft, contactRelationsRead } = require('../services/assistantService');
const relSvc = require('../services/contactRelationService');
const roleSvc = require('../services/contactRoleService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
// users: getRelation (the route's own read) LEFT JOINs it for created_by_name.
const TABLES = ['users', 'contacts', 'contact_relation_types', 'contact_relations', 'contact_role_types', 'contact_roles'];

function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [];
  const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

d('the Casey relation/role cards on real MySQL (A6)', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const EVIDENCE = [
    { id: 'q1', purpose: 'contacts', rows: [{ contact_id: 3001 }, { contact_id: 3002 }, { contact_id: 3003 }, { contact_id: 3004 }, { contact_id: 3005 }, { contact_id: 3006 }] },
  ];
  const ev = (...rows) => rows.map((n) => ({ query_id: 'q1', row_number: n }));

  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set(children.map((r) => r.t)), ...[...TABLES].reverse()]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const conn = await pool.getConnection();
    try {
      await dropAll(conn);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const { creates, alters } = schemaFor(TABLES);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { conn.release(); }
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (3001, 'person', 'Dana Client', 'Dana', 'Client'), (3002, 'person', 'Sam Client', 'Sam', 'Client'),
      (3003, 'org', 'Acme Corp', '', ''), (3004, 'person', 'Hon. Lee', 'Lee', 'Judge'), (3005, 'person', 'Hon. Other', 'O', 'J'),
      (3006, 'person', 'Hon. Retired', 'R', 'J')`);
    // A slice of the live registry (read 2026-10-28), plus a retired type.
    await q(`INSERT INTO contact_relation_types (type_code, forward_label, reverse_label, is_symmetric, allowed_statuses, allowed_end_reasons, sort_order, active) VALUES
      ('spouse', 'Spouse of', 'Spouse of', 1, 'separated', 'divorced,deceased,annulled', 10, 1),
      ('parent_child', 'Parent of', 'Child of', 0, 'step,adopted,foster,estranged', 'deceased', 30, 1),
      ('employer_employee', 'Employer of', 'Employee of', 0, 'part_time,contractor', 'terminated,resigned,retired,laid_off', 50, 1),
      ('zz_old', 'Old of', 'Old by', 0, '', '', 5, 0)`);
    await q(`INSERT INTO contact_role_types (role_code, label, attrs_schema, sort_order, active) VALUES
      ('judge', 'Judge', ?, 10, 1), ('trustee', 'Trustee', ?, 20, 1)`, [
      JSON.stringify([{ key: 'judge_3', type: 'text', label: 'Docket suffix (3-letter)', required: true }]),
      JSON.stringify([{ key: 'chapter', type: 'multi_select', label: 'Chapters', options: [7, 11, 12, 13], required: true },
        { key: 'zoom_link', type: 'url', label: '341 Zoom link', required: false }])]);
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (pool) {
      const conn = await pool.getConnection();
      try { await dropAll(conn); } finally { conn.release(); }
      await pool.end();
    }
  });

  test('registry lookups are case-insensitive, carry the registry spelling, and list live codes in sort order', async () => {
    const out = await normalizeActionDraft(pool, { kind: 'contact.relation.create.v1', contact_a_id: 3001, contact_b_id: 3002,
      type_code: 'PARENT_CHILD', status: 'adopted', start_date: '2015-01-02', evidence: ev(1, 2) }, EVIDENCE);
    expect(out.relation).toMatchObject({ type_code: 'parent_child', forward_label: 'Parent of', reverse_label: 'Child of', is_symmetric: false,
      contact_a: { contact_id: 3001, contact_name: 'Dana Client', contact_kind: 'person' } });
    await expect(normalizeActionDraft(pool, { kind: 'contact.relation.create.v1', contact_a_id: 3001, contact_b_id: 3002, type_code: 'cousin', evidence: ev(1, 2) }, EVIDENCE))
      .rejects.toThrow('use one of: spouse ("Spouse of"), parent_child ("Parent of"), employer_employee ("Employer of")');
    await expect(normalizeActionDraft(pool, { kind: 'contact.relation.create.v1', contact_a_id: 3001, contact_b_id: 3002, type_code: 'zz_old', evidence: ev(1, 2) }, EVIDENCE))
      .rejects.toThrow(/"zz_old" is retired/);
  });

  test('the duplicate predicate: either direction, this type only, active or not — and the native create agrees', async () => {
    const create = (a, b, type) => normalizeActionDraft(pool, { kind: 'contact.relation.create.v1', contact_a_id: a, contact_b_id: b, type_code: type,
      evidence: ev(a - 3000, b - 3000) }, EVIDENCE);
    // The reviewed card's own values through the route's service.
    const card = await create(3001, 3002, 'parent_child');
    const stored = await relSvc.createRelation(pool, { contact_a_id: card.relation.contact_a.contact_id, contact_b_id: card.relation.contact_b.contact_id,
      type_code: card.relation.type_code, status: '', start_date: null, notes: '' }, { createdBy: 6 });
    const id = stored.relation.id;
    await expect(create(3001, 3002, 'parent_child')).rejects.toThrow(`Dana Client and Sam Client already have a parent_child relation (#${id}). Nothing is proposed.`);
    // Asked: Sam "Parent of" Dana; stored: Dana "Parent of" Sam.
    await expect(create(3002, 3001, 'parent_child')).rejects.toThrow(`Dana Client is already recorded as "Parent of Sam Client" (relation #${id}) — the reverse of what was asked`);
    // The native service stores that reverse (no key covers it) — the card is stricter on purpose.
    await expect(create(3001, 3002, 'spouse')).resolves.toBeTruthy();
    await expect(create(3001, 3003, 'parent_child')).resolves.toBeTruthy();
    // The route's UNIQUE key refuses the exact duplicate the predicate named.
    await expect(relSvc.createRelation(pool, { contact_a_id: 3001, contact_b_id: 3002, type_code: 'parent_child' })).rejects.toThrow(/already exists/);
    await q('UPDATE contact_relations SET active = 0 WHERE id = ?', [id]);
    await expect(create(3002, 3001, 'parent_child')).rejects.toThrow(/It is INACTIVE/);
  });

  test('relation update over a real row: DATE and TIMESTAMP come back as the card strings', async () => {
    const { relation } = await relSvc.createRelation(pool, { contact_a_id: 3001, contact_b_id: 3003, type_code: 'employer_employee',
      status: 'part_time', start_date: '2010-06-12', notes: 'warehouse' });
    const [[row]] = await pool.query('SELECT updated_at FROM contact_relations WHERE id = ?', [relation.id]);
    const evidence = [{ id: 'q2', purpose: 'relations', rows: [{ row_type: 'relation', contact_id: '3001', relation_id: String(relation.id) }] }];
    const out = await normalizeActionDraft(pool, { kind: 'contact.relation.update.v1', relation_id: relation.id,
      changes: { status: 'contractor', notes: 'warehouse' }, evidence: [{ query_id: 'q2', row_number: 1 }] }, evidence);
    expect(out).toMatchObject({
      current: { status: 'part_time', start_date: '2010-06-12', notes: 'warehouse' }, changes: { status: 'contractor' },
      expected: { updated_at: row.updated_at.toISOString() },
      relation: { contact_a: { contact_id: 3001, contact_name: 'Dana Client', contact_kind: 'person' }, contact_b: { contact_id: 3003, contact_name: 'Acme Corp', contact_kind: 'org' } },
    });
    await expect(normalizeActionDraft(pool, { kind: 'contact.relation.update.v1', relation_id: relation.id,
      changes: { start_date: '2010-06-12' }, evidence: [{ query_id: 'q2', row_number: 1 }] }, evidence)).rejects.toThrow(/does not change any value/);
  });

  test('the held-role predicate is case-insensitive; the judge-suffix ambiguity flags only ANOTHER ACTIVE judge', async () => {
    await roleSvc.attachRole(pool, { contact_id: 3005, role: 'judge', attrs: { judge_3: 'AbC' } });
    await roleSvc.attachRole(pool, { contact_id: 3006, role: 'judge', attrs: { judge_3: 'xyz' }, active: 0 });
    const judge = (contactId, suffix) => normalizeActionDraft(pool, { kind: 'contact.role.create.v1', contact_id: contactId, role: 'Judge',
      attrs: { judge_3: suffix }, evidence: ev(contactId - 3000) }, EVIDENCE);
    const flagged = await judge(3004, 'abc');
    expect(flagged.role.role_code).toBe('judge');
    expect(flagged.effects).toContain('AMBIGUOUS SUFFIX: Hon. Other (#3005) already carries judge suffix "abc" — docket resolution for it falls back to the judge\'s name.');
    const inactiveOnly = await judge(3004, 'XYZ');
    expect(inactiveOnly.effects.some((e) => /^AMBIGUOUS/.test(e))).toBe(false);
    // Contact 3005 itself: its own row is not "another judge" — but it already holds the role.
    await expect(judge(3005, 'abc')).rejects.toThrow(/Hon\. Other already holds the judge role \(role row #\d+\)/);
    await expect(judge(3006, 'xyz')).rejects.toThrow(/Hon\. Retired has an INACTIVE judge role row/);
  });

  test("a role update's no-change check survives MySQL's JSON key re-ordering", async () => {
    const { id } = await roleSvc.attachRole(pool, { contact_id: 3001, role: 'trustee', attrs: { zoom_link: 'https://zoom.us/j/1', chapter: [7, 13] } });
    const evidence = [{ id: 'q2', purpose: 'relations', rows: [{ row_type: 'role', contact_id: '3001', role_id: String(id) }] }];
    const update = (attrs) => normalizeActionDraft(pool, { kind: 'contact.role.update.v1', contact_id: 3001, role_id: id, attrs,
      evidence: [{ query_id: 'q2', row_number: 1 }] }, evidence);
    await expect(update({ zoom_link: 'https://zoom.us/j/1', chapter: [7, 13] })).rejects.toThrow(/does not change role row/);
    await expect(update({ chapter: [7, 13], zoom_link: 'https://zoom.us/j/1' })).rejects.toThrow(/does not change role row/);
    const out = await update({ chapter: [13] });
    expect(out).toMatchObject({ current_attrs: { chapter: [7, 13], zoom_link: 'https://zoom.us/j/1' }, dropped_keys: ['zoom_link'] });
  });

  test('the contact.relations read over real rows: both perspectives, dates, roles and the active registries', async () => {
    const out = await contactRelationsRead(pool, 3003);
    const rel = out.rows.filter((r) => r.row_type === 'relation');
    // Acme (3003) is contact_b of the employer row; read from ITS perspective.
    expect(rel.map((r) => r.reads)).toEqual(['Dana Client: Employer of Acme Corp']);
    const employer = rel.find((r) => r.type_code === 'employer_employee');
    expect(employer).toMatchObject({ contact_id: 3003, contact_a_id: 3001, contact_a_name: 'Dana Client', contact_b_id: 3003, contact_b_name: 'Acme Corp',
      reads_reverse: 'Acme Corp: Employee of Dana Client', start_date: '2010-06-12', status: 'part_time', active: 1 });
    expect(employer.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(out.rows.filter((r) => r.row_type === 'relation_type').map((r) => r.type_code)).toEqual(['spouse', 'parent_child', 'employer_employee']);
    expect(out.rows.filter((r) => r.row_type === 'role_type').map((r) => r.role_code)).toEqual(['judge', 'trustee']);
    // Sam (3002) is contact_b of the (inactive) parent_child row; Dana is A of both.
    const sam = await contactRelationsRead(pool, 3002);
    expect(sam.rows.filter((r) => r.row_type === 'relation')).toEqual([expect.objectContaining({ contact_id: 3002, type_code: 'parent_child',
      contact_a_name: 'Dana Client', contact_b_name: 'Sam Client', reads: 'Dana Client: Parent of Sam Client', reads_reverse: 'Sam Client: Child of Dana Client', active: 0 })]);
    const dana = await contactRelationsRead(pool, 3001);
    // Active rows first (the service's own order).
    expect(dana.rows.filter((r) => r.row_type === 'relation').map((r) => [r.type_code, r.active])).toEqual([['employer_employee', 1], ['parent_child', 0]]);
    expect(dana.rows.find((r) => r.row_type === 'role')).toMatchObject({ role: 'trustee', role_label: 'Trustee', active: 1 });
    expect(JSON.parse(dana.rows.find((r) => r.row_type === 'role').attrs)).toEqual({ chapter: [7, 13], zoom_link: 'https://zoom.us/j/1' });
    await expect(contactRelationsRead(pool, 9999)).resolves.toEqual({ rows: [{ row_type: 'not_found', contact_id: 9999, note: 'Contact 9999 does not exist' }], truncated: false });
  });
});
