/**
 * tests/reportSchemaDenylist.test.js
 *
 * REPORT COLUMN DENYLIST — what a report may and may not reference.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * The denylist in lib/reportSchema/manifest.js is the only thing between a
 * staff-authored (or AI-authored) report and a CSV of credential material. It
 * had NO jest coverage before 2026-09-24 — the only check was
 * tests/test_report_author.sh, a live smoke test that needs a deployed app, a
 * superuser JWT and an Anthropic key, and that PRINTS its findings rather than
 * asserting them. A harness that prints is not a gate.
 *
 * It got its first real test on the day the list changed, which is the worst
 * possible day to have no test: contact_ssn and contact_dob came OFF the list
 * (Fred's ruling — a bankruptcy firm files Form 121, and a report that cannot
 * show a date of birth cannot answer ordinary questions). Both directions are
 * pinned here so the next edit to that list has to mean it:
 *
 *   - SSN and DOB are selectable, including through the alias / subquery /
 *     backtick routes the scanner is built to catch.
 *   - Credential material is still refused by those same routes, so the
 *     mechanism demonstrably still works rather than having been switched off.
 *   - SELECT * stays banned. Its comment used to justify itself with
 *     contact_ssn; the reason is now password_hash, and the ban is unchanged.
 *
 *   npx jest tests/reportSchemaDenylist.test.js
 */

'use strict';

const { validateSql } = require('../lib/reportSchema/validator');
const { DENIED_COLUMNS, isDeniedColumn } = require('../lib/reportSchema/manifest');

/** validateSql returns {ok:true,...} or {ok:false,error,detail?}. */
const ok  = (sql) => validateSql(sql).ok === true;
const err = (sql) => { const r = validateSql(sql); return `${r.error || ''} ${r.detail || ''}`; };

// ─────────────────────────────────────────────────────────────
// The ruling: SSN and DOB are ordinary columns
// ─────────────────────────────────────────────────────────────

describe('contact_ssn / contact_dob are selectable (2026-09-24 ruling)', () => {
  test.each(['contact_ssn', 'contact_dob'])('%s is not on the denylist', (col) => {
    expect(DENIED_COLUMNS).not.toContain(col);
    expect(isDeniedColumn(col)).toBe(false);
  });

  test('a plain SELECT of both validates', () => {
    expect(ok('SELECT contact_id, contact_ssn, contact_dob FROM contacts')).toBe(true);
  });

  test('aliased, and inside a subquery, and backticked', () => {
    expect(ok('SELECT contact_ssn AS ssn FROM contacts')).toBe(true);
    expect(ok('SELECT x.contact_dob FROM (SELECT contact_dob FROM contacts) x')).toBe(true);
    expect(ok('SELECT `contact_ssn` FROM contacts')).toBe(true);
  });

  test('the realistic Form 121 shape — last four, non-empty only', () => {
    // contact_ssn is NOT NULL but usually ''; 14 of 151 non-empty rows carry
    // dashes. Both facts are in the manifest column note.
    expect(ok(
      "SELECT contact_id, RIGHT(REGEXP_REPLACE(contact_ssn, '[^0-9]', ''), 4) AS ssn4 " +
      "FROM contacts WHERE contact_ssn <> ''"
    )).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// The mechanism still works
// ─────────────────────────────────────────────────────────────

describe('credential material is still refused', () => {
  test.each(['password', 'password_hash', 'reset_token', 'contact_token', 'draft_key'])(
    '%s is still denied', (col) => {
      expect(DENIED_COLUMNS).toContain(col);
      expect(isDeniedColumn(col)).toBe(true);
    });

  test('a denied column is caught plain, aliased, backticked and in a subquery', () => {
    expect(ok('SELECT password_hash FROM users')).toBe(false);
    expect(ok('SELECT password_hash AS p FROM users')).toBe(false);
    expect(ok('SELECT `password_hash` FROM users')).toBe(false);
    expect(ok('SELECT u.p FROM (SELECT password_hash AS p FROM users) u')).toBe(false);
  });

  test('the refusal names the column AND lists the denylist', () => {
    const msg = err('SELECT password_hash FROM users');
    expect(msg).toMatch(/password_hash/);
    expect(msg).toMatch(/denylist/i);
    // The list it prints is the live one — no SSN or DOB in it any more.
    expect(msg).not.toMatch(/contact_ssn|contact_dob/);
  });
});

// ─────────────────────────────────────────────────────────────
// SELECT * — unchanged, for a reason that is no longer SSN
// ─────────────────────────────────────────────────────────────

describe('SELECT * stays banned', () => {
  test('a select-list star is refused even now that SSN is allowed', () => {
    expect(ok('SELECT * FROM contacts')).toBe(false);
    expect(ok('SELECT c.* FROM contacts c')).toBe(false);
  });

  test('multiplication is not a star — percentage reports still validate', () => {
    // An earlier naive "any bare *" check rejected these.
    expect(ok(
      'SELECT ROUND(100.0 * SUM(contact_id) / COUNT(*), 1) AS pct FROM contacts'
    )).toBe(true);
  });
});
