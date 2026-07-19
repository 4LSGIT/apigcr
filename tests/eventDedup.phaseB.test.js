/**
 * tests/eventDedup.phaseB.test.js
 *
 * Slice 4 Phase B — event de-duplication + ingest hardening.
 *
 *   npx jest tests/eventDedup.phaseB.test.js
 *
 * Five surfaces, all against in-memory stubs (no network, no real DB):
 *
 *   1. eventService.findDuplicateEvent — the shared natural-key guard. Rule 1
 *      (exact), rule 2 (cross-form: 'case'/case_id vs 'case_number'/docket, and
 *      'Confirmation Hearing' vs 'confirmation_hearing'), rule 3 (loose title on
 *      the 90/93 pair), and the three REJECTS that prove it is not trigger-happy:
 *      89/108 (Confirmation Hearing + Show Cause, same slot), 71/110 (two
 *      different deadlines, same all-day slot), and poc_due/poc_gov_due at the
 *      same slot — which only reject because the case IDENTITY TOKENS are
 *      stripped from the titles first (unstripped Jaccard = 0.6 → false match).
 *
 *   2. eventService.createEvent { dedupe:true } — on a hit, NOTHING is written:
 *      no INSERT, no log row, no GCal, no reminder task. Asserted via the db
 *      stub's INSERT log and the monkey-patched side-effect fns.
 *
 *   3. create_event internal function — dedupe DEFAULTS TRUE, and output.deduped
 *      is surfaced.
 *
 *   4. spawnReminderTask past-due guard — a yesterday date returns null and
 *      never calls taskService.createTask (task 1047 was born 722 days overdue
 *      because this guard did not exist).
 *
 *   5. emailIngestRuleService._dispatchAction — is_test + workflow →
 *      skipped_test_envelope (no dispatch); is_test + internal_function → still
 *      dispatched (court_extract self-protects via its own dry-run).
 *
 * db-stub convention matches tests/taskservice.test.js: a stateful stub whose
 * query() dispatches on SQL text, and collaborators monkey-patched on the
 * require cache (the services look these up as module properties per call).
 */

// credentialCrypto (pulled in transitively via emailService) throws at REQUIRE
// time without a key. Any 32-byte key works — nothing here decrypts real data.
process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const { DateTime }  = require('luxon');
const eventService  = require('../services/eventService');
const taskService   = require('../services/taskService');
const logService    = require('../services/logService');
const gcalService   = require('../services/gcalService');
const { FIRM_TZ }   = require('../services/timezoneService');

// ─────────────────────────────────────────────────────────────
// In-memory events/cases db stub.
//
// Executes the ACTUAL query strings findDuplicateEvent / createEvent emit, so a
// param-order regression would surface here rather than passing silently.
// ─────────────────────────────────────────────────────────────

// The case universe (subset of live cases touched by the Phase A clusters).
const CASES = {
  SUTCdsPn: { case_id: 'SUTCdsPn', case_number: '26-46639', case_number_full: '26-46639-mar' },
  aYwkZLA3: { case_id: 'aYwkZLA3', case_number: '26-46899', case_number_full: '26-46899-lsg' },
  T19Z4P7z: { case_id: 'T19Z4P7z', case_number: '26-44743', case_number_full: '26-44743-mlo' },
  d1B2iB_q: { case_id: 'd1B2iB_q', case_number: '26-44274', case_number_full: '26-44274-mar' },
  ayx7GJ7j: { case_id: 'ayx7GJ7j', case_number: '26-47542', case_number_full: '26-47542-mlo' },
};
const PRIMARY_NAME = {
  SUTCdsPn: 'Moneika Nashay Brown',
  aYwkZLA3: 'Aboghene Enita Uwedjojevwe',
  T19Z4P7z: 'Nechama Kramer',
  d1B2iB_q: 'Denise Nicole Roth- Childs',
  ayx7GJ7j: 'Marquita Renea Smith',
};

