// services/documentGenerateService.js
//
/**
 * GENERATE A DOCUMENT — a template, a case, and a PDF in Dropbox.
 * services/documentGenerateService.js
 *
 * G2. The non-esign twin of esignSendService.sendFromTemplate: the same
 * templates, the same resolvers, the same renderer, the same filing ladder —
 * and NO envelope. A notice, a letter, a filled worksheet: things the firm
 * produces and files, that nobody is being asked to sign.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * No rows of its own. No provider call. No credits. No recipients, no
 * expiration, no reminders, no completion triggers, no status to track. There
 * is nothing to reconcile because there is nothing outstanding — the document
 * is finished the moment it is written. If a document needs a signature, that
 * is sendFromTemplate's job and this function refuses it (see PURPOSE below).
 *
 * ── THE THREE BORROWED PIECES ───────────────────────────────────────────────
 *   templateRenderService  values → interpolation → PDF. THE SAME renderer the
 *                          send path and the authoring preview use, which is
 *                          the whole point of G1 extracting it: what staff
 *                          preview, what gets signed, and what gets generated
 *                          are one rendering, not three that agree today.
 *   filePlacementService   the case-folder ladder, verbatim from the form-PDF
 *                          path — including the auto-create task, the per-case
 *                          unsorted subfolder and the registry write.
 *   esignTemplateService   the template row.
 * This file's own contribution is small on purpose: the purpose guard, the
 * required-value policy, and the filename.
 *
 * ── PURPOSE ─────────────────────────────────────────────────────────────────
 * contract_templates.purpose gates this. A template marked 'esign' is REFUSED
 * here even though it would render perfectly, because generating and filing a
 * fee agreement instead of sending it for signature looks exactly like success
 * and leaves nothing signed. sendFromTemplate carries the mirror refusal for
 * 'generate'. 'both' passes either way.
 *
 * ── REQUIRED VALUES ARE A HARD STOP, BLANKS ARE NOT ─────────────────────────
 * A required prefill key that is still empty throws ESIGN_MISSING_PREFILL with
 * the same message and the same `.missing` array sendFromTemplate uses — the
 * internal function's on_missing:'task' branch keys on that code, and a shared
 * wording means a staff task reads the same whichever path raised it.
 * Everything else goes through fillBlanks (the PREVIEW posture): a non-required
 * hole renders as '' and is reported in `missing_optional`, because a notice
 * with one blank line is a document a human can finish, and a 400 is not.
 *
 * ── LOAD ────────────────────────────────────────────────────────────────────
 * html templates render through chromium, which SERIALIZES on the 1GiB
 * container. One at a time. The internal function is workflowOnly for exactly
 * this reason — see lib/internal_functions/documents.js.
 */

'use strict';

const { DateTime } = require('luxon');

/** Filename dates are firm-local — the date a person looking for the file will
 *  guess. Same convention and same zone as esignFilingService.buildFilename. */
const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';

/**
 * The generated-documents bin. Its OWN bin, for the reason X5.1 gave form PDFs
 * one: a client upload is a document the firm must chase, a form PDF is a
 * machine archive, and a generated document is a thing staff produced on
 * purpose. Mixing them makes every bin a work queue nobody trusts to be empty.
 *
 * Setting-if-present / hardcoded-default, like the esign, forms and uploads
 * bins, so a missing app_settings row degrades rather than breaks.
 */
const UNSORTED_PATH_KEY = 'dropbox_unsorted_generated_path';
const DEFAULT_UNSORTED_PATH = '/  Law Office/   Cases/  Unsorted Generated Documents';

/** documents envelope `source` / tasks.task_source / console prefix. */
const EVENT_SOURCE = 'generated_doc';
const TASK_SOURCE = 'doc_gen';
const LOG_TAG = '[DOC GEN]';

/** Prose labels for filePlacementService's notes and its move-task title. */
const ARTIFACT_LABEL = 'generated document';
const BIN_LABEL = 'unsorted generated-documents folder';

/** Longest document-name fragment allowed in a filename. */
const MAX_NAME_FRAGMENT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS — repo convention: construct, attach .code, throw.
// Codes are SHARED with the esign surface on purpose: a caller handling
// ESIGN_MISSING_PREFILL should not need to learn a second spelling of it
// because the document happened not to need a signature.
// ─────────────────────────────────────────────────────────────────────────────

function _err(code, message, extra = null) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render one template for one case/contact and file the PDF.
 *
 * @param {object} db
 * @param {object} o
 * @param {number}  o.templateId
 * @param {string}  o.linkableType    'case' | 'contact'
 * @param {string}  o.linkableId
 * @param {object}  [o.values]        caller overrides; win over resolved prefills
 * @param {string}  [o.documentName]  default '{template.name} – {debtor last name}'
 * @param {?number} [o.createdBy]     acting user for the registry write
 * @returns {Promise<object>} filePlacementService's verdict, plus
 *          template_id, template_name, document_name, link_type, link_id,
 *          missing_optional
 * @throws  ESIGN_NOT_FOUND | ESIGN_TEMPLATE_INACTIVE | ESIGN_TEMPLATE_PURPOSE
 *          | ESIGN_BAD_TEMPLATE | ESIGN_BAD_LINKABLE | ESIGN_MISSING_PREFILL
 *          | ESIGN_TEMPLATE_NO_PDF + everything the renderer and the ladder throw
 */
