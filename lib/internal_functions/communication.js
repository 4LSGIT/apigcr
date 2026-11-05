// lib/internal_functions/communication.js
const phoneService   = require('../../services/phoneService');
const emailService   = require('../../services/emailService');
// Automation never texts an opted-out number (ruling 2026-10-27, D19): each
// sender below asserts before it sends; the refusal is an OptOutRefusal the
// workflow / sequence engines record as a SKIP, never a failure. An email
// opt-out is marketing-only (YisraMail D18), so send_email's assert never
// refuses an operational send — it stays for C7's promotional flag.
const { assertNotOptedOut } = require('../../services/optoutService');

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
    // C7/D1: marketing SMS is not built in v1 — a dedicated 10DLC marketing
    // campaign, written consent capture and quiet hours come first (Appendix
    // C). Refused loudly, never downgraded to an operational send.
    if (params.promotional === true || /^(true|1|yes)$/i.test(String(params.promotional ?? ''))) {
      throw new Error('send_sms: promotional SMS is not available (ruling D1 — marketing is email-only in v1)');
    }
    if (!from)    throw new Error('send_sms requires from');
    if (!to)      throw new Error('send_sms requires to');
    if (!message) throw new Error('send_sms requires message');

    await assertNotOptedOut(db, 'sms', to);
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
    { name: 'promotional', type: 'boolean', required: false, default: false,
      description: 'Not available: marketing SMS is email-only in v1 (ruling D1 — it needs a dedicated ' +
        '10DLC marketing campaign, written consent and quiet hours). true is refused at run time; the ' +
        'field exists so the send_email contract carries over the day D1 is revisited.' },
  ],
  example: { from: '2485559999', to: '{{contactPhone}}', message: 'Hi {{firstName}}!' },
  // CTA clicker inputs (ref/CTA_DESIGN.md §12, Ruling 6c): params a CTA
  // option may bind to "[[input:name]]". Every entry is a reviewed exposure
  // decision — tests/ctaInputs.test.js snapshots the full opened set.
  // (§12's seed said `text`; send_sms's body param is `message`.)
  // type (S1i review N6): the input type a recipient takes — a phone here.
  ctaInputParams: {
    to:      { kind: 'recipient', type: 'phone' },
    message: { kind: 'content' },
  },
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

/** Lenient boolean: step configs and resolved {{placeholders}} deliver booleans as strings. */
function truthyParam(v) {
  return v === true || v === 1 || /^(true|1|yes)$/i.test(String(v ?? ''));
}

/**
 * C7: a design from the library as the body — loaded at run time (the engine
 * resolved the STEP CONFIG's placeholders, never the design's), so its merge
 * tags resolve here, against contact_id. Archived designs are refused like
 * createCampaign refuses them. → { html, text, name }
 */
async function loadDesignBody(db, designId, contactId, { resolveNow }) {
  const cid = Number(contactId);
  if (!Number.isSafeInteger(cid) || cid < 1) throw new Error('send_email: design_id needs contact_id — the design\'s merge tags resolve against it');
  const designs = require('../../services/emailDesignService'); // lazy require (convention)
  const design = await designs.getDesign(db, designId);
  if (design.archived) throw new Error(`send_email: design ${design.id} ("${design.name}") is archived — restore it or pick another`);
  if (!resolveNow) return { html: design.html, text: design.text, name: design.name };
  // Operational sends go through the plain path, so the design's merge tags
  // resolve here. Promotional sends resolve inside renderMarketing instead —
  // each path resolves the design exactly ONCE: the hazard of a second pass
  // is re-resolving tags that arrived INSIDE substituted values (clicker or
  // variable text), not double-escaping (the resolver escapes only what it
  // substitutes).
  const { resolve } = require('../../services/resolverService');  // lazy require (convention)
  const refs = { contacts: { contact_id: cid } };
  const rh = await resolve({ db, text: design.html, refs, strict: true, escape: 'html' });
  if (rh.status !== 'success') throw new Error(`send_email: the design's merge tags did not resolve: ${(rh.unresolved || []).join(', ') || (rh.errors || []).join('; ')}`);
  const rt = await resolve({ db, text: design.text, refs, strict: true });
  if (rt.status !== 'success') throw new Error(`send_email: the design's text part did not resolve: ${(rt.unresolved || []).join(', ') || (rt.errors || []).join('; ')}`);
  return { html: rh.text, text: rt.text, name: design.name };
}

