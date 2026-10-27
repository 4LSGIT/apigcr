// services/adapters/phone/quo.js
//
// Quo (formerly OpenPhone) adapter. SMS-only (no MMS).
//
// Auth: Connections api_key credential with config.header='Authorization'
// and config.key=<raw API key WITHOUT 'Bearer ' prefix>. Quo wants the key
// in the header value verbatim — buildAuthHeaders' api_key path produces
// exactly { Authorization: '<key>' } from that config.
//
// Quo's `from` field requires a phoneNumberId (PN...), which we carry on
// phone_lines.provider_id. The 10-digit `from` reaching this adapter is
// only used for logging (in phoneService).
//
// SELF-DESCRIBING METADATA: displayName, credentialRequirements, and
// formHints are read by phoneService.getProviderMetadata() and surfaced
// to the Connections > Phone Lines admin UI. Adding fields here
// auto-propagates to the frontend without route or template edits.

const { buildHeadersForCredential } = require('../../../lib/credentialInjection');

const QUO_API_URL = 'https://api.openphone.com/v1/messages';

async function sendSms(db, { to, message, line, credential }) {
  if (!line.provider_id) {
    throw new Error(
      `Quo line ${line.phone_number} is missing provider_id (PN... id) — ` +
      `set phone_lines.provider_id to the Quo phoneNumberId`
    );
  }

  const headers = await buildHeadersForCredential(db, credential.id, QUO_API_URL);
  if (!headers.Authorization) {
    throw new Error(
      `Quo credential ${credential.id} (${credential.name}) not configured ` +
      `or out of allowed_urls scope for ${QUO_API_URL}`
    );
  }

  const payload = {
    content: message,
    from:    line.provider_id,
    to:      [to],
    setInboxStatus: 'done',
  };

  const res = await fetch(QUO_API_URL, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  let json;
  try { json = await res.json(); } catch { json = null; }

  if (!res.ok) {
    throw new Error(`Quo API ${res.status}: ${JSON.stringify(json ?? {})}`);
  }
  return json?.data ?? json;
}

// ─── ARCHIVE FETCHERS (comms archive S1b — ref/COMMS_ARCHIVE_DESIGN.md §6.1) ──
//
// Read-side calls for services/commsArchiveMediaSweep.js. Quo's documented
// limit is 10 requests/second per API key, shared with live sends; the sweep
// paces itself far below it. Shapes are from Quo's API reference (no live
// probe was possible): the sweep treats any shape it does not recognise as
// DRIFT (park + alert), never as "nothing there".
//
// API calls return { status, json, retryAfterS, errorText } and never throw
// on an HTTP status; they throw err.code 'NO_AUTH' before sending when the
// credential yields no Authorization.
//
// fetchSigned() downloads from a SIGNED URL Quo returned: https only, and NO
// credential header ever goes to that host. Its errors carry the HOST only —
// the query string is the signature.

const QUO_API = 'https://api.openphone.com/v1';
const QUO_CALL_TIMEOUT_MS = 30_000;
const QUO_MEDIA_TIMEOUT_MS = 120_000;

function _ms(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

async function _quoAuth(db, credentialId, url) {
  const headers = await buildHeadersForCredential(db, credentialId, url);
  if (!headers.Authorization) {
    const e = new Error(`Quo credential ${credentialId} produced no Authorization for ${new URL(url).host}`);
    e.code = 'NO_AUTH';
    throw e;
  }
  return headers;
}

/** Pre-flight before any claim: does the credential yield an Authorization header? */
async function checkArchiveAuth(db, credentialId) {
  try {
    await _quoAuth(db, credentialId, `${QUO_API}/call-recordings/AC0`);
    return true;
  } catch (err) {
    if (err.code === 'NO_AUTH') return false;
    throw err;
  }
}

async function _quoGet(db, credentialId, url, timeoutMs) {
  const headers = await _quoAuth(db, credentialId, url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(_ms(timeoutMs, QUO_CALL_TIMEOUT_MS)) });
  const ra = res.headers.get('retry-after');
  const retryAfterS = ra == null || ra === '' ? null : Number(ra);
  let text = '';
  try { text = await res.text(); } catch (_) { /* body gone */ }
  let json = null;
  if (res.status === 200) {
    try { json = JSON.parse(text); } catch (_) { json = undefined; }   // undefined = unparseable 200
  }
  return { status: res.status, json, retryAfterS, errorText: res.status === 200 ? null : text.slice(0, 300) };
}

/** GET /v1/call-recordings/{callId} → documented { data: [{id,url,type,status,duration,startTime}] }. */
async function listCallRecordings(db, { credentialId, callId, timeoutMs }) {
  return _quoGet(db, credentialId, `${QUO_API}/call-recordings/${encodeURIComponent(callId)}`, timeoutMs);
}

/**
 * GET /v1/call-voicemails/{callId} (S1c) → documented { data: { id ^VM,
 * status completed|in-progress, recordingUrl, duration, transcript } }. What a
 * call WITHOUT a voicemail returns is undocumented (404 assumed — the sweep
 * holds 404s for 7 days before `none`, and alarms until the first archive).
 * The `transcript` is Quo's own: kept as a SECONDARY record (kind stt_raw,
 * R10 / C1) beside the archived audio — S2's transcript stays canonical.
 */
async function getCallVoicemail(db, { credentialId, callId, timeoutMs }) {
  return _quoGet(db, credentialId, `${QUO_API}/call-voicemails/${encodeURIComponent(callId)}`, timeoutMs);
}

/** GET /v1/messages/{id} → documented { data: { …, media: [{url, type}] } }; the media URLs are fresh. */
async function getMessage(db, { credentialId, messageId, timeoutMs }) {
  return _quoGet(db, credentialId, `${QUO_API}/messages/${encodeURIComponent(messageId)}`, timeoutMs);
}

/**
 * Download a Quo signed URL. Same return shape as the RC binary fetch plus
 * `host`. Not https → throws err.code 'BAD_URL' (drift). Redirects are
 * followed BY HAND (redirect: 'manual'), at most MAX_REDIRECTS hops, and
 * every hop must be https too — a redirect into http is refused, never
 * followed. The timeout bounds the whole chain including the body.
 */
const MAX_REDIRECTS = 3;

function _httpsUrl(raw, base) {
  let u;
  try { u = new URL(String(raw), base); } catch (_) { u = null; }
  if (!u || u.protocol !== 'https:') {
    const e = new Error(`not an https URL${u ? ` (${u.protocol}${base ? ' redirect' : ''})` : ''}`);
    e.code = 'BAD_URL';
    throw e;
  }
  return u;
}

async function fetchSigned(url, { timeoutMs } = {}) {
  let u = _httpsUrl(url);
  const signal = AbortSignal.timeout(_ms(timeoutMs, QUO_MEDIA_TIMEOUT_MS));
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(u.toString(), { headers: { 'Accept-Encoding': 'identity' }, redirect: 'manual', signal });
    if (res.status < 300 || res.status > 399 || !res.headers.get('location')) break;
    try { await res.body?.cancel(); } catch (_) { /* gone */ }
    if (hop >= MAX_REDIRECTS) {
      const e = new Error(`too many redirects from ${u.host}`);
      e.code = 'BAD_URL';
      throw e;
    }
    u = _httpsUrl(res.headers.get('location'), u);
  }
  if (res.status !== 200) {
    try { await res.body?.cancel(); } catch (_) { /* gone */ }
    return { status: res.status, host: u.host, contentType: res.headers.get('content-type'), contentLength: null, body: null };
  }
  const cl = res.headers.get('content-length');
  const { Readable } = require('stream');
  return {
    status: 200, host: u.host,
    contentType: res.headers.get('content-type'),
    contentLength: cl != null && cl !== '' && Number.isFinite(Number(cl)) ? Number(cl) : null,
    body: res.body ? Readable.fromWeb(res.body) : null,
  };
}

module.exports = {
  displayName: 'Quo',
  // outboundSync stays false until Quo's API is confirmed to expose delivery
  // status for listing (ref/PHONE_DELIVERY_DESIGN.md §2) — hook 16 only logs
  // message.delivered today, so a failed Quo send is invisible.
  // archiveFetch (comms archive media sweep): checkArchiveAuth, listCallRecordings, getCallVoicemail, getMessage, fetchSigned.
  capabilities: { sms: true, mms: false, outboundSync: false, archiveFetch: true },
  credentialRequirements: { type: 'api_key' },
  formHints: {
    provider_id: {
      help: "OpenPhone phone number ID (e.g. 'PNAkKuagWX'). Required by the Quo adapter to identify which OpenPhone number to send from.",
    },
  },
  sendSms,
  checkArchiveAuth,
  listCallRecordings,
  getCallVoicemail,
  getMessage,
  fetchSigned,
};