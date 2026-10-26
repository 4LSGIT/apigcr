// tests/caseyReportDraft.mysql.test.js
//
/**
 * A16 — Casey report drafts on a REAL engine.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3326/yc_a16_test \
 *     npx jest tests/caseyReportDraft.mysql.test.js --runInBand
 * The database name must end in _test; the suite DROPs and recreates its
 * tables FROM ref/database.sql (live types), and runs every preview on a
 * least-privilege account it creates the way scripts/reportGrantUserProvision
 * does — per-column SELECT on the manifest tables, DENIED_COLUMNS withheld —
 * so the engine, not a mock, answers every query. Never point it at 3306.
 *
 * WHAT IS LOCKED
 *   - The preview really runs: the card's row count and first rows come from
 *     the engine on the report pool, a report_runs row is logged, and an engine
 *     error comes back as a refusal the repair stage can read.
 *   - The canonical last-4 expression yields the last four digits whatever
 *     format staff typed (3-2-4, bare nine digits, an EIN's 2-7).
 *   - The STORED preview never carries a full SSN or a date of birth: a
 *     direct column is masked by its ORIGIN whatever its alias; with a full
 *     SSN or a DOB in the SQL every expression column is hidden too.
 *   - columns_meta is checked against the columns the engine actually returned.
 *   - Round trip: normalizer → the browser's own request builder (extracted
 *     from public/assistant.html) → the real POST /api/reports with the
 *     card's Idempotency-Key → the stored row equals the reviewed definition
 *     (key-order-insensitively — MySQL re-orders JSON keys on write); a replay
 *     writes nothing; the saved report, run through the real run route,
 *     returns the row count the card showed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

// The report pool → the scratch engine's least-privilege account (set in
// beforeAll). The prefix `mock` is what lets jest's hoisted factory see it.
const mockReportPool = { pool: null };
jest.mock('../startup/dbReport', () => ({
  getConnection: (...args) => {
    if (!mockReportPool.pool) throw new Error('report pool not ready');
    return mockReportPool.pool.getConnection(...args);
  },
}));

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'contacts', 'cases', 'case_relate', 'report_definitions', 'report_runs',
  'request_idempotency', 'jwt_api_audit_log', 'app_settings', 'ai_calls'];
const SECRET = 'casey-report-mysql-secret';
const RO_USER = 'yc_a16_report_test';
const RO_PASS = 'scratch-only-not-a-secret'; // secret-scan: allow

function dumpBlocks(dumpLines, table) {
  const out = [];
  let cur = null;
  const start = new RegExp(`^(?:CREATE TABLE|ALTER TABLE) \`${table}\`[ (]*$`);
  for (const line of dumpLines) {
    if (cur == null) { if (start.test(line)) cur = [line]; continue; }
    cur.push(line);
    if (/;\s*$/.test(line)) { out.push(cur.join('\n').replace(/;\s*$/, '')); cur = null; }
  }
  return out;
}

// The browser's fixed request builder, out of the page's own source.
function browserReportRequest() {
  const html = read('public/assistant.html');
  const start = html.indexOf('function reportDraftRequest(');
  if (start < 0) throw new Error('reportDraftRequest not found in assistant.html');
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) {
      return new Function(`${html.slice(start, i + 1)}\nreturn reportDraftRequest;`)(); // eslint-disable-line no-new-func
    }
  }
  throw new Error('reportDraftRequest unbalanced');
}

// Key-order-insensitive canonical form (CLAUDE.md, wf50).
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

d('A16 report drafts on a real engine', () => {
  const svc = require('../services/assistantService');
  const { withTransaction } = require('../lib/withTransaction');
  let pool;
  let roPool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const OLD_SECRET = process.env.JWT_SECRET;

  const ASK = 'Make a report of contacts for export';
  const norm = (value, question = ASK) => svc.normalizeActionDraft(pool, { kind: 'report.draft.v1', evidence: [], ...value }, [],
    { currentUserId: 2, question });

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    const url = new URL(URL_);
    const dbName = url.pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (url.port === '3306' || url.port === '') throw new Error('refusing port 3306 — that is production');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);

    const dumpLines = read('ref/database.sql').split('\n');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    for (const t of TABLES) {
      const blocks = dumpBlocks(dumpLines, t);
      if (!blocks.length) throw new Error(`ref/database.sql has no CREATE TABLE for ${t}`);
      for (const b of blocks) await pool.query(b);
    }
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type)
      VALUES (2, 'plain', 'Plain Staff', 'P', 'S', 'PSS', 'authorized', 1)`);
    // Staff type SSNs both ways (14 of 151 live rows carry dashes, manifest
    // note); an org's EIN rides the same column. '' = none on file.
    await q(`INSERT INTO contacts (contact_id, contact_fname, contact_lname, contact_name, contact_city, contact_ssn, contact_dob, contact_kind) VALUES
      (1, 'Pat', 'One', 'Pat One', 'Detroit', '123-45-6789', '1980-02-03', 'person'),
      (2, 'Sam', 'Two', 'Sam Two', 'Detroit', '987654321', '1975-11-30', 'person'),
      (3, 'Acme', 'LLC', 'Acme LLC', 'Detroit', '12-3456789', NULL, 'org'),
      (4, 'Lee', 'Four', 'Lee Four', 'Troy', '', '1990-07-04', 'person')`);

    // The least-privilege report account, built like reportGrantUserProvision:
    // per-column SELECT on every manifest table that exists here, minus
    // DENIED_COLUMNS.
    const manifest = require('../lib/reportSchema/manifest');
    await q(`DROP USER IF EXISTS '${RO_USER}'@'%'`);
    await q(`CREATE USER '${RO_USER}'@'%' IDENTIFIED BY '${RO_PASS}'`);
    for (const t of TABLES.filter((x) => manifest.isAllowedTable(x))) {
      const cols = (await q('SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [dbName, t]))
        .map((r) => r.c).filter((c) => !manifest.isDeniedColumn(c));
      await q(`GRANT SELECT (${cols.map((c) => `\`${c}\``).join(', ')}) ON \`${dbName}\`.\`${t}\` TO '${RO_USER}'@'%'`);
    }
    roPool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: RO_USER, password: RO_PASS, database: dbName,
      connectionLimit: 2, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false });
    roPool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    mockReportPool.pool = roPool;
  });

  afterAll(async () => {
    process.env.JWT_SECRET = OLD_SECRET;
    if (roPool) await roPool.end();
    if (pool) { await q(`DROP USER IF EXISTS '${RO_USER}'@'%'`).catch(() => {}); await pool.end(); }
  });

  test('the report pool really is least-privilege: non-manifest tables and denied columns are unreadable', async () => {
    await expect(roPool.query('SELECT scope FROM request_idempotency')).rejects.toThrow(/denied/i);
    await expect(roPool.query('SELECT password_hash FROM users')).rejects.toThrow(/denied/i);
    // The validator stands in front of it too: neither ever reaches the engine.
    await expect(norm({ title: 'x', sql: 'SELECT r.scope FROM request_idempotency r' })).rejects.toThrow(/SQL was refused/);
    const [rows] = await roPool.query('SELECT contact_id FROM contacts ORDER BY contact_id');
    expect(rows).toHaveLength(4);
  });

  test('a last-4 draft previews on the engine: real row count, last four digits in every format, a logged run', async () => {
    const before = (await q("SELECT COUNT(*) n FROM report_runs WHERE report_key = 'assistant_report_draft'"))[0].n;
    const out = await norm({
      title: 'Detroit contacts with SSN on file', category: 'Contacts',
      sql: "SELECT ct.contact_id, ct.contact_name AS client_name, RIGHT(REGEXP_REPLACE(ct.contact_ssn,'[^0-9]',''),4) AS ssn_last4 " +
        "FROM contacts ct WHERE ct.contact_city = ? AND RIGHT(REGEXP_REPLACE(ct.contact_ssn,'[^0-9]',''),4) <> '' ORDER BY ct.contact_id",
      params: [{ name: 'city', type: 'string', label: 'City', default: 'Detroit', required: true }],
      columns_meta: [{ key: 'client_name', label: 'Client' }, { key: 'contact_id', hidden: true }],
    });
    expect(out).toMatchObject({ kind: 'report.draft.v1', status: 'draft', ssn: 'last4', dob: false, tables: ['contacts'] });
    expect(out.definition.report_key).toMatch(/^casey_detroit_contacts_with_ssn_on_file_[0-9a-f]{6}$/);
    expect(out.preview.row_count).toBe(3);
    expect(out.preview.truncated).toBe(false);
    expect(out.preview.columns.map((c) => c.key)).toEqual(['contact_id', 'client_name', 'ssn_last4']);
    expect(out.preview.columns[0].hidden).toBe(true);
    expect(out.preview.rows.map((r) => r[2])).toEqual(['6789', '4321', '6789']);
    expect(out.preview.bound_values).toEqual(['Detroit']);
    const after = (await q("SELECT COUNT(*) n FROM report_runs WHERE report_key = 'assistant_report_draft'"))[0].n;
    expect(Number(after)).toBe(Number(before) + 1);
  });

  test('the stored preview never carries a full SSN or a DOB, whatever the alias or expression', async () => {
    const question = 'Export a list of clients with their SSNs and birthdays';
    const out = await norm({
      title: 'Clients with SSNs', category: 'Contacts',
      sql: 'SELECT ct.contact_id, ct.contact_name AS client_name, ct.contact_ssn AS tax_id, ct.contact_dob AS born, ' +
        "CONCAT('id:', ct.contact_ssn) AS sneaky, DATE_FORMAT(ct.contact_dob, '%Y-%m-%d') AS born_text, t.s AS derived " +
        'FROM contacts ct JOIN (SELECT contact_id AS cid, contact_ssn AS s FROM contacts) t ON t.cid = ct.contact_id ORDER BY ct.contact_id',
    }, question);
    expect(out.ssn).toBe('full');
    expect(out.dob).toBe(true);
    const stored = JSON.stringify(out.preview);
    for (const secret of ['123-45-6789', '123456789', '987654321', '12-3456789', '123456789', '1980', '1975', '1990-07-04']) {
      expect({ secret, leaked: stored.includes(secret) }).toEqual({ secret, leaked: false });
    }
    const byKey = Object.fromEntries(out.preview.columns.map((c, i) => [c.key, out.preview.rows.map((r) => r[i])]));
    expect(byKey.client_name).toEqual(['Pat One', 'Sam Two', 'Acme LLC', 'Lee Four']);
    expect(out.preview.columns.find((c) => c.key === 'tax_id').masked).toBe(true);
    expect(out.preview.columns.find((c) => c.key === 'born').masked).toBe(true);
    // The definition itself is unmasked: the saved report shows what was asked for.
    expect(out.definition.sql_text).toContain('ct.contact_ssn AS tax_id');
  });

  test('without the SSN ask a full read is refused; a last-4 filter without the ask is fine', async () => {
    await expect(norm({ title: 'x', sql: "SELECT ct.contact_id FROM contacts ct WHERE ct.contact_ssn <> '' ORDER BY ct.contact_id" }))
      .rejects.toThrow(/selects contact_ssn in full/);
    const ok = await norm({ title: 'Has SSN', sql: "SELECT ct.contact_id FROM contacts ct WHERE RIGHT(REGEXP_REPLACE(ct.contact_ssn,'[^0-9]',''),4) <> '' ORDER BY ct.contact_id" });
    expect(ok.preview.row_count).toBe(3);
    expect(ok.ssn).toBe('last4');
  });

  test('engine and validator refusals come back as readable 422s; columns_meta must name returned columns', async () => {
    await expect(norm({ title: 'x', sql: 'SELECT ct.no_such_column FROM contacts ct' }))
      .rejects.toThrow(/Report draft preview failed: .*no_such_column/);
    await expect(norm({ title: 'x', sql: 'SELECT u.password_hash FROM users u' }))
      .rejects.toThrow(/Report draft SQL was refused/);
    await expect(norm({ title: 'x', sql: 'SELECT ct.contact_id FROM contacts ct WHERE ct.contact_city = ?',
      params: [{ name: 'city', type: 'string', required: true }] }))
      .rejects.toThrow(/cannot be previewed: Missing required parameter "city"/);
    await expect(norm({ title: 'x', sql: 'SELECT ct.contact_id FROM contacts ct', columns_meta: [{ key: 'nope', label: 'N' }] }))
      .rejects.toThrow(/columns_meta: .*"nope" is not a column the SQL returns/);
    await expect(norm({ title: 'x', sql: 'SELECT ct.contact_id, ct.contact_id FROM contacts ct' }))
      .rejects.toThrow(/distinct aliases/);
  });

  // The SSN gate reads the SIGNED ticket's question — the execute path must
  // hand it to the normalizer (and to the repair stage). Model stages are
  // stubbed; the sql.read step and the preview run on the engine.
  describe('the execute path hands the signed question to the SSN gate', () => {
    const aiService = require('../services/aiService');
    const ticket = require('../lib/assistantTicket');
    const fullSsnDraft = { kind: 'report.draft.v1', title: 'Clients with SSNs', category: 'Contacts',
      sql: 'SELECT ct.contact_id, ct.contact_name AS client_name, ct.contact_ssn AS ssn FROM contacts ct ORDER BY ct.contact_id', evidence: [] };
    const run = async (question) => {
      const plan = svc.validatePlan({ action: 'query', summary: 'Sample contacts', steps: [
        { id: 'q1', kind: 'sql.read', purpose: 'Sample the contacts', sql: 'SELECT ct.contact_id, ct.contact_name FROM contacts ct ORDER BY ct.contact_id LIMIT 5' }] });
      const signed = ticket.sign({ v: 1, uid: 2, question, history: [], plan: { action: 'query', ...plan } });
      const keys = [];
      const spy = jest.spyOn(aiService, 'call').mockImplementation(async (_db, opts) => {
        keys.push(opts.promptKey);
        if (opts.promptKey === 'assistant_investigate') return { ok: true, callId: 1, json: { action: 'finish', reason: 'enough' } };
        if (opts.promptKey === 'assistant_answer') return { ok: true, callId: 2, json: { answer: 'Here is the report.', citations: [], action_draft: fullSsnDraft } };
        if (opts.promptKey === 'assistant_task_draft_repair') return { ok: true, callId: 3, json: { action_draft: fullSsnDraft } };
        throw new Error(`unexpected prompt ${opts.promptKey}`);
      });
      try {
        const out = await svc.execute(pool, { signedTicket: signed, userId: 2, auth: { type: 'jwt', userId: 2 } });
        const callFor = (key) => (spy.mock.calls.find(([, o]) => o.promptKey === key) || [])[1];
        return { out, keys, answerCall: callFor('assistant_answer'), repairCall: callFor('assistant_task_draft_repair') };
      } finally { spy.mockRestore(); }
    };

    test('a question naming SSNs yields the full-SSN card, with the report appendix and budget', async () => {
      const { out, keys, answerCall } = await run('Export a list of all clients with their SSNs');
      expect(out.action_draft).toMatchObject({ kind: 'report.draft.v1', ssn: 'full' });
      expect(out.investigation.action_draft_status).toBe('ready');
      expect(keys).not.toContain('assistant_task_draft_repair');
      expect(answerCall.systemAppend).toMatch(/REPORT DRAFT RULES/);
      expect(answerCall.max_tokens).toBeGreaterThanOrEqual(8000);
      expect(JSON.stringify(out.action_draft.preview)).not.toMatch(/123-45-6789|987654321|12-3456789/);
    });

    test('the same draft under a question that does not name SSNs is refused, repair included — no card', async () => {
      const { out, keys, repairCall } = await run('Export a list of all clients for the mailing');
      expect(out.action_draft).toBeUndefined();
      // The repair stage gets the schema + rules and room for a whole definition.
      expect(repairCall.systemAppend).toMatch(/REPORT DRAFT RULES/);
      expect(repairCall.max_tokens).toBe(4000);
      expect(out.investigation.action_draft_status).toBe('unavailable');
      expect(keys).toContain('assistant_task_draft_repair');
      expect(out.answer).toMatch(/No reviewed action card was produced|could not produce a valid reviewed action card/);
    });
  });

  test('round trip: normalizer → browser builder → POST /api/reports (keyed) → stored row == reviewed; replay writes nothing; run matches the card', async () => {
    const out = await norm({
      title: 'Detroit list', category: 'Contacts', description: 'Contacts in Detroit.',
      sql: "SELECT ct.contact_id, ct.contact_name AS client_name, RIGHT(REGEXP_REPLACE(ct.contact_ssn,'[^0-9]',''),4) AS ssn_last4 FROM contacts ct WHERE ct.contact_city = ? ORDER BY ct.contact_name",
      params: [{ name: 'city', type: 'string', label: 'City', default: 'Detroit', required: true }],
      columns_meta: [{ key: 'client_name', label: 'Client', action: { type: 'open_contact', idKey: 'contact_id' } }, { key: 'contact_id', hidden: true }],
      caveats: ['contact_city is the legacy address field.'], row_limit: 500,
    });
    const request = browserReportRequest()(out);
    expect(request).toMatchObject({ path: '/api/reports', method: 'POST', idempotent: true });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.reports.js'));
    const tok = jwt.sign({ sub: 2, username: 'plain', user_type: 1, aud: 'staff', user_auth: 'authorized', roles: ['staff'],
      ...(process.env.JWT_VERSION ? { ver: parseInt(process.env.JWT_VERSION, 10) } : {}) }, SECRET, { expiresIn: '5m' });
    const call = (method, urlPath, body, headers = {}) => new Promise((resolve, reject) => {
      const srv = app.listen(0, () => {
        const data = JSON.stringify(body || {});
        const r = http.request({ port: srv.address().port, path: urlPath, method,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${tok}`, ...headers } },
        (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: JSON.parse(s || '{}') }); }); });
        r.on('error', (e) => { srv.close(); reject(e); });
        r.end(data);
      });
    });

    const first = await call(request.method, request.path, request.body, { 'Idempotency-Key': out.draft_id });
    expect(first.status).toBe(201);
    const id = first.body.report.id;
    const [row] = await q('SELECT * FROM report_definitions WHERE id = ?', [id]);
    const def = out.definition;
    expect({ report_key: row.report_key, title: row.title, category: row.category, description: row.description,
      sql_text: row.sql_text, row_limit: row.row_limit, kind: row.kind, visibility: row.visibility, source: row.source,
      is_locked: row.is_locked, created_by: row.created_by })
      .toEqual({ report_key: def.report_key, title: def.title, category: def.category, description: def.description,
        sql_text: def.sql_text, row_limit: def.row_limit, kind: 'report', visibility: 'shared', source: 'ai',
        is_locked: 0, created_by: 2 });
    expect(canon(row.params)).toEqual(canon(def.params));
    expect(canon(row.columns_meta)).toEqual(canon(def.columns_meta));
    expect(canon(row.caveats)).toEqual(canon(def.caveats));
    expect(canon(row.viz)).toEqual({ type: 'table' });

    const replay = await call(request.method, request.path, request.body, { 'Idempotency-Key': out.draft_id });
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.report.id).toBe(id);
    expect((await q('SELECT COUNT(*) n FROM report_definitions WHERE report_key = ?', [def.report_key]))[0].n).toBe(1);

    const run = await call('POST', `/api/reports/${id}/run`, { params: {} });
    expect(run.status).toBe(200);
    expect(run.body.rowCount).toBe(out.preview.row_count);
    expect(run.body.rows.map((r) => r.ssn_last4)).toEqual(['6789', '6789', '4321']);
  });
});
