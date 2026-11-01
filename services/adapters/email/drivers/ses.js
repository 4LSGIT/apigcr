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
//   events                        null until T2 fills { verify, parse }
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

module.exports = {
  name: 'ses',
  HEADERS,
  validateConfig,
  headersFor,
  messageIdFromResponse,
  // T2 fills { verify(req, credential) → bool, parse(req) → [event] } (§5.2's
  // shape). Nothing reads it before then.
  events: null,
};
