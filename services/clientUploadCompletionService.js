// services/clientUploadCompletionService.js
//
/**
 * CLIENT UPLOAD — WHAT HAPPENS AFTER THE FILES LAND. The one post-200 phase
 * behind both upload pages:
 *
 *   docreq   public/docReq.html   → POST /api/public/upload-complete        (routes/api.checklists.js)
 *   portal   portal docs page     → POST /api/portal/cases/:id/docs/upload-complete (portalDocsService)
 *
 * Fred, 2026-11-19: the four client-document doors (these two, the docs@ email
 * automation, Comms → File) should "all do the same thing". The email doors
 * already had the richer half — one reviewer, a notice with a link on every
 * file and the case's open Docs Needed items, a `docs` case-log row — so this
 * service gives the upload doors the same, out of the same parts:
 *
 *   1. WHERE          uploadTargetService.inspectUploadDestination — the server's
 *                     own answer (case folder / unsorted), never the client's
 *   2. WHAT LANDED    documentIngestService.registerLandedInFolder — the folder
 *                     listed, recent files registered + linked (Documents S4);
 *                     its folder_path is what the notice links to
 *   3. THE NOTICE     emailAttachmentNotice.render(kind:'upload') — the email
 *                     notice's frame with upload nouns; each reported file links
 *                     to itself when it can be matched to a registered file (the
 *                     folder link opened on it), plus the Docs Needed block
 *                     (emailAttachmentFilingService.docsChecklist)
 *   4. WHO            docsReviewerService.resolveReviewer — `email_attachments_reviewer`,
 *                     the same person every door tells. Unset ⇒ no email, a
 *                     console warning, everything else still happens.
 *   5. THE LOG ROW    docsIntakeLog — the `docs` row (client_upload / docreq|portal)
 *   6. THE TASK       uploadTargetService.raiseUnsortedUploadTask when the files
 *                     went to the bin
 *
 * NEVER THROWS past its own step: every step self-catches, the files are in
 * Dropbox either way. Returns the gathered pieces for tests and callers.
 *
 * Matching reported names to registered files is best-effort and advisory:
 * autorename makes "statement.pdf" land as "statement (1).pdf", so an unmatched
 * name simply has no link. The notice's file list is the CLIENT's list (what
 * they said they sent, capped by the route), never the folder's — a staffer's
 * own file in the same folder must not appear as the client's.
 *
 * Per-file reporting + lost-batch recovery (docs intake S3 — the client
 * closing the tab before upload-complete, Turner 2026-07-28):
 * services/clientUploadBatchService calls this with the server's own list —
 * the landed files merged with the page's (the page finished, closedBy
 * 'client'), or what had landed when the batch went quiet (closedBy 'sweep':
 * the notice says the page closed early). `files` is whatever the caller
 * trusts; `batchKey` rides into the log row for forensics.
 */

'use strict';

const SOURCES = Object.freeze({
  docreq: { title: 'Documents Needed page', reason: 'Uploaded through the Documents Needed page.' },
  portal: { title: 'Client portal', reason: 'Uploaded through the client portal.' },
});

const SUBJECT_PREFIX = 'Client upload — ';

// Lazy requires (convention: this is reached from route side-effect phases).
const uploadTarget = () => require('./uploadTargetService');
const ingest = () => require('./documentIngestService');
const notice = () => require('./emailAttachmentNotice');
const filing = () => require('./emailAttachmentFilingService');
const reviewer = () => require('./docsReviewerService');
const docsLog = () => require('./docsIntakeLog');
const storage = () => { const s = require('./documentSourceService'); return s.get(s.configured()); };

