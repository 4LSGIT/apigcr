// tests/caseyDocuments.mysql.test.js
//
/**
 * A11 on REAL MySQL: the Casey document normalizer's own SQL (the row, its
 * links, the labels, the related-target resolution it states), the real
 * trigger-rule load and dry run, and the native route behaviour every refusal
 * rests on — routes/api.documents.js, real handlers, real documentService,
 * real pool, under the production sql_mode — plus the browser's click-time
 * re-read and answer checks (extracted from public/assistant.html) over the
 * REAL GET / PATCH / POST payloads.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a11_test npx jest tests/caseyDocuments.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them (the caseyPipeline.mysql hygiene).
 *
 * WHAT IS LOCKED
 *   - THE SILENT CLIP: PATCH stores a 300-character title cut to 255 and
 *     answers success — the normalizer refuses > 255 first. Tags are stored
 *     in normalizeTags form, exactly the card's `to`.
 *   - DUPLICATE = SUCCESS: a repeat POST /links answers 200 created:false and
 *     writes nothing — also for a link_id that differs only in case (the
 *     general_ci UNIQUE key) — so the normalizer's "already linked" refusal
 *     folds case, and the browser maps created:false to a refusal.
 *   - THE UNIQUE KEY (document_id, link_type, link_id) refuses a raw
 *     duplicate insert, case-folded.
 *   - THE LINK ROUTE IGNORES STATUS: a deleted document links natively; the
 *     normalizer refuses it.
 *   - THE RELATED PREDICATE: a contact link shows the document on each case
 *     the contact is on (documentService.list related, the view the Documents
 *     tab reads) and on nothing further — exactly the card's visibility line.
 *   - The report pool returns BIGINT ids as strings; such an evidence row is
 *     accepted.
 *   - The dry run reads the real active rules (an inactive one and one on
 *     another event are not listed) and the service emits exactly the
 *     envelope the card dry-ran.
 *   - The browser's prechecks pass on a fresh card and refuse after a change;
 *     the answer checks accept the real answers.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js)
// and the event queue (observed, not run; buildEnvelope / buildChanges stay
// REAL via requireActual).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
const domainEvents = require('../lib/domainEvents');
const documentService = require('../services/documentService');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'documents', 'document_links', 'trigger_rules', 'trigger_rule_actions'];

function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = []; const alters = [];
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

// The browser's checks, extracted verbatim from the page (the assistantUi
// fnSrc idiom, inlined) and run against an `api` that calls the real routes.
function fnSrc(html, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', m.index + m[0].length); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index - (html.slice(0, m.index).endsWith('async ') ? 6 : 0), i + 1);
  }
  throw new Error(`${name} unbalanced`);
}
function browserChecks(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const max = /const DOCUMENT_FIELD_MAX = \{[^}]*\};/.exec(html);
  if (!max) throw new Error('DOCUMENT_FIELD_MAX not found');
  const names = ['documentChars', 'documentNorm', 'documentFoldId', 'documentName', 'documentId', 'documentUpdateBody', 'documentUpdateRequest',
    'documentLinkRequest', 'documentLinkSignature', 'documentRead', 'documentUpdatePrecheck', 'documentLinkPrecheck', 'documentUpdateResult', 'documentLinkResult'];
  const src = `${max[0]}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { documentUpdateRequest, documentLinkRequest, documentUpdatePrecheck, documentLinkPrecheck, documentUpdateResult, documentLinkResult };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey document cards on real MySQL (A11)', () => {
  let pool; let reportPool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A11CASE1'; const C2 = 'A11CASE2';

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
    for (const t of [...TABLES].reverse()) await q(`DELETE FROM \`${t}\``);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype) VALUES
      (?, '25-60001', 'Bankruptcy', 'Chapter 7'), (?, '25-60002', 'Bankruptcy', 'Chapter 13')`, [C1, C2]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (6001, 'person', 'Dana Debtor', 'Dana', 'Debtor'), (6002, 'person', 'Sam Spouse', 'Sam', 'Spouse'), (6003, 'person', 'Other Client', 'Other', 'Client')`);
    // Dana is on both cases; Sam on C1 only; Other on C2 only.
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (901, ?, 6001, 'Primary'), (902, ?, 6002, 'Secondary'), (903, ?, 6001, 'Primary'), (904, ?, 6003, 'Secondary')`, [C1, C1, C2, C2]);
    await q(`INSERT INTO documents (id, source, external_id, name, path, path_lower, ext, size, status, updated_at) VALUES
      (71, 'dropbox', 'id:AAA', 'Petition.pdf', '/Active/Debtor/Petition.pdf', '/active/debtor/petition.pdf', 'pdf', 1258291, 'active', '2026-10-30 12:00:00'),
      (72, 'dropbox', 'id:BBB', 'Old.pdf', '/Active/Debtor/Old.pdf', '/active/debtor/old.pdf', 'pdf', 10, 'deleted', '2026-10-30 12:00:00'),
      (73, 'dropbox', 'id:CCC', 'Paystub.jpg', '/Unsorted/Paystub.jpg', '/unsorted/paystub.jpg', 'jpg', 5, 'active', '2026-10-30 12:00:00')`);
    await q(`INSERT INTO document_links (id, document_id, link_type, link_id, relation, created_by) VALUES (501, 71, 'case', ?, 'path', NULL)`, [C1]);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (1, 'document.updated', 'Petition typed', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"data.doc_type","op":"equals","value":"petition"}]}'),
      (2, 'document.linked', 'Filed to a contact', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"extra.link_type","op":"equals","value":"contact"}]}'),
      (3, 'document.linked', 'Switched off', 0, 2, 'conditions', '{"operator":"and","conditions":[]}'),
      (4, 'document.created', 'Other event', 1, 1, 'conditions', '{"operator":"and","conditions":[]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
      (1, 'Make a task', 1, 1, 'workflow', '{"workflow_id":42}'), (2, NULL, 1, 1, 'internal_function', '{"function_name":"create_log"}'),
      (3, NULL, 1, 1, 'workflow', '{"workflow_id":9}'), (4, NULL, 1, 1, 'workflow', '{"workflow_id":8}')`);
  }
  const ev = [
    { id: 'q1', rows: [{ document_id: 71 }, { document_id: 72 }, { document_id: 73 }] },
    { id: 'q2', rows: [{ case_id: C1 }, { case_id: C2 }] },
    { id: 'q3', rows: [{ contact_id: 6001 }, { contact_id: 6002 }] },
  ];
  const card = (value, evidence = ev) => normalizeActionDraft(pool, value, evidence, { currentUserId: 6 });
  const linkRows = (id) => q('SELECT id, link_type, link_id, relation, created_by FROM document_links WHERE document_id = ? ORDER BY id', [id]);

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    // The report / Casey sql.read pool's options (startup/dbReport.js): BIGINT comes back as a STRING.
    reportPool = mysql.createPool({ uri: URL_, connectionLimit: 2, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
    const conn = await pool.getConnection();
    try {
      await dropAll(conn);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const { creates, alters } = schemaFor(TABLES);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { conn.release(); }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.documents'));
    // The page's api(path, body, method): a non-2xx throws with .status (apiSend's contract).
    browser = browserChecks(async (p, body, method) => {
      if (/^\/api\/(cases|contacts)\//.test(p)) {
        const [kind, id] = p.split('/').slice(2);
        const rows = kind === 'cases' ? await q('SELECT case_id FROM cases WHERE case_id = ?', [decodeURIComponent(id)])
          : await q('SELECT contact_id FROM contacts WHERE contact_id = ?', [Number(id)]);
        if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
        return { status: 'success' };
      }
      const res = await call(app, method, p, method === 'GET' ? undefined : body);
      if (res.status >= 400) throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
      return res.body;
    });
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
    await reportPool.end();
  });

  beforeEach(async () => { await seed(); domainEvents.emit.mockClear(); });

  test('THE SILENT CLIP — PATCH stores a 300-character title cut to 255 and answers success; the normalizer refuses > 255', async () => {
    const long = 'x'.repeat(300);
    const res = await call(app, 'PATCH', '/api/documents/73', { title: long, doc_type: 't'.repeat(70) });
    expect([res.status, res.body.document.title.length, res.body.document.doc_type.length]).toEqual([200, 255, 64]);
    expect(documentService.COLUMN_LIMITS).toMatchObject({ title: 255, doc_type: 64, tags: 512, relation: 32 });
    await expect(card({ kind: 'document.update.v1', document_id: 71, title: long, evidence: [{ query_id: 'q1', row_number: 1 }] }))
      .rejects.toThrow('The title is 300 characters — the column keeps 255');
    await expect(card({ kind: 'document.update.v1', document_id: 71, doc_type: 't'.repeat(70), evidence: [{ query_id: 'q1', row_number: 1 }] }))
      .rejects.toThrow('The type is 70 characters — the column keeps 64');
  });

  test('the update card over the real row: tags in the stored form, the real dry run, the service\'s own envelope, the browser\'s re-read and answer check', async () => {
    const c = await card({ kind: 'document.update.v1', document_id: 71, title: 'Chapter 7 petition', doc_type: 'petition', tags: 'Court Filed, court',
      evidence: [{ query_id: 'q1', row_number: 1 }] });
    expect([c.changes, c.expected, c.links.map((l) => l.label)]).toEqual([
      { title: { from: null, to: 'Chapter 7 petition' }, doc_type: { from: null, to: 'petition' }, tags: { from: null, to: 'court-filed,court' } },
      { title: null, doc_type: null, tags: null, status: 'active', updated_at: '2026-10-30T12:00:00.000Z' }, ['case 25-60001']]);
    expect([c.automation.rules_checked, c.automation.lines]).toEqual([1, ['Trigger rule #1 "Petition typed" runs: starts workflow #42 ("Make a task")']]);
    // The browser's re-read passes on the fresh card (the ISO updated_at round trip included)…
    expect(await browser.documentUpdatePrecheck(c)).toBe('');
    const req = browser.documentUpdateRequest(c);
    expect(req).toEqual({ path: '/api/documents/71', method: 'PATCH', body: { title: 'Chapter 7 petition', doc_type: 'petition', tags: 'court-filed,court' } });
    const res = await call(app, 'PATCH', req.path, req.body);
    expect(res.status).toBe(200);
    expect(browser.documentUpdateResult(c, res.body)).toEqual({ document_id: 71 });
    const [row] = await q('SELECT title, doc_type, tags FROM documents WHERE id = 71');
    expect(row).toEqual({ title: 'Chapter 7 petition', doc_type: 'petition', tags: 'court-filed,court' });
    // …the service emitted exactly the envelope the card dry-ran…
    const [[, type, payload]] = domainEvents.emit.mock.calls;
    expect([type, payload.source, payload.actor, payload.changes, payload.extra, payload.data.doc_type, payload.data.tags]).toEqual(['document.updated', 'manual', { user_id: 6 },
      c.changes,
      { updated_fields: ['title', 'doc_type', 'tags'], via: 'edit' }, 'petition', 'court-filed,court']);
    // …and the re-read refuses the now-changed document.
    expect(await browser.documentUpdatePrecheck(c)).toMatch(/^The document "Petition\.pdf" changed since this card was prepared/);
    // The same values again: the normalizer's no-op is the service's (no write, no event).
    await expect(card({ kind: 'document.update.v1', document_id: 71, tags: 'court-filed, COURT', evidence: [{ query_id: 'q1', row_number: 1 }] }))
      .rejects.toThrow('already has that tag set — that changes nothing');
    domainEvents.emit.mockClear();
    const again = await call(app, 'PATCH', '/api/documents/71', { tags: 'court-filed,court' });
    expect([again.status, domainEvents.emit.mock.calls.length]).toEqual([200, 0]);
  });

  test('a sync-side change (the file renamed in Dropbox) bumps updated_at — the update card\'s re-read refuses', async () => {
    const c = await card({ kind: 'document.update.v1', document_id: 71, title: 'Petition', evidence: [{ query_id: 'q1', row_number: 1 }] });
    expect(await browser.documentUpdatePrecheck(c)).toBe('');
    await q("UPDATE documents SET name = 'Petition (signed).pdf' WHERE id = 71");
    expect(await browser.documentUpdatePrecheck(c)).toMatch(/changed since this card was prepared \(its title, type, tags or another field\)/);
  });

  test('DUPLICATE = SUCCESS — a repeat link (and one differing only in case) answers 200 created:false and writes nothing; the normalizer refuses both', async () => {
    const first = await call(app, 'POST', '/api/documents/73/links', { link_type: 'case', link_id: C2 });
    const repeat = await call(app, 'POST', '/api/documents/73/links', { link_type: 'case', link_id: C2 });
    const folded = await call(app, 'POST', '/api/documents/73/links', { link_type: 'case', link_id: C2.toLowerCase() });
    expect([first.status, first.body.created, repeat.status, repeat.body.created, folded.status, folded.body.created]).toEqual([201, true, 200, false, 200, false]);
    expect((await linkRows(73)).length).toBe(1);
    expect(domainEvents.emit.mock.calls.map(([, t]) => t)).toEqual(['document.linked']);
    await expect(card({ kind: 'document.link.v1', document_id: 73, link_type: 'case', link_id: C2,
      evidence: [{ query_id: 'q1', row_number: 3 }, { query_id: 'q2', row_number: 2 }] })).rejects.toThrow(/is already linked to case 25-60002 \(link #\d+\) — nothing is proposed/);
    // A stored lower-case link blocks the canonical one too (general_ci).
    await q("INSERT INTO document_links (document_id, link_type, link_id, relation, created_by) VALUES (71, 'case', ?, NULL, 6)", [C2.toLowerCase()]);
    await expect(card({ kind: 'document.link.v1', document_id: 71, link_type: 'case', link_id: C2,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 2 }] })).rejects.toThrow('is already linked to case 25-60002');
    // The browser reads a created:false answer as a refusal that wrote nothing.
    const fresh = await card({ kind: 'document.link.v1', document_id: 73, link_type: 'contact', link_id: 6002,
      evidence: [{ query_id: 'q1', row_number: 3 }, { query_id: 'q3', row_number: 2 }] });
    const rq = browser.documentLinkRequest(fresh);
    expect((await call(app, 'POST', rq.path, rq.body)).status).toBe(201);
    const dup = await call(app, 'POST', rq.path, rq.body);
    expect(() => browser.documentLinkResult(fresh, dup.body)).toThrow('already linked');
  });

  test('THE UNIQUE KEY refuses a raw duplicate, case-folded', async () => {
    await expect(q("INSERT INTO document_links (document_id, link_type, link_id) VALUES (71, 'case', ?)", [C1])).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(q("INSERT INTO document_links (document_id, link_type, link_id) VALUES (71, 'CASE', ?)", [C1.toLowerCase()])).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  test('THE LINK ROUTE IGNORES STATUS — a deleted document links natively; the normalizer refuses it', async () => {
    const res = await call(app, 'POST', '/api/documents/72/links', { link_type: 'case', link_id: C1 });
    expect([res.status, res.body.created]).toEqual([201, true]);
    await expect(card({ kind: 'document.link.v1', document_id: 72, link_type: 'case', link_id: C2,
      evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 2 }] })).rejects.toThrow('Document #72 ("Old.pdf") is deleted — Casey links active documents only');
  });

  test('THE RELATED PREDICATE — a contact link shows on each of the contact\'s cases and nowhere further; the card says exactly that', async () => {
    const c = await card({ kind: 'document.link.v1', document_id: 73, link_type: 'contact', link_id: 6002, relation: 'upload',
      evidence: [{ query_id: 'q1', row_number: 3 }, { query_id: 'q3', row_number: 2 }] });
    expect(c.visibility.slice(0, 2)).toEqual(['Sam Spouse (contact #6002)\'s Documents tab — listed directly.',
      'Under "Include related" (on by default): the Documents tab of each case this contact is on — case 25-60001 (Secondary on the case) — badged "via Sam Spouse (contact #6002)".']);
    expect([c.relation_note, c.effects[0], c.expected]).toEqual(['"upload" — a NEW relation word (no link carries it yet)',
      'Kept: a link you make is a person\'s link — the Dropbox sync never removes it, even if the file is moved or renamed; only someone unlinking it does.',
      { status: 'active', links: [] }]);
    expect([c.automation.rules_checked, c.automation.lines]).toEqual([1, ['Trigger rule #2 "Filed to a contact" runs: calls create_log']]);
    expect(await browser.documentLinkPrecheck(c)).toBe('');
    const rq = browser.documentLinkRequest(c);
    expect(rq).toEqual({ path: '/api/documents/73/links', method: 'POST', body: { link_type: 'contact', link_id: '6002', relation: 'upload' } });
    const res = await call(app, 'POST', rq.path, rq.body);
    const [stored] = await linkRows(73);
    expect(browser.documentLinkResult(c, res.body)).toEqual({ document_link_id: Number(stored.id) });
    expect(stored).toMatchObject({ link_type: 'contact', link_id: '6002', relation: 'upload', created_by: 6 });
    // The service's envelope is the one dry-run.
    const [[, type, payload]] = domainEvents.emit.mock.calls;
    expect([type, payload.contact_id, payload.case_id, payload.extra]).toEqual(['document.linked', 6002, undefined, { link_type: 'contact', link_id: '6002', relation: 'upload' }]);
    // The related view the Documents tab reads: on C1 (Sam is on it), not on C2 (he is not), not on Dana.
    const seen = async (type2, id) => (await documentService.list(pool, { link_type: type2, link_id: id, related: 1 })).documents.map((x) => Number(x.id));
    expect([await seen('case', C1), await seen('case', C2), await seen('contact', '6001')]).toEqual([[73, 71], [], [71]]);
    // A second link since the card: the re-read refuses.
    expect(await browser.documentLinkPrecheck(c)).toMatch(/is already linked to Sam Spouse \(contact #6002\)/);
  });

  test('a case link lists each contact on the case, and the triage effect when it is the document\'s first case link', async () => {
    const c = await card({ kind: 'document.link.v1', document_id: 73, link_type: 'case', link_id: C2,
      evidence: [{ query_id: 'q1', row_number: 3 }, { query_id: 'q2', row_number: 2 }] });
    expect(c.visibility[1]).toBe('Under "Include related" (on by default): the Documents tab of each contact on this case — Dana Debtor (contact #6001) (Primary on the case); Other Client (contact #6003) (Secondary on the case) — badged "via case 25-60002".');
    expect(c.effects[0]).toBe('Triage: the document has no case link yet, so it leaves the Documents page\'s "no case" list.');
    // The triage list the effect names: 73 is on it before and off it after.
    const unlinked = async () => (await documentService.list(pool, { unlinked: 'case' })).documents.map((x) => Number(x.id));
    expect(await unlinked()).toEqual([73]);
    await call(app, 'POST', '/api/documents/73/links', { link_type: 'case', link_id: C2 });
    expect(await unlinked()).toEqual([]);
    // A precheck over another link added in between refuses.
    const c2 = await card({ kind: 'document.link.v1', document_id: 71, link_type: 'case', link_id: C2,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 2 }] });
    await call(app, 'POST', '/api/documents/71/links', { link_type: 'contact', link_id: '6003' });
    expect(await browser.documentLinkPrecheck(c2)).toMatch(/^The links of "Petition\.pdf" changed since this card was prepared/);
  });

  test('the report pool returns BIGINT ids as strings — such an evidence row is accepted', async () => {
    const [rows] = await reportPool.query('SELECT d.id AS document_id, d.name FROM documents d WHERE d.id = 71 LIMIT 1');
    expect(typeof rows[0].document_id).toBe('string');
    const c = await card({ kind: 'document.update.v1', document_id: 71, title: 'Petition', evidence: [{ query_id: 'r1', row_number: 1 }] },
      [{ id: 'r1', rows: rows.map((r) => ({ ...r })) }]);
    expect(c.document.document_id).toBe(71);
  });
});
