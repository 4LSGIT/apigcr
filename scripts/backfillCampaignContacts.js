/**
 * Backfill campaign_contacts from campaigns.contact_ids
 *
 * Run once during migration:
 *   node scripts/backfillCampaignContacts.js
 *
 * Parses the comma-separated contact_ids text field on each campaign
 * and inserts rows into the campaign_contacts junction table.
 * Updates contact_count on each campaign row.
 *
 * Safe to run multiple times — INSERT IGNORE skips duplicates.
 * Contacts that no longer exist in the contacts table are skipped
 * silently (FK constraint handled by IGNORE).
 */

async function backfill(db) {
  // Only process campaigns that still have contact_ids populated
  const [campaigns] = await db.query(
    `SELECT campaign_id, contact_ids
     FROM campaigns
     WHERE contact_ids IS NOT NULL AND contact_ids != ''`
  );

  console.log(`Found ${campaigns.length} campaigns to backfill\n`);

  let totalInserted = 0;
  let campaignsProcessed = 0;
  let campaignsSkipped = 0;

  for (const campaign of campaigns) {
    const contactIds = campaign.contact_ids
      .split(',')
      .map(id => parseInt(id.trim()))
      .filter(id => !isNaN(id) && id > 0);

    if (!contactIds.length) {
      console.log(`  campaign ${campaign.campaign_id} — no valid contact IDs, skipping`);
      campaignsSkipped++;
      continue;
    }

    // Deduplicate (in case the CSV had duplicates)
    const unique = [...new Set(contactIds)];

    // Batch INSERT IGNORE — skips duplicates from re-runs and
    // silently skips contacts that no longer exist (FK violation → warning)
    const values = unique.map(cid => [campaign.campaign_id, cid]);
    const [result] = await db.query(
      'INSERT IGNORE INTO campaign_contacts (campaign_id, contact_id) VALUES ?',
      [values]
    );

    // Update contact_count from actual inserted rows (not from CSV length,
    // since some contacts may have been deleted)
    const [[{ cnt }]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM campaign_contacts WHERE campaign_id = ?',
      [campaign.campaign_id]
    );
    await db.query(
      'UPDATE campaigns SET contact_count = ? WHERE campaign_id = ?',
      [cnt, campaign.campaign_id]
    );

    console.log(`  campaign ${campaign.campaign_id} — ${result.affectedRows} inserted, ${cnt} total (${unique.length} in CSV)`);
    totalInserted += result.affectedRows;
    campaignsProcessed++;
  }

  console.log(`\nBackfill complete:`);
  console.log(`  Campaigns processed: ${campaignsProcessed}`);
  console.log(`  Campaigns skipped:   ${campaignsSkipped}`);
  console.log(`  Rows inserted:       ${totalInserted}`);
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');

  backfill(pool)
    .then(() => {
      console.log('\nDone. Verify results, then run Steps 11-13 of the SQL migration.');
      process.exit(0);
    })
    .catch(err => {
      console.error('Backfill failed:', err);
      process.exit(1);
    });
}

module.exports = backfill;
