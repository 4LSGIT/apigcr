const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");


// GET /api/appts/:id
// Returns single appointment with joined contact and case data
// Used by apptform.html initForm()

router.get("/api/appts/:id", jwtOrApiKey, async (req, res) => {
  const apptId = Number(req.params.id);

  if (!apptId) {
    return res.status(400).json({ error: "Invalid appointment ID" });
  }

  try {
    const [[appt]] = await req.db.query(
      `SELECT 
        appts.*,
        contacts.contact_name,
        contacts.contact_fname,
        contacts.contact_lname,
        contacts.contact_phone,
        contacts.contact_email,
        cases.case_number,
        cases.case_number_full,
        cases.case_type,
        DATE_FORMAT(appts.appt_date, '%Y-%m-%dT%H:%i') AS appt_datetime_local,
        DATE_FORMAT(appts.appt_date, '%b. %e, %Y') AS appt_date_pretty,
        DATE_FORMAT(appts.appt_date, '%l:%i %p') AS appt_time_pretty
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       LEFT JOIN cases ON cases.case_id = appts.appt_case_id
       WHERE appt_id = ?
       LIMIT 1`,
      [apptId]
    );

    if (!appt) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    res.json({ data: appt });

  } catch (err) {
    console.error("GET /api/appts/:id error:", err);
    res.status(500).json({ error: "Failed to fetch appointment" });
  }
});

module.exports = router;