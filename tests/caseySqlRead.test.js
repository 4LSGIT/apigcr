// Casey v2 S1 — lib/caseySqlRules (the three generic rules, pure) and the
// sql_read tool over a MOCKED report pool: what reaches the pool, what never
// does, the logMeta the run is recorded under, cell trimming. The real-engine
// twin (tests/caseySqlRead.mysql.test.js) proves the same path on MySQL 8.4
// with real report_runs rows.
'use strict';

const mockConn = { query: jest.fn(), release: jest.fn() };
jest.mock('../startup/dbReport', () => ({ getConnection: jest.fn(async () => mockConn) }));

const rules = require('../lib/caseySqlRules');
const tools = require('../services/casey/tools');

const dbLog = { query: jest.fn(async () => [{ affectedRows: 1 }, []]) };
const ctx = (auth = { type: 'jwt', userId: 6, username: 'IT', roles: ['su'] }) => ({ db: dbLog, auth, app: null, headers: {}, port: 0, via: 'test' });
const run = (input, c) => tools.runTool('sql_read', c || ctx(), input);

beforeEach(() => {
  mockConn.query.mockReset();
  dbLog.query.mockClear();
  // SET SESSION → ok; EXPLAIN → a tiny plan; the statement → rows + fields.
  mockConn.query.mockImplementation(async (sql) => {
    if (/^SET SESSION/i.test(sql)) return [[], []];
    if (/^EXPLAIN/i.test(sql)) return [[{ id: 1, rows: 10 }], []];
    return [[{ contact_id: 1, contact_name: 'A', big: 'x'.repeat(3500) }, { contact_id: 2, contact_name: 'B', big: 'y' }],
      [{ name: 'contact_id', columnType: 3 }, { name: 'contact_name', columnType: 253 }, { name: 'big', columnType: 253 }]];
  });
});

