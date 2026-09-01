/**
 * tests/courtexecutor.cancel.test.js
 *
 * Show-cause arc, Slice B — the cancel_event action (prompt v6) and its
 * revert arm.
 *
 *   npx jest tests/courtexecutor.cancel.test.js
 *
 * Contract under test (courtExecutor cancel_event dispatch):
 *   CLEAR FIRST   — a show-cause cancel clears cases.show_cause UNCONDITIONALLY
 *                   (before/independent of event matching): dissolved means no
 *                   pending show cause even when the event row is missing or
 *                   already Canceled. Compare-first, so replays are noops.
 *   ONE MATCH     — exactly one Scheduled match → eventService.cancelEvent
 *                   (gcal teardown + reminder-task deletion + log row all live
 *                   in the service), a structured event/cancel change row, and
 *                   an applied entry.
 *   TYPE DRIFT    — live data carries 'Show Cause' AND 'Show Cause Hearing';
 *                   the matcher folds both (isShowCauseType arm), so neither
 *                   the AI's label nor the legacy row's label has to agree.
 *   REPLAY        — only non-Scheduled matches → quiet 'cancel_already_done'
 *                   skip, NO review noise, outcome 'none' when nothing else
 *                   applied.
 *   NO MATCH      — nothing matched at all → 'cancel_no_match' review (queued).
 *   AMBIGUOUS     — 2+ Scheduled matches → cancel NOTHING, 'cancel_ambiguous'
 *                   review. (The 26-44274 same-slot Confirmation+OSC pair is
 *                   the standing false-positive proof.)
 *   DATE NARROWS  — a stated fields.date disambiguates multiple matches but is
 *                   never a hard filter.
 *   DRY-RUN       — plan built (applied/change rows), cancelEvent NOT called.
 *   REVERT        — an event/cancel change row restores Scheduled through
 *                   eventService.updateEvent with the event's own calendar_id
 *                   re-asserted (GCAL_AFFECTING → the calendar copy comes back).
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const CASE_ROW = {
  found: true,
  case_id: 'PennyC01',
  case_number: '26-40794',
  case_number_full: '26-40794-mar',
  case_caption: null,
  primary_contact_id: 222,
  primary_contact_name: 'Charles Penny',
};
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...CASE_ROW });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const eventService = require('../services/eventService');

// U2 — the write paths now resolve type_key from the calendar_item_types
// registry. Prime the registry cache from the seed fixture so no registry
// query reaches this suite's stub (Fred, U2 R1.3: prime, never script a
// positional registry query). Resolution code still runs for real.
const calendarTypeService = require('../services/calendarTypeService');
beforeAll(() => calendarTypeService._primeCache(require('./fixtures/calendar_item_types.seed.json')));
afterAll(() => calendarTypeService.invalidate());
const { executeCourtActions, revertCourtActions } = require('../services/courtExecutor');

// ─────────────────────────────────────────────────────────────
// db stub. Answers exactly the queries the cancel path emits:
//   - the candidates SELECT (recognized by its select list: event_status,
//     event_calendar_id — the update_event typeMatches SELECT has neither),
//   - the cases show_cause lazy loader,
//   - revert's ai_change_log target SELECT + events status SELECT,
//   - generic INSERT/UPDATE fallthrough for the audit tables.
// ─────────────────────────────────────────────────────────────
function makeDb({ events = [], showCause = null, changeRows = [] } = {}) {
  const updates = [];
  const query = jest.fn(async (sql, params = []) => {
    if (/event_status, event_calendar_id\s+FROM events/i.test(sql)) {
      // candidates SELECT (cancel dispatch) — link filter only
      if (/event_link_type='case_number' AND event_link_id=\?/i.test(sql)) {
        return [events.filter(e => e.event_link_id === params[0]).map(e => ({ ...e }))];
      }
      // revert's per-event status SELECT
      if (/WHERE event_id=\? LIMIT 1/i.test(sql)) {
        const row = events.find(e => e.event_id === params[0]);
        return [row ? [{ event_status: row.event_status, event_calendar_id: row.event_calendar_id ?? null }] : []];
      }
    }
    if (/FROM cases WHERE case_id=\? LIMIT 1/i.test(sql)) {
      return [[{
        case_file_date: null, case_judge: '', case_close_date: null,
        case_chapter: '7', case_trustee: '', case_objection: null,
        show_cause: showCause,
      }]];
    }
    if (/FROM ai_change_log\s+WHERE source_message_id=\?/i.test(sql)) {
      return [changeRows.map(r => ({ ...r }))];
    }
    if (/^\s*UPDATE\b/i.test(sql)) { updates.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return [{ affectedRows: 1 }]; }
    if (/^\s*INSERT\b/i.test(sql)) return [{ insertId: 77, affectedRows: 1 }];
    return [[]];
  });
  return { query, updates };
}

function cancelPayload(fields, { messageId = 'court-cancel-run' } = {}) {
  return {
    payload: {
      message_id: messageId,
      case_number: '26-40794-mar',
      case_name: 'Charles Penny',
      classification: 'order_to_show_cause',
      needs_review: false,
      actions: [{ type: 'cancel_event', fields }],
    },
    subject: 'irrelevant (citations stubbed)',
    body: 'irrelevant (citations stubbed)',
  };
}

const SC_EVENT = {
  event_id: 900, event_link_type: 'case_number', event_link_id: '26-40794',
  event_type: 'Show Cause', event_title: 'Order to Show Cause on Dismissal of Case for Failure to Pay Filing Fee',
  event_date: '2026-08-20', event_time: '09:30:00', event_all_day: 0,
  event_location: 'Courtroom 1975', event_status: 'Scheduled', event_calendar_id: 'primary',
};

const realCancelEvent = eventService.cancelEvent;
const realUpdateEvent = eventService.updateEvent;
beforeEach(() => {
  eventService.cancelEvent = jest.fn(async () => ({ event: {} }));
  eventService.updateEvent = jest.fn(async () => ({ event: {} }));
});
afterAll(() => {
  eventService.cancelEvent = realCancelEvent;
  eventService.updateEvent = realUpdateEvent;
});

describe('cancel_event dispatch', () => {
  const FIELDS = {
    event_type: 'Show Cause',
    event_title: 'Order to Show Cause on Dismissal of Case for Failure to Pay',
    date: null,
  };

  test('one Scheduled match → cancelEvent + show_cause cleared + structured change row', async () => {
    const db = makeDb({ events: [SC_EVENT], showCause: '2026-08-20 09:30:00' });
    const res = await executeCourtActions(db, { ...cancelPayload(FIELDS), dryRun: false });

    expect(res.outcome).toBe('executed');
    expect(eventService.cancelEvent).toHaveBeenCalledTimes(1);
    expect(eventService.cancelEvent.mock.calls[0][1]).toBe(900);

    // show_cause cleared, with the prior datetime preserved for revert
    const sc = res.applied.find(a => a.entity_type === 'case' && a.field === 'show_cause');
    expect(sc.old_value).toBe('2026-08-20 09:30');
    expect(sc.new_value).toBeNull();
    expect(db.updates.some(u => /UPDATE cases SET show_cause=NULL/i.test(u.sql))).toBe(true);

    // cancel applied entry + structured before-state
    const ce = res.applied.find(a => a.type === 'cancel_event');
    expect(ce.entity_id).toBe('900');
    expect(ce.summary).toMatch(/^cancel Show Cause/);
  });

  test('type drift: legacy "Show Cause Hearing" row still matches', async () => {
    const drifted = { ...SC_EVENT, event_id: 901, event_type: 'Show Cause Hearing' };
    const db = makeDb({ events: [drifted], showCause: null });
    const res = await executeCourtActions(db, { ...cancelPayload(FIELDS), dryRun: false });
    expect(eventService.cancelEvent).toHaveBeenCalledTimes(1);
    expect(eventService.cancelEvent.mock.calls[0][1]).toBe(901);
    expect(res.outcome).toBe('executed');
  });

  test('replay: only a Canceled match → quiet skip, no review, outcome none', async () => {
    const done = { ...SC_EVENT, event_status: 'Canceled' };
    const db = makeDb({ events: [done], showCause: null }); // column already clear
    const res = await executeCourtActions(db, { ...cancelPayload(FIELDS), dryRun: false });
    expect(eventService.cancelEvent).not.toHaveBeenCalled();
    const sk = res.skipped.find(s => s.type === 'cancel_event');
    expect(sk.reason).toBe('cancel_already_done');
    expect(res.review_reason).toBeFalsy();
    expect(res.outcome).toBe('none');
  });

  test('replay with stale column: event already Canceled but show_cause still set → column clears, executed', async () => {
    const done = { ...SC_EVENT, event_status: 'Canceled' };
    const db = makeDb({ events: [done], showCause: '2026-08-20 09:30:00' });
    const res = await executeCourtActions(db, { ...cancelPayload(FIELDS), dryRun: false });
    expect(eventService.cancelEvent).not.toHaveBeenCalled();
    const sc = res.applied.find(a => a.entity_type === 'case' && a.field === 'show_cause');
    expect(sc.new_value).toBeNull();
    expect(res.outcome).toBe('executed'); // the column write IS an applied action
  });

  test('no match at all → cancel_no_match review, queued', async () => {
    const db = makeDb({ events: [], showCause: null });
    const res = await executeCourtActions(db, { ...cancelPayload(FIELDS), dryRun: false });
    expect(eventService.cancelEvent).not.toHaveBeenCalled();
    expect(res.outcome).toBe('queued');
    expect(res.review_reason).toMatch(/cancel_no_match/);
  });

  test('2+ Scheduled matches → cancel NOTHING, cancel_ambiguous review', async () => {
    const twin = { ...SC_EVENT, event_id: 902, event_date: '2026-09-05' };
    const db = makeDb({ events: [SC_EVENT, twin], showCause: null });
    const res = await executeCourtActions(db, { ...cancelPayload(FIELDS), dryRun: false });
    expect(eventService.cancelEvent).not.toHaveBeenCalled();
    expect(res.review_reason).toMatch(/cancel_ambiguous/);
    const sk = res.skipped.find(s => s.reason === 'cancel_ambiguous');
    expect(sk.event_ids.sort()).toEqual([900, 902]);
  });

  test('stated date disambiguates multiple matches', async () => {
    const twin = { ...SC_EVENT, event_id: 902, event_date: '2026-09-05' };
    const db = makeDb({ events: [SC_EVENT, twin], showCause: null });
    const res = await executeCourtActions(db, {
      ...cancelPayload({ ...FIELDS, date: '2026-09-05' }), dryRun: false,
    });
    expect(eventService.cancelEvent).toHaveBeenCalledTimes(1);
    expect(eventService.cancelEvent.mock.calls[0][1]).toBe(902);
    expect(res.outcome).toBe('executed');
  });

  test('non-show-cause cancel does NOT touch cases.show_cause', async () => {
    const hearing = { ...SC_EVENT, event_id: 903, event_type: 'Hearing', event_title: 'Hearing on Motion for Relief from Stay' };
    const db = makeDb({ events: [hearing], showCause: '2026-08-20 09:30:00' });
    const res = await executeCourtActions(db, {
      ...cancelPayload({ event_type: 'Hearing', event_title: 'Hearing on Motion for Relief from Stay', date: null }),
      dryRun: false,
    });
    expect(eventService.cancelEvent).toHaveBeenCalledWith(expect.anything(), 903, 0);
    expect(res.applied.find(a => a.field === 'show_cause')).toBeUndefined();
    expect(db.updates.some(u => /show_cause=NULL/i.test(u.sql))).toBe(false);
  });

  test('dry-run: full plan, zero service calls, zero writes', async () => {
    const db = makeDb({ events: [SC_EVENT], showCause: '2026-08-20 09:30:00' });
    const res = await executeCourtActions(db, { ...cancelPayload(FIELDS), dryRun: true });
    expect(eventService.cancelEvent).not.toHaveBeenCalled();
    expect(db.updates.some(u => /UPDATE cases SET show_cause/i.test(u.sql))).toBe(false);
    expect(res.applied.find(a => a.type === 'cancel_event').entity_id).toBe('900');
    expect(res.applied.find(a => a.field === 'show_cause').new_value).toBeNull();
  });
});

describe('revert event/cancel', () => {
  test('restores Scheduled via updateEvent with calendar_id re-asserted', async () => {
    const canceled = { ...SC_EVENT, event_status: 'Canceled' };
    const db = makeDb({
      events: [canceled],
      changeRows: [{
        id: 42, entity_type: 'event', entity_id: 900, field: 'cancel',
        old_value: JSON.stringify({ status: 'Scheduled', date: '2026-08-20', time: '09:30', all_day: 0, location: 'Courtroom 1975', calendar_id: 'primary' }),
        new_value: JSON.stringify({ status: 'Canceled' }),
      }],
    });
    const res = await revertCourtActions(db, { messageId: 'court-cancel-run', dryRun: false, actingUserId: 6 });
    expect(res.reverted).toHaveLength(1);
    expect(eventService.updateEvent).toHaveBeenCalledTimes(1);
    const [, id, patch, actor] = eventService.updateEvent.mock.calls[0];
    expect(id).toBe(900);
    expect(patch).toEqual({ event_status: 'Scheduled', event_calendar_id: 'primary' });
    expect(actor).toBe(6);
  });

  test('modified_since guard: event no longer Canceled → skip', async () => {
    const db = makeDb({
      events: [SC_EVENT], // status Scheduled — someone already restored it
      changeRows: [{
        id: 43, entity_type: 'event', entity_id: 900, field: 'cancel',
        old_value: JSON.stringify({ status: 'Scheduled', calendar_id: 'primary' }),
        new_value: JSON.stringify({ status: 'Canceled' }),
      }],
    });
    const res = await revertCourtActions(db, { messageId: 'court-cancel-run', dryRun: false });
    expect(res.reverted).toHaveLength(0);
    expect(res.skipped[0].reason).toBe('modified_since');
    expect(eventService.updateEvent).not.toHaveBeenCalled();
  });
});