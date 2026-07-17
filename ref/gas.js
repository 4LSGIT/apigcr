// File: forwardEmailsToIngest.gs
// ─────────────────────────────────────────────────────────────────────────
// YisraCase Email Ingest — Gmail Apps Script forwarder (replacement)
// 
// Mission: replace the legacy POST to /logEmail with a canonical-envelope
// POST to /api/email/ingest. The new receiver dedupes by
// (source='gmail-firm', headers.message_id=<Gmail internal ID>) which
// preserves continuity with the 28,658 historical gmail-firm rows in
// email_log.message_id.
//
// Two pre-existing side jobs are preserved verbatim for now:
//   1. POST to a Pabbly relay when To: docs@4lsg.com
//   2. Gmail-forward of Clio "Payment method submitted by ..." emails to
//      Shoshana, only on single-message threads
// Both have inline removal instructions for a future cleanup phase.
//
// Trigger: time-based (every N minutes). Pattern: label-as-state — process
// every threaded message under CONFIG.triggerLabelName, remove the label
// from the thread only if every message succeeded. Receiver dedup makes
// re-posting on partial failure safe.
//
// Per-message label removal is NOT possible with basic GmailApp (labels
// are exposed at thread scope only). Documented fallback: thread label
// stays if ANY message in the thread fails; next trigger run re-POSTs all
// messages in that thread (already-ingested ones return status='duplicate').
//
// Deployment:
//   1. Paste over the existing forwardEmailsToWebhook script.
//   2. Set CONFIG.apiKey to the real gmail-firm API key (48-char hex).
//   3. Run testWithLastEmail() first — verifies envelope + endpoint round
//      trip on the most recent labeled message WITHOUT removing the label
//      and WITHOUT firing side jobs.
//   4. Swap the time-based trigger from forwardEmailsToWebhook (old) to
//      forwardEmailsToIngest (this).
//   5. (See MANUAL TEST PLAN at bottom of file.)
// ─────────────────────────────────────────────────────────────────────────


// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  endpoint:         'https://app.4lsg.com/api/email/ingest',
  apiKey:           'c8c6ab759067328228def726508773ec97f466874098c88b',
  source:           'gmail-firm',
  adapterVer:       'gas-1.0',
  schemaVer:        '1',
  triggerLabelName: 'Trigger Label',

  // Legacy side-job — to be removed; see inline notes
  pabblyDocsRelay: {
    enabled:        true,
    url:            'https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjUwNTY0MDYzMDA0MzI1MjZjNTUzMjUxMzIi_pc',
    triggerAddress: 'docs@4lsg.com'
  },

  // Legacy side-job — to be removed; see inline notes
  clioForward: {
    enabled:        true,
    fromAddress:    'notifications@clio.com',
    subjectPattern: /^Payment method submitted by (.+)$/,
    forwardTo:      'shoshana@metrodetroitbankruptcylaw.com'
  },

  // Safety caps
  maxBodyBytes:     1024 * 1024,        // 1 MB per body field (text, html)
  maxPayloadBytes:  1.5 * 1024 * 1024,  // 1.5 MB total — receiver limit is 2 MB
};


// ============================================================
// MAIN — bound to the time-based trigger
// ============================================================
function forwardEmailsToIngest() {
  const label = GmailApp.getUserLabelByName(CONFIG.triggerLabelName);
  if (!label) {
    Logger.log('ABORT: trigger label not found: ' + CONFIG.triggerLabelName);
    return;
  }

  const threads = label.getThreads();
  Logger.log('forwardEmailsToIngest: ' + threads.length + ' thread(s) under "' + CONFIG.triggerLabelName + '"');

  for (let ti = 0; ti < threads.length; ti++) {
    const thread = threads[ti];
    const messages = thread.getMessages();
    let threadAllOk = true;

    for (let mi = 0; mi < messages.length; mi++) {
      const message = messages[mi];

      // Drafts are unsent — no recipients, not real communications — and must
      // never be ingested. thread.getMessages() includes drafts, so skip them.
      // `continue` does NOT flip threadAllOk, so the label still comes off the
      // thread once the real messages are done (no reprocessing, no alert).
      if (message.isDraft()) {
        Logger.log('skipping draft ' + message.getId() + ' in thread ' + thread.getId());
        continue;
      }

      let result;
      try {
        result = processOneMessage(message, thread);
      } catch (e) {
        Logger.log('UNEXPECTED EXCEPTION processing message ' + message.getId() + ': ' + e + (e.stack ? '\n' + e.stack : ''));
        result = { outcome: 'transient', reason: 'exception: ' + e };
      }

      if (result.outcome === 'abort') {
        Logger.log('!!! ABORT RUN: ' + result.reason + ' — leaving all remaining thread labels in place');
        return;
      }
      if (result.outcome === 'bail') {
        Logger.log('!!! BAIL RUN: ' + result.reason + ' — leaving remaining thread labels in place for retry');
        return;
      }
      if (result.outcome === 'transient') {
        threadAllOk = false;
        Logger.log('transient failure on ' + message.getId() + ' (' + result.reason + ') — thread label retained');
      }
      // 'success' or 'permanent' → message is done; thread label can be removed if every other message also done
    }

    if (threadAllOk) {
      label.removeFromThread(thread);
    } else {
      Logger.log('thread ' + thread.getId() + ' had at least one transient failure — label retained for retry next run');
    }
  }

  Logger.log('forwardEmailsToIngest: complete');
}


