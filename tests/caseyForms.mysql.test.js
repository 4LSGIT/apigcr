// tests/caseyForms.mysql.test.js
//
/**
 * A12 on REAL MySQL: the native form routes every Casey form refusal and the
 * carry-forward rest on — routes/api.forms.js, real handlers, real
 * formService, real logService, real pool, under the production sql_mode —
 * plus the normalizer's own SQL (the template, the target's people and their
 * phones / emails, the version, the intake gate, the pipeline steps) and the
 * browser's click-time re-reads and answer checks (extracted from
 * public/assistant.html) over the REAL GET / POST / PATCH payloads.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a12_test npx jest tests/caseyForms.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them (the caseyPipeline.mysql hygiene).
 * The log write uses CONVERT_TZ(…, 'EST5EDT'): the server needs its tz tables
 * (mysql_tzinfo_to_sql) or log_date is NULL and the insert fails.
 *
 * WHAT IS LOCKED
 *   - THE WHOLESALE REPLACE: a second POST /api/forms/draft for the same
 *     (form, record) keeps the row id and REPLACES data — answers it does not
 *     carry are gone — and stamps the body's schema_version (1 when the body
 *     omits it). The carry-forward rests on the first; the card's
 *     template-version body on the second.
 *   - THE DRAFT KEY: one draft per (form_key, link_type, link_id) — a raw
 *     second draft insert is a duplicate, also when the form_key differs only
 *     in case (general_ci); submitted rows never collide (NULL draft_key).
 *   - The route's additive echo (form_key, link_type, link_id) — the yc-sync
 *     address.
 *   - THE LINK ROUTE: 400 for a draft, 409 for an already-linked row and for
 *     another link type than the template's, 404 for an unknown submission or
 *     target; a link renumbers the version to MAX+1 of the TARGET series,
 *     stamps linked_by, writes ONE 'form' log entry with the fixed wording,
 *     stamps the intake gate only when it is '' (a set pointer is left alone); a second link
 *     is 409 and writes nothing.
 *   - The normalizer over real rows: the template's JSON definition, the
 *     carry-forward, the people / phones / emails identity rule, the MAX
 *     version, the intake read and the pipeline-step JSON predicate
 *     (case-insensitive form_key, active only).
 *   - The browser's prechecks pass on a fresh card (the SHA-256 of the
 *     canonical stored draft, the ISO updated_at round trip) and refuse after
 *     a change; the answer checks accept the real answers.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
const { normalizeActionDraft, formTemplateRead } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'contact_phones', 'contact_emails', 'users', 'log',
  'form_templates', 'form_submissions', 'pipeline_stage_requirements'];

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
  const max = /const FORM_DATA_MAX_BYTES = [^;]+;/.exec(html);
  if (!max) throw new Error('FORM_DATA_MAX_BYTES not found');
  const names = ['formCanonical', 'formDataHash', 'formIso', 'formRecordLabel', 'formTitle', 'formRecordPath', 'formDraftRequest', 'formDraftPrecheck',
    'formDraftResult', 'formLinkRequest', 'formLinkPrecheck', 'formLinkResult'];
  const src = `${max[0]}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { formDraftRequest, formDraftPrecheck, formDraftResult, formLinkRequest, formLinkPrecheck, formLinkResult };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

const DEF = {
  dataMode: 'snapshot',
  sections: [{ rows: [{ fields: [
    { name: 'trustee_name', label: 'Trustee', type: 'text', required: true },
    { name: 'outcome', label: 'Outcome', type: 'select', options: ['Concluded', 'Continued'] },
    { name: 'attended', label: 'Attended', type: 'checkbox' },
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'phone', label: 'Phone', type: 'text', mask: 'phone' },
    { name: 'email', label: 'Email', type: 'text' },
  ] }] }],
};

d('the Casey form cards on real MySQL (A12)', () => {
  let pool; let reportPool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A12CASE1'; const C2 = 'A12CASE2';

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
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth) VALUES
      (2, 'stuart', 'Stuart', 'Stuart', 'S', 'SS', 'authorized'), (6, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized')`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype, case_intake_form) VALUES
      (?, '25-70001', 'Bankruptcy', 'Chapter 7', ''), (?, '25-70002', 'Bankruptcy', 'Chapter 13', '58321')`, [C1, C2]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname, contact_phone, contact_email) VALUES
      (7001, 'person', 'Dana Q. Debtor', 'Dana', 'Debtor', '3135551212', 'dana@example.com'),
      (7002, 'person', 'Other Client', 'Other', 'Client', '', '')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (951, ?, 7001, 'Primary'), (952, ?, 7002, 'Primary')`, [C1, C2]);
    await q(`INSERT INTO contact_phones (id, contact_id, phone, end_date) VALUES (81, 7001, '2485550000', '2025-01-01')`);
    await q(`INSERT INTO contact_emails (id, contact_id, email) VALUES (91, 7001, 'Dana.Work@Example.com')`);
    await q(`INSERT INTO form_templates (id, form_key, title, link_type, schema_version, definition, draft_definition, published_at, visibility) VALUES
      (1, '341_notes', '341 Notes', 'case', 3, ?, '{}', '2026-10-01 00:00:00', 'internal'),
      (2, 'issn', 'ISSN', 'case', 1, NULL, '{}', NULL, 'internal'),
      (3, 'intake', 'Intake', 'case', 2, ?, '{}', '2026-10-01 00:00:00', 'public'),
      (4, 'contact_card', 'Contact card', 'contact', 1, ?, '{}', '2026-10-01 00:00:00', 'internal')`,
    [JSON.stringify(DEF), JSON.stringify(DEF), JSON.stringify(DEF)]);
    await q(`INSERT INTO pipeline_stage_requirements (id, stage_id, requirement_key, internal_label, detector, detector_config, active) VALUES
      (1, 10, 'intake_in', 'Intake received', 'form', '{"form_key":"INTAKE"}', 1),
      (2, 11, 'intake_old', 'Old intake step', 'form', '{"form_key":"intake"}', 0),
      (3, 12, 'notes', '341 notes taken', 'form', '{"form_key":"341_notes"}', 1)`);
  }

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
    app.use(require('../routes/api.forms'));
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

  beforeEach(seed);

  const draftOf = async (key, linkType, linkId) => (await q(
    "SELECT id, data, schema_version, submitted_by FROM form_submissions WHERE form_key = ? AND link_type = ? AND link_id = ? AND status = 'draft'", [key, linkType, linkId]));

  test('THE WHOLESALE REPLACE — a second draft POST keeps the row and replaces data whole; the body\'s schema_version (1 when omitted); the echo', async () => {
    const a = await call(app, 'POST', '/api/forms/draft', { form_key: '341_notes', link_type: 'case', link_id: C1, schema_version: 3, data: { trustee_name: 'Old', outcome: 'Continued' } });
    expect([a.status, a.body.form_key, a.body.link_type, a.body.link_id, typeof a.body.id]).toEqual([200, '341_notes', 'case', C1, 'number']);
    const b = await call(app, 'POST', '/api/forms/draft', { form_key: '341_notes', link_type: 'case', link_id: C1, data: { attended: true } });
    expect([b.status, b.body.id]).toEqual([200, a.body.id]);
    const rows = await draftOf('341_notes', 'case', C1);
    expect(rows).toEqual([{ id: a.body.id, data: { attended: true }, schema_version: 1, submitted_by: 6 }]);
  });

  test('THE DRAFT KEY — one draft per (form, record), case-folded; submitted rows never collide', async () => {
    await q("INSERT INTO form_submissions (form_key, link_type, link_id, status, data) VALUES ('341_notes', 'case', ?, 'draft', '{}')", [C1]);
    await expect(q("INSERT INTO form_submissions (form_key, link_type, link_id, status, data) VALUES ('341_notes', 'case', ?, 'draft', '{}')", [C1]))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(q("INSERT INTO form_submissions (form_key, link_type, link_id, status, data) VALUES ('341_NOTES', 'case', ?, 'draft', '{}')", [C1.toLowerCase()]))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await q("INSERT INTO form_submissions (form_key, link_type, link_id, status, version, data) VALUES ('341_notes', 'case', ?, 'submitted', 1, '{}'), ('341_notes', 'case', ?, 'submitted', 2, '{}')", [C1, C1]);
    expect((await q('SELECT COUNT(*) AS n FROM form_submissions'))[0].n).toBe(3);
  });

  test('the form.template read over the real JSON column: published fields, an unpublished head', async () => {
    const pub = await formTemplateRead(pool, '341_notes');
    expect(pub.rows[0]).toMatchObject({ row_type: 'template', title: '341 Notes', published: 1, schema_version: 3, field_count: 6, published_at: '2026-10-01T00:00:00.000Z' });
    expect(pub.rows.slice(1).map((r) => r.key)).toEqual(['trustee_name', 'outcome', 'attended', 'name', 'phone', 'email']);
    const un = await formTemplateRead(pool, 'ISSN');
    expect([un.rows.length, un.rows[0].form_key, un.rows[0].published]).toEqual([1, 'issn', 0]);
  });

  test('the draft card over real rows: the carry-forward, the real route, the stored payload is the card\'s data; the browser re-read passes, then refuses', async () => {
    await call(app, 'POST', '/api/forms/draft', { form_key: '341_notes', link_type: 'case', link_id: C1, schema_version: 2,
      data: { outcome: 'Continued', trustee_name: 'Old Trustee', stale_key: 'kept' } });
    // Stuart saved it (the 24-hour danger names him).
    await q("UPDATE form_submissions SET submitted_by = 2 WHERE form_key = '341_notes' AND status = 'draft'");
    const ev = [{ id: 'q1', kind: 'form.template', rows: [{ row_type: 'template', form_key: '341_notes' }] }, { id: 'q2', rows: [{ case_id: C1 }] }];
    const c = await normalizeActionDraft(pool, { kind: 'form.draft.v1', form_key: '341_notes', link_type: 'case', link_id: C1,
      data: { trustee_name: 'Jane Trustee', attended: true }, evidence: [{ query_id: 'q2', row_number: 1 }] }, ev, { currentUserId: 6 });
    expect(c.data).toEqual({ outcome: 'Continued', trustee_name: 'Jane Trustee', stale_key: 'kept', attended: true });
    expect([c.carried, c.existing.saved_by, c.warnings[0].slice(0, 46)]).toEqual([{ count: 2, off_form: 1 }, 'Stuart (user #2)', 'RECENT DRAFT BY SOMEONE ELSE: Stuart (user #2)']);
    expect(await browser.formDraftPrecheck(c)).toBe('');
    const req = browser.formDraftRequest(c);
    expect(req).toEqual({ path: '/api/forms/draft', method: 'POST', body: { form_key: '341_notes', link_type: 'case', link_id: C1, schema_version: 3, data: c.data } });
    const res = await call(app, req.method, req.path, req.body);
    expect(browser.formDraftResult(c, res.body)).toEqual({ submission_id: c.expected.draft_id });
    const [row] = await draftOf('341_notes', 'case', C1);
    expect([row.data, row.schema_version, row.submitted_by]).toEqual([c.data, 3, 6]);
    // The stored draft changed (its data and its updated_at): the same card now refuses.
    expect(await browser.formDraftPrecheck(c)).toMatch(/^The draft of "341 Notes" for case 25-70001 changed since this card was prepared \(someone saved it — last by Fred\)/);
    // A card prepared with NO draft refuses once a draft appears; one prepared over a draft refuses once it is discarded.
    const fresh = await normalizeActionDraft(pool, { kind: 'form.draft.v1', form_key: '341_notes', link_type: 'case', link_id: C2,
      data: { trustee_name: 'X' }, evidence: [{ query_id: 'q2', row_number: 1 }] }, [ev[0], { id: 'q2', rows: [{ case_id: C2 }] }], { currentUserId: 6 });
    expect([fresh.expected, await browser.formDraftPrecheck(fresh)]).toEqual([{ draft_id: null, updated_at: null, data_hash: null }, '']);
    await call(app, 'POST', '/api/forms/draft', { form_key: '341_notes', link_type: 'case', link_id: C2, data: { attended: false } });
    expect(await browser.formDraftPrecheck(fresh)).toMatch(/^Someone saved a draft of "341 Notes" for case 25-70002 since this card was prepared/);
    await call(app, 'DELETE', `/api/forms/draft?form_key=341_notes&link_type=case&link_id=${C1}`);
    expect(await browser.formDraftPrecheck(c)).toMatch(/^The draft of "341 Notes" for case 25-70001 was discarded or submitted since this card was prepared/);
  });

  test('THE LINK ROUTE — 400 draft, 404 unknown / no target, 409 already linked and wrong link type; nothing written by any of them', async () => {
    await q(`INSERT INTO form_submissions (id, form_key, link_type, link_id, status, version, data) VALUES
      (500, 'intake', '', '', 'draft', 0, '{}'), (501, 'intake', 'case', ?, 'submitted', 1, '{}'), (502, 'intake', '', '', 'submitted', 9, '{}')`, [C2]);
    const link = (id, body) => call(app, 'PATCH', `/api/forms/submissions/${id}/link`, body);
    expect(await link(500, { link_type: 'case', link_id: C1 })).toEqual({ status: 400, body: { status: 'error', message: 'Only submitted submissions can be linked' } });
    expect(await link(999, { link_type: 'case', link_id: C1 })).toEqual({ status: 404, body: { status: 'error', message: 'Submission 999 not found' } });
    expect(await link(501, { link_type: 'case', link_id: C1 })).toEqual({ status: 409, body: { status: 'error', message: `Submission 501 is already linked (case ${C2})` } });
    expect(await link(502, { link_type: 'contact', link_id: '7001' })).toEqual({ status: 409, body: { status: 'error', message: 'Form "intake" is a case-linked form — it cannot be linked to a contact' } });
    expect(await link(502, { link_type: 'case', link_id: 'NOPE0000' })).toEqual({ status: 404, body: { status: 'error', message: 'case "NOPE0000" not found' } });
    expect([(await q('SELECT link_type, version FROM form_submissions WHERE id = 502'))[0], (await q('SELECT COUNT(*) AS n FROM log'))[0].n]).toEqual([{ link_type: '', version: 9 }, 0]);
  });

  test('the link card over real rows, then the real route: identity, MAX+1 version, the log entry, the intake gate, the pipeline step; the browser checks', async () => {
    await q(`INSERT INTO form_submissions (id, form_key, link_type, link_id, status, version, data, created_at) VALUES
      (601, 'intake', 'case', ?, 'submitted', 4, '{}', '2026-10-01 00:00:00'),
      (602, 'intake', '', '', 'submitted', 31, ?, '2026-10-30 15:04:00'),
      (603, 'intake', '', '', 'submitted', 32, ?, '2026-10-30 16:00:00')`,
    [C1, JSON.stringify({ name: 'dana debtor', phone: '248-555-0000', email: 'dana.work@example.com' }), JSON.stringify({ name: 'Robert Smith', phone: '3135559999' })]);
    // The report pool hands BIGINT ids back as strings: such an evidence row cites the submission.
    const [[subRow]] = await reportPool.query('SELECT id AS submission_id FROM form_submissions WHERE id = 602');
    expect(subRow.submission_id).toBe('602');
    const ev = [{ id: 'q1', rows: [subRow, { submission_id: 603 }] }, { id: 'q2', rows: [{ case_id: C1 }, { case_id: C2 }] }];
    const c = await normalizeActionDraft(pool, { kind: 'form.submission.link.v1', submission_id: 602, link_type: 'case', link_id: C1,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, ev, { currentUserId: 6 });
    // The phone is an ENDED contact_phones row, the email a contact_emails row in another case.
    expect(c.identity.map((x) => x.matched)).toEqual(['Dana Q. Debtor', 'Dana Q. Debtor', 'Dana Q. Debtor']);
    expect([c.warnings, c.version_after, c.expected]).toEqual([[], 5, { status: 'submitted', link_type: '', link_id: '', version: 31 }]);
    expect(c.effects).toContain('Intake gate: the case\'s intake-form pointer is empty, so it is stamped "yf:602" — the intake reminder sequences stop asking for an intake form.');
    expect(c.effects).toContain('Pipeline steps: "Intake received" look for a submitted "intake" form on the case — on this case they read as done from now on.');
    expect(await browser.formLinkPrecheck(c)).toBe('');
    const req = browser.formLinkRequest(c);
    expect(req).toEqual({ path: '/api/forms/submissions/602/link', method: 'PATCH', body: { link_type: 'case', link_id: C1 } });
    const res = await call(app, req.method, req.path, req.body);
    expect(res.body).toEqual({ status: 'success', id: 602, link_type: 'case', link_id: C1, version: 5, linked_by: 6, intake_stamped: true, logged: true });
    expect(browser.formLinkResult(c, res.body)).toEqual({ submission_id: 602 });
    expect((await q('SELECT link_type, link_id, version, linked_by, linked_at IS NOT NULL AS stamped FROM form_submissions WHERE id = 602'))[0])
      .toEqual({ link_type: 'case', link_id: C1, version: 5, linked_by: 6, stamped: 1 });
    expect((await q('SELECT case_intake_form FROM cases WHERE case_id = ?', [C1]))[0].case_intake_form).toBe('yf:602');
    const logs = await q('SELECT log_type, log_link_type, log_link_id, log_by, log_subject, log_message, log_date IS NOT NULL AS dated FROM log');
    expect(logs).toEqual([{ log_type: 'form', log_link_type: 'case', log_link_id: C1, log_by: 6, log_subject: 'Form adopted: Intake',
      log_message: 'Intake submission #602 (received unlinked) was linked to this case from the Form Inbox.', dated: 1 }]);
    // The card's log line quotes exactly that wording.
    expect(c.effects.find((e) => /^Log:/.test(e))).toContain('subject "Form adopted: Intake", message "Intake submission #602 (received unlinked) was linked to this case from the Form Inbox."');
    // Now linked: the re-read refuses, and the route's own second answer is a 409 that writes nothing.
    expect(await browser.formLinkPrecheck(c)).toMatch(/^Submission #602 is already linked \(case A12CASE1\) — someone linked it since/);
    expect((await call(app, req.method, req.path, req.body)).status).toBe(409);
    expect((await q('SELECT COUNT(*) AS n FROM log'))[0].n).toBe(1);
    // A mismatched submission on a case whose intake pointer is already set (a legacy JotForm id; the
    // column is NOT NULL, so '' is the only "unset"): the danger warning, and the gate is left alone.
    const bad = await normalizeActionDraft(pool, { kind: 'form.submission.link.v1', submission_id: 603, link_type: 'case', link_id: C2,
      evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 2 }] }, ev, { currentUserId: 6 });
    expect(bad.warnings).toEqual(['IDENTITY MISMATCH: the submission\'s name "Robert Smith", phone "3135559999" match no contact on this case (Other Client, Primary). Check it is the right person before linking — the route never unlinks.']);
    expect(bad.version_after).toBe(1);
    expect(bad.effects).toContain('Intake gate: the case\'s intake-form pointer already reads "58321" — not changed.');
    const res2 = await call(app, 'PATCH', '/api/forms/submissions/603/link', { link_type: 'case', link_id: C2 });
    expect([res2.body.version, res2.body.intake_stamped]).toEqual([1, false]);
    expect((await q('SELECT case_intake_form FROM cases WHERE case_id = ?', [C2]))[0].case_intake_form).toBe('58321');
  });

  test('a contact-linked form: the contact\'s own phones and emails', async () => {
    await q("INSERT INTO form_submissions (id, form_key, link_type, link_id, status, version, data) VALUES (701, 'contact_card', '', '', 'submitted', 1, ?)",
      [JSON.stringify({ name: 'Dana Debtor', email: 'DANA@example.com' })]);
    const c = await normalizeActionDraft(pool, { kind: 'form.submission.link.v1', submission_id: 701, link_type: 'contact', link_id: 7001,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] },
    [{ id: 'q1', rows: [{ submission_id: 701 }] }, { id: 'q2', rows: [{ contact_id: 7001 }] }], { currentUserId: 6 });
    expect([c.warnings, c.identity.map((x) => x.matched), c.target.label]).toEqual([[], ['Dana Q. Debtor', 'Dana Q. Debtor'], 'Dana Q. Debtor (contact #7001)']);
    expect(await browser.formLinkPrecheck(c)).toBe('');
    const res = await call(app, 'PATCH', '/api/forms/submissions/701/link', { link_type: 'contact', link_id: '7001' });
    expect(browser.formLinkResult(c, res.body)).toEqual({ submission_id: 701 });
  });
});
