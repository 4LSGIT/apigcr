#!/usr/bin/env node
// scripts/yisramailT2ReplayDlq.js
//
/**
 * YisraMail T2 — replay SES events from the EventBridge dead-letter queue
 * `yisramail-ses-dlq` back into hook `ses-events` (ref/YISRAMAIL_DESIGN.md
 * §5.4: exhausted EventBridge retries land in the DLQ instead of being dropped).
 *
 *   node scripts/yisramailT2ReplayDlq.js <messages.json> --dry-run   # list what it would post
 *   SES_HOOK_KEY=… node scripts/yisramailT2ReplayDlq.js <messages.json>
 *
 * INPUT — either shape, detected:
 *   - `aws sqs receive-message --queue-url … --max-number-of-messages 10
 *      --attribute-names All --message-attribute-names All > messages.json`:
 *     { "Messages": [ { "MessageId", "Body": "<the event as a JSON string>", … } ] }
 *   - what the SQS console shows ("Send and receive messages" → Poll → open a
 *     message → copy its Body): one event object, an array of event objects /
 *     of {Body} objects, or one JSON event per line.
 * An EventBridge DLQ message's Body is the original event, unchanged
 * (VERIFY(step0): confirm on the first real DLQ message — the runbook's DLQ
 * stage). Anything that is not an `aws.ses` event with an id is skipped and
 * counted; the same event id twice in one file is posted once.
 *
 * Each event is POSTed as the EventBridge API destination would: JSON body,
 * the hook key in header `x-api-key` taken from env SES_HOOK_KEY (never an
 * argument, never printed). The hook's dedup_path (body.id) makes a replay of
 * an event that DID arrive a no-op: the receiver answers 200 and records
 * nothing. 15 s limit per POST. Ends on ONE GO / NO-GO line with the counts.
 * --url <base> overrides https://app.4lsg.com (tests point it at a local server).
 */

'use strict';

const fs = require('fs');

const DEFAULT_BASE = 'https://app.4lsg.com';
const HOOK_PATH = '/hooks/ses-events';
const POST_TIMEOUT_MS = 15000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSesEvent = (v) => isObj(v) && v.source === 'aws.ses' && typeof v.id === 'string' && v.id.length > 0;

function parseBody(b) {
  if (isObj(b)) return b;
  if (typeof b !== 'string') return null;
  try { return JSON.parse(b); } catch (_) { return null; }
}

/** File text → { events, skipped, shape }. Never throws on content. */
function readEvents(text) {
  const out = { events: [], skipped: 0, duplicates: 0, shape: 'unknown' };
  let items = null;
  let doc;
  try { doc = JSON.parse(text); } catch (_) { doc = undefined; }
  if (doc !== undefined) {
    if (isObj(doc) && Array.isArray(doc.Messages)) { out.shape = 'aws-cli'; items = doc.Messages.map((m) => parseBody(m && m.Body)); }
    else if (Array.isArray(doc)) { out.shape = 'array'; items = doc.map((x) => (isObj(x) && 'Body' in x ? parseBody(x.Body) : x)); }
    else if (isObj(doc) && 'Body' in doc) { out.shape = 'message'; items = [parseBody(doc.Body)]; }
    else { out.shape = 'event'; items = [doc]; }
  } else {
    out.shape = 'json-lines';
    items = String(text).split(/\r?\n/).filter((l) => l.trim()).map((l) => parseBody(l.trim()));
  }
  const seen = new Set();
  for (const ev of items) {
    if (!isSesEvent(ev)) { out.skipped += 1; continue; }
    if (seen.has(ev.id)) { out.duplicates += 1; continue; }
    seen.add(ev.id);
    out.events.push(ev);
  }
  return out;
}

function describe(ev) {
  const d = isObj(ev.detail) ? ev.detail : {};
  const mail = isObj(d.mail) ? d.mail : {};
  const to = Array.isArray(mail.destination) ? mail.destination.join(', ') : '?';
  return `${ev.id}  ${ev['detail-type'] || d.eventType || '?'}  ${ev.time || ''}  → ${to}`;
}

async function postOne(base, key, ev) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}${HOOK_PATH}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-api-key': key },
      body: JSON.stringify(ev),
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (err) {
    return { ok: false, status: err && err.name === 'AbortError' ? 'timeout' : (err && err.code) || 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** → { ok, line, posted, failed } */
async function run({ file, dryRun = false, base = DEFAULT_BASE, key = process.env.SES_HOOK_KEY, say = console.log } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    const line = `NO-GO — cannot read "${file}": ${err.message}. Nothing was posted.`;
    say(line);
    return { ok: false, line, posted: 0, failed: 0 };
  }
  const r = readEvents(text);
  say(`${file}: ${r.shape} — ${r.events.length} SES event(s), ${r.skipped} skipped (not an aws.ses event), ${r.duplicates} repeated id(s) dropped`);
  if (!r.events.length) {
    const line = `NO-GO — no SES event found in "${file}". Nothing was posted.`;
    say(line);
    return { ok: false, line, posted: 0, failed: 0 };
  }
  if (dryRun) {
    r.events.forEach((ev) => say(`  would post: ${describe(ev)}`));
    const line = `DRY RUN — GO. ${r.events.length} event(s) would be posted to ${base}${HOOK_PATH}. Next: SES_HOOK_KEY=… node scripts/yisramailT2ReplayDlq.js ${file}`;
    say(line);
    return { ok: true, line, posted: 0, failed: 0 };
  }
  if (!key) {
    const line = 'NO-GO — env SES_HOOK_KEY is not set (the ses-events hook key; never pass it as an argument). Nothing was posted.';
    say(line);
    return { ok: false, line, posted: 0, failed: 0 };
  }
  let posted = 0;
  let failed = 0;
  for (const ev of r.events) {
    const res = await postOne(base, key, ev);
    if (res.ok) posted += 1; else failed += 1;
    say(`  ${res.ok ? '✓' : '✗'} ${res.status}  ${describe(ev)}`);
  }
  const line = failed
    ? `NO-GO — ${posted} posted, ${failed} failed (above). Re-run the same file: events that did arrive are deduplicated by the hook.`
    : `GO — ${posted} event(s) posted to ${base}${HOOK_PATH} (the hook ignores ids it already has). Next: delete these messages from yisramail-ses-dlq (runbook DLQ stage).`;
  say(line);
  return { ok: !failed, line, posted, failed };
}

/** argv → { file, base, dryRun }: `--url <v>` is consumed with its value first, then the file is the first remaining non-flag. */
function parseArgs(argv) {
  const rest = [];
  let base = DEFAULT_BASE;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') { if (argv[i + 1]) base = argv[i + 1].replace(/\/+$/, ''); i += 1; continue; }
    if (argv[i] === '--dry-run') { dryRun = true; continue; }
    rest.push(argv[i]);
  }
  return { file: rest.find((a) => !a.startsWith('--')) || null, base, dryRun };
}

module.exports = { run, readEvents, parseArgs, HOOK_PATH };

if (require.main === module) {
  const { file, base, dryRun } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.log('NO-GO — usage: [SES_HOOK_KEY=…] node scripts/yisramailT2ReplayDlq.js <messages.json> [--dry-run] [--url <base>]');
    process.exitCode = 1;
  } else {
    run({ file, dryRun, base }).then((r) => { process.exitCode = r.ok ? 0 : 1; });
  }
}
