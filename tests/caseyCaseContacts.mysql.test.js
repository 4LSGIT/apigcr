// tests/caseyCaseContacts.mysql.test.js
//
/**
 * A8 on REAL MySQL: the SQL the Casey case-contact normalizer adds (the
 * contact's portal flag), the services it reads through (caseService.getCase,
 * caseService.getCaseContacts) over rows mysql2 really returns, and the
 * native routes' behaviour the normalizer's refusals and the browser's
 * outcome mapping rest on — the case_relate UNIQUE key and its two triggers,
 * under the production sql_mode.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a8_test npx jest tests/caseyCaseContacts.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * cases, contacts and case_relate in it, cloned from ref/database.sql (live
 * types, keys, the two case_relate triggers; a clause referencing a table
 * outside the list is dropped). Drops run with FOREIGN_KEY_CHECKS off in the
 * before-hook AND the after-hook and take any sibling-built child of ours
 * with them (the caseyContactRelations.mysql hygiene).
 *
 * WHAT IS LOCKED
 *   - getCaseContacts' portal_used: EXISTS over portal_access_log, mysql2
 *     returns it as the NUMBER 1 / 0 — 1 for a contact with a login row AND
 *     for one with only a pin_sent row (pin-only use counts on purpose), 0 for
 *     one with none. A portal user's demotion / removal is refused even with
 *     portal_enabled 0; a never-used contact's is allowed with the danger
 *     warning (none once portal_enabled is 0, which is DEFAULT 1).
 *   - The case lookup is case-insensitive (general_ci); the card carries the
 *     stored id, and getCaseContacts reads the membership set in order.
 *   - The native routes (routes/api.cases.js, real handlers, real pool):
 *       POST of an existing (case, contact, type) → 409 "already linked",
 *         nothing written (the browser's refusal mapping);
 *       POST of the same pair with ANOTHER type → a second row (why the
 *         normalizer refuses an add for a pair already on the case);
 *       PATCH of a two-row pair → 500, both rows unchanged; DELETE of it →
 *         both rows gone (why two-row pairs are refused);
 *       PATCH of the current type → 500 (the update trigger sees the row
 *         itself); PATCH of a non-enum type → stored as '' (the route
 *         validates nothing; the builder sends the four types only);
 *       a DELETE / PATCH of a row already gone → 404 "Relationship not found"
 *         (the "already removed" refusal);
 *       POST with a case id over 8 characters → stored truncated (why the add
 *         refuses one);
 *       POST / DELETE emit case.contact_linked / _unlinked; PATCH emits none.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// The route's dependencies that are NOT under test: the auth gate (pinned in
// tests/caseyActionPermissions.test.js) and the fire-and-forget event bus,
// observed instead of run.
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ emit: jest.fn() }));
const domainEvents = require('../lib/domainEvents');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'portal_access_log'];

function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = []; const alters = []; const triggers = [];
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
      } else if (t === 'case_relate' && new RegExp(`^CREATE TRIGGER \`[a-z_]+\` .* ON \`${t}\` FOR EACH ROW`).test(lines[i])) {
        // DELIMITER $$ … END / $$: the driver takes the body as ONE statement.
        // Only case_relate's two: the cases / contacts triggers write tables
        // outside this suite and are not what A8 reads.
        const buf = [];
        for (; i < lines.length; i++) { if (lines[i] === '$$') break; buf.push(lines[i]); }
        triggers.push(buf.join('\n'));
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters, triggers };
}

function call(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
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

d('the Casey case-contact cards on real MySQL (A8)', () => {
  let pool; let app;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const CASE = 'A8CASE01';
  const CASE2 = 'A8CASE02';

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

  async function seed() {
    await q('DELETE FROM case_relate');
    await q('DELETE FROM portal_access_log');
    await q('DELETE FROM contacts');
    await q('DELETE FROM cases');
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type) VALUES (?, '25-40001', '25-40001-abc', 'Chapter 13')`, [CASE]);
    // 4001 and 4002 take portal_enabled's DEFAULT; 4003 is explicitly off.
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (4001, 'person', 'Dana Debtor', 'Dana', 'Debtor'), (4002, 'person', 'Sam Spouse', 'Sam', 'Spouse'), (4004, 'person', 'Nora New', 'Nora', 'New')`);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname, portal_enabled) VALUES
      (4003, 'person', 'Wendy Witness', 'Wendy', 'Witness', 0)`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (701, ?, 4001, 'Primary'), (702, ?, 4002, 'Secondary'), (703, ?, 4003, 'Other')`, [CASE, CASE, CASE]);
    // CASE2: three Secondaries' worth of portal use — Sam (4002) has a LOGIN
    // row, Pat (4005) only a pin_sent row, Nev (4006) none.
    await q(`INSERT INTO cases (case_id, case_number, case_type) VALUES (?, '25-40003', 'Chapter 7')`, [CASE2]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (4005, 'person', 'Pat Pinonly', 'Pat', 'Pinonly'), (4006, 'person', 'Nev Never', 'Nev', 'Never')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (711, ?, 4004, 'Primary'), (712, ?, 4002, 'Secondary'), (713, ?, 4005, 'Secondary'), (714, ?, 4006, 'Secondary')`, [CASE2, CASE2, CASE2, CASE2]);
    await q(`INSERT INTO portal_access_log (contact_id, route, method, status, event) VALUES
      (4002, '/portal/auth/verify', 'POST', 200, 'login'), (4002, '/portal/home', 'GET', 200, NULL), (4005, '/portal/auth/request', 'POST', 200, 'pin_sent'),
      (NULL, '/portal/auth/request', 'POST', 200, 'pin_no_match')`);
  }
  const rows = () => q('SELECT case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type FROM case_relate WHERE case_relate_case_id = ? ORDER BY case_relate_id', [CASE]);
  const ev = [{ id: 'q1', rows: [{ case_relate_id: 701 }, { case_relate_id: 702 }, { case_relate_id: 703 }, { case_id: CASE, contact_id: 4004 }] }];
  const cite = (n) => [{ query_id: 'q1', row_number: n }];

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
      const { creates, alters, triggers } = schemaFor(TABLES);
      expect(triggers).toHaveLength(2);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      for (const sql of triggers) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { conn.release(); }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.cases'));
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => { await seed(); domainEvents.emit.mockClear(); });

  test('getCaseContacts carries portal_used as the number 1/0: a login row and a pin-only row are use, no row is not', async () => {
    const listed = await require('../services/caseService').getCaseContacts(pool, CASE2);
    expect(listed.map((r) => [r.contact_id, r.relate_type, r.relate_id, r.portal_used])).toEqual([
      [4004, 'Primary', 711, 0], [4006, 'Secondary', 714, 0], [4005, 'Secondary', 713, 1], [4002, 'Secondary', 712, 1]]);
    expect(Object.keys(listed[0]).sort()).toEqual(['contact_email', 'contact_id', 'contact_name', 'contact_phone', 'portal_used', 'relate_id', 'relate_type']);
  });

  test('a PORTAL USER (login row, or pin-only) is refused even with access off; a never-used contact is allowed with the warning', async () => {
    const ev2 = [{ id: 'q1', rows: [{ case_relate_id: 712 }, { case_relate_id: 713 }, { case_relate_id: 714 }] }];
    const card = (contactId, n, kind = 'case.contact.update.v1') => normalizeActionDraft(pool,
      { kind, case_id: CASE2, contact_id: contactId, ...(kind === 'case.contact.update.v1' ? { relate_type: 'Other' } : {}), evidence: cite(n) }, ev2);
    await expect(card(4002, 1)).rejects.toThrow(/^PORTAL: Sam Spouse has client-portal access and is Secondary on case 25-40003/);
    await expect(card(4002, 1, 'case.contact.remove.v1')).rejects.toThrow(/^PORTAL: Sam Spouse .* removing them/);
    await expect(card(4005, 2)).rejects.toThrow(/^PORTAL: Pat Pinonly has client-portal access/);
    await q('UPDATE contacts SET portal_enabled = 0 WHERE contact_id IN (4002, 4005)');
    await expect(card(4002, 1)).rejects.toThrow(/^PORTAL: Sam Spouse has used the client portal \(its access is off now\)/);
    const [{ portal_enabled: def }] = await q('SELECT portal_enabled FROM contacts WHERE contact_id = 4006');
    expect(def).toBe(1);
    const out = await card(4006, 3);
    expect(out.contact).toEqual({ contact_id: 4006, contact_name: 'Nev Never', contact_kind: 'person', portal_enabled: 1, portal_used: false });
    expect(out.warnings).toEqual(['CLIENT PORTAL: once the portal is live, Nev Never loses portal visibility of this case (only Primary and Secondary see a case). Nev Never has never used the client portal, so Casey allows it.']);
    expect(out.expected).toEqual({ members: [
      { relate_id: 711, contact_id: 4004, relate_type: 'Primary' }, { relate_id: 712, contact_id: 4002, relate_type: 'Secondary' },
      { relate_id: 713, contact_id: 4005, relate_type: 'Secondary' }, { relate_id: 714, contact_id: 4006, relate_type: 'Secondary' }],
    portal_enabled: 1, portal_used: false });
    await q('UPDATE contacts SET portal_enabled = 0 WHERE contact_id = 4006');
    const off = await card(4006, 3, 'case.contact.remove.v1');
    expect([off.warnings, off.expected.portal_enabled, off.expected.portal_used]).toEqual([[], 0, false]);
  });

  test('the case is found case-insensitively and the card carries the stored id; an add reads the real set', async () => {
    const out = await normalizeActionDraft(pool, { kind: 'case.contact.add.v1', case_id: CASE.toLowerCase(), contact_id: 4004, relate_type: 'Bystander',
      evidence: cite(4) }, [{ id: 'q1', rows: [...ev[0].rows.slice(0, 3), { case_id: CASE.toLowerCase(), contact_id: 4004 }] }]);
    expect(out.case).toEqual({ case_id: CASE, case_number: '25-40001-abc', case_type: 'Chapter 13' });
    expect(out.contact.portal_enabled).toBe(1);
    expect(out.members_after.map((m) => `${m.contact_id}:${m.relate_type}`)).toEqual(['4001:Primary', '4002:Secondary', '4003:Other', '4004:Bystander']);
    expect(out.warnings).toEqual([]);
    // The Other with portal off may be removed (not the last, not a Primary).
    const rm = await normalizeActionDraft(pool, { kind: 'case.contact.remove.v1', case_id: CASE, contact_id: 4003, evidence: cite(3) }, ev);
    expect(rm.membership).toEqual({ case_relate_id: 703, from: 'Other', to: null });
  });

  test('the native POST: an exact duplicate is 409 "already linked" with nothing written; another type is a SECOND row', async () => {
    const dup = await call(app, 'POST', `/api/cases/${CASE}/contacts`, { contact_id: 4002, relate_type: 'Secondary' });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already linked/);
    expect(await rows()).toHaveLength(3);
    const second = await call(app, 'POST', `/api/cases/${CASE}/contacts`, { contact_id: 4002, relate_type: 'Other' });
    expect(second.status).toBe(200);
    expect(Number.isSafeInteger(second.body.case_relate_id)).toBe(true);
    expect((await rows()).filter((r) => r.case_relate_client_id === 4002).map((r) => r.case_relate_type)).toEqual(['Secondary', 'Other']);
    // …which the normalizer then refuses to change or remove as one membership.
    await expect(normalizeActionDraft(pool, { kind: 'case.contact.update.v1', case_id: CASE, contact_id: 4002, relate_type: 'Primary', evidence: cite(2) }, ev))
      .rejects.toThrow(/^Sam Spouse has 2 memberships on case 25-40001-abc \(Secondary, Other\)/);
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
    expect(domainEvents.emit.mock.calls[0][1]).toBe('case.contact_linked');
  });

  test('the native PATCH / DELETE act on EVERY row of the pair: a two-row PATCH fails whole, a DELETE removes both', async () => {
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (704, ?, 4002, 'Other')`, [CASE]);
    const before = await rows();
    const patch = await call(app, 'PATCH', `/api/cases/${CASE}/contacts/4002`, { relate_type: 'Bystander' });
    expect(patch.status).toBe(500);
    expect(await rows()).toEqual(before);
    const del = await call(app, 'DELETE', `/api/cases/${CASE}/contacts/4002`);
    expect(del.status).toBe(200);
    expect((await rows()).map((r) => r.case_relate_id)).toEqual([701, 703]);
  });

  test('the native PATCH validates nothing and emits nothing; a no-op PATCH trips the update trigger', async () => {
    const ok = await call(app, 'PATCH', `/api/cases/${CASE}/contacts/4003`, { relate_type: 'Bystander' });
    expect(ok.status).toBe(200);
    expect(domainEvents.emit).not.toHaveBeenCalled();
    const same = await call(app, 'PATCH', `/api/cases/${CASE}/contacts/4003`, { relate_type: 'Bystander' });
    expect(same.status).toBe(500);
    // Relaxed sql_mode: a non-enum value is stored as '' (with a warning), not refused.
    const bad = await call(app, 'PATCH', `/api/cases/${CASE}/contacts/4003`, { relate_type: 'Debtor' });
    expect(bad.status).toBe(200);
    expect((await rows()).find((r) => r.case_relate_id === 703).case_relate_type).toBe('');
  });

  test('a DELETE or PATCH of a membership already gone is 404 "Relationship not found", nothing written', async () => {
    const first = await call(app, 'DELETE', `/api/cases/${CASE}/contacts/4003`);
    expect(first.status).toBe(200);
    expect(domainEvents.emit.mock.calls.map((c) => c[1])).toEqual(['case.contact_unlinked']);
    for (const [method, body] of [['DELETE', undefined], ['PATCH', { relate_type: 'Other' }]]) {
      const again = await call(app, method, `/api/cases/${CASE}/contacts/4003`, body);
      expect({ method, status: again.status, message: again.body.message }).toEqual({ method, status: 404, message: 'Relationship not found' });
    }
    expect(await rows()).toHaveLength(2);
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
  });

  test('a case id longer than case_relate stores is TRUNCATED by the native POST — the normalizer refuses the add', async () => {
    const long = 'A8LONGCASE';
    await q(`INSERT INTO cases (case_id, case_number, case_type) VALUES (?, '25-40002', 'Chapter 7')`, [long]);
    await expect(normalizeActionDraft(pool, { kind: 'case.contact.add.v1', case_id: long, contact_id: 4004, relate_type: 'Other', evidence: cite(1) },
      [{ id: 'q1', rows: [{ case_id: long, contact_id: 4004 }] }])).rejects.toThrow(/is longer than the 8 characters a case membership stores/);
    const res = await call(app, 'POST', `/api/cases/${long}/contacts`, { contact_id: 4004, relate_type: 'Other' });
    expect(res.status).toBe(200);
    const [stored] = await q('SELECT case_relate_case_id FROM case_relate WHERE case_relate_id = ?', [res.body.case_relate_id]);
    expect(stored.case_relate_case_id).toBe(long.slice(0, 8));
  });
});
