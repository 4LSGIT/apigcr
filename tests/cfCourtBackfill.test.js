// tests/cfCourtBackfill.test.js
//
// buildPlan is pure (scripts/cfCourtBackfill.js): evidence → writes under the
// agreement rule. The maps themselves are frozen literals asserted against the
// live registry at run time (assertRegistry), not here.

'use strict';

const { buildPlan, courtFromSender, courtFromSuffix, courtFromJudge } =
  require('../scripts/cfCourtBackfill');

const CASE = (over = {}) => ({
  case_id: 'C1', case_number: '26-40001', case_number_full: '26-40001-mar',
  case_type: 'Bankruptcy', case_judge: '', cf_court: null, ...over,
});

describe('evidence extractors', () => {
  test('sender: mapped subdomains hit, PACER and non-court mail do not', () => {
    expect(courtFromSender('efile_oxholm@mieb.uscourts.gov')).toBe('MIEB');
    expect(courtFromSender('x@miwb.uscourts.gov')).toBe('MIWB');
    expect(courtFromSender('CA06db_DO_NOT_REPLY@ca6.uscourts.gov')).toBe('USCOA');
    expect(courtFromSender('do_not_reply@psc.uscourts.gov')).toBe(null);
    expect(courtFromSender('someone@gmail.com')).toBe(null);
    expect(courtFromSender('')).toBe(null);
  });

  test('suffix: judge suffixes hit; junk and non-BK docket shapes do not', () => {
    expect(courtFromSuffix('26-42040-mar')).toBe('MIEB');
    expect(courtFromSuffix('25-00001-jtg')).toBe('MIWB');
    expect(courtFromSuffix('26-43652-abc')).toBe(null);     // junk suffix
    expect(courtFromSuffix('1:24-cv-00546 (JLR)')).toBe(null); // SDNY shape
    expect(courtFromSuffix('26-42040')).toBe(null);
    expect(courtFromSuffix(null)).toBe(null);
  });

  test('judge: surname match, any spelling of the rest; unknown judges do not', () => {
    expect(courtFromJudge('Mark A. Randon')).toBe('MIEB');
    expect(courtFromJudge('Lisa Gretchko')).toBe('MIEB');
    expect(courtFromJudge('John T. Gregg')).toBe('MIWB');
    expect(courtFromJudge('Jennifer L. Rochon')).toBe(null);
    expect(courtFromJudge('')).toBe(null);
  });
});

describe('buildPlan — the agreement rule', () => {
  test('agreeing email + suffix + judge evidence writes one court', () => {
    const plan = buildPlan({
      cases: [CASE({ case_judge: 'Thomas J. Tucker', case_number_full: '26-40001-tjt' })],
      senders: [{ case_id: 'C1', from_email: 'ecf@mieb.uscourts.gov', n: 9 }],
    });
    expect(plan.writes).toEqual([{ case_id: 'C1', to: 'MIEB',
      evidence: ['email:MIEB', 'suffix:MIEB', 'judge:MIEB'] }]);
    expect(plan.conflicts).toEqual([]);
  });

  test('two MIEB judges on one case still agree — the rule compares courts', () => {
    const plan = buildPlan({
      cases: [CASE({ case_judge: 'Maria L. Oxholm', case_number_full: '26-40001-prh' })],
      senders: [],
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].to).toBe('MIEB');
  });

  test('disagreeing evidence is a conflict: reported, never written', () => {
    const plan = buildPlan({
      cases: [CASE({ case_number_full: '26-40001-jtg' })], // suffix says MIWB
      senders: [{ case_id: 'C1', from_email: 'ecf@mieb.uscourts.gov', n: 2 }],
    });
    expect(plan.writes).toEqual([]);
    expect(plan.conflicts).toEqual([{ case_id: 'C1',
      evidence: ['email:MIEB', 'suffix:MIWB'] }]);
  });

  test('suffix and judge count only on bankruptcy cases; email counts on any', () => {
    const civil = buildPlan({
      cases: [CASE({ case_type: 'Civil Litigation', case_number_full: '26-40001-mar',
                     case_judge: 'Mark A. Randon' })],
      senders: [{ case_id: 'C1', from_email: 'clerk@mied.uscourts.gov', n: 1 }],
    });
    // were suffix/judge counted, MIEB would conflict with the email's MIED
    expect(civil.conflicts).toEqual([]);
    expect(civil.writes).toEqual([{ case_id: 'C1', to: 'MIED', evidence: ['email:MIED'] }]);
  });

  test('already-set, undocketed, and no-evidence cases are left alone', () => {
    const plan = buildPlan({
      cases: [
        CASE({ case_id: 'SET', cf_court: 'MIEB' }),
        CASE({ case_id: 'NODOCKET', case_number: '', case_number_full: '' }),
        CASE({ case_id: 'NOEV', case_number_full: '26-40002' }),
        CASE({ case_id: 'NOEV_CIVIL', case_type: 'Other', case_number_full: 'X-1' }),
      ],
      senders: [{ case_id: 'SET', from_email: 'ecf@mieb.uscourts.gov', n: 1 }],
    });
    expect(plan.writes).toEqual([]);
    // only the docketed BANKRUPTCY case is surfaced as needing a human
    expect(plan.noEvidence).toEqual(['NOEV']);
  });
});
