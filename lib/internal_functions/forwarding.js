// lib/internal_functions/forwarding.js
const emailService = require('../../services/emailService');
const phoneService = require('../../services/phoneService');

const fns = {};

// ─────────────────────────────────────────────────────────────
// FORWARDING (Slice 9A) — forward an ingested email/phone event
//
// Designed for the ingest-rule action path: an email_ingest_rules or
// phone_ingest_rules action of type internal_function with
//   params_mapping: { "event": "$", ... }
// The '$' whole-object convention (added to
// lib/actionDispatchers.resolveParamsMapping in this slice) passes the
// entire (possibly transformed) event envelope through as the `event`
// param. These functions work equally from a workflow step if the step
// config supplies a full envelope-shaped object.
//
// ENVELOPE SHAPES (verified against live ingest execution rows, Jul 2026):
//
//   email (emailIngestService envelope — _validateEnvelope requires only
//   kind==='email', from.email, and one recipient; subject/text/html are
//   ALL optional — both bodies can be absent):
//     { kind:'email', from:{name,email}, to:[{name,email}], cc:[...],
//       subject, text, html, date, headers:{...}, auth:{...},
//       attachments:[{url:null, mime, size, filename, content_id}], ... }
//     attachments carry url:null — the ingest pipeline stores metadata
//     only, never bytes, so forwarding the files is impossible; we note
//     them instead.
//
//   phone (the create_log params object phoneIngestService receives):
//     sms:  { type:'sms', from, to, direction, message, link_id,
//             data:{direction, attachments:[{id,type,contentType}]},
//             extra:{ts, line, provider, conversation_id, ...},
//             _variables:{..., attachments:[...], attachments_raw:[...]} }
//     call: { type:'call', from, to, direction, link_id,
//             data:{status, duration_seconds, direction, from, to},
//             extra:{started_at, ended_at, line, provider,
//                    provider_status, session_id, recording_id, ...} }
//     NOTE: _variables.attachments_raw is RingCentral's message-store part
//     list and ALWAYS contains the type:'Text' body part — its length is a
//     false-positive signal for media. The FILTERED media list is
//     data.attachments (mirrored at _variables.attachments); entries have
//     no filename, only {id, type:'MmsAttachment', contentType}.
//     Timestamps: sms carries extra.ts; call carries extra.started_at /
//     extra.ended_at (no extra.ts on call rows).
// ─────────────────────────────────────────────────────────────

// RingCentral's documented SMS body limit is 1000 chars (same ceiling the
// send_mms meta cites). Neither phoneService nor the adapters clamp —
// oversized bodies would be rejected by the provider — so we clamp the
// composed forward body here.
const SMS_MAX_CHARS = 1000;

// ─── Shared internals ────────────────────────────────────────

/**
 * Classify an event object as an email or phone envelope.
 * Returns 'email' | 'phone' | null.
 *
 * email: canonical discriminator is kind==='email' (required by
 *   emailIngestService._validateEnvelope). The subject+from-object sniff
 *   is kept as a fallback for transformed events that dropped `kind`.
 * phone: type is always 'sms' | 'call' on real events; the secondary
 *   check (message key / direction / from) guards against an unrelated
 *   object that happens to carry a `type` string.
 */
function _sniffEnvelope(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (event.kind === 'email') return 'email';
  if (event.subject !== undefined && event.from && typeof event.from === 'object') {
    return 'email';
  }
  if ((event.type === 'sms' || event.type === 'call')
      && ('message' in event || event.direction !== undefined || event.from !== undefined)) {
    return 'phone';
  }
  return null;
}

function _sniffOrThrow(event, fnName) {
  const kind = _sniffEnvelope(event);
  if (!kind) {
    throw new Error(
      `${fnName}: event does not look like an email or phone envelope — ` +
      `pass the untransformed envelope ('$' in params_mapping) or check the rule's transform`
    );
  }
  return kind;
}

/** Optional prefix + single space, only when a non-empty prefix was given. */
function _pfx(prefix) {
  const p = prefix == null ? '' : String(prefix).trim();
  return p ? `${p} ` : '';
}

