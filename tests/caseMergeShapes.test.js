/**
 * tests/caseMergeShapes.test.js
 *
 * PRODUCER-SIDE CONTRACT TEST for the merge plan's `dry_run` flag.
 *
 * ── WHY THIS FILE EXISTS (Slice 3c review finding) ─────────────────────────
 *
 * `POST /api/cases/:survivor/merge` serves TWO completely different operations
 * on one endpoint with one 200 shape: a PREVIEW that writes nothing, and a real
 * merge that repoints every child record of another case onto the survivor and
 * then deletes it. `data.dry_run` is the only thing in the response that
 * distinguishes them.
 *
 * The sync bus has to tell them apart — announcing a preview would cost every
 * open Cases tab, Kanban board and case file a refetch for a dialog someone may
 * yet cancel; NOT announcing a real merge leaves all of them showing a case
 * that has silently absorbed another one. So `yc-sync.js`'s mergeGetter reads
 * that one key, and its correctness rests entirely on the producer continuing
 * to send it.
 *
 * ── THE ASYMMETRY, AND WHY IT MOVED (v2.5) ────────────────────────────────
 *
 * Slice 3b required `dry_run === false` and went silent on a plan that had lost
 * the key, reasoning that a shape change should not be guessed at. Slice 3c
 * reversed it to a truthy check — a MISSING key now announces — because the two
 * failure modes are not comparable:
 *
 *   · a missing emit on a real merge reopens the exact HIGH the matcher exists
 *     to close, invisibly, on every open surface
 *   · a wrong emit on a preview costs one idempotent refetch of correct data
 *
 * That reversal makes the DRY-RUN side the load-bearing one: silence now
 * depends on `dry_run` being present AND truthy on a preview. Which is exactly
 * what this file pins, at the producer, so drift breaks HERE — next to the code
 * that moved — rather than in a client fixture that happily keeps asserting
 * against its own hand-written copy of a shape production no longer sends.
 *
 * `tests/contactTransferShapes.test.js` is the precedent and the idiom.
 *
 * ── STUB CONVENTION ────────────────────────────────────────────────────────
 *
 * Dispatch-on-SQL-text, the same order-independent idiom that file uses (and
 * deliberately not the scripted-array idiom, whose drift failure mode is what
 * tests/helpers/scriptGuard.js exists to catch).
 *
 *   npx jest tests/caseMergeShapes.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

// The real merge writes a snapshot log row on the transaction connection.
// logService is not what this file is about, and letting it run would mean
// stubbing its whole insert path for no assertion.
jest.mock('../services/logService', () => ({
  createLogEntry: jest.fn(async () => ({ log_id: 1 })),
}));

const caseService = require('../services/caseService');

const SURVIVOR = 'AAAAAAAA';
const LOSER    = 'BBBBBBBB';

/** The two rows `SELECT * FROM cases WHERE case_id IN (?, ?)` returns. */
function caseRows(over = {}) {
  const base = {
    case_stage: 'Open', case_status: 'New', case_rec: '', case_source: '',
    case_type: 'Bankruptcy', case_subtype: 'Ch. 7',
    case_number: '', case_number_full: '',
    case_notes: '', case_alerts: '', case_dropbox: '',
    case_open_date: null, pipeline_phase: 'lead',
  };
  return [
    { case_id: SURVIVOR, ...base, ...(over.survivor || {}) },
    { case_id: LOSER,    ...base, ...(over.loser    || {}) },
  ];
}

/**
 * One dispatch stub covering every query either path can run.
 *
 * Deliberately boring: every count answers 0, every consolidation lookup
 * answers "nothing shared", so both paths reach their return statement with the
 * smallest possible amount of fixture. The flag is the subject; the plan's
 * contents are not.
 */
function stubDb({ rows = caseRows() } = {}) {
  const seen = [];

  const query = async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    seen.push(s);

    if (/^SELECT \* FROM cases WHERE case_id IN/i.test(s)) return [rows];
    // Docket adopt-collision sweep (only runs when there is something to adopt).
    if (/FROM cases WHERE case_id NOT IN/i.test(s)) return [[]];
    // Tagged-checklist consolidation: nothing shared between the two cases.
    if (/FROM checklists l JOIN checklists s/i.test(s)) return [[]];
    if (/SELECT COUNT\(\*\) AS c/i.test(s)) return [[{ c: 0 }]];
    if (/^DELETE/i.test(s)) return [{ affectedRows: 0 }];
    if (/^UPDATE/i.test(s)) return [{ affectedRows: 0 }];

    return [[]];
  };

  const conn = {
    query,
    beginTransaction: async () => {},
    commit:           async () => {},
    rollback:         async () => {},
    release:          () => {},
  };

  return { seen, query, getConnection: async () => conn };
}

// ─────────────────────────────────────────────────────────────
// The flag
// ─────────────────────────────────────────────────────────────

describe('mergeCases — the dry_run flag the bus reads', () => {
  test('A REAL MERGE carries dry_run: false, boolean', () => {
    // The assertion the bus depends on. If this ever becomes undefined, the
    // matcher's truthy check still announces (that is the point of the v2.5
    // flip) — but the plan's contract has moved and someone should know.
    return caseService.mergeCases(stubDb(), SURVIVOR, LOSER).then((plan) => {
      expect(plan).toHaveProperty('dry_run');
      expect(plan.dry_run).toBe(false);
      expect(typeof plan.dry_run).toBe('boolean');
    });
  });

  test('A DRY RUN carries dry_run: true — the silence the matcher keys on', () => {
    // THIS is the load-bearing half after the v2.5 flip. The matcher goes quiet
    // on a truthy dry_run and announces on everything else, so a preview that
    // stopped setting this would start announcing writes that never happened.
    return caseService.mergeCases(stubDb(), SURVIVOR, LOSER, { dryRun: true })
      .then((plan) => {
        expect(plan.dry_run).toBe(true);
      });
  });

  test('the survivor id the bus addresses comes back on the plan', () => {
    // mergeGetter reads `data.survivor_id` rather than the URL capture, on the
    // grounds that the body is the server's account of what it merged. That is
    // only true while the plan actually carries it.
    return caseService.mergeCases(stubDb(), SURVIVOR, LOSER).then((plan) => {
      expect(plan.survivor_id).toBe(SURVIVOR);
      expect(plan.loser_id).toBe(LOSER);
    });
  });

  test('A DRY RUN WRITES NOTHING — the premise of staying silent', () => {
    // The matcher's whole justification for dropping previews is that they have
    // no effect. Pinned rather than assumed: no UPDATE, no DELETE, and no
    // transaction opened at all.
    const db = stubDb();
    let gotConnection = false;
    const inner = db.getConnection;
    db.getConnection = async () => { gotConnection = true; return inner(); };

    return caseService.mergeCases(db, SURVIVOR, LOSER, { dryRun: true }).then(() => {
      expect(gotConnection).toBe(false);
      expect(db.seen.some(s => /^UPDATE/i.test(s))).toBe(false);
      expect(db.seen.some(s => /^DELETE/i.test(s))).toBe(false);
    });
  });

  test('a real merge DOES open a transaction and write — the contrast case', () => {
    const db = stubDb();
    let gotConnection = false;
    const inner = db.getConnection;
    db.getConnection = async () => { gotConnection = true; return inner(); };

    return caseService.mergeCases(db, SURVIVOR, LOSER).then(() => {
      expect(gotConnection).toBe(true);
      expect(db.seen.some(s => /^DELETE FROM cases WHERE case_id/i.test(s))).toBe(true);
    });
  });
});
