// services/optoutService.js
//
/**
 * Recipient consent — the ONE reader of messaging consent, and its ONE writer
 * (YisraMail P1, ref/YISRAMAIL_DESIGN.md §4.1–§4.4; ruling 2026-10-27 for the
 * read rule, D2 (a) for storage, D18/D19 for what an opt-out stops).
 *
 * STORAGE (D2 (a)). Consent belongs to a DESTINATION — a normalized address or
 * 10-digit number, per channel — not to a contact or a contact row:
 *   comm_consent_events  the ledger: every change, with who/when/how. Never
 *                        updated or deleted. UNIQUE (source, provider_event_id)
 *                        makes a redelivery / re-run a no-op.
 *   comm_consent_state   what sends read: one row per (channel, destination,
 *                        scope) ever touched, pointing at the event that set it.
 *   comm_topics          the marketing topics (config-as-data).
 * The row flags contact_phones.sms_optout / contact_emails.email_optout are a
 * CACHE of the destination's state for one release (dual-read, dual-write),
 * then drop. Each caches ONE scope — CACHE_SCOPE below.
 *
 * SCOPES. SMS: 'all' (STOP / staff / provider). Email: 'marketing' (every
 * marketing topic) — there is NO email 'all'. A topic_key is a narrower scope.
 *
 * WHAT A SEND CHECKS (D18 — opt-outs gate promotion, not operational mail;
 * D19 — an SMS STOP still stops every automated text):
 *   klass 'operational' (default)  sms → scope 'all'      email → NOTHING
 *   klass 'marketing'              sms → 'all' + topic    email → 'marketing' + topic
 * An opt_in topic additionally needs state(topic) = 'opted_in'; an unknown,
 * inactive or other-channel topic blocks every destination (fail closed).
 * Dual-read during the cache release: a destination is opted out when the
 * state says so for a checked scope OR its ACTIVE row's cache flag is 1 and
 * the flag's scope is checked (fail closed).
 *
 * A send knows a destination, not a contact:
 *   - SMS / MMS: normalized as contactPhoneService stores it (digits only, a
 *     leading US 1 dropped, exactly 10 digits — anything else is never opted
 *     out).
 *   - Email: every address-shaped token in the destination (a comma list,
 *     "Name <a@b>" forms, an array), trimmed + lowercased.
 *
 * Who refuses and who warns (the 2026-10-27 read rule, now reached only by
 * SMS and by marketing sends):
 *   - AUTOMATION refuses — assertNotOptedOut throws an OptOutRefusal (code
 *     RECIPIENT_OPTED_OUT). The workflow engine records the step 'skipped',
 *     the sequence engine logs 'skipped' / recipient_opted_out; never
 *     'failed', so the error sweep stays quiet. Any other caller sees a
 *     throw — fail closed.
 *   - STAFF sends warn — the send routes answer 409 code 'opted_out' unless
 *     the body carries acknowledge_optout:true (public/js/optoutAck.js). An
 *     API-key caller is automation: 422, no acknowledgement.
 * Operational email is never blocked, so its gates (send_email, forwards,
 * request_decision, the mail hub, CTA sends, /internal/email) are no-ops that
 * stay in place for C7 to pass klass:'marketing' through.
 *
 * WRITES go through recordConsent(conn, …) ONLY, on the caller's connection
 * (never its own transaction). Callers without one wrap it in
 * withTransaction(fn, { retries: 1 }) (pure DB).
 */

'use strict';

// contactPhoneService / contactEmailService require THIS module lazily (inside
// their writers), so these module-scope requires form no load cycle.
const { normalizePhone } = require('./contactPhoneService');
const { normalizeEmail } = require('./contactEmailService');

const OPTED_OUT_CODE = 'RECIPIENT_OPTED_OUT';
const CHANNELS = Object.freeze({ sms: 'sms', mms: 'sms', email: 'email' });
const KLASSES = Object.freeze(['operational', 'marketing']);

/** The scope each row flag caches: sms_optout = SMS 'all', email_optout = email 'marketing' (D18). */
const CACHE_SCOPE = Object.freeze({ sms: 'all', email: 'marketing' });
const CACHE = Object.freeze({
  sms:   Object.freeze({ table: 'contact_phones', col: 'phone', flag: 'sms_optout' }),
  email: Object.freeze({ table: 'contact_emails', col: 'email', flag: 'email_optout' }),
});

/** comm_consent_events.source vocabulary (design §4.2). */
const SOURCES = Object.freeze(['staff', 'unsub_page', 'one_click', 'pref_page', 'sms_keyword', 'sms_review',
  'provider_optout', 'provider_bounce', 'provider_complaint', 'import', 'web_form', 'migration', 'row_replace']);
const ACTIONS = Object.freeze(['opt_out', 'opt_in']);
/** A topic key is interpolated into SQL (*OptedOutSql) — this shape is what keeps that safe. */
const TOPIC_RE = /^[a-z0-9_]{1,40}$/;

