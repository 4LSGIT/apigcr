// services/issueReportService.js
//
/**
 * Replies to Help & Support reports — the "Respond to sender" side of the
 * Support Inbox (routes/api.issueReports.js; manual 05-Subsystems/09).
 *
 *   OUTCOMES                       per report kind: what a reply can say
 *   outcomesFor(kind)              that list, client-shaped (labels + texts)
 *   buildReplyEmail({...})         the email the reporter gets
 *   respond(db, {id, outcome, message, resolve, by})
 *
 * ONE REPLY = generic text for the outcome + the admin's optional message +
 * the reporter's own note quoted back. Sent FROM the email_it setting
 * (it@4lsg.com, a sending credential) so the reporter can simply hit reply.
 * The public emailService.sendEmail has no reply_to, which is why the sender
 * is IT rather than automations@.
 *
 * RESPOND ORDER — claim, send, settle:
 *   1. read the row (kind, reporter, note);
 *   2. CLAIM: one guarded UPDATE stamps reply_claimed_at and NOTHING else. It
 *      refuses while another send holds the claim (a send can take minutes —
 *      nodemailer's default socket timeout is 10 min — so a time window alone
 *      cannot cover it) and within REPLY_DEBOUNCE_S of the last reply that went
 *      out (the email's deep link opened twice). A claim older than
 *      CLAIM_STALE_MIN is taken to be abandoned (an instance that died
 *      mid-send) and may be taken over;
 *   3. send;
 *   4. SETTLE, guarded on THIS claim's stamp (a call whose claim was taken
 *      over writes nothing):
 *        success → resolution, reply_message, replied_at, reply_error NULL,
 *                  and the resolve when asked; claim cleared;
 *        failure → reply_error only; claim cleared.
 *      Nothing is written before the send and nothing is rolled back after
 *      it: a failed follow-up leaves the earlier reply's record standing, and
 *      a resolve asked for with a failed reply is simply not applied — nor is
 *      anyone else's resolve undone.
 *
 * A reply is allowed on a resolved report too (a follow-up, or a retry after
 * a failed send); `resolve` never moves resolved_at/resolved_by of a report
 * that was already resolved.
 */

'use strict';

const { cfg } = require('../lib/firmConfig');
const emailService = require('./emailService');
const { FIRM_TZ } = require('./timezoneService');

const MESSAGE_MAX = 2000;
const REPLY_DEBOUNCE_S = 30;
const CLAIM_STALE_MIN = 15;     // > nodemailer's 2 min connect + 10 min socket defaults

const KIND_LABEL = { problem: 'problem report', idea: 'idea', question: 'question', casey: 'Casey report' };   // casey: Casey v2 S4b — a flagged Casey answer

// Per kind, in display order. `text` is the generic part of the reply; an
// outcome with needsMessage has none worth sending alone, so the admin's
// message is required. Keys are stored in issue_reports.resolution (≤24 chars,
// app-validated against THIS table for the row's kind).
const OUTCOMES = Object.freeze({
  problem: Object.freeze([
    { key: 'fixed', label: 'Fixed',
      text: "Thanks for reporting this — it's fixed. Reload the page to pick up the fix; if you still see it after that, reply to this email." },
    { key: 'cant_reproduce', label: "Can't reproduce",
      text: "Thanks for reporting this. We tried, and couldn't make it happen. If it comes back, send another report from the screen where it happens — that captures what we need to track it down." },
    { key: 'by_design', label: 'Working as designed',
      text: 'Thanks for reporting this. We looked into it, and this is how it is designed to work.' },
    { key: 'already_done', label: 'Already implemented',
      text: 'Thanks for reporting this — it had already been taken care of by the time your report reached us. Reload the page if you still see it.' },
    { key: 'other', label: 'Other', needsMessage: true, text: '' },
  ]),
  idea: Object.freeze([
    { key: 'done', label: 'Done',
      text: "Thanks for the idea — it's been built and it's live now. Reload the page to get it." },
    { key: 'planned', label: 'Added to the list',
      text: "Thanks for the idea — it's on the list. You'll hear back when it's built." },
    { key: 'already_done', label: 'Already implemented',
      text: 'Thanks for the idea — good news: YisraCase already does this.' },
    { key: 'wont_do', label: "Won't do",
      text: "Thanks for the idea. We've thought it over and decided not to build this one." },
    { key: 'other', label: 'Other', needsMessage: true, text: '' },
  ]),
  question: Object.freeze([
    { key: 'answered', label: 'Answered', needsMessage: true, text: '' },
  ]),
  // Casey v2 S4b: a Casey answer flagged for review (by the user, or by Casey
  // itself). The reviewer reads the chat in Admin → Casey Chats; the fix is
  // usually a Casey Note, sometimes code.
  casey: Object.freeze([
    { key: 'noted', label: 'Fixed with a Casey Note',
      text: 'Thanks for flagging that Casey answer. Casey has been given a note about it, so it should handle this right from now on.' },
    { key: 'fixed', label: 'Fixed in the app',
      text: "Thanks for flagging that Casey answer. The cause was on the app's side and it is fixed; ask Casey again and it should go right." },
    { key: 'by_design', label: 'Casey was right',
      text: 'Thanks for flagging that Casey answer. We read the chat: Casey answered as it should have. If something still looks wrong, reply to this email with what you expected.' },
    { key: 'other', label: 'Other', needsMessage: true, text: '' },
  ]),
});

