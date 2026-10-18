// lib/assistantTicket.js
//
// Short-lived integrity ticket for an approved Assistant query plan. The
// browser may display the plan and return it later, possibly to another Cloud
// Run instance; the HMAC proves that the SQL is exactly what this server
// validated. Nothing in the ticket is secret (the UI displays the SQL under
// Technical details). JWT_SECRET is the established app-minted-MAC key.

'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 20 * 60 * 1000;
const MAX_TICKET_CHARS = 40000;

function bad(detail) {
  const e = new Error('This query plan is invalid or has expired — ask the assistant again.');
  e.status = 400;
  e.detail = detail;
  return e;
}

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('assistantTicket: JWT_SECRET is not set');
  return value;
}

const b64u = (value) => Buffer.from(value).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (value) => Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const mac = (body) => b64u(crypto.createHmac('sha256', secret()).update(body, 'utf8').digest());

function sign(payload, ttlMs = DEFAULT_TTL_MS) {
  const body = b64u(JSON.stringify({ ...(payload || {}), exp: Date.now() + ttlMs }));
  const ticket = `${body}.${mac(body)}`;
  if (ticket.length > MAX_TICKET_CHARS) throw bad('plan is too large');
  return ticket;
}

function verify(ticket) {
  if (typeof ticket !== 'string' || !ticket || ticket.length > MAX_TICKET_CHARS) {
    throw bad('missing or oversized');
  }
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot !== ticket.lastIndexOf('.') || dot === ticket.length - 1) throw bad('malformed');
  const body = ticket.slice(0, dot);
  const got = Buffer.from(ticket.slice(dot + 1), 'utf8');
  const want = Buffer.from(mac(body), 'utf8');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw bad('bad signature');
  let parsed;
  try { parsed = JSON.parse(unb64u(body).toString('utf8')); }
  catch (_) { throw bad('unparseable'); }
  if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.exp) || parsed.exp < Date.now()) {
    throw bad('expired or invalid payload');
  }
  return parsed;
}

module.exports = { sign, verify, DEFAULT_TTL_MS, MAX_TICKET_CHARS };
