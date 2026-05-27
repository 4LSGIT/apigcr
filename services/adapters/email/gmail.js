// services/adapters/email/gmail.js
//
// Gmail API adapter for emailService. Sends through Google's
// /gmail/v1/users/me/messages/send endpoint using OAuth2 credentials
// from the Connections system.
//
// Slice 2 architecture decisions (locked):
//   - Multi-scope per Google account: one credentials row authorizes the
//     entire Google account for Gmail (and future scopes — Calendar etc.
//     re-authorize the same row with additional scopes).
//   - Aliases share a credential: many email_credentials rows (one per
//     verified Send-as alias) all point to the same credentials.id.
//   - Send-as verification is manual in Gmail Settings → Accounts → Send
//     mail as. The adapter does NOT verify. Note: Gmail SILENTLY REWRITES
//     unrecognized From: addresses on the authenticated account to the
//     account's primary address (no error returned). The "Delegation
//     denied" error path below only fires for cross-account delegation
//     scenarios (different Workspace user, etc), not for unrecognized
//     same-account aliases.
//
// MIME assembly: we use nodemailer's MailComposer (an internal-but-stable
// module bundled with every nodemailer install) for the actual RFC 5322
// encoding, multipart structure, and Subject RFC 2047 encoding. We do
// NOT rely on MailComposer's URL-fetching for `path:` attachments —
// empirically that silently dropped a 100MB attachment during Slice 2
// testing (size guard didn't fire because the buffer was small). Instead
// we materialize all URL attachments to inline `content:` buffers
// ourselves with an explicit streaming size cap, BEFORE handing the
// mailOptions to MailComposer.
//
// Auth: buildHeadersForCredential is async and handles oauth2 refresh
// internally. If it returns {} (credential not connected, refresh failed,
// out of allowed_urls scope) we throw rather than send unauthenticated.

const MailComposer = require('nodemailer/lib/mail-composer');
const { buildHeadersForCredential } = require('../../../lib/credentialInjection');

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// Gmail's hard limit for the total raw API request body (the base64url-
// encoded MIME message inside the JSON wrapper).
const GMAIL_MAX_BYTES = 25 * 1024 * 1024;

// Headroom for MIME headers, multipart boundaries, body text, and JSON
// wrapper overhead. The attachment budget is the remainder.
const MIME_OVERHEAD_BYTES = 1 * 1024 * 1024;

// Attachments are base64-encoded inside the MIME message and then the
// whole MIME message is base64url-encoded inside the Gmail JSON body.
// The second pass is roughly idempotent on size for already-base64
// content, so we budget against the first pass: raw bytes × 4/3.
const ATTACHMENT_BASE64_BUDGET = GMAIL_MAX_BYTES - MIME_OVERHEAD_BYTES;

function base64Size(rawBytes) {
  return Math.ceil(rawBytes / 3) * 4;
}

// ─────────────────────────────────────────────────────────────
// Attachment normalization (kept symmetric with SMTP adapter)
// ─────────────────────────────────────────────────────────────