function outcomesFor(kind) {
  return (OUTCOMES[kind] || []).map((o) => ({
    key: o.key, label: o.label, text: o.text, needs_message: !!o.needsMessage,
  }));
}

function findOutcome(kind, key) {
  return (OUTCOMES[kind] || []).find((o) => o.key === key) || null;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br>');

function clamp(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** The reporter's email. Pure — respond() feeds it a row. */
function buildReplyEmail({ id, kind, note, createdAt, outcome, message, firstName }) {
  const kindLabel = KIND_LABEL[kind] || 'report';
  const filed = createdAt ? new Date(createdAt) : null;
  const filedStr = filed && !isNaN(filed)
    ? filed.toLocaleDateString('en-US', { timeZone: FIRM_TZ, month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  const greet = firstName ? `Hi ${firstName},` : 'Hi,';
  const msg = message ? String(message).trim() : '';

  const subject = `Re: your ${kindLabel} #${Number(id)} — ${outcome.label}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;color:#111827;font-size:14px;line-height:1.55">
      <p style="margin:0 0 12px">${esc(greet)}</p>
      ${outcome.text ? `<p style="margin:0 0 12px">${esc(outcome.text)}</p>` : ''}
      ${msg ? `<p style="margin:0 0 12px">${nl2br(msg)}</p>` : ''}
      <div style="margin:18px 0 0;padding:10px 14px;background:#f9fafb;border-left:3px solid #d1d5db;border-radius:4px;color:#4b5563">
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px">Your ${esc(kindLabel)} #${Number(id)}${filedStr ? ` from ${esc(filedStr)}` : ''}:</div>
        <div style="white-space:pre-wrap;word-break:break-word">${esc(note)}</div>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#9ca3af">Sent from the YisraCase Support Inbox. Reply to this email to answer.</p>
    </div>`;

  const quoted = String(note ?? '').split(/\r?\n/).map((l) => `> ${l}`).join('\n');
  const text = [
    greet,
    '',
    ...(outcome.text ? [outcome.text, ''] : []),
    ...(msg ? [msg, ''] : []),
    `Your ${kindLabel} #${Number(id)}${filedStr ? ` from ${filedStr}` : ''}:`,
    quoted,
    '',
    'Sent from the YisraCase Support Inbox. Reply to this email to answer.',
  ].join('\n');

  return { subject, html, text };
}

function fail(status, error) {
  const e = new Error(error);
  e.status = status;
  return e;
}

/**
 * Reply to a report's filer, optionally resolving it.
 * Throws an Error with .status (400/404/409/422) for a request that cannot
 * proceed; resolves { ok, resolved, to | reply_error } once a claim was made.
 */
async function respond(db, { id, outcome: outcomeKey, message, resolve, by }) {
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid <= 0) throw fail(400, 'bad id');

  const [[row]] = await db.query(
    `SELECT r.id, r.kind, r.note, r.user_id, r.created_at,
            u.email AS user_email, u.user_fname AS user_fname
       FROM issue_reports r
       LEFT JOIN users u ON u.user = r.user_id
      WHERE r.id = ? LIMIT 1`, [rid]);
  if (!row) throw fail(404, 'Not found');

  const outcome = findOutcome(row.kind, outcomeKey);
  if (!outcome) throw fail(400, `outcome must be one of: ${(OUTCOMES[row.kind] || []).map((o) => o.key).join(', ')}`);

  const msg = typeof message === 'string' ? message.trim() : '';
  if (msg.length > MESSAGE_MAX) throw fail(400, `message is over ${MESSAGE_MAX} characters`);
  if (outcome.needsMessage && !msg) throw fail(400, `"${outcome.label}" needs a message`);

  const to = row.user_email && String(row.user_email).trim();
  if (!to) throw fail(422, 'The person who filed this has no email address on file');

  const from = cfg('email_it');
  if (!from) throw fail(422, 'No email_it setting configured to send from');

  const doResolve = resolve === true;
  const who = clamp(by || 'admin', 64);

  // CLAIM — this call's own stamp (whole seconds: the column is DATETIME), so
  // the settle can tell its claim from a later one that took it over.
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  const [claim] = await db.query(
    `UPDATE issue_reports SET reply_claimed_at = ?
      WHERE id = ?
        AND (reply_claimed_at IS NULL OR reply_claimed_at < NOW() - INTERVAL ${CLAIM_STALE_MIN} MINUTE)
        AND (replied_at IS NULL OR replied_at < NOW() - INTERVAL ${REPLY_DEBOUNCE_S} SECOND)`,
    [stamp, rid]);
  if (!claim.affectedRows) throw fail(409, 'A reply to this report is being sent, or went out seconds ago — not sending another.');

  const firstName = row.user_fname ? String(row.user_fname).trim().split(/\s+/)[0] : null;
  const mail = buildReplyEmail({
    id: rid, kind: row.kind, note: row.note, createdAt: row.created_at,
    outcome, message: msg, firstName,
  });

  let sendErr = null;
  try {
    await emailService.sendEmail(db, { from, to, ...mail });
  } catch (e) {
    sendErr = clamp(e && e.message ? e.message : String(e), 255);
    console.error(`[issue-reports] reply to #${rid} failed:`, sendErr);
  }

  // SETTLE. resolved_by is assigned BEFORE resolved_at: MySQL evaluates SET
  // left to right, so the IF must still see the old resolved_at.
  const settle = sendErr == null
    ? db.query(
      `UPDATE issue_reports
          SET resolution = ?, reply_message = ?, replied_at = NOW(), reply_error = NULL, reply_claimed_at = NULL
              ${doResolve ? ', resolved_by = IF(resolved_at IS NULL, ?, resolved_by), resolved_at = IFNULL(resolved_at, NOW())' : ''}
        WHERE id = ? AND reply_claimed_at = ?`,
      doResolve ? [outcome.key, msg || null, who, rid, stamp] : [outcome.key, msg || null, rid, stamp])
    : db.query(
      'UPDATE issue_reports SET reply_error = ?, reply_claimed_at = NULL WHERE id = ? AND reply_claimed_at = ?',
      [sendErr, rid, stamp]);
  try {
    const [st] = await settle;
    if (!st.affectedRows) console.error(`[issue-reports] reply to #${rid}: claim ${stamp.toISOString()} was taken over before it settled — nothing recorded`);
  } catch (e) {
    console.error(`[issue-reports] reply to #${rid}: settle failed:`, e.message);
  }

  // The row as it really is now (a bulk resolve may have landed meanwhile).
  // Never let this read turn a reply that WENT OUT into an error: the pane
  // would say "Not sent" and a retry would email the filer twice.
  let resolved = doResolve;
  try {
    const [[now]] = await db.query('SELECT resolved_at FROM issue_reports WHERE id = ?', [rid]);
    if (now) resolved = !!now.resolved_at;
  } catch (e) {
    console.error(`[issue-reports] reply to #${rid}: status read-back failed:`, e.message);
  }
  return sendErr == null ? { ok: true, resolved, to } : { ok: false, resolved, reply_error: sendErr };
}

module.exports = {
  OUTCOMES, MESSAGE_MAX, REPLY_DEBOUNCE_S, CLAIM_STALE_MIN,
  outcomesFor, findOutcome, buildReplyEmail, respond,
};