/**
 * Attachment note for an EMAIL envelope. Bytes aren't stored — every
 * attachment entry carries url:null (metadata-only ingest contract), so
 * forwarding the files is impossible; we name them instead. Names live
 * under `filename` on real envelopes ({url:null, mime, size, filename,
 * content_id}); `name` is accepted defensively.
 * Returns '' when there's nothing to note.
 */
function _emailAttachmentNote(event) {
  const atts = Array.isArray(event.attachments) ? event.attachments : [];
  if (!atts.length) return '';
  const names = atts.map(a => (a && (a.filename || a.name)) || 'unnamed').join(', ');
  return `(${atts.length} attachment(s) not forwarded: ${names})`;
}

/**
 * Attachment note for a PHONE event. Uses the FILTERED media list
 * (data.attachments, mirrored at _variables.attachments) — NOT
 * _variables.attachments_raw, which always includes the type:'Text' body
 * part and would false-positive on every RC SMS. Media entries have no
 * filename ({id, type:'MmsAttachment', contentType}); bytes aren't
 * fetched by the ingest pipeline, so we list content types.
 */
function _phoneAttachmentNote(event) {
  const atts =
    (event.data && Array.isArray(event.data.attachments) && event.data.attachments)
    || (event._variables && Array.isArray(event._variables.attachments) && event._variables.attachments)
    || [];
  if (!atts.length) return '';
  const kinds = atts.map(a => (a && (a.contentType || a.type)) || 'unknown').join(', ');
  return `(${atts.length} attachment(s) not forwarded: ${kinds})`;
}

/** "Name <email>" | email | name — best available identity string. */
function _emailFromDisplay(from) {
  const name  = from && from.name  ? String(from.name).trim()  : '';
  const email = from && from.email ? String(from.email).trim() : '';
  if (name && email) return `${name} <${email}>`;
  return email || name || '(unknown sender)';
}

function _joinToList(to) {
  if (!Array.isArray(to)) return '';
  return to.map(t => (t && t.email) || null).filter(Boolean).join(', ');
}

/** Crude tag-strip for building a plain-text excerpt out of an HTML-only body. */
function _stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The "---------- Forwarded message ----------" header lines for an email
 * envelope. Returned as an array of strings so the text and html paths
 * can frame them independently.
 */
function _fwdHeaderLines(event) {
  const lines = ['---------- Forwarded message ----------'];
  lines.push(`From: ${_emailFromDisplay(event.from)}`);
  if (event.date) lines.push(`Date: ${event.date}`);
  const to = _joinToList(event.to);
  if (to) lines.push(`To: ${to}`);
  lines.push(`Subject: ${event.subject != null ? String(event.subject) : '(no subject)'}`);
  return lines;
}

/** Summary lines for a phone event (forward_as_email body). */
function _phoneSummaryLines(event) {
  const ex   = (event.extra && typeof event.extra === 'object') ? event.extra : {};
  const data = (event.data  && typeof event.data  === 'object') ? event.data  : {};
  const lines = [];
  lines.push(`From: ${event.from || '(unknown)'}`);
  if (event.to) lines.push(`To: ${event.to}`);
  if (event.direction) lines.push(`Direction: ${event.direction}`);

  if (event.type === 'call') {
    // Call rows carry extra.started_at / extra.ended_at (no extra.ts) and
    // data.{status, duration_seconds}; provider status is
    // extra.provider_status. Verified against live phone_ingest_executions.
    if (ex.started_at) lines.push(`Started: ${ex.started_at}`);
    if (ex.ended_at)   lines.push(`Ended: ${ex.ended_at}`);
    const status = data.status || ex.provider_status;
    if (status) lines.push(`Status: ${status}`);
    if (data.duration_seconds != null && data.duration_seconds !== '') {
      lines.push(`Duration: ${data.duration_seconds}s`);
    }
    if (ex.line)         lines.push(`Firm line: ${ex.line}`);
    if (ex.provider)     lines.push(`Provider: ${ex.provider}`);
    if (ex.recording_id) lines.push(`Recording ID: ${ex.recording_id}`);
  } else {
    // sms — timestamp lives at extra.ts
    if (ex.ts)   lines.push(`Timestamp: ${ex.ts}`);
    if (ex.line) lines.push(`Firm line: ${ex.line}`);
    lines.push('', `Message: ${event.message != null ? String(event.message) : '(no message body)'}`);
  }
  return lines;
}

