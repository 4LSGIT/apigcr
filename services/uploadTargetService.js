// services/uploadTargetService.js
//
/**
 * CLIENT UPLOAD TARGET — where a client's document upload lands in Dropbox.
 *
 * The client-upload twin of esignFilingService's fallback ladder (2026-08),
 * shared by BOTH client upload surfaces so they cannot drift:
 *
 *   routes/api.checklists.js       POST /api/public/get-upload-link  (docReq)
 *   services/portalDocsService.js  createUploadLink                  (portal)
 *
 * ── THE LADDER (issueClientUploadLink) ──────────────────────────────────────
 *   1. case with a live case_dropbox link → temp upload link into
 *      <case folder>/Client Uploads (unchanged legacy behavior).
 *   2. case with NO case_dropbox → caseService.ensureCaseDropboxFolder (the
 *      same stage-aware creator that intake, the case-page repair button and
 *      the e-sign filing ladder use), then (1). A successful auto-create
 *      ALWAYS raises a staff task — some unlinked cases have a hand-made
 *      folder that was simply never linked, and a silently-created duplicate
 *      next to the real one is worse than the task. Idempotent per case: the
 *      first file of a batch pays for the create; the rest see case_dropbox
 *      set and take rung 1 (both upload pages loop files sequentially).
 *   3. dead/revoked link, link-is-a-file, or auto-create failure → temp link
 *      into the UNSORTED CLIENT UPLOADS folder (app_settings
 *      'dropbox_unsorted_uploads_path', default below), in a per-case
 *      subfolder "{case_id} - {lfm name}" so a batch stays together and
 *      drag-moves in one gesture. (The e-sign ladder prefixes loose FILE
 *      names instead — deliberate divergence: e-sign files one document at a
 *      time, clients upload batches.) No explicit folder create: a temp
 *      link's commit creates missing parents at upload time, which saves a
 *      Dropbox call per file.
 *   4. everything failed (Dropbox unreachable) → throws; the callers keep
 *      their existing client-facing error responses.
 *
 * A client therefore ALWAYS has a way to upload while Dropbox is reachable —
 * the old "No Dropbox folder linked to this case" dead end is gone.
 *
 * ── COMPLETE-TIME INSPECTION (inspectUploadDestination) ─────────────────────
 * Link issuance (per file) and upload-complete (per batch) are separate HTTP
 * moments, and nothing trustworthy travels between them through the client.
 * So the completion notification re-derives placement server-side:
 * case_dropbox set AND resolvable → the batch went to the case folder;
 * otherwise it went to unsorted. One shared-link metadata call per completed
 * batch; the rare link-died-mid-batch race resolves to the truthful side at
 * the moment the wording is built. Runs in the callers' post-200 side-effect
 * phase, so the client never waits on it.
 *
 * ── TASKS (best-effort, never block an upload) ──────────────────────────────
 * Assignee = first usable id in office_alerts_to
 * (esignAlertService.resolveAlertAssignee — the firm-wide alert roster).
 * tasks.task_source = 'client_upload'.
 *   rung 2 → "no folder was linked so one was created here {link}; merge +
 *            re-link if a hand-made folder already existed" (once, at create)
 *   rung 3 → "files landed in the unsorted folder {link}; move them" —
 *            raised by the complete handlers via raiseUnsortedUploadTask,
 *            once per batch and only AFTER files actually arrived (a client
 *            who fetches links but never uploads must not page staff).
 */

'use strict';

const dropboxService = require('./dropboxService');
const taskService    = require('./taskService');
const { getSetting } = require('./settingsService');
const { resolveAlertAssignee } = require('./esignAlertService');

/**
 * Where client uploads land when no case folder exists or can be made.
 * Overridable without a deploy via app_settings — LEADING SPACES ARE
 * SIGNIFICANT (the firm's manual-sort convention) and are preserved; only
 * trailing CR/LF from a sloppy settings edit is stripped.
 */
