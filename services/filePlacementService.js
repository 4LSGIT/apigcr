// services/filePlacementService.js
//
/**
 * FILE PLACEMENT — bytes in, a filed-and-registered Dropbox file out.
 * services/filePlacementService.js
 *
 * G2. Lifted VERBATIM (semantics, not just code) from formPdfService's
 * _preparePlacement + fileSubmissionPdf, with the form-specific constants
 * turned into parameters. One question, one module: "given some bytes and a
 * thing they belong to, where do they go and who gets told?"
 *
 * ── WHAT IT OWNS ────────────────────────────────────────────────────────────
 *   casePrimaryName     a case's primary-contact lfm name (best-effort)
 *   identityPrefixFor   "{id} - {lfm name} - " for a loose unsorted filename
 *   placeAndRegister    THE LADDER: resolve destination → upload → register in
 *                       the documents registry → raise any task the placement
 *                       earned → mint a temp link → return the verdict
 *
 * ── THE LADDER ──────────────────────────────────────────────────────────────
 * Unchanged from X5 (Fred's ruling 2026-08-14). For a CASE-linked file:
 *   1. live cases.case_dropbox → <case folder>/<subfolder>   (created if absent)
 *   2. no case_dropbox → caseService.ensureCaseDropboxFolder (the same
 *      stage-aware creator intake / e-sign / client-upload use), then (1). The
 *      auto-create ALWAYS raises a staff task — a silently-created duplicate
 *      next to a hand-made never-linked folder is worse than the task. Raised
 *      at CREATE time: the folder exists and is linked even if the upload then
 *      fails.
 *   3. dead link / create failure / case row gone → the caller's unsorted bin,
 *      in a per-case subfolder named "{case_id} - {lfm name}" so one case's
 *      strays stay together — plus a move-task raised only AFTER the upload
 *      actually lands.
 * For contact / appt / unlinked: straight to the bin root as a loose file
 * carrying `unsortedFilenamePrefix`, and NO task (the caller owns whatever
 * surfaces these; a task per anonymous file would duplicate that signal).
 * Everything failed (Dropbox unreachable) → throws; the caller decides.
 *
 * ── THE SECOND COPY ─────────────────────────────────────────────────────────
 * services/esignFilingService.js CARRIES ITS OWN COPY of this ladder and is
 * NOT migrated onto this module. That is known and deliberate for G2: the
 * e-sign copy files TWO artifacts per request (document + certificate) with a
 * shared path budget against signing_requests.signed_pdf_path's varchar(512),
 * and folding that budgeting in here would change the shape of every caller
 * for one caller's benefit. Migrating it is its own slice. Until then, a fix
 * to the ladder has to be made in both places — check esignFilingService's
 * prepareCaseFolder / prepareUnsortedFolder before assuming this file is the
 * only one.
 *
 * ── PARAMETER CONTRACT ──────────────────────────────────────────────────────
 * Everything caller-specific is passed in; this module knows nothing about
 * forms, templates or e-signature:
 *   linkType/linkId          what the bytes belong to ('case'|'contact'|'appt'|null)
 *   content / fileName       the bytes, and the FINAL name including extension.
 *                            The caller composes the name; only the unsorted
 *                            identity prefix is applied here (bin hygiene is
 *                            not the caller's call).
 *   subfolder                under the case folder, CASE RUNG ONLY ('Forms')
 *   unsortedPathKey/Default  which app_settings bin this caller degrades into
 *   unsortedFilenamePrefix   applied ONLY on the loose (non-case) rung
 *   eventSource / taskSource the documents envelope source, and tasks.task_source
 *   logTag                   console prefix, e.g. '[FORM PDF]' / '[DOC GEN]'
 *   artifactLabel            a noun phrase for prose: 'form PDF', 'generated
 *                            document'. Appears in the move-task title and in
 *                            every placement note.
 *   binLabel                 a noun phrase naming the bin: 'unsorted
 *                            form-submissions folder'. Appears in placement
 *                            notes so a reader can tell WHICH bin to go sweep.
 *   createdBy                actor for the registry write; null for machine work
 *
 * ── NEVER-THROW POSTURE ─────────────────────────────────────────────────────
 * The only thing that throws here is a failed UPLOAD, because that is the only
 * failure that means the file does not exist. Name lookups, task creation,
 * registry writes and temp links are all best-effort: the bytes are already in
 * Dropbox by the time those run, and turning a successful filing into an
 * exception over bookkeeping is how a retry files a second copy.
 */

