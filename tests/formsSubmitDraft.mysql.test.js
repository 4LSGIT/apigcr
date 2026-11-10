// tests/formsSubmitDraft.mysql.test.js
//
/**
 * POST /api/forms/submissions/submit-draft on REAL MySQL — the real route, the
 * real formSubmitService over the real formService, formTemplateService,
 * extFormService, caseService (docket guard, updateCase), logService, under
 * the production sql_mode. The draft is written and read back through the
 * real draft routes (POST /api/forms/draft, GET /api/forms/latest — the read
 * the A12 card takes its updated_at from).
 *
 * Stubbed at the boundaries the existing tests use: the auth gate (a staff
 * JWT, user 6), start_workflow (tests/extforms.x2.test.js — the workflow, and
 * the PDF render that would run inside it, never start), and the domain-event
 * queue (observed via domainEvents.emit; buildEnvelope stays real).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_fsub_test npx jest tests/formsSubmitDraft.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables, cloned from ref/database.sql (a clause referencing a table outside
 * the list is dropped), in its before-hook AND its after-hook, with any
 * sibling-built child of ours. The log write uses CONVERT_TZ(…, 'EST5EDT'):
 * the server needs its tz tables (mysql_tzinfo_to_sql).
 *
 * WHAT IS LOCKED
 *   - A draft submitted lands as ONE submitted row (version 1, the published
 *     schema_version, the draft's data, submitted_by the caller); the draft row
 *     is gone; the case's columns carry the patch (and only the patch); ONE
 *     'form' log row by the caller, action form_submit, the diff; the workflow
 *     started with the new submission's id; case.updated then form.submitted.
 *   - A DATE column read through mysql2 (a Date) against the draft's
 *     'YYYY-MM-DD' is no change — the baseline is what the browser receives.
 *   - An unchanged draft still submits and writes nothing to the case.
 *   - A second call for the same draft is a 404 (the draft is gone).
 *   - THE PRECONDITION: a draft re-saved after it was read → 409, and nothing
 *     moves (no submitted row, the newer draft kept, the case untouched, no log).
 *   - VALIDATION names the field by key and label, and nothing moves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../lib/internal_functions', () => ({
  start_workflow: jest.fn(async () => ({ success: true, output: { workflow_execution_id: 4242 } })),
}));
const domainEvents = require('../lib/domainEvents');
const internalFunctions = require('../lib/internal_functions');
const fieldDefs = require('../services/fieldDefService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'contact_roles', 'field_defs', 'users', 'log',
  'form_templates', 'form_submissions'];

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

const CASE = 'FSUBCASE';
const KEY = 'fsub_case';
const DEFINITION = {
  dataMode: 'live',
  endpoints: { load: { method: 'GET', url: '/api/cases/{linkId}', path: 'case' } },
  onSubmit: { patch: { method: 'PATCH', url: '/api/cases/{linkId}' }, workflows: [{ id: 41, initData: { notify_to: 'ops' } }], pdf: true },
  sections: [{ title: 'Case', rows: [{ fields: [
    { name: 'trustee', type: 'text', label: 'Trustee', apiColumn: 'case_trustee', required: true },
    { name: 'caption', type: 'text', label: 'Caption', apiColumn: 'case_caption' },
    { name: 'file_date', type: 'date', label: 'Filed', apiColumn: 'case_file_date' },
    { name: 'notes', type: 'textarea', label: 'Notes' },
  ] }] }],
};
const SAME = { trustee: 'Tom Trustee', caption: 'In re Dana', file_date: '2026-01-05', notes: '' };

d('POST /api/forms/submissions/submit-draft on real MySQL', () => {
  let pool; let app;
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

  async function seed() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DELETE FROM \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    fieldDefs.bump();
    await q(`INSERT INTO users (user, user_name) VALUES (6, 'Fred')`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_trustee, case_caption, case_file_date, custom)
             VALUES (?, '26-10001', 'Bankruptcy', 'Tom Trustee', 'In re Dana', '2026-01-05', '{}')`, [CASE]);
    await q(`INSERT INTO form_templates (id, form_key, title, link_type, schema_version, definition, draft_definition, visibility)
             VALUES (1, ?, 'Case Sheet', 'case', 2, ?, ?, 'internal')`, [KEY, JSON.stringify(DEFINITION), JSON.stringify(DEFINITION)]);
  }

  const saveDraft = (data) => call(app, 'POST', '/api/forms/draft', { form_key: KEY, link_type: 'case', link_id: CASE, schema_version: 2, data });
  const latestDraft = async () => (await call(app, 'GET', `/api/forms/latest?form_key=${KEY}&link_type=case&link_id=${CASE}`)).body.draft;
  const submit = (body) => call(app, 'POST', '/api/forms/submissions/submit-draft', body);
  const rows = (status) => q('SELECT * FROM form_submissions WHERE form_key = ? AND status = ? ORDER BY id', [KEY, status]);
  const caseRow = async () => (await q('SELECT case_trustee, case_caption, case_file_date FROM cases WHERE case_id = ?', [CASE]))[0];
  const logRows = () => q(`SELECT log_type, log_link_type, log_link_id, log_by, log_data FROM log WHERE log_type = 'form'`);
  const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

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
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.forms'));
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => {
    await seed();
    domainEvents.emit.mockClear();
    internalFunctions.start_workflow.mockClear();
  });

  test('a draft submitted: one submitted row, the draft gone, the case patched, the log row, the workflow, the events', async () => {
    const data = { trustee: 'Nina Newtrustee', caption: '', file_date: '2026-01-05', notes: 'called the trustee' };
    expect((await saveDraft(data)).status).toBe(200);
    const draft = await latestDraft();
    const res = await submit({ submission_id: draft.id, expected_updated_at: draft.updated_at });
    expect(res.status).toBe(200);

    const [sub] = await rows('submitted');
    expect((await rows('submitted')).length).toBe(1);
    expect([sub.link_type, sub.link_id, sub.version, sub.schema_version, sub.submitted_by]).toEqual(['case', CASE, 1, 2, 6]);
    expect(asObj(sub.data)).toEqual(data);
    expect(await rows('draft')).toEqual([]);

    // The trustee and the cleared caption; the DATE (a Date from mysql2 vs the
    // draft's 'YYYY-MM-DD') is not a change and is left alone.
    const c = await caseRow();
    expect([c.case_trustee, c.case_caption, c.case_file_date.toISOString()]).toEqual(['Nina Newtrustee', '', '2026-01-05T00:00:00.000Z']);

    const logs = await logRows();
    expect(logs.length).toBe(1);
    expect([logs[0].log_link_type, logs[0].log_link_id, logs[0].log_by]).toEqual(['case', CASE, 6]);
    const ld = asObj(logs[0].log_data);
    expect([ld.form_key, ld.action, ld.version]).toEqual([KEY, 'form_submit', 1]);
    expect(JSON.parse(ld.changes)).toEqual({ trustee: ['Tom Trustee', 'Nina Newtrustee'], caption: ['In re Dana', ''], notes: ['', 'called the trustee'] });

    expect(internalFunctions.start_workflow).toHaveBeenCalledTimes(1);
    const [p, db] = internalFunctions.start_workflow.mock.calls[0];
    expect(db).toBe(pool);
    expect(p.init_data).toEqual({ ...data, notify_to: 'ops', form_key: KEY, form_title: 'Case Sheet', link_type: 'case',
      link_id: CASE, submission_id: sub.id, make_pdf: true, _values: data });

    expect(domainEvents.emit.mock.calls.map((c2) => c2[1])).toEqual(['case.updated', 'form.submitted']);
    const [, , upd] = domainEvents.emit.mock.calls[0];
    expect([upd.actor, upd.source, Object.keys(upd.changes).sort()]).toEqual([{ user_id: 6 }, 'manual', ['case_caption', 'case_trustee']]);

    expect(res.body).toEqual({ status: 'success', submission: { id: sub.id, version: 1, updated_at: sub.updated_at.toISOString() },
      form_key: KEY, link_type: 'case', link_id: CASE, patch_target: { type: 'case', id: CASE },
      patched: ['case_trustee', 'case_caption'], changes: res.body.changes, draft_deleted: true,
      workflows: [{ id: 41, started: true, execution_id: 4242 }], log_id: res.body.log_id });
    expect(res.body.changes.case_trustee).toEqual({ from: 'Tom Trustee', to: 'Nina Newtrustee' });
    expect(Number.isInteger(res.body.log_id) && res.body.log_id > 0).toBe(true);

    // A second call for the same draft: the draft is gone.
    const again = await submit({ submission_id: draft.id });
    expect([again.status, again.body.message]).toEqual([404, `Draft ${draft.id} not found`]);
    expect((await rows('submitted')).length).toBe(1);
  });

  test('an unchanged draft still submits and writes nothing to the case', async () => {
    await saveDraft(SAME);
    const draft = await latestDraft();
    const res = await submit({ submission_id: draft.id });
    expect(res.status).toBe(200);
    expect([res.body.patched, res.body.patch_target]).toEqual([[], null]);
    expect((await rows('submitted')).length).toBe(1);
    expect(await rows('draft')).toEqual([]);
    expect(domainEvents.emit.mock.calls.map((c2) => c2[1])).toEqual(['form.submitted']);
    expect(JSON.parse(asObj((await logRows())[0].log_data).changes)).toEqual({});
  });

  test('THE PRECONDITION: a draft re-saved after it was read → 409, and nothing moves', async () => {
    await saveDraft({ ...SAME, trustee: 'First Edit' });
    // The card read the draft 5 s ago; then someone saved it again.
    await q('UPDATE form_submissions SET updated_at = updated_at - INTERVAL 5 SECOND WHERE status = ?', ['draft']);
    const read = await latestDraft();
    expect((await saveDraft({ ...SAME, trustee: 'Second Edit' })).status).toBe(200);

    const res = await submit({ submission_id: read.id, expected_updated_at: read.updated_at });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(`Draft ${read.id} was saved again since it was read — re-read it before submitting`);
    expect(new Date(res.body.updated_at).getTime()).toBeGreaterThan(new Date(read.updated_at).getTime());
    expect(await rows('submitted')).toEqual([]);
    const drafts = await rows('draft');
    expect([drafts.length, asObj(drafts[0].data).trustee]).toEqual([1, 'Second Edit']);
    expect((await caseRow()).case_trustee).toBe('Tom Trustee');
    expect(await logRows()).toEqual([]);
    expect(internalFunctions.start_workflow).not.toHaveBeenCalled();
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('VALIDATION names the field by key and label, and nothing moves', async () => {
    await saveDraft({ ...SAME, trustee: '   ' });
    const draft = await latestDraft();
    const res = await submit({ submission_id: draft.id, expected_updated_at: draft.updated_at });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('values.trustee is required');
    expect(res.body.fields).toEqual([{ key: 'trustee', label: 'Trustee', message: 'values.trustee is required' }]);
    expect(await rows('submitted')).toEqual([]);
    expect((await rows('draft')).length).toBe(1);
    expect((await caseRow()).case_trustee).toBe('Tom Trustee');
    expect(await logRows()).toEqual([]);
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });
});
