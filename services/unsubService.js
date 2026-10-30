// services/unsubService.js
//
/**
 * Email unsubscribe tokens — the substrate behind /u/<token> (YisraMail P3,
 * ref/YISRAMAIL_DESIGN.md §4.5; routes/unsubActions.js is the surface).
 *
 * One comm_unsub_tokens row per marketing send (C2 mints it inside the send
 * reservation). The token is a bearer capability for ONE destination's
 * MARKETING consent: it can opt that address out of (or back into) marketing
 * topics and nothing else — D18: there is no email scope that stops case or
 * appointment mail, and recordConsent refuses an email 'all'.
 *
 *   mintUnsubToken(conn, …)   C2, on the caller's connection
 *   urlFor(token)             the /u/ URL on the landing origin
 *   lookupToken(db, token)    the page's read — READ ONLY
 *   oneClick(db, token, …)    RFC 8058 POST: opt_out of the token's topic (D4)
 *   applyPage(db, token, …)   the page's form: unsubscribe | all | prefs
 *
 * WRITES go through optoutService.recordConsent only (the one writer), inside
 * withTransaction(retries: 1) + ONE retry on ER_LOCK_DEADLOCK (consentTx —
 * pure DB, so the victim's span re-runs whole). The retry matters: this
 * module is a DIRECT caller in P1's terms (it locks the token row, then
 * recordConsent locks contact_emails through uk_email_active), and a
 * concurrent contact-form end-and-replace of that very address holds the
 * clustered record first and then needs the secondary index record (the
 * generated email_active_uniq changes with end_date) — InnoDB picks a
 * victim, and without the retry a mail client's one-click would get a 500
 * and be lost. Same pattern as phoneConsentService.consentTx. The staff
 * task for a free-text note is created AFTER the commit and its failure
 * never fails the request.
 *
 * IDEMPOTENCY IS ON STATE, not on the token: a request records an event only
 * for a scope whose requested state differs from the current one, so a second
 * one-click (or a resubmitted form) writes nothing — while a one-click after
 * an opt-in through the page records an opt-out again. Tokens never expire and
 * keep working after first use (used_at = the first POST only).
 *
 * LOCKS, in order: the token row (FOR UPDATE — serializes two requests on the
 * same token), then whatever recordConsent takes (the destination's active
 * contact row, then the state row — optoutService's lock order). The current
 * state is read with a PLAIN read after the token lock: under REPEATABLE READ
 * the transaction's snapshot is taken at that first consistent read, i.e.
 * after a concurrent request on the same token committed, and nothing here
 * takes a state lock ahead of recordConsent's contact-row lock (which would
 * invert the lock order). Scopes are written in a fixed order — marketing,
 * then topics by key — so two page requests for one address never lock state
 * rows in opposite orders. tests/unsubService.mysql.test.js holds all of this
 * to the engine.
 */

'use strict';

const crypto = require('crypto');
const optout = require('./optoutService');
const { generateToken, PUBLIC_TOKEN_RE } = require('../lib/token');
const { withTransaction } = require('../lib/withTransaction');

/** withTransaction(retries:1) + one retry on a deadlock (pure DB: the victim's span rolled back whole). */
async function consentTx(db, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(db, fn, { retries: 1 });
    } catch (err) {
      if (err && err.code === 'ER_LOCK_DEADLOCK' && attempt === 0) continue;
      throw err;
    }
  }
}

const CHANNEL = 'email';
const MARKETING = 'marketing';
const NOTE_MAX = 1000;
const UA_MAX = 512;
const MINT_ATTEMPTS = 5;
const ACTIONS = Object.freeze(['unsubscribe', 'all', 'prefs']);
const TOPIC_RE = /^[a-z0-9_]{1,40}$/;

