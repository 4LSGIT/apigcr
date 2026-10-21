// services/adapters/phone/ringcentral.js
//
// RingCentral telecom adapter. Auth via Connections oauth2 — token lifecycle
// is owned entirely by oauthService (lazy refresh, GET_LOCK mutex, alert
// chain). This adapter is HTTP-only.
//
// LIMITER: Bottleneck retained at maxConcurrent=1, minTime=1875ms — RC's
// per-extension SMS rate limit hasn't moved and the limiter is the only
// thing keeping us under it. Do NOT remove until the queue cutover takes
// over rate limiting.
//
// MMS quirks preserved from the legacy ringcentralService:
//   - Strip Content-Type parameters (qs=, charset=, boundary=) before
//     forwarding to RC; RC's media-type check doesn't normalize and
//     rejects e.g. "application/pdf; qs=0.001" with MSG-348.
//   - 1.5MB attachment cap.
//   - PDFs work in practice despite not being on RC's published spec.
//
// SELF-DESCRIBING METADATA: displayName, credentialRequirements, and
// formHints are read by phoneService.getProviderMetadata() and surfaced
// to the Connections > Phone Lines admin UI. Adding fields here
// auto-propagates to the frontend without route or template edits.

const Bottleneck = require('bottleneck');
const { buildHeadersForCredential } = require('../../../lib/credentialInjection');

const SMS_URL = 'https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms';
const MMS_URL = 'https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/mms';
const MAX_ATTACHMENT_BYTES = 1.5 * 1024 * 1024;

const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1875 });

// `from` arrives 10-digit (stripped by phoneService); RC needs +E.164.
function plus1(num) {
  if (num?.toString().startsWith('+')) return num;
  return `+1${num}`;
}

// ─── SMS ─────────────────────────────────────────────────────────────

const sendSmsThroughLimiter = limiter.wrap(
  async (authHeaders, fromE164, toE164, message) => {
    const res = await fetch(SMS_URL, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: { phoneNumber: fromE164 },
        to:   [{ phoneNumber: toE164 }],
        text: message,
      }),
    });
    if (!res.ok) throw new Error(`RingCentral SMS ${res.status}: ${await res.text()}`);
    return res.json();
  }
);

async function sendSms(db, { from, to, message, credential }) {
  const headers = await buildHeadersForCredential(db, credential.id, SMS_URL);
  if (!headers.Authorization) {
    throw new Error(
      `RingCentral credential ${credential.id} (${credential.name}) not connected ` +
      `or out of allowed_urls scope for ${SMS_URL}`
    );
  }
  return sendSmsThroughLimiter(headers, plus1(from), to, message);
}

// ─── MMS ─────────────────────────────────────────────────────────────

const sendMmsThroughLimiter = limiter.wrap(
  async (authHeaders, fromE164, toE164, text, countryIso, buffer, filename, contentType) => {
    const form = new FormData();
    form.append('from', fromE164);
    form.append('to',   toE164);
    if (text) form.append('text', text);
    form.append('country', JSON.stringify({ isoCode: countryIso }));
    form.append('attachment', new Blob([buffer], { type: contentType }), filename);

    const res = await fetch(MMS_URL, {
      method: 'POST',
      // undici sets the multipart boundary from the FormData body.
      headers: { ...authHeaders },
      body: form,
    });
    if (!res.ok) throw new Error(`RingCentral MMS ${res.status}: ${await res.text()}`);
    return res.json();
  }
);

function filenameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last || 'attachment';
  } catch {
    return 'attachment';
  }
}

