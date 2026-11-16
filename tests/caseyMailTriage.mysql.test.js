// tests/caseyMailTriage.mysql.test.js
//
/**
 * A13 on REAL MySQL: the comms hub routes the Casey mail cards write through —
 * routes/api.mail.js, real handlers, real mailReadService / mailboxService /
 * logService, real pool, under the production sql_mode — plus the normalizers'
 * own reads (the typed mail reads as the asking user, the copy lookup, the
 * caseLink prediction) and the browser's click-time re-reads and answer checks
 * (extracted from public/assistant.html) over the REAL GET / POST / DELETE
 * payloads.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a13_test npx jest tests/caseyMailTriage.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped), with FOREIGN_KEY_CHECKS
 * off, taking any sibling-built child of ours with it (the caseyForms.mysql
 * hygiene). The created log row's date uses CONVERT_TZ(…, 'EST5EDT'): the
 * server needs its tz tables (mysql_tzinfo_to_sql) or the insert fails.
 *
 * WHAT IS LOCKED
 *   - readableScope: a mailbox the user holds no grant on is invisible to
 *     mail.search (and to a mailbox_id filter, which is said), its message is
 *     a not-found row in mail.message, refused by both normalizers ("not a
 *     message you can read"), and 404 on the route; a granted box is read.
 *   - setRead idempotency on the real route: two POSTs leave ONE
 *     mail_read_state row, two DELETEs none; each answers {id, unread}; the
 *     read normalizer refuses the no-op afterwards; read state is per user.
 *   - THE COPIES rule on real rows: the same RFC Message-ID in two readable
 *     boxes, the other copy unread → refused; once read → allowed.
 *   - THE caseLink BRIDGE, each branch against the card's prediction: CREATE
 *     (an 'email' log row about the case, the other party, the text, the
 *     stamp), REUSE via the stamp, via a copy's stamp, via another source's
 *     execution row (log_created false, the same log_id the card named); the
 *     store-only grace 409 the card refuses first; the ALREADY-LINKED branch
 *     — the card refuses this case (no-op) and another case, and the route
 *     itself would RELINK to another case (setLogAbout overwrites), which is
 *     why the card refuses it.
 *   - The browser's prechecks pass on a fresh card and refuse after a change
 *     (read state flipped, message linked since); the answer checks accept the
 *     real answers.
 *   - A13X (2026-11-16): the UNLINK route — DELETE /api/mail/messages/:id/
 *     case-link clears the about-link inside its FOR UPDATE span and nothing
 *     else (the log row and the stamp stay), its 409s in the route's words
 *     (not on the log / on the firm log only / a dead stamp), the card's
 *     prediction = the route's answer, the browser's precheck after a change;
 *     and the BULK read — the cited card's ids are what the route marks (its
 *     answered `ids`), the whole-mailbox card's predicted COUNT is what the
 *     route marks (predict, mark, compare — the same predicate text), the
 *     browser's count precheck from the real summary / list.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

process.env.EMAIL_DOMAINS = 'firm.test';
// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js).
// The user is the x-test-user header (default 7) so one suite can be two people.
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => {
  req.auth = { type: 'jwt', userId: Number(req.headers['x-test-user'] || 7) }; next();
});
const { normalizeActionDraft, mailSearchRead, mailMessageRead } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'cases', 'contacts', 'case_relate', 'contact_emails', 'portal_access_log', 'log',
  'mailboxes', 'channel_grants', 'mail_messages', 'mail_read_state', 'email_ingest_executions', 'mail_sends', 'mail_image_senders'];

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
  const names = ['mailMessageIdOf', 'mailCaseLabel', 'mailReadRequest', 'mailReadMessage', 'mailReadPrecheck', 'mailReadResult',
    'mailLinkRequest', 'mailLinkPrecheck', 'mailLinkResult',
    'mailUnlinkRequest', 'mailUnlinkPrecheck', 'mailUnlinkResult', 'mailBulkRequest', 'mailBulkPrecheck', 'mailBulkResult'];
  const src = `${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { mailReadRequest, mailReadPrecheck, mailReadResult, mailLinkRequest, mailLinkPrecheck, mailLinkResult, mailUnlinkRequest, mailUnlinkPrecheck, mailUnlinkResult, mailBulkRequest, mailBulkPrecheck, mailBulkResult };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey mail cards on real MySQL (A13)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A13CASE1'; const C2 = 'A13CASE2';
  // The message rows: 501 granted box 1 (store-only INBOX); 502 box 2 (no
  // grant); 503 / 504 one email in boxes 1 and 3; 505 stamped; 506 + its copy
  // 507 (stamped) in box 3; 508 logged by another source; 509 fresh.
  const OLD = '2026-10-30 15:05:00';

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
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, roles) VALUES
      (6, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized', 0, 'su'),
      (7, 'rena', 'Rena', 'Rena', 'R', 'RR', 'authorized', 0, 'staff'),
      (8, 'pat', 'Pat', 'Pat', 'P', 'PP', 'authorized', 0, 'staff')`);
    const folders = JSON.stringify({ INBOX: { emit_to_rules: false } });
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, ingest_folders) VALUES
      (1, 'intake@firm.test', 'firm.test', 'imap.test', 'intake', ?),
      (2, 'private@firm.test', 'firm.test', 'imap.test', 'private', ?),
      (3, 'billing@firm.test', 'firm.test', 'imap.test', 'billing', ?)`, [folders, folders, folders]);
    await q(`INSERT INTO channel_grants (id, user, channel_type, channel_id, can_read, granted_by) VALUES
      (1, 7, 'mailbox', 1, 1, 6), (2, 7, 'mailbox', 3, 1, 6), (3, 8, 'mailbox', 1, 1, 6)`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype) VALUES
      (?, '25-70001', 'Bankruptcy', 'Chapter 7'), (?, '25-70002', 'Bankruptcy', 'Chapter 13')`, [C1, C2]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname, contact_phone, contact_email) VALUES
      (7001, 'person', 'Dana Q. Debtor', 'Dana', 'Debtor', '3135551212', 'dana@example.com'),
      (7002, 'person', 'Other Client', 'Other', 'Client', '', 'other@example.com')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES
      (951, ?, 7001, 'Primary'), (952, ?, 7002, 'Primary')`, [C1, C2]);
    await q(`INSERT INTO contact_emails (id, contact_id, email) VALUES (91, 7001, 'Dana.Work@Example.com')`);
    await q(`INSERT INTO log (log_id, log_type, log_date, log_link, log_link_type, log_link_id, log_by, log_data, log_message) VALUES
      (4001, 'email', '2026-10-30 11:00:00', '', 'email', 'dana@example.com', 0, '{}', 'stamped text'),
      (4002, 'email', '2026-10-30 11:00:00', '', 'email', 'dana@example.com', 0, '{}', 'copy text'),
      (4003, 'email', '2026-10-30 11:00:00', '', 'email', 'dana@example.com', 0, '{}', 'source text')`);
    const msg = (id, box, mid, over = {}) => ({ id, mailbox_id: box, folder: 'INBOX', uid: id, message_id: mid,
      from_addr: 'Dana Debtor <dana@example.com>', to_addrs: 'intake@firm.test', subject: `Subject ${id}`, date: '2026-10-30 15:04:00',
      snippet: `snippet ${id}`, body_text: `Body of ${id}.`, body_html: '<p>html</p>', log_id: null, ingested_at: OLD, ...over });
    const rows = [
      msg(501, 1, 'm501@x.test', { subject: 'Pay stubs', body_text: 'Here are my pay stubs.' }),
      msg(502, 2, 'm502@x.test', { from_addr: 'Stranger <s@else.test>', subject: 'Private' }),
      msg(503, 1, 'm503@x.test'), msg(504, 3, 'm503@x.test'),
      msg(505, 1, 'm505@x.test', { log_id: 4001 }),
      msg(506, 1, 'm506@x.test'), msg(507, 3, 'm506@x.test', { log_id: 4002 }),
      msg(508, 1, 'm508@x.test'),
      msg(509, 1, 'm509@x.test', { ingested_at: null }),
    ];
    for (const r of rows) {
      await q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, from_addr, to_addrs, subject, date, snippet, body_text, body_html, log_id, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP()))`,
      [r.id, r.mailbox_id, r.folder, r.uid, r.message_id, r.from_addr, r.to_addrs, r.subject, r.date, r.snippet, r.body_text, r.body_html, r.log_id, r.ingested_at]);
    }
    await q(`INSERT INTO email_ingest_executions (id, source_id, message_id, status, log_id) VALUES (1, 1, '<m508@x.test>', 'logged', 4003)`);
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
    app.use(require('../routes/api.mail'));
    const caseService = require('../services/caseService');
    // The page's api(path, body, method): a non-2xx throws with .status (apiSend's contract).
    browser = browserChecks(async (p, body, method) => {
      const caseRoute = /^\/api\/cases\/([^/]+)(\/contacts)?$/.exec(p);
      if (caseRoute) {
        const id = decodeURIComponent(caseRoute[1]);
        // GET /api/cases/:id/contacts is caseService.getCaseContacts verbatim (the route's whole body).
        if (caseRoute[2]) return { contacts: await caseService.getCaseContacts(pool, id) };
        const rows = await q('SELECT case_id FROM cases WHERE case_id = ?', [id]);
        if (!rows.length) throw Object.assign(new Error('Case not found'), { status: 404 });
        return { case: rows[0] };
      }
      // apiSend turns a GET payload into the query string
      const url = method === 'GET' && body && typeof body === 'object' ? `${p}?${new URLSearchParams(body).toString()}` : p;
      const res = await call(app, method, url, method === 'GET' ? undefined : body);
      if (res.status >= 400) throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
      return res.body;
    });
  });
  beforeEach(seed);
  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  const search = (rows) => ({ id: 'q1', kind: 'mail.search', purpose: 'mail', rows: [{ row_type: 'search' },
    ...rows.map((id) => ({ row_type: 'message', mail_message_id: String(id) }))] });
  const caseRead = { id: 'q2', kind: 'sql.read', purpose: 'case', rows: [{ case_id: C1 }, { case_id: C2 }] };
  const evidence = (ids) => [search(ids), caseRead];
  const readCard = (id, read = true) => ({ kind: 'mail.read.v1', mail_message_id: id, read, evidence: [{ query_id: 'q1', row_number: 2 }] });
  const linkCard = (id, caseId = C1) => ({ kind: 'mail.case_link.v1', mail_message_id: id, case_id: caseId,
    evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: caseId === C1 ? 1 : 2 }] });
  const unlinkCard = (id) => ({ kind: 'mail.case_unlink.v1', mail_message_id: id, evidence: [{ query_id: 'q1', row_number: 2 }] });
  const bulkIdsCard = (ids) => ({ kind: 'mail.read.bulk.v1', mail_message_ids: ids, evidence: ids.map((_, i) => ({ query_id: 'q1', row_number: i + 2 })) });
  const bulkAllCard = (over = {}) => ({ kind: 'mail.read.bulk.v1', all: true, evidence: [], ...over });
  const normMany = (card, ids, user = 7) => normalizeActionDraft(pool, card, evidence(ids), { currentUserId: user });
  const norm = (card, user = 7) => normalizeActionDraft(pool, card, evidence([card.mail_message_id]), { currentUserId: user });
  const readRows = async (user) => q('SELECT user, message_fk FROM mail_read_state WHERE user = ? ORDER BY message_fk', [user]);

  test('readableScope: a box without a grant is invisible to the reads, refused by both cards, 404 on the route', async () => {
    const all = await mailSearchRead(pool, 7, { folder: 'inbox', limit: 20 });
    const ids = all.rows.filter((r) => r.row_type === 'message').map((r) => r.mail_message_id).sort();
    expect(ids).toContain(501);
    expect(ids).toContain(504);
    expect(ids).not.toContain(502);
    for (const r of all.rows.slice(1)) expect(Object.keys(r)).not.toContain('body_text');
    const boxed = await mailSearchRead(pool, 7, { mailbox_id: 2 });
    expect(boxed.rows).toEqual([expect.objectContaining({ row_type: 'search', note: 'No mailbox #2 that you can read — it does not exist or you hold no read grant on it.' })]);
    expect((await mailMessageRead(pool, 7, 502)).rows[0]).toMatchObject({ row_type: 'not_found', mail_message_id: 502 });
    const one = (await mailMessageRead(pool, 7, 501)).rows[0];
    expect(one).toMatchObject({ row_type: 'message', mail_message_id: 501, mailbox: 'intake@firm.test', subject: 'Pay stubs', read_by_me: 0,
      body_text_excerpt: 'Here are my pay stubs.', body_chars: 22 });
    expect(JSON.stringify(one)).not.toContain('<p>html</p>');
    await expect(norm(readCard(502))).rejects.toThrow('Message #502 is not a message you can read');
    await expect(norm(linkCard(502))).rejects.toThrow('Message #502 is not a message you can read');
    expect((await call(app, 'POST', '/api/mail/messages/502/read', {})).status).toBe(404);
    // The SU reads it (the hub's own bypass, unchanged for Casey).
    expect((await mailMessageRead(pool, 6, 502)).rows[0]).toMatchObject({ row_type: 'message', mail_message_id: 502 });
  });

  test('mail.search filters on the engine: q (sender or subject), an exact sender address, unread-only, since', async () => {
    expect((await mailSearchRead(pool, 7, { q: 'Pay stubs' })).rows.slice(1).map((r) => r.mail_message_id)).toEqual([501]);
    expect((await mailSearchRead(pool, 7, { from: 'dana@example.com' })).rows.length).toBeGreaterThan(2);
    expect((await mailSearchRead(pool, 7, { from: 'example.com', unread_only: true })).rows.slice(1).every((r) => r.read_by_me === 0)).toBe(true);
    expect((await mailSearchRead(pool, 7, { since: '2026-11-01' })).rows.slice(1)).toEqual([]);
  });

  test('setRead is idempotent and per user; the read card refuses the no-op afterwards; the browser checks pass on the real answers', async () => {
    const card = await norm(readCard(501));
    expect(card).toMatchObject({ before: 'unread', after: 'read', expected: { unread: true } });
    expect(await browser.mailReadPrecheck(card)).toBe('');
    const rq = browser.mailReadRequest(card);
    expect(rq).toEqual({ path: '/api/mail/messages/501/read', method: 'POST', body: {} });
    const first = await call(app, rq.method, rq.path, rq.body);
    const second = await call(app, rq.method, rq.path, rq.body);
    expect([first.status, first.body, second.body]).toEqual([200, { status: 'success', id: 501, unread: false }, { status: 'success', id: 501, unread: false }]);
    expect(browser.mailReadResult(card, first.body)).toEqual({ mail_message_id: 501 });
    expect(await readRows(7)).toEqual([{ user: 7, message_fk: 501 }]);
    expect(await readRows(8)).toEqual([]); // per user
    await expect(norm(readCard(501))).rejects.toThrow('That changes nothing — message #501 is already read for you');
    expect(await browser.mailReadPrecheck(card)).toBe('Message #501 is now read for you — its read state changed since this card was prepared. Nothing was written.');
    const un = await norm(readCard(501, false));
    expect(browser.mailReadRequest(un)).toEqual({ path: '/api/mail/messages/501/read', method: 'DELETE', body: null });
    const d1 = await call(app, 'DELETE', '/api/mail/messages/501/read');
    const d2 = await call(app, 'DELETE', '/api/mail/messages/501/read');
    expect([d1.body, d2.body]).toEqual([{ status: 'success', id: 501, unread: true }, { status: 'success', id: 501, unread: true }]);
    expect(await readRows(7)).toEqual([]);
  });

  test('COPIES on real rows: the other readable copy unread → refused; read → allowed; a copy in a box the user cannot read does not count', async () => {
    await expect(norm(readCard(503))).rejects.toThrow('COPIES refused: this email is stored 2 times in mail you can read, and 1 other copy is still unread for you (message #504)');
    await call(app, 'POST', '/api/mail/messages/504/read', {});
    await expect(norm(readCard(503))).resolves.toMatchObject({ copies: 1, after: 'read' });
    // User 8 reads box 1 only: 504 (box 3) is not theirs to count.
    await expect(norm(readCard(503), 8)).resolves.toMatchObject({ copies: 0 });
  });

  test('caseLink CREATE: the card\'s prediction is what the route writes (an email entry about the case, the other party, the text, the stamp)', async () => {
    const card = await norm(linkCard(501));
    expect(card.log).toEqual({ mode: 'create', other_party: 'dana@example.com', direction: 'incoming', message_chars: 22, derived: false, date: '2026-10-30T15:04:00.000Z' });
    expect(card.identity.matched).toEqual([{ address: 'dana@example.com', contact_id: 7001, name: 'Dana Q. Debtor', relate_type: 'Primary' }]);
    expect(card.expected).toEqual({ stamp_log_id: null, log_id: null, contacts: ['7001:dana@example.com'] });
    expect(await browser.mailLinkPrecheck(card)).toBe('');
    const rq = browser.mailLinkRequest(card);
    expect(rq).toEqual({ path: '/api/mail/messages/501/case-link', method: 'POST', body: { case_id: C1 } });
    const res = await call(app, rq.method, rq.path, rq.body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'success', id: 501, log_created: true, case: { case_id: C1, case_number: '25-70001' } });
    expect(browser.mailLinkResult(card, res.body)).toEqual({ log_id: res.body.log_id });
    const [row] = await q('SELECT log_type, log_link_type, log_link_id, log_about_type, log_about_id, log_by, log_message, log_direction FROM log WHERE log_id = ?', [res.body.log_id]);
    expect(row).toEqual({ log_type: 'email', log_link_type: 'email', log_link_id: 'dana@example.com', log_about_type: 'case', log_about_id: C1,
      log_by: 7, log_message: 'Here are my pay stubs.', log_direction: 'incoming' });
    expect((await q('SELECT log_id FROM mail_messages WHERE id = 501'))[0].log_id).toBe(res.body.log_id);
    // THE ALREADY-LINKED BRANCH: this case is a no-op; another case is a MOVE the card discloses (2026-11-11, was refused) — and the route relinks.
    await expect(norm(linkCard(501))).rejects.toThrow(`That changes nothing — message #501 is already linked to case 25-70001 (log entry #${res.body.log_id})`);
    const moveCard = await norm(linkCard(501, C2));
    expect(moveCard.warnings).toContain(`MOVES THE EMAIL OFF ANOTHER CASE: message #501 is linked to case 25-70001 (log entry #${res.body.log_id}). A log entry has ONE about-link, so linking sets it to case 25-70002: the email leaves case 25-70001's Comms and Log tabs. If it belongs on both cases, leave it — an email shows on one case at a time (the Comms tab's case tag does the same move).`);
    expect(await browser.mailLinkPrecheck(card)).toBe('Message #501 is already linked to case 25-70001 — someone linked it since this card was prepared. Nothing was written.');
    const relink = await call(app, 'POST', '/api/mail/messages/501/case-link', { case_id: C2 });
    expect([relink.status, relink.body.log_created, relink.body.log_id]).toEqual([200, false, res.body.log_id]);
    expect((await q('SELECT log_about_id FROM log WHERE log_id = ?', [res.body.log_id]))[0].log_about_id).toBe(C2);
  });

  test('a long body: the card\'s column disclosure is what the engine keeps (log_message cut at 10,000; log_data whole)', async () => {
    await q('UPDATE mail_messages SET body_text = ? WHERE id = 501', ['x'.repeat(12000)]);
    const card = await norm(linkCard(501));
    expect(card.effects).toContain('Long text: the entry\'s message column holds 10,000 characters, so it keeps the first 10,000 of these 12,000; the entry\'s data copy keeps the rest.');
    const res = await call(app, 'POST', '/api/mail/messages/501/case-link', { case_id: C1 });
    const [row] = await q("SELECT CHAR_LENGTH(log_message) AS m, CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(log_data, '$.Message'))) AS d FROM log WHERE log_id = ?", [res.body.log_id]);
    expect(row).toEqual({ m: 10000, d: 12000 });
  });

  test('caseLink REUSE — via the stamp, a copy\'s stamp, another source\'s row — links exactly the entry the card named', async () => {
    for (const [id, via, logId] of [[505, 'stamped', 4001], [506, 'copy', 4002], [508, 'source', 4003]]) {
      const card = await norm(linkCard(id));
      expect({ id, log: card.log }).toEqual({ id, log: expect.objectContaining({ mode: 'reuse', via, log_id: logId }) });
      expect(await browser.mailLinkPrecheck(card)).toBe('');
      const res = await call(app, 'POST', `/api/mail/messages/${id}/case-link`, { case_id: C1 });
      expect({ id, status: res.status, log_id: res.body.log_id, created: res.body.log_created }).toEqual({ id, status: 200, log_id: logId, created: false });
      expect((await q('SELECT log_about_type, log_about_id FROM log WHERE log_id = ?', [logId]))[0]).toEqual({ log_about_type: 'case', log_about_id: C1 });
      expect((await q('SELECT log_id FROM mail_messages WHERE id = ?', [id]))[0].log_id).toBe(logId);
    }
    expect((await q('SELECT COUNT(*) AS n FROM log'))[0].n).toBe(3); // nothing created
  });

  test('the store-only grace: the card refuses what the route 409s; a dead stamp likewise', async () => {
    await expect(norm(linkCard(509))).rejects.toThrow(/^This email arrived in the last few minutes and another mail sync may still log it/);
    const res = await call(app, 'POST', '/api/mail/messages/509/case-link', { case_id: C1 });
    expect([res.status, res.body.message]).toEqual([409, 'This email arrived in the last few minutes and another mail sync may still log it — try again in about 10 minutes.']);
    await q('UPDATE mail_messages SET log_id = 9999 WHERE id = 501');
    await expect(norm(linkCard(501))).rejects.toThrow('The log entry this message points at no longer exists (log #9999)');
    const dead = await call(app, 'POST', '/api/mail/messages/501/case-link', { case_id: C1 });
    expect([dead.status, dead.body.message]).toEqual([409, 'The log entry this message points at no longer exists.']);
  });

  test('the browser\'s link precheck refuses on a changed contact set and a newly logged message', async () => {
    const card = await norm(linkCard(501));
    await q("UPDATE contacts SET contact_email = 'new@example.com' WHERE contact_id = 7001");
    expect(await browser.mailLinkPrecheck(card)).toMatch(/^The contacts on case 25-70001 changed since this card was prepared/);
    await q("UPDATE contacts SET contact_email = 'dana@example.com' WHERE contact_id = 7001");
    expect(await browser.mailLinkPrecheck(card)).toBe('');
    await q('UPDATE mail_messages SET log_id = 4001 WHERE id = 501');
    expect(await browser.mailLinkPrecheck(card)).toMatch(/^Message #501's log entry changed since this card was prepared/);
  });

  // ── A13X: the unlink ──
  test('UNLINK: the card predicts the route; the route clears ONLY the about-link (the row, its text and the stamp stay); the repeat is a 409 the card refuses first', async () => {
    // put 505 (stamped → log 4001) on C1 through the real link route
    const link = await call(app, 'POST', '/api/mail/messages/505/case-link', { case_id: C1 });
    expect([link.status, link.body.log_id]).toEqual([200, 4001]);
    const card = await norm(unlinkCard(505));
    expect(card).toMatchObject({ kind: 'mail.case_unlink.v1', case: { case_id: C1, case_number: '25-70001', label: 'case 25-70001', exists: true },
      log: { log_id: 4001, via: 'stamped', type: 'email', link: 'email dana@example.com', message_chars: 12 },
      expected: { stamp_log_id: 4001, log_id: 4001, case_id: C1 } });
    expect(card.warnings).toEqual(["LEAVES CASE 25-70001: case 25-70001's Comms tab and Log tab stop listing this email once applied. Nothing is deleted — a link card puts it back if it belongs there."]);
    expect(await browser.mailUnlinkPrecheck(card)).toBe('');
    const rq = browser.mailUnlinkRequest(card);
    expect(rq).toEqual({ path: '/api/mail/messages/505/case-link', method: 'DELETE', body: null });
    const before = await q('SELECT log_type, log_link_type, log_link_id, log_message, log_data, log_by FROM log WHERE log_id = 4001');
    const res = await call(app, rq.method, rq.path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', id: 505, log_id: 4001, case: { case_id: C1, case_number: '25-70001' } });
    expect(browser.mailUnlinkResult(card, res.body)).toEqual({ log_id: 4001 });
    const [row] = await q('SELECT log_type, log_link_type, log_link_id, log_message, log_data, log_by, log_about_type, log_about_id FROM log WHERE log_id = 4001');
    expect(row).toEqual({ ...before[0], log_about_type: null, log_about_id: null });
    expect((await q('SELECT log_id FROM mail_messages WHERE id = 505'))[0].log_id).toBe(4001); // the stamp stays
    expect((await q('SELECT COUNT(*) AS n FROM log'))[0].n).toBe(3); // nothing created or deleted
    // the hub's read agrees; the precheck now refuses; the card refuses first; the route 409s in its words
    const got = await call(app, 'GET', '/api/mail/messages/505');
    expect(got.body.messages[0].log_status).toMatchObject({ state: 'logged', log_id: 4001 });
    expect(await browser.mailUnlinkPrecheck(card)).toBe('Message #505 is no longer on case 25-70001 — someone took it off since this card was prepared. Nothing was written.');
    await expect(norm(unlinkCard(505))).rejects.toThrow('That changes nothing — message #505 is not on a case: log entry #4001 is on the firm log, not on a case. (The route refuses it: "This message is not on a case: its log entry is on the firm log, not on a case.")');
    const again = await call(app, 'DELETE', '/api/mail/messages/505/case-link');
    expect([again.status, again.body.message]).toEqual([409, 'This message is not on a case: its log entry is on the firm log, not on a case.']);
    expect((await q('SELECT log_about_type FROM log WHERE log_id = 4001'))[0].log_about_type).toBeNull();
  });

  test("UNLINK resolves a copy's stamp and another source's row exactly as the link does; not-on-the-log and a dead stamp are 409s the card refuses in the same words; no grant → 404", async () => {
    // 506 is unstamped; its copy 507 carries 4002. Link 506 through the copy, then unlink 506 — the same row.
    expect((await call(app, 'POST', '/api/mail/messages/506/case-link', { case_id: C2 })).body.log_id).toBe(4002);
    const viaCopy = await norm(unlinkCard(506));
    // the link stamped 506 itself, so the card now sees the stamp (route parity: so does caseUnlink)
    expect(viaCopy.log).toMatchObject({ log_id: 4002, via: 'stamped' });
    expect(viaCopy.case.case_id).toBe(C2);
    const r1 = await call(app, 'DELETE', '/api/mail/messages/506/case-link');
    expect(r1.body).toMatchObject({ id: 506, log_id: 4002, case: { case_id: C2 } });
    // 508: another source's execution row → log 4003, put on C1 by the link; unlink an UNSTAMPED twin path: clear the stamp first to exercise priorLogId on the route
    expect((await call(app, 'POST', '/api/mail/messages/508/case-link', { case_id: C1 })).body.log_id).toBe(4003);
    await q('UPDATE mail_messages SET log_id = NULL WHERE id = 508');
    const viaSource = await norm(unlinkCard(508));
    expect(viaSource.log).toMatchObject({ log_id: 4003, via: 'source' });
    expect(viaSource.expected).toEqual({ stamp_log_id: null, log_id: 4003, case_id: C1 });
    const r2 = await call(app, 'DELETE', '/api/mail/messages/508/case-link');
    expect(r2.body).toMatchObject({ id: 508, log_id: 4003, case: { case_id: C1 } });
    expect((await q('SELECT log_id FROM mail_messages WHERE id = 508'))[0].log_id).toBeNull(); // the unlink never stamps
    // not on the log at all
    await expect(norm(unlinkCard(501))).rejects.toThrow('That changes nothing — message #501 is not on a case: it is not on the log. (The route refuses it: "This message is not on a case: it is not on the log.")');
    const none = await call(app, 'DELETE', '/api/mail/messages/501/case-link');
    expect([none.status, none.body.message]).toEqual([409, 'This message is not on a case: it is not on the log.']);
    // a dead stamp
    await q('UPDATE mail_messages SET log_id = 9999 WHERE id = 501');
    await expect(norm(unlinkCard(501))).rejects.toThrow('The log entry this message points at no longer exists (log #9999)');
    const dead = await call(app, 'DELETE', '/api/mail/messages/501/case-link');
    expect([dead.status, dead.body.message]).toEqual([409, 'The log entry this message points at no longer exists.']);
    // no grant: 404, nothing written
    await expect(norm(unlinkCard(502))).rejects.toThrow('Message #502 is not a message you can read');
    expect((await call(app, 'DELETE', '/api/mail/messages/502/case-link')).status).toBe(404);
  });

  // ── A13X: the bulk read ──
  test('BULK (cited): the card\'s frozen ids are exactly what the route marks and answers; copies ride along; the browser checks pass on the real answers', async () => {
    // 503 (box 1) and 504 (box 3) are one email; both unread for 7.
    const card = await normMany(bulkIdsCard([503]), [503]);
    expect(card).toMatchObject({ mode: 'ids', count: 2, copies: 1, expected: { mode: 'ids', ids: [503, 504], count: 2, cited: [{ mail_message_id: 503, unread: true }] } });
    expect(await browser.mailBulkPrecheck(card)).toBe('');
    const rq = browser.mailBulkRequest(card);
    expect(rq).toEqual({ path: '/api/mail/read', method: 'POST', body: { ids: [503, 504] } });
    const res = await call(app, rq.method, rq.path, rq.body);
    expect(res.body).toEqual({ status: 'success', marked: 2, ids: [503, 504] });
    expect(browser.mailBulkResult(card, res.body)).toEqual({ marked: 2 });
    expect(await readRows(7)).toEqual([{ user: 7, message_fk: 503 }, { user: 7, message_fk: 504 }]);
    expect(await readRows(8)).toEqual([]);
    // the single read card refuses the copies case and names the bulk card; the bulk card refuses the no-op afterwards; the precheck refuses the flipped state
    await expect(norm(readCard(505))).resolves.toMatchObject({ kind: 'mail.read.v1' });
    await expect(normMany(bulkIdsCard([503]), [503])).rejects.toThrow('That changes nothing — message #503 is already read for you (every stored copy of it)');
    expect(await browser.mailBulkPrecheck(card)).toBe('Message #503 is now read for you — its read state changed since this card was prepared. Nothing was written.');
    // a repeat of the route is a no-op with empty ids; a mix of cited messages skips the read one
    expect((await call(app, 'POST', '/api/mail/read', { ids: [503, 504] })).body).toEqual({ status: 'success', marked: 0, ids: [] });
    const mixed = await normMany(bulkIdsCard([503, 501]), [503, 501]);
    expect(mixed.skipped.map((r) => r.mail_message_id)).toEqual([503]);
    expect(mixed.expected.ids).toEqual([501]);
    // 502 is not readable: refused by the card; the route silently marks nothing for it
    await expect(normMany(bulkIdsCard([502]), [502])).rejects.toThrow('Message #502 is not a message you can read');
    expect((await call(app, 'POST', '/api/mail/read', { ids: [502] })).body).toEqual({ status: 'success', marked: 0, ids: [] });
  });

  test('BULK (whole mailbox): predict, mark, compare — the card\'s count IS the route\'s marked, with and without filters; the browser re-counts from the real summary / list', async () => {
    // Everything 7 can read in the Inbox: boxes 1 (501, 503, 505, 506, 508, 509) + 3 (504, 507) = 8 unread.
    const card = await norm(bulkAllCard());
    expect(card).toMatchObject({ mode: 'all', count: 8, scope: 'the Inbox of intake@firm.test, billing@firm.test', expected: { mode: 'all', mailbox_ids: [1, 3], filters: {}, count: 8, filtered: false } });
    expect(card.mailboxes).toEqual([{ mailbox_id: 1, address: 'intake@firm.test', alias_of: null }, { mailbox_id: 3, address: 'billing@firm.test', alias_of: null }]);
    expect(await browser.mailBulkPrecheck(card)).toBe('');
    // a filtered scope: box 1, subject matching q — 'Pay stubs' hits 501 only (the FULLTEXT index is not built here; q falls back to LIKE on subject / sender)
    const filtered = await norm(bulkAllCard({ mailbox_ids: [1], filters: { q: 'Pay stubs' } }));
    expect(filtered).toMatchObject({ count: 1, scope: 'the Inbox of intake@firm.test — matching "Pay stubs"', expected: { mailbox_ids: [1], filters: { q: 'Pay stubs' }, count: 1, filtered: true } });
    expect(await browser.mailBulkPrecheck(filtered)).toBe('');
    const frq = browser.mailBulkRequest(filtered);
    expect(frq).toEqual({ path: '/api/mail/read', method: 'POST', body: { all: true, mailbox_ids: [1], filters: { q: 'Pay stubs' } } });
    const fres = await call(app, frq.method, frq.path, frq.body);
    expect(fres.body).toEqual({ status: 'success', marked: 1 });
    expect(browser.mailBulkResult(filtered, fres.body)).toEqual({ marked: 1 });
    expect(await readRows(7)).toEqual([{ user: 7, message_fk: 501 }]);
    // the unfiltered card is now stale by one: the summary says 7
    expect(await browser.mailBulkPrecheck(card)).toBe('The scope now holds 7 unread messages, not the 8 this card reviewed — it changed since the card was prepared. Nothing was written. Ask Casey to prepare it again.');
    const fresh = await norm(bulkAllCard());
    expect(fresh.count).toBe(7);
    const rq = browser.mailBulkRequest(fresh);
    const res = await call(app, rq.method, rq.path, rq.body);
    expect(res.body).toEqual({ status: 'success', marked: 7 });
    expect(browser.mailBulkResult(fresh, res.body)).toEqual({ marked: 7 });
    expect((await readRows(7)).length).toBe(8);
    expect(await readRows(8)).toEqual([]); // per user
    // nothing left: the card refuses; a box the user cannot read is refused by number; a bad filter in the hub's words
    await expect(norm(bulkAllCard())).rejects.toThrow('That changes nothing — nothing is unread for you in the Inbox of intake@firm.test, billing@firm.test');
    await expect(norm(bulkAllCard({ mailbox_ids: [2] }))).rejects.toThrow('No mailbox #2 that you can read');
    await expect(norm(bulkAllCard({ filters: { starred: true } }))).rejects.toThrow('The bulk scope is refused (the hub\'s own rule): filters: unknown key "starred"');
    // the SU reads box 2 too: 502 is the one unread there
    expect((await normalizeActionDraft(pool, bulkAllCard({ mailbox_ids: [2] }), [], { currentUserId: 6 })).count).toBe(1);
  });
});
