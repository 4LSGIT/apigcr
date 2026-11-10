// services/emailAttachmentDigestService.js
//
/**
 * BURST DIGEST — one staff notice per burst of emails from one sender
 * (ref/EMAIL_ATTACHMENTS_DESIGN.md §8). Backs `email_attachments_digest` and
 * the burst form of `email_attachments_refile`.
 *
 * THE PROBLEM (live 2026-11-08): a client emailed docs@ 26 times in 43
 * minutes, one phone photo at a time; SB got 26 notices and, for the ones
 * that went unsorted, 26 pick-the-case emails. The files themselves must still
 * be filed at once — only the NOTICE waits.
 *
 * ── THE RULE (Fred, 2026-11-09) ─────────────────────────────────────────────
 * A burst = the sender's emails whose notice has not gone out yet. It ends
 *   - when the sender has been QUIET for `quietMs` (5 min) — no newer email,
 *     measured on mail_messages.ingested_at (when the worker stored it, not
 *     the sender's Date header) — or
 *   - `capMs` (30 min) after its oldest email, whatever is still arriving.
 * Then ONE notice covers every email of the burst (a burst of one gets the
 * single-email notice, unchanged), and ONE pick-the-case decision moves all of
 * its unsorted files.
 *
 * ── HOW (no scheduler of its own) ───────────────────────────────────────────
 *   enqueue  email_attachments_file with digest_key: a placeholder row before
 *            the files are filed (result NULL — "an email is arriving"), then
 *            record() writes the result. A placeholder holds the burst open
 *            (it counts as the newest email) for STALE_PLACEHOLDER_MIN at most
 *            — a filing step that died must not hold a sender's notices.
 *   check    every email's own workflow calls check() after filing, and loops
 *            (wait_for {{digest.wait}} → check again) while it says 'wait':
 *              its row already in a notice      → 'done' (or, when its OWN
 *                                                  claim — a retried step —
 *                                                  'send' the same burst again)
 *              cap reached, or quiet since the
 *              newest pending email             → claim every pending row
 *                                                  with a result → 'send'
 *              otherwise                        → 'wait' until the sooner of
 *                                                  quiet / cap (≥ MIN_WAIT_MS)
 *            So the newest email's workflow normally sends; the others wake
 *            when the burst should end and find themselves in its notice. If
 *            the newest one's workflow died, the next to wake sends instead —
 *            no burst depends on one execution surviving.
 *   claim    one transaction: the sender's pending rows are locked FOR UPDATE
 *            in ONE statement (index order, so two checks cannot deadlock),
 *            then notified_at + digest_of = the claiming email. Rows sharing
 *            digest_of are the burst; refileDigest moves its unsorted files.
 *
 * All time arithmetic is in SQL on UTC_TIMESTAMP() against UTC columns — the
 * app servers' clocks and the session time zone never enter it.
 */

'use strict';

const QUIET_DEFAULT_MS = 5 * 60_000;
const CAP_DEFAULT_MS = 30 * 60_000;
/** Over workflow_engine LOOP_GUARD_MIN_PAUSE_MS (60 s, measured from the engine's own clock): a shorter wait would count as a pause-free loop. */
const MIN_WAIT_MS = 65_000;
/** Added to a computed wait so the check after it lands past the boundary, not on it. */
const WAIT_SLACK_MS = 5_000;
/** = emailAttachmentFilingService.STALE_CLAIM_MIN: a placeholder older than this is a dead filing. */
const STALE_PLACEHOLDER_MIN = 15;
const KEY_RE = /^[A-Za-z0-9@._-]{1,40}$/;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** The burst key: the sender's address; an email without one is never grouped. */
function senderKey(email, mailMessageId) {
  const e = String(email == null ? '' : email).trim().toLowerCase().slice(0, 255);
  return e || `#${mailMessageId}`;
}

function checkKey(digestKey) {
  const k = String(digestKey == null ? '' : digestKey).trim();
  if (!KEY_RE.test(k)) throw codedError('BAD_DIGEST_KEY', 'digest_key must be 1–40 characters: letters, digits, @ . _ -');
  return k;
}

