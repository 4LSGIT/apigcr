// services/mailbox/mailboxScheduledSendService.js
//
/**
 * Scheduled sends from the comms hub — hub-send extras, 2026-11-16. HTTP
 * layer: routes/api.mail.js (POST /api/mail/send/schedule, GET /api/mail/send
 * /scheduled, DELETE /api/mail/send/scheduled/:id). The send itself is
 * mailboxSendService.sendFromMailbox, run later by lib/job_executor
 * ('mail_scheduled_send' → runScheduledSend). No new table: ONE
 * `scheduled_jobs` row per scheduled send (type 'one_time', max_attempts 1).
 *
 *   parseSendAt(v, now)                      ISO-8601 WITH a zone → Date, inside
 *                                            the window [MIN_AHEAD_MS, MAX_AHEAD_MS]
 *   scheduleSend(db, userId, body, opts)     every pre-dispatch check the send
 *                                            runs, in its order, then the row
 *   listScheduled(db, userId)                the CALLER's rows (own only — SU too)
 *   cancelScheduled(db, userId, id)          ONE conditional UPDATE (pending only)
 *   runScheduledSend(db, job)                the executor: the send behind the
 *                                            idempotency fence, the outcome on the row
 *
 * ── WHAT IS CHECKED AT SCHEDULING, WHAT AT SEND TIME ─────────────────────────
 * The route runs the SU step-up (the schedule IS the write), validateSendBody
 * (attachments included — the documents must exist NOW), the opt-out gate
 * (409 until acknowledged; the acknowledgement is stored with the job so the
 * send never asks again — the gate lives in the route, not in
 * sendFromMailbox) and the per-user limiter; scheduleSend then runs
 * resolveIdentity (grant + sendable box), loadParent (a reply's parent) and
 * loadCase, and loadAttachments (active, size known, caps). NOT the daily
 * budget — that is send-time. At send time sendFromMailbox re-runs EVERY
 * check of its own (grant, box, parent, case, documents, budget), so nothing
 * bypasses the seat because a job runs it: a grant revoked between
 * scheduling and sending fails the send.
 *
 * ── THE DOUBLE-SEND FENCE ────────────────────────────────────────────────────
 * routes/process_jobs.js recoverStuckJobs puts a 'running' row older than 15
 * minutes back to 'pending' and re-runs it; an instance that died between the
 * provider call and the completed-mark would therefore send twice. So the
 * dispatch runs inside lib/requestIdempotency.withIdempotency — pool, scope
 * 'mail.send' (the hub send's own scope), key `scheduled:<job id>`,
 * releaseOnRefusalOnly — the same fence the interactive route uses: a re-run
 * REPLAYS an applied send (outcome 'sent', replayed: true) or STOPS on an
 * in_flight / unknown claim (outcome 'unknown', nothing dispatched), never
 * dispatches again. A pre-dispatch 4xx releases the claim, and the job fails
 * anyway (max_attempts 1), so the key is never reused.
 *
 * ── OUTCOMES (data.outcome, JSON_SET on the row) ─────────────────────────────
 *   sent     {state, at, replayed, send_row_id, email_log_id, provider_message_id}
 *            → the handler returns, process_jobs marks the job completed.
 *   failed   {state, at, status, code, message} — a refusal (grant revoked,
 *            box unsendable, a document deleted since, case gone, budget 429)
 *            or a 502 → recorded, then THROWN so process_jobs marks the job
 *            failed; max_attempts 1 means no automatic second attempt at a
 *            client email.
 *   unknown  the fence's in_flight / unknown → recorded, thrown, never re-run.
 * On failed and unknown the SENDER hears twice: an email to their own
 * users.email (the task reminders' path — users.email + taskService.getFromEmail
 * + emailService.sendEmail, fire-and-forget) and ONE `error` system alert
 * (dedup per job id) so IT hears too. A client email that silently did not go
 * out is the failure this feature must never have.
 *
 * NO MODULE-SCOPE STATE: every call reads the DB.
 */

'use strict';

const S = require('./mailboxSendService');
const mbx = require('../mailboxService');
const { withIdempotency, releaseOnRefusalOnly } = require('../../lib/requestIdempotency');
const { utcToLocal } = require('../timezoneService');

