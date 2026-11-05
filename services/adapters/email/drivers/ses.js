// services/adapters/email/drivers/ses.js
//
// Amazon SES events driver (YisraMail T1 — ref/YISRAMAIL_DESIGN.md §5.2).
//
// A DRIVER is the provider-specific half of a transport that the adapter
// itself does not know about: the send stays plain SMTP through the smtp
// adapter, and the driver only (1) adds its own correlation headers at send,
// (2) reads the provider's message id out of the SMTP reply, and (3) — T2 —
// verifies and parses the provider's event webhooks. It is chosen by
// email_credentials.events_driver — on bulk_ok rows only (emailService throws
// events_driver_requires_bulk otherwise) — through emailService's DRIVERS
// whitelist (never a dynamic require) and handed to the adapter as `driver`.
//
// Contract (every driver):
//   HEADERS                       frozen list of the ONLY header names the
//                                 driver may add — the smtp adapter throws on
//                                 any other name headersFor returns
//   validateConfig(cfg) → string|null
//                                 email_credentials.driver_config check
//                                 (null = valid); the editor route refuses a
//                                 bad value with this message, headersFor
//                                 throws on one at send
//   headersFor({ emailRow, tags }) → { name: value }
//   messageIdFromResponse(response) → string|null
//   events                        { verify(req, hook) → bool, parse(body) → [event],
//                                   parseDetailed(body) → {events, ignored, unknown_shape, errors} }
//                                   (T2, below; mail_event_ingest calls it)
//
// SES over SMTP:
//   X-SES-CONFIGURATION-SET  from driver_config.configuration_set; omitted when
//                            absent — the identity's default configuration set
//                            then applies (news.4lsg.com's default is
//                            yisramail-marketing, P0).
//   X-SES-MESSAGE-TAGS       `k=v, k=v` from `tags` (emailService has already
//                            held each key and value to [A-Za-z0-9_-]{1,256},
//                            ≤ 10 entries); omitted when there are none.
//   SES strips both before delivery; the tags come back on its events.
//
// The 250 reply: SES answers DATA with `250 Ok <ses-message-id>` (the id its
// events carry, NOT the Message-ID header). The exact form is confirmed by
// scripts/yisramailT1Acceptance.js --send on the real account; anything that
// does not parse is null, never a throw — the send itself succeeded.

'use strict';

const HEADERS = Object.freeze(['X-SES-CONFIGURATION-SET', 'X-SES-MESSAGE-TAGS']);

// SES configuration-set names: letters, digits, '_' and '-', 1–64.
const CONFIG_SET_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONFIG_KEYS = Object.freeze(['configuration_set']);

// `250 Ok 0100018b5f6a1b2c-1a2b3c4d-…-000000` (angle brackets tolerated).
const RESPONSE_RE = /^250[ -]Ok <?([A-Za-z0-9][A-Za-z0-9._-]{9,254})>?\s*$/i;

/** driver_config as stored: mysql2 hands a JSON column back parsed; a synthesized row may carry the string. */
function parseConfig(cfg) {
  if (cfg == null) return null;
  if (typeof cfg === 'string') {
    try { return JSON.parse(cfg); } catch (_) { return undefined; }
  }
  return cfg;
}

function validateConfig(raw) {
  const cfg = parseConfig(raw);
  if (cfg === null) return null;
  if (cfg === undefined || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return 'driver_config for ses must be an object like {"configuration_set": "yisramail-marketing"}';
  }
  for (const k of Object.keys(cfg)) {
    if (!CONFIG_KEYS.includes(k)) return `driver_config for ses: unknown key "${String(k).slice(0, 40)}" (allowed: ${CONFIG_KEYS.join(', ')})`;
  }
  if (cfg.configuration_set !== undefined && cfg.configuration_set !== null &&
      (typeof cfg.configuration_set !== 'string' || !CONFIG_SET_RE.test(cfg.configuration_set))) {
    return 'driver_config.configuration_set must be 1–64 letters, digits, "_" or "-"';
  }
  return null;
}

function headersFor({ emailRow, tags } = {}) {
  const problem = validateConfig(emailRow && emailRow.driver_config);
  if (problem) {
    throw new Error(`ses driver: email_credentials ${emailRow && emailRow.id} — ${problem}`);
  }
  const cfg = parseConfig(emailRow && emailRow.driver_config);
  const out = {};
  if (cfg && cfg.configuration_set) out['X-SES-CONFIGURATION-SET'] = cfg.configuration_set;
  const pairs = tags ? Object.entries(tags) : [];
  if (pairs.length) out['X-SES-MESSAGE-TAGS'] = pairs.map(([k, v]) => `${k}=${v}`).join(', ');
  return out;
}

