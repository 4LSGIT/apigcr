// tests/schemaCollationBin.test.js — Dropbox ids are case-SENSITIVE base64url.
// general_ci merged 3,000+ distinct files into shared rows before anyone saw
// an error (2026-08-27). This is invisible at write time by construction —
// hence a schema lint, not a runtime check. Fix + fallout: ref/documents_s2_hotfix.sql
// and the S2 rollout report; the repair is
//   ALTER TABLE <t> MODIFY <col> VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin …
// followed by `npm run db:ref` so this test lints a current dump.
//
// ── S3.1 HARDENING ────────────────────────────────────────────────────────
// The original matcher was
//     /CREATE TABLE `documents`[\s\S]*?`external_id`[^\n]*/
// — non-greedy but UNBOUNDED, so it would run past the end of the documents
// block and match an `external_id` in some later table. That is a false
// NEGATIVE in the one scenario a guard exists for: drop or rename the column
// and the test keeps passing against a different table's line. The match is
// now bounded to the column list of the named CREATE TABLE, so an absent
// column fails loudly instead of finding a lookalike downstream.
'use strict';
const fs = require('fs'), path = require('path');
const dump = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8');

const BIN_COLUMNS = [
  ['documents',         'external_id'],
  ['case_folder_cache', 'folder_external_id'],
];

/**
 * The body of one CREATE TABLE — everything between the opening paren and the
 * `) ENGINE=` that closes it. Stopping there is what bounds the search: the
 * dump indents every column line, so a `)` at column 0 always ends the
 * definition. (Same dump shape tests/schemaConventions.test.js parses.)
 */
function tableBody(table) {
  const m = dump.match(new RegExp(
    'CREATE TABLE `' + table + '` \\(\\n([\\s\\S]*?)\\n\\) ENGINE='));
  return m ? m[1] : null;
}

/** The one line defining `col` inside that body, or null. */
function columnLine(body, col) {
  if (!body) return null;
  const m = body.match(new RegExp('^\\s*`' + col + '` .*$', 'm'));
  return m ? m[0] : null;
}

describe.each(BIN_COLUMNS)('%s.%s', (table, col) => {
  test('the table and column are still present in the dump', () => {
    // Guards the guard: without this, dropping the column would turn the
    // collation assertion below into a no-op that passes forever.
    const body = tableBody(table);
    expect(body).not.toBeNull();
    expect(columnLine(body, col)).not.toBeNull();
  });

  test('is utf8mb4_bin', () => {
    expect(columnLine(tableBody(table), col)).toMatch(/COLLATE utf8mb4_bin/);
  });
});

// The bound is real, not decorative: `documents` is followed in the dump by
// `email_credentials` and others, and the old unbounded matcher would have
// reached them. This pins that a lookalike column in a LATER table cannot
// satisfy an EARLIER table's assertion.
test('the search is bounded to one CREATE TABLE block', () => {
  const body = tableBody('documents');
  expect(body).not.toBeNull();
  // A column that exists elsewhere in the dump but NOT in `documents`.
  expect(dump).toMatch(/`smtp_host`/);
  expect(columnLine(body, 'smtp_host')).toBeNull();
});
