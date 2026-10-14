// tests/helpers/commsArchiveSchema.js
//
// Builds the production tables a comms-archive real-engine suite needs, from
// ref/database.sql (CREATE + index / auto-increment ALTER blocks, FK
// constraints skipped), and applies migration files from disk. Line-based:
// column COMMENTs carry ';'.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(ROOT, 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [], alters = [];
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].match(/^CREATE TABLE `([^`]+)` \($/);
    const a = lines[i].match(/^ALTER TABLE `([^`]+)`$/);
    if (c && tables.includes(c[1])) {
      const buf = [];
      for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
      creates.push(buf.join('\n'));
    } else if (a && tables.includes(a[1])) {
      const buf = [];
      for (; i < lines.length; i++) { buf.push(lines[i]); if (/;$/.test(lines[i])) break; }
      const s = buf.join('\n');
      if (!/ADD CONSTRAINT/.test(s)) alters.push(s);
    }
  }
  return { creates, alters };
}

/** Statements of a migration file: whole-line comments stripped, split at a line-final ';'. */
function migrationStatements(file) {
  const body = fs.readFileSync(path.join(ROOT, 'ref', 'migrations', file), 'utf8')
    .split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  return body.split(/;\s*$/m).map(s => s.trim()).filter(Boolean);
}

async function build(pool, tables) {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [...tables, 'comms_media']) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
  const { creates, alters } = schemaFor(tables);
  if (creates.length !== tables.length) throw new Error(`schemaFor: found ${creates.length} of ${tables.length} tables`);
  for (const s of creates) await pool.query(s);
  for (const s of alters) await pool.query(s);
}

module.exports = { schemaFor, migrationStatements, build };
