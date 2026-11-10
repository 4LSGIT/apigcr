// tests/caseyFormDiscardPdf.mysql.test.js
//
/**
 * A12.2 on REAL MySQL: the routes the discard and PDF cards drive —
 * routes/api.forms.js, real handlers, real formService / formPdfService /
 * filePlacementService / documentIngestService / documentService, real pool,
 * under the production sql_mode — plus the normalizers' own SQL (the stored
 * draft, the template, the appointment, the placement reads, the copies
 * heuristic) and the browser's click-time re-reads, request builders, answer
 * checks and outcome mapping (extracted from public/assistant.html) over the
 * REAL answers.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a122_test npx jest tests/caseyFormDiscardPdf.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (the
 * production proxy). This suite DROPS and recreates its tables, cloned from
 * ref/database.sql, with FOREIGN_KEY_CHECKS off in the before-hook AND the
 * after-hook, taking any sibling-built child of ours with it (the
 * caseyForms.mysql hygiene). The log write uses CONVERT_TZ(…, 'EST5EDT'): the
 * server needs its tz tables (mysql_tzinfo_to_sql).
 *
 * DROPBOX AND THE PDF RENDERER ARE STUBBED AT THEIR BOUNDARIES:
 * pdfRenderService.renderHtmlToPdf returns fixed bytes (no chromium);
 * dropboxService keeps its real helpers (joinPath) and stubs the five network
 * calls the ladder makes — _resolveCredential, resolveLocation (the case's
 * cached folder, lowercased as the real one returns it), createFolder,
 * uploadFile (modelling `mode:'add', autorename:true`: a taken path gets
 * " (1)", " (2)" … before the extension, and the answer is a FileMetadata
 * entry) and getTemporaryLink. Everything above them is real. Nothing here
 * reaches Dropbox or a browser engine. domainEvents.emit is observed, not run.
 *
 * WHAT IS LOCKED
 *   - THE DISCARD ROUTE deletes exactly the one draft row of (form, record),
 *     matched under general_ci, answers {deleted:true} — and {deleted:false}
 *     when nothing matches (the browser's refusal); submitted rows are never
 *     touched; a request with no query is the route's 400.
 *   - The discard card over real rows: the browser's re-read passes, the real
 *     DELETE removes the row, the re-read then refuses; a draft saved after the
 *     card was prepared makes the re-read refuse; an appointment draft re-reads
 *     the appointment.
 *   - THE PDF ROUTE IS NOT IDEMPOTENT: a filing registers ONE document (linked
 *     to the case) and a second filing a SECOND one under Dropbox's autorename
 *     — so the card's ALREADY FILED warning is load-bearing: a card prepared
 *     after the first filing counts it. The card's predicted file name and
 *     folder are the route's; an unlinked submission's identity prefix and an
 *     unlinked registration are the route's too.
 *   - The route's own 404s and its draft render refusal (a 500 with an exact
 *     message, before any upload) beside the card's refusals; the browser
 *     reads them as refusals.
 *   - The PDF re-read refuses after the submission is linked by hand.
 *   - An appointment-linked form: the real link route links it (version, log
 *     row on the appointment) and the card named the appointment.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js),
// the event queue (observed, not run), and the two providers (see the header).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/pdfRenderService', () => ({ renderHtmlToPdf: jest.fn(async () => Buffer.from('%PDF-1.7 fake')) }));
jest.mock('../services/dropboxService', () => {
  const real = jest.requireActual('../services/dropboxService');
  const taken = new Set();
  let n = 0;
  return {
    ...real,
    __taken: taken,
    _resolveCredential: jest.fn(async () => 8),
    resolveLocation: jest.fn(async () => '/active cases/debtor, dana'),
    createFolder: jest.fn(async (_db, { path: p }) => ({ path: p, existed: false })),
    uploadFile: jest.fn(async (_db, { path: p, mode, autorename }) => {
      if (mode !== 'add' || autorename !== true) throw new Error('the ladder uploads with mode add + autorename');
      let out = p;
      for (let i = 1; taken.has(out.toLowerCase()); i++) out = p.replace(/(\.[^./]+)$/, ` (${i})$1`);
      taken.add(out.toLowerCase());
      n += 1;
      return { '.tag': 'file', id: `id:a122file${n}`, name: out.split('/').pop(), path_display: out, path_lower: out.toLowerCase(),
        rev: `r${n}`, size: 13, content_hash: null, server_modified: '2026-11-10T12:00:00Z' };
    }),
    getTemporaryLink: jest.fn(async () => ({ link: 'https://dl.example/temp', metadata: null })),
  };
});
const dropbox = require('../services/dropboxService');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'contact_phones', 'contact_emails', 'users', 'log', 'appts', 'form_templates',
  'form_template_versions', 'form_submissions', 'documents', 'document_links', 'case_folder_cache', 'app_settings', 'trigger_rules'];

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
// `api` that calls the real routes.
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
  const consts = ['FORM_PDF_PLACEMENTS', 'FORM_PDF_WARNINGS_KEPT'].map((n) => {
    const m = new RegExp(`const ${n} = [^;]+;`).exec(html);
    if (!m) throw new Error(`${n} not found`);
    return m[0];
  });
  const names = ['formCanonical', 'formDataHash', 'formIso', 'formRecordLabel', 'formTitle', 'formRecordPath', 'formDiscardRequest', 'formDiscardPrecheck',
    'formDiscardResult', 'formDiscardKnownOutcome', 'formPdfRequest', 'formPdfPrecheck', 'formPdfResult', 'formPdfKnownOutcome', 'formLinkRequest', 'formLinkPrecheck', 'formLinkResult'];
  const src = `${consts.join('\n')}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

const DEF = {
  sections: [{ rows: [{ fields: [
    { name: 'trustee_name', label: 'Trustee', type: 'text', required: true },
    { name: 'attended', label: 'Attended', type: 'checkbox' },
    { name: 'name', label: 'Name', type: 'text' },
  ] }] }],
};

d('the Casey form discard and PDF cards on real MySQL (A12.2)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A122CAS1';

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
    dropbox.__taken.clear();
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth) VALUES
      (2, 'stuart', 'Stuart', 'Stuart', 'S', 'SS', 'authorized'), (6, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized')`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_dropbox, case_intake_form) VALUES
      (?, '25-80001', 'Bankruptcy', 'https://www.dropbox.com/sh/a122case', '')`, [C1]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname, contact_phone, contact_email) VALUES
      (8001, 'person', 'Dana Q. Debtor', 'Dana', 'Debtor', '3135551212', 'dana@example.com')`);
    await q("INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (961, ?, 8001, 'Primary')", [C1]);
    await q("INSERT INTO case_folder_cache (case_id, path_lower) VALUES (?, '/active cases/debtor, dana')", [C1]);
    await q(`INSERT INTO appts (appt_id, appt_client_id, appt_case_id, appt_type, appt_date, appt_length, appt_platform, appt_status, appt_with)
      VALUES (8812, 8001, '', 'Consultation', '2026-11-20 14:30:00', 30, 'Zoom', 'Scheduled', 6)`);
    await q(`INSERT INTO form_templates (id, form_key, title, link_type, schema_version, definition, draft_definition, published_at, visibility) VALUES
      (1, '341_notes', '341 Notes', 'case', 3, ?, '{}', '2026-10-01 00:00:00', 'internal'),
      (2, 'appt_prep', 'Appointment prep', 'appt', 1, ?, '{}', '2026-10-01 00:00:00', 'internal'),
      (3, 'intake', 'Intake', 'case', 2, ?, '{}', '2026-10-01 00:00:00', 'public')`,
    [JSON.stringify(DEF), JSON.stringify(DEF), JSON.stringify(DEF)]);
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
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.forms'));
    // The page's api(path, body, method): a non-2xx throws with .status and .body (apiSend's contract).
    browser = browserChecks(async (p, body, method) => {
      if (/^\/api\/(cases|contacts|appts)\//.test(p)) {
        const [kind, id] = p.split('/').slice(2);
        const sql = { cases: 'SELECT case_id FROM cases WHERE case_id = ?', contacts: 'SELECT contact_id FROM contacts WHERE contact_id = ?', appts: 'SELECT appt_id FROM appts WHERE appt_id = ?' }[kind];
        const rows = await q(sql, [decodeURIComponent(id)]);
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
  });

  beforeEach(seed);

  const draftCount = async () => (await q("SELECT COUNT(*) AS n FROM form_submissions WHERE status = 'draft'"))[0].n;

  test('THE DISCARD ROUTE — deletes exactly the one draft (general_ci), {deleted:false} on nothing, never a submission; no query is a 400', async () => {
    await q(`INSERT INTO form_submissions (id, form_key, link_type, link_id, status, version, data) VALUES
      (101, '341_notes', 'case', ?, 'draft', 0, '{"trustee_name":"A"}'), (102, '341_notes', 'case', ?, 'submitted', 1, '{}'),
      (103, 'intake', 'case', ?, 'draft', 0, '{}')`, [C1, C1, C1]);
    const del = (qs) => call(app, 'DELETE', `/api/forms/draft?${qs}`);
    expect(await del(`form_key=341_NOTES&link_type=case&link_id=${C1.toLowerCase()}`)).toEqual({ status: 200, body: { status: 'success', deleted: true } });
    expect((await q('SELECT id FROM form_submissions ORDER BY id')).map((r) => r.id)).toEqual([102, 103]);
    expect(await del(`form_key=341_notes&link_type=case&link_id=${C1}`)).toEqual({ status: 200, body: { status: 'success', deleted: false } });
    expect(await call(app, 'DELETE', '/api/forms/draft')).toEqual({ status: 400, body: { status: 'error', message: 'Missing required query params: form_key, link_type, link_id' } });
    expect((await q('SELECT COUNT(*) AS n FROM form_submissions'))[0].n).toBe(2);
  });

  test('the discard card over real rows: the re-read passes, the real DELETE, then the re-read and the route\'s second answer refuse', async () => {
    await call(app, 'POST', '/api/forms/draft', { form_key: '341_notes', link_type: 'case', link_id: C1, schema_version: 3, data: { trustee_name: 'Jane', attended: true, stale: 'x' } });
    const [row] = await q("SELECT id FROM form_submissions WHERE status = 'draft'");
    const ev = [{ id: 'q1', rows: [{ submission_id: String(row.id) }] }, { id: 'q2', rows: [{ case_id: C1 }] }];
    const card = { kind: 'form.draft.delete.v1', submission_id: row.id, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] };
    const c = JSON.parse(JSON.stringify(await normalizeActionDraft(pool, card, ev, { currentUserId: 6 })));
    // Listed in the stored order (MySQL re-orders JSON keys on write).
    expect([c.draft.saved_by, c.answers.map((a) => [a.key, a.label, a.off_form || false]).sort(), c.answers_total]).toEqual(['you',
      [['attended', 'Attended', false], ['stale', 'stale', true], ['trustee_name', 'Trustee', false]], 3]);
    expect(await browser.formDiscardPrecheck(c)).toBe('');
    const req = browser.formDiscardRequest(c);
    expect(req).toEqual({ path: `/api/forms/draft?form_key=341_notes&link_type=case&link_id=${C1}`, method: 'DELETE', body: null });
    const res = await call(app, req.method, req.path);
    expect(browser.formDiscardResult(c, res.body)).toEqual({ submission_id: row.id });
    expect(await draftCount()).toBe(0);
    expect(await browser.formDiscardPrecheck(c)).toMatch(/^The draft of "341 Notes" for case 25-80001 is already gone/);
    const again = await call(app, req.method, req.path);
    let err; try { browser.formDiscardResult(c, again.body); } catch (e) { err = e; }
    expect(browser.formDiscardKnownOutcome(err).status).toBe('Refused — nothing deleted');
  });

  test('the discard re-read refuses after a hand edit (a draft saved since); an appointment draft re-reads the appointment', async () => {
    await call(app, 'POST', '/api/forms/draft', { form_key: 'appt_prep', link_type: 'appt', link_id: '8812', schema_version: 1, data: { trustee_name: 'Jane' } });
    const [row] = await q("SELECT id FROM form_submissions WHERE status = 'draft'");
    const ev = [{ id: 'q1', rows: [{ submission_id: row.id }] }, { id: 'q2', rows: [{ appt_id: 8812 }] }];
    const c = JSON.parse(JSON.stringify(await normalizeActionDraft(pool, { kind: 'form.draft.delete.v1', submission_id: row.id,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, ev, { currentUserId: 6 })));
    expect(c.record).toEqual({ link_type: 'appt', link_id: '8812', label: 'appointment #8812 (Consultation, 2026-11-20 14:30 firm time, Dana Q. Debtor)' });
    expect(await browser.formDiscardPrecheck(c)).toBe('');
    // MySQL's updated_at has one-second resolution: wait it out so the re-save is visible in it, as a real later save is.
    await new Promise((r) => setTimeout(r, 1100));
    await call(app, 'POST', '/api/forms/draft', { form_key: 'appt_prep', link_type: 'appt', link_id: '8812', schema_version: 1, data: { trustee_name: 'Jane', attended: true } });
    expect(await browser.formDiscardPrecheck(c)).toMatch(/^The draft of "Appointment prep" for appointment #8812 .* changed since this card was prepared \(someone saved it — last by Fred\)\. Nothing was deleted/);
    expect(await draftCount()).toBe(1);
  }, 15000);

  test('THE PDF ROUTE IS NOT IDEMPOTENT — one document per filing, the second autorenamed; the card predicted the name and folder and counts the first copy', async () => {
    await q("INSERT INTO form_submissions (id, form_key, link_type, link_id, status, version, schema_version, data, created_at) VALUES (201, '341_notes', 'case', ?, 'submitted', 1, 3, ?, '2026-10-30 03:30:00')",
      [C1, JSON.stringify({ trustee_name: 'Jane' })]);
    const ev = [{ id: 'q1', rows: [{ submission_id: 201 }] }, { id: 'q2', rows: [{ case_id: C1 }] }];
    const card = { kind: 'form.pdf.file.v1', submission_id: 201, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] };
    const c1 = JSON.parse(JSON.stringify(await normalizeActionDraft(pool, card, ev, { currentUserId: 6 })));
    expect([c1.file_name, c1.placement, c1.copies, c1.warnings]).toEqual(['2026-10-29 341 Notes (#201).pdf',
      { rung: 'case', folder: '/active cases/debtor, dana/Forms' }, { count: 0, names: [] }, []]);
    expect(await browser.formPdfPrecheck(c1)).toBe('');
    const req = browser.formPdfRequest(c1);
    expect(req).toEqual({ path: '/api/forms/submissions/201/pdf/file', method: 'POST', body: null });
    const r1 = await call(app, req.method, req.path, req.body);
    expect([r1.status, r1.body.file_name, r1.body.path, r1.body.placement]).toEqual([200, c1.file_name, `${c1.placement.folder}/${c1.file_name}`, 'case']);
    expect(browser.formPdfResult(c1, r1.body)).toEqual({ submission_id: 201 });
    expect(c1.pdf_outcome.document_id).toBe(r1.body.document_id);
    expect(JSON.stringify(c1)).not.toContain('dl.example');
    const docs1 = await q('SELECT d.id, d.name, l.link_type, l.link_id FROM documents d LEFT JOIN document_links l ON l.document_id = d.id ORDER BY d.id');
    expect(docs1).toEqual([{ id: r1.body.document_id, name: '2026-10-29 341 Notes (#201).pdf', link_type: 'case', link_id: C1 }]);

    // A card prepared now sees the first copy — the warning the second filing earns.
    const c2 = JSON.parse(JSON.stringify(await normalizeActionDraft(pool, card, ev, { currentUserId: 6 })));
    expect(c2.warnings).toEqual(['ALREADY FILED: a copy named "2026-10-29 341 Notes (#201).pdf" already sits in Documents (1 active document named with "(#201)"); filing again makes a SECOND copy (the route autorenames) — Casey cannot see a copy filed under a custom name.']);
    const r2 = await call(app, req.method, req.path, req.body);
    expect(r2.body.file_name).toBe('2026-10-29 341 Notes (#201) (1).pdf');
    expect((await q('SELECT name FROM documents ORDER BY id')).map((x) => x.name)).toEqual(['2026-10-29 341 Notes (#201).pdf', '2026-10-29 341 Notes (#201) (1).pdf']);
    const c3 = await normalizeActionDraft(pool, card, ev, { currentUserId: 6 });
    expect(c3.copies.count).toBe(2);
    // A neighbour's number never counts: (#2010) is not (#201).
    await q("UPDATE documents SET name = '2026-10-29 341 Notes (#2010).pdf' WHERE name LIKE '%(1).pdf'");
    expect((await normalizeActionDraft(pool, card, ev, { currentUserId: 6 })).copies.count).toBe(1);
  });

  test('an unlinked submission: the route\'s identity prefix is the card\'s, the document links to nothing; a hand link makes the re-read refuse', async () => {
    await q("INSERT INTO form_submissions (id, form_key, link_type, link_id, status, version, schema_version, data, created_at) VALUES (301, 'intake', '', '', 'submitted', 4, 2, ?, '2026-11-02 15:00:00')",
      [JSON.stringify({ name: 'Robert Smith' })]);
    const ev = [{ id: 'q1', rows: [{ submission_id: 301 }] }];
    const c = JSON.parse(JSON.stringify(await normalizeActionDraft(pool, { kind: 'form.pdf.file.v1', submission_id: 301, filename: 'Smith intake',
      evidence: [{ query_id: 'q1', row_number: 1 }] }, ev, { currentUserId: 6 })));
    expect([c.record, c.file_name, c.placement]).toEqual([null, 'submission 301 - Robert Smith - Smith intake.pdf',
      { rung: 'unsorted', folder: '/  Law Office/   Cases/  Unsorted Form Submissions' }]);
    expect(await browser.formPdfPrecheck(c)).toBe('');
    const req = browser.formPdfRequest(c);
    expect(req.body).toEqual({ filename: 'Smith intake' });
    const res = await call(app, req.method, req.path, req.body);
    expect([res.body.file_name, res.body.placement, res.body.path]).toEqual([c.file_name, 'unsorted', `${c.placement.folder}/${c.file_name}`]);
    expect(await q('SELECT COUNT(*) AS n FROM document_links')).toEqual([{ n: 0 }]);
    expect((await q('SELECT COUNT(*) AS n FROM documents'))[0].n).toBe(1);
    // A custom name carries no "(#301)": the next card cannot see this copy, and says so.
    expect(c.effects).toContain('Name: your filename replaces the default "<date> Intake (#301)" — this copy\'s name carries no "(#301)", so a later card cannot see it.');
    await call(app, 'PATCH', '/api/forms/submissions/301/link', { link_type: 'case', link_id: C1 });
    expect(await browser.formPdfPrecheck(c)).toBe('Submission #301 changed since this card was prepared (it was linked — the PDF would land somewhere else). Nothing was filed. Ask Casey to prepare it again.');
  });

  test('the route\'s own 404s and its draft refusal (a 500 before any upload) beside the card\'s refusals; the browser reads them as refusals', async () => {
    await q(`INSERT INTO form_submissions (id, form_key, link_type, link_id, status, version, schema_version, data) VALUES
      (401, '341_notes', 'case', ?, 'draft', 0, 3, '{}'), (402, 'gone_form', '', '', 'submitted', 1, 1, '{}')`, [C1]);
    const uploads = dropbox.uploadFile.mock.calls.length;
    const file = (id) => call(app, 'POST', `/api/forms/submissions/${id}/pdf/file`);
    const known = (res) => browser.formPdfKnownOutcome(Object.assign(new Error(res.body.message), { status: res.status, body: res.body }));
    const r404 = await file(999);
    expect([r404.status, r404.body.message, known(r404).status]).toEqual([404, 'Submission 999 not found', 'Refused — nothing filed']);
    const rDraft = await file(401);
    expect([rDraft.status, rDraft.body.message, known(rDraft).status]).toEqual([500, 'submission 401 is a draft — only submitted forms can be rendered', 'Refused — nothing filed']);
    const rTpl = await file(402);
    expect([rTpl.status, rTpl.body.message, known(rTpl).status]).toEqual([404, 'No template exists for form_key "gone_form"', 'Refused — nothing filed']);
    expect([dropbox.uploadFile.mock.calls.length, (await q('SELECT COUNT(*) AS n FROM documents'))[0].n]).toEqual([uploads, 0]);
    // The card refuses each first.
    const ev = [{ id: 'q1', rows: [{ submission_id: 401 }, { submission_id: 402 }] }, { id: 'q2', rows: [{ case_id: C1 }] }];
    await expect(normalizeActionDraft(pool, { kind: 'form.pdf.file.v1', submission_id: 401, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, ev, { currentUserId: 6 }))
      .rejects.toThrow('A DRAFT has no PDF: #401 is a draft');
    await expect(normalizeActionDraft(pool, { kind: 'form.pdf.file.v1', submission_id: 402, evidence: [{ query_id: 'q1', row_number: 2 }] }, ev, { currentUserId: 6 }))
      .rejects.toThrow('The route cannot render submission #402: No template exists for form_key "gone_form"');
    await expect(normalizeActionDraft(pool, { kind: 'form.draft.delete.v1', submission_id: 402, evidence: [{ query_id: 'q1', row_number: 2 }] }, ev, { currentUserId: 6 }))
      .rejects.toThrow('#402 is a SUBMITTED form (version 1), not a draft');
  });

  test('an appointment-linked form: the card names the appointment; the real link route links it and logs on the appointment', async () => {
    await q("INSERT INTO form_submissions (id, form_key, link_type, link_id, status, version, data) VALUES (501, 'appt_prep', '', '', 'submitted', 7, ?)",
      [JSON.stringify({ name: 'Dana Debtor' })]);
    const ev = [{ id: 'q1', rows: [{ submission_id: 501 }] }, { id: 'q2', rows: [{ appt_id: 8812 }] }];
    const c = JSON.parse(JSON.stringify(await normalizeActionDraft(pool, { kind: 'form.submission.link.v1', submission_id: 501, link_type: 'appt', link_id: 8812,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }, ev, { currentUserId: 6 })));
    expect([c.target.label, c.identity.map((x) => x.matched), c.warnings, c.version_after]).toEqual(['appointment #8812 (Consultation, 2026-11-20 14:30 firm time, Dana Q. Debtor)', ['Dana Q. Debtor'], [], 1]);
    expect(await browser.formLinkPrecheck(c)).toBe('');
    const req = browser.formLinkRequest(c);
    expect(req).toEqual({ path: '/api/forms/submissions/501/link', method: 'PATCH', body: { link_type: 'appt', link_id: '8812' } });
    const res = await call(app, req.method, req.path, req.body);
    expect(browser.formLinkResult(c, res.body)).toEqual({ submission_id: 501 });
    expect((await q('SELECT log_link_type, log_link_id, log_message FROM log'))).toEqual([{ log_link_type: 'appt', log_link_id: '8812',
      log_message: 'Appointment prep submission #501 (received unlinked) was linked to this appt from the Form Inbox.' }]);
    expect(c.effects.find((e) => /^Log:/.test(e))).toContain('message "Appointment prep submission #501 (received unlinked) was linked to this appt from the Form Inbox."');
  });
});
