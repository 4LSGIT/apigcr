// services/esignFilingService.js
//
/**
 * E-Sign DOCUMENT FILING — signed PDF + completion certificate → Dropbox.
 * services/esignFilingService.js
 *
 * Phase 1C, fallback ladder added 2026-08. Called exactly once per request,
 * from esignWebhookService.processStatusChange, on the transition INTO
 * 'signed'. Both routes into that transition (the inbound webhook and the
 * nightly reconciliation job) therefore file through this one module — there
 * is no second copy of the download/name/upload sequence to drift.
 *
 * ── THIS MODULE RAISES NO TASKS AND WRITES NO LOGS ──────────────────────────
 * It returns a structured verdict and lets processStatusChange decide what a
 * human needs to hear. Filing is a mechanism; deciding who gets told is
 * policy, and mixing them here would mean the reconciliation job and the
 * webhook could alert differently for identical outcomes.
 *
 * ── WHY IT NEVER THROWS ─────────────────────────────────────────────────────
 * By the time this runs the client HAS SIGNED. That fact is already recorded
 * in signing_requests and is not in question. A Dropbox outage must not
 * un-record it, must not 500 the webhook, and must not make Zoho retry — it
 * must produce a task telling someone to file the document by hand. So every
 * failure path returns { filed:false, ... } with a human-readable `note`.
 *
 * ── THE FALLBACK LADDER ─────────────────────────────────────────────────────
 * Target resolution now degrades instead of stopping:
 *
 *   1. case with a live case_dropbox link      → <case folder>/Signed Documents
 *   2. case with NO case_dropbox               → caseService.ensureCaseDropboxFolder
 *      (the same stage-aware creator intake and the case-page repair button
 *      use), then (1). The auto-create ALWAYS emits a warning — 69 live cases
 *      have no linked folder and some of those have a hand-made folder that
 *      was simply never linked; a silently-created duplicate next to the real
 *      one is worse than the task. The warning names the created folder and
 *      tells staff to merge + re-link if a folder already existed.
 *   3. anything else — contact-linked request, case row missing, dead/revoked
 *      shared link, auto-create failure, over-long case path — → the UNSORTED
 *      folder (app_settings 'dropbox_unsorted_esign_path', default below),
 *      with the filename prefixed by the linked entity's id and primary
 *      contact name so the file is identifiable sitting in a shared bin, plus
 *      a best-effort direct shared link in the warnings so the task email can
 *      point straight at the file.
 *   4. unsorted also fails                     → { filed:false } as before.
 *
 * `placement` ('case' | 'unsorted') rides on the verdict so the announcer can
 * word the task truthfully — "move this file" is a different job from
 * "download it from Zoho by hand".
 *
 * ── STORAGE CONVENTION (Fred, pre-approved) ─────────────────────────────────
 *   <case folder>/Signed Documents/{YYYY-MM-DD} {document_name} (signed).pdf
 *   <case folder>/Signed Documents/{YYYY-MM-DD} {document_name} (certificate).pdf
 * Unsorted placements prepend "{entity id} - {contact lfm name} - ".
 *
 * The date is the COMPLETION date in firm time, not the send date and not UTC
 * — a document signed at 8pm Detroit on the 3rd files under the 3rd, which is
 * what a person looking for it will guess.
 *
 * ── COLLISIONS ──────────────────────────────────────────────────────────────
 * Handled by Dropbox's own `autorename`, not by us. It is atomic, so it cannot
 * lose a race the way check-then-write can, and it costs no extra API call.
 * The consequence is that the FINAL name may differ from the requested one
 * (Dropbox appends " (1)", " (2)", …), so the caller must persist the path
 * Dropbox RETURNS. See `_upload` — it reads path_display off the response
 * metadata and never trusts the string it asked for.
 *
 * ── ZIP ENVELOPES ───────────────────────────────────────────────────────────
 * Zoho returns a ZIP rather than a PDF when an envelope holds multiple files.
 * Phase 2 sends single-PDF envelopes, so this is defensive. We do NOT extract:
 * the repo has no zip dependency, and a hand-rolled central-directory parser
 * that has never been run against a real Zoho ZIP is a worse failure mode than
 * filing the archive and saying so. The .zip is filed under the same name with
 * a .zip extension and the verdict carries a warning the caller turns into a
 * task.
 */