fns.send_email = async (params, db) => {
    const { from, to, subject, text, html, attachment_urls, attachment_names, include_signature,
      promotional, topic, marketing_sender, design_id, contact_id } = params;
    const isPromotional = truthyParam(promotional);
    if (!from && !isPromotional) throw new Error('send_email requires from');
    if (!to)      throw new Error('send_email requires to');
    if (!subject) throw new Error('send_email requires subject');
    if (!design_id && !text && !html) throw new Error('send_email requires at least one of: text, html, design_id');

    const wantSig = truthyParam(include_signature);

    if (isPromotional) {
      // C7: the marketing path — consent by topic (opted out → SKIPPED, the
      // workflow goes on), kill switch, real unsub token, footer, headers,
      // bulk transport + hold rules. campaignService.sendPromotional owns it.
      if (!topic) throw new Error('send_email: promotional requires topic (the consent question is asked per topic)');
      if (wantSig) throw new Error('send_email: include_signature does not apply to a promotional send — the footer is the sign-off');
      const campaignService = require('../../services/campaignService'); // lazy require (convention)
      let body = html || null;
      if (design_id) body = (await loadDesignBody(db, design_id, contact_id, { resolveNow: false })).html;
      if (!body) throw new Error('send_email: a promotional send needs html or design_id (its body carries the footer slot)');
      const r = await campaignService.sendPromotional(db, {
        sender: marketing_sender || null, to, subject, body,
        topicKey: topic, contactId: contact_id,
        ...(attachment_urls && { attachmentUrls: attachment_urls }),
        ...(attachment_names && { attachmentNames: attachment_names }),
      });
      console.log(`[SEND_EMAIL] promotional topic=${topic} to=${to} ${r.sent ? 'sent' : `skipped=${r.skipped}`}`);
      return { success: true, output: r };
    }

    let bodyHtml = html;
    let bodyText = text;
    if (design_id) {
      const d = await loadDesignBody(db, design_id, contact_id, { resolveNow: true });
      bodyHtml = d.html;
      bodyText = d.text;
    }
    await assertNotOptedOut(db, 'email', to);
    console.log(`[SEND_EMAIL] from=${from} to=${to} subject="${subject}"${attachment_urls ? ' (with attachments)' : ''}${wantSig ? ' (signature)' : ''}${design_id ? ` (design ${design_id})` : ''}`);
    const result = await emailService.sendEmail(db, {
      from, to, subject, text: bodyText, html: bodyHtml,
      ...(attachment_urls  && { attachment_urls }),
      ...(attachment_names && { attachment_names }),
      ...(wantSig          && { signature: true }),
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
    { name: 'from', type: 'string', required: false, widget: 'email_from',
      description: 'Must match a row in email_credentials. Required unless promotional is on (a ' +
        'promotional send uses marketing_sender instead — this list never offers marketing transports); ' +
        'the save validator enforces that (requiredUnless).',
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
    { name: 'include_signature', type: 'boolean', required: false, default: false,
      description:
        'Append the sender\'s stored signature (email_credentials.signature_html' +
        '/_text) after the body. No-op when the from-address has no signature ' +
        'configured. Accepts true/"true"/"1"/"yes".' },
    { name: 'design_id', type: 'integer', required: false,
      description:
        'C7: send a saved Designer template (the campaign Designer\'s "Designs…" list) as the body — ' +
        'its merge tags resolve against contact_id at send time. Overrides text/html. Archived designs ' +
        'are refused. Requires contact_id.' },
    { name: 'contact_id', type: 'integer', required: false, placeholderAllowed: true,
      description:
        'The recipient\'s contact — required with design_id or promotional (merge tags and the ' +
        'unsubscribe token resolve against it).',
      example: '{{contact_id}}' },
    { name: 'promotional', type: 'boolean', required: false, default: false,
      description:
        'C7: true = this is MARKETING mail — it takes the campaign compliance path: consent is checked ' +
        'for the topic (an opted-out recipient is SKIPPED, output {sent:false, skipped:"opted_out"}, and ' +
        'the automation goes on), a real unsubscribe token and the compliance footer are added, marketing ' +
        'headers and Reply-To are set, and it sends from the marketing transport (held transport refused; ' +
        'off while marketing campaigns are switched off). `from` is ignored; include_signature is REFUSED ' +
        '(the footer is the sign-off). ' +
        'Default false = operational: a stand-in for a person (D18) — no footer, reaches opt-outs.' },
    { name: 'topic', type: 'string', required: false,
      description: 'The marketing topic (comm_topics key, e.g. "newsletter") — required with promotional; the consent question and the unsubscribe page are per topic.',
      example: 'newsletter' },
    { name: 'marketing_sender', type: 'string', required: false,
      description:
        'Promotional only: the marketing transport\'s address to send from. Blank = the firm\'s only ' +
        'marketing transport (refused if there are several). The regular `from` list never contains ' +
        'marketing transports, which is why this is its own field.',
      example: 'news@news.4lsg.com' },
  ],
  requiredWith: [['text', 'html', 'design_id']],
  // from is save-required on every step EXCEPT one whose promotional is the
  // literal boolean true (the editors materialize the checkbox explicitly) —
  // an operational step can never save without a sender (review, 2026-11-05).
  requiredUnless: [['from', 'promotional']],
  example: { from: 'info@4lsg.com', to: '{{contactEmail}}', subject: 'Confirmed', text: 'Hi!' },
  // CTA clicker inputs (§12) — see send_sms. html:true = escape-on-substitute:
  // a non-html input bound here is HTML-escaped + nl2br (only a declared
  // type:'html' input passes raw, behind the raw_html_input acknowledgment).
  ctaInputParams: {
    to:      { kind: 'recipient', type: 'email' },
    subject: { kind: 'content' },
    html:    { kind: 'content', html: true },
  },
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

    await assertNotOptedOut(db, 'mms', to);
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

/**
 * phone_outbound_sync
 * One bounded run of the outbound-SMS delivery sync (phone-delivery S1 —
 * ref/PHONE_DELIVERY_DESIGN.md): recovers outbound texts the webhook path
 * dropped and stamps phone_event_log.delivery_* from the provider's verdict.
 * Driven by the "Phone Outbound Delivery Sync" recurring job; also run by
 * hand with explicit since/until/backfill for the S4 backfill.
 */
fns.phone_outbound_sync = async (params = {}, db) => {
  const sync = require('../../services/phoneDeliveryService'); // lazy require (convention)
  const output = await sync.runSync(db, {
    since: params.since,
    until: params.until,
    backfill: params.backfill === true || params.backfill === 'true',
    maxPages: params.max_pages,
  });
  console.log(
    `[PHONE DELIVERY] enabled=${output.enabled} ${output.skipped ? `skipped=${output.skipped} ` : ''}` +
    `window=${output.since}..${output.until} backfill=${output.backfill} groups=${output.groups} ` +
    `pages=${output.pages} listed=${output.listed} ingested=${output.ingested} stamped=${output.stamped} ` +
    `unchanged=${output.unchanged} dispatched=${output.dispatched ?? 0} fetch_err=${output.fetch_errors} ` +
    `ingest_err=${output.ingest_errors} dispatch_err=${output.dispatch_errors ?? 0}`
  );
  return { success: true, output };
};

fns.phone_outbound_sync.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the "Phone Outbound Delivery Sync" recurring job
  description:
    'Internal: one bounded run of the phone outbound delivery sync — lists each provider\'s outbound ' +
    'SMS in a window through the line\'s adapter, ingests any the webhooks dropped (idempotent on the ' +
    '(provider, provider_ref) key) and stamps delivery status (delivery_state/_reason/_code) on ' +
    'phone_event_log. Fail-closed on app_settings phone_delivery_sync_enabled != "1". Driven by its ' +
    'recurring job — do not add to workflows. Not CTA-eligible. ref/PHONE_DELIVERY_DESIGN.md.',
  params: [
    { name: 'since', type: 'string', required: false,
      description: 'Window start (ISO datetime). Default: 48 h ago. Set explicitly for the S4 backfill.' },
    { name: 'until', type: 'string', required: false,
      description: 'Window end (ISO datetime). Default: now.' },
    { name: 'backfill', type: 'boolean', required: false,
      description: 'true = backfill semantics (ref/PHONE_DELIVERY_DESIGN.md §6): Layer-3 automation rules are SKIPPED (recorded as metadata.automation.skipped="backfill") and recovered events carry extra.backfill=true. Never set on the recurring job.' },
    { name: 'max_pages', type: 'integer', required: false,
      description: 'Pages per provider group this run may list (100 records each). Default 10.' },
  ],
  example: {},
};

module.exports = fns;
