/**
 * tests/courtexecutor.convert.test.js
 *
 * Chapter-conversion dispatch fixes (2026-10-05; the 26-31193 India Gragg
 * voluntary 13→7 conversion is the live shape):
 *
 *   npx jest tests/courtexecutor.convert.test.js
 *
 * Contract under test:
 *   FIELDS FIRST  — update_case_fields dispatches BEFORE create_appointment
 *                   regardless of payload order: the cases.case_chapter
 *                   UPDATE must land before apptService.createAppt runs,
 *                   because createAppt's pre_appt enrollment flattens
 *                   cases.case_chapter into trigger_data (enrollment 189
 *                   recorded "13" on a case the same payload converted to 7;
 *                   a Ch11→Ch7 conversion would route the new 341 to the
 *                   Ch11 placeholder rung — no client reminders).
 *   SWEEP         — a case_chapter write LEAVING '13' cancels future
 *                   Scheduled Ch13-only events (confirmation_hearing,
 *                   object_confirmation_due, confirmation_certificate_
 *                   deadline) via eventService.cancelEvent, with structured
 *                   event/cancel change rows (revert-compatible) and
 *                   applied entries. POC/dischargeability rows survive.
 *   TYPE DRIFT    — rows match on type_key OR normalized event_type
 *                   ('Confirmation Hearing' wf24 shape, NULL type_key).
 *   RESOLUTION    — deadline kinds cancel with resolution 'moot';
 *                   hearings/conferences take the service default
 *                   ('moot' is deadline-only per U6a).
 *   FLOOR IN SQL  — the sweep SELECT itself carries the Scheduled + future
 *                   (CURDATE()) floor, the update_event branch's precedent.
 *   13→11 SWEEPS  — any exit from 13 moots the Ch13 confirmation machinery.
 *   NO SWEEP      — a noop/replay chapter write (equal value) and a
 *                   fill-in write (''→'7': chapter was never known to be
 *                   13) never sweep.
 *   DRY-RUN       — sweep plan recorded (applied + change rows),
 *                   cancelEvent NOT called.
 *   ISOLATION     — one failed cancelEvent skips that row
 *                   (conversion_sweep_cancel_failed) without aborting the
 *                   batch or losing the sibling cancels.
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const CASE_ROW = {
  found: true,
  case_id: 'YSHZLitl',
  case_number: '26-31193',
  case_number_full: '26-31193-jda',
  case_caption: null,
  primary_contact_id: 1983,
  primary_contact_name: 'India Gragg',
};
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...CASE_ROW });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const eventService = require('../services/eventService');
const apptService = require('../services/apptService');
const roleResolver = require('../lib/caseRoleResolver');

const { executeCourtActions } = require('../services/courtExecutor');

// ─────────────────────────────────────────────────────────────
// Event fixtures — the 26-48181 post-conversion residue, plus the wf24
// label shape and the bar dates that must survive. All rows the stub
// returns are, by the SQL floor's definition, future + Scheduled; the
// floor itself is asserted textually on the captured SELECT.
// ─────────────────────────────────────────────────────────────
const EV = (event_id, type_key, kind, event_type, extra = {}) => ({
  event_id, type_key, kind, event_type,
  event_title: `${event_type} — India Gragg (26-31193)`,
  event_date: '2126-11-10', event_time: kind === 'hearing' ? '10:00:00' : null,
  event_all_day: kind === 'hearing' ? 0 : 1,
  event_location: null, event_calendar_id: kind === 'hearing' ? 'cal-stuart' : null,
  ...extra,
});
const SWEEP_SET = () => [
  EV(149, 'confirmation_hearing', 'hearing', 'Confirmation Hearing'),
  EV(150, 'object_confirmation_due', 'deadline', 'object_confirmation_due'),
  EV(151, 'confirmation_certificate_deadline', 'deadline', 'Confirmation Certificate Deadline'),
  EV(152, 'poc_due', 'deadline', 'poc_due'),                     // survives
  EV(153, 'poc_gov_due', 'deadline', 'poc_gov_due'),             // survives
  EV(154, 'dischargeability_due', 'deadline', 'dischargeability_due'), // survives
  EV(155, null, 'hearing', 'Confirmation Hearing'),              // wf24 shape: NULL type_key
];

// ─────────────────────────────────────────────────────────────
// db stub. The sweep SELECT is recognized by its `type_key, kind` select
// list; the curCaseRow loader by `FROM cases WHERE case_id=? LIMIT 1`;
// the 341 dupe guard by `SELECT appt_id FROM appts`. `ops` is the shared
// ordering log the FIELDS FIRST assertions read.
// ─────────────────────────────────────────────────────────────
function makeDb({ caseChapter = '13', events = [] } = {}) {
  const updates = [];
  const inserts = [];
  const ops = [];
  let sweepSelectSql = null;
  const query = jest.fn(async (sql, params = []) => {
    if (/type_key, kind/i.test(sql) && /FROM events/i.test(sql)) {
      sweepSelectSql = sql;
      ops.push('sweep_select');
      return [events.map(e => ({ ...e }))];
    }
    if (/SELECT appt_id FROM appts/i.test(sql)) return [[]];
    if (/FROM cases WHERE case_id=\? LIMIT 1/i.test(sql)) {
      return [[{
        case_file_date: null, case_judge: '', case_close_date: null,
        case_discharge_date: null, case_chapter: caseChapter,
        case_trustee: 'Melissa A. Caouette', case_objection: null, show_cause: null,
      }]];
    }
    if (/SELECT `value` FROM app_settings/i.test(sql)) return [[]];
    if (/^\s*UPDATE\b/i.test(sql)) {
      const u = { sql: sql.replace(/\s+/g, ' ').trim(), params };
      updates.push(u);
      if (/SET `case_chapter`=\?/i.test(u.sql)) ops.push('update_case_chapter');
      return [{ affectedRows: 1 }];
    }
    if (/^\s*INSERT\b/i.test(sql)) {
      inserts.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return [{ insertId: 77, affectedRows: 1 }];
    }
    return [[]];
  });
  return { query, updates, inserts, ops, getSweepSql: () => sweepSelectSql };
}

// The India Gragg payload order: create_appointment FIRST, exactly as the
// model emitted it on court_ai_log 997.
function conversionPayload({ chapter = '7', includeAppt = true, messageId = 'court-convert-run' } = {}) {
  const actions = [];
  if (includeAppt) {
    actions.push({
      type: 'create_appointment',
      fields: {
        date: '2126-11-09', time: '11:00', platform: 'Zoom',
        appt_type: '341 Meeting', trustee: 'Collene K. Corcoran',
        connection_info: 'Meeting ID 441 866 7436, Passcode 1002615478',
      },
    });
  }
  actions.push({
    type: 'update_case_fields',
    fields: { case_chapter: chapter, case_trustee: 'Collene K. Corcoran', case_objection: '2127-01-08' },
  });
  return {
    payload: {
      message_id: messageId,
      case_number: '26-31193-jda',
      case_name: 'India Gragg',
      classification: 'meeting_ch7',
      needs_review: false,
      actions,
    },
    subject: 'irrelevant (citations stubbed)',
    body: 'irrelevant (citations stubbed)',
  };
}

const sweepApplied = (res) =>
  res.applied.filter(a => a.field === 'conversion_event_sweep');

const realCreateAppt = apptService.createAppt;
const realResolveTrustee = roleResolver.resolveTrustee;
const realResolveJudge = roleResolver.resolveJudge;
const realCancelEvent = eventService.cancelEvent;
let dbRef; // set per-test so the createAppt mock can log ordering
beforeEach(() => {
  apptService.createAppt = jest.fn(async () => {
    if (dbRef) dbRef.ops.push('createAppt');
    return { appt_id: 3990 };
  });
  roleResolver.resolveTrustee = jest.fn(async () => 2067);
  roleResolver.resolveJudge = jest.fn(async () => null);
  eventService.cancelEvent = jest.fn(async () => ({ event: {} }));
});
afterAll(() => {
  apptService.createAppt = realCreateAppt;
  roleResolver.resolveTrustee = realResolveTrustee;
  roleResolver.resolveJudge = realResolveJudge;
  eventService.cancelEvent = realCancelEvent;
});

describe('dispatch order — update_case_fields before create_appointment', () => {
  test('FIELDS FIRST: payload lists the appt first; the chapter UPDATE still lands before createAppt', async () => {
    const db = makeDb({ caseChapter: '13', events: [] });
    dbRef = db;
    const res = await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    expect(res.outcome).toBe('executed');
    const iUpdate = db.ops.indexOf('update_case_chapter');
    const iAppt = db.ops.indexOf('createAppt');
    expect(iUpdate).toBeGreaterThanOrEqual(0);
    expect(iAppt).toBeGreaterThanOrEqual(0);
    expect(iUpdate).toBeLessThan(iAppt);
  });

  test('FIELDS FIRST: action_index stays the PAYLOAD index on both actions', async () => {
    const db = makeDb({ caseChapter: '13', events: [] });
    dbRef = db;
    const res = await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    const apptEntry = res.applied.find(a => a.entity_type === 'appt');
    const chapterEntry = res.applied.find(a => a.field === 'case_chapter');
    expect(apptEntry.action_index).toBe(0);     // appt was payload index 0
    expect(chapterEntry.action_index).toBe(1);  // fields were payload index 1
  });
});

describe('Ch13-exit conversion sweep', () => {
  test('SWEEP: 13→7 cancels the Ch13-only rows, bar dates survive, drift shape matches', async () => {
    const db = makeDb({ caseChapter: '13', events: SWEEP_SET() });
    dbRef = db;
    const res = await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    const cancelled = eventService.cancelEvent.mock.calls.map(c => c[1]).sort((a, b) => a - b);
    expect(cancelled).toEqual([149, 150, 151, 155]); // 152/153/154 survive

    const entries = sweepApplied(res);
    expect(entries).toHaveLength(4);
    expect(entries.every(e => e.entity_type === 'event')).toBe(true);
    expect(entries.every(e => e.action_index === 1)).toBe(true); // the update_case_fields payload index
  });

  test('RESOLUTION: deadlines cancel moot, hearings take the service default', async () => {
    const db = makeDb({ caseChapter: '13', events: SWEEP_SET() });
    dbRef = db;
    await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    const byId = Object.fromEntries(
      eventService.cancelEvent.mock.calls.map(c => [c[1], c[3] || {}]));
    expect(byId[150]).toEqual({ resolution: 'moot' });
    expect(byId[151]).toEqual({ resolution: 'moot' });
    expect(byId[149]).toEqual({});
    expect(byId[155]).toEqual({});
  });

  test('FLOOR IN SQL: the sweep SELECT itself is Scheduled + future-dated', async () => {
    const db = makeDb({ caseChapter: '13', events: SWEEP_SET() });
    dbRef = db;
    await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    const sql = db.getSweepSql();
    expect(sql).toMatch(/event_status='Scheduled'/);
    expect(sql).toMatch(/event_date >= CURDATE\(\)/);
    expect(sql).toMatch(/event_link_type='case_number' AND event_link_id=\?/);
  });

  test('CHANGE ROWS: structured event/cancel before-state, revert-arm compatible', async () => {
    const db = makeDb({ caseChapter: '13', events: SWEEP_SET() });
    dbRef = db;
    await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    const changeInserts = db.inserts.filter(i => /ai_change_log/i.test(i.sql));
    expect(changeInserts.length).toBeGreaterThan(0);
    // Hunt the event-149 cancel row across the flushed inserts' params.
    const rowParams = changeInserts.flatMap(i => [i.params.flat(Infinity)]);
    const flat = rowParams.flat(Infinity).map(String);
    const i149 = flat.findIndex(v => v === '149');
    expect(i149).toBeGreaterThanOrEqual(0);
    const oldState = JSON.parse(flat.find((v, idx) => idx > i149 && v.startsWith('{')));
    expect(oldState).toEqual({
      status: 'Scheduled', date: '2126-11-10', time: '10:00',
      all_day: 0, location: null, calendar_id: 'cal-stuart',
    });
  });

  test('13→11 SWEEPS: any exit from 13 moots the confirmation machinery', async () => {
    const db = makeDb({ caseChapter: '13', events: SWEEP_SET() });
    dbRef = db;
    await executeCourtActions(db, { ...conversionPayload({ chapter: '11', includeAppt: false }), dryRun: false });

    const cancelled = eventService.cancelEvent.mock.calls.map(c => c[1]).sort((a, b) => a - b);
    expect(cancelled).toEqual([149, 150, 151, 155]);
  });

  test('NO SWEEP on replay: an equal chapter write is a noop and never sweeps', async () => {
    const db = makeDb({ caseChapter: '7', events: SWEEP_SET() });
    dbRef = db;
    const res = await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    expect(eventService.cancelEvent).not.toHaveBeenCalled();
    expect(db.ops).not.toContain('sweep_select');
    expect(res.skipped.some(s => s.field === 'case_chapter' && s.reason === 'noop')).toBe(true);
  });

  test("NO SWEEP on fill-in: ''→'7' writes the chapter but the case was never known Ch13", async () => {
    const db = makeDb({ caseChapter: '', events: SWEEP_SET() });
    dbRef = db;
    const res = await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    expect(res.applied.some(a => a.field === 'case_chapter')).toBe(true); // the write happened
    expect(eventService.cancelEvent).not.toHaveBeenCalled();
    expect(db.ops).not.toContain('sweep_select');
  });

  test('DRY-RUN: sweep plan recorded, cancelEvent never called, no entity writes', async () => {
    const db = makeDb({ caseChapter: '13', events: SWEEP_SET() });
    dbRef = db;
    const res = await executeCourtActions(db, { ...conversionPayload(), dryRun: true });

    expect(eventService.cancelEvent).not.toHaveBeenCalled();
    expect(sweepApplied(res)).toHaveLength(4);
    expect(db.updates.filter(u => /SET `case_chapter`=\?/i.test(u.sql))).toHaveLength(0);
  });

  test('ISOLATION: one failed cancel skips that row, siblings still cancel', async () => {
    const db = makeDb({ caseChapter: '13', events: SWEEP_SET() });
    dbRef = db;
    eventService.cancelEvent = jest.fn(async (_db, eventId) => {
      if (eventId === 150) throw new Error('Event is already Canceled');
      return { event: {} };
    });
    const res = await executeCourtActions(db, { ...conversionPayload(), dryRun: false });

    expect(res.outcome).toBe('executed');
    const cancelled = eventService.cancelEvent.mock.calls.map(c => c[1]).sort((a, b) => a - b);
    expect(cancelled).toEqual([149, 150, 151, 155]); // attempted all four
    expect(sweepApplied(res).map(e => Number(e.entity_id)).sort((a, b) => a - b))
      .toEqual([149, 151, 155]); // 150 skipped, not applied
    expect(res.skipped.some(s => s.reason === 'conversion_sweep_cancel_failed' && s.event_id === 150)).toBe(true);
  });
});
