// tests/caseyChecklistUpsert.mysql.test.js
//
/**
 * A10X on REAL MySQL — Casey's docs-list upsert card against the route it
 * sends: POST /checklists/upsert-items (routes/api.checklists.js — real
 * handler, real pool, production sql_mode), its FIND_DOCS_SQL find (the
 * card's copy is evaluated by the same engine), the real trigger_rules read
 * for the AUTOMATION line, and the browser's click-time re-read and result
 * check extracted from public/assistant.html over the REAL GET / POST answers.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a10x_test npx jest tests/caseyChecklistUpsert.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql. Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them. It shares table names with the other
 * checklist twins: give it its own _test DB or run it --runInBand after them.
 *
 * WHAT IS LOCKED
 *   - THE CARD'S DIFF IS THE ROUTE'S: the item it says is dropped is the one
 *     deleted, every new item is inserted unchecked, the list after (in the
 *     board's order — position NULL first, ties by id) is exactly the route's
 *     answer, the status is the route's, and the event's data is the one the
 *     card dry-ran (but the list id, which a create learns only from the
 *     route). The answer carries the `checklist` {link_type, link} the yc-sync
 *     matcher reads.
 *   - FIND / CREATE / RE-TAG: no docs list → the route creates "Docs Needed"
 *     tagged; an untagged "docs needed" title match (any capitalisation) is
 *     the target and gets the tag; a NOTE titled or tagged as the docs list is
 *     never the target; a tagged list wins over a title match.
 *   - THE SURPRISES THE CARD REFUSES are real: two new items sharing 22
 *     characters → the route inserts both and drops one; a prefix matching two
 *     existing items → the route drops exactly one of them.
 *   - THE AUTOMATION LINE names the ACTIVE rules on checklist.items_upserted
 *     from the real table (an inactive one and another event's are not).
 *   - The browser's re-read passes fresh and refuses after any change.
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
const domainEvents = require('../lib/domainEvents');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'checklists', 'checkitems', 'trigger_rules', 'trigger_rule_actions'];

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
function browserUpsert(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const names = ['checklistParentLabel', 'checklistUpsertRequest', 'checklistUpsertPrecheck', 'checklistUpsertResult'];
  const src = `${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('Casey\'s docs-list upsert card on real MySQL (A10X)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A10XUPS1';

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
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype) VALUES (?, '25-60004', 'Bankruptcy', 'Chapter 7')`, [C1]);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (14, 'checklist.items_upserted', 'Doc request sent → docs stage', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"data.tag","op":"equals","value":"docs_needed"}]}'),
      (15, 'checklist.items_upserted', 'Switched off', 0, 2, 'conditions', '{"operator":"and","conditions":[]}'),
      (16, 'checklist.completed', 'Other event', 1, 1, 'conditions', '{"operator":"and","conditions":[]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
      (14, NULL, 1, 1, 'workflow', '{"workflow_id":42}'), (15, NULL, 1, 1, 'workflow', '{"workflow_id":9}'), (16, NULL, 1, 1, 'workflow', '{"workflow_id":8}')`);
  }
  async function docsList({ id = 71, title = 'Docs Needed', tag = 'docs_needed', status = 'incomplete' } = {}) {
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag) VALUES (?, ?, 'checklist', ?, 6, ?, 'case', ?)`, [id, title, status, C1, tag]);
  }
  const ev = [{ id: 'q1', rows: [{ case_id: C1 }] }];
  const card = (items) => normalizeActionDraft(pool, { kind: 'checklist.items.upsert.v1', case_id: C1, items, evidence: [{ query_id: 'q1', row_number: 1 }] }, ev, { currentUserId: 6 });
  const listItems = async (id) => q('SELECT id, name, status, position FROM checkitems WHERE checklist_id = ? ORDER BY position ASC, id ASC', [id]);
  const send = async (c) => {
    const r = browser.checklistUpsertRequest(c);
    const res = await call(app, r.method, r.path, r.body);
    expect(res.status).toBe(200);
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
    browser = browserUpsert(async (p, body, method) => {
      if (/^\/api\/cases\//.test(p)) {
        const rows = await q('SELECT case_id FROM cases WHERE case_id = ?', [decodeURIComponent(p.split('/')[3])]);
        if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
        return { status: 'success' };
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

  beforeEach(async () => { await seed(); domainEvents.emit.mockClear(); });

  test('THE CARD\'S DIFF IS THE ROUTE\'S — dropped, inserted, the list after in board order, the status, the event data, the bus echo', async () => {
    await docsList();
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES
      (701, 71, '2024 W-2 from every employer', 'complete', 1), (702, 71, 'Pay stubs — last 6 months', 'incomplete', 2), (703, 71, 'Photo ID', 'incomplete', NULL)`);
    const c = await card(['2024 W-2 from every employer (all)', 'Bank statements']);
    expect(c.dropped.map((x) => x.checkitem_id)).toEqual([701]);
    expect(c.automation.rules).toEqual([{ id: 14, name: 'Doc request sent → docs stage' }]);
    expect(c.automation.lines).toEqual(['Trigger rule #14 "Doc request sent → docs stage" runs: starts workflow #42']);
    expect(c.warnings).toContain('AUTOMATION: checklist.items_upserted fires after the write — active trigger rules listening: "Doc request sent → docs stage" (#14).');
    expect(await browser.checklistUpsertPrecheck(c)).toBe('');
    const answer = await send(c);
    expect(browser.checklistUpsertResult(c, answer)).toEqual({ checklist_id: 71 });
    expect([answer.status, answer.checklist.link_type, answer.checklist.link]).toEqual(['success', 'case', C1]);
    // The answered list IS the card's list after, in order, item for item.
    expect(answer.checklist.items.map((i) => [i.name, i.status])).toEqual(c.items_after.map((i) => [i.name, i.status]));
    expect((await listItems(71)).map((i) => Number(i.id))).not.toContain(701);
    expect(answer.checklist.status).toBe(c.list_status.to);
    const [[, type, payload]] = domainEvents.emit.mock.calls;
    expect([type, payload.case_id, payload.source, payload.data]).toEqual(['checklist.items_upserted', C1, 'system',
      { checklist_id: 71, tag: 'docs_needed', title: 'Docs Needed', link_type: 'case', items_upserted: 2, checklist_status: 'incomplete' }]);
    // The card dry-ran exactly that data.
    expect(payload.data).toEqual({ checklist_id: 71, tag: 'docs_needed', title: 'Docs Needed', link_type: 'case', items_upserted: c.items_in.length, checklist_status: c.list_status.to });
    // A card prepared before the write is stale now.
    expect(await browser.checklistUpsertPrecheck(c)).toMatch(/^The items on the docs list of case 25-60004 changed since this card was prepared/);
  });

  test('CREATE — no docs list: the route makes "Docs Needed" tagged; the card said so and named its list after', async () => {
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag) VALUES (72, 'Pre-filing', 'checklist', 'incomplete', 6, ?, 'case', NULL)`, [C1]);
    const c = await card(['Bank statements', 'Lease']);
    expect([c.target, c.expected.target_id, c.expected.lists]).toEqual([null, null, ['72::Pre-filing']]);
    expect(await browser.checklistUpsertPrecheck(c)).toBe('');
    const answer = await send(c);
    expect(browser.checklistUpsertResult(c, answer)).toEqual({ checklist_id: answer.checklist.id });
    expect([answer.checklist.title, answer.checklist.tag, answer.checklist.items.map((i) => i.name)]).toEqual(['Docs Needed', 'docs_needed', c.items_after.map((i) => i.name)]);
    // Prepared again: the new list is now the target, and the old card is stale.
    expect(await browser.checklistUpsertPrecheck(c)).toMatch(/^The checklists on case 25-60004 changed since this card was prepared/);
  });

  test('FIND / RE-TAG — an untagged title match (any case) is the target and gets the tag; a docs NOTE is never the target; a tagged list wins', async () => {
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag) VALUES
      (73, 'Docs Needed', 'note', 'incomplete', 6, ?, 'case', 'docs_needed'),
      (74, 'docs NEEDED', 'checklist', 'complete', 6, ?, 'case', NULL)`, [C1, C1]);
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES (741, 74, 'Lease', 'complete', 1)`);
    const c = await card(['Bank statements']);
    expect(c.target).toEqual({ checklist_id: 74, title: 'docs NEEDED', tag: null, status: 'complete' });
    expect(c.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^TAGS THE LIST: "docs NEEDED" \(#74\)/), expect.stringMatching(/^REOPENS THE LIST/)]));
    const answer = await send(c);
    expect([answer.checklist.id, answer.checklist.tag, answer.checklist.status]).toEqual([74, 'docs_needed', 'incomplete']);
    expect(answer.checklist.items.map((i) => i.name)).toEqual(c.items_after.map((i) => i.name));
    // A tagged list beside a title match: the tagged one is the target (card and route).
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag) VALUES (75, 'Docs Needed', 'checklist', 'incomplete', 6, ?, 'case', NULL)`, [C1]);
    const c2 = await card(['Tax returns']);
    expect(c2.target.checklist_id).toBe(74);
    expect((await send(c2)).checklist.id).toBe(74);
  });

  test('THE SURPRISES THE CARD REFUSES ARE REAL — two new items sharing 22 characters; a prefix matching two existing items', async () => {
    await docsList();
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES
      (711, 71, 'Pay stubs — last 6 months', 'incomplete', 1), (712, 71, 'Pay stubs — last 6 months (spouse)', 'incomplete', 2)`);
    // Two new items with one prefix: the route inserts BOTH and drops one match.
    await expect(card(['Bank statements — Chase checking', 'Bank statements — Chase savings'])).rejects.toThrow('share their first 22 characters');
    const both = await call(app, 'POST', '/checklists/upsert-items', { case_id: C1, items: ['Bank statements — Chase checking', 'Bank statements — Chase savings'] });
    expect(both.body.checklist.items.filter((i) => i.name.startsWith('Bank statements — Chase')).length).toBe(2);
    // A prefix matching two existing items: the route drops exactly ONE of them.
    await expect(card(['Pay stubs — last 6 months, both'])).rejects.toThrow('shares its first 22 characters with 2 items on the docs list');
    const one = await call(app, 'POST', '/checklists/upsert-items', { case_id: C1, items: ['Pay stubs — last 6 months, both'] });
    expect(one.body.checklist.items.filter((i) => [711, 712].includes(i.id)).length).toBe(1);
  });

  test('the re-read refuses a list renamed into the find, a re-tag and a checked item', async () => {
    await docsList({ tag: null });
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag) VALUES (76, 'Pre-filing', 'checklist', 'incomplete', 6, ?, 'case', NULL)`, [C1]);
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES (721, 71, 'Lease', 'incomplete', 1)`);
    const c = await card(['Bank statements']);
    expect(c.target.checklist_id).toBe(71);
    expect(await browser.checklistUpsertPrecheck(c)).toBe('');
    await q("UPDATE checkitems SET status = 'complete' WHERE id = 721");
    expect(await browser.checklistUpsertPrecheck(c)).toMatch(/^The items on the docs list/);
    await q("UPDATE checkitems SET status = 'incomplete' WHERE id = 721");
    await q("UPDATE checklists SET tag = 'docs_needed' WHERE id = 76");
    expect(await browser.checklistUpsertPrecheck(c)).toMatch(/^The checklists on case 25-60004 changed/);
  });
});