function urlToMailcomposerAttachment(item) {
  if (typeof item === 'string' && item) {
    return {
      filename: item.split('/').pop().split('?')[0] || 'attachment',
      path: item,
    };
  }
  if (item && typeof item === 'object' && item.url) {
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
      const a = urlToMailcomposerAttachment(item);
      if (a) out.push(a);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// URL fetch with streaming size cap
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a URL into a Buffer, aborting if the running total exceeds
 * `maxRawBytes`. Fast-fails via Content-Length header when the server
 * provides it; otherwise streams and counts.
 *
 * Defensive replacement for MailComposer's opaque path:-URL fetching,
 * which empirically dropped a 100MB attachment without erroring during
 * Slice 2 testing.
 */
async function fetchAttachmentToBuffer(url, maxRawBytes) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Attachment fetch network error for ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Attachment fetch failed: HTTP ${res.status} for ${url}`);
  }

  const cl = res.headers.get('content-length');
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxRawBytes) {
      // Cancel the body stream so we don't pull bytes we don't need.
      try { res.body?.cancel?.(); } catch { /* ignore */ }
      throw new Error(
        `Attachment ${url} is ${(n / 1024 / 1024).toFixed(2)} MB raw, ` +
        `exceeds remaining attachment budget of ${(maxRawBytes / 1024 / 1024).toFixed(2)} MB`
      );
    }
  }

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxRawBytes) {
        try { res.body?.cancel?.(); } catch { /* ignore */ }
        throw new Error(
          `Attachment ${url} exceeds remaining attachment budget of ` +
          `${(maxRawBytes / 1024 / 1024).toFixed(2)} MB (aborted after ${total} bytes)`
        );
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err.message?.includes('exceeds remaining attachment budget')) throw err;
    throw new Error(`Attachment stream error for ${url}: ${err.message}`);
  }

  return Buffer.concat(chunks);
}

/**
 * Walk the attachment list, fetch any URL-based entries into inline
 * buffers, and enforce the cumulative size budget. Mutates the array
 * in place (converts `path:` URL entries to `content:` Buffer entries).
 *
 * Inline (already-loaded) attachments are counted against the same
 * budget so a mix of inline + URL attachments can't bypass the cap.
 */
async function materializeAttachments(mergedAttachments) {
  let base64Used = 0;

  for (const a of mergedAttachments) {
    const isUrl = a.path && /^https?:\/\//i.test(a.path);
    if (isUrl) {
      const remaining = ATTACHMENT_BASE64_BUDGET - base64Used;
      const remainingRaw = Math.floor(remaining * 3 / 4);
      if (remainingRaw <= 0) {
        throw new Error(
          `Gmail adapter: attachment budget exhausted before fetching ${a.path}`
        );
      }
      const buf = await fetchAttachmentToBuffer(a.path, remainingRaw);
      a.content = buf;
      delete a.path;
      base64Used += base64Size(buf.length);
    } else if (a.content != null) {
      const rawSize = Buffer.isBuffer(a.content)
        ? a.content.length
        : Buffer.byteLength(a.content, a.encoding || 'utf8');
      base64Used += base64Size(rawSize);
      if (base64Used > ATTACHMENT_BASE64_BUDGET) {
        throw new Error(
          `Gmail adapter: inline attachment "${a.filename || '<unnamed>'}" ` +
          `pushes total over the ${(ATTACHMENT_BASE64_BUDGET / 1024 / 1024).toFixed(0)} MB budget`
        );
      }
    }
    // path: that isn't an HTTP(S) URL is treated as a local file by
    // MailComposer; we don't support that here and it shouldn't appear
    // in normal usage (every production caller passes URLs).
  }
}

// ─────────────────────────────────────────────────────────────
// MIME compilation
// ─────────────────────────────────────────────────────────────

function compileMime(mailOptions) {
  return new Promise((resolve, reject) => {
    const composer = new MailComposer(mailOptions);
    composer.compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);  // Buffer of full RFC 5322 bytes (CRLF endings)
    });
  });
}

function base64UrlEncode(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─────────────────────────────────────────────────────────────
// email_log (kept symmetric with SMTP / Pabbly adapters)
// ─────────────────────────────────────────────────────────────

function logEmail(db, messageId, from, to, subject, body) {
  db.query(
    `INSERT INTO email_log (source, message_id, from_email, to_email, subject, body, processed_at)
     VALUES ('outbound-gmail', ?, ?, ?, ?, ?, NOW())`,
    [messageId, from, to, subject, body]
  ).catch(e => console.error('Failed to log email:', e));
}

// ─────────────────────────────────────────────────────────────
// Send
// ─────────────────────────────────────────────────────────────

async function sendEmail(db, {
  from, fromName, to, subject, text, html,
  attachments, attachmentUrls,
  credential,
  emailRow,
  // attachmentNames: ignored — Gmail uses real MIME; names come from
  // {url, name} entries or {filename} on inline attachments.
}) {
  if (!credential) {
    throw new Error(
      `Gmail adapter requires an oauth2 credential. email_credentials ` +
      `${emailRow?.id ?? '<synthesized>'} (${emailRow?.email}) has no credential_id ` +
      `set, or the linked credential was not found.`
    );
  }
  if (credential.type !== 'oauth2') {
    throw new Error(
      `Gmail adapter expected credential ${credential.id} to be type=oauth2, got ` +
      `type=${credential.type}`
    );
  }

  // Match SMTP adapter's From: formatting exactly.
  const fromHeader = fromName
    ? `"${String(fromName).replace(/"/g, '\\"')}" <${from}>`
    : from;

  const mergedAttachments = buildAttachments(attachments, attachmentUrls);

  // Pre-fetch URL attachments BEFORE MailComposer touches them, with an
  // explicit streaming size cap. This is the size enforcement point.
  try {
    await materializeAttachments(mergedAttachments);
  } catch (err) {
    logEmail(db, `FAILED-${Date.now()}`, from, to, subject, `ATTACHMENT FAILED: ${err.message}`);
    throw err;
  }

  const mailOptions = {
    from: fromHeader,
    to,
    subject,
    text,
    html,
    ...(mergedAttachments.length && { attachments: mergedAttachments }),
  };

  let mimeBuffer;
  try {
    mimeBuffer = await compileMime(mailOptions);
  } catch (err) {
    const wrapped = new Error(`Gmail adapter: MIME compilation failed: ${err.message}`);
    logEmail(db, `FAILED-${Date.now()}`, from, to, subject, `MIME COMPILE FAILED: ${err.message}`);
    throw wrapped;
  }

  // Belt-and-suspenders: catch any miscalculation in the budget math
  // above. Should never fire if materializeAttachments is correct.
  if (mimeBuffer.length > GMAIL_MAX_BYTES) {
    const sizeMb = (mimeBuffer.length / (1024 * 1024)).toFixed(2);
    const limitMb = (GMAIL_MAX_BYTES / (1024 * 1024)).toFixed(0);
    const err = new Error(
      `Gmail adapter: assembled message is ${sizeMb} MB which exceeds the ` +
      `${limitMb} MB Gmail API limit (post-compile check; budget math drifted).`
    );
    logEmail(db, `FAILED-${Date.now()}`, from, to, subject, `OVERSIZE-POST: ${sizeMb}MB`);
    throw err;
  }

  const headers = await buildHeadersForCredential(db, credential.id, GMAIL_SEND_URL);
  if (!headers.Authorization) {
    const err = new Error(
      `Gmail adapter: could not obtain access token for credential ` +
      `${credential.id} (${credential.name}). Check Connections UI — ` +
      `oauth_status may not be 'connected' or token refresh may have failed.`
    );
    logEmail(db, `FAILED-${Date.now()}`, from, to, subject, `AUTH FAILED: ${err.message}`);
    throw err;
  }

  let res;
  try {
    res = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: base64UrlEncode(mimeBuffer) }),
    });
  } catch (err) {
    logEmail(db, `FAILED-${Date.now()}`, from, to, subject, `NETWORK FAILED: ${err.message}`);
    throw err;
  }

  if (!res.ok) {
    const errBody = await res.text();
    let parsed;
    try { parsed = JSON.parse(errBody); } catch { parsed = null; }
    const apiMsg = parsed?.error?.message || errBody.slice(0, 500);

    let finalMsg;
    if (typeof apiMsg === 'string' && /Delegation denied/i.test(apiMsg)) {
      finalMsg =
        `Gmail rejected the send: "${apiMsg}". The From: address "${from}" is ` +
        `not authorized as a Send-as delegate for the authenticated Google ` +
        `account on credential ${credential.id} (${credential.name}). Note: ` +
        `Gmail only returns this error for cross-account delegation cases; ` +
        `unrecognized same-account aliases are silently rewritten to the ` +
        `account's primary address.`;
    } else {
      finalMsg = `Gmail API ${res.status}: ${apiMsg}`;
    }

    const err = new Error(finalMsg);
    err.status = res.status;
    logEmail(db, `FAILED-${Date.now()}`, from, to, subject, `SEND FAILED: ${finalMsg}`);
    throw err;
  }

  const result = await res.json();
  const messageId = result?.id || `SENT-${Date.now()}`;
  logEmail(db, messageId, from, to, subject, text);

  return {
    messageId,
    provider: 'gmail',
    threadId: result?.threadId || null,
    labelIds: result?.labelIds || null,
    raw: result,
  };
}

