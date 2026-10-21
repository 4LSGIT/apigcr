// tests/dbReportPool.test.js
//
// startup/dbReport is the least-privilege pool for the validator-gated
// report/assistant surface (yc_report). Two load-bearing behaviours:
//   1. env vars absent → it IS the dbReadonly pool (same object), so the
//      deploy that ships the module cannot break reports before the Cloud
//      Run env vars exist (the boot line says the fallback is active);
//   2. env vars present → a DISTINCT pool connecting as user_report, with
//      the idle-recycler armed (the startup/db.js maxIdle trap).

'use strict';

describe('startup/dbReport', () => {
  const ENV = ['user_report', 'password_report', 'host_report', 'database_report', 'port_report'];
  const saved = {};
  beforeAll(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('without user_report/password_report it falls back to the SAME dbReadonly pool object', () => {
    let report, readonly;
    jest.isolateModules(() => {
      readonly = require('../startup/dbReadonly');
      report = require('../startup/dbReport');
    });
    expect(report).toBe(readonly);
  });

  test('with credentials set it is a distinct pool as user_report, recycler armed', async () => {
    process.env.user_report = 'yc_report_test';
    process.env.password_report = 'pw-test';
    process.env.host_report = '127.0.0.1';
    process.env.database_report = 'testdb';
    let report, readonly;
    jest.isolateModules(() => {
      readonly = require('../startup/dbReadonly');
      report = require('../startup/dbReport');
    });
    try {
      expect(report).not.toBe(readonly);
      expect(typeof report.query).toBe('function');
      expect(report.pool.config.connectionConfig.user).toBe('yc_report_test');
      // The maxIdle < connectionLimit trap (see startup/db.js): the sweeper
      // must be armed or idleTimeout is inert.
      expect(report.pool._removeIdleTimeoutConnectionsTimer).toBeTruthy();
    } finally {
      await report.end().catch(() => {});
      for (const k of ENV) delete process.env[k];
    }
  });
});
