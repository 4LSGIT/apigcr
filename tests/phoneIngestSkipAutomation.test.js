/**
 * tests/phoneIngestSkipAutomation.test.js — phone-delivery S1
 *
 * ingestPhoneEvent's opts.skipAutomation (ref/PHONE_DELIVERY_DESIGN.md §6):
 * a non-empty string skips Layer 3 entirely — the rules evaluator is never
 * consulted — while Layers 1/2 (enrichment, suppression) and the log write
 * run exactly as live, and the executions row records WHY in
 * metadata.automation.skipped. Default (no opts) behavior is pinned too, so
 * the flag can only ever be opt-in — never inferred.
 *
 * Harness style = tests/phoneingestservice.dedup.test.js: scripted db, the
 * three collaborators jest-mocked, the module under test real.
 *
 * Mutation-checked (2026-10-21):
 *   - `if (opts.skipAutomation)` branch removed  → 'never consulted' test
 *   - metadata.automation write dropped          → 'records why' test
 *   - suppression accidentally gated on the flag → 'layer 2 still runs' test
 */
'use strict';

jest.mock('../services/logService', () => ({ createLogEntry: jest.fn() }));
jest.mock('../services/phoneIngestSuppressionService', () => ({ evaluateSuppressions: jest.fn() }));
jest.mock('../services/phoneIngestRuleService', () => ({ evaluateRules: jest.fn() }));

const logService = require('../services/logService');
const suppressionService = require('../services/phoneIngestSuppressionService');
const ruleService = require('../services/phoneIngestRuleService');
const { ingestPhoneEvent, resetFirmNumberCache } = require('../services/phoneIngestService');

function makeDb() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push([sql, params]);
      if (/FROM phone_lines/.test(sql)) return [[]];                       // firm-number cache
      if (/SELECT .*FROM phone_event_log/s.test(sql)) return [[]];         // dedup precheck: fresh
      if (/INSERT INTO phone_event_log/.test(sql)) return [{ insertId: 42, affectedRows: 1 }];
      return [{ insertId: 1, affectedRows: 1 }];
    },
  };
}

const EVENT = () => ({
  type: 'sms', direction: 'outgoing',
  from: '2485592400', to: '2482405969', message: 'hi', by: 0,
  link_type: 'phone', link_id: '2482405969',
  data: { direction: 'outgoing' },
  extra: { ts: '2026-06-01T00:00:00Z', provider: 'ringcentral', provider_message_id: 'bf-1', backfill: true },
});

beforeEach(() => {
  jest.clearAllMocks();
  resetFirmNumberCache();
  suppressionService.evaluateSuppressions.mockResolvedValue({ suppressed: false, matchedRuleIds: [] });
  ruleService.evaluateRules.mockResolvedValue({ matchedRuleIds: [], actionOutcomes: [], parseWarnings: [] });
  logService.createLogEntry.mockResolvedValue({ log_id: 77 });
});

function executionRow(db) {
  const call = db.calls.find(([s]) => /INSERT INTO phone_ingest_executions/.test(s));
  return call || null;
}

/** The value bound to the `metadata` column of a dynamic-column insert. */
function metadataOf(exec) {
  const cols = exec[0].match(/\(([^)]+)\)/)[1].split(',').map(s => s.trim());
  return exec[1][cols.indexOf('metadata')];
}

test('skipAutomation: Layer 3 never consulted; log and suppression still run; executions records why', async () => {
  const db = makeDb();
  const out = await ingestPhoneEvent(db, EVENT(), { skipAutomation: 'backfill' });

  expect(ruleService.evaluateRules).not.toHaveBeenCalled();           // Layer 3 skipped
  expect(suppressionService.evaluateSuppressions).toHaveBeenCalled(); // Layer 2 still runs
  expect(logService.createLogEntry).toHaveBeenCalled();               // the log write happens
  expect(out.log_id).toBe(77);
  expect(out.suppressed).toBe(false);

  const exec = executionRow(db);
  expect(exec).not.toBeNull();
  const metadata = JSON.parse(metadataOf(exec));
  expect(metadata.automation).toEqual({ skipped: 'backfill' });
});

test('without opts, Layer 3 runs (the flag is opt-in, never inferred)', async () => {
  const db = makeDb();
  await ingestPhoneEvent(db, EVENT());
  expect(ruleService.evaluateRules).toHaveBeenCalledTimes(1);
  const exec = executionRow(db);
  const metadata = metadataOf(exec);
  expect(metadata == null || !JSON.parse(metadata).automation).toBe(true);
});

test('a suppressed backfilled event is suppressed exactly like a live one', async () => {
  suppressionService.evaluateSuppressions.mockResolvedValue({ suppressed: true, matchedRuleIds: [5] });
  const db = makeDb();
  const out = await ingestPhoneEvent(db, EVENT(), { skipAutomation: 'backfill' });
  expect(out.suppressed).toBe(true);
  expect(out.log_id).toBeNull();
  expect(logService.createLogEntry).not.toHaveBeenCalled();
  expect(ruleService.evaluateRules).not.toHaveBeenCalled();
});
