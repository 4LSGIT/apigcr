// tests/caseyDocumentsGenerate.mysql.test.js
//
/**
 * A11X on REAL MySQL: the generate and register cards' own SQL (the template
 * row and its source-PDF flag, the record and its primary contact, the
 * prefill resolution, the case folder cache, the registry lookups, the real
 * trigger-rule load and dry run), the NATIVE ROUTES they drive — POST
 * /api/documents/generate (documentGenerateService.generateFromTemplate end to
 * end: the real renderer boundary stubbed, the real filing ladder, the real
 * registry write and link) and POST /api/documents/register (the real
 * provider delegate, the real upsert) — under the production sql_mode, plus the
 * browser's click-time prechecks, request builders, answer checks and outcome
 * mapping (extracted from public/assistant.html) over the REAL answers.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a11x_test npx jest tests/caseyDocumentsGenerate.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (the
 * production proxy). This suite DROPS and recreates its tables, cloned from
 * ref/database.sql, with FOREIGN_KEY_CHECKS off in the before-hook AND the
 * after-hook, taking any sibling-built child of ours with it (the
 * caseyDocuments.mysql hygiene). tests/caseySyncRoots.mysql.test.js shares
 * this database and rebuilds its own tables the same way.
 *
 * THE PROVIDER IS STUBBED AT ITS OBJECT: dropboxService's uploadFile,
 * createFolder, resolveLocation, getTemporaryLink, getMetadata and listFolder
 * are jest.fns modelling Dropbox (a folder tree in memory, autorename on a
 * collision); normalizePath, joinPath, isPathNotFoundError and
 * _resolveCredential stay REAL. pdfRenderService.renderHtmlToPdf is a stub
 * (chromium never runs under jest); caseService.ensureCaseDropboxFolder,
 * taskService.createTask and esignAlertService.resolveAlertAssignee are
 * stubs observed for the rung-2 and rung-3 side effects. Everything else —
 * the esign template service, the prefill resolvers, the render service's
 * interpolation, the filing ladder, the ingest, the registry, the sync's
 * attribution sweep — is real. Nothing here reaches Dropbox or a browser.
 *
 * WHAT IS LOCKED
 *   - THE GENERATE, case rung: the card's predicted path IS the path the route
 *     writes; the route registers ONE documents row (the file's id, name,
 *     path, size) and ONE link to the case with the relation the card
 *     predicted ("path" — the file lands under the case's cached folder);
 *     document.created then document.linked are emitted with source
 *     generated_doc and the actor; the browser's result check receipts the
 *     row; no task is raised; the subfolder is created explicitly.
 *   - RUNG 2 (no case_dropbox): the card says AUTO-CREATE + the task; the route
 *     creates the folder (the stub), raises the task with that exact title,
 *     files under it and links with relation "upload" (no cache row) — the
 *     card's prediction.
 *   - A NAME COLLISION: Dropbox's autorename (the stub) names the second file
 *     "… (1).pdf"; the route reports the real path, nothing is overwritten, the
 *     result check still receipts the new row.
 *   - THE ROUTE'S OWN REFUSALS ARE THE AUTHORITY: a missing required value is
 *     the route's 400 ESIGN_MISSING_PREFILL (with `missing`), a signature-only
 *     template its 409 ESIGN_TEMPLATE_PURPOSE — nothing rendered or written;
 *     the browser reads both as refusals. The normalizer refuses each first in
 *     the same words.
 *   - THE REGISTER: the folder read on the real pool lists the entry with its
 *     id and whether the registry holds it; the card; the precheck through the
 *     REAL /api/dropbox/list route; the route writes ONE row (no link), emits
 *     document.created (manual, actor 6); a second apply is the route's 200
 *     created:false, read as "already registered"; the normalizer refuses the
 *     second card naming the row; the REAL sweep (attributeUnlinked) then
 *     links the registered file to the case whose cached folder holds it —
 *     exactly what the card said. A folder id is the route's 400; a file gone
 *     at the click is Dropbox's 409 through the route, read as a refusal.
 *   - NOTHING IS WRITTEN AT PROPOSAL: no documents / document_links / tasks
 *     rows and no provider write before the click.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/dropboxService', () => ({
  ...jest.requireActual('../services/dropboxService'),
  uploadFile: jest.fn(), createFolder: jest.fn(), resolveLocation: jest.fn(), getTemporaryLink: jest.fn(), getMetadata: jest.fn(), listFolder: jest.fn(),
}));
jest.mock('../services/pdfRenderService', () => ({ renderHtmlToPdf: jest.fn(async (html) => Buffer.from(`%PDF-1.7 twin ${html}`)) }));
jest.mock('../services/caseService', () => ({ ...jest.requireActual('../services/caseService'), ensureCaseDropboxFolder: jest.fn() }));
jest.mock('../services/taskService', () => ({ ...jest.requireActual('../services/taskService'), createTask: jest.fn(async () => ({ task_id: 77 })) }));
jest.mock('../services/esignAlertService', () => ({ ...jest.requireActual('../services/esignAlertService'), resolveAlertAssignee: jest.fn(async () => 22) }));
const domainEvents = require('../lib/domainEvents');
const dropbox = require('../services/dropboxService');
const pdfRender = require('../services/pdfRenderService');
const caseService = require('../services/caseService');
const taskService = require('../services/taskService');
const esignTemplateService = require('../services/esignTemplateService');
const sync = require('../services/documentSyncService');
const { nowLocal } = require('../services/timezoneService');
const { normalizeActionDraft, documentFolderRead, documentTemplatesRead, compactRows } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'documents', 'document_links', 'case_folder_cache', 'document_sync_roots', 'app_settings',
  'contract_templates', 'contract_template_pdfs', 'trigger_rules', 'trigger_rule_actions'];

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
  const consts = ['DOCREGISTER_LIST_MAX', 'DOCGENERATE_NAME_MAX'].map((n) => { const m = new RegExp(`const ${n} = \\d+;`).exec(html); if (!m) throw new Error(`${n} not found`); return m[0]; });
  const names = ['documentSize', 'docgenerateLabel', 'docgenerateTargetLabel', 'docgenerateBody', 'docgenerateRequest', 'docgeneratePrecheck', 'docgenerateResult', 'docgenerateKnownOutcome',
    'docregisterLabel', 'docregisterBody', 'docregisterRequest', 'docregisterPrecheck', 'docregisterResult', 'docregisterKnownOutcome'];
  const src = `${consts.join('\n')}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey document generate / register cards on real MySQL (A11X)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A11XCAS1'; const C2 = 'A11XCAS2';
  const ROOT = '/  Law Office/   Cases/  Active Cases';
  const FOLDER1 = `${ROOT}/ 7 - Debtor, Dana - 25-70001`;
  const LINK1 = 'https://www.dropbox.com/scl/fo/c1/folder?rlkey=1';
  const TODAY = nowLocal().toFormat('yyyy-MM-dd');
  // Dropbox, modelled: a map of lowercased folder paths → entries; files by id.
  let tree; let files; let uploads;
  const lower = (p) => String(p).toLowerCase();
  const notFound = () => Object.assign(new Error('dropbox: POST /2/files/get_metadata → 409: path/not_found/..'), { status: 409, errorSummary: 'path/not_found/..' });
  function model() {
    tree = new Map(); files = new Map(); uploads = [];
    const file = (id, folder, name, size) => {
      const meta = { '.tag': 'file', id, name, path_display: `${folder}/${name}`, path_lower: lower(`${folder}/${name}`), size, rev: `r${id.slice(-3)}`, server_modified: '2026-10-02T10:00:00Z', content_hash: 'h'.repeat(64) };
      files.set(id, meta); files.set(meta.path_lower, meta);
      if (!tree.has(lower(folder))) tree.set(lower(folder), []);
      tree.get(lower(folder)).push(meta);
      return meta;
    };
    tree.set(lower(FOLDER1), []);
    tree.set(lower(`${FOLDER1}/Scans`), []);
    const sub = { '.tag': 'folder', id: 'id:SUBSCANS1', name: 'Scans', path_display: `${FOLDER1}/Scans`, path_lower: lower(`${FOLDER1}/Scans`) };
    tree.get(lower(FOLDER1)).push(sub); files.set(sub.id, sub);
    file('id:A11XPAY001', FOLDER1, 'Paystub.pdf', 1024);
    file('id:A11XPET001', FOLDER1, 'Petition.pdf', 2048);
  }
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
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type, case_subtype, case_dropbox) VALUES
      (?, '25-70001', '25-70001-abc', 'Bankruptcy', 'Chapter 7', ?), (?, '25-70002', NULL, 'Bankruptcy', 'Chapter 13', NULL)`, [C1, LINK1, C2]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname, contact_lfm_name) VALUES
      (7001, 'person', 'Dana Debtor', 'Dana', 'Debtor', 'Debtor, Dana'), (7002, 'person', 'Sam Spouse', 'Sam', 'Spouse', 'Spouse, Sam'), (7003, 'person', 'Other Client', 'Other', 'Client', 'Client, Other')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (911, ?, 7001, 'Primary'), (912, ?, 7002, 'Secondary'), (913, ?, 7003, 'Primary')`, [C1, C1, C2]);
    await q('INSERT INTO documents (id, source, external_id, name, path, path_lower, ext, size, status) VALUES (81, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['dropbox', 'id:A11XPET001', 'Petition.pdf', `${FOLDER1}/Petition.pdf`, lower(`${FOLDER1}/Petition.pdf`), 'pdf', 2048, 'active']);
    await q('INSERT INTO document_links (id, document_id, link_type, link_id, relation, created_by) VALUES (601, 81, ?, ?, ?, NULL)', ['case', C1, 'path']);
    await q('INSERT INTO case_folder_cache (case_id, folder_external_id, path_lower, path_display) VALUES (?, ?, ?, ?)', [C1, 'id:A11XFOLD01', lower(FOLDER1), FOLDER1]);
    await q('INSERT INTO document_sync_roots (id, path, enabled, backfill_done) VALUES (1, ?, 1, 1)', [ROOT]);
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('documents_sync_enabled', '1')");
    await q(`INSERT INTO contract_templates (id, name, kind, template_type, purpose, file_subfolder, body, prefill_schema, placement_json, active) VALUES
      (14, 'Hearing Notice', 'notice', 'html', 'generate', 'Notices', '<p>{{client_name}} / {{docket}} / {{hearing_date}}</p>',
       '[{"key":"client_name","label":"Client name","type":"text","resolver":"case.case_name","required":true},{"key":"docket","label":"Docket","type":"text","resolver":"case.docket","required":false},{"key":"hearing_date","label":"Hearing date","type":"text","required":false}]', '{"fields":[]}', 1),
      (15, 'Fee Agreement', 'contract', 'html', 'esign', 'Generated Documents', '<p>x</p>', '[]', '{"fields":[]}', 1),
      (18, 'Strict Notice', 'notice', 'html', 'both', 'Notices', '<p>{{amount}}</p>', '[{"key":"amount","label":"Amount","type":"text","required":true}]', '{"fields":[]}', 1)`);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (1, 'document.linked', 'Filed to a case', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"extra.link_type","op":"equals","value":"case"}]}'),
      (2, 'document.created', 'Any new file', 1, 1, 'conditions', '{"operator":"and","conditions":[]}')`);
  }
  const card = (value, evidence, question = '') => normalizeActionDraft(pool, value, evidence, { currentUserId: 6, question });
  // The evidence a model would hold: the templates read (real), the case / contact rows (sql.read shape).
  async function evidence() {
    const templates = await documentTemplatesRead(pool);
    return [
      { id: 'q1', kind: 'document.templates', purpose: 'templates', rows: compactRows(templates.rows) },
      { id: 'q2', rows: [{ case_id: C1, case_number: '25-70001', case_dropbox: LINK1 }, { case_id: C2, case_number: '25-70002', case_dropbox: null }] },
      { id: 'q3', rows: [{ contact_id: 7003, contact_name: 'Other Client' }] },
    ];
  }
  const tplRow = (ev, id) => ev[0].rows.findIndex((r) => Number(r.template_id) === id) + 1;
  // The browser's whole write path for one card: re-read, request, the real route, the answer check.
  async function apply(c, family) {
    const why = await browser[`${family}Precheck`](c);
    if (why) return { refused: why };
    const rq = browser[`${family}Request`](c);
    const res = await call(app, rq.method, rq.path, rq.body);
    if (res.status >= 400) return { error: Object.assign(new Error(res.body.message), { status: res.status, body: res.body }) };
    return { payload: browser[`${family}Result`](c, res.body), body: res.body };
  }
  const emitted = () => domainEvents.emit.mock.calls.map(([, ev, payload]) => [ev, payload.source, payload.actor, payload.data && payload.data.name, payload.data && payload.data.path, payload.extra || null]);

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
    app.use(require('../routes/api.documents'));
    app.use(require('../routes/api.dropbox')); // the register precheck's POST /api/dropbox/list — listFolder is the stub
    // The page's api(path, body, method): a non-2xx throws with .status / .body (apiSend's contract).
    // Three precheck GETs are answered from the services the routes wrap (their
    // route files drag the e-sign send stack / the whole case and contact
    // services in; the reads are not under test here): GET /api/esign/
    // templates/:id → {template}, GET /api/cases/:id → {case}, GET
    // /api/contacts/:id → {contact} — the shapes the real routes answer.
    browser = browserChecks(async (p, body, method) => {
      let m;
      if (method === 'GET' && (m = /^\/api\/esign\/templates\/(\d+)$/.exec(p))) {
        const template = await esignTemplateService.getTemplate(pool, Number(m[1]));
        if (!template) throw Object.assign(new Error(`Template ${m[1]} not found.`), { status: 404 });
        return { template };
      }
      if (method === 'GET' && (m = /^\/api\/cases\/([^/]+)$/.exec(p))) {
        const row = (await q('SELECT * FROM cases WHERE case_id = ?', [decodeURIComponent(m[1])]))[0];
        if (!row) throw Object.assign(new Error('Case not found'), { status: 404 });
        return { case: row };
      }
      if (method === 'GET' && (m = /^\/api\/contacts\/(\d+)$/.exec(p))) {
        const row = (await q('SELECT * FROM contacts WHERE contact_id = ?', [Number(m[1])]))[0];
        if (!row) throw Object.assign(new Error('Contact not found'), { status: 404 });
        return { contact: row };
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

  beforeEach(async () => {
    await seed();
    model();
    domainEvents.emit.mockClear();
    pdfRender.renderHtmlToPdf.mockClear();
    taskService.createTask.mockClear();
    caseService.ensureCaseDropboxFolder.mockReset();
    dropbox.resolveLocation.mockReset().mockImplementation(async (_db, _cred, { sharedLink }) => {
      if (sharedLink === LINK1) return FOLDER1;
      if (sharedLink === 'https://www.dropbox.com/scl/fo/c2/new?rlkey=2') return `${ROOT}/ 13 - Client, Other - 25-70002`;
      throw new Error('link revoked');
    });
    dropbox.createFolder.mockReset().mockImplementation(async (_db, { path: p }) => { if (!tree.has(lower(p))) tree.set(lower(p), []); return { path: p, existed: false }; });
    dropbox.uploadFile.mockReset().mockImplementation(async (_db, { path: requested, content }) => {
      const folder = requested.slice(0, requested.lastIndexOf('/')); let name = requested.slice(requested.lastIndexOf('/') + 1);
      const entries = tree.get(lower(folder)) || []; tree.set(lower(folder), entries);
      // files/upload with mode add + autorename: a collision gets a counter.
      if (entries.some((e) => lower(e.name) === lower(name))) name = name.replace(/\.pdf$/i, ' (1).pdf');
      const id = `id:A11XGEN${String(uploads.length + 1).padStart(3, '0')}`;
      const meta = { '.tag': 'file', id, name, path_display: `${folder}/${name}`, path_lower: lower(`${folder}/${name}`), size: content.length, rev: `r${id.slice(-3)}`, server_modified: '2026-11-17T15:00:00Z', content_hash: 'g'.repeat(64) };
      entries.push(meta); files.set(id, meta); files.set(meta.path_lower, meta); uploads.push({ requested, meta, content: content.toString() });
      return meta;
    });
    dropbox.getTemporaryLink.mockReset().mockImplementation(async () => ({ link: 'https://dl/x', metadata: null }));
    dropbox.getMetadata.mockReset().mockImplementation(async (_db, { path: p }) => {
      const hit = files.get(String(p)) || files.get(lower(p));
      if (hit) return hit;
      if (tree.has(lower(p))) return { '.tag': 'folder', id: `id:${lower(p)}`, path_lower: lower(p), path_display: p };
      throw notFound();
    });
    dropbox.listFolder.mockReset().mockImplementation(async (_db, { path: p, maxEntries }) => {
      const entries = tree.get(lower(p));
      if (!entries) throw Object.assign(new Error('dropbox: POST /2/files/list_folder → 409: path/not_found/..'), { status: 409, errorSummary: 'path/not_found/..' });
      return { entries: entries.slice(0, maxEntries || 2000), count: entries.length, truncated: entries.length > (maxEntries || 2000) };
    });
  });

  test('THE GENERATE, case rung: the predicted path is the written path; ONE row and ONE "path" link; both events; the receipt; no task', async () => {
    const ev = await evidence();
    const c = await card({ kind: 'document.generate.v1', template_id: 14, linkable_type: 'case', linkable_id: C1, values: { hearing_date: '2026-12-04' },
      evidence: [{ query_id: 'q1', row_number: tplRow(ev, 14) }, { query_id: 'q2', row_number: 1 }] }, ev, 'generate the hearing notice for Dana, hearing 2026-12-04');
    expect(c).toMatchObject({ document_name: 'Hearing Notice – Debtor', file_name: `${TODAY} Hearing Notice – Debtor.pdf`,
      predicted_path: `${FOLDER1}/Notices/${TODAY} Hearing Notice – Debtor.pdf`, relation: 'path',
      destination: { rung: 'case', folder_path: `${FOLDER1}/Notices`, subfolder: 'Notices' },
      expected: { template: { active: true, purpose: 'generate', template_type: 'html', has_pdf: false }, record: { case_dropbox: LINK1 } } });
    expect(c.values.resolved.map((r) => [r.key, r.filled, r.given, r.value])).toEqual([['client_name', true, false, 'Dana Debtor'], ['docket', true, false, '25-70001-abc'], ['hearing_date', true, true, '2026-12-04']]);
    expect(c.values.blanks).toEqual([]);
    // The real rules, dry-run: rule 2 on created (no conditions) and rule 1 on linked (a case link) both act.
    expect(c.automation.lines.map((l) => l.split(' runs')[0])).toEqual(['Trigger rule #2 "Any new file"', 'Trigger rule #1 "Filed to a case"']);
    // Nothing written at proposal.
    expect([(await q('SELECT COUNT(*) AS n FROM documents'))[0].n, (await q('SELECT COUNT(*) AS n FROM document_links'))[0].n, uploads.length, taskService.createTask.mock.calls.length]).toEqual([1, 1, 0, 0]);
    expect(pdfRender.renderHtmlToPdf).not.toHaveBeenCalled();
    const out = await apply(c, 'docgenerate');
    expect(out.refused).toBeUndefined();
    expect(out.error).toBeUndefined();
    const id = out.payload.document_id;
    expect(id).toBeGreaterThan(81);
    expect(out.body).toMatchObject({ status: 'success', placement: 'case', path: c.predicted_path, file_name: c.file_name, document_id: id, template_id: 14, link_type: 'case', link_id: C1, document_name: 'Hearing Notice – Debtor', missing_optional: [] });
    expect(uploads.map((u) => [u.requested, u.meta.path_display])).toEqual([[c.predicted_path, c.predicted_path]]);
    expect(uploads[0].content).toBe('%PDF-1.7 twin <p>Dana Debtor / 25-70001-abc / 2026-12-04</p>');
    expect(dropbox.createFolder.mock.calls.map((x) => x[1].path)).toEqual([`${FOLDER1}/Notices`]);
    const [row] = await q('SELECT id, source, external_id, name, path, path_lower, size, status, title FROM documents WHERE id = ?', [id]);
    expect(row).toEqual({ id, source: 'dropbox', external_id: 'id:A11XGEN001', name: c.file_name, path: c.predicted_path, path_lower: lower(c.predicted_path), size: uploads[0].content.length, status: 'active', title: null });
    expect(await q('SELECT link_type, link_id, relation, created_by FROM document_links WHERE document_id = ?', [id])).toEqual([{ link_type: 'case', link_id: C1, relation: 'path', created_by: 6 }]);
    expect(emitted()).toEqual([['document.created', 'generated_doc', { user_id: 6 }, c.file_name, c.predicted_path, null],
      ['document.linked', 'generated_doc', { user_id: 6 }, c.file_name, c.predicted_path, { link_type: 'case', link_id: C1, relation: 'path' }]]);
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(caseService.ensureCaseDropboxFolder).not.toHaveBeenCalled();
    expect(c.__docgenerateOutcome).toEqual({ path: c.predicted_path, placement: 'case', warnings: [], missing_optional: [] });
  });

  test('RUNG 2: AUTO-CREATE predicted; the route creates the folder, raises the task with the card\'s title, files under it, links with relation "upload"', async () => {
    const ev = await evidence();
    const c = await card({ kind: 'document.generate.v1', template_id: 14, linkable_type: 'case', linkable_id: C2, evidence: [{ query_id: 'q1', row_number: tplRow(ev, 14) }, { query_id: 'q2', row_number: 2 }] }, ev);
    expect(c.destination).toMatchObject({ rung: 'auto_create', task: `Dropbox folder auto-created for case ${C2}` });
    expect(c.warnings[1]).toMatch(/^AUTO-CREATE: case 25-70002 has no Dropbox folder linked\./);
    expect([c.relation, c.document_name, c.expected.record]).toEqual(['upload', 'Hearing Notice – Client', { case_dropbox: null }]);
    expect(c.values.blanks).toEqual(['hearing_date']);
    caseService.ensureCaseDropboxFolder.mockImplementation(async (db, caseId) => {
      await db.query('UPDATE cases SET case_dropbox = ? WHERE case_id = ?', ['https://www.dropbox.com/scl/fo/c2/new?rlkey=2', caseId]);
      tree.set(lower(`${ROOT}/ 13 - Client, Other - 25-70002`), []);
      return { existed: false, stage: 'active', path: `${ROOT}/ 13 - Client, Other - 25-70002`, shared_link: 'https://www.dropbox.com/scl/fo/c2/new?rlkey=2' };
    });
    const out = await apply(c, 'docgenerate');
    expect(out.refused).toBeUndefined();
    expect(caseService.ensureCaseDropboxFolder).toHaveBeenCalledWith(pool, C2);
    expect(taskService.createTask.mock.calls.map(([, t]) => [t.title, t.link_type, t.link_id, t.source, t.to])).toEqual([[`Dropbox folder auto-created for case ${C2}`, 'case', C2, 'doc_gen', 22]]);
    expect(out.body.path).toBe(`${ROOT}/ 13 - Client, Other - 25-70002/Notices/${TODAY} Hearing Notice – Client.pdf`);
    expect(out.body.warnings[0]).toMatch(/had no Dropbox folder linked, so one was created automatically/);
    expect(await q('SELECT link_type, link_id, relation FROM document_links WHERE document_id = ?', [out.payload.document_id])).toEqual([{ link_type: 'case', link_id: C2, relation: 'upload' }]);
    expect(c.__docgenerateOutcome.missing_optional).toEqual(['hearing_date']);
    // The precheck of a second card prepared BEFORE the folder existed refuses now: the case's link changed.
    expect(await browser.docgeneratePrecheck(c)).toMatch(/^The Dropbox folder of case 25-70002 changed since this card was prepared \(its link was set or re-linked\)/);
  });

  test('A NAME COLLISION: Dropbox autorenames, nothing is overwritten, the route reports the real path and the receipt is the new row', async () => {
    const ev = await evidence();
    const make = () => card({ kind: 'document.generate.v1', template_id: 14, linkable_type: 'case', linkable_id: C1, evidence: [{ query_id: 'q1', row_number: tplRow(ev, 14) }, { query_id: 'q2', row_number: 1 }] }, ev);
    const first = await apply(await make(), 'docgenerate');
    const c = await make();
    const second = await apply(c, 'docgenerate');
    expect(second.refused).toBeUndefined();
    expect(second.body.path).toBe(`${FOLDER1}/Notices/${TODAY} Hearing Notice – Debtor (1).pdf`);
    expect(second.payload.document_id).toBeGreaterThan(first.payload.document_id);
    expect((await q('SELECT COUNT(*) AS n FROM documents WHERE path LIKE ?', [`${FOLDER1}/Notices/%`]))[0].n).toBe(2);
    expect(uploads.map((u) => u.meta.name)).toEqual([`${TODAY} Hearing Notice – Debtor.pdf`, `${TODAY} Hearing Notice – Debtor (1).pdf`]);
  });

  test('THE ROUTE\'S REFUSALS ARE THE AUTHORITY: a missing required value (400 + missing) and a signature-only template (409) — nothing rendered or written; the normalizer first', async () => {
    const ev = await evidence();
    await expect(card({ kind: 'document.generate.v1', template_id: 18, linkable_type: 'case', linkable_id: C1, evidence: [{ query_id: 'q1', row_number: tplRow(ev, 18) }, { query_id: 'q2', row_number: 1 }] }, ev))
      .rejects.toThrow(/^Required value\(s\) are still empty: amount\. Fill them in and send again\./);
    const missing = await call(app, 'POST', '/api/documents/generate', { template_id: 18, linkable_type: 'case', linkable_id: C1 });
    expect(missing).toEqual({ status: 400, body: { status: 'error', message: 'Required value(s) are still empty: amount. Fill them in and send again.', code: 'ESIGN_MISSING_PREFILL', missing: ['amount'] } });
    expect(browser.docgenerateKnownOutcome({ status: 400, body: missing.body })).toMatchObject({ status: 'Refused — nothing generated' });
    const esign = await call(app, 'POST', '/api/documents/generate', { template_id: 15, linkable_type: 'case', linkable_id: C1 });
    expect([esign.status, esign.body.code]).toEqual([409, 'ESIGN_TEMPLATE_PURPOSE']);
    expect(browser.docgenerateKnownOutcome({ status: 409, body: esign.body })).toMatchObject({ status: 'Refused — nothing generated' });
    // The templates read never lists the signature-only template, so no card can cite it.
    expect(ev[0].rows.map((r) => r.template_id)).toEqual(['14', '18']);
    expect([pdfRender.renderHtmlToPdf.mock.calls.length, uploads.length, (await q('SELECT COUNT(*) AS n FROM documents'))[0].n]).toEqual([0, 0, 1]);
  });

  test('THE REGISTER: the folder read lists the entry with its id; the card; the real precheck; ONE row, no link, document.created; a repeat is "already registered"; the REAL sweep links it', async () => {
    const read = await documentFolderRead(pool, FOLDER1);
    expect(read.rows.map((r) => [r.row_type, r.entry_id, r.name, r.is_folder, r.registered_document_id])).toEqual([
      ['folder', undefined, undefined, 1, undefined], ['entry', 'id:SUBSCANS1', 'Scans', 1, null], ['entry', 'id:A11XPAY001', 'Paystub.pdf', 0, null], ['entry', 'id:A11XPET001', 'Petition.pdf', 0, 81]]);
    const ev = [{ id: 'q4', kind: 'document.folder', purpose: 'the folder', rows: compactRows(read.rows) }];
    await expect(card({ kind: 'document.register.v1', external_id: 'id:A11XPET001', evidence: [{ query_id: 'q4', row_number: 4 }] }, ev)).rejects.toThrow(/^"Petition\.pdf" is already registered as document #81 — nothing to register/);
    await expect(card({ kind: 'document.register.v1', external_id: 'id:SUBSCANS1', evidence: [{ query_id: 'q4', row_number: 2 }] }, ev)).rejects.toThrow(/^"Scans" is a folder — register targets files, not folders/);
    const c = await card({ kind: 'document.register.v1', external_id: 'id:A11XPAY001', evidence: [{ query_id: 'q4', row_number: 3 }] }, ev);
    expect(c).toMatchObject({ file: { external_id: 'id:A11XPAY001', name: 'Paystub.pdf', path: `${FOLDER1}/Paystub.pdf`, parent_path: FOLDER1, size: 1024, rev: 'r001' },
      folder_case: { case_id: C1, path_lower: lower(FOLDER1) }, sync_root: { root_id: 1, path: ROOT }, sync_enabled: true, warnings: [],
      expected: { external_id: 'id:A11XPAY001', name: 'Paystub.pdf', size: 1024, rev: 'r001', parent_path: FOLDER1 } });
    expect(c.automation.lines).toEqual(['Trigger rule #2 "Any new file" runs: no active actions']);
    expect((await q('SELECT COUNT(*) AS n FROM documents'))[0].n).toBe(1);
    const out = await apply(c, 'docregister');
    expect(out.refused).toBeUndefined();
    expect(dropbox.listFolder.mock.calls.at(-1)[1]).toMatchObject({ path: FOLDER1, recursive: false, maxEntries: 500 });
    const id = out.payload.document_id;
    expect(out.body).toMatchObject({ status: 'success', created: true, document: { id, external_id: 'id:A11XPAY001', name: 'Paystub.pdf', size: 1024, status: 'active' } });
    expect(await q('SELECT source, external_id, name, path, path_lower, size, rev, status FROM documents WHERE id = ?', [id])).toEqual([{ source: 'dropbox', external_id: 'id:A11XPAY001', name: 'Paystub.pdf', path: `${FOLDER1}/Paystub.pdf`, path_lower: lower(`${FOLDER1}/Paystub.pdf`), size: 1024, rev: 'r001', status: 'active' }]);
    expect(await q('SELECT COUNT(*) AS n FROM document_links WHERE document_id = ?', [id])).toEqual([{ n: 0 }]);
    expect(emitted()).toEqual([['document.created', 'manual', { user_id: 6 }, 'Paystub.pdf', `${FOLDER1}/Paystub.pdf`, null]]);
    // A second apply of the same card: the precheck passes (the file is unchanged), the route answers
    // 200 created:false, and the result check throws the noop — "already registered", never a success.
    let again = null;
    try { await apply(c, 'docregister'); } catch (e) { again = e; }
    expect([again && again.documentRegisterNoop, again && again.documentRegisterId]).toEqual([true, id]);
    expect(browser.docregisterKnownOutcome(again).status).toBe('Refused — already registered');
    expect((await q('SELECT COUNT(*) AS n FROM documents'))[0].n).toBe(2);
    // A second card refuses at proposal, naming the row.
    await expect(card({ kind: 'document.register.v1', external_id: 'id:A11XPAY001', evidence: [{ query_id: 'q4', row_number: 3 }] }, ev)).rejects.toThrow(`"Paystub.pdf" is already registered as document #${id} — nothing to register; the route would answer 200 created:false and only refresh that row. To put it on a case, use a document.link card`);
    // The REAL sweep links it to the case whose cached folder holds it — the card's attribution line.
    const swept = await sync.attributeUnlinked(pool, { watermark: false });
    expect(swept.linked).toBe(1);
    expect(await q('SELECT link_type, link_id, relation, created_by FROM document_links WHERE document_id = ?', [id])).toEqual([{ link_type: 'case', link_id: C1, relation: 'path', created_by: null }]);
  });

  test('THE REGISTER at the click: a file gone from Dropbox is refused by the precheck, and by the route (Dropbox\'s 409) when the listing could not prove it', async () => {
    const read = await documentFolderRead(pool, FOLDER1);
    const ev = [{ id: 'q4', kind: 'document.folder', purpose: 'the folder', rows: compactRows(read.rows) }];
    const c = await card({ kind: 'document.register.v1', external_id: 'id:A11XPAY001', evidence: [{ query_id: 'q4', row_number: 3 }] }, ev);
    // Deleted in Dropbox after the card was prepared.
    const meta = files.get('id:A11XPAY001'); files.delete('id:A11XPAY001'); files.delete(meta.path_lower);
    tree.set(lower(FOLDER1), tree.get(lower(FOLDER1)).filter((e) => e.id !== 'id:A11XPAY001'));
    expect(await browser.docregisterPrecheck(c)).toBe(`"Paystub.pdf" is no longer in "${FOLDER1}" — it was deleted or moved since this card was prepared. Nothing was written. Ask Casey to read the folder again.`);
    // The route's own answer to the same file (the precheck skipped — a truncated listing): Dropbox's not-found through mapErrorStatus.
    const res = await call(app, 'POST', '/api/documents/register', { external_id: 'id:A11XPAY001' });
    expect([res.status, res.body.message]).toEqual([409, 'dropbox: POST /2/files/get_metadata → 409: path/not_found/..']);
    expect(browser.docregisterKnownOutcome({ status: res.status, body: res.body })).toMatchObject({ status: 'Refused — nothing written' });
    // A folder id straight at the route: its own 400.
    const folder = await call(app, 'POST', '/api/documents/register', { external_id: 'id:SUBSCANS1' });
    expect([folder.status, folder.body.message]).toEqual([400, 'register targets files, not folders']);
    expect((await q('SELECT COUNT(*) AS n FROM documents'))[0].n).toBe(1);
  });
});
