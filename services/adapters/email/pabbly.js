// services/adapters/email/pabbly.js
//
// Pabbly adapter — fire-and-forget HTTP POST to the webhook URL stored
// in app_settings.pabbly_internal_url. Pabbly forwards to Gmail.
//
// Returns a synthetic info object ({ messageId, provider }) immediately;
// the actual HTTP send is .catch()-detached. This matches pre-refactor
// behavior — Pabbly send is NOT awaited and provider-side failures will
// not surface to the caller.
//
// `credential` param is null this slice. `attachments` (smtp-style inline)
// is silently ignored — Pabbly only accepts URL-based attachments.

// Attachment input formats accepted (preserved verbatim from monolith):
//   - Array of { url, name } objects (preferred — communicate.html, campaign.html)
//   - Single { url, name } object
//   - Array of URL strings
//   - Legacy comma-separated string of URLs

function logEmail(db, messageId, from, to, subject, body) {
  db.query(
    `INSERT INTO email_log (message_id, from_email, to_email, subject, body, processed_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [messageId, from, to, subject, body]
  ).catch(e => console.error('Failed to log email:', e));
}

// Normalizes mixed attachment input into parallel comma-separated lists
// for Pabbly's CSV-style attachment_urls / attachment_names fields.
function parseAttachments(attachment_urls, attachment_names) {
  if (attachment_urls && typeof attachment_urls === 'object') {
    const items = Array.isArray(attachment_urls) ? attachment_urls : [attachment_urls];
    const urls  = items.map(a => (typeof a === 'string' ? a : a.url)).filter(Boolean);
    const names = items.map(a => {
      if (typeof a === 'string') return a.split('/').pop().split('?')[0] || 'attachment';
      return a.name || a.url?.split('/').pop().split('?')[0] || 'attachment';
    });
    return { urls: urls.join(','), names: names.join(',') };
  }
  if (attachment_urls && typeof attachment_urls === 'string') {
    return {
      urls:  attachment_urls,
      names: attachment_names
        || attachment_urls.split(',').map(u => u.trim().split('/').pop().split('?')[0] || 'attachment').join(','),
    };
  }
  return { urls: null, names: null };
}

async function sendEmail(db, {
  from, fromName, to, subject, text, html,
  attachmentUrls, attachmentNames,
  // attachments, credential, emailRow.credential_id: unused for Pabbly
}) {
  const [[row]] = await db.query(
    "SELECT value FROM app_settings WHERE `key` = 'pabbly_internal_url' LIMIT 1"
  );
  if (!row?.value) throw new Error('app_settings missing key: pabbly_internal_url');

  const messageId = `PABBLY-${Date.now()}`;
  const { urls, names } = parseAttachments(attachmentUrls, attachmentNames);

  fetch(row.value, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service: 'email_gmail',
      data: {
        from,
        from_name: fromName,
        to,
        subject,
        text,
        html,
        ...(urls  && { attachment_urls:  urls }),
        ...(names && { attachment_names: names }),
      },
    }),
  }).catch(err => console.error('Pabbly email call failed:', err.message));

  logEmail(db, messageId, from, to, subject, text);
  return { messageId, provider: 'pabbly' };
}

module.exports = {
  capabilities: {
    html: true,
    attachments_inline: false,  // Pabbly doesn't accept inline buffers
    attachments_url: true,
  },
  sendEmail,
};