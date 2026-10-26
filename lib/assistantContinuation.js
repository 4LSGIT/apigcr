// lib/assistantContinuation.js
//
// Sealed state for an Ask Casey investigation that stopped on a budget (R1,
// read-loop continuation). The browser carries the token and hands it back
// when the user clicks "Keep going"; it can neither read nor alter it.
//
// Why sealed and not merely signed: the state holds the ACCUMULATED EVIDENCE.
// Action proposals are authorized by evidence rows (contactEvidenceSupports
// and kin), so evidence a client could write would let a crafted request
// manufacture an action card for any record — the token must be unforgeable
// (AES-256-GCM authenticates every byte). It is also encrypted because the
// rows are more than the browser is otherwise shown (uncited rows, comms
// snippets), and nothing about them needs to be visible client-side.
//
// The key is derived from JWT_SECRET (the established app-minted-MAC key) by
// HKDF with its own label, so a continuation is never a valid plan ticket
// (lib/assistantTicket.js, HMAC under the raw secret) and vice versa.

'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

// 15 minutes, the action-card freshness window (public/assistant.html
// ACTION_DRAFT_TTL_MS): a continuation's answer may carry a card backed by
// this evidence. Each grant re-seals, so the window slides with the user.
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_CHARS = 2000000;
const MAX_PLAIN_BYTES = 4 * 1024 * 1024;
const PREFIX = 'c1';
const AAD = Buffer.from('yisracase:assistant-continuation:v1', 'utf8');
const TOKEN_RE = /^c1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;

function bad(detail, status = 400) {
  const e = new Error('This investigation can no longer be continued: a continuation lasts 15 minutes and does not survive reopening a saved chat. Ask Casey again.');
  e.status = status;
  e.detail = detail;
  return e;
}

function key() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('assistantContinuation: JWT_SECRET is not set');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(value, 'utf8'), Buffer.alloc(0), AAD, 32));
}

const b64u = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (text) => Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function seal(payload, ttlMs = DEFAULT_TTL_MS) {
  const plain = zlib.deflateRawSync(Buffer.from(JSON.stringify({ ...(payload || {}), exp: Date.now() + ttlMs }), 'utf8'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const token = `${PREFIX}.${b64u(iv)}.${b64u(body)}.${b64u(cipher.getAuthTag())}`;
  if (token.length > MAX_TOKEN_CHARS) throw bad('state is too large', 413);
  return token;
}

function open(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_CHARS) throw bad('missing or oversized');
  const m = TOKEN_RE.exec(token);
  if (!m) throw bad('malformed');
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), unb64u(m[1]));
    decipher.setAAD(AAD);
    decipher.setAuthTag(unb64u(m[3]));
    plain = Buffer.concat([decipher.update(unb64u(m[2])), decipher.final()]);
  } catch (_) {
    throw bad('bad seal');
  }
  let parsed;
  try { parsed = JSON.parse(zlib.inflateRawSync(plain, { maxOutputLength: MAX_PLAIN_BYTES }).toString('utf8')); }
  catch (_) { throw bad('unparseable'); }
  if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.exp) || parsed.exp < Date.now()) {
    throw bad('expired or invalid payload');
  }
  return parsed;
}

module.exports = { seal, open, DEFAULT_TTL_MS, MAX_TOKEN_CHARS };