class OptOutRefusal extends Error {
  constructor(channel, recipients, klass = 'operational') {
    super(refusalMessage(channel, recipients, klass));
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

/** Destination → the 10-digit keys a contact_phones row / consent row can hold. */
function phoneKeys(dest) {
  const out = new Set();
  for (const s of flat(dest)) {
    const ten = normalizePhone(s);
    if (/^\d{10}$/.test(ten)) out.add(ten);
  }
  return [...out];
}

/** One address → its stored form (contactEmailService.normalizeEmail), or '' when it is not address-shaped. */
function emailKey(s) {
  const t = normalizeEmail(s);
  return t.length >= 3 && t.length <= 254 && t.indexOf('@') > 0 && t.indexOf('@') < t.length - 1 && !/\s/.test(t) ? t : '';
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
      const t = emailKey(tok);
      if (t) out.add(t);
    }
  }
  return [...out];
}

function keysFor(channel, dest) {
  return channelOf(channel) === 'sms' ? phoneKeys(dest) : emailKeys(dest);
}

/** ONE destination → its stored key, or '' when it cannot be one (never opted out, never recorded). */
function normalizeDestination(channel, dest) {
  const c = channelOf(channel);
  if (dest == null || typeof dest === 'object') return '';
  if (c === 'sms') {
    const ten = normalizePhone(dest);
    return /^\d{10}$/.test(ten) ? ten : '';
  }
  return emailKey(dest);
}

function fmtPhone(ten) {
  return /^\d{10}$/.test(ten) ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : ten;
}

function who(r) {
  const name = r.contact_name ? `${r.contact_name} ` : '';
  const dest = r.channel === 'sms' ? fmtPhone(r.destination) : r.destination;
  // A destination no row holds (consent survives its row) has no contact to name.
  return r.contact_id == null ? `${name}${dest}` : `${name}${dest} (contact #${r.contact_id})`;
}

function noun(c, klass) {
  return c === 'sms' ? 'texts' : (klass === 'marketing' ? 'marketing email' : 'email');
}

function refusalMessage(channel, recipients, klass = 'operational') {
  const c = channelOf(channel);
  const list = (recipients || []).map(who).join(', ');
  return `Not sent — ${list} ${recipients && recipients.length > 1 ? 'have' : 'has'} opted out of ${noun(c, klass)}. ` +
    'Automation never messages an opted-out recipient; clear the opt-out on the contact\'s ' +
    `${c === 'sms' ? 'phone' : 'email'} row if they opt back in.`;
}

/**
 * The send's options → { klass, topic }. Throws on anything else — a typo'd
 * klass must not read as 'operational' (which, for email, checks nothing).
 */
function readOpts(c, opts) {
  const o = opts == null ? {} : opts;
  if (typeof o !== 'object') throw new Error('optoutService: options must be an object');
  const klass = o.klass == null ? 'operational' : o.klass;
  if (!KLASSES.includes(klass)) throw new Error(`optoutService: unknown klass "${klass}"`);
  const topic = o.topic == null || o.topic === '' ? null : o.topic;
  if (topic !== null) {
    if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) throw new Error(`optoutService: invalid topic "${topic}"`);
    if (klass !== 'marketing') throw new Error('optoutService: a topic applies to marketing sends only');
  }
  return { klass, topic };
}

/** The scopes whose 'opted_out' blocks this send, or null when nothing can (operational email, D18). */
function blockingScopes(c, klass, topic) {
  if (klass === 'operational') return c === 'sms' ? ['all'] : null;
  const scopes = c === 'sms' ? ['all'] : ['marketing'];
  if (topic) scopes.push(topic);
  return scopes;
}

function sqlStr(s) {
  // Only ever called on values this module validated (channel, scope names, TOPIC_RE).
  if (!/^[a-z0-9_]+$/.test(s)) throw new Error(`optoutService: refusing to interpolate "${s}"`);
  return `'${s}'`;
}

/**
 * The SQL predicate, for callers that filter in SQL (campaign preview). `col`
 * is a trusted column expression naming the destination (never user input).
 * Same scope rules and dual-read as findOptedOut — tests/consentCore.mysql
 * holds the two to agreement on the engine.
 */
function optedOutSql(channel, col, opts) {
  const c = channelOf(channel);
  const { klass, topic } = readOpts(c, opts);
  const scopes = blockingScopes(c, klass, topic);
  if (!scopes) return '(0 = 1)';
  const t = CACHE[c];
  const parts = [];
  if (scopes.includes(CACHE_SCOPE[c])) {
    parts.push(`EXISTS (SELECT 1 FROM ${t.table} oo_r WHERE oo_r.${t.col} = ${col} AND oo_r.end_date IS NULL AND oo_r.${t.flag} = 1)`);
  }
  parts.push(`EXISTS (SELECT 1 FROM comm_consent_state oo_s WHERE oo_s.channel = ${sqlStr(c)} AND oo_s.destination = ${col}` +
    ` AND oo_s.scope IN (${scopes.map(sqlStr).join(', ')}) AND oo_s.state = 'opted_out')`);
  if (topic) {
    parts.push(`NOT EXISTS (SELECT 1 FROM comm_topics oo_t WHERE oo_t.topic_key = ${sqlStr(topic)} AND oo_t.channel = ${sqlStr(c)} AND oo_t.active = 1)`);
    parts.push(`(EXISTS (SELECT 1 FROM comm_topics oo_t2 WHERE oo_t2.topic_key = ${sqlStr(topic)} AND oo_t2.consent_model = 'opt_in')` +
      ` AND NOT EXISTS (SELECT 1 FROM comm_consent_state oo_i WHERE oo_i.channel = ${sqlStr(c)} AND oo_i.destination = ${col}` +
      ` AND oo_i.scope = ${sqlStr(topic)} AND oo_i.state = 'opted_in'))`);
  }
  return `(${parts.join(' OR ')})`;
}
function smsOptedOutSql(col, opts) { return optedOutSql('sms', col, opts); }
function emailOptedOutSql(col, opts) { return optedOutSql('email', col, opts); }

