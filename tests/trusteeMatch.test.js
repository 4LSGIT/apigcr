// tests/trusteeMatch.test.js — FIL-1 pure matcher table tests.
'use strict';

const { matchTrustee } = require('../lib/trusteeMatch');

// Shapes verbatim from the live fe-trustees setting (subset), including the
// McDonald pair whose exact-name collision the chapter gate exists for.
const ROSTER = [
  { name: 'Michael A. Stevenson',   lname: 'Stevenson', case_type: 7,  link: 'https://z/stev' },
  { name: 'Thomas W. McDonald',     lname: 'McDonald',  case_type: 12, link: 'https://z/mc12' },
  { name: 'Thomas W. Jr. McDonald', lname: 'McDonald',  case_type: 13, link: 'https://z/mc13' },
  { name: 'Stuart A. Gold',         lname: 'Gold',      case_type: 7,  link: 'https://z/gold' },
  { name: 'K. Jin Lim',             lname: 'Lim',       case_type: 7,  link: 'https://z/lim'  },
  { name: 'Krispen S. Carroll',     lname: 'Carroll',   case_type: 13, link: 'https://z/car'  },
];

const m = (extracted, chapter, roster = ROSTER) =>
  matchTrustee({ extracted, chapter, roster });

describe('matchTrustee', () => {
  test('exact match, case/whitespace-insensitive', () => {
    const r = m('  stuart a.  gold ', '7');
    expect(r.status).toBe('matched');
    expect(r.method).toBe('exact');
    expect(r.entry.name).toBe('Stuart A. Gold');
  });

  test('lname fuzzy canonicalizes the live drift case (Michael Stevenson)', () => {
    const r = m('Michael Stevenson', '7');
    expect(r).toMatchObject({ status: 'matched', method: 'lname' });
    expect(r.entry.name).toBe('Michael A. Stevenson');
  });

  test('McDonald collision: Ch13 case + exact Ch12 NAME resolves to the Jr (Ch13) entry', () => {
    const r = m('Thomas W. McDonald', '13');
    expect(r.status).toBe('matched');
    expect(r.entry.name).toBe('Thomas W. Jr. McDonald');
  });

  test('McDonald with unknown chapter is ambiguous — never guesses', () => {
    const r = m('McDonald', '');
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.map((c) => c.name).sort()).toEqual(
      ['Thomas W. Jr. McDonald', 'Thomas W. McDonald']);
  });

  test('lname is whole-word: "Golden" does not hit lname "Gold"', () => {
    expect(m('Sarah Golden', '7').status).toBe('no_match');
  });

  test('incompatible first name blocks the lname match (near-miss reported)', () => {
    const r = m('John Stevenson', '7');
    expect(r.status).toBe('no_match');
    expect(r.candidates.map((c) => c.name)).toEqual(['Michael A. Stevenson']);
  });

  test('single-letter initial is compatible either direction', () => {
    expect(m('M. Stevenson', '7')).toMatchObject({ status: 'matched', method: 'lname' });
    expect(m('Krispen Carroll', '13')).toMatchObject({ status: 'matched', method: 'lname' });
  });

  test('surname-only extracted value matches a unique candidate', () => {
    const r = m('Lim', '7');
    expect(r.status).toBe('matched');
    expect(r.entry.name).toBe('K. Jin Lim');
  });

  test('a hit only on chapter-mismatched entries is chapter_mismatch, not a match', () => {
    const r = m('Stuart A. Gold', '13');
    expect(r.status).toBe('chapter_mismatch');
    expect(r.candidates.map((c) => c.name)).toEqual(['Stuart A. Gold']);
  });

  test('entries with no case_type are always eligible', () => {
    const roster = [{ name: 'Any Chapter Trustee', lname: 'Trustee', link: 'x' }];
    expect(m('Any Chapter Trustee', '13', roster).status).toBe('matched');
  });

  test('unknown name → no_match with empty candidates', () => {
    const r = m('Jane Q. Nobody', '7');
    expect(r.status).toBe('no_match');
    expect(r.candidates).toEqual([]);
  });

  test('empty / whitespace trustee → no_trustee', () => {
    expect(m('', '7').status).toBe('no_trustee');
    expect(m('   ', '7').status).toBe('no_trustee');
  });

  test('missing, empty, or garbage roster → no_roster', () => {
    expect(m('X', '7', null).status).toBe('no_roster');
    expect(m('X', '7', []).status).toBe('no_roster');
    expect(m('X', '7', [{ nope: 1 }, null]).status).toBe('no_roster');
  });

  test('regex metacharacters in lname cannot break the word-boundary test', () => {
    const roster = [{ name: 'A. B. (Chip) O\'Neil', lname: 'O\'Neil (Chip)', case_type: 7, link: 'x' }];
    // Must not throw, and must not false-positive.
    expect(() => m('Some Body', '7', roster)).not.toThrow();
  });
});
