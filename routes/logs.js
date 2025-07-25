const express = require("express");
const router = express.Router();
const path = require("path");

function dateNow() {
  const now = new Date();
  const estOffset = -4; // EST offset from UTC
  const dstOffset = isDST(now.getFullYear(), now.getMonth(), now.getDate()) ? 1 : 0;
  const estWithDST = new Date(now.getTime() + (estOffset + dstOffset) * 3600000);
  const mysqlFormattedDateTime = estWithDST.toISOString().slice(0, 19).replace('T', ' ');
  return mysqlFormattedDateTime;

  function isDST(year, month, day) {
    const dstStart = getNthWeekdayOfMonth(year, 2, 0, 1); // Second Sunday in March
    const dstEnd = getNthWeekdayOfMonth(year, 10, 0, 1); // First Sunday in November
    const checkDate = new Date(year, month, day);
    return checkDate >= dstStart && checkDate < dstEnd && checkDate.getDay() === 0;
  }

  function getNthWeekdayOfMonth(year, month, weekday, n) {
    const date = new Date(year, month, 1);
    let count = 0;
    while (date.getDay() !== weekday || count < n) {
      if (date.getDay() === weekday) {
        count++;
      }
      date.setDate(date.getDate() + 1);
    }
    return date;
  }
}

function escStr(str) {
  return str.replace(/['"`]/g, function (match) {
    switch (match) {
      case "'":
        return "''"; // Double single quote for MySQL
      case '"':
        return '"';
      case '`':
        return '`';
    }
  });
}

router.post("/logEmail", (req, res) => {
  const db = req.db;
  let { to, from, subject, body_plain, attachments, messageID } = req.body;

  // Validate messageID
  if (!messageID) {
    console.error("Missing messageID in payload");
    return res.status(400).json({ error: "messageID is required" });
  }

  // Check if messageID exists in email_log
  db.query(
    "SELECT message_id FROM email_log WHERE message_id = ?",
    [messageID],
    (err, results) => {
      if (err) {
        console.error(`Error checking messageID ${messageID}:`, err);
        return res.status(500).json({ error: "Failed to check email log", details: err.message });
      }

      if (results.length > 0) {
        console.log(`Skipped email ID ${messageID}: already processed`);
        return res.status(200).json({ message: "Email already processed" });
      }

      // Internal email check
      if (from.endsWith("@4lsg.com") && to.endsWith("@4lsg.com")) {
        console.log(`Skipped email ID ${messageID}: internal email (from: ${from}, to: ${to})`);
        return res.status(200).json({ message: "Internal Email not logged" });
      }

      // Store in email_log using dateNow
      const attachmentsStr = attachments && Array.isArray(attachments) ? JSON.stringify(attachments) : '[]';
      const currentDate = dateNow(); // Use for both email_log and log
      db.query(
        "INSERT INTO email_log (message_id, from_email, to_email, subject, body, attachments, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [messageID, from, to, subject, body_plain, attachmentsStr, currentDate],
        (err, result) => {
          if (err) {
            console.error(`Error storing email ID ${messageID} in email_log:`, err);
            return res.status(500).json({ error: "Failed to store email log", details: err.message });
          }

          // Proceed with existing log table insertion
          const contactEmail = from.toLowerCase().endsWith("@4lsg.com") ? to : from;
          const escapedSubject = escStr(subject);
          let message = escStr(body_plain);
          if (attachments && Array.isArray(attachments) && attachments.length > 0) {
            attachments.forEach((attachment, index) => {
              message += `\nAttachment ${index + 1}: ${attachment}`;
            });
          }
          let string = `{"From": "${from}", "To": "${to}", "Subject": "${escapedSubject}", "Message": "${message}"}`;
          if (string.length > 65501) {
            string = string.substring(0, 65500) + '"}';
          }
          const insertLogQuery = `INSERT INTO log (log_type, log_date, log_link, log_by, log_data) 
                                 SELECT 'email', '${currentDate}', c.contact_id, 0, '${string}' 
                                 FROM contacts c WHERE c.contact_email = '${contactEmail}'`;

          db.query(insertLogQuery, (err, result) => {
            if (err) {
              console.error(`Error inserting email ID ${messageID} into log table:`, err);
              return res.status(500).json({ error: "Failed to log email data", details: err.message, sql: insertLogQuery });
            }

            console.log(`Processed email ID ${messageID} from ${from} to ${to} with subject: ${subject}`);
            res.status(200).json({ message: "Email data logged successfully", details: result, sql: insertLogQuery });
          });
        }
      );
    }
  );
});

module.exports = router;