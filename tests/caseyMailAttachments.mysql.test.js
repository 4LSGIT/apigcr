// tests/caseyMailAttachments.mysql.test.js
//
/**
 * A13b on REAL MySQL: the Casey attachment-filing card over the routes it
 * reads and writes through — routes/api.mail.js (preview, file, notice, the
 * message GET), the real emailAttachmentCommsService / emailAttachmentFilingService
 * / filePlacementService / documentIngestService / mailReadService /
 * logService, the real pool, under the production sql_mode — plus the card's
 * own reads (the typed mail.attachments.preview read, the normalizer's
 * preview re-run, the caseLink prediction) and the browser's click-time
 * precheck, dispatch and answer checks, extracted from public/assistant.html.
 * Stubbed, as in tests/emailAttachments.mysql.test.js: Dropbox (an in-memory
 * account), the IMAP part fetch, the firm's settings (settingsService) and the
 * notice's sendEmail. Nothing else.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a13b_test npx jest tests/caseyMailAttachments.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (on a dev
 * machine that is production). This suite DROPS and recreates its tables in
 * that database, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped), with FOREIGN_KEY_CHECKS
 * off, taking any sibling-built child of ours with it — give it its own
 * *_test database. The created log row's date uses CONVERT_TZ(…, 'EST5EDT'):
 * the server needs its tz tables (mysql_tzinfo_to_sql) and should run
 * --default-time-zone=+00:00 (the store-only grace compares NOW() with UTC
 * ingested_at).
 *
 * WHAT IS LOCKED
 *   - the card's per-part verdicts ARE the preview route's (the browser's
 *     verdict over the real POST /api/mail/attachments/preview equals the
 *     card's expected), and the typed read's classes are the preview's;
 *   - a second confirmation the card omits: the card refuses it by name AND
 *     the route answers 409 needs_confirmation for the same part; a blocked
 *     part: the card refuses it by name AND the route 422s it; nothing uploads;
 *   - the file lands through the browser's own request + dispatch: files[],
 *     the registry rows filed by the user, the default folder the card named,
 *     the link's created log row about the case (the card predicted a create),
 *     the notice batch's rows claimed and ONE notice to the reviewer, the
 *     document.created / document.linked events the card listed queued;
 *   - the precheck passes fresh and refuses after a policy change (and the
 *     route's 409 at the click maps to a refusal), after a link elsewhere;
 *   - access: no read grant → a not-found read row, a refused card, a 404;
 *   - the move out of Unsorted (the card's default) is the route's refile;
 *   - the link refusal the card predicts is the route's link_error;
 *   - a typed folder with a leading space lands exactly there; a duplicate.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const express = require('express');
const mysql = require('mysql2/promise');

process.env.EMAIL_DOMAINS = 'firm.test';
process.env.APP_URL = 'https://app.test';
// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js).
// The user is the x-test-user header (default 7) so one suite can be several people.
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => {
  req.auth = { type: 'jwt', userId: Number(req.headers['x-test-user'] || 7) }; next();
});
// ── in-memory Dropbox (tests/emailAttachments.mysql.test.js's) ─────────────
const mockDbx = { files: new Map(), uploads: [], moves: [], seq: 0, links: { 'https://dbx/case-1': '/cases/debtor', 'https://dbx/case-2': '/cases/other' }, listing: null };
const mockMetaOf = (f) => ({ '.tag': 'file', id: f.id, name: f.path.split('/').pop(), path_display: f.path, path_lower: f.path.toLowerCase(), size: f.size });
const mockJoin = (base, ...segs) => {
  let out = String(base || '').replace(/\/+$/, '');
  for (const s of segs) if (s != null && s !== '') out = `${out}/${String(s).replace(/^\/+/, '')}`;
  return out.replace(/\/{2,}/g, '/');
};
jest.mock('../services/dropboxService', () => ({
  _resolveCredential: jest.fn(async () => 8),
  resolveLocation: jest.fn(async (db, cred, { sharedLink, path: p }) => {
    if (p) return p;
    if (!mockDbx.links[sharedLink]) throw new Error('shared link not found');
    return mockDbx.links[sharedLink];
  }),
  createFolder: jest.fn(async (db, { path: p }) => ({ path: p, existed: false })),
  uploadFile: jest.fn(async (db, { path: p, content }) => {
    const f = { id: `id:F${++mockDbx.seq}xY`, path: p, size: content.length };
    mockDbx.files.set(f.id, f);
    mockDbx.uploads.push(p);
    return mockMetaOf(f);
  }),
  getTemporaryLink: jest.fn(async () => ({ link: 'https://dl/tmp' })),
  getOrCreateSharedLink: jest.fn(async (db, { path: p }) => `https://dbx/sh${p}`),
  getMetadata: jest.fn(async (db, { path: p }) => {
    const f = mockDbx.files.get(p) || [...mockDbx.files.values()].find((x) => x.path.toLowerCase() === String(p).toLowerCase());
    if (!f) throw Object.assign(new Error('path/not_found/'), { status: 409 });
    return mockMetaOf(f);
  }),
  movePath: jest.fn(async (db, { fromPath, toPath }) => {
    const f = mockDbx.files.get(fromPath);
    if (!f) throw new Error('not found');
    mockDbx.moves.push({ from: f.path, to: toPath });
    f.path = toPath;
    return { metadata: mockMetaOf(f) };
  }),
  joinPath: (...a) => mockJoin(...a),
  listFolder: jest.fn(async () => mockDbx.listing || { entries: [], count: 0, truncated: false }),
}));
jest.mock('../services/settingsService', () => ({
  ...jest.requireActual('../services/settingsService'),
  getSetting: jest.fn(async () => null),
  getSettings: jest.fn(async () => ({})),
}));
jest.mock('../services/emailService', () => ({ ...jest.requireActual('../services/emailService'), sendEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/mailbox/imapTransport', () => ({ ...jest.requireActual('../services/mailbox/imapTransport'), fetchPart: jest.fn() }));

const { normalizeActionDraft, mailAttachmentsPreviewRead } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'cases', 'contacts', 'case_relate', 'contact_emails', 'portal_access_log', 'log',
  'mailboxes', 'channel_grants', 'mail_messages', 'mail_read_state', 'email_ingest_executions', 'mail_sends', 'mail_image_senders',
  'mail_attachment_filings', 'mail_attachment_notices', 'documents', 'document_links', 'case_folder_cache',
  'checklists', 'checkitems', 'trigger_rules', 'trigger_rule_actions', 'domain_event_queue'];

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
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks for ${tables.length} tables`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

function call(app, method, urlPath, body, user = 7) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = body === undefined || body === null ? '' : JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-test-user': String(user) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

// The browser's functions, extracted verbatim from the page (the assistantUi
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
function browserFns(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const names = ['mailMessageIdOf', 'mailReadMessage', 'mailAttachmentsCaseLabel', 'mailAttachmentVerdict', 'mailAttachmentMoveKey', 'mailAttachmentsBatch',
    'mailAttachmentsRequest', 'mailAttachmentsPrecheck', 'mailAttachmentsDispatch', 'mailAttachmentsResult', 'mailAttachmentsKnownOutcome'];
  const src = `${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey attachment-filing card on real MySQL (A13b)', () => {
  const settings = require('../services/settingsService');
  const emailSvc = require('../services/emailService');
  const transport = require('../services/mailbox/imapTransport');
  const filing = require('../services/emailAttachmentFilingService');
  let pool; let app; let browser; let SET;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A13BCAS1'; const C2 = 'A13BCAS2';
  const OLD = '2026-10-30 15:05:00';
  const pdf = (part, filename, size = 4000) => ({ part: String(part), filename, mime: 'application/pdf', size });
  const ATT = [pdf(2, 'stub.pdf'), { part: '3', filename: 'scans.zip', mime: 'application/zip', size: 9000 },
    { part: '4', filename: 'run.exe', mime: 'application/octet-stream', size: 500 }, pdf(6, 'w2.pdf', 5000)];

  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set(children.map((r) => r.t)), ...[...TABLES].reverse()]) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  async function message(id, box, { from = 'Dana Debtor <dana@example.com>', subject = `Subject ${id}`, attachments = ATT, ingested = OLD, rfc = `m${id}@x.test` } = {}) {
    await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, from_addr, to_addrs, subject, date, snippet, body_text, attachments, flags, ingested_at)
      VALUES (?, ?, 'INBOX', ?, ?, ?, 'intake@firm.test', ?, '2026-10-30 15:04:00', 's', 'Here are my documents.', ?, '', COALESCE(?, UTC_TIMESTAMP()))`,
    [id, box, id, rfc, from, subject, JSON.stringify(attachments), ingested]);
  }

  async function seed() {
    for (const t of [...TABLES].reverse()) await q(`DELETE FROM \`${t}\``);
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, email, ringcentral, roles) VALUES
      (5, 'shana', 'Shana', 'Shana', 'B', 'SB', 'authorized', 'sb@firm.test', 0, 'staff'),
      (7, 'rena', 'Rena', 'Rena', 'R', 'RR', 'authorized', 'rr@firm.test', 0, 'staff'),
      (8, 'pat', 'Pat', 'Pat', 'P', 'PP', 'authorized', 'pp@firm.test', 0, 'staff')`);
    const folders = JSON.stringify({ INBOX: { emit_to_rules: false } });
    const cursor = JSON.stringify({ INBOX: { uidvalidity: 3, last_uid: 999 } });    // the part fetch's identity guard
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, ingest_folders, ingest_state) VALUES
      (1, 'intake@firm.test', 'firm.test', 'imap.test', 'intake', ?, ?), (2, 'private@firm.test', 'firm.test', 'imap.test', 'private', ?, ?)`,
    [folders, cursor, folders, cursor]);
    await q("INSERT INTO channel_grants (id, user, channel_type, channel_id, can_read, granted_by) VALUES (1, 7, 'mailbox', 1, 1, 5), (2, 5, 'mailbox', 1, 1, 5)");
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_stage, pipeline_phase, case_dropbox) VALUES
      (?, '25-70001', 'Bankruptcy', 'Open', 'case', 'https://dbx/case-1'), (?, '25-70002', 'Bankruptcy', 'Open', 'case', 'https://dbx/case-2')`, [C1, C2]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_type, contact_name, contact_fname, contact_lname, contact_email) VALUES
      (7001, 'person', 'Client', 'Dana Debtor', 'Dana', 'Debtor', 'dana@example.com')`);
    await q("INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (951, ?, 7001, 'Primary')", [C1]);
    await q("INSERT INTO contact_emails (id, contact_id, email) VALUES (91, 7001, 'dana@example.com')");
    await message(601, 1, { subject: 'Pay stubs' });
    await message(602, 2, { subject: 'Private' });
    await message(603, 1, { from: 'Her Mom <mom@y.test>', subject: 'for dana', attachments: [pdf(2, 'tax.pdf')] });
    await message(604, 1, { subject: 'just now', attachments: [pdf(2, 'fresh.pdf')], ingested: null });
    mockDbx.files.clear(); mockDbx.uploads.length = 0; mockDbx.moves.length = 0; mockDbx.seq = 0; mockDbx.listing = null;
    SET = { email_attachments_reviewer: '5' };
    settings.getSettings.mockImplementation(async (db, keys) => Object.fromEntries(keys.map((k) => [k, SET[k] ?? null])));
    emailSvc.sendEmail.mockClear();
    transport.fetchPart.mockImplementation(async (row, folder, uid, part) =>
      ({ stream: Readable.from([Buffer.from(`bytes-of-${uid}-${part}`)]), mime: 'application/pdf', close: () => {} }));
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    if (!/_test$/.test(u.pathname.slice(1))) throw new Error(`refusing to run against "${u.pathname.slice(1)}"`);
    if (u.port === '3306' || u.port === '') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}', time_zone = '+00:00'`));
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
    app.use(require('../routes/api.mail'));
    // The page's api(path, body, method): a non-2xx throws with .status and .body (apiSend's contract).
    browser = (user = 7) => browserFns(async (p, body, method) => {
      const caseRoute = /^\/api\/cases\/([^/]+)$/.exec(p);
      if (caseRoute && method === 'GET') {
        const rows = await q('SELECT case_id, case_dropbox FROM cases WHERE case_id = ?', [decodeURIComponent(caseRoute[1])]);
        if (!rows.length) throw Object.assign(new Error('Case not found'), { status: 404 });
        return { case: rows[0] };
      }
      const res = await call(app, method, p, method === 'GET' ? undefined : body, user);
      if (res.status >= 400) throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
      return res.body;
    });
  });
  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await seed();
  });
  afterEach(() => { console.log.mockRestore(); console.warn.mockRestore(); });
  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  // The evidence a real investigation would carry: the mail.search row, the
  // typed preview read's rows, a case read.
  async function evidenceFor(id, caseId = C1, user = 7) {
    const pv = await mailAttachmentsPreviewRead(pool, user, { mail_message_id: id, case_id: caseId });
    return [{ id: 'q1', kind: 'mail.search', purpose: 'mail', rows: [{ row_type: 'search' }, { row_type: 'message', mail_message_id: String(id) }] },
      { id: 'q2', kind: 'mail.attachments.preview', purpose: 'files', rows: pv.rows },
      { id: 'q3', kind: 'sql.read', purpose: 'case', rows: [{ case_id: C1 }, { case_id: C2 }] }];
  }
  const EV = (caseId = C1) => [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 1 }, { query_id: 'q3', row_number: caseId === C1 ? 1 : 2 }];
  async function card(over = {}, { id = 601, user = 7, caseId = C1 } = {}) {
    const ev = await evidenceFor(id, caseId, user);
    const draft = await normalizeActionDraft(pool, { kind: 'mail.attachments.file.v1', mail_message_id: id, case_id: caseId, parts: ['2'], evidence: EV(caseId), ...over }, ev, { currentUserId: user });
    return JSON.parse(JSON.stringify(draft));
  }
  async function apply(draft, user = 7) {
    const b = browser(user);
    expect(await b.mailAttachmentsPrecheck(draft)).toBe('');
    const req = b.mailAttachmentsRequest(draft);
    const out = await b.mailAttachmentsDispatch(req);
    return { req, out, payload: b.mailAttachmentsResult(draft, out) };
  }
  const reg = (id) => q('SELECT part, status, link_type, link_id, placement, filed_by, dropbox_path FROM mail_attachment_filings WHERE mail_message_id = ? ORDER BY part', [id]);

  test('the card\'s verdicts ARE the preview route\'s; the typed read classifies as the dialog does', async () => {
    const read = await mailAttachmentsPreviewRead(pool, 7, { mail_message_id: 601, case_id: C1 });
    expect(read.rows[0]).toMatchObject({ row_type: 'attachments_preview', mail_message_id: 601, mailbox_id: 1, case_id: C1, case_source: 'asked',
      match_case_id: C1, reviewer: 'Shana', reviewer_user_id: 5, reviewer_is_you: 0, confirm_over_mb: 15 });
    expect(read.rows.filter((r) => r.row_type === 'attachment').map((r) => [r.part, r.class, r.skip_reason, r.needs_confirm, r.ticked])).toEqual([
      ['2', 'file', null, null, 1], ['3', 'optional', null, 'type', 0], ['4', 'skip', 'blocked', null, 0], ['6', 'file', null, null, 1]]);
    const draft = await card({ parts: ['2', '3', '6'], confirm: ['3'] });
    const route = await call(app, 'POST', '/api/mail/attachments/preview', { message_ids: [601], case_id: C1 });
    expect(route.status).toBe(200);
    const b = browser();
    const byPart = new Map(route.body.messages[0].parts.map((p) => [p.part, p]));
    expect(draft.expected.parts).toEqual(['2', '3', '6'].map((p) => b.mailAttachmentVerdict(byPart.get(p))));
    expect(draft.expected).toMatchObject({ reviewer_id: 5, case_folder: true, move: null, message: { mailbox_id: 1, subject: 'Pay stubs' } });
  });

  test('a second confirmation the card omits: refused by the card AND 409 needs_confirmation by the route; a blocked part: refused by name AND 422', async () => {
    await expect(card({ parts: ['2', '3'] })).rejects.toThrow('NEEDS A SECOND CONFIRMATION — "scans.zip" (part 3): not a usual document type');
    const r409 = await call(app, 'POST', '/api/mail/messages/601/attachments/file', { case_id: C1, parts: ['2', '3'], link: false });
    expect(r409).toMatchObject({ status: 409, body: { needs_confirmation: [{ part: '3', filename: 'scans.zip', why: 'type' }] } });
    await expect(card({ parts: ['4'] })).rejects.toThrow(`NEVER FILED — "run.exe" (part 4) cannot be filed: its type is on the firm's never-filed list`);
    const r422 = await call(app, 'POST', '/api/mail/messages/601/attachments/file', { case_id: C1, parts: ['4'], link: false });
    expect(r422).toMatchObject({ status: 422, body: { message: "run.exe cannot be filed: its type is on the firm's never-filed list." } });
    expect(mockDbx.uploads).toEqual([]);
    expect(await reg(601)).toEqual([]);
  });

  test('the file lands through the browser\'s request + dispatch: files[], the registry, the default folder, the link\'s log row, the notice, the events', async () => {
    const draft = await card({ parts: ['2', '3'], confirm: ['3'] });
    expect(draft.folder_card.path).toBe('Client Uploads/Emailed 261030');
    expect(draft.link_card).toMatchObject({ mode: 'create', same_case: false });
    expect(draft.notice).toMatchObject({ send: true, reviewer: { user_id: 5, name: 'Shana' } });
    expect(draft.effects.some((e) => e.includes('Trigger rules: each file emits document.created / document.linked; no active rule listens'))).toBe(true);
    const { req, out, payload } = await apply(draft);
    expect(payload).toEqual({ mail_message_id: 601 });
    expect(out.files.map((f) => [f.part, f.status])).toEqual([['2', 'filed'], ['3', 'filed']]);
    expect(mockDbx.uploads).toEqual(['/cases/debtor/Client Uploads/Emailed 261030/stub.pdf', '/cases/debtor/Client Uploads/Emailed 261030/scans.zip']);
    expect(out.folder_path.endsWith(`/${draft.folder_card.path}`)).toBe(true);
    expect((await reg(601)).map((r) => [r.part, r.status, r.link_type, r.link_id, r.placement, Number(r.filed_by)])).toEqual([
      ['2', 'filed', 'case', C1, 'case', 7], ['3', 'filed', 'case', C1, 'case', 7]]);
    // the link: the log row the card said it would create, about the case, by the user
    expect(out).toMatchObject({ linked: true, link_error: null });
    const [m] = await q('SELECT log_id FROM mail_messages WHERE id = 601');
    expect(Number(out.log_id)).toBe(Number(m.log_id));
    const [lg] = await q('SELECT log_type, log_by, log_about_type, log_about_id, log_link_id FROM log WHERE log_id = ?', [m.log_id]);
    expect(lg).toMatchObject({ log_type: 'email', log_by: 7, log_about_type: 'case', log_about_id: C1, log_link_id: 'dana@example.com' });
    // the notice: this card's batch, claimed, ONE email to the reviewer
    expect(req.body.batch).toBe(browser().mailAttachmentsBatch(draft));
    const rows = await q('SELECT digest_key, mail_message_id, notified_at IS NOT NULL AS done FROM mail_attachment_notices');
    expect(rows.map((r) => [r.digest_key, r.mail_message_id, Number(r.done)])).toEqual([[`comms-${req.body.batch}`, 601, 1]]);
    expect(out.notice).toMatchObject({ sent: true, to: { user_id: 5, name: 'Shana' }, notices: 1 });
    expect(emailSvc.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailSvc.sendEmail.mock.calls[0][1]).toMatchObject({ to: 'sb@firm.test', subject: expect.stringMatching(/^Filed from Comms — /) });
    expect(draft.file_outcome).toMatchObject({ filed: 2, already: 0, failed: [], linked: true, link_error: null, notice: { sent: true } });
    // the events the card's trigger line named, queued by the real registry
    await new Promise((r) => setTimeout(r, 50));
    const ev = (await q('SELECT event_type FROM domain_event_queue')).map((r) => r.event_type);
    expect(ev.filter((e) => e === 'document.created')).toHaveLength(2);
    expect(ev.filter((e) => e === 'document.linked')).toHaveLength(2);
    // filed now: a second card for the same part is refused (nothing to do)
    await expect(card({ parts: ['2'] })).rejects.toThrow('That changes nothing for "stub.pdf" (part 2) — it is already filed to case 25-70001');
  });

  test('the precheck refuses after a policy change (and the route\'s 409 at the click is a refusal); after the email is linked elsewhere', async () => {
    const draft = await card({ parts: ['2'], link: false });
    expect(await browser().mailAttachmentsPrecheck(draft)).toBe('');
    SET.email_attachments_confirm_mb = '0.001';      // stub.pdf now needs a size confirmation
    expect(await browser().mailAttachmentsPrecheck(draft)).toMatch(/^"stub\.pdf" changed since this card was prepared/);
    const b = browser();
    const e = await b.mailAttachmentsDispatch(b.mailAttachmentsRequest(draft)).catch((x) => x);
    expect(e).toMatchObject({ status: 409 });
    expect(b.mailAttachmentsKnownOutcome(e)).toMatchObject({ status: 'Refused — nothing written', text: expect.stringContaining('"stub.pdf" (a large file) now needs a second confirmation') });
    expect(mockDbx.uploads).toEqual([]);
    delete SET.email_attachments_confirm_mb;
    // the reviewer changed
    SET.email_attachments_reviewer = '7';
    expect(await browser().mailAttachmentsPrecheck(draft)).toMatch(/review-notice recipient/);
    SET.email_attachments_reviewer = '5';
    // linked to another case since the card
    const linkCard = await card({ parts: ['2'] });
    expect(await browser().mailAttachmentsPrecheck(linkCard)).toBe('');
    expect((await call(app, 'POST', '/api/mail/messages/601/case-link', { case_id: C2 })).status).toBe(200);
    expect(await browser().mailAttachmentsPrecheck(linkCard)).toMatch(/case link or log entry changed/);
    // and a fresh card now says the link MOVES it off that case (the route's setLogAbout overwrites)
    const moved = await card({ parts: ['2'] });
    expect(moved.warnings.some((w) => w.startsWith('MOVES THE EMAIL OFF ANOTHER CASE: message #601 is linked to case 25-70002'))).toBe(true);
    await apply(moved);
    const [lg] = await q('SELECT l.log_about_id FROM log l JOIN mail_messages m ON m.log_id = l.log_id WHERE m.id = 601');
    expect(lg.log_about_id).toBe(C1);
  });

  test('access: no read grant → a not-found read row, a refused card, a 404 on the route; nothing filed', async () => {
    const read = await mailAttachmentsPreviewRead(pool, 8, { mail_message_id: 601 });
    expect(read.rows).toEqual([expect.objectContaining({ row_type: 'not_found', mail_message_id: 601 })]);
    const ev = await evidenceFor(601, C1, 7);
    await expect(normalizeActionDraft(pool, { kind: 'mail.attachments.file.v1', mail_message_id: 601, case_id: C1, parts: ['2'], evidence: EV() }, ev, { currentUserId: 8 }))
      .rejects.toThrow('Message #601 is not a message you can read');
    expect((await mailAttachmentsPreviewRead(pool, 7, { mail_message_id: 602 })).rows[0]).toMatchObject({ row_type: 'not_found' });
    expect(await call(app, 'POST', '/api/mail/messages/602/attachments/file', { case_id: C1, parts: ['2'] })).toMatchObject({ status: 404, body: { message: 'Message not found' } });
    expect(mockDbx.uploads).toEqual([]);
  });

  test('the move out of Unsorted is the card\'s default and the route\'s refile', async () => {
    await filing.fileMessageAttachments(pool, { ref: { mail_message_id: 603 } });          // docs@: a stranger → Unsorted
    expect((await reg(603)).map((r) => r.placement)).toEqual(['unsorted']);
    const draft = await card({ parts: [], link: false }, { id: 603 });
    expect(draft.move).toMatchObject({ asked: null, move: true, count: 1, unsorted: 1, case_ids: [] });
    expect(draft.warnings).toEqual([]);
    const { req, out } = await apply(draft);
    expect(req.body).toMatchObject({ parts: [], move: true, link: false });
    expect(out.refiled).toMatchObject({ moved: 1, failed: [] });
    expect(mockDbx.moves.map((m) => m.to)).toEqual(['/cases/debtor/Client Uploads/Emailed 261030/tax.pdf']);
    expect((await reg(603)).map((r) => [r.link_type, r.link_id, r.placement])).toEqual([['case', C1, 'case']]);
    // moved: nothing left elsewhere → a move card is refused
    await expect(card({ parts: [], move: true }, { id: 603 })).rejects.toThrow('Nothing to move');
  });

  test('the link refusal the card predicts is the route\'s link_error; link false files', async () => {
    await expect(card({ parts: ['2'] }, { id: 604 })).rejects.toThrow('LINK REFUSED — This email arrived in the last few minutes');
    const direct = await call(app, 'POST', '/api/mail/messages/604/attachments/file', { case_id: C1, parts: ['2'], link: true });
    expect(direct.body).toMatchObject({ linked: false, link_error: expect.stringMatching(/^This email arrived in the last few minutes/) });
    await q('DELETE FROM mail_attachment_filings'); mockDbx.uploads.length = 0;
    const draft = await card({ parts: ['2'], link: false }, { id: 604 });
    const { out } = await apply(draft);
    expect([out.files[0].status, out.linked]).toEqual(['filed', false]);
  });

  test('a typed folder with a leading space lands exactly there; a duplicate is danger and its verdict rides expected', async () => {
    mockDbx.listing = { truncated: false, entries: [{ '.tag': 'folder', path_display: '/cases/debtor/ 012 - Supplemental Responses', path_lower: '/cases/debtor/ 012 - supplemental responses' }] };
    const draft = await card({ parts: ['2'], folder: ' 012 - Supplemental Responses', link: false });
    expect(draft.folder_card).toMatchObject({ path: ' 012 - Supplemental Responses', exists: true });
    const { out } = await apply(draft);
    expect(out.files[0].path).toBe('/cases/debtor/ 012 - Supplemental Responses/stub.pdf');
    // the same stub.pdf (same name, same encoded size) in a later email from her
    await message(605, 1, { subject: 'again', attachments: [pdf(2, 'Stub.PDF')] });
    const dup = await card({ parts: ['2'], link: false }, { id: 605 });
    expect(dup.warnings.some((w) => w.startsWith('DUPLICATE: "Stub.PDF" (part 2) has the same name and size as a file already filed to case 25-70001'))).toBe(true);
    expect(dup.expected.parts[0]).toBe('2|file||||601:0');
  });
});
