// services/emailAttachmentCommsService.js
//
/**
 * FILE EMAIL ATTACHMENTS FROM COMMS — email attachments S3
 * (ref/EMAIL_ATTACHMENTS_DESIGN.md §9). Backs three routes in
 * routes/api.mail.js; the UI is public/comms.html's "File attachments" dialog.
 *
 * WHY (live, 2026-11-10): over 60 days about 69 client emails with files went
 * to staff inboxes and only 37 to docs@ — most client documents never reach
 * the docs@ automation. Any mailbox, any sender: a person picks the case and
 * the files; the docs@ engine (emailAttachmentFilingService) does the filing,
 * so the folders (<case folder>/Client Uploads/Emailed YYMMDD), names,
 * duplicate guard and registry (mail_attachment_filings) are the same.
 *
 *   preview(db, userId, {message_ids, case_id?})
 *       Read-only. Per email: every attachment, classified —
 *         file      on the client-upload allowlist → ticked unless filed or a duplicate
 *         optional  any other type a person may file (not blocked) → unticked
 *         skip      inline signature image, too large, or BLOCKED (never filed)
 *       + `filed` (already in the registry, and where), `duplicate` (the same
 *       name and encoded size already filed to the target case, or earlier in
 *       this selection), `confirm` ('type' | 'size' — the firm's confirm
 *       settings), the matcher's verdict, and `move` (parts already filed
 *       ELSEWHERE — Unsorted or another case — that filing here can move).
 *       Target case = case_id, else the one case every email matches. An
 *       email the matcher can place nowhere (no case, no candidates — an
 *       Adobe Sign notice) offers the cases of clients whose first AND last
 *       name both appear in its subject (subjectNameCases) — candidates
 *       only, never the target.
 *   caseFolders(db, userId, {case_id})
 *       The case Dropbox folder's subfolders (one recursive listing, folders
 *       only, ≤ FOLDERS_DEPTH levels) — the dialog's folder choices.
 *   fileOne(db, userId, messageId, {case_id, parts, confirm?, move?, link?, batch?, folder?})
 *       One email: moves its elsewhere-filed parts here when asked
 *       (refileMessageAttachments — the whole email's filed parts go
 *       together), files the picked parts, links the email to the case
 *       (mailReadService.caseLink — the "Link to case" action) when asked.
 *       One request per email so the dialog shows progress and a retry
 *       re-runs one email (the registry makes every part idempotent).
 *       `folder` = a folder inside the case folder, taken EXACTLY (leading
 *       spaces are the firm's sort order — filing exactFolder refuses what
 *       could leave the case folder); absent = Client Uploads/Emailed YYMMDD.
 *       With `batch`, the result is queued (mail_attachment_notices,
 *       digest_key comms-<batch>) for the review notice.
 *   sendNotice(db, userId, {batch})
 *       Claims the batch's queued results and sends the
 *       `email_attachments_reviewer` user (SB) ONE notice per sender in the
 *       batch — the burst digest's renderer (emailAttachmentDigestService
 *       .digestOutput: one email = the single-email notice), which speaks for
 *       one sender. Not sent when the reviewer is the one filing, or no
 *       reviewer is set (the rows are claimed all the same). A dialog closed
 *       before this call leaves its rows unclaimed: no notice for that batch.
 *
 * ACCESS: anyone who can READ the email in Comms (mailReadService.loadVisible —
 * a mailbox grant, SU, the attorney read bypass, or an alias slice) may file
 * its attachments (Fred, 2026-11-10) — the rule the per-file Save to case
 * button always had. An email the caller cannot read is a 404, like every
 * Comms read (no existence oracle).
 *
 * WHAT A PERSON MAY FILE (Fred, 2026-11-10; mailAttachmentService
 * staffFilingPolicy): any type but the blocked ones
 * (`email_attachments_blocked_ext`; blank = programs, scripts, installers,
 * disk images, shortcuts). A type on `email_attachments_confirm_ext` (blank =
 * every type outside the client-upload list) or a file over
 * `email_attachments_confirm_mb` (blank = 15, 0 = never) needs a second
 * confirmation — ENFORCED HERE, not only in the dialog: a fileOne whose picked
 * part needs one and is not in `confirm` answers 409 {needs_confirmation}.
 */

