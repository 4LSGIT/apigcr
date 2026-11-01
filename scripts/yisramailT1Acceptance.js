#!/usr/bin/env node
// scripts/yisramailT1Acceptance.js
//
/**
 * YisraMail T1 — acceptance against the REAL SES account (ref/YISRAMAIL_DESIGN.md
 * §5.2). Two stages, each ending on ONE line: GO or NO-GO, naming the next step.
 *
 *   node scripts/yisramailT1Acceptance.js --send --row 17 --to it@4lsg.com
 *     A PRODUCTION SEND, run by Fred, once. Loads email_credentials row 17
 *     from .env's database (read-only; refuses a row that is not bulk_ok) and
 *     sends ONE message through the marketing path —
 *     emailService.sendEmailDirect(db, row, { bulk: true, headers:
 *     List-Unsubscribe / List-Unsubscribe-Post / List-Id, reply_to:
 *     office@4lsg.com, tags: { campaign_id: 't1', result_id: 't1' } }).
 *     The List-Unsubscribe URL carries a token that does not exist: /u/ shows
 *     its neutral page for an unknown token (§4.5 As built), so the link is
 *     harmless. Prints providerMessageId (the SES id parsed from the SMTP
 *     reply), the raw 250 line and the email_log row id (the smtp adapter
 *     writes its one outbound-smtp row as usual). NO-GO when the reply does
 *     not parse to an SES id — C2 stores that id; the --check stage can still
 *     run.
 *
 *   T2 (2026-11-02): --send also takes SES's mailbox simulator as --to
 *     (success@ / bounce@ / complaint@ / ooto@ / suppressionlist@
 *     simulator.amazonses.com) and [--campaign-id <tag>] [--result-id <tag>]
 *     (default t1 / t1; [A-Za-z0-9_-]{1,256}, held by emailService). A
 *     simulator send skips the DKIM next step: its proof is the SES event that
 *     reaches /hooks/ses-events (local/2026-11-02_YISRAMAIL_T2_SES_EVENTS_RUNBOOK.md).
 *
 *   node scripts/yisramailT1Acceptance.js --check <path-to-eml> [--domain news.4lsg.com]
 *     Offline. <path> = Gmail's "Show original" → "Download original" of the
 *     received message. Parses EVERY DKIM-Signature header and prints each
 *     d= with its h= list. GO only when the received message carries
 *     List-Unsubscribe and List-Unsubscribe-Post AND the signature with
 *     d=<domain> lists BOTH in h= (RFC 8058 §3.1: the one-click headers must
 *     be covered by a DKIM signature). Also reports whether
 *     X-SES-CONFIGURATION-SET / X-SES-MESSAGE-TAGS survived to the recipient
 *     (expected: they did not — SES strips the headers it acts on; if they
 *     survived, SES did not recognize them and the tags never reached SES:
 *     tell MAIL_MAN), whether Reply-To is office@4lsg.com, and the receiving
 *     server's dkim= verdict for <domain>.
 *     A NO-GO here is a FINDING, not a script bug: C2 must not build on
 *     unsigned headers. Paste the whole output to MAIL_MAN at once.
 *
 * The send waits at most SEND_TIMEOUT_MS for the relay; past it the outcome is
 * UNKNOWN (the relay may still deliver) — check the inbox before re-running.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SEND_TIMEOUT_MS = 60_000;
const DEFAULT_DOMAIN = 'news.4lsg.com';
const REPLY_TO = 'office@4lsg.com';
const UNSUB_URL = 'https://app.4lsg.com/u/T1ACCEPTANCE000000000';

// ─────────────────────────────────────────────────────────────
// --check: the .eml parser (pure — unit-tested on fixture text)
// ─────────────────────────────────────────────────────────────

/** The header block of a raw message → [{ name, value }] in order, continuation lines unfolded. */
function parseHeaders(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const end = text.indexOf('\n\n');
  const block = end === -1 ? text : text.slice(0, end);
  const out = [];
  for (const line of block.split('\n')) {
    if (/^[ \t]/.test(line) && out.length) { out[out.length - 1].value += ' ' + line.trim(); continue; }
    const m = /^([!-9;-~]+):\s?(.*)$/.exec(line);
    if (m) out.push({ name: m[1], value: m[2] });
  }
  return out;
}

