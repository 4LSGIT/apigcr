/**
 * tests/caseJudgeFill.test.js
 *
 * The judge NAME fill on the non-court docket writers (2026-11-16).
 *
 *   npx jest tests/caseJudgeFill.test.js
 *
 * courtExecutor fills a blank case_judge from the docket suffix on the court
 * path (tests/courtexecutor.judgefill.test.js). The same rule now runs on:
 *   - caseService.updateCase — every write carrying case_number_full (the
 *     case page, PATCH /api/cases/:id/docket, form submits, the automation
 *     update_case function), through caseService.judgeFillFromDocket;
 *   - intakeService.intakeCase — a case created with a full docket gets the
 *     judge name beside its twin.
 * The Ask Casey cards that predict updateCase call judgeFillFromDocket itself
 * (pinned in caseyDocket / caseyCaseFields / caseyFormSubmit).
 *
 * Contract:
 *   RULE      — fills only when the write carries case_number_full, the judge
 *               is blank before, and the write leaves it blank (absent, or
 *               blank over blank). A set judge is never changed; a hand clear
 *               of a set judge is respected.
 *   UPDATE    — the fill joins the ONE UPDATE: case_judge after the caller's
 *               columns, then the twin resolved from the filled post-state;
 *               updated_fields / changes carry it; an explicit twin is still
 *               respected.
 *   INTAKE    — createCase receives case_judge + case_judge_contact_id from
 *               one suffix lookup; a miss passes neither.
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

jest.mock('../lib/domainEvents', () => ({
  ...jest.requireActual('../lib/domainEvents'),
  emit: jest.fn(() => Promise.resolve()),
}));

const caseService = require('../services/caseService');
const roleResolver = require('../lib/caseRoleResolver');

const ROSTER = {
  lsg: { contact_id: 2059, contact_name: 'Lisa S. Gretchko' },
  mar: { contact_id: 2061, contact_name: 'Mark A. Randon' },
};

// ─────────────────────────────────────────────────────────────
// caseService.judgeFillFromDocket — the rule
// ─────────────────────────────────────────────────────────────

describe('caseService.judgeFillFromDocket — when the fill fires', () => {
  let spy; let seen;
  beforeEach(() => {
    seen = [];
    spy = jest.spyOn(roleResolver, 'judgeFromDocket').mockImplementation(async (_db, full) => {
      seen.push(full); return { contact_id: 2059, name: 'Lisa S. Gretchko' };
    });
  });
  afterEach(() => spy.mockRestore());
  const fill = (prior, fields) => caseService.judgeFillFromDocket({}, prior, fields);

  test('docket written, judge blank before and untouched → the suffix lookup runs on the NEW docket', async () => {
    expect(await fill({ case_judge: '' }, { case_number_full: '26-52466-lsg' }))
      .toEqual({ contact_id: 2059, name: 'Lisa S. Gretchko' });
    expect(seen).toEqual(['26-52466-lsg']);
  });

  test.each([
    ['NULL judge before', { case_judge: null }, { case_number_full: '26-1-lsg' }],
    ['whitespace judge before', { case_judge: '   ' }, { case_number_full: '26-1-lsg' }],
    ['blank sent over blank', { case_judge: '' }, { case_number_full: '26-1-lsg', case_judge: '' }],
    ['null sent over blank', { case_judge: '' }, { case_number_full: '26-1-lsg', case_judge: null }],
  ])('%s → fills', async (_l, prior, fields) => {
    expect(await fill(prior, fields)).not.toBeNull();
  });

  test.each([
    ['no docket in the write', { case_judge: '' }, { case_caption: 'In re X' }],
    ['a set judge (suffix change)', { case_judge: 'Mark A. Randon' }, { case_number_full: '26-1-lsg' }],
    ['a hand clear of a set judge', { case_judge: 'Mark A. Randon' }, { case_number_full: '26-1-lsg', case_judge: '' }],
    ['a judge typed in the same write', { case_judge: '' }, { case_number_full: '26-1-lsg', case_judge: 'Someone' }],
  ])('%s → no lookup, no fill', async (_l, prior, fields) => {
    expect(await fill(prior, fields)).toBeNull();
    expect(seen).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// caseService.updateCase — wiring
// ─────────────────────────────────────────────────────────────

describe('caseService.updateCase — the fill joins the write', () => {
  const PRIOR = {
    case_id: 'C1', case_number: '26-52466', case_number_full: '', case_judge: '',
    case_trustee: '', case_chapter: '7', case_caption: '',
    case_judge_contact_id: null, case_trustee_contact_id: null,
  };
  function caseDb(priorRow) {
    const updates = [];
    return {
      updates,
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^SELECT \* FROM cases WHERE case_id/.test(s)) return [[{ ...priorRow }]];
        if (/FROM information_schema\.COLUMNS/.test(s)) return [Object.keys(PRIOR).map(c => ({ COLUMN_NAME: c }))];
        if (/^UPDATE cases SET/.test(s)) { updates.push({ s, params }); return [{ affectedRows: 1 }]; }
        // the suffix passes: judgeFromDocket (JOIN contacts) and resolveJudge (contact_id only)
        if (/JSON_EXTRACT\(cr\.attrs, '\$\.judge_3'\)/.test(s)) {
          const hit = ROSTER[params[0]];
          if (!hit) return [[]];
          return [/JOIN contacts/.test(s) ? [{ ...hit }] : [{ contact_id: hit.contact_id }]];
        }
        return [[]];
      },
    };
  }
  const param = (db, r, field) => db.updates[0].params[r.updated_fields.indexOf(field)];

  test('docket adopt onto a case with no judge: name + twin in the one UPDATE, in order, in changes', async () => {
    const db = caseDb(PRIOR);
    const r = await caseService.updateCase(db, 'C1', { case_number_full: '26-52466-lsg' }, { source: 'docket_adopt' });
    expect(r.updated_fields).toEqual(['case_number_full', 'case_judge', 'case_judge_contact_id']);
    expect(db.updates).toHaveLength(1);
    expect(param(db, r, 'case_judge')).toBe('Lisa S. Gretchko');
    expect(param(db, r, 'case_judge_contact_id')).toBe(2059);
    expect(r.changes.case_judge).toEqual({ from: '', to: 'Lisa S. Gretchko' });
  });

  test('the case form sending a blank judge beside the docket still fills, at the caller\'s position', async () => {
    const db = caseDb(PRIOR);
    const r = await caseService.updateCase(db, 'C1', { case_judge: '', case_number_full: '26-52466-mar' });
    expect(r.updated_fields).toEqual(['case_judge', 'case_number_full', 'case_judge_contact_id']);
    expect(param(db, r, 'case_judge')).toBe('Mark A. Randon');
    expect(param(db, r, 'case_judge_contact_id')).toBe(2061);
  });

  test('a set judge stays; the twin still re-resolves from the suffix', async () => {
    const db = caseDb({ ...PRIOR, case_judge: 'Lisa Gretchko' });
    const r = await caseService.updateCase(db, 'C1', { case_number_full: '26-52466-lsg' });
    expect(r.updated_fields).toEqual(['case_number_full', 'case_judge_contact_id']);
    expect(param(db, r, 'case_judge_contact_id')).toBe(2059);
  });

  test('a hand clear of a set judge beside a docket write is respected', async () => {
    const db = caseDb({ ...PRIOR, case_judge: 'Lisa S. Gretchko' });
    const r = await caseService.updateCase(db, 'C1', { case_judge: '', case_number_full: '26-52466-lsg' });
    expect(param(db, r, 'case_judge')).toBe('');
  });

  test('a suffix on no judge role fills nothing', async () => {
    const db = caseDb(PRIOR);
    const r = await caseService.updateCase(db, 'C1', { case_number_full: '26-52466-pjs' });
    expect(r.updated_fields).toEqual(['case_number_full', 'case_judge_contact_id']);
    expect(param(db, r, 'case_judge_contact_id')).toBeNull();
  });

  test('an explicit twin is respected while the name fills', async () => {
    const db = caseDb(PRIOR);
    const r = await caseService.updateCase(db, 'C1', { case_number_full: '26-52466-lsg', case_judge_contact_id: 777 });
    expect(param(db, r, 'case_judge')).toBe('Lisa S. Gretchko');
    expect(param(db, r, 'case_judge_contact_id')).toBe(777);
    expect(r.updated_fields.filter(f => f === 'case_judge_contact_id')).toHaveLength(1);
  });

  test('a write without the docket never looks the judge up', async () => {
    const spy = jest.spyOn(roleResolver, 'judgeFromDocket');
    try {
      const db = caseDb(PRIOR);
      const r = await caseService.updateCase(db, 'C1', { case_caption: 'In re X' });
      expect(r.updated_fields).toEqual(['case_caption']);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

// ─────────────────────────────────────────────────────────────
// intakeService.intakeCase
// ─────────────────────────────────────────────────────────────

describe('intakeService.intakeCase — judge name + twin on create', () => {
  const intakeService = require('../services/intakeService');
  let spies; let created; let looked;
  function intakeDb() {
    return {
      query: async (sql) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^INSERT INTO case_relate/.test(s)) return [{ insertId: 9001, affectedRows: 1 }];
        if (/^INSERT INTO log/.test(s)) return [{ insertId: 1, affectedRows: 1 }];
        return [[]]; // docket clash check: none
      },
    };
  }
  beforeEach(() => {
    created = []; looked = [];
    spies = [
      jest.spyOn(caseService, 'createCase').mockImplementation(async (_db, cols) => { created.push(cols); return { case_id: 'NEW00001', custom_fields: {} }; }),
      jest.spyOn(caseService, 'ensureCaseDropboxFolder').mockImplementation(() => Promise.resolve()),
      jest.spyOn(roleResolver, 'judgeFromDocket').mockImplementation(async (_db, full) => {
        looked.push(full);
        const hit = ROSTER[String(full).split('-').pop()];
        return hit ? { contact_id: hit.contact_id, name: hit.contact_name } : null;
      }),
    ];
  });
  afterEach(() => spies.forEach(s => s.mockRestore()));

  test('a full docket on a roster suffix → case_judge + case_judge_contact_id from one lookup', async () => {
    const r = await intakeService.intakeCase(intakeDb(), { contact_id: 2367, case_type: 'Bankruptcy', case_number_full: '26-52466-lsg' });
    expect(r.case_id || r.outcome).toBeTruthy();
    expect(looked).toEqual(['26-52466-lsg']);
    expect(created[0]).toMatchObject({ case_number_full: '26-52466-lsg', case_judge: 'Lisa S. Gretchko', case_judge_contact_id: 2059 });
  });

  test('a suffix on no judge role → neither column is passed', async () => {
    await intakeService.intakeCase(intakeDb(), { contact_id: 2367, case_type: 'Bankruptcy', case_number_full: '26-52466-pjs' });
    expect('case_judge' in created[0]).toBe(false);
    expect('case_judge_contact_id' in created[0]).toBe(false);
  });

  test('no full docket → no lookup', async () => {
    await intakeService.intakeCase(intakeDb(), { contact_id: 2367, case_type: 'Bankruptcy', case_number: '26-52466' });
    expect(looked).toEqual([]);
    expect('case_judge' in created[0]).toBe(false);
  });
});