// Exported so an in-memory test world can answer them by identity (the
// optoutService FIND_SQL / WRITE_SQL convention).
const UNSUB_SQL = Object.freeze({
  insert: 'INSERT INTO comm_unsub_tokens (token, channel, destination, topic_key, campaign_id, contact_id, send_ref)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  // The page's read: the token and its topic's row as it stands now (a topic
  // retired or deleted since the mint still names the send).
  get: 'SELECT t.token, t.destination, t.topic_key, t.campaign_id, t.contact_id, t.send_ref, t.used_at,'
    + ' tp.label AS topic_label, tp.channel AS topic_channel, tp.consent_model AS topic_consent_model'
    + ' FROM comm_unsub_tokens t LEFT JOIN comm_topics tp ON tp.topic_key = t.topic_key WHERE t.token = ?',
  // The writers' first statement: the token alone (no join — FOR UPDATE on a
  // join would lock the topic row too).
  lock: 'SELECT token, destination, topic_key, campaign_id, contact_id, send_ref, used_at'
    + ' FROM comm_unsub_tokens WHERE token = ? FOR UPDATE',
  used: 'UPDATE comm_unsub_tokens SET used_at = NOW() WHERE token = ? AND used_at IS NULL',
  // The topics the page offers: active email topics (D18 — marketing scopes only).
  topics: "SELECT topic_key, label, description, consent_model FROM comm_topics WHERE channel = 'email' AND active = 1 ORDER BY topic_key",
  assignee: "SELECT user FROM users WHERE user = ? AND user_auth LIKE 'authorized%'",
  // Ledger notes no task ever carried (the unassigned-notes alert's count).
  unassigned: "SELECT COUNT(*) AS n FROM comm_consent_events WHERE channel = 'email'"
    + " AND source IN ('unsub_page', 'pref_page') AND evidence->>'$.note_unassigned' = 'true'",
});

/** A page request the route answers 422 (bad action / topic) — never internals. */
class UnsubInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UnsubInputError';
    this.status = 422;
    this.code = code;
  }
}

function optInt(v, what) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`mintUnsubToken: ${what} must be a positive integer`);
  return n;
}

function clip(s, max) {
  if (s == null) return null;
  const t = String(s);
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Mint one token for a marketing send — on the CALLER's connection (C2 mints
 * inside the send reservation). The topic must exist, be an email topic
 * (optoutService.assertScope — the check recordConsent runs) and be ACTIVE (a
 * send on a retired topic is blocked anyway; a token for it is a dead row).
 * Collision retry on ER_DUP_ENTRY (the token is the only unique key).
 * `generate` is a test seam. → the token string
 */
