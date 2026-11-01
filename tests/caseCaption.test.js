/**
 * tests/caseCaption.test.js — the caption naming rules (lib/caseCaption.js).
 *
 *   npx jest tests/caseCaption.test.js
 */

'use strict';

const {
  captionFromCourtName,
  courtNameFromCaption,
  captionAddsInfo,
} = require('../lib/caseCaption');

const CH7 = { case_type: 'Bankruptcy', case_subtype: 'Chapter 7' };
const OLD_BK = { case_type: 'Bankruptcy', case_subtype: '' };
const AP = { case_type: 'Bankruptcy', case_subtype: 'Adversary Proceeding' };
const CIVIL = { case_type: 'Civil Litigation', case_subtype: '' };

describe('captionFromCourtName', () => {
  test.each([
    [CH7, 'Zenobia A. Dandridge', 'In re Zenobia A. Dandridge'],
    [CH7, 'Dennis Gardin and Alicia Gardin', 'In re Dennis Gardin and Alicia Gardin'],
    [OLD_BK, 'Rosemary Dotson', 'In re Rosemary Dotson'],
    [CH7, '584 Starkweather LLC', 'In re 584 Starkweather LLC'],
    [CH7, 'In re Legacy Signature Properties, Inc.', 'In re Legacy Signature Properties, Inc.'],
    [CH7, 'IN RE: Rosemary Dotson', 'In re Rosemary Dotson'],
    [CH7, 'Ivan V. Smith', 'In re Ivan V. Smith'],
    [CH7, '  Taneka   Moody ', 'In re Taneka Moody'],
    [AP, 'Schneyer v. Childs', 'Schneyer v. Childs'],
    [CIVIL, 'EYM Realty of Michigan LLC v. Mt. Hawley Insurance Company',
      'EYM Realty of Michigan LLC v. Mt. Hawley Insurance Company'],
    [CIVIL, 'Hamama', 'Hamama'],
  ])('%j %s', (row, name, want) => {
    expect(captionFromCourtName(row, name)).toBe(want);
  });

  test.each([[''], ['   '], [null], [undefined], ['In re ']])('nothing to write for %j', (name) => {
    expect(captionFromCourtName(CH7, name)).toBeNull();
  });

  test('a "v." name never lands on a main bankruptcy case', () => {
    expect(captionFromCourtName(CH7, 'Cohen v. Boren')).toBeNull();
    expect(captionFromCourtName(OLD_BK, 'Cohen v Boren')).toBeNull();
  });

  test('never longer than the column', () => {
    expect(captionFromCourtName(CH7, 'x'.repeat(200))).toHaveLength(150);
    expect(captionFromCourtName(AP, 'y'.repeat(200))).toHaveLength(150);
  });
});

describe('courtNameFromCaption', () => {
  test('takes the "In re" off and leaves anything else alone', () => {
    expect(courtNameFromCaption('In re Jane Smith')).toBe('Jane Smith');
    expect(courtNameFromCaption('Schneyer v. Childs')).toBe('Schneyer v. Childs');
    expect(courtNameFromCaption(null)).toBe('');
  });
});

describe('captionAddsInfo', () => {
  // The cases that decided the rule, as they stood on 2026-11-01.
  test.each([
    ['In re Jason F. Childs', 'Jason F Childs'],
    ['In re Gary Lee Brohl, Jr', 'Gary Lee Brohl Jr'],
    ['In re Michelle Lynn Britt-McNeil', 'Michelle Britt'],
    ['In re Tracy N. Morton-Davis', 'Tracy N Morton- Davis'],
    ['In re Dennis Gardin and Alicia Gardin', 'Alicia Gardin'],
    ['In re Legacy Signature Properties, Inc.', 'Legacy Signature Properties, Inc.'],
    ['In re Deon Drake', 'Deon Drake Jr'],
  ])('%s only repeats %s', (caption, primary) => {
    expect(captionAddsInfo(caption, primary)).toBe(false);
  });

  test.each([
    ['Schneyer v. Childs', 'Jason F Childs'],
    ['Moore v. Westlake Financial Services', 'Kimberly D Moore'],
    ['In re Ammar Victor Buny', 'Salwan Savaya'],
    ['In re 584 Starkweather LLC', 'David Merlo'],
    ['In re Aimee Ish', 'Aimee A Smith'],
    ['In re Jane Smith', ''],
  ])('%s says more than %s', (caption, primary) => {
    expect(captionAddsInfo(caption, primary)).toBe(true);
  });

  test('a middle initial V. is not a versus', () => {
    expect(captionAddsInfo('In re Ivan V. Smith', 'Ivan Smith')).toBe(false);
  });

  test('no caption adds nothing', () => {
    expect(captionAddsInfo('', 'Jane Smith')).toBe(false);
    expect(captionAddsInfo(null, 'Jane Smith')).toBe(false);
  });
});
