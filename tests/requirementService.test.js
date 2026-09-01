// tests/requirementService.test.js
//
// R2 — stage requirements: detector registry, batched resolver, overrides,
// and the getPipeline C1 contract. Exercised against STUB mysql2 pools that
// record every (sql, params) call and return scripted rows — no database
// (stub pattern from tests/pipelineService.test.js, scriptGuard-registered).
//
// Covers (per the slice spec):
//   - Each detector: satisfied/unsatisfied/progress hit shapes + QUERY-COUNT
//     assertions proving batching (N cases × M requirements of one kind =
//     constant queries): esign 1 · checklist 2 (1 when no lists) · form 1 ·
//     event 3 · manual 0.
//   - event detector (U5): registry-key matching with kind fallback, all
//     three sources through caseEventService.listForCases, want→status_norm
//     mapping, which latest/first, dead rows excluded by the read layer,
//     read-time warn path for an unknown stored source.
//   - Resolver precedence matrix, one scenario exercising every row:
//     override-na beats a satisfied detector; override-done supplies
//     satisfied_at; detector-done beats position (THE FILED-CASE
//     QUESTIONNAIRE: submitted in March → "done", never "skipped");
//     behind+unsatisfied → skipped (same-template AND cross-template);
//     current → active; ahead → upcoming; manual + no override → never
//     done. Plus: no-history → all upcoming, none active. Plus a
//     whole-resolver query-count assertion (2 cases × 7 requirements = 13
//     queries; 11 before U5 moved the event detector onto listForCases).
//   - C1: default getPipeline payload byte-identical (keys + no
//     requirements anywhere + no extra queries); { requirements:true }
//     attaches per-stage arrays (empty tables → [] — the deploy gate).
//   - Overrides service: set/clear happy paths write the upsert/DELETE and
//     the type='status' case log row; 400s (bad status, unknown key), 404s
//     (unknown case, nothing to clear); note clipped to 255.
//
// Run:
//   npx jest tests/requirementService.test.js

'use strict';

const detectors = require('../services/requirementDetectors');
const reqSvc = require('../services/requirementService');
const pipelineSvc = require('../services/pipelineService');
const { scriptGuard } = require('./helpers/scriptGuard');

// (R2.6) The report detector lazy-requires reportService; mock it so no test
// here touches the report execution stack. Nothing else in this file uses it.
jest.mock('../services/reportService', () => ({
  getReport: jest.fn(),
  runReport: jest.fn(),
}));
const reportService = require('../services/reportService');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Detector fixtures
// ─────────────────────────────────────────────────────────────────────────────

const req = (key, detector, cfg) => ({
  requirement_key: key, detector, detector_config: cfg,
});

// ─────────────────────────────────────────────────────────────────────────────
// esign detector
// ─────────────────────────────────────────────────────────────────────────────