const { DateTime } = require('luxon');
const dropboxService = require('./dropboxService');
const esignService = require('./esignService');
const { getSetting } = require('./settingsService');

const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';

/** Subfolder under the case folder. Created if absent (idempotent). */
const SUBFOLDER = 'Signed Documents';

/**
 * Where documents land when no case folder can be found or made. Overridable
 * without a deploy via app_settings — LEADING SPACES ARE SIGNIFICANT (the
 * firm's manual-sort convention) and are preserved; only trailing CR/LF from
 * a sloppy settings edit is stripped.
 */
const UNSORTED_PATH_KEY = 'dropbox_unsorted_esign_path';
const DEFAULT_UNSORTED_PATH = '/  Law Office/   Cases/  Unsorted E-Signed Documents';

/**
 * signing_requests.signed_pdf_path / cert_pdf_path are varchar(512) and
 * esignService._guardLength THROWS above that rather than truncating. Budget
 * the generated filename so a long document_name cannot produce a path we are
 * then unable to store — the file would be in Dropbox with nothing pointing
 * at it. Headroom covers Dropbox's " (10)" autorename suffix.
 */
const MAX_STORED_PATH = 512;
const PATH_HEADROOM   = 24;

/** Longest document_name fragment allowed in a filename. */
const MAX_NAME_FRAGMENT = 120;

/** Longest identity prefix ("{id} - {name} - ") on an unsorted filename. */
const MAX_PREFIX = 80;

/**
 * Characters Dropbox rejects or that make a filename hostile to open.
 * NOTE the firm's leading-space sort convention is a PATH concern (folders
 * they name by hand) — it does not apply to a filename we generate, so the
 * generated fragment is trimmed.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_NAME = /[/\\:*?"<>|\u0000-\u001f]/g;

/** %PDF */
const MAGIC_PDF = Buffer.from([0x25, 0x50, 0x44, 0x46]);
/** PK\x03\x04 — a ZIP local file header. */
const MAGIC_ZIP = Buffer.from([0x50, 0x4b]);

/**
 * What kind of bytes did Zoho actually hand us?
 * @returns {'pdf'|'zip'|'unknown'}
 */
function sniffBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return 'unknown';
  if (buf.subarray(0, 4).equals(MAGIC_PDF)) return 'pdf';
  if (buf.subarray(0, 2).equals(MAGIC_ZIP)) return 'zip';
  return 'unknown';
}

