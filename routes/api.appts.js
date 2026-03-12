/**
 * Appointments API
 * ----------------------------------------
 * GET  /api/appts              list with filters
 * GET  /api/appts/:id          single appointment (tested, working)
 * POST /api/appts/:id/attended mark attended
 * POST /api/appts/:id/no-show  mark no show + optional sequence enroll
 * POST /api/appts/cancel       cancel + optional task, SMS/email confirm, gcal delete
 *
 * Pending:
 * POST /api/appts              create
 * POST /api/appts/reschedule   reschedule
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const smsService = require("../services/smsService");
const emailService = require("../services/emailService");
const pabbly = require("../services/pabblyService");

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

async function getSetting(db, key) {
  const [[row]] = await db.query(
    "SELECT value FROM app_settings WHERE `key` = ? LIMIT 1",
    [key]
  );
  return row?.value || null;
}

// Insert a log entry tied to an appointment row.
// Reads appt_case_id/appt_client_id from the appts table to set log_link correctly.
async function logApptEvent(db, apptId, actingUserId, extraFields = {}) {
  const fields = Object.entries(extraFields)
    .map(([k, v]) => `'\"${k}\":\"', REPLACE(IFNULL('${String(v).replace(/'/g, "''")}',''), '"', '\\\\"'), '\"'`)
    .join(", ',', ");

  // Build log_data as JSON string in SQL, safely escaping appt_type
  await db.query(
    `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
     SELECT
       'appt',
       CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'),
       CASE WHEN appt_case_id IS NOT NULL AND appt_case_id != ''
            THEN appt_case_id
            ELSE appt_client_id
       END,
       ?,
       CONCAT(
         '{',
           '"Appt ID":"', appt_id, '",',
           '"Appt Type":"', REPLACE(IFNULL(appt_type,''), '"', '\\\\"'), '",',
           '"Appt Time":"', appt_date, '",',
           ?
         '}'
       )
     FROM appts
     WHERE appt_id = ?`,
    [actingUserId, extraFields._logExtra || "", apptId]
  );
}

// Simpler log helper — builds the extra JSON fields as a JS string, passes as param
async function insertApptLog(db, apptId, actingUserId, extraJson) {
  await db.query(
    `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
     SELECT
       'appt',
       CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'),
       CASE WHEN appt_case_id IS NOT NULL AND appt_case_id != ''
            THEN appt_case_id
            ELSE appt_client_id
       END,
       ?,
       CONCAT(
         '{',
           '"Appt ID":"', appt_id, '",',
           '"Appt Type":"', REPLACE(IFNULL(appt_type,''), '"', '\\\\"'), '",',
           '"Appt Time":"', appt_date, '",',
           ?
         '}'
       )
     FROM appts
     WHERE appt_id = ?`,
    [actingUserId, extraJson, apptId]
  );
}

// ─────────────────────────────────────────
// GET /api/appts  — list with filters
// ─────────────────────────────────────────
router.get("/api/appts", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    contact_id,
    case_id,
    status,
    from,
    to,
    limit = 50,
    offset = 0
  } = req.query;

  const conditions = [];
  const params = [];

  if (contact_id) { conditions.push("appts.appt_client_id = ?"); params.push(contact_id); }
  if (case_id)    { conditions.push("appts.appt_case_id = ?");   params.push(case_id); }
  if (status)     { conditions.push("appts.appt_status = ?");    params.push(status); }
  if (from)       { conditions.push("appts.appt_date >= ?");     params.push(from); }
  if (to)         { conditions.push("appts.appt_date <= ?");     params.push(to); }

  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const [rows] = await db.query(
      `SELECT
         appts.appt_id        AS id,
         appts.appt_client_id,
         appts.appt_case_id,
         appts.appt_type,
         appts.appt_length,
         appts.appt_platform,
         appts.appt_status    AS status,
         appts.appt_date,
         appts.appt_end,
         appts.appt_with,
         appts.appt_note,
         appts.appt_gcal,
         DATE_FORMAT(appts.appt_date, '%b. %e, %Y') AS format_date,
         DATE_FORMAT(appts.appt_date, '%h:%i %p')   AS time,
         contacts.contact_name,
         contacts.contact_id,
         users.user_name
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       LEFT JOIN users    ON users.user = appts.appt_with
       LEFT JOIN cases    ON appts.appt_case_id = cases.case_id
       ${whereSql}
       ORDER BY appts.appt_date DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [[{ counter }]] = await db.query(
      `SELECT COUNT(*) AS counter
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       LEFT JOIN cases    ON appts.appt_case_id = cases.case_id
       ${whereSql}`,
      params
    );

    res.json({ appts: rows, counter: counter || 0 });

  } catch (err) {
    console.error("GET /api/appts error:", err);
    res.status(500).json({ status: "error", message: "Failed to fetch appointments" });
  }
});

// ─────────────────────────────────────────
// GET /api/appts/:id  — single appointment
// ─────────────────────────────────────────
router.get("/api/appts/:id", jwtOrApiKey, async (req, res) => {
  const apptId = parseInt(req.params.id);
  if (!apptId) return res.status(400).json({ status: "error", message: "Invalid appointment ID" });

  try {
    const [[appt]] = await req.db.query(
      `SELECT
         appts.*,
         contacts.contact_name,
         contacts.contact_fname,
         contacts.contact_lname,
         contacts.contact_phone,
         contacts.contact_email,
         cases.case_id,
         cases.case_type,
         cases.case_status,
         cases.case_stage,
         DATE_FORMAT(appts.appt_date, '%Y-%m-%dT%H:%i') AS appt_date_local,
         DATE_FORMAT(appts.appt_end,  '%Y-%m-%dT%H:%i') AS appt_end_local
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       LEFT JOIN cases    ON appts.appt_case_id   = cases.case_id
       WHERE appts.appt_id = ?`,
      [apptId]
    );

    if (!appt) return res.status(404).json({ status: "error", message: "Appointment not found" });
    res.json({ data: appt });

  } catch (err) {
    console.error("GET /api/appts/:id error:", err);
    res.status(500).json({ status: "error", message: "Failed to fetch appointment" });
  }
});

// ─────────────────────────────────────────
// POST /api/appts/:id/attended
// ─────────────────────────────────────────
router.post("/api/appts/:id/attended", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const apptId = parseInt(req.params.id);
  const note = (req.body.note || "").trim();
  const actingUserId = req.auth?.userId || 99;

  if (!apptId) return res.status(400).json({ status: "error", title: "Error", message: "Invalid appointment ID" });

  try {
    const [[appt]] = await db.query(
      "SELECT appt_id FROM appts WHERE appt_id = ?",
      [apptId]
    );
    if (!appt) return res.status(404).json({ status: "error", title: "Not found", message: "Appointment not found" });

    await db.query(
      `UPDATE appts
       SET appt_status = 'Attended',
           appt_note   = CONCAT(IFNULL(appt_note,''), ?)
       WHERE appt_id = ?`,
      [note ? ` ${note}` : "", apptId]
    );

    await insertApptLog(db, apptId, actingUserId,
      `"Status":"Attended"${note ? `,"Note":"${note.replace(/"/g, '\\"')}"` : ""}`
    );

    res.json({ status: "success", title: "Success!", message: "Appointment marked Attended!" });

  } catch (err) {
    console.error("POST /attended error:", err);
    res.status(500).json({ status: "error", title: "Error", message: "Failed to mark appointment as attended" });
  }
});

// ─────────────────────────────────────────
// POST /api/appts/:id/no-show
// Body: { note, enroll }
// enroll: true = enroll in no-show sequence (only if first no-show for this contact)
// ─────────────────────────────────────────
router.post("/api/appts/:id/no-show", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const apptId = parseInt(req.params.id);
  const note   = (req.body.note || "").trim();
  const enroll = req.body.enroll === true;
  const actingUserId = req.auth?.userId || 99;

  if (!apptId) return res.status(400).json({ status: "error", title: "Error", message: "Invalid appointment ID" });

  try {
    const [[appt]] = await db.query(
      "SELECT appt_id, appt_client_id, appt_case_id FROM appts WHERE appt_id = ?",
      [apptId]
    );
    if (!appt) return res.status(404).json({ status: "error", title: "Not found", message: "Appointment not found" });

    await db.query(
      `UPDATE appts
       SET appt_status = 'No Show',
           appt_note   = CONCAT(IFNULL(appt_note,''), ?)
       WHERE appt_id = ?`,
      [note ? ` ${note}` : "", apptId]
    );

    // Check if contact already has a previous no-show (don't double-enroll)
    let enrolled = false;
    if (enroll) {
      const [[{ priorCount }]] = await db.query(
        `SELECT COUNT(*) AS priorCount
         FROM appts
         WHERE appt_client_id = ?
           AND appt_status    = 'No Show'
           AND appt_id       != ?`,
        [appt.appt_client_id, apptId]
      );

      if (priorCount === 0) {
        // First no-show — enroll in sequence
        pabbly.send(db, "sequence_enroll", {
          contact_id:    appt.appt_client_id,
          sequence_type: "no_show",
          appt_id:       apptId,
          case_id:       appt.appt_case_id
        });
        enrolled = true;
      }
    }

    await insertApptLog(db, apptId, actingUserId,
      `"Status":"No Show","Enrolled":"${enrolled}"`
    );

    const message = enroll && !enrolled
      ? 'Marked No Show — sequence not triggered (contact has prior no-shows)'
      : `Marked No Show${enrolled ? " and enrolled in sequence" : ""}`;

    res.json({ status: "success", title: "Success!", message });

  } catch (err) {
    console.error("POST /no-show error:", err);
    res.status(500).json({ status: "error", title: "Error", message: "Failed to mark appointment as No Show" });
  }
});

// ─────────────────────────────────────────
// POST /api/appts/cancel
// Body: {
//   appt,               int     — appointment ID
//   note,               string  — internal note
//   sms,                bool    — send confirmation SMS to client
//   email,              bool    — send confirmation email to client
//   confirm_message,    string  — message text if sms or email
//   cancel_gcal,        bool    — delete google calendar event
//   create_task,        bool    — create follow-up task
//   enroll_sequence,    bool    — enroll in cancel sequence
// }
// ─────────────────────────────────────────
router.post("/api/appts/cancel", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    appt:         apptId,
    note          = "",
    sms           = false,
    email         = false,
    confirm_message = "",
    cancel_gcal   = false,
    create_task   = false,
    enroll_sequence = false
  } = req.body;

  if (!apptId) return res.status(400).json({ status: "error", title: "Error", message: "Missing appointment ID" });
  if ((sms || email) && !confirm_message.trim()) {
    return res.status(400).json({ status: "error", title: "Error", message: "Confirmation message required when sending SMS or email" });
  }

  const actingUserId = req.auth?.userId || 99;

  try {
    // 1) Fetch full appt + contact for downstream use
    const [[appt]] = await db.query(
      `SELECT appts.*, contacts.contact_phone, contacts.contact_email AS client_email
       FROM appts
       LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
       WHERE appts.appt_id = ?`,
      [apptId]
    );
    if (!appt) return res.status(404).json({ status: "error", title: "Not found", message: "Appointment not found" });

    // 2) Update status
    await db.query(
      `UPDATE appts
       SET appt_status = 'Canceled',
           appt_note   = CONCAT(IFNULL(appt_note,''), ?)
       WHERE appt_id = ?`,
      [note ? ` ${note}` : "", apptId]
    );

    // 3) Optional: create follow-up task
    let taskId = null;
    if (create_task) {
      const [taskResult] = await db.query(
        `INSERT INTO tasks
           (task_status, task_from, task_to, task_link, task_title, task_last_update)
         VALUES (
           'Pending', ?, ?,
           (SELECT contact_id FROM contacts
            LEFT JOIN appts ON contact_id = appts.appt_client_id
            WHERE appts.appt_id = ? LIMIT 1),
           'Appointment Cancellation Follow-up',
           NOW()
         )`,
        [actingUserId, actingUserId, apptId]
      );
      taskId = taskResult.insertId;
    }

    // 4) Log entry
    await insertApptLog(db, apptId, actingUserId,
      `"Status":"Canceled"` +
      (taskId  ? `,"Task":"${taskId}"` : "") +
      (note    ? `,"Note":"${note.replace(/"/g, '\\"')}"` : "")
    );

    // 5) Non-blocking external actions — respond to client first
    res.json({
      status:  "success",
      title:   "Appointment Canceled",
      message: taskId ? `Canceled — follow-up task #${taskId} created` : "Canceled"
    });

    // 6) SMS confirmation
    if (sms && appt.contact_phone) {
      const fromNumber = await getSetting(db, "sms_default_from");
      if (fromNumber) {
        smsService.sendSms(db, fromNumber, appt.contact_phone, confirm_message)
          .catch(err => console.error("Cancel SMS failed:", err.message));
      } else {
        console.error("Cancel SMS skipped: sms_default_from not set in app_settings");
      }
    }

    // 7) Email confirmation
    if (email && appt.client_email) {
      const fromEmail = await getSetting(db, "email_default_from");
      if (fromEmail) {
        emailService.sendEmail(db, {
          from:    fromEmail,
          to:      appt.client_email,
          subject: "Appointment Cancellation Confirmation",
          text:    confirm_message
        }).catch(err => console.error("Cancel email failed:", err.message));
      } else {
        console.error("Cancel email skipped: email_default_from not set in app_settings");
      }
    }

    // 8) GCal delete
    if (cancel_gcal && appt.appt_gcal) {
      pabbly.send(db, "gcal_delete", { appt_gcal: appt.appt_gcal, appt_id: apptId });
    }

    // 9) Sequence enroll
    if (enroll_sequence) {
      pabbly.send(db, "sequence_enroll", {
        contact_id:    appt.appt_client_id,
        sequence_type: "cancel",
        appt_id:       apptId,
        case_id:       appt.appt_case_id
      });
    }

  } catch (err) {
    console.error("POST /api/appts/cancel error:", err);
    // Only send error if we haven't already responded
    if (!res.headersSent) {
      res.status(500).json({ status: "error", title: "Error", message: "Failed to cancel appointment" });
    }
  }
});

module.exports = router;