// ─────────────────────────────────────────────────────────────
// List Send-as aliases (Slice 4)
//
// Probes Gmail's settings.sendAs.list endpoint and returns the raw
// array. Used by routes/api.emailCredentials.js for both the manual
// "Verify aliases" action and the auto-verify-on-save warning.
//
// Requires the gmail.settings.basic scope on the credential. Gmail
// returns 403 with insufficient_scope if the credential was authorized
// before that scope was added — caller surfaces the message to the UI
// so the operator knows to re-authorize.
//
// Returns the array directly (not the wrapping {sendAs:[...]} envelope)
// — callers don't need the wrapper. Each element shape:
//   { sendAsEmail, displayName, replyToAddress, signature,
//     isPrimary, isDefault, treatAsAlias, verificationStatus }
// ─────────────────────────────────────────────────────────────

const GMAIL_SENDAS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs';

async function listSendAs(db, credentialId) {
  if (credentialId == null) {
    throw new Error('listSendAs: credentialId is required');
  }
  const headers = await buildHeadersForCredential(db, credentialId, GMAIL_SENDAS_URL);
  if (!headers.Authorization) {
    throw new Error(
      `Gmail listSendAs: could not obtain access token for credential ${credentialId} ` +
      `— check Connections UI (oauth_status may not be 'connected', or token refresh failed).`
    );
  }
  const res = await fetch(GMAIL_SENDAS_URL, { method: 'GET', headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const apiMsg = parsed?.error?.message || body.slice(0, 500);
    if (res.status === 403 && /insufficient[\s_-]?scope|gmail\.settings/i.test(apiMsg)) {
      throw new Error(
        `Gmail listSendAs: credential ${credentialId} is missing the ` +
        `gmail.settings.basic scope. Re-authorize this credential from the API ` +
        `Credentials tab to grant the new scope. (Gmail: "${apiMsg}")`
      );
    }
    throw new Error(`Gmail listSendAs failed (${res.status}): ${apiMsg}`);
  }
  const data = await res.json();
  return Array.isArray(data?.sendAs) ? data.sendAs : [];
}

module.exports = {
  capabilities: {
    html: true,
    attachments_inline: true,
    attachments_url: true,
  },
  sendEmail,
  listSendAs,
};