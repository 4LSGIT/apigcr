// services/optoutService.js
//
/**
 * Recipient opt-out — the ONE reader of messaging consent (ruling 2026-10-27).
 *
 * Consent lives on the ROW staff edit: contact_phones.sms_optout and
 * contact_emails.email_optout — the only consent flags. The contact row has
 * none (its old pair was dropped: scripts/optoutContactColumnsDrop.js).
 *
 * A send knows a destination, not a contact, so the destination maps to rows:
 *   - SMS / MMS: the number normalized the way contactPhoneService stores it
 *     (digits only, a leading US 1 dropped, exactly 10 digits — anything else
 *     cannot match a char(10) row and is never opted out).
 *   - Email: every address-shaped token in the destination (a comma list,
 *     "Name <a@b>" forms, an array), trimmed + lowercased; the column's
 *     general_ci collation makes the compare case-insensitive anyway.
 * The rule: the destination is opted out when its ACTIVE row
 * (end_date IS NULL) carries the flag. uk_phone_active / uk_email_active make
 * that at most one row per number/address across all contacts, so there is
 * no "shared number" ambiguity to resolve; ended rows are history (the
 * number's current row is staff's current knowledge of consent).
 *
 * Who refuses and who warns (the ruling):
 *   - AUTOMATION refuses — assertNotOptedOut throws an OptOutRefusal
 *     (code RECIPIENT_OPTED_OUT). The workflow engine records the step
 *     'skipped' and the sequence engine logs 'skipped'/recipient_opted_out;
 *     neither is 'failed', so the error sweep never pages for expected
 *     behaviour (CLAUDE.md alert convention). Any other caller sees a throw —
 *     fail closed.
 *   - STAFF sends warn — the send routes answer 409 code 'opted_out' unless
 *     the body carries acknowledge_optout:true (public/js/optoutAck.js turns
 *     the 409 into a confirm and the resend). A caller that does not handle
 *     the 409 simply does not send.
 */

'use strict';

const { normalizePhone } = require('./contactPhoneService');

const OPTED_OUT_CODE = 'RECIPIENT_OPTED_OUT';
const CHANNELS = Object.freeze({ sms: 'sms', mms: 'sms', email: 'email' });

class OptOutRefusal extends Error {
  constructor(channel, recipients) {
    super(refusalMessage(channel, recipients));
    this.name = 'OptOutRefusal';
    this.code = OPTED_OUT_CODE;
    this.channel = channel;
    this.recipients = recipients;
  }
}

function isOptOutRefusal(err) {
  return !!(err && err.code === OPTED_OUT_CODE);
}

function channelOf(channel) {
  const c = CHANNELS[channel];
  if (!c) throw new Error(`optoutService: unknown channel "${channel}"`);
  return c;
}

function flat(dest) {
  if (dest == null) return [];
  if (Array.isArray(dest)) return dest.flatMap(flat);
  if (typeof dest === 'object') return flat(dest.email != null ? dest.email : dest.address);
  return [String(dest)];
}

/** Destination → the 10-digit keys a contact_phones row can hold. */
function phoneKeys(dest) {
  const out = new Set();
  for (const s of flat(dest)) {
    const ten = normalizePhone(s);
    if (/^\d{10}$/.test(ten)) out.add(ten);
  }
  return [...out];
}

/**
 * Destination → lowercased addresses. Split on the separators an address
 * cannot contain (linear — no backtracking regex on caller-supplied text),
 * keep the tokens that look like an address.
 */
