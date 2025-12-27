const express = require("express");
const router = express.Router();

function dateNow() {
  const now = new Date();
  const estOffset = -4;
  const dstOffset = isDST(now.getFullYear(), now.getMonth(), now.getDate()) ? 1 : 0;
  const estWithDST = new Date(now.getTime() + (estOffset + dstOffset) * 3600000);
  return estWithDST.toISOString().slice(0, 19).replace("T", " ");

  function isDST(year, month, day) {
    const dstStart = getNthWeekdayOfMonth(year, 2, 0, 1);
    const dstEnd = getNthWeekdayOfMonth(year, 10, 0, 1);
    const checkDate = new Date(year, month, day);
    return checkDate >= dstStart && checkDate < dstEnd && checkDate.getDay() === 0;
  }

  function getNthWeekdayOfMonth(year, month, weekday, n) {
    const date = new Date(year, month, 1);
    let count = 0;
    while (date.getDay() !== weekday || count < n) {
      if (date.getDay() === weekday) count++;
      date.setDate(date.getDate() + 1);
    }
    return date;
  }
}

router.post("/logEmail", async (req, res) => {
  const db = req.db;
  let { to, from, subject, body_plain, attachments, messageID } = req.body;

  if (!messageID) {
    return res.status(400).json({ error: "messageID is required" });
  }

  try {
    // check duplicate
    const [existing] = await db.query(
      "SELECT message_id FROM email_log WHERE message_id = ?",
      [messageID]
    );

    if (existing.length > 0) {
      return res.status(200).json({ message: "Email already processed" });
    }

    // internal email skip
    if (from.endsWith("@4lsg.com") && to.endsWith("@4lsg.com")) {
      return res.status(200).json({ message: "Internal Email not logged" });
    }

    const attachmentsStr =
      attachments && Array.isArray(attachments)
        ? JSON.stringify(attachments)
        : "[]";

    const currentDate = dateNow();

    // insert raw email log
    await db.query(
      `INSERT INTO email_log 
       (message_id, from_email, to_email, subject, body, attachments, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [messageID, from, to, subject, body_plain, attachmentsStr, currentDate]
    );

    const contactEmail = from.toLowerCase().endsWith("@4lsg.com") ? to : from;

    // build message
    let message = body_plain || "";
    if (attachments && Array.isArray(attachments)) {
      attachments.forEach((a, i) => {
        message += `\nAttachment ${i + 1}: ${a}`;
      });
    }

    let logObj = {
      From: from,
      To: to,
      Subject: subject,
      Message: message
    };

    let string = JSON.stringify(logObj);
    if (string.length > 65501) {
      string = string.substring(0, 65500) + '"}';
    }

    // insert log
    const insertLogQuery = `
      INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
      SELECT 'email', ?, c.contact_id, 0, ?
      FROM contacts c
      WHERE c.contact_email = ?
    `;

    const [logResult] = await db.query(insertLogQuery, [
      currentDate,
      string,
      contactEmail
    ]);

    // update appointments
    const updateApptsQuery = `
      UPDATE appts
      SET appt_status = 'canceled'
      WHERE appt_status = 'no show'
        AND appt_client_id = (
          SELECT contact_id FROM contacts WHERE contact_email = ?
        )
    `;

    const [updateResult] = await db.query(updateApptsQuery, [contactEmail]);

    res.status(200).json({
      message: "Email data logged successfully",
      logDetails: logResult,
      apptUpdate: updateResult
    });

  } catch (err) {
    console.error("Email log failure:", err);
    res.status(500).json({
      error: "Database operation failed",
      details: err.message
    });
  }
});

module.exports = router;