function _clampSms(body) {
  const s = String(body);
  if (s.length <= SMS_MAX_CHARS) return s;
  return s.slice(0, SMS_MAX_CHARS - 1) + '…';
}

// ─────────────────────────────────────────────────────────────
// forward_as_email
// ─────────────────────────────────────────────────────────────

/**
 * forward_as_email
 * Forward an ingested email or phone event to an email address.
 *
 * Built for ingest-rule actions: map the whole envelope through with
 * '$' — params_mapping: { "event": "$", "to": "'it@4lsg.com'",
 * "from": "'info@4lsg.com'", "subject_prefix": "'Fwd:'" }.
 *
 * subject_prefix is used VERBATIM (plus one separating space) — nothing
 * is hardcoded server-side. "Fwd:" is only the meta default the UI
 * pre-fills; clear it and the forwarded subject is the original subject
 * bare. Same for phone events ("SMS from …" / "Call from …" is the
 * generated portion; the prefix, if any, precedes it).
 *
 * Email events: subject = prefix + original subject; body = optional
 * body_prefix paragraph, the forwarded-message header block, then the
 * original text. HTML bodies pass through as the html param with the
 * same framing prepended in a minimal wrapper. The ingest validator does
 * NOT require text or html — when both are absent the body degrades to
 * "(no body)". Attachments are noted by name, never forwarded (the
 * envelope stores url:null — bytes are not retained by ingest).
 *
 * Phone events: subject = prefix + "SMS from {from}" / "Call from
 * {from}"; body = prefix paragraph + event summary lines (from / to /
 * direction / timestamps; message text for sms; status, duration, line,
 * provider, recording id for calls — fields verified against live rows).
 *
 * params:
 *   event           {object}  — required. The email/phone envelope
 *                               (use '$' in an ingest params_mapping).
 *   to              {string}  — required. Recipient address.
 *   from            {string}  — required. Must match email_credentials
 *                               (same contract as send_email).
 *   subject_prefix  {string}  — optional. Prepended verbatim + one space.
 *                               UI default: "Fwd:".
 *   body_prefix     {string}  — optional. Leading paragraph before the
 *                               forwarded content.
 *
 * returns:
 *   { success: true,
 *     output: { forwarded_as: 'email', to, subject, send_result } }
 */
