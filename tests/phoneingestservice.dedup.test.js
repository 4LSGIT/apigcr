/**
 * tests/phoneingestservice.dedup.test.js
 *
 * Tests for services/phoneIngestService.js — provider-ref normalization (C1)
 * and the true-redelivery guard (C2). MTH-2.
 *
 * THE TWO DEFECTS THIS PINS
 *
 * C1 — empty-string provider_ref collision.
 *   wf20 ("rc-call") step 3 falls back to `provider_call_id: ""` when the
 *   RingCentral call-log fetch returns no records (~4% of RC calls). The old
 *   extraction (`ex.provider_call_id ?? null`) does NOT catch '' — `??` only
 *   catches null/undefined — so '' went into the unique key
 *   ux_phone_event_provider_ref (provider, provider_ref), and every ref-less
 *   RC call collided onto ONE row (id 94) via ON DUPLICATE KEY UPDATE.
 *   65 unrelated real calls were smeared onto that row by 2026-07-14.
 *   Fix: '' / '  ' / undefined all normalize to NULL. MySQL unique indexes
 *   permit multiple NULLs → each ref-less call gets its own row.
 *
 * C2 — no true-redelivery guard.
 *   With C1 in place, a genuine (provider, provider_ref) hit means the provider
 *   redelivered the same event. Guard it so Layer-3 automation actions do not
 *   fire twice. Self-heal when the prior attempt died before the log_id
 *   backfill (log_id IS NULL → reprocess).
 *
 * DETECTION IS A SELECT, NOT r.affectedRows.
 *   `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` sets the row to its
 *   CURRENT values, so MySQL reports affectedRows = 1 on a duplicate —
 *   identical to a fresh insert. (0 without CLIENT_FOUND_ROWS; mysql2 turns it
 *   on by default and startup/db.js passes no custom flags.) Verified against
 *   MySQL 8.0.46 + mysql2 3.x with the exact production statement: fresh → 1,
 *   duplicate → 1, NEVER 2. Any guard keyed on `affectedRows === 2` would be
 *   dead code. Hence the SELECT precheck (which also mirrors
 *   emailIngestService's step-3 dedup).
 *
 * The db is a scripted FAKE (the module takes `db` as a parameter). The three
 * collaborators (logService, suppression, rules) are jest-mocked. The module
 * under test is never mocked.
 *
 * Run:
 *   npx jest tests/phoneingestservice.dedup.test.js
 */

jest.mock('../services/logService', () => ({ createLogEntry: jest.fn() }));
jest.mock('../services/phoneIngestSuppressionService', () => ({ evaluateSuppressions: jest.fn() }));
jest.mock('../services/phoneIngestRuleService', () => ({ evaluateRules: jest.fn() }));

const logService = require('../services/logService');
const suppressionService = require('../services/phoneIngestSuppressionService');
const ruleService = require('../services/phoneIngestRuleService');

const phoneIngestService = require('../services/phoneIngestService');
const { ingestPhoneEvent, resetFirmNumberCache, _normalizeProviderRef } = phoneIngestService;


// ─────────────────────────────────────────────────────────────
// Fake db. Scripted responses keyed off the SQL text; records every call.
// ─────────────────────────────────────────────────────────────
const FIRM_NUMBER = '2485592400';   // a phone_lines row
const OTHER_PARTY = '2487732948';   // not a firm number

function makeDb({ precheckRows = [], insertId = 4300, insertThrows = false } = {}) {
  const calls = [];
  const db = {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM phone_lines/.test(sql)) {
        return [[{ phone_number: FIRM_NUMBER }]];
      }
      // The precheck is the only query carrying an EXISTS() subquery.
      if (/EXISTS\(SELECT 1 FROM phone_ingest_executions/.test(sql)) {
        return [precheckRows];
      }
      if (/INSERT INTO phone_event_log/.test(sql)) {
        if (insertThrows) throw new Error('simulated catch-all failure');
        // NB: affectedRows is 1 for BOTH insert and duplicate — see header.
        return [{ insertId, affectedRows: 1 }];
      }
      if (/UPDATE phone_event_log/.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO phone_ingest_executions/.test(sql)) {
        return [{ insertId: 900 }];
      }
      throw new Error(`fake db: unexpected SQL: ${sql}`);
    }),
  };
  return db;
}