// ============================================================
// CORE — process a single message
//
// Returns one of:
//   { outcome: 'success' }
//   { outcome: 'permanent', reason }   // 4xx (not 401), payload too large, etc.
//   { outcome: 'transient', reason }   // 5xx, network error, body status='error'
//   { outcome: 'abort',     reason }   // 401 — bad key, abort whole run
//   { outcome: 'bail',      reason }   // 429 — stop run, retry next time
// ============================================================
function processOneMessage(message, thread) {
  let envelope;
  try {
    envelope = buildCanonicalEnvelope(message);
  } catch (e) {
    Logger.log('buildCanonicalEnvelope failed on ' + message.getId() + ': ' + e);
    // Treat envelope-build failure as permanent — retrying won't help, and
    // we don't want to wedge the thread forever on one bad message.
    return { outcome: 'permanent', reason: 'envelope_build_failed: ' + e };
  }

  const envelopeJson = JSON.stringify(envelope);
  if (envelopeJson.length > CONFIG.maxPayloadBytes) {
    Logger.log('payload too large (' + envelopeJson.length + ' bytes) for ' + message.getId() + ' — skipping (permanent)');
    return { outcome: 'permanent', reason: 'payload_too_large_' + envelopeJson.length };
  }

  const res = sendToEndpoint(CONFIG.endpoint, envelopeJson, {
    'Content-Type':      'application/json',
    'X-Email-Ingest-Key': CONFIG.apiKey
  });

  // Network error (UrlFetchApp raised) → res.status === 0
  if (res.status === 0) {
    Logger.log('network error POSTing to ' + CONFIG.endpoint + ': ' + res.error);
    return { outcome: 'transient', reason: 'network_error: ' + res.error };
  }
  if (res.status === 401) {
    Logger.log('!!! 401 Unauthorized from ingest endpoint — API key is wrong. Response: ' + res.body);
    return { outcome: 'abort', reason: '401_unauthorized' };
  }
  if (res.status === 429) {
    Logger.log('!!! 429 rate-limited. Response: ' + res.body);
    return { outcome: 'bail', reason: '429_rate_limit' };
  }
  if (res.status >= 500) {
    Logger.log('5xx (' + res.status + ') from ingest: ' + res.body + ' — transient');
    return { outcome: 'transient', reason: 'http_' + res.status };
  }
  if (res.status >= 400) {
    // 4xx other than 401 — receiver explicitly rejected the payload.
    // Retrying won't help; log and treat as done so the label can come off.
    Logger.log('4xx (' + res.status + ') from ingest: ' + res.body + ' — permanent, message ' + message.getId() + ' will not be retried');
    return { outcome: 'permanent', reason: 'http_' + res.status };
  }

  // 2xx — parse body for status
  let parsed = {};
  try { parsed = JSON.parse(res.body) || {}; } catch (e) { /* ignore */ }
  const respStatus = parsed.status || 'unknown';

  Logger.log(
    'ingest OK msg=' + message.getId() +
    ' status=' + respStatus +
    ' execId=' + parsed.execution_id +
    ' logId=' + parsed.log_id +
    ' elId=' + parsed.email_log_id
  );

  // The receiver returns 200 with body.status='error' when an INSERT race
  // or unexpected DB issue happened. Receiver dedup makes a retry safe.
  if (respStatus === 'error') {
    return { outcome: 'transient', reason: '200_body_status_error' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEGACY PABBLY RELAY for docs@4lsg.com — TO BE REMOVED IN A FUTURE PHASE
  //
  // What this does: forwards every email sent to docs@4lsg.com to a Pabbly
  // workflow that handles attachment upload and case attribution. Uses the
  // OLD payload shape (NOT the canonical envelope) because the Pabbly
  // workflow was built around the old shape.
  //
  // How to remove (when the new system's rules layer handles docs@ natively):
  //   1. Verify the new system has a rule matching envelope.recipient ==
  //      'docs@4lsg.com' (or to[].email == 'docs@4lsg.com') that does case
  //      attribution and attachment upload.
  //   2. Run a parallel period: this Pabbly call AND the new rule both fire
  //      for a week, check parity in case/log attribution.
  //   3. Delete this if-block (the entire LEGACY PABBLY RELAY section).
  //   4. Set CONFIG.pabblyDocsRelay.enabled = false (or delete the block).
  //   5. Disable or delete the Pabbly workflow at
  //      https://connect.pabbly.com/workflow/sendwebhookdata/...
  // ─────────────────────────────────────────────────────────────────────────
  if (CONFIG.pabblyDocsRelay.enabled) {
    try {
      const legacy = buildLegacyPayload(message);
      if (legacy.to === CONFIG.pabblyDocsRelay.triggerAddress) {
        const pres = sendToEndpoint(CONFIG.pabblyDocsRelay.url, JSON.stringify(legacy), {
          'Content-Type': 'application/json'
        });
        if (pres.status >= 200 && pres.status < 300) {
          Logger.log('Pabbly docs@ relay OK for msg ' + message.getId());
        } else {
          // Side-job failure should not affect ingest outcome — log only.
          Logger.log('Pabbly docs@ relay FAILED (' + pres.status + ') for msg ' + message.getId() + ': ' + pres.body);
        }
      }
    } catch (e) {
      Logger.log('Pabbly docs@ relay exception for msg ' + message.getId() + ': ' + e);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEGACY CLIO PAYMENT FORWARD — TO BE REMOVED IN A FUTURE PHASE
  //
  // What this does: forwards "Payment method submitted by ..." emails from
  // notifications@clio.com to Shoshana, but only when the email is a
  // single-message thread (avoids forwarding follow-ups).
  //
  // How to remove (when the rules layer handles Clio notifications):
  //   1. Build a rule matching from.email == 'notifications@clio.com' AND
  //      subject regex /^Payment method submitted by /.
  //   2. Action: internal_function 'forward_email_to' (or equivalent), or a
  //      workflow that triggers a sequence enrolling Shoshana.
  //   3. Verify the new path works (test send a fake Clio notification).
  //   4. Set CONFIG.clioForward.enabled = false (or delete the block).
  // ─────────────────────────────────────────────────────────────────────────
  if (CONFIG.clioForward.enabled) {
    try {
      const fromAddr = legacyEmail(message.getFrom()).toLowerCase();
      const subj     = message.getSubject();
      if (fromAddr === CONFIG.clioForward.fromAddress &&
          CONFIG.clioForward.subjectPattern.test(subj) &&
          thread.getMessageCount() === 1) {
        message.forward(CONFIG.clioForward.forwardTo, { subject: subj });
        Logger.log('Clio payment forward sent to ' + CONFIG.clioForward.forwardTo + ' for msg ' + message.getId());
      }
    } catch (e) {
      Logger.log('Clio forward exception for msg ' + message.getId() + ': ' + e);
    }
  }

  return { outcome: 'success' };
}


// ============================================================
// ENVELOPE BUILDER
// ============================================================
function buildCanonicalEnvelope(message) {
  const rawContent  = message.getRawContent() || '';
  const split       = splitHeadersBody(rawContent);
  const headersBlock = split.headers;

  const parsed = parseHeaderBlock(headersBlock);
  const allHeaders     = parsed.all;   // { name(lc): [v1, v2, ...] }
  const headersAllFlat = parsed.flat;  // { name(lc): string | string[] }

  const warnings = [];

  function getH(name) {
    const k = name.toLowerCase();
    return (allHeaders[k] && allHeaders[k].length > 0) ? allHeaders[k][0] : null;
  }

  // Address lists from the GmailMessage convenience methods. These already
  // return the raw header value (or a comma-joined merge if the header
  // appears multiple times). parseAddressList tolerates either.
  const fromList    = parseAddressList(message.getFrom());
  let   toList      = parseAddressList(message.getTo());
  const ccList      = parseAddressList(message.getCc());
  const replyToList = parseAddressList(message.getReplyTo());

  // Recipient fallback. The receiver requires to[].email OR
  // envelope.recipient; envelope.recipient is always null here (Gmail hides
  // the SMTP envelope), so an empty To: header — e.g. a forward sent with
  // recipients in Bcc only — fails validation and the message is dropped.
  // getBcc() is populated on messages this mailbox SENT, which is exactly the
  // case for these forwards, so fall back to it before giving up.
  if (toList.length === 0) {
    const bccList = parseAddressList(message.getBcc());
    if (bccList.length > 0) {
      toList = bccList;
      warnings.push('to_empty_fell_back_to_bcc');
    } else {
      warnings.push('to_empty_and_no_bcc');
    }
  }

  const fromOne = fromList.length > 0 ? fromList[0] : { name: '', email: '' };

  const authResultsRaw = getH('authentication-results');
  const auth = {
    spf:                        parseAuthMethod(authResultsRaw, 'spf'),
    dkim:                       parseAuthMethod(authResultsRaw, 'dkim'),
    dmarc:                      parseAuthMethod(authResultsRaw, 'dmarc'),
    arc:                        parseAuthMethod(authResultsRaw, 'arc'),
    antispam_result:            getH('x-antispam-scan-result'),
    raw_authentication_results: authResultsRaw
  };

  // Bodies (GmailApp auto-decodes MIME). Cap to maxBodyBytes.
  let textBody = message.getPlainBody() || '';
  let htmlBody = message.getBody() || '';
  if (textBody.length > CONFIG.maxBodyBytes) {
    textBody = textBody.substring(0, CONFIG.maxBodyBytes);
    warnings.push('text_truncated_at_' + CONFIG.maxBodyBytes);
  }
  if (htmlBody.length > CONFIG.maxBodyBytes) {
    htmlBody = htmlBody.substring(0, CONFIG.maxBodyBytes);
    warnings.push('html_truncated_at_' + CONFIG.maxBodyBytes);
  }

  // Attachments — metadata only (bytes discarded; receiver doesn't need them
  // in v1, will pull from Gmail / upload to GCS in a later phase).
  let attachments;
  try {
    attachments = message.getAttachments().map(function (a) {
      return {
        filename:   a.getName(),
        mime:       a.getContentType(),
        size:       a.getSize(),
        url:        null,
        // GmailApp doesn't expose Content-ID in basic API; left empty
        // string to match the canonical shape exactly.
        content_id: ''
      };
    });
  } catch (e) {
    warnings.push('attachments_enumeration_failed: ' + e);
    attachments = [];
  }

  // Date: prefer the raw Date: header (mirrors PHP forwarder's `$getHeader('date')`),
  // fall back to the parsed Date object stringified.
  const dateStr = getH('date') || message.getDate().toUTCString();

  return {
    schema_version:  CONFIG.schemaVer,
    received_at:     new Date().toISOString(),
    source:          CONFIG.source,
    adapter_version: CONFIG.adapterVer,
    kind:            'email',

    envelope: {
      // Gmail doesn't expose the SMTP envelope (Exim env vars) — receiver
      // tolerates nulls and falls back to header-derived addresses.
      sender:              null,
      recipient:           null,
      local_part:          null,
      plus_tag:            null,
      domain:              null,
      exim_message_id:     null,
      exim_local_part_raw: null,
      exim_domain_raw:     null
    },

    from:     fromOne,
    to:       toList,
    cc:       ccList,
    reply_to: replyToList,
    subject:  message.getSubject() || '',
    date:     dateStr,

    text: textBody,
    html: htmlBody,

    attachments: attachments,

    auth: auth,

    headers: {
      // DELIBERATE: Gmail internal 16-hex ID, NOT the RFC Message-Id header.
      // Preserves dedup continuity with 28,658 historical gmail-firm rows
      // in email_log.message_id. Do NOT change to getH('message-id').
      message_id:   message.getId(),
      in_reply_to:  getH('in-reply-to'),
      references:   getH('references'),
      content_type: getH('content-type'),
      list_id:      getH('list-id'),
      all:          headersAllFlat
    },

    raw: {
      headers_block: headersBlock,
      // Deliberately null — attachments are inline-base64 in the raw MIME,
      // which would inflate the payload past the 2MB receiver limit on any
      // message with attachments. The metadata above is sufficient for
      // logging/routing.
      body_block: null
    },

    _parse_warnings: warnings
  };
}


// ============================================================
// LEGACY PAYLOAD (for Pabbly docs@ relay only — old shape)
// ============================================================
function buildLegacyPayload(message) {
  const attachmentNames = message.getAttachments().map(function (a) { return a.getName(); });
  return {
    from:       legacyEmail(message.getFrom()),
    to:         legacyEmail(message.getTo()),
    subject:    message.getSubject(),
    date:       message.getDate(),  // serialized as ISO string by JSON.stringify
    body_plain: message.getPlainBody(),
    attachments: attachmentNames,
    messageID:  message.getId()
  };
}

// Old getEmail helper from the previous script — preserved verbatim
// so the Pabbly relay sees the exact same `to` value it sees today.
// On multi-address headers, returns the LAST address inside <…>; on bare
// addresses returns the input unchanged.
function legacyEmail(s) {
  if (!s) return s;
  const lt = s.lastIndexOf('<');
  const gt = s.lastIndexOf('>');
  if (lt >= 0 && gt > lt) return s.substring(lt + 1, gt);
  return s;
}


// ============================================================
// HELPERS
// ============================================================

// Split rawContent at the first blank line. Returns { headers, body }.
function splitHeadersBody(raw) {
  let sep = raw.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (sep === -1) { sep = raw.indexOf('\n\n'); sepLen = 2; }
  if (sep === -1) return { headers: raw, body: '' };
  return { headers: raw.substring(0, sep), body: raw.substring(sep + sepLen) };
}

// Parse an RFC 5322 header block.
// Returns { all, flat }:
//   all  = { name(lc): [value1, value2, ...] }
//   flat = { name(lc): string OR string[] } — mirrors PHP $headersAllFlat
// Handles header continuation (RFC 5322 § 2.2.3 — folded headers).
function parseHeaderBlock(headersBlock) {
  const all = {};
  const lines = headersBlock.split(/\r?\n/);
  let current = null;
  let isFirstLine = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') { isFirstLine = false; continue; }

    // mbox-style "From sender@domain ..." separator — skip
    if (isFirstLine && /^From\s+\S+@\S+\s/.test(line)) {
      isFirstLine = false; current = null; continue;
    }
    isFirstLine = false;

    const c0 = line.charAt(0);
    if (current !== null && (c0 === ' ' || c0 === '\t')) {
      // Continuation: fold onto the most recent value of `current`
      const arr = all[current];
      arr[arr.length - 1] += ' ' + line.replace(/^[\s]+/, '');
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) { current = null; continue; }

    const name = line.substring(0, colon).toLowerCase().trim();
    if (name === '' || !/^[a-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
      current = null; continue;
    }
    const value = line.substring(colon + 1).replace(/^[\s]+/, '');

    if (!all[name]) all[name] = [];
    all[name].push(value);
    current = name;
  }

  const flat = {};
  for (const k in all) {
    if (all.hasOwnProperty(k)) {
      flat[k] = (all[k].length === 1) ? all[k][0] : all[k];
    }
  }
  return { all: all, flat: flat };
}

// Extract a single auth verdict from an Authentication-Results header value.
// Mirrors the PHP regex: /(?:^|[\s;])METHOD=([a-zA-Z]+)/
function parseAuthMethod(raw, method) {
  if (raw === null || raw === undefined || raw === '') return null;
  const pattern = new RegExp('(?:^|[\\s;])' + method + '=([a-zA-Z]+)');
  const m = String(raw).match(pattern);
  return m ? m[1].toLowerCase() : null;
}

// Parse an address-list header (From / To / Cc / Reply-To) into [{name, email}, ...].
// Direct port of the PHP parseAddressList byte-by-byte state machine:
//   - splits on commas NOT inside quotes or angle brackets
//   - "Display Name" <addr@host>  →  { name: "Display Name", email: "addr@host" }
//   - DisplayName <addr@host>     →  { name: "DisplayName",  email: "addr@host" }
//   - addr@host                   →  { name: "",             email: "addr@host" }
//   - RFC 2047-encoded display names are best-effort decoded via decodeMimeWord
// Email is lowercased to match PHP behavior.
function parseAddressList(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return [];
  raw = String(raw).trim();

  const items = [];
  let depth = 0;
  let inQuote = false;
  let buf = '';
  for (let i = 0, n = raw.length; i < n; i++) {
    const c = raw.charAt(i);
    if (c === '"' && (i === 0 || raw.charAt(i - 1) !== '\\')) {
      inQuote = !inQuote;
      buf += c;
      continue;
    }
    if (!inQuote) {
      if (c === '<')                     { depth++; buf += c; continue; }
      if (c === '>')                     { depth = Math.max(0, depth - 1); buf += c; continue; }
      if (c === ',' && depth === 0)      { items.push(buf); buf = ''; continue; }
    }
    buf += c;
  }
  if (buf !== '') items.push(buf);

  const out = [];
  for (let j = 0; j < items.length; j++) {
    const item = items[j].trim();
    if (item === '') continue;

    let name = '';
    let email = '';
    const m = item.match(/^(.*)<([^>]+)>\s*$/);
    if (m) {
      name  = m[1].trim();
      email = m[2].trim();
      if (name.length >= 2 && name.charAt(0) === '"' && name.charAt(name.length - 1) === '"') {
        name = name.substring(1, name.length - 1);
      }
    } else {
      email = item;
    }
    out.push({
      name:  decodeMimeWord(name),
      email: email.toLowerCase()
    });
  }
  return out;
}

// Best-effort RFC 2047 decoder for encoded-words: =?charset?B/Q?text?=
// Handles a single encoded-word per match (multiple in one string are each
// decoded). Not perfect — doesn't collapse whitespace between adjacent
// encoded-words per the spec — but covers the common display-name case.
function decodeMimeWord(s) {
  if (!s || typeof s !== 'string' || s.indexOf('=?') === -1) return s;
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (_match, charset, enc, text) {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Utilities.base64Decode(text);
      } else {
        // Q-encoding: _ = space; =XX = byte (hex)
        const qDecoded = text
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, function (_m, hex) {
            return String.fromCharCode(parseInt(hex, 16));
          });
        // Convert to signed-byte array for newBlob
        bytes = [];
        for (let i = 0; i < qDecoded.length; i++) {
          const b = qDecoded.charCodeAt(i) & 0xff;
          bytes.push(b > 127 ? b - 256 : b);
        }
      }
      return Utilities.newBlob(bytes).getDataAsString(charset);
    } catch (e) {
      // On any failure, return the original encoded text — caller still
      // gets a string, just an undecoded one.
      return text;
    }
  });
}