const { httpError } = mbx;

const JOB_TYPE = 'mail_scheduled_send';
const MIN_AHEAD_MS = 2 * 60_000;              // at least 2 minutes from now
const MAX_AHEAD_MS = 30 * 24 * 3600_000;      // at most 30 days out
const HISTORY_DAYS = 7;                       // finished rows the list still shows
const IDEMPOTENCY_SCOPE = 'mail.send';        // the hub send's scope — key scheduled:<job id>
const JOB_BACKOFF_S = 300;                    // the column's default; irrelevant at max_attempts 1
// ISO-8601 with an explicit zone — Z or ±hh:mm. A naive time ("…T09:30") is
// refused: the client converts the firm-local pick to an instant itself.
const SEND_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The caller's own scheduled sends: the two JSON predicates (type and user). */
const OWN_WHERE = "type = 'one_time' AND JSON_EXTRACT(data, '$.type') = ? AND JSON_EXTRACT(data, '$.user') = ?";
const SQL = {
  insert:
    "INSERT INTO scheduled_jobs (type, scheduled_time, status, name, data, max_attempts, backoff_seconds) VALUES ('one_time', ?, 'pending', ?, ?, ?, ?)",
  // Pending / running ones, plus anything finished (completed / failed /
  // cancelled — process_jobs and the cancel below bump updated_at) within
  // HISTORY_DAYS. A scan of scheduled_jobs (no index serves a JSON predicate
  // under an OR); the table is small (hundreds of rows live), accepted.
  list:
    `SELECT id, status, scheduled_time, data, created_at, updated_at FROM scheduled_jobs WHERE ${OWN_WHERE}` +
    " AND (status IN ('pending', 'running') OR updated_at >= NOW() - INTERVAL ? DAY) ORDER BY scheduled_time ASC, id ASC",
  cancel:
    `UPDATE scheduled_jobs SET status = 'cancelled', active = 0, updated_at = NOW() WHERE id = ? AND status = 'pending' AND ${OWN_WHERE}`,
  peek:
    `SELECT status FROM scheduled_jobs WHERE id = ? AND ${OWN_WHERE} LIMIT 1`,
  outcome:
    "UPDATE scheduled_jobs SET data = JSON_SET(data, '$.outcome', CAST(? AS JSON)) WHERE id = ?",
  mailboxes: 'SELECT id, address FROM mailboxes WHERE id IN (?)',
  documents: 'SELECT id, name, status FROM documents WHERE id IN (?)',
  senderEmail: 'SELECT email FROM users WHERE user = ? LIMIT 1',
};

const CANCEL_TEXT = Object.freeze({
  running: 'This send is going out right now — it may already have gone. Check the mailbox\'s Sent folder.',
  completed: 'This send has already gone out.',
  failed: 'This send already failed — there is nothing to cancel.',
  cancelled: 'This send was already cancelled.',
});

const oneLine = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parseJson = (v) => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } };
const toIso = (d) => { if (d == null) return null; const x = d instanceof Date ? d : new Date(d); return Number.isNaN(x.getTime()) ? null : x.toISOString(); };

function toId(v, label) {
  const s = typeof v === 'number' ? String(v) : String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0 || !Number.isSafeInteger(Number(s))) throw httpError(400, `${label} must be a positive integer`);
  return Number(s);
}

/** send_at → a Date inside the window, or 400. `now` (ms) is injectable for tests. */
function parseSendAt(v, now = Date.now()) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || !SEND_AT_RE.test(s)) throw httpError(400, 'send_at must be an ISO-8601 time with its zone (…Z or ±hh:mm)');
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw httpError(400, 'send_at is not a valid time');
  if (t < now + MIN_AHEAD_MS) throw httpError(400, `send_at must be at least ${MIN_AHEAD_MS / 60_000} minutes from now`);
  if (t > now + MAX_AHEAD_MS) throw httpError(400, `send_at must be within ${MAX_AHEAD_MS / 86_400_000} days`);
  return new Date(t);
}

/**
 * The send's own pre-dispatch checks, in the send's order, without the budget
 * (header): body → identity → parent → case → documents. → the VALIDATED
 * body (what the job stores — never the raw request) + the rows.
 */
