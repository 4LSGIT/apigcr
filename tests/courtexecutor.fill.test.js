/**
 * tests/courtexecutor.fill.test.js
 *
 * S1 — native case_number_full fill on fallback resolution (the Pabbly
 * docket-PATCH replacement). CAL III slice, 2026-10-12.
 *
 *   npx jest tests/courtexecutor.fill.test.js
 *
 * Contract under test (courtExecutor STEP 2 patch + pre-dispatch persist):
 *   FILL          — fallback resolution (email carried the full docket, the
 *                   case row holds only the bare form) with the full docket
 *                   grounded verbatim in subject/body → UPDATE cases fires
 *                   (guarded `IS NULL OR ''`), an ai_change_log row records
 *                   null → full, the case.court_processed emit carries the
 *                   patched data.case_number_full, and the outcome stays
 *                   'none' (the fill is a resolution byproduct, not an
 *                   action — no applied[] entry, no appliedOrIntended bump).
 *   EXACT MATCH   — case_number_full already set → no fill, no change row.
 *   BARE DOCKET   — the email's docket IS the bare form → no fill.
 *   COLLISION     — another case already holds the full form →
 *                   skipped {type:'fill_docket', reason:'docket_collision'},
 *                   no UPDATE, no change row.
 *   DRY RUN       — no UPDATE, no collision query; a plan change row lands
 *                   with dry_run=1.
 *   PREVIEW       — zero writes of any kind; the response's resolved{}
 *                   carries would_fill_docket:true + the patched
 *                   case_number_full.
 *   RACE          — UPDATE affectedRows 0 (interim Pabbly PATCH won) → no
 *                   change row, no skip entry.
 *   GROUNDING     — full docket absent from subject+body → no fill (kills a
 *                   hallucinated judge suffix; caseNumber is AI-extracted).
 *   PINS          — update_case_fields requesting case_number_full stays
 *                   forbidden_column (the AI never gains this write), and
 *                   revertCourtActions skips a fill change row as
 *                   'unrevertable' (re-fills next notice; deliberate).
 *
 * courtExecutor itself is NOT mocked; caseService.checkCaseNumberCollision
 * runs for real against the db stub (its SELECT is routed by shape).
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));
const domainEvents = require('../lib/domainEvents');

// Fallback-path resolution: row holds the bare docket, full is empty.
const FALLBACK_ROW = {
  found: true,
  case_id: 'TrezJ001',
  case_number: '26-44937',
  case_number_full: '',
  case_caption: null,
  case_chapter: '13',
  primary_contact_id: 333,
  primary_contact_name: 'Trezette M. Johnson',
};

// Patch BEFORE courtExecutor is required (it destructures at require time).
let resolveResult = { ...FALLBACK_ROW };
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...resolveResult });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const { executeCourtActions, revertCourtActions } = require('../services/courtExecutor');

const FULL = '26-44937-mar';

// ─────────────────────────────────────────────────────────────
// db stub. Routed by SQL shape:
//   * STEP 1 processed marker (court_ai_log)          → never seen
//   * collision check (`FROM cases WHERE case_id <> ?`) → `collision` rows
//   * the fill UPDATE (`SET case_number_full=?`)       → `fillAffected` rows
//   * ai_change_log / court_ai_log INSERTs             → captured
//   * revert's ai_change_log SELECT                    → `changeLogRows`
// ─────────────────────────────────────────────────────────────
function makeDb({ collision = [], fillAffected = 1, changeLogRows = [] } = {}) {
  const updates = [];
  const inserts = [];
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (/FROM court_ai_log WHERE message_id = \?/i.test(flat)) return [[]];
    if (/FROM cases WHERE case_id <> \?/i.test(flat)) {
      return [collision.map(r => ({ ...r }))];
    }
    if (/FROM ai_change_log WHERE source_message_id=\?/i.test(flat)) {
      return [changeLogRows.map(r => ({ ...r }))];
    }
    if (/FROM cases WHERE case_id=\? LIMIT 1/i.test(flat)) {
      return [[{
        case_file_date: null, case_judge: '', case_close_date: null,
        case_discharge_date: null, case_chapter: '13', case_trustee: '',
        case_objection: null, show_cause: null,
      }]];
    }
    if (/SELECT `value` FROM app_settings/i.test(flat)) return [[]];
    if (/^UPDATE\b/i.test(flat)) {
      updates.push({ sql: flat, params });
      const affected = /SET case_number_full=\?/i.test(flat) ? fillAffected : 1;
      return [{ affectedRows: affected }];
    }
    if (/^INSERT\b/i.test(flat)) {
      inserts.push({ sql: flat, params });
      return [{ insertId: 88 + inserts.length, affectedRows: 1 }];
    }
    return [[]];
  });
  return { query, updates, inserts };
}

const fillUpdates = (db) => db.updates.filter(u => /SET case_number_full=\?/i.test(u.sql));
const changeRowInserts = (db) =>
  db.inserts.filter(i => /INSERT INTO ai_change_log/i.test(i.sql));
const fillChangeRows = (db) =>
  // flushChangeRows params: [source_message_id, ai_call_id, court_ai_log_id,
  //                          entity_type, entity_id, field, old, new, dry_run]
  changeRowInserts(db).filter(i => i.params[5] === 'case_number_full');
const collisionSelects = (db) =>
  db.query.mock.calls.filter(([sql]) => /case_id <> \?/i.test(sql));
const courtProcessedEmit = () =>
  domainEvents.emit.mock.calls.find(c => c[1] === 'case.court_processed');

function run(overrides = {}, opts = {}) {
  return executeCourtActions(makeDbArg(opts), {
    payload: {
      message_id: 'court-fill-run',
      case_number: FULL,
      case_name: 'Trezette M. Johnson',
      classification: 'other_notice',
      needs_review: false,
      actions: [],
      ...overrides,
    },
    subject: `${FULL} "Certificate of Service" Ch 13`,
    body: `Case Number: ${FULL}\nDocument filed.`,
    dryRun: false,
    ...opts.exec,
  });
}
// helper so each test keeps a handle on its db
let lastDb;
function makeDbArg(opts) { lastDb = makeDb(opts.db || {}); return lastDb; }

beforeEach(() => {
  resolveResult = { ...FALLBACK_ROW };
  domainEvents.emit.mockClear();
});

// ── 1. FILL ────────────────────────────────────────────────────────────
test('fallback resolution with grounded full docket fills the column, logs the change, enriches the emit, outcome stays none', async () => {
  const res = await run();
  // UPDATE fired, guarded, with the right params
  const ups = fillUpdates(lastDb);
  expect(ups).toHaveLength(1);
  expect(ups[0].sql).toMatch(/IS NULL OR case_number_full=''/i);
  expect(ups[0].params).toEqual([FULL, 'TrezJ001']);
  // change row: case/case_number_full, null → full, dry_run 0
  const rows = fillChangeRows(lastDb);
  expect(rows).toHaveLength(1);
  expect(rows[0].params[3]).toBe('case');        // entity_type
  expect(rows[0].params[4]).toBe('TrezJ001');    // entity_id
  expect(rows[0].params[6]).toBe(null);          // old_value
  expect(rows[0].params[7]).toBe(FULL);          // new_value
  expect(rows[0].params[8]).toBe(0);             // dry_run
  // emit enriched by the in-memory patch
  const emit = courtProcessedEmit();
  expect(emit).toBeTruthy();
  expect(emit[2].data.case_number_full).toBe(FULL);
  // the fill is NOT an action
  expect(res.outcome).toBe('none');
  expect(res.applied).toHaveLength(0);
});

// ── 2. EXACT MATCH ─────────────────────────────────────────────────────
test('exact-match resolution (full already set) never fills', async () => {
  resolveResult = { ...FALLBACK_ROW, case_number_full: FULL };
  const res = await run();
  expect(fillUpdates(lastDb)).toHaveLength(0);
  expect(fillChangeRows(lastDb)).toHaveLength(0);
  expect(res.outcome).toBe('none');
});

// ── 3. BARE DOCKET ─────────────────────────────────────────────────────
test('bare-docket email (rawDocket === case_number) never fills', async () => {
  const res = await run({ case_number: '26-44937' });
  expect(fillUpdates(lastDb)).toHaveLength(0);
  expect(fillChangeRows(lastDb)).toHaveLength(0);
  expect(res.outcome).toBe('none');
});

// ── 4. COLLISION ───────────────────────────────────────────────────────
test('another case holding the full docket skips the fill as docket_collision', async () => {
  const res = await run({}, { db: { collision: [{
    case_id: 'OtherC99', case_number: '', case_number_full: FULL, case_type: 'BK',
  }] } });
  expect(fillUpdates(lastDb)).toHaveLength(0);
  expect(fillChangeRows(lastDb)).toHaveLength(0);
  expect(res.skipped).toContainEqual(
    { type: 'fill_docket', reason: 'docket_collision', conflict_case_id: 'OtherC99' });
  expect(res.outcome).toBe('none');
});

// ── 5. DRY RUN ─────────────────────────────────────────────────────────
test('dry run writes nothing to cases and records a dry_run=1 plan row; no collision query', async () => {
  await run({}, { exec: { dryRun: true } });
  expect(fillUpdates(lastDb)).toHaveLength(0);
  expect(collisionSelects(lastDb)).toHaveLength(0);
  const rows = fillChangeRows(lastDb);
  expect(rows).toHaveLength(1);
  expect(rows[0].params[8]).toBe(1);             // dry_run
  expect(domainEvents.emit).not.toHaveBeenCalled();
});

// ── 6. PREVIEW ─────────────────────────────────────────────────────────
test('preview writes nothing and exposes would_fill_docket + the patched full form', async () => {
  const res = await run({}, { exec: { preview: true } });
  expect(lastDb.updates).toHaveLength(0);
  expect(lastDb.inserts).toHaveLength(0);
  expect(res.resolved.would_fill_docket).toBe(true);
  expect(res.resolved.case_number_full).toBe(FULL);
  // existing keys intact (additive JSON only)
  expect(res.resolved.case_id).toBe('TrezJ001');
  expect(res.resolved.case_number).toBe('26-44937');
});

test('preview on an exact-match resolution reports would_fill_docket:false', async () => {
  resolveResult = { ...FALLBACK_ROW, case_number_full: FULL };
  const res = await run({}, { exec: { preview: true } });
  expect(res.resolved.would_fill_docket).toBe(false);
  expect(res.resolved.case_number_full).toBe(FULL);
});

// ── 7. RACE ────────────────────────────────────────────────────────────
test('race (full set between resolve and UPDATE) records no change row and no skip', async () => {
  const res = await run({}, { db: { fillAffected: 0 } });
  expect(fillUpdates(lastDb)).toHaveLength(1);   // the attempt happened
  expect(fillChangeRows(lastDb)).toHaveLength(0);
  expect(res.skipped).toHaveLength(0);
  expect(res.outcome).toBe('none');
});

// ── 8. GROUNDING ───────────────────────────────────────────────────────
test('full docket absent from subject+body never fills (hallucinated-suffix guard)', async () => {
  const res = await executeCourtActions(makeDbArg({}), {
    payload: {
      message_id: 'court-fill-run', case_number: FULL,
      case_name: 'Trezette M. Johnson', classification: 'other_notice',
      needs_review: false, actions: [],
    },
    subject: '26-44937 "Certificate of Service" Ch 13',   // bare form only
    body: 'Case Number: 26-44937\nDocument filed.',
    dryRun: false,
  });
  expect(fillUpdates(lastDb)).toHaveLength(0);
  expect(fillChangeRows(lastDb)).toHaveLength(0);
  expect(res.outcome).toBe('none');
  // emit full stays null — resolved was never patched
  expect(courtProcessedEmit()[2].data.case_number_full).toBe(null);
});

// ── 9. PINS ────────────────────────────────────────────────────────────
test('PIN: update_case_fields requesting case_number_full stays forbidden_column', async () => {
  resolveResult = { ...FALLBACK_ROW, case_number_full: FULL }; // exact match: isolate the pin
  const res = await run({
    classification: 'case_update',
    actions: [{ type: 'update_case_fields', fields: { case_number_full: '26-99999-xyz' } }],
  });
  expect(res.skipped).toContainEqual(
    { action_index: 0, type: 'update_case_fields', field: 'case_number_full', reason: 'forbidden_column' });
  expect(fillUpdates(lastDb)).toHaveLength(0);
});

test('PIN: revertCourtActions skips a fill change row as unrevertable', async () => {
  const db = makeDb({ changeLogRows: [{
    id: 501, entity_type: 'case', entity_id: 'TrezJ001',
    field: 'case_number_full', old_value: null, new_value: FULL,
  }] });
  const res = await revertCourtActions(db, { messageId: 'court-fill-run', dryRun: false, actingUserId: 6 });
  expect(res.skipped).toContainEqual({ change_log_id: 501, reason: 'unrevertable' });
  expect(res.reverted).toHaveLength(0);
  // and no write-back touched the column
  expect(db.updates.filter(u => /case_number_full/i.test(u.sql))).toHaveLength(0);
});
