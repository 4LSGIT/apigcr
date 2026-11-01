/**
 * tests/caseCaptionBackfill.test.js — scripts/caseCaptionBackfill.js, the plan
 * and the body parse. The writes on a real engine: the twin below it in
 * tests/caseCaption.mysql.test.js.
 *
 *   npx jest tests/caseCaptionBackfill.test.js
 */

'use strict';

const { buildPlan, courtNameFromBody, docketFromBody } = require('../scripts/caseCaptionBackfill');

const bk = (id, over = {}) => ({ case_id: id, case_number: id, case_number_full: `${id}-mar`,
  case_type: 'Bankruptcy', case_subtype: 'Chapter 7', case_caption: null, ...over });
const primary = (id, name) => ({ case_id: id, relate_type: 'Primary', contact_name: name });
const secondary = (id, name) => ({ case_id: id, relate_type: 'Secondary', contact_name: name });
const plan = (input) => buildPlan({ cases: [], relates: [], emails: [], aiNames: [], ...input });

describe('the ECF body parse', () => {
  test('the shapes email_log holds', () => {
    const bold = '*Case Name:* Yolanda C. Turner \n*Case Number:* 25-43233-mar \n<https://ecf>';
    expect(courtNameFromBody(bold)).toBe('Yolanda C. Turner');
    expect(docketFromBody(bold)).toBe('25-43233-mar');
    const wrapped = 'Case Name:\n\n  Brian H. Herschfus, et al v. City of Oak Park, MI, et al\nCase Number:  24-1451';
    expect(courtNameFromBody(wrapped)).toBe('Brian H. Herschfus, et al v. City of Oak Park, MI, et al');
    expect(docketFromBody(wrapped)).toBe('24-1451');
  });

  test('no name, nothing', () => {
    expect(courtNameFromBody('Pay.gov Payment Confirmation')).toBe('');
    expect(docketFromBody('')).toBe('');
    expect(courtNameFromBody(null)).toBe('');
  });
});

describe('buildPlan', () => {
  test('the court\'s most frequent name wins, by full or bare docket', () => {
    const p = plan({
      cases: [bk('26-1')],
      emails: [
        { docket: '26-1-mar', name: 'Jane Q. Smith' },
        { docket: '26-1-mar', name: 'Jane Q. Smith' },
        { docket: '26-1', name: 'Jane Smith' },
      ],
    });
    expect(p.writes).toEqual([{ case_id: '26-1', from: null, to: 'In re Jane Q. Smith', source: 'court' }]);
  });

  test('the literal email beats the AI log, which fills what mail does not cover', () => {
    const p = plan({
      cases: [bk('26-1'), bk('26-2')],
      emails: [{ docket: '26-1-mar', name: 'Literal Name' }],
      aiNames: [{ case_id: '26-1', name: 'Ai Name', n: 9 }, { case_id: '26-2', name: 'Other Person', n: 1 }],
    });
    expect(p.writes.map((w) => w.to)).toEqual(['In re Literal Name', 'In re Other Person']);
  });

  test('a blank name in an email counts for nothing', () => {
    const p = plan({ cases: [bk('26-1')], relates: [primary('26-1', 'Jane Smith')],
      emails: [{ docket: '26-1-mar', name: '' }] });
    expect(p.writes[0].source).toBe('contact');
  });

  test('no court email: the Primary contact\'s name', () => {
    const p = plan({ cases: [bk('26-1')], relates: [primary('26-1', 'Jane Smith')] });
    expect(p.writes).toEqual([{ case_id: '26-1', from: null, to: 'In re Jane Smith', source: 'contact' }]);
  });

  test('a Secondary with no court email goes to a person', () => {
    const p = plan({ cases: [bk('26-1')],
      relates: [primary('26-1', 'Jane Smith'), secondary('26-1', 'John Smith')] });
    expect(p.writes).toEqual([]);
    expect(p.hand[0].why).toContain('John Smith');
  });

  test('a Secondary with a court email takes the court\'s word', () => {
    const p = plan({ cases: [bk('26-1')], relates: [primary('26-1', 'Jane Smith'), secondary('26-1', 'John Smith')],
      emails: [{ docket: '26-1-mar', name: 'John Smith and Jane Smith' }] });
    expect(p.writes[0].to).toBe('In re John Smith and Jane Smith');
    expect(p.hand).toEqual([]);
  });

  test('an adversary with no court email goes to a person, and takes no contact name', () => {
    const p = plan({ cases: [bk('26-1', { case_subtype: 'Adversary Proceeding' })],
      relates: [primary('26-1', 'Jane Smith')] });
    expect(p.writes).toEqual([]);
    expect(p.hand).toHaveLength(1);
  });

  test('no docket, no caption, whatever the type', () => {
    const p = plan({ cases: [bk('LEADCASE', { case_number: null, case_number_full: '' })],
      relates: [primary('LEADCASE', 'Jane Smith')] });
    expect(p.writes).toEqual([]);
    expect(p.hand).toEqual([]);
  });

  test('a non-bankruptcy case with no court email is left for staff', () => {
    const p = plan({ cases: [bk('26-1', { case_type: 'Civil Litigation', case_subtype: '' })],
      relates: [primary('26-1', 'Jane Smith')] });
    expect(p.writes).toEqual([]);
    expect(p.hand).toEqual([]);
  });

  test('a civil case on ECF takes the court\'s text', () => {
    const p = plan({ cases: [bk('26-1', { case_type: 'Civil Litigation', case_subtype: '' })],
      emails: [{ docket: '26-1-mar', name: 'EYM Realty v. Mt. Hawley' }] });
    expect(p.writes[0].to).toBe('EYM Realty v. Mt. Hawley');
  });

  test('a "v." name on a main case is not a caption for it', () => {
    const p = plan({ cases: [bk('26-1')], relates: [primary('26-1', 'Jane Smith')],
      emails: [{ docket: '26-1-mar', name: 'Cohen v. Boren' }] });
    expect(p.writes[0]).toEqual({ case_id: '26-1', from: null, to: 'In re Jane Smith', source: 'contact' });
  });

  test('a bare docket two cases share matches neither', () => {
    const p = plan({
      cases: [bk('26-1', { case_number_full: '26-1-mar' }), bk('X', { case_number: '26-1', case_number_full: '26-1-prh' })],
      emails: [{ docket: '26-1', name: 'Jane Smith' }],
    });
    expect(p.sharedDockets).toEqual(['26-1']);
    expect(p.writes.filter((w) => w.source === 'court')).toEqual([]);
  });

  test('existing captions: a bare main case gains "In re", nothing else moves', () => {
    const p = plan({ cases: [
      bk('A', { case_caption: 'Aimee Gail Crittenden' }),
      bk('B', { case_caption: 'In re Legacy Signature Properties, Inc.' }),
      bk('C', { case_caption: 'Schneyer v. Childs', case_subtype: 'Adversary Proceeding' }),
      bk('D', { case_caption: 'Reaver v. Childs' }),
    ] });
    expect(p.writes).toEqual([{ case_id: 'A', from: 'Aimee Gail Crittenden',
      to: 'In re Aimee Gail Crittenden', source: 'normalize' }]);
  });
});
