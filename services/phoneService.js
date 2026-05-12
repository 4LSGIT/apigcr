// services/phoneService.js
//
// Telecom router — single chokepoint for all SMS/MMS sends.
// Public API:
//   sendSms(db, from, to, message)
//   sendMms(db, from, to, text, attachmentUrl)
//   getProviderMetadata() → public-facing per-provider metadata map
//
// Dispatch:
//   1. resolveLine: phone_lines lookup by 10-digit `from`. Reject if
//      missing/inactive/uncredentialed.
//   2. Capability check: adapter.capabilities[channel] AND, for MMS,
//      phone_lines.mms_capable.
//   3. Load the credential row (used for adapter authentication).
//   4. Adapter call. Adapter is responsible for HTTP/auth/provider-shape.
//   5. Log result to rc_messages_log (success or error).
//
// Adapter contract — services/adapters/phone/<provider>.js:
//   {
//     displayName: string,                     // UI label
//     capabilities: { sms: bool, mms: bool, ... },
//     credentialRequirements: { ...columnSpec },  // credentials-row matcher
//     formHints: { <field>: { help?, label?, placeholder? } },  // optional
//     async sendSms(db, { from, to, message,           line, credential }) → providerResult,
//     async sendMms(db, { from, to, text, attachmentUrl, line, credential }) → providerResult,
//   }
//   from is 10 digits (strip-only). to is +E.164. line + credential are
//   pre-loaded rows. Adapter returns whatever the provider returned;
//   shape is opaque to phoneService and to callers.
//
// Future cloud-tasks queue: insert at the adapter call line. Resolver,
// capability checks, credential load, and logging are all queue-agnostic.

const { loadCredential } = require('../lib/credentialInjection');

// Whitelist of provider → adapter. Avoids dynamic require() based on a
// DB-controlled string. Add a new entry to onboard a new provider.
const ADAPTERS = {
  ringcentral: require('./adapters/phone/ringcentral'),
  quo:         require('./adapters/phone/quo'),
};

// Frozen list of provider keys. Exported for admin route validation
// (Connections > Phone Lines tab). Single source of truth for what
// counts as a valid provider in the system.
const VALID_PROVIDERS = Object.freeze(Object.keys(ADAPTERS));

// ─── Number helpers ──────────────────────────────────────────────────

function tenDigit(num) {
  return num?.toString().replace(/\D/g, '').slice(-10) || '';
}

function normalizeE164(num) {
  if (!num) return null;
  const c = num.toString().replace(/\D/g, '');
  if (c.length === 11 && c.startsWith('1')) return `+${c}`;
  if (c.length === 10) return `+1${c}`;
  if (num.toString().startsWith('+')) return num.toString();
  return null;
}

// ─── Resolve ──────────────────────────────────────────────────────────

async function resolveLine(db, from) {
  const fromClean = tenDigit(from);
  if (!fromClean) throw new Error(`Invalid from number: ${from}`);

  const [[line]] = await db.query(
    `SELECT id, phone_number, display_name, provider, provider_id,
            credential_id, active, mms_capable
       FROM phone_lines
      WHERE phone_number = ? LIMIT 1`,
    [fromClean]
  );
  if (!line)               throw new Error(`No phone line found for number: ${from}`);
  if (!line.active)        throw new Error(`Phone line ${from} is inactive`);
  if (!line.credential_id) throw new Error(`Phone line ${from} has no credential_id assigned`);

  const adapter = ADAPTERS[line.provider];
  if (!adapter) {
    throw new Error(`No adapter registered for provider '${line.provider}' (line ${from})`);
  }

  const credential = await loadCredential(db, line.credential_id);
  if (!credential) {
    throw new Error(`Credential ${line.credential_id} not found for line ${from}`);
  }

  return { line, adapter, credential, fromClean };
}

// ─── Logging (rc_messages_log — temp table, real logs are auto-written
//     elsewhere; this stays for now per memory). Always log the 10-digit
//     `from`, never the provider_id (PN-id for Quo).
//     Provider-specific identifiers go inside rc_response. ────────────

function logToTable(db, kind, status, fields) {
  const cols = ['type', 'from_number', 'to_number', 'message'];
  const vals = [kind, fields.from, fields.to, fields.message ?? null];

  if (kind === 'mms') {
    cols.push('attachment_filename', 'attachment_url');
    vals.push(fields.attachmentFilename ?? null, fields.attachmentUrl ?? null);
  }

  cols.push('status');
  vals.push(status);

  if (status === 'success') {
    cols.push('rc_response');
    vals.push(JSON.stringify(fields.providerResult ?? {}));
  } else {
    cols.push('error_message');
    vals.push(fields.errorMessage ?? '');
  }

  db.query(
    `INSERT INTO rc_messages_log (${cols.join(',')})
     VALUES (${cols.map(() => '?').join(',')})`,
    vals
  ).catch(e => console.error('[phoneService] log write failed:', e.message));
}