'use strict';

const MAX_MESSAGES = 50;
const CANDIDATES_MAX = 12;
const NAME_CASES_MAX = 8;        // cases offered from names in one subject
const NAME_TOKENS_MAX = 40;
const FOLDERS_DEPTH = 4;         // levels of subfolders offered under the case folder
const FOLDERS_MAX = 400;
const FOLDERS_LIST_MAX = 4000;   // entries read (files too — list_folder has no folders-only mode)
const OPEN_STAGES = ['Open', 'Pending', 'Filed'];
const BATCH_RE = /^[A-Za-z0-9_-]{8,30}$/;
const CASE_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;
const PART_RE = /^\d{1,4}(?:\.\d{1,4}){0,15}$/;
const REVIEWER_SETTING = 'email_attachments_reviewer';
const NOTICE_PREFIX = 'Filed from Comms — ';
const BATCH_KEY = (batch) => `comms-${batch}`;

// Lazy requires (convention): these load the mail and filing graphs.
const reads = () => require('./mailbox/mailReadService');
const attachments = () => require('./mailbox/mailAttachmentService');
const filing = () => require('./emailAttachmentFilingService');
const caseMatch = () => require('./emailCaseMatchService');
const digest = () => require('./emailAttachmentDigestService');

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

function onlyKeys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'request body must be a JSON object');
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw httpError(400, `unknown field "${k}"`);
  }
}

function caseIdOf(v, { required }) {
  const s = typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : '');
  if (!s) {
    if (required) throw httpError(400, 'case_id is required');
    return null;
  }
  if (!CASE_ID_RE.test(s)) throw httpError(400, 'case_id is malformed');
  return s;
}

