/**
 * Backfill appt_date_utc for existing appointments
 *
 * Run once: node scripts/backfill_appt_date_utc.js
 *
 * Reads appt_date (local firm time stored as-if-UTC by mysql2),
 * converts to real UTC via timezoneService, writes to appt_date_utc.
 *
 * Safe to run multiple times — only touches rows where appt_date_utc IS NULL.
 */

const { localToUTC } = require('../services/timezoneService');

async function backfill(db) {
  const [rows] = await db.query(
    'SELECT appt_id, appt_date FROM appts WHERE appt_date_utc IS NULL'
  );

  console.log(`Found ${rows.length} appointments to backfill`);

  let updated = 0, skipped = 0;

  for (const row of rows) {
    const utc = localToUTC(row.appt_date);
    if (!utc) {
      console.warn(`  appt_id=${row.appt_id} — could not convert, skipping`);
      skipped++;
      continue;
    }

    await db.query(
      'UPDATE appts SET appt_date_utc = ? WHERE appt_id = ?',
      [utc, row.appt_id]
    );
    updated++;
  }

  console.log(`Backfill complete: ${updated} updated, ${skipped} skipped`);
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');  // adjust path to your pool export

  backfill(pool)
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = backfill;