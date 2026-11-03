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
 *     attachment_names,   // legacy csv string, Pabbly only
 *     signature,          // OPT-IN boolean, default false. When true, the
 *                         //   sender's email_credentials.signature_html/_text
 *                         //   are appended to the bodies after normalization.
 *                         //   No-op when the sender row has no signature.
 *   })
 *
 * Internal entry point added in Slice 2:
 *   sendEmailDirect(db, emailRow, opts)
 *     Bypasses the email_credentials lookup. Caller supplies a pre-built
 *     emailRow (loaded from DB or synthesized). Used by the diagnostic
 *     test route to send through the Gmail adapter without flipping any
 *     production email_credentials row's provider column, and by the comms
 *     hub's compose/reply (services/mailbox/mailboxSendService.js, mailbox
 *     S3), which sends as a mailbox through its send_credential_id row.
 *     sendEmail remains the normal public entry point.
 *
 *   HUB-ONLY OPTIONS (mailbox S3) — sendEmailDirect only:
 *     cc, bcc            address strings (bcc reaches the Gmail adapter's
 *                        MIME so Gmail can deliver it; nodemailer strips it
 *                        from what recipients see)
 *     in_reply_to        '<id>' — the reply's parent
 *     references         '<root> … <parent>' — the threading chain
 *     message_id         '<id>' — a caller-chosen Message-ID (the hub needs
 *                        the SMTP copy it APPENDs to Sent to carry the same
 *                        one; Gmail rewrites it on its own sends anyway)
 *     thread_id          Gmail API threadId (gmail adapter only) — files the
 *                        reply in the sender's existing Gmail conversation
 *   The public sendEmail STRIPS them (HUB_ONLY_OPTIONS): every automation /
 *   workflow / campaign send stays byte-identical whatever keys its caller
 *   happens to pass. The adapters only set a header when its option is
 *   present, so a call without them builds exactly what it built before.
 *   Grant checks are NOT here (design D6): the hub's route checks can_send.
 *
 *   MARKETING-ONLY OPTIONS (YisraMail T1, ref/YISRAMAIL_DESIGN.md §5.2) —
 *   sendEmailDirect only, and only together with a bulk_ok row. Two callers
 *   send bulk:true, both in campaignService.executeSend: the campaign
 *   MARKETING path (C2 — headers, reply_to, tags, log_body:false) and an
 *   operational campaign confirmed over the cap (C1, D16 — tags only: no
 *   headers, no reply_to, no footer):
 *     bulk               true = the caller asserts it IS a campaign bulk send
 *                        (marketing, or operational over the cap). Required to
 *                        send from a bulk_ok row; refused on any other row.
 *     headers            { 'List-Unsubscribe', 'List-Unsubscribe-Post',
 *                          'List-Id' } — nothing else (MARKETING_HEADERS; keys
 *                        matched case-insensitively, passed on canonical);
 *                        string values, no CR/LF/NUL, ≤ 998 bytes
 *     reply_to           ONE address (the comms hub's parseRecipient rule)
 *     tags               { key: value } — [A-Za-z0-9_-]{1,256} each, ≤ 10;
 *                        reach the wire only through the row's DRIVER
 *     log_body           false = the email_log row keeps the envelope and
 *                        delivery_info but NOT the body (LOG_BODY_OMITTED in its
 *                        place — C2: the campaign's send_snapshot is the copy).
 *                        Only with headers carrying List-Unsubscribe (i.e. a
 *                        marketing broadcast — the over-cap D16 send carries no
 *                        headers, so it always logs its body), and only on an
 *                        adapter declaring log_without_body. Any value but
 *                        false / absent is refused.
 *   Refusals (Error, .code = the name, message starts with it):
 *     bulk_row_requires_marketing_path   bulk_ok row without bulk:true — keeps
 *                                        the hub, the diagnostic route and
 *                                        every automation off the SES row even
 *                                        when they load it directly (the code
 *                                        name predates D16: campaign bulk sends
 *                                        of either kind pass bulk:true)
 *     bulk_requires_bulk_row             bulk:true on a row that is not bulk_ok
 *     marketing_options_require_bulk     headers / reply_to / tags / log_body
 *                                        without bulk:true (a programming
 *                                        error, never stripped silently)
 *     marketing_header_refused           a header outside the allowlist, or a
 *                                        bad value
 *     marketing_reply_to_invalid / marketing_tags_invalid
 *     marketing_log_body_refused         log_body anything but false, or false
 *                                        without a List-Unsubscribe header
 *     adapter_lacks_capability           the row's adapter does not declare
 *                                        bulk / headers / tags (gmail, pabbly
 *                                        never see these options), or a row
 *                                        names a driver on an adapter that
 *                                        cannot carry its headers
 *     unknown_events_driver              email_credentials.events_driver names
 *                                        no entry of DRIVERS
 *     events_driver_requires_bulk        a driver on a row that is not bulk_ok —
 *                                        a driver belongs to the marketing
 *                                        transport only (its headers must never
 *                                        ride operational or hub mail); a
 *                                        hand-edited row fails loudly
 *   The public sendEmail STRIPS all five (MARKETING_ONLY_OPTIONS, like
 *   HUB_ONLY_OPTIONS) and refuses a bulk_ok row outright: bulk_sender_refused
 *   (campaignService.isTransientError classifies it permanent).
 *
 * Drivers (services/adapters/email/drivers/<name>.js — contract in ses.js):
 *   email_credentials.events_driver → DRIVERS (whitelist, no dynamic
 *   require), on bulk_ok rows only. sendEmailDirect hands the adapter
 *   `driver` (absent when the column is NULL); the adapter merges driver.headersFor({emailRow, tags})
 *   AFTER the caller's allowlisted headers and returns info.providerMessageId
 *   from driver.messageIdFromResponse(info.response).
 *
 * Adapter contract (services/adapters/email/<provider>.js):
 *   module.exports = {
 *     capabilities: { html, attachments_inline, attachments_url,
 *                     bulk,      // may send from a bulk_ok row (campaign bulk sends)
 *                     headers,   // carries `headers` / `replyTo` and a driver's headers
 *                     tags,      // forwards `tags` to the row's driver
 *                     log_without_body, // honours logBody:false (C2)
 *                     batch,     // one call, many recipients (none yet)
 *                     events },  // the ADAPTER parses provider events (none —
 *                                //   events belong to the driver)
 *     async sendEmail(db, {
 *       from, fromName, to, subject,
 *       text, html,          // already normalized; both populated
 *       attachments,         // smtp-style inline, may be empty
 *       attachmentUrls,      // raw input (string/object/array) — adapter parses
 *       attachmentNames,     // raw legacy csv, may be undefined
 *       credential,          // credentials row, null when emailRow.credential_id is null
 *       emailRow,            // full email_credentials row (or synthesized one)
 *       // bulk:true sends only (absent otherwise):
 *       headers, replyTo, tags,
 *       logBody,             // false only (C2 marketing); absent = log the body
 *       driver,              // absent when emailRow.events_driver is NULL
 *     }) → providerResult    // smtp: nodemailer info + providerMessageId
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
  gmail:  require('./adapters/email/gmail'),
};

// Whitelist of email_credentials.events_driver → driver module (T1). Same
// reason as ADAPTERS: never require() a DB-controlled string.
const DRIVERS = {
  ses: require('./adapters/email/drivers/ses'),
};

// -------------------- MARKETING PATH (T1) --------------------

/** The headers a marketing caller may set (§5.2 base allowlist), canonical case. */
const MARKETING_HEADERS = Object.freeze(['List-Unsubscribe', 'List-Unsubscribe-Post', 'List-Id']);
const HEADER_VALUE_MAX_BYTES = 998;     // RFC 5322 line limit
const TAG_RE = /^[A-Za-z0-9_-]{1,256}$/;
const TAGS_MAX = 10;

function fenceError(code, detail) {
  const err = new Error(`${code}: ${detail}`);
  err.code = code;
  return err;
}

/**
 * A bulk_ok row. FAIL CLOSED: anything but an explicit 0 / false / NULL counts
 * (mysql2 returns tinyint as a number; a synthesized row may carry true / '1').
 */
function isBulkRow(row) {
  if (!row || row.bulk_ok == null || row.bulk_ok === false) return false;
  return Number(row.bulk_ok) !== 0;
}

function rowLabel(row) {
  return `email_credentials ${row && row.id != null ? row.id : '<synthesized>'} (${row && row.email})`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** headers → { canonicalName: value } or throw marketing_header_refused. */
function canonicalHeaders(headers) {
  if (!isPlainObject(headers)) throw fenceError('marketing_header_refused', 'headers must be an object');
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const canon = MARKETING_HEADERS.find((h) => h.toLowerCase() === String(key).toLowerCase());
    if (!canon) {
      throw fenceError('marketing_header_refused',
        `"${String(key).slice(0, 60)}" is not an allowed header (allowed: ${MARKETING_HEADERS.join(', ')})`);
    }
    if (Object.prototype.hasOwnProperty.call(out, canon)) throw fenceError('marketing_header_refused', `${canon} given twice`);
    if (typeof value !== 'string' || value === '') throw fenceError('marketing_header_refused', `${canon} must be a non-empty string`);
    if (/[\r\n\0]/.test(value)) throw fenceError('marketing_header_refused', `${canon} contains CR, LF or NUL`);
    if (Buffer.byteLength(value, 'utf8') > HEADER_VALUE_MAX_BYTES) {
      throw fenceError('marketing_header_refused', `${canon} is longer than ${HEADER_VALUE_MAX_BYTES} bytes`);
    }
    out[canon] = value;
  }
  return out;
}

/** reply_to → one formatted address, by the comms hub's own rule (mailboxSendService.parseRecipient). */
function canonicalReplyTo(replyTo) {
  if (typeof replyTo !== 'string') throw fenceError('marketing_reply_to_invalid', 'reply_to must be one address string');
  // lazy require: mailboxSendService requires this module at load.
  const { parseRecipient, formatAddr } = require('./mailbox/mailboxSendService');
  try {
    return formatAddr(parseRecipient(replyTo, 'reply_to'));
  } catch (err) {
    throw fenceError('marketing_reply_to_invalid', err.message);
  }
}

function canonicalTags(tags) {
  if (!isPlainObject(tags)) throw fenceError('marketing_tags_invalid', 'tags must be an object');
  const entries = Object.entries(tags);
  if (entries.length > TAGS_MAX) throw fenceError('marketing_tags_invalid', `at most ${TAGS_MAX} tags`);
  for (const [k, v] of entries) {
    if (!TAG_RE.test(k) || typeof v !== 'string' || !TAG_RE.test(v)) {
      throw fenceError('marketing_tags_invalid', `tag "${String(k).slice(0, 60)}" — keys and values are 1–256 of A-Z a-z 0-9 _ -`);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * email_credentials.events_driver → the driver module, null when unset.
 * A driver on a non-bulk row, or an unknown one → throw (fail closed).
 */
function resolveDriver(emailRow) {
  const name = emailRow && emailRow.events_driver;
  if (name == null || name === '') return null;
  if (!isBulkRow(emailRow)) {
    throw fenceError('events_driver_requires_bulk', `${rowLabel(emailRow)} names events_driver "${String(name).slice(0, 40)}" but is not a bulk_ok row`);
  }
  if (!Object.prototype.hasOwnProperty.call(DRIVERS, name)) {
    throw fenceError('unknown_events_driver', `${rowLabel(emailRow)} names events_driver "${String(name).slice(0, 40)}"`);
  }
  return DRIVERS[name];
}

/**
 * The T1 fence, run by sendEmailDirect before dispatch. → what the adapter
 * receives: { marketing, headers, replyTo, tags, driver }.
 */
function marketingDispatch(emailRow, adapter, { bulk, headers, reply_to, tags, log_body }) {
  const caps = adapter.capabilities || {};
  const hasHeaders = headers !== undefined && headers !== null;
  const hasReplyTo = reply_to !== undefined && reply_to !== null;
  const hasTags    = tags !== undefined && tags !== null;
  const bulkRow = isBulkRow(emailRow);

  if (bulkRow && bulk !== true) {
    throw fenceError('bulk_row_requires_marketing_path',
      `${rowLabel(emailRow)} is a marketing (bulk) transport; only a campaign bulk send (bulk:true — the marketing path, or an operational campaign confirmed over the cap) may send from it`);
  }
  if (bulk === true && !bulkRow) {
    throw fenceError('bulk_requires_bulk_row', `${rowLabel(emailRow)} is not a bulk_ok row`);
  }
  const hasLogBody = log_body !== undefined && log_body !== null;
  if (bulk !== true && (hasHeaders || hasReplyTo || hasTags || hasLogBody)) {
    throw fenceError('marketing_options_require_bulk', 'headers / reply_to / tags / log_body are campaign bulk-send options (bulk:true) only');
  }

  const driver = resolveDriver(emailRow);
  if (driver && !caps.headers) {
    throw fenceError('adapter_lacks_capability', `${rowLabel(emailRow)}: provider ${emailRow.provider} cannot carry driver ${driver.name} headers`);
  }
  if (bulk !== true) return { marketing: false, driver };

  if (!caps.bulk) throw fenceError('adapter_lacks_capability', `provider ${emailRow.provider} cannot send bulk`);
  if ((hasHeaders || hasReplyTo) && !caps.headers) throw fenceError('adapter_lacks_capability', `provider ${emailRow.provider} cannot set headers`);
  if (hasTags && !caps.tags) throw fenceError('adapter_lacks_capability', `provider ${emailRow.provider} cannot carry tags`);

  const canonHeaders = hasHeaders ? canonicalHeaders(headers) : undefined;
  // log_body:false (C2): the marketing broadcast's email_log row drops its
  // body. FAIL CLOSED: exactly false, and only on a send carrying
  // List-Unsubscribe — the over-cap D16 send (no headers) always logs its body.
  if (hasLogBody) {
    if (log_body !== false) throw fenceError('marketing_log_body_refused', 'log_body may only be false');
    if (!canonHeaders || !canonHeaders['List-Unsubscribe']) {
      throw fenceError('marketing_log_body_refused', 'log_body:false needs a List-Unsubscribe header (the marketing broadcast only)');
    }
    if (!caps.log_without_body) throw fenceError('adapter_lacks_capability', `provider ${emailRow.provider} cannot omit the logged body`);
  }

  return {
    marketing: true,
    headers: canonHeaders,
    replyTo: hasReplyTo ? canonicalReplyTo(reply_to) : undefined,
    tags:    hasTags ? canonicalTags(tags) : undefined,
    ...(hasLogBody ? { logBody: false } : {}),
    driver,
  };
}

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
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
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

/**
 * Coerce a body value to something htmlToText / textToHtml can call .replace on.
 *
 * WHY (MTH-2 / Fix D): lib/workflow_engine.resolvePlaceholders has a deliberate
 * single-placeholder fast path — when a param's value is EXACTLY one `{{token}}`
 * and that token resolves to a non-primitive, the object/array is passed through
 * UNSTRINGIFIED (an MMS attachment array must survive; String() would turn it
 * into "[object Object],[object Object]"). Do not "fix" that in the engine.
 *
 * The consequence lands here: a workflow that pipes a json-typed `query_ai`
 * output var straight into send_email's `text`/`html` (wf29 did exactly this,
 * 2026-07-02) hands emailService an OBJECT, and textToHtml's `text.replace(...)`
 * throws "text.replace is not a function" — the whole workflow step dies.
 * "AI output → email body" is a first-class authoring pattern here, so the
 * chokepoint hardens instead of the engine.
 *
 * Coerce, never throw: a delivered email containing pretty-printed JSON beats a
 * dead workflow step at a law firm.
 *
 * Contract:
 *   null / undefined / ''  → returned as-is, so they stay FALSY and the
 *                            `!text && !html` throw plus the `||` fallbacks
 *                            below keep their exact existing semantics.
 *   string                 → returned unchanged (same reference). This is the
 *                            regression bar: string inputs must round-trip
 *                            byte-identically through htmlToText/textToHtml.
 *   object / array         → JSON.stringify(v, null, 2)
 *   other primitives       → String(v)   (number, boolean, bigint…)
 */
function _coerceBody(v) {
  if (v == null || v === '') return v;      // preserve falsiness exactly
  if (typeof v === 'string') return v;      // hot path — untouched
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      // Circular reference / BigInt inside. Still don't throw — a useless body
      // beats a failed send.
      return String(v);
    }
  }
  return String(v);
}

function normalizeBodies(text, html) {
  // Coerce ONCE, at the top, on both args — every downstream consumer
  // (htmlToText, textToHtml, the adapters) then sees a string or a falsy value.
  const t = _coerceBody(text);
  const h = _coerceBody(html);
  if (!t && !h) throw new Error('Email requires at least one of: text, html');
  return {
    text: t || htmlToText(h),
    html: h || textToHtml(t),
  };
}

// -------------------- INTERNAL: sendEmailDirect --------------------

/**
 * Internal entry point — dispatches to a provider adapter using a
 * pre-built emailRow. The public sendEmail wraps this with an
 * email_credentials lookup. Slice 2 added this so the diagnostic test
 * route can test Gmail without flipping any production row's `provider`
 * column.
 *
 * Validation + body normalization is performed here so direct callers
 * don't need to repeat it. When sendEmail forwards already-normalized
 * bodies, the second normalize call is a no-op (both fields are set).
 *
 * @param {object} db
 * @param {object} emailRow
 *   Required: email, provider, from_name. Optional: id, credential_id,
 *   smtp_host/port/user/pass/secure (smtp adapter only). May be a real
 *   row from the email_credentials table, or a synthesized object with
 *   the same shape.
 * @param {object} opts                same shape as sendEmail's opts
 * @returns provider result
 */
async function sendEmailDirect(db, emailRow, {
  from, to, subject,
  text, html,
  attachments = [],
  attachment_urls,
  attachment_names,
  signature = false,
  // HUB-ONLY OPTIONS (header) — absent for every caller but the comms hub.
  cc, bcc, in_reply_to, references, message_id, thread_id,
  // MARKETING-ONLY OPTIONS (header, T1) — campaign bulk sends only.
  bulk, headers, reply_to, tags, log_body,
}) {
  if (!from || !to || !subject) {
    throw new Error('Missing required email fields (from, to, subject)');
  }
  // If sendEmail already normalized, this is a cheap no-op (both fields set).
  const bodies = normalizeBodies(text, html);

  // ── Signature append — OPT-IN ──
  // Nothing happens unless the caller passes signature: true AND the sender
  // row has a stored signature. Every pre-existing call site omits the flag,
  // so their output is byte-identical to before this feature existed.
  // Appended AFTER normalization on purpose: signature HTML must never be
  // run through htmlToText body derivation, and vice versa. When only one
  // side is stored, the other is derived so the multipart halves agree.
  if (signature && (emailRow.signature_html || emailRow.signature_text)) {
    const sigHtml = emailRow.signature_html || textToHtml(emailRow.signature_text);
    const sigText = emailRow.signature_text || htmlToText(emailRow.signature_html);
    bodies.html = bodies.html + '<br><br>' + sigHtml;
    bodies.text = bodies.text + '\n\n' + sigText;
  }

  if (!emailRow || !emailRow.provider) {
    throw new Error('sendEmailDirect requires emailRow with a provider');
  }
  const adapter = ADAPTERS[emailRow.provider];
  if (!adapter) {
    throw new Error(`Unknown email provider '${emailRow.provider}' for sender: ${from}`);
  }

  // T1 fence: bulk rows only via bulk:true, marketing options only with it,
  // and the row's driver (if any) resolved — all BEFORE any provider call.
  const mkt = marketingDispatch(emailRow, adapter, { bulk, headers, reply_to, tags, log_body });

  // Load credential if linked.
  let credential = null;
  if (emailRow.credential_id) {
    credential = await loadCredential(db, emailRow.credential_id);
    if (!credential) {
      throw new Error(
        `email_credentials ${emailRow.id ?? '<synthesized>'} references credential ` +
        `${emailRow.credential_id} but it was not found`
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
    // Hub-only (S3): undefined for every other caller, and each adapter sets
    // a header only when its value is present.
    cc,
    bcc,
    inReplyTo:  in_reply_to,
    references,
    messageId:  message_id,
    threadId:   thread_id,
    // Bulk path (T1): present only on a bulk:true send; the driver only when
    // the row names one; logBody only when C2's marketing send passes false.
    ...(mkt.marketing && { headers: mkt.headers, replyTo: mkt.replyTo, tags: mkt.tags }),
    ...(mkt.logBody === false && { logBody: false }),
    ...(mkt.driver && { driver: mkt.driver }),
  });
}

/**
 * The options only the comms hub may pass (sendEmailDirect). The public
 * sendEmail drops them so an automation caller can never start setting
 * headers it did not set before (see HUB-ONLY OPTIONS in the header).
 */
const HUB_ONLY_OPTIONS = Object.freeze(['cc', 'bcc', 'in_reply_to', 'references', 'message_id', 'thread_id']);

/**
 * The options only a campaign bulk send may pass (sendEmailDirect with a
 * bulk_ok row: the marketing path, or an operational campaign over the cap).
 * The public sendEmail drops them the same way.
 */
const MARKETING_ONLY_OPTIONS = Object.freeze(['bulk', 'headers', 'reply_to', 'tags', 'log_body']);

/** The public sendEmail's copy of opts: hub-only AND marketing-only options removed. */
function withoutDirectOnlyOptions(opts) {
  const out = { ...opts };
  for (const k of HUB_ONLY_OPTIONS) delete out[k];
  for (const k of MARKETING_ONLY_OPTIONS) delete out[k];
  return out;
}

// -------------------- PUBLIC: sendEmail --------------------

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
 * @param {boolean} [opts.signature=false] - append the sender's stored signature
 */
async function sendEmail(db, opts) {
  const { from, to, subject, text, html } = opts || {};

  // Validate + normalize bodies BEFORE the DB lookup, to preserve original
  // error ordering when both `text/html missing` and `creds not found` could
  // fire. normalizeBodies throws the same message the old explicit check did.
  if (!from || !to || !subject) {
    throw new Error('Missing required email fields (from, to, subject)');
  }
  const bodies = normalizeBodies(text, html);

  const [[emailRow]] = await db.query(
    'SELECT * FROM email_credentials WHERE email = ? LIMIT 1',
    [from]
  );
  if (!emailRow) {
    throw new Error(`No credentials found for sender: ${from}`);
  }
  // A marketing transport is never an automation / workflow / campaign
  // sender (§5.2). Permanent — campaignService.isTransientError says so.
  if (isBulkRow(emailRow)) {
    throw fenceError('bulk_sender_refused',
      `${emailRow.email} is a marketing transport; automation, workflows and operational campaigns cannot send from it`);
  }

  // Forward already-normalized bodies; sendEmailDirect will idempotently
  // re-normalize for direct callers. Hub-only and marketing-only options never
  // pass this way.
  return sendEmailDirect(db, emailRow, {
    ...withoutDirectOnlyOptions(opts),
    text: bodies.text,
    html: bodies.html,
  });
}

const VALID_PROVIDERS = Object.freeze(Object.keys(ADAPTERS));
const VALID_EVENTS_DRIVERS = Object.freeze(Object.keys(DRIVERS));

/** driver_config check for the editor route: null = valid (or no driver), else the message. */
function validateDriverConfig(driverName, cfg) {
  if (driverName == null || driverName === '') {
    return cfg == null ? null : 'driver_config needs an events_driver';
  }
  if (!Object.prototype.hasOwnProperty.call(DRIVERS, driverName)) return `unknown events_driver "${String(driverName).slice(0, 40)}"`;
  return DRIVERS[driverName].validateConfig(cfg);
}

// normalizeBodies is exported as a TEST SEAM (pure function, no SMTP/adapters).
// Additive — nothing else imports it.
module.exports = {
  sendEmail, sendEmailDirect, VALID_PROVIDERS, normalizeBodies, HUB_ONLY_OPTIONS,
  // htmlToText: C2's marketing text part builds on it (campaignService.textPartFor).
  htmlToText,
  // T1
  MARKETING_ONLY_OPTIONS, MARKETING_HEADERS, VALID_EVENTS_DRIVERS, isBulkRow, validateDriverConfig,
};