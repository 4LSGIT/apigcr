'use strict';
/**
 * tests/caseyReportDraft.test.js
 *
 * A16 — Casey drafts a report (ruling 16, Fred 2026-10-27: Casey writes the
 * SQL; the Reports engine's validator + the yc_report pool are the authority,
 * as for sql.read). Pinned here without a database:
 *   1. the SSN classifier (Fred's ruling 2): contact_ssn only inside the
 *      canonical last-4 expression — anywhere else, or inside a string, reads
 *      as FULL, and full is refused unless the user's OWN question names SSNs;
 *   2. every refusal the normalizer makes BEFORE it touches the engine (the
 *      family switch, closed keys, widths, the create route's own validators,
 *      the full-SSN gate) — the db stub throws if anything reaches it;
 *   3. POST /api/reports honours an Idempotency-Key (scope reports.create): a
 *      retry replays the first report instead of creating a second one, a
 *      refused create releases the key, and no key means no extra query;
 *   4. the settings pair;
 *   5. the chart hint (viz, 2026-10-27 review): the Reports engine's own enum,
 *      validated strictly against the previewed columns — accepted shapes are
 *      exactly what the route's sanitizer stores AND what Reports' chart code
 *      draws (no silent fallback); everything else refuses with the allowed
 *      values; the browser builder sends the server's viz, kind / visibility
 *      / source stay pinned.
 * The engine half — preview on real MySQL, the stored-preview masking, and the
 * normalizer → browser builder → route → stored-row round trip — is
 * tests/caseyReportDraft.mysql.test.js.
 */

// This file never reaches an engine: the report pool is replaced by one that
// throws, so a refusal that ran too late fails loudly instead of dialling the
// real database (.env points the pool at it).
jest.mock('../startup/dbReport', () => ({
  getConnection: async () => { throw new Error('report pool touched in a no-engine test'); },
}));

const path = require('path');
const svc = require(path.join(__dirname, '..', 'services', 'assistantService'));
const { normalizeActionDraft, reportSsnUse, reportDraftViz } = svc;

const untouchedDb = () => ({ query: jest.fn(async (sql) => { throw new Error(`db touched: ${sql}`); }),
  getConnection: jest.fn(async () => { throw new Error('db touched'); }) });

const draft = (over = {}) => ({
  kind: 'report.draft.v1',
  title: 'Detroit contacts',
  category: 'Contacts',
  description: 'Contacts whose city is Detroit.',
  sql: "SELECT ct.contact_id, ct.contact_name AS client_name FROM contacts ct WHERE ct.contact_city = 'Detroit' ORDER BY ct.contact_name",
  params: [],
  columns_meta: [],
  caveats: [],
  row_limit: 1000,
  evidence: [],
  ...over,
});

afterEach(() => { delete process.env.CASEY_REPORT_AUTHORING_ENABLED; });

