// services/docsIntakeLog.js
//
/**
 * DOCS INTAKE LOG — ONE `docs` log row per batch of documents a client (or
 * someone for them) sends in, whichever door the files came through, so a
 * case's log reads the same way regardless of how they arrived (Fred,
 * 2026-11-18: "they should all do the same thing more or less").
 *
 *   source   door                                    caller
 *   docreq   public/docReq.html → upload-complete    routes/api.checklists.js
 *   portal   portal docs page → upload-complete      services/portalDocsService.js
 *   email    an email automation (the docs@ rule)    emailAttachmentFilingService
 *                                                    (fileMessageAttachments / refile*)
 *   comms    a person filing from Comms              emailAttachmentCommsService.fileOne
 *                                                    → the same filing service
 *
 * WHY (live, 2026-11-18): docReq and the portal each hand-wrote a `docs` row,
 * in two slightly different shapes; the two email doors wrote none. 57
 * attachments from 45 emails filed Nov 8–18 left no trace on their cases — only
 * the email's own row, linked to the sender's address, not the case.
 *
 * ── THE ROW ─────────────────────────────────────────────────────────────────
 *   log_type        'docs'           log_direction  'incoming'
 *   link            the case; else the contact (an email filed to Unsorted from
 *                   a known sender); else NO row — there is nothing to hang it
 *                   on (an unknown sender's files in Unsorted get their row
 *                   when someone moves them to a case: action 'email_refiled')
 *   log_by          the acting user (Comms, or whoever passed filed_by), else 0
 *                   (a client, or an automation)
 *   log_subject     one line for the feed — subjectFor() below:
 *                     docreq   "Client uploaded 3 documents"
 *                     portal   "Client uploaded 3 documents via portal"
 *                     email    "Jane Doe emailed 3 documents to docs@4lsg.com"
 *                     comms    "Fred filed 3 emailed documents from Comms"
 *                     refiled  "3 emailed documents moved to this case[ by Fred]"
 *   log_data (JSON) { action, source, contact_id, file_count,
 *                     files: [{ name, path?, document_id?, item_id?, item_name? }],
 *                     comment, placement, folder_path,
 *                     failed?: [{ name, error }],
 *                     email?: { mail_message_id, from, to, subject },
 *                     batch_key?, closed_by? }
 *                   batch_key: the upload run's key (upload pages, docs intake
 *                   S3 — client_upload_batches.batch_key); closed_by: 'sweep'
 *                   when the page never finished and the cron reported what
 *                   had landed (services/clientUploadBatchService).
 *                   action: 'client_upload' (docreq, portal) | 'email_filed'
 *                   (email, comms) | 'email_refiled' (moved to the case later).
 *                   logService folds the subject into log_data.subject as for
 *                   every row.
 *
 * Shape notes for anyone reading old rows: before this, docReq's `files` was an
 * array of plain names and its rows carried no `source`; portal rows already
 * had source 'portal' and `files` as objects. Nothing in the codebase reads
 * these fields (grepped 2026-11-18) — they are for people and for Casey.
 *
 * NEVER THROWS. The files are already in Dropbox when this runs; a failed log
 * write is a console line, never a failed upload or filing. Returns
 * { log_id } or null.
 */

'use strict';

const SOURCES = Object.freeze(['docreq', 'portal', 'email', 'comms']);
const ACTIONS = Object.freeze(['client_upload', 'email_filed', 'email_refiled']);

/** Files listed in one row (the count covers the rest). Same cap as the upload routes' MAX_UPLOAD_FILES. */
const MAX_FILES = 50;
const MAX_NAME = 255;
const MAX_PATH = 512;
const MAX_COMMENT = 2000;
const MAX_ERROR = 300;
const MAX_BATCH_KEY = 40;
const CLOSED_BY = Object.freeze(['client', 'sweep']);

const plural = (n) => (n === 1 ? '' : 's');
const str = (v, max) => (v == null ? null : String(v).slice(0, max));

