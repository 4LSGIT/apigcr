// tests/pipelineBoard.test.js
//
// Slice C3 assertions for pipelineAdminService.getBoard, exercised against
// STUB mysql2 pools that record every (sql, params) call and return scripted
// rows — no database (stub pattern from tests/pipelineService.test.js,
// jest-hosted).
//
// Covers:
//   - Membership mirrors resolveTemplate branch order:
//       intake board  = branch 1 (blank subtype) ∪ branch 4 (subtyped, no
//                       exact template, no type default) — NOT-IN params
//                       carry the exact pairs and default types.
//       exact board   = branch 2 (type+subtype params, non-blank guard).
//       default board = branch 2 for its own pair ∪ branch 3 (type param,
//                       sibling exact subtypes excluded).
//       shadowed / inactive template → structurally empty (no cases scan).
//   - Placement: latest log key in template → its column; key NOT in
//     template (branched-from-intake) → unstaged with case_status kept;
//     no log rows → unstaged.
//   - Closed filter: default WHERE carries case_stage <> 'Closed';
//     includeClosed:true drops it.
//   - Groupwise-max tie-break query shape (entered_at DESC, id DESC).
//
// Run:
//   npx jest tests/pipelineBoard.test.js

'use strict';

const svc = require('../services/pipelineAdminService');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs (same shape as tests/pipelineService.test.js)
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
      return [script.shift()];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — mirror the live Slice A seed (+ a default template for branch 3)
// ─────────────────────────────────────────────────────────────────────────────

const TPL_INTAKE = { id: 1, name: 'Intake', case_type: '', case_subtype: '', role: 'intake', is_default: 0, active: 1 };
const TPL_CH7    = { id: 2, name: 'Bankruptcy — Chapter 7',  case_type: 'Bankruptcy', case_subtype: 'Chapter 7',  role: 'case', is_default: 0, active: 1 };
const TPL_CH13   = { id: 3, name: 'Bankruptcy — Chapter 13', case_type: 'Bankruptcy', case_subtype: 'Chapter 13', role: 'case', is_default: 0, active: 1 };
const TPL_BK_DEF = { id: 4, name: 'Bankruptcy — Default',    case_type: 'Bankruptcy', case_subtype: '',           role: 'case', is_default: 1, active: 1 };

const CH7_STAGES = [
  { stage_id: 5, stage_key: 'docs',  stage_number: 1, internal_label: 'Documents & Prep', client_label: 'Preparing your case', client_visible: 1, case_stage: 'Pending', is_terminal: 0, default_rec: '' },
  { stage_id: 6, stage_key: 'filed', stage_number: 2, internal_label: 'Filed',            client_label: 'Your case is filed',  client_visible: 1, case_stage: 'Filed',   is_terminal: 0, default_rec: '' },
];
const INTAKE_STAGES = [
  { stage_id: 1, stage_key: 'lead',     stage_number: 1, internal_label: 'Lead',     client_label: 'Inquiry received',  client_visible: 1, case_stage: 'Open',    is_terminal: 0, default_rec: '' },
  { stage_id: 4, stage_key: 'retained', stage_number: 4, internal_label: 'Retained', client_label: "You've retained us", client_visible: 1, case_stage: 'Pending', is_terminal: 0, default_rec: '' },
];

