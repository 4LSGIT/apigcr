// scripts/reviveScalarReplacedValues.js
//
/**
 * Revive contact_phones / contact_emails rows that the SCALAR propagators
 * ended as end_reason='replaced' before the demote-don't-end change.
 *
 * Those rows are numbers and addresses a contact actually gave us, ended
 * only because someone (often an unattended intake write) supplied a
 * different value for the same scalar column. Reviving = clear end_date and
 * end_reason, leave is_primary = 0. The current primary is untouched, so no
 * mirror recompute is needed and contacts.contact_phone / contact_email do
 * not move.
 *
 * SCOPE: end_reason='replaced' ONLY. 'ended' (an explicit clear) and
 * 'transferred' (a cross-contact move) stay ended — both were deliberate.
 *
 * ── THE GUARD THAT MATTERS ────────────────────────────────────────────────
 *
 * uk_phone_active / uk_email_active are UNIQUE on a generated column that is
 * the value WHERE end_date IS NULL — table-wide, and under utf8mb4_general_ci,
 * so CASE-INSENSITIVE for emails. A blanket revive therefore breaks on the
 * commonest real case in this data: a row ended purely because someone
 * re-saved the same address with different capitalization
 * (`Timothyfairley75@gmail.com` → `timothyfairley75@gmail.com`). Reviving the
 * first would collide with the second, and the row is not a second address
 * anyway — it is the same one, twice.
 *
 * So each candidate is checked against every ACTIVE row holding that value,
 * anywhere in the table, compared the way the index compares. A hit is
 * SKIPPED and reported, not written.
 *
 * Judgment the script does NOT make: whether an ended value was a typo
 * correction rather than a real change. Dry-run prints each candidate beside
 * the value that displaced it — eyeball that list before --apply. A typo you
 * revive by mistake is one click to re-end in the contact editor.
 *
 * USAGE:
 *   node scripts/reviveScalarReplacedValues.js             # dry-run (default)
 *   node scripts/reviveScalarReplacedValues.js --apply     # execute
 *   node scripts/reviveScalarReplacedValues.js --apply --include-test-contacts
 *
 * Test-shaped contacts (names matching Test/Tester, 555xxxxxxx numbers,
 * @example.com addresses) are excluded by default — reviving fixture rows
 * just makes the next person wonder what they mean.
 */

'use strict';

const APPLY         = process.argv.includes('--apply');
const INCLUDE_TESTS = process.argv.includes('--include-test-contacts');
const DRY           = !APPLY;

const KINDS = [
  { table: 'contact_phones', col: 'phone', mirror: 'contact_phone' },
  { table: 'contact_emails', col: 'email', mirror: 'contact_email' },
];

function pad(s, n) { return String(s == null ? '' : s).padEnd(n); }

/** Mirrors utf8mb4_general_ci equality closely enough for this comparison. */
function sameValue(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase()
      === String(b == null ? '' : b).trim().toLowerCase();
}

function looksLikeTestRow(row) {
  const name = String(row.contact_name || '');
  if (/\b(test|tester)\b/i.test(name)) return true;
  const v = String(row.value || '');
  if (/^555\d{7}$/.test(v)) return true;
  if (/@example\.(com|org|net)$/i.test(v)) return true;
  return false;
}

async function main(db) {
  console.log(`\n=== reviveScalarReplacedValues — ${DRY ? 'DRY-RUN (no writes)' : 'APPLY'} ===\n`);

  const summary = { revived: 0, skippedCollision: 0, skippedTest: 0 };

  for (const kind of KINDS) {
    const [candidates] = await db.query(
      `SELECT r.id, r.contact_id, c.contact_name,
              r.${kind.col} AS value,
              DATE_FORMAT(r.start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(r.end_date,   '%Y-%m-%d') AS end_date,
              c.${kind.mirror} AS current_primary
         FROM ${kind.table} r
         JOIN contacts c ON c.contact_id = r.contact_id
        WHERE r.end_reason = 'replaced'
        ORDER BY r.contact_id, r.id`
    );

    console.log(`── ${kind.table}: ${candidates.length} row(s) with end_reason='replaced'`);
    if (!candidates.length) { console.log(''); continue; }

    console.log('  ' + pad('id', 7) + pad('contact', 9) + pad('name', 24)
      + pad('ended value', 30) + pad('ended', 12) + pad('now primary', 30) + 'verdict');

    for (const row of candidates) {
      let verdict = 'REVIVE';

      if (!INCLUDE_TESTS && looksLikeTestRow(row)) {
        verdict = 'skip (test fixture)';
        summary.skippedTest++;
      } else {
        // The index check. Any ACTIVE row anywhere holding this value —
        // including the one that displaced it, compared case-insensitively.
        const [actives] = await db.query(
          `SELECT id, contact_id, ${kind.col} AS value
             FROM ${kind.table}
            WHERE end_date IS NULL AND id <> ?`,
          [row.id]
        );
        const clash = actives.find(a => sameValue(a.value, row.value));
        if (clash) {
          verdict = `skip (active row ${clash.id} on contact ${clash.contact_id} holds this value)`;
          summary.skippedCollision++;
        }
      }

      console.log('  ' + pad(row.id, 7) + pad(row.contact_id, 9)
        + pad(String(row.contact_name).slice(0, 22), 24)
        + pad(row.value, 30) + pad(row.end_date, 12)
        + pad(String(row.current_primary || '(none)').slice(0, 28), 30) + verdict);

      if (verdict !== 'REVIVE') continue;
      summary.revived++;

      if (!DRY) {
        // is_primary stays 0 — the current primary keeps the flag and the
        // mirror column, so no recompute is required.
        await db.query(
          `UPDATE ${kind.table}
              SET end_date = NULL, end_reason = NULL, updated_by = 0
            WHERE id = ? AND end_reason = 'replaced'`,
          [row.id]
        );
      }
    }
    console.log('');
  }

  console.log(`${summary.revived} row(s) ${DRY ? 'would be ' : ''}revived; `
    + `${summary.skippedCollision} skipped for an active duplicate, `
    + `${summary.skippedTest} skipped as test fixtures.`);
  if (DRY) console.log('Re-run with --apply to execute.\n');
  else console.log('');
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');
  main(pool)
    .then(() => process.exit(0))
    .catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
}

module.exports = { main };
