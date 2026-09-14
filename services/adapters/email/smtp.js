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
//
// email_log.delivery_info — WHAT A ROW DOES AND DOESN'T PROVE:
//   The row is written as soon as transporter.sendMail RESOLVES. That means
//   the relay returned 250 on the handoff and nothing more — it is NOT
//   evidence of delivery. A 2026-09-14 smoke test of POST /api/alert/it sent
//   four alerts, logged four successes with real message-ids, and only one
//   of them ever reached the recipient mailbox; the discarded SMTP response
//   was the only thing that could have traced the other three.
//   So every row now carries delivery_info: info.response (which holds the
//   relay's queue id), plus accepted / rejected / envelope. `rejected` is the
//   one that hides — nodemailer RESOLVES when at least one recipient is
//   accepted, so a partially-rejected send looks like a clean success to
//   every caller. Recording it does not change that contract; callers still
//   see a resolved promise. It just stops the evidence being thrown away.
//   See ref/migrations/2026-09-15_email_log_delivery_info.sql.
//
// Encryption-at-rest:
//   - emailRow.smtp_pass is ENCv1: ciphertext (lib/credentialCrypto).
//     The adapter decrypts inside the existing try/catch block, so any
//     decrypt failure (corrupt ciphertext, wrong key) or "not encrypted"
//     defensive throw is logged to email_log as a FAILED row, then
//     rethrown to the caller. There is NO plaintext fallback — a row
//     whose smtp_pass is not ENCv1:-prefixed will hard-fail; run
//     scripts/encrypt-smtp-passwords.js to migrate any legacy plaintext.

const nodemailer = require('nodemailer');
const { decrypt, isEncrypted } = require('../../../lib/credentialCrypto');

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

function logEmail(db, messageId, from, to, subject, body, deliveryInfo = null) {
  db.query(
    `INSERT INTO email_log (source, message_id, from_email, to_email, subject, body, delivery_info, processed_at)
     VALUES ('outbound-smtp', ?, ?, ?, ?, ?, ?, NOW())`,
    [messageId, from, to, subject, body, deliveryInfo]
  ).catch(e => console.error('Failed to log email:', e));
}

// What nodemailer hands back on a RESOLVED send. `response` is the relay's
// reply line, which carries its queue id — the only handle that follows the
// message past our process. `rejected` is recorded because a non-empty one
// still resolves (see the header note).
function describeSend(info) {
  return JSON.stringify({
    response: info?.response ?? null,
    accepted: info?.accepted ?? [],
    rejected: info?.rejected ?? [],
    ...(info?.pending?.length ? { pending: info.pending } : {}),
    envelope: info?.envelope ?? null,
  });
}

// An SMTP refusal puts the server's own words on .response / .responseCode and
// the verb that drew them on .command. err.message alone loses all three, and
// they are what distinguishes a throttle from a bad mailbox from bad auth.
function describeError(err) {
  return JSON.stringify({
    error:        err?.message ?? String(err),
    code:         err?.code ?? null,
    responseCode: err?.responseCode ?? null,
    response:     err?.response ?? null,
    command:      err?.command ?? null,
  });
}

async function sendEmail(db, {
  from, fromName, to, subject, text, html,
  attachments, attachmentUrls,
  // attachmentNames, credential, emailRow.credential_id: ignored for SMTP
  emailRow,
}) {
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
    // Decrypt smtp_pass at the adapter boundary. No plaintext fallback —
    // a row that isn't ENCv1: prefixed is treated as a hard error so the
    // operator runs the migration script. Both this throw and any throw
    // from decrypt() (e.g. auth-tag failure) land in the catch below,
    // producing an email_log FAILED row and propagating the error.
    if (!isEncrypted(emailRow.smtp_pass)) {
      throw new Error(
        `SMTP adapter: emailRow id=${emailRow.id} smtp_pass is not encrypted. ` +
        `Run scripts/encrypt-smtp-passwords.js.`
      );
    }
    const smtpPassPlain = decrypt(emailRow.smtp_pass);

    const transporter = nodemailer.createTransport({
      host:   emailRow.smtp_host,
      port:   emailRow.smtp_port,
      secure: !!emailRow.smtp_secure,
      auth: {
        user: emailRow.smtp_user,
        pass: smtpPassPlain,
      },
    });

    info = await transporter.sendMail(mailOptions);
  } catch (err) {
    logEmail(db, `FAILED-${Date.now()}`, from, to, subject, `SEND FAILED: ${err.message}`,
             describeError(err));
    throw err;
  }

  // Resolved-but-rejected is invisible to the caller by nodemailer's contract,
  // so say it out loud here as well as persisting it.
  if (info?.rejected?.length) {
    console.warn(
      `[smtp] send RESOLVED with ${info.rejected.length} rejected recipient(s): ` +
      `${info.rejected.join(', ')} | from=${from} subject=${subject}`
    );
  }
  logEmail(db, info.messageId || `SENT-${Date.now()}`, from, to, subject, text,
           describeSend(info));
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