const CARD = (case_id, extra = {}) => ({
  case_id,
  case_display: case_id,
  case_stage: 'Open',
  case_status: 'Lead',
  primary_contact_name: 'Test Person',
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
// Membership branch mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('getBoard membership mirrors resolveTemplate', () => {
  test('exact (type, subtype) template board — branch 2 clause + params, closed filter default', async () => {
    const db = stubDb([
      [TPL_CH7],                 // template by id
      CH7_STAGES.slice(),        // active stages
      [TPL_INTAKE, TPL_CH7, TPL_CH13],  // active templates (resolveTemplate load)
      [],                        // cards
      [],                        // latest-log
    ]);
    const out = await svc.getBoard(db, 2);
    const cards = db.calls[3];
    expect(cards.sql).toContain(`TRIM(c.case_subtype) <> ''`);
    expect(cards.sql).toContain(`TRIM(c.case_type) = ?`);
    expect(cards.sql).toContain(`TRIM(c.case_subtype) = ?`);
    expect(cards.params).toEqual(['Bankruptcy', 'Chapter 7']);
    expect(cards.sql).toContain(`case_stage <> 'Closed'`);
    // no intake / default clauses leaked in
    expect(cards.sql).not.toContain(`TRIM(c.case_subtype) = ''`);
    expect(out.columns).toHaveProperty('unstaged');
    expect(out.columns).toHaveProperty('docs');
    expect(out.columns).toHaveProperty('filed');
  });

  test('includeClosed drops the Closed filter', async () => {
    const db = stubDb([
      [TPL_CH7], CH7_STAGES.slice(), [TPL_INTAKE, TPL_CH7, TPL_CH13], [], [],
    ]);
    await svc.getBoard(db, 2, { includeClosed: true });
    expect(db.calls[3].sql).not.toContain(`Closed`);
  });

  test('intake board = branch 1 ∪ branch 4 (exact pairs + default types excluded)', async () => {
    const db = stubDb([
      [TPL_INTAKE], INTAKE_STAGES.slice(),
      [TPL_INTAKE, TPL_CH7, TPL_CH13, TPL_BK_DEF],
      [], [],
    ]);
    await svc.getBoard(db, 1);
    const cards = db.calls[3];
    expect(cards.sql).toContain(`TRIM(c.case_subtype) = ''`);                          // branch 1
    expect(cards.sql).toContain(`(TRIM(c.case_type), TRIM(c.case_subtype)) NOT IN`);   // branch 4 pairs
    expect(cards.sql).toContain(`TRIM(c.case_type) NOT IN`);                           // branch 4 defaults
    expect(cards.params).toEqual([
      'Bankruptcy', 'Chapter 7',      // exact pair 1
      'Bankruptcy', 'Chapter 13',     // exact pair 2
      'Bankruptcy',                   // default type
    ]);
  });

  test('intake board without any default templates omits the type NOT IN', async () => {
    const db = stubDb([
      [TPL_INTAKE], INTAKE_STAGES.slice(),
      [TPL_INTAKE, TPL_CH7, TPL_CH13],    // live shape: no is_default anywhere
      [], [],
    ]);
    await svc.getBoard(db, 1);
    const cards = db.calls[3];
    expect(cards.sql).toContain(`NOT IN`);                        // pairs still excluded
    expect(cards.sql).not.toContain(`TRIM(c.case_type) NOT IN`);  // no default clause
    expect(cards.params).toEqual(['Bankruptcy', 'Chapter 7', 'Bankruptcy', 'Chapter 13']);
  });

  test('is_default board = own exact pair ∪ branch 3 minus sibling exact subtypes', async () => {
    const db = stubDb([
      [TPL_BK_DEF], [],   // (stages content irrelevant here)
      [TPL_INTAKE, TPL_CH7, TPL_CH13, TPL_BK_DEF],
      [], [],
    ]);
    await svc.getBoard(db, 4);
    const cards = db.calls[3];
    // TPL_BK_DEF has a BLANK subtype → no branch-2 clause of its own
    // (a blank-subtype template can never win branch 2), only branch 3.
    expect(cards.sql).toContain(`TRIM(c.case_type) = ?`);
    expect(cards.sql).toContain(`TRIM(c.case_subtype) NOT IN (?, ?)`);
    expect(cards.params).toEqual(['Bankruptcy', 'Chapter 7', 'Chapter 13']);
  });

  test('is_default board WITH its own subtype gets branch 2 AND branch 3', async () => {
    const TPL_DEF_SUB = { id: 4, name: 'BK Default Ch11', case_type: 'Bankruptcy', case_subtype: 'Chapter 11', role: 'case', is_default: 1, active: 1 };
    const db = stubDb([
      [TPL_DEF_SUB], [],
      [TPL_INTAKE, TPL_CH7, TPL_CH13, TPL_DEF_SUB],
      [], [],
    ]);
    await svc.getBoard(db, 4);
    const cards = db.calls[3];
    // branch 2 (own pair) then branch 3 (type minus ALL exact subtypes incl. its own)
    expect(cards.params).toEqual([
      'Bankruptcy', 'Chapter 11',                            // branch 2
      'Bankruptcy', 'Chapter 7', 'Chapter 13', 'Chapter 11', // branch 3 + NOT IN
    ]);
  });

  test('shadowed duplicate template → empty board, no cases scan', async () => {
    // Two active exact CH7 templates; id 2 wins .find — id 9 resolves for no case.
    const TPL_CH7_DUPE = { ...TPL_CH7, id: 9, name: 'CH7 dupe' };
    const db = stubDb([
      [TPL_CH7_DUPE], CH7_STAGES.slice(),
      [TPL_INTAKE, TPL_CH7, TPL_CH7_DUPE],
      // NO cards / latest-log entries scripted — must not be queried
    ]);
    const out = await svc.getBoard(db, 9);
    expect(db.calls.length).toBe(3);
    expect(out.columns.unstaged).toEqual([]);
    expect(out.columns.docs).toEqual([]);
  });

  test('inactive template → empty board, no cases scan', async () => {
    const TPL_OFF = { ...TPL_CH7, active: 0 };
    const db = stubDb([
      [TPL_OFF], CH7_STAGES.slice(),
      [TPL_INTAKE, TPL_CH13],   // active load doesn't include it
    ]);
    const out = await svc.getBoard(db, 2);
    expect(db.calls.length).toBe(3);
    expect(out.columns.unstaged).toEqual([]);
  });

  test('bad template_id → 400; unknown → 404', async () => {
    await expect(svc.getBoard(stubDb([]), 'abc')).rejects.toMatchObject({ status: 400 });
    await expect(svc.getBoard(stubDb([[]]), 999)).rejects.toMatchObject({ status: 404 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Placement
// ─────────────────────────────────────────────────────────────────────────────

describe('getBoard placement', () => {
  const boot = (cards, latest) => stubDb([
    [TPL_CH7], CH7_STAGES.slice(), [TPL_INTAKE, TPL_CH7, TPL_CH13], cards, latest,
  ]);

  test('latest key in template → its column; no log → unstaged; foreign key → unstaged keeping case_status', async () => {
    const out = await svc.getBoard(boot(
      [
        CARD('AAAA0001'),                                    // no log → unstaged
        CARD('BBBB0002', { case_status: 'Filed' }),          // latest 'filed' → filed col
        CARD('CCCC0003', { case_status: 'Retained' }),       // latest 'retained' (intake key) → unstaged
      ],
      [
        { case_id: 'BBBB0002', stage_key: 'filed',    entered_at: '2026-08-01 10:00:00', days_in_stage: 4 },
        { case_id: 'CCCC0003', stage_key: 'retained', entered_at: '2026-07-01 10:00:00', days_in_stage: 35 },
      ]
    ), 2);

    expect(out.columns.filed.map(c => c.case_id)).toEqual(['BBBB0002']);
    expect(out.columns.docs).toEqual([]);
    const un = out.columns.unstaged;
    expect(un.map(c => c.case_id).sort()).toEqual(['AAAA0001', 'CCCC0003']);

    const noLog = un.find(c => c.case_id === 'AAAA0001');
    expect(noLog.current_stage_key).toBeNull();
    expect(noLog.days_in_stage).toBeNull();

    const branched = un.find(c => c.case_id === 'CCCC0003');
    expect(branched.current_stage_key).toBe('retained');  // visible, just not a column
    expect(branched.case_status).toBe('Retained');        // live status kept on the card
    expect(branched.days_in_stage).toBe(35);
  });

  test('staged column sorted longest-in-stage first', async () => {
    const out = await svc.getBoard(boot(
      [CARD('AAAA0001'), CARD('BBBB0002')],
      [
        { case_id: 'AAAA0001', stage_key: 'docs', entered_at: '2026-08-03 10:00:00', days_in_stage: 2 },
        { case_id: 'BBBB0002', stage_key: 'docs', entered_at: '2026-07-01 10:00:00', days_in_stage: 35 },
      ]
    ), 2);
    expect(out.columns.docs.map(c => c.case_id)).toEqual(['BBBB0002', 'AAAA0001']);
  });

  test('groupwise-max query carries the (entered_at, id) tie-break', async () => {
    const db = boot([], []);
    await svc.getBoard(db, 2);
    const gm = db.calls[4].sql;
    expect(gm).toContain('l2.entered_at > l.entered_at');
    expect(gm).toContain('l2.entered_at = l.entered_at AND l2.id > l.id');
    expect(gm).toContain('l2.id IS NULL');
  });
});