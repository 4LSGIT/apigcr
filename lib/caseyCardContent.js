// lib/caseyCardContent.js — Casey v2 S3b: the "exact content" block of a card
// step, rendered by the SERVER from the step's request JSON (ref/CASEY_V2_DESIGN.md
// §4.4: "for T2, the exact-content block is rendered by the server from the
// JSON, not from the model's words: recipients, sender, subject, body, counts").
//
// contentFor({ method, path, body }) → { kind, fields: [{ label, value }] }
//   kind    'mail' (POST /api/mail/send and its schedule twin), 'sms' (a phone
//           line's SMS send), or 'fields' (anything else: the body as a key /
//           value list).
//   fields  one row per field, values as plain text (arrays joined, objects as
//           JSON). RULE, pinned by tests/caseyCardContent.test.js: NO FIELD IS
//           HIDDEN — every top-level key of the body appears in `fields`, the
//           known ones under a friendly label and in a fixed order, the rest
//           after them under their own key. A body that is not a JSON object
//           (none, or a cut text) is one row saying so.
//
// The page shows this block OPEN on T2 and T3 cards and under "Details" on T1;
// the raw JSON (byte-for-byte what apiSend sends) is always available beside it.
'use strict';

const MAIL_PATHS = /^\/api\/mail\/send(\/schedule)?(\?|$)/;
const SMS_PATHS = /^\/api\/phone-lines\/[^/]+\/sms(\?|$)/;

/** A friendly label and order for the send bodies' known keys. */
const MAIL_FIELDS = [
  ['mailbox_id', 'From mailbox'], ['to', 'To'], ['cc', 'Cc'], ['bcc', 'Bcc'], ['subject', 'Subject'],
  ['body_text', 'Body (text)'], ['body_html', 'Body (HTML)'], ['attachments', 'Attachments'],
  ['in_reply_to_message_fk', 'In reply to message'], ['quote_original', 'Quote the original'], ['signature', 'Signature'],
  ['acknowledge_optout', 'Opt-out acknowledged'], ['case_id', 'Case'], ['send_at', 'Send at'],
];
const SMS_FIELDS = [['to', 'To'], ['message', 'Message']];

function recipient(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r === 'object') {
    const email = r.email || r.address || '';
    const name = r.name || '';
    return name && email ? `${name} <${email}>` : (email || name || JSON.stringify(r));
  }
  return String(r);
}

/** A value as one plain-text string. */
function text(v) {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '(none)';
    return v.map((x) => (x && typeof x === 'object' && (x.email || x.address || x.name) ? recipient(x) : (typeof x === 'object' ? JSON.stringify(x) : String(x)))).join(', ');
  }
  return JSON.stringify(v);
}

function parseBody(body) {
  if (body == null) return undefined;
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch (_) { return null; }
}

/**
 * @param {{method:string, path:string, body?:string|object|null}} step
 * @returns {{kind:'mail'|'sms'|'fields', fields:Array<{label:string, value:string}>}}
 */
function contentFor(step) {
  const path = String((step && step.path) || '');
  const parsed = parseBody(step && step.body);
  const kind = MAIL_PATHS.test(path) ? 'mail' : SMS_PATHS.test(path) ? 'sms' : 'fields';
  if (parsed === undefined) return { kind, fields: [{ label: 'Body', value: '(no request body)' }] };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind, fields: [{ label: 'Body', value: parsed === null ? '(not JSON)' : text(parsed) }] };
  }
  const known = kind === 'mail' ? MAIL_FIELDS : kind === 'sms' ? SMS_FIELDS : [];
  const fields = [];
  const seen = new Set();
  for (const [key, label] of known) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    seen.add(key);
    const v = parsed[key];
    if (key === 'attachments' && Array.isArray(v)) { fields.push({ label, value: `${v.length} file${v.length === 1 ? '' : 's'}: ${text(v)}` }); continue; }
    if (key === 'mailbox_id') { fields.push({ label, value: `mailbox #${text(v)}` }); continue; }
    fields.push({ label, value: text(v) });
  }
  for (const key of Object.keys(parsed)) {
    if (seen.has(key)) continue;
    fields.push({ label: key, value: text(parsed[key]) });
  }
  if (!fields.length) fields.push({ label: 'Body', value: '{} (empty object)' });
  return { kind, fields };
}

module.exports = { contentFor, MAIL_PATHS, SMS_PATHS, MAIL_FIELDS, SMS_FIELDS, _text: text };