function positiveId(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw codedError('BAD_REF', `${name} must be a positive integer (got ${JSON.stringify(v)})`);
  return n;
}

function parseResult(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// enqueue / record — called by emailAttachmentFilingService
// ─────────────────────────────────────────────────────────────────────────────

/** The placeholder: this email is in the sender's burst, its files not filed yet. Idempotent. */
async function enqueue(db, { digestKey, mailMessageId, senderEmail }) {
  const key = checkKey(digestKey);
  const mid = positiveId(mailMessageId, 'mail_message_id');
  await db.query(
    `INSERT IGNORE INTO mail_attachment_notices (digest_key, mail_message_id, sender, ingested_at, created_at)
     SELECT ?, id, ?, ingested_at, UTC_TIMESTAMP() FROM mail_messages WHERE id = ?`,
    [key, senderKey(senderEmail, mid), mid]
  );
}

/** The filing result the notice is built from. Never rewrites a row already in a notice. */
async function record(db, { digestKey, mailMessageId, result }) {
  await db.query(
    'UPDATE mail_attachment_notices SET result = ? WHERE digest_key = ? AND mail_message_id = ? AND notified_at IS NULL',
    [JSON.stringify(result), checkKey(digestKey), positiveId(mailMessageId, 'mail_message_id')]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// check — the burst decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} o
 * @param {string} o.digestKey
 * @param {number} o.mailMessageId   the email whose workflow is asking
 * @param {number} [o.quietMs]       default 5 min
 * @param {number} [o.capMs]         default 30 min
 * @returns {Promise<object>} {action: 'wait'|'send'|'done', …} — see digestOutput / the internal function's meta
 */
async function check(db, o = {}) {
  const key = checkKey(o.digestKey);
  const mid = positiveId(o.mailMessageId, 'mail_message_id');
  const quietS = Math.ceil((Number(o.quietMs) > 0 ? Number(o.quietMs) : QUIET_DEFAULT_MS) / 1000);
  const capS = Math.ceil((Number(o.capMs) > 0 ? Number(o.capMs) : CAP_DEFAULT_MS) / 1000);
  if (capS < quietS) throw codedError('BAD_WINDOW', 'cap must be at least as long as quiet');
  const { withTransaction } = require('../lib/withTransaction');   // lazy (convention)

  const verdict = await withTransaction(db, async (conn) => {
    const [[me]] = await conn.query(
      'SELECT sender, digest_of, notified_at, result IS NOT NULL AS has_result FROM mail_attachment_notices WHERE digest_key = ? AND mail_message_id = ?',
      [key, mid]);
    if (!me) {
      throw codedError('NOT_QUEUED',
        `message ${mid} is not queued under digest "${key}" — the email_attachments_file step needs digest_key "${key}"`);
    }
    if (!me.notified_at && !Number(me.has_result)) {
      throw codedError('NOT_FILED', `message ${mid} has no filing result yet — run email_attachments_file (digest_key "${key}") first`);
    }
    // ONE locking read of the sender's pending rows (mine among them while unclaimed).
    const [rows] = me.notified_at ? [[]] : await conn.query(
      `SELECT mail_message_id, result IS NOT NULL AS has_result,
              GREATEST(0, TIMESTAMPDIFF(SECOND, ingested_at, UTC_TIMESTAMP())) AS age_s
         FROM mail_attachment_notices
        WHERE digest_key = ? AND sender = ? AND notified_at IS NULL
          AND (result IS NOT NULL OR created_at > UTC_TIMESTAMP() - INTERVAL ? MINUTE)
        ORDER BY ingested_at, mail_message_id
          FOR UPDATE`,
      [key, me.sender, STALE_PLACEHOLDER_MIN]);
    if (!rows.some(r => Number(r.mail_message_id) === mid && Number(r.has_result))) {
      // Claimed between the two reads, or before this call: whose notice?
      // A LOCKING read: a plain one would answer from this transaction's snapshot,
      // taken before the claim that just made the row disappear from `rows`.
      const [[now]] = await conn.query(
        'SELECT digest_of FROM mail_attachment_notices WHERE digest_key = ? AND mail_message_id = ? LOCK IN SHARE MODE', [key, mid]);
      const of = now && now.digest_of != null ? Number(now.digest_of) : null;
      if (of === mid) return { action: 'send', digestOf: mid };      // my own claim: a retried step sends it again
      return { action: 'done', digestOf: of };
    }
    const filed = rows.filter(r => Number(r.has_result));
    const newest = Math.min(...rows.map(r => Number(r.age_s)));       // placeholders count: an email is arriving
    const oldest = Math.max(...filed.map(r => Number(r.age_s)));
    if (oldest < capS && newest < quietS) {
      const waitMs = Math.max(MIN_WAIT_MS, Math.min(quietS - newest, capS - oldest) * 1000 + WAIT_SLACK_MS);
      return { action: 'wait', waitMs, pending: rows.length };
    }
    const ids = filed.map(r => Number(r.mail_message_id));
    await conn.query(
      `UPDATE mail_attachment_notices SET notified_at = UTC_TIMESTAMP(), digest_of = ?
        WHERE digest_key = ? AND mail_message_id IN (?) AND notified_at IS NULL`,
      [mid, key, ids]);
    return { action: 'send', digestOf: mid, endedBy: oldest >= capS ? 'cap' : 'quiet' };
  }, { retries: 1 });

  if (verdict.action === 'wait') {
    const s = Math.ceil(verdict.waitMs / 1000);
    return { action: 'wait', wait: `${s}s`, wait_ms: s * 1000, pending: verdict.pending, digest_of: null, digest_key: key, mail_message_id: mid };
  }
  if (verdict.action === 'done') {
    return { action: 'done', digest_of: verdict.digestOf, digest_key: key, mail_message_id: mid };
  }
  const rows = await burstRows(db, key, verdict.digestOf);
  return {
    ...(await digestOutput(db, rows)),
    action: 'send', ended_by: verdict.endedBy || null, digest_key: key, digest_of: verdict.digestOf, mail_message_id: mid,
  };
}

/** The burst's rows, oldest first, results parsed (a row whose result will not parse is dropped). */
async function burstRows(db, key, digestOf) {
  const [rows] = await db.query(
    `SELECT mail_message_id, result FROM mail_attachment_notices
      WHERE digest_key = ? AND digest_of = ? ORDER BY ingested_at, mail_message_id`,
    [key, digestOf]);
  return rows.map(r => ({ mail_message_id: Number(r.mail_message_id), result: parseResult(r.result) })).filter(r => r.result);
}

/**
 * The notice for a burst. One email: its own notice as the filing step built
 * it (byte-for-byte what a single email always got). Several: renderDigest in
 * the filing step's wording (notice_subject_prefix / notice_title, kept with
 * each result), each case's Docs Needed list read now, and the unsorted
 * emails' pick-the-case options merged into one set.
 */
async function digestOutput(db, rows) {
  const notice = require('./emailAttachmentNotice');               // lazy (convention)
  const results = rows.map(r => r.result);
  const last = results[results.length - 1] || {};
  const prefix = last.notice_prefix != null ? String(last.notice_prefix) : undefined;
  const ttl = last.notice_title != null && last.notice_title !== '' ? String(last.notice_title) : undefined;
  const unsorted = results.filter(r => r.placement === 'unsorted');
  const landedN = (r) => (r.files || []).filter(f => f.status === 'filed' || f.status === 'already_filed').length;
  const base = {
    mail_message_ids: rows.map(r => r.mail_message_id),
    count: rows.length,
    from: last.from || { email: null, name: null },
    files_filed: results.reduce((a, r) => a + landedN(r), 0),
    unsorted_ids: unsorted.map(r => Number(r.mail_message_id)),
    unsorted_folder_path: (unsorted.find(r => r.folder_path) || {}).folder_path || null,
    unsorted_folder_link: (unsorted.find(r => r.folder_link) || {}).folder_link || null,
    case_ids: [...new Set(results.filter(r => r.placement !== 'unsorted' && r.case_id && landedN(r)).map(r => r.case_id))],
  };

  if (results.length === 1) {
    return {
      ...base,
      needs_decision: !!last.needs_decision,
      decision_options: Array.isArray(last.decision_options) ? last.decision_options : [],
      notice_subject: last.notice_subject,
      notice_html: last.notice_html,
      notice_text: last.notice_text,
      notice_html_decision: last.needs_decision ? last.notice_html_decision : null,
      warnings: [],
    };
  }

  // Several emails: one set of options — every candidate any unsorted email offered, once, then "leave it".
  const opts = new Map();
  for (const r of unsorted) {
    for (const op of (Array.isArray(r.decision_options) ? r.decision_options : [])) {
      if (op && op.value !== 'unsorted' && !opts.has(op.value)) opts.set(op.value, op);
    }
  }
  const decisionOptions = opts.size ? [...opts.values(), { label: 'Leave them in Unsorted', value: 'unsorted' }] : [];
  const checklists = {};
  const warnings = [];
  const filing = require('./emailAttachmentFilingService');        // lazy (convention)
  for (const caseId of base.case_ids) {
    checklists[caseId] = await filing.docsChecklist(db, caseId, last.app_url || filing.appUrl(), warnings);
  }
  const args = { results, checklists, subjectPrefix: prefix, title: ttl };
  const n = notice.renderDigest(args);
  return {
    ...base,
    needs_decision: decisionOptions.length > 0,
    decision_options: decisionOptions,
    notice_subject: n.subject,
    notice_html: n.html,
    notice_text: n.text,
    notice_html_decision: decisionOptions.length ? notice.renderDigest({ ...args, withOptions: true }).html : null,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// refileDigest — the burst's answer to its one decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move every unsorted email of a burst into a case (refileMessageAttachments
 * per email). The burst's case-filed emails stay where they are.
 * @returns {Promise<{case_id, mail_message_ids, moved, already_there, failed, warnings, folder_path, folder_link, folders}>}
 */
async function refileDigest(db, o = {}) {
  const key = checkKey(o.digestKey);
  const of = positiveId(o.digestOf, 'digest_of');
  const filing = require('./emailAttachmentFilingService');        // lazy (convention)
  const rows = await burstRows(db, key, of);
  if (!rows.length) throw codedError('DIGEST_NOT_FOUND', `no notice ${of} under digest "${key}"`);
  const targets = rows.filter(r => r.result.placement === 'unsorted');
  const out = {
    case_id: null, mail_message_ids: targets.map(r => r.mail_message_id),
    moved: [], already_there: [], failed: [], warnings: [], folder_path: null, folder_link: null, folders: [],
  };
  if (!targets.length) {
    out.case_id = String(o.caseId || '') || null;
    out.warnings.push('Nothing in this notice was left unsorted.');
    return out;
  }
  for (const r of targets) {
    const one = await filing.refileMessageAttachments(db, {
      mailMessageId: r.mail_message_id, caseId: o.caseId, subfolder: o.subfolder, filedBy: o.filedBy,
    });
    out.case_id = one.case_id;
    const tag = (x) => ({ ...x, mail_message_id: r.mail_message_id });
    out.moved.push(...one.moved.map(tag));
    out.already_there.push(...one.already_there.map(tag));
    out.failed.push(...one.failed.map(tag));
    for (const w of one.warnings || []) if (!out.warnings.includes(w)) out.warnings.push(w);
    if (one.folder_path && !out.folders.some(f => f.path === one.folder_path)) out.folders.push({ path: one.folder_path, link: one.folder_link || null });
  }
  const lastFolder = out.folders[out.folders.length - 1] || {};
  out.folder_path = lastFolder.path || null;
  out.folder_link = lastFolder.link || null;
  return out;
}

module.exports = {
  enqueue,
  record,
  check,
  refileDigest,
  burstRows,
  senderKey,
  QUIET_DEFAULT_MS,
  CAP_DEFAULT_MS,
  MIN_WAIT_MS,
  WAIT_SLACK_MS,
  STALE_PLACEHOLDER_MIN,
  // exported for tests
  digestOutput,
};