async function mintUnsubToken(conn, {
  destination, topicKey, campaignId = null, contactId = null, sendRef = null,
} = {}, { generate = generateToken } = {}) {
  if (!conn || typeof conn.query !== 'function') throw new Error('mintUnsubToken: needs the caller\'s connection');
  const dest = optout.normalizeDestination(CHANNEL, destination);
  if (!dest) throw new Error(`mintUnsubToken: "${destination}" is not a valid address`);
  if (typeof topicKey !== 'string' || topicKey === MARKETING || topicKey === 'all') {
    throw new Error(`mintUnsubToken: a token names one marketing topic, not "${topicKey}"`);
  }
  await optout.assertScope(conn, CHANNEL, topicKey);
  const [[t]] = await conn.query(optout.FIND_SQL.topic, [topicKey]);
  if (!t || Number(t.active) !== 1) throw new Error(`mintUnsubToken: topic "${topicKey}" is not active`);
  const cid = optInt(campaignId, 'campaignId');
  const ctid = optInt(contactId, 'contactId');
  const ref = sendRef == null || sendRef === '' ? null : String(sendRef);
  if (ref !== null && ref.length > 64) throw new Error('mintUnsubToken: sendRef exceeds 64 characters');

  for (let i = 0; i < MINT_ATTEMPTS; i++) {
    const token = generate();
    try {
      await conn.query(UNSUB_SQL.insert, [token, CHANNEL, dest, topicKey, cid, ctid, ref]);
      return token;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  throw new Error(`mintUnsubToken: no unique token after ${MINT_ATTEMPTS} attempts`);
}

/** The unsubscribe URL on the landing origin (the one place it is built — lib/ctaLinks' convention). */
function urlFor(token) {
  const { publicUrl } = require('../lib/firmConfig');
  return `${publicUrl()}/u/${token}`;
}

/** The preference menu: the same page, scrolled to its form. */
function preferencesUrlFor(token) {
  return `${urlFor(token)}#prefs`;
}

/**
 * Is a topic received, given the states? Marketing stops every topic; an
 * opt_out topic is received unless opted out, an opt_in topic only when
 * opted in. `model` null (a topic deleted since mint) reads as opt_out.
 */
function receives(states, topicKey, model) {
  if (states[MARKETING] === 'opted_out') return false;
  const s = topicKey ? states[topicKey] : null;
  return model === 'opt_in' ? s === 'opted_in' : s !== 'opted_out';
}

/** scope → 'opted_out' | 'opted_in' | null for one destination (a plain read — see the header). */
async function readStates(q, destination, scopes) {
  const out = {};
  for (const s of scopes) out[s] = null;
  if (!scopes.length) return out;
  const [rows] = await q.query(optout.FIND_SQL.state, [CHANNEL, [destination], scopes]);
  for (const r of rows || []) {
    if (String(r.destination).toLowerCase() === destination && Object.prototype.hasOwnProperty.call(out, r.scope)) {
      out[r.scope] = r.state;
    }
  }
  return out;
}

const uniq = (a) => [...new Set(a)];

/**
 * The page's read. READ ONLY — a GET renders from this and link scanners
 * prefetch every GET. Format gate first: a malformed token never reaches SQL.
 * → null when unknown, else {
 *     token, destination, topic_key, topic_label, topic_exists, topic_consent_model,
 *     campaign_id, contact_id, send_ref, used_at,
 *     topics:  [{ topic_key, label, description, consent_model }]  (active email topics)
 *     states:  { marketing, <each active topic>, <the token's topic>: 'opted_out'|'opted_in'|null }
 *     receives: { <each active topic>: boolean }, topic_receives: boolean (the token's topic)
 *   }
 */
async function lookupToken(db, token) {
  if (typeof token !== 'string' || !PUBLIC_TOKEN_RE.test(token)) return null;
  const [[row]] = await db.query(UNSUB_SQL.get, [token]);
  if (!row) return null;
  const [topicRows] = await db.query(UNSUB_SQL.topics);
  const topics = (topicRows || []).map((t) => ({
    topic_key: String(t.topic_key), label: String(t.label),
    description: t.description == null ? null : String(t.description), consent_model: String(t.consent_model),
  }));
  const destination = String(row.destination);
  const exists = row.topic_channel != null && String(row.topic_channel) === CHANNEL;
  const states = await readStates(db, destination, uniq([MARKETING, ...topics.map((t) => t.topic_key), String(row.topic_key)]));
  const receivesMap = {};
  for (const t of topics) receivesMap[t.topic_key] = receives(states, t.topic_key, t.consent_model);
  const model = exists && row.topic_consent_model != null ? String(row.topic_consent_model) : null;
  return {
    token: String(row.token),
    destination,
    topic_key: String(row.topic_key),
    topic_label: exists && row.topic_label != null ? String(row.topic_label) : String(row.topic_key),
    topic_exists: exists,
    topic_consent_model: model,
    campaign_id: row.campaign_id == null ? null : Number(row.campaign_id),
    contact_id: row.contact_id == null ? null : Number(row.contact_id),
    send_ref: row.send_ref == null ? null : String(row.send_ref),
    used_at: row.used_at || null,
    topics,
    states,
    receives: receivesMap,
    topic_receives: receives(states, exists ? String(row.topic_key) : null, model),
  };
}

/**
 * The scope the token's own topic resolves to: the topic itself while it is
 * an email topic (retired ones included — an unsubscribe from a retired list
 * still records), else 'marketing'. A token whose topic row was deleted must
 * not throw away the recipient's unsubscribe: stopping all marketing honours
 * it; a narrower scope no longer exists.
 */
async function tokenScope(q, topicKey) {
  const [[t]] = await q.query(optout.FIND_SQL.topic, [topicKey]);
  return t && String(t.channel) === CHANNEL ? { scope: topicKey, fallback: false } : { scope: MARKETING, fallback: true };
}

function baseEvidence(t, { ip, userAgent, via }) {
  return {
    token: String(t.token),
    via,
    ip: ip ? String(ip) : null,
    user_agent: clip(userAgent, UA_MAX),
    ...(t.campaign_id != null ? { campaign_id: Number(t.campaign_id) } : {}),
  };
}

/**
 * RFC 8058 one-click: opt_out of the token's topic (D4), source 'one_click'.
 * NEVER throws on a bad token — an unknown or malformed one is
 * { ok: true, applied: false } (the route answers 200 either way: no oracle).
 * Infrastructure errors do throw (the route answers 500 — an unsubscribe that
 * did not record must not read as done).
 * → { ok: true, applied }
 */
async function oneClick(db, token, { ip = null, userAgent = null } = {}) {
  if (typeof token !== 'string' || !PUBLIC_TOKEN_RE.test(token)) return { ok: true, applied: false };
  return consentTx(db, async (conn) => {
    const [[t]] = await conn.query(UNSUB_SQL.lock, [token]);
    if (!t) return { ok: true, applied: false };
    const dest = String(t.destination);
    const { scope, fallback } = await tokenScope(conn, String(t.topic_key));
    const states = await readStates(conn, dest, [scope]);
    let applied = false;
    if (states[scope] !== 'opted_out') {
      const r = await optout.recordConsent(conn, {
        channel: CHANNEL, destination: dest, scope, action: 'opt_out', source: 'one_click',
        contactId: t.contact_id, sendRef: t.send_ref,
        evidence: {
          ...baseEvidence(t, { ip, userAgent, via: 'rfc8058' }),
          ...(fallback ? { topic_missing: String(t.topic_key) } : {}),
        },
      });
      applied = !r.duplicate;
    }
    await conn.query(UNSUB_SQL.used, [token]);
    return { ok: true, applied };
  }, { retries: 1 });
}

/** The prefs form's topic map → { [key]: 'in' | 'out' }; shape errors are 422. */
function readTopicMap(topics) {
  const out = Object.create(null);
  if (topics == null) return out;
  if (typeof topics !== 'object' || Array.isArray(topics)) throw new UnsubInputError('bad_topic', 'topics must be an object');
  for (const k of Object.keys(topics)) {
    const v = topics[k];
    if (!TOPIC_RE.test(k)) throw new UnsubInputError('bad_topic', 'unknown topic');
    if (v !== 'in' && v !== 'out') throw new UnsubInputError('bad_topic', 'a topic is "in" or "out"');
    out[k] = v;
  }
  return out;
}

/** The free-text note: trimmed, '' → null, capped at NOTE_MAX (never a refusal — an unsubscribe must not fail on a long note). */
function readNote(note) {
  if (note == null) return { note: null, truncated: false };
  const s = String(note).trim();
  if (!s) return { note: null, truncated: false };
  return s.length > NOTE_MAX ? { note: s.slice(0, NOTE_MAX), truncated: true } : { note: s, truncated: false };
}

/**
 * The consent follow-up assignee: app_setting consent_task_user_id, when it
 * names an ACTIVE user (user_auth 'authorized%' — intakeService's rule).
 * No default: unset → null (the caller alerts). Plain reads.
 */
async function resolveAssignee(q) {
  const { getSettings } = require('./settingsService'); // lazy require (convention)
  const { consent_task_user_id: raw } = await getSettings(q, ['consent_task_user_id']);
  const id = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[u]] = await q.query(UNSUB_SQL.assignee, [id]);
  return u ? id : null;
}

/**
 * The page's form. `action`:
 *   'unsubscribe'  opt_out of the token's topic            source unsub_page
 *   'all'          opt_out of scope 'marketing'            source unsub_page
 *   'prefs'        `topics` { key: 'in' } for each TICKED active email topic
 *                  (anything absent is 'out'); one event per scope whose
 *                  requested state differs from the current one, source
 *                  pref_page. Ticking a topic while all marketing is stopped
 *                  also opts 'marketing' back in — and then opts out every
 *                  unticked topic that would otherwise resume. Unknown,
 *                  inactive or non-email topic keys → 422, nothing written.
 * A request that changes nothing writes nothing. `note` (≤ 1000, trimmed)
 * rides on the first event's evidence and becomes ONE staff task AFTER the
 * commit (consent_task_user_id); unassigned → an IT warning instead.
 * → { ok: true, changed: [{ scope, action }], event_ids, task_id? }
 *   | { ok: false, code: 'not_found' }
 */
async function applyPage(db, token, { action, topics = null, note = null, ip = null, userAgent = null } = {}) {
  if (!ACTIONS.includes(action)) throw new UnsubInputError('bad_action', 'unknown action');
  const wanted = readTopicMap(topics);
  const { note: text, truncated } = readNote(note);
  // Input is judged BEFORE the token is: a bogus topic is 422 whether or not
  // the token exists, so the answer never tells a valid token from an unknown
  // one. A plain read on the pool — inside the transaction the first
  // consistent read must come AFTER the token lock (header).
  if (action === 'prefs' && Object.keys(wanted).length) {
    const [topicRows] = await db.query(UNSUB_SQL.topics);
    const known = new Set((topicRows || []).map((r) => String(r.topic_key)));
    for (const k of Object.keys(wanted)) if (!known.has(k)) throw new UnsubInputError('bad_topic', 'unknown topic');
  }
  if (typeof token !== 'string' || !PUBLIC_TOKEN_RE.test(token)) return { ok: false, code: 'not_found' };

  const out = await consentTx(db, async (conn) => {
    const [[t]] = await conn.query(UNSUB_SQL.lock, [token]);
    if (!t) return { ok: false, code: 'not_found' };
    const dest = String(t.destination);
    const [topicRows] = await conn.query(UNSUB_SQL.topics);
    const active = new Map((topicRows || []).map((r) => [String(r.topic_key), String(r.consent_model)]));
    // Re-checked under the lock: a topic retired between the two reads.
    if (action === 'prefs') {
      for (const k of Object.keys(wanted)) {
        if (!active.has(k)) throw new UnsubInputError('bad_topic', 'unknown topic');
      }
    }
    const own = await tokenScope(conn, String(t.topic_key));
    const keys = [...active.keys()].sort();
    const states = await readStates(conn, dest, uniq([MARKETING, ...keys, own.scope]));

    // The plan, in lock order: marketing first, then topics by key.
    const plan = [];
    if (action === 'unsubscribe') {
      if (states[own.scope] !== 'opted_out') plan.push({ scope: own.scope, action: 'opt_out', source: 'unsub_page' });
    } else if (action === 'all') {
      if (states[MARKETING] !== 'opted_out') plan.push({ scope: MARKETING, action: 'opt_out', source: 'unsub_page' });
    } else {
      const want = new Set(keys.filter((k) => wanted[k] === 'in'));
      let marketingOut = states[MARKETING] === 'opted_out';
      if (want.size && marketingOut) {
        plan.push({ scope: MARKETING, action: 'opt_in', source: 'pref_page' });
        marketingOut = false;
      }
      for (const k of keys) {
        const model = active.get(k);
        const topicIn = model === 'opt_in' ? states[k] === 'opted_in' : states[k] !== 'opted_out';
        if (want.has(k) && !topicIn) plan.push({ scope: k, action: 'opt_in', source: 'pref_page' });
        else if (!want.has(k) && topicIn && !marketingOut) plan.push({ scope: k, action: 'opt_out', source: 'pref_page' });
      }
    }

    const assignee = text ? await resolveAssignee(conn) : null;
    const eventIds = [];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const r = await optout.recordConsent(conn, {
        channel: CHANNEL, destination: dest, scope: p.scope, action: p.action, source: p.source,
        contactId: t.contact_id, sendRef: t.send_ref,
        evidence: {
          ...baseEvidence(t, { ip, userAgent, via: 'unsub_page' }),
          ...(p.scope === own.scope && own.fallback ? { topic_missing: String(t.topic_key) } : {}),
          // The note rides on the request's FIRST event (the ledger is its
          // durable home); note_unassigned marks one no task will carry.
          ...(i === 0 && text ? { note: text, ...(truncated ? { note_truncated: true } : {}), ...(assignee ? {} : { note_unassigned: true }) } : {}),
        },
      });
      if (r.event_id != null) eventIds.push(r.event_id);
    }
    await conn.query(UNSUB_SQL.used, [token]);
    return {
      ok: true,
      changed: plan.map((p) => ({ scope: p.scope, action: p.action })),
      event_ids: eventIds,
      _t: t, _assignee: assignee,
    };
  }, { retries: 1 });

  if (!out.ok) return out;
  const { _t: t, _assignee: assignee, ...result } = out;
  if (text) {
    // POST-COMMIT, failure-isolated: the consent change above has committed;
    // nothing here can undo it or fail the request.
    const taskId = await noteFollowUp(db, { t, note: text, truncated, assignee, changed: result.changed, eventIds: result.event_ids });
    if (taskId != null) result.task_id = taskId;
  }
  return result;
}