fns.forward_as_email = async (params, db) => {
  const { event, to, from, subject_prefix, body_prefix } = params;
  if (!event) throw new Error('forward_as_email requires event');
  if (!to)    throw new Error('forward_as_email requires to');
  if (!from)  throw new Error('forward_as_email requires from');

  const kind = _sniffOrThrow(event, 'forward_as_email');
  const pfx  = _pfx(subject_prefix);

  let subject;
  let text;
  let html; // only set when the source email has an html body

  if (kind === 'email') {
    subject = `${pfx}${event.subject != null && String(event.subject) !== '' ? String(event.subject) : '(no subject)'}`;

    const headerLines = _fwdHeaderLines(event);
    const attNote = _emailAttachmentNote(event);

    // Body sources — the ingest validator requires NEITHER text nor html,
    // so both can be absent.
    const hasText = event.text != null && String(event.text) !== '';
    const hasHtml = event.html != null && String(event.html) !== '';

    const textBody = hasText
      ? String(event.text)
      : (hasHtml ? '(This message has an HTML body only — see the HTML version.)' : '(no body)');

    const textParts = [];
    if (body_prefix) textParts.push(String(body_prefix), '');
    textParts.push(...headerLines, '', textBody);
    if (attNote) textParts.push('', attNote);
    text = textParts.join('\n');

    if (hasHtml) {
      // Minimal wrapper: same framing as the text path, escaped, then the
      // original html untouched.
      const framing = [];
      if (body_prefix) framing.push(String(body_prefix));
      framing.push(...headerLines);
      if (attNote) framing.push(attNote);
      const framingHtml = framing.map(l => `<p>${_escapeHtml(l)}</p>`).join('\n');
      html = `<div>\n${framingHtml}\n<hr>\n</div>\n${String(event.html)}`;
    }
  } else {
    // phone event
    subject = event.type === 'call'
      ? `${pfx}Call from ${event.from || '(unknown)'}`
      : `${pfx}SMS from ${event.from || '(unknown)'}`;

    const attNote = event.type === 'sms' ? _phoneAttachmentNote(event) : '';
    const parts = [];
    if (body_prefix) parts.push(String(body_prefix), '');
    parts.push(..._phoneSummaryLines(event));
    if (attNote) parts.push('', attNote);
    text = parts.join('\n');
  }

  console.log(`[FORWARD_AS_EMAIL] kind=${kind} from=${from} to=${to} subject="${subject}"`);
  const result = await emailService.sendEmail(db, {
    from, to, subject, text,
    ...(html && { html }),
  });

  return {
    success: true,
    output: { forwarded_as: 'email', to, subject, send_result: result },
  };
};

fns.forward_as_email.__meta = {
  category: 'forwarding',
  uiHidden: true, // ingest action pickers ignore hiding; workflow picker hides
  description:
    'Forward an ingested email or phone event to an email address. Designed ' +
    'for ingest-rule actions — map the whole envelope with "$" in ' +
    'params_mapping. Attachments are noted by name, never forwarded (ingest ' +
    'stores metadata only).',
  params: [
    { name: 'event', type: 'object', required: true,
      description:
        'The email or phone event envelope. In an ingest rule\'s ' +
        'params_mapping, use the string "$" to pass the whole ' +
        '(post-transform) event object through: { "event": "$" }.' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Recipient email address.',
      example: 'stuart@4lsg.com' },
    { name: 'from', type: 'string', required: true, widget: 'email_from',
      description: 'Sending address — must match a row in email_credentials.',
      example: 'info@4lsg.com' },
    { name: 'subject_prefix', type: 'string', required: false,
      placeholderAllowed: true, default: 'Fwd:',
      description:
        'Prepended verbatim (plus one space) to the generated subject. ' +
        'Nothing is hardcoded — clear this and the subject is the original ' +
        'subject (email) or "SMS from …"/"Call from …" (phone) bare.' },
    { name: 'body_prefix', type: 'string', required: false,
      placeholderAllowed: true, multiline: true,
      description: 'Optional leading paragraph before the forwarded content.' },
  ],
  // Example is written as an ingest params_mapping: "$" passes the whole
  // envelope; single-quoted values are literals per the mapping rules.
  example: {
    event: '$',
    to: "'stuart@4lsg.com'",
    from: "'info@4lsg.com'",
    subject_prefix: "'Fwd:'",
  },
};

// ─────────────────────────────────────────────────────────────
// forward_as_sms
// ─────────────────────────────────────────────────────────────

/**
 * forward_as_sms
 * Forward an ingested email or phone event to an SMS number.
 *
 * Email events → "{prefix}Email from {name||email}: {subject} — {text
 * excerpt}" (HTML-only bodies get a crude tag-strip for the excerpt;
 * bodiless envelopes note "(no body)"). Phone sms → "{prefix}SMS from
 * {from}: {message}"; call → "{prefix}Call from {from} ({direction}
 * {, Ns})". Attachment notes append when media exists. The composed
 * body is clamped to 1000 chars — RingCentral's documented SMS limit
 * (nothing in phoneService/adapters clamps; RC would reject oversized).
 *
 * params:
 *   event        {object}  — required. The envelope ('$' in an ingest
 *                            params_mapping).
 *   to           {string}  — required. Recipient number.
 *   from         {string}  — required. Active phone line, same contract
 *                            as send_sms (phone_lines.phone_number).
 *   body_prefix  {string}  — optional. Prepended verbatim + one space.
 *
 * returns:
 *   { success: true, output: { forwarded_as: 'sms', to, send_result } }
 */