async function sendMms(db, { from, to, text, attachmentUrl, credential }) {
  // Fetch the attachment outside the limiter — limiter guards the RC POST.
  const fetchRes = await fetch(attachmentUrl);
  if (!fetchRes.ok) {
    throw new Error(`Failed to fetch attachment: ${fetchRes.status} ${fetchRes.statusText}`);
  }
  const buffer = Buffer.from(await fetchRes.arrayBuffer());
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large (${buffer.length} bytes; max ${MAX_ATTACHMENT_BYTES})`);
  }

  // RC media-type quirk: strip parameters from Content-Type. See block comment.
  const rawCT = fetchRes.headers.get('content-type') || 'application/octet-stream';
  const contentType = rawCT.split(';')[0].trim() || 'application/octet-stream';
  const filename = filenameFromUrl(attachmentUrl);

  const headers = await buildHeadersForCredential(db, credential.id, MMS_URL);
  if (!headers.Authorization) {
    throw new Error(
      `RingCentral credential ${credential.id} (${credential.name}) not connected ` +
      `or out of allowed_urls scope for ${MMS_URL}`
    );
  }

  return sendMmsThroughLimiter(
    headers, plus1(from), to, text, 'US', buffer, filename, contentType
  );
}

// ─── ARCHIVE FETCHERS (comms archive S1a — ref/COMMS_ARCHIVE_DESIGN.md §6.1) ──
//
// Read-side calls for services/commsArchiveSweep.js. Both endpoints are in
// RC's HEAVY rate group (10/min, shared with live call ingest's call-log
// reads), so they do NOT ride the SMS limiter above — different group, and
// the sweeper paces itself (≤ heavy_per_tick per tick, ≥ 20 s apart). Every
// response hands back the X-Rate-Limit-* headers and Retry-After so the
// sweeper can end its tick early.
//
// They NEVER throw on an HTTP status — the sweeper decides whose side a
// status is on. They throw only:
//   err.code 'NO_AUTH'  the credential produced no Authorization header
//                       (disconnected, refresh failed, or URL out of
//                       allowed_urls) — BEFORE any request is sent;
//   network errors      (timeouts, sockets) — provider-side transients.
//
// `~` in the paths is load-bearing (the authenticated account): never
// percent-encode it — RC 404s on %7E.

const RC_PLATFORM = 'https://platform.ringcentral.com';
const RC_MEDIA    = 'https://media.ringcentral.com';
const ARCHIVE_TIMEOUT_MS = 120_000;   // default bound, whole request incl. body; a 4 h call is ~58 MB
const CALL_LOG_TIMEOUT_MS = 30_000;

function _ms(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function recordingContentUrl(recordingId) {
  return `${RC_MEDIA}/restapi/v1.0/account/~/recording/${encodeURIComponent(recordingId)}/content`;
}

function callLogUrl(telephonySessionId, dateFrom, dateTo) {
  const q = new URLSearchParams({
    telephonySessionId,
    view: 'Detailed',
    perPage: '100',
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
  });
  return `${RC_PLATFORM}/restapi/v1.0/account/~/call-log?${q}`;
}

async function _authHeaders(db, credentialId, url) {
  const headers = await buildHeadersForCredential(db, credentialId, url);
  if (!headers.Authorization) {
    const e = new Error(`RingCentral credential ${credentialId} produced no Authorization for ${new URL(url).host}`);
    e.code = 'NO_AUTH';
    throw e;
  }
  return headers;
}

function _rateInfo(res) {
  const h = (k) => res.headers.get(k);
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return {
    group:     h('x-rate-limit-group'),
    limit:     num(h('x-rate-limit-limit')),
    remaining: num(h('x-rate-limit-remaining')),
    window:    num(h('x-rate-limit-window')),
    retryAfterS: num(h('retry-after')),
  };
}

/**
 * Pre-flight: does this credential yield an Authorization header for the
 * media host? Run before claiming any row (no RC request is made — the
 * token comes from oauthService's cache / refresh).
 */
async function checkArchiveAuth(db, credentialId) {
  try {
    await _authHeaders(db, credentialId, recordingContentUrl('0'));
    return true;
  } catch (err) {
    if (err.code === 'NO_AUTH') return false;
    throw err;
  }
}

/**
 * GET a recording's bytes. Returns the RESPONSE, unconsumed on 200:
 *   { status, contentType, contentLength, body (Node Readable | null),
 *     rate, errorText }
 * The caller must consume or destroy `body`. `timeoutMs` bounds the whole
 * request INCLUDING the body (the abort signal ends the stream too).
 *
 * Accept-Encoding: identity — fetch (undici) transparently DECOMPRESSES a
 * gzip/br body while Content-Length still counts the compressed bytes, so a
 * compressed response would fail the archive's length check every time.
 */
async function fetchRecordingContent(db, { credentialId, recordingId, timeoutMs }) {
  return _fetchBinary(db, credentialId, recordingContentUrl(recordingId), timeoutMs);
}

/**
 * GET one MMS attachment's bytes (S1b) — the MEDIUM rate group. `~` is the
 * authenticated extension: rc2 (2486213656) is a second number on the main
 * extension (every RC webhook and rc2's own MMS URIs carry extension
 * 55880693, verified 2026-10-14), so one path serves both lines and no
 * extension id is stored anywhere. Same return shape as
 * fetchRecordingContent.
 */
async function fetchMessageAttachment(db, { credentialId, messageId, attachmentId, timeoutMs }) {
  const url = `${RC_MEDIA}/restapi/v1.0/account/~/extension/~/message-store/` +
    `${encodeURIComponent(messageId)}/content/${encodeURIComponent(attachmentId)}`;
  return _fetchBinary(db, credentialId, url, timeoutMs);
}

/**
 * List the extension's VOICEMAILS (S1c) — message-store, LIGHT rate group
 * (probed 2026-10-14: x-rate-limit-group light). Newest first, paged.
 * Returns { status, json, rate, errorText }; never throws on a status
 * (NO_AUTH before sending). The sweep validates the shape.
 */
async function listVoicemails(db, { credentialId, dateFrom, page = 1, perPage = 100, timeoutMs }) {
  const q = new URLSearchParams({
    messageType: 'VoiceMail',
    dateFrom: (dateFrom instanceof Date ? dateFrom : new Date(dateFrom)).toISOString(),
    perPage: String(perPage),
    page: String(page),
  });
  const url = `${RC_PLATFORM}/restapi/v1.0/account/~/extension/~/message-store?${q}`;
  const headers = await _authHeaders(db, credentialId, url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(_ms(timeoutMs, CALL_LOG_TIMEOUT_MS)) });
  const rate = _rateInfo(res);
  let text = '';
  try { text = await res.text(); } catch (_) { /* body gone */ }
  let json = null;
  if (res.status === 200) {
    try { json = JSON.parse(text); } catch (_) { json = undefined; }   // undefined = unparseable 200
  }
  return { status: res.status, json, rate, errorText: res.status === 200 ? null : text.slice(0, 300) };
}

async function _fetchBinary(db, credentialId, url, timeoutMs) {
  const headers = await _authHeaders(db, credentialId, url);
  const res = await fetch(url, {
    headers: { ...headers, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(_ms(timeoutMs, ARCHIVE_TIMEOUT_MS)),
  });
  const rate = _rateInfo(res);
  if (res.status !== 200) {
    let errorText = '';
    try { errorText = (await res.text()).slice(0, 300); } catch (_) { /* body gone */ }
    return { status: res.status, contentType: res.headers.get('content-type'), contentLength: null, body: null, rate, errorText };
  }
  const cl = res.headers.get('content-length');
  const { Readable } = require('stream');
  return {
    status: 200,
    contentType: res.headers.get('content-type'),
    contentLength: cl != null && cl !== '' && Number.isFinite(Number(cl)) ? Number(cl) : null,
    body: res.body ? Readable.fromWeb(res.body) : null,
    rate,
    errorText: null,
  };
}

/**
 * Recover the recordings of a call that reached us only as a
 * `tsi:<telephonySessionId>` ref (no call-log data at ingest). RC's call-log
 * defaults dateFrom to dateTo − 24 h, so the window is passed explicitly
 * around the call: [around − 2 d, around + 2 d].
 *
 * Returns { status, recordings: [{id, contentType}], records, rawRecords, rate, errorText }.
 * `records` = how many call-log records matched the session (0 = RC has not
 * logged the call yet, or never will); `rawRecords` = how many RC returned
 * before that filter (rawRecords > 0 with records 0 = the filter or the field
 * changed shape — the sweep alerts instead of concluding "no recording");
 * recordings are de-duplicated across records and their legs.
 *
 * ONLY records whose telephonySessionId EQUALS the requested one count. If
 * RC ever ignored the filter, a page of up to 100 other calls' recordings
 * would otherwise be filed under THIS call's party and line — the grant
 * anchor for privileged audio. A record without the field is dropped too.
 */
async function findSessionRecordings(db, { credentialId, telephonySessionId, around, timeoutMs }) {
  const t = around instanceof Date ? around : new Date(around);
  const url = callLogUrl(
    telephonySessionId,
    new Date(t.getTime() - 2 * 86400_000),
    new Date(t.getTime() + 2 * 86400_000),
  );
  const headers = await _authHeaders(db, credentialId, url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(_ms(timeoutMs, CALL_LOG_TIMEOUT_MS)) });
  const rate = _rateInfo(res);
  if (res.status !== 200) {
    let errorText = '';
    try { errorText = (await res.text()).slice(0, 300); } catch (_) { /* body gone */ }
    return { status: res.status, recordings: [], records: 0, rawRecords: 0, rate, errorText };
  }
  const json = await res.json();
  const raw = Array.isArray(json && json.records) ? json.records : [];
  const records = raw.filter(rec => rec && rec.telephonySessionId === telephonySessionId);
  const seen = new Map();
  const take = (r) => {
    if (r && r.id != null && !seen.has(String(r.id))) {
      seen.set(String(r.id), { id: String(r.id), contentType: r.contentType || null });
    }
  };
  for (const rec of records) {
    take(rec.recording);
    for (const leg of (Array.isArray(rec.legs) ? rec.legs : [])) take(leg.recording);
  }
  return { status: 200, recordings: [...seen.values()], records: records.length, rawRecords: raw.length, rate, errorText: null };
}

// ─── OUTBOUND DELIVERY SYNC (phone-delivery S1 — ref/PHONE_DELIVERY_DESIGN.md) ──
//
// Read side for services/phoneDeliveryService.js. Same endpoint family as
// listVoicemails (message-store list — probed LIGHT rate group 2026-10-14; the
// sync re-checks each response's rate.group and parks on 429). Everything
// RingCentral-shaped — messageStatus words, SMS-* error codes, +1 phones, the
// synthetic text/plain attachment — is translated HERE; the core service and
// the UI only ever see the normalized vocabulary below.

/**
 * RC messageStatus → normalized delivery state (design §3).
 * Unknown statuses map to 'pending' (not yet terminal — the next window
 * re-checks) so a provider vocabulary surprise can never fabricate a verdict.
 */
const DELIVERY_STATE = Object.freeze({
  Queued: 'pending',
  Sent: 'sent',
  Delivered: 'delivered',
  SendingFailed: 'failed',
  DeliveryFailed: 'failed',
});

/**
 * RC deliveryErrorCode → normalized failure reason (design §3; source:
 * developers.ringcentral.com/guide/messaging/sms/sms-errors). Codes not
 * listed → 'unknown'.
 */
const DELIVERY_REASON = Object.freeze({
  'SMS-RC-410': 'unreachable', 'SMS-UP-410': 'unreachable',
  'SMS-CAR-400': 'unreachable', 'SMS-CAR-411': 'unreachable', 'SMS-CAR-412': 'unreachable',
  'SMS-RC-413': 'opted_out', 'SMS-UP-413': 'opted_out', 'SMS-CAR-413': 'opted_out',
  'SMS-RC-430': 'spam_content', 'SMS-UP-430': 'spam_content', 'SMS-UP-433': 'spam_content',
  'SMS-UP-431': 'sender_flagged',
});

/** Strip a +1 from a 12-char +1NNNNNNNNNN; anything else passes through (wf19 step-3 semantics). */
function _norm10(v) {
  if (v == null) return '';
  const s = String(v);
  return (s.length === 12 && s.charAt(0) === '+' && s.charAt(1) === '1' && /^\d{10}$/.test(s.slice(2)))
    ? s.slice(2)
    : s;
}

/** messageStatus + deliveryErrorCode → { state, reason, provider_code }. */
function _mapDelivery(messageStatus, code) {
  const state = DELIVERY_STATE[messageStatus] || 'pending';
  const provider_code = code != null && String(code).trim() !== '' ? String(code).trim() : null;
  return {
    state,
    reason: state === 'failed' ? (DELIVERY_REASON[provider_code] || 'unknown') : null,
    provider_code,
  };
}

/**
 * One RC message-store record → NormalizedOutbound (design §3), or null for a
 * record the sync must not touch (not SMS / not Outbound / no id). The
 * deliveryErrorCode has been seen record-level and per-`to` entry depending
 * on RC product line — read both, record-level first.
 */
function _mapOutboundRecord(rec) {
  if (!rec || rec.id == null) return null;
  if (rec.type !== 'SMS' || rec.direction !== 'Outbound') return null;
  const to0 = Array.isArray(rec.to) ? (rec.to[0] || {}) : {};
  const attachments = (Array.isArray(rec.attachments) ? rec.attachments : [])
    .filter(a => !(a && a.type === 'Text' && a.contentType === 'text/plain'))
    .map(a => ({
      id: a && a.id != null ? String(a.id) : '',
      type: a && a.type != null ? String(a.type) : '',
      contentType: a && a.contentType != null ? String(a.contentType) : '',
    }));
  return {
    provider: 'ringcentral',
    provider_ref: String(rec.id),
    from: _norm10(rec.from && rec.from.phoneNumber),
    to: _norm10(to0.phoneNumber),
    body: rec.subject != null ? String(rec.subject) : '',
    ts: rec.creationTime != null ? String(rec.creationTime) : '',
    conversation_id: rec.conversation && rec.conversation.id != null ? String(rec.conversation.id) : '',
    attachments,
    delivery: _mapDelivery(rec.messageStatus, rec.deliveryErrorCode ?? to0.deliveryErrorCode),
  };
}

/**
 * List the extension's OUTBOUND SMS in a window — message-store, LIGHT rate
 * group (same endpoint family as listVoicemails). Newest first, paged.
 * Returns { status, records: [NormalizedOutbound], page, totalPages, rate,
 * errorText }; never throws on an HTTP status (NO_AUTH before sending).
 * Records RC returns that are not Outbound SMS are dropped here, counted by
 * nobody — the query already filters, so a dropped record is shape drift the
 * next failed stamp surfaces.
 */
async function listOutbound(db, { credentialId, sinceISO, untilISO, page = 1, perPage = 100, timeoutMs }) {
  const q = new URLSearchParams({
    messageType: 'SMS',
    direction: 'Outbound',
    dateFrom: new Date(sinceISO).toISOString(),
    dateTo: new Date(untilISO).toISOString(),
    perPage: String(perPage),
    page: String(page),
  });
  const url = `${RC_PLATFORM}/restapi/v1.0/account/~/extension/~/message-store?${q}`;
  const headers = await _authHeaders(db, credentialId, url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(_ms(timeoutMs, CALL_LOG_TIMEOUT_MS)) });
  const rate = _rateInfo(res);
  let text = '';
  try { text = await res.text(); } catch (_) { /* body gone */ }
  if (res.status !== 200) {
    return { status: res.status, records: [], page, totalPages: null, rate, errorText: text.slice(0, 300) };
  }
  let json = null;
  try { json = JSON.parse(text); } catch (_) {
    return { status: 200, records: [], page, totalPages: null, rate, errorText: 'unparseable 200 body' };
  }
  const raw = Array.isArray(json && json.records) ? json.records : [];
  const records = raw.map(_mapOutboundRecord).filter(Boolean);
  const paging = json && json.paging ? json.paging : {};
  return {
    status: 200,
    records,
    page: Number(paging.page) || page,
    totalPages: Number.isFinite(Number(paging.totalPages)) ? Number(paging.totalPages) : null,
    rate,
    errorText: null,
  };
}

module.exports = {
  displayName: 'RingCentral',
  capabilities: { sms: true, mms: true, outboundSync: true },
  credentialRequirements: { type: 'oauth2', oauth_status: 'connected' },
  formHints: {
    provider_id: {
      help: 'RingCentral extension ID. Usually left blank on single-extension accounts.',
    },
  },
  sendSms,
  sendMms,
  checkArchiveAuth,
  fetchRecordingContent,
  fetchMessageAttachment,
  findSessionRecordings,
  listVoicemails,
  listOutbound,
  // Exported for testing — the RC→normalized translation tables
  _mapDelivery,
  _mapOutboundRecord,
  _norm10,
};