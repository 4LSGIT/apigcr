// tests/caseyContactRelationsRemove.mysql.test.js
//
/**
 * A6.2 on REAL MySQL, through the REAL routes: the relation END / REACTIVATE /
 * REMOVE and role DEACTIVATE / REACTIVATE / REMOVE cards, and the A6.1 update
 * widened to a type change and an ended relation's end fields — each card's
 * fixed request (lifted from public/assistant.html) sent to
 * routes/api.contactRelations.js / routes/api.contactRoles.js over the real
 * pool, the row read back, the route's answer through the card's own result
 * reader, and the click-time precheck over the real GETs.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a62_test npx jest tests/caseyContactRelationsRemove.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (on a
 * dev machine that is production). This suite DROPS and recreates the tables
 * below, cloned line-by-line from ref/database.sql (a clause referencing a
 * table outside the list is dropped), in its before-hook AND after-hook —
 * with any sibling-built table whose FK points at one of ours — so a shared
 * *_test DB is left with none of them. Give it its own *_test DB anyway: it
 * shares table names (contacts, cases, workflows …) with other twin families.
 *
 * WHAT IS LOCKED
 *   - end / reactivate / remove land as the card said (active, end_date as a
 *     DATE, end_reason; NULL / '' on reactivate; the row gone), and the
 *     route's answer passes the card's result reader; a second delete is the
 *     route's 404, read as "already removed".
 *   - the card refuses a stored status the type no longer allows BECAUSE the
 *     route would: the native PATCH answers 400 on the same row.
 *   - the judge / trustee link shift the card discloses EQUALS what the real
 *     resolvers (lib/caseRoleResolver, the ones updateCase runs) return after
 *     the deactivation / reactivation is really written — the projection's
 *     rewritten predicate runs on this engine.
 *   - the Roles section deletes only an INACTIVE row; the route itself would
 *     delete an active one (no native guard) — the card mirrors the page.
 *   - the stored-definitions scan finds a workflow step naming the table.
 *   - the precheck passes on the real GETs and refuses after a hand edit.
 *   - the widened update: a type change and an ended relation's end fields,
 *     through the real PATCH.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// The auth gate is not under test (tests/caseyActionPermissions.test.js pins it).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
const { normalizeActionDraft } = require('../services/assistantService');
const resolver = require('../lib/caseRoleResolver');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'contacts', 'contact_relation_types', 'contact_relations', 'contact_role_types', 'contact_roles', 'cases',
  // The stored-definitions scan (assistantService CASE_FIELDS_READER_SCANS) and the step tables' parents.
  'report_definitions', 'form_templates', 'portal_cards', 'pipeline_stages', 'pipeline_stage_requirements', 'sequence_steps',
  'sequence_templates', 'workflow_steps', 'workflows', 'email_ingest_rule_actions', 'phone_ingest_rule_actions'];

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
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks for ${tables.length} tables`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

function call(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = body == null ? '' : JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

// The browser half, extracted verbatim from the page (the assistantUi fnSrc idiom).
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
const FNS = ['contactRelationStableJson', 'contactRelationDay', 'contactRelationRequest', 'contactRelationPrecheck',
  'contactRelationLifecycleRequest', 'contactRoleLifecycleRequest', 'contactRelationLifecyclePrecheck', 'contactRoleLifecyclePrecheck',
  'contactRelationLifecycleResult', 'contactRoleLifecycleResult', 'contactLifecycleKnownOutcome'];
function browser(api) {
  return new Function('api', `${FNS.map(fnSrc).join('\n')}\nreturn { ${FNS.join(', ')} };`)(api); // eslint-disable-line no-new-func
}

d('the Casey relation / role lifecycle cards on real MySQL, through the real routes (A6.2)', () => {
  let pool; let app; let b;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

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

  // The browser's api(): the real routes; a non-2xx throws with .status, as P.apiSend does.
  async function api(p, body, method) {
    const res = await call(app, method, p, method === 'GET' ? undefined : body);
    if (res.status >= 400 || res.body.status === 'error') throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
    return res.body;
  }
  // Apply a card the way the shared engine does: precheck, request, route, result reader.
  async function apply(card, family) {
    const pre = await (family === 'role' ? b.contactRoleLifecyclePrecheck(card) : b.contactRelationLifecyclePrecheck(card));
    if (pre) return { refused: pre };
    const r = family === 'role' ? b.contactRoleLifecycleRequest(card) : b.contactRelationLifecycleRequest(card);
    const out = await api(r.path, r.body, r.method);
    return { out, receipt: family === 'role' ? b.contactRoleLifecycleResult(card, out) : b.contactRelationLifecycleResult(card, out) };
  }

  const relEvidence = (id) => [{ id: 'q1', purpose: 'relations', rows: [{ row_type: 'relation', contact_id: '7001', relation_id: String(id) }] }];
  const roleEvidence = (cid, rid) => [{ id: 'q1', purpose: 'relations', rows: [{ row_type: 'role', contact_id: String(cid), role_id: String(rid) }] }];
  const relCard = (kind, id, over = {}) => normalizeActionDraft(pool, { kind, relation_id: id, evidence: [{ query_id: 'q1', row_number: 1 }], ...over }, relEvidence(id));
  const roleCard = (kind, cid, rid) => normalizeActionDraft(pool, { kind, contact_id: cid, role_id: rid, evidence: [{ query_id: 'q1', row_number: 1 }] }, roleEvidence(cid, rid));
  async function relation(fields) {
    const cols = Object.keys(fields);
    const res = await q(`INSERT INTO contact_relations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => fields[c]));
    return res.insertId;
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
      (7001, 'person', 'Dana Client', 'Dana', 'Client'), (7002, 'person', 'Sam Client', 'Sam', 'Client'),
      (7501, 'person', 'Krispen Carroll', 'Krispen', 'Carroll'), (7502, 'person', 'Mark Carroll', 'Mark', 'Carroll'),
      (7601, 'person', 'Hon. Lee Judge', 'Lee', 'Judge'), (7602, 'person', 'Hon. Ann Other', 'Ann', 'Other')`);
    await q(`INSERT INTO contact_relation_types (type_code, forward_label, reverse_label, is_symmetric, allowed_statuses, allowed_end_reasons, sort_order, active) VALUES
      ('spouse', 'Spouse of', 'Spouse of', 1, 'separated', 'divorced,deceased,annulled', 10, 1),
      ('parent_child', 'Parent of', 'Child of', 0, 'step,adopted', 'deceased', 30, 1),
      ('business_partner', 'Business partner of', 'Business partner of', 1, '', '', 60, 1)`);
    await q(`INSERT INTO contact_role_types (role_code, label, attrs_schema, sort_order, active) VALUES
      ('judge', 'Judge', ?, 10, 1), ('trustee', 'Trustee', ?, 20, 1)`, [
      JSON.stringify([{ key: 'judge_3', type: 'text', label: 'Docket suffix (3-letter)', required: true }]),
      JSON.stringify([{ key: 'chapter', type: 'multi_select', label: 'Chapters', options: [7, 11, 12, 13], required: true }])]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.contactRelations'));
    app.use(require('../routes/api.contactRoles'));
    b = browser(api);
    for (const m of ['log', 'warn', 'error', 'debug']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (pool) {
      const conn = await pool.getConnection();
      try { await dropAll(conn); } finally { conn.release(); }
      await pool.end();
    }
  });
  beforeEach(async () => {
    for (const t of ['contact_relations', 'contact_roles', 'cases', 'workflow_steps', 'workflows']) await q(`DELETE FROM ${t}`);
  });

  test('END lands as the card said, through the route; the precheck passes on the real GET and refuses after a hand edit', async () => {
    const id = await relation({ contact_a_id: 7001, contact_b_id: 7002, type_code: 'spouse', status: '', start_date: '2010-06-12', notes: 'n' });
    const card = await relCard('contact.relation.end.v1', id, { end_date: '2026-11-01', end_reason: 'divorced' });
    expect(card.changes).toEqual({ active: 0, end_date: '2026-11-01', end_reason: 'divorced' });
    // A hand edit between prepare and click: refused before any write.
    await q('UPDATE contact_relations SET notes = ? WHERE id = ?', ['edited', id]);
    expect((await apply(card)).refused).toMatch(/was edited, ended or reactivated since this card was prepared/);
    await q('UPDATE contact_relations SET notes = ?, updated_at = ? WHERE id = ?', ['n', new Date(card.expected.updated_at), id]);
    const { receipt } = await apply(card);
    expect(receipt).toEqual({ relation_id: id });
    const [row] = await q('SELECT active, end_date, end_reason, status, notes FROM contact_relations WHERE id = ?', [id]);
    expect(row).toEqual({ active: 0, end_date: new Date('2026-11-01T00:00:00Z'), end_reason: 'divorced', status: '', notes: 'n' });
    // The applied card's own state is gone: a second click is refused before any write.
    expect((await apply(card)).refused).toMatch(/was edited, ended or reactivated/);
  });

  test('REACTIVATE clears the end fields; another ACTIVE relation of the type between the pair is refused by the card', async () => {
    const id = await relation({ contact_a_id: 7001, contact_b_id: 7002, type_code: 'spouse', active: 0, end_date: '2024-03-01', end_reason: 'divorced' });
    const card = await relCard('contact.relation.reactivate.v1', id);
    expect(card.current).toMatchObject({ active: 0, end_date: '2024-03-01', end_reason: 'divorced' });
    expect(await apply(card)).toEqual({ out: expect.objectContaining({ status: 'success' }), receipt: { relation_id: id } });
    expect(await q('SELECT active, end_date, end_reason FROM contact_relations WHERE id = ?', [id])).toEqual([{ active: 1, end_date: null, end_reason: '' }]);
    // A one-way type, ended A→B, with B→A active: the route would happily reactivate both directions.
    const ended = await relation({ contact_a_id: 7001, contact_b_id: 7002, type_code: 'parent_child', active: 0, end_date: '2020-01-01' });
    const live = await relation({ contact_a_id: 7002, contact_b_id: 7001, type_code: 'parent_child' });
    await expect(relCard('contact.relation.reactivate.v1', ended)).rejects.toThrow(`already have an ACTIVE parent_child relation (#${live}) — reactivating relation #${ended} would record it twice`);
    const native = await call(app, 'PATCH', `/api/contact-relations/${ended}`, { active: 1, end_date: null, end_reason: '' });
    expect(native.status).toBe(200);
  });

  test('a stored status the type no longer allows: the card refuses because the native PATCH does', async () => {
    const id = await relation({ contact_a_id: 7001, contact_b_id: 7002, type_code: 'spouse', status: 'engaged' });
    await expect(relCard('contact.relation.end.v1', id, { end_reason: 'divorced' })).rejects.toThrow(/stored status "engaged" is not allowed for spouse/);
    const native = await call(app, 'PATCH', `/api/contact-relations/${id}`, { active: 0, end_date: '2026-11-01', end_reason: 'divorced' });
    expect(native).toEqual({ status: 400, body: { status: 'error', message: 'status "engaged" is not allowed for this type (allowed: separated)' } });
  });

  test('REMOVE deletes the row; a second delete is the route\'s 404, read as "already removed"', async () => {
    const id = await relation({ contact_a_id: 7001, contact_b_id: 7002, type_code: 'spouse' });
    const card = await relCard('contact.relation.remove.v1', id);
    expect(card.warnings[0]).toMatch(/^NO UNDO: relation #\d+ is DELETED .* It is ACTIVE: ENDING it/);
    expect((await apply(card)).receipt).toEqual({ relation_id: id });
    expect(await q('SELECT id FROM contact_relations WHERE id = ?', [id])).toEqual([]);
    let err;
    try { await api(`/api/contact-relations/${id}`, null, 'DELETE'); } catch (e) { err = e; }
    expect(err.status).toBe(404);
    expect(b.contactLifecycleKnownOutcome(err)).toMatchObject({ status: 'Refused — nothing written' });
  });

  test('the stored-definitions scan finds a live workflow step naming contact_relations', async () => {
    await q(`INSERT INTO workflows (id, name, active, current_version, draft_version) VALUES (9, 'Relations mailer', 1, 2, 3)`);
    await q(`INSERT INTO workflow_steps (id, workflow_id, version, step_number, type, label, config) VALUES
      (91, 9, 2, 1, 'internal_function', 'read rels', ?), (92, 9, 1, 1, 'internal_function', 'old', ?)`,
    [JSON.stringify({ function_name: 'db', params: { sql: 'SELECT * FROM contact_relations' } }), JSON.stringify({ params: { sql: 'contact_relations' } })]);
    const id = await relation({ contact_a_id: 7001, contact_b_id: 7002, type_code: 'spouse' });
    const card = await relCard('contact.relation.end.v1', id);
    expect(card.warnings).toEqual(['STORED READERS: Workflow step #91 "workflow #9 v2 step 1 "read rels"" names contact_relations — what it reads changes; check before applying.']);
  });

  test('the widened update through the real PATCH: a type change, then an ended relation\'s end fields', async () => {
    const id = await relation({ contact_a_id: 7001, contact_b_id: 7002, type_code: 'spouse', status: 'separated' });
    await expect(relCard('contact.relation.update.v1', id, { changes: { type_code: 'business_partner' } })).rejects.toThrow(/a type change must set status too/);
    const typeCard = await relCard('contact.relation.update.v1', id, { changes: { type_code: 'business_partner', status: '' } });
    const r = b.contactRelationRequest(typeCard);
    expect(r.body).toEqual({ type_code: 'business_partner', status: '' });
    expect(await b.contactRelationPrecheck(typeCard)).toBe('');
    await api(r.path, r.body, r.method);
    expect(await q('SELECT type_code, status FROM contact_relations WHERE id = ?', [id])).toEqual([{ type_code: 'business_partner', status: '' }]);
    const ended = await relation({ contact_a_id: 7001, contact_b_id: 7002, type_code: 'parent_child', active: 0, end_date: '2024-03-01', end_reason: '' });
    const endCard = await relCard('contact.relation.update.v1', ended, { changes: { end_date: '2024-04-02', end_reason: 'deceased' } });
    expect(await b.contactRelationPrecheck(endCard)).toBe('');
    const r2 = b.contactRelationRequest(endCard);
    await api(r2.path, r2.body, r2.method);
    expect(await q('SELECT active, end_date, end_reason FROM contact_relations WHERE id = ?', [ended])).toEqual([{ active: 0, end_date: new Date('2024-04-02T00:00:00Z'), end_reason: 'deceased' }]);
  });

  // ── roles ──
  async function seedRoles() {
    await q(`INSERT INTO contact_roles (id, contact_id, role, attrs, active) VALUES
      (31, 7501, 'trustee', '{"chapter":[13]}', 1), (32, 7502, 'trustee', '{"chapter":[13]}', 1),
      (41, 7601, 'judge', '{"judge_3":"mar"}', 1), (42, 7602, 'judge', '{"judge_3":"abc"}', 1)`);
    await q(`INSERT INTO cases (case_id, case_number_full, case_judge, case_judge_contact_id, case_trustee, case_trustee_contact_id, case_chapter) VALUES
      ('T1', '25-1', '', NULL, 'Carroll', NULL, '13'), ('T2', '25-2', '', NULL, 'Mark Carroll', 7502, '13'), ('T3', '25-3', '', NULL, 'Someone Else', NULL, '7'),
      ('J1', '25-40001-mar', '', 7601, '', NULL, '13'), ('J2', '25-40002', 'Lee Judge', 7601, '', NULL, '13'),
      ('J3', '25-40003-abc', '', 7602, '', NULL, '13'), ('J4', '25-40004-MAR', 'Somebody', NULL, '', NULL, '13'),
      ('J5', '25-40005', 'LEE JUDGE', NULL, '', NULL, '13')`); // reached ONLY through the judge-text term (no suffix, no stored link)
  }
  // What the real resolvers say for every case right now (the ones updateCase runs).
  async function resolveAll(code) {
    const out = {};
    for (const k of await q('SELECT case_id, case_number_full, case_judge, case_trustee, case_chapter FROM cases ORDER BY case_id')) {
      out[k.case_id] = code === 'judge'
        ? await resolver.resolveJudge(pool, { case_number_full: k.case_number_full, case_judge: k.case_judge })
        : await resolver.resolveTrustee(pool, { case_trustee: k.case_trustee, case_chapter: k.case_chapter });
    }
    return out;
  }
  const diff = (a, c) => Object.keys(a).filter((k) => a[k] !== c[k]).sort();
  const shiftIds = (card) => (card.warnings.find((w) => /LINKS:/.test(w)) || '').match(/case (\w+):/g) || [];

  test('DEACTIVATE a trustee and a judge: the shift the card discloses equals the real resolvers after the real write', async () => {
    await seedRoles();
    for (const [cid, rid, code, n] of [[7502, 32, 'trustee', 2], [7601, 41, 'judge', 4]]) {
      const before = await resolveAll(code);
      const card = await roleCard('contact.role.deactivate.v1', cid, rid);
      expect(await apply(card, 'role')).toEqual({ out: { status: 'success', id: rid }, receipt: { role_id: rid } });
      expect(await q('SELECT active FROM contact_roles WHERE id = ?', [rid])).toEqual([{ active: 0 }]);
      const changed = diff(before, await resolveAll(code));
      expect(changed).toHaveLength(n);
      expect(card.warnings[0]).toMatch(new RegExp(`^${code.toUpperCase()} LINKS: ${n} case\\(s\\)`));
      expect(shiftIds(card).map((s) => s.slice(5, -1)).sort()).toEqual(changed);
    }
  });

  test('REACTIVATE: the disclosed shift equals the resolvers after the write; the precheck refuses after a hand edit', async () => {
    await seedRoles();
    await q("UPDATE contact_roles SET active = 0, attrs = '{\"judge_3\":\"abc\"}' WHERE id = 41");
    const before = await resolveAll('judge');
    const card = await roleCard('contact.role.reactivate.v1', 7601, 41);
    expect(card.warnings).toContain('AMBIGUOUS SUFFIX: Hon. Ann Other (#7602) already carries judge suffix "abc" — docket resolution for it falls back to the judge\'s name.');
    await q("UPDATE contact_roles SET attrs = '{\"judge_3\":\"xyz\"}' WHERE id = 41");
    expect((await apply(card, 'role')).refused).toBe('Role row #41 was edited since this card was prepared. Nothing was written. Ask Casey to prepare it again.');
    await q("UPDATE contact_roles SET attrs = '{\"judge_3\":\"abc\"}' WHERE id = 41");
    expect((await apply(card, 'role')).receipt).toEqual({ role_id: 41 });
    const changed = diff(before, await resolveAll('judge'));
    expect(changed).toEqual(['J2', 'J3', 'J5']);
    expect(shiftIds(card).map((s) => s.slice(5, -1)).sort()).toEqual(changed);
  });

  test('REMOVE: the card refuses an ACTIVE row (the Roles section offers Delete only on inactive rows) though the route would delete it', async () => {
    await seedRoles();
    await expect(roleCard('contact.role.remove.v1', 7502, 32)).rejects.toThrow(/is ACTIVE — the Roles section deletes only an INACTIVE row/);
    // No native guard: the route deletes an active row outright.
    expect(await call(app, 'DELETE', '/api/contacts/7602/roles/42')).toEqual({ status: 200, body: { status: 'success', removed: 1 } });
    await q('UPDATE contact_roles SET active = 0 WHERE id = 32');
    const card = await roleCard('contact.role.remove.v1', 7502, 32);
    expect((await apply(card, 'role')).receipt).toEqual({ role_id: 32 });
    expect(await q('SELECT id FROM contact_roles WHERE id = 32')).toEqual([]);
    let err;
    try { await api('/api/contacts/7502/roles/32', null, 'DELETE'); } catch (e) { err = e; }
    expect([err.status, err.message]).toEqual([404, 'Role row not found on this contact']);
    expect(b.contactLifecycleKnownOutcome(err)).toMatchObject({ status: 'Refused — nothing written' });
  });
});
