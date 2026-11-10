// tests/caseyFormSubmit.mysql.test.js
//
/**
 * A12.3 on REAL MySQL: the Casey submit card (services/assistantService.js
 * normalizeFormSubmit) beside the REAL route it drives —
 * POST /api/forms/submissions/submit-draft (routes/api.forms.js →
 * services/formSubmitService.js over the real formService,
 * formTemplateService, extFormService, caseService (docket guard,
 * updateCase), logService) — under the production sql_mode, plus the browser's
 * click-time re-reads, request builder and answer check (extracted from
 * public/assistant.html) over the REAL answers of the real GET routes
 * (/api/cases/:id, /api/forms/latest, /api/form-templates/render/:form_key).
 * The draft is written and read back through the real draft routes.
 *
 * Stubbed at the boundaries tests/formsSubmitDraft.mysql.test.js uses: the
 * auth gate (a staff JWT, user 6), start_workflow (spied on the registry
 * module formSubmitService calls — the workflow, and any PDF render inside
 * it, never starts; no provider is reached) and the domain-event queue
 * (observed via domainEvents.emit; buildEnvelope stays real).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a123_test npx jest tests/caseyFormSubmit.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (the
 * production proxy). This suite DROPS and recreates its tables, cloned from
 * ref/database.sql (a clause referencing a table outside the list is
 * dropped), in its before-hook AND its after-hook, with any sibling-built
 * child of ours. The log write uses CONVERT_TZ(…, 'EST5EDT'): the server
 * needs its tz tables (mysql_tzinfo_to_sql).
 *
 * WHAT IS LOCKED
 *   - The diff the card DISCLOSED is exactly the columns the route PATCHED
 *     (and the case carries those values, and only those); the card's
 *     re-read passes over the real GETs; its request is ONE POST the route
 *     accepts; the draft is gone; ONE submitted row carries the draft's data,
 *     the published schema_version, the next version and the caller (6); ONE
 *     'form' log row by the caller, action form_submit; the workflow the card
 *     said starts is started with the new submission's id; the browser's
 *     answer check keeps the outcome and the NEW submission id is the receipt.
 *   - A failing required answer: the card refuses naming EVERY failing answer
 *     by label; the route 400s naming the first — and nothing moves.
 *   - THE PRECONDITION after a hand edit of the draft: the card's re-read
 *     refuses AND the route 409s on the card's expected_updated_at — nothing
 *     moves. A hand edit of the case refuses at the card's re-read.
 *   - An older schema_version: the card refuses naming both versions; the
 *     route 409s naming both — nothing moves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
const domainEvents = require('../lib/domainEvents');
const internalFunctions = require('../lib/internal_functions');
const fieldDefs = require('../services/fieldDefService');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'contact_roles', 'field_defs', 'users', 'log', 'form_templates', 'form_submissions',
  'workflows', 'trigger_rules', 'trigger_rule_actions', 'pipeline_stage_requirements'];

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

// The browser's half, extracted verbatim from the page and run against an
// `api` that calls the real routes (throwing as the shell's apiSend does).
function fnSrc(html, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index - (html.slice(0, m.index).endsWith('async ') ? 6 : 0), i + 1);
  }
  throw new Error(`${name} unbalanced`);
}
function browserChecks(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const names = ['formCanonical', 'formDataHash', 'formIso', 'formRecordLabel', 'formTitle', 'formRecordPath', 'formSubmitRequest', 'formSubmitPrecheck',
    'formSubmitResult', 'formSubmitKnownOutcome', 'formSubmitOutcomeText'];
  const src = `${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

const CASE = 'A123CASE';
const KEY = 'a123_case';
const DEFINITION = {
  dataMode: 'live',
  endpoints: { load: { method: 'GET', url: '/api/cases/{linkId}', path: 'case' } },
  onSubmit: { patch: { method: 'PATCH', url: '/api/cases/{linkId}' }, workflows: [{ id: 41, initData: { notify_to: 'ops' } }], pdf: true },
  sections: [{ title: 'Case', rows: [{ fields: [
    { name: 'trustee', type: 'text', label: 'Trustee', apiColumn: 'case_trustee', required: true },
    { name: 'caption', type: 'text', label: 'Caption', apiColumn: 'case_caption' },
    { name: 'chapter', type: 'select', label: 'Chapter', apiColumn: 'case_chapter', options: ['7', '13'] },
    { name: 'file_date', type: 'date', label: 'Filed', apiColumn: 'case_file_date' },
    { name: 'debts', type: 'number', label: 'Debts', min: 0 },
    { name: 'notes', type: 'textarea', label: 'Notes' },
  ] }] }],
};
const SAME = { trustee: 'Tom Trustee', caption: 'In re Dana', chapter: '7', file_date: '2026-01-05', debts: '', notes: '' };

d('the Casey form submit card on real MySQL (A12.3)', () => {
  let pool; let app; let browser; let startSpy;
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
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_trustee, case_caption, case_chapter, case_file_date, custom)
             VALUES (?, '26-20001', 'Bankruptcy', 'Tom Trustee', 'In re Dana', '7', '2026-01-05', '{}')`, [CASE]);
    await q(`INSERT INTO form_templates (id, form_key, title, link_type, schema_version, definition, draft_definition, visibility)
             VALUES (1, ?, 'Case Sheet', 'case', 2, ?, ?, 'internal')`, [KEY, JSON.stringify(DEFINITION), JSON.stringify(DEFINITION)]);
    await q(`INSERT INTO workflows (id, active, name, description, current_version) VALUES (41, 1, 'Notify ops', 'Emails ops', 1)`);
  }

  const saveDraft = (data, schemaVersion = 2) => call(app, 'POST', '/api/forms/draft', { form_key: KEY, link_type: 'case', link_id: CASE, schema_version: schemaVersion, data });
  const latestDraft = async () => (await call(app, 'GET', `/api/forms/latest?form_key=${KEY}&link_type=case&link_id=${CASE}`)).body.draft;
  const route = (body) => call(app, 'POST', '/api/forms/submissions/submit-draft', body);
  const rows = (status) => q('SELECT * FROM form_submissions WHERE form_key = ? AND status = ? ORDER BY id', [KEY, status]);
  const caseRow = async () => (await q('SELECT case_trustee, case_caption, case_chapter, case_file_date FROM cases WHERE case_id = ?', [CASE]))[0];
  const logRows = () => q(`SELECT log_type, log_link_type, log_link_id, log_by, log_data FROM log WHERE log_type = 'form'`);
  const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const evidenceFor = (id) => [
    { id: 'q1', kind: 'sql.read', purpose: 'the draft', rows: [{ submission_id: id }] },
    { id: 'q2', kind: 'sql.read', purpose: 'the case', rows: [{ case_id: CASE }] },
  ];
  const card = (id) => normalizeActionDraft(pool, { kind: 'form.submit.v1', submission_id: id,
    evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, evidenceFor(id), { currentUserId: 6 });
  const nothingMoved = async (draftsLeft = 1) => {
    expect(await rows('submitted')).toEqual([]);
    expect((await rows('draft')).length).toBe(draftsLeft);
    expect((await caseRow()).case_trustee).toBe('Tom Trustee');
    expect(await logRows()).toEqual([]);
    expect(startSpy).not.toHaveBeenCalled();
    expect(domainEvents.emit).not.toHaveBeenCalled();
  };

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
    app.use(require('../routes/api.formTemplates'));
    app.use(require('../routes/api.cases'));
    browser = browserChecks(async (p, body, method) => {
      const res = await call(app, method, p, body);
      if (res.status >= 400) throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
      return res.body;
    });
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
    startSpy = jest.spyOn(internalFunctions, 'start_workflow').mockImplementation(async () => ({ success: true, output: { workflow_execution_id: 4242 } }));
  });
  afterEach(() => { startSpy.mockRestore(); });

  test('the disclosed diff IS what the route patched; the re-read passes; ONE POST; the draft gone; the row, the log, the workflow; the receipt', async () => {
    const data = { trustee: 'Nina Newtrustee', caption: '', chapter: '13', file_date: '2026-01-05', debts: '12', notes: 'called the trustee' };
    expect((await saveDraft(data)).status).toBe(200);
    const draft = await latestDraft();
    const c = JSON.parse(JSON.stringify(await card(draft.id)));

    // What the card disclosed: three columns (the DATE — a Date from mysql2
    // against 'YYYY-MM-DD' — is no change), the workflow, the next version.
    const disclosed = c.patch.columns.map((x) => x.column).sort();
    expect(disclosed).toEqual(['case_caption', 'case_chapter', 'case_trustee']);
    expect(c.patch.columns.find((x) => x.column === 'case_trustee')).toMatchObject({ before: '"Tom Trustee"', after: '"Nina Newtrustee"' });
    expect(c.workflows).toEqual([{ id: 41, name: 'Notify ops', description: 'Emails ops', will_start: true, init_keys: ['notify_to'] }]);
    expect([c.version_after, c.expected.draft_id, c.expected.updated_at]).toEqual([1, draft.id, draft.updated_at]);
    expect(c.automation.events).toEqual(['case.updated', 'form.submitted']);

    // The browser: the re-read over the real GETs passes, then ONE POST.
    expect(await browser.formSubmitPrecheck(c)).toBe('');
    const req = browser.formSubmitRequest(c);
    expect(req).toEqual({ path: '/api/forms/submissions/submit-draft', method: 'POST', body: { submission_id: draft.id, expected_updated_at: draft.updated_at } });
    const res = await call(app, req.method, req.path, req.body);
    expect(res.status).toBe(200);
    expect([...res.body.patched].sort()).toEqual(disclosed);

    const after = await caseRow();
    expect([after.case_trustee, after.case_caption, after.case_chapter, after.case_file_date.toISOString()]).toEqual(['Nina Newtrustee', '', '13', '2026-01-05T00:00:00.000Z']);
    // Each column now holds the value the card showed as "after" (its display: '' reads "(empty)").
    const shown = (v) => (v == null ? '(blank)' : v === '' ? '(empty)' : JSON.stringify(v));
    for (const col of c.patch.columns) expect({ col: col.column, now: shown(after[col.column]) }).toEqual({ col: col.column, now: col.after });

    expect(await rows('draft')).toEqual([]);
    const subs = await rows('submitted');
    expect(subs.length).toBe(1);
    expect([subs[0].version, subs[0].schema_version, subs[0].submitted_by, subs[0].link_id]).toEqual([1, 2, 6, CASE]);
    expect(asObj(subs[0].data)).toEqual(data);

    const logs = await logRows();
    expect(logs.length).toBe(1);
    expect([logs[0].log_link_type, logs[0].log_link_id, logs[0].log_by, asObj(logs[0].log_data).action]).toEqual(['case', CASE, 6, 'form_submit']);
    // The log's diff names the answers the card listed as differing.
    expect(Object.keys(JSON.parse(asObj(logs[0].log_data).changes)).sort()).toEqual(c.changes.map((x) => x.key).sort());

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0][0]).toMatchObject({ workflow_id: 41, init_data: { notify_to: 'ops', submission_id: subs[0].id, make_pdf: true, form_key: KEY } });
    expect(domainEvents.emit.mock.calls.map((x) => x[1])).toEqual(c.automation.events);

    // The browser's answer check: the NEW row is the receipt; nothing is a problem.
    expect(browser.formSubmitResult(c, res.body)).toEqual({ submission_id: subs[0].id });
    expect(c.submit_outcome).toMatchObject({ submission_id: subs[0].id, version: 1, unreviewed: [], draft_deleted: true, log_id: res.body.log_id });
    expect(browser.formSubmitOutcomeText(c).problems).toEqual([]);

    // The re-read after the submit refuses: the draft is gone.
    expect(await browser.formSubmitPrecheck(c)).toMatch(/is gone — submitted or discarded since this card was prepared\. Nothing was submitted\.$/);
  });

  test('a failing required answer: the card names EVERY failing answer; the route 400s naming the first; nothing moves', async () => {
    await saveDraft({ ...SAME, trustee: '   ', chapter: '11', debts: '-3' });
    const draft = await latestDraft();
    let err;
    try { await card(draft.id); } catch (e) { err = e; }
    expect(err && err.status).toBe(422);
    expect(err.message).toMatch(/^ANSWERS REFUSED: the route validates the draft against the published "Case Sheet" and would refuse it \(400\) — /);
    for (const want of ['"Trustee" (trustee): is required', '"Chapter" (chapter): value is not one of the allowed options', '"Debts" (debts): is below minimum 0']) {
      expect(err.message).toContain(want);
    }
    const res = await route({ submission_id: draft.id, expected_updated_at: draft.updated_at });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual([{ key: 'trustee', label: 'Trustee', message: 'values.trustee is required' }]);
    expect(browser.formSubmitKnownOutcome(Object.assign(new Error(res.body.message), { status: 400, body: res.body })).status).toBe('Refused — nothing written');
    await nothingMoved();
  });

  test('THE PRECONDITION: a hand edit of the draft — the card refuses AND the route 409s; a hand edit of the case refuses at the card', async () => {
    await saveDraft({ ...SAME, trustee: 'First Edit' });
    // The card read the draft 5 s ago; then someone saved it again.
    await q('UPDATE form_submissions SET updated_at = updated_at - INTERVAL 5 SECOND WHERE status = ?', ['draft']);
    const read = await latestDraft();
    const c = JSON.parse(JSON.stringify(await card(read.id)));
    expect(await browser.formSubmitPrecheck(c)).toBe('');
    expect((await saveDraft({ ...SAME, trustee: 'Second Edit' })).status).toBe(200);

    expect(await browser.formSubmitPrecheck(c)).toMatch(/^The draft of "Case Sheet" for case 26-20001 changed since this card was prepared .*Nothing was submitted/);
    const req = browser.formSubmitRequest(c);
    const res = await call(app, req.method, req.path, req.body);
    expect([res.status, res.body.message]).toEqual([409, `Draft ${read.id} was saved again since it was read — re-read it before submitting`]);
    await nothingMoved();
    expect(asObj((await rows('draft'))[0].data).trustee).toBe('Second Edit');

    // A fresh card, then a hand edit of the case: the record re-read refuses.
    const fresh = await latestDraft();
    const c2 = JSON.parse(JSON.stringify(await card(fresh.id)));
    expect(await browser.formSubmitPrecheck(c2)).toBe('');
    await q('UPDATE cases SET case_caption = ? WHERE case_id = ?', ['In re Someone Else', CASE]);
    expect(await browser.formSubmitPrecheck(c2)).toBe('case 26-20001 changed since this card was prepared — the columns the submit writes, and what it compares the answers with, may differ. Nothing was submitted. Ask Casey to prepare it again.');
  });

  test('an older schema_version: the card refuses naming both; the route 409s naming both; nothing moves', async () => {
    await saveDraft({ ...SAME, trustee: 'Old Version' }, 1);
    const draft = await latestDraft();
    await expect(card(draft.id)).rejects.toThrow(/^OLD FORM VERSION refused: draft #\d+ was saved on version 1 of "Case Sheet"; the published form is version 2\. The route refuses it \(409\)/);
    const res = await route({ submission_id: draft.id, expected_updated_at: draft.updated_at });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(`Draft ${draft.id} was saved on version 1 of this form; the published form is version 2 — re-save the draft on the current version first`);
    expect([res.body.draft_schema_version, res.body.schema_version]).toEqual([1, 2]);
    await nothingMoved();
  });
});
