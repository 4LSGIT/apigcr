// tests/schemaCollationBin.test.js — Dropbox ids are case-SENSITIVE base64url.
// general_ci merged 3,000+ distinct files into shared rows before anyone saw
// an error (2026-08-27). This is invisible at write time by construction —
// hence a schema lint, not a runtime check.
'use strict';
const fs = require('fs'), path = require('path');
const dump = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8');

const BIN_COLUMNS = [
  ['documents',         'external_id'],
  ['case_folder_cache', 'folder_external_id'],
];

test.each(BIN_COLUMNS)('%s.%s is utf8mb4_bin in the schema dump', (table, col) => {
  const m = dump.match(new RegExp(
    'CREATE TABLE `' + table + '`[\\s\\S]*?`' + col + '`[^\\n]*'));
  expect(m).not.toBeNull();
  expect(m[0]).toMatch(/COLLATE utf8mb4_bin/);
});
