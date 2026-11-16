/**
 * tests/courtexecutor.resuffix.test.js
 *
 * Docket RE-SUFFIX on a judge reassignment (2026-11-16).
 *
 *   npx jest tests/courtexecutor.resuffix.test.js
 *
 * The court reassigns a case by moving its docket suffix — '26-50408-mar' →
 * '26-50408-mlo' (an explicit reassignment NEF, live 2026-09-23) or silently
 * (25-47301: stored '-tjt', the court mails '-mar'). Every later NEF resolves
 * through courtResolve's bare fallback, so the stored docket and judge used to
 * stay stale. courtExecutor now moves the docket and lets the judge follow.
 *
 * Contract under test:
 *   MOVE        — suffix-only difference, grounded verbatim → guarded UPDATE
 *                 (on the stored value), change row old → new, emit carries
 *                 the new docket, outcome stays 'none' (no applied[] entry).
 *   FOLLOW      — judge text naming the OLD suffix's judge (exact, drifted,
 *                 or a RETIRED judge's inactive role) becomes the new
 *                 suffix's judge + twin, change-logged.
 *   STAY        — text already naming the new judge: twin only. Text naming
 *                 someone else: twin only + skip judge_text_not_old_judge.
 *                 New suffix on no active role: skip suffix_not_on_roster.
 *   BLANK       — a blank judge fills from the new suffix (the fill path).
 *   NOT A MOVE  — capitalisation only; a different bare number; ungrounded.
 *   REFUSED     — stale flip-back (moved away from this suffix < 3 days ago),
 *                 collision, raced UPDATE → skip entry, docket + judge
 *                 untouched, emit keeps the stored docket.
 *   DRY/PREVIEW — plan rows only / zero writes + would_resuffix_docket.
 *   ORDER       — an AI case_judge in the same payload hits fill_only_occupied.
 *   REVERT      — a re-suffix row restores the old docket (guarded, collision-
 *                 checked) and re-resolves the twins; S1 fill rows stay
 *                 unrevertable.
 *
 * courtExecutor (incl. its judgeTextNamesSuffix) and lib/caseRoleResolver run
 * for real against the db stub.
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

const CASE = 'Iv6kDE7c';
const SHORT = '26-50408';
const OLD = '26-50408-mar';
const NEW = '26-50408-mlo';

const RESOLVED = {
  found: true, case_id: CASE, case_number: SHORT, case_number_full: OLD,
  case_caption: 'In re Ariel Kramer', case_chapter: '13',
  primary_contact_id: 7001, primary_contact_name: 'Ariel Kramer',
};
let resolveResult = { ...RESOLVED };
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...resolveResult });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const { executeCourtActions, revertCourtActions, _internal } = require('../services/courtExecutor');
const { judgeTextNamesSuffix } = _internal;

// The judge roster: suffix → role. tjt is a RETIRED (inactive) judge.
const ROLES = {
  mar: { contact_id: 2061, contact_name: 'Mark A. Randon', contact_fname: 'Mark', contact_lname: 'Randon', active: 1 },
  mlo: { contact_id: 2060, contact_name: 'Maria L. Oxholm', contact_fname: 'Maria', contact_lname: 'Oxholm', active: 1 },
  tjt: { contact_id: 2062, contact_name: 'Thomas J. Tucker', contact_fname: 'Thomas', contact_lname: 'Tucker', active: 0 },
};

function makeDb({
  caseRow = {}, collision = [], stale = [], resuffixAffected = 1, changeLogRows = [],
} = {}) {
  const row = {
    case_file_date: null, case_judge: 'Mark A. Randon', case_close_date: null,
    case_discharge_date: null, case_chapter: '13', case_trustee: '',
    case_objection: null, show_cause: null, case_number_full: OLD, ...caseRow,
  };
  const updates = []; const inserts = []; const reads = [];
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (/FROM court_ai_log WHERE message_id = \?/i.test(flat)) return [[]];
    if (/FROM cases WHERE case_id <> \?/i.test(flat)) { reads.push('collision'); return [collision.map(r => ({ ...r }))]; }
    if (/FROM ai_change_log WHERE entity_type='case' AND entity_id=\? AND field='case_number_full'/.test(flat)) {
      reads.push('stale'); return [stale.map(r => ({ ...r }))];
    }
    if (/FROM ai_change_log WHERE source_message_id=\?/i.test(flat)) return [changeLogRows.map(r => ({ ...r }))];
    if (/AS v FROM cases WHERE case_id=\? LIMIT 1/i.test(flat)) {
      const col = (flat.match(/SELECT `?(\w+)`? AS v/) || [])[1];
      return [[{ v: row[col] }]];
    }
    if (/FROM cases WHERE case_id=\? LIMIT 1/i.test(flat)) return [[{ ...row }]];
    // judgeTextNamesSuffix: names incl. inactive roles
    if (/c\.contact_fname, c\.contact_lname/.test(flat) && /judge_3/.test(flat)) {
      const r = ROLES[params[0]]; return [r ? [{ ...r }] : []];
    }
    // judgeFromDocket (JOIN, active) / resolveJudge suffix pass (no JOIN, active)
    if (/JSON_EXTRACT\(cr\.attrs, '\$\.judge_3'\)/.test(flat)) {
      const r = ROLES[params[0]];
      const hits = r && r.active ? [r] : [];
      return [/JOIN contacts/.test(flat) ? hits.map(h => ({ contact_id: h.contact_id, contact_name: h.contact_name }))
                                        : hits.map(h => ({ contact_id: h.contact_id }))];
    }
    if (/LOWER\(c\.contact_name\) = LOWER\(\?\)/.test(flat)) {
      return [Object.values(ROLES).filter(r => r.active && r.contact_name.toLowerCase() === String(params[0]).toLowerCase()).map(r => ({ contact_id: r.contact_id }))];
    }
    if (/LOWER\(c\.contact_fname\) = LOWER\(\?\)/.test(flat)) return [[]];
    if (/SELECT `value` FROM app_settings/i.test(flat)) return [[]];
    if (/^UPDATE\b/i.test(flat)) {
      updates.push({ sql: flat, params });
      if (/SET case_number_full=\? WHERE case_id=\? AND case_number_full=\?/.test(flat)) {
        if (resuffixAffected === 1) row.case_number_full = params[0];
        return [{ affectedRows: resuffixAffected }];
      }
      if (/SET case_judge=\?, case_judge_contact_id=\?/.test(flat)) row.case_judge = params[0];
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT\b/i.test(flat)) { inserts.push({ sql: flat, params }); return [{ insertId: 500 + inserts.length, affectedRows: 1 }]; }
    return [[]];
  });
  return { query, updates, inserts, reads, row };
}

const docketMoves = (db) => db.updates.filter(u => /SET case_number_full=\? WHERE case_id=\? AND case_number_full=\?/.test(u.sql));
const judgeWrites = (db) => db.updates.filter(u => /SET case_judge=\?, case_judge_contact_id=\?/.test(u.sql));
const twinOnly    = (db) => db.updates.filter(u => /^UPDATE cases SET case_judge_contact_id=\? WHERE case_id=\?$/.test(u.sql));
const rows        = (db, field) => db.inserts.filter(i => /INSERT INTO ai_change_log/.test(i.sql) && i.params[5] === field)
  .map(i => i.params.slice(5)); // [field, old, new, dry_run]
const emitted     = () => (domainEvents.emit.mock.calls.find(c => c[1] === 'case.court_processed') || [])[2];

let lastDb;
function run(overrides = {}, opts = {}) {
  lastDb = makeDb(opts.db || {});
  const docket = opts.docket || NEW;
  return executeCourtActions(lastDb, {
    payload: {
      message_id: 'court-resuffix-run', case_number: docket, case_name: 'Ariel Kramer',
      classification: 'none', needs_review: false, actions: [], ...overrides,
    },
    subject: opts.subject != null ? opts.subject : `${docket} "Reassignment of Order (LBR 1073-1)" Ch 13`,
    body: opts.body != null ? opts.body : `Case Number: ${docket}\nORDER OF THE COURT FOR REASSIGNMENT OF JUDGE.`,
    dryRun: false,
    fromEmail: 'ecfnotices@mieb.uscourts.gov',
    ...opts.exec,
  });
}

beforeEach(() => { resolveResult = { ...RESOLVED }; domainEvents.emit.mockClear(); });

// ── MOVE + FOLLOW ─────────────────────────────────────────────────────────
test('a reassignment NEF moves the docket (guarded on the stored value) and the judge follows the suffix', async () => {
  const res = await run();
  expect(docketMoves(lastDb).map(u => u.params)).toEqual([[NEW, CASE, OLD]]);
  expect(rows(lastDb, 'case_number_full')).toEqual([['case_number_full', OLD, NEW, 0]]);
  expect(judgeWrites(lastDb).map(u => u.params)).toEqual([['Maria L. Oxholm', 2060, CASE, 'Mark A. Randon']]);
  expect(judgeWrites(lastDb)[0].sql).toMatch(/WHERE case_id=\? AND case_judge=\?$/);
  expect(rows(lastDb, 'case_judge')).toEqual([['case_judge', 'Mark A. Randon', 'Maria L. Oxholm', 0]]);
  expect(emitted().data.case_number_full).toBe(NEW);
  expect(res.outcome).toBe('none');
  expect(res.applied).toHaveLength(0);
  expect(res.skipped).toEqual([]);
});

test.each([
  ['drifted text (no middle initial)', 'Mark Randon'],
  ['extra whitespace / case', '  mark a.  randon '],
])('the old judge named with %s still follows', async (_l, judge) => {
  await run({}, { db: { caseRow: { case_judge: judge } } });
  expect(judgeWrites(lastDb).map(u => u.params[0])).toEqual(['Maria L. Oxholm']);
});

test('a RETIRED judge (inactive role) still counts: the bulk-reassigned case follows to the new judge', async () => {
  resolveResult = { ...RESOLVED, case_number: '25-47301', case_number_full: '25-47301-tjt' };
  await run({}, { docket: '25-47301-mar', db: { caseRow: { case_judge: 'Thomas J. Tucker', case_number_full: '25-47301-tjt' } } });
  expect(docketMoves(lastDb).map(u => u.params)).toEqual([['25-47301-mar', CASE, '25-47301-tjt']]);
  expect(judgeWrites(lastDb).map(u => u.params.slice(0, 2))).toEqual([['Mark A. Randon', 2061]]);
});

// ── STAY ──────────────────────────────────────────────────────────────────
test('text already naming the new judge: docket moves, text stays, twin re-resolves', async () => {
  const res = await run({}, { db: { caseRow: { case_judge: 'Maria L. Oxholm' } } });
  expect(docketMoves(lastDb)).toHaveLength(1);
  expect(judgeWrites(lastDb)).toHaveLength(0);
  expect(twinOnly(lastDb).map(u => u.params)).toEqual([[2060, CASE]]);
  expect(res.skipped).toEqual([]);
});

test('text naming someone else: text stays, twin follows the suffix, skip entry for review', async () => {
  const res = await run({}, { db: { caseRow: { case_judge: 'Harry Honor' } } });
  expect(docketMoves(lastDb)).toHaveLength(1);
  expect(judgeWrites(lastDb)).toHaveLength(0);
  expect(twinOnly(lastDb).map(u => u.params)).toEqual([[2060, CASE]]);
  expect(res.skipped).toEqual([{ type: 'judge_follow', reason: 'judge_text_not_old_judge', judge: 'Harry Honor' }]);
});

test('a new suffix on no active judge role: docket moves, text stays, skip suffix_not_on_roster', async () => {
  const res = await run({}, { docket: '26-50408-xyz' });
  expect(docketMoves(lastDb).map(u => u.params[0])).toEqual(['26-50408-xyz']);
  expect(judgeWrites(lastDb)).toHaveLength(0);
  expect(res.skipped).toEqual([{ type: 'judge_follow', reason: 'suffix_not_on_roster', docket: '26-50408-xyz' }]);
  // the twin re-resolves: suffix misses, then the text's exact name (Randon, active)
  expect(twinOnly(lastDb).map(u => u.params)).toEqual([[2061, CASE]]);
});

// ── BLANK ─────────────────────────────────────────────────────────────────
test('a blank judge on a moved docket fills from the NEW suffix', async () => {
  await run({}, { db: { caseRow: { case_judge: '' } } });
  expect(judgeWrites(lastDb).map(u => u.params.slice(0, 2))).toEqual([['Maria L. Oxholm', 2060]]);
  expect(rows(lastDb, 'case_judge')).toEqual([['case_judge', '', 'Maria L. Oxholm', 0]]);
});

// ── NOT A MOVE ────────────────────────────────────────────────────────────
test.each([
  ['capitalisation only', { docket: '26-50408-MAR' }],
  ['a different bare number', { docket: '26-50409-mlo' }],
  ['the new docket not in the email', { subject: '26-50408 "Notice" Ch 13', body: 'Case Number: 26-50408' }],
  ['a bare docket', { docket: SHORT }],
])('%s → no move, no stale check, no judge write', async (_l, opts) => {
  await run({}, opts);
  expect(docketMoves(lastDb)).toHaveLength(0);
  expect(lastDb.reads).not.toContain('stale');
  expect(judgeWrites(lastDb)).toHaveLength(0);
  expect(rows(lastDb, 'case_number_full')).toEqual([]);
});

test('a stored docket whose bare number is not the case number (dirty row) → no move', async () => {
  resolveResult = { ...RESOLVED, case_number_full: '26-50407-mar' };
  await run({}, { db: { caseRow: { case_number_full: '26-50407-mar' } } });
  expect(docketMoves(lastDb)).toHaveLength(0);
  expect(lastDb.reads).not.toContain('stale');
});

test('an email bare number that is not the case\'s case number → no move', async () => {
  resolveResult = { ...RESOLVED, case_number: '26-50499' };
  await run();
  expect(docketMoves(lastDb)).toHaveLength(0);
  expect(lastDb.reads).not.toContain('stale');
});

// ── REFUSED ───────────────────────────────────────────────────────────────
test.each([
  ['stale flip-back (moved away from this suffix < 3 days ago)', { stale: [{ id: 77 }] },
    { type: 'resuffix_docket', reason: 'stale_suffix', change_log_id: 77, from: OLD, to: NEW }],
  ['another case holds the new docket', { collision: [{ case_id: 'OTHER1', case_number: '', case_number_full: NEW, case_type: 'Bankruptcy' }] },
    { type: 'resuffix_docket', reason: 'docket_collision', conflict_case_id: 'OTHER1', from: OLD, to: NEW }],
  ['the stored docket changed since resolve', { resuffixAffected: 0 },
    { type: 'resuffix_docket', reason: 'raced', from: OLD, to: NEW }],
])('%s → refused: skip entry, judge untouched, emit keeps the stored docket', async (_l, db, skip) => {
  const res = await run({}, { db });
  expect(res.skipped).toEqual([skip]);
  expect(judgeWrites(lastDb)).toHaveLength(0);
  expect(twinOnly(lastDb)).toHaveLength(0);
  expect(rows(lastDb, 'case_number_full')).toEqual([]);
  expect(rows(lastDb, 'case_judge')).toEqual([]);
  expect(emitted().data.case_number_full).toBe(OLD);
});

test('the stale check looks for THIS exact reverse move, live rows only, last 3 days', async () => {
  await run();
  const call = lastDb.query.mock.calls.find(([sql]) => /field='case_number_full'/.test(sql));
  expect(call[0].replace(/\s+/g, ' ')).toMatch(/dry_run=0 AND undone_at IS NULL AND LOWER\(old_value\)=LOWER\(\?\) AND LOWER\(new_value\)=LOWER\(\?\) AND created_at >= NOW\(\) - INTERVAL 3 DAY/);
  expect(call[1]).toEqual([CASE, NEW, OLD]);
});

// ── DRY RUN / PREVIEW ─────────────────────────────────────────────────────
test('dry run: plan rows for the move and the follow, no UPDATE, no collision query', async () => {
  await run({}, { exec: { dryRun: true } });
  expect(lastDb.updates).toHaveLength(0);
  expect(lastDb.reads).not.toContain('collision');
  expect(rows(lastDb, 'case_number_full')).toEqual([['case_number_full', OLD, NEW, 1]]);
  expect(rows(lastDb, 'case_judge')).toEqual([['case_judge', 'Mark A. Randon', 'Maria L. Oxholm', 1]]);
});

test('preview: zero writes; resolved{} says would_resuffix_docket and the docket it replaces', async () => {
  const res = await run({}, { exec: { preview: true } });
  expect(lastDb.updates).toHaveLength(0);
  expect(lastDb.inserts).toHaveLength(0);
  expect(res.resolved).toMatchObject({ case_number_full: NEW, would_fill_docket: false, would_resuffix_docket: true, previous_case_number_full: OLD });
  resolveResult = { ...RESOLVED, case_number_full: NEW };
  const same = await run({}, { exec: { preview: true } });
  expect(same.resolved).toMatchObject({ would_resuffix_docket: false, previous_case_number_full: null });
});

// ── ORDER ─────────────────────────────────────────────────────────────────
test('an AI case_judge in the same payload sees the followed judge → fill_only_occupied', async () => {
  const res = await run({
    classification: 'case_update',
    actions: [{ type: 'update_case_fields', fields: { case_judge: 'Maria L. Oxholm' }, citations: { case_judge: 'x' } }],
  });
  expect(judgeWrites(lastDb)).toHaveLength(1);
  expect(res.skipped).toContainEqual({ action_index: 0, type: 'update_case_fields', field: 'case_judge', reason: 'fill_only_occupied' });
});

// ── REVERT ────────────────────────────────────────────────────────────────
describe('revertCourtActions', () => {
  const revert = (db) => revertCourtActions(db, { messageId: 'court-resuffix-run', dryRun: false, actingUserId: 6 });
  const moveRow = { id: 901, entity_type: 'case', entity_id: CASE, field: 'case_number_full', old_value: OLD, new_value: NEW };
  const judgeRow = { id: 902, entity_type: 'case', entity_id: CASE, field: 'case_judge', old_value: 'Mark A. Randon', new_value: 'Maria L. Oxholm' };

  test('the judge row then the move row restore both, and the twins re-resolve once', async () => {
    const db = makeDb({ caseRow: { case_number_full: NEW, case_judge: 'Maria L. Oxholm' }, changeLogRows: [judgeRow, moveRow] });
    const res = await revert(db);
    expect(res.reverted.map(r => [r.change_log_id, r.field])).toEqual([[902, 'case_judge'], [901, 'case_number_full']]);
    expect(db.updates.find(u => /^UPDATE cases SET case_number_full=\? WHERE case_id=\?$/.test(u.sql)).params).toEqual([OLD, CASE]);
    expect(db.updates.filter(u => /SET case_judge_contact_id=\?, case_trustee_contact_id=\?/.test(u.sql))).toHaveLength(1);
  });

  test('a move row alone restores the docket and re-resolves the twins (the suffix keys the judge link)', async () => {
    const db = makeDb({ caseRow: { case_number_full: NEW }, changeLogRows: [moveRow] });
    const res = await revert(db);
    expect(res.reverted).toEqual([{ change_log_id: 901, entity_type: 'case', entity_id: CASE, field: 'case_number_full', action: 'restored' }]);
    expect(db.updates.filter(u => /SET case_judge_contact_id=\?, case_trustee_contact_id=\?/.test(u.sql))).toHaveLength(1);
    expect(db.updates.some(u => /^UPDATE ai_change_log SET undone_at=NOW\(\), undone_by=\? WHERE id=\?$/.test(u.sql) && u.params[1] === 901)).toBe(true);
  });

  test('a move row whose docket changed since is skipped modified_since', async () => {
    const db = makeDb({ caseRow: { case_number_full: '26-50408-prh' }, changeLogRows: [moveRow] });
    const res = await revert(db);
    expect(res.skipped).toEqual([{ change_log_id: 901, reason: 'modified_since' }]);
    expect(db.updates).toHaveLength(0);
  });

  test('a move row whose old docket another case took is skipped docket_collision', async () => {
    const db = makeDb({ caseRow: { case_number_full: NEW }, changeLogRows: [moveRow],
      collision: [{ case_id: 'OTHER1', case_number: '', case_number_full: OLD, case_type: 'Bankruptcy' }] });
    const res = await revert(db);
    expect(res.skipped).toEqual([{ change_log_id: 901, reason: 'docket_collision', conflict_case_id: 'OTHER1' }]);
    expect(db.updates).toHaveLength(0);
  });

  test('PIN: an S1 fill row (old NULL) stays unrevertable', async () => {
    const db = makeDb({ caseRow: { case_number_full: NEW }, changeLogRows: [{ ...moveRow, old_value: null }] });
    const res = await revert(db);
    expect(res.skipped).toEqual([{ change_log_id: 901, reason: 'unrevertable' }]);
  });
});

// ── RESOLVER UNIT ─────────────────────────────────────────────────────────
describe('judgeTextNamesSuffix (courtExecutor, module scope)', () => {
  const db = (rows, opts = {}) => ({
    query: jest.fn(async () => { if (opts.throws) throw new Error('db down'); return [rows]; }),
  });
  const RANDON = { contact_name: 'Mark A. Randon', contact_fname: 'Mark', contact_lname: 'Randon' };

  test.each([
    ['exact name', 'Mark A. Randon', true],
    ['case-insensitive, spaces collapsed', ' mark  a. RANDON ', true],
    ['first + last (no middle)', 'Mark Randon', true],
    ['another judge', 'Maria L. Oxholm', false],
    ['last name only', 'Randon', false],
    ['blank', '', false],
  ])('%s → %s', async (_l, text, want) => {
    expect(await judgeTextNamesSuffix(db([RANDON]), text, '26-1-mar')).toBe(want);
  });

  test('counts inactive roles (no active filter in the query); suffix lowercased', async () => {
    const d = db([RANDON]);
    await judgeTextNamesSuffix(d, 'Mark Randon', '26-1-MAR');
    expect(d.query.mock.calls[0][0]).not.toMatch(/active/);
    expect(d.query.mock.calls[0][1]).toEqual(['mar']);
  });

  test.each([
    ['no role on the suffix', [], '26-1-mar'],
    ['two roles on the suffix', [RANDON, RANDON], '26-1-mar'],
    ['garbage suffix', [RANDON], '26-00546 (jlr)'],
  ])('%s → false', async (_l, rws, docket) => {
    expect(await judgeTextNamesSuffix(db(rws), 'Mark A. Randon', docket)).toBe(false);
  });

  test('never throws', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await judgeTextNamesSuffix(db([], { throws: true }), 'Mark A. Randon', '26-1-mar')).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  test('stays out of lib/caseRoleResolver (the role-shift projection pin covers every query there)', () => {
    expect(require('../lib/caseRoleResolver').judgeTextNamesSuffix).toBeUndefined();
  });
});
