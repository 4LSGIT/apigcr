// services/portalAuthService.js
//
// Client Portal Slice 1 — PIN auth logic. All logic lives here;
// routes/portal.auth.js stays thin.
//
// Security posture (the invariants, spelled out):
//   * NO ENUMERATION ORACLE. requestPin resolves to the same {ok:true} for
//     every internal branch (no match / multi-match / disabled / SMS-capped /
//     send-failed / sent). The route turns that into one identical 200.
//     External sends are fire-and-forget so response TIMING doesn't leak
//     found-vs-not-found either.
//   * Raw PINs are NEVER stored, logged, or returned after generation. Only
//     pin_hash = HMAC-SHA256(JWT_SECRET, pin) hex persists.
//   * NO `SELECT contacts.*` anywhere — contact_ssn lives on contacts.
//     Named columns only.
//   * Portal JWTs carry EXACTLY {sub, aud:'contact', ver} (+ iat/exp) —
//     never user_auth (the claim the two staff verify sites gate on).
//   * Multi-match sends NOTHING. Auth must never guess which contact the
//     identifier belongs to (booking's best-match behavior is explicitly
//     not the model here). The pin_multi_match access-log row is the
//     staff-visible signal to clean the data.

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSetting, getSettings } = require('./settingsService');
const phoneService = require('./phoneService');
const emailService = require('./emailService');
const { alert } = require('../lib/alerting');
const { _insertPortalAccessLog: insertPortalAccessLog } = require('../lib/auth.requireAuth');

const PIN_TTL_MINUTES = 10;
const PIN_MAX_ATTEMPTS = 5;
const ROUTE_REQUEST = '/api/portal/request-pin';
const ROUTE_VERIFY = '/api/portal/verify-pin';

// ── identifier parsing / resolution ─────────────────────────────────────────

/**
 * Pure parse — no DB. Phone rule: strip non-digits; drop a leading 1 when 11
 * digits (mirrors phoneService.normalizeE164's leading-1 handling); require
 * EXACTLY 10 after that (stricter than phoneService.tenDigit's last-10 slice
 * on purpose: auth input must not silently truncate a mistyped number into
 * someone else's). Email rule: trim; must contain '@'; matching is
 * case-insensitive via the tables' utf8mb4_general_ci collation.
 *
 * @returns {{kind:'phone'|'email', normalized:string} | {kind:null, normalized:null}}
 */
function parseIdentifier(identifier) {
  const raw = String(identifier ?? '').trim();
  if (!raw) return { kind: null, normalized: null };

  if (raw.includes('@')) {
    // Minimal sanity: something@something, no whitespace inside.
    if (/\s/.test(raw) || raw.indexOf('@') === 0 || raw.indexOf('@') === raw.length - 1) {
      return { kind: null, normalized: null };
    }
    return { kind: 'email', normalized: raw };
  }

  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return { kind: null, normalized: null };
  return { kind: 'phone', normalized: digits };
}

/**
 * Resolve an identifier to contact ids. UNION (not ALL) dedupes across the
 * three sources. contact_phones/contact_emails carry DB-enforced uniqueness
 * for ACTIVE values (uk_phone_active / uk_email_active), so multi-match is
 * only reachable via the legacy contacts columns.
 *
 * @returns {{kind, normalized, contactIds:number[]}}  kind null ⇒ malformed
 */
async function resolveIdentifier(db, identifier) {
  const parsed = parseIdentifier(identifier);
  if (!parsed.kind) return { kind: null, normalized: null, contactIds: [] };

  let sql, params;
  if (parsed.kind === 'phone') {
    sql = `
      SELECT contact_id FROM contact_phones WHERE phone = ? AND end_date IS NULL
      UNION
      SELECT contact_id FROM contacts WHERE contact_phone = ?
      UNION
      SELECT contact_id FROM contacts WHERE contact_phone2 = ?`;
    params = [parsed.normalized, parsed.normalized, parsed.normalized];
  } else {
    sql = `
      SELECT contact_id FROM contact_emails WHERE email = ? AND end_date IS NULL
      UNION
      SELECT contact_id FROM contacts WHERE contact_email = ?
      UNION
      SELECT contact_id FROM contacts WHERE contact_email2 = ?`;
    params = [parsed.normalized, parsed.normalized, parsed.normalized];
  }

  const [rows] = await db.query(sql, params);
  return {
    kind: parsed.kind,
    normalized: parsed.normalized,
    contactIds: rows.map(r => r.contact_id),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function hashPin(pin) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(pin)).digest('hex');
}

function logEvent(db, { contactId = null, route, event, meta = null, ip = null }) {
  // Fire-and-forget (helper self-catches); returned for test flushing only.
  return insertPortalAccessLog(db, {
    contact_id: contactId,
    route,
    method: 'POST',
    event,
    meta,
    ip,
  });
}

