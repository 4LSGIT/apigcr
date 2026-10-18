'use strict';

const mockConn = { query: jest.fn(), release: jest.fn() };
jest.mock('../startup/dbReadonly', () => ({ getConnection: jest.fn(async () => mockConn) }));

const reportService = require('../services/reportService');

describe('report runner SQL audit logging', () => {
  beforeEach(() => {
    mockConn.query.mockReset();
    mockConn.release.mockReset();
    mockConn.query.mockImplementation(async (sql) => {
      if (String(sql).startsWith('SET SESSION')) return [[], []];
      if (String(sql).startsWith('EXPLAIN')) return [[{ id: 1, rows: 1 }], []];
      return [[{ contact_id: 7 }], [{ name: 'contact_id', columnType: 3 }]];
    });
  });

  test('keeps conversational SQL when the assistant opts into developer diagnostics', async () => {
    const db = { query: jest.fn(async () => [{ insertId: 1 }]) };
    await reportService.execute(db, {
      sql: "SELECT contact_id FROM contacts WHERE contact_name LIKE '%private phrase%' LIMIT 5",
      expectedParams: 0,
      logMeta: { report_key: 'assistant_chat', run_by: 7, log_sql: true },
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const params = db.query.mock.calls[0][1];
    expect(params[1]).toBe('assistant_chat');
    expect(params[4]).toContain('private phrase');
  });

  test('preserves full SQL logging for every existing report caller', async () => {
    const db = { query: jest.fn(async () => [{ insertId: 1 }]) };
    const sql = 'SELECT contact_id FROM contacts LIMIT 5';
    await reportService.execute(db, { sql, expectedParams: 0, logMeta: { report_key: 'ordinary_report' } });
    expect(db.query.mock.calls[0][1][4]).toBe(sql);
  });
});