// The statements findOptedOut / consentVersions issue — exported so in-memory
// test worlds can answer them by identity (tests/helpers/optoutFake.js; their
// predicates are held to real MySQL in tests/consentCore.mysql.test.js).
const FIND_SQL = Object.freeze({
  // The destination's ACTIVE row (at most one: uk_phone_active / uk_email_active) and its cache flag.
  sms: 'SELECT r.id AS row_id, r.contact_id, r.phone AS destination, ct.contact_name, r.sms_optout AS cache_optout'
    + ' FROM contact_phones r LEFT JOIN contacts ct ON ct.contact_id = r.contact_id'
    + ' WHERE r.phone IN (?) AND r.end_date IS NULL ORDER BY r.id',
  email: 'SELECT r.id AS row_id, r.contact_id, r.email AS destination, ct.contact_name, r.email_optout AS cache_optout'
    + ' FROM contact_emails r LEFT JOIN contacts ct ON ct.contact_id = r.contact_id'
    + ' WHERE r.email IN (?) AND r.end_date IS NULL ORDER BY r.id',
  state: 'SELECT destination, scope, state FROM comm_consent_state'
    + ' WHERE channel = ? AND destination IN (?) AND scope IN (?)',
  topic: 'SELECT channel, consent_model, active FROM comm_topics WHERE topic_key = ?',
  version: 'SELECT destination, MAX(last_event_id) AS version FROM comm_consent_state'
    + ' WHERE channel = ? AND destination IN (?) GROUP BY destination',
});

/**
 * The opted-out recipients among `dest` for this send — [] when none, when
 * nothing in `dest` can be a destination, or for an operational email (D18).
 * Each: { channel, destination, contact_id, contact_name, row_id } —
 * contact_id / row_id / contact_name from the destination's ACTIVE row, null
 * when no row holds it. Rows first (by row id), then row-less destinations.
 */
async function findOptedOut(db, channel, dest, opts = {}) {
  const c = channelOf(channel);
  const { klass, topic } = readOpts(c, opts);
  const scopes = blockingScopes(c, klass, topic);
  if (!scopes) return [];
  const keys = keysFor(c, dest);
  if (!keys.length) return [];

  let blockAll = false;
  let needOptIn = false;
  if (topic) {
    const [[t]] = await db.query(FIND_SQL.topic, [topic]);
    if (!t || Number(t.active) !== 1 || String(t.channel) !== c) blockAll = true;
    else needOptIn = String(t.consent_model) === 'opt_in';
  }

  const [rows] = await db.query(FIND_SQL[c], [keys]);
  const [states] = await db.query(FIND_SQL.state, [c, keys, scopes]);

  const entries = new Map(keys.map((k, i) => [k, { i, row: null, out: blockAll, optedIn: false }]));
  const keyOf = (v) => (c === 'sms' ? String(v) : String(v).toLowerCase());
  for (const r of rows || []) {
    const e = entries.get(keyOf(r.destination));
    if (e && !e.row) e.row = r;
  }
  for (const s of states || []) {
    const e = entries.get(keyOf(s.destination));
    if (!e) continue;
    if (s.state === 'opted_out' && scopes.includes(String(s.scope))) e.out = true;
    if (topic && String(s.scope) === topic && s.state === 'opted_in') e.optedIn = true;
  }
  const hits = [];
  for (const [k, e] of entries) {
    if (e.row && Number(e.row.cache_optout) === 1 && scopes.includes(CACHE_SCOPE[c])) e.out = true;
    if (needOptIn && !e.optedIn) e.out = true;
    if (!e.out) continue;
    hits.push({
      i: e.i,
      channel: c,
      destination: e.row ? keyOf(e.row.destination) : k,
      contact_id: e.row ? Number(e.row.contact_id) : null,
      contact_name: e.row && e.row.contact_name != null ? String(e.row.contact_name) : null,
      row_id: e.row ? Number(e.row.row_id) : null,
    });
  }
  hits.sort((a, b) => (a.row_id == null) - (b.row_id == null) || (a.row_id || 0) - (b.row_id || 0) || a.i - b.i);
  return hits.map(({ i, ...h }) => h);
}