describe('esign detector', () => {
  test('BATCHED: 3 cases × 2 kinds = ONE query; hit only where terminal success exists', async () => {
    const db = stubDb([[
      { linkable_id: 'A', kind: 'contract', status: 'signed',
        completed_at: '2026-02-01 10:00:00', updated_at: '2026-02-01 10:00:01', created_at: '2026-01-20 09:00:00' },
      { linkable_id: 'B', kind: 'schedules', status: 'satisfied_external',
        completed_at: null, updated_at: '2026-03-03 08:00:00', created_at: '2026-02-15 08:00:00' },
    ]]);
    const out = await detectors.DETECTORS.esign.batchResolve(db, ['A', 'B', 'C'], [
      req('retainer_signed', 'esign', { kind: 'contract' }),
      req('schedules_signed', 'esign', { kind: 'schedules' }),
    ]);
    expect(db.calls.length).toBe(1);                       // the batching proof
    expect(db.calls[0].params).toEqual([
      ['A', 'B', 'C'], ['contract', 'schedules'], ['signed', 'satisfied_external'],
    ]);
    const a = out.get('A').get('retainer_signed');
    expect(a.satisfied_at).toBe('2026-02-01 10:00:00');    // completed_at first
    expect(a.detail).toBe('Signed');
    expect(a.progress).toBeNull();
    // satisfied⇔non-null protocol: fallback keeps a signed row satisfied
    // even when completed_at is missing (legacy shape).
    expect(out.get('B').get('schedules_signed').satisfied_at).toBe('2026-03-03 08:00:00');
    expect(out.get('A').has('schedules_signed')).toBe(false);
    expect(out.has('C')).toBe(false);
  });

  test('latest terminal-success row wins on re-sends', async () => {
    const db = stubDb([[
      { linkable_id: 'A', kind: 'contract', status: 'signed',
        completed_at: '2026-01-01 00:00:00', updated_at: null, created_at: null },
      { linkable_id: 'A', kind: 'contract', status: 'signed',
        completed_at: '2026-04-01 00:00:00', updated_at: null, created_at: null },
    ]]);
    const out = await detectors.DETECTORS.esign.batchResolve(db, ['A'],
      [req('retainer_signed', 'esign', { kind: 'contract' })]);
    expect(out.get('A').get('retainer_signed').satisfied_at).toBe('2026-04-01 00:00:00');
  });

  test('validateConfig: missing kind / unknown key / non-object all rejected', () => {
    expect(detectors.validateDetectorConfig('esign', {})).toMatch(/kind/);
    expect(detectors.validateDetectorConfig('esign', { kinds: 'x' })).toMatch(/unknown config key/);
    expect(detectors.validateDetectorConfig('esign', [1])).toMatch(/object/);
    expect(detectors.validateDetectorConfig('esign', { kind: 'contract' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checklist detector
// ─────────────────────────────────────────────────────────────────────────────

describe('checklist detector', () => {
  test('BATCHED: 2 cases × 1 tag = TWO queries; progress carried even when unsatisfied', async () => {
    const db = stubDb([
      [ // lists
        { id: 900, link: 'A', tag: 'docs_needed', status: 'complete',   updated_date: '2026-04-01 12:00:00' },
        { id: 901, link: 'B', tag: 'docs_needed', status: 'incomplete', updated_date: '2026-08-01 12:00:00' },
      ],
      [ // item counts
        { checklist_id: 900, total: 8, done: 8 },
        { checklist_id: 901, total: 8, done: 2 },
      ],
    ]);
    const out = await detectors.DETECTORS.checklist.batchResolve(db, ['A', 'B'],
      [req('docs_received', 'checklist', { tag: 'docs_needed' })]);
    expect(db.calls.length).toBe(2);                       // lists + items, never per-case
    expect(db.calls[0].sql).toContain(`kind = 'checklist'`);   // a docs_needed NOTE must not count
    const a = out.get('A').get('docs_received');
    expect(a.satisfied_at).toBe('2026-04-01 12:00:00');
    expect(a.detail).toBe('Complete');
    expect(a.progress).toBe('8 of 8 received');
    const b = out.get('B').get('docs_received');
    expect(b.satisfied_at).toBeNull();                     // unsatisfied…
    expect(b.progress).toBe('2 of 8 received');            // …but progress rides along
  });

  test('no tagged list at all → ONE query, no entry (nothing to report)', async () => {
    const db = stubDb([[]]);
    const out = await detectors.DETECTORS.checklist.batchResolve(db, ['A'],
      [req('docs_received', 'checklist', { tag: 'docs_needed' })]);
    expect(db.calls.length).toBe(1);
    expect(out.size).toBe(0);
  });

  test('multiple lists under one tag: ALL must be complete', async () => {
    const db = stubDb([
      [
        { id: 900, link: 'A', tag: 'docs_needed', status: 'complete',   updated_date: '2026-04-01 12:00:00' },
        { id: 902, link: 'A', tag: 'docs_needed', status: 'incomplete', updated_date: '2026-05-01 12:00:00' },
      ],
      [{ checklist_id: 900, total: 3, done: 3 }, { checklist_id: 902, total: 2, done: 1 }],
    ]);
    const out = await detectors.DETECTORS.checklist.batchResolve(db, ['A'],
      [req('docs_received', 'checklist', { tag: 'docs_needed' })]);
    const a = out.get('A').get('docs_received');
    expect(a.satisfied_at).toBeNull();
    expect(a.progress).toBe('4 of 5 received');
  });

  test('validateConfig', () => {
    expect(detectors.validateDetectorConfig('checklist', { tag: 'docs_needed' })).toBeNull();
    expect(detectors.validateDetectorConfig('checklist', {})).toMatch(/tag/);
    expect(detectors.validateDetectorConfig('checklist', { tag: 'x', extra: 1 })).toMatch(/unknown config key/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// form detector
// ─────────────────────────────────────────────────────────────────────────────

describe('form detector', () => {
  test('BATCHED: ONE query; satisfied_at = latest submission time; drafts filtered in SQL', async () => {
    const db = stubDb([[
      { link_id: 'A', form_key: 'intake', submitted_at: '2026-03-05 10:00:00' },
    ]]);
    const out = await detectors.DETECTORS.form.batchResolve(db, ['A', 'B'],
      [req('intake_form', 'form', { form_key: 'intake' })]);
    expect(db.calls.length).toBe(1);
    expect(db.calls[0].sql).toContain(`status = 'submitted'`);
    const a = out.get('A').get('intake_form');
    expect(a.satisfied_at).toBe('2026-03-05 10:00:00');
    expect(a.detail).toBe('Submitted');
    expect(out.has('B')).toBe(false);
  });

  test('validateConfig', () => {
    expect(detectors.validateDetectorConfig('form', { form_key: 'intake' })).toBeNull();
    expect(detectors.validateDetectorConfig('form', {})).toMatch(/form_key/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// event detector (U5: registry keys; all three sources through the read layer)
// ─────────────────────────────────────────────────────────────────────────────
//
// The detector now reads caseEventService.listForCases rather than its own
// appt SQL, so a stub script for it is THREE results in the read layer's own
// order: cases, events, appts. Everything below scripts them explicitly, which
// is also what pins the 3-query budget — an accidental 4th read would overrun
// the script and scriptGuard would say so.
// ─────────────────────────────────────────────────────────────────────────────

/** cases rows as _listForCases selects them (case_id + both docket columns). */
const CE_CASES = (...ids) =>
  ids.map((id) => ({ case_id: id, case_number: null, case_number_full: null }));

/** An appts row in the shape _listForCases selects. */
const CE_APPT = (caseId, typeKey, status, date, over = {}) => ({
  appt_id: over.appt_id ?? Math.floor(Math.random() * 1e6),
  appt_case_id: caseId,
  appt_client_id: 1,
  appt_type: over.appt_type ?? typeKey,
  type_key: typeKey,
  appt_status: status,
  appt_date: date,
  appt_end: null,
  appt_length: 30,
  appt_platform: 'Zoom',
  appt_with: 1,
});

/** An events row in the shape _listForCases selects. */
const CE_EVENT = (caseId, typeKey, kind, status, date, over = {}) => ({
  event_id: over.event_id ?? Math.floor(Math.random() * 1e6),
  event_type: over.event_type ?? typeKey,
  event_title: over.event_title ?? typeKey,
  event_date: date,
  event_time: over.event_time ?? '10:00:00',
  event_all_day: 0,
  event_length: 60,
  event_location: null,
  event_status: status,
  event_resolution: null,
  event_link_type: 'case',
  event_link_id: caseId,
  kind,
  type_key: typeKey,
  event_with: 1,
  superseded_by_event_id: null,
  supersede_reason: null,
});

describe('event detector (appt source, registry keys)', () => {
  const CASES = CE_CASES('A', 'B');
  const APPTS = [
    CE_APPT('A', 'meeting_341', 'Attended',  '2026-05-01 10:00:00'),
    CE_APPT('A', 'meeting_341', 'Attended',  '2026-06-01 10:00:00'),
    CE_APPT('A', 'meeting_341', 'No Show',   '2026-04-01 10:00:00'),
    CE_APPT('A', 'meeting_341', 'Scheduled', '2026-09-01 10:00:00'),
    CE_APPT('A', 'meeting_341', 'Canceled',  '2026-03-01 10:00:00'),
  ];
  const cfg = (over = {}) => ({ source: 'appt', kind_or_type: 'meeting_341', ...over });

  /** The Date mysql2 would have produced for the same DATETIME under the
   *  pool's timezone:'Z'. satisfied_at must stay a Date — portalCaseService
   *  runs it through utcToLocal. */
  const at = (naive) => new Date(`${naive.replace(' ', 'T')}Z`);

  test('BATCHED: THREE queries via listForCases; tombstones excluded in ITS sql', async () => {
    const db = stubDb([CASES, [], APPTS]);
    await detectors.DETECTORS.event.batchResolve(db, ['A', 'B'],
      [req('m341_held', 'event', cfg())]);
    expect(db.calls.length).toBe(3);
    expect(db.calls[0].sql).toMatch(/FROM cases/);
    expect(db.calls[1].sql).toMatch(/FROM events/);
    expect(db.calls[2].sql).toMatch(/FROM appts/);
    // The dead-row rules are the read layer's now, not this detector's.
    expect(db.calls[1].sql).toContain('superseded_by_event_id IS NULL');
    expect(db.calls[2].sql).toContain(`appt_status <> 'Rescheduled'`);
    // No type filter reaches SQL at all — the vocabulary match is in JS,
    // against type_key/kind_key, so one read serves every requirement.
    expect(db.calls[2].sql).not.toContain('type_key IN');
  });

  test('want held (default) → status_norm held; which latest (default) picks max start', async () => {
    const db = stubDb([CASES, [], APPTS]);
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('m341_held', 'event', cfg())]);
    const hit = out.get('A').get('m341_held');
    expect(hit.satisfied_at).toEqual(at('2026-06-01 10:00:00'));
    expect(hit.satisfied_at instanceof Date).toBe(true);
    // detail is still the RAW status label staff read in case.html.
    expect(hit.detail).toBe('Attended');
  });

  test('which first picks min start among matches', async () => {
    const db = stubDb([CASES, [], APPTS]);
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('m341_held', 'event', cfg({ which: 'first' }))]);
    expect(out.get('A').get('m341_held').satisfied_at).toEqual(at('2026-05-01 10:00:00'));
  });

  test('want scheduled → Scheduled; want missed → No Show', async () => {
    const db = stubDb([CASES, [], APPTS, CASES, [], APPTS]);
    const out1 = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('m341_sched', 'event', cfg({ want: 'scheduled' }))]);
    expect(out1.get('A').get('m341_sched').detail).toBe('Scheduled');
    const out2 = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('m341_missed', 'event', cfg({ want: 'missed' }))]);
    expect(out2.get('A').get('m341_missed').detail).toBe('No Show');
  });

  test('want any matches any non-tombstone (Canceled included), latest wins', async () => {
    const db = stubDb([CASES, [], APPTS]);
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('m341_any', 'event', cfg({ want: 'any' }))]);
    expect(out.get('A').get('m341_any').satisfied_at).toEqual(at('2026-09-01 10:00:00'));
    expect(out.get('A').get('m341_any').detail).toBe('Scheduled');
  });

  test('no matching status → unsatisfied (no entry)', async () => {
    const db = stubDb([CE_CASES('A'), [], [APPTS[4]]]);   // only the Canceled row
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('m341_held', 'event', cfg())]);
    expect(out.size).toBe(0);
  });

  test('a STALE LABEL config no longer matches — the U5 cutover is a real cutover', async () => {
    const db = stubDb([CE_CASES('A'), [], APPTS]);
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('m341_held', 'event', { source: 'appt', kind_or_type: '341 Meeting' })]);
    // The rows carry appt_type '341 Meeting' but type_key 'meeting_341'.
    // Matching the label would be matching a vocabulary the registry replaced.
    expect(out.size).toBe(0);
  });

  test('WRITE-time: all three sources accepted; bad want/which; typo key', () => {
    expect(detectors.validateDetectorConfig('event', cfg())).toBeNull();
    expect(detectors.validateDetectorConfig('event', cfg({ source: 'event' }))).toBeNull();
    expect(detectors.validateDetectorConfig('event', cfg({ source: 'any' }))).toBeNull();
    expect(detectors.validateDetectorConfig('event', cfg({ source: 'task' }))).toMatch(/source must be one of/);
    expect(detectors.validateDetectorConfig('event', cfg({ want: 'happened' }))).toMatch(/want/);
    expect(detectors.validateDetectorConfig('event', cfg({ which: 'newest' }))).toMatch(/which/);
    expect(detectors.validateDetectorConfig('event', cfg({ kindortype: 'x' }))).toMatch(/unknown config key/);
  });

  test('READ-time guard: an unknown stored source resolves unsatisfied + console.warn', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = stubDb([CE_CASES('A'), [], APPTS]);
      const out = await detectors.DETECTORS.event.batchResolve(db, ['A'], [
        req('m341_held', 'event', cfg()),
        req('bogus_src', 'event', { source: 'task', kind_or_type: 'meeting_341' }),
      ]);
      expect(db.calls.length).toBe(3);
      expect(out.get('A').has('m341_held')).toBe(true);
      expect(out.get('A').has('bogus_src')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bogus_src'));
    } finally {
      warn.mockRestore();
    }
  });

  test('ZERO queries when there are no ids, no reqs, or no usable values', async () => {
    const none = stubDb([]);
    await detectors.DETECTORS.event.batchResolve(none, [], [req('x', 'event', cfg())]);
    await detectors.DETECTORS.event.batchResolve(none, ['A'], []);
    await detectors.DETECTORS.event.batchResolve(none, ['A'],
      [req('x', 'event', { source: 'appt', kind_or_type: ['   '] })]);
    expect(none.calls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (U5) event detector — kind FALLBACK, and sources 'event' / 'any'
// ─────────────────────────────────────────────────────────────────────────────
//
// v0.5 §6: "match type_key first, then kind_key". A configured value is
// therefore either a registry type key or one of the five kinds, and the same
// selector may name both. ['meeting'] matches every appt by construction
// (§3.3.2: kind='meeting' → appts); ['deadline'] matches every deadline event.
// ─────────────────────────────────────────────────────────────────────────────

describe('event detector — kind fallback and the widened sources (U5)', () => {
  const CASES = CE_CASES('A');
  const APPTS = [
    CE_APPT('A', 'iss',         'Attended',  '2026-02-01 09:00:00'),
    CE_APPT('A', 'meeting_341', 'Attended',  '2026-08-01 09:00:00'),
  ];
  const EVENTS = [
    CE_EVENT('A', 'poc_due',              'deadline', 'Completed', '2026-03-01'),
    CE_EVENT('A', 'confirmation_hearing', 'hearing',  'Scheduled', '2026-09-15'),
    CE_EVENT('A', 'docs_deadline',        'deadline', 'Completed', '2026-05-01'),
  ];
  const script = () => [CASES, EVENTS, APPTS];

  test("['meeting'] matches EVERY appt — appts are 'meeting' by table", async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('any_meeting', 'event', { source: 'appt', kind_or_type: ['meeting'], want: 'held' })]);
    // Latest of the two Attended appts, regardless of their differing types.
    expect(out.get('A').get('any_meeting').satisfied_at)
      .toEqual(new Date('2026-08-01T09:00:00Z'));
  });

  test("['deadline'] matches every deadline EVENT and no appt", async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('a_deadline', 'event', { source: 'event', kind_or_type: ['deadline'], want: 'held' })]);
    const hit = out.get('A').get('a_deadline');
    // 'Completed' on the event side normalizes to status_norm 'held'.
    expect(hit.satisfied_at).toEqual(new Date('2026-05-01T10:00:00Z'));
    expect(hit.detail).toBe('Completed');
  });

  test("source 'event' matches an event by TYPE key", async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('conf_set', 'event', { source: 'event', kind_or_type: 'confirmation_hearing', want: 'scheduled' })]);
    expect(out.get('A').get('conf_set').detail).toBe('Scheduled');
  });

  test("source 'any' spans BOTH tables in one selector", async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('mixed', 'event', { source: 'any', kind_or_type: ['iss', 'poc_due'], want: 'held' })]);
    // The 341 appt (2026-08-01) is NOT in the selector; the latest match
    // across the two named keys is the poc_due deadline on 2026-03-01.
    expect(out.get('A').get('mixed').satisfied_at).toEqual(new Date('2026-03-01T10:00:00Z'));
  });

  test("source 'appt' ignores events of a matching kind, and vice versa", async () => {
    const db = stubDb([...script(), ...script()]);
    const apptOnly = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('d', 'event', { source: 'appt', kind_or_type: ['deadline'], want: 'held' })]);
    expect(apptOnly.size).toBe(0);
    const eventOnly = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('m', 'event', { source: 'event', kind_or_type: ['meeting'], want: 'held' })]);
    expect(eventOnly.size).toBe(0);
  });

  test("want:'missed' on source 'event' is honestly unsatisfiable (no missed status)", async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('missed_deadline', 'event', { source: 'event', kind_or_type: ['deadline'], want: 'missed' })]);
    expect(out.size).toBe(0);
  });

  test('one read serves several requirements of every source', async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'], [
      req('iss_held',   'event', { source: 'appt',  kind_or_type: ['iss'] }),
      req('a_deadline', 'event', { source: 'event', kind_or_type: ['deadline'] }),
      req('anything',   'event', { source: 'any',   kind_or_type: ['meeting', 'hearing'], want: 'any' }),
    ]);
    expect(db.calls.length).toBe(3);
    expect(out.get('A').get('iss_held').satisfied_at).toEqual(new Date('2026-02-01T09:00:00Z'));
    expect(out.get('A').get('a_deadline').satisfied_at).toEqual(new Date('2026-05-01T10:00:00Z'));
    // want 'any' across meetings + hearings: the 2026-09-15 hearing is latest.
    expect(out.get('A').get('anything').satisfied_at).toEqual(new Date('2026-09-15T10:00:00Z'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (F1, carried through U5) event detector — kind_or_type is a LIST
// ─────────────────────────────────────────────────────────────────────────────
//
// Why a list and not a data migration: 'Strategy Session' (Feb 2024 → Jun
// 2026) and 'Initial Strategy Session' (Jun 2024 → Jul 2026) OVERLAP. They
// were two names in concurrent use for one activity, not a rename with a
// cutover, so no normalization could collapse them without falsifying booked
// history. Verified live 2026-08-27: the single-string config covered 285
// cases, the four-name list covered 353 — 68 real strategy sessions the
// requirement was calling unmet.
//
// U5 changed what the list holds, not why it exists. The registry absorbed the
// TYPO ('Intial Strategy Session' is an ingest_alias of `iss`, applied at write
// time), so that spelling leaves the list; the three genuinely distinct
// activities Fred ruled — iss, ss, consultation — keep three keys, and the
// selector keeps naming all three. trigger_rules #1/#2 match on exactly this
// list; the detector agrees with the trigger rather than contradicting it.
// ─────────────────────────────────────────────────────────────────────────────

describe('event detector — kind_or_type list (F1)', () => {
  // Two keys, deliberately interleaved in time so `which` ordering across the
  // union is distinguishable from ordering within either key alone.
  const CASES = CE_CASES('A', 'B');
  const MIXED = [
    CE_APPT('A', 'ss',  'Attended', '2024-03-01 10:00:00'),
    CE_APPT('A', 'iss', 'Attended', '2025-01-15 10:00:00'),
    CE_APPT('A', 'ss',  'Attended', '2026-06-02 10:00:00'),
    CE_APPT('A', 'iss', 'No Show',  '2026-07-07 10:00:00'),
    CE_APPT('B', 'ss',  'Attended', '2024-05-05 10:00:00'),
  ];
  // The exact live config requirement 3 (iss_held) was moved to by the U5
  // migration.
  const ISS_LIST = ['iss', 'ss', 'consultation'];
  const listCfg = (over = {}) => ({ source: 'appt', kind_or_type: ISS_LIST, want: 'held', which: 'latest', ...over });
  const script = () => [CASES, [], MIXED];

  // ── validateConfig ──────────────────────────────────────────────────────

  test('WRITE-time: a non-empty array of non-empty strings is accepted', () => {
    expect(detectors.validateDetectorConfig('event', listCfg())).toBeNull();
    expect(detectors.validateDetectorConfig('event',
      { source: 'appt', kind_or_type: ['meeting_341'] })).toBeNull();
  });

  test('WRITE-time: empty array rejected (it would silently match nothing)', () => {
    expect(detectors.validateDetectorConfig('event',
      { source: 'appt', kind_or_type: [] })).toMatch(/non-empty/);
  });

  test('WRITE-time: a non-string or blank element is rejected, naming its index', () => {
    expect(detectors.validateDetectorConfig('event',
      { source: 'appt', kind_or_type: ['ok', 3] })).toMatch(/kind_or_type\[1\]/);
    expect(detectors.validateDetectorConfig('event',
      { source: 'appt', kind_or_type: ['ok', '   '] })).toMatch(/kind_or_type\[1\]/);
    expect(detectors.validateDetectorConfig('event',
      { source: 'appt', kind_or_type: ['ok', null] })).toMatch(/kind_or_type\[1\]/);
  });

  test('WRITE-time: an over-length element is rejected at the SAME 60 the scalar uses', () => {
    const long = 'x'.repeat(61);
    expect(detectors.validateDetectorConfig('event',
      { source: 'appt', kind_or_type: ['ok', long] })).toMatch(/at most 60 characters/);
    // The scalar form's ceiling is unchanged — the array cannot smuggle a
    // value past a check the string form applies.
    expect(detectors.validateDetectorConfig('event',
      { source: 'appt', kind_or_type: long })).toMatch(/at most 60 characters/);
  });

  test('WRITE-time: the other rules are untouched (unknown key, want, which)', () => {
    expect(detectors.validateDetectorConfig('event', listCfg({ nope: 1 }))).toMatch(/unknown config key/);
    expect(detectors.validateDetectorConfig('event', listCfg({ want: 'happened' }))).toMatch(/want/);
    expect(detectors.validateDetectorConfig('event', listCfg({ which: 'newest' }))).toMatch(/which/);
  });

  test('config_hint advertises the array form AND registry keys, not labels', () => {
    const hint = JSON.parse(detectors.DETECTORS.event.config_hint);
    expect(Array.isArray(hint.kind_or_type)).toBe(true);
    expect(hint.kind_or_type).toEqual(['iss', 'ss']);
    // A label in the hint would teach the wrong vocabulary on the admin screen.
    expect(detectors.DETECTORS.event.config_hint).not.toMatch(/Strategy Session/);
  });

  // ── batchResolve ────────────────────────────────────────────────────────

  test('QUERY COUNT UNCHANGED BY LIST LENGTH: every key rides the one read', async () => {
    const db = stubDb(script());
    await detectors.DETECTORS.event.batchResolve(db, ['A', 'B'],
      [req('iss_held', 'event', listCfg())]);
    expect(db.calls.length).toBe(3);
  });

  test('resolves across MIXED keys — the 68-case gap stays closed', async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A', 'B'],
      [req('iss_held', 'event', listCfg())]);
    // B has ONLY an `ss` — invisible to a single-key config, satisfied here.
    expect(out.get('B').get('iss_held').satisfied_at).toEqual(new Date('2024-05-05T10:00:00Z'));
    expect(out.get('B').get('iss_held').detail).toBe('Attended');
  });

  test('which latest picks the max across the UNION, not per key', async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('iss_held', 'event', listCfg())]);
    // 2026-06-02 is an `ss`; the latest `iss` Attended is 2025-01-15. Picking
    // per key would return the wrong row.
    expect(out.get('A').get('iss_held').satisfied_at).toEqual(new Date('2026-06-02T10:00:00Z'));
  });

  test('which first picks the min across the UNION', async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('iss_held', 'event', listCfg({ which: 'first' }))]);
    expect(out.get('A').get('iss_held').satisfied_at).toEqual(new Date('2024-03-01T10:00:00Z'));
  });

  test('want still filters status across the union (No Show ignored under held)', async () => {
    const db = stubDb([...script(), ...script()]);
    const held = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('iss_held', 'event', listCfg())]);
    expect(held.get('A').get('iss_held').detail).toBe('Attended');
    const missed = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('iss_missed', 'event', listCfg({ want: 'missed' }))]);
    expect(missed.get('A').get('iss_missed').satisfied_at).toEqual(new Date('2026-07-07T10:00:00Z'));
  });

  test('BACKWARD COMPATIBLE: a single string behaves as a one-element list', async () => {
    const db = stubDb([...script(), ...script()]);
    const asString = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('iss_held', 'event', { source: 'appt', kind_or_type: 'iss' })]);
    // Only the `iss` rows are considered: the 2026-06-02 `ss` is NOT picked.
    expect(asString.get('A').get('iss_held').satisfied_at).toEqual(new Date('2025-01-15T10:00:00Z'));

    const asArray = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('iss_held', 'event', { source: 'appt', kind_or_type: ['iss'] })]);
    expect(asArray.get('A').get('iss_held')).toEqual(asString.get('A').get('iss_held'));
  });

  test('configured values that collapse under the ci key do not double-count', async () => {
    const ROWS = [CE_APPT('A', 'consultation', 'Attended', '2026-01-01 10:00:00')];
    const db = stubDb([CE_CASES('A'), [], ROWS]);
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'],
      [req('c', 'event', { source: 'appt', kind_or_type: ['Consultation', 'consultation'] })]);
    // Registry keys are matched case-insensitively — the general_ci semantics
    // the column is stored under.
    expect(out.get('A').get('c').satisfied_at).toEqual(new Date('2026-01-01T10:00:00Z'));
  });

  test('two requirements with DIFFERENT lists share the one read and stay separate', async () => {
    const db = stubDb(script());
    const out = await detectors.DETECTORS.event.batchResolve(db, ['A'], [
      req('iss_held', 'event', listCfg()),
      req('formal_only', 'event', { source: 'appt', kind_or_type: ['iss'] }),
    ]);
    expect(db.calls.length).toBe(3);
    expect(out.get('A').get('iss_held').satisfied_at).toEqual(new Date('2026-06-02T10:00:00Z'));
    expect(out.get('A').get('formal_only').satisfied_at).toEqual(new Date('2025-01-15T10:00:00Z'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// manual detector
// ─────────────────────────────────────────────────────────────────────────────

describe('manual detector', () => {
  test('ZERO queries, never satisfies', async () => {
    const db = stubDb([]);
    const out = await detectors.DETECTORS.manual.batchResolve(db, ['A'],
      [req('lead_manual', 'manual', null)]);
    expect(db.calls.length).toBe(0);
    expect(out.size).toBe(0);
  });

  test('validateConfig: blank only', () => {
    expect(detectors.validateDetectorConfig('manual', null)).toBeNull();
    expect(detectors.validateDetectorConfig('manual', {})).toBeNull();
    expect(detectors.validateDetectorConfig('manual', { x: 1 })).toMatch(/no config/);
  });

  test('unknown detector key is itself a validation error', () => {
    expect(detectors.validateDetectorConfig('nope', {})).toMatch(/unknown detector/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolver fixtures — Intake (tpl 1) + Chapter 7 (tpl 2), Slice-A shapes
// ─────────────────────────────────────────────────────────────────────────────

const TPL_INTAKE = { id: 1, name: 'Intake', case_type: '', case_subtype: '', role: 'intake', is_default: 0, active: 1 };
const TPL_CH7    = { id: 2, name: 'Bankruptcy — Chapter 7', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', role: 'case', is_default: 0, active: 1 };

const ST_LEAD  = { id: 101, template_id: 1, stage_key: 'lead',        stage_number: 1, lane: 'main' };
const ST_DOCS  = { id: 201, template_id: 2, stage_key: 'docs',        stage_number: 1, lane: 'main' };
const ST_FILED = { id: 202, template_id: 2, stage_key: 'filed',       stage_number: 2, lane: 'main' };
const ST_341   = { id: 203, template_id: 2, stage_key: 'meeting_341', stage_number: 3, lane: 'main' };

const reqRow = (id, stage_id, key, detector, cfg, extra = {}) => ({
  id, stage_id, requirement_key: key,
  internal_label: key, client_label: null, client_visible: 1, required: 1,
  owner: 'client', kind: 'task', hint: null, effort: null, group_label: null,
  detector, detector_config: cfg, sort_order: id % 100, active: 1, ...extra,
});

// 7 requirements across both templates.
const R_INTAKE_FORM = reqRow(1, 101, 'intake_form',     'form',      { form_key: 'intake' });
const R_LEAD_MANUAL = reqRow(2, 101, 'lead_manual',     'manual',    null);
const R_DOCS_RCVD   = reqRow(3, 201, 'docs_received',   'checklist', { tag: 'docs_needed' });
const R_RETAINER    = reqRow(4, 201, 'retainer_signed', 'esign',     { kind: 'contract' });
const R_BUDGET      = reqRow(5, 201, 'budget_manual',   'manual',    null);
const R_PETITION    = reqRow(6, 202, 'petition_manual', 'manual',    null);
// U5: the selector's VALUES are registry keys now. Shape unchanged.
const R_M341        = reqRow(7, 203, 'm341_held',       'event',     { source: 'appt', kind_or_type: 'meeting_341' });

describe('resolveRequirements — precedence matrix', () => {
  // CASE1: at 'filed' (tpl 2). CASE3: at 'docs' (tpl 2). Both phase 'case'.
  // Detector kind order (first appearance): form, manual, checklist, esign,
  // event → scripted detector queries: form(1), checklist(2), esign(1),
  // event(3 — U5: caseEventService.listForCases is cases/events/appts);
  // manual issues none.
  function masterDb() {
    return stubDb([
      [ // 1 cases
        { case_id: 'CASE1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' },
        { case_id: 'CASE3', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' },
      ],
      [TPL_INTAKE, TPL_CH7],                                   // 2 templates
      [ST_LEAD, ST_DOCS, ST_FILED, ST_341],                    // 3 stages
      [R_INTAKE_FORM, R_LEAD_MANUAL, R_DOCS_RCVD, R_RETAINER,  // 4 requirements
       R_BUDGET, R_PETITION, R_M341],
      [ // 5 latest log per case
        { case_id: 'CASE1', template_id: 2, stage_key: 'filed' },
        { case_id: 'CASE3', template_id: 2, stage_key: 'docs' },
      ],
      [ // 6 overrides
        { case_id: 'CASE1', requirement_key: 'docs_received', status: 'na',
          note: 'not needed', set_by: 5, updated_at: '2026-05-05 09:00:00' },
        { case_id: 'CASE1', requirement_key: 'petition_manual', status: 'done',
          note: null, set_by: 5, updated_at: '2026-06-06 09:00:00' },
      ],
      [ // 7 form — CASE1's questionnaire, submitted in March
        { link_id: 'CASE1', form_key: 'intake', submitted_at: '2026-03-05 10:00:00' },
      ],
      [ // 8 checklist lists — CASE1 complete (but overridden na), CASE3 underway
        { id: 900, link: 'CASE1', tag: 'docs_needed', status: 'complete',   updated_date: '2026-04-01 12:00:00' },
        { id: 901, link: 'CASE3', tag: 'docs_needed', status: 'incomplete', updated_date: '2026-08-01 12:00:00' },
      ],
      [ // 9 checklist items
        { checklist_id: 900, total: 8, done: 8 },
        { checklist_id: 901, total: 8, done: 2 },
      ],
      [ // 10 esign — CASE1 signed the contract
        { linkable_id: 'CASE1', kind: 'contract', status: 'signed',
          completed_at: '2026-02-01 10:00:00', updated_at: null, created_at: null },
      ],
      // 11–13 event — listForCases: cases, events, appts. The cases row must be
      // present or the read layer short-circuits after query 11 and the budget
      // assertion below silently lands back on 11.
      [
        { case_id: 'CASE1', case_number: null, case_number_full: null },
        { case_id: 'CASE3', case_number: null, case_number_full: null },
      ],
      [],                                                      // 12 events — none
      [],                                                      // 13 appts — no 341s
    ]);
  }

  const byKey = (list) => Object.fromEntries(list.map((r) => [r.requirement_key, r]));

  test('BATCHED: 2 cases × 7 requirements = 13 queries, and every precedence rule at once', async () => {
    const db = masterDb();
    const out = await reqSvc.resolveRequirements(db, ['CASE1', 'CASE3']);
    // 11 before U5; the event detector traded its single appt query for
    // caseEventService.listForCases (3). Still a CONSTANT for N cases × M
    // requirements, which is the property this assertion exists to prove.
    expect(db.calls.length).toBe(13);                       // the whole-pass batching proof

    const c1 = byKey(out.get('CASE1'));
    const c3 = byKey(out.get('CASE3'));

    // Rule 2 beats rule 3 — THE FILED-CASE QUESTIONNAIRE: intake-template
    // requirement, cross-template behind, but the form was submitted in
    // March → 'done', never 'skipped'.
    expect(c1.intake_form.status).toBe('done');
    expect(c1.intake_form.satisfied_at).toBe('2026-03-05 10:00:00');
    expect(c1.intake_form.stage_key).toBe('lead');

    // Rule 3b — cross-template behind: unsatisfied intake requirement on a
    // case whose latest log row is on a role='case' template → skipped.
    expect(c1.lead_manual.status).toBe('skipped');

    // Rule 1 — override 'na' beats a SATISFIED detector; detector facts
    // (progress) still ride along.
    expect(c1.docs_received.status).toBe('na');
    expect(c1.docs_received.satisfied_at).toBeNull();
    expect(c1.docs_received.progress).toBe('8 of 8 received');
    expect(c1.docs_received.override).toEqual(
      { status: 'na', note: 'not needed', set_by: 5, at: '2026-05-05 09:00:00' });

    // Rule 2 beats rule 3a — same-template behind but esign-satisfied → done.
    expect(c1.retainer_signed.status).toBe('done');
    expect(c1.retainer_signed.satisfied_at).toBe('2026-02-01 10:00:00');

    // Rule 3a — same-template behind, unsatisfied manual → skipped.
    expect(c1.budget_manual.status).toBe('skipped');

    // Rule 1 — override 'done' supplies satisfied_at = override.at
    // (manual detector can never do it itself).
    expect(c1.petition_manual.status).toBe('done');
    expect(c1.petition_manual.satisfied_at).toBe('2026-06-06 09:00:00');

    // Rule 4 — ahead → upcoming.
    expect(c1.m341_held.status).toBe('upcoming');

    // CASE3 (at 'docs'):
    expect(c3.intake_form.status).toBe('skipped');          // cross-behind, unsatisfied
    expect(c3.docs_received.status).toBe('active');         // current stage
    expect(c3.docs_received.progress).toBe('2 of 8 received');
    expect(c3.retainer_signed.status).toBe('active');       // current, unsatisfied
    expect(c3.budget_manual.status).toBe('active');         // manual + no override: never done
    expect(c3.petition_manual.status).toBe('upcoming');
    expect(c3.m341_held.status).toBe('upcoming');

    // Ordering: intake-template requirements first (pipeline chronology),
    // then the resolved template's, stage order then sort order.
    expect(out.get('CASE1').map((r) => r.requirement_key)).toEqual([
      'intake_form', 'lead_manual',
      'docs_received', 'retainer_signed', 'budget_manual',
      'petition_manual', 'm341_held',
    ]);
  });

  test('no pipeline history → everything upcoming, nothing active (intake case)', async () => {
    const db = stubDb([
      [{ case_id: 'NEW1', case_type: 'Bankruptcy', case_subtype: '', pipeline_phase: 'intake' }],
      [TPL_INTAKE, TPL_CH7],
      [ST_LEAD],                     // phase intake → applicable = intake only
      [R_INTAKE_FORM, R_LEAD_MANUAL],
      [],                            // no log rows
      [],                            // no overrides
      [],                            // form query — nothing submitted
      // manual: no query
    ]);
    const out = await reqSvc.resolveRequirements(db, ['NEW1']);
    expect(db.calls.length).toBe(7);
    const list = out.get('NEW1');
    expect(list.map((r) => r.status)).toEqual(['upcoming', 'upcoming']);
    expect(list.some((r) => r.status === 'active')).toBe(false);
  });

  test('empty requirement tables short-circuit — the zero-behavior deploy gate', async () => {
    const db = stubDb([
      [{ case_id: 'CASE1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      [TPL_INTAKE, TPL_CH7],
      [ST_LEAD, ST_DOCS, ST_FILED, ST_341],
      [],                            // zero requirement rows → stop here
    ]);
    const out = await reqSvc.resolveRequirements(db, ['CASE1']);
    expect(db.calls.length).toBe(4); // no log/override/detector queries spent
    expect(out.get('CASE1')).toEqual([]);
  });

  test('unknown case ids are absent from the result map', async () => {
    const db = stubDb([[]]);         // cases query returns nothing
    const out = await reqSvc.resolveRequirements(db, ['GHOST']);
    expect(out.size).toBe(0);
    expect(db.calls.length).toBe(1);
  });

  test('clientOnly filters at the requirements query', async () => {
    const db = stubDb([
      [{ case_id: 'CASE1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      [TPL_INTAKE, TPL_CH7],
      [ST_LEAD, ST_DOCS, ST_FILED, ST_341],
      [],                            // (filtered) requirements — empty is fine
    ]);
    await reqSvc.resolveRequirements(db, ['CASE1'], { clientOnly: true });
    expect(db.calls[3].sql).toContain('client_visible = 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C1 — getPipeline default payload unchanged; opt-in attaches per stage
// ─────────────────────────────────────────────────────────────────────────────

describe('getPipeline C1 contract (R2)', () => {
  const CASE_ROW = { case_id: 'CASE1', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' };
  const GP_STAGES = [
    { stage_id: 201, stage_key: 'docs',  stage_number: 1, internal_label: 'Documents & Prep',
      client_label: 'Preparing your case', case_stage: 'Pending', is_terminal: 0, lane: 'main',
      default_rec: '', client_visible: 1 },
    { stage_id: 202, stage_key: 'filed', stage_number: 2, internal_label: 'Filed',
      client_label: 'Your case is filed', case_stage: 'Filed', is_terminal: 0, lane: 'main',
      default_rec: '', client_visible: 1 },
  ];
  const LOG_ROW = { stage_id: 201, stage_key: 'docs', case_stage: 'Pending', status_label: 'Documents & Prep',
    entered_at: '2026-07-01 09:00:00', entered_by: 1, source: 'manual', note: null };

  test('DEFAULT payload: exact key set, no `requirements` anywhere, no extra queries', async () => {
    const db = stubDb([
      [CASE_ROW],
      [TPL_INTAKE, TPL_CH7],
      [LOG_ROW],
      GP_STAGES.map((s) => ({ ...s })),
    ]);
    const payload = await pipelineSvc.getPipeline(db, 'CASE1');
    expect(db.calls.length).toBe(4);                        // exactly today's four
    expect(Object.keys(payload).sort()).toEqual(
      ['current', 'history', 'stages', 'template', 'upcoming']);
    for (const s of payload.stages) {
      expect('requirements' in s).toBe(false);
    }
  });

  test('{ requirements:true } attaches per-stage arrays; empty tables → [] (deploy gate)', async () => {
    const db = stubDb([
      [CASE_ROW],
      [TPL_INTAKE, TPL_CH7],
      [LOG_ROW],
      GP_STAGES.map((s) => ({ ...s })),
      // resolveRequirements (empty-tables short-circuit): cases, templates,
      // stages, requirements
      [CASE_ROW],
      [TPL_INTAKE, TPL_CH7],
      [ST_LEAD, ST_DOCS, ST_FILED, ST_341],
      [],
    ]);
    const payload = await pipelineSvc.getPipeline(db, 'CASE1', { requirements: true });
    expect(db.calls.length).toBe(8);
    for (const s of payload.stages) {
      expect(s.requirements).toEqual([]);
    }
  });

  test('{ requirements:true } filters resolved rows to each stage by stage_id', async () => {
    const db = stubDb([
      [CASE_ROW],
      [TPL_INTAKE, TPL_CH7],
      [LOG_ROW],
      GP_STAGES.map((s) => ({ ...s })),
      // resolveRequirements: one manual requirement on 'docs' (201)
      [CASE_ROW],
      [TPL_INTAKE, TPL_CH7],
      [ST_LEAD, ST_DOCS, ST_FILED, ST_341],
      [R_BUDGET],
      [{ case_id: 'CASE1', template_id: 2, stage_key: 'docs' }],   // latest
      [],                                                          // overrides
      // manual detector: no query
    ]);
    const payload = await pipelineSvc.getPipeline(db, 'CASE1', { requirements: true });
    const docs = payload.stages.find((s) => s.stage_key === 'docs');
    const filed = payload.stages.find((s) => s.stage_key === 'filed');
    expect(docs.requirements.map((r) => r.requirement_key)).toEqual(['budget_manual']);
    expect(docs.requirements[0].status).toBe('active');
    expect(filed.requirements).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Overrides service
// ─────────────────────────────────────────────────────────────────────────────

describe('overrides', () => {
  const CASE_HIT = [{ case_id: 'CASE1' }];

  test('setOverride happy path: upsert + type=status case log row', async () => {
    const db = stubDb([
      CASE_HIT,                       // case exists
      [{ n: 2 }],                     // key exists on active requirements
      { affectedRows: 1 },            // upsert
      { insertId: 77 },               // createLogEntry INSERT
    ]);
    const out = await reqSvc.setOverride(db, 'CASE1', 'docs_received',
      { status: 'na', note: 'client is a renter', userId: 5 });
    expect(out).toEqual({ case_id: 'CASE1', requirement_key: 'docs_received',
      status: 'na', note: 'client is a renter' });
    const upsert = db.calls[2];
    expect(upsert.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(upsert.params).toEqual(['CASE1', 'docs_received', 'na', 'client is a renter', 5]);
    const log = db.calls[3];
    expect(log.sql).toContain('INSERT INTO log');
    expect(log.params[0]).toBe('status');                   // log_type — the advance convention
    expect(log.params[1]).toBe('CASE1');                    // log_link
  });

  test('clearOverride happy path: DELETE + log row; 404 when nothing to clear', async () => {
    const db = stubDb([
      CASE_HIT,
      { affectedRows: 1 },
      { insertId: 78 },
    ]);
    const out = await reqSvc.clearOverride(db, 'CASE1', 'docs_received', { userId: 5 });
    expect(out).toEqual({ cleared: true, case_id: 'CASE1', requirement_key: 'docs_received' });
    expect(db.calls[1].sql.startsWith('DELETE')).toBe(true);

    const db2 = stubDb([CASE_HIT, { affectedRows: 0 }]);
    await expect(reqSvc.clearOverride(db2, 'CASE1', 'docs_received'))
      .rejects.toMatchObject({ status: 404 });
  });

  test('bad status → 400 before any query; every other state is derived', async () => {
    const db = stubDb([]);
    await expect(reqSvc.setOverride(db, 'CASE1', 'k', { status: 'skipped' }))
      .rejects.toMatchObject({ status: 400 });
    expect(db.calls.length).toBe(0);
  });

  test('unknown case → 404', async () => {
    const db = stubDb([[]]);
    await expect(reqSvc.setOverride(db, 'GHOST', 'k', { status: 'na' }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('unknown requirement key → 400 (typo, not future-proofing)', async () => {
    const db = stubDb([CASE_HIT, [{ n: 0 }]]);
    await expect(reqSvc.setOverride(db, 'CASE1', 'tpyo_key', { status: 'na' }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('tpyo_key') });
  });

  test('note clipped to 255 (lax sql_mode would clip silently); null userId → set_by 0', async () => {
    const db = stubDb([
      CASE_HIT, [{ n: 1 }], { affectedRows: 1 }, { insertId: 79 },
    ]);
    await reqSvc.setOverride(db, 'CASE1', 'docs_received',
      { status: 'done', note: 'x'.repeat(300) });
    const upsert = db.calls[2];
    expect(upsert.params[3].length).toBe(255);
    expect(upsert.params[4]).toBe(0);                       // created_by-style 0 = system
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// case_field detector (R2.6 Tier 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('case_field detector', () => {
  test('validateConfig: unknown key / non-whitelist field / non-object rejected; happy null', () => {
    expect(detectors.validateDetectorConfig('case_field', { fields: 'x' }))
      .toMatch(/unknown config key/);
    const bad = detectors.validateDetectorConfig('case_field', { field: 'case_caption' });
    expect(bad).toMatch(/field must be one of/);
    expect(bad).toContain('case_open_date');          // message lists the whitelist
    expect(detectors.validateDetectorConfig('case_field', [1])).toMatch(/object/);
    expect(detectors.validateDetectorConfig('case_field', { field: 'case_discharge_date' }))
      .toBeNull();
  });

  test('BATCHED: 2 cases × 2 field-requirements = ONE query with the union column list', async () => {
    const db = stubDb([[
      { case_id: 'A', case_file_date: '2026-01-15', docs_due: null },
      { case_id: 'B', case_file_date: null, docs_due: new Date(2026, 4, 9) },
    ]]);
    const out = await detectors.DETECTORS.case_field.batchResolve(db, ['A', 'B'], [
      req('filed', 'case_field', { field: 'case_file_date' }),
      req('docs_deadline_set', 'case_field', { field: 'docs_due' }),
    ]);
    expect(db.calls.length).toBe(1);                            // the batching proof
    expect(db.calls[0].sql).toContain('case_file_date, docs_due');
    expect(db.calls[0].params).toEqual([['A', 'B']]);

    const a = out.get('A').get('filed');
    expect(a.satisfied_at).toBe('2026-01-15');                  // raw column value
    expect(a.detail).toBe('2026-01-15');
    expect(a.progress).toBeNull();
    expect(out.get('A').has('docs_deadline_set')).toBe(false);  // NULL → unsatisfied
    expect(out.get('B').has('filed')).toBe(false);
    // Date objects format from LOCAL parts (a local-midnight DATE must not
    // shift to the previous UTC day).
    expect(out.get('B').get('docs_deadline_set').detail).toBe('2026-05-09');
  });

  test('same-key dedup: first config wins; single-column query', async () => {
    const db = stubDb([[{ case_id: 'A', case_file_date: '2026-01-15' }]]);
    const out = await detectors.DETECTORS.case_field.batchResolve(db, ['A'], [
      req('dup', 'case_field', { field: 'case_file_date' }),
      req('dup', 'case_field', { field: 'docs_due' }),
    ]);
    expect(db.calls[0].sql).toContain('case_file_date');
    expect(db.calls[0].sql).not.toContain('docs_due');
    expect(out.get('A').get('dup').satisfied_at).toBe('2026-01-15');
  });

  test('empty caseIds / empty reqs short-circuit with ZERO queries', async () => {
    const db = stubDb([]);
    expect((await detectors.DETECTORS.case_field.batchResolve(db, [], [
      req('filed', 'case_field', { field: 'case_file_date' }),
    ])).size).toBe(0);
    expect((await detectors.DETECTORS.case_field.batchResolve(db, ['A'], [])).size).toBe(0);
    expect(db.calls.length).toBe(0);
  });

  test('read-time guard: stored non-whitelist field warns, resolves unsatisfied, never reaches SQL', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = stubDb([]);
      const out = await detectors.DETECTORS.case_field.batchResolve(db, ['A'], [
        req('sneaky', 'case_field', { field: 'case_caption; DROP TABLE cases' }),
      ]);
      expect(out.size).toBe(0);
      expect(db.calls.length).toBe(0);                          // filtered before the query
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sneaky'));
    } finally { warn.mockRestore(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// report detector (R2.6 Tier 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('report detector', () => {
  beforeEach(() => {
    reportService.getReport.mockReset();
    reportService.runReport.mockReset();
  });

  test('validateConfig (sync shape): unknown key / blank / overlong rejected; happy null', () => {
    expect(detectors.validateDetectorConfig('report', { key: 'x' }))
      .toMatch(/unknown config key/);
    expect(detectors.validateDetectorConfig('report', { report_key: '' }))
      .toMatch(/non-empty string/);
    expect(detectors.validateDetectorConfig('report', { report_key: 'a'.repeat(61) }))
      .toMatch(/60/);
    expect(detectors.validateDetectorConfig('report', { report_key: 'req_tax_returns' }))
      .toBeNull();
  });

  describe('validateConfigDb', () => {
    const vdb = (db, cfg) => detectors.DETECTORS.report.validateConfigDb(db, cfg);

    test('missing report → error naming the key; getReport never called', async () => {
      const db = stubDb([[]]);
      expect(await vdb(db, { report_key: 'ghost' })).toMatch(/no report with report_key "ghost"/);
      expect(reportService.getReport).not.toHaveBeenCalled();
    });

    test('inactive report → error', async () => {
      const db = stubDb([[{ id: 9 }]]);
      reportService.getReport.mockResolvedValue({ is_active: 0, params: [] });
      expect(await vdb(db, { report_key: 'req_x' })).toMatch(/inactive/);
      expect(reportService.runReport).not.toHaveBeenCalled();
    });

    test('report with params → error (zero-params contract)', async () => {
      const db = stubDb([[{ id: 9 }]]);
      reportService.getReport.mockResolvedValue({ is_active: 1, params: [{ name: 'x' }] });
      expect(await vdb(db, { report_key: 'req_x' })).toMatch(/zero/);
    });

    test('runReport throw surfaces as the error message', async () => {
      const db = stubDb([[{ id: 9 }]]);
      reportService.getReport.mockResolvedValue({ is_active: 1, params: [] });
      reportService.runReport.mockRejectedValue(new Error('EXPLAIN refused: full scan'));
      expect(await vdb(db, { report_key: 'req_x' }))
        .toMatch(/failed to run: EXPLAIN refused/);
    });

    test('missing required columns → error naming them (zero rows is fine — fields carry names)', async () => {
      const db = stubDb([[{ id: 9 }]]);
      reportService.getReport.mockResolvedValue({ is_active: 1, params: [] });
      reportService.runReport.mockResolvedValue({ rows: [], fields: [{ name: 'case_id' }] });
      expect(await vdb(db, { report_key: 'req_x' })).toMatch(/satisfied_at/);
    });

    test('happy path: runs the report exactly once as userId 0', async () => {
      const db = stubDb([[{ id: 9 }]]);
      reportService.getReport.mockResolvedValue({ is_active: 1, params: [] });
      reportService.runReport.mockResolvedValue({
        rows: [], fields: [{ name: 'case_id' }, { name: 'satisfied_at' }],
      });
      expect(await vdb(db, { report_key: 'req_x' })).toBeNull();
      expect(reportService.runReport).toHaveBeenCalledTimes(1);
      expect(reportService.runReport).toHaveBeenCalledWith(db, 9, {}, 0);
    });
  });

  describe('batchResolve', () => {
    test('ONE key→id lookup + one runReport per unique key; hits mapped with String() normalization', async () => {
      const db = stubDb([[{ id: 9, report_key: 'req_x' }]]);
      reportService.runReport.mockResolvedValue({
        rows: [
          { case_id: 12, satisfied_at: '2026-03-01', detail: 'Received' },
          { case_id: 'B', satisfied_at: null, detail: '2 of 5', progress: '2/5' },
        ],
        fields: [{ name: 'case_id' }, { name: 'satisfied_at' }],
      });
      const out = await detectors.DETECTORS.report.batchResolve(db, [12, 'B', 'C'], [
        req('tax_returns', 'report', { report_key: 'req_x' }),
        req('tax_returns_again', 'report', { report_key: 'req_x' }),   // same key: still 1 run
      ]);
      expect(db.calls.length).toBe(1);                              // the ONLY direct query
      expect(db.calls[0].params).toEqual([['req_x']]);
      expect(reportService.runReport).toHaveBeenCalledTimes(1);
      expect(reportService.runReport).toHaveBeenCalledWith(db, 9, {}, 0);

      expect(out.get('12').get('tax_returns').satisfied_at).toBe('2026-03-01');
      expect(out.get('12').get('tax_returns_again').satisfied_at).toBe('2026-03-01');
      // NULL satisfied_at row = unsatisfied hit that still carries progress
      const b = out.get('B').get('tax_returns');
      expect(b.satisfied_at).toBeNull();
      expect(b.progress).toBe('2/5');
      expect(out.has('C')).toBe(false);
    });

    test('two distinct keys → two runReport calls, one lookup', async () => {
      const db = stubDb([[{ id: 9, report_key: 'req_x' }, { id: 11, report_key: 'req_y' }]]);
      reportService.runReport.mockResolvedValue({ rows: [], fields: [] });
      await detectors.DETECTORS.report.batchResolve(db, ['A'], [
        req('one', 'report', { report_key: 'req_x' }),
        req('two', 'report', { report_key: 'req_y' }),
      ]);
      expect(db.calls.length).toBe(1);
      expect(reportService.runReport).toHaveBeenCalledTimes(2);
    });

    test('FAIL-SOFT: runReport throw → warn naming requirement + key, all unsatisfied, no throw', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const db = stubDb([[{ id: 9, report_key: 'req_x' }]]);
        reportService.runReport.mockRejectedValue(new Error('manifest retired table'));
        const out = await detectors.DETECTORS.report.batchResolve(db, ['A'], [
          req('tax_returns', 'report', { report_key: 'req_x' }),
        ]);
        expect(out.size).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tax_returns[\s\S]*req_x[\s\S]*manifest retired/));
      } finally { warn.mockRestore(); }
    });

    test('FAIL-SOFT: report_key not found → warn, unsatisfied, runReport never called', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const db = stubDb([[]]);
        const out = await detectors.DETECTORS.report.batchResolve(db, ['A'], [
          req('tax_returns', 'report', { report_key: 'ghost' }),
        ]);
        expect(out.size).toBe(0);
        expect(reportService.runReport).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
      } finally { warn.mockRestore(); }
    });

    test('duplicate rows for one case: satisfied beats unsatisfied', async () => {
      const db = stubDb([[{ id: 9, report_key: 'req_x' }]]);
      reportService.runReport.mockResolvedValue({
        rows: [
          { case_id: 'A', satisfied_at: null, progress: '1/2' },
          { case_id: 'A', satisfied_at: '2026-02-02' },
        ],
        fields: [],
      });
      const out = await detectors.DETECTORS.report.batchResolve(db, ['A'], [
        req('r', 'report', { report_key: 'req_x' }),
      ]);
      expect(out.get('A').get('r').satisfied_at).toBe('2026-02-02');
    });

    test('empty caseIds / empty reqs short-circuit: zero queries, zero runs', async () => {
      const db = stubDb([]);
      expect((await detectors.DETECTORS.report.batchResolve(db, [], [
        req('r', 'report', { report_key: 'req_x' }),
      ])).size).toBe(0);
      expect((await detectors.DETECTORS.report.batchResolve(db, ['A'], [])).size).toBe(0);
      expect(db.calls.length).toBe(0);
      expect(reportService.runReport).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (R3) getCaseRequirements — the single-case HTTP surface
// ─────────────────────────────────────────────────────────────────────────────
//
// The function exists for ONE reason, and it is the reason these tests pin:
// resolveRequirements is BATCH-shaped and short-circuits to an empty map when
// no templates / stages / requirements exist, so `map.has(caseId)` cannot tell
// "no such case" from "no requirements authored". A route inferring 404 from an
// absent key would 404 every real case in the firm until Fred authored his
// first requirement. Hence the explicit existence read — and hence the second
// test below, which is the one that would catch it coming back.
//
// The route layer (envelope, status mapping, ?client_only=) has its own suite:
// tests/pipelineRequirementsRoute.test.js.

describe('(R3) getCaseRequirements', () => {
  test('unknown case → 404, and NOTHING else runs', async () => {
    const db = stubDb([[]]);                    // the existence read finds nothing
    await expect(reqSvc.getCaseRequirements(db, 'NOPE'))
      .rejects.toMatchObject({ status: 404, message: 'Case NOPE not found' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toBe('SELECT case_id FROM cases WHERE case_id = ?');
  });

  test('REAL case, NOTHING AUTHORED → [] — an empty work list is a valid answer, not a 404', async () => {
    const db = stubDb([
      [{ case_id: 'TYL6KJN8' }],                                        // existence
      [{ case_id: 'TYL6KJN8', case_type: 'Bankruptcy',                  // resolver: cases
         case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      [{ id: 1, role: 'intake', active: 1, case_type: '', case_subtype: '' },
       { id: 2, role: 'case', active: 1, case_type: 'Bankruptcy',       // resolver: templates
         case_subtype: 'Chapter 7' }],
      [{ id: 5, template_id: 2, stage_key: 'docs', stage_number: 2, lane: 'main' }],
      [],                                                               // requirements: NONE
    ]);
    await expect(reqSvc.getCaseRequirements(db, 'TYL6KJN8')).resolves.toEqual([]);
  });

  test('BOTH templates come back on a phase-`case` case — the F2 surface', async () => {
    // Intake rows resolve `skipped` by rule 3b (latest log row is on a
    // role='case' template) and are visible HERE and nowhere else over HTTP.
    const db = stubDb([
      [{ case_id: 'C1' }],                                              // existence
      [{ case_id: 'C1', case_type: 'Bankruptcy',                        // cases
         case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      [{ id: 1, role: 'intake', active: 1, case_type: '', case_subtype: '' },
       { id: 2, role: 'case', active: 1, case_type: 'Bankruptcy',       // templates
         case_subtype: 'Chapter 7' }],
      [{ id: 2, template_id: 1, stage_key: 'consult_booked', stage_number: 2, lane: 'main' },
       { id: 5, template_id: 2, stage_key: 'docs', stage_number: 2, lane: 'main' }],
      [{ id: 10, stage_id: 2, requirement_key: 'submit_questionnaire', detector: 'manual',
         internal_label: 'Submit intake questionnaire', client_label: 'Complete your questionnaire',
         client_visible: 1, required: 1, owner: 'client', kind: 'task', hint: null,
         effort: null, group_label: 'Intake', sort_order: 1 },
       { id: 11, stage_id: 5, requirement_key: 'upload_docs', detector: 'manual',
         internal_label: 'Upload requested documents', client_label: 'Upload your documents',
         client_visible: 1, required: 1, owner: 'client', kind: 'task', hint: null,
         effort: null, group_label: 'Documents', sort_order: 1 }],
      [{ case_id: 'C1', template_id: 2, stage_key: 'docs' }],           // latest log
      [],                                                               // overrides
    ]);
    const out = await reqSvc.getCaseRequirements(db, 'C1');
    expect(out.map(r => [r.requirement_key, r.status])).toEqual([
      ['submit_questionnaire', 'skipped'],   // intake first — pipeline chronology
      ['upload_docs', 'active'],
    ]);
  });

  test('the CANONICAL case_id from `cases` keys the resolver (collation is case-insensitive)', async () => {
    const db = stubDb([
      [{ case_id: 'TYL6KJN8' }],
      [{ case_id: 'TYL6KJN8', case_type: 'Bankruptcy',
         case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      [{ id: 1, role: 'intake', active: 1, case_type: '', case_subtype: '' }],
      [{ id: 2, template_id: 1, stage_key: 'consult_booked', stage_number: 2, lane: 'main' }],
      [],
    ]);
    await expect(reqSvc.getCaseRequirements(db, 'tyl6kjn8')).resolves.toEqual([]);
    expect(db.calls[1].params).toEqual([['TYL6KJN8']]);   // the DB's casing, not the caller's
  });

  test('clientOnly rides through to the resolver query', async () => {
    const db = stubDb([
      [{ case_id: 'X' }],
      [{ case_id: 'X', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' }],
      [{ id: 1, role: 'intake', active: 1, case_type: '', case_subtype: '' }],
      [{ id: 2, template_id: 1, stage_key: 'consult_booked', stage_number: 2, lane: 'main' }],
      [],
    ]);
    await reqSvc.getCaseRequirements(db, 'X', { clientOnly: true });
    const q = db.calls.find(c => c.sql.includes('pipeline_stage_requirements'));
    expect(q.sql).toContain('client_visible = 1');
  });
});
