// tests/helpers/unsubWorld.js
//
/**
 * An in-memory world for the email unsubscribe surface (YisraMail P3) —
 * routes/unsubActions.js + services/unsubService.js over the REAL
 * optoutService writer. The CI-run sibling of tests/unsubService.mysql.test.js.
 *
 * Built ON tests/helpers/contactConsentWorld.js (its consent store answers
 * optoutService.FIND_SQL / WRITE_SQL by identity with the store's real
 * semantics — the event UNIQUE, the guarded upsert, the active-row cache
 * sync), adding what the unsubscribe surface touches on top:
 *   comm_unsub_tokens  answered by identity (unsubService.UNSUB_SQL)
 *   comm_topics        the page's active-topic list, with labels
 *   app_settings       getSettings' IN (?) read (consent_task_user_id)
 *   users              the assignee check
 * and a pool shape lib/withTransaction drives: getConnection() → a connection
 * with beginTransaction / commit / rollback / release. ROLLBACK restores the
 * world as it stood at BEGIN.
 *
 *   W.log      every statement and every BEGIN / COMMIT / ROLLBACK, in order —
 *              tests assert ordering (the note's task AFTER the COMMIT) and
 *              that a GET issued no write at all (W.writes()).
 *   W.unhandled  statements naming comm_unsub_tokens nobody answered (a test
 *              asserts it stays empty — a new statement must be modelled).
 */
'use strict';

const { makeWorld } = require('./contactConsentWorld');
const { UNSUB_SQL } = require('../../services/unsubService');

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const clone = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Date ? { __d: x.toISOString() } : x)),
  (k, x) => (x && typeof x === 'object' && typeof x.__d === 'string' && Object.keys(x).length === 1 ? new Date(x.__d) : x));

const DEFAULT_TOPICS = [
  { topic_key: 'newsletter', channel: 'email', label: 'Newsletter', description: 'Monthly news', consent_model: 'opt_out', active: 1 },
];

function makeUnsubWorld({ tokens = [], topics = DEFAULT_TOPICS, states = [], emails = [], contacts = [], settings = {}, users = [] } = {}) {
  const W = makeWorld({ topics: topics.map((t) => ({ ...t })), states, emails, contacts });
  W.tokens = tokens.map((t) => ({
    channel: 'email', campaign_id: null, contact_id: null, send_ref: null, used_at: null,
    created_at: new Date('2026-10-30T00:00:00Z'), ...t,
  }));
  W.settings = { ...settings };
  W.users = users.map((u) => ({ user_auth: 'authorized', ...u }));
  W.log = [];
  W.unsubUnhandled = [];
  const baseQuery = W.db.query;

  const lc = (v) => String(v).toLowerCase();
  const tok = (t) => W.tokens.find((x) => x.token === t) || null;   // exact: the column is utf8mb4_bin

  async function query(sql, p = []) {
    const s = norm(sql);
    W.log.push(s);
    if (s === norm(UNSUB_SQL.get)) {
      const t = tok(p[0]);
      if (!t) return [[]];
      const tp = W.topics.find((x) => x.topic_key === t.topic_key) || null;
      return [[{
        token: t.token, destination: t.destination, topic_key: t.topic_key, campaign_id: t.campaign_id,
        contact_id: t.contact_id, send_ref: t.send_ref, used_at: t.used_at,
        topic_label: tp ? tp.label : null, topic_channel: tp ? tp.channel : null, topic_consent_model: tp ? tp.consent_model : null,
      }]];
    }
    if (s === norm(UNSUB_SQL.lock)) {
      const t = tok(p[0]);
      return [t ? [{ token: t.token, destination: t.destination, topic_key: t.topic_key, campaign_id: t.campaign_id,
        contact_id: t.contact_id, send_ref: t.send_ref, used_at: t.used_at }] : []];
    }
    if (s === norm(UNSUB_SQL.used)) {
      const t = tok(p[0]);
      if (!t || t.used_at != null) return [{ affectedRows: 0 }];
      t.used_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (s === norm(UNSUB_SQL.insert)) {
      const [token, channel, destination, topic_key, campaign_id, contact_id, send_ref] = p;
      if (tok(token)) {
        const e = new Error(`Duplicate entry '${token}' for key 'comm_unsub_tokens.PRIMARY'`);
        e.code = 'ER_DUP_ENTRY'; e.sqlMessage = e.message; throw e;
      }
      W.tokens.push({ token, channel, destination, topic_key, campaign_id, contact_id, send_ref, used_at: null, created_at: new Date() });
      return [{ affectedRows: 1 }];
    }
    if (s === norm(UNSUB_SQL.topics)) {
      return [W.topics.filter((t) => t.channel === 'email' && Number(t.active == null ? 1 : t.active) === 1)
        .sort((a, b) => (a.topic_key < b.topic_key ? -1 : 1))
        .map((t) => ({ topic_key: t.topic_key, label: t.label || t.topic_key, description: t.description == null ? null : t.description, consent_model: t.consent_model }))];
    }
    if (s === norm(UNSUB_SQL.assignee)) {
      const u = W.users.find((x) => Number(x.user) === Number(p[0]) && /^authorized/.test(String(x.user_auth)));
      return [u ? [{ user: u.user }] : []];
    }
    if (s === norm(UNSUB_SQL.unassigned)) {
      const n = W.events.filter((e) => e.channel === 'email' && ['unsub_page', 'pref_page'].includes(e.source)
        && e.evidence && e.evidence.note_unassigned === true).length;
      return [[{ n }]];
    }
    if (s === 'SELECT `key`, `value` FROM app_settings WHERE `key` IN (?)') {
      const keys = p[0] || [];
      return [keys.filter((k) => Object.prototype.hasOwnProperty.call(W.settings, k)).map((k) => ({ key: k, value: W.settings[k] }))];
    }
    if (/comm_unsub_tokens/.test(s)) { W.unsubUnhandled.push(s); return /^SELECT/.test(s) ? [[]] : [{ affectedRows: 0 }]; }
    return baseQuery(sql, p);
  }

  // ROLLBACK restores the world as it stood at BEGIN.
  const STATE_KEYS = ['tokens', 'events', 'states', 'emails', 'phones', 'contacts'];
  function makeConn() {
    let snap = null;
    return {
      query,
      async beginTransaction() { W.log.push('BEGIN'); snap = Object.fromEntries(STATE_KEYS.map((k) => [k, clone(W[k])])); },
      async commit() { W.log.push('COMMIT'); snap = null; },
      async rollback() {
        W.log.push('ROLLBACK');
        if (snap) for (const k of STATE_KEYS) { W[k].length = 0; W[k].push(...snap[k]); }
        snap = null;
      },
      release() {},
      destroy() {},
    };
  }

  W.db = { query, getConnection: async () => makeConn() };
  /** Every write statement the world saw (INSERT / UPDATE / DELETE / REPLACE). */
  W.writes = () => W.log.filter((s) => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s));
  W.token = (t) => tok(t);
  W.eventsFor = (destination) => W.events.filter((e) => lc(e.destination) === lc(destination));
  return W;
}

module.exports = { makeUnsubWorld, DEFAULT_TOPICS };