function previewLink(folderLink, name) {
  return `${folderLink}${String(folderLink).includes('?') ? '&' : '?'}preview=${encodeURIComponent(name)}`;
}
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * @param {object} db
 * @param {object} o
 * @param {'docreq'|'portal'} o.source
 * @param {string} o.caseId
 * @param {number} [o.contactId]        the uploader (portal knows; docReq does not)
 * @param {string} [o.clientName]       the uploader's name (portal) — else the case's Primary contact
 * @param {Array}  o.files              [{ name, item_id?, item_name? }] — the client's list, already capped
 * @param {number} [o.fileCount]        the true count when the list was capped
 * @param {string} [o.comment]          the client's note
 * @param {'client'|'sweep'} [o.closedBy]  'sweep' = the page never finished (a lost batch the
 *                                      cron reported) — the notice and the log row say so
 * @param {string} [o.batchKey]         the upload run's key (clientUploadBatchService) — log data only
 * @returns {Promise<{dest, registered, reviewer, sent: boolean, subject: string|null, log, warnings: string[]}>}
 */
async function completeClientUpload(db, o = {}) {
  const src = SOURCES[o.source];
  if (!src) throw new Error(`completeClientUpload: unknown source "${o.source}"`);
  const caseId = String(o.caseId || '');
  const files = (Array.isArray(o.files) ? o.files : [])
    .map(f => (f && typeof f === 'object' ? { name: String(f.name ?? ''), item_id: f.item_id ?? null, item_name: f.item_name ?? null } : { name: String(f ?? ''), item_id: null, item_name: null }))
    .filter(f => f.name);
  const fileCount = Number.isInteger(o.fileCount) && o.fileCount >= files.length ? o.fileCount : files.length;
  const omitted = fileCount - files.length;
  const comment = o.comment == null ? '' : String(o.comment);
  const swept = o.closedBy === 'sweep';
  const warnings = [];
  const out = { dest: null, registered: null, reviewer: null, sent: false, subject: null, log: null, warnings };

  // ── the case and the client ──
  let caseRow = null;
  try {
    [[caseRow]] = await db.query(
      `SELECT c.case_id, COALESCE(c.case_number_full, c.case_number, c.case_id) AS case_display FROM cases c WHERE c.case_id = ?`, [caseId]);
  } catch (err) { warnings.push(`case read failed: ${err.message}`); }
  if (!caseRow) return out;   // the case vanished — nothing to notify about
  let clientName = o.clientName ? String(o.clientName) : '';
  if (!clientName) {
    try {
      const [[p]] = await db.query(
        `SELECT co.contact_name FROM contacts co JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
          WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary' LIMIT 1`, [caseId]);
      clientName = (p && p.contact_name) || '';
    } catch (err) { warnings.push(`client read failed: ${err.message}`); }
  }
  clientName = clientName || 'Unknown client';

  // ── 1. where ──
  let dest = null;
  try { dest = await uploadTarget().inspectUploadDestination(db, caseId); } catch (err) { warnings.push(`destination inspection failed: ${err.message}`); }
  out.dest = dest;
  const unsorted = !!(dest && dest.placement === 'unsorted');

  // ── 2. what landed (registered + linked; the folder it listed) ──
  let reg = null;
  if (dest) {
    const target = unsorted ? { folderPath: dest.path } : { sharedLink: dest.sharedLink, subfolder: 'Client Uploads' };
    const links = [{ type: 'case', id: caseId }];
    if (o.contactId != null) links.push({ type: 'contact', id: o.contactId });
    reg = await ingest().registerLandedInFolder(db, { ...target, links, createdBy: null, eventSource: o.source === 'portal' ? 'portal_upload' : 'client_upload' });
    if (reg && reg.registered) console.log(`[UPLOAD ${o.source}] registered ${reg.registered} document(s) for case ${caseId}`);
  }
  out.registered = reg;
  const folderPath = (reg && reg.folder_path) || (unsorted ? dest.path : null);
  let listedLink = null;   // a link to THE FOLDER LISTED — the only link a per-file preview= works on
  if (folderPath) {
    try { listedLink = await storage().ensureSharedLink(db, folderPath); } catch (err) { warnings.push(`folder link: ${err.message}`); }
  }
  // The folder button: the listed folder when it has a link, else the case folder itself (as before)
  const folderLink = listedLink || (dest && !unsorted && dest.sharedLink) || null;

  // ── match the client's names to what is on disk (advisory: links + sizes) ──
  const byName = new Map();
  for (const d of (reg && reg.documents) || []) if (d && d.name) byName.set(lower(d.name), d);
  const noticeFiles = files.map(f => {
    const d = byName.get(lower(f.name));
    const entry = { part: null, filename: f.name, filed_name: (d && d.name) || f.name, status: 'filed', bytes: d && d.size != null ? Number(d.size) : null, path: (d && (d.path || d.path_lower)) || null, document_id: d ? Number(d.id) : null, note: f.item_name || null };
    if (d && listedLink) entry.link = previewLink(listedLink, d.name);
    return entry;
  });

  // ── 3. the notice ──
  const base = filing().appUrl();
  const shell = require('../lib/shellLinks');   // lazy (convention)
  const docsChecklist = await filing().docsChecklist(db, caseId, base, warnings);
  const result = {
    from: { name: clientName, email: null },
    subject: null,
    date: new Date(),
    text: comment,
    match: {
      reason: swept
        ? `${src.reason} The client's page closed before it finished — this is what had landed by then.`
        : src.reason,
      candidates: [],
    },
    placement: unsorted ? 'unsorted' : 'case',
    case_id: caseId,
    folder_path: folderPath,
    folder_link: folderLink,
    app_url: base,
    case_link: shell.caseLink(base, caseId),
    files: noticeFiles,
    skipped: omitted > 0 ? [{ filename: `… and ${omitted} more file${omitted === 1 ? '' : 's'} not listed`, reason: 'not_listed' }] : [],
    docs_checklist: docsChecklist,
  };
  const n = notice().render({ result, kind: 'upload', subjectPrefix: SUBJECT_PREFIX, title: src.title });
  out.subject = n.subject;

  // ── 4. who ──
  let who = null;
  try { who = await reviewer().resolveReviewer(db); } catch (err) { warnings.push(`reviewer read failed: ${err.message}`); }
  out.reviewer = who;
  if (who) {
    try {
      const { cfg } = require('../lib/firmConfig');   // lazy (convention)
      await require('./emailService').sendEmail(db, {
        from: cfg('email_automations') || 'automations@4lsg.com',
        to: who.email, subject: n.subject, html: n.html, text: n.text,
      });
      out.sent = true;
    } catch (err) {
      console.error(`[UPLOAD ${o.source}] notice email failed:`, err.message);
      warnings.push(`notice email failed: ${err.message}`);
    }
  } else {
    console.warn(`[UPLOAD ${o.source}] notice skipped — ${reviewer().REVIEWER_SETTING} unset or not an active user with an email (notifications off)`);
  }

  // ── 5. the log row ──
  out.log = await docsLog().logDocsIntake(db, {
    action: 'client_upload',
    source: o.source,
    caseId,
    contactId: o.contactId,
    files: noticeFiles.map(f => ({ name: f.filed_name, path: f.path, document_id: f.document_id, item_id: files.find(x => x.name === f.filename)?.item_id ?? null, item_name: f.note })),
    fileCount,
    comment: comment || null,
    placement: dest ? dest.placement : null,
    folderPath: unsorted ? dest.path : null,
    batchKey: o.batchKey || undefined,
    closedBy: swept ? 'sweep' : undefined,
  });

  // ── 6. the task ──
  if (unsorted) {
    await uploadTarget().raiseUnsortedUploadTask(db, { caseId, clientName, fileCount, path: dest.path, link: dest.link });
  }
  return out;
}

module.exports = { completeClientUpload, SUBJECT_PREFIX, SOURCES, _previewLink: previewLink };