/** A DKIM-Signature value → { d, s, h: [lowercased names] } (RFC 6376 tag=value list). */
function parseDkim(value) {
  const tags = {};
  for (const part of String(value).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).replace(/\s+/g, '').toLowerCase();
    if (k) tags[k] = part.slice(i + 1).replace(/\s+/g, '');
  }
  return {
    d: (tags.d || '').toLowerCase(),
    s: tags.s || '',
    h: (tags.h || '').split(':').map((x) => x.trim().toLowerCase()).filter(Boolean),
  };
}

/** The --check verdict for a raw message. → { ok, lines, line } */
function checkEml(raw, { domain = DEFAULT_DOMAIN } = {}) {
  const want = domain.toLowerCase();
  const headers = parseHeaders(raw);
  const all = (n) => headers.filter((h) => h.name.toLowerCase() === n);
  const lines = [];
  const warnings = [];

  const sigs = all('dkim-signature').map((h) => parseDkim(h.value));
  if (!sigs.length) lines.push('DKIM-Signature: none');
  sigs.forEach((s, i) => lines.push(`DKIM-Signature #${i + 1}: d=${s.d || '(none)'} s=${s.s || '(none)'} h=${s.h.join(':') || '(none)'}`));

  const hasLU  = all('list-unsubscribe').length > 0;
  const hasLUP = all('list-unsubscribe-post').length > 0;
  lines.push(`List-Unsubscribe: ${hasLU ? all('list-unsubscribe')[0].value : 'ABSENT'}`);
  lines.push(`List-Unsubscribe-Post: ${hasLUP ? all('list-unsubscribe-post')[0].value : 'ABSENT'}`);

  const ours = sigs.filter((s) => s.d === want);
  const signing = ours.find((s) => s.h.includes('list-unsubscribe') && s.h.includes('list-unsubscribe-post'));
  if (!ours.length) lines.push(`✗ no DKIM signature with d=${want}`);
  else if (!signing) lines.push(`✗ the d=${want} signature does not list both list-unsubscribe and list-unsubscribe-post in h=`);
  else lines.push(`✓ the d=${want} signature lists list-unsubscribe and list-unsubscribe-post in h=`);

  for (const n of ['x-ses-configuration-set', 'x-ses-message-tags']) {
    const got = all(n);
    if (got.length) {
      const msg = `${n} SURVIVED to the recipient (${got[0].value}) — SES did not act on it; the tags / configuration set may not have reached SES: tell MAIL_MAN`;
      lines.push(`! ${msg}`);
      warnings.push(msg);
    } else {
      lines.push(`${n}: absent at the recipient (expected — SES strips the headers it acts on)`);
    }
  }
  const replyTo = all('reply-to').map((h) => h.value).join(', ');
  const replyOk = new RegExp(`(^|[<\\s])${REPLY_TO.replace(/[.]/g, '\\.')}(>|\\s|$)`, 'i').test(replyTo);
  lines.push(`Reply-To: ${replyTo || 'ABSENT'} ${replyOk ? `(✓ ${REPLY_TO})` : `(! expected ${REPLY_TO})`}`);
  if (!replyOk) warnings.push(`Reply-To is not ${REPLY_TO}`);

  const verdicts = all('authentication-results').map((h) => h.value)
    .map((v) => (new RegExp(`dkim=(\\w+)[^;]*header\\.(?:d|i)=@?${want.replace(/[.]/g, '\\.')}(?![\\w.-])`, 'i').exec(v) || [])[1])
    .filter(Boolean);
  lines.push(`receiver's dkim verdict for ${want}: ${verdicts.length ? verdicts.join(', ') : '(no Authentication-Results line names it)'}`);
  if (verdicts.length && !verdicts.includes('pass')) warnings.push(`the receiver did not pass the d=${want} signature`);

  const ok = hasLU && hasLUP && !!signing;
  const line = ok
    ? `GO — List-Unsubscribe and List-Unsubscribe-Post are DKIM-signed by d=${want}${warnings.length ? ` (with ${warnings.length} warning(s) above — paste this output to MAIL_MAN)` : ''}. Next: paste this output to MAIL_MAN (acceptance for the T1 As built block).`
    : `NO-GO — ${!hasLU || !hasLUP ? 'the received message lacks the List-Unsubscribe headers' : `the one-click headers are not signed by d=${want}`}. A finding, not a script bug: paste this whole output to MAIL_MAN now — C2 must not build on unsigned headers.`;
  return { ok, lines, line, signatures: sigs, warnings };
}

