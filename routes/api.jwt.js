const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");


/*router.get('/api/events', async (req, res) => {
  const { start, end } = req.query;

  const [rows] = await req.db.query(`
    SELECT 
      appt_id AS id,
      CONCAT(appt_type, ' - ', appt_platform) AS title,
      appt_date AS start,
      appt_end AS end
    FROM appts
    WHERE appt_status = 'Scheduled'
    AND appt_date >= ?
    AND appt_date <= ?
  `, [start, end]);

  res.json(rows);
});*/

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