/** First address in a header-ish string ("Docs <DOCS@4lsg.com>, x@y" → "docs@4lsg.com"). */
function firstAddress(list) {
  const m = /[^\s<>,;"']+@[^\s<>,;"']+/.exec(String(list || ''));
  return m ? m[0].toLowerCase() : null;
}

/** A file entry, from a plain name or an object; null when it names nothing. */
function fileEntry(f) {
  if (f == null) return null;
  if (typeof f !== 'object') {
    const name = str(f, MAX_NAME);
    return name ? { name } : null;
  }
  const name = str(f.name ?? f.filed_name ?? f.filename, MAX_NAME);
  if (!name) return null;
  const out = { name };
  if (f.path) out.path = str(f.path, MAX_PATH);
  if (f.document_id != null) out.document_id = Number(f.document_id);
  if (f.item_id != null) out.item_id = f.item_id;
  if (f.item_name != null) out.item_name = str(f.item_name, MAX_NAME);
  return out;
}

/**
 * The feed line. Exported for tests and for anyone who wants to show the same
 * wording elsewhere.
 */
function subjectFor({ action, source, count, actor, from, to }) {
  const n = Number(count) || 0;
  const docs = `${n} document${plural(n)}`;
  if (action === 'email_refiled') {
    return `${n} emailed document${plural(n)} moved to this case${actor ? ` by ${actor}` : ''}`;
  }
  if (action === 'email_filed') {
    if (source === 'comms') return `${actor || 'Staff'} filed ${n} emailed document${plural(n)} from Comms`;
    return `${from || 'Unknown sender'} emailed ${docs}${to ? ` to ${to}` : ''}`;
  }
  // client_upload
  return `Client uploaded ${docs}${source === 'portal' ? ' via portal' : ''}`;
}

/**
 * Write the row. Never throws.
 *
 * @param {object} db                 mysql2 pool / connection
 * @param {object} o
 * @param {string} o.action           'client_upload' | 'email_filed' | 'email_refiled'
 * @param {string} o.source           'docreq' | 'portal' | 'email' | 'comms'
 * @param {string} [o.caseId]         the case the files belong to (wins)
 * @param {number} [o.contactId]      the contact — the link when there is no case, else data only
 * @param {Array}  o.files            names, or { name|filed_name|filename, path?, document_id?, item_id?, item_name? }
 * @param {number} [o.fileCount]      the true count when `files` was capped upstream (default files.length)
 * @param {string} [o.comment]        the client's note (upload pages)
 * @param {string} [o.placement]      'case' | 'unsorted'
 * @param {string} [o.folderPath]     where they landed
 * @param {Array}  [o.failed]         [{ name|filename, error }] — parts that did not file
 * @param {object} [o.email]          { mail_message_id, from (display or address), from_email, to, subject }
 * @param {number} [o.by]             the acting user id (0 / null = client or automation)
 * @param {string} [o.actor]          the acting person's name, for the subject (comms / refile)
 * @param {string} [o.batchKey]       upload pages: the run's batch key → data.batch_key
 * @param {string} [o.closedBy]       upload pages: 'sweep' (a lost batch) → data.closed_by
 * @returns {Promise<{log_id:number}|null>}
 */
async function logDocsIntake(db, o = {}) {
  try {
    if (!ACTIONS.includes(o.action)) throw new Error(`unknown action "${o.action}"`);
    if (!SOURCES.includes(o.source)) throw new Error(`unknown source "${o.source}"`);

    const all = (Array.isArray(o.files) ? o.files : []).map(fileEntry).filter(Boolean);
    const fileCount = Number.isInteger(o.fileCount) && o.fileCount >= all.length ? o.fileCount : all.length;
    if (!fileCount) return null;   // nothing arrived — nothing to say

    const caseId = o.caseId != null && o.caseId !== '' ? String(o.caseId) : null;
    const contactId = o.contactId != null && o.contactId !== '' && Number.isFinite(Number(o.contactId))
      ? Number(o.contactId) : null;
    const link = caseId ? { link_type: 'case', link_id: caseId }
      : contactId ? { link_type: 'contact', link_id: String(contactId) }
        : null;
    if (!link) return null;   // see header: an unknown sender's Unsorted files get their row on refile

    const email = o.email && typeof o.email === 'object' ? o.email : null;
    const to = email ? firstAddress(email.to) : null;
    const fromLabel = email ? (str(email.from, 200) || str(email.from_email, 200)) : null;

    const data = {
      action: o.action,
      source: o.source,
      contact_id: contactId,
      file_count: fileCount,
      files: all.slice(0, MAX_FILES),
      comment: o.comment ? String(o.comment).slice(0, MAX_COMMENT) : null,
      placement: o.placement || null,
      folder_path: str(o.folderPath, MAX_PATH),
    };
    const failed = (Array.isArray(o.failed) ? o.failed : [])
      .map(f => ({ name: str(f && (f.name ?? f.filename), MAX_NAME), error: str(f && f.error, MAX_ERROR) }))
      .filter(f => f.name);
    if (failed.length) data.failed = failed.slice(0, MAX_FILES);
    if (o.batchKey) data.batch_key = str(o.batchKey, MAX_BATCH_KEY);
    if (CLOSED_BY.includes(o.closedBy)) data.closed_by = o.closedBy;
    if (email) {
      data.email = {
        mail_message_id: email.mail_message_id != null ? Number(email.mail_message_id) : null,
        from: str(email.from_email || email.from, 255),
        to,
        subject: str(email.subject, 255),
      };
    }

    const by = Number(o.by) > 0 ? Number(o.by) : 0;
    const subject = subjectFor({
      action: o.action, source: o.source, count: fileCount,
      actor: o.actor ? String(o.actor).slice(0, 80) : null, from: fromLabel, to,
    });

    return await require('./logService').createLogEntry(db, {   // lazy (convention: reached from internal_functions)
      type: 'docs',
      ...link,
      by,
      data: JSON.stringify(data),
      subject,
      direction: 'incoming',
    });
  } catch (err) {
    console.error(`[DOCS LOG] ${o && o.source}/${o && o.action} for ${o && (o.caseId || o.contactId)}: ${err && err.message}`);
    return null;
  }
}

module.exports = {
  logDocsIntake,
  subjectFor,
  SOURCES,
  ACTIONS,
  MAX_FILES,
  // exported for tests
  _firstAddress: firstAddress,
  _fileEntry: fileEntry,
};
