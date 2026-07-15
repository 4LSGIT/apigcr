/**
 * Deferred slice — route courtExecutor event writes through eventService.createEvent.
 *
 *   npx jest tests/courtExecutor.eventLog.test.js
 *
 * The executor's doCreateEvent used to run a RAW `INSERT INTO events`, which
 * wrote NO `log` row — so court-created events were invisible in the case /
 * contact activity feed while wf24's (created via createEvent) were not. The
 * change routes the executor through eventService.createEvent. The ONLY intended
 * behavior change is that a `log` row now appears. createEvent does three other
 * things the raw INSERT did not; all three are neutralized by the exact argument
 * set doCreateEvent passes. These tests assert BOTH halves:
 *
 *   THE FIX          — a live court create produces a `log` row (type 'event',
 *                      link_type 'case', link_id the docket, action 'created'),
 *                      via the REAL createEvent path (logService is spied only to
 *                      capture the write, NOT to replace createEvent).
 *   NEUTRALIZED #2   — event_calendar_id 'none' → GCal sync is a no-op (gcal
 *                      never called; 'none' persisted on the row).
 *   NEUTRALIZED #3   — no `reminder` key → no reminder task spawned.
 *   NEUTRALIZED #4   — dedupe:false → the executor's OWN upstream findDuplicateEvent
 *                      guard still owns the 'event_exists' / 'event_slot_exists'
 *                      skip-reason contract, and createEvent is never reached on a
 *                      dup (no double-guard).
 *   ROW SHAPE        — event_created_by NULL (acting_user_id 0), event_with NULL,
 *                      event_length NULL — identical to the raw INSERT's row
 *                      (the raw INSERT omitted with/length; DB defaults are NULL,
 *                      verified against live rows). Notably event_with is NULL
 *                      even for a TIMED event (older executor rows carried
 *                      event_with=1; this change does NOT reintroduce that).
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
  primary_contact_id: 111,
  primary_contact_name: 'Marquita Renea Smith',
};
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...CASE_ROW });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const eventService  = require('../services/eventService');
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

    // ── _normalizeEventWith users lookup (never hit: event_with is null) ────
    if (/FROM users WHERE user = \? AND does_appts = 1/i.test(sql)) {
      return [[]];
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
  gcalService.createEvent    = jest.fn(async () => ({ id: 'gcal_should_not_be_called' }));
  taskService.createTask     = jest.fn(async () => 888);     // reminder task target
});
afterAll(() => {
  eventService.createEvent  = realCreateEvent;
});

// ─────────────────────────────────────────────────────────────
// 1. THE FIX + neutralized deltas — one live create through the REAL createEvent.
// ─────────────────────────────────────────────────────────────
describe('live court create → createEvent', () => {
  // A TIMED event on purpose: proves event_with stays NULL even when timed
  // (legacy executor rows carried event_with=1 for timed events; this change
  // must not reintroduce that).
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

  test('does NOT spawn a reminder task (no reminder passed) — neutralized #3', async () => {
    const db = makeDb([]);
    await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('persists event_calendar_id "none" and never calls GCal — neutralized #2', async () => {
    const db = makeDb([]);
    await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });
    const params = db.eventInserts[0].params;
    expect(params[I.calendar_id]).toBe('none');
    expect(gcalService.createEvent).not.toHaveBeenCalled();
  });

  test('event_created_by NULL, event_with NULL, event_length NULL — row shape unchanged', async () => {
    const db = makeDb([]);
    await executeCourtActions(db, { ...createEventPayload(FIELDS), dryRun: false });
    const params = db.eventInserts[0].params;
    expect(params[I.created_by]).toBeNull();   // acting_user_id 0 → NULL
    expect(params[I.with]).toBeNull();         // timed event, still NULL (no legacy =1)
    expect(params[I.length]).toBeNull();       // matches raw INSERT omission (DB default NULL)
    expect(params[I.note]).toBe(AI_DISCLAIMER);
    expect(params[I.all_day]).toBe(0);         // timed → 0 (derived from event_time)
    expect(params[I.time]).toBe('09:30:00');   // normalized
    expect(params[I.link_type]).toBe('case_number');
    expect(params[I.link_id]).toBe('26-47542');
  });

  test('all-day court event derives event_all_day=1 and event_time NULL', async () => {
    const db = makeDb([]);
    const allDay = { event_type: 'poc_due', event_title: 'Proof of Claim Deadline', date: '2026-09-11' };
    await executeCourtActions(db, { ...createEventPayload(allDay), dryRun: false });
    const params = db.eventInserts[0].params;
    expect(params[I.all_day]).toBe(1);
    expect(params[I.time]).toBeNull();
    expect(params[I.with]).toBeNull();
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