/**
 * tests/courtexecutor.judgefill.test.js
 *
 * Judge fill from the docket suffix (2026-11-16, DZ8G0HYT / 26-52466-lsg).
 *
 *   npx jest tests/courtexecutor.judgefill.test.js
 *
 * Court NEFs never name the judge — only the docket suffix — so the AI's
 * citation-gated update_case_fields case_judge practically never fires. The
 * Pabbly 341 UPDATE used to map suffix → name; since it was disabled
 * (2026-10-12) nothing wrote cases.case_judge. courtExecutor now fills a
 * BLANK case_judge (and its twin) from the suffix before dispatch.
 *
 * Contract under test:
 *   S1 FILL       — the docket is filled this run and the judge is blank →
 *                   ONE guarded UPDATE writes case_judge + case_judge_contact_id,
 *                   a change row records '' → name, outcome stays 'none', no
 *                   applied[] entry.
 *   SELF-HEAL     — docket already full on the row, judge blank → same fill
 *                   (any later court email repairs a blank judge).
 *   OCCUPIED      — judge already set → no judge write, no change row.
 *   TWIN RESYNC   — judge set AND S1 filled the docket this run → only the
 *                   twin is re-resolved (suffix is the resolver's primary key;
 *                   S1's raw UPDATE bypasses updateCase's twin hook).
 *   MISS / AMBIG  — suffix not on the roster, or on 2 roles → nothing.
 *   NO DOCKET     — no full docket anywhere → no roster query at all.
 *   COLLISION     — S1's fill refused as docket_collision → no judge fill.
 *   DRY RUN       — no UPDATE; a dry_run=1 plan row.
 *   PREVIEW       — zero writes.
 *   RACE          — guarded UPDATE affects 0 rows → no change row.
 *   ORDER         — an AI case_judge in the same payload hits fill_only_occupied
 *                   (the in-memory row was updated).
 *   NON-FATAL     — the judge UPDATE throwing does not error the batch.
 *   REVERT        — the change row restores '' and re-resolves the twin.
 *
 * courtExecutor and lib/caseRoleResolver are NOT mocked — the resolver runs
 * for real against the db stub (its queries are routed by shape).
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));

const SHORT = '26-52466';
const FULL  = '26-52466-lsg';
const CASE  = 'DZ8G0HYT';

// S1 fallback shape: the row holds only the bare docket.
const FALLBACK_ROW = {
  found: true,
  case_id: CASE,
  case_number: SHORT,
  case_number_full: '',
  case_caption: 'In re Dawn Carla Sims',
  case_chapter: '7',
  primary_contact_id: 2367,
  primary_contact_name: 'Dawn Carla Sims',
};

let resolveResult = { ...FALLBACK_ROW };
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...resolveResult });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const { executeCourtActions, revertCourtActions } = require('../services/courtExecutor');

const ROSTER = {
  lsg: [{ contact_id: 2059, contact_name: 'Lisa S. Gretchko' }],
  mar: [{ contact_id: 2061, contact_name: 'Mark A. Randon' }],
  dup: [{ contact_id: 1, contact_name: 'A One' }, { contact_id: 2, contact_name: 'B Two' }],
};

// ─────────────────────────────────────────────────────────────
// db stub, routed by SQL shape. `caseRow` is the curCaseRow / revert read.
// ─────────────────────────────────────────────────────────────
function makeDb({
  caseRow = {}, collision = [], judgeAffected = 1, judgeThrows = false,
  changeLogRows = [], roster = ROSTER,
} = {}) {
  const row = {
    case_file_date: null, case_judge: '', case_close_date: null,
    case_discharge_date: null, case_chapter: '7', case_trustee: '',
    case_objection: null, show_cause: null, case_number_full: FULL,
    ...caseRow,
  };
  const updates = [];
  const inserts = [];
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (/FROM court_ai_log WHERE message_id = \?/i.test(flat)) return [[]];
    if (/FROM cases WHERE case_id <> \?/i.test(flat)) return [collision.map(r => ({ ...r }))];
    if (/FROM ai_change_log WHERE source_message_id=\?/i.test(flat)) {
      return [changeLogRows.map(r => ({ ...r }))];
    }
    if (/AS v FROM cases WHERE case_id=\? LIMIT 1/i.test(flat)) {
      const col = (flat.match(/SELECT `(\w+)` AS v/) || [])[1];
      return [[{ v: row[col] }]];
    }
    if (/FROM cases WHERE case_id=\? LIMIT 1/i.test(flat)) return [[{ ...row }]];
    // judgeFromDocket (JOIN contacts) and resolveJudge's suffix pass (no JOIN)
    if (/JSON_EXTRACT\(cr\.attrs, '\$\.judge_3'\)/.test(flat)) {
      const hits = roster[params[0]] || [];
      return [/JOIN contacts/.test(flat) ? hits.map(h => ({ ...h }))
                                        : hits.map(h => ({ contact_id: h.contact_id }))];
    }
    if (/SELECT `value` FROM app_settings/i.test(flat)) return [[]];
    if (/^UPDATE\b/i.test(flat)) {
      if (/SET case_judge=\?, case_judge_contact_id=\?/i.test(flat)) {
        if (judgeThrows) throw new Error('boom');
        updates.push({ sql: flat, params });
        if (judgeAffected === 1) row.case_judge = params[0];
        return [{ affectedRows: judgeAffected }];
      }
      updates.push({ sql: flat, params });
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT\b/i.test(flat)) {
      inserts.push({ sql: flat, params });
      return [{ insertId: 300 + inserts.length, affectedRows: 1 }];
    }
    return [[]];
  });
  return { query, updates, inserts, row };
}

const judgeFills  = (db) => db.updates.filter(u => /SET case_judge=\?, case_judge_contact_id=\?/i.test(u.sql));
const twinOnly    = (db) => db.updates.filter(u => /^UPDATE cases SET case_judge_contact_id=\? WHERE/i.test(u.sql));
const judgeRows   = (db) => db.inserts.filter(i => /INSERT INTO ai_change_log/i.test(i.sql) && i.params[5] === 'case_judge');
const rosterReads = (db) => db.query.mock.calls.filter(([sql]) => /JOIN contacts/.test(sql) && /judge_3/.test(sql));

let lastDb;
function run(overrides = {}, opts = {}) {
  lastDb = makeDb(opts.db || {});
  const docket = opts.docket || FULL;
  return executeCourtActions(lastDb, {
    payload: {
      message_id: 'court-judge-run',
      case_number: docket,
      case_name: 'Dawn Carla Sims',
      classification: 'meeting_ch7',
      needs_review: false,
      actions: [],
      ...overrides,
    },
    subject: `${docket} "Meeting (Chapter 7)" Ch 7`,
    body: `Case Number: ${docket}\nNotice of Chapter 7 Bankruptcy Case.`,
    dryRun: false,
    fromEmail: 'ecfnotices@mieb.uscourts.gov',
    ...opts.exec,
  });
}

beforeEach(() => { resolveResult = { ...FALLBACK_ROW }; });

// ── S1 FILL ──────────────────────────────────────────────────────────────
test('S1 fills the docket and the blank judge lands from the suffix (one guarded UPDATE, one change row)', async () => {
  const res = await run();
  const ups = judgeFills(lastDb);
  expect(ups).toHaveLength(1);
  expect(ups[0].sql).toMatch(/AND \(case_judge IS NULL OR case_judge=''\)/i);
  expect(ups[0].params).toEqual(['Lisa S. Gretchko', 2059, CASE]);
  const rows = judgeRows(lastDb);
  expect(rows).toHaveLength(1);
  // flushChangeRows params: [msg, ai_call, court_ai_log, entity_type, entity_id, field, old, new, dry_run]
  expect(rows[0].params.slice(3)).toEqual(['case', CASE, 'case_judge', '', 'Lisa S. Gretchko', 0]);
  expect(res.outcome).toBe('none');
  expect(res.applied).toHaveLength(0);
  expect(twinOnly(lastDb)).toHaveLength(0); // the fill wrote the twin itself
});

// ── SELF-HEAL ────────────────────────────────────────────────────────────
test('docket already full on the row + blank judge → same fill (self-heal on any later notice)', async () => {
  resolveResult = { ...FALLBACK_ROW, case_number_full: '26-48953-mar' };
  const res = await run({}, { docket: '26-48953-mar' });
  expect(judgeFills(lastDb).map(u => u.params)).toEqual([['Mark A. Randon', 2061, CASE]]);
  expect(judgeRows(lastDb)).toHaveLength(1);
  expect(res.outcome).toBe('none');
});

// ── OCCUPIED ─────────────────────────────────────────────────────────────
test('judge already set (docket already full) → no judge write, no twin write, no change row', async () => {
  resolveResult = { ...FALLBACK_ROW, case_number_full: FULL };
  await run({}, { db: { caseRow: { case_judge: 'Lisa Gretchko' } } });
  expect(judgeFills(lastDb)).toHaveLength(0);
  expect(twinOnly(lastDb)).toHaveLength(0);
  expect(judgeRows(lastDb)).toHaveLength(0);
  expect(rosterReads(lastDb)).toHaveLength(0);
});

// ── TWIN RESYNC ──────────────────────────────────────────────────────────
test('judge set + S1 filled the docket this run → only the twin re-resolves, from the suffix', async () => {
  await run({}, { db: { caseRow: { case_judge: 'Someone Typed This' } } });
  expect(judgeFills(lastDb)).toHaveLength(0);
  expect(judgeRows(lastDb)).toHaveLength(0);
  const tw = twinOnly(lastDb);
  expect(tw).toHaveLength(1);
  expect(tw[0].params).toEqual([2059, CASE]);
});

// ── MISS / AMBIGUOUS ─────────────────────────────────────────────────────
test.each([
  ['suffix not on the roster', '26-52466-pjs'],
  ['suffix on two active roles', '26-52466-dup'],
])('%s → nothing written', async (_label, docket) => {
  const res = await run({}, { docket });
  expect(rosterReads(lastDb)).toHaveLength(1);
  expect(judgeFills(lastDb)).toHaveLength(0);
  expect(judgeRows(lastDb)).toHaveLength(0);
  expect(res.outcome).toBe('none');
});

// ── NO DOCKET ────────────────────────────────────────────────────────────
test('bare-docket email on a bare-docket row → no roster query, no write', async () => {
  await run({}, { docket: SHORT });
  expect(rosterReads(lastDb)).toHaveLength(0);
  expect(judgeFills(lastDb)).toHaveLength(0);
});

// ── COLLISION ────────────────────────────────────────────────────────────
test('S1 fill refused as docket_collision → the refused docket never feeds a judge fill', async () => {
  const res = await run({}, { db: { collision: [{
    case_id: 'OtherC99', case_number: '', case_number_full: FULL, case_type: 'Bankruptcy',
  }] } });
  expect(res.skipped).toContainEqual(
    { type: 'fill_docket', reason: 'docket_collision', conflict_case_id: 'OtherC99' });
  expect(rosterReads(lastDb)).toHaveLength(0);
  expect(judgeFills(lastDb)).toHaveLength(0);
  expect(judgeRows(lastDb)).toHaveLength(0);
});

// ── DRY RUN / PREVIEW ────────────────────────────────────────────────────
test('dry run writes nothing to cases and records a dry_run=1 plan row', async () => {
  await run({}, { exec: { dryRun: true } });
  expect(judgeFills(lastDb)).toHaveLength(0);
  expect(twinOnly(lastDb)).toHaveLength(0);
  const rows = judgeRows(lastDb);
  expect(rows).toHaveLength(1);
  expect(rows[0].params.slice(5)).toEqual(['case_judge', '', 'Lisa S. Gretchko', 1]);
});

test('preview writes nothing at all', async () => {
  await run({}, { exec: { preview: true } });
  expect(lastDb.updates).toHaveLength(0);
  expect(lastDb.inserts).toHaveLength(0);
});

// ── RACE ─────────────────────────────────────────────────────────────────
test('guarded UPDATE affecting 0 rows (judge set meanwhile) → no change row', async () => {
  const res = await run({}, { db: { judgeAffected: 0 } });
  expect(judgeFills(lastDb)).toHaveLength(1);
  expect(judgeRows(lastDb)).toHaveLength(0);
  expect(res.outcome).toBe('none');
});

// ── ORDER ────────────────────────────────────────────────────────────────
test('an AI case_judge in the same payload sees the filled value → fill_only_occupied', async () => {
  const res = await run({
    actions: [{ type: 'update_case_fields', fields: { case_judge: 'Lisa Gretchko' },
                citations: { case_judge: 'x' } }],
  });
  expect(judgeFills(lastDb)).toHaveLength(1);
  expect(res.skipped).toContainEqual(
    { action_index: 0, type: 'update_case_fields', field: 'case_judge', reason: 'fill_only_occupied' });
  expect(lastDb.updates.filter(u => /SET `case_judge`=\?/.test(u.sql))).toHaveLength(0);
});

// ── NON-FATAL ────────────────────────────────────────────────────────────
test('the judge UPDATE throwing does not error the batch; later actions still apply', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await run({
      actions: [{ type: 'update_case_fields', fields: { case_objection: '2027-02-08' },
                  citations: { case_objection: 'x' } }],
    }, { db: { judgeThrows: true } });
    expect(res.outcome).toBe('executed');
    expect(res.applied.map(a => a.field)).toEqual(['case_objection']);
    expect(judgeRows(lastDb)).toHaveLength(0);
    expect(spy.mock.calls.some(c => /judge fill from docket failed/.test(c[0]))).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

// ── REVERT ───────────────────────────────────────────────────────────────
test('revert restores the blank judge and re-resolves the twin from the row as it now stands', async () => {
  const db = makeDb({
    caseRow: { case_judge: 'Lisa S. Gretchko' },
    changeLogRows: [{ id: 901, entity_type: 'case', entity_id: CASE,
      field: 'case_judge', old_value: '', new_value: 'Lisa S. Gretchko' }],
  });
  const res = await revertCourtActions(db, { messageId: 'court-judge-run', dryRun: false, actingUserId: 6 });
  expect(res.reverted).toEqual([expect.objectContaining({ change_log_id: 901, field: 'case_judge', action: 'restored' })]);
  const back = db.updates.find(u => /^UPDATE cases SET `case_judge`=\?/.test(u.sql));
  expect(back.params).toEqual(['', CASE]);
  expect(db.updates.some(u => /SET case_judge_contact_id=\?, case_trustee_contact_id=\?/.test(u.sql))).toBe(true);
});

// ── RESOLVER UNIT ────────────────────────────────────────────────────────
describe('caseRoleResolver.judgeFromDocket', () => {
  const { judgeFromDocket } = require('../lib/caseRoleResolver');
  const db = (rows, opts = {}) => ({
    query: jest.fn(async () => { if (opts.throws) throw new Error('db down'); return [rows]; }),
  });

  test('one active role on the suffix → { contact_id, name }', async () => {
    const d = db([{ contact_id: '2059', contact_name: ' Lisa S. Gretchko ' }]);
    expect(await judgeFromDocket(d, '26-52466-LSG')).toEqual({ contact_id: 2059, name: 'Lisa S. Gretchko' });
    expect(d.query.mock.calls[0][1]).toEqual(['lsg']);
    expect(d.query.mock.calls[0][0]).toMatch(/cr\.active = 1/);
  });

  test.each([
    ['garbage suffix', '26-00546 (jlr)', [{ contact_id: 1, contact_name: 'X' }]],
    ['no docket', '', [{ contact_id: 1, contact_name: 'X' }]],
    ['zero roles', '26-1-lsg', []],
    ['two roles', '26-1-lsg', [{ contact_id: 1, contact_name: 'A' }, { contact_id: 2, contact_name: 'B' }]],
    ['blank name', '26-1-lsg', [{ contact_id: 1, contact_name: '  ' }]],
    ['name over varchar(100)', '26-1-lsg', [{ contact_id: 1, contact_name: 'x'.repeat(101) }]],
  ])('%s → null', async (_l, docket, rows) => {
    expect(await judgeFromDocket(db(rows), docket)).toBeNull();
  });

  test('never throws', async () => {
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      expect(await judgeFromDocket(db([], { throws: true }), '26-1-lsg')).toBeNull();
    } finally { spy.mockRestore(); }
  });
});
