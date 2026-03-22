const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

/*
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
*/

router.get("/api/cases/:caseId", async (req, res) => {
  const { caseId } = req.params;
  const db = req.db;

  try {
    const q1 = `
      SELECT *
      FROM cases
      WHERE case_id = ?
      LIMIT 1
    `;

    const q2 = `
      SELECT *,
        IFNULL(DATE_FORMAT(contact_dob, '%b. %e, %Y'), '') AS dob
      FROM contacts
      LEFT JOIN case_relate
        ON contact_id = case_relate.case_relate_client_id
      WHERE case_relate.case_relate_case_id = ?
    `;

    const q3 = `
      SELECT
        appts.*,
        DATE_FORMAT(appt_date, '%b. %e, %Y') AS date,
        DATE_FORMAT(appt_date, '%l:%i %p') AS time,
        contacts.contact_name,
        contacts.contact_id
      FROM appts
      LEFT JOIN contacts
        ON appts.appt_client_id = contacts.contact_id
      LEFT JOIN cases
        ON appts.appt_case_id = cases.case_id
        OR appts.appt_case_id = cases.case_number
        OR appts.appt_case_id = cases.case_number_full
      WHERE appt_case_id = ?
      ORDER BY appts.appt_date DESC
    `;

    const [[caseRow]] = await db.query(q1, [caseId]);
    if (!caseRow) {
      return res.status(404).json({ error: "Case not found" });
    }

    const [clients] = await db.query(q2, [caseId]);
    const [appts]   = await db.query(q3, [caseId]);

    res.json({
      case: caseRow,
      clients,
      appts
    });
  } catch (err) {
    console.error("GET /api/cases/:caseId", err);
    res.status(500).json({ error: "Failed to load case" });
  }
});


/*
GET /api/cases/:caseId/tasks
Query params:
  q
  status
  by
  to
  offset
  limit
*/
router.get("/api/cases/:caseId/tasks", jwtOrApiKey, async (req, res) => {
  const { caseId } = req.params;
  const {
    q = "",
    status = "Incomplete",
    by = null,
    to = null,
    offset = 0,
    limit = 100
  } = req.query;

  try {
    const where = [];
    const params = [];

    // ---- Case linkage (case + its clients)
    where.push(`
      (
        t.task_link = ?
        OR t.task_link IN (
          SELECT case_relate_client_id
          FROM case_relate
          WHERE case_relate_case_id = ?
        )
      )
    `);
    params.push(caseId, caseId);

    // ---- Text search
    if (q) {
      where.push("(t.task_title LIKE ? OR t.task_desc LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }

    // ---- Assigned by
    if (by) {
      where.push("t.task_from = ?");
      params.push(by);
    }

    // ---- Assigned to
    if (to) {
      where.push("t.task_to = ?");
      params.push(to);
    }

    // ---- Status logic
    if (status === "Incomplete") {
      where.push(`t.task_status IN ("Pending","Due Today","Overdue")`);
    } else {
      where.push("t.task_status = ?");
      params.push(status);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // ---- Main query
    const dataSql = `
      SELECT
        t.*,
        u.user_name  AS task_from_name,
        u2.user_name AS task_to_name,
        co.contact_name,
        DATE_FORMAT(t.task_due, '%b. %e, %Y') AS due,
        DATE_FORMAT(t.task_date, '%b. %e, %Y at %l:%i %p') AS date
      FROM tasks t
      LEFT JOIN users u  ON t.task_from = u.user
      LEFT JOIN users u2 ON t.task_to   = u2.user
      LEFT JOIN contacts co ON t.task_link = co.contact_id
      ${whereSql}
      ORDER BY t.task_due ASC
      LIMIT ? OFFSET ?
    `;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM tasks t
      ${whereSql}
    `;

    const [[countRow]] = await req.db.query(countSql, params);
    const [rows] = await req.db.query(dataSql, [...params, Number(limit), Number(offset)]);

    res.json({
      message: "tasks retrieved",
      results: countRow.total,
      data: rows
    });

  } catch (err) {
    console.error("Case tasks error:", err);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

module.exports = router;
