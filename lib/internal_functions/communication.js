// lib/internal_functions/communication.js
const phoneService   = require('../../services/phoneService');
const emailService   = require('../../services/emailService');

const fns = {};

// ─────────────────────────────────────────────────────────────
// COMMUNICATION
// ─────────────────────────────────────────────────────────────

/**
 * send_sms
 * Send an SMS from an internal phone line.
 * Returns the provider result as output — use set_vars in step config
 * to capture anything you need (e.g. {{this.messageId}}).
 *
 * params:
 *   from     {string}  — 10-digit number matching phone_lines.phone_number
 *   to       {string}  — recipient number (any common format)
 *   message  {string}  — message body ({{variables}} resolved before call)
 *
 * example config:
 *   {
 *     "function_name": "send_sms",
 *     "params": {
 *       "from": "2485559999",
 *       "to": "{{contactPhone}}",
 *       "message": "Hi {{firstName}}, your appointment is confirmed for {{apptDate}}."
 *     }
 *   }
 */

fns.send_sms = async (params, db) => {
    const { from, to, message } = params;
    if (!from)    throw new Error('send_sms requires from');
    if (!to)      throw new Error('send_sms requires to');
    if (!message) throw new Error('send_sms requires message');

    console.log(`[SEND_SMS] from=${from} to=${to}`);
    const result = await phoneService.sendSms(db, from, to, message);

    return {
      success: true,
      output: result
    };
  };

fns.send_sms.__meta = {
  category: 'communication',
  description: 'Send an SMS from an internal phone line.',
  params: [
    { name: 'from', type: 'string', required: true, widget: 'phone_line',
      description: '10-digit number matching phone_lines.phone_number.',
      example: '2485559999' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Recipient number (any common format).',
      example: '{{contactPhone}}' },
    { name: 'message', type: 'string', required: true, placeholderAllowed: true,
      multiline: true,
      description: 'Message body. {{variables}} resolved before send.',
      example: 'Hi {{firstName}}, your appointment is confirmed.' },
  ],
  example: { from: '2485559999', to: '{{contactPhone}}', message: 'Hi {{firstName}}!' }
};

/**
 * send_email
 * Send an email via the configured provider (smtp or pabbly).
 * Returns the provider result as output — use set_vars in step config
 * to capture anything you need (e.g. {{this.messageId}}).
 *
 * params:
 *   from              {string}  — must match a row in email_credentials
 *   to                {string}  — recipient address
 *   subject           {string}
 *   text              {string}  — plain text body
 *   html              {string}  — optional HTML body
 *   attachment_urls   {array}   — optional. Array of {url, name} objects,
 *                                 array of URL strings, or a single
 *                                 {url, name} object. Names are inferred
 *                                 from the URL when omitted. Works on both
 *                                 SMTP (via nodemailer's remote-fetch path)
 *                                 and Pabbly providers. Placeholders inside
 *                                 URL strings are resolved before send.
 *   attachment_names  {array}   — optional. Parallel array of display names.
 *                                 Usually unnecessary — names are inferred
 *                                 from the URL or the {name} field.
 *
 * example config:
 *   {
 *     "function_name": "send_email",
 *     "params": {
 *       "from": "info@4lsg.com",
 *       "to": "{{contactEmail}}",
 *       "subject": "Your appointment is confirmed",
 *       "text": "Hi {{firstName}}, we look forward to seeing you on {{apptDate}}.",
 *       "attachment_urls": [
 *         { "url": "https://storage.googleapis.com/.../intake.pdf", "name": "Intake Packet.pdf" }
 *       ]
 *     }
 *   }
 */

fns.send_email = async (params, db) => {
    const { from, to, subject, text, html, attachment_urls, attachment_names } = params;
    if (!from)    throw new Error('send_email requires from');
    if (!to)      throw new Error('send_email requires to');
    if (!subject) throw new Error('send_email requires subject');
    if (!text && !html) throw new Error('send_email requires at least one of: text, html');

    console.log(`[SEND_EMAIL] from=${from} to=${to} subject="${subject}"${attachment_urls ? ' (with attachments)' : ''}`);
    const result = await emailService.sendEmail(db, {
      from, to, subject, text, html,
      ...(attachment_urls  && { attachment_urls }),
      ...(attachment_names && { attachment_names }),
    });

    return {
      success: true,
      output: result
    };
  };

fns.send_email.__meta = {
  category: 'communication',
  description: 'Send an email via the configured provider (smtp or pabbly).',
  params: [
    { name: 'from', type: 'string', required: true, widget: 'email_from',
      description: 'Must match a row in email_credentials.',
      example: 'info@4lsg.com' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Recipient address.',
      example: '{{contactEmail}}' },
    { name: 'subject', type: 'string', required: true, placeholderAllowed: true },
    { name: 'text', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'Plain text body. Provide at least one of text or html.' },
    { name: 'html', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'HTML body. Provide at least one of text or html.' },
    { name: 'attachment_urls', type: 'array', required: false,
      description:
        'Optional. JSON array of attachments. Two shapes accepted:\n' +
        '  ["https://.../file.pdf"]                                  — URL strings, name auto-derived\n' +
        '  [{"url":"https://...","name":"Fee Agreement.pdf"}]        — explicit display name\n' +
        'Placeholders work inside URL strings (e.g. {{contacts.contact_doc_url}}).\n' +
        'Files are fetched at send time — they must be publicly reachable.' },
  ],
  requiredWith: [['text', 'html']],
  example: { from: 'info@4lsg.com', to: '{{contactEmail}}', subject: 'Confirmed', text: 'Hi!' }
};