describe('the SSN classifier (ruling 2)', () => {
  const LAST4 = "RIGHT(REGEXP_REPLACE(ct.contact_ssn,'[^0-9]',''),4)";
  test.each([
    ['SELECT ct.contact_id FROM contacts ct', 'none'],
    [`SELECT ${LAST4} AS ssn_last4 FROM contacts ct`, 'last4'],
    [`SELECT ${LAST4} AS a FROM contacts ct WHERE ${LAST4} <> ''`, 'last4'],
    ["SELECT RIGHT( REGEXP_REPLACE( `contact_ssn` , '[^0-9]' , '' ) , 4 ) AS a FROM contacts", 'last4'],
    ["select right(regexp_replace(contact_ssn,'[^0-9]',''),4) as a from contacts", 'last4'],
    ['SELECT ct.contact_ssn FROM contacts ct', 'full'],
    ['SELECT `contact_ssn` FROM contacts', 'full'],
    [`SELECT ${LAST4} AS a FROM contacts ct WHERE ct.contact_ssn <> ''`, 'full'],
    // A derived table hands the raw column out under another name.
    [`SELECT ${LAST4.replace('ct.contact_ssn', 't.contact_ssn')} FROM (SELECT contact_ssn FROM contacts) t`, 'full'],
    // A near-miss of the canonical form is not the canonical form.
    ["SELECT RIGHT(REGEXP_REPLACE(contact_ssn,'[^0-8]',''),4) FROM contacts", 'full'],
    ["SELECT RIGHT(REGEXP_REPLACE(contact_ssn,'[^0-9]',''),9) FROM contacts", 'full'],
    ["SELECT LEFT(REGEXP_REPLACE(contact_ssn,'[^0-9]',''),4) FROM contacts", 'full'],
    ["SELECT RIGHT(REGEXP_REPLACE(contact_ssn,'[^0-9]','x'),4) FROM contacts", 'full'],
    // An unterminated literal defeats the blanker: fail closed.
    ["SELECT RIGHT(REGEXP_REPLACE(contact_ssn,'[^0-9]',''),4), 'oops FROM contacts", 'full'],
    // The word inside a string literal is not a column read.
    ["SELECT ct.contact_id FROM contacts ct WHERE ct.contact_notes LIKE '%contact_ssn%'", 'none'],
  ])('%s → %s', (sql, want) => {
    expect(reportSsnUse(sql)).toBe(want);
  });

  test('a full-SSN draft is refused unless the user\'s own question names SSNs — before any engine call', async () => {
    const sql = 'SELECT ct.contact_id, ct.contact_ssn FROM contacts ct ORDER BY ct.contact_id';
    for (const question of ['Make a report of all contacts', 'Export the client list', '']) {
      await expect(normalizeActionDraft(untouchedDb(), draft({ sql }), [], { question }))
        .rejects.toThrow(/selects contact_ssn in full, but the user did not ask for SSNs/);
    }
    // The model cannot claim the ask: there is no ssn field to set.
    await expect(normalizeActionDraft(untouchedDb(), draft({ sql, ssn_full: true }), [], { question: 'x' }))
      .rejects.toThrow(/unsupported fields/);
  });
});

describe('the report normalizer refuses before touching the engine', () => {
  test.each([
    [{ extra: 1 }, /unsupported fields/],
    [{ title: '' }, /title is required/],
    [{ title: 'x'.repeat(151) }, /title exceeds 150/],
    [{ category: 'Views' }, /category must be one of/],
    [{ category: 'Billing' }, /category must be one of/],
    [{ sql: '' }, /sql is required/],
    [{ sql: 'x'.repeat(20001) }, /sql exceeds 20000/],
    [{ sql: 'DELETE FROM contacts' }, /SQL was refused: Report SQL must be read-only/],
    [{ sql: 'SELECT k.setting_value FROM app_settings k' }, /SQL was refused/],
    [{ sql: 'SELECT u.password_hash FROM users u' }, /SQL was refused/],
    [{ sql: 'SELECT ct.contact_id FROM contacts ct WHERE ct.contact_city = ?' }, /SQL was refused: Parameter count mismatch/],
    [{ params: [{ name: 'x', type: 'date' }] }, /SQL was refused: Parameter count mismatch/],
    [{ params: [{ name: '1bad', type: 'date' }] }, /params\[0\]\.name/],
    [{ params: [{ name: 'a', type: 'blob' }] }, /params\[0\]\.type/],
    [{ params: 'x' }, /params must be an array/],
    [{ row_limit: 0 }, /row_limit must be an integer 1-10000/],
    [{ row_limit: 10001 }, /row_limit must be an integer 1-10000/],
    [{ row_limit: 2.5 }, /row_limit must be an integer/],
    [{ caveats: ['x'.repeat(301)] }, /caveat exceeds 300/],
    [{ caveats: 'x' }, /caveats must be an array/],
    [{ columns_meta: 'x' }, /columns_meta must be an array/],
  ])('%j', async (over, msg) => {
    await expect(normalizeActionDraft(untouchedDb(), draft(over), [], { question: 'Make a report' })).rejects.toThrow(msg);
  });

  test('the family off switch makes the kind not exist', async () => {
    process.env.CASEY_REPORT_AUTHORING_ENABLED = '0';
    await expect(normalizeActionDraft(untouchedDb(), draft(), [], { question: 'Make a report' }))
      .rejects.toThrow(/Action kind is unavailable/);
  });
});