// HTTP POST wrapper. Returns { status, body, error } regardless of outcome.
// status === 0 on network/transport error; body/error populated accordingly.
function sendToEndpoint(url, body, headers) {
  const options = {
    method:             'post',
    contentType:        (headers && headers['Content-Type']) || 'application/json',
    payload:            body,
    headers:            headers || {},
    muteHttpExceptions: true,
    followRedirects:    false
  };
  try {
    const resp = UrlFetchApp.fetch(url, options);
    return {
      status: resp.getResponseCode(),
      body:   resp.getContentText(),
      error:  null
    };
  } catch (e) {
    return { status: 0, body: '', error: String(e) };
  }
}


// ============================================================
// TEST HARNESS — run from the editor before flipping the trigger
// ============================================================
//
// testWithLastEmail():
//   - Finds the most recent thread under CONFIG.triggerLabelName
//   - Builds the canonical envelope for its first message
//   - Logs the envelope (pretty-printed) and the endpoint response
//   - Does NOT remove the label
//   - Does NOT fire the legacy Pabbly relay or Clio forward
//
// Safe to run multiple times. The receiver dedupes by message_id, so the
// second run returns status='duplicate'.
function testWithLastEmail() {
  const label = GmailApp.getUserLabelByName(CONFIG.triggerLabelName);
  if (!label) { Logger.log('Trigger label not found: ' + CONFIG.triggerLabelName); return; }
  const threads = label.getThreads(0, 1);
  if (threads.length === 0) {
    Logger.log('No threads under "' + CONFIG.triggerLabelName + '". Apply the label to a test email and re-run.');
    return;
  }
  const message = threads[0].getMessages()[0];
  Logger.log('=== testWithLastEmail on message ===');
  Logger.log('  id:      ' + message.getId());
  Logger.log('  subject: ' + message.getSubject());
  Logger.log('  from:    ' + message.getFrom());
  Logger.log('  to:      ' + message.getTo());
  Logger.log('  date:    ' + message.getDate());

  const envelope = buildCanonicalEnvelope(message);
  Logger.log('=== canonical envelope ===');
  Logger.log(JSON.stringify(envelope, null, 2));

  const json = JSON.stringify(envelope);
  Logger.log('=== payload size: ' + json.length + ' bytes ===');

  if (CONFIG.apiKey === '<PASTE GMAIL-FIRM API KEY HERE BEFORE DEPLOYING>') {
    Logger.log('!!! CONFIG.apiKey is still the placeholder — replace it before running the live trigger.');
    Logger.log('    Skipping the POST so you can still review the envelope shape.');
    return;
  }

  const res = sendToEndpoint(CONFIG.endpoint, json, {
    'Content-Type':       'application/json',
    'X-Email-Ingest-Key': CONFIG.apiKey
  });
  Logger.log('=== POST ' + CONFIG.endpoint + ' ===');
  Logger.log('  http_status: ' + res.status);
  Logger.log('  body:        ' + res.body);
  if (res.error) Logger.log('  error: ' + res.error);
}


