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
const logService  = require('../services/logService');
// M1.2 spies on emit rather than jest.mock'ing the module: mocking would apply
// to every test in the file, and the assertion that matters is "the merge path
// still emits nothing", which is only meaningful against the real object
// caseService holds a reference to.
const domainEvents = require('../lib/domainEvents');

beforeEach(() => jest.clearAllMocks());

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
 *
 * (M1) Two additions, both additive:
 *   · `calls` records {sql, params} alongside `seen`, because the child-repoint
 *     tests below assert BIND ORDER — a repoint that swapped (survivor, loser)
 *     would move the survivor's rows onto a case about to be deleted, and no
 *     assertion on SQL text alone can see that.
 *   · `answers` lets one test hand a specific result to a specific statement
 *     (matched by regex, consulted BEFORE the generic fallbacks) so the
 *     survivor-wins split can be modelled without teaching the stub to be a
 *     database.
 *
 * (M1.2) An `answers` VALUE may now also be a FUNCTION, called as
 * `fn(sql, params)` and expected to return the same `[rows]` shape. This is
 * not generality for its own sake: M1.2 brackets the repoint loop with the
 * SAME statement run twice — the survivor's latest stage-log row BEFORE the
 * loser's history arrives, and again after — and the difference between those
 * two answers IS the mechanism. A single fixed result cannot express it, and
 * the alternative (a scripted array the stub shifts) is precisely the idiom
 * tests/helpers/scriptGuard.js exists to keep out of this file.
 */
function stubDb({ rows = caseRows(), answers = [] } = {}) {
  const seen = [];
  const calls = [];

  const query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    seen.push(s);
    calls.push({ sql: s, params: params || [] });

    for (const [re, result] of answers) {
      if (re.test(s)) {
        return typeof result === 'function' ? result(s, params || []) : result;
      }
    }

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

  return { seen, calls, query, getConnection: async () => conn };
}

/** The single call matching `re` — fails loudly on 0 or 2+, because "the
 *  statement I meant" is the whole point of every assertion below. */
