// tests/emitStageAged.test.js
//
// emit_stage_aged (lib/internal_functions/system.js) — the case.stage_aged
// nightly emitter, exercised against a STUB pool (pattern from
// tests/triggerService.test.js) with lib/domainEvents and lib/alerting
// mocked. No database, no engine.
//
// Covers:
//   - Grace window: fire only when threshold <= days < threshold + grace;
//     a day-8 case fires BOTH the 3 and 7 rungs (the documented bounded
//     overlap), day-20 fires 14 only, day-100 fires nothing.
//   - Claim-then-emit: INSERT IGNORE affectedRows 0 → no emit, counted as
//     duplicate; affectedRows 1 → exactly one emit per claim.
//   - Per-run cap: stops BEFORE claiming the next crossing, alerts once.
//   - dry_run: no claims, no emits, would_emit listed.
//   - Envelope shape: source 'system', actor user 0, extra.stage_log_id,
//     data.threshold_days / days_in_stage.
//   - Param parsing: csv thresholds; empty/invalid ladders throw.
//
// Run:
//   npx jest tests/emitStageAged.test.js

'use strict';

jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(async () => {}),
}));
jest.mock('../lib/alerting', () => ({
  alert: jest.fn(async () => {}),
}));

const domainEvents = require('../lib/domainEvents');
const { alert }    = require('../lib/alerting');
const fns          = require('../lib/internal_functions/system');

// ─────────────────────────────────────────────────────────────
// Stub pool
// ─────────────────────────────────────────────────────────────
//
// Serves the candidate SELECT from a fixture and records every
// case_stage_aged_emitted INSERT IGNORE. `claimResult(logId, t)` scripts
// affectedRows (default 1 = fresh claim; 0 = already claimed).

function makeDb(candidates, { claimResult = () => 1 } = {}) {
  const calls = [];
  return {
    calls,
    claims: () => calls.filter(c => /INSERT IGNORE INTO case_stage_aged_emitted/.test(c.sql)),
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM case_stage_log/.test(sql)) {
        return [candidates.map(r => ({ ...r }))];
      }
      if (/INSERT IGNORE INTO case_stage_aged_emitted/.test(sql)) {
        return [{ affectedRows: claimResult(params[0], params[1]) }];
      }
      throw new Error('stub: unscripted SQL: ' + sql.slice(0, 60));
    },
  };
}

const cand = (logId, caseId, days, over = {}) => ({
  stage_log_id: logId, case_id: caseId, template_id: 1, stage_id: 3,
  stage_key: 'docs', status_label: 'Documents & Prep',
  entered_at: new Date('2026-08-01T12:00:00.000Z'),
  days_in_stage: days, case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
  ...over,
});

beforeEach(() => {
  domainEvents.emit.mockClear();
  alert.mockClear();
});

// ─────────────────────────────────────────────────────────────
// Grace window
// ─────────────────────────────────────────────────────────────

test('window: fires only threshold <= days < threshold + grace; day 8 fires rungs 3 AND 7', async () => {
  const db = makeDb([
    cand(101, 'CASEAAAA', 2),    // below the whole ladder → nothing
    cand(102, 'CASEBBBB', 5),    // rung 3 in [3,10) → fires 3 only
    cand(103, 'CASECCCC', 8),    // 3:[3,10) AND 7:[7,14) → fires both
    cand(104, 'CASEDDDD', 20),   // 14:[14,21) → fires 14 only; 3 & 7 out of window
    cand(105, 'CASEEEEE', 100),  // 60:[60,67) passed → nothing
  ]);
  const out = await fns.emit_stage_aged({}, db);

  const fired = domainEvents.emit.mock.calls.map(([, ev, payload]) =>
    [payload.extra.stage_log_id, payload.data.threshold_days]);
  expect(fired).toEqual([[102, 3], [103, 3], [103, 7], [104, 14]]);
  expect(out.output.emitted).toBe(4);
  expect(out.output.duplicates).toBe(0);
  expect(out.output.capped).toBe(false);
  // one claim per emit, same (log_id, threshold) pairs
  expect(db.claims().map(c => [c.params[0], c.params[1]])).toEqual(fired);
});

// ─────────────────────────────────────────────────────────────
// Claim-then-emit dedup
// ─────────────────────────────────────────────────────────────