describe('POST /api/reports, idempotent (scope reports.create)', () => {
  const express = require('express');
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const { SQL } = require('../lib/requestIdempotency');
  const reportService = require('../services/reportService');

  const SECRET = 'casey-report-test-secret';
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });
  const token = () => jwt.sign({ sub: 2, username: 'plain', user_type: 1, aud: 'staff',
    user_auth: 'authorized', roles: ['staff'],
    ...(process.env.JWT_VERSION ? { ver: parseInt(process.env.JWT_VERSION, 10) } : {}),
  }, SECRET, { expiresIn: '5m' });

  function makeDb() {
    const idemRows = [];
    let nextId = 1;
    const calls = [];
    return {
      calls,
      idemRows,
      getConnection: async () => { throw new Error('no connections'); },
      async query(sql, params) {
        calls.push(sql);
        if (/INSERT INTO jwt_api_audit_log/.test(sql)) return [{ affectedRows: 1 }];
        if (sql === SQL.claim) {
          const [user_id, scope, idem_key] = params;
          if (idemRows.some((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key)) {
            const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err;
          }
          const row = { id: nextId++, user_id, scope, idem_key, status: 'in_flight', result: null };
          idemRows.push(row);
          return [{ insertId: row.id, affectedRows: 1 }];
        }
        if (sql === SQL.read) {
          const [user_id, scope, idem_key] = params;
          const row = idemRows.find((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key);
          return row ? [[{ id: row.id, status: row.status, result: row.result, age_s: 0 }]] : [[]];
        }
        if (sql === SQL.settle) {
          const [json, id] = params;
          const row = idemRows.find((r) => r.id === id && r.status === 'in_flight');
          if (!row) return [{ affectedRows: 0 }];
          row.status = 'applied'; row.result = JSON.parse(json);
          return [{ affectedRows: 1 }];
        }
        if (sql === SQL.release) {
          const i = idemRows.findIndex((r) => r.id === params[0] && r.status === 'in_flight');
          if (i >= 0) idemRows.splice(i, 1);
          return [{ affectedRows: i >= 0 ? 1 : 0 }];
        }
        throw new Error(`unexpected pool SQL: ${sql}`);
      },
    };
  }

  function send(db, headers, payload) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = db; next(); });
    a.use(require('../routes/api.reports.js'));
    const data = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const srv = a.listen(0, () => {
        const req = http.request({
          port: srv.address().port, path: '/api/reports', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
            authorization: `Bearer ${token()}`, ...headers },
        }, (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); });
        });
        req.on('error', (e) => { srv.close(); reject(e); });
        req.write(data); req.end();
      });
    });
  }

  let creates = 0;
  let spy;
  beforeEach(() => {
    creates = 0;
    spy = jest.spyOn(reportService, 'createReport').mockImplementation(async (_db, body) => {
      if (body.report_key === 'bad') { const e = new Error('report_key must be lowercase'); e.status = 400; throw e; }
      creates += 1;
      return { id: 40 + creates, report_key: body.report_key, title: body.title };
    });
  });
  afterEach(() => spy.mockRestore());

  test('one key, one report: the replay returns the first id and creates nothing twice', async () => {
    const db = makeDb();
    const first = await send(db, { 'idempotency-key': 'report-draft-1' }, { report_key: 'casey_x_1', title: 'X' });
    expect(first.status).toBe(201);
    expect(first.body.report).toMatchObject({ id: 41, report_key: 'casey_x_1' });
    expect(first.body.replayed).toBeUndefined();
    const second = await send(db, { 'idempotency-key': 'report-draft-1' }, { report_key: 'casey_x_1', title: 'X' });
    expect(second.status).toBe(201);
    expect(second.body.report).toMatchObject({ id: 41 });
    expect(second.body.replayed).toBe(true);
    expect(creates).toBe(1);
    expect(db.idemRows).toHaveLength(1);
    expect(db.idemRows[0]).toMatchObject({ scope: 'reports.create', user_id: 2, status: 'applied' });
  });

  test('a refused create releases the key, so the same key may be retried', async () => {
    const db = makeDb();
    const refused = await send(db, { 'idempotency-key': 'report-draft-2' }, { report_key: 'bad' });
    expect(refused.status).toBe(400);
    expect(db.idemRows).toHaveLength(0);
    const retried = await send(db, { 'idempotency-key': 'report-draft-2' }, { report_key: 'casey_ok_2', title: 'Y' });
    expect(retried.status).toBe(201);
    expect(creates).toBe(1);
  });

  test('no key: the native editor path is unchanged — no idempotency query at all', async () => {
    const db = makeDb();
    const res = await send(db, {}, { report_key: 'casey_n_3', title: 'Z' });
    expect(res.status).toBe(201);
    expect(db.calls.filter((s) => /request_idempotency/.test(s))).toHaveLength(0);
    const again = await send(db, {}, { report_key: 'casey_n_3', title: 'Z' });
    expect(again.status).toBe(201);
    expect(creates).toBe(2);
  });

  test('a malformed key is refused before anything is written', async () => {
    const db = makeDb();
    const res = await send(db, { 'idempotency-key': 'no spaces allowed' }, { report_key: 'casey_m_4', title: 'M' });
    expect(res.status).toBe(400);
    expect(res.body.idempotency).toEqual({ outcome: 'invalid_key' });
    expect(creates).toBe(0);
  });
});

