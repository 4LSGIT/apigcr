// Casey v2 S5a — routes/mcp.js logTool against the REAL readonly_query_log
// (MySQL 8.4 twin; its own *_test DB; gated on YC_TEST_MYSQL_URL, skipped
// otherwise):
//
//   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3379/yc_mcp_audit_test \
//     npx jest tests/mcpAudit.mysql.test.js
//
// Review r1 of S5a found the blocker this file exists for: the audit INSERT
// named columns the table does not have (key_id, key_label, ip_address), the
// failure was swallowed, and tests/mcpServer.test.js's SQL stub accepted the
// statement — a read of another user's chat left NO audit row. A mocked query
// cannot see a column list; this one builds the table from ref/database.sql's
// own CREATE and reads the row back column by column. Also: a refused INSERT
// THROWS (the tool fails closed on it), the UA is cut at the column's 512.
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;

function ddl() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8');
  const m = sql.match(/CREATE TABLE `readonly_query_log` \([\s\S]*?\) ENGINE[^\n]*/);
  if (!m) throw new Error('readonly_query_log CREATE not found in ref/database.sql');
  // the dump keeps keys in a later ALTER; the twin wants an id
  return m[0].replace('`id` bigint NOT NULL,', '`id` bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,');
}

suite('mcp logTool on the real readonly_query_log', () => {
  let conn;
  const { logTool } = require('../routes/mcp');
  const req = (over = {}) => ({ db: conn, auth: { keyId: 77, scopes: ['sql.ro', 'casey.review'] }, ip: '10.1.2.3', headers: { 'user-agent': 'claude-code/2.0' }, ...over });

  beforeAll(async () => {
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    await conn.query('DROP TABLE IF EXISTS readonly_query_log');
    await conn.query(ddl());
  });
  afterAll(async () => { if (conn) await conn.end(); });
  beforeEach(async () => { await conn.query('DELETE FROM readonly_query_log'); });

  test('a success row: every column as logTool binds it, read back', async () => {
    await logTool(req(), { tool: 'casey_review_chat', params: { chat_id: 23, user_id: 7, from_seq: 1, to_seq: null, limit: 40 }, rowCount: 5, durationMs: 12 });
    const [rows] = await conn.query('SELECT * FROM readonly_query_log');
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({ api_key_id: 77, ip: '10.1.2.3', user_agent: 'claude-code/2.0', sql_text: 'mcp casey_review_chat', row_count: 5, duration_ms: 12, status: 'success', sensitive_key: 0, error_text: null });
    expect(r.params_json).toEqual({ chat_id: 23, user_id: 7, from_seq: 1, to_seq: null, limit: 40 });
    expect(r.created_at).toBeInstanceOf(Date);
  });

  test('a not_found row; sensitive_key 1 for a key holding sql.ro.sensitive; no UA → "unknown"; a UA cut at 512; the error text kept', async () => {
    await logTool(req({ auth: { keyId: 78, scopes: ['sql.ro', 'sql.ro.sensitive', 'casey.review'] }, headers: {} }), { tool: 'casey_review_chat', params: { chat_id: 999 }, status: 'not_found', durationMs: 1 });
    await logTool(req({ headers: { 'user-agent': 'u'.repeat(600) }, auth: { keyId: 79, scopes: null } }), { tool: 'casey_review_list', params: {}, status: 'error', error: new Error('boom') });
    const [rows] = await conn.query('SELECT * FROM readonly_query_log ORDER BY id');
    expect(rows.map((r) => [r.api_key_id, r.status, r.sensitive_key, r.user_agent.length, r.row_count, r.error_text])).toEqual([
      [78, 'not_found', 1, 'unknown'.length, null, null],
      [79, 'error', 0, 512, null, 'Error: boom'],
    ]);
    expect(rows[0].params_json).toEqual({ chat_id: 999 });
  });

  test('a refused INSERT throws — the caller fails closed (the review tools answer nothing without their row)', async () => {
    await conn.query('ALTER TABLE readonly_query_log RENAME COLUMN params_json TO params_json_gone');
    try {
      await expect(logTool(req(), { tool: 'casey_review_list', params: {} })).rejects.toThrow(/Unknown column 'params_json'/);
      const [rows] = await conn.query('SELECT COUNT(*) AS n FROM readonly_query_log');
      expect(rows[0].n).toBe(0);
    } finally {
      await conn.query('ALTER TABLE readonly_query_log RENAME COLUMN params_json_gone TO params_json');
    }
  });
});