test('already-claimed crossing (affectedRows 0) emits nothing and counts as duplicate', async () => {
  const db = makeDb(
    [cand(201, 'CASEAAAA', 5), cand(202, 'CASEBBBB', 5)],
    { claimResult: (logId) => (logId === 201 ? 0 : 1) }   // 201 claimed last night
  );
  const out = await fns.emit_stage_aged({}, db);

  expect(domainEvents.emit).toHaveBeenCalledTimes(1);
  expect(domainEvents.emit.mock.calls[0][2].extra.stage_log_id).toBe(202);
  expect(out.output.emitted).toBe(1);
  expect(out.output.duplicates).toBe(1);
});

// ─────────────────────────────────────────────────────────────
// Per-run cap
// ─────────────────────────────────────────────────────────────

test('cap stops BEFORE claiming the next crossing and alerts once', async () => {
  const db = makeDb([
    cand(301, 'CASEAAAA', 5),
    cand(302, 'CASEBBBB', 5),
    cand(303, 'CASECCCC', 5),
  ]);
  const out = await fns.emit_stage_aged({ max_emissions: 1 }, db);

  expect(out.output.emitted).toBe(1);
  expect(out.output.capped).toBe(true);
  // The skipped crossings were NOT claimed — they stay eligible tomorrow
  // while inside their grace window.
  expect(db.claims().length).toBe(1);
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls[0][1].kind).toBe('trigger_stage_aged_cap');
});

// ─────────────────────────────────────────────────────────────
// dry_run
// ─────────────────────────────────────────────────────────────

test('dry_run lists would-emit crossings without claiming or emitting', async () => {
  const db = makeDb([cand(401, 'CASEAAAA', 8)]);
  const out = await fns.emit_stage_aged({ dry_run: true }, db);

  expect(domainEvents.emit).not.toHaveBeenCalled();
  expect(db.claims().length).toBe(0);
  expect(out.output.dry_run).toBe(true);
  expect(out.output.would_emit).toEqual([
    { case_id: 'CASEAAAA', stage_key: 'docs', stage_log_id: 401, threshold_days: 3, days_in_stage: 8 },
    { case_id: 'CASEAAAA', stage_key: 'docs', stage_log_id: 401, threshold_days: 7, days_in_stage: 8 },
  ]);
  expect(out.output.emitted).toBe(0);
});

// ─────────────────────────────────────────────────────────────
// Envelope shape
// ─────────────────────────────────────────────────────────────

test('envelope: source system, actor user 0, string case_id, data + extra fields', async () => {
  const db = makeDb([cand(501, 'CASEAAAA', 15)]);
  await fns.emit_stage_aged({}, db);

  expect(domainEvents.emit).toHaveBeenCalledTimes(1);
  const [dbArg, eventType, payload] = domainEvents.emit.mock.calls[0];
  expect(dbArg).toBe(db);
  expect(eventType).toBe('case.stage_aged');
  expect(payload.case_id).toBe('CASEAAAA');
  expect(payload.source).toBe('system');
  expect(payload.actor).toEqual({ user_id: 0 });
  expect(payload.data).toMatchObject({
    stage_key: 'docs', stage_id: 3, template_id: 1,
    days_in_stage: 15, threshold_days: 14,
    case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
    status_label: 'Documents & Prep',
  });
  expect(payload.extra).toEqual({ stage_log_id: 501 });
});

// ─────────────────────────────────────────────────────────────
// Param parsing
// ─────────────────────────────────────────────────────────────

test('thresholds accepts csv, dedupes, sorts; custom grace window applies', async () => {
  const db = makeDb([cand(601, 'CASEAAAA', 11)]);
  // ladder "10, 5, 10" → [5, 10]; grace 2 → 5:[5,7) misses, 10:[10,12) fires
  const out = await fns.emit_stage_aged({ thresholds: '10, 5, 10', grace_days: 2 }, db);
  expect(out.output.thresholds).toEqual([5, 10]);
  expect(domainEvents.emit).toHaveBeenCalledTimes(1);
  expect(domainEvents.emit.mock.calls[0][2].data.threshold_days).toBe(10);
  // the candidate SELECT is parameterized on the MIN threshold
  const sel = db.calls.find(c => /FROM case_stage_log/.test(c.sql));
  expect(sel.params).toEqual([5]);
});

test('invalid or empty ladders throw before any query damage', async () => {
  await expect(fns.emit_stage_aged({ thresholds: 'abc, -3, 0' }, makeDb([])))
    .rejects.toThrow(/empty list/);
  await expect(fns.emit_stage_aged({ thresholds: { nope: true } }, makeDb([])))
    .rejects.toThrow(/array or comma-separated/);
  expect(domainEvents.emit).not.toHaveBeenCalled();
});