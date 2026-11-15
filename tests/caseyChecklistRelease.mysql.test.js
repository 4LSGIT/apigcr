// tests/caseyChecklistRelease.mysql.test.js
//
/**
 * A10X on REAL MySQL — the lifted A10 deferrals: a colleague's personal list,
 * lists on an appointment / event / task, unlinked lists. The normalizer's own
 * SQL (the record labels, DATE_FORMAT on the firm-local naive appt_date, the
 * active-staff predicate taskService.findAssignableStaff on real users rows)
 * and the native routes the cards send (routes/api.checklists.js; GET
 * /api/users/:id from routes/api.users.js for the owner re-read) — real
 * handlers, real pool, production sql_mode — plus the browser's click-time
 * re-read extracted from public/assistant.html.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a10x_test npx jest tests/caseyChecklistRelease.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * naming a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them. It shares table names with the other
 * checklist twins: give it its own _test DB or run it --runInBand after them.
 *
 * WHAT IS LOCKED
 *   - THE ROUTE IS OPEN, CASEY IS NOT: POST /checklists makes a personal list
 *     for a RETIRED user (the route checks nothing); the card refuses that
 *     user by the real active-staff predicate (user_auth LIKE 'authorized%'
 *     AND user_type <> 0 — 'authorized' with user_type 0 and 'inactive' both
 *     refused) and makes the card for an active one, which the route then
 *     writes exactly; the owner re-read over the real GET /api/users/:id
 *     passes, and refuses once the owner is deactivated.
 *   - RECORD LABELS from real rows (appointment, event, task) and the create
 *     + item add on them through the real routes.
 *   - AN UNLINKED LIST: the card's request stores link_type and link NULL
 *     (the board's Unlinked view reads it), the result check accepts the
 *     route's NULL answer, and an item card on it re-reads clean.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => {}) }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => {}) }));
jest.mock('../services/uploadTargetService', () => ({ issueClientUploadLink: jest.fn(), inspectUploadDestination: jest.fn(), raiseUnsortedUploadTask: jest.fn() }));
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'users', 'appts', 'events', 'tasks', 'checklists', 'checkitems', 'trigger_rules', 'trigger_rule_actions'];

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

function fnSrc(html, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`${name} unbalanced`);
}
function constSrc(html, name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
  if (!m) throw new Error(`const ${name} not found`);
  return html.slice(m.index, html.indexOf(';\n', m.index) + 1);
}
function browserFns(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const names = ['checklistFoldTitle', 'checklistParentLabel', 'checklistCreateBody', 'checklistRequest', 'checkitemRequest', 'checklistCreatePrecheck',
    'checklistListPrecheck', 'checklistPrecheck', 'checkitemPrecheck', 'checklistParentPrecheck', 'checklistResult'];
  const src = `${constSrc(html, 'CHECKLIST_LINK_TYPES')}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the lifted checklist deferrals on real MySQL (A10X)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A10XREL1';

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
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype) VALUES (?, '25-60003', 'Bankruptcy', 'Chapter 7')`, [C1]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES (7001, 'person', 'Dana Debtor', 'Dana', 'Debtor')`);
    // 6 = the asker; 1 = active; 2 = 'authorized' but user_type 0; 3 = 'inactive'.
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type, ringcentral, roles) VALUES
      (6, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized', 1, 0, 'staff'),
      (1, 'stuart', 'Stuart', 'Stuart', 'S', 'SS', 'authorized', 1, 0, 'staff'),
      (2, 'gone', 'Gone', 'Gone', 'G', 'GG', 'authorized', 0, 0, 'staff'),
      (3, 'old', 'Old', 'Old', 'O', 'OO', 'inactive', 1, 0, 'staff')`);
    await q(`INSERT INTO appts (appt_id, appt_client_id, appt_case_id, appt_type, appt_status, appt_date) VALUES
      (55, 7001, ?, 'Strategy session', 'Scheduled', '2026-11-20 10:00:00')`, [C1]);
    await q(`INSERT INTO events (event_id, event_type, event_title, event_date, event_status) VALUES (77, 'hearing', '341 meeting', '2026-12-01', 'Scheduled')`);
    await q(`INSERT INTO tasks (task_id, task_status, task_to, task_title) VALUES (88, 'Pending', 1, 'Prepare schedules')`);
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag) VALUES
      (61, 'Stuart to-dos', 'checklist', 'incomplete', 6, '1', 'user', NULL),
      (62, 'Appt prep', 'checklist', 'incomplete', 6, '55', 'appt', NULL)`);
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES (611, 61, 'Call trustee', 'incomplete', 1), (621, 62, 'Print agenda', 'incomplete', 1)`);
  }
  const ev = [
    { id: 'q1', rows: [{ appt_id: 55 }, { event_id: 77 }, { task_id: 88 }] },
    { id: 'q2', rows: [{ checklist_id: 61 }, { checklist_id: 62 }] },
  ];
  const card = (value) => normalizeActionDraft(pool, value, ev, { currentUserId: 6 });
  const apply = async (c, r) => {
    const res = await call(app, r.method, r.path, r.body);
    if (res.status >= 400) throw Object.assign(new Error(res.body.message), { status: res.status });
    return res.body;
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
    app.use(require('../routes/api.checklists'));
    app.use(require('../routes/api.users'));
    // The page's api: the real checklist and users routes; an appointment /
    // event / task GET answers by the row's existence (their routes' 404 rule).
    browser = browserFns(async (p, body, method) => {
      let m;
      if ((m = /^\/api\/(appts|events|tasks)\/(\d+)$/.exec(p))) {
        const [t, col] = { appts: ['appts', 'appt_id'], events: ['events', 'event_id'], tasks: ['tasks', 'task_id'] }[m[1]];
        if (!(await q(`SELECT 1 FROM ${t} WHERE ${col} = ?`, [Number(m[2])])).length) throw Object.assign(new Error('not found'), { status: 404 });
        return { data: {} };
      }
      const qs = method === 'GET' && body ? `?${new URLSearchParams(body)}` : '';
      const res = await call(app, method, p + qs, method === 'GET' ? undefined : body);
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

  beforeEach(async () => { await seed(); });

  test('THE ROUTE IS OPEN, CASEY IS NOT — the route lists for a retired user; the card refuses by the real active-staff predicate', async () => {
    const native = await call(app, 'POST', '/checklists', { title: 'For Old', link_type: 'user', link: '3' });
    expect([native.status, native.body.link]).toEqual([201, '3']);
    await expect(card({ kind: 'checklist.create.v1', title: 'For Gone', link_type: 'user', link: 2, evidence: [] }))
      .rejects.toThrow('A personal list for Gone (user #2) is not available — they are not an active staff member (retired or inactive)');
    await expect(card({ kind: 'checklist.create.v1', title: 'For Old', link_type: 'user', link: 3, evidence: [] }))
      .rejects.toThrow('A personal list for Old (user #3) is not available');
    await expect(card({ kind: 'checklist.create.v1', title: 'For nobody', link_type: 'user', link: 4, evidence: [] }))
      .rejects.toThrow('A personal list for user #4 is not available — that user does not exist');
    // The native list made for user 3 is refused on an item card too.
    const list3 = native.body.id;
    await expect(normalizeActionDraft(pool, { kind: 'checklist.item.add.v1', checklist_id: list3, name: 'x', evidence: [{ query_id: 'q9', row_number: 1 }] },
      [...ev, { id: 'q9', rows: [{ checklist_id: list3 }] }], { currentUserId: 6 })).rejects.toThrow('is the personal list of Old (user #3), who is not an active staff member');
  });

  test('a colleague\'s list: the card for an active owner, the real request writes it exactly, the owner re-read passes — then refuses once deactivated', async () => {
    const c = await card({ kind: 'checklist.create.v1', title: 'Court prep', list_kind: 'checklist', link_type: 'user', link: 1, items: ['Pull docket'], evidence: [] });
    expect([c.owner, c.expected]).toEqual([{ user_id: 1, name: 'Stuart', label: 'Stuart (user #1)' }, { link_type: 'user', link: '1', list_ids: [61] }]);
    expect(await browser.checklistPrecheck(c)).toBe('');
    const r = browser.checklistRequest(c);
    expect(r.body).toEqual({ title: 'Court prep', kind: 'checklist', link_type: 'user', link: '1', items: [{ name: 'Pull docket' }] });
    const made = await apply(c, r);
    expect(browser.checklistResult(c, made)).toEqual({ checklist_id: made.id });
    expect([made.link_type, made.link, made.created_by, made.items.map((i) => i.name)]).toEqual(['user', '1', 6, ['Pull docket']]);
    // An item card on the colleague's list; then the owner is deactivated.
    const add = await card({ kind: 'checklist.item.add.v1', checklist_id: 61, name: 'File reply', evidence: [{ query_id: 'q2', row_number: 1 }] });
    expect(add.owner.user_id).toBe(1);
    expect(await browser.checklistPrecheck(add)).toBe('');
    await q("UPDATE users SET user_auth = 'inactive' WHERE user = 1");
    expect(await browser.checklistPrecheck(add)).toBe('Stuart (user #1) is no longer an active staff member (retired or inactive), so Casey no longer works on their list. Nothing was written.');
    await expect(card({ kind: 'checklist.item.add.v1', checklist_id: 61, name: 'File reply', evidence: [{ query_id: 'q2', row_number: 1 }] }))
      .rejects.toThrow('is the personal list of Stuart (user #1), who is not an active staff member');
    await q("UPDATE users SET user_auth = 'authorized', user_type = 0 WHERE user = 1");
    expect(await browser.checklistPrecheck(add)).toMatch(/is no longer an active staff member/);
  });

  test('RECORD LABELS from real rows; a create and an item add on an appointment / event / task through the real routes', async () => {
    const appt = await card({ kind: 'checklist.create.v1', title: 'Questions', link_type: 'appt', link: 55, evidence: [{ query_id: 'q1', row_number: 1 }] });
    const evnt = await card({ kind: 'checklist.create.v1', title: 'Bring', link_type: 'event', link: 77, evidence: [{ query_id: 'q1', row_number: 2 }] });
    const task = await card({ kind: 'checklist.create.v1', title: 'Steps', link_type: 'task', link: 88, evidence: [{ query_id: 'q1', row_number: 3 }] });
    expect([appt.parent.label, evnt.parent.label, task.parent.label]).toEqual([
      'appointment #55 (Strategy session, 2026-11-20 10:00, Scheduled — Dana Debtor)', 'event #77 ("341 meeting", 2026-12-01, Scheduled)', 'task #88 ("Prepare schedules", Pending)']);
    expect([appt.expected.list_ids, evnt.expected.list_ids, task.expected.list_ids]).toEqual([[62], [], []]);
    for (const c of [appt, evnt, task]) {
      expect(await browser.checklistPrecheck(c)).toBe('');
      const made = await apply(c, browser.checklistRequest(c));
      expect(browser.checklistResult(c, made)).toEqual({ checklist_id: made.id });
      expect([made.link_type, made.link]).toEqual([c.list.link_type, c.list.link]);
    }
    const add = await card({ kind: 'checklist.item.add.v1', checklist_id: 62, name: 'Bring ID', evidence: [{ query_id: 'q2', row_number: 2 }] });
    expect(add.parent.label).toBe('appointment #55 (Strategy session, 2026-11-20 10:00, Scheduled — Dana Debtor)');
    expect(await browser.checklistPrecheck(add)).toBe('');
    await q('DELETE FROM appts WHERE appt_id = 55');
    expect(await browser.checklistPrecheck(add)).toMatch(/^appointment #55 .* no longer exists\. Nothing was written\.$/);
    await expect(card({ kind: 'checklist.item.add.v1', checklist_id: 62, name: 'Bring ID', evidence: [{ query_id: 'q2', row_number: 2 }] })).rejects.toThrow('no longer exists');
  });

  test('AN UNLINKED LIST — stored NULL / NULL by the card\'s request, accepted by the result check, read by the Unlinked view; an item card on it re-reads clean', async () => {
    const c = await card({ kind: 'checklist.create.v1', title: 'Loose ends', list_kind: 'checklist', link_type: 'none', items: ['Sort mail'], evidence: [] });
    expect(await browser.checklistPrecheck(c)).toBe('');
    const made = await apply(c, browser.checklistRequest(c));
    expect([made.link_type, made.link]).toEqual([null, null]);
    expect(browser.checklistResult(c, made)).toEqual({ checklist_id: made.id });
    const unl = await call(app, 'GET', '/checklists?unlinked=1');
    expect(unl.body.checklists.map((r) => r.id)).toEqual([made.id]);
    // A second unlinked list of that title is warned (the engine's collation).
    const again = await card({ kind: 'checklist.create.v1', title: 'LOOSE ENDS', link_type: 'none', evidence: [] });
    expect(again.warnings[0]).toBe(`DUPLICATE TITLE: there is already an unlinked checklist titled "Loose ends" (#${made.id}). This makes a SECOND one — duplicates are allowed; to add to the existing list instead, ask Casey to add items to it.`);
    const evU = [...ev, { id: 'q9', rows: [{ checklist_id: made.id }] }];
    const add = await normalizeActionDraft(pool, { kind: 'checklist.item.add.v1', checklist_id: made.id, name: 'Shred', evidence: [{ query_id: 'q9', row_number: 1 }] }, evU, { currentUserId: 6 });
    expect(add.parent.label).toBe('no record (an unlinked list)');
    expect(await browser.checklistPrecheck(add)).toBe('');
    const res = await apply(add, browser.checklistRequest(add));
    expect(res.items.map((i) => i.name)).toEqual(['Sort mail', 'Shred']);
  });
});