/**
 * SMS monthly cost cap. Counter JSON lives in app_settings
 * 'portal_sms_counter' = {ym, count, alerted_ym}. Month key is UTC YYYY-MM —
 * a month boundary drifting a few hours from firm-local is irrelevant to a
 * cost cap, and UTC avoids any timezone dependency. Read-modify-write on the
 * settings row is best-effort under concurrency (same accepted posture as
 * the in-memory rate limiter: worst case a handful of extra sends around the
 * boundary — this is a cost control, not a security control).
 *
 * @returns {boolean} true = allowed (counter incremented), false = capped
 */
async function checkAndCountSms(db, ip) {
  const s = await getSettings(db, ['portal_sms_counter', 'portal_sms_monthly_cap']);
  const cap = parseInt(s.portal_sms_monthly_cap ?? '300', 10);

  let counter;
  try {
    counter = JSON.parse(s.portal_sms_counter || '{}');
  } catch (_) {
    counter = {};
  }
  if (typeof counter !== 'object' || counter === null) counter = {};

  const ym = new Date().toISOString().slice(0, 7); // UTC YYYY-MM
  if (counter.ym !== ym) {
    counter = { ym, count: 0, alerted_ym: counter.alerted_ym || '' };
  }

  if (Number(counter.count) >= cap) {
    if (counter.alerted_ym !== ym) {
      counter.alerted_ym = ym;
      await persistCounter(db, counter);
      alert(db, {
        source: 'app',
        kind: 'portal_sms_capped',
        severity: 'warning',
        group_key: 'portal:sms_capped',
        title: 'Portal SMS monthly cap reached',
        message: `Portal login-code SMS sends hit the monthly cap (${cap}) for ${ym}. Further SMS PIN requests are silently not sent until next month or a cap raise (app_settings.portal_sms_monthly_cap).`,
      });
    }
    return false;
  }

  counter.count = Number(counter.count || 0) + 1;
  await persistCounter(db, counter);
  return true;
}

async function persistCounter(db, counter) {
  await db.query(
    "UPDATE app_settings SET `value` = ? WHERE `key` = 'portal_sms_counter'",
    [JSON.stringify(counter)]
  );
}

// ── requestPin ──────────────────────────────────────────────────────────────

/**
 * Always resolves {ok:true} for the route (generic-200 contract). Every
 * internal branch is recorded in portal_access_log; nothing here may throw
 * for reasons that depend on whether/who matched.
 */
async function requestPin(db, { identifier, ip = null }) {
  const resolved = await resolveIdentifier(db, identifier);

  // Malformed shouldn't reach here (route 400s on format) — defensive: treat
  // as no-match without logging a bogus event.
  if (!resolved.kind) return { ok: true };

  const { kind, normalized, contactIds } = resolved;

  if (contactIds.length === 0) {
    logEvent(db, { route: ROUTE_REQUEST, event: 'pin_no_match', ip });
    return { ok: true };
  }

  if (contactIds.length >= 2) {
    // Staff-visible data-cleanup signal. NOTHING sent — auth never guesses.
    logEvent(db, {
      route: ROUTE_REQUEST, event: 'pin_multi_match',
      meta: { count: contactIds.length }, ip,
    });
    return { ok: true };
  }

  const contactId = contactIds[0];

  // Named columns only — contacts carries contact_ssn.
  const [[contact]] = await db.query(
    'SELECT portal_enabled FROM contacts WHERE contact_id = ?',
    [contactId]
  );
  if (!contact || contact.portal_enabled !== 1) {
    logEvent(db, { contactId, route: ROUTE_REQUEST, event: 'pin_disabled', ip });
    return { ok: true };
  }

  const channel = kind === 'phone' ? 'sms' : 'email';

  if (channel === 'sms') {
    const allowed = await checkAndCountSms(db, ip);
    if (!allowed) {
      logEvent(db, { contactId, route: ROUTE_REQUEST, event: 'pin_capped', ip });
      return { ok: true };
    }
  }

  // Generate + store. Raw PIN exists only in this scope and the outbound
  // message — never logged, never returned.
  const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(
    `INSERT INTO portal_login_pins
       (contact_id, channel, destination, pin_hash, expires_at, ip)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${PIN_TTL_MINUTES} MINUTE), ?)`,
    [contactId, channel, normalized, hashPin(pin), ip]
  );

  // Send — FIRE-AND-FORGET. Awaiting an external SMS/email API would make
  // the found branch measurably slower than not-found (timing oracle), and
  // a distinguishable error response would re-open the enumeration oracle.
  // pin_sent therefore means "send initiated"; a later failure appends
  // pin_send_failed + alerts.
  const message = `Your client portal login code is ${pin}. It expires in ${PIN_TTL_MINUTES} minutes.`;
  (async () => {
    if (channel === 'sms') {
      const from = await getSetting(db, 'sms_default_from');
      await phoneService.sendSms(db, from, normalized, message);
    } else {
      // portal_email_from falls back to email_default_from ONLY when the
      // setting row is missing — never on a send failure (a failing
      // configured sender must surface as an alert, not silently reroute).
      const s = await getSettings(db, ['portal_email_from', 'email_default_from']);
      const from = s.portal_email_from ?? s.email_default_from;
      await emailService.sendEmail(db, {
        from,
        to: normalized,
        subject: 'Your client portal login code',
        text: message,
      });
    }
  })().catch(err => {
    logEvent(db, {
      contactId, route: ROUTE_REQUEST, event: 'pin_send_failed',
      meta: { channel, error: String(err.message).slice(0, 200) }, ip,
    });
    alert(db, {
      source: 'app',
      kind: 'portal_pin_send_failed',
      severity: 'error',
      group_key: `portal:pin_send_failed:${channel}`,
      title: `Portal login-code ${channel} send failed`,
      message: `contact=${contactId}: ${err.message}`,
    });
  });

  logEvent(db, { contactId, route: ROUTE_REQUEST, event: 'pin_sent', meta: { channel }, ip });
  return { ok: true };
}

