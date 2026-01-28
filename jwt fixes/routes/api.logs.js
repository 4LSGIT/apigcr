const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");


// GET /api/logs
router.get("/api/logs", jwtOrApiKey, async (req, res) => {
  const db = req.db;

  const {
    query = "",
    type = "All",
    time = "All",
    date1 = null,
    date2 = null,
    offset = 0,
    limit = 100
  } = req.query;

  try {
    const where = [];
    const params = [];

    /* -----------------------------
       TYPE FILTER
    ----------------------------- */
    if (type !== "All") {
      if (type === "Communication") {
        where.push(`log.log_type IN ('sms','email','call')`);
      } else {
        where.push(`log.log_type = ?`);
        params.push(type);
      }
    }

    /* -----------------------------
       TIME FILTER
    ----------------------------- */
    if (time !== "All" && date1) {
      if (time === "Before") {
        where.push(`DATE(log.log_date) < ?`);
        params.push(date1);
      } else if (time === "On") {
        where.push(`DATE(log.log_date) = ?`);
        params.push(date1);
      } else if (time === "After") {
        where.push(`DATE(log.log_date) > ?`);
        params.push(date1);
      } else if (time === "Between" && date2) {
        where.push(`DATE(log.log_date) BETWEEN ? AND ?`);
        params.push(date1, date2);
      }
    }

    /* -----------------------------
       SEARCH FILTER
    ----------------------------- */
    if (query) {
      const q = `%${query}%`;
      where.push(`
        (
          log.log_data LIKE ?
          OR log.log_from LIKE ?
          OR log.log_to LIKE ?
          OR log.log_subject LIKE ?
          OR log.log_form_id LIKE ?
          OR log.log_link LIKE ?
        )
      `);
      params.push(q, q, q, q, q, q);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    /* -----------------------------
       MAIN QUERY
    ----------------------------- */
    const [rows] = await db.query(
      `
      SELECT
        log.*,
        DATE_FORMAT(log.log_date, '%M %e, %Y at %h:%i %p') AS formatted_date,

        contacts.contact_id,
        contacts.contact_name,

        cases.case_id,
        COALESCE(cases.case_number_full, cases.case_number) AS case_number,
        cases.case_type

      FROM log
      LEFT JOIN contacts
        ON log.log_link = contacts.contact_id
      LEFT JOIN cases
        ON (
          log.log_link = cases.case_id
          OR log.log_link = cases.case_number
          OR log.log_link = cases.case_number_full
        )
        AND log.log_link != ''

      ${whereSQL}
      ORDER BY log.log_date DESC, log.log_id DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, Number(limit), Number(offset)]
    );

    /* -----------------------------
       COUNT QUERY
    ----------------------------- */
    const [[{ total }]] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM log
      ${whereSQL}
      `,
      params
    );

    res.json({ data: rows, total });

  } catch (err) {
    console.error("GET /api/logs error:", err);
    res.status(500).json({
      status: "error",
      message: "Failed to load logs"
    });
  }
});

module.exports = router;
