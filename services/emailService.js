// services/emailService.js
/**
 * Email Service — router
 *
 * Looks up email_credentials by sender address, normalizes bodies, then
 * dispatches to the appropriate provider adapter under
 * services/adapters/email/. Mirrors the phoneService router pattern.
 *
 * Public API (UNCHANGED from pre-refactor):
 *   sendEmail(db, {
 *     from, to, subject,
 *     text, html,
 *     attachments,        // smtp-style inline (nodemailer format)
 *     attachment_urls,    // string | object | array (see below)
 *     attachment_names    // legacy csv string, Pabbly only
 *   })
 *
 * Adapter contract (services/adapters/email/<provider>.js):
 *   module.exports = {
 *     capabilities: { html, attachments_inline, attachments_url },
 *     async sendEmail(db, {
 *       from, fromName, to, subject,
 *       text, html,          // already normalized; both populated
 *       attachments,         // smtp-style inline, may be empty
 *       attachmentUrls,      // raw input (string/object/array) — adapter parses
 *       attachmentNames,     // raw legacy csv, may be undefined
 *       credential,          // credentials row, null when emailRow.credential_id is null
 *       emailRow,            // full email_credentials row
 *     }) → providerResult
 *   }
 *
 * Adding a provider:
 *   1. Expand the email_credentials.provider enum (separate migration)
 *   2. Drop services/adapters/email/<provider>.js
 *   3. Add to the ADAPTERS map below
 *
 * Attachment input formats accepted (parsed inside adapters, not here):
 *   - Array of { url, name } objects (preferred)
 *   - Single { url, name } object
 *   - Array of URL strings
 *   - Legacy comma-separated string of URLs (Pabbly only)
 *
 * Body normalization: at least one of text/html is required; missing
 * side is derived from the other before dispatch.
 */

const { loadCredential } = require('../lib/credentialInjection');

// Whitelist of provider → adapter module. Avoids dynamic require() based
// on a DB-controlled string. Mirrors phoneService.
const ADAPTERS = {
  smtp:   require('./adapters/email/smtp'),
  pabbly: require('./adapters/email/pabbly'),
};

// -------------------- BODY NORMALIZATION --------------------

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
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
    html: html || textToHtml(text),
  };
}

// -------------------- MAIN --------------------

/**
 * Send a single email. Routes to the appropriate provider adapter.
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.from               - must match a row in email_credentials
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.text]             - plain text body (auto-generated from html if omitted)
 * @param {string} [opts.html]             - html body (auto-generated from text if omitted)
 *                                           At least one of text or html is required.
 * @param {Array}  [opts.attachments]      - smtp-style inline attachments (nodemailer format)
 * @param {*}      [opts.attachment_urls]  - URLs (string | object | array)
 * @param {string} [opts.attachment_names] - legacy csv string of filenames (Pabbly)
 */
async function sendEmail(db, {
  from, to, subject,
  text, html,
  attachments = [],
  attachment_urls,
  attachment_names,
}) {
  if (!from || !to || !subject) {
    throw new Error('Missing required email fields (from, to, subject)');
  }

  // Validate + normalize bodies BEFORE the DB lookup, to preserve original
  // error ordering when both `text/html missing` and `creds not found` could
  // fire. normalizeBodies throws the same message the old explicit check did.
  const bodies = normalizeBodies(text, html);

  const [[emailRow]] = await db.query(
    'SELECT * FROM email_credentials WHERE email = ? LIMIT 1',
    [from]
  );
  if (!emailRow) {
    throw new Error(`No credentials found for sender: ${from}`);
  }

  const adapter = ADAPTERS[emailRow.provider];
  if (!adapter) {
    throw new Error(`Unknown email provider '${emailRow.provider}' for sender: ${from}`);
  }

  // Load credential if linked. SMTP and Pabbly rows have credential_id NULL
  // today; Slice 2 (Gmail) will populate this.
  let credential = null;
  if (emailRow.credential_id) {
    credential = await loadCredential(db, emailRow.credential_id);
    if (!credential) {
      throw new Error(
        `email_credentials ${emailRow.id} references credential ${emailRow.credential_id} but it was not found`
      );
    }
  }

  return adapter.sendEmail(db, {
    from,
    fromName:        emailRow.from_name,
    to,
    subject,
    text:            bodies.text,
    html:            bodies.html,
    attachments,
    attachmentUrls:  attachment_urls,
    attachmentNames: attachment_names,
    credential,
    emailRow,
  });
}

module.exports = { sendEmail };