function messageIdFromResponse(response) {
  if (typeof response !== 'string') return null;
  const m = RESPONSE_RE.exec(response.trim());
  return m ? m[1] : null;
}


// ─────────────────────────────────────────────────────────────
// EVENTS (T2) — SES → EventBridge → hook ses-events → mail_event_ingest
// ─────────────────────────────────────────────────────────────
//
// The hook target hands mail_event_ingest the EventBridge event (params_mapping
// event ← body):
//   { version, id, "detail-type", source: "aws.ses", account, time, region,
//     resources, detail: <the SES event: { eventType, mail, bounce | delivery |
//     complaint | reject | deliveryDelay | failure | send }> }
// CONFIRMED on captured events (step 0, 2026-11-01, hook_executions
// 36158–36169 → tests/fixtures/ses-events/<type>.json): the envelope, `id`,
// `source`, `detail`, eventType Send / Delivery / Bounce / Complaint, mail.
// messageId, mail.tags (our two tags among SES's own ses:* tags, every value
// a one-string array), and the Delivery / Bounce (Permanent General,
// Transient General — no diagnosticCode —, Permanent EmailValidationSuppressed)
// / Complaint (abuse) sub-objects as read below. Still VERIFY(step0) — the
// simulator cannot produce them, shapes from AWS's documentation: Reject,
// DeliveryDelay, Rendering Failure (marked where they are read).
//
// One SES event names N recipients → N normalized events, each with
// provider_event_id `<eventbridge id>:<recipient>` (the consent ledger's
// uk_source_event idempotency key — one ledger row per recipient). A
// recipient long enough to push that past the ledger's 128 characters is
// replaced by a sha256 prefix (never truncated: a truncation could collide).
//
// Never throws: a body that is not an SES event, or a type whose shape is not
// the one documented, is COUNTED (errors / unknown_shape) and yields nothing,
// so one bad event never fails the hook execution of the others.

const crypto = require('crypto');

/** Normalized types (§5.2). `unsubscribe` is never produced: SES list management is not used (YC owns unsubscribe). */
const EVENT_TYPES = Object.freeze(['delivered', 'bounce_hard', 'bounce_soft', 'complaint', 'reject', 'rendering_failure', 'open', 'click']);
const PROVIDER_EVENT_ID_MAX = 128;   // comm_consent_events.provider_event_id
const DIAGNOSTIC_MAX = 255;          // campaign_results.delivery_diag
const TAG_KEYS = Object.freeze(['campaign_id', 'result_id']);

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function eventIdFor(ebId, recipient) {
  const id = `${ebId}:${recipient}`;
  if (id.length <= PROVIDER_EVENT_ID_MAX) return id;
  return `${ebId}:sha256:${crypto.createHash('sha256').update(recipient).digest('hex').slice(0, 40)}`;
}

/** mail.tags: { key: [value] } — every tag an array of one string (captured); SES's ses:* tags are ignored. */
function tagsOf(mail) {
  const out = {};
  const t = isObj(mail && mail.tags) ? mail.tags : {};
  for (const k of TAG_KEYS) {
    const v = Array.isArray(t[k]) ? t[k][0] : t[k];
    out[k] = str(v);
  }
  return out;
}

function clip(s, n) { return s == null ? null : String(s).slice(0, n); }

/** Recipient objects ({emailAddress, …}) or plain address strings → [{address, item}]. */
function recipientsOf(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const r of list) {
    const addr = str(isObj(r) ? r.emailAddress : r);
    if (addr) out.push({ address: addr.toLowerCase(), item: isObj(r) ? r : {} });
  }
  return out;
}

/**
 * One SES eventType → { type?, recipients, at, diagnostic(item), raw(item), ignore? }.
 * Delivery / Bounce / Complaint: confirmed on captured events. Reject /
 * DeliveryDelay / Rendering Failure: VERIFY(step0).
 */