const callsMatching = (db, re) => db.calls.filter(c => re.test(c.sql));
const eventInsert   = db => callsMatching(db, /INSERT INTO phone_event_log/)[0] || null;
const precheck      = db => callsMatching(db, /EXISTS\(SELECT 1 FROM phone_ingest_executions/)[0] || null;

/** Zip the generated executions INSERT back into a { col: value } object. */
function execRow(db) {
  const c = callsMatching(db, /INSERT INTO phone_ingest_executions/)[0];
  if (!c) return null;
  const cols = c.sql.match(/\(([^)]+)\)\s+VALUES/)[1].split(',').map(s => s.trim());
  const out = {};
  cols.forEach((col, i) => { out[col] = c.params[i]; });
  return out;
}

// Column order of the catch-all INSERT:
// provider, provider_ref, provider_event_id, event_type, direction,
// from_number, to_number, other_party, body, raw_extra
const P_PROVIDER = 0;
const P_REF      = 1;

function callEvent(extra = {}) {
  return {
    type: 'call', link_type: 'phone', link_id: OTHER_PARTY, by: 0,
    direction: 'incoming', from: OTHER_PARTY, to: FIRM_NUMBER,
    extra: { provider: 'ringcentral', provider_event_id: '6397132268297936200', ...extra },
  };
}
function smsEvent(extra = {}) {
  return {
    type: 'sms', link_type: 'phone', link_id: OTHER_PARTY, by: 0,
    direction: 'incoming', from: OTHER_PARTY, to: FIRM_NUMBER, message: 'hi',
    extra: { provider: 'ringcentral', provider_event_id: 'evt-1', ...extra },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetFirmNumberCache();                        // module-level cache
  logService.createLogEntry.mockResolvedValue({ log_id: 60001 });
  suppressionService.evaluateSuppressions.mockResolvedValue({ suppressed: false, matchedRuleIds: [] });
  ruleService.evaluateRules.mockResolvedValue({ matchedRuleIds: [], actionOutcomes: [], parseWarnings: [] });
});


// ─────────────────────────────────────────────────────────────
// C1 — provider_ref normalization
// ─────────────────────────────────────────────────────────────
describe('_normalizeProviderRef — the `??` hole that ate 65 calls', () => {
  test.each([
    ['empty string',      '',            null],
    ['whitespace only',   '   ',         null],
    ['tab/newline only',  '\t\n',        null],
    ['undefined',         undefined,     null],
    ['null',              null,          null],
    ['real ref',          'abc123',      'abc123'],
    ['ref with padding',  '  abc123  ',  'abc123'],
    ['numeric ref',       6397132268,    '6397132268'],   // non-string → String()
  ])('%s → %p', (_label, input, expected) => {
    expect(_normalizeProviderRef(input)).toBe(expected);
  });

  test('`??` (the old operator) does NOT catch the empty string — regression anchor', () => {
    expect('' ?? null).toBe('');            // ← the bug, in one line
    expect(_normalizeProviderRef('')).toBeNull();
  });
});

