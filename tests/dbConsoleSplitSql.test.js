/**
 * tests/dbConsoleSplitSql.test.js
 *
 * THE DB CONSOLE'S STATEMENT SPLITTER — public/dbConsole.html's splitSql().
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * The pool runs with multipleStatements off, so a pasted script has to be cut
 * into single statements client-side before POST /admin/db/batch ever sees it.
 * Everything downstream — the batch loop, stop-on-error, the markdown report —
 * trusts that cut completely, and a bad cut does not look like a bug. It looks
 * like a server-side syntax error on a fragment nobody wrote.
 *
 * That is exactly how the m3 org-contacts migration failed on 2026-09-08. The
 * splitter had no DELIMITER support and no BEGIN…END awareness, so
 *
 *     DELIMITER $$
 *     CREATE TRIGGER … BEGIN DECLARE x VARCHAR(255); … END $$
 *
 * became fourteen fragments, and `DECLARE lfm_name VARCHAR(255)` was sent to
 * MySQL as a standalone statement. A trigger or procedure body is the one shape
 * a plain semicolon splitter cannot express, and it is also the shape you most
 * want a migration console for.
 *
 * The DELIMITER cases below pin the fix. The rest pin the behaviour that was
 * already correct, because the fix touches the hot path of the state machine
 * and a regression there is silent in exactly the same way.
 *
 *   npx jest tests/dbConsoleSplitSql.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Lift splitSql() out of the shipped HTML rather than re-implementing it.
 * A copied fixture would keep passing while the real page drifted, which is
 * the failure mode this whole file exists to prevent.
 */
function loadSplitSql() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dbConsole.html'), 'utf8');
  const m = html.match(/function splitSql\(sql\)\s*\{[\s\S]*?\n\}/);
  if (!m) throw new Error('splitSql() not found in public/dbConsole.html');
  // eslint-disable-next-line no-eval
  return eval(`(${m[0].replace(/^function splitSql/, 'function')})`);
}

const splitSql = loadSplitSql();

// ─────────────────────────────────────────────────────────────
// DELIMITER — the regression that broke m3
// ─────────────────────────────────────────────────────────────

describe('splitSql — DELIMITER', () => {
  test('a BEGIN…END trigger body survives as ONE statement', () => {
    const sql = `
DELIMITER $$
CREATE TRIGGER t BEFORE INSERT ON c FOR EACH ROW
BEGIN
  DECLARE x VARCHAR(255);
  SET x = 'a';
  SET NEW.n = x;
END $$
DELIMITER ;
SELECT 1;
`;
    const out = splitSql(sql);
    expect(out).toHaveLength(2);
    // THE ASSERTION. Every internal semicolon stayed inside statement one.
    expect(out[0]).toMatch(/^CREATE TRIGGER/);
    expect(out[0]).toContain('DECLARE x VARCHAR(255);');
    expect(out[0]).toContain('END');
    expect(out[0]).not.toContain('$$');
    expect(out[1]).toBe('SELECT 1');
  });

  test('the directive itself is never emitted — the server has no DELIMITER', () => {
    const out = splitSql("DELIMITER $$\nSELECT 1 $$\nDELIMITER ;\nSELECT 2;");
    expect(out.join('\n')).not.toMatch(/DELIMITER/i);
    expect(out).toEqual(['SELECT 1', 'SELECT 2']);
  });

  test('while a custom delimiter is active, a bare ; does NOT split', () => {
    const out = splitSql("DELIMITER $$\nSELECT 1; SELECT 2 $$");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('SELECT 1; SELECT 2');
  });

  test('switching back to ; restores normal splitting', () => {
    const out = splitSql("DELIMITER $$\nSELECT 1 $$\nDELIMITER ;\nSELECT 2; SELECT 3;");
    expect(out).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  test('multi-char delimiters other than $$ work', () => {
    const out = splitSql("DELIMITER //\nSELECT 1 //\nSELECT 2 //");
    expect(out).toEqual(['SELECT 1', 'SELECT 2']);
  });

  test('DELIMITER is only a directive at the start of a line', () => {
    // A column called `delimiter`, or the word inside an expression, must not
    // hijack the splitter.
    const out = splitSql("SELECT delimiter $$ FROM t;");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('$$');
  });

  test('leading comments still attach to the statement that follows', () => {
    // Not flushing the buffer on the directive is what preserves the
    // "annotated batch" pattern the report relies on.
    const out = splitSql("-- why this trigger exists\nDELIMITER $$\nCREATE TRIGGER t ... $$");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^-- why this trigger exists/);
    expect(out[0]).toContain('CREATE TRIGGER');
  });
});

// ─────────────────────────────────────────────────────────────
// Everything that already worked — the fix edits the hot path
// ─────────────────────────────────────────────────────────────

describe('splitSql — pre-existing behaviour (regression guard)', () => {
  test('plain semicolon splitting, trimmed, empties dropped', () => {
    expect(splitSql('SELECT 1;  SELECT 2 ;\n\n;SELECT 3'))
      .toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  test('a semicolon inside a single-quoted literal does not split', () => {
    const out = splitSql("SELECT 'a;b' AS x; SELECT 2;");
    expect(out).toEqual(["SELECT 'a;b' AS x", 'SELECT 2']);
  });

  test('a semicolon inside a double-quoted literal does not split', () => {
    expect(splitSql('SELECT "a;b"; SELECT 2;')).toEqual(['SELECT "a;b"', 'SELECT 2']);
  });

  test('a semicolon inside a backtick identifier does not split', () => {
    expect(splitSql('SELECT `we;ird`; SELECT 2;')).toEqual(['SELECT `we;ird`', 'SELECT 2']);
  });

  test("doubled quotes are a literal quote, not a close", () => {
    const out = splitSql("SELECT 'O''Brien; Esq' AS n; SELECT 2;");
    expect(out).toEqual(["SELECT 'O''Brien; Esq' AS n", 'SELECT 2']);
  });

  test('backslash escapes inside a literal are honoured', () => {
    const out = splitSql("SELECT 'a\\'; b' AS x; SELECT 2;");
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('SELECT 2');
  });

  test('a semicolon inside a -- line comment does not split', () => {
    expect(splitSql('SELECT 1 -- trailing; note\n; SELECT 2;'))
      .toEqual(['SELECT 1 -- trailing; note', 'SELECT 2']);
  });

  test('a semicolon inside a # line comment does not split', () => {
    expect(splitSql('SELECT 1 # hash; note\n; SELECT 2;'))
      .toEqual(['SELECT 1 # hash; note', 'SELECT 2']);
  });

  test('a semicolon inside a block comment does not split', () => {
    expect(splitSql('SELECT 1 /* a; b */; SELECT 2;'))
      .toEqual(['SELECT 1 /* a; b */', 'SELECT 2']);
  });

  test('"--" needs whitespace after it, per the MySQL grammar', () => {
    // `1--2` is arithmetic, not a comment; the ; must still split.
    const out = splitSql('SELECT 1--2; SELECT 3;');
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('SELECT 3');
  });

  test('an unterminated trailing statement is still emitted', () => {
    expect(splitSql('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  test('leading comments attach to the following statement', () => {
    const out = splitSql('-- header\nSELECT 1;\n-- second\nSELECT 2;');
    expect(out[0]).toBe('-- header\nSELECT 1');
    expect(out[1]).toBe('-- second\nSELECT 2');
  });
});
