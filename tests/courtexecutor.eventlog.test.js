/**
 * tests/courtexecutor.eventlog.test.js
 *
 * Deferred slice — route courtExecutor event writes through eventService.createEvent.
 *
 *   npx jest tests/courtexecutor.eventlog.test.js
 *
 * The executor's doCreateEvent used to run a RAW `INSERT INTO events` (no log
 * row → invisible in the activity feed); it now routes through
 * eventService.createEvent. The SHOW-CAUSE ARC (2026-08) then un-neutralized
 * two of createEvent's side effects on purpose. Current contract under test:
 *
 *   THE FIX          — a live court create produces a `log` row (type 'event',
 *                      link_type 'case', link_id the docket, action 'created'),
 *                      via the REAL createEvent path (logService is spied only to
 *                      capture the write, NOT to replace createEvent).
 *   CALENDAR POLICY  — timed events persist event_calendar_id 'primary'
 *                      (Stuart's own Google calendar) and event_with=1 (blocks
 *                      only SS in availabilityService); all-day events persist
 *                      calendar_id NULL (firm group calendar) and with NULL
 *                      (all-day never blocks). GCal sync is LIVE for both.
 *   SHOW CAUSE       — an OSC create ALSO (a) converges cases.show_cause to the
 *                      hearing datetime — including on a dedup-skip, so email
 *                      replays converge the column — and (b) spawns a
 *                      filing-fee reminder task to billing (app_settings
 *                      billing_tasks_to, fallback user 5), due clamped to
 *                      today. Non-show-cause types get NO reminder.
 *   DEDUP CONTRACT   — dedupe:false → the executor's OWN upstream
 *                      findDuplicateEvent guard still owns the 'event_exists' /
 *                      'event_slot_exists' skip-reason strings, and createEvent
 *                      is never reached on a dup (no double-guard).
 *   ROW SHAPE        — event_created_by NULL (acting_user_id 0), event_length
 *                      NULL, AI_DISCLAIMER note, all_day derived from time.
 *   DRY-RUN          — dry-run creates NOTHING: createEvent is never invoked.
 *
 * db-stub convention mirrors tests/eventDedup.phaseB.test.js: a stateful stub
 * whose query() dispatches on SQL text, executing the ACTUAL query strings
 * findDuplicateEvent / createEvent emit (so a param-order regression surfaces
 * here). resolveCase + checkCitations are patched on the require cache BEFORE
 * courtExecutor is required, so the executor destructures the stubs at load time.
 */

// credentialCrypto (pulled in transitively via eventService → emailService)
// throws at REQUIRE time without a key. Any 32-byte key works.
process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

// ── Patch resolveCase + checkCitations BEFORE requiring courtExecutor ─────────
// courtExecutor destructures both at module load:
//   const { resolveCase } = require('../lib/courtResolve');
//   const { checkCitations } = require('../lib/courtCitation');
// Mutating the cached module objects here means the destructure picks up these
// stubs. Order matters: this MUST run before require('../services/courtExecutor').
const CASE_ROW = {
  found: true,
  case_id: 'ayx7GJ7j',
  case_number: '26-47542',        // SHORT docket → becomes event_link_id
  case_number_full: '26-47542-mlo',
  case_caption: null,             // Slice A: resolver now returns case_caption
  primary_contact_id: 111,
  primary_contact_name: 'Marquita Renea Smith',
};
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...CASE_ROW });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const eventService  = require('../services/eventService');

// U2 — the write paths now resolve type_key from the calendar_item_types
// registry. Prime the registry cache from the seed fixture so no registry
// query reaches this suite's stub (Fred, U2 R1.3: prime, never script a
// positional registry query). Resolution code still runs for real.
const calendarTypeService = require('../services/calendarTypeService');
beforeAll(() => calendarTypeService._primeCache(require('./fixtures/calendar_item_types.seed.json')));
afterAll(() => calendarTypeService.invalidate());
const logService    = require('../services/logService');
const gcalService   = require('../services/gcalService');
const taskService   = require('../services/taskService');

// Capture the REAL createEvent before we wrap it — the success test drives it.
const realCreateEvent = eventService.createEvent;

const { executeCourtActions } = require('../services/courtExecutor');

// The provenance note the executor stamps on every event (must match courtExecutor).
const AI_DISCLAIMER = '[AI] Auto-created from a court email — verify.';