// ─── Filename parsing for MMS log (best-effort metadata) ──────────────

function filenameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last || 'attachment';
  } catch {
    return 'attachment';
  }
}

// ─── Public: sendSms ──────────────────────────────────────────────────

async function sendSms(db, from, to, message) {
  if (!from)    throw new Error('phoneService.sendSms requires from');
  if (!to)      throw new Error('phoneService.sendSms requires to');
  if (!message) throw new Error('phoneService.sendSms requires message');

  const toE164 = normalizeE164(to);
  if (!toE164) throw new Error(`Invalid to number: ${to}`);

  const ctx = await resolveLine(db, from);

  if (!ctx.adapter.capabilities?.sms) {
    throw new Error(`Provider '${ctx.line.provider}' does not support SMS`);
  }

  try {
    const result = await ctx.adapter.sendSms(db, {
      from: ctx.fromClean,
      to:   toE164,
      message,
      line: ctx.line,
      credential: ctx.credential,
    });
    logToTable(db, 'sms', 'success', {
      from: ctx.fromClean, to: toE164, message, providerResult: result,
    });
    return result;
  } catch (err) {
    logToTable(db, 'sms', 'error', {
      from: ctx.fromClean, to: toE164, message, errorMessage: err.message,
    });
    throw err;
  }
}

// ─── Public: sendMms ──────────────────────────────────────────────────

async function sendMms(db, from, to, text, attachmentUrl) {
  if (!from)          throw new Error('phoneService.sendMms requires from');
  if (!to)            throw new Error('phoneService.sendMms requires to');
  if (!attachmentUrl) throw new Error('phoneService.sendMms requires attachmentUrl');

  const toE164 = normalizeE164(to);
  if (!toE164) throw new Error(`Invalid to number: ${to}`);

  const ctx = await resolveLine(db, from);

  if (!ctx.adapter.capabilities?.mms) {
    throw new Error(`Provider '${ctx.line.provider}' does not support MMS`);
  }
  if (!ctx.line.mms_capable) {
    throw new Error(`Phone line ${from} is not MMS-capable (provider=${ctx.line.provider})`);
  }

  const attachmentFilename = filenameFromUrl(attachmentUrl);

  try {
    const result = await ctx.adapter.sendMms(db, {
      from: ctx.fromClean,
      to:   toE164,
      text: text || '',
      attachmentUrl,
      line: ctx.line,
      credential: ctx.credential,
    });
    logToTable(db, 'mms', 'success', {
      from: ctx.fromClean, to: toE164, message: text || null,
      attachmentFilename, attachmentUrl, providerResult: result,
    });
    return result;
  } catch (err) {
    logToTable(db, 'mms', 'error', {
      from: ctx.fromClean, to: toE164, message: text || null,
      attachmentFilename, attachmentUrl, errorMessage: err.message,
    });
    throw err;
  }
}

// ─── Public: getProviderMetadata ─────────────────────────────────────

/**
 * Returns a public-facing per-provider metadata map. Used by the route
 * GET /admin response (slice 2) so the frontend can render the provider
 * dropdown, hints, credential filter, and capability-driven UI without
 * hardcoding provider names.
 *
 * Returned shape:
 *   {
 *     <provider_key>: {
 *       displayName: string,
 *       capabilities: { ...adapter-declared booleans },
 *       credentialRequirements: { ...adapter-declared key/value spec },
 *       formHints: { ...adapter-declared per-field hint map (may be empty) },
 *     },
 *     ...
 *   }
 *
 * Adapter `send` functions are NOT included; this is read-only metadata.
 */
function getProviderMetadata() {
  const result = {};
  for (const [key, adapter] of Object.entries(ADAPTERS)) {
    result[key] = {
      displayName: adapter.displayName,
      capabilities: adapter.capabilities,
      credentialRequirements: adapter.credentialRequirements,
      formHints: adapter.formHints || {},
    };
  }
  return result;
}

module.exports = {
  sendSms,
  sendMms,
  getProviderMetadata,

  // Exposed for the admin Phone Lines tab: VALID_PROVIDERS for route
  // validation, ADAPTERS for capability lookup (default mms_capable on
  // new lines). Read-only consumers — do not mutate.
  ADAPTERS,
  VALID_PROVIDERS,

  // Exposed for the temp test route + future channel additions.
  _resolveLine: resolveLine,
};