// tests/caseyChecklists.mysql.test.js
//
/**
 * A10 on REAL MySQL: the Casey checklist normalizer's own SQL (the parent
 * record, the lists on it, one list with its items, the portal's docs
 * predicate evaluated by the engine), the real trigger-rule load and dry run,
 * and the native route behaviour every refusal rests on — routes/api.checklists.js,
 * real handlers, real pool, under the production sql_mode — plus the browser's
 * click-time re-read (extracted from public/assistant.html) over the REAL GET
 * payloads.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a10_test npx jest tests/caseyChecklists.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them (the caseyPipeline.mysql hygiene).
 *
 * WHAT IS LOCKED
 *   - NO NATIVE DUPLICATE-NAME GUARD: POST /checklists/:id/items stores the
 *     same name twice (any capitalisation) — the normalizer refuses it.
 *   - NO NATIVE WIDTH GUARD: a 300-character title or item name is stored
 *     clipped to 255 under the relaxed sql_mode — the normalizer refuses > 255.
 *   - A NOTE REJECTS ITEMS (both routes, 400) and a checklist a body.
 *   - THE DERIVED STATUS TRANSITION: completing the last open item completes
 *     the list and emits checkitem.completed + checklist.completed with
 *     exactly the data the card dry-ran; reopening reopens it with no list
 *     event; adding an item to a complete list reopens it. The PATCH answer is
 *     the item row byte-identical plus the additive `checklist` echo.
 *   - THE PUBLIC DOCS PREDICATE ON TITLE: an UNTAGGED case list titled "docs
 *     needed" (any case — general_ci) is read by the unauthenticated docs GET,
 *     a contact list of that title is not — why the create refusal folds the
 *     title and is case-only, and the item cards' docs_list flag agrees.
 *   - The dry run reads the real active rules (an inactive one and one on
 *     another event are not listed).
 *   - The browser's prechecks pass on a fresh card and refuse after a change.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js
// — a staff JWT, not SU, so mayWriteTag refuses a tag), the event queue
// (observed, not run; buildEnvelope stays REAL via requireActual) and the
// public upload routes' mail / log / upload-target graph.
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => {}) }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => {}) }));
jest.mock('../services/uploadTargetService', () => ({ issueClientUploadLink: jest.fn(), inspectUploadDestination: jest.fn(), raiseUnsortedUploadTask: jest.fn() }));
const domainEvents = require('../lib/domainEvents');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'checklists', 'checkitems', 'trigger_rules', 'trigger_rule_actions'];

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

// The browser's prechecks, extracted verbatim from the page (the assistantUi
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
function browserPrechecks(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const names = ['checklistFoldTitle', 'checklistParentLabel', 'checklistCreateBody', 'checklistRequest', 'checkitemRequest',
    'checklistCreatePrecheck', 'checklistListPrecheck', 'checklistPrecheck', 'checkitemPrecheck'];
  const src = `const CHECKLIST_LINK_TYPES = ['case', 'contact', 'user'];\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { checklistPrecheck, checkitemPrecheck };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey checklist cards on real MySQL (A10)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A10CASE1';

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
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype) VALUES (?, '25-60001', 'Bankruptcy', 'Chapter 7')`, [C1]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (6001, 'person', 'Dana Debtor', 'Dana', 'Debtor')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (901, ?, 6001, 'Primary')`, [C1]);
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag, created_date) VALUES
      (21, 'Pre-filing', 'checklist', 'incomplete', 6, ?, 'case', NULL, '2026-10-01 10:00:00'),
      (22, 'Call log', 'note', 'incomplete', 6, ?, 'case', NULL, '2026-10-02 10:00:00'),
      (23, 'Fred list', 'checklist', 'incomplete', 6, '6', 'user', NULL, '2026-10-03 10:00:00')`, [C1, C1]);
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES
      (301, 21, 'Pull credit report', 'incomplete', 1), (302, 21, 'Order transcripts', 'complete', 2)`);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (1, 'checkitem.completed', 'Credit report done', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"data.name","op":"equals","value":"Pull credit report"}]}'),
      (2, 'checklist.completed', 'List done', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"data.link_type","op":"equals","value":"case"}]}'),
      (3, 'checklist.completed', 'Switched off', 0, 2, 'conditions', '{"operator":"and","conditions":[]}'),
      (4, 'checklist.items_upserted', 'Other event', 1, 1, 'conditions', '{"operator":"and","conditions":[]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
      (1, 'Log it', 1, 1, 'internal_function', '{"function_name":"create_log"}'),
      (2, NULL, 1, 1, 'workflow', '{"workflow_id":42}'), (3, NULL, 1, 1, 'workflow', '{"workflow_id":9}'), (4, NULL, 1, 1, 'workflow', '{"workflow_id":8}')`);
  }
  const ev = [
    { id: 'q1', rows: [{ case_id: C1 }] },
    { id: 'q2', rows: [{ checklist_id: 21 }, { checklist_id: 22 }, { checklist_id: 23 }] },
    { id: 'q3', rows: [{ checkitem_id: 301 }, { checkitem_id: 302 }] },
  ];
  const card = (value) => normalizeActionDraft(pool, value, ev, { currentUserId: 6 });
  const items = (id) => q('SELECT id, name, status, position FROM checkitems WHERE checklist_id = ? ORDER BY position, id', [id]);
  const listStatus = async (id) => (await q('SELECT status FROM checklists WHERE id = ?', [id]))[0].status;

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
    // The page's api(path, body, method): GET bodies become the query string,
    // a non-2xx throws with .status (apiSend's contract).
    browser = browserPrechecks(async (p, body, method) => {
      const qs = method === 'GET' && body ? `?${new URLSearchParams(body)}` : '';
      if (/^\/api\/(cases|contacts)\//.test(p)) {
        const [kind, id] = p.split('/').slice(2);
        const rows = kind === 'cases' ? await q('SELECT case_id FROM cases WHERE case_id = ?', [decodeURIComponent(id)])
          : await q('SELECT contact_id FROM contacts WHERE contact_id = ?', [Number(id)]);
        if (!rows.length) throw Object.assign(new Error('not found'), { status: 404 });
        return { status: 'success' };
      }
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

  test('NO NATIVE DUPLICATE-NAME GUARD — the route stores the same name twice; the normalizer refuses it', async () => {
    const a = await call(app, 'POST', '/checklists/21/items', { name: 'Pay stubs' });
    const b = await call(app, 'POST', '/checklists/21/items', { name: 'PAY STUBS' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await items(21)).map((i) => i.name)).toEqual(['Pull credit report', 'Order transcripts', 'Pay stubs', 'PAY STUBS']);
    await expect(card({ kind: 'checklist.item.add.v1', checklist_id: 21, name: 'pay Stubs', evidence: [{ query_id: 'q2', row_number: 1 }] }))
      .rejects.toThrow('"Pre-filing" already has an item named "Pay stubs"');
  });

  test('NO NATIVE WIDTH GUARD — a 300-character title / item name is stored clipped to 255; the normalizer refuses > 255', async () => {
    const long = 'x'.repeat(300);
    const made = await call(app, 'POST', '/checklists', { title: long, link_type: 'case', link: C1, items: [{ name: long }] });
    expect(made.status).toBe(201);
    expect([made.body.title.length, made.body.items[0].name.length]).toEqual([255, 255]);
    await expect(card({ kind: 'checklist.create.v1', title: long, link_type: 'case', link: C1, evidence: [{ query_id: 'q1', row_number: 1 }] }))
      .rejects.toThrow('The list title is 300 characters — the column keeps 255');
    await expect(card({ kind: 'checklist.item.add.v1', checklist_id: 21, name: long, evidence: [{ query_id: 'q2', row_number: 1 }] }))
      .rejects.toThrow('The item name is 300 characters');
  });

  test('A NOTE REJECTS ITEMS and a checklist a body (both routes, 400); the normalizer refuses both first', async () => {
    const noteWithItems = await call(app, 'POST', '/checklists', { title: 'N', kind: 'note', items: [], link_type: 'case', link: C1 });
    const listWithBody = await call(app, 'POST', '/checklists', { title: 'L', body: 'x', link_type: 'case', link: C1 });
    const itemOnNote = await call(app, 'POST', '/checklists/22/items', { name: 'x' });
    expect([noteWithItems.status, listWithBody.status, itemOnNote.status]).toEqual([400, 400, 400]);
    await expect(card({ kind: 'checklist.item.add.v1', checklist_id: 22, name: 'x', evidence: [{ query_id: 'q2', row_number: 2 }] }))
      .rejects.toThrow('"Call log" (#22) is a NOTE, not a checklist');
    await expect(card({ kind: 'checklist.create.v1', title: 'N', list_kind: 'note', items: [], link_type: 'case', link: C1, evidence: [{ query_id: 'q1', row_number: 1 }] }))
      .rejects.toThrow('A note holds freeform text, not items');
  });

  test('THE DERIVED STATUS TRANSITION — the card\'s claim and its dry run match what the route does and emits', async () => {
    const c = await card({ kind: 'checklist.item.update.v1', checkitem_id: 301, status: 'complete', evidence: [{ query_id: 'q3', row_number: 1 }] });
    expect([c.list_status, c.automation.events, c.automation.rules_checked, c.automation.lines]).toEqual([
      { from: 'incomplete', to: 'complete' }, ['checkitem.completed', 'checklist.completed'], 2,
      ['Trigger rule #1 "Credit report done" runs: calls create_log ("Log it")', 'Trigger rule #2 "List done" runs: starts workflow #42']]);
    expect(c.expected.items).toEqual(['301:incomplete:Pull credit report', '302:complete:Order transcripts']);
    // The browser's re-read passes on the fresh card…
    expect(await browser.checkitemPrecheck(c)).toBe('');
    const res = await call(app, 'PATCH', '/checkitems/301', { status: 'complete' });
    expect(res.status).toBe(200);
    // The item row byte-identical (key order too), plus the additive echo.
    const [row] = await q('SELECT * FROM checkitems WHERE id = 301');
    expect(Object.keys(res.body)).toEqual([...Object.keys(row), 'checklist']);
    expect(res.body).toEqual({ ...JSON.parse(JSON.stringify(row)), checklist: { id: 21, link_type: 'case', link: C1 } });
    expect(await listStatus(21)).toBe('complete');
    const emitted = domainEvents.emit.mock.calls.map(([, type, payload]) => [type, payload.case_id, payload.data]);
    expect(emitted).toEqual([
      ['checkitem.completed', C1, { item_id: 301, name: 'Pull credit report', checklist_id: 21, tag: null, title: 'Pre-filing', link_type: 'case', checklist_status: 'complete' }],
      ['checklist.completed', C1, { checklist_id: 21, title: 'Pre-filing', tag: null, link_type: 'case' }]]);
    // …and refuses on the now-changed list.
    expect(await browser.checkitemPrecheck(c)).toMatch(/^The list "Pre-filing" changed since this card was prepared/);
    // Reopening reopens the list and emits no list event; the card said so.
    const r = await card({ kind: 'checklist.item.update.v1', checkitem_id: 302, status: 'incomplete', evidence: [{ query_id: 'q3', row_number: 2 }] });
    expect([r.list_status, r.automation.events]).toEqual([{ from: 'complete', to: 'incomplete' }, []]);
    domainEvents.emit.mockClear();
    await call(app, 'PATCH', '/checkitems/302', { status: 'incomplete' });
    expect([await listStatus(21), domainEvents.emit.mock.calls.length]).toEqual(['incomplete', 0]);
  });

  test('adding an item to a COMPLETE list reopens it — the card warns, the route does it', async () => {
    await q("UPDATE checkitems SET status = 'complete' WHERE checklist_id = 21");
    await q("UPDATE checklists SET status = 'complete' WHERE id = 21");
    const c = await card({ kind: 'checklist.item.add.v1', checklist_id: 21, name: 'Countersigned', evidence: [{ query_id: 'q2', row_number: 1 }] });
    expect(c.list_status).toEqual({ from: 'complete', to: 'incomplete' });
    expect(await browser.checklistPrecheck(c)).toBe('');
    const res = await call(app, 'POST', '/checklists/21/items', { name: 'Countersigned' });
    expect([res.status, res.body.status, await listStatus(21), domainEvents.emit.mock.calls.length]).toEqual([201, 'incomplete', 'incomplete', 0]);
    expect(await browser.checklistPrecheck(c)).toMatch(/^The list "Pre-filing" changed since this card was prepared/);
  });

  test('THE PUBLIC DOCS PREDICATE ON TITLE — an untagged case list titled "docs needed" reaches the unauthenticated GET; a contact one does not', async () => {
    await q(`INSERT INTO checklists (id, title, kind, status, created_by, link, link_type, tag) VALUES
      (31, 'docs needed', 'checklist', 'incomplete', 6, ?, 'case', NULL),
      (32, 'Docs Needed', 'checklist', 'incomplete', 6, '6001', 'contact', NULL),
      (33, 'Döcs Needed', 'checklist', 'incomplete', 6, ?, 'case', NULL)`, [C1, C1]);
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES
      (311, 31, 'Bank statements', 'incomplete', 1), (312, 31, 'Old lease', 'complete', 2), (321, 32, 'Contact-side item', 'incomplete', 1),
      (331, 33, 'Accented-title item', 'incomplete', 1)`);
    const pub = await call(app, 'GET', `/api/public/docs/${C1}`);
    expect(pub.status).toBe(200);
    expect(pub.body.items.sort()).toEqual(['Accented-title item', 'Bank statements']);
    // The create refusal folds exactly those titles, case-only.
    for (const title of ['docs needed', 'Döcs Needed', 'DOCS NEEDED ']) {
      await expect(card({ kind: 'checklist.create.v1', title, link_type: 'case', link: C1, evidence: [{ query_id: 'q1', row_number: 1 }] }))
        .rejects.toThrow('DOCS LIST refused');
    }
    // The item cards' docs flag is the engine's own predicate.
    const evDocs = [...ev, { id: 'q9', rows: [{ checklist_id: 31 }, { checklist_id: 32 }, { checklist_id: 33 }] }];
    const flags = [];
    for (const [n, id] of [[1, 31], [2, 32], [3, 33]]) {
      const c = await normalizeActionDraft(pool, { kind: 'checklist.item.add.v1', checklist_id: id, name: 'New', evidence: [{ query_id: 'q9', row_number: n }] }, evDocs, { currentUserId: 6 });
      flags.push([id, c.list.docs_list, c.warnings.some((w) => w.startsWith('CLIENT-VISIBLE'))]);
    }
    expect(flags).toEqual([[31, true, true], [32, false, false], [33, true, true]]);
  });

  test('the tag gate the route does have — staff get 403 — is moot for Casey, which never sends a tag', async () => {
    const res = await call(app, 'POST', '/checklists', { title: 'T', tag: 'docs_needed', link_type: 'case', link: C1 });
    expect(res.status).toBe(403);
    await expect(card({ kind: 'checklist.create.v1', title: 'T', tag: 'docs_needed', link_type: 'case', link: C1, evidence: [{ query_id: 'q1', row_number: 1 }] }))
      .rejects.toThrow('TAG refused');
  });

  test('the create card over the real rows: expected = the real GET\'s list ids; a second list after the card refuses it; a personal list', async () => {
    const c = await card({ kind: 'checklist.create.v1', title: 'pre-FILING', link_type: 'case', link: C1, items: ['A', 'B'], evidence: [{ query_id: 'q1', row_number: 1 }] });
    expect([c.expected.list_ids, c.existing_total, c.warnings.length]).toEqual([[21, 22], 2, 1]);
    expect(await browser.checklistPrecheck(c)).toBe('');
    await call(app, 'POST', '/checklists', { title: 'Someone else', link_type: 'case', link: C1 });
    expect(await browser.checklistPrecheck(c)).toMatch(/^The notes and lists on case 25-60001 changed since this card was prepared/);
    const mine = await card({ kind: 'checklist.create.v1', title: 'Errands', link_type: 'user', evidence: [] });
    expect([mine.list.link, mine.expected.list_ids]).toEqual(['6', [23]]);
    expect(await browser.checklistPrecheck(mine)).toBe('');
    const made = await call(app, 'POST', '/checklists', { title: 'Errands', kind: 'checklist', link_type: 'user', link: '6' });
    expect([made.status, made.body.link_type, made.body.link, made.body.created_by]).toEqual([201, 'user', '6', 6]);
  });
});
