const express = require("express");
const router = express.Router();
const path = require("path");




function dateNow(){
const now = new Date();
const estOffset = -4; // EST offset from UTC
const dstOffset = isDST(now.getFullYear(), now.getMonth(), now.getDate()) ? 1 : 0; // Check if DST is in effect

const estWithDST = new Date(now.getTime() + (estOffset + dstOffset) * 3600000);
const mysqlFormattedDateTime = estWithDST.toISOString().slice(0, 19).replace('T', ' ');
return mysqlFormattedDateTime

function isDST(year, month, day) {
  const dstStart = getNthWeekdayOfMonth(year, 2, 0, 1); // DST starts on the second Sunday in March
  const dstEnd = getNthWeekdayOfMonth(year, 10, 0, 1); // DST ends on the first Sunday in November
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
  return str.replace(/['"`]/g, function(match) {
    switch (match) {
      case "'":
        return '&#39;'; // or &apos; if preferred
      case '"':
        return '&quot;';
      case '`':
        return '&#96;';
    }
  });
}

router.post("/logEmail", (req, res) => {
  const db = req.db;
  let { to, from, subject, body_plain, attachments} = req.body;
  if (from.endsWith("@4lsg.com") && to.endsWith("@4lsg.com")) {
    res.status(200).json({ message: "Internal Email not logged" });
    return;
  }
  const currentDate = dateNow();
  const contactEmail = from.toLowerCase().endsWith("@4lsg.com") ? to : from;
//  subject = subject.replace(/["']/g, '\\$&');
//  let message = body_plain.replace(/["']/g, '\\$&');
  subject = escStr(subject);
  let message = escStr(body_plain);
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    attachments.forEach((attachment, index) => {
      message += `\nAttachment ${index + 1}: ${attachment}`;
    });
  }
  let string = `{"From": "${from}", "To": "${to}", "Subject": "${subject}", "Message": "${message}"}`;
  if (string.length > 65501){
    string = string.substring(0,65500) + '"}'
  }
  const insertQuery = `INSERT INTO log (log_type, log_date, log_link, log_by, log_data) SELECT "email", "${currentDate}", c.contact_id, 0, '${string}' FROM contacts c WHERE c.contact_email = "${contactEmail}"`;
  db.query(insertQuery, (err, result) => {
  if (err) {
    console.error("Error inserting email data into the log table:", err);
    res.status(500).json({ error: "Failed to log email data", details: err.message , sql: insertQuery});
  } else {
    res.status(200).json({ message: "Email data logged successfully", details: result, sql: insertQuery});
  }
  });
});



module.exports = router;