async function prepare(db, userId, bodyIn) {
  const body = S.validateSendBody(bodyIn);
  const { mailbox } = await S.resolveIdentity(db, userId, body.mailbox_id);
  if (body.in_reply_to_message_fk) await S.loadParent(db, userId, body.in_reply_to_message_fk, 'in_reply_to_message_fk');
  if (body.case_id) await S.loadCase(db, body.case_id);
  const attachments = await S.loadAttachments(db, body.attachments);
  return { body, mailbox, attachments };
}

/**
 * Schedule one send AS mailbox body.mailbox_id at `sendAt` (a Date from
 * parseSendAt). → {job_id, send_at, mailbox_id, from, recipients, attachments}.
 */
async function scheduleSend(db, userId, bodyIn, { sendAt, acknowledgedOptout = false, now = new Date() } = {}) {
  if (!(sendAt instanceof Date) || Number.isNaN(sendAt.getTime())) throw new TypeError('scheduleSend: sendAt must be a Date');
  const uid = toId(userId, 'user');
  const { body, mailbox, attachments } = await prepare(db, uid, bodyIn);
  const data = {
    type: JOB_TYPE,
    user: uid,
    mailbox_id: Number(mailbox.id),
    body,
    acknowledged_optout: !!acknowledgedOptout,
    requested_at: now.toISOString(),
  };
  const [r] = await db.query(SQL.insert, [
    sendAt,
    `Mail scheduled send — user #${uid} (mailbox #${mailbox.id})`,
    JSON.stringify(data),
    1,
    JOB_BACKOFF_S,
  ]);
  return {
    job_id: Number(r.insertId),
    send_at: sendAt.toISOString(),
    mailbox_id: Number(mailbox.id),
    from: mailbox.address,
    recipients: body.to.length + body.cc.length + body.bcc.length,
    attachments: attachments.map(a => ({ document_id: a.document_id, name: a.name, size: a.size })),
  };
}

/** A list row for the pane: never the bodies. */
function shapeRow(row, mailboxes, docs) {
  const data = parseJson(row.data) || {};
  const b = data.body || {};
  const addr = (list) => (Array.isArray(list) ? list : []).map(r => ({ email: r.email, name: r.name || null }));
  const ids = Array.isArray(b.attachments) ? b.attachments.map(Number) : [];
  return {
    id: Number(row.id),
    send_at: toIso(row.scheduled_time),
    status: row.status,
    outcome: data.outcome || null,
    mailbox: { id: Number(data.mailbox_id), address: mailboxes.get(Number(data.mailbox_id)) || null },
    to: addr(b.to),
    cc: addr(b.cc),
    bcc: addr(b.bcc),
    subject: b.subject || '',
    in_reply_to_message_fk: b.in_reply_to_message_fk == null ? null : Number(b.in_reply_to_message_fk),
    case_id: b.case_id || null,
    // names resolved NOW; a document deleted since is marked (status), never dropped
    attachments: ids.map((id) => {
      const d = docs.get(id);
      return { document_id: id, name: d ? d.name : null, status: d ? d.status : 'missing' };
    }),
    acknowledged_optout: !!data.acknowledged_optout,
    created_at: toIso(row.created_at),
  };
}

/**
 * The CALLER's scheduled sends — own only, an SU included (the rows name
 * their user; nobody browses another person's drafts-to-be): pending and
 * running ones, plus those finished within HISTORY_DAYS.
 */
async function listScheduled(db, userId) {
  const uid = toId(userId, 'user');
  const [rows] = await db.query(SQL.list, [JOB_TYPE, uid, HISTORY_DAYS]);
  const mailboxIds = new Set();
  const docIds = new Set();
  for (const r of rows) {
    const data = parseJson(r.data) || {};
    if (data.mailbox_id != null) mailboxIds.add(Number(data.mailbox_id));
    for (const id of ((data.body && data.body.attachments) || [])) docIds.add(Number(id));
  }
  const mailboxes = new Map();
  if (mailboxIds.size) {
    const [mb] = await db.query(SQL.mailboxes, [[...mailboxIds]]);
    for (const m of mb) mailboxes.set(Number(m.id), m.address);
  }
  const docs = new Map();
  if (docIds.size) {
    const [ds] = await db.query(SQL.documents, [[...docIds]]);
    for (const d of ds) docs.set(Number(d.id), { name: d.name, status: d.status });
  }
  return { scheduled: rows.map(r => shapeRow(r, mailboxes, docs)) };
}