fns.forward_as_sms = async (params, db) => {
  const { event, to, from, body_prefix } = params;
  if (!event) throw new Error('forward_as_sms requires event');
  if (!to)    throw new Error('forward_as_sms requires to');
  if (!from)  throw new Error('forward_as_sms requires from');

  const kind = _sniffOrThrow(event, 'forward_as_sms');
  const pfx  = _pfx(body_prefix);

  let body;
  if (kind === 'email') {
    const who = (event.from && (event.from.name || event.from.email)) || '(unknown sender)';
    const subj = event.subject != null && String(event.subject) !== ''
      ? String(event.subject) : '(no subject)';
    const hasText = event.text != null && String(event.text) !== '';
    const hasHtml = event.html != null && String(event.html) !== '';
    const excerptSrc = hasText ? String(event.text)
      : (hasHtml ? _stripHtml(event.html) : '(no body)');
    const excerpt = excerptSrc.replace(/\s+/g, ' ').trim() || '(no body)';
    const attNote = _emailAttachmentNote(event);
    body = `${pfx}Email from ${who}: ${subj} — ${excerpt}${attNote ? ` ${attNote}` : ''}`;
  } else if (event.type === 'call') {
    const ex   = (event.extra && typeof event.extra === 'object') ? event.extra : {};
    const data = (event.data  && typeof event.data  === 'object') ? event.data  : {};
    const bits = [];
    if (event.direction) bits.push(event.direction);
    if (data.duration_seconds != null && data.duration_seconds !== '') {
      bits.push(`${data.duration_seconds}s`);
    }
    const status = data.status || ex.provider_status;
    if (status) bits.push(status);
    body = `${pfx}Call from ${event.from || '(unknown)'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  } else {
    const attNote = _phoneAttachmentNote(event);
    const msg = event.message != null && String(event.message).trim() !== ''
      ? String(event.message) : '(no message body)';
    body = `${pfx}SMS from ${event.from || '(unknown)'}: ${msg}${attNote ? ` ${attNote}` : ''}`;
  }

  body = _clampSms(body);

  console.log(`[FORWARD_AS_SMS] kind=${kind} from=${from} to=${to}`);
  const result = await phoneService.sendSms(db, from, to, body);

  return {
    success: true,
    output: { forwarded_as: 'sms', to, send_result: result },
  };
};

fns.forward_as_sms.__meta = {
  category: 'forwarding',
  uiHidden: true, // ingest action pickers ignore hiding; workflow picker hides
  description:
    'Forward an ingested email or phone event as an SMS. Designed for ' +
    'ingest-rule actions — map the whole envelope with "$" in ' +
    'params_mapping. Body is clamped to 1000 chars (RingCentral SMS limit). ' +
    'Attachments are noted, never forwarded.',
  params: [
    { name: 'event', type: 'object', required: true,
      description:
        'The email or phone event envelope. In an ingest rule\'s ' +
        'params_mapping, use the string "$" to pass the whole ' +
        '(post-transform) event object through: { "event": "$" }.' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Recipient phone number (any common format).',
      example: '{{contactPhone}}' },
    { name: 'from', type: 'string', required: true, widget: 'phone_line',
      description: '10-digit number matching phone_lines.phone_number (must be active).',
      example: '2485559999' },
    { name: 'body_prefix', type: 'string', required: false,
      placeholderAllowed: true,
      description: 'Prepended verbatim (plus one space) to the composed message.' },
  ],
  // Example is written as an ingest params_mapping: "$" passes the whole
  // envelope; single-quoted values are literals per the mapping rules.
  example: {
    event: '$',
    to: "'2485551234'",
    from: "'2485559999'",
  },
};

module.exports = fns;