// ─────────────────────────────────────────────────────────────
// --send
// ─────────────────────────────────────────────────────────────

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${what} did not finish within ${ms / 1000}s`), { code: 'T1_TIMEOUT' })), ms); }),
  ]);
}

/** The message --send sends: the exact sendEmailDirect options (exported for the unit test). */
const SIMULATOR_RE = /@simulator\.amazonses\.com$/i;

function acceptanceMessage(row, to, now = new Date(), { campaignId = 't1', resultId = 't1' } = {}) {
  const stamp = now.toISOString();
  return {
    bulk: true,
    from: row.email,
    to,
    subject: `YisraMail T1 acceptance ${stamp}`,
    text: `YisraMail T1 acceptance send, ${stamp}.\n\nThis tests the marketing transport's headers. No action needed.`,
    html: `<p>YisraMail T1 acceptance send, ${stamp}.</p><p>This tests the marketing transport's headers. No action needed.</p>`,
    reply_to: REPLY_TO,
    headers: {
      'List-Unsubscribe': `<${UNSUB_URL}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Id': '<news.news.4lsg.com>',
    },
    tags: { campaign_id: campaignId, result_id: resultId },
  };
}

async function send(db, { rowId, to, campaignId, resultId, say = console.log }) {
  const emailService = require('../services/emailService');
  const [[row]] = await db.query('SELECT * FROM email_credentials WHERE id = ? LIMIT 1', [rowId]);
  if (!row) return { ok: false, line: `NO-GO — no email_credentials row ${rowId}. Nothing was sent.` };
  if (!emailService.isBulkRow(row)) {
    return { ok: false, line: `NO-GO — row ${rowId} (${row.email}) is not bulk_ok. Mark it bulk in the sender editor first (after the migration + deploy). Nothing was sent.` };
  }
  say(`row ${row.id}: ${row.email} via ${row.smtp_host}:${row.smtp_port} — events_driver ${row.events_driver || '(none)'}, driver_config ${row.driver_config ? JSON.stringify(row.driver_config) : '(none)'}`);
  const msg = acceptanceMessage(row, to, new Date(), { campaignId, resultId });
  say(`tags:              campaign_id=${msg.tags.campaign_id}, result_id=${msg.tags.result_id}`);
  let info;
  try {
    info = await withTimeout(emailService.sendEmailDirect(db, row, msg), SEND_TIMEOUT_MS, 'the SMTP send');
  } catch (err) {
    if (err.code === 'T1_TIMEOUT') {
      return { ok: false, line: `NO-GO — ${err.message}; the outcome is UNKNOWN (it may still arrive). Check ${to}'s inbox before re-running.` };
    }
    return { ok: false, line: `NO-GO — the send failed: ${err.code ? `${err.code} ` : ''}${err.message}. Paste this output to MAIL_MAN.` };
  }
  say(`subject:           ${msg.subject}`);
  say(`250 reply:         ${info.response}`);
  say(`providerMessageId: ${info.providerMessageId}`);
  say(`Message-ID:        ${info.messageId}`);
  let logId = null;
  for (let i = 0; i < 10 && logId == null; i++) {     // the adapter writes email_log fire-and-forget: bounded wait
    const [[r]] = await db.query("SELECT id FROM email_log WHERE source = 'outbound-smtp' AND message_id = ? ORDER BY id DESC LIMIT 1", [info.messageId]);
    if (r) logId = r.id; else await new Promise((res) => setTimeout(res, 300));
  }
  say(`email_log id:      ${logId == null ? '(not found within 3 s)' : logId}`);
  const next = SIMULATOR_RE.test(to)
    ? `Next: SES publishes the event for ${to} to EventBridge within about a minute — read it on hook ses-events (runbook stage 7).`
    : `Next: in Gmail (${to}) open "${msg.subject}" → ⋮ → Show original → Download original, then: node scripts/yisramailT1Acceptance.js --check <downloaded .eml path>`;
  if (!info.providerMessageId) {
    return { ok: false, line: `NO-GO — sent, but the SES message id did not parse from the 250 reply above (the driver's format guess is wrong): paste this output to MAIL_MAN. ${next}` };
  }
  return { ok: true, line: `GO — sent through SES; message id parsed. ${next}` };
}