describe('lib/caseySqlRules', () => {
  test('constants are v1\'s, with the LIMIT ceiling at 250', () => {
    expect([rules.MAX_SQL, rules.MAX_ROWS, rules.DEFAULT_ROWS]).toEqual([6000, 250, 50]);
    expect(rules.DENIED_NAMES).toEqual(['contact_ssn', 'contact_dob', 'password', 'password_hash', 'reset_token',
      'contact_token', 'appt_manage_token', 'task_action_token', 'track_token', 'draft_key', 'attachments']);   // delivery_info un-denied in S3a (checkpoint F1)
    // email_log.body (S3a review): the account's grants cover it, so the rule refuses it — table-qualified.
    expect(rules.checkSql("SELECT body FROM email_log WHERE processed_at >= '2026-11-01' LIMIT 5", ['email_log'])).toEqual({ ok: false, error: 'asks for a field Casey may not read: email_log.body (mail text)' });
    expect(rules.checkSql("SELECT e.subject, e.delivery_info FROM email_log e WHERE e.processed_at >= '2026-11-01' AND e.subject LIKE '%body%' LIMIT 5", ['email_log']).ok).toBe(true);   // the word inside a literal
    expect(rules.checkSql("SELECT subject FROM email_log WHERE processed_at >= '2026-11-01' /* body */ LIMIT 5", ['email_log']).ok).toBe(true);   // or a comment
    expect(rules.checkSql('SELECT body FROM templates LIMIT 5', ['templates']).ok).toBe(true);   // another table's body is not mail
    expect(rules.mailBody('select body from email_log', ['email_log'])).toBe(true);
    expect(rules.mailBody('select bodyguard from email_log', ['email_log'])).toBe(false);
  });
  test('trailingLimit reads only a TRAILING LIMIT', () => {
    expect(rules.trailingLimit('SELECT 1 LIMIT 5')).toBe(5);
    expect(rules.trailingLimit('SELECT 1 LIMIT 5;')).toBe(5);
    expect(rules.trailingLimit('SELECT 1 limit 05 ; ')).toBe(5);
    expect(rules.trailingLimit('SELECT * FROM (SELECT 1 LIMIT 5) t')).toBeNull();
    expect(rules.trailingLimit('SELECT 1 LIMIT 5, 10')).toBeNull();
    expect(rules.trailingLimit('SELECT 1')).toBeNull();
    // a LIMIT inside a comment is no LIMIT (MySQL never sees it); a comment after a real LIMIT is fine
    expect(rules.trailingLimit('SELECT 1 FROM t -- LIMIT 5')).toBeNull();
    expect(rules.trailingLimit('SELECT 1 FROM t # LIMIT 5')).toBeNull();
    expect(rules.trailingLimit('SELECT 1 FROM t /* LIMIT 5 */')).toBeNull();
    expect(rules.trailingLimit('SELECT 1 FROM t LIMIT 5 -- five')).toBe(5);
    expect(rules.trailingLimit('SELECT 1 FROM t /* nine */ LIMIT 7')).toBe(7);
    expect(rules.trailingLimit("SELECT '-- x' FROM t LIMIT 3")).toBe(3);
  });
  test('blankComments blanks line and block comments to spaces, after literals, keeping backticked names', () => {
    expect(rules.blankComments("a 'x -- y' -- c\nb")).toBe("a '      '     \nb");
    expect(rules.blankComments('a /* b */ `c#d` # e')).toBe('a         `c#d`    ');
    expect(rules.blankComments('x --y')).toBe('x --y'); // `--` needs a space after it to comment
  });
  test('deniedName: whole words outside string literals, any case, backticked or operator-adjacent', () => {
    expect(rules.deniedName('SELECT contact_ssn FROM contacts')).toBe('contact_ssn');
    expect(rules.deniedName('SELECT `Contact_SSN` FROM contacts')).toBe('contact_ssn');
    expect(rules.deniedName('SELECT 1 FROM users WHERE 1--password\n=1')).toBe('password');
    expect(rules.deniedName("SELECT contact_name FROM contacts WHERE contact_notes LIKE '%password%'")).toBeNull();
    expect(rules.deniedName('SELECT contact_name FROM contacts WHERE contact_notes LIKE "contact_ssn"')).toBeNull();
    expect(rules.deniedName("SELECT 1 WHERE x = 'unterminated contact_ssn")).toBe('contact_ssn'); // fail closed
    expect(rules.deniedName('SELECT password_reset_count FROM t')).toBeNull(); // not a whole word
    expect(rules.deniedName('SELECT contact_dob_year FROM t')).toBeNull();
    expect(rules.deniedName('SELECT attachments FROM email_log')).toBe('attachments');
  });
  test('blankStringLiterals keeps everything but literal contents', () => {
    expect(rules.blankStringLiterals("a 'bc' `d'e` -- f'g\n/* h'i */ \"jk\"")).toBe("a '  ' `d'e` -- f'g\n/* h'i */ \"  \"");
    expect(rules.blankStringLiterals("x 'a''b' y")).toBe("x '    ' y");
    expect(rules.blankStringLiterals("x 'a\\'b' y")).toBe("x '    ' y");
    expect(rules.blankStringLiterals("x 'open")).toBe("x 'open");
  });
  test('checkSql: empty, long, denied, LIMIT bounds, log / email_log date bounds', () => {
    expect(rules.checkSql('')).toEqual({ ok: false, error: 'SQL is empty' });
    expect(rules.checkSql('SELECT 1 LIMIT 1 ' + '-- ' + 'x'.repeat(6000))).toMatchObject({ ok: false, error: expect.stringMatching(/longer than 6000/) });
    expect(rules.checkSql('SELECT contact_dob FROM contacts LIMIT 1', ['contacts'])).toEqual({ ok: false, error: 'asks for a field Casey may not read: contact_dob' });
    expect(rules.checkSql('SELECT 1 FROM contacts', ['contacts'])).toEqual({ ok: false, error: 'must end with LIMIT 1-250' });
    expect(rules.checkSql('SELECT 1 FROM contacts LIMIT 0', ['contacts']).ok).toBe(false);
    expect(rules.checkSql('SELECT 1 FROM contacts LIMIT 251', ['contacts']).ok).toBe(false);
    expect(rules.checkSql('SELECT 1 FROM contacts LIMIT 250', ['contacts'])).toEqual({ ok: true, limit: 250 });
    expect(rules.checkSql('SELECT log_id FROM log LIMIT 5', ['log'])).toEqual({ ok: false, error: 'must put a concrete lower date bound on log.log_date' });
    expect(rules.checkSql("SELECT log_id FROM log WHERE log_date >= '2026-01-01' LIMIT 5", ['log'])).toEqual({ ok: true, limit: 5 });
    expect(rules.checkSql("SELECT log_id FROM log WHERE log_date BETWEEN '2026-01-01' AND '2026-02-01' LIMIT 5", ['log']).ok).toBe(true);
    expect(rules.checkSql('SELECT log_id FROM log WHERE log_date < NOW() LIMIT 5', ['log']).ok).toBe(true);
    expect(rules.checkSql('SELECT log_id FROM log WHERE log_date <= NOW() LIMIT 5', ['log']).ok).toBe(false);
    expect(rules.checkSql('SELECT id FROM email_log LIMIT 5', ['email_log'])).toEqual({ ok: false, error: 'must put a concrete lower date bound on email_log.processed_at' });
    expect(rules.checkSql("SELECT id FROM email_log WHERE processed_at > '2026-01-01' LIMIT 5", ['email_log']).ok).toBe(true);
    // the bound rule is keyed on the validator's table list, not on the text
    expect(rules.checkSql('SELECT 1 FROM contacts WHERE contact_notes LIKE "%log%" LIMIT 1', ['contacts']).ok).toBe(true);
    // a bound or a LIMIT inside a comment counts for nothing
    expect(rules.checkSql("SELECT log_id FROM log WHERE 1 /* log_date >= '2026-01-01' */ LIMIT 5", ['log']).ok).toBe(false);
    expect(rules.checkSql('SELECT log_id FROM log WHERE log_date >= \'2026-01-01\' -- LIMIT 5', ['log'])).toEqual({ ok: false, error: 'must end with LIMIT 1-250' });
    expect(rules.checkSql('SELECT id FROM email_log WHERE 1 # processed_at > 1\n LIMIT 5', ['email_log']).ok).toBe(false);
  });
});

