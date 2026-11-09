// services/emailAttachmentFilingService.js
//
/**
 * EMAIL ATTACHMENTS → DROPBOX — file a stored email's attachments where they
 * belong, once, and say where they went.
 *
 * Backs the `email_attachments_file` and `email_attachments_refile` internal
 * functions (lib/internal_functions/emailAttachments.js). First caller: the
 * docs@4lsg.com rule's workflow. Design: ref/EMAIL_ATTACHMENTS_DESIGN.md.
 *
 *   fileMessageAttachments(db, opts)    match → fetch → place → register → notice
 *   refileMessageAttachments(db, opts)  move a message's filed parts to a case
 *
 * ── PIPELINE (fileMessageAttachments) ───────────────────────────────────────
 *   1. resolve the stored message   mailAttachmentService.resolveMessage — the
 *                                   YC mailbox store, so any IMAP provider
 *   2. choose the destination       target 'auto' = emailCaseMatchService;
 *                                   'case' / 'contact' / 'unsorted' = caller's
 *   3. per fileable part            CLAIM (mail_attachment_filings) → fetch the
 *                                   bytes over IMAP → filePlacementService
 *                                   .placeAndRegister (the client-upload
 *                                   ladder + documents registry) → COMPLETE
 *   4. one Dropbox folder link (each file's own link = that link opened on
 *      it), the case's Docs Needed list when it has one, the notice
 *      (emailAttachmentNotice), and — when no case was chosen but candidates
 *      exist — ready request_decision options so a workflow can ask staff
 *      which case.
 *   digestKey: the email also joins its sender's BURST (a row in
 *      mail_attachment_notices before step 3, its result after step 4) and
 *      the workflow sends the burst's one notice later —
 *      emailAttachmentDigestService, design §8.
 *
 * ── WHERE FILES LAND (ladder: filePlacementService) ─────────────────────────
 *   case chosen        <case folder>/<subfolder>, default
 *                      "Client Uploads/Emailed {yymmdd}" (one folder per day —
 *                      ruling Q3, 2026-11-06). A case without a working folder
 *                      gets the ladder's rungs 2/3 (auto-create + task, or the
 *                      bin's "{case_id} - {name}" folder) — NO per-file move
 *                      task: the notice already says it, and a 14-file email
 *                      must not raise 14 tasks.
 *   no case            the unsorted client-uploads bin
 *                      (app_settings dropbox_unsorted_uploads_path), in
 *                      "Emailed {yymmdd} - {sender}" — registered to the
 *                      sender's contact when there is one.
 *   {yymmdd} is the message's date, firm-local (FIRM_TIMEZONE).
 *
 * ── IDEMPOTENCY: THE CLAIM ──────────────────────────────────────────────────
 * UNIQUE(mail_message_id, part) in mail_attachment_filings. INSERT IGNORE a
 * 'filing' row before the fetch; mark it 'filed' after the upload; DELETE it
 * on failure so a retry can try again. A part already 'filed' is reported, not
 * re-filed — a retried step, a duplicate job, a second rule all converge on
 * one copy. A 'filing' claim older than STALE_CLAIM_MIN (a crash mid-upload)
 * is re-claimed by the next run. The window between a successful upload and
 * the COMPLETE write is the only place a crash can still leave a second copy
 * ("x (1).pdf") — never a lost one.
 *
 * ── FAILURE POSTURE ─────────────────────────────────────────────────────────
 * Throws only when there is nothing to report on: the reference is bad
 * (BAD_REF), the message is not stored (MESSAGE_NOT_STORED — an Apps Script
 * envelope that beat the worker; the step's error_policy retries), or the
 * explicit target does not exist (CASE_NOT_FOUND / CONTACT_NOT_FOUND).
 * Per-file failures (mail server unreachable, the message deleted, Dropbox
 * down) are RESULTS — listed in the notice so a person finishes the job; a
 * re-run later files only what is still missing. Each fetch gets one retry.
 */

'use strict';

const { DateTime } = require('luxon');