module.exports = { parseHeaders, parseDkim, checkEml, acceptanceMessage, send, DEFAULT_DOMAIN, REPLY_TO, SIMULATOR_RE };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i === -1 ? undefined : argv[i + 1]; };
  const usage = 'usage: node scripts/yisramailT1Acceptance.js --send --row 17 --to it@4lsg.com [--campaign-id t2 --result-id t2-1] | --check <path-to-eml> [--domain news.4lsg.com]';

  if (argv.includes('--check')) {
    const file = arg('--check');
    if (!file || !fs.existsSync(file)) {
      console.log(`NO-GO — no readable .eml at "${file || ''}". ${usage}`);
      process.exitCode = 1;
    } else {
      const r = checkEml(fs.readFileSync(file, 'utf8'), { domain: arg('--domain') || DEFAULT_DOMAIN });
      r.lines.forEach((l) => console.log(l));
      console.log(r.line);
      process.exitCode = r.ok ? 0 : 1;
    }
  } else if (argv.includes('--send')) {
    const rowId = Number(arg('--row'));
    const to = arg('--to');
    if (!Number.isInteger(rowId) || rowId <= 0 || !to || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(to)) {
      console.log(`NO-GO — --row <id> and --to <one address> are required. ${usage}`);
      process.exitCode = 1;
    } else {
      require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
      const mysql = require('mysql2');
      const { ensureSqlProxy } = require('./ensure-sql-proxy');
      (async () => {
        let pool;
        try {
          const proxy = await withTimeout(ensureSqlProxy(), 30_000, 'starting the Cloud SQL proxy');
          if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
          for (const k of ['host', 'user', 'password', 'database']) {
            if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
          }
          pool = mysql.createPool({
            host: process.env.host, user: process.env.user, password: process.env.password,
            database: process.env.database, timezone: 'Z', connectTimeout: 15_000, connectionLimit: 2,
          }).promise();
          const r = await send(pool, { rowId, to, campaignId: arg('--campaign-id') || 't1', resultId: arg('--result-id') || 't1' });
          console.log(r.line);
          process.exitCode = r.ok ? 0 : 1;
        } catch (err) {
          console.log(`\n${err.message}\n\nNO-GO — could not finish. Nothing was sent unless a 250 reply is printed above.`);
          process.exitCode = 1;
        } finally {
          if (pool) await pool.end().catch(() => {});
        }
      })();
    }
  } else {
    console.log(`NO-GO — ${usage}`);
    process.exitCode = 1;
  }
}
