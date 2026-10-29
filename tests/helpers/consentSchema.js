// tests/helpers/consentSchema.js
//
// The YisraMail P1 consent tables (comm_topics, comm_consent_events,
// comm_consent_state) for the gated real-MySQL twins.
//
// They reach ref/database.sql only once the migration has run live, so a twin
// whose code path reads or writes consent — optoutService's reader, the contact
// phone/email writers, the Casey send / appointment normalizers — builds them
// from the migration file itself. That file is idempotent (CREATE TABLE IF NOT
// EXISTS + a guarded seed), so this keeps working unchanged once the
// regenerated dump carries the tables.
//
// Twin rule (CLAUDE.md): a twin builds every table it touches and drops in its
// before-hook any table a sibling creates — several twins create these, so
// buildConsentTables() drops them first by default (fresh, empty, seeded).
'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', '..', 'ref', 'migrations', '2026-10-29_yisramail_p1_consent_core.sql');
const CONSENT_TABLES = Object.freeze(['comm_topics', 'comm_consent_events', 'comm_consent_state']);

// Each statement ends with ';' at END OF LINE — a COMMENT may hold '; ' mid-line.
function consentStatements() {
  return fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}

// q: (sql, params?) => Promise — the twin's own query helper.
async function buildConsentTables(q, { fresh = true } = {}) {
  if (fresh) for (const t of CONSENT_TABLES) await q(`DROP TABLE IF EXISTS \`${t}\``);
  for (const sql of consentStatements()) await q(sql);
}

module.exports = { MIGRATION, CONSENT_TABLES, consentStatements, buildConsentTables };
