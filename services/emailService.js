/**
 * Email Service — single message send
 *
 * Looks up credentials from email_credentials table by sender address.
 * Routes to nodemailer (smtp) or Pabbly depending on email_credentials.provider.
 *
 * Usage:
 *   const emailService = require('./emailService');
 *   await emailService.sendEmail(db, {
 *     from: 'info@4lsg.com',
 *     to: 'client@example.com',
 *     subject: 'Your appointment',
 *     text: 'Plain text fallback',
 *     html: '<p>HTML version</p>',   // optional
 *     attachments: []                // optional, nodemailer format (smtp only)
 *   });
 *
 * email_credentials table:
 *   email       — sender address (PK, used for lookup)
 *   provider    — enum: 'smtp' | 'pabbly'
 *   smtp_host   — smtp only
 *   smtp_port   — smtp only
 *   smtp_user   — smtp only
 *   smtp_pass   — smtp only
 *   smtp_secure — smtp only, tinyint(1)
 *
 * To migrate a Gmail address from pabbly to smtp later:
 *   UPDATE email_credentials SET provider='smtp', smtp_host=..., ... WHERE email='addr@gmail.com';
 */

const nodemailer = require("nodemailer");

// -------------------- NORMALIZERS --------------------
// Ensures both text and html are always populated before sending.
// - html only  → strip tags for text
// - text only  → wrap in basic html
// - neither    → throw
// - both       → pass through unchanged

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')     // strip all remaining tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')  // collapse excessive blank lines
    .trim();
}

function textToHtml(text) {
  return '<p>' +
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>') +
    '</p>';
}

function normalizeBodies(text, html) {
  if (!text && !html) throw new Error('Email requires at least one of: text, html');
  return {
    text: text || htmlToText(html),
    html: html  || textToHtml(text)
  };
}

function logEmail(db, messageId, from, to, subject, body) {
  db.query(
    `INSERT INTO email_log (message_id, from_email, to_email, subject, body, processed_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [messageId, from, to, subject, body]
  ).catch(e => console.error("Failed to log email:", e));
}

// -------------------- SMTP --------------------
async function sendViaSmtp(db, creds, { from, to, subject, text, html, attachments = [] }) {
  const transporter = nodemailer.createTransport({
    host: creds.smtp_host,
    port: creds.smtp_port,
    secure: !!creds.smtp_secure,
    auth: {
      user: creds.smtp_user,
      pass: creds.smtp_pass
    }
  });

  const bodies = normalizeBodies(text, html);

  const mailOptions = {
    from,
    to,
    subject,
    text: bodies.text,
    html: bodies.html,
    ...(attachments.length && { attachments })
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

// -------------------- PABBLY --------------------
// Fire-and-forget — Pabbly handles the actual Gmail send.
// Returns a synthetic info object so callers get a consistent response shape.
// Normalizes attachments input into parallel comma-separated lists for Pabbly.
// Accepts:
//   - Array of { url, name } objects  → preferred
//   - Array of URL strings            → name defaults to filename from URL
//   - Single { url, name } object
//   - Already-separated attachment_urls / attachment_names strings (legacy)
function parseAttachments(attachment_urls, attachment_names) {
  // If attachment_urls is an array or object, parse it
  if (attachment_urls && typeof attachment_urls === "object") {
    const items = Array.isArray(attachment_urls) ? attachment_urls : [attachment_urls];
    const urls  = items.map(a => (typeof a === "string" ? a : a.url)).filter(Boolean);
    const names = items.map(a => {
      if (typeof a === "string") return a.split("/").pop().split("?")[0] || "attachment";
      return a.name || a.url?.split("/").pop().split("?")[0] || "attachment";
    });
    return {
      urls:  urls.join(","),
      names: names.join(",")
    };
  }
  // Legacy: already comma-separated strings passed directly
  if (attachment_urls && typeof attachment_urls === "string") {
    return {
      urls:  attachment_urls,
      names: attachment_names || attachment_urls.split(",").map(u => u.trim().split("/").pop().split("?")[0] || "attachment").join(",")
    };
  }
  return { urls: null, names: null };
}

async function sendViaPabbly(db, { from, from_name, to, subject, text, html, attachment_urls, attachment_names }) {
  const [[row]] = await db.query(
    "SELECT value FROM app_settings WHERE `key` = 'pabbly_internal_url' LIMIT 1"
  );
  if (!row?.value) throw new Error("app_settings missing key: pabbly_internal_url");

  const bodies = normalizeBodies(text, html);
  const messageId = `PABBLY-${Date.now()}`;
  const { urls, names } = parseAttachments(attachment_urls, attachment_names);

  fetch(row.value, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service: "email_gmail",
      data: {
        from, from_name, to, subject,
        text: bodies.text,
        html: bodies.html,
        ...(urls  && { attachment_urls: urls }),
        ...(names && { attachment_names: names })
      }
    })
  }).catch(err => console.error("Pabbly email call failed:", err.message));

  logEmail(db, messageId, from, to, subject, bodies.text);
  return { messageId, provider: "pabbly" };
}

// -------------------- MAIN --------------------
/**
 * Send a single email. Routes to smtp or pabbly based on email_credentials.provider.
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.from          - must match a row in email_credentials
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.text]        - plain text body (auto-generated from html if omitted)
 * @param {string} [opts.html]        - html body (auto-generated from text if omitted)
 *                                      At least one of text or html is required.
 * @param {Array}  [opts.attachments] - smtp only, nodemailer format
 */
async function sendEmail(db, { from, to, subject, text, html, attachments = [], attachment_urls, attachment_names }) {
  if (!from || !to || !subject) {
    throw new Error("Missing required email fields (from, to, subject)");
  }
  if (!text && !html) {
    throw new Error("Email requires at least one of: text, html");
  }

  const [[creds]] = await db.query(
    "SELECT * FROM email_credentials WHERE email = ? LIMIT 1",
    [from]
  );

  if (!creds) {
    throw new Error(`No credentials found for sender: ${from}`);
  }

  switch (creds.provider) {
    case "smtp":
      return sendViaSmtp(db, creds, { from, to, subject, text, html, attachments });

    case "pabbly":
      return sendViaPabbly(db, { from, from_name: creds.from_name, to, subject, text, html, attachment_urls, attachment_names });

    default:
      throw new Error(`Unknown email provider '${creds.provider}' for sender: ${from}`);
  }
}

module.exports = { sendEmail };