const nullEq = (a, b) => (a == null && b == null) ? true : a === b;

/** Resolve any (link_type, link_id) to a case_id, folding both docket forms. */
function resolveCaseId(linkType, linkId) {
  if (linkType === 'case') return CASES[linkId] ? linkId : null;
  if (linkType === 'case_number') {
    for (const c of Object.values(CASES)) {
      if (c.case_number === linkId || c.case_number_full === linkId) return c.case_id;
    }
  }
  return null;
}

function makeDb(seedEvents = []) {
  // Clone so a test can't leak row mutations into another.
  const events = seedEvents.map(e => ({ event_status: 'Scheduled', event_time: null, ...e }));
  const inserted = [];
  const sqlLog   = [];
  let nextId = Math.max(0, ...events.map(e => e.event_id || 0)) + 1;

  const query = jest.fn(async (sql, params = []) => {
    sqlLog.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));

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

    // ── _resolveLinkedCase ('case') ────────────────────────────────────────
    if (/FROM cases WHERE case_id = \? LIMIT 1/i.test(sql)) {
      const c = CASES[params[0]];
      return [c ? [{ ...c }] : []];
    }
    // ── _resolveLinkedCase ('case_number') ─────────────────────────────────
    if (/FROM cases\s+WHERE case_number = \? OR case_number_full = \? LIMIT 1/i.test(sql)) {
      const [n, f] = params;
      const c = Object.values(CASES).find(c => c.case_number === n || c.case_number_full === f);
      return [c ? [{ ...c }] : []];
    }

    // ── findDuplicateEvent SLOT set (rules 2 & 3 candidate pool) ────────────
    if (/SELECT e\.\* FROM events e\s+WHERE .*event_date = \? AND e\.event_time <=> \?/is.test(sql)) {
      const hasExcl = /event_id <> \?/i.test(sql);
      // Consume link params off the FRONT according to the emitted link clause.
      let i = 0, linkPred;
      if (/event_link_id IN \(/i.test(sql)) {                       // form A: case + dockets
        const inCount = (sql.match(/IN \(([^)]*)\)/i)[1].match(/\?/g) || []).length;
        const caseId  = params[i++];
        const dockets = params.slice(i, i + inCount); i += inCount;
        linkPred = (e) =>
          (e.event_link_type === 'case' && e.event_link_id === caseId) ||
          (e.event_link_type === 'case_number' && dockets.includes(e.event_link_id));
      } else if (/\(e\.event_link_type = 'case' AND e\.event_link_id = \?\)/i.test(sql)) { // form B
        const caseId = params[i++];
        linkPred = (e) => e.event_link_type === 'case' && e.event_link_id === caseId;
      } else {                                                       // form C: raw equality
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

    // ── _caseIdentityTokens (only when identity_tokens NOT precomputed) ─────
    if (/SELECT co\.contact_name\s+FROM case_relate cr/i.test(sql)) {
      const name = PRIMARY_NAME[params[0]] || null;
      return [name ? [{ contact_name: name }] : []];
    }

    // ── createEvent INSERT ─────────────────────────────────────────────────
    if (/INSERT INTO events/i.test(sql)) {
      const id = nextId++;
      inserted.push({ id, params });
      // Reflect into the table so a subsequent getEvent finds it.
      events.push({
        event_id: id,
        event_type: params[0], event_link_type: params[1], event_link_id: params[2],
        event_title: params[3], event_date: params[4], event_time: params[5],
        event_all_day: params[6], event_status: 'Scheduled',
      });
      return [{ insertId: id }];
    }

    // ── getEvent (returned on both createEvent paths) ──────────────────────
    if (/ca\.case_id AS joined_case_id/i.test(sql)) {
      const row = events.find(e => e.event_id === params[0]);
      return [row ? [{ ...row }] : []];
    }

    throw new Error(`unexpected SQL in stub: ${sql.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
  });

  return { query, inserted, sqlLog };
}

// ─────────────────────────────────────────────────────────────
// 1. findDuplicateEvent
// ─────────────────────────────────────────────────────────────

describe('findDuplicateEvent', () => {
  test('RULE 1 — exact natural key hits', async () => {
    const db = makeDb([{
      event_id: 90, event_link_type: 'case_number', event_link_id: '26-44743',
      event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing',
      event_date: '2026-11-16', event_time: '10:00:00',
    }]);
    const hit = await eventService.findDuplicateEvent(db, {
      event_link_type: 'case_number', event_link_id: '26-44743',
      event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing',
      event_date: '2026-11-16', event_time: '10:00:00',
    });
    expect(hit).toBeTruthy();
    expect(hit.event_id).toBe(90);
    expect(hit._dedupe_rule).toBe('natural_key');
  });

  test('RULE 2 — cross-form: existing case/case_id vs candidate case_number/docket, "Confirmation Hearing" vs "confirmation_hearing"', async () => {
    // The live 26-46639 confirmation-hearing cluster: external automation wrote
    // it linked by case_id with type "Confirmation Hearing"; wf24 then tried to
    // create it linked by docket with type "confirmation_hearing".
    const db = makeDb([{
      event_id: 51, event_link_type: 'case', event_link_id: 'SUTCdsPn',
      event_type: 'Confirmation Hearing',
      event_title: 'Confirmation Hearing - 26-46639-mar - Moneika Nashay Brown',
      event_date: '2026-09-02', event_time: '14:00:00',
    }]);
    const hit = await eventService.findDuplicateEvent(db, {
      event_link_type: 'case_number', event_link_id: '26-46639',
      event_type: 'confirmation_hearing',
      event_title: 'Confirmation Hearing — Moneika Nashay Brown (26-46639)',
      event_date: '2026-09-02', event_time: '14:00:00',
    });
    expect(hit).toBeTruthy();
    expect(hit.event_id).toBe(51);
    expect(hit._dedupe_rule).toBe('slot_type');   // normalized type matched
  });

  test('RULE 3 — loose title on the 90/93 pair (bare vs debtor-named), types equal', async () => {
    // 90 exists as a bare "Confirmation Hearing"; the model re-titles the second
    // notice "Confirmation Hearing - Nechama Kramer". Same type, so this is a
    // rule-3 (loose title) confirmation that the slot backstop folds it.
    const db = makeDb([{
      event_id: 90, event_link_type: 'case_number', event_link_id: '26-44743',
      event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing',
      event_date: '2026-11-16', event_time: '10:00:00',
    }]);
    const hit = await eventService.findDuplicateEvent(db, {
      event_link_type: 'case_number', event_link_id: '26-44743',
      event_type: 'Confirmation Hearing',
      event_title: 'Confirmation Hearing - Nechama Kramer',
      event_date: '2026-11-16', event_time: '10:00:00',
    });
    expect(hit).toBeTruthy();
    expect(hit.event_id).toBe(90);
    // Same normalized type → rule 2 fires first; that is still a correct dedupe.
    expect(['slot_type', 'slot_title']).toContain(hit._dedupe_rule);
  });

  test('RULE 3 fires when the type also varies (pure title path)', async () => {
    // Force the title path: existing type is null, candidate re-typed, so rule 2
    // cannot match and only the loose-title arm can.
    const db = makeDb([{
      event_id: 90, event_link_type: 'case_number', event_link_id: '26-44743',
      event_type: null, event_title: 'Confirmation Hearing',
      event_date: '2026-11-16', event_time: '10:00:00',
    }]);
    const hit = await eventService.findDuplicateEvent(db, {
      event_link_type: 'case_number', event_link_id: '26-44743',
      event_type: 'Hearing', event_title: 'Confirmation Hearing - Nechama Kramer',
      event_date: '2026-11-16', event_time: '10:00:00',
    });
    expect(hit).toBeTruthy();
    expect(hit._dedupe_rule).toBe('slot_title');
  });

  test('REJECT — 89/108 shape: Confirmation Hearing + Show Cause at the same slot', async () => {
    const db = makeDb([{
      event_id: 89, event_link_type: 'case_number', event_link_id: '26-44274',
      event_type: 'Confirmation Hearing', event_title: 'Confirmation Hearing',
      event_date: '2026-09-02', event_time: '14:00:00',
    }]);
    const hit = await eventService.findDuplicateEvent(db, {
      event_link_type: 'case_number', event_link_id: '26-44274',
      event_type: 'Show Cause',
      event_title: 'Order to Show Cause on Dismissal of Case for Failure to Pay Filing Fee',
      event_date: '2026-09-02', event_time: '14:00:00',
    });
    expect(hit).toBeNull();
  });

  test('REJECT — 71/110 shape: two different all-day deadlines on the same date', async () => {
    const db = makeDb([{
      event_id: 71, event_link_type: 'case', event_link_id: 'aYwkZLA3',
      event_type: 'Confirmation Certificate Deadline',
      event_title: 'Confirmation Certificate Deadline - 26-46899-lsg - Aboghene Enita Uwedjojevwe',
      event_date: '2026-09-01', event_time: null,
    }]);
    const hit = await eventService.findDuplicateEvent(db, {
      event_link_type: 'case_number', event_link_id: '26-46899',
      event_type: 'Filing Fee Installment Deadline',
      event_title: 'Final Installment Payment Due',
      event_date: '2026-09-01', event_time: null,
    });
    expect(hit).toBeNull();
  });

  test('REJECT — poc_due vs poc_gov_due at the same slot (only rejects AFTER the identity-token strip)', async () => {
    // These do not share a date in production; construct them same-slot to prove
    // the DANGEROUS case. Without stripping "Marquita/Renea/Smith/26/47542" from
    // the cores the two titles score Jaccard 0.6 → false match. findDuplicateEvent
    // must build the identity tokens off the resolved case and reject.
    const db = makeDb([{
      event_id: 101, event_link_type: 'case_number', event_link_id: '26-47542',
      event_type: 'poc_due',
      event_title: 'Proofs of Claims Due — Marquita Renea Smith (26-47542)',
      event_date: '2026-09-11', event_time: null,
    }]);
    const hit = await eventService.findDuplicateEvent(db, {
      event_link_type: 'case_number', event_link_id: '26-47542',
      event_type: 'poc_gov_due',
      event_title: 'Government POC Due — Marquita Renea Smith (26-47542)',
      event_date: '2026-09-11', event_time: null,
      // identity_tokens intentionally OMITTED → exercises the _caseIdentityTokens
      // DB lookup (case_relate → primary contact) end to end.
    });
    expect(hit).toBeNull();
  });

  test('unlinked candidate uses rule 1 only (no slot query issued)', async () => {
    const db = makeDb([{
      event_id: 5, event_link_type: null, event_link_id: null,
      event_type: 'Internal', event_title: 'Reminder smoke',
      event_date: '2026-08-01', event_time: '09:00:00',
    }]);
    const miss = await eventService.findDuplicateEvent(db, {
      event_link_type: null, event_link_id: null,
      event_type: 'Internal', event_title: 'Something else',
      event_date: '2026-08-01', event_time: '09:00:00',
    });
    expect(miss).toBeNull();
    // No slot/case queries — rule 1 missed and there is no entity to expand.
    expect(db.sqlLog.some(s => /FROM cases/i.test(s))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. createEvent { dedupe }
// ─────────────────────────────────────────────────────────────

describe('createEvent dedupe wiring', () => {
  let realCreateLogEntry, realCreateTask, realGcalCreate;

  beforeEach(() => {
    realCreateLogEntry     = logService.createLogEntry;
    realCreateTask         = taskService.createTask;
    realGcalCreate         = gcalService.createEvent;
    logService.createLogEntry = jest.fn(async () => ({ log_id: 1 }));
    taskService.createTask    = jest.fn(async () => ({ task_id: 1 }));
    gcalService.createEvent   = jest.fn(async () => ({ id: 'gcal-1' }));
  });
  afterEach(() => {
    logService.createLogEntry = realCreateLogEntry;
    taskService.createTask    = realCreateTask;
    gcalService.createEvent   = realGcalCreate;
    jest.clearAllMocks();
  });

  const candidate = {
    event_type: 'confirmation_hearing', event_link_type: 'case_number',
    event_link_id: '26-46639',
    event_title: 'Confirmation Hearing — Moneika Nashay Brown (26-46639)',
    event_date: '2026-09-02', event_time: '14:00:00', acting_user_id: 0,
    reminder: { to: 1, date: '2026-09-01' },
  };
  const existing = {
    event_id: 51, event_link_type: 'case', event_link_id: 'SUTCdsPn',
    event_type: 'Confirmation Hearing',
    event_title: 'Confirmation Hearing - 26-46639-mar - Moneika Nashay Brown',
    event_date: '2026-09-02', event_time: '14:00:00',
  };

  test('dedupe:true + hit → NO insert, NO log, NO gcal, NO reminder; returns deduped:true', async () => {
    const db = makeDb([existing]);
    const res = await eventService.createEvent(db, { ...candidate, dedupe: true });

    expect(res.deduped).toBe(true);
    expect(res.event_id).toBe(51);
    expect(db.inserted).toHaveLength(0);                       // no INSERT
    expect(logService.createLogEntry).not.toHaveBeenCalled();  // no log row
    expect(gcalService.createEvent).not.toHaveBeenCalled();    // no calendar
    expect(taskService.createTask).not.toHaveBeenCalled();     // no reminder
  });

  test('dedupe:false (default) + same slot → INSERTS anyway (manual override path)', async () => {
    const db = makeDb([existing]);
    const res = await eventService.createEvent(db, { ...candidate });  // dedupe defaults false
    expect(res.deduped).toBe(false);
    expect(db.inserted).toHaveLength(1);
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });

  test('dedupe:true + no existing → INSERTS normally, deduped:false', async () => {
    const db = makeDb([]);   // empty table
    const res = await eventService.createEvent(db, { ...candidate, dedupe: true });
    expect(res.deduped).toBe(false);
    expect(db.inserted).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. create_event internal function
// ─────────────────────────────────────────────────────────────

describe('create_event internal function — dedupe defaults TRUE', () => {
  const internalFns = require('../lib/internal_functions');
  let realCreateEvent;

  beforeEach(() => { realCreateEvent = eventService.createEvent; });
  afterEach(() => { eventService.createEvent = realCreateEvent; jest.clearAllMocks(); });

  test('omitting dedupe passes dedupe:true through to eventService.createEvent', async () => {
    eventService.createEvent = jest.fn(async () => ({ event_id: 9, event: { event_id: 9 }, deduped: false }));
    await internalFns.create_event(
      { event_title: 'X', event_date: '2026-09-02', event_link_type: 'case_number', event_link_id: '26-46639' },
      {}
    );
    expect(eventService.createEvent).toHaveBeenCalledTimes(1);
    expect(eventService.createEvent.mock.calls[0][1].dedupe).toBe(true);
  });

  test('explicit dedupe:false is honored (string "false" too — placeholder resolution)', async () => {
    eventService.createEvent = jest.fn(async () => ({ event_id: 9, event: {}, deduped: false }));
    await internalFns.create_event(
      { event_title: 'X', event_date: '2026-09-02', dedupe: 'false' }, {}
    );
    expect(eventService.createEvent.mock.calls[0][1].dedupe).toBe(false);
  });

  test('output.deduped is surfaced from the service result', async () => {
    eventService.createEvent = jest.fn(async () => ({ event_id: 51, event: { event_id: 51 }, deduped: true }));
    const out = await internalFns.create_event(
      { event_title: 'X', event_date: '2026-09-02' }, {}
    );
    expect(out.success).toBe(true);
    expect(out.output.deduped).toBe(true);
    expect(out.output.event_id).toBe(51);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. spawnReminderTask past-due guard
// ─────────────────────────────────────────────────────────────

describe('spawnReminderTask past-due guard', () => {
  let realCreateTask;
  beforeEach(() => { realCreateTask = taskService.createTask; taskService.createTask = jest.fn(async () => ({ task_id: 1 })); });
  afterEach(() => { taskService.createTask = realCreateTask; jest.clearAllMocks(); });

  const event = { event_id: 42, event_title: 'Docs due to trustee' };

  test('yesterday → returns null and never calls createTask', async () => {
    const yesterday = DateTime.now().setZone(FIRM_TZ).minus({ days: 1 }).toFormat('yyyy-MM-dd');
    const res = await eventService.spawnReminderTask({}, event, { to: 1, date: yesterday }, 0);
    expect(res).toBeNull();
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  test('today → allowed (not past)', async () => {
    const today = DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd');
    const res = await eventService.spawnReminderTask({}, event, { to: 1, date: today }, 0);
    expect(res).toBe(1);
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
  });

  test('future → allowed', async () => {
    const future = DateTime.now().setZone(FIRM_TZ).plus({ days: 30 }).toFormat('yyyy-MM-dd');
    await eventService.spawnReminderTask({}, event, { to: 1, date: future }, 0);
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
  });

  test('no date → allowed (undated reminder is not "past")', async () => {
    await eventService.spawnReminderTask({}, event, { to: 1 }, 0);
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. _dispatchAction test-envelope gate
// ─────────────────────────────────────────────────────────────

describe('emailIngestRuleService._dispatchAction — test-envelope gate', () => {
  const ruleSvc          = require('../services/emailIngestRuleService');
  const actionDispatchers = require('../lib/actionDispatchers');
  let realDispatch;

  beforeEach(() => {
    realDispatch = actionDispatchers.dispatch;
    actionDispatchers.dispatch = jest.fn(async () => ({ status: 'success', result: { id: 1 } }));
  });
  afterEach(() => { actionDispatchers.dispatch = realDispatch; jest.clearAllMocks(); });

  const rule = { id: 9, name: 'Court: Ch13 Meeting', actions: [] };

  test('is_test + workflow → skipped_test_envelope, dispatch NOT called', async () => {
    const action = { id: 8, action_type: 'workflow', config: { workflow_id: 24 } };
    const outcome = await ruleSvc._dispatchAction({}, rule, action, {}, { is_test: true });
    expect(outcome.status).toBe('skipped_test_envelope');
    expect(actionDispatchers.dispatch).not.toHaveBeenCalled();
  });

  test('is_test + internal_function → STILL dispatched (court_extract self-protects)', async () => {
    const action = { id: 11, action_type: 'internal_function', config: { function_name: 'court_extract' } };
    const outcome = await ruleSvc._dispatchAction({}, rule, action, {}, { is_test: true });
    expect(outcome.status).toBe('success');
    expect(actionDispatchers.dispatch).toHaveBeenCalledTimes(1);
  });

  test('NON-test envelope + workflow → dispatched normally', async () => {
    const action = { id: 8, action_type: 'workflow', config: { workflow_id: 24 } };
    const outcome = await ruleSvc._dispatchAction({}, rule, action, {}, { is_test: false });
    expect(outcome.status).toBe('success');
    expect(actionDispatchers.dispatch).toHaveBeenCalledTimes(1);
  });

  test('missing envelope (defensive) + workflow → dispatched (gate needs is_test===true)', async () => {
    const action = { id: 8, action_type: 'workflow', config: { workflow_id: 24 } };
    const outcome = await ruleSvc._dispatchAction({}, rule, action, {}, undefined);
    expect(outcome.status).toBe('success');
    expect(actionDispatchers.dispatch).toHaveBeenCalledTimes(1);
  });
});