/** Automation's gate: throws an OptOutRefusal when any recipient opted out. */
async function assertNotOptedOut(db, channel, dest, opts = {}) {
  const hits = await findOptedOut(db, channel, dest, opts);
  if (hits.length) throw new OptOutRefusal(channelOf(channel), hits, readOpts(channelOf(channel), opts).klass);
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
async function optoutGate(db, { channel, dest, acknowledged, automation = false, klass, topic }) {
  const opts = { klass, topic };
  const hits = await findOptedOut(db, channel, dest, opts);
  if (!hits.length) return { refusal: null, overridden: [] };
  const c = channelOf(channel);
  const k = readOpts(c, opts).klass;
  if (automation) {
    return { overridden: [], refusal: { status: 422, body: { status: 'error', code: 'opted_out', message: refusalMessage(c, hits, k), opted_out: hits } } };
  }
  if (acknowledged === true) return { refusal: null, overridden: hits };
  const list = hits.map(who).join(', ');
  return { overridden: [], refusal: {
    status: 409,
    body: {
      status: 'error',
      code: 'opted_out',
      message: `${list} ${hits.length > 1 ? 'have' : 'has'} opted out of ${noun(c, k)}. ` +
        'Send anyway only if they asked for this message (an opted-out client can still get a reply they requested).',
      opted_out: hits,
      acknowledge_with: 'acknowledge_optout',
    },
  } };
}

/**
 * Each destination's consent as an OPERATIONAL send reads it, plus a version
 * stamp that moves on every consent change for it (any scope) →
 * Map(key → { opted_out, version }). The contact phone/email list routes and
 * Casey's send proposal both read this, so the card's click-time re-check
 * compares the server's own answer, not a row flag.
 */
async function consentVersions(db, channel, dests) {
  const c = channelOf(channel);
  const keys = keysFor(c, dests);
  const out = new Map(keys.map((k) => [k, { opted_out: false, version: '0' }]));
  if (!keys.length) return out;
  for (const h of await findOptedOut(db, c, keys)) {
    const e = out.get(h.destination);
    if (e) e.opted_out = true;
  }
  const [rows] = await db.query(FIND_SQL.version, [c, keys]);
  for (const r of rows || []) {
    const e = out.get(c === 'sms' ? String(r.destination) : String(r.destination).toLowerCase());
    if (e && r.version != null) e.version = String(r.version);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────
//
// LOCK ORDER, every writer: the destination's contact row FIRST, then its
// consent state row. InnoDB does not retry a deadlock here
// (lib/withTransaction retries connection blips only), so it is load-bearing.
//   - A ROW WRITER already holds its row — by PRIMARY KEY (`WHERE id = ?`) —
//     and passes it as `rowId`: recordConsent then takes no further row lock
//     and syncs the cache by primary key. It must not touch the row through
//     the unique index: a direct caller waiting on that row holds its
//     uk_*_active entry, and asking for it again is a deadlock (proven on the
//     engine — tests/consentCore.mysql, "the reviewer's interleave").
//   - A DIRECT caller (the migration, P2's keyword handler) holds nothing:
//     recordConsent locks the destination's ACTIVE row first, through the
//     generated *_active_uniq unique key — exactly the active row, or the gap
//     where one would go (so a concurrent insert waits for it), never the
//     destination's ended history rows.

const EVENT_INSERT_SQL = 'INSERT INTO comm_consent_events'
  + ' (channel, destination, scope, action, source, provider_event_id, occurred_at, contact_id, line_number, send_ref, evidence, actor_user_id)'
  + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
// Seed the state row; on an existing one, a no-op that takes its row lock.
const STATE_SEED_SQL = 'INSERT INTO comm_consent_state (channel, destination, scope, state, occurred_at, last_event_id, updated_at)'
  + ' VALUES (?, ?, ?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE scope = scope';
// The guard: the event wins only when (occurred_at, id) is newer than the stored pair.
const STATE_GUARD_SQL = 'UPDATE comm_consent_state SET state = ?, occurred_at = ?, last_event_id = ?, updated_at = NOW(3)'
  + ' WHERE channel = ? AND destination = ? AND scope = ?'
  + ' AND (occurred_at < ? OR (occurred_at = ? AND last_event_id < ?))';
const STATE_READ_SQL = 'SELECT state, last_event_id FROM comm_consent_state WHERE channel = ? AND destination = ? AND scope = ?';
// LOCKING reads of the state: they see the newest COMMITTED row, never the
// transaction's REPEATABLE-READ snapshot (a writer opened its read view
// before a newer decision committed elsewhere).
const STATE_SHARE_SQL = `${STATE_READ_SQL} FOR SHARE`;   // decides a row's flag
const STATE_LOCK_SQL  = `${STATE_READ_SQL} FOR UPDATE`;  // recordConsent, after its upsert
// The destination's ACTIVE row, locked (recordConsent's first statement).
const ACTIVE_LOCK_SQL = Object.freeze({
  sms:   'SELECT id FROM contact_phones WHERE phone_active_uniq = ? FOR UPDATE',
  email: 'SELECT id FROM contact_emails WHERE email_active_uniq = ? FOR UPDATE',
});
// One row by id, locked — the three-way decision reads its destination and flag.
const ROW_LOCK_SQL = Object.freeze({
  sms:   'SELECT id, phone AS destination, sms_optout AS flag, end_date FROM contact_phones WHERE id = ? FOR UPDATE',
  email: 'SELECT id, email AS destination, email_optout AS flag, end_date FROM contact_emails WHERE id = ? FOR UPDATE',
});
// Align the destination's ACTIVE row's cache flag with a state value (only when it differs).
const CACHE_SYNC_SQL = Object.freeze({
  sms:   'UPDATE contact_phones SET sms_optout = ? WHERE phone_active_uniq = ? AND sms_optout <> ?',
  email: 'UPDATE contact_emails SET email_optout = ? WHERE email_active_uniq = ? AND email_optout <> ?',
});
// The same, for a row writer's own (already locked) row — by primary key.
const CACHE_SYNC_ROW_SQL = Object.freeze({
  sms:   'UPDATE contact_phones SET sms_optout = ? WHERE id = ? AND end_date IS NULL AND sms_optout <> ?',
  email: 'UPDATE contact_emails SET email_optout = ? WHERE id = ? AND end_date IS NULL AND email_optout <> ?',
});
// Set ONE row's cache flag (a new row's birth value; only when it differs).
const ROW_FLAG_SQL = Object.freeze({
  sms:   'UPDATE contact_phones SET sms_optout = ? WHERE id = ? AND sms_optout <> ?',
  email: 'UPDATE contact_emails SET email_optout = ? WHERE id = ? AND email_optout <> ?',
});
// Exported, like FIND_SQL, so an in-memory world can answer the writers by identity.
const WRITE_SQL = Object.freeze({
  event: EVENT_INSERT_SQL, seed: STATE_SEED_SQL, guard: STATE_GUARD_SQL, read: STATE_READ_SQL,
  share: STATE_SHARE_SQL, lock: STATE_LOCK_SQL, active: ACTIVE_LOCK_SQL, row: ROW_LOCK_SQL,
  cache: CACHE_SYNC_SQL, cacheRow: CACHE_SYNC_ROW_SQL, rowFlag: ROW_FLAG_SQL,
});

function badArg(msg) { return new Error(`recordConsent: ${msg}`); }

function optId(v, what) {
  if (v == null || v === '' || v === 0 || v === '0') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw badArg(`${what} must be a positive integer`);
  return n;
}

function optText(v, max, what) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (s.length > max) throw badArg(`${what} exceeds ${max} characters`);
  return s;
}

async function assertScope(conn, c, scope) {
  if (scope === 'all') { if (c !== 'sms') throw badArg('scope "all" exists for SMS only (D18: an email opt-out is marketing-only)'); return; }
  if (scope === 'marketing') { if (c !== 'email') throw badArg('scope "marketing" is an email scope (SMS marketing is the sms_marketing topic)'); return; }
  if (typeof scope !== 'string' || !TOPIC_RE.test(scope)) throw badArg(`invalid scope "${scope}"`);
  const [[t]] = await conn.query(FIND_SQL.topic, [scope]);
  if (!t || String(t.channel) !== c) throw badArg(`scope "${scope}" is not a ${c} topic`);
}

/**
 * Record one consent change — the ONLY writer of comm_consent_events /
 * comm_consent_state. Runs on the CALLER's connection, inside the caller's
 * transaction (it never opens its own: a consent write inside a contact save
 * must commit or roll back with it).
 *   0. Lock order: row, then state. A row writer passes the row it holds
 *      (`rowId`) and nothing more is locked; a direct caller has the
 *      destination's ACTIVE row locked here, through the unique key.
 *   1. INSERT the event; a duplicate (source, provider_event_id) is a no-op
 *      ({ duplicate: true } — nothing else is touched).
 *   2. Guarded upsert of the state row: this event wins only when
 *      (occurred_at, id) is newer than the stored (occurred_at, last_event_id),
 *      so racing writers or a replayed old event can't leave the state on the
 *      older one. The state is then re-read with a LOCKING read — the newest
 *      committed row, whatever this transaction's snapshot holds.
 *   3. When `scope` is the scope a row flag caches (SMS 'all', email
 *      'marketing'), align the destination's ACTIVE row's flag with the
 *      resulting state (the writer's `rowId` by primary key, else through
 *      the unique key). A cache sync is never itself an event.
 * → { event_id, duplicate, applied, state }
 */
async function recordConsent(conn, {
  channel, destination, scope, action, source,
  occurredAt = null, providerEventId = null, contactId = null, lineNumber = null,
  sendRef = null, evidence = null, actorUserId = null, rowId = null,
} = {}) {
  if (!conn || typeof conn.query !== 'function') throw badArg('needs the caller\'s connection');
  const c = channelOf(channel);
  const dest = normalizeDestination(c, destination);
  if (!dest) throw badArg(`"${destination}" is not a ${c === 'sms' ? '10-digit number' : 'valid address'}`);
  if (!ACTIONS.includes(action)) throw badArg(`unknown action "${action}"`);
  if (!SOURCES.includes(source)) throw badArg(`unknown source "${source}"`);
  await assertScope(conn, c, scope);
  const at = occurredAt == null ? new Date() : (occurredAt instanceof Date ? occurredAt : new Date(occurredAt));
  if (Number.isNaN(at.getTime())) throw badArg(`invalid occurredAt "${occurredAt}"`);
  const pid = optText(providerEventId, 128, 'providerEventId');
  const line = lineNumber == null || lineNumber === '' ? null : normalizePhone(lineNumber);
  if (line !== null && !/^\d{10}$/.test(line)) throw badArg('lineNumber must be a 10-digit number');
  if (evidence != null && (typeof evidence !== 'object' || Array.isArray(evidence))) throw badArg('evidence must be an object');

  const heldRow = rowId == null ? null : Number(rowId);
  if (heldRow !== null && (!Number.isSafeInteger(heldRow) || heldRow < 1)) throw badArg('rowId must be a positive integer');
  if (heldRow === null) await conn.query(ACTIVE_LOCK_SQL[c], [dest]);

  let eventId;
  try {
    const [ins] = await conn.query(EVENT_INSERT_SQL, [
      c, dest, scope, action, source, pid, at,
      optId(contactId, 'contactId'), line, optText(sendRef, 64, 'sendRef'),
      evidence == null ? null : JSON.stringify(evidence), optId(actorUserId, 'actorUserId'),
    ]);
    eventId = Number(ins.insertId);
  } catch (err) {
    // InnoDB rolls back only the failed statement; the caller's transaction lives on.
    if (err && err.code === 'ER_DUP_ENTRY' && /uk_source_event/.test(String(err.sqlMessage || err.message))) {
      return { event_id: null, duplicate: true, applied: false, state: null };
    }
    throw err;
  }
  if (!Number.isSafeInteger(eventId) || eventId < 1) throw badArg('the event insert returned no id');

  const st = action === 'opt_out' ? 'opted_out' : 'opted_in';
  await conn.query(STATE_SEED_SQL, [c, dest, scope, st, at, eventId]);
  await conn.query(STATE_GUARD_SQL, [st, at, eventId, c, dest, scope, at, at, eventId]);
  const [[now]] = await conn.query(STATE_LOCK_SQL, [c, dest, scope]);
  if (!now) throw badArg('the state row is missing after its upsert');

  if (scope === CACHE_SCOPE[c]) {
    const val = now.state === 'opted_out' ? 1 : 0;
    if (heldRow !== null) await conn.query(CACHE_SYNC_ROW_SQL[c], [val, heldRow, val]);
    else await conn.query(CACHE_SYNC_SQL[c], [val, dest, val]);
  }
  return { event_id: eventId, duplicate: false, applied: Number(now.last_event_id) === eventId, state: now.state };
}

/**
 * The destination's state for the scope its row flag caches, read with a
 * LOCKING read (FOR SHARE — the newest committed decision). Call it while
 * holding the destination's contact row (lock order).
 * → { exists, flag } — flag 1 when the state is 'opted_out'.
 */
async function stateFlag(conn, channel, destination) {
  const c = channelOf(channel);
  const dest = normalizeDestination(c, destination);
  if (!dest) return { exists: false, flag: 0 };
  const [[s]] = await conn.query(STATE_SHARE_SQL, [c, dest, CACHE_SCOPE[c]]);
  return { exists: !!s, flag: s && s.state === 'opted_out' ? 1 : 0 };
}

// ─── Who is writing (fix round, minor 7) ────────────────────
//
// A consent change records who made it. A signed-in staff member ('user') may
// opt a destination in or out; an API key ('api_key' — an integration, a
// workflow webhook) and in-process automation ('system') may opt OUT only: an
// opt-in is a human consent decision. Routes build the actor from req.auth.

/** req.auth → the consent actor. Anything unrecognised is 'system' (fails closed: no opt-in). */
function consentActor(auth) {
  const a = auth && typeof auth === 'object' ? auth : {};
  if (a.type === 'jwt') {
    const n = Number(a.userId);
    return { kind: 'user', userId: Number.isSafeInteger(n) && n > 0 ? n : null };
  }
  if (a.type === 'api_key') return { kind: 'api_key', keyId: a.key_id != null ? a.key_id : null, keyLabel: a.key_label || null };
  return { kind: 'system' };
}

// No actor passed: an in-process caller (intake, booking, update_contact) —
// automation. Writers pass their own `system` actor carrying the user id they
// were given, so attribution survives.
function actorOf(actor) {
  if (actor && (actor.kind === 'user' || actor.kind === 'api_key' || actor.kind === 'system')) return actor;
  return { kind: 'system', userId: null };
}

/** A writer's actor: the route's (consentActor), else automation attributed to the given user id. */
function writerActor(consentActorOpt, userId) {
  if (consentActorOpt && consentActorOpt.kind) return consentActorOpt;
  const n = Number(userId);
  return { kind: 'system', userId: Number.isSafeInteger(n) && n > 0 ? n : null };
}

/**
 * The evidence keys an actor adds to an event: an API key is named (it has no
 * user); a user is actor_user_id; automation keeps the caller's own `via`.
 */
function actorEvidence(a) {
  if (a.kind === 'api_key') return { via: 'api_key', ...(a.keyId != null ? { key_id: a.keyId } : {}), ...(a.keyLabel ? { key_label: a.keyLabel } : {}) };
  return {};
}

/** A consent write refused with an HTTP status (routes answer err.status with err.code). */
class ConsentWriteRefusal extends Error {
  constructor(status, code, message, destination) {
    super(message);
    this.name = 'ConsentWriteRefusal';
    this.status = status;
    this.code = code;
    this.consent = { destination };
  }
}

function shown(c, dest) { return c === 'sms' ? fmtPhone(dest) : dest; }

function optInRefusal(c, dest) {
  return new ConsentWriteRefusal(422, 'opt_in_needs_staff',
    `Clearing the ${c === 'sms' ? 'SMS' : 'marketing email'} opt-out on ${shown(c, dest)} is a consent decision a signed-in staff member makes — an API key or automation can set an opt-out, never clear one.`,
    dest);
}

function toFlag(v) { return v ? 1 : 0; }
/** A sent / base flag → 0 | 1, or undefined when absent ('false' / '0' read as 0). */
function presentFlag(v) { return v === undefined || v === null || v === '' ? undefined : toFlag(v === 'false' || v === '0' ? 0 : v); }

/** 409: the caller decided against a consent value that is no longer current. */
function consentChanged(channel, destination) {
  const c = channelOf(channel);
  const dest = normalizeDestination(c, destination) || String(destination);
  return new ConsentWriteRefusal(409, 'consent_changed',
    `Consent for ${shown(c, dest)} changed since you opened this contact — reload it, then make the change again if it is still needed. Nothing was saved.`,
    dest);
}

/**
 * One row's destination and that destination's CURRENT consent — the state
 * for the flag's scope when one exists, else the row's flag. Locks the row
 * first, then reads the state (lock order). Works on an ended row too (an
 * end-and-replace reads the row it just ended).
 * → { destination, current, rowFlag }
 */
async function rowConsent(conn, { channel, rowId }) {
  const c = channelOf(channel);
  const [[row]] = await conn.query(ROW_LOCK_SQL[c], [rowId]);
  if (!row) throw new Error(`rowConsent: ${c === 'sms' ? 'phone' : 'email'} row ${rowId} not found`);
  const dest = normalizeDestination(c, row.destination);
  const rowFlag = toFlag(Number(row.flag) === 1);
  const st = await stateFlag(conn, c, dest);
  return { destination: dest, current: st.exists ? st.flag : rowFlag, rowFlag };
}

/**
 * The three-way consent decision for a write that carries an EXISTING ACTIVE
 * row's flag (fix round, MAJOR 2). Locks the row, then reads the
 * destination's state (lock order). `current` = the state for the flag's
 * scope when one exists, else the row's flag.
 *   sent   the flag the caller sent
 *   base   the flag the caller LOADED (the contact form sends `*_base`), or
 *          undefined
 *     base given, sent = base   → no decision: the row's cache = current
 *                                  (a stale form never undoes a newer change)
 *     base given, sent ≠ base   → the user's decision, unless base ≠ current:
 *                                  then 409 consent_changed, nothing written
 *     base absent (Casey, an API caller, an older tab) → sent vs current
 * An opt_in from anything but a signed-in user is refused (422).
 * → { action: null | 'opt_out' | 'opt_in', flag, current, destination }
 */
async function decideRowFlag(conn, { channel, rowId, sent, base, actor }) {
  const c = channelOf(channel);
  const { destination: dest, current } = await rowConsent(conn, { channel: c, rowId });
  const s = presentFlag(sent);
  const b = presentFlag(base);
  if (s === undefined) return { action: null, flag: current, current, destination: dest };
  if (b !== undefined) {
    if (s === b) return { action: null, flag: current, current, destination: dest };
    if (b !== current) throw consentChanged(c, dest);
  }
  if (s === current) return { action: null, flag: current, current, destination: dest };
  const action = s === 1 ? 'opt_out' : 'opt_in';
  if (action === 'opt_in' && actorOf(actor).kind !== 'user') throw optInRefusal(c, dest);
  return { action, flag: s, current, destination: dest };
}

/**
 * Record the decision decideRowFlag returned (no-op when there is none) —
 * source 'staff', attributed to the actor. Call it AFTER the row write, with
 * the row's id (`rowId` — the row the writer holds; see the lock order).
 */
async function applyRowDecision(conn, { channel, rowId, destination, action, actor, contactId = null, evidence = null }) {
  if (!action) return null;
  const c = channelOf(channel);
  const a = actorOf(actor);
  if (action === 'opt_in' && a.kind !== 'user') throw optInRefusal(c, normalizeDestination(c, destination));
  return recordConsent(conn, {
    channel: c, destination, scope: CACHE_SCOPE[c], action, source: 'staff', rowId,
    contactId, actorUserId: a.userId, evidence: { ...(evidence || {}), ...actorEvidence(a) },
  });
}

/**
 * A NEW active row for a destination — an insert, a transfer, an
 * end-and-replace, a reactivation. Call it right AFTER the row is written
 * (the caller holds its lock), on the same connection. Reads the state with a
 * LOCKING read and sets the row's flag to
 *     max(intent, carried flags, state)   — never born opted IN past the state
 *   intent   1 when the CALLER decided an opt-out (a staff tick, an API value)
 *   carried  [{ flag, gap_only, from_row_id, from_destination, via }] — flags
 *            an older row hands over. A correction's old row (end-and-replace)
 *            always carries; a transfer's donor and a reactivated row's own
 *            history flag (gap_only) carry only when the destination has NO
 *            state row yet — a stale history flag never overrides a recorded
 *            decision.
 * One opt_out event when the result is 1 and the state is not already
 * 'opted_out': source 'staff' when the intent decided it, 'row_replace' when
 * only a carry did. Never an opt_in. → { flag, state, event }
 */
async function bornRow(conn, { channel, rowId, destination, intent = 0, carried = [], actor, contactId = null, evidence = null }) {
  const c = channelOf(channel);
  const dest = normalizeDestination(c, destination);
  if (!dest) return { flag: toFlag(intent), state: { exists: false, flag: 0 }, event: null };
  const st = await stateFlag(conn, c, dest);
  const carry = (carried || []).find((k) => k && toFlag(Number(k.flag) === 1) && !(k.gap_only && st.exists)) || null;
  const want = toFlag(intent) || (carry ? 1 : 0) || st.flag;
  await conn.query(ROW_FLAG_SQL[c], [want, rowId, want]);
  let event = null;
  if (want === 1 && !st.flag) {
    const a = actorOf(actor);
    const byIntent = !!toFlag(intent);
    const from = byIntent ? {} : {
      ...(carry.from_destination ? { from_destination: carry.from_destination } : {}),
      ...(carry.from_row_id != null ? { from_row_id: carry.from_row_id } : {}),
      ...(carry.via ? { carried_by: carry.via } : {}),
    };
    event = await recordConsent(conn, {
      channel: c, destination: dest, scope: CACHE_SCOPE[c], action: 'opt_out', rowId,
      source: byIntent ? 'staff' : 'row_replace', contactId, actorUserId: a.userId,
      evidence: { ...(evidence || {}), ...from, ...actorEvidence(a) },
    });
  }
  return { flag: want, state: st, event };
}

/**
 * Realign the cache flag of rows a GENERIC writer touched (update_db /
 * insert_db — fix round, MAJOR 1) with their destination's state: each row
 * that is ACTIVE takes the state's value where a state row exists. Ended rows
 * are history; a destination with no state keeps its row's flag. Never an
 * event — a generic writer makes no consent decision (the flag columns are
 * blocked from it). Lock order: each row, then its state.
 * → the number of rows whose flag changed
 */
async function syncRowCaches(conn, channel, rowIds) {
  const c = channelOf(channel);
  let changed = 0;
  for (const id of rowIds || []) {
    const [[row]] = await conn.query(ROW_LOCK_SQL[c], [id]);
    if (!row || row.end_date != null) continue;
    const st = await stateFlag(conn, c, row.destination);
    if (!st.exists) continue;
    const [r] = await conn.query(ROW_FLAG_SQL[c], [st.flag, id, st.flag]);
    changed += Number((r && r.affectedRows) || 0);
  }
  return changed;
}

/**
 * An opt-out override's audit fields (fix round, minor 6): the contact ids as
 * before, plus every destination — a destination with no active row has no
 * contact to name.
 */
function overrideAudit(hits) {
  const h = hits || [];
  return { acknowledged_optout: h.map((r) => r.contact_id), acknowledged_optout_destinations: h.map((r) => r.destination) };
}
function overrideLine(hits) {
  return (hits || []).map((r) => (r.contact_id != null ? `contact ${r.contact_id} (${r.destination})` : `${r.destination} (no active row)`)).join(', ');
}

module.exports = {
  OPTED_OUT_CODE,
  FIND_SQL,
  WRITE_SQL,
  CACHE_SCOPE,
  SOURCES,
  OptOutRefusal,
  ConsentWriteRefusal,
  isOptOutRefusal,
  findOptedOut,
  assertNotOptedOut,
  optoutGate,
  smsOptedOutSql,
  emailOptedOutSql,
  consentVersions,
  recordConsent,
  stateFlag,
  consentActor,
  writerActor,
  rowConsent,
  consentChanged,
  decideRowFlag,
  presentFlag,
  applyRowDecision,
  bornRow,
  syncRowCaches,
  overrideAudit,
  overrideLine,
  // helpers (tests)
  phoneKeys,
  emailKeys,
  normalizeDestination,
  refusalMessage,
};