describe('C1 — empty/whitespace/missing refs are bound into the INSERT as NULL', () => {
  test("call with provider_call_id: '' → NULL in the INSERT, no dedup path", async () => {
    const db = makeDb();
    await ingestPhoneEvent(db, callEvent({ provider_call_id: '' }));

    const ins = eventInsert(db);
    expect(ins).not.toBeNull();
    expect(ins.params[P_REF]).toBeNull();               // NOT ''
    expect(ins.params[P_PROVIDER]).toBe('ringcentral');
    expect(precheck(db)).toBeNull();                   // ref is NULL → no dedup lookup
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);   // the call IS logged
    expect(execRow(db).status).toBe('logged');
  });

  test("call with provider_call_id: '  ' (whitespace) → NULL", async () => {
    const db = makeDb();
    await ingestPhoneEvent(db, callEvent({ provider_call_id: '  ' }));
    expect(eventInsert(db).params[P_REF]).toBeNull();
    expect(precheck(db)).toBeNull();
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });

  test('call with provider_call_id missing entirely (undefined) → NULL', async () => {
    const db = makeDb();
    await ingestPhoneEvent(db, callEvent());           // no provider_call_id key at all
    expect(eventInsert(db).params[P_REF]).toBeNull();
    expect(precheck(db)).toBeNull();
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });

  test("sms with provider_message_id: '' → NULL (same fix, sms branch)", async () => {
    const db = makeDb();
    await ingestPhoneEvent(db, smsEvent({ provider_message_id: '' }));
    expect(eventInsert(db).params[P_REF]).toBeNull();
    expect(precheck(db)).toBeNull();
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });

  test('sms reads provider_message_id, call reads provider_call_id (branches not crossed)', async () => {
    const dbSms = makeDb();
    await ingestPhoneEvent(dbSms, smsEvent({ provider_message_id: 'MSG-1', provider_call_id: 'CALL-1' }));
    expect(eventInsert(dbSms).params[P_REF]).toBe('MSG-1');

    const dbCall = makeDb();
    await ingestPhoneEvent(dbCall, callEvent({ provider_message_id: 'MSG-1', provider_call_id: 'CALL-1' }));
    expect(eventInsert(dbCall).params[P_REF]).toBe('CALL-1');
  });

  test('a real ref is preserved verbatim and IS deduped against', async () => {
    const db = makeDb();
    await ingestPhoneEvent(db, callEvent({ provider_call_id: 'CALL-999' }));
    expect(eventInsert(db).params[P_REF]).toBe('CALL-999');
    expect(precheck(db)).not.toBeNull();
    expect(precheck(db).params).toEqual(['ringcentral', 'CALL-999']);
  });

  test('empty provider (either half NULL) disables dedup — mirrors the unique index', async () => {
    const db = makeDb();
    await ingestPhoneEvent(db, callEvent({ provider: '', provider_call_id: 'CALL-999' }));
    expect(eventInsert(db).params[P_PROVIDER]).toBeNull();
    expect(precheck(db)).toBeNull();   // NULLs are distinct in a MySQL unique key
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });
});


// ─────────────────────────────────────────────────────────────
// C2 — true-redelivery guard
// ─────────────────────────────────────────────────────────────
describe('C2 — fresh insert (no existing row)', () => {
  test('full pipeline runs and writes a `logged` execution', async () => {
    const db = makeDb({ precheckRows: [], insertId: 4300 });
    const out = await ingestPhoneEvent(db, callEvent({ provider_call_id: 'CALL-NEW' }));

    expect(precheck(db)).not.toBeNull();
    expect(eventInsert(db)).not.toBeNull();
    expect(suppressionService.evaluateSuppressions).toHaveBeenCalledTimes(1);
    expect(ruleService.evaluateRules).toHaveBeenCalledTimes(1);
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);

    expect(execRow(db)).toMatchObject({
      event_log_id: 4300,
      status: 'logged',
      log_id: 60001,
    });
    expect(out).toMatchObject({ log_id: 60001, suppressed: false, firmToFirm: false });
    expect(out.duplicate).toBeUndefined();
  });
});

