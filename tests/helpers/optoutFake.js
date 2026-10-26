// tests/helpers/optoutFake.js
//
// Answers services/optoutService.js's two lookups for an in-memory test world,
// by statement IDENTITY (FIND_SQL) — so a world that has never heard of opt-out
// keeps working, and a reworded statement fails loudly in the real-MySQL suite
// (tests/optout.mysql.test.js holds the predicate itself to MySQL 8.4).
//
//   answerOptout(sql, params, { phones, emails, contacts }) → [rows] | undefined
//     phones   [{ id, contact_id, phone, end_date?, sms_optout? }]
//     emails   [{ id, contact_id, email, end_date?, email_optout? }]
//     contacts [{ contact_id, contact_name }]  (or a Map of id → row)
// undefined = not an opt-out statement; the world goes on to its own handlers.
'use strict';

const { FIND_SQL } = require('../../services/optoutService');

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function nameOf(contacts, id) {
  if (!contacts) return null;
  const c = contacts instanceof Map ? contacts.get(Number(id)) : contacts.find((x) => Number(x.contact_id) === Number(id));
  return c && c.contact_name != null ? c.contact_name : null;
}

function answerOptout(sql, params, { phones = [], emails = [], contacts = null } = {}) {
  const s = norm(sql);
  if (s !== FIND_SQL.sms && s !== FIND_SQL.email) return undefined;
  const keys = new Set((params && params[0]) || []);
  const sms = s === FIND_SQL.sms;
  const rows = (sms ? phones : emails)
    .filter((r) => r.end_date == null
      && Number(sms ? r.sms_optout : r.email_optout) === 1
      && (sms ? keys.has(String(r.phone)) : [...keys].some((k) => String(k).toLowerCase() === String(r.email).toLowerCase())))
    .sort((a, b) => a.id - b.id)
    .map((r) => ({ row_id: r.id, contact_id: r.contact_id, destination: sms ? r.phone : r.email, contact_name: nameOf(contacts, r.contact_id) }));
  return [rows];
}

module.exports = { answerOptout };
