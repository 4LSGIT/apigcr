const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

const SORT_MAP = {
  "contact_lname ASC": "c.contact_lname ASC",
  "contact_lname DESC": "c.contact_lname DESC",
  "contact_fname ASC": "c.contact_fname ASC",
  "contact_fname DESC": "c.contact_fname DESC",
};

router.get("/api/contacts", jwtOrApiKey, async (req, res) => {
  const db = req.db;

  const {
    query = "",
    offset = 0,
    limit = 100,
  } = req.query;

  const sortSql = SORT_MAP[req.query.sort] || SORT_MAP["contact_lname ASC"];

  try {
    const [rows] = await db.query(
      `
      SELECT c.contact_id, c.contact_name, c.contact_phone, c.contact_email, 
             c.contact_address, c.contact_city, c.contact_state, c.contact_zip,
             IFNULL(DATE_FORMAT(c.contact_dob, '%M %e, %Y'), '') as DoB,
             JSON_ARRAYAGG(JSON_OBJECT(
               'case_number', COALESCE(ca.case_number_full, ca.case_number, ca.case_id),
               'case_id', ca.case_id,
               'case_type', ca.case_type
             )) as cases
      FROM contacts c
      LEFT JOIN case_relate cr ON c.contact_id = cr.case_relate_client_id
      LEFT JOIN cases ca ON cr.case_relate_case_id = ca.case_id
      WHERE c.contact_id LIKE ?
         OR c.contact_name LIKE ?
         OR c.contact_phone LIKE ?
         OR c.contact_email LIKE ?
         OR c.contact_dob LIKE ?
         OR c.contact_ssn LIKE ?
      GROUP BY c.contact_id
      ORDER BY ${sortSql}
      LIMIT ? OFFSET ?
      `,
      Array(6).fill(`%${query}%`).concat([Number(limit), Number(offset)])
    );

    const [[{ counter }]] = await db.query(
      `
      SELECT COUNT(*) AS counter
      FROM (
        SELECT c.contact_id
        FROM contacts c
        LEFT JOIN case_relate cr ON c.contact_id = cr.case_relate_client_id
        LEFT JOIN cases ca ON cr.case_relate_case_id = ca.case_id
        WHERE c.contact_id LIKE ?
           OR c.contact_name LIKE ?
           OR c.contact_phone LIKE ?
           OR c.contact_email LIKE ?
           OR c.contact_dob LIKE ?
           OR c.contact_ssn LIKE ?
        GROUP BY c.contact_id
      ) AS sub
      `,
      Array(6).fill(`%${query}%`)
    );

    res.json({
      contacts: rows,
      counter: counter || 0,
    });
  } catch (err) {
    console.error("Contacts API error:", err);
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});


router.get("/api/contacts/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const contactId = Number(req.params.id);

  if (!Number.isInteger(contactId)) {
    return res.status(400).json({ error: "Invalid contact id" });
  }

  try {
    const [rows] = await db.query(
      `
      SELECT 
        c.contact_id,
        c.contact_fname,
        c.contact_mname,
        c.contact_lname,
        c.contact_name,
        c.contact_phone,
        c.contact_phone2,
        c.contact_email,
        c.contact_email2,
        c.contact_dob,
        c.contact_address,
        c.contact_city,
        c.contact_state,
        c.contact_zip,
        c.contact_notes,
        c.contact_tags,
        c.contact_created,
        c.contact_updated,
        JSON_ARRAYAGG(
          IF(ca.case_id IS NULL, NULL,
            JSON_OBJECT(
              'case_id', ca.case_id,
              'case_number', COALESCE(ca.case_number_full, ca.case_number),
              'case_type', ca.case_type
            )
          )
        ) AS cases
      FROM contacts c
      LEFT JOIN case_relate cr 
        ON c.contact_id = cr.case_relate_client_id
      LEFT JOIN cases ca 
        ON cr.case_relate_case_id = ca.case_id
      WHERE c.contact_id = ?
      GROUP BY c.contact_id
      `,
      [contactId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Contact not found" });
    }

    const c = rows[0];

    res.json({
      id: c.contact_id,
      first_name: c.contact_fname || "",
      middle_name: c.contact_mname || "",
      last_name: c.contact_lname || "",
      preferred_name: c.contact_name || "",
      name: c.contact_name || `${c.contact_fname} ${c.contact_lname}`.trim(),
      phone: c.contact_phone || null,
      phone_secondary: c.contact_phone2 || null,
      email: c.contact_email || null,
      email_secondary: c.contact_email2 || null,
      dob: c.contact_dob
        ? new Date(c.contact_dob).toISOString().split("T")[0]
        : null,
      address: {
        line1: c.contact_address || null,
        city: c.contact_city || null,
        state: c.contact_state || null,
        zip: c.contact_zip || null,
      },
      notes: c.contact_notes || null,
      tags: c.contact_tags || null,
      created_at: c.contact_created,
      updated_at: c.contact_updated,
      cases: (c.cases || []).filter(Boolean),
    });
  } catch (err) {
    console.error("Contact by ID API error:", err);
    res.status(500).json({ error: "Failed to fetch contact" });
  }
});

/*
router.get("/api/contacts/:id/logs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const contactId = Number(req.params.id);

  if (!Number.isInteger(contactId)) {
    return res.status(400).json({ error: "Invalid contact id" });
  }

  const {
    query = "",
    type = "All",
    time = "All",
    date1,
    date2,
    offset = 0,
    limit = 100
  } = req.query;

  try {
    const where = [];
    const params = [];

    // ------------------------------------------------------------------
    // Scope: logs linked directly to contact OR to cases related to contact
    // ------------------------------------------------------------------
    where.push(`
      (
        log.log_link = ?
        OR log.log_link IN (
          SELECT cr.case_relate_case_id
          FROM case_relate cr
          WHERE cr.case_relate_client_id = ?
        )
      )
    `);
    params.push(contactId, contactId);

    // -----------------
    // Type filter
    // -----------------
    if (type !== "All") {
      if (type === "Communication") {
        where.push(`log.log_type IN ('sms','email','call')`);
      } else {
        where.push(`log.log_type = ?`);
        params.push(type);
      }
    }

    // -----------------
    // Time filter
    // -----------------
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

    // -----------------
    // Search filter
    // -----------------
    if (query) {
      const like = `%${query}%`;
      where.push(`
        (
          log.log_data LIKE ?
          OR log.log_from LIKE ?
          OR log.log_to LIKE ?
          OR log.log_subject LIKE ?
          OR log.log_form_id LIKE ?
          OR CAST(log.log_link AS CHAR) LIKE ?
        )
      `);
      params.push(like, like, like, like, like, like);
    }

    const whereSQL = `WHERE ${where.join(" AND ")}`;

    // -----------------
    // Data query
    // -----------------
    const logsQuery = `
      SELECT
        log.*,
        DATE_FORMAT(log.log_date, '%M %e, %Y at %h:%i %p') AS formatted_date,
        c.contact_id,
        c.contact_name,
        ca.case_id,
        ca.case_type,
        COALESCE(ca.case_number_full, ca.case_number) AS case_number
      FROM log
      LEFT JOIN contacts c
        ON log.log_link = c.contact_id
      LEFT JOIN cases ca
        ON log.log_link = ca.case_id
      ${whereSQL}
      ORDER BY log.log_date DESC, log.log_id DESC
      LIMIT ? OFFSET ?;
    `;

    // -----------------
    // Count query
    // -----------------
    const countQuery = `
      SELECT COUNT(*) AS counter
      FROM log
      ${whereSQL};
    `;

    const [logs] = await db.query(logsQuery, [
      ...params,
      Number(limit),
      Number(offset)
    ]);

    const [countRows] = await db.query(countQuery, params);

    res.json({
      logs,
      total: countRows[0]?.counter ?? 0
    });

  } catch (err) {
    console.error("Contact logs API error:", err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});
*/


router.get("/api/contacts/:id/logs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const contactId = Number(req.params.id);

  if (!Number.isInteger(contactId)) {
    return res.status(400).json({ error: "Invalid contact id" });
  }

  const {
    query = "",
    type = "All",
    time = "All",
    date1,
    date2,
    offset = 0,
    limit = 100
  } = req.query;

  try {
    const filters = [];
    const params = [];

    // -------------------------------------------------
    // CTE base scope: logs linked to contact or cases
    // -------------------------------------------------
    filters.push(`
      (
        log.log_link = ?
        OR log.log_link IN (
          SELECT cr.case_relate_case_id
          FROM case_relate cr
          WHERE cr.case_relate_client_id = ?
        )
      )
    `);
    params.push(contactId, contactId);

    // -----------------
    // Type filter
    // -----------------
    if (type !== "All") {
      if (type === "Communication") {
        filters.push(`log.log_type IN ('sms','email','call')`);
      } else {
        filters.push(`log.log_type = ?`);
        params.push(type);
      }
    }

    // -----------------
    // Time filter
    // -----------------
    if (time !== "All" && date1) {
      if (time === "Before") {
        filters.push(`DATE(log.log_date) < ?`);
        params.push(date1);
      } else if (time === "On") {
        filters.push(`DATE(log.log_date) = ?`);
        params.push(date1);
      } else if (time === "After") {
        filters.push(`DATE(log.log_date) > ?`);
        params.push(date1);
      } else if (time === "Between" && date2) {
        filters.push(`DATE(log.log_date) BETWEEN ? AND ?`);
        params.push(date1, date2);
      }
    }

    // -----------------
    // Search filter
    // -----------------
    if (query) {
      const like = `%${query}%`;
      filters.push(`
        (
          log.log_data LIKE ?
          OR log.log_from LIKE ?
          OR log.log_to LIKE ?
          OR log.log_subject LIKE ?
          OR log.log_form_id LIKE ?
          OR CAST(log.log_link AS CHAR) LIKE ?
        )
      `);
      params.push(like, like, like, like, like, like);
    }

    const whereSQL = filters.length
      ? `WHERE ${filters.join(" AND ")}`
      : "";

    // -------------------------------------------------
    // CTE-based query
    // -------------------------------------------------
    const logsQuery = `
      WITH scoped_logs AS (
        SELECT log.*
        FROM log
        ${whereSQL}
      )
      SELECT
        sl.*,
        DATE_FORMAT(sl.log_date, '%M %e, %Y at %h:%i %p') AS formatted_date,
        c.contact_id,
        c.contact_name,
        ca.case_id,
        ca.case_type,
        COALESCE(ca.case_number_full, ca.case_number) AS case_number
      FROM scoped_logs sl
      LEFT JOIN contacts c
        ON sl.log_link = c.contact_id
      LEFT JOIN cases ca
        ON sl.log_link = ca.case_id
      ORDER BY sl.log_date DESC, sl.log_id DESC
      LIMIT ? OFFSET ?;
    `;

    const countQuery = `
      WITH scoped_logs AS (
        SELECT log.log_id
        FROM log
        ${whereSQL}
      )
      SELECT COUNT(*) AS counter
      FROM scoped_logs;
    `;

    const [logs] = await db.query(logsQuery, [
      ...params,
      Number(limit),
      Number(offset)
    ]);

    const [countRows] = await db.query(countQuery, params);

    res.json({
      logs,
      total: countRows[0]?.counter ?? 0
    });

  } catch (err) {
    console.error("Contact logs API error:", err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});




// POST /api/contacts/:id/logs – add a new log for a contact
router.post("/api/contacts/:id/logs", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const contactId = Number(req.params.id);
  const { text, type = "Note", link = null } = req.body; // link can be case_id or null
  const userId = req.auth.userId;

  if (!Number.isInteger(contactId)) {
    return res.status(400).json({ error: "Invalid contact id" });
  }
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Log text cannot be empty" });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO log (log_link, log_type, log_data, log_by, log_date) VALUES (?, ?, ?, ?, NOW())`,
      [link || contactId, type, text, userId]
    );

    const [[log]] = await db.query(
      `SELECT log.*, DATE_FORMAT(log_date, '%M %e, %Y at %h:%i %p') AS formatted_date
       FROM log WHERE log_id = ?`,
      [result.insertId]
    );

    res.json({
      log,
      title: "Log Added",
      message: "Log successfully added",
      status: "success"
    });
  } catch (err) {
    console.error("Add contact log API error:", err);
    res.status(500).json({ error: "Failed to add log" });
  }
});





module.exports = router;
