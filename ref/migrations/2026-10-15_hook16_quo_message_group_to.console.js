/*
 * ref/migrations/2026-10-15_hook16_quo_message_group_to.console.js
 *
 * Hook 16 "quo-message" transform v2 → v3 — group texts. Paste into the
 * DevTools console of a logged-in app.4lsg.com tab (the SHELL, where
 * `apiSend` is defined).
 *
 * WHY: Quo sends a group text's `to` as ONE comma-joined string
 * ("+12485592400,+12489654574"), not an array. v2 took a string `to` whole
 * and norm10 stripped the comma, so the digits ran together into one
 * 22-digit "line" (phone_event_log 2293, 2026-06-19): no phone_lines match,
 * invisible in the Comms phone views, its MMS parked `no_line` by the comms
 * archive. The one live occurrence in 2,103 deliveries; repaired by hand.
 *
 * CHANGE (v3):
 *   - `to` (array OR string, split on , ; whitespace) → a de-duplicated list
 *     of 10-digit numbers, emitted as `recipients` (wf 18 does not forward
 *     it today; hook_executions.raw_input keeps the full payload anyway).
 *   - INCOMING: the firm line is the Quo inbox the webhook fired for —
 *     data.object.phoneNumberId through QUO_LINES. An unknown inbox falls
 *     back to the first recipient (v2's array behaviour) with a warning.
 *   - OUTGOING: the line is `from` (unchanged); the other party is the first
 *     recipient that is not the line. A multi-client group send therefore
 *     threads under its FIRST client only.
 *   - Every other output key is unchanged for a one-recipient message.
 *
 * Adding a Quo line = adding its phoneNumberId to QUO_LINES (a hook edit);
 * the RC twin is hook 21's LINES. See ref/AI_CONTEXT.md §28.
 *
 * RUN: paste once. CHECK runs immediately and is READ-ONLY: it asserts the
 * base (hook 16 at v2, code sha256 as below) and dry-runs v3 server-side
 * through POST /api/hooks/test-transform (pure — runs the transform, writes
 * nothing) against hook_executions 8502, the group text that exposed this.
 * On "GO — CHECK", run `await hook16v3.apply()`: it re-runs CHECK, PUTs the
 * v3 code, then re-reads the hook and asserts the stored code byte-equal and
 * the version at 3.
 * ROLLBACK: hooks keep no version history — re-PUT v2 (the code hashing to
 * V2_SHA256 below; hook_executions keep every delivery for replay).
 * Tested by tests/quoMessageTransform.test.js, which reads V3_CODE out of
 * THIS file — the bytes it tests are the bytes this script sends.
 */
