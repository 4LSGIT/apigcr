// tests/helpers/optoutFake.js
//
// Answers services/optoutService.js's lookups for an in-memory test world, by
// statement IDENTITY (FIND_SQL) — so a world that has never heard of opt-out
// keeps working, and a reworded statement fails loudly in the real-MySQL suite
// (tests/consentCore.mysql.test.js holds the predicates themselves to MySQL).
//
//   answerOptout(sql, params, { phones, emails, contacts, states, topics }) → [rows] | undefined
//     phones   [{ id, contact_id, phone, end_date?, sms_optout? }]
//     emails   [{ id, contact_id, email, end_date?, email_optout? }]
//     contacts [{ contact_id, contact_name }]  (or a Map of id → row)
//     states   [{ channel, destination, scope, state, last_event_id? }]  (comm_consent_state; default none)
//     topics   [{ topic_key, channel, consent_model, active? }]           (comm_topics; default none)
// undefined = not an opt-out statement; the world goes on to its own handlers.
// A world with no `states` is a world where only the row flags (the cache)
// carry consent — exactly today's data until the migration runs.
'use strict';

const { FIND_SQL } = require('../../services/optoutService');

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function nameOf(contacts, id) {
  if (!contacts) return null;
  const c = contacts instanceof Map ? contacts.get(Number(id)) : contacts.find((x) => Number(x.contact_id) === Number(id));
  return c && c.contact_name != null ? c.contact_name : null;
}

const lc = (v) => String(v).toLowerCase();

function answerOptout(sql, params, { phones = [], emails = [], contacts = null, states = [], topics = [] } = {}) {
  const s = norm(sql);
  if (s === FIND_SQL.sms || s === FIND_SQL.email) {
    const sms = s === FIND_SQL.sms;
    const keys = new Set(((params && params[0]) || []).map((k) => (sms ? String(k) : lc(k))));
    const rows = (sms ? phones : emails)
      .filter((r) => r.end_date == null && keys.has(sms ? String(r.phone) : lc(r.email)))
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ row_id: r.id, contact_id: r.contact_id, destination: sms ? r.phone : r.email,
        contact_name: nameOf(contacts, r.contact_id), cache_optout: Number(sms ? r.sms_optout : r.email_optout) === 1 ? 1 : 0 }));
    return [rows];
  }
  if (s === FIND_SQL.state) {
    const [channel, keys, scopes] = params;
    const k = new Set((keys || []).map(lc));
    return [states.filter((r) => r.channel === channel && k.has(lc(r.destination)) && (scopes || []).includes(r.scope))
      .map((r) => ({ destination: r.destination, scope: r.scope, state: r.state }))];
  }
  if (s === FIND_SQL.topic) {
    const t = topics.find((x) => x.topic_key === params[0]);
    return [t ? [{ channel: t.channel, consent_model: t.consent_model, active: t.active == null ? 1 : t.active }] : []];
  }
  if (s === FIND_SQL.version) {
    const [channel, keys] = params;
    const k = new Set((keys || []).map(lc));
    const by = new Map();
    for (const r of states) {
      if (r.channel !== channel || !k.has(lc(r.destination))) continue;
      by.set(lc(r.destination), Math.max(by.get(lc(r.destination)) || 0, Number(r.last_event_id) || 0));
    }
    return [[...by].map(([destination, version]) => ({ destination, version }))];
  }
  return undefined;
}

module.exports = { answerOptout };
