const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

/**
 * Generate random 8-char alphanumeric string
 */
function generateCaseId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

router.post("/create-case", async (req, res) => {
  const {
    contact_id,
    case_type,
    username,
    password,
    on_duplicate = "duplicate"
  } = req.body;

  if (!contact_id || !case_type || !username || !password) {
    return res.json({
      status: "error",
      message: "missing required fields"
    });
  }

  const db = req.db;

  try {
    /* ---------------- AUTH ---------------- */
    const authSql = `
      SELECT user_auth
      FROM users
      WHERE username = '${username}'
        AND password = '${password}'
        AND user_auth LIKE 'authorized%'
      LIMIT 1
    `;

    const [authRows] = await db.promise().query(authSql);

    if (!authRows.length) {
      return res.json({
        status: "error",
        message: "authentication failed"
      });
    }

    /* --------- CHECK FOR EXISTING CASE --------- */
    const findCaseSql = `
      SELECT cases.case_id
      FROM cases
      LEFT JOIN case_relate cr
        ON cases.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = '${contact_id}'
        AND cr.case_relate_type = 'Primary'
        AND cases.case_stage IN ('Lead','Open','Pending','Filed')
        AND (
          cases.case_type = '${case_type}'
          OR cases.case_type LIKE '${case_type} - ch%'
        )
      ORDER BY cases.case_open_date DESC
      LIMIT 1
    `;

    const [existing] = await db.promise().query(findCaseSql);

    if (existing.length && on_duplicate !== "duplicate") {
      return res.json({
        status: "success",
        message: "case found",
        id: existing[0].case_id
      });
    }

    /* --------- CREATE NEW CASE --------- */
    const conn = await db.promise().getConnection();

    let case_id;
    let inserted = false;

    try {
      await conn.beginTransaction();

      // retry loop for unique case_id
      while (!inserted) {
        case_id = generateCaseId();

        try {
          const insertCaseSql = `
            INSERT INTO cases
            SET
              case_id = '${case_id}',
              case_open_date = CONVERT_TZ(NOW(),'UTC','America/New_York'),
              case_type = '${case_type}'
          `;
          await conn.query(insertCaseSql);
          inserted = true;
        } catch (err) {
          if (err.code !== "ER_DUP_ENTRY") {
            throw err;
          }
        }
      }

      const insertRelateSql = `
        INSERT INTO case_relate
        SET
          case_relate_case_id = '${case_id}',
          case_relate_client_id = '${contact_id}',
          case_relate_type = 'Primary'
      `;
      await conn.query(insertRelateSql);

      const logData = JSON.stringify({
        data: "New case created",
        type: case_type
      });

      const insertLogSql = `
        INSERT INTO log
        SET
          log_date = CONVERT_TZ(NOW(),'UTC','America/New_York'),
          log_link = '${case_id}',
          log_by = 0,
          log_data = '${logData}'
      `;
      await conn.query(insertLogSql);

      await conn.commit();
      conn.release();

      /* --------- RESPOND FIRST --------- */
      res.json({
        status: "success",
        message: "case created",
        id: case_id
      });

      /* --------- FIRE WEBHOOK AFTER RESPONSE --------- */
      try {
        const webhookUrl = "https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjUwNTZhMDYzNTA0MzU1MjY1NTUzNjUxMzUi_pc";

        if (webhookUrl) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username,
              password,
              "mode":"newCaseDropbox",
              contact_id,
              case_id
            })
          });
        }
      } catch (e) {
        // intentionally ignored; case already created
        console.error("Dropbox webhook failed:", e.message);
      }

    } catch (err) {
      await conn.rollback();
      conn.release();
      throw err;
    }

  } catch (err) {
    console.error(err);
    res.json({
      status: "error",
      message: "server error"
    });
  }
});

module.exports = router;