describe('C2 — duplicate (existing row WITH a log_id): redelivery must not re-fire anything', () => {
  const setup = async () => {
    const db = makeDb({ precheckRows: [{ id: 94, log_id: 59393, suppressed: 0, has_execution: 1 }] });
    const out = await ingestPhoneEvent(db, callEvent({ provider_call_id: 'CALL-DUP' }));
    return { db, out };
  };

  test("writes a status='duplicate' execution carrying the ORIGINAL log_id", async () => {
    const { db } = await setup();
    expect(execRow(db)).toMatchObject({
      event_log_id: 94,
      status: 'duplicate',
      log_id: 59393,
      metadata: null,          // rules did NOT run — do not fabricate metadata
    });
  });

  test('does NOT call createLogEntry', async () => {
    const { db } = await setup();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    void db;
  });

  test('does NOT evaluate Layer-3 rules (no actions re-fire)', async () => {
    await setup();
    expect(ruleService.evaluateRules).not.toHaveBeenCalled();
  });

  test('does NOT evaluate Layer-2 suppressions', async () => {
    await setup();
    expect(suppressionService.evaluateSuppressions).not.toHaveBeenCalled();
  });

  test('does NOT re-insert the phone_event_log catch-all row', async () => {
    const { db } = await setup();
    expect(eventInsert(db)).toBeNull();
  });

  test('returns { log_id:<existing>, suppressed:false, duplicate:true, firmToFirm }', async () => {
    const { out } = await setup();
    expect(out).toEqual({
      log_id: 59393,
      suppressed: false,
      duplicate: true,
      firmToFirm: false,
    });
  });

  test('exactly ONE execution row is written', async () => {
    const { db } = await setup();
    expect(callsMatching(db, /INSERT INTO phone_ingest_executions/)).toHaveLength(1);
  });
});

describe('C2 — REGRESSION (MTH-2a): redelivery of a SUPPRESSED event must NOT reprocess', () => {
  // THE BUG THAT SHIPPED IN MTH-2:
  //   The guard originally read `if (dupRow.log_id != null)`. But the suppressed
  //   path deliberately SKIPS createLogEntry, so a fully-processed suppressed
  //   event carries log_id = NULL forever. The guard therefore classified every
  //   suppressed event as "died mid-flight" and fell through to the self-heal
  //   branch — re-running Layer 3 and RE-FIRING its actions on redelivery, which
  //   is precisely what the guard exists to prevent.
  //   Live DB 2026-07-14: 390 of 4309 event rows (9%) are exactly this shape.
  const SUPPRESSED_ORIGINAL = { id: 4367, log_id: null, suppressed: 1, has_execution: 1 };

  test('is treated as a duplicate, not as an incomplete run', async () => {
    const db = makeDb({ precheckRows: [SUPPRESSED_ORIGINAL] });
    await ingestPhoneEvent(db, smsEvent({ provider_message_id: '3021920551019' }));

    expect(ruleService.evaluateRules).not.toHaveBeenCalled();          // ← actions do NOT re-fire
    expect(suppressionService.evaluateSuppressions).not.toHaveBeenCalled();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    expect(eventInsert(db)).toBeNull();
  });

  test("writes status='duplicate' with log_id NULL (the original never had one)", async () => {
    const db = makeDb({ precheckRows: [SUPPRESSED_ORIGINAL] });
    await ingestPhoneEvent(db, smsEvent({ provider_message_id: '3021920551019' }));

    expect(execRow(db)).toMatchObject({
      event_log_id: 4367,
      status: 'duplicate',
      log_id: null,
      metadata: null,
    });
  });

  test("echoes the original's outcome: suppressed:true, log_id:null", async () => {
    const db = makeDb({ precheckRows: [SUPPRESSED_ORIGINAL] });
    const out = await ingestPhoneEvent(db, smsEvent({ provider_message_id: '3021920551019' }));

    expect(out).toEqual({
      log_id: null, suppressed: true, duplicate: true, firmToFirm: false,
    });
  });
});

describe('C2 — REGRESSION (MTH-2a): redelivery of an ERRORED event must NOT reprocess', () => {
  // INVALID_LOG_LINK_ID path: log_id NULL, suppressed 0 — but an executions row
  // WAS written, and Layer 3 already fired. The has_execution clause catches it.
  test('log_id NULL + suppressed 0 + has_execution 1 → duplicate', async () => {
    const db = makeDb({ precheckRows: [{ id: 500, log_id: null, suppressed: 0, has_execution: 1 }] });
    const out = await ingestPhoneEvent(db, callEvent({ provider_call_id: 'CALL-ERRORED' }));

    expect(ruleService.evaluateRules).not.toHaveBeenCalled();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
    expect(execRow(db)).toMatchObject({ event_log_id: 500, status: 'duplicate', log_id: null });
    expect(out).toEqual({ log_id: null, suppressed: false, duplicate: true, firmToFirm: false });
  });
});