/**
 * send_mms
 * Send an MMS from a phone line that's flagged mms_capable in phone_lines.
 * URL-attachment only (single attachment per RingCentral API limits).
 *
 * MMS today is RingCentral-only — Quo and OpenPhone don't support MMS sends.
 * The capability is read from phone_lines.mms_capable (a TINYINT(1) flag),
 * not inferred from provider, so future provider additions can opt in via
 * a row update without code changes here. If the flag is false, phoneService
 * throws a clear error — no silent fallback to SMS.
 *
 * MEDIA TYPES:
 *   RingCentral's published spec lists images (JPEG, PNG, GIF, BMP, TIFF)
 *   and standard audio/video formats as supported. **PDFs are NOT on the
 *   published list but work in practice for this account today** — they're
 *   tested-good but not contractually guaranteed; an RC API change could
 *   break PDF support without notice. Prefer the spec-supported types when
 *   reliability matters; for documents you need delivered guaranteed, use
 *   send_email (attachment_urls handles PDFs cleanly).
 *
 * CONTENT-TYPE GOTCHA:
 *   The RingCentral adapter strips Content-Type parameters before forwarding
 *   to RC because RC's parser doesn't normalize them. A source URL that
 *   returns `application/pdf; qs=0.001` (some W3C-hosted files do this as a
 *   content-negotiation hint) gets rejected as MSG-348 "Unsupported
 *   attachment media type" if the parameter isn't stripped. Hosting
 *   attachments on GCS, your own server, or any provider that returns a
 *   clean Content-Type avoids the issue.
 *
 * params:
 *   from            {string}  — 10-digit phone_lines.phone_number;
 *                                must be active AND mms_capable=1
 *   to              {string}  — recipient number (any common format)
 *   text            {string}  — optional message body (≤1000 chars per RC limits)
 *   attachment_url  {string}  — required. Publicly fetchable URL.
 *                                The adapter fetches at send time and
 *                                caps it at 1.5MB.
 *
 * example config:
 *   {
 *     "function_name": "send_mms",
 *     "params": {
 *       "from": "2485559999",
 *       "to": "{{contactPhone}}",
 *       "text": "Hi {{firstName}}, see attached.",
 *       "attachment_url": "https://storage.googleapis.com/uploads.4lsg.com/screenshot.png"
 *     }
 *   }
 */

fns.send_mms = async (params, db) => {
    const { from, to, text, attachment_url } = params;
    if (!from)           throw new Error('send_mms requires from');
    if (!to)             throw new Error('send_mms requires to');
    if (!attachment_url) throw new Error('send_mms requires attachment_url');

    console.log(`[SEND_MMS] from=${from} to=${to}`);
    const result = await phoneService.sendMms(db, from, to, text || '', attachment_url);

    return {
      success: true,
      output: result
    };
  };

fns.send_mms.__meta = {
  category: 'communication',
  description: 'Send an MMS from an mms_capable phone line. URL-attachment only. Spec-supported types: images (JPEG/PNG/GIF/BMP/TIFF) and standard audio/video. PDFs work in practice but are best-effort (not in RC\'s published spec).',
  params: [
    { name: 'from', type: 'string', required: true, widget: 'phone_line_mms',
      description:
        'Must be an active phone line with mms_capable=1 in phone_lines. ' +
        'Today that means RingCentral lines; Quo/OpenPhone lines won\'t appear ' +
        'in the dropdown and will fail at runtime if entered manually.' },
    { name: 'to', type: 'string', required: true, placeholderAllowed: true,
      description: 'Recipient phone (any common format).' },
    { name: 'text', type: 'string', required: false, placeholderAllowed: true,
      multiline: true,
      description: 'Optional message body (≤1000 chars per RingCentral limits).' },
    { name: 'attachment_url', type: 'string', required: true, placeholderAllowed: true,
      description:
        'Publicly fetchable URL. RingCentral fetches the file at send time and caps it at 1.5MB. ' +
        'Spec-supported per RingCentral: images (JPEG, PNG, GIF, BMP, TIFF) and standard audio/video. ' +
        'PDFs are not on the published list but work in practice for this account — best-effort, ' +
        'no contractual guarantee. For guaranteed document delivery, prefer send_email.' },
  ],
  example: { from: '2485559999', to: '{{contactPhone}}', text: 'See attached', attachment_url: 'https://storage.googleapis.com/uploads.4lsg.com/screenshot.png' }
};

module.exports = fns;
