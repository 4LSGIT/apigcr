// tests/caseyRequirementOverride.mysql.test.js
//
/**
 * A9.4 on REAL MySQL: the Casey requirement override cards
 * (case.requirement.override.v1 / .clear.v1) over rows mysql2 really returns,
 * beside the REAL routes they send — routes/api.pipeline.js POST / DELETE
 * /api/cases/:id/pipeline/requirements/:key/override →
 * requirementService.setOverride / clearOverride (and its case-log row
 * through logService.createLogEntry) — real handlers, real pool, under the
 * production sql_mode.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a94_test npx jest tests/caseyRequirementOverride.mysql.test.js --runInBand
 * The database name must end in _test (port 3306 is refused — on a dev
 * machine that is production); this suite DROPS and recreates its tables in
 * it, cloned from ref/database.sql (live types and keys; a clause referencing
 * a table outside the list is dropped). Drops run with FOREIGN_KEY_CHECKS off
 * in the before-hook AND the after-hook and take any sibling-built child of
 * ours with them. Give it its own *_test DB. The server needs its timezone
 * tables loaded (mysql_tzinfo_to_sql): the case-log row's log_date is
 * CONVERT_TZ(NOW(), …, 'EST5EDT'), NULL without them, and the fire-and-forget
 * log write would fail silently.
 *
 * WHAT IS LOCKED
 *   - SET LANDS AS THE CARD SAID: the real POST with the browser's own request
 *     stores the status, the note and set_by = the signed-in user, writes the
 *     case-log row whose text the card quoted word for word, and the real
 *     resolver then reads the step as the card's after_status; the browser's
 *     result check accepts the real payload; the card's precheck passed before
 *     the write and refuses after it.
 *   - REPLACE: over an existing override, the card's DERIVED status (the real
 *     resolver re-run over the hiding wrapper) equals what the real resolver
 *     reads once the override is really deleted; the replaced override is
 *     named with its author's name from users.
 *   - CLEAR: the "returns to" status the card projected equals the real
 *     resolver after the real DELETE — for a manual step (back to active, a
 *     re-block) and a case_field-detector step (back to done); the log row.
 *   - THE PRECHECK over the real GETs (steps, pipeline, case) passes a fresh
 *     card and refuses one after a hand edit.
 *   - THE ROUTE'S OWN 400 / 404 beside the card's refusals: a status outside
 *     na / done, an unknown key, a clear with nothing to clear (the browser
 *     reads that 404 as a refusal); and the route storing an over-long note
 *     CUT SHORT (by UTF-16 units — an emoji note is mangled) where the card
 *     refuses it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// The routes' dependencies NOT under test: the auth gate (pinned in
// tests/caseyActionPermissions.test.js) — the signed-in user is #6.
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'users', 'pipeline_templates', 'pipeline_stages', 'pipeline_stage_requirements',
  'case_stage_log', 'case_requirement_overrides', 'log'];

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

// The browser half, extracted verbatim from the page (the assistantUi fnSrc idiom).
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
function constSrc(name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
  if (!m) throw new Error(`const ${name} not found`);
  return html.slice(m.index, html.indexOf(';\n', m.index) + 1);
}
function browser(api) {
  const fns = ['actionStringReceipt', 'casePipelineCaseLabel', 'caseOverrideWord', 'caseOverrideRequest', 'caseOverridePrecheck', 'caseOverrideResult', 'caseOverrideKnownOutcome'];
  return new Function('api', `${constSrc('CASE_OVERRIDE_KEY')}\n${fns.map(fnSrc).join('\n')}\nreturn { ${fns.join(', ')} };`)(api); // eslint-disable-line no-new-func
}

// The fire-and-forget case-log write lands after the response; poll for it, bounded.
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

d('the Casey requirement override cards on real MySQL (A9.4)', () => {
  let pool; let app;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A94CASE1';

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
    await q(`INSERT INTO users (user, user_name, user_auth, user_type) VALUES (6, 'Fred', 'authorized', 1), (1, 'Stuart', 'authorized', 1)`);
    await q(`INSERT INTO pipeline_templates (id, name, case_type, case_subtype, role, is_default, active) VALUES
      (1, 'Intake', '', '', 'intake', 0, 1), (2, 'Chapter 7', 'Bankruptcy', 'Chapter 7', 'case', 1, 1)`);
    await q(`INSERT INTO pipeline_stages (id, template_id, stage_key, stage_number, internal_label, client_label, case_stage, lane, default_rec, client_visible, active) VALUES
      (11, 1, 'consult_booked', 1, 'Consult booked', 'Consult', 'Open', 'main', '', 1, 1),
      (21, 2, 'retained', 1, 'Retained', 'Retained', 'Open', 'main', '', 1, 1),
      (22, 2, 'docs', 2, 'Docs requested', 'Documents', 'Open', 'main', '', 1, 1),
      (23, 2, 'filed', 3, 'Filed', 'Filed', 'Filed', 'main', '', 1, 1),
      (29, 2, 'dismissed', 90, 'Dismissed', NULL, 'Closed', 'offramp', '', 0, 1)`);
    await q(`INSERT INTO pipeline_stage_requirements (id, stage_id, requirement_key, internal_label, client_label, client_visible, required, owner, detector, detector_config, hint, sort_order, active) VALUES
      (401, 11, 'questionnaire', 'Intake questionnaire submitted', 'Questionnaire', 1, 1, 'client', 'manual', NULL, NULL, 1, 1),
      (402, 21, 'fee', 'Retainer fee paid', 'Pay your retainer', 1, 1, 'client', 'manual', NULL, 'Collect the retainer', 1, 1),
      (403, 21, 'courtesy', 'Courtesy call', NULL, 0, 0, 'staff', 'manual', NULL, NULL, 2, 1),
      (404, 22, 'file_date', 'File date recorded', NULL, 0, 1, 'staff', 'case_field', '{"field":"case_file_date"}', NULL, 1, 1),
      (405, 22, 'w2', 'W-2s received', 'Send your W-2s', 1, 1, 'client', 'manual', NULL, NULL, 2, 1)`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype, pipeline_phase, case_stage, case_status, case_rec, case_file_date) VALUES
      (?, '25-70001', 'Bankruptcy', 'Chapter 7', 'case', 'Open', 'Retained', '', '2026-09-01')`, [C1]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES (7001, 'person', 'Dana Debtor', 'Dana', 'Debtor')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (951, ?, 7001, 'Primary')`, [C1]);
    await q(`INSERT INTO case_stage_log (case_id, template_id, stage_id, stage_key, case_stage, status_label, entered_at, entered_by, source) VALUES
      (?, 1, 11, 'consult_booked', 'Open', 'Consult booked', '2026-08-01 10:00:00', 6, 'manual'),
      (?, 2, 21, 'retained', 'Open', 'Retained', '2026-08-15 10:00:00', 6, 'manual')`, [C1, C1]);
  }
  const ev = [{ id: 'q1', rows: [{ case_id: C1 }] }];
  const cite = [{ query_id: 'q1', row_number: 1 }];
  const card = (value) => normalizeActionDraft(pool, { case_id: C1, evidence: cite, ...value }, ev, { currentUserId: 6 });
  // A draft as it reaches the browser: through JSON (Dates become ISO strings).
  const wire = (c) => JSON.parse(JSON.stringify(c));
  const overrideRow = async (key) => (await q('SELECT status, note, set_by FROM case_requirement_overrides WHERE case_id = ? AND requirement_key = ?', [C1, key]))[0] || null;
  const logRows = () => q("SELECT log_type, log_link_type, log_link, log_link_id, log_by, log_data, log_extra FROM log WHERE log_link_type = 'case' AND log_link = ? ORDER BY log_id", [C1]);
  const resolved = async () => {
    const res = await call(app, 'GET', `/api/cases/${C1}/pipeline/requirements`);
    return new Map(res.body.requirements.map((r) => [`${r.requirement_key}@${r.stage_id}`, r]));
  };
  // The browser's api(): GETs through the real routes, a non-2xx as the shell's apiSend throws it.
  const realApi = async (p, body, method) => {
    if (method !== 'GET') throw new Error(`unexpected ${method} ${p}`);
    const res = await call(app, 'GET', p);
    if (res.status >= 400) throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
    return res.body;
  };
  const send = (r) => call(app, r.method, r.path, r.body);

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
      const [[tz]] = await conn.query("SELECT CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT') AS t");
      if (tz.t == null) throw new Error('the test server has no timezone tables (mysql_tzinfo_to_sql) — the case-log row cannot be written');
    } finally { conn.release(); }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.pipeline'));
    app.use(require('../routes/api.cases'));
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => { await seed(); });

  test('SET LANDS AS THE CARD SAID: status, note, set_by, the quoted case-log row, the resolver after; precheck passes before and refuses after', async () => {
    const c = wire(await card({ kind: 'case.requirement.override.v1', requirement: 'Retainer fee paid', status: 'na', note: 'Paid in cash at the consult' }));
    expect(c).toMatchObject({
      requirement: { requirement_key: 'fee', required: 1 }, override_status: 'na', note: 'Paid in cash at the consult',
      log_line: 'Requirement fee: marked N/A (override) - Paid in cash at the consult',
      // docs is blocked by fee alone; filed by fee AND w2 (file_date is done by its real case_field detector).
      gate: { unblocks: ['Docs requested (docs) — its next stage'], reblocks: [], still: [{ move: 'Filed (filed)', others: ['"W-2s received" (stage Docs requested, upcoming)'] }] },
    });
    expect(c.rows).toEqual([expect.objectContaining({ stage_id: 21, detector: 'manual', status: 'active', derived_status: 'active', after_status: 'na', on_pipeline: true })]);
    expect(c.effects).toContain('Client portal: "Pay your retainer" goes from shown as still to do to hidden on the client\'s Next steps card, and the count of steps remaining changes with it.');
    const b = browser(realApi);
    await expect(b.caseOverridePrecheck(c)).resolves.toBe('');
    const res = await send(b.caseOverrideRequest(c));
    expect(res.status).toBe(200);
    expect(b.caseOverrideResult(c, res.body)).toEqual({ case_id: C1 });
    expect(await overrideRow('fee')).toEqual({ status: 'na', note: 'Paid in cash at the consult', set_by: 6 });
    const log = await waitFor(async () => (await logRows())[0]);
    expect(log).toMatchObject({ log_type: 'status', log_link_type: 'case', log_link: C1, log_link_id: C1, log_by: 6, log_data: c.log_line });
    expect(typeof log.log_extra === 'string' ? JSON.parse(log.log_extra) : log.log_extra).toEqual({ source: 'staff', requirement_key: 'fee', override_status: 'na' });
    expect((await resolved()).get('fee@21')).toMatchObject({ status: c.rows[0].after_status, override: { status: 'na', note: 'Paid in cash at the consult', set_by: 6 } });
    // The same card again: the override it did not review is now there.
    await expect(b.caseOverridePrecheck(c)).resolves.toMatch(/^The override on "Retainer fee paid" for case 25-70001 changed since this card was prepared \(now N\/A, note "Paid in cash at the consult"\)/);
    // A fresh identical set is refused by name; the same status with a new note is a note-only card.
    await expect(card({ kind: 'case.requirement.override.v1', requirement: 'fee', status: 'na', note: 'Paid in cash at the consult' })).rejects.toThrow(/^"Retainer fee paid" on case 25-70001 is already marked N\/A by an override with this same note/);
    await expect(card({ kind: 'case.requirement.override.v1', requirement: 'fee', status: 'na', note: 'again' })).resolves.toMatchObject({ note_only: true });
  });

  test('REPLACE: the derived status the card shows (resolver re-run, this override hidden) is what the real resolver reads once it is deleted; the author is named', async () => {
    await q(`INSERT INTO case_requirement_overrides (case_id, requirement_key, status, note, set_by, updated_at) VALUES (?, 'w2', 'na', 'no W-2 income', 1, '2026-10-20 15:00:00'),
      (?, 'fee', 'done', 'paid', 6, '2026-10-20 15:00:00')`, [C1, C1]);
    const c = wire(await card({ kind: 'case.requirement.override.v1', requirement: 'w2', status: 'done', note: 'both W-2s are in the file' }));
    expect(c.rows[0]).toMatchObject({ status: 'na', derived_status: 'upcoming', after_status: 'done' });
    expect(c.existing).toEqual({ status: 'na', note: 'no W-2 income', set_by: 1, set_by_text: 'Stuart (user #1)', at: '2026-10-20T15:00:00.000Z', at_text: '2026-10-20 11:00 firm time' });
    await expect(browser(realApi).caseOverridePrecheck(c)).resolves.toBe('');
    // The projection, checked against the real resolver with the override really gone.
    await q('DELETE FROM case_requirement_overrides WHERE case_id = ? AND requirement_key = ?', [C1, 'w2']);
    const after = await resolved();
    expect(after.get('w2@22').status).toBe(c.rows[0].derived_status);
    // The hiding touched only w2: fee's override is still in force.
    expect(after.get('fee@21').status).toBe('done');
  });

  test('NOTE ONLY: same status, a new note — the real route rewrites the note and set_by, keeps the status, and writes the log line the card quoted', async () => {
    await q(`INSERT INTO case_requirement_overrides (case_id, requirement_key, status, note, set_by, updated_at) VALUES (?, 'fee', 'na', 'old reason', 1, '2026-10-20 15:00:00')`, [C1]);
    // The identical set is refused: nothing to change.
    await expect(card({ kind: 'case.requirement.override.v1', requirement: 'fee', status: 'na', note: 'old reason' })).rejects.toThrow(/with this same note \("old reason"\) — there is nothing to change$/);
    const c = wire(await card({ kind: 'case.requirement.override.v1', requirement: 'fee', status: 'na', note: 'Paid in cash, receipt in file' }));
    expect(c).toMatchObject({ note_only: true, warnings: [], gate: { unblocks: [], reblocks: [], still: [] }, log_line: 'Requirement fee: marked N/A (override) - Paid in cash, receipt in file' });
    expect(c.rows[0]).toMatchObject({ status: 'na', derived_status: 'active', after_status: 'na' });
    expect(c.effects.find((e) => /^NOTE ONLY/.test(e))).toMatch(/^NOTE ONLY: status unchanged \(N\/A\); note replaced: "old reason" → "Paid in cash, receipt in file"\. The override was N\/A, set by Stuart \(user #1\)/);
    const b = browser(realApi);
    await expect(b.caseOverridePrecheck(c)).resolves.toBe('');
    const res = await send(b.caseOverrideRequest(c));
    expect([res.status, b.caseOverrideResult(c, res.body)]).toEqual([200, { case_id: C1 }]);
    expect(await overrideRow('fee')).toEqual({ status: 'na', note: 'Paid in cash, receipt in file', set_by: 6 });
    const log = await waitFor(async () => (await logRows())[0]);
    expect(log).toMatchObject({ log_type: 'status', log_by: 6, log_data: c.log_line });
    expect((await resolved()).get('fee@21')).toMatchObject({ status: 'na', override: { note: 'Paid in cash, receipt in file', set_by: 6 } });
  });

  test('CLEAR: the "returns to" status equals the real resolver after the real DELETE — a manual step back to active (re-block), a detector step back to done; the log row', async () => {
    await q(`INSERT INTO case_requirement_overrides (case_id, requirement_key, status, note, set_by) VALUES (?, 'fee', 'done', 'paid', 6), (?, 'file_date', 'na', 'n/a', 6)`, [C1, C1]);
    const c = wire(await card({ kind: 'case.requirement.override.clear.v1', requirement: 'fee' }));
    expect(c.rows[0]).toMatchObject({ status: 'done', derived_status: 'active', after_status: 'active' });
    expect(c.gate.reblocks).toEqual(['Docs requested (docs) — its next stage']);
    const b = browser(realApi);
    await expect(b.caseOverridePrecheck(c)).resolves.toBe('');
    const res = await send(b.caseOverrideRequest(c));
    expect([res.status, b.caseOverrideResult(c, res.body)]).toEqual([200, { case_id: C1 }]);
    expect(await overrideRow('fee')).toBe(null);
    expect((await resolved()).get('fee@21')).toMatchObject({ status: c.rows[0].after_status, override: null });
    const log = await waitFor(async () => (await logRows())[0]);
    expect(log).toMatchObject({ log_type: 'status', log_by: 6, log_data: 'Requirement fee: override cleared' });

    const d2 = wire(await card({ kind: 'case.requirement.override.clear.v1', requirement: 'file_date' }));
    expect(d2.rows[0]).toMatchObject({ status: 'na', derived_status: 'done', after_status: 'done', detector: 'case_field' });
    const res2 = await send(browser(realApi).caseOverrideRequest(d2));
    expect(res2.status).toBe(200);
    expect((await resolved()).get('file_date@22').status).toBe(d2.rows[0].after_status);
  });

  test('THE PRECHECK over the real GETs refuses after a hand edit — an override set by hand, another step made required, the case moved', async () => {
    const c = wire(await card({ kind: 'case.requirement.override.v1', requirement: 'fee', status: 'done', note: 'Paid by card' }));
    const b = browser(realApi);
    await expect(b.caseOverridePrecheck(c)).resolves.toBe('');
    await q('UPDATE pipeline_stage_requirements SET required = 1 WHERE id = 403');
    await expect(b.caseOverridePrecheck(c)).resolves.toMatch(/^The steps of case 25-70001 changed since this card was prepared/);
    await q('UPDATE pipeline_stage_requirements SET required = 0 WHERE id = 403');
    await q(`INSERT INTO case_requirement_overrides (case_id, requirement_key, status, note, set_by) VALUES (?, 'fee', 'na', 'by hand', 1)`, [C1]);
    await expect(b.caseOverridePrecheck(c)).resolves.toMatch(/^The override on "Retainer fee paid" for case 25-70001 changed since this card was prepared \(now N\/A, note "by hand"\)/);
    await q('DELETE FROM case_requirement_overrides WHERE case_id = ?', [C1]);
    await q(`INSERT INTO case_stage_log (case_id, template_id, stage_id, stage_key, case_stage, status_label, entered_at, entered_by, source) VALUES (?, 2, 22, 'docs', 'Open', 'Docs requested', '2026-09-01 10:00:00', 6, 'manual')`, [C1]);
    // At docs, fee is behind the case: its status is skipped now — the row check refuses first.
    await expect(b.caseOverridePrecheck(c)).resolves.toMatch(/^"Retainer fee paid" on case 25-70001 changed since this card was prepared \(it now reads skipped\)/);
  });

  test('an intake-history step of a retained case resolves through the route\'s own read, as the Steps panel offers it', async () => {
    const c = wire(await card({ kind: 'case.requirement.override.v1', requirement: 'questionnaire', status: 'na', note: 'Consult done by phone' }));
    expect(c.rows).toEqual([expect.objectContaining({ stage_id: 11, template_name: 'Intake', on_pipeline: false, status: 'skipped', after_status: 'na' })]);
    const res = await send(browser(realApi).caseOverrideRequest(c));
    expect(res.status).toBe(200);
    expect((await resolved()).get('questionnaire@11').status).toBe('na');
  });

  test('THE ROUTE\'S OWN 400 / 404 beside the card\'s refusals — and the over-long note the route cuts short where the card refuses', async () => {
    const base = `/api/cases/${C1}/pipeline/requirements`;
    // A status outside na / done.
    expect((await call(app, 'POST', `${base}/fee/override`, { status: 'skipped' })).status).toBe(400);
    await expect(card({ kind: 'case.requirement.override.v1', requirement: 'fee', status: 'skipped', note: 'x' })).rejects.toThrow(/^An override's status is "na"/);
    // An unknown key.
    const unknown = await call(app, 'POST', `${base}/tax_returns/override`, { status: 'na' });
    expect([unknown.status, unknown.body.message]).toEqual([400, expect.stringMatching(/^Unknown requirement key "tax_returns"/)]);
    await expect(card({ kind: 'case.requirement.override.v1', requirement: 'tax_returns', status: 'na', note: 'x' })).rejects.toThrow(/^"tax_returns" is not a step of case 25-70001's pipeline/);
    // A clear with nothing to clear: the route's 404, which the browser reads as a refusal.
    const none = await call(app, 'DELETE', `${base}/fee/override`);
    expect([none.status, none.body.message]).toEqual([404, `No override on requirement "fee" for case ${C1}`]);
    expect(browser(realApi).caseOverrideKnownOutcome({ status: none.status, message: none.body.message, body: none.body }))
      .toMatchObject({ status: 'Refused — nothing written' });
    await expect(card({ kind: 'case.requirement.override.clear.v1', requirement: 'fee' })).rejects.toThrow(/^"Retainer fee paid" on case 25-70001 has no override to clear/);
    expect(await logRows()).toEqual([]);
    // The route clips silently: 300 characters stored as 255 …
    expect((await call(app, 'POST', `${base}/fee/override`, { status: 'na', note: 'x'.repeat(300) })).status).toBe(200);
    expect((await overrideRow('fee')).note).toBe('x'.repeat(255));
    // … and an emoji note by UTF-16 units: 200 emoji are not what is stored.
    const emoji = '\u{1F600}'.repeat(200);
    expect((await call(app, 'POST', `${base}/w2/override`, { status: 'na', note: emoji })).status).toBe(200);
    expect((await overrideRow('w2')).note).not.toBe(emoji);
    // Where the card refuses both.
    await q('DELETE FROM case_requirement_overrides WHERE case_id = ?', [C1]);
    await expect(card({ kind: 'case.requirement.override.v1', requirement: 'fee', status: 'na', note: 'x'.repeat(300) })).rejects.toThrow(/^The override note is 300 characters/);
    await expect(card({ kind: 'case.requirement.override.v1', requirement: 'w2', status: 'na', note: emoji })).rejects.toThrow(/^The override note is 200 characters \(400 UTF-16 units\)/);
  });
});
