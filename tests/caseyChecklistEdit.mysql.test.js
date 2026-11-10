// tests/caseyChecklistEdit.mysql.test.js
//
/**
 * A10.2 on REAL MySQL: the Casey list update / list delete / item delete
 * normalizers' own SQL (information_schema's title width and status ENUM, the
 * list, its text and items, the owner and superuser reads), the PIPELINE
 * PROJECTION against the real requirement resolver and checklist detector,
 * and the native routes every card drives — routes/api.checklists.js, real
 * handlers, real pool, under the production sql_mode — with the browser's
 * fixed requests and click-time re-read (extracted from public/assistant.html)
 * over the REAL payloads.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a102_test npx jest tests/caseyChecklistEdit.mysql.test.js --runInBand
 * The database name must end in _test (never port 3306 — that is production
 * on a dev machine); this suite DROPS and recreates its tables in it, cloned
 * from ref/database.sql, with FOREIGN_KEY_CHECKS off in the before-hook AND
 * the after-hook, taking any sibling-built child of ours with them. Give it
 * its own *_test DB (the twin-family rule in CLAUDE.md).
 *
 * WHAT IS LOCKED
 *   - Each write lands as its card said: the PATCH stores exactly the reviewed
 *     title / done state / text; the list DELETE takes its items with it (the
 *     FK cascade); the item DELETE recomputes the derived status the card
 *     named and emits checklist.completed with the data the card dry-ran.
 *   - THE PROJECTION EQUALS THE ENGINE: the step status each card projects is
 *     the real resolver's status after the real write — a tagged complete list
 *     deleted (done → active), the docs list's last open item deleted (active
 *     → done), the only item of a complete list deleted (done → active).
 *   - NO NATIVE WIDTH GUARD on the title (a 300-character title is stored
 *     clipped to 255) — the card refuses past information_schema's width.
 *   - The routes' own refusals beside the card's: a body / status on a
 *     checklist and a kind change (400), another user's personal list on
 *     DELETE (403 — a superuser passes, and so does the card), a gone list /
 *     item (404).
 *   - The browser's precheck passes on a fresh card and refuses after a hand
 *     edit (title, text, an item added) and after the delete itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js
// — the identity is set per test below), the event queue (observed, not run;
// buildEnvelope stays REAL via requireActual) and the public upload routes'
// mail / log / upload-target graph.
let mockAuth = { type: 'jwt', userId: 6 };
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { ...mockAuth }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => {}) }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => {}) }));
jest.mock('../services/uploadTargetService', () => ({ issueClientUploadLink: jest.fn(), inspectUploadDestination: jest.fn(), raiseUnsortedUploadTask: jest.fn() }));
const domainEvents = require('../lib/domainEvents');
const { normalizeActionDraft } = require('../services/assistantService');
const requirementService = require('../services/requirementService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'users', 'checklists', 'checkitems', 'trigger_rules', 'trigger_rule_actions',
  'pipeline_templates', 'pipeline_stages', 'pipeline_stage_requirements', 'case_stage_log', 'case_requirement_overrides'];

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
      const payload = body === undefined || body === null ? '' : JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.setTimeout(10000, () => req.destroy(new Error('request timed out')));
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

// The browser's request builders and precheck, extracted verbatim from the page.
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
  const names = ['checklistEditListId', 'checklistUpdateRequest', 'checklistDeleteRequest', 'checkitemDeleteRequest', 'checklistEditPrecheck',
    'checklistUpdateResult', 'checklistDeleteResult', 'checkitemDeleteResult'];
  const src = `${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey list update / delete / item delete cards on real MySQL (A10.2)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A102CAS1';

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
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype, pipeline_phase) VALUES (?, '25-60201', 'Bankruptcy', 'Chapter 7', 'intake')`, [C1]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES (6001, 'person', 'Dana Debtor', 'Dana', 'Debtor')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (901, ?, 6001, 'Primary')`, [C1]);
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type, roles, ringcentral) VALUES
      (6, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized', 1, 'staff', 0),
      (1, 'stuart', 'Stuart', 'Stuart', 'S', 'SS', 'authorized', 1, 'attorney', 0),
      (9, 'it', 'IT', 'IT', 'Admin', 'IT', 'authorized', 1, 'staff,su', 0)`);
    await q(`INSERT INTO checklists (id, title, kind, body, status, created_by, link, link_type, tag, created_date) VALUES
      (21, 'Pre-filing', 'checklist', NULL, 'incomplete', 6, ?, 'case', NULL, '2026-10-01 10:00:00'),
      (22, 'Call log', 'note', 'Called 11/2', 'incomplete', 6, ?, 'case', NULL, '2026-10-02 10:00:00'),
      (24, 'Docs Needed', 'checklist', NULL, 'incomplete', 6, ?, 'case', 'docs_needed', '2026-10-04 10:00:00'),
      (25, 'Intake forms', 'checklist', NULL, 'complete', 6, ?, 'case', 'intake_forms', '2026-10-05 10:00:00'),
      (26, 'Stuart list', 'checklist', NULL, 'incomplete', 1, '1', 'user', NULL, '2026-10-06 10:00:00')`, [C1, C1, C1, C1]);
    await q(`INSERT INTO checkitems (id, checklist_id, name, status, position) VALUES
      (301, 21, 'Pull credit report', 'incomplete', 1), (302, 21, 'Order transcripts', 'complete', 2),
      (341, 24, 'Pay stubs', 'incomplete', 1), (342, 24, 'Photo ID', 'complete', 2),
      (351, 25, 'Questionnaire', 'complete', 1), (361, 26, 'Call trustee', 'incomplete', 1)`);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (2, 'checklist.completed', 'Docs in', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"data.tag","op":"equals","value":"docs_needed"}]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES (2, NULL, 1, 1, 'workflow', '{"workflow_id":42}')`);
    await q(`INSERT INTO pipeline_templates (id, name, case_type, case_subtype, role, is_default, active) VALUES (1, 'Intake', '', '', 'intake', 0, 1)`);
    await q(`INSERT INTO pipeline_stages (id, template_id, stage_key, stage_number, internal_label, client_label, case_stage, lane, default_rec, client_visible, active) VALUES
      (11, 1, 'docs', 1, 'Docs requested', 'Documents', 'Open', 'main', '', 1, 1)`);
    await q(`INSERT INTO pipeline_stage_requirements (id, stage_id, requirement_key, internal_label, client_label, client_visible, required, owner, detector, detector_config, hint, sort_order, active) VALUES
      (401, 11, 'docs_in', 'Documents received', NULL, 0, 1, 'client', 'checklist', '{"tag":"docs_needed"}', NULL, 1, 1),
      (402, 11, 'forms_in', 'Intake forms received', NULL, 0, 0, 'client', 'checklist', '{"tag":"intake_forms"}', NULL, 2, 1)`);
    await q(`INSERT INTO case_stage_log (case_id, template_id, stage_id, stage_key, case_stage, status_label, entered_at, entered_by, source) VALUES
      (?, 1, 11, 'docs', 'Open', 'Docs requested', '2026-10-01 09:00:00', 6, 'manual')`, [C1]);
  }
  const ev = [
    { id: 'q1', rows: [21, 22, 24, 25, 26].map((id) => ({ checklist_id: id })) },
    { id: 'q2', rows: [301, 302, 341, 342, 351, 361].map((id) => ({ checkitem_id: id })) },
  ];
  const listEv = (id) => [{ query_id: 'q1', row_number: [21, 22, 24, 25, 26].indexOf(id) + 1 }];
  const itemEv = (id) => [{ query_id: 'q2', row_number: [301, 302, 341, 342, 351, 361].indexOf(id) + 1 }];
  const card = (value, userId = 6) => normalizeActionDraft(pool, value, ev, { currentUserId: userId }).then((c) => JSON.parse(JSON.stringify(c)));
  // The resolver's own status for a step, read fresh after a real write.
  const stepStatus = async (key) => ((await requirementService.getCaseRequirements(pool, C1)).find((r) => r.requirement_key === key) || {}).status;
  // Apply a card the way the browser does: its fixed request against the real route.
  async function apply(c, request) {
    const res = await call(app, request.method, request.path, request.body);
    return res;
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    if (!/_test$/.test(u.pathname.slice(1))) throw new Error(`refusing to run against "${u.pathname.slice(1)}"`);
    if (u.port === '3306') throw new Error('refusing to run against the production proxy port');
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
    browser = browserFns(async (p, body, method) => {
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

  beforeEach(async () => { mockAuth = { type: 'jwt', userId: 6 }; await seed(); domainEvents.emit.mockClear(); });

  test('a RENAME lands as the card said; the precheck refuses after; NO NATIVE WIDTH GUARD — the card reads information_schema', async () => {
    const c = await card({ kind: 'checklist.update.v1', checklist_id: 21, title: 'Pre-filing (2026)', evidence: listEv(21) });
    expect(c.expected).toMatchObject({ title: 'Pre-filing', body: null, items: ['301:incomplete:Pull credit report', '302:complete:Order transcripts'] });
    expect(await browser.checklistEditPrecheck(c)).toBe('');
    const res = await apply(c, browser.checklistUpdateRequest(c));
    expect(res.status).toBe(200);
    expect(browser.checklistUpdateResult(c, res.body)).toEqual({ checklist_id: 21 });
    expect((await q('SELECT title FROM checklists WHERE id = 21'))[0].title).toBe('Pre-filing (2026)');
    expect(domainEvents.emit).not.toHaveBeenCalled();
    expect(await browser.checklistEditPrecheck(c)).toMatch(/^The list "Pre-filing" changed since this card was prepared/);
    // The route clips; the card refuses past the column's own width.
    const long = await call(app, 'PATCH', '/checklists/21', { title: 'y'.repeat(300) });
    expect([long.status, long.body.title.length]).toEqual([200, 255]);
    await expect(card({ kind: 'checklist.update.v1', checklist_id: 21, title: 'z'.repeat(256), evidence: listEv(21) }))
      .rejects.toThrow('The list title is 256 characters — the column keeps 255');
    await q('ALTER TABLE checklists MODIFY title varchar(100) NOT NULL');
    try {
      await expect(card({ kind: 'checklist.update.v1', checklist_id: 21, title: 'z'.repeat(101), evidence: listEv(21) }))
        .rejects.toThrow('The list title is 101 characters — the column keeps 100');
    } finally { await q('ALTER TABLE checklists MODIFY title varchar(255) NOT NULL'); }
  });

  test('a NOTE\'s done state and text land exactly; the routes\' 400s beside the card\'s refusals', async () => {
    const c = await card({ kind: 'checklist.update.v1', checklist_id: 22, status: 'complete', body: 'Called 11/2\n\tCalled 11/5', evidence: listEv(22) });
    expect(await browser.checklistEditPrecheck(c)).toBe('');
    const res = await apply(c, browser.checklistUpdateRequest(c));
    expect(res.status).toBe(200);
    expect(browser.checklistUpdateResult(c, res.body)).toEqual({ checklist_id: 22 });
    expect(await q('SELECT status, body FROM checklists WHERE id = 22')).toEqual([{ status: 'complete', body: 'Called 11/2\n\tCalled 11/5' }]);
    expect(domainEvents.emit).not.toHaveBeenCalled();
    // A hand edit of the text after the card: refused.
    const c2 = await card({ kind: 'checklist.update.v1', checklist_id: 22, body: 'Third', evidence: listEv(22) });
    await q("UPDATE checklists SET body = 'Edited by hand' WHERE id = 22");
    expect(await browser.checklistEditPrecheck(c2)).toBe('The text of the note "Call log" changed since this card was prepared. Nothing was written. Ask Casey to prepare it again.');
    // The route's own kind rules, and the card's.
    const bodyOnList = await call(app, 'PATCH', '/checklists/21', { body: 'x' });
    const statusOnList = await call(app, 'PATCH', '/checklists/21', { status: 'complete' });
    const kindChange = await call(app, 'PATCH', '/checklists/22', { kind: 'checklist' });
    expect([bodyOnList.status, statusOnList.status, kindChange.status]).toEqual([400, 400, 400]);
    await expect(card({ kind: 'checklist.update.v1', checklist_id: 21, body: 'x', evidence: listEv(21) })).rejects.toThrow('is a checklist — a checklist holds items, not text');
    await expect(card({ kind: 'checklist.update.v1', checklist_id: 21, status: 'complete', evidence: listEv(21) })).rejects.toThrow('its status is derived from its items');
    await expect(card({ kind: 'checklist.update.v1', checklist_id: 22, list_kind: 'checklist', evidence: listEv(22) })).rejects.toThrow('KIND refused');
  });

  test('DELETE a complete tagged list: the cascade, and the projected step equals the real resolver after the real delete', async () => {
    expect(await stepStatus('forms_in')).toBe('done');
    const c = await card({ kind: 'checklist.delete.v1', checklist_id: 25, evidence: listEv(25) });
    expect([c.counts, c.pipeline.map((p) => [p.requirement_key, p.from, p.to])]).toEqual([{ total: 1, done: 1, open: 0 }, [['forms_in', 'done', 'active']]]);
    expect(await browser.checklistEditPrecheck(c)).toBe('');
    const res = await apply(c, browser.checklistDeleteRequest(c));
    expect([res.status, res.body]).toEqual([200, { status: 'success', message: 'Checklist deleted' }]);
    expect(browser.checklistDeleteResult(c, res.body)).toEqual({ checklist_id: 25 });
    expect([await q('SELECT id FROM checklists WHERE id = 25'), await q('SELECT id FROM checkitems WHERE checklist_id = 25')]).toEqual([[], []]);
    expect(await stepStatus('forms_in')).toBe(c.pipeline[0].to);
    expect(domainEvents.emit).not.toHaveBeenCalled();
    expect(await browser.checklistEditPrecheck(c)).toBe('The list "Intake forms" no longer exists — someone already deleted it. Nothing was written.');
    // The route's own 404 on a second delete, beside the card's refusal.
    expect((await call(app, 'DELETE', '/checklists/25')).status).toBe(404);
    await expect(card({ kind: 'checklist.delete.v1', checklist_id: 25, evidence: listEv(25) })).rejects.toThrow('Checklist #25 no longer exists');
  });

  test('DELETE an incomplete list: no step moves (the card says so) — and the real resolver agrees', async () => {
    const before = await stepStatus('docs_in');
    const c = await card({ kind: 'checklist.delete.v1', checklist_id: 24, evidence: listEv(24) });
    expect(c.pipeline).toEqual([]);
    expect(c.effects[0]).toMatch(/^Pipeline: every step of case 25-60201 keeps its status/);
    expect((await apply(c, browser.checklistDeleteRequest(c))).status).toBe(200);
    expect(await stepStatus('docs_in')).toBe(before);
  });

  test('DELETE the docs list\'s last OPEN item: the list completes, checklist.completed fires with the dry-run data, the step goes done', async () => {
    expect(await stepStatus('docs_in')).toBe('active');
    const c = await card({ kind: 'checklist.item.delete.v1', checkitem_id: 341, evidence: itemEv(341) });
    expect([c.list_status, c.automation.events, c.automation.lines, c.pipeline.map((p) => [p.requirement_key, p.from, p.to])]).toEqual([
      { from: 'incomplete', to: 'complete' }, ['checklist.completed'], ['Trigger rule #2 "Docs in" runs: starts workflow #42'], [['docs_in', 'active', 'done']]]);
    expect(await browser.checklistEditPrecheck(c)).toBe('');
    const res = await apply(c, browser.checkitemDeleteRequest(c));
    expect([res.status, res.body]).toEqual([200, { status: 'success', message: 'Item deleted' }]);
    expect(browser.checkitemDeleteResult(c, res.body)).toEqual({ checkitem_id: 341 });
    expect((await q('SELECT status FROM checklists WHERE id = 24'))[0].status).toBe('complete');
    expect(await stepStatus('docs_in')).toBe('done');
    const emitted = domainEvents.emit.mock.calls.map(([, type, payload]) => [type, payload.case_id, payload.data]);
    expect(emitted).toEqual([['checklist.completed', C1, { checklist_id: 24, title: 'Docs Needed', tag: 'docs_needed', link_type: 'case' }]]);
    expect(await browser.checklistEditPrecheck(c)).toMatch(/^The list "Docs Needed" changed since this card was prepared/);
    expect((await call(app, 'DELETE', '/checkitems/341')).status).toBe(404);
    await expect(card({ kind: 'checklist.item.delete.v1', checkitem_id: 341, evidence: itemEv(341) })).rejects.toThrow('Checklist item #341 no longer exists');
  });

  test('DELETE the only item of a complete list: the list REOPENS (empty is never complete), no event, the step goes done → active', async () => {
    const c = await card({ kind: 'checklist.item.delete.v1', checkitem_id: 351, evidence: itemEv(351) });
    expect([c.list_status, c.automation.events, c.pipeline.map((p) => [p.requirement_key, p.from, p.to, p.progress_to])]).toEqual([
      { from: 'complete', to: 'incomplete' }, [], [['forms_in', 'done', 'active', '0 of 0 received']]]);
    expect((await apply(c, browser.checkitemDeleteRequest(c))).status).toBe(200);
    expect((await q('SELECT status FROM checklists WHERE id = 25'))[0].status).toBe('incomplete');
    const after = (await requirementService.getCaseRequirements(pool, C1)).find((r) => r.requirement_key === 'forms_in');
    expect([after.status, after.progress]).toEqual(['active', '0 of 0 received']);
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('another user\'s personal list: the route 403s a non-owner and the card refuses; a superuser passes both', async () => {
    const denied = await call(app, 'DELETE', '/checklists/26');
    expect([denied.status, denied.body.message]).toEqual([403, expect.stringMatching(/belongs to another user/)]);
    await expect(card({ kind: 'checklist.delete.v1', checklist_id: 26, evidence: listEv(26) }))
      .rejects.toThrow('"Stuart list" (#26) is another user\'s personal list — it belongs to Stuart (user #1). Only its owner or a superuser may delete it');
    const c = await card({ kind: 'checklist.delete.v1', checklist_id: 26, evidence: listEv(26) }, 9);
    expect(c.warnings.some((w) => w.startsWith('ANOTHER USER\'S LIST: this is Stuart (user #1)\'s personal list'))).toBe(true);
    mockAuth = { type: 'jwt', userId: 9, roles: ['staff', 'su'] };
    expect(await browser.checklistEditPrecheck(c)).toBe('');
    const res = await apply(c, browser.checklistDeleteRequest(c));
    expect(res.status).toBe(200);
    expect(await q('SELECT id FROM checkitems WHERE checklist_id = 26')).toEqual([]);
  });

  test('the precheck refuses after an item is added by hand, and passes on a fresh card', async () => {
    const c = await card({ kind: 'checklist.item.delete.v1', checkitem_id: 302, evidence: itemEv(302) });
    expect(await browser.checklistEditPrecheck(c)).toBe('');
    await call(app, 'POST', '/checklists/21/items', { name: 'Added by hand' });
    expect(await browser.checklistEditPrecheck(c)).toMatch(/^The items on "Pre-filing" changed since this card was prepared/);
  });
});
