// tests/caseyDocket.mysql.test.js
//
/**
 * A7c on REAL MySQL: the native docket-adopt route every refusal and
 * disclosure of the Casey docket card rests on — routes/api.cases.js
 * PATCH /api/cases/:id/docket, real handler, real caseService
 * (checkCaseNumberCollision, updateCase, getCase), the real judge resolver,
 * real pool, under the production sql_mode — plus the normalizer's own reads
 * and dry run, and the browser's click-time re-read, answer check and
 * outcome mapping (extracted from public/assistant.html) over the REAL
 * GET / PATCH payloads.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a7c_test npx jest tests/caseyDocket.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them (the caseyPipeline.mysql hygiene).
 *
 * WHAT IS LOCKED
 *   - ADOPT-ONLY: a column already holding a DIFFERENT value answers 409
 *     ("…Replacing it is a case-detail-form operation, not an adopt.") and
 *     writes nothing — capitalisation counts (the route compares in JS,
 *     exactly); the normalizer refuses first, naming the stored value.
 *   - THE COLLISION: another case holding the value in EITHER column answers
 *     409 and writes nothing — cross column, under the database's equality
 *     (capitalisation and trailing spaces aside), never a shape parse; the
 *     normalizer refuses the same through the same function.
 *   - ONLY THE SUBMITTED COLUMN is written, and a blank stored as '' is
 *     fillable; the `changes` echo names exactly what changed — the judge
 *     link a full number re-resolves included — and the service emits the
 *     very case.updated envelope the card dry-ran.
 *   - THE SILENT CLIP: a 25-character number is stored cut to 20 and
 *     answered 200 — the normalizer refuses > 20 first.
 *   - THE CASES LIST GAP: after a case-number adopt on a case whose full
 *     number is '' (not NULL), listCases' Case Number is '' — the card says so.
 *   - THE ROWS FILED UNDER IT: the card's event / log counts are exactly the
 *     rows the real readers (eventService.listEvents' docket expansion,
 *     logService._buildCaseLogWhere) attach to the case after the write.
 *   - The dry run reads the real active case.updated rules (an inactive one
 *     and one on another event are not listed).
 *   - The browser's precheck passes on a fresh card and refuses after a hand
 *     edit; its answer check accepts the real answer; its outcome mapping
 *     reads both real 409 bodies and the real 404 as refusals.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// Not under test: the auth gate (pinned in tests/caseyActionPermissions.test.js)
// and the event queue (observed, not run; buildEnvelope / buildChanges stay
// REAL via requireActual).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
const domainEvents = require('../lib/domainEvents');
const caseService = require('../services/caseService');
const logService = require('../services/logService');
const eventService = require('../services/eventService');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'contact_roles', 'events', 'log', 'trigger_rules', 'trigger_rule_actions'];

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
  const consts = ['CASE_DOCKET_FIELDS', 'CASE_DOCKET_NAMES', 'CASE_DOCKET_MAX', 'CASE_DOCKET_CONTROL'].map((n) => {
    const m = new RegExp(`const ${n} = [^\\n]*;`).exec(html);
    if (!m) throw new Error(`${n} not found`);
    return m[0];
  });
  const names = ['actionStringReceipt', 'caseDocketCaseLabel', 'caseDocketBody', 'caseDocketRequest', 'caseDocketPrecheck', 'caseDocketResult', 'caseDocketKnownOutcome'];
  const src = `${consts.join('\n')}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { caseDocketRequest, caseDocketPrecheck, caseDocketResult, caseDocketKnownOutcome };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey docket card on real MySQL (A7c)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A7CCASE1'; const C2 = 'A7CCASE2'; const C3 = 'A7CCASE3'; const C4 = 'A7CCASE4';

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
    // C1: short number only (full NULL). C2: full number only. C3: a short
    // number stored with a trailing space. C4: blank, full stored as '' (not NULL).
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type, case_subtype, case_judge, case_caption) VALUES
      (?, '25-70001', NULL, 'Bankruptcy', 'Chapter 7', 'Mark Example', ''),
      (?, NULL, '25-70002-abc', 'Bankruptcy', 'Chapter 13', '', 'In re Sam Spouse'),
      (?, '25-70003 ', NULL, 'Bankruptcy', 'Chapter 7', '', ''),
      (?, NULL, '', 'Bankruptcy', 'Chapter 7', '', '')`, [C1, C2, C3, C4]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (7001, 'person', 'Dana Debtor', 'Dana', 'Debtor'), (7101, 'person', 'Hon. Mark Example', 'Mark', 'Example'),
      (7102, 'person', 'Hon. Ann Other', 'Ann', 'Other')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (951, ?, 7001, 'Primary')`, [C1]);
    // Judge roster: suffix "mex" → 7101, "aot" → 7102.
    await q(`INSERT INTO contact_roles (contact_id, role, attrs, active) VALUES
      (7101, 'judge', '{"judge_3":"mex"}', 1), (7102, 'judge', '{"judge_3":"aot"}', 1)`);
    // Filed under 25-70004 before any case had it: one docket-linked event, a
    // court-email log row (typed) and a legacy untyped one; plus noise.
    await q(`INSERT INTO events (event_id, event_title, event_date, event_link_type, event_link_id) VALUES
      (801, 'Meeting of creditors', '2026-12-01', 'case_number', '25-70004'), (802, 'Other docket', '2026-12-02', 'case_number', '25-79999')`);
    await q(`INSERT INTO log (log_id, log_type, log_date, log_link, log_link_type, log_link_id, log_by, log_data, log_message) VALUES
      (901, 'court email', '2026-10-01 10:00:00', '25-70004', 'case', '25-70004', 0, '', 'Notice of filing'),
      (902, 'note', '2026-10-02 10:00:00', '25-70004', NULL, NULL, 0, '', 'legacy note'),
      (903, 'note', '2026-10-03 10:00:00', '25-79999', 'case', '25-79999', 0, '', 'other docket')`);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (1, 'case.updated', 'Docket adopted', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"source","op":"equals","value":"docket_adopt"}]}'),
      (2, 'case.updated', 'Hand edits only', 1, 2, 'conditions', '{"operator":"and","conditions":[{"path":"source","op":"equals","value":"manual"}]}'),
      (3, 'case.updated', 'Switched off', 0, 3, 'conditions', '{"operator":"and","conditions":[]}'),
      (4, 'case.stage_advanced', 'Other event', 1, 1, 'conditions', '{"operator":"and","conditions":[]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
      (1, 'Court flow', 1, 1, 'workflow', '{"workflow_id":77}'), (2, NULL, 1, 1, 'workflow', '{"workflow_id":78}'),
      (3, NULL, 1, 1, 'workflow', '{"workflow_id":9}'), (4, NULL, 1, 1, 'workflow', '{"workflow_id":8}')`);
  }
  const ev = [{ id: 'q1', rows: [{ case_id: C1 }, { case_id: C2 }, { case_id: C3 }, { case_id: C4 }] }];
  const row = (n) => [{ query_id: 'q1', row_number: n }];
  const card = (value) => normalizeActionDraft(pool, { kind: 'case.docket.adopt.v1', ...value }, ev, { currentUserId: 6 });
  const docket = (id) => q('SELECT case_number, case_number_full, case_judge_contact_id FROM cases WHERE case_id = ?', [id]).then((r) => r[0]);

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
    app.use(require('../routes/api.cases'));
    // The page's api(path, body, method): a non-2xx throws with .status / .body (apiSend's contract).
    browser = browserChecks(async (p, body, method) => {
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

  beforeEach(async () => { await seed(); domainEvents.emit.mockClear(); });

  test('ADOPT-ONLY — a column holding a different value answers 409 and writes nothing (capitalisation counts); the normalizer refuses first', async () => {
    const res = await call(app, 'PATCH', `/api/cases/${C1}/docket`, { case_number: '25-70009' });
    expect([res.status, res.body.message]).toEqual([409, `Case ${C1} already has a case number (25-70001). Replacing it is a case-detail-form operation, not an adopt.`]);
    const caps = await call(app, 'PATCH', `/api/cases/${C2}/docket`, { case_number_full: '25-70002-ABC' });
    expect([caps.status, caps.body.message]).toEqual([409, `Case ${C2} already has a full docket (25-70002-abc). Replacing it is a case-detail-form operation, not an adopt.`]);
    expect([await docket(C1), await docket(C2), domainEvents.emit.mock.calls.length]).toEqual([
      { case_number: '25-70001', case_number_full: null, case_judge_contact_id: null }, { case_number: null, case_number_full: '25-70002-abc', case_judge_contact_id: null }, 0]);
    await expect(card({ case_id: C1, case_number: '25-70009', evidence: row(1) })).rejects.toThrow('REPLACING refused: case 25-70001 already has a case number ("25-70001"), and "25-70009" is different');
    await expect(card({ case_id: C2, case_number_full: '25-70002-ABC', evidence: row(2) })).rejects.toThrow('already has a full case number ("25-70002-abc"), and "25-70002-ABC" is different');
    // The browser reads the real 409 as a refusal written before any write.
    const err = Object.assign(new Error(res.body.message), { status: res.status, body: res.body });
    expect(browser.caseDocketKnownOutcome(err)).toEqual({ status: 'Refused — nothing written',
      text: `Refused — nothing written: the case already had a different number when this was applied (Case ${C1} already has a case number (25-70001). Replacing it is a case-detail-form operation, not an adopt.) — someone set it after this card was prepared. Ask Casey to read the case again.` });
  });

  test('THE COLLISION — the value in EITHER column of another case answers 409 (cross column, case- and trailing-space-insensitive); the normalizer refuses the same', async () => {
    const attempts = [
      [C4, { case_number: '25-70002-ABC' }],   // C2's FULL number, as a short number, other capitalisation
      [C4, { case_number_full: '25-70001' }],  // C1's SHORT number, as a full number
      [C4, { case_number: '25-70003' }],       // C3 stores it with a trailing space
    ];
    for (const [id, body] of attempts) {
      const res = await call(app, 'PATCH', `/api/cases/${id}/docket`, body);
      expect([res.status, /^That docket already belongs to case A7CCASE[123] /.test(res.body.message)]).toEqual([409, true]);
    }
    expect([await docket(C4), domainEvents.emit.mock.calls.length]).toEqual([{ case_number: null, case_number_full: '', case_judge_contact_id: null }, 0]);
    await expect(card({ case_id: C4, case_number: '25-70002-ABC', evidence: row(4) }))
      .rejects.toThrow(`ANOTHER CASE HOLDS IT: "25-70002-ABC" is already on case ${C2} (Bankruptcy) — its case number is blank, its full case number "25-70002-abc"`);
    await expect(card({ case_id: C4, case_number_full: '25-70001', evidence: row(4) }))
      .rejects.toThrow(`ANOTHER CASE HOLDS IT: "25-70001" is already on case ${C1} (Bankruptcy) — its case number is "25-70001", its full case number blank`);
    await expect(card({ case_id: C4, case_number: '25-70003', evidence: row(4) })).rejects.toThrow(`is already on case ${C3}`);
    // The browser maps the real collision 409 to a refusal.
    const r = await call(app, 'PATCH', `/api/cases/${C4}/docket`, { case_number: '25-70003' });
    const known = browser.caseDocketKnownOutcome(Object.assign(new Error(r.body.message), { status: r.status, body: r.body }));
    expect(known.text).toMatch(new RegExp(`^Refused — nothing written: That docket already belongs to case ${C3} \\(25-70003 \\)\\. Another case took that number`));
  });

  test('ONLY THE SUBMITTED COLUMN — a full number fills just that column, re-resolves the judge link, and the service emits the envelope the card dry-ran', async () => {
    const c = await card({ case_id: C1, case_number_full: '25-70001-mex', evidence: row(1) });
    expect([c.writes, c.kept, c.judge, c.expected]).toEqual([
      { case_number_full: { from: null, to: '25-70001-mex' } }, [],
      { from: null, to: 7101, from_label: 'none', to_label: 'Hon. Mark Example (contact #7101)' },
      { case_number: '25-70001', case_number_full: null, case_type: 'Bankruptcy', case_judge: 'Mark Example', case_judge_contact_id: null }]);
    expect([c.automation.rules_checked, c.automation.lines]).toEqual([2, ['Trigger rule #1 "Docket adopted" runs: starts workflow #77 ("Court flow")']]);
    expect(c.effects).toContain('Client portal: the case\'s docket line reads "25-70001-mex" for Dana Debtor (its Primary / Secondary contacts) once they sign in; portal cards that show the case number read it too.');
    // The browser's re-read passes on the fresh card; the request is exactly the reviewed column.
    expect(await browser.caseDocketPrecheck(c)).toBe('');
    const rq = browser.caseDocketRequest(c);
    expect(rq).toEqual({ path: `/api/cases/${C1}/docket`, method: 'PATCH', body: { case_number_full: '25-70001-mex' } });
    const res = await call(app, rq.method, rq.path, rq.body);
    expect([res.status, res.body.changes]).toEqual([200, { case_number_full: { from: null, to: '25-70001-mex' }, case_judge_contact_id: { from: null, to: 7101 } }]);
    expect(browser.caseDocketResult(c, res.body)).toEqual({ case_id: C1 });
    expect(await docket(C1)).toEqual({ case_number: '25-70001', case_number_full: '25-70001-mex', case_judge_contact_id: 7101 });
    // The service emitted exactly the envelope the card dry-ran.
    const [[, type, payload]] = domainEvents.emit.mock.calls;
    const dry = jest.requireActual('../lib/domainEvents').buildChanges;
    expect([type, payload.source, payload.actor, payload.changes, payload.extra]).toEqual(['case.updated', 'docket_adopt', { user_id: 6 },
      dry({ case_number_full: null, case_judge_contact_id: null }, { case_number_full: '25-70001-mex', case_judge_contact_id: 7101 }, ['case_number_full', 'case_judge_contact_id']),
      { updated_fields: ['case_number_full', 'case_judge_contact_id'] }]);
    // A second card on the same case now refuses (no-op), and the stale first card's re-read refuses too.
    await expect(card({ case_id: C1, case_number_full: '25-70001-mex', evidence: row(1) })).rejects.toThrow('that changes nothing');
    expect(await browser.caseDocketPrecheck(c)).toMatch(/^case 25-70001 now has a full case number \("25-70001-mex"\) — someone set it since this card was prepared/);
  });

  test('a judge link that a full number CHANGES is resolved by the real resolver and danger-warned', async () => {
    await q('UPDATE cases SET case_judge_contact_id = 7102 WHERE case_id = ?', [C1]);
    const c = await card({ case_id: C1, case_number_full: '25-70001-mex', evidence: row(1) });
    expect(c.warnings).toEqual(['JUDGE LINK CHANGES: setting the full case number re-resolves the case\'s judge contact from its suffix (else from the judge text "Mark Example") — Hon. Ann Other (contact #7102) → Hon. Mark Example (contact #7101). The judge text itself is untouched.']);
    const res = await call(app, 'PATCH', `/api/cases/${C1}/docket`, browser.caseDocketRequest(c).body);
    expect(res.body.changes.case_judge_contact_id).toEqual({ from: 7102, to: 7101 });
  });

  test('a blank stored as \'\' is fillable; THE CASES LIST GAP — its Case Number stays \'\' after a short-number adopt, as the card says', async () => {
    const c = await card({ case_id: C4, case_number: '25-70004', evidence: row(4) });
    expect(c.effects[1]).toBe('Cases list: its Case Number column keeps showing BLANK — it reads the full case number whenever that is not NULL, and this case\'s full case number is stored as empty text. Searching the Cases list by "25-70004" does find the case.');
    expect(c.expected).toEqual({ case_number: null, case_number_full: '', case_type: 'Bankruptcy' });
    // THE ROWS FILED UNDER IT: counted on the card, and the real readers attach exactly those after the write.
    expect(c.effects).toContain('Joins this case now: 1 event calendared against this number and 2 log entries filed under it (court mail that arrived before the case had the number, for example) — they show on this case\'s Events tab and log from now on.');
    const caseLog = async () => { const { whereFragment, params } = await logService._buildCaseLogWhere(pool, C4, { relateFilter: 'none' });
      return (await q(`SELECT l.log_id FROM log l WHERE ${whereFragment} ORDER BY l.log_id`, params)).map((r) => r.log_id); };
    const caseEvents = async () => (await eventService.listEvents(pool, { link_type: 'case', link_id: C4 })).data.map((e) => Number(e.event_id));
    expect([await caseLog(), await caseEvents()]).toEqual([[], []]);
    const res = await call(app, 'PATCH', `/api/cases/${C4}/docket`, browser.caseDocketRequest(c).body);
    expect([res.status, res.body.changes]).toEqual([200, { case_number: { from: null, to: '25-70004' } }]);
    expect([await caseLog(), await caseEvents()]).toEqual([[901, 902], [801]]);
    const listed = await caseService.listCases(pool, { query: '25-70004' });
    expect(listed.cases.map((x) => [x.case_id, x.case_number])).toEqual([[C4, '']]);
  });

  test('THE SILENT CLIP — a 25-character number is stored cut to 20 and answered 200; the normalizer refuses > 20', async () => {
    const long = '25-70004-' + 'x'.repeat(16);
    const res = await call(app, 'PATCH', `/api/cases/${C4}/docket`, { case_number: long });
    expect([res.status, (await docket(C4)).case_number]).toEqual([200, long.slice(0, 20)]);
    await q('UPDATE cases SET case_number = NULL WHERE case_id = ?', [C4]);
    await expect(card({ case_id: C4, case_number: long, evidence: row(4) })).rejects.toThrow(`is 25 characters — the column keeps 20`);
  });

  test('the browser\'s re-read refuses a hand edit to the type, and the real 404 reads as a refusal', async () => {
    const c = await card({ case_id: C4, case_number: '25-70004', evidence: row(4) });
    await q("UPDATE cases SET case_type = 'Civil' WHERE case_id = ?", [C4]);
    expect(await browser.caseDocketPrecheck(c)).toMatch(/^The case number, full case number or type of case A7CCASE4 changed since this card was prepared/);
    await q('DELETE FROM cases WHERE case_id = ?', [C4]);
    expect(await browser.caseDocketPrecheck(c)).toBe('Case A7CCASE4 no longer exists. Nothing was written.');
    const gone = await call(app, 'PATCH', `/api/cases/${C4}/docket`, { case_number: '25-70004' });
    expect(gone.status).toBe(404);
    expect(browser.caseDocketKnownOutcome(Object.assign(new Error(gone.body.message), { status: gone.status, body: gone.body })))
      .toEqual({ status: 'Refused — nothing written', text: 'Refused — nothing written: the case no longer exists. Ask Casey to read it again.' });
  });
});