/**
 * Cancel a PENDING scheduled send of the caller's: one conditional UPDATE.
 * 0 rows → re-read: not theirs / not a scheduled send → 404; running,
 * completed, failed or cancelled → 409 saying which (a running one may be
 * mid-dispatch — the text says it may already have gone).
 */
async function cancelScheduled(db, userId, idIn) {
  const uid = toId(userId, 'user');
  const id = toId(idIn, 'id');
  const [r] = await db.query(SQL.cancel, [id, JOB_TYPE, uid]);
  if (r && Number(r.affectedRows) === 1) return { id, status: 'cancelled' };
  const [[row]] = await db.query(SQL.peek, [id, JOB_TYPE, uid]);
  if (!row) throw httpError(404, 'Scheduled send not found');
  const err = httpError(409, CANCEL_TEXT[row.status] || `This scheduled send is ${row.status} and cannot be cancelled.`);
  err.code = `already_${row.status}`;
  throw err;
}


// ─────────────────────────────────────────────────────────────────────────────
// The executor (lib/job_executor, type 'mail_scheduled_send')
// ─────────────────────────────────────────────────────────────────────────────

async function recordOutcome(db, jobId, outcome) {
  await db.query(SQL.outcome, [JSON.stringify(outcome), jobId]);
}

function sendAlert(db, o) {
  try {
    const { alert } = require('../../lib/alerting'); // deferred — circular-dep convention
    return Promise.resolve(alert(db, { source: 'app', ...o })).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

/** The firm-local wording of an instant, for the sender's email. */
function firmWhen(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const l = utcToLocal(d);
  return l && l.isValid ? l.toFormat("ccc, LLL d, yyyy 'at' h:mm a") : d.toISOString();
}

/**
 * Tell the sender (their own users.email — the task reminders' path) and IT
 * (ONE error alert per job) that a scheduled send did not go out — or, for
 * `unknown`, may not have.
 */
async function tellSender(db, { job, data, outcome }) {
  const b = data.body || {};
  const user = Number(data.user);
  const unknown = outcome.state === 'unknown';
  const subject = b.subject || (b.in_reply_to_message_fk ? '(a reply)' : '(no subject)');
  const toCount = ['to', 'cc', 'bcc'].reduce((n, k) => n + (Array.isArray(b[k]) ? b[k].length : 0), 0);
  const [[mb]] = await db.query(SQL.mailboxes, [[Number(data.mailbox_id)]]).catch(() => [[null]]);
  const from = mb && mb.address ? mb.address : `mailbox #${data.mailbox_id}`;
  const when = firmWhen(job.scheduled_time);
  const why = unknown
    ? 'An earlier attempt did not finish and its outcome is unknown — the message MAY have been sent. Check the mailbox\'s Sent folder before sending it again.'
    : `It was refused at send time: ${outcome.message || 'no detail'}`;

  // IT: never the addresses or the subject — counts and the reason.
  await sendAlert(db, {
    kind: 'mail_scheduled_send_failed',
    group_key: `app:mail_scheduled_send_failed:${Number(data.mailbox_id)}`,
    dedup_key: `mail_scheduled_send_failed:${job.id}`,
    severity: 'error',
    title: unknown ? `Scheduled send may not have gone out: ${from}` : `Scheduled send was NOT sent: ${from}`,
    message: `A comms-hub send scheduled by user #${user} from ${from} for ${when} (${toCount} recipient${toCount === 1 ? '' : 's'}, ` +
      `scheduled_jobs #${job.id}) ${unknown ? 'has an unknown outcome' : 'did not go out'}. ${why} The sender has been emailed.`,
    context: { job_id: Number(job.id), user, mailbox_id: Number(data.mailbox_id), recipients: toCount, state: outcome.state, status: outcome.status || null, code: outcome.code || null },
    ref_table: 'scheduled_jobs',
    ref_id: Number(job.id),
  });

  // The sender: their own address, the task reminders' sender, fire-and-forget.
  (async () => {
    const [[u]] = await db.query(SQL.senderEmail, [user]);
    if (!u || !u.email) { console.warn(`[mailSchedule] job ${job.id}: user ${user} has no email — not notified`); return; }
    const taskService = require('../taskService'); // lazy (convention): its load pulls the settings path in
    const emailService = require('../emailService');
    const toList = ['to', 'cc', 'bcc'].flatMap(k => (Array.isArray(b[k]) ? b[k] : []).map(r => r.email)).join(', ');
    const html = `<p>${unknown ? 'A scheduled email <b>may not have gone out</b>' : 'A scheduled email was <b>not sent</b>'}.</p>` +
      `<p><b>From:</b> ${esc(from)}<br><b>To:</b> ${esc(toList)}<br><b>Subject:</b> ${esc(subject)}<br><b>Scheduled for:</b> ${esc(when)}</p>` +
      `<p>${esc(why)}</p>` +
      '<p>Nothing is retried automatically. Open Comms → Scheduled to see it, and send it again by hand when the problem is fixed.</p>';
    await emailService.sendEmail(db, {
      from: await taskService.getFromEmail(db),
      to: u.email,
      subject: unknown ? `Scheduled email may not have gone out: ${subject}` : `Scheduled email was NOT sent: ${subject}`,
      html,
    });
  })().catch(err => console.error(`[mailSchedule] job ${job.id}: sender notice failed:`, err && err.message));
}

/**
 * Run one scheduled send (header: THE DOUBLE-SEND FENCE, OUTCOMES). Returns
 * the outcome on success; records and THROWS on failure / unknown.
 */
async function runScheduledSend(db, job) {
  const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;
  if (!data || data.type !== JOB_TYPE) throw new Error('mail_scheduled_send: not a scheduled-send job');
  const user = Number(data.user);
  const mailboxId = Number(data.mailbox_id);
  if (!Number.isInteger(user) || user <= 0 || !Number.isInteger(mailboxId) || mailboxId <= 0) {
    throw new Error('mail_scheduled_send: the job data names no user / mailbox');
  }
  let r;
  try {
    r = await withIdempotency(db, { userId: user, scope: IDEMPOTENCY_SCOPE, key: `scheduled:${job.id}` },
      () => S.sendFromMailbox(db, user, mailboxId, data.body), { releaseOnError: releaseOnRefusalOnly });
  } catch (err) {
    const at = new Date().toISOString();
    const outcome = err && err.idempotency
      ? { state: 'unknown', at, outcome: err.idempotency.outcome, message: oneLine(err.message).slice(0, 300) }
      : {
        state: 'failed', at,
        status: Number.isInteger(err && err.status) ? err.status : 500,
        code: err && err.code ? String(err.code) : null,
        message: oneLine(err && err.message).slice(0, 300) || 'the send failed with no message',
      };
    try { await recordOutcome(db, job.id, outcome); } catch (e) { console.error(`[mailSchedule] job ${job.id}: outcome not recorded:`, e && e.message); }
    try { await tellSender(db, { job, data, outcome }); } catch (e) { console.error(`[mailSchedule] job ${job.id}: notice failed:`, e && e.message); }
    throw err; // process_jobs marks the job failed (max_attempts 1 — no retry)
  }
  const v = (r && r.value) || {};
  const outcome = {
    state: 'sent',
    at: new Date().toISOString(),
    replayed: !!(r && r.replayed),
    send_row_id: v.send_row_id ?? null,
    email_log_id: v.email_log_id ?? null,
    provider_message_id: v.provider_message_id ?? null,
  };
  // The mail went out: a bookkeeping failure never turns it into a failed job.
  try { await recordOutcome(db, job.id, outcome); } catch (e) { console.error(`[mailSchedule] job ${job.id}: outcome not recorded:`, e && e.message); }
  return outcome;
}

module.exports = {
  parseSendAt,
  scheduleSend,
  listScheduled,
  cancelScheduled,
  runScheduledSend,
  JOB_TYPE,
  MIN_AHEAD_MS,
  MAX_AHEAD_MS,
  HISTORY_DAYS,
  IDEMPOTENCY_SCOPE,
  CANCEL_TEXT,
  SQL,
};