function describeChanges(changed) {
  if (!changed.length) return 'No consent change (preferences were already as submitted).';
  return 'Recorded: ' + changed.map((c) => `${c.action === 'opt_out' ? 'opted out of' : 'opted back in to'} ${c.scope === MARKETING ? 'all marketing email' : c.scope}`).join('; ') + '.';
}

/**
 * The free-text note → ONE staff task (consent_task_user_id), or — with no
 * usable assignee — an IT warning, once per UTC day, counting the ledger's
 * unassigned notes. A note that changed nothing has no ledger event to live
 * in, so it gets its own warning carrying the text (never a silent drop).
 * Never throws. → the task id, or null.
 */
async function noteFollowUp(db, { t, note, truncated, assignee, changed, eventIds }) {
  const { alert } = require('../lib/alerting'); // lazy require (convention)
  const dest = String(t.destination);
  try {
    if (!assignee) {
      let n = null;
      try { const [[r]] = await db.query(UNSUB_SQL.unassigned); n = r ? Number(r.n) : null; } catch (_) { /* the count is a nicety */ }
      const day = new Date().toISOString().slice(0, 10);
      await alert(db, {
        source: 'consent', kind: 'consent_task_unassigned', severity: 'warning',
        group_key: 'consent_task_unassigned', dedup_key: `consent_task_unassigned:${day}`,
        title: n == null ? 'consent_task_user_id unset — unsubscribe notes unassigned'
          : `consent_task_user_id unset — ${n} unsubscribe note${n === 1 ? '' : 's'} unassigned`,
        message: 'An unsubscribe-page note found no staff assignee: app_setting consent_task_user_id is unset or not an '
          + 'active user (Config → Firm → Marketing email & consent). The notes are in the consent ledger: '
          + "comm_consent_events where evidence->>'$.note_unassigned' = 'true'.",
      });
      if (!eventIds.length) {
        await alert(db, {
          source: 'consent', kind: 'consent_note_unassigned', severity: 'warning',
          group_key: 'consent_task_unassigned',
          dedup_key: `consent_note:${crypto.createHash('sha1').update(`${t.token}\n${note}`).digest('hex')}`,
          title: `Unsubscribe-page note from ${clip(dest, 200)} (no task — no assignee)`,
          message: note,
          context: { destination: dest, token: String(t.token), note, ...(truncated ? { note_truncated: true } : {}) },
        });
      }
      return null;
    }
    const taskService = require('./taskService'); // lazy require (convention)
    const details = [
      '',
      `Address: ${dest}`,
      `From the unsubscribe page of a ${t.topic_key} email${t.campaign_id != null ? ` (campaign #${t.campaign_id})` : ''}.`,
      describeChanges(changed),
      ...(t.contact_id != null ? [`Contact #${t.contact_id}.`] : []),
      ...(eventIds.length ? [`Consent ledger event #${eventIds[0]}.`] : []),
    ].join('\n');
    const room = 1000 - details.length;
    const body = note.length > room ? `${note.slice(0, Math.max(0, room - 1))}…` : note;
    const r = await taskService.createTask(db, {
      from: 0,
      to: assignee,
      title: clip(`Unsubscribe page note from ${dest}`, 100),
      desc: `${body}${details}`.slice(0, 1000),
      source: 'consent',
      link_type: t.contact_id != null ? 'contact' : null,
      link_id: t.contact_id != null ? String(t.contact_id) : null,
      // The full text, whatever the desc had room for.
      log_extra: { consent_note: note, ...(truncated ? { note_truncated: true } : {}), destination: dest },
    });
    return r && r.task_id != null ? Number(r.task_id) : null;
  } catch (err) {
    console.error('[unsub] note follow-up failed:', err.message);
    await Promise.resolve(alert(db, {
      source: 'consent', kind: 'consent_note_task_failed', severity: 'warning',
      group_key: 'consent_note_task_failed',
      title: `Unsubscribe-page note task not created (${clip(dest, 200)})`,
      message: `${err.message}\n\nNote: ${note}`,
      context: { destination: dest, token: String(t.token), event_ids: eventIds },
    })).catch(() => {});
    return null;
  }
}

module.exports = {
  UNSUB_SQL,
  ACTIONS,
  NOTE_MAX,
  UnsubInputError,
  mintUnsubToken,
  urlFor,
  preferencesUrlFor,
  lookupToken,
  oneClick,
  applyPage,
  // The consent follow-up assignee rule — also phoneConsentService's (YisraMail P2).
  resolveAssignee,
  // helpers (tests)
  receives,
};