const UNSORTED_PATH_KEY     = 'dropbox_unsorted_uploads_path';
const DEFAULT_UNSORTED_PATH = '/  Law Office/   Cases/  Unsorted Client Uploads';

/** Subfolder under the case folder — the legacy destination, unchanged. */
const SUBFOLDER = 'Client Uploads';

/** tasks.task_source — marks these as machine-pushed. varchar(50). */
const TASK_SOURCE = 'client_upload';

// taskService.createTask THROWS above these rather than truncating (sql_mode
// is not strict). Clip so a task is never lost to a long name.
const MAX_TITLE = 100;
const MAX_DESC  = 1000;

// tasks.task_link_id is varchar(20); over-length ids would truncate silently
// (see esignAlertService.MAX_TASK_LINK_ID rationale). Real case ids are ~8
// chars — this is a tripwire, not an expectation.
const MAX_TASK_LINK_ID = 20;

/**
 * Characters Dropbox rejects in a name (esignFilingService convention). The
 * per-case subfolder name is GENERATED, so the firm's leading-space sort
 * convention does not apply — it gets trimmed.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_NAME = /[/\\:*?"<>|\u0000-\u001f]/g;

/** Sanitize one generated path segment. */
function _sanitizeSegment(s, max) {
  const cleaned = String(s == null ? '' : s)
    .replace(ILLEGAL_IN_NAME, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || 'Unknown';
  return base.length <= max ? base : base.slice(0, max).trim();
}

/** Clip to `max`, marking the cut (esignAlertService convention). */
function _clip(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return `${str.slice(0, max - 14)}…(truncated)`;
}

/** The unsorted base path — settings value or the default. Never throws. */
async function _unsortedBasePath(db) {
  let path = null;
  try {
    const raw = await getSetting(db, UNSORTED_PATH_KEY);
    // Trailing CR/LF only — leading/embedded spaces are the firm's sort
    // convention and must survive a settings round-trip untouched.
    if (raw != null && String(raw).replace(/[\r\n]+$/, '') !== '') {
      path = String(raw).replace(/[\r\n]+$/, '');
    }
  } catch (err) {
    console.warn(`[UPLOAD TARGET] ${UNSORTED_PATH_KEY} lookup failed, using default: ${err.message}`);
  }
  return path || DEFAULT_UNSORTED_PATH;
}

/**
 * "{case_id} - {lfm name}" — the per-case subfolder inside the unsorted
 * folder. Name comes from the case's Primary contact (lowest contact id
 * fallback — the ensureCaseDropboxFolder / e-sign identity convention). A
 * failed name lookup degrades to the bare case id, never throws.
 */
async function _unsortedCaseFolderName(db, caseId) {
  let name = null;
  try {
    const [[row]] = await db.query(
      `SELECT c.contact_lfm_name
         FROM case_relate cr
         JOIN contacts c ON c.contact_id = cr.case_relate_client_id
        WHERE cr.case_relate_case_id = ?
        ORDER BY (cr.case_relate_type = 'Primary') DESC, cr.case_relate_client_id ASC
        LIMIT 1`,
      [String(caseId)]
    );
    name = row?.contact_lfm_name || null;
  } catch (err) {
    console.warn(`[UPLOAD TARGET] name lookup failed for case ${caseId}: ${err.message}`);
  }
  const parts = [_sanitizeSegment(String(caseId), 40)];
  if (name) parts.push(_sanitizeSegment(name, 60));
  return parts.join(' - ');
}

/** Full Dropbox path of the case's unsorted-uploads subfolder. */
async function unsortedCaseFolderPath(db, caseId) {
  const base = await _unsortedBasePath(db);
  return dropboxService.joinPath(base, await _unsortedCaseFolderName(db, caseId));
}

/**
 * Raise a staff task about a client upload. Best-effort — a lost task must
 * never fail an upload — so this logs and returns instead of throwing.
 */
async function _raiseTask(db, { title, desc, caseId }) {
  try {
    const assignee = await resolveAlertAssignee(db);
    if (!assignee) {
      console.warn(`[UPLOAD TARGET] office_alerts_to names no user — dropping task: ${title}`);
      return { ok: false, reason: 'no_assignee' };
    }
    const idStr = String(caseId);
    const linkable = idStr.length <= MAX_TASK_LINK_ID;
    const { task_id } = await taskService.createTask(db, {
      from:      0,                       // automations user
      to:        assignee,
      title:     _clip(title, MAX_TITLE),
      desc:      _clip(desc, MAX_DESC),
      link_type: linkable ? 'case' : null,
      link_id:   linkable ? idStr : null,
      source:    TASK_SOURCE,
    });
    console.log(`[UPLOAD TARGET] task #${task_id} → user ${assignee}: ${title}`);
    return { ok: true, taskId: task_id };
  } catch (err) {
    console.error(`[UPLOAD TARGET] failed to raise task "${title}": ${err && err.message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * THE LADDER — resolve a Dropbox temporary upload link for one client file.
 *
 * `filename` must arrive ALREADY SANITIZED (both callers sanitize before
 * calling — this module never sees raw client path input).
 *
 * @param {object} db
 * @param {object} o — { caseId, filename }
 * @returns {Promise<{case_id:string, link:string,
 *                    placement:'case'|'created'|'unsorted', path?:string}>}
 * @throws err.code='CASE_NOT_FOUND' when the case row is gone; otherwise
 *         only when every rung failed (Dropbox unreachable) — callers keep
 *         their existing error responses.
 */
async function issueClientUploadLink(db, { caseId, filename }) {
  if (!caseId)   throw new Error('issueClientUploadLink requires caseId');
  if (!filename) throw new Error('issueClientUploadLink requires filename');

  const [[caseRow]] = await db.query(
    'SELECT case_id, case_dropbox FROM cases WHERE case_id = ?',
    [String(caseId)]
  );
  if (!caseRow) {
    const err = new Error(`issueClientUploadLink: case ${caseId} not found`);
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }
  const cid = caseRow.case_id;

  let sharedLink = (caseRow.case_dropbox && String(caseRow.case_dropbox).trim()) || '';
  let placement  = 'case';
  let ladderNote = null;

  // ── rung 2: auto-create the case folder ───────────────────────────────────
  if (!sharedLink) {
    try {
      const caseService = require('./caseService');   // deferred require (convention)
      const ensured = await caseService.ensureCaseDropboxFolder(db, cid);
      sharedLink = (ensured.shared_link && String(ensured.shared_link).trim()) || '';
      placement  = 'created';
      console.log(`[UPLOAD TARGET] auto-created case folder for ${cid}: ${ensured.path || '(pre-existing)'}`);
      // Fire-and-forget: the merge warning must not delay the client's
      // upload. Once per case — the next file sees case_dropbox set.
      _raiseTask(db, {
        title: `Review auto-created Dropbox folder: ${cid}`,
        desc:
          `Case ${cid} had no Dropbox folder linked, so one was created automatically when a ` +
          `client uploaded documents: ${sharedLink}\n\n` +
          `If this case already had a folder that was never linked, move its contents into the ` +
          `new folder (or move the uploads into the old one and re-link it on the case page).`,
        caseId: cid,
      });
    } catch (err) {
      ladderNote = `auto-creating a case folder failed (${err.message})`;
      console.warn(`[UPLOAD TARGET] ${cid}: ${ladderNote}`);
    }
  }

  // ── rung 1 (possibly via rung 2): the case folder ─────────────────────────
  if (sharedLink) {
    try {
      // `path` is returned on EVERY rung as of S4 (it always existed here and
      // was simply dropped). The documents upload flow signs the issued
      // destination into its commit ticket, and a rung that hid its path would
      // be the one rung that could not be committed against. Existing callers
      // destructure { link } and are unaffected.
      const { link, path } = await dropboxService.getTemporaryUploadLink(db, {
        sharedLink, filename, subfolder: SUBFOLDER,
      });
      return { case_id: cid, link, placement, path };
    } catch (err) {
      ladderNote = `case folder link unusable (${err.message})`;
      console.warn(`[UPLOAD TARGET] ${cid}: ${ladderNote} — falling back to unsorted`);
    }
  }

  // ── rung 3: the unsorted client-uploads folder ────────────────────────────
  try {
    const path = await unsortedCaseFolderPath(db, cid);
    const { link } = await dropboxService.getTemporaryUploadLink(db, { path, filename });
    return { case_id: cid, link, placement: 'unsorted', path };
  } catch (err) {
    // ── rung 4: nothing worked ──────────────────────────────────────────────
    err.message = `unsorted upload fallback failed (${err.message})` +
                  (ladderNote ? `; earlier: ${ladderNote}` : '');
    throw err;
  }
}

/**
 * COMPLETE-TIME: where did this batch's files land? Read-only — creates
 * nothing, raises nothing.
 *
 * @returns {Promise<{case_id:string, placement:'case', sharedLink:string} |
 *                   {case_id:string, placement:'unsorted', path:string,
 *                    link:string|null} | null>}
 *   null = case row gone. Unsorted `link` is a best-effort shared link to
 *   the per-case subfolder (null when Dropbox declines — e.g. the folder was
 *   never materialised because no file actually arrived).
 */
async function inspectUploadDestination(db, caseId) {
  const [[caseRow]] = await db.query(
    'SELECT case_id, case_dropbox FROM cases WHERE case_id = ?',
    [String(caseId)]
  );
  if (!caseRow) return null;
  const cid = caseRow.case_id;

  const sharedLink = (caseRow.case_dropbox && String(caseRow.case_dropbox).trim()) || '';
  if (sharedLink) {
    try {
      const credentialId = await dropboxService._resolveCredential(db, {});
      await dropboxService.resolveLocation(db, credentialId, { sharedLink, expectFolder: true });
      return { case_id: cid, placement: 'case', sharedLink };
    } catch (err) {
      console.warn(`[UPLOAD TARGET] ${cid}: case link did not resolve at complete time (${err.message}) — reporting unsorted placement`);
    }
  }

  const path = await unsortedCaseFolderPath(db, cid);
  let link = null;
  try {
    link = await dropboxService.getOrCreateSharedLink(db, { path });
  } catch (err) {
    console.warn(`[UPLOAD TARGET] ${cid}: best-effort shared link for unsorted folder failed (${err.message})`);
  }
  return { case_id: cid, placement: 'unsorted', path, link };
}

/**
 * The rung-3 staff task — called by BOTH complete handlers when
 * inspectUploadDestination reports 'unsorted', once per completed batch.
 * Best-effort; never throws.
 */
async function raiseUnsortedUploadTask(db, { caseId, clientName, fileCount, path, link }) {
  const n = Number(fileCount) || 0;
  const where = link || `Dropbox path: ${path}`;
  return _raiseTask(db, {
    title: `Move client uploads to case folder: ${caseId}`,
    desc:
      `${clientName || 'A client'} uploaded ${n} document${n === 1 ? '' : 's'}, but case ${caseId} ` +
      `has no working Dropbox folder, so the files were placed in the unsorted client uploads ` +
      `folder: ${where}\n\n` +
      `Action: move the files into the correct case folder, and create or re-link the case's ` +
      `Dropbox folder on the case page so future uploads file themselves.`,
    caseId,
  });
}

module.exports = {
  issueClientUploadLink,
  inspectUploadDestination,
  raiseUnsortedUploadTask,
  unsortedCaseFolderPath,
  // The BARE bin, no per-case subfolder. S4's staff upload uses it for the two
  // destinations that have no case to make a subfolder for: a CONTACT-scoped
  // upload (contacts have no folder convention at all) and a global one. Kept
  // as a named export rather than letting callers re-read the setting, so the
  // app_settings key and its leading-space handling stay in one place.
  unsortedBasePath: _unsortedBasePath,
  UNSORTED_PATH_KEY,
  DEFAULT_UNSORTED_PATH,
  TASK_SOURCE,
  // Exposed for tests (repo pattern).
  _sanitizeSegment,
};