'use strict';

const dropboxService = require('./dropboxService');
const taskService = require('./taskService');
const { getSetting } = require('./settingsService');
const { resolveAlertAssignee } = require('./esignAlertService');

/** Longest generated name fragment. */
const MAX_NAME_FRAGMENT = 100;

/** Longest identity prefix on an unsorted filename (e-sign convention). */
const MAX_PREFIX = 80;

// taskService.createTask THROWS above these rather than truncating (sql_mode
// is not strict). Clip so a task is never lost to a long name.
const MAX_TITLE = 100;
const MAX_DESC = 1000;

// tasks.task_link_id is varchar(20); real case ids are ~8 chars — tripwire.
const MAX_TASK_LINK_ID = 20;

/** Console prefix when a caller supplies none. */
const DEFAULT_LOG_TAG = '[FILE PLACEMENT]';

/** Characters Dropbox rejects in a generated name (e-sign convention). */
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_NAME = /[/\\:*?"<>|\u0000-\u001f]/g;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filesystem-safe fragment of a generated name (e-sign convention).
 *
 * `fallback` exists because the two lifted copies disagreed: formPdfService
 * used 'form' and esignFilingService uses 'document'. Rather than pick one and
 * silently change a caller's edge-case name, it is a parameter — formPdfService
 * pins 'form' in its own one-line wrapper.
 */
function sanitizeNameFragment(name, max = MAX_NAME_FRAGMENT, fallback = 'document') {
  const cleaned = String(name == null ? '' : name)
    .replace(ILLEGAL_IN_NAME, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || fallback;
  return base.length <= max ? base : base.slice(0, max).trim();
}

/** Clip to `max`, marking the cut (esignAlertService convention). */
function _clip(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return `${str.slice(0, max - 14)}…(truncated)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity lookups (best-effort, never throw)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Primary-contact lfm name for a case — the shared identity convention, and
 * the same ORDER BY the client-upload, e-sign and form-PDF ladders all use.
 *
 * @param {object} db
 * @param {string|number} caseId
 * @param {string} [logTag]   console prefix for the degrade warning
 * @returns {Promise<?string>} null on any failure
 */
async function casePrimaryName(db, caseId, logTag = DEFAULT_LOG_TAG) {
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
    return row?.contact_lfm_name || null;
  } catch (err) {
    console.warn(`${logTag} case name lookup failed for ${caseId}: ${err.message}`);
    return null;
  }
}

/**
 * "{id} - {lfm name} - " for a loose file sitting in a shared bin — the e-sign
 * unsorted-filename convention, so a stray is identifiable at a glance.
 *
 * A CASE uses its bare id ("hjSFMabb - Smith, John - "); everything else is
 * prefixed by its type ("contact 1001 - Doe, Jane - ", "appt 450 - ").
 * Every lookup failure degrades to "{id} - ", never to an error: this is a
 * filename nicety on the LAST rung of a ladder, and throwing here would cost
 * the filing itself.
 *
 * @param {object} db
 * @param {object} o
 * @param {string} o.linkType   'case' | 'contact' | 'appt' | null
 * @param {string|number} o.linkId
 * @param {string} [logTag]
 * @returns {Promise<string>} '' when there is no identity to name
 */
async function identityPrefixFor(db, { linkType, linkId } = {}, logTag = DEFAULT_LOG_TAG) {
  const id = linkId == null ? '' : String(linkId);
  if (!id) return '';

  const idPart = linkType === 'case' ? id : `${linkType || 'item'} ${id}`;

  let name = null;
  try {
    if (linkType === 'case') {
      name = await casePrimaryName(db, id, logTag);
    } else if (linkType === 'contact') {
      const [[row]] = await db.query(
        'SELECT contact_lfm_name FROM contacts WHERE contact_id = ? LIMIT 1',
        [id]
      );
      name = row?.contact_lfm_name || null;
    }
  } catch (err) {
    console.warn(`${logTag} identity lookup failed for ${idPart}: ${err.message}`);
  }

  const parts = [sanitizeNameFragment(idPart, 40)];
  if (name) parts.push(sanitizeNameFragment(name, 40));
  const prefix = `${parts.join(' - ')} - `;
  return prefix.length <= MAX_PREFIX ? prefix : `${prefix.slice(0, MAX_PREFIX - 3)} - `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (best-effort, never block a filing)
// ─────────────────────────────────────────────────────────────────────────────

async function _raiseTask(db, { title, desc, caseId, taskSource, logTag = DEFAULT_LOG_TAG }) {
  try {
    const assignee = await resolveAlertAssignee(db);
    if (!assignee) {
      console.warn(`${logTag} office_alerts_to names no user \u2014 dropping task: ${title}`);
      return { ok: false, reason: 'no_assignee' };
    }
    const idStr = String(caseId);
    const linkable = idStr.length <= MAX_TASK_LINK_ID;
    const { task_id } = await taskService.createTask(db, {
      from: 0,                        // automations user
      to: assignee,
      title: _clip(title, MAX_TITLE),
      desc: _clip(desc, MAX_DESC),
      link_type: linkable ? 'case' : null,
      link_id: linkable ? idStr : null,
      source: taskSource,
    });
    console.log(`${logTag} task #${task_id} \u2192 user ${assignee}: ${title}`);
    return { ok: true, taskId: task_id };
  } catch (err) {
    console.error(`${logTag} failed to raise task "${title}": ${err && err.message}`);
    return { ok: false, reason: 'error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement — THE LADDER
// ─────────────────────────────────────────────────────────────────────────────

/** The caller's unsorted bin base path (setting, else the caller's default). */
async function _unsortedBasePath(db, { unsortedPathKey, unsortedDefault, logTag = DEFAULT_LOG_TAG }) {
  let path = null;
  try {
    const raw = await getSetting(db, unsortedPathKey);
    // Trailing CR/LF only — leading/embedded spaces are the firm's sort
    // convention and must survive a settings round-trip untouched.
    if (raw != null && String(raw).replace(/[\r\n]+$/, '') !== '') {
      path = String(raw).replace(/[\r\n]+$/, '');
    }
  } catch (err) {
    console.warn(`${logTag} ${unsortedPathKey} lookup failed, using default: ${err.message}`);
  }
  return path || unsortedDefault;
}

/**
 * "{bin}/{case_id} - {lfm name}" — the per-case subfolder inside the caller's
 * bin, so one case's strays stay together instead of scattering through a flat
 * list. Naming mirrors uploadTargetService's client-upload convention (same
 * Primary-contact rule) on purpose: staff sorting any bin see one format.
 * A failed name lookup degrades to the bare case id, never throws.
 */
async function _unsortedCaseFolderPath(db, caseId, opts) {
  const base = await _unsortedBasePath(db, opts);
  const name = await casePrimaryName(db, caseId, opts.logTag || DEFAULT_LOG_TAG);
  const parts = [sanitizeNameFragment(String(caseId), 40)];
  if (name) parts.push(sanitizeNameFragment(name, 60));
  return dropboxService.joinPath(base, parts.join(' - '));
}

/**
 * Resolve where these bytes belong (header: THE LADDER).
 *
 * @returns {Promise<{credentialId, folderPath, filenamePrefix:string,
 *                    placement:'case'|'unsorted', placementNote:string|null,
 *                    warnings:string[], moveTaskAfterUpload:boolean}>}
 * Throws only when even the unsorted bin cannot be resolved (which, since that
 * rung is settings+string work, effectively means the credential lookup
 * failed — Dropbox trouble surfaces at upload time instead).
 */
async function _preparePlacement(db, {
  linkType, linkId, subfolder,
  unsortedPathKey, unsortedDefault, unsortedFilenamePrefix = '',
  artifactLabel, binLabel, taskSource, logTag,
}) {
  const credentialId = await dropboxService._resolveCredential(db, {});
  const warnings = [];
  const binOpts = { unsortedPathKey, unsortedDefault, logTag };

  if (linkType === 'case') {
    const caseId = String(linkId);
    let sharedLink = null;
    let fallbackNote = null;

    let row = null;
    try {
      [[row]] = await db.query(
        'SELECT case_dropbox FROM cases WHERE case_id = ? LIMIT 1', [caseId]
      );
    } catch (err) {
      fallbackNote = `Could not read the case row: ${err.message}`;
    }

    if (row && row.case_dropbox && String(row.case_dropbox).trim() !== '') {
      sharedLink = String(row.case_dropbox);
    } else if (row) {
      // ── rung 2: auto-create the case folder ─────────────────────────────
      try {
        const caseService = require('./caseService');   // deferred require (convention)
        const ensured = await caseService.ensureCaseDropboxFolder(db, caseId);
        sharedLink = ensured.shared_link;
        const warn =
          `Case "${caseId}" had no Dropbox folder linked, so one was created automatically` +
          (ensured.shared_link ? `: ${ensured.shared_link}` : '.') +
          ' If this case already had a folder that was never linked, merge the two and re-link ' +
          'the original on the case page.';
        warnings.push(warn);
        // Raised NOW, not after upload: the folder exists and is linked to
        // the case whether or not the upload then succeeds.
        await _raiseTask(db, {
          caseId,
          title: `Dropbox folder auto-created for case ${caseId}`,
          desc: warn,
          taskSource, logTag,
        });
        console.log(`${logTag} auto-created case folder for ${caseId}: ${ensured.path || '(pre-existing)'}`);
      } catch (err) {
        fallbackNote = `Case "${caseId}" has no Dropbox folder and auto-creating one failed (${err.message}).`;
      }
    } else if (!fallbackNote) {
      fallbackNote = `Case "${caseId}" was not found.`;
    }

    // ── rung 1 (possibly via rung 2): <case folder>/<subfolder> ────────────
    if (sharedLink) {
      try {
        const caseFolder = await dropboxService.resolveLocation(db, credentialId, {
          sharedLink, expectFolder: true,
        });
        // files/upload creates missing parents, but creating explicitly keeps
        // the failure legible (e-sign convention). Idempotent.
        const created = await dropboxService.createFolder(db, {
          credentialId, path: dropboxService.joinPath(caseFolder, subfolder),
        });
        return {
          credentialId, folderPath: created.path, filenamePrefix: '',
          placement: 'case', placementNote: null, warnings,
          moveTaskAfterUpload: false,
        };
      } catch (err) {
        fallbackNote = `Could not open the case's Dropbox folder: ${err.message}`;
      }
    }

    // ── rung 3: the caller's bin, per-case subfolder ──────────────────────
    const folderPath = await _unsortedCaseFolderPath(db, caseId, binOpts);
    return {
      credentialId, folderPath, filenamePrefix: '',
      placement: 'unsorted', warnings,
      placementNote:
        `The ${artifactLabel} could not be filed to the case folder \u2014 ${fallbackNote} ` +
        `It was filed to the ${binLabel} instead (${folderPath}); ` +
        'move it into the correct case folder.',
      moveTaskAfterUpload: true,
    };
  }

  // ── contact / appt / unlinked: the bin root, loose file w/ identity ──────
  const base = await _unsortedBasePath(db, binOpts);
  const what = linkType === 'contact' ? `a contact (id ${linkId})`
    : linkType === 'appt' ? `an appointment (id ${linkId})`
      : 'nothing yet';
  return {
    credentialId, folderPath: base,
    filenamePrefix: unsortedFilenamePrefix || '',
    placement: 'unsorted', warnings,
    placementNote:
      `This ${artifactLabel} is linked to ${what}, so there is no case folder to file into. ` +
      `It went to the ${binLabel} (${base}).`,
    moveTaskAfterUpload: false,   // the caller's own surface already lists these
  };
}

/**
 * Place bytes on the ladder, upload them, register the result, and report.
 *
 * @param {object} db
 * @param {object} o                 see the header's PARAMETER CONTRACT
 * @param {Buffer} o.content
 * @param {string} o.fileName        final name INCLUDING extension
 * @param {boolean} [o.moveTaskOnUnsortedCase=true]
 * @param {boolean} [o.linkForRegistration=true]
 * @returns {Promise<{path, file_name, placement, placement_note, temp_link,
 *                    temp_link_expires_note, warnings, credential_id,
 *                    document_id}>}
 * @throws only on a failed upload
 */
async function placeAndRegister(db, {
  linkType, linkId, content, fileName, subfolder,
  unsortedPathKey, unsortedDefault, unsortedFilenamePrefix = '',
  eventSource, taskSource, logTag = DEFAULT_LOG_TAG,
  artifactLabel = 'file', binLabel = 'unsorted folder',
  createdBy = null,
  moveTaskOnUnsortedCase = true,
  linkForRegistration = true,
} = {}) {
  const prep = await _preparePlacement(db, {
    linkType, linkId, subfolder,
    unsortedPathKey, unsortedDefault, unsortedFilenamePrefix,
    artifactLabel, binLabel, taskSource, logTag,
  });

  // ── upload — the path Dropbox RETURNS is authoritative (autorename) ──────
  const requested = dropboxService.joinPath(prep.folderPath, `${prep.filenamePrefix}${fileName}`);
  let meta;
  try {
    meta = await dropboxService.uploadFile(db, {
      credentialId: prep.credentialId,
      path: requested,
      content,
      mode: 'add',
      autorename: true,
    });
  } catch (err) {
    throw new Error(
      `could not upload the ${artifactLabel} to Dropbox (${requested}): ${err.message}` +
      (prep.placement === 'unsorted'
        ? ' The unsorted fallback also being unreachable means Dropbox itself is down.'
        : '')
    );
  }
  const actualPath = meta?.path_display || meta?.path_lower || requested;
  if (actualPath !== requested) {
    console.log(`${logTag} Dropbox autorenamed: "${requested}" \u2192 "${actualPath}"`);
  }
  const actualName = actualPath.split('/').pop();

  // ── REGISTER (Documents S4) ─────────────────────────────────────────────
  //
  // Write-time attribution: the caller already KNOWS what these bytes belong
  // to, and on the unsorted rung the path will never reveal it — a case's
  // paperwork sitting in a shared bin is exactly the document staff will later
  // go looking for on the case and not find.
  //
  // link_type 'appt' and NULL are passed through untouched and simply produce
  // no link: documentIngestService links whatever it is handed, and inventing
  // an appointment→document relation here would be a schema decision made by a
  // side effect. Registration still happens, so the file is in the list.
  //
  // Safe variant — the file is already in Dropbox and the caller's return
  // value is about the filing. A registry hiccup must not turn a successful
  // filing into a throw; it costs a document_id, and the sync's next delta
  // picks the file up anyway.
  const ingest = require('./documentIngestService');   // deferred (convention)
  const registered = await ingest.registerWrittenSafe(db, {
    entry:       meta,                 // files/upload returned it; post-autorename truth
    links:       (linkForRegistration &&
                  (linkType === 'case' || linkType === 'contact') && linkId != null)
                   ? [{ type: linkType, id: linkId }]
                   : [],
    createdBy,
    eventSource,
    credentialId: prep.credentialId,
  });
  const documentId =
    registered && registered.ok && registered.document && registered.document.id != null
      ? registered.document.id
      : null;

  // ── post-upload move-task (only after the file actually landed) ──────────
  if (prep.moveTaskAfterUpload && moveTaskOnUnsortedCase) {
    await _raiseTask(db, {
      caseId: String(linkId),
      title: `Move ${artifactLabel} for case ${linkId} out of Unsorted`,
      desc: `${prep.placementNote} File: ${actualPath}`,
      taskSource, logTag,
    });
  }

  // ── temp link, best-effort (see header) ──────────────────────────────────
  let tempLink = null;
  const warnings = prep.warnings.slice();
  try {
    const tl = await dropboxService.getTemporaryLink(db, {
      credentialId: prep.credentialId, path: actualPath,
    });
    tempLink = tl.link;
  } catch (err) {
    warnings.push(
      `The ${artifactLabel} was filed, but a temporary download link could not be created: ${err.message}. ` +
      'temp_link is null \u2014 email-attachment steps consuming it will need a retry or the Dropbox path.'
    );
  }
  if (prep.placementNote) warnings.push(prep.placementNote);

  return {
    path: actualPath,
    file_name: actualName,
    placement: prep.placement,
    placement_note: prep.placementNote,
    temp_link: tempLink,
    temp_link_expires_note: tempLink
      ? 'Dropbox temporary link \u2014 expires ~4 hours after creation'
      : null,
    warnings,
    credential_id: prep.credentialId,
    document_id: documentId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  placeAndRegister,
  casePrimaryName,
  identityPrefixFor,
  sanitizeNameFragment,
  // exposed for tests (repo pattern)
  _preparePlacement,
  _raiseTask,
  _unsortedBasePath,
  _unsortedCaseFolderPath,
  // constants
  MAX_NAME_FRAGMENT,
  MAX_PREFIX,
  ILLEGAL_IN_NAME,
};