// createEvent's INSERT param order (must track eventService.createEvent):
//   0 event_type · 1 event_link_type · 2 event_link_id · 3 event_title ·
//   4 event_date · 5 event_time · 6 event_all_day · 7 event_length ·
//   8 event_location · 9 event_link · 10 event_note · 11 event_calendar_id ·
//   12 event_with · 13 event_created_by      (event_status/'Scheduled' and
//   event_create_date/NOW() are SQL literals, NOT params).
const I = {
  type: 0, link_type: 1, link_id: 2, title: 3, date: 4, time: 5, all_day: 6,
  length: 7, location: 8, link: 9, note: 10, calendar_id: 11, with: 12, created_by: 13,
};

const nullEq = (a, b) => (a == null && b == null) ? true : a === b;

// ─────────────────────────────────────────────────────────────
// In-memory db stub. Executes the real query strings; captures the events INSERT
// with its FULL param set (unlike phaseB's stub, which drops the columns this
// slice must assert). Everything the executor writes for audit (court_ai_log,
// ai_change_log) falls through to a generic INSERT → {insertId}.
// ─────────────────────────────────────────────────────────────
function makeDb(seedEvents = []) {
  const events = seedEvents.map(e => ({ event_status: 'Scheduled', event_time: null, ...e }));
  const eventInserts = [];             // { id, params } for each createEvent INSERT
  const sqlLog = [];
  let nextId = Math.max(1000, ...events.map(e => e.event_id || 0)) + 1;

  const query = jest.fn(async (sql, params = []) => {
    sqlLog.push(sql.replace(/\s+/g, ' ').trim().slice(0, 70));

    // ── findDuplicateEvent RULE 1 — exact natural key ──────────────────────
    if (/SELECT e\.\* FROM events e\s+WHERE e\.event_link_type <=> \?/i.test(sql)) {
      const hasExcl = /event_id <> \?/i.test(sql);
      const [lt, lid, ty, date, title] = params;
      const excl = hasExcl ? params[5] : null;
      const rows = events.filter(e =>
        e.event_status === 'Scheduled' &&
        nullEq(e.event_link_type, lt) && nullEq(e.event_link_id, lid) &&
        nullEq(e.event_type, ty) && e.event_date === date && e.event_title === title &&
        (excl == null || e.event_id !== excl)
      ).sort((a, b) => a.event_id - b.event_id);
      return [rows.slice(0, 1)];
    }

    // ── _resolveLinkedCase ('case_number') ─────────────────────────────────
    if (/FROM cases\s+WHERE case_number = \? OR case_number_full = \? LIMIT 1/i.test(sql)) {
      const [n, f] = params;
      const c = (CASE_ROW.case_number === n || CASE_ROW.case_number_full === f)
        ? { case_id: CASE_ROW.case_id, case_number: CASE_ROW.case_number, case_number_full: CASE_ROW.case_number_full }
        : null;
      return [c ? [c] : []];
    }
    // ── _resolveLinkedCase ('case') — not used here but harmless ───────────
    if (/FROM cases WHERE case_id = \? LIMIT 1/i.test(sql)) {
      const c = params[0] === CASE_ROW.case_id
        ? { case_id: CASE_ROW.case_id, case_number: CASE_ROW.case_number, case_number_full: CASE_ROW.case_number_full }
        : null;
      return [c ? [c] : []];
    }

    // ── findDuplicateEvent SLOT set (rules 2 & 3 candidate pool) ────────────
    if (/SELECT e\.\* FROM events e\s+WHERE .*event_date = \? AND e\.event_time <=> \?/is.test(sql)) {
      const hasExcl = /event_id <> \?/i.test(sql);
      let i = 0, linkPred;
      if (/event_link_id IN \(/i.test(sql)) {                        // form A: case + dockets
        const inCount = (sql.match(/IN \(([^)]*)\)/i)[1].match(/\?/g) || []).length;
        const caseId  = params[i++];
        const dockets = params.slice(i, i + inCount); i += inCount;
        linkPred = (e) =>
          (e.event_link_type === 'case' && e.event_link_id === caseId) ||
          (e.event_link_type === 'case_number' && dockets.includes(e.event_link_id));
      } else if (/\(e\.event_link_type = 'case' AND e\.event_link_id = \?\)/i.test(sql)) {
        const caseId = params[i++];
        linkPred = (e) => e.event_link_type === 'case' && e.event_link_id === caseId;
      } else {                                                        // form C: raw equality
        const lt = params[i++], lid = params[i++];
        linkPred = (e) => e.event_link_type === lt && e.event_link_id === lid;
      }
      const date = params[i++];
      const time = params[i++];
      const excl = hasExcl ? params[i++] : null;
      const rows = events.filter(e =>
        e.event_status === 'Scheduled' && linkPred(e) &&
        e.event_date === date && nullEq(e.event_time, time) &&
        (excl == null || e.event_id !== excl)
      ).sort((a, b) => a.event_id - b.event_id);
      return [rows];
    }

    // ── createEvent INSERT — capture the FULL param set, reflect the row ────
    if (/INSERT INTO events/i.test(sql)) {
      const id = nextId++;
      eventInserts.push({ id, params });
      events.push({
        event_id: id,
        event_type: params[I.type], event_link_type: params[I.link_type],
        event_link_id: params[I.link_id], event_title: params[I.title],
        event_date: params[I.date], event_time: params[I.time],
        event_all_day: params[I.all_day], event_length: params[I.length],
        event_location: params[I.location], event_link: params[I.link],
        event_note: params[I.note], event_status: 'Scheduled',
        event_calendar_id: params[I.calendar_id], event_with: params[I.with],
        event_created_by: params[I.created_by],
      });
      return [{ insertId: id }];
    }

    // ── getEvent (createEvent tail; only event_id is consumed downstream) ───
    if (/ca\.case_id AS joined_case_id/i.test(sql)) {
      const row = events.find(e => e.event_id === params[0]);
      return [row ? [{ ...row }] : []];
    }

    // ── _normalizeEventWith users lookup — SS (user 1) IS a provider, matching
    //    the live row (users.does_appts=1 verified 2026-08). Timed court events
    //    now pass event_with=1 through this validator.
    if (/FROM users WHERE user = \? AND does_appts = 1/i.test(sql)) {
      return [Number(params[0]) === 1 ? [{ user: 1 }] : []];
    }

    // ── Generic fallback: court_ai_log INSERT, ai_change_log INSERT, the
    //    STEP-1 processed-marker SELECT, etc. INSERT → {insertId}; else [] ──
    if (/^\s*INSERT\b/i.test(sql)) return [{ insertId: nextId++, affectedRows: 1 }];
    if (/^\s*(UPDATE|DELETE)\b/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];  // SELECT/SHOW default: no rows
  });

  return { query, eventInserts, sqlLog };
}