/** Filesystem-safe fragment of the document name. */
function sanitizeNameFragment(name, max = MAX_NAME_FRAGMENT) {
  const cleaned = String(name == null ? '' : name)
    .replace(ILLEGAL_IN_NAME, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || 'document';
  return base.length <= max ? base : base.slice(0, max).trim();
}

/**
 * `{YYYY-MM-DD} {name} ({suffix}).{ext}`
 *
 * @param {object} o
 * @param {Date|string|null} o.completedAt  falls back to now
 * @param {string} o.documentName
 * @param {'signed'|'certificate'|string} o.suffix
 * @param {string} o.ext                    'pdf' | 'zip'
 * @param {number} [o.nameBudget]           chars available to the name fragment
 */
function buildFilename({ completedAt, documentName, suffix, ext, nameBudget = MAX_NAME_FRAGMENT }) {
  const dt = completedAt
    ? DateTime.fromJSDate(completedAt instanceof Date ? completedAt : new Date(completedAt), { zone: 'utc' }).setZone(FIRM_TZ)
    : DateTime.now().setZone(FIRM_TZ);
  const date = dt.isValid ? dt.toFormat('yyyy-MM-dd') : DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd');
  const frag = sanitizeNameFragment(documentName, Math.max(8, nameBudget));
  return `${date} ${frag} (${suffix}).${ext}`;
}

/**
 * Where does this request's paperwork belong? FIRST RUNG ONLY — the raw
 * "does this case have a live folder link" check. prepareCaseFolder owns the
 * ladder; this stays exported with its original reason vocabulary because the
 * reasons feed event payloads and are asserted by tests.
 *
 * 69 of 1066 live cases have no case_dropbox at all (measured), so the empty
 * branch is a real, regularly-exercised path rather than a theoretical one.
 *
 * @returns {Promise<{ok:boolean, sharedLink?:string, reason?:string, note?:string}>}
 */
async function resolveTarget(db, request) {
  if (request.linkable_type !== 'case') {
    return {
      ok: false,
      reason: 'not_a_case',
      note: `This signing request is linked to a ${request.linkable_type} ` +
            `(id ${request.linkable_id}), not a case, so there is no case folder to file into.`,
    };
  }

  let row;
  try {
    [[row]] = await db.query(
      'SELECT case_dropbox FROM cases WHERE case_id = ? LIMIT 1',
      [String(request.linkable_id)]
    );
  } catch (err) {
    return { ok: false, reason: 'db_error', note: `Could not read the case row: ${err.message}` };
  }

  if (!row) {
    return {
      ok: false,
      reason: 'case_not_found',
      note: `Case "${request.linkable_id}" was not found, so the signed document could not be filed.`,
    };
  }
  if (!row.case_dropbox || String(row.case_dropbox).trim() === '') {
    return {
      ok: false,
      reason: 'no_case_dropbox',
      note: `Case "${request.linkable_id}" has no Dropbox folder link (cases.case_dropbox is empty).`,
    };
  }
  return { ok: true, sharedLink: String(row.case_dropbox) };
}

/**
 * "{id} - {primary contact lfm name} - " for an unsorted filename, so the
 * file is identifiable sitting in a shared bin. Best-effort: any lookup
 * failure degrades to the id alone, never to an error — this is a filename
 * nicety on the LAST rung of the ladder, and a thrown error here would cost
 * us the filing itself.
 */
async function _identityPrefix(db, request) {
  const idPart = request.linkable_type === 'case'
    ? String(request.linkable_id)
    : `${request.linkable_type} ${request.linkable_id}`;
  let name = null;
  try {
    if (request.linkable_type === 'case') {
      const [[row]] = await db.query(
        `SELECT c.contact_lfm_name
           FROM case_relate cr
           JOIN contacts c ON c.contact_id = cr.case_relate_client_id
          WHERE cr.case_relate_case_id = ?
          ORDER BY (cr.case_relate_type = 'Primary') DESC, cr.case_relate_client_id ASC
          LIMIT 1`,
        [String(request.linkable_id)]
      );
      name = row?.contact_lfm_name || null;
    } else if (request.linkable_type === 'contact') {
      const [[row]] = await db.query(
        'SELECT contact_lfm_name FROM contacts WHERE contact_id = ? LIMIT 1',
        [String(request.linkable_id)]
      );
      name = row?.contact_lfm_name || null;
    }
  } catch (err) {
    console.warn(`[ESIGN FILING] identity-prefix lookup failed for ${idPart}: ${err.message}`);
  }
  const parts = [sanitizeNameFragment(idPart, 40)];
  if (name) parts.push(sanitizeNameFragment(name, 40));
  const prefix = `${parts.join(' - ')} - `;
  return prefix.length <= MAX_PREFIX ? prefix : `${prefix.slice(0, MAX_PREFIX - 3)} - `;
}

/**
 * LAST RUNG: the unsorted folder. Returns the same target shape as the case
 * rung (placement 'unsorted', plus a filenamePrefix carrying the entity's
 * identity). Throws nothing — failure returns { ok:false, note }.
 */
async function prepareUnsortedFolder(db, request) {
  let credentialId;
  let folderPath;
  let prefix;
  try {
    credentialId = await dropboxService._resolveCredential(db, {});

    let path = null;
    try {
      const raw = await getSetting(db, UNSORTED_PATH_KEY);
      // Trailing CR/LF only — leading/embedded spaces are the firm's sort
      // convention and must survive a settings round-trip untouched.
      if (raw != null && String(raw).replace(/[\r\n]+$/, '') !== '') {
        path = String(raw).replace(/[\r\n]+$/, '');
      }
    } catch (err) {
      console.warn(`[ESIGN FILING] ${UNSORTED_PATH_KEY} lookup failed, using default: ${err.message}`);
    }
    if (!path) path = DEFAULT_UNSORTED_PATH;

    const created = await dropboxService.createFolder(db, { credentialId, path });
    folderPath = created.path;
    prefix = await _identityPrefix(db, request);
  } catch (err) {
    return { ok: false, note: `Could not open the unsorted e-sign folder: ${err.message}` };
  }

  // Budget the name so the stored path fits varchar(512). The unsorted path
  // is short, so this only bites on a pathological settings value — shrink
  // the prefix before giving up.
  const suffixLen = '/YYYY-MM-DD  (certificate).pdf'.length;
  let nameBudget = Math.min(
    MAX_NAME_FRAGMENT,
    MAX_STORED_PATH - PATH_HEADROOM - folderPath.length - prefix.length - suffixLen
  );
  if (nameBudget < 8) {
    const available = MAX_STORED_PATH - PATH_HEADROOM - folderPath.length - suffixLen;
    prefix = available > 11 ? `${prefix.slice(0, available - 11)} - ` : '';
    nameBudget = Math.min(MAX_NAME_FRAGMENT, available - prefix.length);
    if (nameBudget < 8) {
      return {
        ok: false,
        note: `The unsorted folder path is ${folderPath.length} characters, which leaves no room ` +
              `for a filename inside the ${MAX_STORED_PATH}-character limit on the stored path.`,
      };
    }
  }

  return { ok: true, placement: 'unsorted', credentialId, folderPath, filenamePrefix: prefix, nameBudget };
}

/**
 * Resolve where this request's paperwork goes and how long the name may be —
 * THE LADDER (see the header). Shared by fileSignedDocuments (which downloads
 * bytes FROM the provider) and fileExternalDocument (which is HANDED bytes);
 * the two callers differ only in where the buffer comes from.
 *
 * Success shape:
 *   { ok:true, credentialId, folderPath, nameBudget,
 *     placement: 'case'|'unsorted',
 *     filenamePrefix: string,          // '' for case placement
 *     warnings: string[],              // facts that already happened
 *                                      // (e.g. "a folder was auto-created")
 *     placementNote: string|null }     // why unsorted; callers surface it
 *                                      // only AFTER an upload succeeds, so a
 *                                      // task never claims a filing that
 *                                      // then failed
 *
 * Failure shape (every rung exhausted):
 *   { ok:false, skipped:boolean, reason, note }
 * `reason` stays the PRIMARY reason (the first rung's failure) so event
 * payloads and greps keep their vocabulary; `note` narrates the whole ladder.
 * `skipped` is false — if even the unsorted bin is unreachable, Dropbox is
 * down and the reconcile job SHOULD count it as a failure.
 */
async function prepareCaseFolder(db, request) {
  const warnings = [];
  const target = await resolveTarget(db, request);
  let sharedLink = target.ok ? target.sharedLink : null;
  let primaryReason = target.ok ? null : target.reason;
  let fallbackNote  = target.ok ? null : target.note;

  // ── rung 2: auto-create the case folder ───────────────────────────────────
  if (!target.ok && target.reason === 'no_case_dropbox') {
    try {
      const caseService = require('./caseService');   // deferred require (convention)
      const ensured = await caseService.ensureCaseDropboxFolder(db, String(request.linkable_id));
      sharedLink = ensured.shared_link;
      warnings.push(
        `Case "${request.linkable_id}" had no Dropbox folder linked, so one was created automatically` +
        (ensured.shared_link ? `: ${ensured.shared_link}` : '.') +
        ` If this case already had a folder that was never linked, move its contents into the new ` +
        `folder (or move this document into the old one and re-link it on the case page).`
      );
      console.log(`[ESIGN FILING] auto-created case folder for ${request.linkable_id}: ${ensured.path || '(pre-existing)'}`);
    } catch (err) {
      fallbackNote = `${target.note} Auto-creating one failed (${err.message}).`;
    }
  }

  // ── rung 1 (possibly via rung 2): the case folder ─────────────────────────
  if (sharedLink) {
    try {
      const credentialId = await dropboxService._resolveCredential(db, {});
      const caseFolder = await dropboxService.resolveLocation(db, credentialId, {
        sharedLink, expectFolder: true,
      });
      // files/upload creates missing parents, but creating it explicitly keeps
      // the failure legible: "could not make the folder" beats a 409 buried in
      // an upload error. Idempotent — an existing folder returns existed:true.
      const created = await dropboxService.createFolder(db, {
        credentialId, path: dropboxService.joinPath(caseFolder, SUBFOLDER),
      });
      const folderPath = created.path;

      const nameBudget = Math.min(
        MAX_NAME_FRAGMENT,
        MAX_STORED_PATH - PATH_HEADROOM - folderPath.length - '/YYYY-MM-DD  (certificate).pdf'.length
      );
      if (nameBudget >= 8) {
        return {
          ok: true, placement: 'case', credentialId, folderPath, nameBudget,
          filenamePrefix: '', warnings, placementNote: null,
        };
      }
      primaryReason = primaryReason || 'path_too_long';
      fallbackNote =
        `The case's Dropbox folder path is ${folderPath.length} characters, which leaves no room ` +
        `for a filename inside the ${MAX_STORED_PATH}-character limit on the stored path.`;
    } catch (err) {
      primaryReason = primaryReason || 'dropbox_unreachable';
      fallbackNote = `Could not open the case's Dropbox folder: ${err.message}`;
    }
  }

  // ── rung 3: the unsorted folder ───────────────────────────────────────────
  const un = await prepareUnsortedFolder(db, request);
  if (un.ok) {
    return {
      ...un,
      warnings,
      placementNote:
        `The document could not be filed to a case folder — ${fallbackNote} ` +
        `It was filed to the unsorted e-sign folder instead (${un.folderPath}); ` +
        `move it into the correct case folder.`,
    };
  }

  // ── rung 4: nothing worked ────────────────────────────────────────────────
  return {
    ok: false,
    skipped: false,
    reason: primaryReason || 'dropbox_unreachable',
    note: `${fallbackNote} Fallback to the unsorted folder also failed: ${un.note}`,
  };
}

/**
 * Upload one buffer and return the path DROPBOX CHOSE.
 *
 * autorename:true means the requested name is a request, not a guarantee. The
 * response metadata is authoritative and is what gets persisted.
 */
async function _upload(db, credentialId, folderPath, filename, content) {
  const requested = dropboxService.joinPath(folderPath, filename);
  const meta = await dropboxService.uploadFile(db, {
    credentialId,
    path: requested,
    content,
    mode: 'add',
    autorename: true,
  });

  // files/upload returns FileMetadata. path_display preserves the case the
  // user sees; path_lower is the canonical handle. Either is a valid path.
  const actual = meta?.path_display || meta?.path_lower || requested;
  if (actual !== requested) {
    console.log(`[ESIGN FILING] Dropbox autorenamed: "${requested}" → "${actual}"`);
  }
  return { path: actual, renamed: actual !== requested, metadata: meta };
}

/** prep.filenamePrefix + buildFilename, with the prep's budget. */
function _nameFor(prep, { completedAt, documentName, suffix, ext }) {
  return (prep.filenamePrefix || '') +
    buildFilename({ completedAt, documentName, suffix, ext, nameBudget: prep.nameBudget });
}

/**
 * After a successful UNSORTED upload: surface WHY it landed there, and a
 * best-effort direct shared link so the task email points at the file itself.
 * Mutates out.warnings; never throws.
 */
async function _annotateUnsorted(db, prep, out) {
  if (prep.placement !== 'unsorted') return;
  if (prep.placementNote) out.warnings.push(prep.placementNote);
  try {
    const url = await dropboxService.getOrCreateSharedLink(db, {
      credentialId: prep.credentialId, path: out.signedPdfPath,
    });
    if (url) out.warnings.push(`Direct link to the signed document: ${url}`);
  } catch (err) {
    console.warn(`[ESIGN FILING] could not create a shared link for ${out.signedPdfPath}: ${err.message}`);
  }
}

/**
 * File a document we were HANDED rather than one we downloaded — the paper /
 * in-office signature that satisfies a request outside the provider entirely
 * (see esignSendService.markSatisfiedExternal).
 *
 * There is no completion certificate to chase: nobody generated one, because
 * nobody signed electronically. So this is the signed-document half of
 * fileSignedDocuments and nothing else.
 *
 * NEVER THROWS, for the same reason as the rest of this module: by the time it
 * runs, the request has ALREADY been marked satisfied_external. A Dropbox
 * outage must not un-say that.
 *
 * @param {object} db
 * @param {object} request               shaped signing_requests row
 * @param {object} o
 * @param {Buffer} o.buffer              the externally-signed document
 * @param {string} [o.suffix='signed - external']
 * @param {Date|string} [o.completedAt]  defaults to the row's completed_at
 */
async function fileExternalDocument(db, request, { buffer, suffix = 'signed - external', completedAt = null } = {}) {
  const out = {
    filed: false, skipped: false, reason: null, note: null, placement: null,
    signedPdfPath: null, certPdfPath: null, warnings: [],
  };

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    out.skipped = true;
    out.reason = 'no_buffer';
    out.note = 'No document was supplied, so there was nothing to file.';
    return out;
  }

  const prep = await prepareCaseFolder(db, request);
  if (!prep.ok) {
    out.skipped = prep.skipped;
    out.reason = prep.reason;
    out.note = prep.note;
    return out;
  }
  out.placement = prep.placement;
  out.warnings.push(...prep.warnings);

  const kind = sniffBuffer(buffer);
  let ext = 'pdf';
  if (kind === 'zip') {
    ext = 'zip';
    out.warnings.push(
      'The uploaded document is a ZIP archive, not a PDF. It has been filed as a .zip; ' +
      'open it and split out the individual documents by hand.'
    );
  } else if (kind === 'unknown') {
    out.warnings.push(
      `The uploaded document did not begin with a PDF or ZIP signature (${buffer.length} bytes). ` +
      'It has been filed as-is with a .pdf extension — check that it opens.'
    );
  }

  try {
    const res = await _upload(db, prep.credentialId, prep.folderPath, _nameFor(prep, {
      completedAt: completedAt || request.completed_at,
      documentName: request.document_name,
      suffix, ext,
    }), buffer);
    out.signedPdfPath = res.path;
    out.filed = true;
  } catch (err) {
    out.reason = 'signed_upload_failed';
    out.note = `Dropbox rejected the document: ${err.message}`;
    return out;
  }

  await _annotateUnsorted(db, prep, out);

  try {
    await esignService.setPdfPaths(db, request.id, { signedPdfPath: out.signedPdfPath });
  } catch (err) {
    // The file IS in Dropbox. Only the pointer failed.
    out.warnings.push(
      `Filed to Dropbox, but the path could not be recorded against signing request ` +
      `${request.id} (${err.message}). Signed: ${out.signedPdfPath}`
    );
  }

  console.log(`[ESIGN FILING] request ${request.id} externally-signed → ${out.signedPdfPath} (${out.placement})`);
  return out;
}