const SHAPES = Object.freeze({
  Delivery: (d) => (isObj(d.delivery) ? {                                             // captured: delivery.json
    type: () => 'delivered',
    recipients: recipientsOf(d.delivery.recipients),                                   // an array of address strings
    at: d.delivery.timestamp,
    diagnostic: () => clip(str(d.delivery.smtpResponse), DIAGNOSTIC_MAX),
    raw: () => ({ smtpResponse: d.delivery.smtpResponse || null, reportingMTA: d.delivery.reportingMTA || null }),
  } : null),
  Bounce: (d) => (isObj(d.bounce) ? {                                                  // captured: bounce-permanent / -transient / -suppressed.json
    // Permanent → hard (ledger opt-out). Transient AND Undetermined → soft:
    // an undetermined bounce never opts anyone out.
    type: () => (d.bounce.bounceType === 'Permanent' ? 'bounce_hard' : 'bounce_soft'),
    recipients: recipientsOf(d.bounce.bouncedRecipients),                              // [{emailAddress, diagnosticCode?, status?, action?}] — a Transient one carries only emailAddress
    at: d.bounce.timestamp,
    diagnostic: (item) => clip(str(item.diagnosticCode) || [d.bounce.bounceType, d.bounce.bounceSubType].filter(Boolean).join('/'), DIAGNOSTIC_MAX),
    raw: (item) => ({ bounceType: d.bounce.bounceType || null, bounceSubType: d.bounce.bounceSubType || null,
      status: item.status || null, action: item.action || null, feedbackId: d.bounce.feedbackId || null }),
  } : null),
  // A `not-spam` feedback report RETRACTS a complaint (AWS): ignored — no
  // opt-out, no alert, no status change (ruled 2026-11-02, T2 review r2).
  Complaint: (d) => (isObj(d.complaint) ? (d.complaint.complaintFeedbackType === 'not-spam' ? { ignore: true } : {   // captured: complaint.json (abuse); not-spam: AWS docs
    type: () => 'complaint',
    recipients: recipientsOf(d.complaint.complainedRecipients),
    at: d.complaint.timestamp,
    diagnostic: () => clip(str(d.complaint.complaintFeedbackType) || 'complaint', DIAGNOSTIC_MAX),
    raw: () => ({ complaintFeedbackType: d.complaint.complaintFeedbackType || null, feedbackId: d.complaint.feedbackId || null,
      complaintSubType: d.complaint.complaintSubType || null }),
  }) : null),
  // The three below are not producible from the mailbox simulator; their
  // shapes come from AWS's documentation (ruled 2026-11-02) and stay
  // VERIFY(step0) until a real one is captured (ref/plans.md). They touch
  // delivery columns only, never the ledger.
  Reject: (d) => (isObj(d.reject) ? {                                                  // VERIFY(step0)
    type: () => 'reject',
    recipients: recipientsOf(d.mail && d.mail.destination),
    at: null,
    diagnostic: () => clip(str(d.reject.reason) || 'rejected', DIAGNOSTIC_MAX),
    raw: () => ({ reason: d.reject.reason || null }),
  } : null),
  DeliveryDelay: (d) => (isObj(d.deliveryDelay) ? {                                    // VERIFY(step0)
    type: () => 'bounce_soft',
    recipients: recipientsOf(d.deliveryDelay.delayedRecipients),
    at: d.deliveryDelay.timestamp,
    diagnostic: (item) => clip(str(item.diagnosticCode) || str(d.deliveryDelay.delayType) || 'delivery delayed', DIAGNOSTIC_MAX),
    raw: (item) => ({ delayType: d.deliveryDelay.delayType || null, expirationTime: d.deliveryDelay.expirationTime || null, status: item.status || null }),
  } : null),
  'Rendering Failure': (d) => (isObj(d.failure) ? {                                    // VERIFY(step0): eventType spelled with a space
    type: () => 'rendering_failure',
    recipients: recipientsOf(d.mail && d.mail.destination),
    at: null,
    diagnostic: () => clip(str(d.failure.errorMessage) || 'rendering failure', DIAGNOSTIC_MAX),
    raw: () => ({ errorMessage: d.failure.errorMessage || null, templateName: d.failure.templateName || null }),
  } : null),
  // C6 engagement events — produced only once the config set publishes
  // Open/Click with the custom redirect domain. ENGAGEMENT axis: they never
  // touch delivery_status or the ledger (mailEventService branches on type).
  // Shapes confirmed on captured events (open.json / click.json, campaign
  // 120, 2026-11-05). isBotEvent is a STRING on the wire ("Unlikely" on the
  // captured pair) — a Likely-bot open/click is ignored like a not-spam
  // complaint: a scanner's click must not stamp engagement (clicks are the
  // honest metric). Anything that is not Likely/true counts: fail OPEN here,
  // an over-filtered click can never be recovered.
  Open: (d) => (isObj(d.open) ? (isBotEngagement(d.open.isBotEvent) ? { ignore: true } : {   // captured: open.json
    type: () => 'open',
    recipients: recipientsOf(d.mail && d.mail.destination),
    at: d.open.timestamp,
    diagnostic: () => null,
    raw: () => ({ ipAddress: d.open.ipAddress || null, userAgent: clip(str(d.open.userAgent), DIAGNOSTIC_MAX), isBotEvent: d.open.isBotEvent ?? null }),
  }) : null),
  Click: (d) => (isObj(d.click) ? (isBotEngagement(d.click.isBotEvent) ? { ignore: true } : {   // captured: click.json
    type: () => 'click',
    recipients: recipientsOf(d.mail && d.mail.destination),
    at: d.click.timestamp,
    diagnostic: () => null,
    raw: () => ({ link: clip(str(d.click.link), 512), ipAddress: d.click.ipAddress || null, userAgent: clip(str(d.click.userAgent), DIAGNOSTIC_MAX), isBotEvent: d.click.isBotEvent ?? null }),
  }) : null),
});
/** SES bot verdict on an engagement event → ignore? true / 'true' / 'Likely' only; anything else counts (fail open). */
function isBotEngagement(v) { return v === true || /^(likely|true)$/i.test(String(v)); }
// Published but carrying no delivery outcome or engagement: counted as ignored.
const IGNORED_EVENT_TYPES = Object.freeze(['Send', 'Subscription']);

