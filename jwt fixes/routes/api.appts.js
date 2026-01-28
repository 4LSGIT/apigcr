const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const fetch = require("node-fetch"); // ensure fetch is imported once
const url = "https://webhookspy.com/9d1df7bd5a044364a09ed9576ede79a0"; // test url
const pabblyUrl = "https://pabbly.com/abc123"; // test pabbly url


router.get("/api/appts", jwtOrApiKey, async (req, res) => {
  const db = req.db;

  let {
    type = "Default",
    status = "Scheduled",
    time = "All",
    date1,
    date2,
    offset = 0,
    limit = 100,
  } = req.query;

  offset = Number(offset);
  limit = Number(limit);

  const where = [];
  const params = [];

  // ---- TYPE ----
  if (type !== "All") {
    if (type === "Default") {
      where.push(`appts.appt_type != ?`);
      params.push("341 Meeting");
    } else {
      where.push(`appts.appt_type = ?`);
      params.push(type);
    }
  }

  // ---- STATUS ----
  if (status !== "All") {
    where.push(`appts.appt_status = ?`);
    params.push(status);
  }

  // ---- TIME FILTER ----
  if (time !== "All" && date1) {
    if (time === "Before") {
      where.push(`DATE(appts.appt_date) < ?`);
      params.push(date1);
    } else if (time === "After") {
      where.push(`DATE(appts.appt_date) > ?`);
      params.push(date1);
    } else if (time === "On") {
      where.push(`DATE(appts.appt_date) = ?`);
      params.push(date1);
    } else if (time === "Between" && date2) {
      where.push(`DATE(appts.appt_date) > ? AND DATE(appts.appt_date) < ?`);
      params.push(date1, date2);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    // ---- MAIN QUERY ----
    const [rows] = await db.query(
      `
      SELECT 
        appts.appt_id AS id,
        contacts.contact_name AS name,
        appts.appt_client_id AS clientId,
        cases.case_number AS caseN,
        appts.appt_case_id AS leadId,
        appts.appt_type AS type,
        appts.appt_date AS date,
        DATE_FORMAT(appts.appt_date, '%b. %e, %Y') AS format_date,
        DATE_FORMAT(appts.appt_date, '%h:%i %p') AS time,
        appts.appt_status AS status,
        users.user_name AS user_name
      FROM appts
      LEFT JOIN users ON users.user = appts.appt_with
      LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
      LEFT JOIN cases ON appts.appt_case_id = cases.case_id
      ${whereSql}
      ORDER BY appts.appt_date DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    // ---- COUNTER ----
    const [[{ counter }]] = await db.query(
      `
      SELECT COUNT(*) AS counter
      FROM appts
      LEFT JOIN contacts ON appts.appt_client_id = contacts.contact_id
      LEFT JOIN cases ON appts.appt_case_id = cases.case_id
      ${whereSql}
      `,
      params
    );

    res.json({
      appts: rows,
      counter: counter || 0,
    });
  } catch (err) {
    console.error("Appts API error:", err);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});



router.post("/api/appts/:apptId/attended", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const apptId = Number(req.params.apptId);
  const note = (req.body.note || "").trim();
  const actingUserId = req.auth?.userId || 99;

  if (!apptId) {
    return res.status(400).json({
      status: "error",
      title: "Invalid request",
      message: "Invalid appointment ID",
    });
  }

  try {
    // 1️⃣ Verify appointment exists
    const [[appt]] = await db.query(
      `
      SELECT appt_id, appt_type, appt_date, appt_case_id, appt_client_id
      FROM appts
      WHERE appt_id = ?
      `,
      [apptId]
    );

    if (!appt) {
      return res.status(404).json({
        status: "error",
        title: "Not found",
        message: "Appointment not found",
      });
    }

    // 2️⃣ Update appointment
    await db.query(
      `
      UPDATE appts
      SET 
        appt_status = 'Attended',
        appt_note = CONCAT(IFNULL(appt_note,''), ?)
      WHERE appt_id = ?
      `,
      [note ? ` ${note}` : "", apptId]
    );

    // 3️⃣ Insert log entry (quotes safely escaped)
    await db.query(
      `
      INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
      SELECT
        'appt' AS log_type,
        CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT') AS log_date,
        CASE 
          WHEN appt_case_id IS NOT NULL AND appt_case_id != '' 
            THEN appt_case_id
          ELSE appt_client_id
        END AS log_link,
        ? AS log_by,
        CONCAT(
          '{',
            '\"Appt ID\":\"', appt_id, '\",',
            '\"Appt Type\":\"', REPLACE(IFNULL(appt_type,''), '\"', '\\\\\"'), '\",',
            '\"Appt Time\":\"', appt_date, '\",',
            '\"Status\":\"Attended\"',
          '}'
        ) AS log_data
      FROM appts
      WHERE appt_id = ?
      `,
      [actingUserId, apptId]
    );

    res.json({
      status: "success",
      title: "Success!",
      message: 'Appointment marked "Attended"! Enjoy the meeting',
    });
  } catch (err) {
    console.error("Attend appt error:", err);
    res.status(500).json({
      status: "error",
      title: "Error",
      message: "Failed to mark appointment as attended",
    });
  }
});




router.post("/api/appts/:apptId/no-show", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const apptId = Number(req.params.apptId);
  const note = (req.body.note || "").trim();
  const enroll = req.body.enroll === true;
  const actingUserId = req.auth?.userId || 99;

  if (!apptId) {
    return res.status(400).json({
      status: "error",
      title: "Invalid request",
      message: "Invalid appointment ID",
    });
  }

  try {
    // --- Fetch appointment ---
    const [[appt]] = await db.query(
      `
      SELECT appt_id, appt_type, appt_date, appt_case_id, appt_client_id
      FROM appts
      WHERE appt_id = ?
      `,
      [apptId]
    );

    if (!appt) {
      return res.status(404).json({
        status: "error",
        title: "Not found",
        message: "Appointment not found",
      });
    }

    // --- Update appointment ---
    await db.query(
      `
      UPDATE appts
      SET appt_status = 'No Show',
          appt_note = CONCAT(IFNULL(appt_note,''), ?)
      WHERE appt_id = ?
      `,
      [note ? ` ${note}` : "", apptId]
    );

    // --- Insert log entry ---
    await db.query(
      `
      INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
      SELECT
        'appt' AS log_type,
        CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT') AS log_date,
        CASE 
          WHEN appt_case_id IS NOT NULL AND appt_case_id != ''
            THEN appt_case_id
          ELSE appt_client_id
        END AS log_link,
        ? AS log_by,
        CONCAT(
          '{',
            '\"Appt ID\":\"', appt_id, '\",',
            '\"Appt Type\":\"', REPLACE(IFNULL(appt_type,''), '\"', '\\\\\"'), '\",',
            '\"Appt Time\":\"', appt_date, '\",',
            '\"Status\":\"NO SHOW\",',
            '\"Enrolled\":\"', ?, '\"',
          '}'
        ) AS log_data
      FROM appts
      WHERE appt_id = ?
      `,
      [actingUserId, enroll ? "true" : "false", apptId]
    );

    // --- Minimal fix starts here ---
    let hasExistingNoShow = false;

    if (enroll) {
      const [[result]] = await db.query(
        `
        SELECT CASE 
          WHEN EXISTS (
            SELECT 1 
            FROM appts a2 
            WHERE a2.appt_client_id = ? 
              AND a2.appt_status = 'No Show' 
              AND a2.appt_id != ?
          ) THEN 'has no show'
          ELSE 'no other no show'
        END AS result
        `,
        [appt.appt_client_id, apptId]
      );

      hasExistingNoShow = result.result === "has no show";

      if (!hasExistingNoShow) {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: appt.appt_client_id,
            apptId,
            action: "enrollNoShow"
          })
        }).catch(err => console.error("Webhook error:", err));
      }
    }
    // --- Minimal fix ends here ---

    res.json({
      status: "success",
      title: "Success!",
      message: hasExistingNoShow
        ? 'Appointment marked "No Show" but not enrolled due to no existing No Show!'
        : `Appointment marked "No Show"${enroll ? " and enrolled" : ""}!`,
    });

  } catch (err) {
    console.error("No Show appt error:", err);
    res.status(500).json({
      status: "error",
      title: "Error",
      message: "Failed to mark appointment as No Show",
    });
  }
});





router.post("/api/appts/cancel", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    appt,
    note = "",
    sms = false,
    email = false,
    apptCancelFollowUp = false,
    apptCancelTask = false,
  } = req.body;

  if (!appt) return res.status(400).json({ status: "error", title: "Error", message: "Missing appointment ID" });

  const actingUserId = req.auth?.userId || 5; // fallback if missing

  try {
    // ---- 1) Update appointment status ----
    await db.query(
      `UPDATE appts 
       SET appt_status = 'Canceled', 
           appt_note = CONCAT(COALESCE(appt_note,''), ' ', ?) 
       WHERE appt_id = ?`,
      [note, appt]
    );

    // ---- 2) Optionally create task ----
    let taskId = false;
    if (apptCancelTask) {
      const [taskResult] = await db.query(
        `INSERT INTO tasks 
          SET task_status = 'Pending',
              task_from = ?,
              task_to = ?,
              task_link = (SELECT contacts.contact_id 
                           FROM contacts 
                           LEFT JOIN appts ON contact_id = appts.appt_client_id 
                           WHERE appts.appt_id = ?),
              task_title = 'Appointment Cancelation Follow-up'`,
        [actingUserId, 2, appt]
      );
      taskId = taskResult.insertId;
    }

    // ---- 3) Insert log (quote-safe) ----
    await db.query(
      `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
       SELECT 'appt',
              CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'),
              CASE WHEN appt_case_id IS NOT NULL AND appt_case_id != '' THEN appt_case_id
                   ELSE appt_client_id END AS log_link,
              ? AS log_by,
              CONCAT('{',
                     '\"Appt ID\":\"', appt_id, '\",',
                     '\"Appt Type\":\"', REPLACE(IFNULL(appt_type,''), '"','\\"'), '\",',
                     '\"Appt Time\":\"', appt_date, '\",',
                     '\"Status\":\"Canceled\",',
                     '\"Task Created\":\"', REPLACE(IFNULL(?,false), '"','\\"'), '\",',
                     '\"Cancel Note\":\"', REPLACE(IFNULL(?,''), '"','\\"'), '\",',
                     '\"Follow-up\":\"', ? ,'"',
                     '}') AS log_data
       FROM appts
       WHERE appt_id = ?`,
      [actingUserId, taskId || false, note, apptCancelFollowUp, appt]
    );

    // ---- 4) Call webhook for external actions ----
    const webhookPayload = {
      appt,
      followup: !!apptCancelFollowUp,
      task: !!apptCancelTask,
      sms: !!sms,
      email: !!email,
      note
    };
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(webhookPayload) });

    // ---- 5) Build response message ----
    const message = taskId
      ? `Appointment Canceled! Task ${taskId} created to follow up!`
      : "Appointment Canceled! No task created to follow up!";

    res.json({ status: "success", title: "Success!", message });

  } catch (err) {
    console.error("Cancel API error:", err);
    res.status(500).json({ status: "error", title: "Error", message: "Failed to cancel appointment" });
  }
});






async function createAppt(db, {
  contact_id,
  case_id = "",
  appt_len,
  appt_type,
  appt_platform,
  appt_date,
  response_needed = false,
  case_tab = "",
  confirm_sms = false,
  confirm_email = false,
  confirm_message = "",
  note = "",
  actingUserId = 6 // default if not provided
}) {
  if (!contact_id) throw new Error("Missing contact_id");
  if (!appt_date) throw new Error("Missing appt_date");
  if (!appt_len || isNaN(appt_len) || appt_len <= 0) throw new Error("Invalid appt_len");
  if (!appt_type || !appt_platform) throw new Error("Missing type/platform");
  if ((confirm_sms || confirm_email) && !confirm_message.trim()) {
    throw new Error("Confirmation message required if SMS or email requested");
  }

  const payload = {
    contact_id,
    case_id,
    appt_len,
    appt_type,
    appt_platform,
    appt_date,
    response_needed,
    case_tab,
    confirm_sms,
    confirm_email,
    confirm_message
  };

  // ---- Send to Pabbly webhook ----
  const resp = await fetch(pabblyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const errDetail = await resp.text();
    throw new Error(`Pabbly webhook failed: ${errDetail}`);
  }

  const result = await resp.json();

  // ---- Insert log in local DB (quote-safe) ----
  await db.query(
    `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
     SELECT 'appt',
            CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'),
            CASE WHEN appt_case_id IS NOT NULL AND appt_case_id != '' THEN appt_case_id
                 ELSE appt_client_id END AS log_link,
            ? AS log_by,
            CONCAT('{',
                   '\"Appt ID\":\"', appt_id, '\",',
                   '\"Appt Type\":\"', REPLACE(IFNULL(appt_type,''), '"','\\"'), '\",',
                   '\"Appt Time\":\"', appt_date, '\",',
                   '\"Note\":\"', REPLACE(IFNULL(?,''), '"','\\"'), '\",',
                   '\"Status\":\"Created\"',
                   '}') AS log_data
     FROM appts
     WHERE appt_client_id = ? 
     ORDER BY appt_date DESC
     LIMIT 1`,
    [actingUserId, note, contact_id]
  );

  return result;
}

router.post("/api/appts/create", jwtOrApiKey, async (req, res) => {
  const actingUserId = req.auth?.userId || 6; // use authenticated user ID

  try {
    const newAppt = await createAppt(req.db, { ...req.body, actingUserId });
    res.json({
      status: "success",
      title: "Appointment Created!",
      message: "Pabbly webhook triggered successfully",
      data: newAppt
    });
  } catch (err) {
    console.error("Create Appt error:", err);
    res.status(500).json({ status: "error", title: "Error", message: err.message });
  }
});








router.post("/api/appts/reschedule", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const {
    appt,
    newDate,               // only for "Reschedule Now"
    note = "",
    sms = false,
    email = false,
    msg = "",              // confirmation message
    rescheduleLater = false,
    createTask = false     // only relevant for "Later"
  } = req.body;

  if (!appt) return res.status(400).json({ status:"error", title:"Error", message:"Missing appointment ID" });

  const actingUserId = req.auth?.userId || 6; // use authenticated user

  try {
    let newApptId = null;

    if (!rescheduleLater) {
      // ---- RESCHEDULE NOW ----
      if (!newDate) return res.status(400).json({ status:"error", title:"Error", message:"Missing new date for Reschedule Now" });

      // 1) Update old appointment status
      await db.query(
        `UPDATE appts
         SET appt_status = 'Rescheduled',
             appt_note = CONCAT(COALESCE(appt_note,''),' ',?)
         WHERE appt_id = ?`,
        [note, appt]
      );

      // 2) Fetch old appointment data
      const [[oldApptRow]] = await db.query(`SELECT * FROM appts WHERE appt_id = ?`, [appt]);
      if (!oldApptRow) throw new Error("Original appointment not found");

      // 3) Create new appointment using shared function
      const newAppt = await createAppt(db, {
        contact_id: oldApptRow.appt_client_id,
        case_id: oldApptRow.appt_case_id,
        appt_len: oldApptRow.appt_len || 15,
        appt_type: oldApptRow.appt_type,
        appt_platform: oldApptRow.appt_platform || "phone",
        appt_date: newDate,
        note,
        confirm_sms: sms,
        confirm_email: email,
        confirm_message: msg,
        actingUserId
      });

      newApptId = newAppt.id || null;

      // 4) Log original appointment reschedule (quote-escaped)
      await db.query(
        `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
         SELECT 'appt',
                CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'),
                CASE WHEN appt_case_id IS NOT NULL AND appt_case_id != '' THEN appt_case_id
                     ELSE appt_client_id END AS log_link,
                ? AS log_by,
                CONCAT('{',
                       '"Appt ID":"', appt_id, '",',
                       '"Appt Type":"', REPLACE(IFNULL(appt_type,''), '"','\\"'), '",',
                       '"Old Appt Time":"', appt_date, '",',
                       '"New Appt Time":"', ?, '",',
                       '"Note":"', REPLACE(IFNULL(?,''), '"','\\"'), '",',
                       '"Status":"Rescheduled"',
                       '}') AS log_data
         FROM appts
         WHERE appt_id = ?`,
        [actingUserId, newDate, note, appt]
      );

    } else {
      // ---- RESCHEDULE LATER ----
      await db.query(
        `UPDATE appts
         SET appt_status = 'Rescheduled',
             appt_note = CONCAT(COALESCE(appt_note,''),' ',?)
         WHERE appt_id = ?`,
        [note, appt]
      );

      // optional follow-up task
      if (createTask) {
        const [taskResult] = await db.query(
          `INSERT INTO tasks 
            SET task_status = 'Pending',
                task_from = ?,
                task_to = 2,
                task_link = (SELECT contacts.contact_id
                             FROM contacts
                             LEFT JOIN appts ON contact_id = appts.appt_client_id
                             WHERE appts.appt_id = ?),
                task_title = 'Appointment Reschedule Follow-up',
                task_desc = 'This appointment was marked rescheduled without scheduling another appointment.'`,
          [actingUserId, appt]
        );
        newApptId = taskResult.insertId;
      }

      // log original appointment (quote-escaped)
      await db.query(
        `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
         SELECT 'appt',
                CONVERT_TZ(NOW(), @@session.time_zone, 'EST5EDT'),
                CASE WHEN appt_case_id IS NOT NULL AND appt_case_id != '' THEN appt_case_id
                     ELSE appt_client_id END AS log_link,
                ? AS log_by,
                CONCAT('{',
                       '"Appt ID":"', appt_id, '",',
                       '"Appt Type":"', REPLACE(IFNULL(appt_type,''), '"','\\"'), '",',
                       '"Note":"', REPLACE(IFNULL(?,''), '"','\\"'), '",',
                       '"Status":"Rescheduled"',
                       '}') AS log_data
         FROM appts
         WHERE appt_id = ?`,
        [actingUserId, note, appt]
      );
    }

    // ---- WEBHOOK NOTIFICATION ----
    const webhookPayload = {
      appt,
      newApptId,
      sms: !!sms,
      email: !!email,
      note,
      rescheduleLater: !!rescheduleLater,
      createTask: !!createTask
    };
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(webhookPayload) });

    // ---- RESPONSE ----
    const message = !rescheduleLater
      ? `Appointment marked Rescheduled! New appointment ID: ${newApptId}`
      : (newApptId
         ? `Appointment marked Rescheduled! Task ${newApptId} created to follow up!`
         : "Appointment marked Rescheduled! No follow-up task created.");

    res.json({ status: "success", title: "Success!", message });

  } catch (err) {
    console.error("Reschedule API error:", err);
    res.status(500).json({ status:"error", title:"Error", message:"Failed to reschedule appointment" });
  }
});






module.exports = router;