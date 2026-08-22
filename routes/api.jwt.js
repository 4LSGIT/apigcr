// routes/api.jwt.js
//
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

router.get("/auth/validate", jwtOrApiKey, (req, res) => {
  res.json({ valid: true, user: req.auth });
});


router.get('/api/cause_error', jwtOrApiKey, (req, res, next) => {
  next(new Error('Intentional test error'));
});

// Returns the Clio login 2FA code captured from inbound SMS by phone-ingest
// rule 4 and written to app_settings.clio_login_code by set_setting.
//
// age_seconds (added 2026-08-22) is computed IN SQL so it is immune to client
// clock skew. It exists because the UI must never present a dead code as
// usable: on 2026-08-21 a user read a three-day-old code four times in 26
// seconds and tried to log in with it. See public/index.html showClioCode().
// NULL when updated_at is NULL (the column is nullable) — callers must treat
// null as "infinitely old", not as "fresh".
router.get("/clio-code", jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT value, updated_at,
              TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age_seconds
       FROM app_settings 
       WHERE \`key\` = "clio_login_code"
       LIMIT 1`
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Code not found" });
    }

    const row = rows[0];
    // Normalise to a JS number (or null) so the client never has to guess
    // whether it got "180" or 180. The main pool is not configured with
    // bigNumberStrings, but pin the contract anyway.
    row.age_seconds = row.age_seconds == null ? null : Number(row.age_seconds);

    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get('/api/events', jwtOrApiKey, async (req, res) => {
  const { start, end } = req.query;

  const [rows] = await req.db.query(`
    SELECT 
      a.appt_id AS id,
      CONCAT(c.contact_name, ' - ', a.appt_type) AS title,
      a.appt_date AS start,
      a.appt_end AS end,
      a.appt_status,
      a.appt_platform,
      c.contact_name,
      a.appt_note,
      CASE 
        WHEN a.appt_status = 'Canceled' THEN '#999'
        WHEN a.appt_status = 'No Show' THEN '#dc3545'
        WHEN a.appt_status = 'Attended' THEN '#28a745'
        ELSE '#3788d8'
      END AS color
    FROM appts a
    LEFT JOIN contacts c 
      ON c.contact_id = a.appt_client_id
    WHERE a.appt_status != 'Canceled'
    AND a.appt_date >= ?
    AND a.appt_date <= ?
  `, [start, end]);

  res.json(rows);
});

module.exports = router;