// A create_event action payload for the executor. checkCitations is stubbed to
// pass, so subject/body/action content is irrelevant to citation gating.
function createEventPayload(fields, { messageId = 'court-eventlog-run', caseNumber = '26-47542' } = {}) {
  return {
    payload: {
      message_id: messageId,
      case_number: caseNumber,
      classification: 'court_notice',
      needs_review: false,
      actions: [{ type: 'create_event', fields }],
    },
    subject: 'irrelevant (citations stubbed)',
    body: 'irrelevant (citations stubbed)',
  };
}

// ─────────────────────────────────────────────────────────────
// Spies. Reinstalled fresh each test so call counts reset. createEvent DELEGATES
// to the real implementation, so the success test exercises the true create
// path (real INSERT + real insertEventLog); logService/gcal/task are captured
// only to inspect / prove-absence.
// ─────────────────────────────────────────────────────────────
beforeEach(() => {
  eventService.createEvent   = jest.fn((...a) => realCreateEvent(...a));
  logService.createLogEntry  = jest.fn(async () => 999);     // capture the log write
  gcalService.createEvent    = jest.fn(async () => ({ id: 'gcal_evt_1' }));
  taskService.createTask     = jest.fn(async () => ({ task_id: 888 })); // spawnReminderTask reads .task_id
});

// createEvent fires syncEventToCalendar + spawnReminderTask WITHOUT awaiting
// (`.catch()` fire-and-forget). Flush the microtask/immediate queue so those
// spies settle deterministically before asserting on them.
const flushAsync = () => new Promise((r) => setImmediate(r));
afterAll(() => {
  eventService.createEvent  = realCreateEvent;
});