function emailKeys(dest) {
  const out = new Set();
  for (const s of flat(dest)) {
    for (const tok of s.split(/[\s,;<>"'()[\]]+/)) {
      const t = tok.trim().toLowerCase();
      if (t.length >= 3 && t.length <= 254 && t.indexOf('@') > 0 && t.indexOf('@') < t.length - 1) out.add(t);
    }
  }
  return [...out];
}

function keysFor(channel, dest) {
  return channelOf(channel) === 'sms' ? phoneKeys(dest) : emailKeys(dest);
}

function fmtPhone(ten) {
  return /^\d{10}$/.test(ten) ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : ten;
}

function who(r) {
  const name = r.contact_name ? `${r.contact_name} ` : '';
  const dest = r.channel === 'sms' ? fmtPhone(r.destination) : r.destination;
  return `${name}${dest} (contact #${r.contact_id})`;
}

function refusalMessage(channel, recipients) {
  const c = channelOf(channel);
  const list = (recipients || []).map(who).join(', ');
  return `Not sent — ${list} ${recipients && recipients.length > 1 ? 'have' : 'has'} opted out of ${c === 'sms' ? 'texts' : 'email'}. ` +
    'Automation never messages an opted-out recipient; clear the opt-out on the contact\'s ' +
    `${c === 'sms' ? 'phone' : 'email'} row if they opt back in.`;
}

/**
 * The SQL predicate, for callers that filter in SQL (campaign preview). `col`
 * is a trusted column expression naming the destination (never user input).
 */
function smsOptedOutSql(col) {
  return `EXISTS (SELECT 1 FROM contact_phones oo_p WHERE oo_p.phone = ${col} AND oo_p.end_date IS NULL AND oo_p.sms_optout = 1)`;
}
function emailOptedOutSql(col) {
  return `EXISTS (SELECT 1 FROM contact_emails oo_e WHERE oo_e.email = ${col} AND oo_e.end_date IS NULL AND oo_e.email_optout = 1)`;
}

// The two statements findOptedOut issues — exported so in-memory test worlds
// can answer them by identity (their predicates are held to real MySQL in
// tests/optout.mysql.test.js).
const FIND_SQL = Object.freeze({
  sms: 'SELECT r.id AS row_id, r.contact_id, r.phone AS destination, ct.contact_name'
    + ' FROM contact_phones r LEFT JOIN contacts ct ON ct.contact_id = r.contact_id'
    + ' WHERE r.phone IN (?) AND r.end_date IS NULL AND r.sms_optout = 1 ORDER BY r.id',
  email: 'SELECT r.id AS row_id, r.contact_id, r.email AS destination, ct.contact_name'
    + ' FROM contact_emails r LEFT JOIN contacts ct ON ct.contact_id = r.contact_id'
    + ' WHERE r.email IN (?) AND r.end_date IS NULL AND r.email_optout = 1 ORDER BY r.id',
});

/**
 * The opted-out recipients among `dest` — [] when none (or when nothing in
 * `dest` can map to a row). Each: { channel, destination, contact_id,
 * contact_name, row_id }.
 */
async function findOptedOut(db, channel, dest) {
  const c = channelOf(channel);
  const keys = keysFor(c, dest);
  if (!keys.length) return [];
  const [rows] = await db.query(c === 'sms' ? FIND_SQL.sms : FIND_SQL.email, [keys]);
  return rows.map((r) => ({
    channel: c,
    destination: c === 'sms' ? String(r.destination) : String(r.destination).toLowerCase(),
    contact_id: Number(r.contact_id),
    contact_name: r.contact_name == null ? null : String(r.contact_name),
    row_id: Number(r.row_id),
  }));
}

/** Automation's gate: throws an OptOutRefusal when any recipient opted out. */
async function assertNotOptedOut(db, channel, dest) {
  const hits = await findOptedOut(db, channel, dest);
  if (hits.length) throw new OptOutRefusal(channelOf(channel), hits);
}

/**
 * A staff send route's gate → { refusal, overridden }.
 *   refusal    null when the send may go; else { status, body } to answer.
 *   overridden the opted-out recipients the caller acknowledged ([] when
 *              nobody opted out) — the route audits the override.
 * The send may go when nobody opted out, or when the STAFF caller
 * acknowledged (body.acknowledge_optout === true — a literal true, nothing
 * merely truthy): 409 code 'opted_out' otherwise. An API-key caller is
 * automation: it may never acknowledge, and gets 422.
 */
async function optoutGate(db, { channel, dest, acknowledged, automation = false }) {
  const hits = await findOptedOut(db, channel, dest);
  if (!hits.length) return { refusal: null, overridden: [] };
  const c = channelOf(channel);
  if (automation) {
    return { overridden: [], refusal: { status: 422, body: { status: 'error', code: 'opted_out', message: refusalMessage(c, hits), opted_out: hits } } };
  }
  if (acknowledged === true) return { refusal: null, overridden: hits };
  const list = hits.map(who).join(', ');
  return { overridden: [], refusal: {
    status: 409,
    body: {
      status: 'error',
      code: 'opted_out',
      message: `${list} ${hits.length > 1 ? 'have' : 'has'} opted out of ${c === 'sms' ? 'texts' : 'email'}. ` +
        'Send anyway only if they asked for this message (an opted-out client can still get a reply they requested).',
      opted_out: hits,
      acknowledge_with: 'acknowledge_optout',
    },
  } };
}

module.exports = {
  OPTED_OUT_CODE,
  FIND_SQL,
  OptOutRefusal,
  isOptOutRefusal,
  findOptedOut,
  assertNotOptedOut,
  optoutGate,
  smsOptedOutSql,
  emailOptedOutSql,
  // helpers (tests)
  phoneKeys,
  emailKeys,
  refusalMessage,
};
