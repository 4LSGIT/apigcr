// lib/uploadTicket.js
//
/**
 * SIGNED UPLOAD TICKET — carries a destination + its context across the gap
 * lib/uploadTicket.js
 *
 * Documents S4. `POST /api/documents/upload-link` composes a Dropbox
 * destination and hands the browser a temporary upload link; the bytes then go
 * browser→Dropbox and this server hears nothing until the browser comes back to
 * `POST /api/documents/upload-commit`. Two HTTP moments, and the only thing
 * travelling between them is whatever the client chooses to send back.
 *
 * ── WHY A SIGNATURE AND NOT A SHAPE CHECK ─────────────────────────────────
 * The commit has to register a file and LINK IT TO A CASE. If the case came
 * out of the commit body unauthenticated, the endpoint would be a
 * "register any file against any case" verb wearing an upload's clothes —
 * which is precisely the laundering the S4 brief rules out, and which
 * POST /api/documents/register already offers deliberately and visibly for
 * anyone who wants it.
 *
 * The obvious cheaper guard — "does the committed path start with the case
 * folder we would have issued?" — is genuinely weaker, not merely simpler. It
 * proves the file is IN a folder; it does not prove THIS request is the one
 * that put it there, so any file already sitting in a case folder could be
 * (re)registered under a fabricated context. A MAC over the issued destination
 * makes the context unforgeable rather than merely plausible, and turns the
 * commit's guard into a verification instead of a heuristic.
 *
 * ── WHY THE PATH IS IN THE PAYLOAD AND STILL RE-CHECKED ───────────────────
 * `autorename:true` means the path we issued is a request. The committed file
 * may legitimately be "<issued> (1).pdf", so the commit cannot demand equality
 * — it checks the committed file's real, STATTED path against the issued
 * PARENT FOLDER. Signing the issued path is what makes that parent
 * trustworthy; see routes/api.documents.js for the check itself.
 *
 * ── FORMAT ────────────────────────────────────────────────────────────────
 *   <base64url(JSON payload)>.<base64url(HMAC-SHA256(payload))>
 *
 * Opaque to the client, which is the point — it is not a place to put anything
 * the client should read, and nothing here is secret (the destination path is
 * returned alongside it in plaintext); the signature protects INTEGRITY, not
 * confidentiality.
 *
 * Keyed on JWT_SECRET, the established convention for app-minted MACs in this
 * repo (services/portalAuthService.js hashes portal PINs with it,
 * routes/booking.js signs booking tokens with it). A missing secret THROWS at
 * call time rather than silently signing with `undefined` — which would
 * produce a MAC every instance agrees on and no attacker has to guess.
 *
 * Exports:
 *   sign(payload, ttlMs?) -> string
 *   verify(ticket)        -> payload      THROWS with .status on any failure
 *   DEFAULT_TTL_MS
 */

'use strict';

const crypto = require('crypto');

/**
 * Ticket lifetime.
 *
 * Deliberately LONGER than dropboxService.getTemporaryUploadLink's own default
 * duration (7200s): the upload link is the thing that must expire on Dropbox's
 * clock, and a ticket that died first would leave a browser holding a file it
 * successfully uploaded and cannot register. An extra hour absorbs clock skew
 * and a slow last file without ever outliving the link by enough to matter.
 */
const DEFAULT_TTL_MS = (7200 + 3600) * 1000;

/** Cap on a ticket the server will even attempt to parse (DoS hygiene). */
const MAX_TICKET_CHARS = 4096;

function _secret() {
  const s = process.env.JWT_SECRET;
  if (!s) {
    // Loud, and at call time rather than module load: this file is required by
    // the routes loader on every boot, and throwing there would take the whole
    // app down over a feature nobody may be using. (Contrast
    // lib/credentialCrypto.js, whose key IS required at module load — that one
    // guards data at rest.)
    throw new Error('uploadTicket: JWT_SECRET is not set — cannot sign or verify upload tickets');
  }
  return s;
}

function _b64u(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _unb64u(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function _mac(payloadB64) {
  return _b64u(crypto.createHmac('sha256', _secret()).update(payloadB64, 'utf8').digest());
}

/**
 * Mint a ticket.
 *
 * @param {object} payload   whatever the commit needs back, verbatim. The
 *                           issuing route puts { path, link_type, link_id }
 *                           in it; `exp` is added here so a caller cannot
 *                           forget it.
 * @param {number} [ttlMs]
 * @returns {string}
 */
function sign(payload, ttlMs = DEFAULT_TTL_MS) {
  const body = { ...(payload || {}), exp: Date.now() + Number(ttlMs || DEFAULT_TTL_MS) };
  const p = _b64u(JSON.stringify(body));
  return `${p}.${_mac(p)}`;
}

/**
 * Verify and decode a ticket.
 *
 * Every rejection is a 400 carrying the SAME class of message, on purpose: the
 * distinction between "expired", "tampered" and "malformed" is useful to us in
 * the log and useless to a caller who is either a browser holding a stale
 * ticket (retry the whole flow) or someone probing (tell them nothing).
 *
 * timingSafeEqual on equal-length buffers only — a length mismatch is compared
 * as a boolean first, since timingSafeEqual THROWS on differing lengths and an
 * exception is itself an oracle.
 *
 * @param {string} ticket
 * @returns {object} the payload
 * @throws Error with .status = 400
 */
function verify(ticket) {
  const bad = (why) => {
    const e = new Error('the upload ticket is invalid or has expired — start the upload again');
    e.status = 400;
    e.detail = why;
    return e;
  };

  if (typeof ticket !== 'string' || !ticket || ticket.length > MAX_TICKET_CHARS) {
    throw bad('missing or oversized');
  }
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot === ticket.length - 1) throw bad('malformed');

  const p   = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);

  const expected = _mac(p);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad('bad signature');

  let body;
  try {
    body = JSON.parse(_unb64u(p).toString('utf8'));
  } catch (_) {
    throw bad('unparseable payload');
  }
  if (!body || typeof body !== 'object') throw bad('non-object payload');
  if (!Number.isFinite(body.exp) || body.exp < Date.now()) throw bad('expired');

  return body;
}

module.exports = { sign, verify, DEFAULT_TTL_MS, MAX_TICKET_CHARS };
