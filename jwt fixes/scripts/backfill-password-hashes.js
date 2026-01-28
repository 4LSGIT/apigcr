/**
 * One-time password hash backfill script
 * Run with: node scripts/backfill-password-hashes.js
 */

require("dotenv").config(); // <-- REQUIRED

const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");

// ---------- CONFIG VALIDATION ----------
const REQUIRED_ENVS = [
  "host",
  "user",
  "password",
  "database"
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
    console.log("🔐 Starting password hash backfill…");

    pool = await createDbPool();

    // Sanity check connection
    await pool.query("SELECT 1");
    console.log("✅ Database connection OK");

    const [users] = await pool.query(`
      SELECT user, password
      FROM users
      WHERE password IS NOT NULL
        AND password_hash IS NULL
    `);

    if (users.length === 0) {
      console.log("ℹ️  No users need backfilling");
      process.exit(0);
    }

    console.log(`👤 Found ${users.length} users to backfill`);

    let processed = 0;

    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 12);

      await pool.query(
        "UPDATE users SET password_hash = ? WHERE user = ?",
        [hash, u.user]
      );

      processed++;
      if (processed % 5 === 0 || processed === users.length) {
        console.log(`   → ${processed}/${users.length} done`);
      }
    }

    console.log("🎉 Password backfill complete");
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