await (async () => {
  const HOOK = 16;
  const SLUG = 'quo-message';
  const SAMPLE_EXECUTION = 8502;
  const V2_SHA256 = '9a11e3522839aea8d268c103e6c67f9387369cd64a21f4cea0dcf08d97d0c5e9';

  const V3_CODE = String.raw`// quo-message v3 (2026-10-15). Quo sends a group text's "to" as ONE
// comma-joined string ("+12485592400,+12489654574"), not an array; v2 ran
// the digits together into an unmatchable line. Every to shape is now split
// into a recipient list; an INCOMING message's line is the Quo inbox the
// webhook fired for (data.object.phoneNumberId).
//
// ADDING A QUO LINE? Add its phoneNumberId (phone_lines.provider_id) here,
// or its group texts fall back to the first recipient. RC's twin map is
// LINES in hook 21 (rc-message-in). ref/AI_CONTEXT.md §28.
var QUO_LINES = {
  "PNAkKuagWX": "2489654574",
  "PNj4riXHPb": "2489655355",
  "PNr4hkvr41": "2484179800",
  "PNdCdA4i1u": "4404674208"
};

function norm10(v) {
  if (v == null) return "";
  var d = String(v).replace(/\D/g, "");
  if (d.length === 11 && d.charAt(0) === "1") return d.slice(1);
  return d;
}

// Array or comma-joined string → unique 10-digit numbers, in order.
function recipientList(field) {
  var raw = Array.isArray(field) ? field : [field];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    if (raw[i] == null) continue;
    var parts = String(raw[i]).split(/[,;\s]+/);
    for (var j = 0; j < parts.length; j++) {
      var n = norm10(parts[j]);
      if (n && out.indexOf(n) === -1) out.push(n);
    }
  }
  return out;
}

var body = (input && input.body) || {};
var obj  = (body.data && body.data.object) || {};
var type = body.type;

var direction;
if      (type === "message.received")  direction = "incoming";
else if (type === "message.delivered") direction = "outgoing";
else return {};

var from       = norm10(obj.from);
var recipients = recipientList(obj.to);

var ourNumber, theirNumber;
if (direction === "incoming") {
  var pn = obj.phoneNumberId != null ? String(obj.phoneNumberId) : "";
  ourNumber = Object.prototype.hasOwnProperty.call(QUO_LINES, pn) ? QUO_LINES[pn] : "";
  if (!ourNumber) {
    if (recipients.length > 1) {
      console.warn("[quo-message] phoneNumberId " + pn + " not in QUO_LINES; group text falls back to the first recipient");
    }
    ourNumber = recipients.length ? recipients[0] : "";
  }
  theirNumber = from;
} else {
  ourNumber = from;
  theirNumber = recipients.length ? recipients[0] : "";
  for (var k = 0; k < recipients.length; k++) {
    if (recipients[k] !== ourNumber) { theirNumber = recipients[k]; break; }
  }
}

var attachments = [];
if (Array.isArray(obj.media)) {
  for (var i = 0; i < obj.media.length; i++) {
    var m = obj.media[i];
    if (m && m.url) attachments.push({ url: String(m.url) });
  }
}

var conversationId = obj.conversationId != null ? String(obj.conversationId) : "";

return {
  provider:            "quo",
  direction:           direction,
  their_number:        theirNumber,
  our_number:          ourNumber,
  body:                obj.body != null ? String(obj.body) : "",
  attachments:         attachments,
  from:                from,
  to:                  direction === "incoming" ? ourNumber : theirNumber,
  recipients:          recipients,
  provider_message_id: obj.id != null ? String(obj.id) : "",
  provider_event_id:   body.id != null ? String(body.id) : "",
  ts:                  obj.createdAt != null ? String(obj.createdAt) : "",
  conversation_id:     conversationId
};`;

  const fail = (msg) => { console.error('NO-GO — ' + msg); throw new Error(msg); };
  const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const cfgOf = (c) => (typeof c === 'string' ? JSON.parse(c) : c) || {};
  const jsonOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

  async function check() {
    // ── 1. assert the base: hook 16, slug, code mode, v2 by version AND bytes ──
    const { hook } = await apiSend(`/api/hooks/${HOOK}`);
    if (!hook || hook.slug !== SLUG) fail(`hook ${HOOK} is not ${SLUG}: ${hook && hook.slug}`);
    if (hook.transform_mode !== 'code') fail(`transform_mode is ${hook.transform_mode}, expected code`);
    if (Number(hook.version) !== 2) fail(`expected hook version 2, found ${hook.version}`);
    const v2 = cfgOf(hook.transform_config).code;
    if (typeof v2 !== 'string') fail('transform_config.code missing');
    const got = await sha256(v2);
    if (got !== V2_SHA256) fail(`base code sha256 ${got} != expected v2 ${V2_SHA256}`);

    // ── 2. dry-run v3 server-side on the real group text (read-only) ──
    const { execution } = await apiSend(`/api/hooks/executions/${SAMPLE_EXECUTION}`);
    if (!execution || Number(execution.hook_id) !== HOOK) fail(`execution ${SAMPLE_EXECUTION} is not a hook ${HOOK} delivery`);
    const input = jsonOf(execution.raw_input);
    const sampleTo = input && input.body && input.body.data && input.body.data.object && input.body.data.object.to;
    if (sampleTo !== '+12485592400,+12489654574') fail('sample `to` is not the expected group string: ' + JSON.stringify(sampleTo));
    const dry = await apiSend('/api/hooks/test-transform', 'POST',
      { transform_mode: 'code', transform_config: { code: V3_CODE }, input, slug: SLUG });
    const t = dry && dry.result && dry.result.transform;
    if (!t || (t.errors && t.errors.length)) fail('v3 dry-run errored: ' + JSON.stringify(t && t.errors));
    const o = t.output;
    const sender = String(input.body.data.object.from).replace(/\D/g, '').slice(-10);   // the client: never a literal here (public repo)
    const want = { direction: 'incoming', our_number: '2489654574', to: '2489654574', from: sender, their_number: sender };
    for (const [k, v] of Object.entries(want)) if (o[k] !== v) fail(`dry-run ${k} = ${JSON.stringify(o[k])}, expected ${v}`);
    if (JSON.stringify(o.recipients) !== JSON.stringify(['2485592400', '2489654574'])) fail('dry-run recipients: ' + JSON.stringify(o.recipients));
    if (o.attachments.length !== 1) fail('dry-run attachments: ' + JSON.stringify(o.attachments));
    console.log(`GO — CHECK: hook ${HOOK} is v2 (sha matches); v3 dry-run on execution ${SAMPLE_EXECUTION} → line ${o.our_number}, recipients ${o.recipients.join(',')}. Next: await hook16v3.apply()`);
    return hook;
  }

  async function apply() {
    await check();
    // ── 3. write: PUT bumps version by 1 ──
    await apiSend(`/api/hooks/${HOOK}`, 'PUT', { transform_config: { code: V3_CODE } });
    // ── 4. re-read and assert the stored bytes + version ──
    const { hook } = await apiSend(`/api/hooks/${HOOK}`);
    const stored = cfgOf(hook.transform_config).code;
    if (stored !== V3_CODE) fail(`stored code differs from V3_CODE (sha ${await sha256(String(stored))} vs ${await sha256(V3_CODE)}) — re-PUT v2 to roll back`);
    if (Number(hook.version) !== 3) fail(`version after PUT is ${hook.version}, expected 3`);
    if (hook.transform_mode !== 'code' || !hook.active) fail(`mode/active changed: ${hook.transform_mode}/${hook.active}`);
    console.log(`GO — hook ${HOOK} ${SLUG} is v3 (code sha256 ${await sha256(V3_CODE)}). Group texts now resolve their line.`);
  }

  window.hook16v3 = { check, apply, V3_CODE };
  await check();
})();
