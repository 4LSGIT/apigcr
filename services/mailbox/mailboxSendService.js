// services/mailbox/mailboxSendService.js
//
/**
 * Mailbox send service — mailbox-system arc, slice S3 (compose / reply from
 * the comms hub). HTTP layer: routes/api.mail.js. Spec:
 * ref/MAILBOX_SYSTEM_DESIGN.md §4.2 (send, "As built"), D6, §4.1 S1-G.
 *
 *   listIdentities(db, userId)              the mailboxes the caller may send AS,
 *                                           each sendable or not (and why)
 *   replyDefaults(db, userId, messageId, q) recipients / subject / quote for a
 *                                           reply or reply-all to a stored message
 *   sendFromMailbox(db, userId, mailboxId, body)
 *                                           the send
 *   seedSentReadState(db, data, {final})    the deferred read-state seed
 *                                           (lib/job_executor 'mail_sent_read_seed')
 *
 * ── THE GRANT CHECK IS HERE, ON THE INTERACTIVE SEAT (D6) ────────────────────
 * can_send via mailboxService.getAccess — SU bypass = full access (S0), and
 * the attorney READ bypass does NOT extend to send (mailboxService header,
 * SEND). emailService and the adapters stay grant-blind: a workflow /
 * campaign / automation send never passes through this file.
 *
 * ── WHAT A SEND WRITES (carry #1) ────────────────────────────────────────────
 * Nothing to the log tier. The adapters keep writing their one 'outbound-*'
 * email_log row (FAILED-… on a refusal), and that is all: for a Gmail-fed
 * mailbox the ingested All-Mail copy, emitted under gmail-firm, IS the log
 * path (the same Gmail id twins the outbound-gmail row); an RFC mailbox's
 * Sent stays store-only (§4.1). A send-time log row would log every hub reply
 * twice. The response carries the adapter's email_log id (looked up — the
 * adapters write it fire-and-forget).
 *
 * ── SENT APPEND (carry #2) ───────────────────────────────────────────────────
 * Decided per send from the send credential: provider 'gmail' (the Gmail API)
 * files every send into the account's Sent itself → no APPEND, no IMAP
 * connection. Anything else ('smtp') → APPEND the same message (same
 * Message-ID, Bcc kept) to the mailbox's Sent folder through
 * imapTransport.appendSent, which independently refuses any X-GM-EXT-1 server
 * (a Gmail mailbox reached over another relay). An APPEND that fails or
 * finds no Sent folder is a WARNING in the response — the mail was sent; the
 * send is never reported as failed for it.
 *
 * ── READ STATE FOR THE SENDER (carry #3; S3-R: an alias sender's probe also
 *    walks the alias's PARENT box — the copy lives there — and the grant-
 *    scoped markRead admits it through the alias slice) ──────────────────────
 * The sent copy does not exist at send time: it arrives with a later ingest
 * tick (All Mail on Gmail; a polled Sent folder after APPEND). So the send
 * SCHEDULES the seed — a one_time scheduled_jobs row ('mail_sent_read_seed',
 * first try SEED_FIRST_DELAY after the send, then SEED_BACKOFF doubling, up
 * to SEED_MAX_ATTEMPTS) — that marks every copy the sender can read, by the
 * Gmail id (provider_id) or our Message-ID, read for them through
 * mailReadService.markRead (grant-scoped). Not found yet → the job retries;
 * on its last try it completes quietly (no alert: a copy that is never
 * stored — an unpolled Sent folder — is not a failure). Scheduled only when
 * a copy will be stored with a key we know: Gmail sends (provider id), or an
 * APPEND into a folder the mailbox polls (Message-ID).
 *
 * ── GUARDRAILS (design §4.2) ─────────────────────────────────────────────────
 *   - recipients: To required; To + Cc + Bcc ≤ MAX_RECIPIENTS after
 *     de-duplication. The hub is not a bulk sender and never touches campaign
 *     paths (bulk_ok stays the campaign sender's).
 *   - daily budget per TRANSPORT (the account a provider counts against: the
 *     Google account behind a gmail credential, the SMTP login behind an smtp
 *     one), counted from email_log over the last 24 hours — automation sends
 *     through the same account included, refused attempts (FAILED-… rows)
 *     too, since the provider counts them. Breach → 429, nothing dispatched,
 *     ONE error alert per transport per day (dedup_key) — error, not warning:
 *     a spent budget is no transient blip, it stops every hub send through
 *     that account until the window rolls, so IT must hear of it (the hourly
 *     digest emails at error and above). Never retried here.
 *     Defaults DEFAULT_DAILY_BUDGET, overridable per provider by the
 *     app_settings row `mail_send_daily_budget` ({"gmail":n,"smtp":n}). A
 *     soft limit: two sends racing at the edge can both pass.
 *   - sizes: subject / body caps below; every header value is validated
 *     (no CR/LF, no angle brackets in ids) before nodemailer sees it.
 *
 * ── TRANSACTION CLASSIFICATION ───────────────────────────────────────────────
 * No withTransaction span. The dispatch is an external side effect with no
 * DB write of ours to roll back; everything after it (email_log lookup,
 * APPEND, the seed job row) is best-effort and post-dispatch. Nothing is
 * retried in-process: a client re-POST is a second send (the pane disables
 * Send while one is in flight).
 *
 * NO MODULE-SCOPE STATE (design §2): every call reads the DB.
 */

'use strict';

const crypto = require('crypto');
const MailComposer = require('nodemailer/lib/mail-composer');
const mbx = require('../mailboxService');
const emailService = require('../emailService');
const gmailAdapter = require('../adapters/email/gmail');
const transport = require('./imapTransport');
const { loadConnectionRow, folderConfig, htmlToText } = require('./mailboxIngestService');
const logService = require('../logService');
const { inferDirection, firmDomains } = require('../emailIngestService');
const read = require('./mailReadService');
const { getSetting } = require('../settingsService');
const { utcToLocal } = require('../timezoneService');
const mailboxColor = require('../../public/js/mailboxColor');

const { httpError } = mbx;

const MAX_RECIPIENTS = 10;          // To + Cc + Bcc, after de-duplication
const SUBJECT_MAX = 500;
const TEXT_MAX = 200_000;           // characters of the new text
const HTML_MAX = 500_000;
const NAME_MAX = 128;
const QUOTE_MAX = 20_000;           // characters of the quoted original
const ADDR_MAX = 254;
const MID_MAX = 512;               // mail_messages.message_id / in_reply_to / thread_key are varchar(512)
const DEFAULT_DAILY_BUDGET = Object.freeze({ gmail: 1500, smtp: 300 });
const BUDGET_SETTING = 'mail_send_daily_budget';
const SEND_PROVIDERS = Object.freeze(['smtp', 'gmail']); // pabbly: no headers, no Cc/Bcc
const SEED_JOB_TYPE = 'mail_sent_read_seed';
const SEED_FIRST_DELAY_MS = 6 * 60_000;  // one ~5-min ingest tick + margin
const SEED_MAX_ATTEMPTS = 4;             // +6, +11, +21, +41 min
const SEED_BACKOFF_S = 300;
// S2P §G: the sent copy's case link. Same first delay as the seed; MORE
// attempts, because a 409 is expected until the copy clears the 10-minute
// store-only grace (caseLink STORE_ONLY_GRACE_MIN): tries at +6, +11, +21,
// +41, +81, +161 min — attempt 3 (+21) is the first past a typical
// store-at-~6-min + 10-min grace, and the tail absorbs a slow scheduler.
const LINK_JOB_TYPE = 'mail_sent_case_link';
const LINK_FIRST_DELAY_MS = 6 * 60_000;
const LINK_MAX_ATTEMPTS = 6;
const LINK_BACKOFF_S = 300;
const LOG_ID_TRIES = 5;
const LOG_ID_WAIT_MS = 60;
const CASE_ID_RE = /^[A-Za-z0-9_-]{1,20}$/; // mailReadService.caseLink's rule
const BODY_KEYS = Object.freeze([
  'mailbox_id', 'to', 'cc', 'bcc', 'subject', 'body_text', 'body_html',
  'in_reply_to_message_fk', 'quote_original', 'signature', 'case_id',
]);

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const MID_RE = /^[^\s<>\u0000-\u001f\u007f]{1,512}$/;
const GMAIL_ID_RE = /^[0-9a-f]{1,16}$/;
const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex';

