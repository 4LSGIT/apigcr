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

module.exports = {
  displayName: 'RingCentral',
  capabilities: { sms: true, mms: true },
  credentialRequirements: { type: 'oauth2', oauth_status: 'connected' },
  formHints: {
    provider_id: {
      help: 'RingCentral extension ID. Usually left blank on single-extension accounts.',
    },
  },
  sendSms,
  sendMms,
};