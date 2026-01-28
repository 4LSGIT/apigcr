// routes/renaReminder.js



const express = require("express");
const router = express.Router();


const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const queryToken = req.query.token;

  let token = null;

  if (authHeader) {
    token = authHeader.replace(/^Bearer\s+/i, "").trim();
  } else if (queryToken) {
    token = queryToken.trim();
  }

  if (!token || token !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};


/**
 * GET /renaReminder
 * Returns HTML <tr>...</tr> rows for reminder email
 */
router.get("/renaReminder", authenticateToken, async (req, res) => {
  try {
    const sql = `
      SELECT
        COALESCE(
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'appt_id', t.appt_id,
              'appt_type', t.appt_type,
              'appt_date', t.appt_date_fmt,
              'sort_date', t.appt_date_raw,
              'client_id', t.appt_client_id,
              'client_name', t.contact_name,
              'case_id', t.appt_case_id,
              'case_number', t.case_number
            )
          ),
          JSON_ARRAY()
        ) AS appointments
      FROM (
        SELECT
          appts.appt_id,
          appts.appt_type,
          appts.appt_date AS appt_date_raw,
          DATE_FORMAT(
            appts.appt_date,
            '%W %e, %Y at %l:%i %p'
          ) AS appt_date_fmt,
          appts.appt_client_id,
          contacts.contact_name,
          appts.appt_case_id,
          COALESCE(
            cases.case_number_full,
            cases.case_number,
            appts.appt_case_id
          ) AS case_number
        FROM appts
        LEFT JOIN contacts
          ON contacts.contact_id = appts.appt_client_id
        LEFT JOIN cases
          ON cases.case_id = appts.appt_case_id
        WHERE appts.appt_status = 'scheduled'
          AND DATE(appts.appt_date) = CURDATE()
      ) AS t;
    `;

    const [rows] = await req.db.query(sql);
    const appointments = rows[0]?.appointments || [];

    // Defensive parse (mysql2 may already return JSON)
    const appts =
      typeof appointments === "string"
        ? JSON.parse(appointments)
        : appointments;

    // ✅ Correct chronological sort
    appts.sort(
      (a, b) => new Date(a.sort_date) - new Date(b.sort_date)
    );

    // ✅ Build email-safe HTML rows
    let html;

    if (!appts.length) {
      html = `
        <tr>
          <td colspan="5" style="text-align:center; padding:12px;">
            No appointments scheduled
          </td>
        </tr>
      `;
    } else {
      html = appts
        .map(appt => {
          const caseCell = appt.case_id
            ? `<a href='https://app.4lsg.com/?case=${appt.case_id}'>
                 ${appt.case_number}
               </a>`
            : "no case";

          return `
            <tr>
              <td>${appt.appt_id}</td>
              <td>${appt.appt_type}</td>
              <td>${appt.appt_date}</td>
              <td>
                <a href='https://app.4lsg.com/?contact=${appt.client_id}'>
                  ${appt.client_name}
                </a>
              </td>
              <td>${caseCell}</td>
            </tr>
          `;
        })
        .join("");
    }

    res
      .status(200)
      /*.type("text/html")*/
      .json({
        html: html.trim()
      });

  } catch (err) {
    console.error("renaReminder error:", err);
    res.status(500).send("Error generating reminder table");
  }
});

module.exports = router;