// ============================================================
// MANUAL TEST PLAN (for Fred — comments only)
// ============================================================
//
// 1. Paste this entire script into the Apps Script editor, replacing the
//    previous forwardEmailsToWebhook script. Do NOT save yet.
//
// 2. Replace CONFIG.apiKey with the real gmail-firm API key (48-char hex).
//
// 3. Save. Authorize permissions if prompted (Gmail read, send mail,
//    external request).
//
// 4. Apply the trigger label to one test email. Pick one with at least one
//    attachment, one cc recipient, and a non-trivial subject.
//
// 5. Run testWithLastEmail() manually from the editor. Check Logs:
//      - Envelope JSON shape matches the canonical envelope spec.
//      - Response is 200 with status='logged'.
//      - Label remains on the message (testWithLastEmail does not remove it).
//
// 6. Verify in DB via the readonly SQL endpoint:
//      SELECT * FROM email_ingest_executions ORDER BY id DESC LIMIT 1;
//      SELECT * FROM log       WHERE log_id = <log_id from response>;
//      SELECT * FROM email_log WHERE id      = <email_log_id from response>;
//    All three should be populated correctly.
//
// 7. Re-run testWithLastEmail() on the same message. Expect status='duplicate'.
//
// 8. Once 5-7 look right: swap the time-based trigger from the old
//    forwardEmailsToWebhook function to the new forwardEmailsToIngest.
//
// 9. Apply trigger label to 3-5 normal emails. Wait for the next trigger fire.
//    Verify executions rows + label removal happened correctly.
//
// 10. Send a test to docs@4lsg.com from an external address, apply the
//     trigger label, and verify BOTH the ingest endpoint AND the Pabbly relay
//     fire (legacy side-job preserved).
//
// 11. Watch email_ingest_executions for a day. Compare incoming traffic
//     volume against historical /logEmail traffic for parity.
//
// 12. When parity is confirmed, retire the /logEmail route on the receiver.
// ============================================================
// TEST TRIGGER — live end-to-end test without dedupe collision
//
// Bind a SEPARATE time-based trigger (or run manually) to this function.
// Apply the label CONFIG.testTriggerLabelName ('Test Trigger') to any email
// you want to re-run through ingest as if it were brand new.
//
// Differences vs forwardEmailsToIngest (all SAFER):
//   - Overrides envelope.headers.message_id with a random suffix so the
//     receiver's (source, message_id) dedupe treats it as a NEW message and
//     Layer-3 rules actually fire. (Re-runnable: fresh suffix each run.)
//   - Skips BOTH legacy side-jobs (no Pabbly docs@ relay, no Clio forward).
//   - Does NOT remove the label, so you can re-run freely.
//
// The synthetic message_id is the ONLY non-production element. Everything
// else — envelope build, endpoint, headers, Layer-3 — is identical to prod.
// ============================================================
function forwardTestTrigger() {
  const labelName = 'IT/Test Trigger';
  const label = GmailApp.getUserLabelByName(labelName);
  if (!label) { Logger.log('ABORT: test label not found: ' + labelName); return; }

  const threads = label.getThreads();
  Logger.log('forwardTestTrigger: ' + threads.length + ' thread(s) under "' + labelName + '"');

  for (let ti = 0; ti < threads.length; ti++) {
    const messages = threads[ti].getMessages();
    for (let mi = 0; mi < messages.length; mi++) {
      const message = messages[mi];
      let envelope;
      try {
        envelope = buildCanonicalEnvelope(message);
      } catch (e) {
        Logger.log('TEST envelope build failed on ' + message.getId() + ': ' + e);
        continue;
      }

      // The ONLY change from prod: mangle the dedupe key so this re-runs.
      const suffix = '-test-' + Date.now().toString(36) + '-' +
                     Math.random().toString(36).slice(2, 8);
      envelope.headers.message_id = message.getId() + suffix;
      envelope._parse_warnings = (envelope._parse_warnings || []).concat(['TEST_TRIGGER_synthetic_message_id']);

      const json = JSON.stringify(envelope);
      const res = sendToEndpoint(CONFIG.endpoint, json, {
        'Content-Type':       'application/json',
        'X-Email-Ingest-Key': CONFIG.apiKey
      });
      let parsed = {};
      try { parsed = JSON.parse(res.body) || {}; } catch (e) {}
      Logger.log(
        'TEST ingest msg=' + message.getId() + suffix +
        ' http=' + res.status +
        ' status=' + (parsed.status || 'unknown') +
        ' execId=' + parsed.execution_id +
        ' logId=' + parsed.log_id
      );
      // Deliberately NO label removal, NO side-jobs.
    }
  }
  Logger.log('forwardTestTrigger: complete');
}




