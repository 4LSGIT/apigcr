// tests/caseyCaseFields.mysql.test.js
//
/**
 * A7 groups B/C on REAL MySQL: the native case PATCH every refusal and
 * disclosure of the Casey case fields card rests on — routes/api.cases.js
 * PATCH /api/cases/:id, real handler, real caseService.updateCase (the
 * blank-date guard, the cf_ splitter, the judge / trustee resolver), real
 * pool, under the production sql_mode — plus the normalizer's own reads (the
 * information_schema column map, the link names, the readers scan over every
 * definition table) and dry run, and the browser's click-time re-read and
 * answer check (extracted from public/assistant.html) over the REAL GET /
 * PATCH payloads.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a7bc_test npx jest tests/caseyCaseFields.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them (the caseyDocket.mysql hygiene).
 *
 * WHAT IS LOCKED
 *   - THE SILENT CLIP: a 151-character caption is stored cut to 150 and
 *     answered 200 — the normalizer refuses > width first, counting code
 *     points (150 emoji are stored whole).
 *   - '' ON A DATE: the route stores NULL (blankDateToNull), never a zero
 *     date; the card sends null and says Clears.
 *   - THE SET ORDER: a SET written out of member order reads back IN member
 *     order — so the card's member-order join and its order-insensitive no-op
 *     are the database's own reading.
 *   - THE DATETIME: the card's 'YYYY-MM-DDTHH:MM' (the form's shape) is
 *     stored as that wall time, and the GET's value canonicalizes to exactly
 *     the card's `after`.
 *   - THE JUDGE TWIN: a case_judge write re-resolves case_judge_contact_id to
 *     exactly what the card predicted (and a miss writes NULL); an unrelated
 *     column leaves it untouched.
 *   - THE ECHO: the PATCH answers {status, data:{case_id, updated_fields,
 *     changes}}; the service emits the very case.updated changes /
 *     updated_fields the card dry-ran; the browser's answer check accepts it.
 *   - The column map is information_schema (an unknown column and an
 *     over-width CHAR refuse); the readers scan runs on every definition
 *     table and lands each hit on the column it names; the dry run reads only
 *     ACTIVE case.updated rules.
 *   - The browser's precheck passes on a fresh card — DATE, DATETIME and a
 *     custom value compared in the GET's own shapes — and refuses after a
 *     hand edit.
 *   - A7e, THE DOCKET (case_number / case_number_full on this card): the plain
 *     PATCH stores a REPLACED number; since 2026-11-09 it refuses a number
 *     ANOTHER case holds (409 {conflict}, caseService.checkCaseNumberCollision
 *     on the real engine's general_ci + PAD SPACE equality) and one over 20
 *     (400) before any write — the card's own refusals come first and read
 *     friendlier, the route's are the floor and caseFieldsKnownOutcome reads
 *     the 409 as "nothing written"; a replace moves exactly the events
 *     and log rows the card counted, measured with the real readers
 *     (eventService.listEvents' case scope, logService._buildCaseLogWhere)
 *     before and after; court email (lib/courtResolve) follows the numbers,
 *     the bare-number fallback included; the judge link re-resolves from the
 *     new suffix, and a clear drops it when the judge text matches no one;
 *     the browser's click-time collision re-check over the real search route
 *     refuses a number another case took after the card was prepared.
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
const fieldDefs = require('../services/fieldDefService');
const triggerService = require('../services/triggerService');
const { normalizeActionDraft } = require('../services/assistantService');
const pipelineService = require('../services/pipelineService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'contact_roles', 'field_defs', 'trigger_rules', 'trigger_rule_actions',
  'report_definitions', 'form_templates', 'portal_cards', 'pipeline_stages', 'pipeline_stage_requirements', 'sequence_steps',
  'workflow_steps', 'email_ingest_rule_actions', 'phone_ingest_rule_actions',
  // The readers scan joins the step tables' parents on the live versions.
  'workflows', 'sequence_templates',
  // A7d: the pipeline a type / subtype resolves to, the case's stage history, the firm's case-type list.
  'pipeline_templates', 'case_stage_log', 'app_settings',
  // A7e: the rows filed by number that leave / arrive with a docket.
  'events', 'log'];

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

// The browser's checks, extracted verbatim from the page and run against an
// `api` that calls the real routes.
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
function constSrc(html, name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
  if (!m) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = m.index; i < html.length; i++) {
    const c = html[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`${name} unterminated`);
}
function browserChecks(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const consts = ['CASE_FIELDS_MAX', 'CASE_FIELDS_REFUSED_NAMES', 'CASE_FIELDS_COLUMN', 'CASE_FIELDS_DOCKET_SEARCH_MAX',
    'CASE_DOCKET_FIELDS', 'CASE_DOCKET_MAX', 'CASE_DOCKET_CONTROL'].map((n) => constSrc(html, n));
  const names = ['actionStringReceipt', 'caseFieldsCaseLabel', 'caseFieldsCanon', 'caseFieldsBody', 'caseFieldsRequest', 'caseFieldsPrecheck',
    'caseFieldsDocketPrecheck', 'caseFieldsResult', 'caseFieldsKnownOutcome'];
  const src = `${consts.join('\n')}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { caseFieldsRequest, caseFieldsPrecheck, caseFieldsResult, caseFieldsKnownOutcome };`;
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

d('the Casey case fields card on real MySQL (A7 groups B/C)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A7BCASE1'; const C2 = 'A7BCASE2';

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
    fieldDefs.bump();
    // C1: no full number (the judge resolves by NAME), judge 'Mark Example' → 7101.
    // C2: a judge link that does not match its text (an unrelated edit must leave it).
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type, case_subtype, case_judge, case_judge_contact_id,
               case_trustee, case_caption, case_chapter, case_file_date, case_pre_petition, custom) VALUES
      (?, '25-80001', NULL, 'Bankruptcy', 'Chapter 7', 'Mark Example', 7101, 'Tom Trustee', 'In re Dana Debtor', '7', '2026-01-02', 'Sent', '{"cf_court":"EDMI"}'),
      (?, '25-80002', NULL, 'Bankruptcy', 'Chapter 13', 'Nobody Known', 7101, '', '', '13', NULL, '', '{}')`, [C1, C2]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES
      (7001, 'person', 'Dana Debtor', 'Dana', 'Debtor'), (7101, 'person', 'Hon. Mark Example', 'Mark', 'Example'),
      (7102, 'person', 'Hon. Ann Other', 'Ann', 'Other')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (961, ?, 7001, 'Primary')`, [C1]);
    await q(`INSERT INTO contact_roles (contact_id, role, attrs, active) VALUES
      (7101, 'judge', '{"judge_3":"mex"}', 1), (7102, 'judge', '{"judge_3":"aot"}', 1)`);
    await q(`INSERT INTO field_defs (id, entity, field_key, label, field_type, options, indexed, sort_order, active) VALUES
      (1, 'case', 'cf_court', 'Court', 'select', '[{"value":"EDMI"},{"value":"WDMI"}]', 1, 1, 1)`);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (1, 'case.updated', 'Hand edits', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"source","op":"equals","value":"manual"}]}'),
      (2, 'case.updated', 'Docket adopts only', 1, 2, 'conditions', '{"operator":"and","conditions":[{"path":"source","op":"equals","value":"docket_adopt"}]}'),
      (3, 'case.updated', 'Switched off', 0, 3, 'conditions', '{"operator":"and","conditions":[]}'),
      (4, 'case.stage_advanced', 'Other event', 1, 1, 'conditions', '{"operator":"and","conditions":[]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
      (1, 'Hand flow', 1, 1, 'workflow', '{"workflow_id":77}'), (2, NULL, 1, 1, 'workflow', '{"workflow_id":78}'),
      (3, NULL, 1, 1, 'workflow', '{"workflow_id":9}'), (4, NULL, 1, 1, 'workflow', '{"workflow_id":8}')`);
    // Stored definitions for the readers scan: hits, a near miss, an inactive row.
    await q(`INSERT INTO report_definitions (id, report_key, title, sql_text, is_active) VALUES
      (10, 'filed', 'Filed cases', 'SELECT case_id, case_file_date FROM cases', 1),
      (11, 'old', 'Retired', 'SELECT case_file_date FROM cases', 0)`);
    await q(`INSERT INTO pipeline_templates (id, name, role, case_type, case_subtype, is_default, active) VALUES
      (1, 'Chapter 7', 'case', 'Bankruptcy', 'Chapter 7', 0, 1), (2, 'Chapter 13', 'case', 'Bankruptcy', 'Chapter 13', 0, 1), (3, 'Intake', 'intake', NULL, NULL, 0, 1)`);
    await q(`INSERT INTO pipeline_stages (id, template_id, stage_number, stage_key, internal_label, case_stage) VALUES (5, 1, 3, 'filed', 'Filed', 'Filed'),
      (6, 2, 3, 'filed', 'Filed', 'Filed'), (7, 1, 5, 'discharged', 'Discharged', 'Concluded')`);
    await q(`INSERT INTO app_settings (\`key\`, \`value\`) VALUES ('fe-case_types', ?)`, [JSON.stringify({ Bankruptcy: ['Chapter 7', 'Chapter 13'], 'Civil Litigation': [] })]);
    await q(`INSERT INTO pipeline_stage_requirements (id, stage_id, requirement_key, internal_label, detector, detector_config, active) VALUES
      (7, 5, 'petition_filed', 'Petition filed', 'case_field', '{"field":"case_file_date"}', 1)`);
    // Workflow 4: published v3 with a draft v4; a v1 step still names case_chapter
    // but is history — the scan must list v3 and v4 only (version predicate).
    await q(`INSERT INTO workflows (id, name, active, current_version, draft_version) VALUES (4, 'Chapter mailer', 1, 3, 4)`);
    await q(`INSERT INTO workflow_steps (id, workflow_id, version, step_number, type, label, config) VALUES
      (9, 4, 3, 2, 'internal_function', 'near miss', '{"text":"{{cases.case_file_date_x}}"}'),
      (10, 4, 3, 3, 'internal_function', NULL, '{"text":"Chapter {{cases.case_chapter}}"}'),
      (11, 4, 1, 1, 'internal_function', 'retired', '{"text":"Old chapter {{cases.case_chapter}}"}'),
      (12, 4, 4, 1, 'internal_function', 'draft', '{"text":"Draft chapter {{cases.case_chapter}}"}')`);
    await q(`INSERT INTO sequence_templates (id, name, type, active, current_version, draft_version) VALUES (6, 'Chapter drip', NULL, 1, 2, NULL)`);
    await q(`INSERT INTO sequence_steps (id, template_id, version, step_number, action_type, action_config, timing) VALUES
      (21, 6, 2, 1, 'sms', '{"function_name":"send_sms","params":{"message":"Ch {{cases.case_chapter}}"}}', '{"type":"immediate"}'),
      (22, 6, 1, 1, 'sms', '{"function_name":"send_sms","params":{"message":"Old {{cases.case_chapter}}"}}', '{"type":"immediate"}')`);
    await q(`INSERT INTO portal_cards (id, card_key, title, body_type, body_template, conditions, active) VALUES
      (3, 'ch', 'Chapter', 'template', 'Your chapter: {{cases.case_chapter}}', NULL, 1)`);
  }
  const ev = [{ id: 'q1', rows: [{ case_id: C1 }, { case_id: C2 }] }];
  const row = (n) => [{ query_id: 'q1', row_number: n }];
  const card = (id, changes) => normalizeActionDraft(pool, { kind: 'case.fields.update.v1', case_id: id, changes, evidence: row(id === C1 ? 1 : 2) }, ev, { currentUserId: 6 });
  const patch = (id, body) => call(app, 'PATCH', `/api/cases/${id}`, body);
  const sendOf = (draft) => Object.fromEntries(draft.writes.map((w) => [w.column, w.send]));

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

  test('THE SILENT CLIP — the route stores an over-width caption cut short and answers 200; the normalizer refuses it first, counting code points', async () => {
    const res = await patch(C2, { case_caption: 'x'.repeat(151) });
    expect(res.status).toBe(200);
    expect((await q('SELECT CHAR_LENGTH(case_caption) AS n FROM cases WHERE case_id = ?', [C2]))[0].n).toBe(150);
    await expect(card(C1, { case_caption: 'y'.repeat(151) })).rejects.toThrow(/is 151 characters — the column keeps 150, and the database would save it cut short while the route answers success/);
    const emoji = '\u{1F600}'.repeat(150);
    const ok = await card(C1, { case_caption: emoji });
    expect((await patch(C1, sendOf(ok))).status).toBe(200);
    expect((await q('SELECT CHAR_LENGTH(case_caption) AS n, case_caption = ? AS same FROM cases WHERE case_id = ?', [emoji, C1]))[0]).toEqual({ n: 150, same: 1 });
    // The live column map: an over-width CHAR(2) and an unknown column.
    await expect(card(C1, { case_chapter: '133' })).rejects.toThrow(/case_chapter "133" is 3 characters — the column keeps 2/);
    await expect(card(C1, { case_colour: 'red' })).rejects.toThrow(/^Not a column of cases: case_colour/);
    const unknown = await patch(C1, { case_colour: 'red' });
    expect([unknown.status, unknown.body.message]).toEqual([400, 'updateCase: unknown column(s): case_colour']);
  });

  test("'' ON A DATE — the route stores NULL, never a zero date; the card sends null and says Clears", async () => {
    const res = await patch(C2, { case_close_date: '' });
    expect(res.status).toBe(200);
    expect((await q('SELECT case_close_date FROM cases WHERE case_id = ?', [C2]))[0].case_close_date).toBeNull();
    const c = await card(C1, { case_file_date: '' });
    expect(c.writes[0]).toMatchObject({ column: 'case_file_date', send: null, clears: true, removes: true, from: '2026-01-02', to: 'blank' });
    expect((await patch(C1, sendOf(c))).status).toBe(200);
    expect((await q('SELECT case_file_date FROM cases WHERE case_id = ?', [C1]))[0].case_file_date).toBeNull();
  });

  test('THE SET ORDER — a SET written out of member order reads back in member order; the card joins in member order and its no-op reads the same', async () => {
    await patch(C2, { case_pre_petition: 'Signed,Sent' });
    expect((await q('SELECT case_pre_petition AS v FROM cases WHERE case_id = ?', [C2]))[0].v).toBe('Sent,Signed');
    const c = await card(C1, { case_pre_petition: ['Signed', 'Sent'] });
    expect(sendOf(c)).toEqual({ case_pre_petition: 'Sent,Signed' });
    await patch(C1, sendOf(c));
    await expect(card(C1, { case_pre_petition: ['Signed', 'Sent'] })).rejects.toThrow(/That changes nothing on case 25-80001 — case_pre_petition is already Sent, Signed/);
  });

  test('THE DATETIME — the form-shaped value is stored as that wall time and canonicalizes back to the card\'s after', async () => {
    const c = await card(C1, { show_cause: '2026-12-01 09:30' });
    expect(c.writes[0]).toMatchObject({ send: '2026-12-01T09:30', after: '2026-12-01 09:30:00' });
    expect((await patch(C1, sendOf(c))).status).toBe(200);
    expect((await q("SELECT DATE_FORMAT(show_cause, '%Y-%m-%d %H:%i:%s') AS v FROM cases WHERE case_id = ?", [C1]))[0].v).toBe('2026-12-01 09:30:00');
    await expect(card(C1, { show_cause: '2026-12-01T09:30' })).rejects.toThrow(/show_cause is already 2026-12-01 09:30 \(firm time\)/);
  });

  test('THE JUDGE TWIN — a case_judge write re-resolves the link to what the card predicted; a miss writes NULL; an unrelated column leaves it', async () => {
    let dryRun;
    const spy = jest.spyOn(triggerService, 'evaluateDraft');
    const c = await card(C1, { case_judge: 'Ann Other' });
    dryRun = spy.mock.calls.map((x) => x[1]);
    spy.mockRestore();
    expect(c.judge).toEqual({ from: 7101, to: 7102, from_label: 'Hon. Mark Example (contact #7101)', to_label: 'Hon. Ann Other (contact #7102)' });
    expect(c.warnings).toContain('JUDGE LINK CHANGES: re-resolved from the full case number\'s judge suffix, else the new judge text — Hon. Mark Example (contact #7101) → Hon. Ann Other (contact #7102).');
    // The dry run read only the ACTIVE case.updated rules, and the hand-edit rule runs.
    expect(dryRun.length).toBe(2);
    expect(c.automation).toEqual({ events: ['case.updated'], lines: ['Trigger rule #1 "Hand edits" runs: starts workflow #77 ("Hand flow")'], rules_checked: 2, quiet: 1 });
    const res = await patch(C1, sendOf(c));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', data: { case_id: C1, updated_fields: ['case_judge', 'case_judge_contact_id'],
      changes: { case_judge: { from: 'Mark Example', to: 'Ann Other' }, case_judge_contact_id: { from: 7101, to: 7102 } } } });
    expect((await q('SELECT case_judge_contact_id AS id FROM cases WHERE case_id = ?', [C1]))[0].id).toBe(7102);
    // The service emitted exactly the envelope the card dry-ran.
    const [[, type, payload]] = domainEvents.emit.mock.calls;
    expect(type).toBe('case.updated');
    expect([payload.source, payload.changes, payload.extra]).toEqual([dryRun[0].source, dryRun[0].changes, dryRun[0].extra]);
    // The browser's answer check accepts the real answer.
    expect(browser.caseFieldsResult(c, res.body)).toEqual({ case_id: C1 });
    // A miss writes NULL — the card said so.
    const miss = await card(C1, { case_judge: 'Nobody At All' });
    expect(miss.judge.to).toBeNull();
    expect(miss.warnings.join('\n')).toMatch(/JUDGE LINK CLEARS: .* Hon\. Ann Other \(contact #7102\) → none/);
    await patch(C1, sendOf(miss));
    expect((await q('SELECT case_judge_contact_id AS id FROM cases WHERE case_id = ?', [C1]))[0].id).toBeNull();
    // An unrelated column: the mismatched link on C2 is left alone, and the card re-resolves nothing.
    const other = await card(C2, { case_caption: 'In re Sam Spouse' });
    expect([other.judge, other.trustee]).toEqual([null, null]);
    const r2 = await patch(C2, sendOf(other));
    expect(r2.body.data.updated_fields).toEqual(['case_caption']);
    expect((await q('SELECT case_judge_contact_id AS id FROM cases WHERE case_id = ?', [C2]))[0].id).toBe(7101);
  });

  test('A7d — a subtype change re-resolves the pipeline on the real resolver (Chapter 7 → Chapter 13), the stage check reads the real stages, the PATCH stores it and resolveTemplate agrees; a type change clears the subtype through the route', async () => {
    await q("UPDATE cases SET pipeline_phase = 'case' WHERE case_id = ?", [C1]);
    await q("INSERT INTO case_stage_log (case_id, template_id, stage_id, stage_key, case_stage, status_label, entered_at, source) VALUES (?, 1, 5, 'filed', 'Filed', 'Filed', NOW(), 'manual')", [C1]);
    try {
      const c = await card(C1, { case_subtype: 'Chapter 13' });
      expect(c.warnings).toEqual([expect.stringMatching(/^PIPELINE CHANGES: the case resolves to Chapter 7 \(case\) → Chapter 13 \(case\).*Its current stage "filed" exists on Chapter 13 too/)]);
      const r = await patch(C1, sendOf(c));
      expect(r.status).toBe(200);
      const [[after]] = await pool.query('SELECT * FROM cases WHERE case_id = ?', [C1]);
      expect((await pipelineService.resolveTemplate(pool, after)).id).toBe(2);
      // Discharged exists on Chapter 7 only: moving back is said to leave the case unstaged there.
      await q("UPDATE case_stage_log SET stage_id = 7, stage_key = 'discharged', status_label = 'Discharged' WHERE case_id = ?", [C1]);
      const back = await card(C1, { case_subtype: 'Chapter 7' });
      expect(back.warnings[0]).toMatch(/Chapter 13 \(case\) → Chapter 7 \(case\).*Its current stage "discharged" exists on Chapter 7 too/);
      const tc = await card(C1, { case_type: 'Civil Litigation' });
      expect(tc.writes.map((x) => [x.column, x.send, !!x.implied])).toEqual([['case_type', 'Civil Litigation', false], ['case_subtype', '', true]]);
      expect(tc.warnings).toEqual([expect.stringMatching(/^PIPELINE CHANGES: the case resolves to Chapter 13 \(case\) → Intake \(intake\)/)]);
      const r2 = await patch(C1, sendOf(tc));
      expect(r2.status).toBe(200);
      const [[typed]] = await pool.query('SELECT case_type, case_subtype FROM cases WHERE case_id = ?', [C1]);
      expect(typed).toEqual({ case_type: 'Civil Litigation', case_subtype: '' });
    } finally {
      await q("UPDATE cases SET case_type = 'Bankruptcy', case_subtype = 'Chapter 7', pipeline_phase = 'intake' WHERE case_id = ?", [C1]);
      await q('DELETE FROM case_stage_log WHERE case_id = ?', [C1]);
    }
  });

  test('THE READERS SCAN — every definition table is read; each hit lands on the column it names; an inactive report and a near miss do not', async () => {
    const c = await card(C1, { case_file_date: '2026-03-03', case_chapter: '13' });
    const byCol = Object.fromEntries(c.writes.map((w) => [w.column, w.readers]));
    expect(byCol.case_file_date).toEqual([
      'Court email fills it only while it is blank.',
      'Report #10 "Filed cases" names it.',
      'Pipeline step #7 "Petition filed (stage "Filed")" names it.',
      'Templates: {{cases.case_file_date}} in letters, forms, emails and texts resolves to the new value.',
    ]);
    expect(byCol.case_chapter).toEqual(expect.arrayContaining(['CLIENT PORTAL card #3 "ch — Chapter" names it.', 'Workflow step #10 "workflow #4 v3 step 3" names it.',
      'Workflow step #12 "workflow #4 v4 step 1 "draft"" names it.', 'Sequence step #21 "template #6 v2 step 1" names it.']));
    // History is not a reader: the retired v1 step and the template's v1 step never show.
    expect(byCol.case_chapter.join(' | ')).not.toMatch(/#11|retired|#22|Old /);
    expect(c.writes.map((w) => [w.column, w.client_visible])).toEqual([['case_file_date', false], ['case_chapter', true]]);
  });

  test('THE CLICK — the precheck passes on a fresh card (DATE, DATETIME, custom compared in the GET\'s shapes), the route accepts the body, and a hand edit refuses', async () => {
    await patch(C1, { show_cause: '2026-11-30T14:00' });
    const c = await card(C1, { case_file_date: '2026-03-03', show_cause: '2026-12-01 09:30', cf_court: 'WDMI' });
    expect(c.expected).toMatchObject({ case_file_date: '2026-01-02', show_cause: '2026-11-30 14:00:00', cf_court: '"EDMI"', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
    expect(await browser.caseFieldsPrecheck(c)).toBe('');
    const req = browser.caseFieldsRequest(c);
    expect(req).toEqual({ path: `/api/cases/${C1}`, method: 'PATCH', body: { case_file_date: '2026-03-03', show_cause: '2026-12-01T09:30', cf_court: 'WDMI' } });
    const res = await patch(C1, req.body);
    expect(res.status).toBe(200);
    expect(browser.caseFieldsResult(c, res.body)).toEqual({ case_id: C1 });
    expect((await q("SELECT DATE_FORMAT(case_file_date, '%Y-%m-%d') AS f, cf_court FROM cases WHERE case_id = ?", [C1]))[0]).toEqual({ f: '2026-03-03', cf_court: 'WDMI' });
    // The same card is now stale on every touched column.
    expect(await browser.caseFieldsPrecheck(c)).toBe('case_file_date, show_cause, cf_court of case 25-80001 changed since this card was prepared. Nothing was written. Ask Casey to prepare it again.');
    // The route's own cf_ 400 is the card's refusal.
    await expect(card(C1, { cf_court: 'XXMI' })).rejects.toThrow(/^CUSTOM FIELD refused — cf_court: "XXMI" is not one of its options \(EDMI, WDMI\)\. Nothing is proposed$/);
    const bad = await patch(C1, { cf_court: 'XXMI' });
    expect([bad.status, bad.body.message]).toEqual([400, 'cf_court: "XXMI" is not one of its options (EDMI, WDMI)']);
  });

  // ── A7e: the docket on this card ──────────────────────────────────────────
  describe('A7e — THE DOCKET on the case fields card', () => {
    const C3 = 'A7ECASE3'; const C4 = 'A7ECASE4';
    const eventSvc = require('../services/eventService');
    const logSvc = require('../services/logService');
    const { resolveCase } = require('../lib/courtResolve');
    const ev3 = [{ id: 'q1', rows: [{ case_id: C3 }] }];
    const card3 = (changes) => normalizeActionDraft(pool, { kind: 'case.fields.update.v1', case_id: C3, changes, evidence: row(1) }, ev3, { currentUserId: 6 });
    // The case's Events tab and log, by their own readers.
    const eventIds = async () => (await eventSvc.listEvents(pool, { link_type: 'case', link_id: C3, status: 'all', includeSuperseded: true, limit: 500 })).data.map((e) => e.event_id).sort();
    const logIds = async () => {
      const { whereFragment, params } = await logSvc._buildCaseLogWhere(pool, C3, { relateFilter: 'none' });
      return (await q(`SELECT l.log_id FROM log l WHERE ${whereFragment} ORDER BY l.log_id`, params)).map((r) => r.log_id);
    };
    const minus = (a, b) => a.filter((x) => !b.includes(x));

    beforeEach(async () => {
      // C3: a full number with the 'mex' suffix (judge link 7101 by suffix) and a judge
      // text that matches no judge — so a clear of the full number drops the link.
      // C4: another case holding a full number in other capitalisation.
      await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type, case_subtype, case_judge, case_judge_contact_id, case_caption) VALUES
        (?, '25-80003', '25-80003-mex', 'Bankruptcy', 'Chapter 13', 'Unknown Judge', 7101, 'In re Dana Debtor'),
        (?, NULL, '25-80009-AOT', 'Bankruptcy', 'Chapter 7', '', NULL, '')`, [C3, C4]);
      await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (962, ?, 7001, 'Primary')`, [C3]);
      await q(`INSERT INTO events (event_id, event_link_type, event_link_id, event_title, event_date) VALUES
        (9001, 'case_number', '25-80003-mex', 'Hearing filed under the old full number', '2026-12-01'),
        (9002, 'case_number', '25-80003-aot', 'Hearing filed under the new full number', '2026-12-02'),
        (9003, 'case_number', '25-80003', 'Deadline under the bare number (stays)', '2026-12-03'),
        (9004, 'case', ?, 'Linked by case id (stays)', '2026-12-04'),
        (9005, 'case_number', '25-99999', 'Unrelated', '2026-12-05')`, [C3]);
      await q(`INSERT INTO log (log_id, log_type, log_date, log_link, log_link_type, log_link_id, log_about_type, log_about_id, log_by, log_data, log_message) VALUES
        (8001, 'court email', '2026-11-01 10:00:00', '25-80003-mex', 'case', '25-80003-mex', NULL, NULL, 0, '', 'old full, typed'),
        (8002, 'note', '2026-11-01 10:01:00', '25-80003-mex', NULL, NULL, NULL, NULL, 0, '', 'old full, legacy untyped'),
        (8003, 'court email', '2026-11-01 10:02:00', 'x@example.com', 'email', 'x@example.com', 'case', '25-80003-aot', 0, '', 'new full, about'),
        (8004, 'note', '2026-11-01 10:03:00', ?, 'case', ?, NULL, NULL, 0, '', 'by case id (stays)'),
        (8005, 'note', '2026-11-01 10:04:00', '25-80003', 'case', '25-80003', NULL, NULL, 0, '', 'bare number (stays)'),
        (8006, 'note', '2026-11-01 10:05:00', '25-80003-mex', 'case', '25-80003-mex', 'case', ?, 0, '', 'old full but about the case id (stays)')`, [C3, C3, C3]);
    });

    test('REPLACE — the card counts exactly the rows the real readers lose and gain; court email and the judge link follow; the PATCH stores it', async () => {
      const ev0 = await eventIds(); const log0 = await logIds();
      expect(ev0).toEqual([9001, 9003, 9004]);
      expect(log0).toEqual([8001, 8002, 8004, 8005, 8006]);
      const c = await card3({ case_number_full: '25-80003-aot' });
      expect(c.docket.rows).toEqual({ events_leave: 1, log_leave: 2, events_arrive: 1, log_arrive: 1 });
      expect(c.judge).toMatchObject({ from: 7101, to: 7102 });
      expect(c.warnings).toContain('JUDGE LINK CHANGES: re-resolved from the new full case number\'s judge suffix, else the judge text — Hon. Mark Example (contact #7101) → Hon. Ann Other (contact #7102).');
      expect(c.expected).toMatchObject({ case_number: '25-80003', case_number_full: '25-80003-mex', case_judge: 'Unknown Judge', case_judge_contact_id: '7101' });
      expect(await browser.caseFieldsPrecheck(c)).toBe('');
      const res = await patch(C3, browser.caseFieldsRequest(c).body);
      expect(res.status).toBe(200);
      expect(res.body.data.updated_fields).toEqual(['case_number_full', 'case_judge_contact_id']);
      expect(browser.caseFieldsResult(c, res.body)).toEqual({ case_id: C3 });
      // The generic PATCH really stores a replaced number, and the link the card predicted.
      expect((await q('SELECT case_number_full AS f, case_judge_contact_id AS j FROM cases WHERE case_id = ?', [C3]))[0]).toEqual({ f: '25-80003-aot', j: 7102 });
      // The real readers moved exactly what the card counted.
      const ev1 = await eventIds(); const log1 = await logIds();
      expect([minus(ev0, ev1), minus(ev1, ev0)]).toEqual([[9001], [9002]]);
      expect([minus(log0, log1), minus(log1, log0)]).toEqual([[8001, 8002], [8003]]);
      // Court email: the new number lands here; the old full number still does, through the bare-number fallback (the card said so).
      expect((await resolveCase(pool, '25-80003-aot')).case_id).toBe(C3);
      expect((await resolveCase(pool, '25-80003-mex')).case_id).toBe(C3);
      expect(c.effects.find((x) => x.startsWith('Court email:'))).toMatch(/mail carrying "25-80003-mex" still reaches this case — with its judge letters stripped it is "25-80003"/);
    });

    test('CLEAR — the bare number gone: old mail stops resolving, its rows leave, the card counted them', async () => {
      const ev0 = await eventIds(); const log0 = await logIds();
      const c = await card3({ case_number: '' });
      expect(c.writes[0]).toMatchObject({ column: 'case_number', send: null, clears: true, removes: true });
      expect(c.docket.rows).toEqual({ events_leave: 1, log_leave: 1, events_arrive: 0, log_arrive: 0 });
      expect(c.effects.find((x) => x.startsWith('Court email:'))).toMatch(/mail carrying "25-80003" no longer files on this case; a full docket that reduces to "25-80003" once its judge letters are stripped no longer falls back to this case/);
      expect((await resolveCase(pool, '25-80003-zzz')).case_id).toBe(C3); // the bare fallback, before
      expect((await patch(C3, browser.caseFieldsRequest(c).body)).status).toBe(200);
      expect((await q('SELECT case_number FROM cases WHERE case_id = ?', [C3]))[0].case_number).toBeNull();
      const ev1 = await eventIds(); const log1 = await logIds();
      expect([minus(ev0, ev1), minus(ev1, ev0)]).toEqual([[9003], []]);
      expect([minus(log0, log1), minus(log1, log0)]).toEqual([[8005], []]);
      expect((await resolveCase(pool, '25-80003')).found).toBe(false);
      expect((await resolveCase(pool, '25-80003-zzz')).found).toBe(false);
    });

    test('CLEAR the full number — the judge link drops when the judge text matches no one; the card predicted it', async () => {
      const c = await card3({ case_number_full: null });
      expect(c.judge).toMatchObject({ from: 7101, to: null });
      expect(c.warnings.join('\n')).toMatch(/JUDGE LINK CLEARS: the server re-resolves the judge contact from the judge text alone \(the full case number is cleared, so it has no suffix\) and finds no match/);
      expect(c.docket.after.header).toBe('25-80003');
      const res = await patch(C3, browser.caseFieldsRequest(c).body);
      expect(res.body.data.changes).toEqual({ case_number_full: { from: '25-80003-mex', to: null }, case_judge_contact_id: { from: 7101, to: null } });
      expect((await q('SELECT case_number_full AS f, case_judge_contact_id AS j FROM cases WHERE case_id = ?', [C3]))[0]).toEqual({ f: null, j: null });
    });

    test('ANOTHER CASE HOLDS IT — the card refuses it (the service\'s own equality), the click re-checks it, and the plain PATCH refuses the duplicate at the write (409, nothing stored)', async () => {
      // The card: refused, naming the other case (capitalisation aside — general_ci).
      await expect(card3({ case_number: '25-80009-aot' })).rejects.toThrow(`ANOTHER CASE HOLDS IT: "25-80009-aot" is already on case ${C4} (Bankruptcy) — its case number is blank, its full case number "25-80009-AOT"`);
      // The route's own guard (2026-11-09): the duplicate is refused before any write, in either
      // column, general_ci — and the browser reads that 409 as a refusal, never "may have been applied".
      const dup = await patch(C2, { case_number: '25-80009-aot' });
      expect([dup.status, dup.body.message]).toEqual([409, `That docket already belongs to case ${C4} (25-80009-AOT).`]);
      expect(dup.body.conflict).toMatchObject({ case_id: C4, case_number_full: '25-80009-AOT' });
      expect((await q("SELECT COUNT(*) AS n FROM cases WHERE case_number = '25-80009-aot' OR case_number_full = '25-80009-aot'"))[0].n).toBe(1);
      expect((await q('SELECT case_number FROM cases WHERE case_id = ?', [C2]))[0].case_number).toBe('25-80002');
      const full = await patch(C2, { case_number: '25-80002', case_number_full: '25-80009-AOT ' }); // trailing space — equal under PAD SPACE
      expect([full.status, full.body.conflict && full.body.conflict.case_id]).toEqual([409, C4]);
      expect(browser.caseFieldsKnownOutcome(Object.assign(new Error(dup.body.message), { status: dup.status, body: dup.body })))
        .toEqual({ status: 'Refused — nothing written', text: `Refused — nothing written: That docket already belongs to case ${C4} (25-80009-AOT). Another case took that number after this card was prepared; two cases cannot share a docket. If they are the same matter, merge the cases on the case page.` });
      expect(browser.caseFieldsKnownOutcome(Object.assign(new Error('x'), { status: 409, body: { idempotency: { outcome: 'unknown' }, conflict: {}, message: dup.body.message } }))).toBeNull();
      // A case's OWN number is no collision: re-sending it is a no-op write, not a 409.
      expect((await patch(C2, { case_number: '25-80002' })).status).toBe(200);
      // A card prepared while the number was free; another case takes it before the click.
      const c = await card3({ case_number: '25-80077' });
      expect(await browser.caseFieldsPrecheck(c)).toBe('');
      await patch(C4, { case_number: '25-80077 ' }); // stored with a trailing space — equal under PAD SPACE
      expect(await browser.caseFieldsPrecheck(c)).toBe(`Case ${C4} now holds "25-80077" — another case took that number since this card was prepared. Nothing was written. Two cases cannot share a docket; if they are the same matter, merge the cases on the case page.`);
      expect((await q('SELECT case_number FROM cases WHERE case_id = ?', [C3]))[0].case_number).toBe('25-80003');
    });

    test('WIDTH — the plain PATCH refuses a 21-character number (400, nothing stored; it used to store it cut to 20 and answer 200); the card refuses it first', async () => {
      const res = await patch(C2, { case_number: '1'.repeat(21) });
      expect([res.status, res.body.message]).toEqual([400, 'case_number is 21 characters — the column keeps 20']);
      expect((await q('SELECT case_number AS n FROM cases WHERE case_id = ?', [C2]))[0].n).toBe('25-80002');
      // Exactly 20 is stored whole (code points, not UTF-16 units).
      const twenty = '\u{1F4C4}'.repeat(20);
      expect((await patch(C2, { case_number_full: twenty })).status).toBe(200);
      expect((await q('SELECT CHAR_LENGTH(case_number_full) AS n FROM cases WHERE case_id = ?', [C2]))[0].n).toBe(20);
      expect((await patch(C2, { case_number_full: null })).status).toBe(200);
      await expect(card3({ case_number: '2'.repeat(21) })).rejects.toThrow(/^case_number "2{21}" is 21 characters — the column keeps 20, and the route refuses it\. Nothing is proposed — shorten it$/);
    });
  });
});