// ─────────────────────────────────────────────────────────────
// 1. THE FIX + neutralized deltas — one live create through the REAL createEvent.
// ─────────────────────────────────────────────────────────────
describe('live court create → createEvent', () => {
  // A TIMED Show Cause on purpose: exercises the calendar policy (timed →
  // 'primary' + event_with=1), the show_cause column write, AND the billing
  // reminder task in one create. Date is intentionally "today or past" —
  // the reminder due-date clamp must never let spawnReminderTask's past-due
  // guard silently refuse the task.
  const FIELDS = {
    event_type: 'Show Cause',
    event_title: 'Show Cause Hearing',
    date: '2026-08-07',
    time: '09:30',
    location: 'Courtroom 3',
  };

  test('writes a log row (type=event, link=case/docket, action=created) — THE FIX', async () => {
    const db = makeDb([]);
    const res = await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });

    expect(res.outcome).toBe('executed');
    expect(res.skipped).toEqual([]);

    // Real createEvent ran → real insertEventLog → logService.createLogEntry.
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    const logArg = logService.createLogEntry.mock.calls[0][1];
    expect(logArg.type).toBe('event');
    expect(logArg.link_type).toBe('case');        // court-email convention
    expect(logArg.link_id).toBe('26-47542');      // the docket, verbatim
    expect(logArg.data.action).toBe('created');
    expect(logArg.data.event_title).toBe('Show Cause Hearing');

    // applied entry carries the real event_id from createEvent (not '(dry)').
    const evId = db.eventInserts[0].id;
    const appliedEvent = res.applied.find(a => a.type === 'create_event');
    expect(appliedEvent.entity_id).toBe(String(evId));
  });

  test('Show Cause spawns the billing reminder task (fallback user 5, due clamped to today)', async () => {
    const db = makeDb([]);
    await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });
    await flushAsync(); // spawnReminderTask is fire-and-forget inside createEvent
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    const t = taskService.createTask.mock.calls[0][1];
    expect(t.to).toBe(5);                          // app_settings read misses → fallback Shoshana
    expect(t.link_type).toBe('event');
    expect(t.title).toMatch(/^Filing fee — Show Cause 2026-08-07/);
    // due = hearing − 7d clamped to today (never < today, so the past-due
    // guard in spawnReminderTask can never refuse it).
    //
    // FLAKE FIX (2026-08-24): this assertion previously computed "today" in
    // FIRM_TIMEZONE-or-UTC, but the clamp in services/eventService.js uses
    // FIRM_TZ (America/Detroit when the env is unset under jest). Between
    // 8pm and midnight Detroit time, UTC's date is one day ahead, so
    // t.due (Detroit-today) < today (UTC-tomorrow) and the test failed —
    // a daily four-hour flake window, first hit on the Aug 22/23 sandbox
    // runs. Mirror the code under test's timezone exactly. The old
    // `|| t.due === today` clause was dead (subsumed by >=) and is gone.
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: process.env.FIRM_TIMEZONE || 'America/Detroit',
    }).format(new Date());
    expect(t.due >= today).toBe(true);
  });

  test('non-show-cause court event spawns NO reminder task', async () => {
    const db = makeDb([]);
    await executeCourtActions(db, {
      ...createEventPayload({ event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing', date: '2026-09-14', time: '10:00' }),
      dryRun: false,
    });
    await flushAsync();
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('timed event persists calendar_id "primary" + event_with 1, and GCal sync fires', async () => {
    const db = makeDb([]);
    await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });
    const params = db.eventInserts[0].params;
    expect(params[I.calendar_id]).toBe('primary'); // Stuart's own calendar
    expect(params[I.with]).toBe(1);                // blocks only SS's availability
    await flushAsync(); // syncEventToCalendar is fire-and-forget
    expect(gcalService.createEvent).toHaveBeenCalledTimes(1);
  });

  test('OSC converges cases.show_cause to the hearing datetime', async () => {
    const db = makeDb([]);
    const res = await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });
    const sc = res.applied.find(a => a.entity_type === 'case' && a.field === 'show_cause');
    expect(sc).toBeTruthy();
    expect(sc.new_value).toBe('2026-08-07 09:30');
    // The UPDATE actually ran (live, not dry).
    expect(db.query.mock.calls.some(([sql]) => /UPDATE cases SET show_cause=\?/i.test(sql))).toBe(true);
  });

  test('event_created_by NULL, event_length NULL — row shape', async () => {
    const db = makeDb([]);
    await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });
    const params = db.eventInserts[0].params;
    expect(params[I.created_by]).toBeNull();   // acting_user_id 0 → NULL
    expect(params[I.length]).toBeNull();       // DB default NULL (availability blocks 60 min)
    expect(params[I.note]).toBe(AI_DISCLAIMER);
    expect(params[I.all_day]).toBe(0);         // timed → 0 (derived from event_time)
    expect(params[I.time]).toBe('09:30:00');   // normalized
    expect(params[I.link_type]).toBe('case_number');
    expect(params[I.link_id]).toBe('26-47542');
  });

  test('all-day court event: all_day=1, time NULL, calendar NULL (firm), with NULL (never blocks)', async () => {
    const db = makeDb([]);
    const allDay = { event_type: 'poc_due', event_title: 'Proof of Claim Deadline', date: '2026-09-11' };
    await executeCourtActions(db, { ...createEventPayload(allDay), dryRun: false });
    const params = db.eventInserts[0].params;
    expect(params[I.all_day]).toBe(1);
    expect(params[I.time]).toBeNull();
    expect(params[I.with]).toBeNull();
    expect(params[I.calendar_id]).toBeNull();  // firm group calendar via app_settings
  });

  test('dedup-skipped OSC replay STILL converges cases.show_cause', async () => {
    // Seed the exact natural key so findDuplicateEvent hits → 'event_exists'.
    const db = makeDb([{
      event_id: 601, event_link_type: 'case_number', event_link_id: '26-47542',
      event_type: 'Show Cause', event_title: 'Show Cause Hearing',
      event_date: '2026-08-07', event_time: '09:30:00',
    }]);
    const res = await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });
    const sk = res.skipped.find(s => s.type === 'create_event');
    expect(sk && sk.reason).toBe('event_exists');
    expect(eventService.createEvent).not.toHaveBeenCalled();
    // …but the case column still converged (writeShowCauseColumn runs BEFORE
    // the dedup guard, exactly so replays repair a missing/ stale column).
    const sc = res.applied.find(a => a.entity_type === 'case' && a.field === 'show_cause');
    expect(sc && sc.new_value).toBe('2026-08-07 09:30');
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Dry-run creates NOTHING — createEvent is never invoked.
// ─────────────────────────────────────────────────────────────
describe('dry-run', () => {
  test('does not call createEvent and inserts no event row', async () => {
    const db = makeDb([]);
    const res = await executeCourtActions(db, {
      ...createEventPayload({ event_type: 'Show Cause', event_title: 'Show Cause Hearing', date: '2026-08-07', time: '09:30' }),
      dryRun: true,
    });
    expect(eventService.createEvent).not.toHaveBeenCalled();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    expect(db.eventInserts).toHaveLength(0);
    // The plan is still built: applied carries the intended event as '(dry)'.
    const appliedEvent = res.applied.find(a => a.type === 'create_event');
    expect(appliedEvent.entity_id).toBe('(dry)');
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Dedup skip contract still owned by the executor's OWN guard — neutralized #4.
//    createEvent is NEVER reached on a dup (no double-guard), and the skip-reason
//    strings the digest / court.js DEDUP_SKIP_REASONS depend on are unchanged.
// ─────────────────────────────────────────────────────────────
describe('dedup skip path (executor guard, real findDuplicateEvent)', () => {
  test('exact natural-key dup → skip reason "event_exists", createEvent not called', async () => {
    const db = makeDb([{
      event_id: 501, event_link_type: 'case_number', event_link_id: '26-47542',
      event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing',
      event_date: '2026-09-14', event_time: '10:00:00',
    }]);
    const res = await executeCourtActions(db, {
      ...createEventPayload({
        event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing',
        date: '2026-09-14', time: '10:00',
      }),
      dryRun: false,
    });
    expect(eventService.createEvent).not.toHaveBeenCalled();
    expect(db.eventInserts).toHaveLength(0);
    const sk = res.skipped.find(s => s.type === 'create_event');
    expect(sk).toBeTruthy();
    expect(sk.reason).toBe('event_exists');
    expect(sk.event_id).toBe(501);
  });

  test('same-slot cross-casing dup → skip reason "event_slot_exists", createEvent not called', async () => {
    // Seed 'confirmation_hearing' (underscore); candidate is 'Confirmation Hearing'.
    // RULE 1 misses (type + title differ); RULE 2 (slot + normalized type) hits.
    const db = makeDb([{
      event_id: 502, event_link_type: 'case_number', event_link_id: '26-47542',
      event_type: 'confirmation_hearing', event_title: 'Confirmation Hearing (docketed)',
      event_date: '2026-09-14', event_time: '10:00:00',
    }]);
    const res = await executeCourtActions(db, {
      ...createEventPayload({
        event_type: 'Confirmation Hearing',
        event_title: 'Confirmation Hearing — Marquita Renea Smith (26-47542)',
        date: '2026-09-14', time: '10:00',
      }),
      dryRun: false,
    });
    expect(eventService.createEvent).not.toHaveBeenCalled();
    expect(db.eventInserts).toHaveLength(0);
    const sk = res.skipped.find(s => s.type === 'create_event');
    expect(sk).toBeTruthy();
    expect(sk.reason).toBe('event_slot_exists');
    expect(sk.event_id).toBe(502);
  });
});