// ============================================================
// WEBHOOK TRIGGER — deploy as web app to enable
//
// Setup:
//   1. Add a secret: Project Settings → Script Properties →
//      key WEBHOOK_SECRET, value = a long random string.
//   2. Deploy → New deployment → type: Web app
//        Execute as: Me
//        Who has access: Anyone
//   3. Copy the /exec URL. Invoke with:
//        POST https://script.google.com/macros/s/<ID>/exec?secret=<WEBHOOK_SECRET>
//      (body ignored; optional ?mode=async for fire-and-forget)
//
// Notes:
//   - Headers are NOT visible to doPost — secret must be in the query string.
//   - "Anyone" access is required for non-Google callers; the secret is the
//     only gate, hence Script Properties, not hardcoded.
//   - Updating code later: Deploy → Manage deployments → edit the existing
//     deployment → New version. Do NOT create a new deployment or the URL
//     changes.
//   - LockService prevents a webhook run overlapping the time-trigger run
//     (label-as-state is idempotent anyway via receiver dedup, but the lock
//     avoids duplicate POST churn).
// ============================================================
function doPost(e) {
  return handleWebhook_(e);
}
// Optional: allow GET too (easier to test from a browser / curl -X GET)
function doGet(e) {
  return handleWebhook_(e);
}
function handleWebhook_(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const provided = e && e.parameter ? e.parameter.secret : null;

  if (!secret || provided !== secret) {
    return jsonOut_({ status: 'unauthorized' });
  }
  const mode = (e.parameter.mode || 'sync').toLowerCase();
  if (mode === 'async') {
    // Fire-and-forget: schedule a one-off trigger ~1s out and return now.
    // The trigger auto-deletes itself is NOT automatic — clean up stale
    // one-off triggers at the top of the run (see cleanupOneOffTriggers_).
    ScriptApp.newTrigger('runIngestFromWebhook_')
      .timeBased()
      .after(1000)
      .create();
    return jsonOut_({ status: 'scheduled' });
  }

  // Sync: run inline, caller waits for completion.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return jsonOut_({ status: 'busy', detail: 'another run holds the lock' });
  }
  try {
    forwardEmailsToIngest();
    return jsonOut_({ status: 'ok' });
  } catch (err) {
    return jsonOut_({ status: 'error', detail: String(err) });
  } finally {
    lock.releaseLock();
  }
}
// Target for async mode. Deletes its own one-off trigger(s), then runs.
function runIngestFromWebhook_() {
  cleanupOneOffTriggers_('runIngestFromWebhook_');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('runIngestFromWebhook_: lock busy, skipping (time trigger or another webhook run active)');
    return;
  }
  try {
    forwardEmailsToIngest();
  } finally {
    lock.releaseLock();
  }
}
// One-off after() triggers persist after firing — remove all triggers
// pointing at the given handler. Safe: the recurring time-based trigger
// points at forwardEmailsToIngest, not this handler, so it's untouched.
function cleanupOneOffTriggers_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(t);
    }
  });
}
function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}