describe('the settings pair', () => {
  test('the flag is registered in BOTH places', () => {
    const { cfg } = require(path.join(__dirname, '..', 'lib', 'firmConfig'));
    expect(() => cfg('casey_report_authoring_enabled')).not.toThrow();
    const { SETTINGS } = require(path.join(__dirname, '..', 'lib', 'settingsRegistry'));
    expect(SETTINGS.casey_report_authoring_enabled).toMatchObject({ kind: 'system', type: 'bool' });
  });
});

describe('the chart hint (viz) — the Reports engine\'s own enum, strict', () => {
  const RC = require('../public/js/reportCharts.js');
  const { sanitizeViz } = require('../lib/reportSchema/validator');
  // mysql2 field type codes: 253 VAR_STRING, 8 LONGLONG (COUNT), 246 NEWDECIMAL (SUM), 10 DATE.
  const FIELDS = [{ name: 'stage', type: 253 }, { name: 'month', type: 10 }, { name: 'n', type: 8 }, { name: 'total', type: 246 }];
  const ROWS = [{ stage: 'filed', month: '2026-09-01', n: 3, total: '10.50' }, { stage: 'open', month: '2026-10-01', n: 5, total: '2.00' }];
  const profile = RC.profileColumns(ROWS, FIELDS);

  test('the enum is Reports\' own: the server sanitizer and the chart code accept exactly these types', () => {
    expect(svc.REPORT_VIZ_TYPES).toEqual(['bar', 'line', 'area', 'pie', 'doughnut', 'combo', 'stat', 'table']);
    expect([...RC.CHART_TYPES].sort()).toEqual([...svc.REPORT_VIZ_TYPES].sort());
    for (const type of svc.REPORT_VIZ_TYPES) expect(sanitizeViz({ type, y: 'n' }).viz).toMatchObject({ type });
    expect(sanitizeViz({ type: 'scatter', y: 'n' }).viz).toBeNull();
  });

  test('"number column" means what Reports\' chart code means: the same field type codes, every one of 0-255', () => {
    const drawnAsNumber = [];
    for (let code = 0; code < 256; code++) {
      if (RC.profileColumns([{ c: 1 }], [{ name: 'c', type: code }])[0].kind === 'number') drawnAsNumber.push(code);
    }
    expect([...svc.REPORT_VIZ_NUMERIC_TYPES].sort((a, b) => a - b)).toEqual(drawnAsNumber);
  });

  test.each([
    [undefined, { type: 'table' }],
    [null, { type: 'table' }],
    [{ type: 'table' }, { type: 'table' }],
    [{ type: 'bar', x: 'stage', y: 'n' }, { type: 'bar', x: 'stage', y: 'n' }],
    [{ type: 'line', x: 'month', y: 'total', yLabel: 'Fees' }, { type: 'line', x: 'month', y: 'total', yLabel: 'Fees' }],
    [{ type: 'area', x: 'month', series: [{ key: 'n' }, { key: 'total', label: 'Total' }], stacked: true },
      { type: 'area', x: 'month', series: [{ key: 'n' }, { key: 'total', label: 'Total' }], stacked: true }],
    [{ type: 'pie', x: 'stage', y: 'n', limit: 12 }, { type: 'pie', x: 'stage', y: 'n', limit: 12 }],
    [{ type: 'doughnut', x: 'stage', series: [{ key: 'n', format: 'number' }] }, { type: 'doughnut', x: 'stage', series: [{ key: 'n', format: 'number' }] }],
    [{ type: 'combo', x: 'month', series: [{ key: 'n', type: 'bar' }, { key: 'total', type: 'line', axis: 'y1', format: 'currency' }], y1Label: '$' },
      { type: 'combo', x: 'month', series: [{ key: 'n', type: 'bar' }, { key: 'total', type: 'line', axis: 'y1', format: 'currency' }], y1Label: '$' }],
    [{ type: 'stat' }, { type: 'stat' }],
    [{ type: 'stat', series: [{ key: 'n', label: 'Cases' }] }, { type: 'stat', series: [{ key: 'n', label: 'Cases' }] }],
    [{ type: 'bar', x: 'stage', y: 'n', horizontal: true, stacked: false }, { type: 'bar', x: 'stage', y: 'n', horizontal: true }],
  ])('accepted: %j → stored as %j, which Reports draws as that very chart', (raw, stored) => {
    const out = reportDraftViz(raw, FIELDS);
    expect(out).toEqual(stored);
    expect(sanitizeViz(out)).toEqual({ viz: stored, warning: null });            // what POST /api/reports keeps
    const drawn = RC.normalizeViz(out, ROWS, profile);                            // no silent fallback to inferViz
    expect(drawn && drawn.type).toBe(stored.type);
    if (stored.x) expect(drawn.x).toBe(stored.x);
    if (stored.y) expect(drawn.series.map((x) => x.key)).toEqual([stored.y]);
    if (stored.series) expect(drawn.series.map((x) => x.key)).toEqual(stored.series.map((x) => x.key));
  });

  test.each([
    ['x', /viz must be an object, e.g\. \{"type":"bar"/],
    [[{ type: 'bar' }], /viz must be an object/],
    [{ type: 'scatter', x: 'stage', y: 'n' }, /viz type must be one of bar, line, area, pie, doughnut, combo, stat, table/],
    [{ type: 'Bar', x: 'stage', y: 'n' }, /viz type must be one of/],
    [{ x: 'stage', y: 'n' }, /viz type must be one of/],
    [{ type: 'bar', x: 'stage', y: 'n', color: 'red' }, /viz carries unsupported fields: color — it takes type, x, y, series, stacked, horizontal, xLabel, yLabel, y1Label, limit/],
    [{ type: 'table', x: 'stage' }, /viz of type table takes no other fields/],
    [{ type: 'bar', y: 'n' }, /viz of type bar needs x \(the label \/ category column\) — the report's columns are stage, month, n, total/],
    [{ type: 'bar', x: 'stage' }, /viz of type bar needs y or series .* number columns: n, total/],
    [{ type: 'bar', x: 'nope', y: 'n' }, /viz x must name a returned column — the report's columns are stage, month, n, total/],
    [{ type: 'bar', x: 'stage', y: 'stage' }, /viz y "stage" is not a number column, so Reports cannot plot it — number columns: n, total/],
    [{ type: 'line', x: 'month', series: [{ key: 'month' }] }, /viz series\[0\]\.key "month" is not a number column/],
    [{ type: 'line', x: 'month', series: [{ key: 'ghost' }] }, /viz series\[0\]\.key must name a returned column/],
    [{ type: 'line', x: 'month', series: [] }, /viz series must be an array of 1-12/],
    [{ type: 'line', x: 'month', series: [{ key: 'n', colour: 'x' }] }, /viz series\[0\] carries unsupported fields: colour/],
    [{ type: 'combo', x: 'month', series: [{ key: 'n', type: 'pie' }] }, /viz series\[0\]\.type must be one of bar, line, area/],
    [{ type: 'combo', x: 'month', series: [{ key: 'n', axis: 'y2' }] }, /viz series\[0\]\.axis may only be "y1"/],
    [{ type: 'line', x: 'month', series: [{ key: 'n', format: 'money' }] }, /viz series\[0\]\.format must be one of number, percent, currency, days, text, date/],
    [{ type: 'pie', x: 'stage', series: [{ key: 'n' }, { key: 'total' }] }, /viz of type pie plots exactly one number column/],
    [{ type: 'bar', x: 'stage', y: 'n', stacked: 'yes' }, /viz stacked must be true or false/],
    [{ type: 'bar', x: 'stage', y: 'n', limit: '12' }, /viz limit must be an integer 1-1000/],
    [{ type: 'bar', x: 'stage', y: 'n', yLabel: 5 }, /viz yLabel must be text up to 80/],
  ])('refused with the allowed values: %j', (raw, msg) => {
    let err = null;
    try { reportDraftViz(raw, FIELDS); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 422 });
    expect(err.message).toMatch(msg);
  });

  test('stat with no number column in the result is refused (Reports would fall back silently)', () => {
    expect(() => reportDraftViz({ type: 'stat' }, [{ name: 'stage', type: 253 }])).toThrow(/stat needs at least one number column/);
  });

  test('viz is a draft key the normalizer accepts; it refuses before the engine like the other fields', async () => {
    await expect(normalizeActionDraft(untouchedDb(), draft({ vizz: { type: 'bar' } }), [], { question: 'Make a report' }))
      .rejects.toThrow(/unsupported fields/);
    // A valid key reaches the engine (here: the throwing pool) — viz is checked against the PREVIEWED columns.
    await expect(normalizeActionDraft(untouchedDb(), draft({ viz: { type: 'bar', x: 'client_name', y: 'contact_id' } }), [], { question: 'Make a report' }))
      .rejects.toThrow(/report pool touched|preview failed/);
  });

  describe('the browser: card line + fixed builder', () => {
    const fs = require('fs');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
    const fnSrc = (name) => {
      const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
      let parens = 0; let i = m.index + m[0].length - 1;
      for (; i < html.length; i++) { if (html[i] === '(') parens++; else if (html[i] === ')' && --parens === 0) break; }
      let depth = 0;
      for (let j = html.indexOf('{', i); j < html.length; j++) {
        if (html[j] === '{') depth++; else if (html[j] === '}' && --depth === 0) return html.slice(m.index, j + 1);
      }
      throw new Error(name);
    };
    // eslint-disable-next-line no-new-func
    const { reportDraftRequest, reportVizText, reportCardText } = new Function(
      `${fnSrc('reportVizText')}\n${fnSrc('reportSsnText')}\n${fnSrc('reportCardText')}\n${fnSrc('reportDraftRequest')}\nreturn { reportDraftRequest, reportVizText, reportCardText };`)();
    const def = (viz) => ({ definition: { report_key: 'casey_x_abc123', title: 'T', category: 'Cases', description: '', sql_text: 'SELECT 1 AS n',
      params: [], columns_meta: [], caveats: [], row_limit: 1000, ...(viz === undefined ? {} : { viz }) }, preview: { columns: [], row_count: 0 }, tables: [] });

    test('the builder sends the server\'s viz; kind, visibility and source stay pinned; no viz = table', () => {
      const viz = { type: 'combo', x: 'month', series: [{ key: 'n', type: 'bar' }, { key: 'total', type: 'line', axis: 'y1' }] };
      expect(reportDraftRequest(def(viz)).body).toMatchObject({ viz, kind: 'report', visibility: 'shared', source: 'ai' });
      expect(reportDraftRequest(def(undefined)).body.viz).toEqual({ type: 'table' });
      expect(reportDraftRequest(def(null)).body.viz).toEqual({ type: 'table' });
      // A tampered card carrying model-ish extras still cannot move the pinned fields.
      const tampered = def({ type: 'bar', x: 'a', y: 'n' });
      tampered.definition.kind = 'view'; tampered.definition.visibility = 'private'; tampered.definition.source = 'manual';
      expect(reportDraftRequest(tampered).body).toMatchObject({ kind: 'report', visibility: 'shared', source: 'ai' });
      expect(() => reportDraftRequest(def({ type: 'scatter' }))).toThrow(/no usable display setting/);
      expect(() => reportDraftRequest(def('bar'))).toThrow(/no usable display setting/);
    });

    test('the card names the display in the Reports editor\'s words', () => {
      expect(reportVizText({ type: 'table' })).toBe('Table (no chart)');
      expect(reportVizText(undefined)).toBe('Table (no chart)');
      expect(reportVizText({ type: 'bar', x: 'stage', y: 'n' })).toBe('Bar chart by stage of n — switchable in Reports; the table and CSV are unchanged');
      expect(reportVizText({ type: 'doughnut', x: 'stage', y: 'n', limit: 12 })).toMatch(/^Donut chart by stage of n top 12 —/);
      expect(reportVizText({ type: 'combo', x: 'month', series: [{ key: 'n', type: 'bar' }, { key: 'total', label: 'Total', type: 'line', axis: 'y1' }], stacked: true }))
        .toMatch(/^Combo chart by month of n as bar, Total as line \(right axis\) stacked —/);
      expect(reportVizText({ type: 'stat' })).toMatch(/^Figures of every number column —/);
      expect(reportCardText(def({ type: 'line', x: 'month', y: 'n' })).split('\n')).toContain('Display: Line chart by month of n — switchable in Reports; the table and CSV are unchanged');
      expect(reportCardText(def(undefined)).split('\n')).toContain('Display: Table (no chart)');
    });
  });
});