const attachments = require('./mailbox/mailAttachmentService');
const caseMatch = require('./emailCaseMatchService');
const notice = require('./emailAttachmentNotice');

const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';

const DEFAULT_CASE_SUBFOLDER = 'Client Uploads/Emailed {yymmdd}';
const DEFAULT_UNSORTED_SUBFOLDER = 'Emailed {yymmdd} - {sender}';

/** A 'filing' claim older than this is a crashed run — the next run takes it over. */
const STALE_CLAIM_MIN = 15;

/** documents envelope source + tasks.task_source for everything filed here. */
const SOURCE = 'email_attachment';
const LOG_TAG = '[EMAIL ATTACH]';
const ARTIFACT_LABEL = 'emailed document';
const BIN_LABEL = 'unsorted client-uploads folder';

const TARGETS = Object.freeze(['auto', 'case', 'contact', 'unsorted']);

/** Longest filed filename (Dropbox allows 255; the ladder may add a prefix). */
const MAX_FILENAME = 150;

/** One fetch retry after this pause (a socket blip, a throttled IMAP login). */
const FETCH_RETRY_MS = 2000;

// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_NAME = /[/\\:*?"<>|\u0000-\u001f]/g;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Lazy requires (convention: services reached from internal_functions load
// their heavy dependencies inside the call).
const placement = () => require('./filePlacementService');
const dropbox = () => require('./dropboxService');
const docIngest = () => require('./documentIngestService');
const uploadTarget = () => require('./uploadTargetService');
const digest = () => require('./emailAttachmentDigestService');