/**
 * Download the signed document (and, best-effort, its completion certificate)
 * and file both into the resolved Dropbox folder (case, or unsorted — see the
 * ladder in the header).
 *
 * Certificate failure is NON-FATAL and deliberately so: the signed document is
 * the operative instrument, the certificate is corroborating evidence, and
 * losing the second must never cost us the first. It comes back as a warning.
 *
 * @param {object} db
 * @param {object} request   a shaped signing_requests row (post-transition)
 * @param {object} o
 * @param {object} o.provider  an esign provider instance (already constructed
 *                             by the caller, so one provider serves a whole
 *                             reconciliation run)
 * @returns {Promise<{
 *   filed: boolean, skipped: boolean, reason: string|null, note: string|null,
 *   placement: 'case'|'unsorted'|null,
 *   signedPdfPath: string|null, certPdfPath: string|null, warnings: string[]
 * }>}
 */
async function fileSignedDocuments(db, request, { provider } = {}) {
  const out = {
    filed: false, skipped: false, reason: null, note: null, placement: null,
    signedPdfPath: null, certPdfPath: null, warnings: [],
  };

  // ── idempotency ───────────────────────────────────────────────────────────
  // A row that already carries a signed path has been filed. Re-delivery of
  // the same Zoho notification, or a reconciliation run racing a webhook,
  // must not produce a second copy. applyStatus's terminal soft-refusal
  // normally stops us reaching here twice; this is the belt to that braces,
  // and it is the guard that actually holds when two deliveries interleave
  // between applyStatus's read and its write.
  if (request.signed_pdf_path) {
    out.skipped = true;
    out.reason = 'already_filed';
    out.signedPdfPath = request.signed_pdf_path;
    out.certPdfPath = request.cert_pdf_path || null;
    console.log(`[ESIGN FILING] request ${request.id} already filed at ${request.signed_pdf_path} — skipping`);
    return out;
  }

  if (!provider) {
    out.skipped = true;
    out.reason = 'no_provider';
    out.note = 'Internal error: filing was attempted without a provider instance.';
    return out;
  }

  const prep = await prepareCaseFolder(db, request);
  if (!prep.ok) {
    out.skipped = prep.skipped;
    out.reason = prep.reason;
    out.note = prep.note;
    return out;
  }
  out.placement = prep.placement;
  out.warnings.push(...prep.warnings);
  const { credentialId, folderPath } = prep;

  // ── signed document ───────────────────────────────────────────────────────
  let signedBuf;
  try {
    signedBuf = await provider.downloadSignedPdf(request.provider_id);
  } catch (err) {
    out.reason = 'signed_download_failed';
    out.note = `Zoho would not return the signed document: ${err.message}`;
    return out;
  }

  const kind = sniffBuffer(signedBuf);
  let ext = 'pdf';
  if (kind === 'zip') {
    ext = 'zip';
    out.warnings.push(
      'Zoho returned a ZIP archive, not a single PDF — this envelope held more than one file. ' +
      'It has been filed as a .zip; open it and split out the individual PDFs by hand.'
    );
  } else if (kind === 'unknown') {
    out.warnings.push(
      `The signed download did not begin with a PDF or ZIP signature (${signedBuf?.length ?? 0} bytes). ` +
      'It has been filed as-is with a .pdf extension — check that it opens.'
    );
  }

  try {
    const res = await _upload(db, credentialId, folderPath, _nameFor(prep, {
      completedAt: request.completed_at, documentName: request.document_name,
      suffix: 'signed', ext,
    }), signedBuf);
    out.signedPdfPath = res.path;
    out.filed = true;
  } catch (err) {
    out.reason = 'signed_upload_failed';
    out.note = `Dropbox rejected the signed document: ${err.message}`;
    return out;
  }

  await _annotateUnsorted(db, prep, out);

  // ── completion certificate (best effort) ──────────────────────────────────
  try {
    const certBuf = await provider.downloadCompletionCertificate(request.provider_id);
    const certKind = sniffBuffer(certBuf);
    const res = await _upload(db, credentialId, folderPath, _nameFor(prep, {
      completedAt: request.completed_at, documentName: request.document_name,
      suffix: 'certificate', ext: certKind === 'zip' ? 'zip' : 'pdf',
    }), certBuf);
    out.certPdfPath = res.path;
  } catch (err) {
    out.warnings.push(
      `The signed document filed successfully, but the completion certificate could not be ` +
      `saved (${err.message}). Download it from the Zoho Sign dashboard if it is needed for the file.`
    );
  }

  // ── persist ───────────────────────────────────────────────────────────────
  try {
    await esignService.setPdfPaths(db, request.id, {
      signedPdfPath: out.signedPdfPath,
      ...(out.certPdfPath ? { certPdfPath: out.certPdfPath } : {}),
    });
  } catch (err) {
    // The files ARE in Dropbox. Only the pointer failed, so this is a warning
    // with an exact remedy rather than a failed filing.
    out.warnings.push(
      `Filed to Dropbox, but the paths could not be recorded against signing request ` +
      `${request.id} (${err.message}). Signed: ${out.signedPdfPath}`
    );
  }

  console.log(
    `[ESIGN FILING] request ${request.id} → ${out.signedPdfPath} (${out.placement})` +
    (out.certPdfPath ? ` + certificate` : '') +
    (out.warnings.length ? ` (${out.warnings.length} warning(s))` : '')
  );
  return out;
}

module.exports = {
  fileSignedDocuments,
  fileExternalDocument,
  prepareCaseFolder,
  prepareUnsortedFolder,
  resolveTarget,
  // exported for tests
  sniffBuffer,
  sanitizeNameFragment,
  buildFilename,
  _identityPrefix,
  SUBFOLDER,
  MAX_STORED_PATH,
  MAX_NAME_FRAGMENT,
  MAX_PREFIX,
  UNSORTED_PATH_KEY,
  DEFAULT_UNSORTED_PATH,
};