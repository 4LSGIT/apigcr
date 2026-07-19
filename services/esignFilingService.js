// services/esignFilingService.js
//
/**
 * E-Sign DOCUMENT FILING — signed PDF + completion certificate → Dropbox.
 * services/esignFilingService.js
 *
 * Phase 1C. Called exactly once per request, from
 * esignWebhookService.processStatusChange, on the transition INTO 'signed'.
 * Both routes into that transition (the inbound webhook and the nightly
 * reconciliation job) therefore file through this one module — there is no
 * second copy of the download/name/upload sequence to drift.
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
 * ── STORAGE CONVENTION (Fred, pre-approved) ─────────────────────────────────
 *   <case folder>/Signed Documents/{YYYY-MM-DD} {document_name} (signed).pdf
 *   <case folder>/Signed Documents/{YYYY-MM-DD} {document_name} (certificate).pdf
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

const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';

/** Subfolder under the case folder. Created if absent (idempotent). */
const SUBFOLDER = 'Signed Documents';

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
 * @param {'signed'|'certificate'} o.suffix
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
 * Where does this request's paperwork belong?
 *
 * Only 'case' has a Dropbox folder. A contact-linked request has nowhere
 * automatic to go — the firm files by case — so it is a deliberate skip, not
 * an error. 69 of 1066 live cases also have no case_dropbox at all (measured),
 * so the empty branch is a real, regularly-exercised path rather than a
 * theoretical one.
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

/**
 * Download the signed document (and, best-effort, its completion certificate)
 * and file both into the case's Dropbox folder.
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
 *   signedPdfPath: string|null, certPdfPath: string|null, warnings: string[]
 * }>}
 */
async function fileSignedDocuments(db, request, { provider } = {}) {
  const out = {
    filed: false, skipped: false, reason: null, note: null,
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

  const target = await resolveTarget(db, request);
  if (!target.ok) {
    out.skipped = true;
    out.reason = target.reason;
    out.note = target.note;
    return out;
  }

  let credentialId;
  let folderPath;
  try {
    credentialId = await dropboxService._resolveCredential(db, {});
    const caseFolder = await dropboxService.resolveLocation(db, credentialId, {
      sharedLink: target.sharedLink, expectFolder: true,
    });
    // files/upload creates missing parents, but creating it explicitly keeps
    // the failure legible: "could not make the folder" beats a 409 buried in
    // an upload error. Idempotent — an existing folder returns existed:true.
    const created = await dropboxService.createFolder(db, {
      credentialId, path: dropboxService.joinPath(caseFolder, SUBFOLDER),
    });
    folderPath = created.path;
  } catch (err) {
    out.reason = 'dropbox_unreachable';
    out.note = `Could not open the case's Dropbox folder: ${err.message}`;
    return out;
  }

  // Budget the name so the stored path fits varchar(512).
  const nameBudget = Math.min(
    MAX_NAME_FRAGMENT,
    MAX_STORED_PATH - PATH_HEADROOM - folderPath.length - '/YYYY-MM-DD  (certificate).pdf'.length
  );
  if (nameBudget < 8) {
    out.reason = 'path_too_long';
    out.note = `The case's Dropbox folder path is ${folderPath.length} characters, which leaves ` +
               `no room for a filename inside the ${MAX_STORED_PATH}-character limit on the stored path.`;
    return out;
  }

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
    const res = await _upload(db, credentialId, folderPath, buildFilename({
      completedAt: request.completed_at, documentName: request.document_name,
      suffix: 'signed', ext, nameBudget,
    }), signedBuf);
    out.signedPdfPath = res.path;
    out.filed = true;
  } catch (err) {
    out.reason = 'signed_upload_failed';
    out.note = `Dropbox rejected the signed document: ${err.message}`;
    return out;
  }

  // ── completion certificate (best effort) ──────────────────────────────────
  try {
    const certBuf = await provider.downloadCompletionCertificate(request.provider_id);
    const certKind = sniffBuffer(certBuf);
    const res = await _upload(db, credentialId, folderPath, buildFilename({
      completedAt: request.completed_at, documentName: request.document_name,
      suffix: 'certificate', ext: certKind === 'zip' ? 'zip' : 'pdf', nameBudget,
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
    `[ESIGN FILING] request ${request.id} → ${out.signedPdfPath}` +
    (out.certPdfPath ? ` + certificate` : '') +
    (out.warnings.length ? ` (${out.warnings.length} warning(s))` : '')
  );
  return out;
}

module.exports = {
  fileSignedDocuments,
  resolveTarget,
  // exported for tests
  sniffBuffer,
  sanitizeNameFragment,
  buildFilename,
  SUBFOLDER,
  MAX_STORED_PATH,
  MAX_NAME_FRAGMENT,
};