const REASON_TEXT = Object.freeze({
  inactive: 'This mailbox is switched off (Admin → Mailboxes).',
  no_send_credential: 'Read-only: this mailbox has no send credential (a superuser sets one in Admin → Mailboxes).',
  credential_missing: 'This mailbox\'s send credential no longer exists (a superuser re-points it in Admin → Mailboxes).',
  unsupported_provider: 'This mailbox sends through Pabbly, which cannot send replies or Cc/Bcc — a superuser re-points it to an SMTP or Gmail credential.',
  credential_mismatch: 'This mailbox\'s Google sender is for a different address — Gmail would send the mail under its own address instead. A superuser re-points it (Admin → Mailboxes) to the sender whose address is the mailbox\'s.',
});


// ─────────────────────────────────────────────────────────────────────────────
// Helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

function has(obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k);
}

function toId(v, label) {
  const s = typeof v === 'number' ? String(v) : String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0 || !Number.isSafeInteger(Number(s))) {
    throw httpError(400, `${label} must be a positive integer`);
  }
  return Number(s);
}

function toBool(v, label) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  throw httpError(400, `${label} must be true or false`);
}

const lower = (s) => String(s == null ? '' : s).trim().toLowerCase();
const sameAddr = (a, b) => !!a && !!b && lower(a) === lower(b);

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Plain text → HTML: escaped, blank lines → paragraphs, newlines → <br>. */
function textToHtml(text) {
  const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!t.trim()) return '';
  return t.split(/\n{2,}/).map(p => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/** A header-safe single line: CR/LF/TAB → space, other controls dropped, trimmed. */
function oneLine(v) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/** A stored Message-ID (brackets stripped) safe to put back in a header, else null. */
function cleanMid(v) {
  const s = String(v == null ? '' : v).trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  return s && s.length <= MID_MAX && MID_RE.test(s) ? s : null;
}

/** A display name safe inside "…": no quotes, backslashes, angle brackets or controls. */
function cleanName(v) {
  if (v == null) return null;
  const s = oneLine(v).replace(/["\\<>]/g, '').trim().slice(0, NAME_MAX).trim();
  return s || null;
}

/** One recipient: "a@b", "Name <a@b>" or {email, name}. → {email, name} or 400. */
function parseRecipient(v, label) {
  let email;
  let name = null;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    email = v.email;
    name = v.name;
  } else if (typeof v === 'string') {
    const s = v.trim();
    const m = /^(.*?)\s*<([^<>]*)>\s*$/.exec(s);
    if (m) { name = m[1].replace(/^"(.*)"$/, '$1'); email = m[2]; } else email = s;
  } else {
    throw httpError(400, `${label}: each recipient is an address or {email, name}`);
  }
  const e = String(email == null ? '' : email).trim();
  if (!e || e.length > ADDR_MAX || !EMAIL_RE.test(e)) {
    throw httpError(400, `${label}: "${oneLine(e).slice(0, 80)}" is not an email address`);
  }
  const n = cleanName(name);
  return { email: e, name: n && lower(n) !== lower(e) ? n : null };
}

function recipientList(v, label) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw httpError(400, `${label} must be an array of addresses`);
  if (v.length > MAX_RECIPIENTS * 3) throw httpError(400, `${label} has too many entries`);
  return v.map(x => parseRecipient(x, label));
}

/** "Name" <a@b> | a@b — names are cleanName()d, so the quoting is safe. */
function formatAddr(r) {
  return r.name ? `"${r.name}" <${r.email}>` : r.email;
}

/** "Re: subject" unless it already is one. */
function reSubject(subject) {
  const t = oneLine(subject);
  if (/^re\s*:/i.test(t)) return t;
  return `Re: ${t || '(no subject)'}`;
}

/** Subject with reply/forward prefixes off, for "is this the same conversation's subject". */
function bareSubject(subject) {
  let t = oneLine(subject).toLowerCase();
  let prev;
  do { prev = t; t = t.replace(/^\s*(re|fwd?|fw|aw|sv)\s*(\[\d+\])?\s*:\s*/i, ''); } while (t !== prev);
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Reply threading from the stored parent (OQ1's rule run backwards). The
 * full References header is not stored, so the chain is abbreviated (RFC
 * 5322 §3.6.4 allows trimming the middle): the thread root (the parent's
 * thread_key = ITS References[0]), the parent's own parent, the parent.
 * The worker derives the reply's thread_key as References[0] = the root —
 * the parent's thread_key — so the sent copy lands in the same thread.
 * → {inReplyTo, references, threadKey} | null (a parent with no ids).
 */
function threadingFor(parent) {
  const pid = cleanMid(parent.message_id);
  const chain = [];
  const push = (x) => { if (x && !chain.some(c => c.toLowerCase() === x.toLowerCase())) chain.push(x); };
  push(cleanMid(parent.thread_key));
  push(cleanMid(parent.in_reply_to));
  push(pid);
  if (!chain.length) return null;
  return {
    inReplyTo: pid ? `<${pid}>` : null,
    references: chain.map(x => `<${x}>`).join(' '),
    threadKey: chain[0],
  };
}

/** The quoted original: "On <date>, <from> wrote:" + its text (capped). */
function quoteOf(parent) {
  const hasText = parent.body_text != null && String(parent.body_text).trim() !== '';
  let text = hasText ? String(parent.body_text) : (parent.body_html ? htmlToText(String(parent.body_html)) : '');
  text = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  let cut = false;
  if (text.length > QUOTE_MAX) { text = text.slice(0, QUOTE_MAX); cut = true; }
  const d = parent.date ? utcToLocal(parent.date instanceof Date ? parent.date : new Date(parent.date)) : null;
  const when = d && d.isValid ? d.toFormat("ccc, LLL d, yyyy 'at' h:mm a") : null;
  const who = oneLine(parent.from_addr) || 'the sender';
  return {
    header: when ? `On ${when}, ${who} wrote:` : `${who} wrote:`,
    text: text + (cut ? '\n[…]' : ''),
  };
}

/** The credential's signature as {html, text}, or null (the emailService derivation). */
function signatureOf(cred) {
  if (!cred || !(cred.signature_html || cred.signature_text)) return null;
  return {
    html: cred.signature_html || textToHtml(cred.signature_text),
    text: cred.signature_text || htmlToText(String(cred.signature_html)),
  };
}

/** New content, then the signature, then the quoted original — both halves. */
function composeBodies({ text, html, signature, quote }) {
  const outText = [text];
  const outHtml = [`<div>${html}</div>`];
  if (signature) {
    outText.push(signature.text);
    outHtml.push(`<br><div>${signature.html}</div>`);
  }
  if (quote) {
    outText.push(`${quote.header}\n${quote.text.split('\n').map(l => `> ${l}`).join('\n')}`);
    outHtml.push(`<br><div>${escHtml(quote.header)}</div><blockquote style="${QUOTE_STYLE}">${textToHtml(quote.text) || '<p></p>'}</blockquote>`);
  }
  return { text: outText.join('\n\n'), html: outHtml.join('') };
}

/** RFC 5322 bytes for the Sent copy — the same headers, Bcc KEPT (the sender's own record). */
function compileMessage(mail) {
  return new Promise((resolve, reject) => {
    const node = new MailComposer(mail).compile();
    node.keepBcc = true;
    node.build((err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sendAlert(db, o) {
  try {
    const { alert } = require('../../lib/alerting'); // deferred — circular-dep convention
    return Promise.resolve(alert(db, { source: 'app', ...o })).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Body validation
// ─────────────────────────────────────────────────────────────────────────────

/** The POST body → a clean request, or 400. Unknown keys are refused. */
function validateSendBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'request body must be a JSON object');
  for (const k of Object.keys(body)) {
    if (!BODY_KEYS.includes(k)) throw httpError(400, `unknown field "${k}"`);
  }
  const out = {};
  out.mailbox_id = toId(body.mailbox_id, 'mailbox_id');
  out.to = recipientList(body.to, 'to');
  out.cc = recipientList(body.cc, 'cc');
  out.bcc = recipientList(body.bcc, 'bcc');
  if (!out.to.length) throw httpError(400, 'to needs at least one address');
  // One address once: To beats Cc beats Bcc.
  const seen = new Set();
  for (const k of ['to', 'cc', 'bcc']) {
    out[k] = out[k].filter((r) => { const e = lower(r.email); if (seen.has(e)) return false; seen.add(e); return true; });
  }
  if (seen.size > MAX_RECIPIENTS) {
    throw httpError(400, `at most ${MAX_RECIPIENTS} recipients (To, Cc and Bcc together) — the hub is not a bulk sender`);
  }

  if (body.subject !== undefined && body.subject !== null && typeof body.subject !== 'string') throw httpError(400, 'subject must be a string');
  out.subject = oneLine(body.subject);
  if (out.subject.length > SUBJECT_MAX) throw httpError(400, `subject must be at most ${SUBJECT_MAX} characters`);

  for (const [k, max] of [['body_text', TEXT_MAX], ['body_html', HTML_MAX]]) {
    const v = body[k];
    if (v === undefined || v === null) { out[k] = null; continue; }
    if (typeof v !== 'string') throw httpError(400, `${k} must be a string`);
    if (v.length > max) throw httpError(400, `${k} must be at most ${max} characters`);
    out[k] = v;
  }
  if (!(out.body_text && out.body_text.trim()) && !(out.body_html && out.body_html.trim())) {
    throw httpError(400, 'write a message — body_text or body_html is required');
  }

  out.in_reply_to_message_fk = body.in_reply_to_message_fk === undefined || body.in_reply_to_message_fk === null
    ? null : toId(body.in_reply_to_message_fk, 'in_reply_to_message_fk');
  out.quote_original = has(body, 'quote_original') ? toBool(body.quote_original, 'quote_original') : true;
  out.signature = has(body, 'signature') ? toBool(body.signature, 'signature') : false;
  // S2P §G: the composer's optional Case field. Shape-checked here; existence
  // is checked against `cases` BEFORE dispatch (sendFromMailbox) — an unknown
  // case is a 400 and nothing leaves.
  if (body.case_id === undefined || body.case_id === null || body.case_id === '') {
    out.case_id = null;
  } else {
    const c = typeof body.case_id === 'string' ? body.case_id.trim() : (typeof body.case_id === 'number' ? String(body.case_id) : '');
    if (!CASE_ID_RE.test(c)) throw httpError(400, 'case_id must be a case id');
    out.case_id = c;
  }
  if (!out.in_reply_to_message_fk && !out.subject) throw httpError(400, 'subject is required');
  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// Identity: can this caller send as this mailbox, and through what
// ─────────────────────────────────────────────────────────────────────────────

const SEND_MAILBOX_COLS = 'id, address, display_name, active, send_credential_id, ingest_enabled, ingest_folders';

function whyNot(mb, cred) {
  if (!mb.active) return 'inactive';
  if (mb.send_credential_id == null) return 'no_send_credential';
  if (!cred) return 'credential_missing';
  if (!SEND_PROVIDERS.includes(String(cred.provider))) return 'unsupported_provider';
  // The Gmail API sends as the address only when it is that account's own
  // (or a verified alias — which is what each gmail email_credentials row
  // IS). Any other From is silently rewritten to the account's primary
  // address (services/adapters/email/gmail.js): the mail would leave under
  // someone else's name while the hub says it went from this box. A shared
  // SMTP credential is different by design (§4.2: one wildcard sender per
  // domain) — the relay decides there.
  if (cred.provider === 'gmail' && !sameAddr(cred.email, mb.address)) return 'credential_mismatch';
  return null;
}

function refusal(reason) {
  const err = httpError(409, REASON_TEXT[reason] || 'This mailbox cannot send');
  err.code = reason;
  return err;
}

/**
 * The caller's right to send as mailbox `mailboxId` + the rows the send
 * needs. 404 when they cannot even read it (no existence oracle), 403 when
 * they can read but not send, 409 when the box itself cannot send.
 */
async function resolveIdentity(db, userId, mailboxId) {
  const id = toId(mailboxId, 'mailbox_id');
  const access = await mbx.getAccess(db, userId, 'mailbox', id);
  if (!access.can_send) {
    if (!access.can_read) throw httpError(404, 'Mailbox not found');
    throw httpError(403, 'You can read this mailbox but not send from it — ask whoever manages it for Send access');
  }
  const [[mb]] = await db.query(`SELECT ${SEND_MAILBOX_COLS} FROM mailboxes WHERE id = ? LIMIT 1`, [id]);
  if (!mb) throw httpError(404, 'Mailbox not found');
  let cred = null;
  if (mb.send_credential_id != null) {
    const [[row]] = await db.query('SELECT * FROM email_credentials WHERE id = ? LIMIT 1', [Number(mb.send_credential_id)]);
    cred = row || null;
  }
  const reason = whyNot(mb, cred);
  if (reason) throw refusal(reason);
  return { mailbox: mb, cred, access };
}

/**
 * The comms hub's identity picker: every mailbox the caller may send AS
 * (mailboxService.listSendable — SU all, else can_send grants, no role
 * bypass), each {id, address, display_name, color, active, send_only,
 * sendable, reason, reason_text, signature}. `signature` = its credential
 * carries one AND is the box's own address (a shared domain credential's
 * signature is nobody's). Never the credential itself.
 *
 * ORDER (S3.2): real boxes first, then SEND-ONLY identities (a Google alias —
 * mailReadService.sendOnlyIds, design §4.2), each group by address. A new
 * Compose takes the first sendable one, so with alias boxes a person with
 * Send on billing@ (alias) and stuart@ (the box) composes as stuart@, not as
 * whichever address sorts first.
 */
async function listIdentities(db, userId) {
  const rows = await mbx.listSendable(db, userId);
  const sendOnly = await read.sendOnlyIds(db, rows.map(r => r.id));
  const credIds = [...new Set(rows.map(r => r.send_credential_id).filter(v => v != null).map(Number))];
  const creds = new Map();
  if (credIds.length) {
    const [cr] = await db.query(
      `SELECT id, email, provider,
              ((signature_html IS NOT NULL AND signature_html <> '') OR (signature_text IS NOT NULL AND signature_text <> '')) AS has_sig
         FROM email_credentials WHERE id IN (?)`,
      [credIds]
    );
    for (const c of cr) creds.set(Number(c.id), c);
  }
  const identities = rows.map((r) => {
    const cred = r.send_credential_id != null ? creds.get(Number(r.send_credential_id)) || null : null;
    const reason = whyNot(r, cred);
    return {
      id: Number(r.id),
      address: r.address,
      display_name: r.display_name || null,
      color: mailboxColor.normalize(r.color),
      active: !!r.active,
      send_only: sendOnly.has(Number(r.id)),
      sendable: !reason,
      reason,
      reason_text: reason ? REASON_TEXT[reason] : null,
      signature: !reason && !!Number(cred.has_sig) && sameAddr(cred.email, r.address),
    };
  });
  // Stable: each group keeps listSendable's address order.
  identities.sort((a, b) => Number(a.send_only) - Number(b.send_only));
  return { identities, max_recipients: MAX_RECIPIENTS };
}

/**
 * The caller's EXPLICIT send grants among `sendable` (S3.2). An SU's bypass
 * sends as every box, so the grant rows they hold say who they are; anyone
 * else's sendable set IS their grant rows (listSendable), returned as is.
 */
const GRANTED_SEND_SQL = "SELECT channel_id FROM channel_grants WHERE user = ? AND channel_type = 'mailbox' AND can_send = 1";

async function grantedIdentities(db, userId, sendable) {
  if (!(await mbx.isSuperuser(db, userId))) return sendable;
  const [rows] = await db.query(GRANTED_SEND_SQL, [Number(userId)]);
  const ids = new Set(rows.map(r => Number(r.channel_id)));
  return sendable.filter(i => ids.has(i.id));
}


// ─────────────────────────────────────────────────────────────────────────────
// The parent message (reply)
// ─────────────────────────────────────────────────────────────────────────────

const PARENT_COLS = 'id, mailbox_id, folder, gmail_labels, message_id, in_reply_to, thread_key, provider_id, from_addr, to_addrs, cc_addrs, subject, date, body_text, body_html';

/** Is this stored row a SENT copy (the hub's Sent scope: the Gmail \Sent label, or a Sent folder)? */
function isSentCopy(row) {
  return read.placeOf(row).sent || new RegExp(read.SENT_FOLDER_SQL_RE, 'i').test(String(row.folder || ''));
}

/**
 * A stored message the caller can READ, else 404 — its mailbox readable, or
 * (S3-R) a readable alias slice of that box admits it (mailReadService
 * ACCESS / ALIAS SLICE: the row carries From/To/Cc + gmail_labels, which is
 * what the slice test reads). Like the thread routes.
 */
async function loadParent(db, userId, messageId, label = 'message id') {
  const id = toId(messageId, label);
  const [[row]] = await db.query(`SELECT ${PARENT_COLS} FROM mail_messages WHERE id = ? LIMIT 1`, [id]);
  if (!row) throw httpError(404, 'Message not found');
  const access = await mbx.getAccess(db, userId, 'mailbox', row.mailbox_id);
  if (!access.can_read && !(await read.messageAliasEntry(db, userId, row))) {
    throw httpError(404, 'Message not found');
  }
  return row;
}

/**
 * Reply / reply-all defaults for message `messageId`:
 *   identity  q.mailbox_id when the caller can send as it; else the PICK: the
 *             sendable box the mail came FROM, else the first one in its To,
 *             then its Cc (header order) — the address the mail was sent to
 *             (Fred, 2026-10-12; Gmail's "reply from the same address") —
 *             else the box the message sits in. The pick runs first over the
 *             caller's EXPLICIT send grants, then over everything they may
 *             send as (S3.2: an SU's bypass sends as every box; the grant rows
 *             they hold say who they are — for everyone else the two sets are
 *             one). First hit wins; else the first granted, else the first
 *             sendable one (real boxes come first — listIdentities); else null
 *             (cannot reply). This is what makes a SEND-ONLY identity (a
 *             Google alias such as it@ whose mail lands in the account's own
 *             box — design §4.2) reply as itself.
 *   to        OWN mail is judged against that identity (S3.2): its From IS
 *             the identity → own; else the identity is in its To/Cc → NOT own
 *             (answer the sender — internal "stuart@ → it@" mail is one copy in
 *             the account's box, a Sent copy, yet it was sent TO it@); else
 *             the S3 rule — its From is one of the caller's sendable boxes, or
 *             the row is a Sent copy (the \Sent label / a Sent folder: mail
 *             the account sent under another From, automations@). Own mail →
 *             its To; otherwise → the sender.
 *   cc        (reply-all) the message's other To + Cc, minus the identity's
 *             own address and anything already in To.
 *   subject   "Re: …" (reSubject); quote: {header, text} as the send builds it.
 * The stored row has no Reply-To (not captured at ingest), so replies go to
 * From. `over_cap` when the defaults alone exceed MAX_RECIPIENTS.
 */
async function replyDefaults(db, userId, messageId, q = {}) {
  const parent = await loadParent(db, userId, messageId);
  const all = q.all === true || q.all === 1 || q.all === '1' || q.all === 'true';
  const { identities } = await listIdentities(db, userId);
  const sendable = identities.filter(i => i.sendable);
  const mine = new Set(sendable.map(i => lower(i.address)));
  const tos = read.addressList(parent.to_addrs);
  const ccs = read.addressList(parent.cc_addrs);
  const want = q.mailbox_id !== undefined && q.mailbox_id !== null && q.mailbox_id !== '' ? toId(q.mailbox_id, 'mailbox_id') : null;
  const from = read.addressList(parent.from_addr)[0] || null;
  const granted = await grantedIdentities(db, userId, sendable);
  /** The pick (header) over one set of identities: From, To, Cc, the message's box. */
  const pick = (set) => {
    const boxFor = (list) => {
      for (const a of list) {
        const hit = set.find(i => lower(i.address) === a.email);
        if (hit) return hit;
      }
      return null;
    };
    return (from ? boxFor([from]) : null)
      || boxFor(tos) || boxFor(ccs)
      || set.find(i => i.id === Number(parent.mailbox_id))
      || null;
  };
  const identity = (want && sendable.find(i => i.id === want))
    || (granted !== sendable ? pick(granted) : null)
    || pick(sendable)
    || granted[0] || sendable[0] || null;
  const me = identity ? lower(identity.address) : null;
  const toMe = !!me && [...tos, ...ccs].some(a => a.email === me);
  const own = !!(from && me && from.email === me)
    || (!toMe && (!!(from && mine.has(from.email)) || isSentCopy(parent)));
  const shape = (a) => ({ email: a.email, name: a.name || null });
  const to = (own ? tos : (from ? [from] : [])).map(shape);
  const taken = new Set(to.map(a => a.email));
  if (me) taken.add(me);
  const cc = [];
  if (all) {
    for (const a of [...(own ? [] : tos), ...ccs]) {
      if (taken.has(a.email)) continue;
      taken.add(a.email);
      cc.push(shape(a));
    }
  }
  return {
    in_reply_to_message_fk: Number(parent.id),
    mailbox_id: identity ? identity.id : null,
    all,
    to,
    cc,
    subject: reSubject(parent.subject),
    quote: quoteOf(parent),
    over_cap: to.length + cc.length > MAX_RECIPIENTS,
    max_recipients: MAX_RECIPIENTS,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Budget
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The account a provider counts sends against, and every From address that
 * reaches email_log through it: the email_credentials rows sharing it (all
 * aliases of one Google account; one SMTP login) plus every mailbox that
 * sends through any of them (a shared domain credential logs the MAILBOX's
 * address as From).
 */
async function transportOf(db, cred) {
  let key;
  let peers;
  if (cred.provider === 'gmail') {
    key = `gmail:${cred.credential_id == null ? 'none' : Number(cred.credential_id)}`;
    [peers] = await db.query(
      "SELECT id, email FROM email_credentials WHERE provider = 'gmail' AND credential_id <=> ?",
      [cred.credential_id == null ? null : Number(cred.credential_id)]
    );
  } else {
    key = `smtp:${lower(cred.smtp_host)}:${lower(cred.smtp_user)}`;
    [peers] = await db.query(
      "SELECT id, email FROM email_credentials WHERE provider = 'smtp' AND smtp_host = ? AND smtp_user = ?",
      [cred.smtp_host, cred.smtp_user]
    );
  }
  const ids = [...new Set([Number(cred.id), ...peers.map(p => Number(p.id))])];
  const [boxes] = await db.query('SELECT address FROM mailboxes WHERE send_credential_id IN (?)', [ids]);
  const addresses = [...new Set([cred.email, ...peers.map(p => p.email), ...boxes.map(b => b.address)].filter(Boolean).map(lower))];
  return { key, source: `outbound-${cred.provider}`, addresses };
}

/** The daily budget for a provider: the app_settings override, else the default. */
async function budgetFor(db, provider) {
  let v = null;
  try { v = await getSetting(db, BUDGET_SETTING); } catch (_) { /* default */ }
  let parsed = null;
  try { parsed = v ? JSON.parse(v) : null; } catch (_) { parsed = null; }
  const n = parsed && typeof parsed === 'object' ? Number(parsed[provider]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET[provider];
}

/** Refuse (429 + one ERROR alert per transport per day — header, GUARDRAILS) when the budget is spent. */
async function checkBudget(db, cred, mailbox) {
  const t = await transportOf(db, cred);
  const budget = await budgetFor(db, cred.provider);
  const [[row]] = await db.query(
    'SELECT COUNT(*) AS n FROM email_log WHERE source = ? AND from_email IN (?) AND processed_at > NOW() - INTERVAL 24 HOUR',
    [t.source, t.addresses]
  );
  const used = Number(row && row.n) || 0;
  if (used < budget) return { key: t.key, used, budget };
  const day = new Date().toISOString().slice(0, 10);
  await sendAlert(db, {
    kind: 'mailbox_send_budget',
    group_key: `app:mailbox_send_budget:${t.key}`,
    dedup_key: `mailbox_send_budget:${t.key}:${day}`,
    severity: 'error',
    title: `Mail send budget reached: ${mailbox.address}`,
    message: `${used} sends through ${t.key} in the last 24 hours (budget ${budget}). The comms hub is refusing sends through it ` +
      `until the count drops; automation sends are not stopped by this check. Raise or lower the budget with the ` +
      `app_settings row '${BUDGET_SETTING}' ({"gmail": n, "smtp": n}).`,
    context: { mailbox_id: Number(mailbox.id), transport: t.key, used, budget },
    ref_table: 'mailboxes',
    ref_id: Number(mailbox.id),
  });
  const err = httpError(429, `This mailbox's sending account has reached its daily limit (${used} of ${budget} in the last 24 hours). ` +
    'Nothing was sent — try again later. IT has been notified.');
  err.code = 'SEND_BUDGET';
  throw err;
}


// ─────────────────────────────────────────────────────────────────────────────
// The send
// ─────────────────────────────────────────────────────────────────────────────

/** The adapter's own email_log row (written fire-and-forget) → its id, or null. */
async function findLogRow(db, source, messageId) {
  if (!messageId) return null;
  for (let i = 0; i < LOG_ID_TRIES; i++) {
    const [[row]] = await db.query(
      'SELECT id FROM email_log WHERE source = ? AND message_id = ? ORDER BY id DESC LIMIT 1',
      [source, messageId]
    );
    if (row) return Number(row.id);
    await sleep(LOG_ID_WAIT_MS);
  }
  return null;
}

/** Is `folder` one the mailbox polls (so an APPENDed copy will be stored)? */
function folderPolled(mailbox, folder) {
  if (!folder || !Number(mailbox.ingest_enabled)) return false;
  return folderConfig(mailbox.ingest_folders).some(([name]) =>
    name === folder || (name.toUpperCase() === 'INBOX' && folder.toUpperCase() === 'INBOX'));
}

async function scheduleSeed(db, data) {
  const [r] = await db.query(
    `INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts, backoff_seconds)
     VALUES ('one_time', ?, 'pending', ?, ?, ?, ?)`,
    [
      new Date(Date.now() + SEED_FIRST_DELAY_MS),
      `Mail sent — read state for user #${data.user} (mailbox #${data.mailbox_id})`,
      JSON.stringify({ type: SEED_JOB_TYPE, ...data }),
      SEED_MAX_ATTEMPTS,
      SEED_BACKOFF_S,
    ]
  );
  return r && r.insertId ? Number(r.insertId) : null;
}

/**
 * Send one message AS mailbox `mailboxId` (body: see BODY_KEYS; to/cc/bcc
 * arrays of "a@b" | "Name <a@b>" | {email, name}). Grant, identity, parent
 * and budget are checked before anything leaves; then the dispatch through
 * emailService.sendEmailDirect + the credential's adapter; then the
 * best-effort tail (email_log id, Sent APPEND, read-state seed).
 */
async function sendFromMailbox(db, userId, mailboxId, bodyIn) {
  const body = validateSendBody({ ...(bodyIn || {}), mailbox_id: mailboxId });
  const { mailbox, cred } = await resolveIdentity(db, userId, body.mailbox_id);
  const warnings = [];

  let parent = null;
  let threading = null;
  if (body.in_reply_to_message_fk) {
    parent = await loadParent(db, userId, body.in_reply_to_message_fk, 'in_reply_to_message_fk');
    threading = threadingFor(parent);
  }
  const subject = body.subject || (parent ? reSubject(parent.subject) : '');

  // S2P §G: the Case field is validated BEFORE dispatch — an unknown case is
  // a 400 and nothing leaves (caseLink's own rule, run early).
  let caseRow = null;
  if (body.case_id) {
    const [[cs]] = await db.query(
      'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = ? LIMIT 1', [body.case_id]
    );
    if (!cs) throw httpError(400, `case_id "${body.case_id}" is not a case`);
    caseRow = cs;
  }

  await checkBudget(db, cred, mailbox);

  // ── bodies ──
  const newText = body.body_text != null && body.body_text.trim() ? body.body_text.replace(/\r\n?/g, '\n') : null;
  const newHtml = body.body_html != null && body.body_html.trim() ? body.body_html : null;
  let signature = null;
  if (body.signature) {
    signature = sameAddr(cred.email, mailbox.address) ? signatureOf(cred) : null;
    if (!signature) warnings.push({ code: 'no_signature', message: 'This mailbox has no signature of its own — sent without one.' });
  }
  const bodies = composeBodies({
    text: newText != null ? newText : htmlToText(newHtml),
    html: newHtml != null ? newHtml : textToHtml(newText),
    signature,
    quote: parent && body.quote_original ? quoteOf(parent) : null,
  });

  // ── headers ──
  const domain = String(mailbox.address).split('@').pop().toLowerCase();
  const rfcId = cred.provider === 'smtp' ? `${crypto.randomUUID()}@${domain}` : null;
  const fromName = sameAddr(cred.email, mailbox.address) ? cleanName(cred.from_name) : null;
  const toStr = body.to.map(formatAddr).join(', ');
  const ccStr = body.cc.map(formatAddr).join(', ');
  const bccStr = body.bcc.map(formatAddr).join(', ');

  // Gmail files the reply in the sender's own conversation only with its
  // threadId (and a matching subject + References) — best-effort lookup of
  // the parent's, by the Gmail id the worker stored.
  let threadId = null;
  if (cred.provider === 'gmail' && parent && parent.provider_id && threading
      && bareSubject(subject) === bareSubject(parent.subject)) {
    threadId = await gmailAdapter.lookupThreadId(db, cred.credential_id, parent.provider_id);
  }

  // ── dispatch (the external side effect — nothing before it wrote) ──
  const sentAt = new Date();
  let result;
  try {
    result = await emailService.sendEmailDirect(db, { ...cred, from_name: fromName }, {
      from: mailbox.address,
      to: toStr,
      subject,
      text: bodies.text,
      html: bodies.html,
      ...(ccStr && { cc: ccStr }),
      ...(bccStr && { bcc: bccStr }),
      ...(threading && threading.inReplyTo && { in_reply_to: threading.inReplyTo }),
      ...(threading && { references: threading.references }),
      ...(rfcId && { message_id: `<${rfcId}>` }),
      ...(threadId && { thread_id: threadId }),
    });
  } catch (err) {
    const e = httpError(502, `The message was not sent: ${oneLine(err && err.message).slice(0, 300) || 'the mail provider refused it'}`);
    e.code = 'SEND_FAILED';
    e.expose = true; // the route shows a 5xx message only when told to
    throw e;
  }

  // ── tail: best-effort, never turns a sent message into a failure ──
  // nodemailer RESOLVES when at least one recipient was accepted (smtp adapter
  // header) — the sender must hear about the ones the relay turned away.
  const refused = result && Array.isArray(result.rejected) ? result.rejected.map(x => oneLine(x && x.address ? x.address : x)).filter(Boolean) : [];
  if (refused.length) {
    warnings.push({ code: 'recipients_rejected', message: `Sent, but the mail server refused ${refused.length === 1 ? 'one recipient' : `${refused.length} recipients`}: ${refused.slice(0, MAX_RECIPIENTS).join(', ').slice(0, 400)}.` });
  }
  const providerMessageId = result && result.messageId ? String(result.messageId) : null;
  const source = `outbound-${cred.provider}`;
  let emailLogId = null;
  try { emailLogId = await findLogRow(db, source, providerMessageId); } catch (_) { /* reported as null */ }

  const append = { attempted: false, appended: false, folder: null, reason: null };
  if (cred.provider === 'gmail') {
    append.reason = 'gmail_files_sent';
  } else {
    let conn = null;
    try { conn = await loadConnectionRow(db, mailbox.id); } catch (_) { conn = null; }
    if (!conn || !conn.imap_host || !conn.imap_secret) {
      append.reason = 'no_imap';
      warnings.push({ code: 'append_skipped', message: 'Sent, but no copy was saved to the mailbox\'s Sent folder (it has no IMAP login).' });
    } else {
      append.attempted = true;
      try {
        const raw = await compileMessage({
          from: fromName ? `"${fromName}" <${mailbox.address}>` : mailbox.address,
          to: toStr,
          ...(ccStr && { cc: ccStr }),
          ...(bccStr && { bcc: bccStr }),
          subject,
          text: bodies.text,
          html: bodies.html,
          messageId: `<${rfcId}>`,
          date: sentAt,
          ...(threading && threading.inReplyTo && { inReplyTo: threading.inReplyTo }),
          ...(threading && { references: threading.references }),
        });
        const r = await transport.appendSent(conn, raw);
        Object.assign(append, { appended: r.appended, folder: r.folder, reason: r.reason });
        if (!r.appended) {
          warnings.push({ code: 'append_skipped', message: r.reason === 'no_sent_folder'
            ? 'Sent, but the mailbox has no Sent folder, so no copy was saved there.'
            : 'Sent, but no copy was saved to Sent: YisraCase never writes into a Google mailbox. Give this box its Google sender (Admin → Mailboxes) and Google files what it sends.' });
        }
      } catch (err) {
        append.reason = 'error';
        warnings.push({ code: 'append_failed', message: 'Sent, but saving a copy to the mailbox\'s Sent folder failed — the message itself went out.' });
        console.warn(`[mailSend] mailbox ${mailbox.id}: Sent APPEND failed:`, err && err.code ? err.code : '', err && err.message);
        const day = new Date().toISOString().slice(0, 10);
        sendAlert(db, {
          kind: 'mailbox_send_append_failed',
          group_key: `app:mailbox_send_append_failed:${mailbox.id}`,
          dedup_key: `mailbox_send_append_failed:${mailbox.id}:${day}`,
          severity: 'warning',
          title: `Sent copy not saved: ${mailbox.address}`,
          message: `A comms-hub send went out but its IMAP APPEND to Sent failed: ${oneLine(err && err.message).slice(0, 300)}`,
          context: { mailbox_id: Number(mailbox.id), code: err && err.code ? String(err.code) : null },
          ref_table: 'mailboxes',
          ref_id: Number(mailbox.id),
        });
      }
    }
  }

  const readSeed = { scheduled: false, job_id: null };
  let seedKey = null;
  if (cred.provider === 'gmail' && providerMessageId && GMAIL_ID_RE.test(providerMessageId)) seedKey = { provider_id: providerMessageId };
  else if (append.appended && folderPolled(mailbox, append.folder)) seedKey = { message_id: rfcId };
  if (seedKey) {
    try {
      readSeed.job_id = await scheduleSeed(db, {
        user: Number(userId), mailbox_id: Number(mailbox.id), sent_at: sentAt.toISOString(),
        provider_id: seedKey.provider_id || null, message_id: seedKey.message_id || null,
      });
      readSeed.scheduled = true;
    } catch (err) {
      console.warn(`[mailSend] mailbox ${mailbox.id}: read-state seed not scheduled:`, err && err.message);
    }
  }

  // ── S2P: attribution + the Case field (still the best-effort tail) ──
  // One mail_sends row per successful dispatch (design OQ4). The Case field's
  // link rides it: `caseLink` when a copy of the send will be stored (exactly
  // the seed's condition — a key we can find the copy by), a send-time log
  // row when no copy will EVER be stored (an SMTP send whose APPEND did not
  // land in a polled folder — the worker will never see it, so nothing can
  // collide with the row; §G.3 double-log hazard is the stored-copy case).
  const caseLink = { state: null, job_id: null };
  const sendRow = {
    mailbox_id: Number(mailbox.id),
    user: Number(userId),
    message_id: rfcId,
    provider_id: seedKey && seedKey.provider_id ? seedKey.provider_id : (providerMessageId && GMAIL_ID_RE.test(providerMessageId) ? providerMessageId : null),
    email_log_id: emailLogId,
    case_id: caseRow ? caseRow.case_id : null,
    case_link_state: null,
    case_log_id: null,
    sent_at: sentAt,
  };
  const noCopyEver = cred.provider === 'smtp' && !(append.appended && folderPolled(mailbox, append.folder));
  if (caseRow) {
    if (seedKey) {
      sendRow.case_link_state = 'pending';
    } else if (noCopyEver) {
      try {
        const toList = body.to.map(r => r.email).join(', ');
        let message = bodies.text || '';
        if (message.length > 50_000) message = message.slice(0, 50_000) + '…[truncated]'; // caseLink's LOG_MESSAGE_SOFT_CAP
        const direction = inferDirection(mailbox.address, firmDomains());
        const r = await logService.createLogEntry(db, {
          type: 'email',
          link_type: 'email',
          link_id: body.to[0].email,
          about_type: 'case',
          about_id: caseRow.case_id,
          by: Number(userId),
          data: { From: mailbox.address, To: toList, Subject: subject, Message: message },
          extra: {
            source: 'mailbox-hub-send',
            mailbox_id: Number(mailbox.id),
            email_log_id: emailLogId,
            message_id: rfcId,
          },
          from: mailbox.address,
          to: toList,
          subject,
          message,
          direction,
          // dated now (the send), never the copy's later ingest
        });
        sendRow.case_link_state = 'linked';
        sendRow.case_log_id = Number(r.log_id);
      } catch (err) {
        sendRow.case_link_state = 'failed';
        console.warn(`[mailSend] mailbox ${mailbox.id}: send-time case log failed:`, err && err.message);
      }
    } else {
      // A copy may be stored but no key can ever find it (a Gmail send whose
      // adapter returned no id): a send-time log row risks the §G.3 double
      // log, so this fails loudly instead.
      sendRow.case_link_state = 'failed';
    }
  }
  let sendRowId = null;
  try {
    const [r] = await db.query(
      `INSERT INTO mail_sends (mailbox_id, user, message_id, provider_id, email_log_id, case_id, case_link_state, case_log_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sendRow.mailbox_id, sendRow.user, sendRow.message_id, sendRow.provider_id, sendRow.email_log_id,
        sendRow.case_id, sendRow.case_link_state, sendRow.case_log_id, sendRow.sent_at]
    );
    sendRowId = r && r.insertId ? Number(r.insertId) : null;
  } catch (err) {
    // Never fails the send — the mail went out. ONE alert per send (dedup by
    // the email_log id). Severity follows what was actually lost (review D3):
    // attribution alone is a warning; a case link the sender ASKED for that
    // will now never be made (pending had no row to hang the job on) is an
    // ERROR — a requested log entry is missing, same as the job's give-up.
    // In the no-copy branch the log row was already written at send, so only
    // the attribution is lost there.
    console.warn(`[mailSend] mailbox ${mailbox.id}: mail_sends insert failed:`, err && err.message);
    sendAlert(db, {
      kind: 'mail_send_attribution_failed',
      group_key: `app:mail_send_attribution_failed:${mailbox.id}`,
      dedup_key: `mail_send_attribution_failed:${emailLogId != null ? `log${emailLogId}` : `mid:${rfcId || providerMessageId || 'none'}`}`,
      severity: caseRow && sendRow.case_link_state !== 'linked' ? 'error' : 'warning',
      title: `Send attribution not recorded: ${mailbox.address}`,
      message: `A comms-hub send went out but its mail_sends row could not be written: ${oneLine(err && err.message).slice(0, 300)}.` +
        (caseRow ? (sendRow.case_link_state === 'linked'
          ? ` Its case ${caseRow.case_id} log entry was written at send (log ${sendRow.case_log_id}).`
          : ` The sender asked to link it to case ${caseRow.case_id} — that link was NOT scheduled.`) : ''),
      context: { mailbox_id: Number(mailbox.id), email_log_id: emailLogId, case_id: caseRow ? caseRow.case_id : null },
      ref_table: 'mailboxes',
      ref_id: Number(mailbox.id),
    });
  }
  if (caseRow && sendRowId != null) {
    if (sendRow.case_link_state === 'pending') {
      try {
        caseLink.job_id = await scheduleCaseLink(db, {
          send_id: sendRowId, user: Number(userId), mailbox_id: Number(mailbox.id),
          case_id: caseRow.case_id, sent_at: sentAt.toISOString(),
          provider_id: seedKey.provider_id || null, message_id: seedKey.message_id || null,
        });
      } catch (err) {
        console.warn(`[mailSend] mailbox ${mailbox.id}: case-link job not scheduled:`, err && err.message);
        try { await db.query("UPDATE mail_sends SET case_link_state = 'failed' WHERE id = ?", [sendRowId]); } catch (_) { /* best-effort */ }
        sendRow.case_link_state = 'failed';
      }
    }
    if (sendRow.case_link_state === 'failed') {
      caseLinkFailedAlert(db, {
        sendRowId, mailbox, caseId: caseRow.case_id,
        why: seedKey ? 'the link job could not be scheduled'
          : (noCopyEver ? 'the send-time log entry could not be written'
            : 'the provider returned no message id, so the stored copy can never be found'),
      });
    }
  }
  caseLink.state = sendRow.case_link_state;

  const recipients = body.to.length + body.cc.length + body.bcc.length;
  console.log(`[mailSend] user ${userId} sent as mailbox ${mailbox.id} (${cred.provider}) to ${recipients} recipient(s)` +
    `${parent ? ` replying to message ${parent.id}` : ''}; email_log ${emailLogId ?? 'not found'}`);
  return {
    mailbox_id: Number(mailbox.id),
    from: mailbox.address,
    email_log_id: emailLogId,
    provider_message_id: providerMessageId,
    rfc_message_id: rfcId,
    thread_key: threading ? threading.threadKey : rfcId,
    in_reply_to_message_fk: parent ? Number(parent.id) : null,
    gmail_thread_id: threadId,
    recipients,
    append,
    read_seed: readSeed,
    send_row_id: sendRowId,
    case_link: caseLink,
    warnings,
  };
}

/** ONE error alert when a case link the sender asked for will not happen (dedup per send row). */
function caseLinkFailedAlert(db, { sendRowId, mailbox, caseId, why }) {
  sendAlert(db, {
    kind: 'mail_sent_case_link_failed',
    group_key: `app:mail_sent_case_link_failed:${mailbox.id}`,
    dedup_key: `mail_sent_case_link_failed:${sendRowId}`,
    severity: 'error',
    title: `Sent mail not linked to case ${caseId}`,
    message: `A comms-hub send from ${mailbox.address} was asked onto the log of case ${caseId}, but ${why}. ` +
      'The mail went out; the case log entry is missing — link the stored copy by hand from the hub (Link to case).',
    context: { mailbox_id: Number(mailbox.id), mail_sends_id: sendRowId, case_id: caseId },
    ref_table: 'mail_sends',
    ref_id: sendRowId,
  });
}

async function scheduleCaseLink(db, data) {
  const [r] = await db.query(
    `INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts, backoff_seconds)
     VALUES ('one_time', ?, 'pending', ?, ?, ?, ?)`,
    [
      new Date(Date.now() + LINK_FIRST_DELAY_MS),
      `Mail sent — case link to ${data.case_id} (mail_sends #${data.send_id})`,
      JSON.stringify({ type: LINK_JOB_TYPE, ...data }),
      LINK_MAX_ATTEMPTS,
      LINK_BACKOFF_S,
    ]
  );
  return r && r.insertId ? Number(r.insertId) : null;
}


// ─────────────────────────────────────────────────────────────────────────────
// The deferred read-state seed (lib/job_executor, type 'mail_sent_read_seed')
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark the copies of a hub send READ for its sender. Copies = rows in any
 * mailbox the sender can read NOW carrying the send's Gmail id (within a day
 * of the send; the probe rides idx_mail_messages_mailbox_provider — or the
 * (mailbox_id, date) index, the optimizer's pick) or its Message-ID. None yet
 * → throw (the job retries);
 * on the job's last attempt (`final`) → done quietly instead.
 */
async function seedSentReadState(db, data, { final = false } = {}) {
  const user = Number(data && data.user);
  if (!Number.isInteger(user) || user < 0) return { seeded: 0, skipped: 'no user in the job data' };
  const pid = data.provider_id && GMAIL_ID_RE.test(String(data.provider_id)) ? String(data.provider_id) : null;
  const mid = cleanMid(data.message_id);
  if (!pid && !mid) return { seeded: 0, skipped: 'no message key in the job data' };
  // S3-R: a send AS an alias lands its copy in the PARENT box's rows — probe
  // the parents of readable alias boxes too; markRead (the disjunction) is
  // the grant seat and marks only what the caller's slices actually admit
  // (the copy carries the alias in From, so it does).
  const readable = await mbx.listReadable(db, user, 'mailbox');
  const scope = [...new Set(readable.map(r => Number(r.alias_of != null ? r.alias_of : r.id)))];
  if (!scope.length) return { seeded: 0, skipped: 'the sender can read no mailbox' };

  const ids = new Set();
  if (pid) {
    const t = Date.parse(data.sent_at);
    const since = new Date((Number.isFinite(t) ? t : Date.now()) - 24 * 3600_000);
    const [rows] = await db.query(
      'SELECT id FROM mail_messages WHERE mailbox_id IN (?) AND date >= ? AND provider_id = ?',
      [scope, since, pid]
    );
    for (const r of rows) ids.add(Number(r.id));
  }
  if (mid) {
    const [rows] = await db.query('SELECT id FROM mail_messages WHERE message_id = ? AND mailbox_id IN (?)', [mid, scope]);
    for (const r of rows) ids.add(Number(r.id));
  }
  if (!ids.size) {
    if (final) return { seeded: 0, found: 0, gave_up: true };
    throw new Error('the sent copy is not stored yet — will retry');
  }
  const r = await read.markRead(db, user, { ids: [...ids].slice(0, read.BULK_READ_MAX) });
  return { seeded: r.marked, found: ids.size };
}


// ─────────────────────────────────────────────────────────────────────────────
// The deferred case link (S2P §G — lib/job_executor, type 'mail_sent_case_link')
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Link the stored copy of a hub send to the case its sender asked for. The
 * copy is found the way seedSentReadState finds it (the same keys, the same
 * sender-readable scope with alias parents), then mailReadService.caseLink
 * runs AS THE SENDER — the grant seat is unchanged; this job holds no power a
 * fresh click of "Link to case" would not.
 *
 * Outcomes:
 *   - copy not stored yet, or caseLink 409 (emission pending / store-only
 *     grace)                         → throw: the job retries on its backoff;
 *   - caseLink 403/404 (the sender's grant was revoked between send and run;
 *     the service answers 404 where the spec sketch said 403 — same meaning,
 *     no oracle)                     → FINAL failure, never retried;
 *   - the final attempt without success → case_link_state='failed' + ONE
 *     `error` alert (a log entry the user asked for is missing);
 *   - success → case_link_state='linked' + case_log_id.
 */
async function linkSentCase(db, data, { final = false } = {}) {
  const sendId = Number(data && data.send_id);
  const user = Number(data && data.user);
  if (!Number.isInteger(sendId) || sendId <= 0) return { linked: false, skipped: 'no send row in the job data' };
  const [[row]] = await db.query(
    'SELECT id, mailbox_id, case_id, case_link_state FROM mail_sends WHERE id = ? LIMIT 1', [sendId]
  );
  if (!row) return { linked: false, skipped: 'the mail_sends row is gone' };
  if (row.case_link_state !== 'pending') return { linked: false, skipped: `state is ${row.case_link_state || 'null'} — nothing to do` };

  const giveUp = async (why) => {
    await db.query("UPDATE mail_sends SET case_link_state = 'failed' WHERE id = ?", [sendId]).catch(() => {});
    const [[mb]] = await db.query('SELECT id, address FROM mailboxes WHERE id = ? LIMIT 1', [Number(row.mailbox_id)]).catch(() => [[null]]);
    caseLinkFailedAlert(db, {
      sendRowId: sendId,
      mailbox: mb || { id: Number(row.mailbox_id), address: `mailbox #${row.mailbox_id}` },
      caseId: row.case_id,
      why,
    });
    return { linked: false, gave_up: true, reason: why };
  };

  if (!Number.isInteger(user) || user < 0) return giveUp('the job data names no sender');
  const pid = data.provider_id && GMAIL_ID_RE.test(String(data.provider_id)) ? String(data.provider_id) : null;
  const mid = cleanMid(data.message_id);
  if (!pid && !mid) return giveUp('the job data carries no message key');

  // The seed's probe: sender-readable boxes, alias parents included.
  const readable = await mbx.listReadable(db, user, 'mailbox');
  const scope = [...new Set(readable.map(r => Number(r.alias_of != null ? r.alias_of : r.id)))];
  if (!scope.length) return giveUp('the sender can no longer read any mailbox');

  const ids = new Set();
  if (pid) {
    const t = Date.parse(data.sent_at);
    const since = new Date((Number.isFinite(t) ? t : Date.now()) - 24 * 3600_000);
    const [rows] = await db.query(
      'SELECT id FROM mail_messages WHERE mailbox_id IN (?) AND date >= ? AND provider_id = ?',
      [scope, since, pid]
    );
    for (const r of rows) ids.add(Number(r.id));
  }
  if (mid) {
    const [rows] = await db.query('SELECT id FROM mail_messages WHERE message_id = ? AND mailbox_id IN (?)', [mid, scope]);
    for (const r of rows) ids.add(Number(r.id));
  }
  if (!ids.size) {
    if (final) return giveUp('the sent copy was never stored');
    throw new Error('the sent copy is not stored yet — will retry');
  }
  const copyId = Math.min(...ids); // one copy carries the link; deterministic
  let out;
  try {
    out = await read.caseLink(db, user, copyId, { case_id: row.case_id });
  } catch (err) {
    const status = Number(err && err.status);
    if (status === 403 || status === 404) {
      // final, never retried — the probe already found the copy, so this is
      // revoked access, or the message / case deleted between send and link
      return giveUp('the sender\'s access was revoked — or the message or case is gone — between send and link');
    }
    if (final) return giveUp(`linking kept failing (${oneLine(err && err.message).slice(0, 200)})`);
    throw err; // 409 (emission pending / store-only grace) and transients retry
  }
  await db.query(
    "UPDATE mail_sends SET case_link_state = 'linked', case_log_id = ? WHERE id = ?",
    [Number(out.log_id), sendId]
  );
  return { linked: true, log_id: Number(out.log_id), message_fk: copyId };
}


module.exports = {
  listIdentities,
  replyDefaults,
  sendFromMailbox,
  seedSentReadState,
  linkSentCase,
  // exported for tests
  validateSendBody,
  resolveIdentity,
  threadingFor,
  quoteOf,
  composeBodies,
  reSubject,
  bareSubject,
  parseRecipient,
  formatAddr,
  textToHtml,
  transportOf,
  budgetFor,
  folderPolled,
  compileMessage,
  MAX_RECIPIENTS,
  DEFAULT_DAILY_BUDGET,
  BUDGET_SETTING,
  SEND_PROVIDERS,
  SEED_JOB_TYPE,
  SEED_MAX_ATTEMPTS,
  SEED_BACKOFF_S,
  SEED_FIRST_DELAY_MS,
  LINK_JOB_TYPE,
  LINK_MAX_ATTEMPTS,
  LINK_BACKOFF_S,
  LINK_FIRST_DELAY_MS,
  REASON_TEXT,
};