describe('sql_read (mocked report pool)', () => {
  test('an allowed SELECT runs on the report pool with the LIMIT as rowLimit, logs a casey_v2 run with the SQL and purpose (as v1 does), trims long cells', async () => {
    const r = await run({ sql: 'SELECT contact_id, contact_name FROM contacts LIMIT 2', purpose: 'who is A' });
    expect(r.ok).toBe(true);
    expect(r.untrusted).toBe(true);
    expect(r.data).toMatchObject({ columns: ['contact_id', 'contact_name', 'big'], row_count: 2, truncated: false, tables: ['contacts'] });
    expect(r.data.rows[0].big).toMatch(/^x{3000}…\[\+500 chars\]$/);
    expect(r.data.rows[1].big).toBe('y');
    const sqls = mockConn.query.mock.calls.map(c => c[0]);
    expect(sqls[0]).toMatch(/^SET SESSION MAX_EXECUTION_TIME/);
    expect(sqls[1]).toBe('EXPLAIN SELECT contact_id, contact_name FROM contacts LIMIT 2');
    expect(sqls[2]).toBe('SELECT contact_id, contact_name FROM contacts LIMIT 2');
    expect(mockConn.release).toHaveBeenCalled();
    // report_runs row on the MAIN pool: key casey_v2, run_by 6, the SQL text, purpose in params_json — v1's sql.read logging
    expect(dbLog.query).toHaveBeenCalledTimes(1);
    const [sql, params] = dbLog.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO report_runs/);
    expect(params.slice(0, 5)).toEqual([null, 'casey_v2', 6, JSON.stringify({ purpose: 'who is A' }), 'SELECT contact_id, contact_name FROM contacts LIMIT 2']);
    expect(params[7]).toBe('success');
  });

  test('a trailing semicolon is tolerated; the LIMIT also caps execute\'s rowLimit (truncated when the DB returned more)', async () => {
    mockConn.query.mockImplementation(async (sql) => /^SET|^EXPLAIN/i.test(sql) ? [[{ rows: 1 }], []]
      : [[{ a: 1 }, { a: 2 }, { a: 3 }], [{ name: 'a', columnType: 3 }]]);
    const r = await run({ sql: 'SELECT contact_id a FROM contacts LIMIT 2;' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ row_count: 3, truncated: true });
    expect(r.data.rows).toHaveLength(2);
  });

  test('refused by the rules: nothing reaches the pool and no report_runs row is written', async () => {
    for (const sql of ['SELECT contact_id FROM contacts', 'SELECT contact_ssn FROM contacts LIMIT 1', 'SELECT log_id FROM log LIMIT 3', 'SELECT contact_id FROM contacts LIMIT 251']) {
      const r = await run({ sql });
      expect([sql, r.ok, r.error && r.error.code]).toEqual([sql, false, 'SQL_REFUSED']);
      expect(r.error.message).toMatch(/^Query /);
    }
    expect(mockConn.query).not.toHaveBeenCalled();
    expect(dbLog.query).not.toHaveBeenCalled();
  });

  test('refused by the report validator (non-manifest table, a write, a CTE): same — no pool, no row', async () => {
    for (const sql of ['SELECT `key` FROM app_settings LIMIT 1', 'DELETE FROM contacts LIMIT 1', 'WITH x AS (SELECT 1) SELECT * FROM x LIMIT 1', 'SELECT password_hash FROM users LIMIT 1']) {
      const r = await run({ sql });
      expect([sql, r.ok, r.error && r.error.code]).toEqual([sql, false, 'SQL_REFUSED']);
    }
    expect(mockConn.query).not.toHaveBeenCalled();
    expect(dbLog.query).not.toHaveBeenCalled();
  });

  test('a DB error becomes SQL_FAILED with the engine message; the run is logged as error', async () => {
    mockConn.query.mockImplementation(async (sql) => { if (/^SET/i.test(sql)) return [[], []]; throw Object.assign(new Error("Unknown column 'nope' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' }); });
    const r = await run({ sql: 'SELECT nope FROM contacts LIMIT 1' });
    expect(r).toMatchObject({ ok: false, error: { code: 'SQL_FAILED', message: "Unknown column 'nope' in 'field list'" } });
    expect(dbLog.query.mock.calls[0][1][7]).toBe('error');
  });

  test('schema: sql required, purpose ≤ 200, no other keys; a machine key runs with run_by null', async () => {
    expect(await run({})).toMatchObject({ ok: false, error: { code: 'BAD_INPUT', message: 'missing required input: sql' } });
    expect(await run({ sql: 'SELECT 1 LIMIT 1', purpose: 'p'.repeat(201) })).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
    expect(await run({ sql: 'SELECT 1 LIMIT 1', values: [] })).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
    const k = await run({ sql: 'SELECT contact_id FROM contacts LIMIT 1' }, ctx({ type: 'api_key', key_label: 'k', scopes: null }));
    expect(k.ok).toBe(true);
    expect(dbLog.query.mock.calls[0][1][2]).toBeNull();
  });
});