function partsOf(v, label) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw httpError(400, `${label} must be an array of part ids`);
  if (v.length > 100) throw httpError(400, `${label}: at most 100 parts`);
  const out = [];
  for (const p of v) {
    const s = String(p);
    if (!PART_RE.test(s)) throw httpError(400, `${label}: "${s.slice(0, 20)}" is not a part id`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function boolOf(v, label) {
  if (v == null) return false;
  if (typeof v !== 'boolean') throw httpError(400, `${label} must be true or false`);
  return v;
}

async function caseRow(db, caseId) {
  const [[c]] = await db.query(
    'SELECT case_id, case_number, case_number_full, case_type, case_stage FROM cases WHERE case_id = ? LIMIT 1', [caseId]);
  return c || null;
}

function shapeCase(c) {
  return c ? {
    case_id: c.case_id,
    case_number: c.case_number_full || c.case_number || null,
    case_type: c.case_type || null,
    case_stage: c.case_stage || null,
  } : null;
}

async function userName(db, userId) {
  const [[u]] = await db.query('SELECT user_name FROM users WHERE user = ? LIMIT 1', [Number(userId)]);
  return (u && u.user_name) || `user ${userId}`;
}

/** The review-notice recipient: the setting's user, active, with an email — else null. */
async function resolveReviewer(db) {
  const { getSettings } = require('./settingsService');   // lazy (convention)
  const vals = await getSettings(db, [REVIEWER_SETTING]);
  const id = parseInt(String(vals[REVIEWER_SETTING] ?? '').trim(), 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[u]] = await db.query(
    "SELECT user, user_name, email FROM users WHERE user = ? AND user_auth LIKE 'authorized%' LIMIT 1", [id]);
  if (!u || !u.email || !String(u.email).includes('@')) return null;
  return { user_id: Number(u.user), name: u.user_name || `user ${u.user}`, email: String(u.email).trim() };
}

function messageText(msg) {
  return require('./mailbox/mailboxIngestService').emitText(msg.body_text, msg.body_html).text;   // lazy (convention)
}

/** The registry's word for where a part went, for the UI. */
function filedOf(r) {
  return {
    status: r.status,
    placement: r.placement || null,
    case_id: r.link_type === 'case' && r.link_id != null ? String(r.link_id) : null,
    link_type: r.link_type || null,
    path: r.dropbox_path || null,
    filed_at: r.filed_at instanceof Date ? r.filed_at.toISOString() : (r.filed_at || null),
  };
}

const dupKey = (filename, size) => `${String(filename || '').trim().toLowerCase()}|${Number(size) || 0}`;

function attachmentList(msg) {
  return (Array.isArray(msg && msg.attachments) ? msg.attachments : [])
    .filter(p => p && p.part != null && PART_RE.test(String(p.part)));
}

/**
 * Files already filed to the case, keyed by name + ENCODED size (the size the
 * mail store records for a part — what a second email carrying the same file
 * shows; the registry's own size is the decoded byte count, which a part's
 * metadata cannot be compared with).
 */
async function filedToCase(db, caseId) {
  const [rows] = await db.query(
    `SELECT mail_message_id, part, filed_at, dropbox_path FROM mail_attachment_filings
      WHERE status = 'filed' AND link_type = 'case' AND link_id = ?`, [caseId]);
  const keys = new Map();
  if (!rows.length) return keys;
  const ids = [...new Set(rows.map(r => Number(r.mail_message_id)))];
  const [msgs] = await db.query('SELECT id, attachments FROM mail_messages WHERE id IN (?)', [ids]);
  const parts = new Map();
  for (const m of msgs) {
    let list = m.attachments;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
    for (const p of Array.isArray(list) ? list : []) if (p && p.part != null) parts.set(`${m.id}:${p.part}`, p);
  }
  for (const r of rows) {
    const p = parts.get(`${r.mail_message_id}:${r.part}`);
    if (!p) continue;
    const k = dupKey(p.filename, p.size);
    if (!keys.has(k)) {
      keys.set(k, {
        mail_message_id: Number(r.mail_message_id),
        filed_at: r.filed_at instanceof Date ? r.filed_at.toISOString() : (r.filed_at || null),
        path: r.dropbox_path || null,
      });
    }
  }
  return keys;
}

/**
 * NAMES IN THE SUBJECT (Fred, 2026-11-10): for an email the matcher can place
 * nowhere, the cases of clients (Primary / Secondary) whose first AND last
 * name are both words of the subject — "… between Stuart Sandweiss and
 * michele boren is Signed and Filed!" → Michele Boren's cases. Suggestions
 * only: never the target, never ticked. Not the firm's own people: a contact
 * named exactly like a staff user, or holding a firm-address email
 * (emailCaseMatchService.isFirmSender), is left out — the attorney's name is
 * in every e-sign subject. Whole words, case-blind (general_ci), open cases
 * first.
 * @returns {Promise<object[]>} [{case_id, case_number, case_type, case_stage, why:'subject_name', contact_name}]
 */
async function subjectNameCases(db, subject) {
  const words = String(subject || '').toLowerCase().match(/[a-z\u00c0-\u024f][a-z\u00c0-\u024f'\u2019-]*/g) || [];
  const tokens = [...new Set(words.map(w => w.replace(/['\u2019-]+$/, '')).filter(w => w.length >= 2))].slice(0, NAME_TOKENS_MAX);
  if (tokens.length < 2) return [];
  const [people] = await db.query(
    `SELECT c.contact_id, c.contact_fname, c.contact_lname FROM contacts c
      WHERE c.contact_fname IN (?) AND c.contact_lname IN (?)
        AND c.contact_fname <> '' AND c.contact_lname <> ''
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_fname = c.contact_fname AND u.user_lname = c.contact_lname)
      LIMIT 20`, [tokens, tokens]);
  if (!people.length) return [];
  const ids = people.map(p => Number(p.contact_id));
  const [emails] = await db.query('SELECT contact_id, email FROM contact_emails WHERE contact_id IN (?)', [ids]);
  const firm = new Set();
  for (const e of emails) {
    if (!firm.has(Number(e.contact_id)) && await caseMatch().isFirmSender(db, e.email)) firm.add(Number(e.contact_id));
  }
  const keep = people.filter(p => !firm.has(Number(p.contact_id)));
  if (!keep.length) return [];
  const nameOf = new Map(keep.map(p => [Number(p.contact_id), `${p.contact_fname} ${p.contact_lname}`.trim()]));
  const [rows] = await db.query(
    `SELECT cr.case_relate_client_id AS contact_id, ca.case_id, ca.case_number, ca.case_number_full, ca.case_type, ca.case_stage
       FROM case_relate cr JOIN cases ca ON ca.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id IN (?) AND cr.case_relate_type IN ('Primary', 'Secondary')`,
    [[...nameOf.keys()]]);
  const seen = new Set();
  return rows
    .sort((a, b) => (OPEN_STAGES.includes(b.case_stage) - OPEN_STAGES.includes(a.case_stage)) || String(a.case_id).localeCompare(String(b.case_id)))
    .filter(r => !seen.has(r.case_id) && seen.add(r.case_id))
    .slice(0, NAME_CASES_MAX)
    .map(r => ({
      case_id: r.case_id,
      case_number: r.case_number_full || r.case_number || null,
      case_type: r.case_type || null,
      case_stage: r.case_stage || null,
      why: 'subject_name',
      contact_name: nameOf.get(Number(r.contact_id)) || null,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// caseFolders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The case folder's subfolders, for the dialog's folder choice: ONE recursive
 * Dropbox listing of the case's folder (cases.case_dropbox — the shared link
 * every upload resolves), folders only, relative to the case folder, at most
 * FOLDERS_DEPTH levels, names exactly as Dropbox shows them (leading spaces
 * kept). Any staff member: the same listing /api/dropbox/list gives.
 * @returns {Promise<{case_id, folders:string[], truncated:boolean, reason:null|'no_case_folder'|'unavailable', error?}>}
 */
async function caseFolders(db, userId, body) {
  onlyKeys(body, ['case_id']);
  const caseId = caseIdOf(body.case_id, { required: true });
  const [[c]] = await db.query('SELECT case_id, case_dropbox FROM cases WHERE case_id = ? LIMIT 1', [caseId]);
  if (!c) throw httpError(404, 'Case not found');
  const out = { case_id: c.case_id, folders: [], truncated: false, reason: null };
  if (!c.case_dropbox || !String(c.case_dropbox).trim()) return { ...out, reason: 'no_case_folder' };
  const dbx = require('./dropboxService');                 // lazy (convention)
  let listing;
  let root;
  try {
    const cred = await dbx._resolveCredential(db, {});
    root = String(await dbx.resolveLocation(db, cred, { sharedLink: String(c.case_dropbox).trim(), expectFolder: true }) || '');
    listing = await dbx.listFolder(db, { path: root, recursive: true, maxEntries: FOLDERS_LIST_MAX, credentialId: cred });
  } catch (err) {
    return { ...out, reason: 'unavailable', error: (err && err.message) || 'Dropbox did not answer' };
  }
  const rootLower = root.toLowerCase().replace(/\/+$/, '');
  const seen = new Set();
  const folders = [];
  for (const e of listing.entries || []) {
    if (!e || e['.tag'] !== 'folder') continue;
    const lower = String(e.path_lower || '');
    if (!lower.startsWith(`${rootLower}/`)) continue;
    const disp = String(e.path_display || '');
    const rel = disp.length === lower.length ? disp.slice(rootLower.length + 1) : lower.slice(rootLower.length + 1);
    if (!rel || rel.split('/').length > FOLDERS_DEPTH || seen.has(rel.toLowerCase())) continue;
    seen.add(rel.toLowerCase());
    folders.push(rel);
  }
  folders.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { ...out, folders: folders.slice(0, FOLDERS_MAX), truncated: !!listing.truncated || folders.length > FOLDERS_MAX };
}

// ─────────────────────────────────────────────────────────────────────────────
// preview
// ─────────────────────────────────────────────────────────────────────────────

async function preview(db, userId, body) {
  onlyKeys(body, ['message_ids', 'case_id']);
  const raw = body.message_ids;
  if (!Array.isArray(raw) || !raw.length) throw httpError(400, 'message_ids must be a non-empty array');
  if (raw.length > MAX_MESSAGES) throw httpError(400, `at most ${MAX_MESSAGES} emails at a time`);
  const ids = [...new Set(raw.map(Number))];
  if (ids.some(n => !Number.isSafeInteger(n) || n <= 0)) throw httpError(400, 'message_ids must be positive integers');
  const wantCase = caseIdOf(body.case_id, { required: false });

  const vis = new Map();
  for (const id of ids) vis.set(id, await reads().loadVisible(db, userId, id));   // 404 for any the caller cannot read
  const given = wantCase ? await caseRow(db, wantCase) : null;
  if (wantCase && !given) throw httpError(404, 'Case not found');

  const A = attachments();
  const policy = await A.staffFilingPolicy(db);
  const msgs = [];
  for (const id of ids) {
    const msg = await A.resolveMessage(db, { mail_message_id: id });
    if (msg) msgs.push(msg);
  }
  msgs.sort((a, b) => (new Date(a.date || 0) - new Date(b.date || 0)) || (a.id - b.id));

  const [reg] = await db.query(
    `SELECT mail_message_id, part, status, link_type, link_id, placement, dropbox_path, filed_at
       FROM mail_attachment_filings WHERE mail_message_id IN (?) AND status IN ('filed', 'filing')`,
    [msgs.length ? msgs.map(m => m.id) : [0]]);
  const regOf = (id, part) => reg.find(r => Number(r.mail_message_id) === Number(id) && String(r.part) === String(part));

  // the matcher's verdict per email (the same rules docs@ uses)
  const R = reads();
  const matches = new Map();
  const named = new Map();   // email → cases of clients named in its subject (only when the matcher found nothing)
  for (const msg of msgs) {
    const m = await caseMatch().matchCase(db, { fromEmail: R.senderOf(msg.from_addr), subject: msg.subject, text: messageText(msg) });
    matches.set(msg.id, m);
    if (!m.case_id && !(m.candidates || []).length) named.set(msg.id, await subjectNameCases(db, msg.subject));
  }

  // the target: the case asked for, else the ONE case every email with files matches
  let target = given;
  let suggested = false;
  if (!target) {
    const withFiles = msgs.filter(m => attachmentList(m).length);
    const hits = new Set(withFiles.map(m => (matches.get(m.id) || {}).case_id || null));
    if (withFiles.length && hits.size === 1 && !hits.has(null)) {
      target = await caseRow(db, [...hits][0]);
      suggested = !!target;
    }
  }
  const candidates = new Map();
  if (target) candidates.set(target.case_id, shapeCase(target));
  for (const m of matches.values()) {
    for (const c of m.candidates || []) {
      if (candidates.size >= CANDIDATES_MAX) break;
      if (!candidates.has(c.case_id)) {
        candidates.set(c.case_id, { case_id: c.case_id, case_number: c.case_number || null, case_type: c.case_type || null, case_stage: c.case_stage || null, why: 'match' });
      }
    }
  }
  for (const list of named.values()) {
    for (const c of list) {
      if (candidates.size >= CANDIDATES_MAX) break;
      if (!candidates.has(c.case_id)) candidates.set(c.case_id, c);
    }
  }

  const already = target ? await filedToCase(db, target.case_id) : new Map();
  const seen = new Map();   // dupKey → mail_message_id, earlier in THIS selection
  const out = [];
  for (const msg of msgs) {
    const scan = A.fileableParts(msg, { staffPick: false, blocked: policy.blocked });
    const parts = [];
    for (const p of attachmentList(msg)) {
      const part = String(p.part);
      const f = scan.files.find(x => x.part === part);
      const sk = f ? null : scan.skipped.find(x => x.part === part);
      const r = regOf(msg.id, part);
      const entry = {
        part,
        filename: (f && f.filename) || (sk && sk.filename) || p.filename || `attachment-${part}`,
        mime: p.mime || null,
        bytes: Math.round((Number(p.size) || 0) * A.DECODED_RATIO),
        kind: f ? 'file' : (sk && sk.optional ? 'optional' : 'skip'),
        // inline_image | too_large | blocked (the firm's list) | type_not_allowed (no usable type)
        reason: sk && !sk.optional ? (sk.blocked ? 'blocked' : sk.reason) : null,
        confirm: null,
        filed: r ? filedOf(r) : null,
        duplicate: null,
        checked: false,
      };
      if (entry.kind !== 'skip') {
        entry.confirm = A.confirmReason(f || sk, policy);
        const k = dupKey(p.filename, p.size);
        if (!r && already.has(k)) entry.duplicate = { ...already.get(k), in_selection: false };
        else if (!r && seen.has(k)) entry.duplicate = { mail_message_id: seen.get(k), in_selection: true };
        if (!r && !seen.has(k)) seen.set(k, msg.id);
        entry.checked = entry.kind === 'file' && !r && !entry.duplicate;
      }
      parts.push(entry);
    }
    const elsewhere = reg.filter(r => Number(r.mail_message_id) === Number(msg.id) && r.status === 'filed' &&
      !(target && r.link_type === 'case' && String(r.link_id) === target.case_id));
    const m = matches.get(msg.id) || {};
    const v = vis.get(Number(msg.id));
    out.push({
      id: Number(msg.id),
      // the box the reader sees it in: an alias slice's id when that is how
      // they read it (the part route serves a slice row under the alias id)
      mailbox_id: v && v.via_alias ? Number(v.via_alias.id) : Number(msg.mailbox_id),
      from: msg.from_addr || null,
      subject: msg.subject || '',
      date: msg.date instanceof Date ? msg.date.toISOString() : (msg.date || null),
      match: { case_id: m.case_id || null, method: m.method || null, flag: m.flag || null, reason: m.reason || null },
      named_cases: (named.get(msg.id) || []).map(c => c.case_id),
      parts,
      move: elsewhere.length ? {
        count: elsewhere.length,
        unsorted: elsewhere.filter(r => r.placement === 'unsorted').length,
        case_ids: [...new Set(elsewhere.filter(r => r.link_type === 'case' && r.placement !== 'unsorted').map(r => String(r.link_id)))],
        // Unsorted is where an undecided email waits: moving it is the point.
        // Out of another CASE is a decision — offered, never ticked.
        checked: !!target && elsewhere.every(r => r.placement === 'unsorted'),
      } : null,
    });
  }

  const reviewer = await resolveReviewer(db);
  return {
    case: shapeCase(target),
    suggested,
    candidates: [...candidates.values()],
    messages: out,
    reviewer: reviewer ? { user_id: reviewer.user_id, name: reviewer.name, is_you: reviewer.user_id === Number(userId) } : null,
    policy: {
      confirm_mb: Math.round(policy.confirmBytes / (1024 * 1024)),
      confirm_types: policy.confirmExt ? [...policy.confirmExt] : null,
    },
    max_messages: MAX_MESSAGES,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fileOne
// ─────────────────────────────────────────────────────────────────────────────

async function fileOne(db, userId, messageId, body) {
  onlyKeys(body, ['case_id', 'parts', 'confirm', 'move', 'link', 'batch', 'folder']);
  const caseId = caseIdOf(body.case_id, { required: true });
  const picked = partsOf(body.parts, 'parts');
  const confirmed = partsOf(body.confirm, 'confirm');
  const move = boolOf(body.move, 'move');
  const link = boolOf(body.link, 'link');
  const batch = body.batch == null || body.batch === '' ? null : String(body.batch);
  if (batch && !BATCH_RE.test(batch)) throw httpError(400, 'batch must be 8-30 letters, digits, _ or -');
  let folder = null;
  if (body.folder != null && body.folder !== '') {
    try { folder = filing().exactFolder(body.folder); } catch (err) { throw httpError(400, err.message); }
  }

  const v = await reads().loadVisible(db, userId, messageId);
  const cs = await caseRow(db, caseId);
  if (!cs) throw httpError(404, 'Case not found');
  const A = attachments();
  const msg = await A.resolveMessage(db, { mail_message_id: v.id });
  if (!msg) throw httpError(404, 'Message not found');

  // Every picked part: on this email, fileable by a person, confirmed when it must be.
  const policy = await A.staffFilingPolicy(db);
  const scan = A.fileableParts(msg, { staffPick: true, blocked: policy.blocked });
  const onEmail = new Set(attachmentList(msg).map(p => String(p.part)));
  const needs = [];
  for (const part of picked) {
    if (!onEmail.has(part)) throw httpError(400, `part ${part} is not an attachment of this email`);
    const f = scan.files.find(x => x.part === part);
    if (!f) {
      const sk = scan.skipped.find(x => x.part === part) || {};
      const why = sk.reason === 'inline_image' ? 'it is an inline signature image'
        : sk.reason === 'too_large' ? 'it is too large to file'
          : sk.blocked ? 'its type is on the firm\'s never-filed list'
            : 'it has no file type YisraCase can name';
      throw httpError(422, `${sk.filename || `part ${part}`} cannot be filed: ${why}.`);
    }
    const reason = A.confirmReason(f, policy);
    if (reason && !confirmed.includes(part)) needs.push({ part, filename: f.filename, why: reason });
  }
  if (needs.length) {
    throw httpError(409, `${needs.length === 1 ? 'This file needs' : 'These files need'} a second confirmation: ` +
      needs.map(n => n.filename).join(', '), { expose: true, needs_confirmation: needs });
  }

  const [filedRows] = await db.query(
    "SELECT part, link_type, link_id, placement FROM mail_attachment_filings WHERE mail_message_id = ? AND status = 'filed'", [msg.id]);
  const elsewhere = filedRows.filter(r => !(r.link_type === 'case' && String(r.link_id) === cs.case_id));
  if (!picked.length && !(move && elsewhere.length)) throw httpError(400, 'Nothing to file: pick a file, or move what was filed elsewhere.');

  const name = await userName(db, userId);
  const F = filing();
  let refiled = null;
  if (move && elsewhere.length) {
    const r = await F.refileMessageAttachments(db, { mailMessageId: msg.id, caseId: cs.case_id, filedBy: Number(userId), folder: folder || undefined });
    refiled = { moved: r.moved.length, already_there: r.already_there.length, failed: r.failed, warnings: r.warnings };
  }

  // The parts to report: the picks, plus — after a move — everything already
  // filed for the email (they come back 'already_filed', now in this case).
  const report = [...picked];
  if (refiled) for (const r of filedRows) if (!report.includes(String(r.part))) report.push(String(r.part));
  const result = await F.fileMessageAttachments(db, {
    ref: { mail_message_id: msg.id },
    target: 'case',
    caseId: cs.case_id,
    filedBy: Number(userId),
    parts: report,
    folder: folder || undefined,
    reason: `Filed to case ${cs.case_id} by ${name} from Comms.`,
    digestKey: batch ? BATCH_KEY(batch) : undefined,
    noticeSubjectPrefix: NOTICE_PREFIX,
    noticeTitle: `Filed by ${name}`,
  });

  let linked = false;
  let logId = null;
  let linkError = null;
  if (link) {
    try {
      const l = await reads().caseLink(db, userId, msg.id, { case_id: cs.case_id });
      linked = true;
      logId = l && l.log_id != null ? Number(l.log_id) : null;
    } catch (err) {
      linkError = (err && err.message) || 'the email could not be linked';
    }
  }

  return {
    id: Number(msg.id),
    case: shapeCase(cs),
    files: result.files,
    skipped: result.skipped.filter(s => s.reason !== 'not_selected'),
    folder_path: result.folder_path,
    folder_link: result.folder_link,
    warnings: result.warnings || [],
    refiled,
    linked,
    log_id: logId,   // the case-link's log row (public/js/yc-sync.js announces it, as for case-link)
    link_error: linkError,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendNotice
// ─────────────────────────────────────────────────────────────────────────────

async function sendNotice(db, userId, body) {
  onlyKeys(body, ['batch']);
  const batch = String(body.batch == null ? '' : body.batch);
  if (!BATCH_RE.test(batch)) throw httpError(400, 'batch must be 8-30 letters, digits, _ or -');
  const key = BATCH_KEY(batch);
  const { withTransaction } = require('../lib/withTransaction');   // lazy (convention)

  // Only emails the caller can read go in — checked BEFORE anything is
  // claimed: a batch id is not a capability (404, like every Comms read).
  const [queued] = await db.query(
    `SELECT mail_message_id FROM mail_attachment_notices
      WHERE digest_key = ? AND notified_at IS NULL AND result IS NOT NULL`, [key]);
  if (!queued.length) return { sent: false, reason: 'nothing_to_report' };
  const visible = queued.map(r => Number(r.mail_message_id));
  for (const id of visible) await reads().loadVisible(db, userId, id);

  // Claim them in ONE locking read. One notice per SENDER (the digest's
  // renderer speaks for one sender: "From: …", the subject's name) — the
  // usual batch is one client's run of emails, so one notice; a batch across
  // senders sends one each. Rows sharing digest_of are one notice.
  const groups = await withTransaction(db, async (conn) => {
    const [rows] = await conn.query(
      `SELECT mail_message_id, sender FROM mail_attachment_notices
        WHERE digest_key = ? AND mail_message_id IN (?) AND notified_at IS NULL AND result IS NOT NULL
        ORDER BY ingested_at, mail_message_id FOR UPDATE`, [key, visible]);
    const bySender = new Map();
    for (const r of rows) {
      if (!bySender.has(r.sender)) bySender.set(r.sender, []);
      bySender.get(r.sender).push(Number(r.mail_message_id));
    }
    const out = [];
    for (const ids of bySender.values()) {
      const of = Math.min(...ids);
      await conn.query(
        'UPDATE mail_attachment_notices SET notified_at = UTC_TIMESTAMP(), digest_of = ? WHERE digest_key = ? AND mail_message_id IN (?)',
        [of, key, ids]);
      out.push({ of, ids });
    }
    return out;
  }, { retries: 1 });
  const count = groups.reduce((a, g) => a + g.ids.length, 0);
  if (!count) return { sent: false, reason: 'nothing_to_report' };   // another request claimed them first

  const reviewer = await resolveReviewer(db);
  if (!reviewer) return { sent: false, reason: 'no_reviewer', count };
  if (reviewer.user_id === Number(userId)) return { sent: false, reason: 'you_are_the_reviewer', count };

  const D = digest();
  const { cfg } = require('../lib/firmConfig');            // lazy (convention)
  const from = cfg('email_automations') || 'automations@4lsg.com';
  let notices = 0;
  for (const g of groups) {
    const rows = await D.burstRows(db, key, g.of);
    if (!rows.length) continue;
    const out = await D.digestOutput(db, rows);
    await require('./emailService').sendEmail(db, {         // lazy (convention)
      from, to: reviewer.email, subject: out.notice_subject, html: out.notice_html, text: out.notice_text,
    });
    notices++;
  }
  return { sent: notices > 0, to: { user_id: reviewer.user_id, name: reviewer.name }, count, notices };
}

module.exports = {
  preview,
  caseFolders,
  fileOne,
  sendNotice,
  subjectNameCases,
  resolveReviewer,
  MAX_MESSAGES,
  REVIEWER_SETTING,
  NOTICE_PREFIX,
  BATCH_RE,
};