/**
 * body → { events, ignored, unknown_shape, errors }. Never throws.
 * events: [{ type, provider_message_id, recipient, at, provider_event_id, tags, diagnostic, raw }]
 */
function parseDetailed(body) {
  const out = { events: [], ignored: 0, unknown_shape: 0, errors: [] };
  try {
    if (!isObj(body)) { out.errors.push('body is not an object'); return out; }
    if (body.source !== 'aws.ses') { out.errors.push(`source is ${JSON.stringify(body.source)}, not "aws.ses"`); return out; }
    const ebId = str(body.id);                     // the EventBridge event id (the hook's dedup_path body.id)
    const d = body.detail;
    if (!ebId || !isObj(d)) { out.errors.push('no event id or no detail'); return out; }
    const eventType = str(d.eventType);
    if (eventType && IGNORED_EVENT_TYPES.includes(eventType)) { out.ignored += 1; return out; }
    const shapeFn = eventType ? SHAPES[eventType] : null;
    const shape = shapeFn ? shapeFn(d) : null;
    if (shape && shape.ignore) { out.ignored += 1; return out; }
    if (!shape || !shape.recipients || !shape.recipients.length) { out.unknown_shape += 1; return out; }
    const mail = isObj(d.mail) ? d.mail : {};
    const messageId = str(mail.messageId);         // the id the T1 driver reads from the 250 reply (same shape, captured)
    const tags = tagsOf(mail);
    const atRaw = shape.at || mail.timestamp || body.time;
    const atDate = atRaw ? new Date(atRaw) : null;
    const at = atDate && !Number.isNaN(atDate.getTime()) ? atDate : null;
    for (const { address, item } of shape.recipients) {
      out.events.push({
        type: shape.type(item),
        provider_message_id: messageId,
        recipient: address,
        at,
        provider_event_id: eventIdFor(ebId, address),
        tags,
        diagnostic: shape.diagnostic(item),
        raw: { eventType, ...shape.raw(item) },
      });
    }
  } catch (err) {
    out.errors.push(`parse failed: ${err.message}`);
    out.events = [];
  }
  return out;
}

const events = {
  /**
   * Always true. The hook's own api_key auth (header x-api-key, the key in an
   * EventBridge Connection) authenticates the request before any target runs
   * — EventBridge API destinations sign nothing, so there is nothing more for
   * a driver to verify (SNS would be different: its certificate signature
   * would be checked here).
   */
  verify: () => true,
  parse: (body) => parseDetailed(body).events,
  parseDetailed,
};

module.exports = {
  name: 'ses',
  HEADERS,
  validateConfig,
  headersFor,
  messageIdFromResponse,
  // T2: { verify, parse, parseDetailed } — see EVENTS above.
  events,
  EVENT_TYPES,
  eventIdFor,
};