// ── verifyPin ───────────────────────────────────────────────────────────────

/**
 * @returns {{ok:true, token:string} | {ok:false}} — every failure mode is
 * identical to the caller.
 */
async function verifyPin(db, { identifier, pin, trustDevice = true, ip = null }) {
  const resolved = await resolveIdentifier(db, identifier);
  if (!resolved.kind || resolved.contactIds.length !== 1) return { ok: false };

  const contactId = resolved.contactIds[0];
  const channel = resolved.kind === 'phone' ? 'sms' : 'email';

  // NEWEST unconsumed row for (contact, channel) — a newer request
  // supersedes older PINs by recency; older rows are never loaded again.
  // Expiry is computed DB-side (expires_at > NOW()) so app/DB clock or
  // timezone skew can't matter.
  const [[row]] = await db.query(
    `SELECT id, pin_hash, attempts, (expires_at > NOW()) AS live
       FROM portal_login_pins
      WHERE contact_id = ? AND channel = ? AND consumed_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [contactId, channel]
  );

  if (!row) return { ok: false };
  if (!row.live) return { ok: false };
  if (row.attempts >= PIN_MAX_ATTEMPTS) return { ok: false };

  // Increment BEFORE comparing — even on the winning attempt. Cheap, and
  // race-resistant: parallel guesses can't share one attempt slot.
  await db.query(
    'UPDATE portal_login_pins SET attempts = attempts + 1 WHERE id = ?',
    [row.id]
  );

  let match = false;
  try {
    match = crypto.timingSafeEqual(
      Buffer.from(hashPin(pin), 'hex'),
      Buffer.from(row.pin_hash, 'hex')
    );
  } catch (_) {
    match = false;
  }
  if (!match) return { ok: false };

  await db.query(
    'UPDATE portal_login_pins SET consumed_at = NOW() WHERE id = ?',
    [row.id]
  );

  // Re-fetch enabled + version — enabled could have flipped since the
  // request, and the token must carry the CURRENT session version.
  const [[contact]] = await db.query(
    'SELECT portal_enabled, portal_session_version FROM contacts WHERE contact_id = ?',
    [contactId]
  );
  if (!contact || contact.portal_enabled !== 1) return { ok: false };

  // EXACTLY these claims (+ iat/exp). Never user_auth — that claim is what
  // makes the two staff verify sites accept a token as staff.
  const token = jwt.sign(
    { sub: contactId, aud: 'contact', ver: contact.portal_session_version },
    process.env.JWT_SECRET,
    { expiresIn: trustDevice ? '90d' : '12h' }
  );

  logEvent(db, { contactId, route: ROUTE_VERIFY, event: 'login', meta: { channel, trustDevice: !!trustDevice }, ip });
  return { ok: true, token };
}

// ── getMe ───────────────────────────────────────────────────────────────────

/** First name only (manage.js precedent) — no contact_id, no phone/email echo. */
async function getMe(db, contactId) {
  const [[row]] = await db.query(
    'SELECT contact_fname FROM contacts WHERE contact_id = ?',
    [contactId]
  );
  return { name: row ? row.contact_fname : '' };
}

module.exports = {
  parseIdentifier,
  resolveIdentifier,
  requestPin,
  verifyPin,
  getMe,
  // internals exposed for tests
  _hashPin: hashPin,
  _checkAndCountSms: checkAndCountSms,
};