function appUrl() {
  return (require('../lib/firmConfig').cfg('app_url') || 'https://app.4lsg.com').replace(/\/+$/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

/** One generated path segment: illegal characters out, no trailing '.'/' ' (Windows sync). */
function cleanSegment(s, max = 100) {
  const out = String(s == null ? '' : s)
    .replace(ILLEGAL_IN_NAME, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '');
  return out === '.' || out === '..' ? '' : out;
}

/**
 * Fill a folder template. Tokens: {yymmdd} {yyyy-mm-dd} {sender}. A template
 * may hold '/' (nested folders); every segment is cleaned on its own and empty
 * ones dropped, so no value can climb out of the folder it was meant for.
 */
function renderFolder(template, { date, sender }) {
  const d = (date instanceof Date && !isNaN(date.getTime()))
    ? DateTime.fromJSDate(date, { zone: 'utc' }).setZone(FIRM_TZ)
    : DateTime.now().setZone(FIRM_TZ);
  const vals = {
    yymmdd: d.toFormat('yyMMdd'),
    'yyyy-mm-dd': d.toFormat('yyyy-MM-dd'),
    sender: cleanSegment(sender, 60) || 'unknown sender',
  };
  return String(template || '')
    .split('/')
    .map(seg => cleanSegment(seg.replace(/\{(yymmdd|yyyy-mm-dd|sender)\}/g, (_, k) => vals[k])))
    .filter(Boolean)
    .join('/');
}

/** The filed name: cleaned, length-capped with its extension kept. */
function safeFileName(name, ext) {
  let n = String(name == null ? '' : name).replace(ILLEGAL_IN_NAME, '-').replace(/\s+/g, ' ').trim();
  if (!n) n = 'attachment';
  const dot = ext ? `.${ext}` : '';
  if (n.length > MAX_FILENAME) {
    const base = dot && n.toLowerCase().endsWith(dot) ? n.slice(0, -dot.length) : n;
    n = base.slice(0, MAX_FILENAME - dot.length).trim() + dot;
  }
  return n.replace(/^[. ]+/, '') || `attachment${dot}`;
}

function senderAddress(fromAddr) {
  return require('./mailbox/mailReadService').senderOf(fromAddr);   // lazy (convention)
}

function displayName(fromAddr) {
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(String(fromAddr || ''));
  return m && m[1].trim() ? m[1].trim() : null;
}

function parentOf(path) {
  const p = String(path || '');
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The claim (mail_attachment_filings)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take the (message, part) claim.
 * @returns {Promise<{claimed:true, id:number} | {claimed:false, row:object}>}
 */
async function claim(db, mailMessageId, part, filename) {
  const [ins] = await db.query(
    `INSERT IGNORE INTO mail_attachment_filings (mail_message_id, part, filename, status, claimed_at)
     VALUES (?, ?, ?, 'filing', UTC_TIMESTAMP())`,
    [mailMessageId, String(part), String(filename || '').slice(0, 255)]
  );
  if (ins.affectedRows === 1) return { claimed: true, id: Number(ins.insertId) };
  const [[row]] = await db.query(
    'SELECT * FROM mail_attachment_filings WHERE mail_message_id = ? AND part = ? LIMIT 1',
    [mailMessageId, String(part)]
  );
  if (!row) {
    // Released between our INSERT and SELECT — a concurrent run failed. Ours
    // to try once more.
    return claim(db, mailMessageId, part, filename);
  }
  if (row.status === 'filing') {
    const [up] = await db.query(
      `UPDATE mail_attachment_filings SET claimed_at = UTC_TIMESTAMP()
        WHERE id = ? AND status = 'filing' AND claimed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE`,
      [row.id, STALE_CLAIM_MIN]
    );
    if (up.affectedRows === 1) return { claimed: true, id: Number(row.id) };
  }
  return { claimed: false, row };
}

async function complete(db, id, f) {
  await db.query(
    `UPDATE mail_attachment_filings
        SET status = 'filed', size = ?, link_type = ?, link_id = ?, placement = ?, match_method = ?,
            dropbox_path = ?, dropbox_id = ?, document_id = ?, filed_by = ?, filed_at = UTC_TIMESTAMP()
      WHERE id = ? AND status = 'filing'`,
    [f.size, f.link_type, f.link_id, f.placement, f.match_method,
      f.dropbox_path, f.dropbox_id, f.document_id, f.filed_by, id]
  );
}

async function release(db, id) {
  try {
    await db.query("DELETE FROM mail_attachment_filings WHERE id = ? AND status = 'filing'", [id]);
  } catch (err) {
    // The claim then goes stale and the next run re-claims it.
    console.warn(`${LOG_TAG} could not release claim ${id}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Destination
// ─────────────────────────────────────────────────────────────────────────────

async function _caseRow(db, caseId) {
  const [[row]] = await db.query(
    `SELECT case_id, case_number, case_number_full, case_type, case_stage, case_status, pipeline_phase
       FROM cases WHERE case_id = ? LIMIT 1`, [String(caseId)]
  );
  return row || null;
}

async function _contactRow(db, contactId) {
  const [[row]] = await db.query(
    'SELECT contact_id, contact_name, contact_lfm_name FROM contacts WHERE contact_id = ? LIMIT 1',
    [Number(contactId)]
  );
  return row ? { contact_id: Number(row.contact_id), name: row.contact_name || null, lfm_name: row.contact_lfm_name || null } : null;
}

/**
 * Where this message's files go.
 * @returns {Promise<{match, linkType, linkId, caseId, contact}>}
 */
async function _destination(db, { target, caseId, contactId, msg, fromEmail, text }) {
  // The matcher always runs: its contact names the unsorted folder, and its
  // candidates go in the notice, whatever the caller decided.
  const match = await caseMatch.matchCase(db, { fromEmail, subject: msg.subject, text });

  if (target === 'case') {
    const cs = await _caseRow(db, caseId);
    if (!cs) throw codedError('CASE_NOT_FOUND', `case ${caseId} not found`);
    return {
      match: { ...match, case_id: cs.case_id, method: 'explicit', flag: null, reason: `Filed to case ${cs.case_id} as the automation directed.` },
      linkType: 'case', linkId: cs.case_id, caseId: cs.case_id, contact: match.contact,
    };
  }
  if (target === 'contact') {
    const ct = await _contactRow(db, contactId);
    if (!ct) throw codedError('CONTACT_NOT_FOUND', `contact ${contactId} not found`);
    return {
      match: { ...match, case_id: null, method: 'explicit', flag: null, reason: `Filed for ${ct.name || `contact ${ct.contact_id}`} as the automation directed.` },
      linkType: 'contact', linkId: ct.contact_id, caseId: null, contact: ct,
    };
  }
  if (target === 'unsorted' || !match.case_id) {
    const m = target === 'unsorted'
      ? { ...match, case_id: null, method: null, reason: 'Filed to Unsorted as the automation directed.' }
      : match;
    return {
      match: m,
      linkType: match.contact ? 'contact' : null,
      linkId: match.contact ? match.contact.contact_id : null,
      caseId: null,
      contact: match.contact,
    };
  }
  return { match, linkType: 'case', linkId: match.case_id, caseId: match.case_id, contact: match.contact };
}

// ─────────────────────────────────────────────────────────────────────────────
// fileMessageAttachments
// ─────────────────────────────────────────────────────────────────────────────

async function _fetchWithRetry(db, msg, part, maxBytes) {
  try {
    return await attachments.fetchPartBuffer(db, msg, part, { maxBytes });
  } catch (err) {
    // Deterministic answers are final; anything else (a socket, a throttled
    // login, a server hiccup) gets one more try.
    if (['BAD_REF', 'MAILBOX_GONE', 'PART_GONE', 'TOO_LARGE'].includes(err && err.code)) throw err;
    await new Promise(r => setTimeout(r, FETCH_RETRY_MS));
    return attachments.fetchPartBuffer(db, msg, part, { maxBytes });
  }
}

/**
 * @param {object} db
 * @param {object} o
 * @param {object} o.ref                    resolveMessage reference
 * @param {string} [o.target='auto']        auto | case | contact | unsorted
 * @param {string} [o.caseId]               target 'case'
 * @param {number} [o.contactId]            target 'contact'
 * @param {string} [o.subfolder]            case-rung folder template
 * @param {string} [o.unsortedSubfolder]    bin folder template
 * @param {number} [o.filedBy]              acting user; null = automation
 * @param {number} [o.maxBytes]
 * @param {string} [o.noticeSubjectPrefix]
 * @param {string} [o.noticeTitle]
 * @returns {Promise<object>} the result (see the internal function's __meta)
 */
async function fileMessageAttachments(db, o = {}) {
  const target = o.target == null || o.target === '' ? 'auto' : String(o.target);
  if (!TARGETS.includes(target)) throw codedError('BAD_TARGET', `target must be one of ${TARGETS.join(', ')}`);
  if (target === 'case' && !o.caseId) throw codedError('BAD_TARGET', "target 'case' needs case_id");
  if (target === 'contact' && !o.contactId) throw codedError('BAD_TARGET', "target 'contact' needs contact_id");
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : attachments.DEFAULT_MAX_BYTES;
  const filedBy = o.filedBy == null || o.filedBy === '' ? null : Number(o.filedBy);
  const digestKey = o.digestKey == null || o.digestKey === '' ? null : String(o.digestKey);

  const msg = await attachments.resolveMessage(db, o.ref);
  if (!msg) {
    throw codedError('MESSAGE_NOT_STORED',
      'the message is not in the mailbox store yet (the ingest worker stores it within one poll — retry)');
  }

  const fromEmail = senderAddress(msg.from_addr);
  const text = require('./mailbox/mailboxIngestService').emitText(msg.body_text, msg.body_html).text;   // lazy (convention)
  const dest = await _destination(db, {
    target, caseId: o.caseId, contactId: o.contactId, msg, fromEmail, text,
  });
  // BURST DIGEST (design §8): in the sender's burst from now — before the
  // files, so a burst still being filed holds its notice back.
  if (digestKey) await digest().enqueue(db, { digestKey, mailMessageId: msg.id, senderEmail: fromEmail });

  const date = msg.date instanceof Date ? msg.date : (msg.date ? new Date(msg.date) : null);
  const senderLabel = (dest.contact && (dest.contact.lfm_name || dest.contact.name)) || fromEmail || 'unknown sender';
  const caseFolder = renderFolder(o.subfolder || DEFAULT_CASE_SUBFOLDER, { date, sender: senderLabel });
  const binFolder = renderFolder(o.unsortedSubfolder || DEFAULT_UNSORTED_SUBFOLDER, { date, sender: senderLabel });

  const { files: fileable, skipped } = attachments.fileableParts(msg, { maxBytes });
  const files = [];
  const warnings = [];
  const placements = new Set();
  const folders = [];

  for (const f of fileable) {
    const entry = { part: f.part, filename: f.filename };
    const c = await claim(db, msg.id, f.part, f.filename);
    if (!c.claimed) {
      const r = c.row;
      if (r.status === 'filed') {
        Object.assign(entry, {
          status: 'already_filed', path: r.dropbox_path || null,
          filed_name: r.dropbox_path ? String(r.dropbox_path).split('/').pop() : f.filename,
          bytes: r.size != null ? Number(r.size) : null,
          document_id: r.document_id != null ? Number(r.document_id) : null,
        });
        if (r.placement) placements.add(r.placement);
        if (r.dropbox_path) folders.push(parentOf(r.dropbox_path));
      } else {
        Object.assign(entry, { status: 'in_progress' });
      }
      files.push(entry);
      continue;
    }
    try {
      const { buffer } = await _fetchWithRetry(db, msg, f.part, maxBytes);
      const verdict = await placement().placeAndRegister(db, {
        linkType: dest.linkType,
        linkId: dest.linkId,
        content: buffer,
        fileName: safeFileName(f.filename, f.ext),
        subfolder: caseFolder,
        unsortedPathKey: uploadTarget().UNSORTED_PATH_KEY,
        unsortedDefault: uploadTarget().DEFAULT_UNSORTED_PATH,
        unsortedFilenamePrefix: '',
        unsortedSubfolder: binFolder,
        eventSource: SOURCE,
        taskSource: SOURCE,
        logTag: LOG_TAG,
        artifactLabel: ARTIFACT_LABEL,
        binLabel: BIN_LABEL,
        createdBy: filedBy,
        moveTaskOnUnsortedCase: false,
      });
      await complete(db, c.id, {
        size: buffer.length,
        link_type: dest.linkType,
        link_id: dest.linkId != null ? String(dest.linkId) : null,
        placement: verdict.placement,
        match_method: dest.match.method || 'none',
        dropbox_path: verdict.path,
        dropbox_id: null,
        document_id: verdict.document_id,
        filed_by: filedBy,
      });
      placements.add(verdict.placement);
      folders.push(parentOf(verdict.path));
      for (const w of verdict.warnings || []) if (!warnings.includes(w)) warnings.push(w);
      Object.assign(entry, {
        status: 'filed', path: verdict.path, filed_name: verdict.file_name,
        bytes: buffer.length, document_id: verdict.document_id,
      });
    } catch (err) {
      await release(db, c.id);
      console.warn(`${LOG_TAG} message ${msg.id} part ${f.part}: ${err && err.message}`);
      Object.assign(entry, { status: 'failed', error: (err && err.message) || 'error', bytes: f.est_bytes || null });
    }
    files.push(entry);
  }

  // The Dropbox id is stamped after the fact from the registry: placeAndRegister
  // returns the path, and documents.external_id holds the id it registered.
  await _stampDropboxIds(db, msg.id);

  const landed = files.filter(f => f.status === 'filed' || f.status === 'already_filed');
  const folderPath = folders.filter(Boolean)[0] || null;
  let folderLink = null;
  if (folderPath) {
    try {
      folderLink = await dropbox().getOrCreateSharedLink(db, { path: folderPath });
    } catch (err) {
      warnings.push(`The files were filed, but a link to their folder could not be made: ${err.message}`);
    }
  }

  // One link per file: the folder's link opened on that file (Dropbox's own
  // `preview=` — no new shared link per file). Only for a file in THAT folder
  // (a part filed by an earlier run may sit elsewhere); a file renamed since
  // just opens the folder.
  if (folderLink) {
    for (const f of landed) {
      if (f.path && parentOf(f.path) === folderPath) f.link = previewLink(folderLink, f.path.slice(folderPath.length + 1));
    }
  }

  const unsorted = placements.has('unsorted') || (!dest.caseId && landed.length > 0);
  const base = appUrl();
  const shell = require('../lib/shellLinks');   // lazy (convention)
  const result = {
    mail_message_id: Number(msg.id),
    mailbox_id: Number(msg.mailbox_id),
    from: { email: fromEmail || null, name: displayName(msg.from_addr) },
    subject: msg.subject || '',
    date: date && !isNaN(date.getTime()) ? date.toISOString() : null,
    text,
    target,
    match: dest.match,
    placement: !files.length && !skipped.length ? 'none' : (unsorted ? 'unsorted' : (landed.length ? 'case' : 'none')),
    case_id: dest.caseId,
    contact_id: dest.contact ? dest.contact.contact_id : null,
    folder_path: folderPath,
    folder_link: folderLink,
    app_url: base,
    case_link: dest.caseId ? shell.caseLink(base, dest.caseId) : null,
    contact_link: dest.contact ? shell.contactLink(base, dest.contact.contact_id) : null,
    files,
    skipped,
    counts: {
      filed: files.filter(f => f.status === 'filed').length,
      already_filed: files.filter(f => f.status === 'already_filed').length,
      in_progress: files.filter(f => f.status === 'in_progress').length,
      failed: files.filter(f => f.status === 'failed').length,
      skipped: skipped.length,
    },
    warnings,
    // The client's Docs Needed list, when the case has one — the job is
    // "review, rename, move, and check it off their list" (Fred 2026-11-09).
    docs_checklist: dest.caseId && landed.length ? await _docsChecklist(db, dest.caseId, base, warnings) : null,
  };

  // A person should pick the case when none was chosen but some are plausible.
  const cands = (!dest.caseId || unsorted) && landed.length && Array.isArray(dest.match.candidates)
    ? dest.match.candidates : [];
  result.needs_decision = cands.length > 0;
  result.decision_options = result.needs_decision
    ? [
      ...cands.map(c => ({
        label: `${c.case_id} — ${[c.case_number, c.case_type, c.case_stage].filter(Boolean).join(' · ')}`.slice(0, 100),
        value: c.case_id,
      })),
      { label: 'Leave it in Unsorted', value: 'unsorted' },
    ]
    : [];

  const n = notice.render({
    result,
    subjectPrefix: o.noticeSubjectPrefix != null ? String(o.noticeSubjectPrefix) : undefined,
    title: o.noticeTitle != null && o.noticeTitle !== '' ? String(o.noticeTitle) : undefined,
  });
  result.notice_subject = n.subject;
  result.notice_html = n.html;
  result.notice_text = n.text;
  // request_decision's email_html: the same notice with [[options_html]] —
  // one button per decision_options entry — in the where-box.
  result.notice_html_decision = result.needs_decision
    ? notice.render({
      result,
      subjectPrefix: o.noticeSubjectPrefix != null ? String(o.noticeSubjectPrefix) : undefined,
      title: o.noticeTitle != null && o.noticeTitle !== '' ? String(o.noticeTitle) : undefined,
      withOptions: true,
    }).html
    : null;
  result.digest_key = digestKey;
  if (digestKey) {
    // What the burst's notice is built from: this result, the sender's words
    // (cut as the notice cuts them) instead of the raw body, and the wording.
    await digest().record(db, {
      digestKey,
      mailMessageId: msg.id,
      result: {
        ...result,
        text: undefined,
        excerpt: notice.messageExcerpt(text),
        notice_prefix: o.noticeSubjectPrefix != null ? String(o.noticeSubjectPrefix) : undefined,
        notice_title: o.noticeTitle != null && o.noticeTitle !== '' ? String(o.noticeTitle) : undefined,
      },
    });
  }
  delete result.text;   // the notice carries the excerpt; the raw body stays in the store
  return result;
}

/** A Dropbox shared FOLDER link opened on one file inside it. */
function previewLink(folderLink, name) {
  return `${folderLink}${String(folderLink).includes('?') ? '&' : '?'}preview=${encodeURIComponent(name)}`;
}

/** Open items the notice names, at most; the count covers the rest. */
const CHECKLIST_ITEMS_MAX = 12;

/**
 * The case's client-facing Docs Needed list(s) — portalDocsService.listDocs'
 * scope (tag 'docs_needed', or the legacy title 'Docs Needed'), items in
 * position order. null when the case has none. Best-effort: a failed read is
 * a warning, never a failed filing.
 * @returns {Promise<{link, lists, items, open_count, open}|null>}
 */
async function _docsChecklist(db, caseId, base, warnings) {
  try {
    const [rows] = await db.query(
      `SELECT cl.id AS list_id, ci.name, ci.status
         FROM checklists cl
         LEFT JOIN checkitems ci ON ci.checklist_id = cl.id
        WHERE cl.link_type = 'case' AND cl.link = ?
          AND (cl.tag = 'docs_needed' OR cl.title = 'Docs Needed')
        ORDER BY cl.id, ci.position, ci.id`,
      [caseId]);
    if (!rows.length) return null;
    const items = rows.filter(r => r.name != null);
    const open = items.filter(r => r.status !== 'complete').map(r => r.name);
    return {
      link: require('../lib/shellLinks').caseLink(base, caseId, 'checklists'),   // lazy (convention)
      lists: new Set(rows.map(r => r.list_id)).size,
      items: items.length,
      open_count: open.length,
      open: open.slice(0, CHECKLIST_ITEMS_MAX),
    };
  } catch (err) {
    warnings.push(`The case's Docs Needed list could not be read: ${err.message}`);
    return null;
  }
}

/** Copy documents.external_id (the Dropbox id) onto this message's filed rows. Best-effort. */
async function _stampDropboxIds(db, mailMessageId) {
  try {
    await db.query(
      `UPDATE mail_attachment_filings f
         JOIN documents d ON d.id = f.document_id
          SET f.dropbox_id = d.external_id
        WHERE f.mail_message_id = ? AND f.status = 'filed' AND f.dropbox_id IS NULL
          AND d.source = 'dropbox'`,
      [mailMessageId]
    );
  } catch (err) {
    console.warn(`${LOG_TAG} dropbox id stamp failed for message ${mailMessageId}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// refileMessageAttachments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move every filed attachment of a message into a case: the answer to a
 * request_decision, or staff correcting a wrong guess. The files are moved by
 * their Dropbox id (renames and moves since filing are followed) and keep
 * their CURRENT names; each is linked to the case in the documents registry
 * (relation 'upload' — intent, not location; documentIngestService header).
 * A file already in the destination folder is only re-linked.
 *
 * @param {object} db
 * @param {object} o
 * @param {number} o.mailMessageId
 * @param {string} o.caseId
 * @param {string} [o.subfolder]    case-rung template (default as filing)
 * @param {number} [o.filedBy]
 * @returns {Promise<{case_id, placement, folder_path, folder_link, moved, already_there, failed, warnings}>}
 */
async function refileMessageAttachments(db, o = {}) {
  const mid = Number(o.mailMessageId);
  if (!Number.isInteger(mid) || mid <= 0) throw codedError('BAD_REF', 'mail_message_id must be a positive integer');
  const cs = await _caseRow(db, o.caseId);
  if (!cs) throw codedError('CASE_NOT_FOUND', `case ${o.caseId} not found`);
  const filedBy = o.filedBy == null || o.filedBy === '' ? null : Number(o.filedBy);

  const [rows] = await db.query(
    "SELECT * FROM mail_attachment_filings WHERE mail_message_id = ? AND status = 'filed' ORDER BY id ASC",
    [mid]
  );
  const out = { case_id: cs.case_id, placement: null, folder_path: null, folder_link: null, moved: [], already_there: [], failed: [], warnings: [] };
  if (!rows.length) {
    out.warnings.push(`Nothing has been filed for message ${mid}.`);
    return out;
  }

  const msg = await attachments.resolveMessage(db, { mail_message_id: mid });
  const date = msg && msg.date ? new Date(msg.date) : (rows[0].filed_at ? new Date(rows[0].filed_at) : null);
  const prep = await placement().preparePlacement(db, {
    linkType: 'case',
    linkId: cs.case_id,
    subfolder: renderFolder(o.subfolder || DEFAULT_CASE_SUBFOLDER, { date, sender: '' }),
    unsortedPathKey: uploadTarget().UNSORTED_PATH_KEY,
    unsortedDefault: uploadTarget().DEFAULT_UNSORTED_PATH,
    artifactLabel: ARTIFACT_LABEL,
    binLabel: BIN_LABEL,
    taskSource: SOURCE,
    logTag: LOG_TAG,
  });
  out.placement = prep.placement;
  out.folder_path = prep.folderPath;
  out.warnings.push(...(prep.warnings || []));
  if (prep.placementNote) out.warnings.push(prep.placementNote);
  const destLower = String(prep.folderPath).toLowerCase();

  for (const r of rows) {
    const label = r.dropbox_path ? String(r.dropbox_path).split('/').pop() : r.filename;
    try {
      const handle = r.dropbox_id || r.dropbox_path;
      if (!handle) throw new Error('no Dropbox path or id recorded');
      const meta = await dropbox().getMetadata(db, { credentialId: prep.credentialId, path: handle });
      if (!meta || meta['.tag'] !== 'file') throw new Error('it is no longer a file in Dropbox');
      let entry = meta;
      const here = parentOf(meta.path_lower) === destLower;
      if (!here) {
        const moved = await dropbox().movePath(db, {
          credentialId: prep.credentialId,
          fromPath: meta.id || meta.path_lower,
          toPath: dropbox().joinPath(prep.folderPath, meta.name),
          autorename: true,
        });
        entry = (moved && moved.metadata) || entry;
      }
      const reg = await docIngest().registerWrittenSafe(db, {
        entry,
        links: [{ type: 'case', id: cs.case_id }],
        createdBy: filedBy,
        eventSource: SOURCE,
        credentialId: prep.credentialId,
      });
      const docId = reg && reg.ok && reg.document && reg.document.id != null ? Number(reg.document.id) : null;
      await db.query(
        `UPDATE mail_attachment_filings
            SET link_type = 'case', link_id = ?, placement = ?, match_method = 'refiled',
                dropbox_path = ?, dropbox_id = COALESCE(?, dropbox_id), document_id = COALESCE(?, document_id),
                filed_by = COALESCE(?, filed_by), refiled_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [cs.case_id, prep.placement, entry.path_display || entry.path_lower || r.dropbox_path,
          entry.id || null, docId, filedBy, r.id]
      );
      (here ? out.already_there : out.moved).push({ part: r.part, filename: label, path: entry.path_display || entry.path_lower });
    } catch (err) {
      console.warn(`${LOG_TAG} refile message ${mid} part ${r.part} → ${cs.case_id}: ${err && err.message}`);
      out.failed.push({ part: r.part, filename: label, error: (err && err.message) || 'error' });
    }
  }

  try {
    out.folder_link = await dropbox().getOrCreateSharedLink(db, { path: prep.folderPath });
  } catch (err) {
    out.warnings.push(`Could not make a link to ${prep.folderPath}: ${err.message}`);
  }
  return out;
}

module.exports = {
  fileMessageAttachments,
  refileMessageAttachments,
  docsChecklist: _docsChecklist,
  appUrl,
  DEFAULT_CASE_SUBFOLDER,
  DEFAULT_UNSORTED_SUBFOLDER,
  STALE_CLAIM_MIN,
  SOURCE,
  TARGETS,
  // exported for tests
  renderFolder,
  safeFileName,
  cleanSegment,
  claim,
};
