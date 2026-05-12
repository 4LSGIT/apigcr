// scripts/encrypt-smtp-passwords.js
//
/**
 * One-time encryption of legacy plaintext smtp_pass values in
 * email_credentials. Run with: node scripts/encrypt-smtp-passwords.js
 *
 * Idempotent — rows already ENCv1:-prefixed (or NULL/empty) are skipped.
 * Mirrors the convention of scripts/backfill-password-hashes.js: stdout
 * is the audit trail; no admin_audit_log writes; no updated_at touch.
 */

require("dotenv").config(); // <-- REQUIRED

const mysql = require("mysql2/promise");
const { encrypt, isEncrypted } = require("../lib/credentialCrypto");

// ---------- CONFIG VALIDATION ----------
const REQUIRED_ENVS = [
  "host",
  "user",
  "password",
  "database",
  "CREDENTIALS_ENCRYPTION_KEY"
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ---------- DB CONNECTION ----------
async function createDbPool() {
  return mysql.createPool({
    host: process.env.host,
    user: process.env.user,
    password: process.env.password,
    database: process.env.database,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });
}

// ---------- MAIN ----------
(async () => {
  let pool;

  try {
    console.log("🔐 Starting smtp_pass encryption backfill…");

    pool = await createDbPool();

    // Sanity check connection
    await pool.query("SELECT 1");
    console.log("✅ Database connection OK");

    const [rows] = await pool.query(`
      SELECT id, email, smtp_pass
      FROM email_credentials
      WHERE smtp_pass IS NOT NULL
        AND smtp_pass != ''
        AND smtp_pass NOT LIKE 'ENCv1:%'
    `);

    if (rows.length === 0) {
      console.log("ℹ️  No rows need encrypting");
      process.exit(0);
    }

    console.log(`📧 Found ${rows.length} rows to encrypt`);

    let processed = 0;
    let skipped = 0;

    for (const r of rows) {
      // Defense-in-depth: even though the WHERE filter excludes ENCv1:
      // rows, double-check here. If somehow an already-encrypted value
      // slipped through, skip rather than double-encrypt.
      if (isEncrypted(r.smtp_pass)) {
        skipped++;
        continue;
      }

      const ciphertext = encrypt(r.smtp_pass);

      await pool.query(
        "UPDATE email_credentials SET smtp_pass = ? WHERE id = ?",
        [ciphertext, r.id]
      );

      processed++;
      if (processed % 5 === 0 || processed === rows.length) {
        console.log(`   → ${processed}/${rows.length} done`);
      }
    }

    if (skipped > 0) {
      console.log(`⚠️  Skipped ${skipped} row(s) that were already encrypted`);
    }
    console.log(`🎉 Encryption backfill complete — ${processed} row(s) updated`);
    process.exit(0);

  } catch (err) {
    console.error("💥 Backfill failed:");
    console.error(err.message || err);
    process.exit(1);

  } finally {
    if (pool) {
      await pool.end();
    }
  }
})();