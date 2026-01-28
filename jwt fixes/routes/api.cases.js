const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

router.get("/api/cases", jwtOrApiKey, async (req, res) => {
  try {
    const {
      query = "",
      type = "%",
      stage = "%",
      status = "%",
      order = "c.case_id",
      order2 = "ASC",
      offset = 0,
      limit = 100
    } = req.query;

    // ---- ORDER BY whitelist ----
    const allowedOrder = {
      "c.case_id": "c.case_id",
      "co.contact_lname": "co.contact_lname",
      "co.contact_name": "co.contact_name",
      "c.case_number": "c.case_number",
      "c.case_open_date": "c.case_open_date",
      "c.case_file_date": "c.case_file_date",
      "c.case_close_date": "c.case_close_date",
      "c.case_type": "c.case_type",
      "c.case_stage": "c.case_stage",
      "c.case_status": "c.case_status"
    };

    const orderBy = allowedOrder[order] || "c.case_id";
    const dir = order2 === "DESC" ? "DESC" : "ASC";

    const likeQuery = `%${query}%`;
    const likeStatus = status || "%";

    const [rows] = await req.db.query(
      `
      SELECT
        c.case_id,
        COALESCE(c.case_number_full, c.case_number, '') AS case_number,
        c.case_type,
        c.case_stage,
        c.case_status,
        JSON_ARRAYAGG(
          JSON_OBJECT(
            'contact_name', co.contact_name,
            'contact_id', co.contact_id,
            'contact_relate', cr.case_relate_type
          )
        ) AS contacts,
        IFNULL(DATE_FORMAT(c.case_open_date, '%M %e, %Y'), '') AS open,
        IFNULL(DATE_FORMAT(c.case_file_date, '%M %e, %Y'), '') AS file,
        IFNULL(DATE_FORMAT(c.case_close_date, '%M %e, %Y'), '') AS close
      FROM cases c
      LEFT JOIN case_relate cr ON c.case_id = cr.case_relate_case_id
      LEFT JOIN contacts co ON cr.case_relate_client_id = co.contact_id
      WHERE (
        co.contact_id LIKE ?
        OR co.contact_name LIKE ?
        OR c.case_id LIKE ?
        OR c.case_number LIKE ?
        OR c.case_number_full LIKE ?
        OR c.case_notes LIKE ?
      )
      AND c.case_type LIKE ?
      AND c.case_stage LIKE ?
      AND c.case_status LIKE ?
      GROUP BY c.case_id
      ORDER BY ${orderBy} ${dir}
      LIMIT ? OFFSET ?
      `,
      [
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        type,
        stage,
        likeStatus,
        Number(limit),
        Number(offset)
      ]
    );

    const [[count]] = await req.db.query(
      `
      SELECT COUNT(DISTINCT c.case_id) AS counter
      FROM cases c
      LEFT JOIN case_relate cr ON c.case_id = cr.case_relate_case_id
      LEFT JOIN contacts co ON cr.case_relate_client_id = co.contact_id
      WHERE (
        co.contact_id LIKE ?
        OR co.contact_name LIKE ?
        OR c.case_id LIKE ?
        OR c.case_number LIKE ?
        OR c.case_number_full LIKE ?
        OR c.case_notes LIKE ?
      )
      AND c.case_type LIKE ?
      AND c.case_stage LIKE ?
      AND c.case_status LIKE ?
      `,
      [
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        type,
        stage,
        likeStatus
      ]
    );

    res.json({
      cases: rows,
      counter: count.counter
    });
  } catch (err) {
    console.error("API cases error:", err);
    res.status(500).json({ error: "Failed to load cases" });
  }
});

module.exports = router;