async function generateFromTemplate(db, {
  templateId, linkableType, linkableId,
  values = null, documentName = null, createdBy = null,
} = {}) {
  const esignTemplateService  = require('./esignTemplateService');
  const templateRenderService = require('./templateRenderService');
  const filePlacementService  = require('./filePlacementService');

  // ── 1. the template, and whether it may be generated at all ───────────────
  const tid = Number(templateId);
  if (!Number.isInteger(tid) || tid < 1) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `template_id must be a positive integer (got ${JSON.stringify(templateId)}).`);
  }

  const template = await esignTemplateService.getTemplate(db, tid);
  if (!template) throw _err('ESIGN_NOT_FOUND', `Template ${tid} not found.`);

  if (!template.active) {
    throw _err('ESIGN_TEMPLATE_INACTIVE',
      `Template "${template.name}" is inactive and cannot be used. Reactivate it, or pick another.`);
  }
  if (template.purpose === 'esign') {
    throw _err('ESIGN_TEMPLATE_PURPOSE',
      `Template "${template.name}" is a signature-only template; ` +
      `set its purpose to generate or both.`);
  }

  // A generated document must belong to something — it is going to be FILED,
  // and the ladder's whole job is deciding whose folder. ESIGN_BAD_LINKABLE is
  // the code esignSendService._assertLinkableExists already uses for exactly
  // this, so routes and callers map one code, not two.
  if (linkableType !== 'case' && linkableType !== 'contact') {
    throw _err('ESIGN_BAD_LINKABLE',
      `Invalid link type "${linkableType}" (expected one of: case, contact).`);
  }
  const linkId = String(linkableId == null ? '' : linkableId).trim();
  if (!linkId) throw _err('ESIGN_BAD_LINKABLE', 'No case or contact was selected.');

  // ── 2. values ─────────────────────────────────────────────────────────────
  const resolved = await templateRenderService.resolveTemplateValues(db, template, {
    linkableType, linkableId: linkId, values,
  });

  if (resolved.missingRequired.length) {
    // Wording is IDENTICAL to sendFromTemplate's, deliberately: the same staff
    // member reads the same sentence whichever path stopped, and the internal
    // function's on_missing branch keys on the code either way.
    throw _err(
      'ESIGN_MISSING_PREFILL',
      `Required value(s) are still empty: ${resolved.missingRequired.join(', ')}. ` +
      `Fill them in and send again.`,
      { missing: resolved.missingRequired }
    );
  }

  // ── 3. render ─────────────────────────────────────────────────────────────
  // fillBlanks, not raw merged: required-ness was already enforced above, so
  // anything still empty here is OPTIONAL and belongs on the page as a blank
  // rather than as an ESIGN_UNDECLARED_PLACEHOLDER. (The send path does the
  // opposite and refuses — an unsigned notice with a gap is fixable by hand;
  // a signed contract with a gap is not.)
  const { filled, missing } = templateRenderService.fillBlanks(template, resolved.merged);
  const pdf = await templateRenderService.renderTemplateToPdf(db, template, filled);

  // ── 4. name ───────────────────────────────────────────────────────────────
  const docName = (documentName != null && String(documentName).trim() !== '')
    ? String(documentName).trim()
    : templateRenderService.defaultDocumentName(template.name, resolved.context);

  // "{YYYY-MM-DD} {name}.pdf" — the firm's filing convention, date first so a
  // folder sorts chronologically. Generation time, not any stored timestamp:
  // this document did not exist until now.
  const date = DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd');
  const fileName =
    `${date} ${filePlacementService.sanitizeNameFragment(docName, MAX_NAME_FRAGMENT)}.pdf`;

  // ── 5. file it ────────────────────────────────────────────────────────────
  // file_subfolder is NOT NULL in the schema; the fallback covers exactly one
  // situation — code deployed ahead of its migration — where the alternative
  // is silently filing into the case folder ROOT and never noticing.
  const subfolder = template.file_subfolder || esignTemplateService.DEFAULT_FILE_SUBFOLDER;

  const verdict = await filePlacementService.placeAndRegister(db, {
    linkType:               linkableType,
    linkId,
    content:                pdf,
    fileName,
    subfolder,
    unsortedPathKey:        UNSORTED_PATH_KEY,
    unsortedDefault:        DEFAULT_UNSORTED_PATH,
    unsortedFilenamePrefix: await filePlacementService.identityPrefixFor(
      db, { linkType: linkableType, linkId }, LOG_TAG
    ),
    eventSource:            EVENT_SOURCE,
    taskSource:             TASK_SOURCE,
    logTag:                 LOG_TAG,
    artifactLabel:          ARTIFACT_LABEL,
    binLabel:               BIN_LABEL,
    createdBy,
  });

  console.log(
    `${LOG_TAG} template ${tid} ("${template.name}") \u2192 ${verdict.path} ` +
    `for ${linkableType} ${linkId} (${verdict.placement})`
  );

  return {
    ...verdict,
    template_id: template.id,
    template_name: template.name,
    document_name: docName,
    link_type: linkableType,
    link_id: linkId,
    // Declared keys that rendered BLANK. Not an error — see the header — but
    // the caller deserves to know before emailing it to a client.
    missing_optional: missing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  generateFromTemplate,
  UNSORTED_PATH_KEY,
  DEFAULT_UNSORTED_PATH,
  EVENT_SOURCE,
  TASK_SOURCE,
  LOG_TAG,
};
