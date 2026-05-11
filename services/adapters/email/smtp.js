// services/adapters/email/smtp.js
//
// SMTP adapter for emailService. Uses nodemailer; auth comes from the
// emailRow.smtp_* columns (NOT from the credentials table — `credential`
// param will be null for SMTP rows in this slice).
//
// Attachment URLs are merged into nodemailer's `attachments` array using
// the `path` field, which nodemailer fetches remotely at send time.
//
// Behavior preserved from the pre-refactor monolith:
//   - No transporter pooling/caching — new transporter per call.
//   - `from_name` is intentionally ignored; the bare `from` email is
//     passed to nodemailer. (Old code did this; changing would be a
//     behavior change outside this slice's scope.)
//   - On send failure, log a FAILED-<ts> row to email_log BEFORE rethrowing.

const nodemailer = require('nodemailer');

function urlToNodemailerAttachment(item) {
  if (typeof item === 'string' && item) {
    return {
      filename: item.split('/').pop().split('?')[0] || 'attachment',
      path: item,
    };
  }
  if (item?.url) {
    return {
      filename: item.name || item.url.split('/').pop().split('?')[0] || 'attachment',
      path: item.url,
    };
  }
  return null;
}

function buildAttachments(attachments, attachmentUrls) {
  const out = Array.isArray(attachments) ? [...attachments] : [];
  if (attachmentUrls) {
    const items = Array.isArray(attachmentUrls) ? attachmentUrls : [attachmentUrls];
    for (const item of items) {
      const a = urlToNodemailerAttachment(item);
      if (a) out.push(a);
    }
  }
  return out;
}

function logEmail(db, messageId, from, to, subject, body) {
  db.query(
    `INSERT INTO email_log (message_id, from_email, to_email, subject, body, processed_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [messageId, from, to, subject, body]
  ).catch(e => console.error('Failed to log email:', e));
}

async function sendEmail(db, {
  from, fromName, to, subject, text, html,
  attachments, attachmentUrls,
  // attachmentNames, credential, emailRow.credential_id: ignored for SMTP
  emailRow,
}) {
  const transporter = nodemailer.createTransport({
    host:   emailRow.smtp_host,
    port:   emailRow.smtp_port,
    secure: !!emailRow.smtp_secure,
    auth: {
      user: emailRow.smtp_user,
      pass: emailRow.smtp_pass,
    },
  });

  const mergedAttachments = buildAttachments(attachments, attachmentUrls);

  const mailOptions = {
    from: fromName ? `"${fromName.replace(/"/g, '\\"')}" <${from}>` : from,
    to,
    subject,
    text,
    html,
    ...(mergedAttachments.length && { attachments: mergedAttachments }),
  };

  let info;
  try {
    info = await transporter.sendMail(mailOptions);
  } catch (err) {
    logEmail(db, `FAILED-${Date.now()}`, from, to, subject, `SEND FAILED: ${err.message}`);
    throw err;
  }

  logEmail(db, info.messageId || `SENT-${Date.now()}`, from, to, subject, text);
  return info;
}

module.exports = {
  capabilities: {
    html: true,
    attachments_inline: true,  // nodemailer's {filename, content, ...}
    attachments_url: true,     // nodemailer fetches `path` URLs at send
  },
  sendEmail,
};