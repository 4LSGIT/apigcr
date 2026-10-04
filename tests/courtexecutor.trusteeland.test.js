/**
 * tests/courtexecutor.trusteeland.test.js
 *
 * create_appointment → cases.case_trustee landing (the India Gragg gap,
 * 26-31193, 2026-10-02): a 341 delivered inside a hearing_adjourned email
 * emits only create_appointment, so the extracted trustee used to die in the
 * appt note — cases.case_trustee / case_341_link stayed empty and the 48h
 * seq-19 guard was the first thing to notice.
 *
 *   npx jest tests/courtexecutor.trusteeland.test.js
 *
 * Contract under test (courtExecutor landTrusteeColumn):
 *   LAND          — create_appointment with `trustee` + empty case_trustee →
 *                   UPDATE cases.case_trustee, slice-6 twin re-resolve,
 *                   change row + applied entry (field case_trustee).
 *   NO CHURN      — current value CONTAINS the extracted string (continuance
 *                   citing 'Caouette' against 'Melissa A. Caouette') → no
 *                   write, no change row. The validator would only
 *                   canonicalize it straight back.
 *   SUBSTITUTION  — a different trustee name overwrites (the 26-48181
 *                   stale-link class: validation must see the NEW name, not
 *                   confidently re-bless the old one).
 *   REPLAY        — appt_exists dedup-skip still converges the column (the
 *                   writeShowCauseColumn precedent).
 *   CONVERGED     — equal value → quiet noop (no write, no change row).
 *   DRY RUN       — no UPDATEs; applied still shows the intended write so
 *                   preview plans are honest.
 *   NO TRUSTEE    — absent field → untouched.
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const CASE_ROW = {
  found: true,
  case_id: 'YSHZLitl',
  case_number: '26-31193',
  case_number_full: '26-31193-jda',
  case_caption: null,
  primary_contact_id: 1983,
  primary_contact_name: 'India Gragg',
};
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...CASE_ROW });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const apptService = require('../services/apptService');
const roleResolver = require('../lib/caseRoleResolver');

const { executeCourtActions } = require('../services/courtExecutor');

// ─────────────────────────────────────────────────────────────
// db stub. The dupe guard SELECT is recognized by `SELECT appt_id FROM appts`;
// the curCaseRow loader by `FROM cases WHERE case_id=? LIMIT 1`.
// ─────────────────────────────────────────────────────────────
function makeDb({ caseTrustee = '', existingAppt = null } = {}) {
  const updates = [];
  const query = jest.fn(async (sql, params = []) => {
    if (/SELECT appt_id FROM appts/i.test(sql)) {
      return [existingAppt ? [{ appt_id: existingAppt }] : []];
    }
    if (/FROM cases WHERE case_id=\? LIMIT 1/i.test(sql)) {
      return [[{
        case_file_date: null, case_judge: '', case_close_date: null,
        case_discharge_date: null, case_chapter: '13',
        case_trustee: caseTrustee, case_objection: null, show_cause: null,
      }]];
    }
    if (/SELECT `value` FROM app_settings/i.test(sql)) return [[]];
    if (/^\s*UPDATE\b/i.test(sql)) { updates.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return [{ affectedRows: 1 }]; }
    if (/^\s*INSERT\b/i.test(sql)) return [{ insertId: 77, affectedRows: 1 }];
    return [[]];
  });
  return { query, updates };
}

function apptPayload(fields, { messageId = 'court-trustee-land' } = {}) {
  return {
    payload: {
      message_id: messageId,
      case_number: '26-31193-jda',
      case_name: 'India Gragg',
      classification: 'hearing_adjourned', // the India shape: NOT meeting_*
      needs_review: false,
      actions: [{ type: 'create_appointment', fields }],
    },
    subject: 'irrelevant (citations stubbed)',
    body: 'irrelevant (citations stubbed)',
  };
}

const APPT_FIELDS = {
  date: '2126-10-06', time: '13:00', platform: 'Zoom',
  appt_type: '341 Meeting', trustee: 'Melissa A. Caouette',
  connection_info: 'Meeting ID 741 812 1144, Passcode 8079024454',
};

const trusteeUpdates = (db) =>
  db.updates.filter(u => /SET case_trustee=\?/i.test(u.sql));
const twinUpdates = (db) =>
  db.updates.filter(u => /SET case_trustee_contact_id=\?/i.test(u.sql));

const realCreateAppt = apptService.createAppt;
const realResolveTrustee = roleResolver.resolveTrustee;
beforeEach(() => {
  apptService.createAppt = jest.fn(async () => ({ appt_id: 3960 }));
  roleResolver.resolveTrustee = jest.fn(async () => 2083);
});
afterAll(() => {
  apptService.createAppt = realCreateAppt;
  roleResolver.resolveTrustee = realResolveTrustee;
});

describe('create_appointment → case_trustee landing', () => {
  test('LAND: empty case_trustee + trustee field → column write, twin re-resolve, applied entry', async () => {
    const db = makeDb({ caseTrustee: '' });
    const res = await executeCourtActions(db, { ...apptPayload(APPT_FIELDS), dryRun: false });

    expect(res.outcome).toBe('executed');
    expect(apptService.createAppt).toHaveBeenCalledTimes(1);

    const tu = trusteeUpdates(db);
    expect(tu).toHaveLength(1);
    expect(tu[0].params).toEqual(['Melissa A. Caouette', 'YSHZLitl']);

    // Slice-6 twin contract rides every case_trustee write.
    expect(roleResolver.resolveTrustee).toHaveBeenCalledWith(db, {
      case_trustee: 'Melissa A. Caouette', case_chapter: '13',
    });
    expect(twinUpdates(db)).toHaveLength(1);
    expect(twinUpdates(db)[0].params).toEqual([2083, 'YSHZLitl']);

    const a = res.applied.find(x => x.field === 'case_trustee');
    expect(a).toBeTruthy();
    expect(a.old_value).toBe('');
    expect(a.new_value).toBe('Melissa A. Caouette');
  });

  test('NO CHURN: current contains the extracted partial → untouched', async () => {
    const db = makeDb({ caseTrustee: 'Melissa A. Caouette' });
    const res = await executeCourtActions(db,
      { ...apptPayload({ ...APPT_FIELDS, trustee: 'Caouette' }), dryRun: false });

    expect(trusteeUpdates(db)).toHaveLength(0);
    expect(twinUpdates(db)).toHaveLength(0);
    expect(res.applied.find(x => x.field === 'case_trustee')).toBeUndefined();
    // The appt itself still lands.
    expect(apptService.createAppt).toHaveBeenCalledTimes(1);
  });

  test('SUBSTITUTION: different trustee overwrites and re-resolves the twin', async () => {
    const db = makeDb({ caseTrustee: 'Melissa A. Caouette' });
    const res = await executeCourtActions(db,
      { ...apptPayload({ ...APPT_FIELDS, trustee: 'Tammy L. Terry' }), dryRun: false });

    const tu = trusteeUpdates(db);
    expect(tu).toHaveLength(1);
    expect(tu[0].params).toEqual(['Tammy L. Terry', 'YSHZLitl']);
    expect(roleResolver.resolveTrustee).toHaveBeenCalledWith(db, {
      case_trustee: 'Tammy L. Terry', case_chapter: '13',
    });
    const a = res.applied.find(x => x.field === 'case_trustee');
    expect(a.old_value).toBe('Melissa A. Caouette');
    expect(a.new_value).toBe('Tammy L. Terry');
  });

  test('REPLAY: appt_exists dedup-skip still converges the column', async () => {
    const db = makeDb({ caseTrustee: '', existingAppt: 3960 });
    const res = await executeCourtActions(db, { ...apptPayload(APPT_FIELDS), dryRun: false });

    expect(apptService.createAppt).not.toHaveBeenCalled();
    expect(res.skipped.find(s => s.reason === 'appt_exists')).toBeTruthy();
    expect(trusteeUpdates(db)).toHaveLength(1);
    expect(trusteeUpdates(db)[0].params).toEqual(['Melissa A. Caouette', 'YSHZLitl']);
  });

  test('CONVERGED: equal value → quiet noop, no change row', async () => {
    const db = makeDb({ caseTrustee: 'Melissa A. Caouette', existingAppt: 3960 });
    const res = await executeCourtActions(db, { ...apptPayload(APPT_FIELDS), dryRun: false });

    expect(trusteeUpdates(db)).toHaveLength(0);
    expect(twinUpdates(db)).toHaveLength(0);
    expect(res.applied.find(x => x.field === 'case_trustee')).toBeUndefined();
    // Pure replay: nothing applied at all → outcome 'none'.
    expect(res.outcome).toBe('none');
  });

  test('DRY RUN: no UPDATEs, applied still shows the intended write', async () => {
    const db = makeDb({ caseTrustee: '' });
    const res = await executeCourtActions(db, { ...apptPayload(APPT_FIELDS), dryRun: true });

    expect(db.updates).toHaveLength(0);
    expect(apptService.createAppt).not.toHaveBeenCalled();
    expect(roleResolver.resolveTrustee).not.toHaveBeenCalled();
    const a = res.applied.find(x => x.field === 'case_trustee');
    expect(a).toBeTruthy();
    expect(a.new_value).toBe('Melissa A. Caouette');
  });

  test('NO TRUSTEE: absent field → cases untouched', async () => {
    const db = makeDb({ caseTrustee: '' });
    const { trustee, ...rest } = APPT_FIELDS;
    await executeCourtActions(db, { ...apptPayload(rest), dryRun: false });

    expect(trusteeUpdates(db)).toHaveLength(0);
    expect(twinUpdates(db)).toHaveLength(0);
    expect(apptService.createAppt).toHaveBeenCalledTimes(1);
  });
});
