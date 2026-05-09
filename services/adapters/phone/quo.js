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

const fetch = require('node-fetch');
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

module.exports = {
  capabilities: { sms: true, mms: false },
  sendSms,
};