function oneCall(db, re) {
  const hits = db.calls.filter(c => re.test(c.sql));
  expect(hits).toHaveLength(1);
  return hits[0];
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

// ─────────────────────────────────────────────────────────────
// M1 (2026-08-28) — the child repoint set covers every case-keyed table
// ─────────────────────────────────────────────────────────────
//
// ── WHY THIS SECTION EXISTS ────────────────────────────────────────────────
//
// `CHILDREN` predates the pipeline engine, the trigger engine and the client
// portal. A live audit of every case-keyed column in the schema (2026-08-28)
// found six tables missing from it, and NONE of those tables carries a foreign
// key — so the loser's `DELETE FROM cases` in step 5 would not have errored on
// them. It would have stranded their rows, silently, pointing at a case_id that
// no longer exists. The live orphan count is 0 today only because no merge
// loser has yet held a row in any of them.
//
// That is a failure mode with no symptom: nothing throws, nothing logs, and the
// damage is only visible if someone thinks to LEFT JOIN for it. So the coverage
// is pinned here rather than left to the next audit.
//
// ── WHAT IS ACTUALLY WORTH ASSERTING ──────────────────────────────────────
//
// Not "does the statement exist" — that is a spelling test. The three things
// that can silently go wrong:
//
//   · BIND ORDER. `[survivor, loser]` reversed is a valid statement that moves
//     the SURVIVOR's rows onto the case about to be deleted. No amount of SQL
//     text inspection catches it; only the params do.
//   · THE SURVIVOR-WINS SPLIT. case_requirement_overrides has a UNIQUE
//     (case_id, requirement_key). A collider must be DROPPED and a
//     non-collider must be MOVED, and the merge note must report both numbers,
//     or a discarded override leaves no trace at all.
//   · SCOPE CREEP. Two entries are deliberately narrower than they look:
//     case_stage_aged_emitted repoints case_id and NOT stage_log_id (its
//     uniqueness key, which must stay pointing at the same log rows), and
//     trigger_executions repoints the case_id COLUMN and not the `envelope`
//     JSON that also contains ids. Both are the kind of thing a later reader
//     "fixes". These tests are the reason not to.

const M1_TABLES = [
  'case_stage_log',
  'case_requirement_overrides',
  'case_stage_aged_emitted',
  'case_folder_cache',
  'portal_access_log',
  'trigger_executions',
];

describe('M1 — every case-keyed table is repointed', () => {
  test('the five repointable tables bind (survivor, loser) — never the reverse', async () => {
    // Reversal is the silent catastrophe: a valid UPDATE that migrates the
    // SURVIVOR's rows onto the case step 5 is about to delete.
    const db = stubDb();
    await caseService.mergeCases(db, SURVIVOR, LOSER);

    for (const table of ['case_stage_log', 'case_requirement_overrides',
                         'case_stage_aged_emitted', 'portal_access_log',
                         'trigger_executions']) {
      const call = oneCall(db, new RegExp(`^UPDATE ${table} SET case_id`, 'i'));
      expect(call.sql).toBe(`UPDATE ${table} SET case_id = ? WHERE case_id = ?`);
      expect(call.params).toEqual([SURVIVOR, LOSER]);
    }
  });

  test('case_folder_cache is DELETE-ONLY — never repointed, and never the survivor', async () => {
    // PK is case_id, so a repoint collides outright when the survivor has a
    // row — but the real reason is that this caches a Dropbox folder, and
    // case_dropbox is survivor-wins. Moving the loser's cache row would hand
    // the survivor a resolved folder its own case_dropbox contradicts.
    const db = stubDb();
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    expect(db.calls.some(c => /^UPDATE case_folder_cache/i.test(c.sql))).toBe(false);

    const del = oneCall(db, /^DELETE FROM case_folder_cache/i);
    expect(del.sql).toBe('DELETE FROM case_folder_cache WHERE case_id <> ? AND case_id = ?');
    // The `<> ?` guard is structural, not decoration: the survivor's own cache
    // row can never be the one this statement removes.
    expect(del.params).toEqual([SURVIVOR, LOSER]);

    // Reported at 0 moved (with its rows under `_dropped`), so the label still
    // appears in the merge note like every other child table.
    expect(plan.children.case_folder_cache).toBe(0);
    expect(plan.children).toHaveProperty('case_folder_cache_dropped');
  });

  test('SURVIVOR-WINS overrides: the collider is dropped, the rest repointed, both counted', async () => {
    // Fixture: the loser holds two overrides — one on a requirement_key the
    // survivor has already ruled on (collides, cannot move) and one it has
    // not (moves). The collide-DELETE reports 1, the UPDATE reports the
    // surviving 1.
    const db = stubDb({
      answers: [
        [/^DELETE lo FROM case_requirement_overrides/i, [{ affectedRows: 1 }]],
        [/^UPDATE case_requirement_overrides SET case_id/i, [{ affectedRows: 1 }]],
      ],
    });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    const del = oneCall(db, /^DELETE lo FROM case_requirement_overrides/i);
    // Collision key is (case_id, requirement_key) — the survivor's ruling on a
    // key is the one about the case that continues to exist.
    expect(del.sql).toMatch(/so\.case_id = \? AND so\.requirement_key = lo\.requirement_key/);
    expect(del.sql).toMatch(/WHERE lo\.case_id = \?/);
    expect(del.params).toEqual([SURVIVOR, LOSER]);

    expect(plan.children.case_requirement_overrides).toBe(1);
    expect(plan.children.case_requirement_overrides_dropped).toBe(1);
  });

  test('the collide-DELETE runs BEFORE the repoint it protects', async () => {
    // Order is the whole mechanism. Repoint first and the UPDATE hits
    // ER_DUP_ENTRY on uq_case_reqkey and rolls the entire merge back.
    const db = stubDb();
    await caseService.mergeCases(db, SURVIVOR, LOSER);

    const idxDelete = db.calls.findIndex(c => /^DELETE lo FROM case_requirement_overrides/i.test(c.sql));
    const idxUpdate = db.calls.findIndex(c => /^UPDATE case_requirement_overrides SET case_id/i.test(c.sql));
    expect(idxDelete).toBeGreaterThan(-1);
    expect(idxUpdate).toBeGreaterThan(idxDelete);
  });

  test('case_stage_aged_emitted repoints case_id ONLY — stage_log_id is never bound', async () => {
    // Its UNIQUE is (stage_log_id, threshold_days), and the case_stage_log
    // repoint changes no row IDS — so the claims stay valid exactly as they
    // are. Touching stage_log_id here would break the claims; DELETING the
    // rows instead would re-arm every already-emitted aged threshold and
    // replay the events.
    const db = stubDb();
    await caseService.mergeCases(db, SURVIVOR, LOSER);

    const call = oneCall(db, /^UPDATE case_stage_aged_emitted/i);
    expect(call.sql).not.toMatch(/stage_log_id|threshold_days/);
    expect(call.params).toEqual([SURVIVOR, LOSER]);
    expect(db.calls.some(c => /^DELETE FROM case_stage_aged_emitted/i.test(c.sql))).toBe(false);
  });

  test('trigger_executions touches the case_id COLUMN and not the envelope JSON', async () => {
    // The envelope is an immutable record of what the engine was handed at the
    // time. Rewriting it to say a trigger fired for a case that did not exist
    // yet would make the execution log lie about the past.
    const db = stubDb();
    await caseService.mergeCases(db, SURVIVOR, LOSER);

    const call = oneCall(db, /^UPDATE trigger_executions/i);
    expect(call.sql).not.toMatch(/envelope|outcomes|JSON_/i);
    expect(call.params).toEqual([SURVIVOR, LOSER]);
  });

  test('every new label reaches the plan AND the merge note (the audit trail)', async () => {
    // "0 rows" entries are fine and expected today — the point is that the
    // note names the table at all, so a future merge that DID move rows in one
    // of them is legible in the log rather than invisible.
    const db = stubDb();
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    for (const t of M1_TABLES) expect(plan.children).toHaveProperty(t);

    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    const entry = logService.createLogEntry.mock.calls[0][1];
    for (const t of M1_TABLES) expect(entry.message).toContain(`${t}=`);
    expect(entry.message).toContain('case_requirement_overrides_dropped=');
    expect(entry.message).toContain('case_folder_cache_dropped=');
    // The snapshot's children block is the recoverable copy of the same thing.
    expect(entry.extra.merge.children).toEqual(plan.children);
  });

  test('a DRY RUN previews the new tables too — including the survivor-wins split', async () => {
    // The preview's justification is that it describes the merge that would
    // happen. A delete-only table must preview 0 moved, not "1 will move".
    const db = stubDb({
      answers: [
        [/FROM case_requirement_overrides lo JOIN/i, [[{ c: 2 }]]],
        [/SELECT COUNT\(\*\) AS c FROM case_folder_cache WHERE case_id <> \?/i, [[{ c: 1 }]]],
        [/SELECT COUNT\(\*\) AS c FROM case_folder_cache WHERE case_id = \?/i, [[{ c: 1 }]]],
      ],
    });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER, { dryRun: true });

    expect(plan.children.case_folder_cache).toBe(0);          // never repointed
    expect(plan.children.case_folder_cache_dropped).toBe(1);
    expect(plan.children.case_requirement_overrides_dropped).toBe(2);
    for (const t of M1_TABLES) expect(plan.children).toHaveProperty(t);
    // Still writes nothing (the premise the sync bus stays silent on).
    expect(db.seen.some(s => /^UPDATE/i.test(s))).toBe(false);
    expect(db.seen.some(s => /^DELETE/i.test(s))).toBe(false);
  });

  test('the pre-existing entries are byte-for-byte unchanged', async () => {
    // M1 extended the entry shape (an optional 4th slot). The thirteen entries
    // that were already here keep their exact statements and their exact
    // binds — including `log`, the one label the loop special-cases to bind
    // THREE params (log_link_id + log_link + the WHERE).
    const db = stubDb();
    await caseService.mergeCases(db, SURVIVOR, LOSER);

    const UNCHANGED = [
      ['UPDATE case_relate SET case_relate_case_id = ? WHERE case_relate_case_id = ?', [SURVIVOR, LOSER]],
      ['UPDATE appts SET appt_case_id = ? WHERE appt_case_id = ?', [SURVIVOR, LOSER]],
      [`UPDATE tasks SET task_link_id = ? WHERE task_link_type = 'case' AND task_link_id = ?`, [SURVIVOR, LOSER]],
      [`UPDATE checklists SET link = ? WHERE link_type = 'case' AND link = ?`, [SURVIVOR, LOSER]],
      [`UPDATE events SET event_link_id = ? WHERE event_link_type = 'case' AND event_link_id = ?`, [SURVIVOR, LOSER]],
      [`UPDATE log SET log_link_id = ?, log_link = ? WHERE log_link_type = 'case' AND log_link_id = ?`,
        [SURVIVOR, SURVIVOR, LOSER]],
      [`UPDATE log SET log_about_id = ? WHERE log_about_type = 'case' AND log_about_id = ?`, [SURVIVOR, LOSER]],
      [`UPDATE form_submissions SET link_id = ? WHERE link_type = 'case' AND link_id = ?`, [SURVIVOR, LOSER]],
      [`UPDATE signing_requests SET linkable_id = ? WHERE linkable_type = 'case' AND linkable_id = ?`, [SURVIVOR, LOSER]],
      ['UPDATE sequences SET seq_case = ? WHERE seq_case = ?', [SURVIVOR, LOSER]],
      ['UPDATE court_ai_log SET resolved_case_id = ? WHERE resolved_case_id = ?', [SURVIVOR, LOSER]],
      ['UPDATE video_views SET case_id = ? WHERE case_id = ?', [SURVIVOR, LOSER]],
      [`UPDATE ai_change_log SET entity_id = ? WHERE entity_type = 'case' AND entity_id = ?`, [SURVIVOR, LOSER]],
    ];

    for (const [sql, params] of UNCHANGED) {
      const hits = db.calls.filter(c => c.sql === sql);
      expect(hits).toHaveLength(1);
      expect(hits[0].params).toEqual(params);
    }
  });

  test('the loser is still deleted LAST, after every repoint', async () => {
    // The repoints are only safe because they precede the delete. A new entry
    // appended after step 5 would strand exactly the rows it meant to save.
    const db = stubDb();
    await caseService.mergeCases(db, SURVIVOR, LOSER);

    const idxDelete = db.calls.findIndex(c => /^DELETE FROM cases WHERE case_id/i.test(c.sql));
    expect(idxDelete).toBeGreaterThan(-1);
    for (const t of M1_TABLES) {
      const idx = db.calls.findIndex(c => new RegExp(`(UPDATE|DELETE(?: lo)?(?: FROM)?) ${t}\\b`, 'i').test(c.sql));
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(idxDelete);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// M1.2 (2026-08-29) — the survivor's pipeline position survives the merge
// ─────────────────────────────────────────────────────────────
//
// ── WHY THIS SECTION EXISTS ────────────────────────────────────────────────
//
// M1 added `case_stage_log` to the repoint set, which was right — the rows had
// to move or the loser's DELETE would strand them. What it did not account for
// is that case_stage_log is not only history. It is the CURRENT-POSITION
// ORACLE: getPipeline's `current` is the last row of
// `ORDER BY entered_at ASC, id ASC`, advanceStage's `latest` is the first of
// the same order reversed, and `latest` feeds onlyFrom, onlyFromRole,
// _resolveTarget, the idempotency check and forwardOnly — and names the stage
// whose template role advanceStage writes into `cases.pipeline_phase`.
//
// The canonical merge pair is a stale docketless LEAD absorbed into the
// RETAINED case it became, and the lead is the side touched most recently:
// live (2026-08-29), 72 of the 74 phase='case' cases carrying stage history
// have a newest row OLDER than the newest lead row. So after the repoint, the
// loser's intake rows are the survivor's `latest`, and an automation guarded
// `onlyFromRole:['intake']` — which correctly SKIPPED this case a minute
// earlier — MATCHES, advances into an intake stage, and demotes a retained
// case back into the funnel. That is the T8 failure, re-entered through merge.
//
// ── WHAT IS ACTUALLY WORTH ASSERTING ──────────────────────────────────────
//
//   · THE DECISION IS BY ROW ID, NOT TIMESTAMP. An equal `entered_at` broken
//     by `id DESC` moves the position just as surely as a newer one, and a
//     timestamp comparison would miss it entirely. Pinned as its own case.
//   · THE ROW IS BOOKKEEPING. No domain event (case.stage_advanced on a merge
//     would start rule cascades over a position that never changed), no
//     `cases` write (step 3's field rules already settled the position; this
//     row exists to stop the log contradicting them).
//   · THE RESIDUAL IS REPORTED. A survivor with no history of its own has no
//     position to restore. That is a real outcome, not a no-op, and it has to
//     reach the merge note or nobody will ever know it happened.
//   · THE PREVIEW DESCRIBES THE MERGE. A dry run that says nothing about the
//     position decision is a preview of a different operation.

/** The projection SURVIVOR_LATEST_SQL / MERGED_LATEST_SQL return. */
function stageRow(over = {}) {
  return {
    id: 10,
    template_id: 3,
    stage_id: 31,
    stage_key: 'retained',
    case_stage: 'Filed',
    status_label: 'Retained',
    entered_at_str: '2026-01-10 09:00:00',
    ...over,
  };
}

/** The survivor's own position (a retained case) and the loser's newer intake
 *  row — the shape of every real merge this exists to protect. */
const SURVIVOR_POS = stageRow();
const LOSER_POS = stageRow({
  id: 44, template_id: 1, stage_id: 5,
  stage_key: 'consult_booked', case_stage: 'Open', status_label: 'Consult Booked',
  entered_at_str: '2026-08-20 14:30:00',
});

// The two reads. Anchored on the WHERE clause because that is the only thing
// that distinguishes them, and they must never cross-match: `case_id = ?` is
// the real path's bracket, `case_id IN (?, ?)` is the dry run's simulation.
const SURVIVOR_LATEST_RE = /FROM case_stage_log WHERE case_id = \? ORDER BY entered_at DESC, id DESC LIMIT 1/i;
const MERGED_LATEST_RE   = /FROM case_stage_log WHERE case_id IN \(\?, \?\) ORDER BY entered_at DESC, id DESC LIMIT 1/i;

/** Answers the survivor-latest read with `pre` first and `post` after — the
 *  before/after the repoint loop sits between. `null` means "no rows". */
function bracketed(pre, post) {
  let n = 0;
  return () => {
    const row = (n++ === 0) ? pre : post;
    return [row ? [row] : []];
  };
}

describe('M1.2 — the survivor keeps its pipeline position across a merge', () => {
  test('LOSER ROW NEWER: one re-assert row, no domain event, no `cases` write', async () => {
    const db = stubDb({ answers: [[SURVIVOR_LATEST_RE, bracketed(SURVIVOR_POS, LOSER_POS)]] });
    const emit = jest.spyOn(domainEvents, 'emit').mockImplementation(() => {});

    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    const ins = oneCall(db, /^INSERT INTO case_stage_log/i);
    // The stage columns are the SURVIVOR's, copied verbatim off the row the
    // repoint just buried. Copying the loser's instead would write down the
    // demotion rather than undo it.
    expect(ins.params).toEqual([
      SURVIVOR,
      SURVIVOR_POS.template_id,
      SURVIVOR_POS.stage_id,
      SURVIVOR_POS.stage_key,
      SURVIVOR_POS.case_stage,
      SURVIVOR_POS.status_label,
      LOSER_POS.entered_at_str,        // the superseded row's stamp, for GREATEST
      null,                            // entered_by: by=0 → NULL (system)
      'system',                        // enum has no 'merge' member
      `[merge ${LOSER}] position re-asserted`,
    ]);
    // Merge time, except when the row it supersedes is stamped later — then
    // match it and win on the id tiebreak. NULL-safe because a NULL here would
    // land a zero-date (no STRICT_TRANS_TABLES) and sort the row to the bottom.
    expect(ins.sql).toMatch(/GREATEST\(NOW\(\), COALESCE\(\?, NOW\(\)\)\)/);
    // Bookkeeping, not an advance: no event, and nothing written to `cases`.
    expect(emit).not.toHaveBeenCalled();
    expect(db.calls.some(c => /^UPDATE cases SET/i.test(c.sql))).toBe(false);

    expect(plan.children.case_stage_log_reassert).toBe('row');
    expect(plan.children.case_stage_log_reassert_stage).toBe('retained');
    expect(plan.children).not.toHaveProperty('case_stage_log_position');

    emit.mockRestore();
  });

  test('the re-assert lands AFTER the repoint and BEFORE the loser is deleted', async () => {
    // Before the repoint it would be buried by the rows it is meant to
    // outrank; after the DELETE there would be no transaction left to be in.
    const db = stubDb({ answers: [[SURVIVOR_LATEST_RE, bracketed(SURVIVOR_POS, LOSER_POS)]] });
    await caseService.mergeCases(db, SURVIVOR, LOSER);

    const idxMove   = db.calls.findIndex(c => /^UPDATE case_stage_log SET case_id/i.test(c.sql));
    const idxInsert = db.calls.findIndex(c => /^INSERT INTO case_stage_log/i.test(c.sql));
    const idxDelete = db.calls.findIndex(c => /^DELETE FROM cases WHERE case_id/i.test(c.sql));
    expect(idxMove).toBeGreaterThan(-1);
    expect(idxInsert).toBeGreaterThan(idxMove);
    expect(idxDelete).toBeGreaterThan(idxInsert);
  });

  test('the decision reaches the merge note and the recovery snapshot', async () => {
    const db = stubDb({ answers: [[SURVIVOR_LATEST_RE, bracketed(SURVIVOR_POS, LOSER_POS)]] });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    const entry = logService.createLogEntry.mock.calls[0][1];
    expect(entry.message).toContain('case_stage_log_reassert=row');
    expect(entry.message).toContain('case_stage_log_reassert_stage=retained');
    expect(entry.extra.merge.children).toEqual(plan.children);
  });

  test('LOSER ROWS OLDER: the survivor still leads — nothing written, plan says none', async () => {
    // Post-repoint the survivor's own row is still `latest` (same row id), so
    // there is nothing to re-assert and appending anyway would restart the
    // aged clock for no reason.
    const db = stubDb({ answers: [[SURVIVOR_LATEST_RE, bracketed(SURVIVOR_POS, SURVIVOR_POS)]] });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    expect(db.calls.some(c => /^INSERT INTO case_stage_log/i.test(c.sql))).toBe(false);
    expect(plan.children.case_stage_log_reassert).toBe('none');
    expect(plan.children).not.toHaveProperty('case_stage_log_reassert_stage');
    expect(plan.children).not.toHaveProperty('case_stage_log_position');
  });

  test('EQUAL entered_at, loser id higher: the id tiebreak still moves the position', async () => {
    // `ORDER BY entered_at DESC, id DESC` — an identical timestamp is decided
    // by the id, and the loser's row wins it. A decision that compared
    // timestamps would call this "unchanged" and leave the case demoted. This
    // is why the implementation compares ROW IDS.
    const tie = '2026-08-20 14:30:00';
    const db = stubDb({
      answers: [[SURVIVOR_LATEST_RE, bracketed(
        stageRow({ id: 10, entered_at_str: tie }),
        stageRow({ id: 44, template_id: 1, stage_id: 5, stage_key: 'consult_booked',
                   case_stage: 'Open', status_label: 'Consult Booked',
                   entered_at_str: tie }),
      )]],
    });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    const ins = oneCall(db, /^INSERT INTO case_stage_log/i);
    expect(ins.params[3]).toBe('retained');   // the survivor's stage, restored
    expect(ins.params[6]).toBe(tie);          // GREATEST(NOW(), tie) → NOW()
    expect(plan.children.case_stage_log_reassert).toBe('row');
  });

  test('SURVIVOR HAS NO HISTORY: no insert, and the residual is reported', async () => {
    // The loser's rows legitimately become the merged case's only position.
    // Nothing to restore — but that is an OUTCOME, not a no-op, and it has to
    // be visible in the note or it is indistinguishable from "nothing
    // happened".
    const db = stubDb({ answers: [[SURVIVOR_LATEST_RE, bracketed(null, LOSER_POS)]] });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    expect(db.calls.some(c => /^INSERT INTO case_stage_log/i.test(c.sql))).toBe(false);
    expect(plan.children.case_stage_log_reassert).toBe('warn');
    expect(plan.children.case_stage_log_position)
      .toBe('intake-history-now-leads; no survivor position to re-assert');
    expect(plan.children).not.toHaveProperty('case_stage_log_reassert_stage');

    const entry = logService.createLogEntry.mock.calls[0][1];
    expect(entry.message).toContain('case_stage_log_reassert=warn');
    expect(entry.message)
      .toContain('case_stage_log_position=intake-history-now-leads; no survivor position to re-assert');
  });

  test('LOSER HAS NO STAGE ROWS: two cheap reads and nothing else', async () => {
    // Indistinguishable from "loser rows older" at this seam, deliberately:
    // the decision is made on which ROW leads, not on whether the loser
    // brought any. What this pins is the COST — the bracket is exactly two
    // LIMIT-1 reads on the real path, it never runs the dry run's union query,
    // and it writes nothing when there is nothing to do.
    const db = stubDb({ answers: [[SURVIVOR_LATEST_RE, bracketed(SURVIVOR_POS, SURVIVOR_POS)]] });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    expect(db.calls.filter(c => SURVIVOR_LATEST_RE.test(c.sql))).toHaveLength(2);
    expect(db.calls.filter(c => SURVIVOR_LATEST_RE.test(c.sql)).map(c => c.params))
      .toEqual([[SURVIVOR], [SURVIVOR]]);
    expect(db.calls.some(c => MERGED_LATEST_RE.test(c.sql))).toBe(false);
    expect(db.calls.some(c => /^INSERT INTO case_stage_log/i.test(c.sql))).toBe(false);
    expect(plan.children.case_stage_log_reassert).toBe('none');
  });

  test('A DRY RUN previews the decision and writes nothing', async () => {
    // The preview simulates the post-repoint order with a union over both
    // case_ids — the repoint changes case_id and nothing else, so row ids (and
    // therefore the ordering) are identical to what the real merge produces.
    const db = stubDb({
      answers: [
        [SURVIVOR_LATEST_RE, [[SURVIVOR_POS]]],
        [MERGED_LATEST_RE,   [[LOSER_POS]]],
      ],
    });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER, { dryRun: true });

    expect(plan.children.case_stage_log_reassert).toBe('row');
    expect(plan.children.case_stage_log_reassert_stage).toBe('retained');

    const union = oneCall(db, MERGED_LATEST_RE);
    expect(union.params).toEqual([SURVIVOR, LOSER]);

    // The premise the sync bus stays silent on, restated for the new statement.
    expect(db.calls.some(c => /^INSERT/i.test(c.sql))).toBe(false);
    expect(db.seen.some(s => /^UPDATE/i.test(s))).toBe(false);
    expect(db.seen.some(s => /^DELETE/i.test(s))).toBe(false);
  });

  test('A DRY RUN reports the residual too, without writing', async () => {
    const db = stubDb({
      answers: [
        [SURVIVOR_LATEST_RE, [[]]],          // survivor has no history
        [MERGED_LATEST_RE,   [[LOSER_POS]]],
      ],
    });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER, { dryRun: true });

    expect(plan.children.case_stage_log_reassert).toBe('warn');
    expect(plan.children.case_stage_log_position)
      .toBe('intake-history-now-leads; no survivor position to re-assert');
    expect(db.calls.some(c => /^INSERT/i.test(c.sql))).toBe(false);
  });

  test('NEITHER CASE HAS HISTORY: the decision degrades to none', async () => {
    // The universal day-one state, and the one every pre-pipeline case is in.
    const db = stubDb({ answers: [[SURVIVOR_LATEST_RE, bracketed(null, null)]] });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);

    expect(db.calls.some(c => /^INSERT INTO case_stage_log/i.test(c.sql))).toBe(false);
    expect(plan.children.case_stage_log_reassert).toBe('none');
  });
});