describe('C2 — genuinely incomplete (no log_id, not suppressed, NO execution row): self-heal', () => {
  // The ONLY shape that is truly incomplete: the pipeline rethrows (writing no
  // executions row) when createLogEntry fails for any reason other than
  // INVALID_LOG_LINK_ID. Verified on the live DB: this predicate leaves 0 of
  // 4309 rows misclassified.
  test('prior attempt died before any terminal write → process normally', async () => {
    const db = makeDb({ precheckRows: [{ id: 94, log_id: null, suppressed: 0, has_execution: 0 }], insertId: 94 });
    const out = await ingestPhoneEvent(db, callEvent({ provider_call_id: 'CALL-HALF' }));

    // Falls through: catch-all re-runs (idempotent, LAST_INSERT_ID returns 94),
    // suppression + rules + log write all execute.
    expect(eventInsert(db)).not.toBeNull();
    expect(suppressionService.evaluateSuppressions).toHaveBeenCalledTimes(1);
    expect(ruleService.evaluateRules).toHaveBeenCalledTimes(1);
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);

    expect(execRow(db)).toMatchObject({ event_log_id: 94, status: 'logged', log_id: 60001 });
    expect(out).toMatchObject({ log_id: 60001, suppressed: false });
    expect(out.duplicate).toBeUndefined();

    // and the backfill this event previously missed now runs
    expect(callsMatching(db, /UPDATE phone_event_log SET log_id/)).toHaveLength(1);
  });
});

describe('C2 — existing behavior preserved', () => {
  test('catch-all INSERT throws → pipeline continues, eventLogId null', async () => {
    const db = makeDb({ insertThrows: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await ingestPhoneEvent(db, callEvent({ provider_call_id: 'CALL-BOOM' }));

    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    expect(ruleService.evaluateRules).toHaveBeenCalledTimes(1);
    expect(execRow(db)).toMatchObject({ event_log_id: null, status: 'logged', log_id: 60001 });
    expect(out).toMatchObject({ log_id: 60001, suppressed: false });

    warn.mockRestore();
  });

  test('dedup precheck throws → fails OPEN (event still processed, never dropped)', async () => {
    const db = makeDb();
    db.query.mockImplementationOnce(async (sql) => {   // phone_lines
      db.calls.push({ sql, params: undefined });
      return [[{ phone_number: FIRM_NUMBER }]];
    }).mockImplementationOnce(async () => { throw new Error('lock wait timeout'); }); // precheck
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await ingestPhoneEvent(db, callEvent({ provider_call_id: 'CALL-X' }));

    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ log_id: 60001, suppressed: false });
    expect(out.duplicate).toBeUndefined();

    warn.mockRestore();
  });

  test('suppressed path is untouched by the dedup work', async () => {
    suppressionService.evaluateSuppressions.mockResolvedValue({ suppressed: true, matchedRuleIds: [7] });
    const db = makeDb();

    const out = await ingestPhoneEvent(db, callEvent({ provider_call_id: 'CALL-SUP' }));

    expect(logService.createLogEntry).not.toHaveBeenCalled();
    expect(ruleService.evaluateRules).toHaveBeenCalledTimes(1);      // L3 still runs
    expect(execRow(db)).toMatchObject({ status: 'suppressed', log_id: null });
    expect(out).toEqual({ log_id: null, suppressed: true, matched_rule_ids: [7], firmToFirm: false });
  });

  test('firmToFirm is still stamped on the duplicate path', async () => {
    const db = makeDb({ precheckRows: [{ id: 94, log_id: 59393, suppressed: 0, has_execution: 1 }] });
    const ev = callEvent({ provider_call_id: 'CALL-DUP' });
    ev.link_id = FIRM_NUMBER;                        // other party IS a firm line

    const out = await ingestPhoneEvent(db, ev);

    expect(out.firmToFirm).toBe(true);
    expect(out.duplicate).toBe(true);
  });
});