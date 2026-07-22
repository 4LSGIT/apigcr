// services/esignSendService.js
//
/**
 * E-Sign ORCHESTRATION — send, resend, recall, remind, satisfy, read.
 * services/esignSendService.js
 *
 * Phase 2A. This is the layer the UI and staff actions talk to. It owns no
 * rows and speaks no vendor dialect; it sequences the three modules that do:
 *
 *   services/esignService.js       DATA   (1A) — rows, transitions, audit trail
 *   services/esign/               WIRE   (1B) — getProvider, credit accounting
 *   services/esignFilingService.js FILING (1C) — Dropbox
 *
 * Everything here is a SEQUENCE with a failure story. That is the whole reason
 * the file exists: "stamp, then send, then mark sent, then spend a credit" has
 * four places to fail and four different right answers, and a route handler is
 * the wrong place to encode them.
 *
 * ── THE ORDER IS THE DESIGN ─────────────────────────────────────────────────
 *
 *   1. validate            no row, no network, no credit spent
 *   2. createRequest       draft row exists, tracking_id minted
 *   3. stamp footer        needs the tracking_id from step 2
 *   4. provider send       the only step that costs money
 *   5. markSent            draft → sent, provider_id recorded
 *   6. recordCreditSpend   local estimate, best effort
 *
 * A failure at 4 leaves the row a DRAFT and rethrows with `.draftId` attached,
 * so the caller can retry with the same row rather than orphaning it and
 * minting another. That is why draftId is a first-class parameter of
 * sendPipeline and not an internal detail: a retry after a Zoho 500 must reuse
 * the tracking_id already stamped into the client's document, or the copy the
 * debtor eventually signs carries an id that matches nothing.
 *
 * A failure at 6 is swallowed. By then the envelope is out and the credits are
 * gone; turning a bookkeeping miss into a 500 would tell the caller the send
 * failed when it did not, and they would send it again — spending five more.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────
 * No UI (2C). No placement editor (2D). No reminder cadence or sequence
 * enrollment (Phase 3). The 2B template branch (sendFromTemplate, below)
 * manufactures its PDF via pdfRenderService and then joins the SAME pipeline;
 * sendPipeline itself still takes a PDF buffer from its caller and asks no
 * questions about where it came from.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const esignService = require('./esignService');
const esignFilingService = require('./esignFilingService');
const { getProvider, recordCreditSpend } = require('./esign');
const { validatePlacements } = require('./esign/placements');
const { fillTextFields } = require('./esign/pdfFill');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Document kinds a caller may send today.
 *
 * Kept here rather than in esignService because 1A deliberately accepts any
 * snake_case kind (it only cares that the value is safe to embed in a tracking
 * id). This list is the PRODUCT's opinion about which ones exist, and 2B adds
 * template-derived kinds to it. Same posture as LINKABLE_TYPES: expansion is
 * always safe, since the validator only rejects values not in the list.
 */
const KINDS = Object.freeze([
  'retainer_prepetition',
  'retainer_postpetition',
  'schedules',
  'other',
]);

/**
 * Zoho's own document ceiling is 25MB. We stop at 20 so that footer stamping —
 * which rewrites the file and can grow it — cannot push a document that we
 * accepted over a limit the provider will reject three steps later, after the
 * draft row already exists.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Footer geometry, in PDF points. */
const FOOTER_SIZE          = 7;
const FOOTER_GRAY          = 0.45;
const FOOTER_FROM_BOTTOM   = 18;
const FOOTER_FROM_RIGHT    = 36;
const FOOTER_MIN_LEFT      = 2;    // clamp, for absurdly narrow pages
const FOOTER_PREFIX        = 'Doc Ctrl: ';

/** document_name bounds. The column is varchar(255); the product wants shorter. */
const MIN_DOC_NAME = 3;
const MAX_DOC_NAME = 120;

/** Recipient bounds. */
const MAX_RECIPIENTS = 5;
const MAX_RECIPIENT_NAME = 100;

/** expiration_days bounds. Default matches contract_templates.expiration_days. */
const MIN_EXPIRATION_DAYS = 1;
const MAX_EXPIRATION_DAYS = 90;
const DEFAULT_EXPIRATION_DAYS = 14;

/** recall/satisfy reason + note bounds. Stored in event payload JSON. */
const MAX_REASON = 500;
const MAX_NOTE   = 1000;

/**
 * Machine-name detectors for document_name. See validateSendInput.
 *
 *   HEX_RUN     a 12+ character run of hex digits — a uuid fragment, a hash,
 *               a provider id. No human types this into a document title.
 *   TOKEN_ONLY  a single word of word-characters and hyphens, over 20 chars,
 *               with no spaces at all: 'Retainer_Agreement_Smith_2026'.
 *   FILENAMEY   contains 'request_', or ends in '.pdf'.
 */
const HEX_RUN    = /[0-9a-f]{12,}/i;
const TOKEN_ONLY = /^[\w-]+$/;
const HAS_LETTER = /[a-z]/i;

/** Statuses from which each action is legal. Read with esignService.TRANSITIONS. */
const RESENDABLE_SAME_ROW = new Set(['bounced']);
const REMINDABLE          = new Set(['sent', 'viewed']);
const SATISFIABLE         = new Set(['sent', 'viewed', 'bounced']);
/** Statuses where the provider still holds a live envelope worth recalling. */
const LIVE_AT_PROVIDER    = new Set(['sent', 'viewed', 'bounced']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
//
// Repo convention (esignService, logService): construct, attach .code, throw.
// ─────────────────────────────────────────────────────────────────────────────

function _err(code, message, extra = null) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// FOOTER STAMPING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamp `Doc Ctrl: {trackingId}` into the bottom-right corner of EVERY page.
 *
 * ── WHY EVERY PAGE ──────────────────────────────────────────────────────────
 * The signed document comes back as one file, but a bankruptcy file gets
 * photocopied, scanned, split and faxed. A page that has been separated from
 * its envelope is exactly the page whose provenance someone later disputes, so
 * the id has to survive being alone.
 *
 * ── WHAT IS AND IS NOT PRESERVED ────────────────────────────────────────────
 * `updateMetadata: false` stops pdf-lib doing what it does by default: setting
 * Producer to itself and ModDate to now. The document's own metadata is left
 * exactly as its author wrote it; the only change to the file is the footer.
 *
 * `useObjectStreams: false` writes a classic uncompressed cross-reference
 * table rather than a PDF-1.5 cross-reference stream. It costs a little file
 * size and buys compatibility with old parsers — measured: this repo's own
 * pdf-parse (which bundles pdf.js v1.10.100 from 2018) chokes on pdf-lib's
 * default output with 'Invalid PDF structure'. These documents go to debtors
 * who open them in whatever they have; the tradeoff is not close.
 *
 * ── KNOWN LIMITATION: ROTATED PAGES ─────────────────────────────────────────
 * drawText places text in the page's UNROTATED user space. A page carrying a
 * /Rotate 90 will show the footer rotated with it — still on the page, still
 * legible, just not visually bottom-right. Bankruptcy forms are not rotated,
 * so this is left alone rather than fixed speculatively; if scanned exhibits
 * ever arrive rotated, the fix is to read page.getRotation() and swap the
 * width/height used below.
 *
 * @param {Buffer} pdfBuffer
 * @param {string} trackingId   signing_requests.tracking_id — opaque, never parsed
 * @returns {Promise<Buffer>}
 * @throws  ESIGN_BAD_PDF | ESIGN_PDF_TOO_LARGE
 */
async function stampTrackingFooter(pdfBuffer, trackingId) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw _err('ESIGN_BAD_PDF', 'No document was supplied, or it was empty.');
  }
  // Size first: it is a length check on a buffer we already hold, and it must
  // not be gated behind parsing a 60MB file.
  if (pdfBuffer.length > MAX_PDF_BYTES) {
    throw _err(
      'ESIGN_PDF_TOO_LARGE',
      `The document is ${(pdfBuffer.length / (1024 * 1024)).toFixed(1)}MB. ` +
      `The limit is ${MAX_PDF_BYTES / (1024 * 1024)}MB — split it, or reduce the scan quality.`
    );
  }
  // Magic-byte sniff, shared with the filing service so \"is this a PDF\" has one
  // answer across the subsystem.
  if (esignFilingService.sniffBuffer(pdfBuffer) !== 'pdf') {
    throw _err(
      'ESIGN_BAD_PDF',
      'That file is not a PDF (it does not begin with a PDF signature). ' +
      'Convert it to PDF and try again.'
    );
  }
  if (!trackingId || typeof trackingId !== 'string') {
    throw _err('ESIGN_BAD_PDF', 'stampTrackingFooter requires a tracking id.');
  }

  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  } catch (err) {
    // Encrypted PDFs land here too (pdf-lib throws EncryptedPDFError unless
    // told to ignore it — and ignoring it produces a file the signer cannot
    // fill). Same remedy either way, so same code with a specific message.
    const encrypted = /encrypt/i.test(err && err.message ? err.message : '');
    throw _err(
      'ESIGN_BAD_PDF',
      encrypted
        ? 'That PDF is password-protected or encrypted, so a tracking footer cannot be ' +
          'added to it. Save an unprotected copy and try again.'
        : `That PDF could not be read (${err && err.message}). It may be corrupt.`
    );
  }

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = `${FOOTER_PREFIX}${trackingId}`;
  const textWidth = font.widthOfTextAtSize(text, FOOTER_SIZE);

  for (const page of doc.getPages()) {
    const { width } = page.getSize();
    page.drawText(text, {
      x: Math.max(FOOTER_MIN_LEFT, width - FOOTER_FROM_RIGHT - textWidth),
      y: FOOTER_FROM_BOTTOM,
      size:  FOOTER_SIZE,
      font,
      color: rgb(FOOTER_GRAY, FOOTER_GRAY, FOOTER_GRAY),
    });
  }

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * document_name is DEBTOR-VISIBLE. Zoho puts it in the subject line of the
 * email the client receives and at the top of the signing page, so
 * '472304-Ch7_Form122A_smith.pdf' is not a cosmetic problem — it is what the
 * client sees from their lawyer.
 *
 * The rejections below are deliberately narrow: they catch names that were
 * plainly produced by a machine, not names that are merely ugly. A human who
 * genuinely wants a terse title can still have one.
 *
 * @throws ESIGN_BAD_NAME with a message the UI may show verbatim
 */
function _validateDocumentName(raw) {
  const name = String(raw == null ? '' : raw).trim();

  if (name.length < MIN_DOC_NAME || name.length > MAX_DOC_NAME) {
    throw _err(
      'ESIGN_BAD_NAME',
      `The document name must be between ${MIN_DOC_NAME} and ${MAX_DOC_NAME} characters. ` +
      `This is the name the client sees in the signing email.`
    );
  }
  if (!HAS_LETTER.test(name)) {
    throw _err(
      'ESIGN_BAD_NAME',
      'The document name needs at least one letter — the client sees this name, ' +
      'so it should read as a document title.'
    );
  }
  if (/request_/i.test(name) || /\.pdf$/i.test(name)) {
    throw _err(
      'ESIGN_BAD_NAME',
      'The document name looks like a filename. Use a title the client will ' +
      'recognise, e.g. "Retainer Agreement" — not the name of the file on disk.'
    );
  }
  if (HEX_RUN.test(name)) {
    throw _err(
      'ESIGN_BAD_NAME',
      'The document name contains what looks like an internal id or hash. ' +
      'Use a title the client will recognise, e.g. "Retainer Agreement".'
    );
  }
  if (!name.includes(' ') && TOKEN_ONLY.test(name) && name.length > 20) {
    throw _err(
      'ESIGN_BAD_NAME',
      'The document name looks machine-generated. Use words and spaces, ' +
      'e.g. "Retainer Agreement" rather than "Retainer_Agreement_2026".'
    );
  }
  return name;
}

/**
 * Recipients, normalized to the neutral contract shape {name, email, order}.
 *
 * `order` must be contiguous from 1 because it is the identity a placement's
 * `signer` refers to. A gap ('signers 1 and 3') would silently orphan every
 * field bound to the missing order: the provider would accept the envelope and
 * the second debtor would open a document with nowhere to sign.
 *
 * @throws ESIGN_BAD_RECIPIENTS
 */
function _validateRecipients(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw _err('ESIGN_BAD_RECIPIENTS', 'At least one signer is required.');
  }
  if (raw.length > MAX_RECIPIENTS) {
    throw _err('ESIGN_BAD_RECIPIENTS', `At most ${MAX_RECIPIENTS} signers are supported (got ${raw.length}).`);
  }

  const out = raw.map((r, i) => {
    if (!r || typeof r !== 'object') {
      throw _err('ESIGN_BAD_RECIPIENTS', `Signer ${i + 1} is not filled in.`);
    }

    const name = String(r.name == null ? '' : r.name).trim();
    if (name.length < 1 || name.length > MAX_RECIPIENT_NAME) {
      throw _err(
        'ESIGN_BAD_RECIPIENTS',
        `Signer ${i + 1} needs a name of 1–${MAX_RECIPIENT_NAME} characters.`
      );
    }

    const email = String(r.email == null ? '' : r.email).trim().toLowerCase();
    // Deliberately shape-only. Anything stricter rejects addresses that are
    // legal and deliverable; the authoritative test is whether the invitation
    // arrives, and a bounce is already a first-class status.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw _err('ESIGN_BAD_RECIPIENTS', `"${r.email}" is not a valid email address.`);
    }

    if (!Number.isInteger(r.order)) {
      throw _err('ESIGN_BAD_RECIPIENTS', `Signer ${i + 1} has no signing order.`);
    }
    return { name, email, order: r.order };
  });

  const orders = out.map((r) => r.order).sort((a, b) => a - b);
  const contiguous = orders.every((o, i) => o === i + 1);
  if (!contiguous) {
    throw _err(
      'ESIGN_BAD_RECIPIENTS',
      `Signing order must run 1..${out.length} with no gaps or repeats (got ${orders.join(', ')}).`
    );
  }

  const emails = out.map((r) => r.email);
  const dup = emails.find((e, i) => emails.indexOf(e) !== i);
  if (dup) {
    throw _err(
      'ESIGN_BAD_RECIPIENTS',
      `${dup} appears more than once. Each signer needs their own email address.`
    );
  }

  return out;
}

function _validateExpirationDays(raw) {
  if (raw == null || raw === '') return DEFAULT_EXPIRATION_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_EXPIRATION_DAYS || n > MAX_EXPIRATION_DAYS) {
    throw _err(
      'ESIGN_BAD_EXPIRATION',
      `Expiry must be a whole number of days between ${MIN_EXPIRATION_DAYS} and ${MAX_EXPIRATION_DAYS}.`
    );
  }
  return n;
}

/**
 * Does the thing we are about to attach this request to actually exist?
 *
 * Checked here rather than left to a foreign key because signing_requests has
 * none: linkable_id is a polymorphic varchar. Without this, a typo'd case id
 * produces a perfectly valid row that no case screen will ever show, and a
 * signed retainer files nowhere.
 *
 * linkable_id is bound as a STRING at every site — see the idx_sr_linkable
 * note in esignService's header.
 *
 * @throws ESIGN_BAD_LINKABLE
 */
async function _assertLinkableExists(db, linkableType, linkableId) {
  const id = String(linkableId == null ? '' : linkableId).trim();
  if (!id) throw _err('ESIGN_BAD_LINKABLE', 'No case or contact was selected.');

  if (linkableType === 'case') {
    const [[row]] = await db.query('SELECT case_id FROM cases WHERE case_id = ? LIMIT 1', [id]);
    if (!row) throw _err('ESIGN_BAD_LINKABLE', `Case "${id}" was not found.`);
    return id;
  }
  if (linkableType === 'contact') {
    const [[row]] = await db.query('SELECT contact_id FROM contacts WHERE contact_id = ? LIMIT 1', [id]);
    if (!row) throw _err('ESIGN_BAD_LINKABLE', `Contact "${id}" was not found.`);
    return id;
  }
  throw _err(
    'ESIGN_BAD_LINKABLE',
    `Invalid link type "${linkableType}" (expected one of: ${esignService.LINKABLE_TYPES.join(', ')}).`
  );
}

/**
 * Validate everything a send needs, in the order that fails cheapest first.
 *
 * SYNCHRONOUS except for the linkable existence check, which is the only rule
 * needing the database. Split that way so the pure rules are unit-testable
 * with no db at all.
 *
 * @returns {Promise<object>} the normalized, safe-to-persist input
 */
async function validateSendInput(db, {
  linkableType, linkableId, kind, documentName, recipients,
  placements = null, expirationDays = null,
} = {}) {
  if (!KINDS.includes(kind)) {
    // 2B: templates may DEFINE kinds beyond the static list. The legal set is
    // the union — KINDS ∪ kinds carried by ACTIVE templates. Lazy require:
    // sendService → templateService is the only direction; never the reverse.
    const templateKinds = await require('./esignTemplateService').listActiveTemplateKinds(db);
    if (!templateKinds.includes(kind)) {
      throw _err('ESIGN_BAD_KIND', `Unknown document kind "${kind}" (expected one of: ${[...new Set([...KINDS, ...templateKinds])].join(', ')}).`);
    }
  }

  const documentNameClean = _validateDocumentName(documentName);
  const recipientsClean   = _validateRecipients(recipients);
  const expiration        = _validateExpirationDays(expirationDays);

  if (placements != null) {
    // ONE validator, shared with the provider — see services/esign/placements.js.
    validatePlacements(placements);

    // Cross-check the two halves against each other. Neither validator can do
    // this alone: placements knows nothing about recipients, and the recipient
    // rules know nothing about fields. A field bound to signer 3 of a 2-signer
    // envelope is accepted by both and lands nowhere.
    const orders = new Set(recipientsClean.map((r) => r.order));
    for (const f of placements.fields) {
      if (f.type === 'text') continue; // filled locally; no signer to cross-check
      const signer = Number.isInteger(f.signer) ? f.signer : 1;
      if (!orders.has(signer)) {
        throw _err(
          'ESIGN_BAD_PLACEMENTS',
          `A signature field is assigned to signer ${signer}, but this document has ` +
          `${recipientsClean.length} signer(s) (orders ${[...orders].sort().join(', ')}).`
        );
      }
    }
  }

  const linkableIdClean = await _assertLinkableExists(db, linkableType, linkableId);

  return {
    linkableType,
    linkableId: linkableIdClean,
    kind,
    documentName: documentNameClean,
    recipients: recipientsClean,
    placements,
    expirationDays: expiration,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND
// ─────────────────────────────────────────────────────────────────────────────

/** now + days, as a Date. */
function _expiryFrom(days) {
  return new Date(Date.now() + days * MS_PER_DAY);
}

/**
 * Best-effort audit append. Used on paths where the ACTION already succeeded
 * and only the record-keeping can still fail — never swallow an event on a
 * path where the caller would otherwise learn nothing.
 */
async function _tryAppendEvent(db, id, payload) {
  try {
    await esignService.appendEvent(db, id, payload);
  } catch (err) {
    console.error(`[ESIGN SEND] could not append '${payload && payload.event}' to request ${id}: ${err.message}`);
  }
}

/**
 * BEST-EFFORT source storage (Phase 2E). Runs after a send has already
 * succeeded; a failure here degrades a future resend back to re-attach, and
 * that is ALL it may do — warn + event, never throw. Same posture as
 * esignFilingService for the same reason.
 */
async function _tryStoreSource(db, id, buffer) {
  try {
    await esignService.storeSourcePdf(db, id, buffer);
  } catch (err) {
    console.warn(`[ESIGN SEND] could not store source PDF for request ${id}: ${err.message}`);
    await _tryAppendEvent(db, id, {
      event: 'source_pdf_not_stored',
      payload: { error: err && err.message, code: err && err.code },
    });
  }
}

/**
 * Recover the reminder policy for a row from its provenance: a template-made
 * row (template_id set) answers with its template's {off, seqId}; a one-time
 * row answers null, which _tryEnrollReminders reads as "fall to the firm
 * default". Used wherever a send happens WITHOUT the template in hand — the
 * draft-retry path, and both resend branches. Never throws: an unreadable
 * template degrades to the firm-default rung, not to a failed send.
 */
async function _reminderPolicyForRow(db, row) {
  if (!row || !row.template_id) return null;
  try {
    const t = await require('./esignTemplateService').getTemplate(db, row.template_id);
    if (!t) return null;
    return { off: Boolean(t.reminders_off), seqId: t.reminder_seq_id || null };
  } catch (err) {
    console.warn(`[ESIGN SEND] could not read template ${row.template_id} for reminder policy: ${err.message}`);
    return null;
  }
}

/**
 * BEST-EFFORT reminder enrollment (Phase 3). Runs after a send has already
 * succeeded, so — like source storage and credits above — a failure here may
 * warn, event and NOTHING else. A client not getting nudges is a smaller
 * failure than a sent envelope reported as an error.
 *
 * ── THE RESOLUTION LADDER ────────────────────────────────────────────────────
 *   1. reminderPolicy.off === true            → no reminders (template said so)
 *   2. reminderPolicy.seqId                   → that sequence template
 *   3. app_settings.esign_reminder_seq_id     → the firm default
 *   4. otherwise                              → no reminders
 * One-time uploads pass no policy and land on rung 3/4.
 *
 * ── WHO GETS ENROLLED ────────────────────────────────────────────────────────
 * Sequences are contact-keyed. The enrollment contact is debtor1 exactly as
 * the prefill layer defines it (esignPrefillService.buildContext): the case's
 * Primary relate, MIN(contact_id) tiebreak; a contact-linked send stands in as
 * its own debtor1. No resolvable contact → event, no enrollment. The signer
 * EMAILS are deliberately not matched against contacts — recipients can be a
 * spouse's shared inbox or a paralegal, and the reminder clock belongs to the
 * case's client either way.
 *
 * ── WIRING ───────────────────────────────────────────────────────────────────
 * trigger_data carries signing_request_id (the seq step's esign_remind param
 * AND the engine's duplicate-enrollment scope — Phase 3 migration), plus
 * case_id/tracking_id/document_name for step-copy placeholders. The
 * enrollment id is written back to signing_requests.seq_instance_id (the 1A
 * pointer), which is what applyStatus cancels on a terminal transition.
 * Lazy require of sequenceEngine: it reaches internal_functions/esign, which
 * requires esignService — call-time require breaks the load cycle.
 */
async function _tryEnrollReminders(db, row, reminderPolicy) {
  try {
    if (reminderPolicy && reminderPolicy.off === true) return { enrolled: false, reason: 'template_off' };

    let seqTemplateId = reminderPolicy && reminderPolicy.seqId ? Number(reminderPolicy.seqId) : null;
    if (!seqTemplateId) {
      const { getSettings } = require('./settingsService');
      const s = await getSettings(db, ['esign_reminder_seq_id']);
      const v = s.esign_reminder_seq_id != null ? String(s.esign_reminder_seq_id).trim() : '';
      seqTemplateId = /^\d+$/.test(v) ? Number(v) : null;
    }
    if (!seqTemplateId) return { enrolled: false, reason: 'no_sequence_configured' };

    const { buildContext } = require('./esignPrefillService');
    // OPTIONS-OBJECT signature — buildContext(db, { linkableType, linkableId }).
    // The original Phase 3 code called it positionally; a string second arg
    // destructures to {linkableType: undefined} and returns an EMPTY context,
    // so every send evented reminders_not_enrolled/no_contact even with a
    // Primary relate present (live request 23). The mock in the test suite
    // hid the drift — see the signature-contract test in esignReminders.
    const ctx = await buildContext(db, {
      linkableType: row.linkable_type,
      linkableId:   row.linkable_id,
    });
    const contactId = ctx && ctx.debtor1 ? Number(ctx.debtor1.contact_id) : null;
    if (!contactId) {
      await _tryAppendEvent(db, row.id, {
        event: 'reminders_not_enrolled',
        payload: { reason: 'no_contact', seq_template_id: seqTemplateId },
      });
      return { enrolled: false, reason: 'no_contact' };
    }

    const { enrollContactByTemplateId } = require('../lib/sequenceEngine');
    const triggerData = {
      signing_request_id: row.id,
      tracking_id:        row.tracking_id,
      document_name:      row.document_name,
      ...(row.linkable_type === 'case' ? { case_id: row.linkable_id } : {}),
    };
    const enrollment = await enrollContactByTemplateId(db, contactId, seqTemplateId, triggerData);

    await esignService.setSeqInstance(db, row.id, enrollment.enrollmentId);
    await _tryAppendEvent(db, row.id, {
      event: 'reminders_enrolled',
      payload: {
        enrollment_id: enrollment.enrollmentId,
        seq_template_id: seqTemplateId,
        sequence_name: enrollment.templateName,
        first_reminder_at: enrollment.firstJobScheduledAt,
        contact_id: contactId,
      },
    });
    return { enrolled: true, enrollmentId: enrollment.enrollmentId };
  } catch (err) {
    console.warn(`[ESIGN SEND] reminder enrollment failed for request ${row.id}: ${err.message}`);
    await _tryAppendEvent(db, row.id, {
      event: 'reminders_enroll_failed',
      payload: { error: err && err.message },
    });
    return { enrolled: false, reason: 'error', error: err && err.message };
  }
}

/**
 * Stamp → send → mark sent → spend a credit.
 *
 * @param {object} db
 * @param {object} o
 * @param {string}  o.linkableType    'case' | 'contact'
 * @param {string}  o.linkableId
 * @param {string}  o.kind            one of KINDS
 * @param {string}  o.documentName    debtor-visible
 * @param {Array}   o.recipients      [{name, email, order}]
 * @param {object}  [o.placements]    neutral schema
 * @param {number}  [o.expirationDays=14]
 * @param {number}  o.createdBy       users.user; 0 for automation
 * @param {Buffer}  o.pdfBuffer
 * @param {object}  [o.textValues]    key → string for `text` placement fields
 *                                    (one-time upload flow); pdf-template sends
 *                                    pass their resolved prefills here too.
 *                                    Fields whose key is absent/empty stay
 *                                    blank — visibly, not silently (pdfFill
 *                                    reports them; required-value policy is
 *                                    the template layer's, not this one's).
 * @param {number}  [o.draftId]       reuse an existing draft row instead of
 *                                    minting one (retry after a failed send)
 * @param {number}  [o.templateId]    contract_templates.id when the document
 *                                    came from a template (2B) — provenance
 *                                    only, stored on the row, never dereferenced
 * @returns {Promise<{row: object, testing: boolean}>}
 */
async function sendPipeline(db, {
  linkableType, linkableId, kind, documentName, recipients,
  placements = null, expirationDays = null, createdBy, pdfBuffer, draftId = null,
  templateId = null, textValues = null, reminderPolicy = null,
} = {}) {
  let row;

  if (draftId != null) {
    // ── retry path ──────────────────────────────────────────────────────────
    // The row already carries a tracking_id, and that id may already be printed
    // on a document in the client's inbox from a previous partial attempt. Its
    // metadata therefore wins over anything the caller re-sends, except the
    // fields they are explicitly allowed to correct (recipients, name).
    row = await esignService.getById(db, draftId);
    if (!row) throw _err('ESIGN_NOT_FOUND', `Signing request ${draftId} not found.`);
    if (row.status !== 'draft') {
      throw _err(
        'ESIGN_NOT_DRAFT',
        `Signing request ${draftId} is '${row.status}', not a draft, so it cannot be sent. ` +
        `Recall it first, or create a new request.`
      );
    }

    const merged = await validateSendInput(db, {
      linkableType:   linkableType || row.linkable_type,
      linkableId:     linkableId   != null ? linkableId : row.linkable_id,
      kind:           kind         || row.kind,
      documentName:   documentName || row.document_name,
      recipients:     recipients   || row.recipients,
      placements:     placements   != null ? placements : row.placement_json,
      expirationDays,
    });

    // Persisted so the row reflects what we are ABOUT to send, not what was
    // first drafted — otherwise a corrected email address exists only in the
    // provider and the audit trail disagrees with reality.
    await db.query(
      'UPDATE signing_requests SET document_name = ?, recipients = ?, placement_json = ? WHERE id = ?',
      [
        merged.documentName,
        JSON.stringify(esignService._normalizeRecipients(merged.recipients)),
        merged.placements == null ? null : JSON.stringify(merged.placements),
        row.id,
      ]
    );
    row = await esignService.getById(db, row.id);
    row.__send = merged;
  } else {
    // ── first send ──────────────────────────────────────────────────────────
    const clean = await validateSendInput(db, {
      linkableType, linkableId, kind, documentName, recipients, placements, expirationDays,
    });
    row = await esignService.createRequest(db, {
      linkableType:  clean.linkableType,
      linkableId:    clean.linkableId,
      kind:          clean.kind,
      documentName:  clean.documentName,
      recipients:    clean.recipients,
      placementJson: clean.placements,
      templateId,
      createdBy,
    });
    row.__send = clean;
  }

  const send = row.__send;
  delete row.__send;

  // TEXT FILL (Phase 2E) — values become ink BEFORE stamping, so the buffer
  // stored as the row's source below already carries them: a resend re-stamps
  // and never loses the fill-ins. With no textValues (or no text fields in
  // the placements) this is an identity pass returning the original buffer.
  let sourceBuffer = pdfBuffer;
  if (textValues && send.placements) {
    const filledOut = await fillTextFields(pdfBuffer, send.placements, textValues);
    sourceBuffer = filledOut.buffer;
  }

  // Stamped AFTER the row exists, because the id being stamped is the row's.
  const stamped = await stampTrackingFooter(sourceBuffer, row.tracking_id);

  const provider = await getProvider(db, row.provider);

  let result;
  try {
    result = await provider.sendForSignature({
      pdfBuffer:      stamped,
      documentName:   send.documentName,
      recipients:     send.recipients,
      placements:     send.placements || { fields: [] },
      expirationDays: send.expirationDays,
    });
  } catch (err) {
    // The row stays a DRAFT. Nothing was sent, so no status has changed and
    // no credit was spent; the only thing worth recording is that we tried.
    await _tryAppendEvent(db, row.id, {
      event: 'send_failed',
      payload: {
        error: err && err.message,
        code: err && err.code,
        provider_code: err && err.providerCode,
        // Zoho names the offending parameter (error_param) and the raw body
        // often says more than the message — keep both. The 9011 hunt of
        // 2026-07-20 would have been a one-look diagnosis with these stored.
        provider_param: err && err.providerParam,
        provider_raw: err && err.providerRaw,
        http_status: err && err.httpStatus,
      },
    });
    // draftId travels on the error so the caller can retry this exact row and
    // keep the tracking id it already has.
    err.draftId = row.id;
    throw err;
  }

  const sentAt = new Date();
  const updated = await esignService.markSent(db, row.id, {
    providerId: result.providerId,
    sentAt,
    expiresAt: new Date(sentAt.getTime() + send.expirationDays * MS_PER_DAY),
  });

  // ── source storage (Phase 2E) ─────────────────────────────────────────────
  // The filled-but-unstamped bytes, kept so a bounced/terminal resend never
  // needs the document re-attached, and as the audit copy of what went out
  // (minus the deterministic footer). BEST-EFFORT after the send is already a
  // fact: a storage hiccup must not un-say a successful send. Draft retries
  // upsert — the retried bytes may carry corrected fill-ins.
  await _tryStoreSource(db, row.id, sourceBuffer);

  // ── reminder enrollment (Phase 3) ─────────────────────────────────────────
  // Same best-effort posture, same reason. `updated` (post-markSent) carries
  // the fields trigger_data wants. An explicit policy (sendFromTemplate) wins;
  // otherwise the row's own template provenance answers (covers the draft-
  // retry and duplicate-resend paths, which reach here without a template in
  // hand); a one-time row falls through to the firm default inside.
  await _tryEnrollReminders(db, updated, reminderPolicy || await _reminderPolicyForRow(db, updated));

  // ── credits ───────────────────────────────────────────────────────────────
  // ONLY for a real send. In test mode Zoho bills nothing, and decrementing a
  // local estimate for a free envelope would make the estimate drift down and
  // raise a low-credit alarm that is simply wrong.
  if (result.testing === false) {
    try {
      const spend = await recordCreditSpend(db);
      if (spend && spend.ok === false && spend.reason === 'error') {
        await _tryAppendEvent(db, row.id, {
          event: 'credit_spend_failed',
          payload: { reason: spend.reason, error: spend.error },
        });
      }
    } catch (err) {
      // recordCreditSpend is documented never to throw. If it ever does, the
      // envelope is still out and the send still succeeded.
      console.error(`[ESIGN SEND] credit accounting threw for request ${row.id}: ${err.message}`);
      await _tryAppendEvent(db, row.id, {
        event: 'credit_spend_failed',
        payload: { reason: 'threw', error: err && err.message },
      });
    }
  }

  return { row: updated, testing: result.testing };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESEND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send it again. TWO different operations wear this name, and which one you get
 * depends on why the first attempt ended.
 *
 *   (a) BOUNCED  → same row. The document is unchanged and the client never
 *                  received it; only the address was wrong. Reusing the row
 *                  keeps ONE tracking id for what is, to everyone involved,
 *                  one document — and markSent preserves the dead provider_id
 *                  in the event payload so the first attempt is still on file.
 *
 *   (b) TERMINAL (declined / recalled / expired) → new row. Something happened
 *                  that a court might care about: the debtor refused, or the
 *                  firm pulled it, or it timed out. Overwriting that row would
 *                  destroy the record of it. So the old row stays terminal and
 *                  a fresh one is minted, with events on BOTH pointing at each
 *                  other.
 *
 *   (c) anything else → refused. An active request must be recalled first, and
 *                  that has to be a deliberate act by a person, because it
 *                  invalidates a link the client may be looking at right now.
 *
 * @returns {Promise<{row, testing, mode:'same_row'|'duplicated', supersededId?:number}>}
 */
async function resendPipeline(db, id, { recipients = null, pdfBuffer, createdBy } = {}) {
  const row = await esignService.getById(db, id);
  if (!row) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);

  // ── document sourcing (Phase 2E) ────────────────────────────────────────
  // A resend needs bytes, but since sends store their source, the caller no
  // longer has to supply them: an explicit upload WINS (a replacement is a
  // deliberate act), else the stored source (already text-filled; both
  // branches only re-stamp), else a clear refusal. A failing storage READ is
  // surfaced as its own error, not conflated with "never stored".
  if (!pdfBuffer) {
    let stored;
    try {
      stored = await esignService.getSourcePdf(db, row.id);
    } catch (err) {
      throw _err('ESIGN_SOURCE_UNAVAILABLE',
        `The stored copy of this document could not be read (${err.message}). ` +
        `Attach the PDF manually and try again.`);
    }
    if (!stored) {
      throw _err('ESIGN_BAD_PDF',
        'A document is required to re-send, and no copy of the original was stored ' +
        '(this request predates source storage, or storing it failed at send time). ' +
        'Attach the PDF as the `file` part of a multipart upload, or send it as `pdf_base64`.');
    }
    pdfBuffer = stored.buffer;
  }

  // ── (a) same-row resend after a bounce ──────────────────────────────────
  if (RESENDABLE_SAME_ROW.has(row.status)) {
    const recips = _validateRecipients(recipients || row.recipients);

    if (recipients) {
      await db.query(
        'UPDATE signing_requests SET recipients = ? WHERE id = ?',
        [JSON.stringify(esignService._normalizeRecipients(recips)), row.id]
      );
    }

    // SAME tracking id — that is the whole point of reusing the row.
    const stamped  = await stampTrackingFooter(pdfBuffer, row.tracking_id);
    const provider = await getProvider(db, row.provider);

    const expirationDays = DEFAULT_EXPIRATION_DAYS;
    let result;
    try {
      result = await provider.sendForSignature({
        pdfBuffer:    stamped,
        documentName: row.document_name,
        recipients:   recips,
        placements:   row.placement_json || { fields: [] },
        expirationDays,
      });
    } catch (err) {
      await _tryAppendEvent(db, row.id, {
        event: 'send_failed',
        payload: { resend: true, error: err && err.message, code: err && err.code },
      });
      err.draftId = row.id;
      throw err;
    }

    const sentAt = new Date();
    // bounced → sent. markSent records previous_provider_id itself.
    const updated = await esignService.markSent(db, row.id, {
      providerId: result.providerId,
      sentAt,
      expiresAt: new Date(sentAt.getTime() + expirationDays * MS_PER_DAY),
    });

    // Same row, same document — but a caller MAY have attached a replacement
    // PDF, and the stored source must always be the bytes that actually went
    // out. Upserting the (possibly identical) buffer keeps that invariant
    // without needing to know which case this was.
    await _tryStoreSource(db, row.id, pdfBuffer);

    // ── reminders (Phase 3) ─────────────────────────────────────────────────
    // A bounce never cancelled the enrollment (cancellation is TERMINAL-only),
    // so usually the clock is still running and the dup guard would refuse a
    // second one anyway. Re-arm ONLY when the prior enrollment is finished or
    // was never made — e.g. the sequence ran out while the envelope sat
    // bounced, and this resend opens a fresh 14-day window that deserves
    // fresh nudges. Policy rung: this path has no template in hand, so the
    // row's own provenance decides — a template-made row re-reads its
    // template's policy; a one-time row falls to the firm default.
    let priorActive = false;
    if (updated.seq_instance_id) {
      try {
        const [enr] = await db.query(
          `SELECT status FROM sequence_enrollments WHERE id = ? LIMIT 1`,
          [updated.seq_instance_id]
        );
        priorActive = Boolean(enr.length && enr[0].status === 'active');
      } catch (_) { /* unknowable → treat as inactive; the dup guard is the backstop */ }
    }
    if (!priorActive) {
      await _tryEnrollReminders(db, updated, await _reminderPolicyForRow(db, updated));
    }

    if (result.testing === false) {
      try { await recordCreditSpend(db); } catch (_) { /* see sendPipeline */ }
    }

    return { row: updated, testing: result.testing, mode: 'same_row' };
  }

  // ── (b) duplicate a terminal request as a new draft ─────────────────────
  if (esignService.TERMINAL.has(row.status)) {
    const recips = _validateRecipients(recipients || row.recipients);

    const draft = await esignService.createRequest(db, {
      linkableType:  row.linkable_type,
      linkableId:    row.linkable_id,
      kind:          row.kind,
      documentName:  row.document_name,
      recipients:    recips,
      placementJson: row.placement_json,
      templateId:    row.template_id,
      createdBy,
      provider:      row.provider,
    });

    // Cross-reference BEFORE sending. If the send then fails, the link between
    // the two rows still exists and the new draft is retryable rather than
    // looking like an orphan somebody created by accident.
    await _tryAppendEvent(db, row.id, {
      event: 'superseded_by',
      payload: { new_request_id: draft.id, new_tracking_id: draft.tracking_id, from_status: row.status },
    });
    await _tryAppendEvent(db, draft.id, {
      event: 'duplicates',
      payload: { previous_request_id: row.id, previous_tracking_id: row.tracking_id, previous_status: row.status },
    });

    const out = await sendPipeline(db, {
      draftId:   draft.id,
      recipients: recips,
      createdBy,
      pdfBuffer,
    });
    return { ...out, mode: 'duplicated', supersededId: row.id };
  }

  // ── (c) refuse ──────────────────────────────────────────────────────────
  throw _err(
    'ESIGN_RESEND_INVALID_STATE',
    `This request is '${row.status}'. Only a bounced request can be re-sent directly, and only a ` +
    `declined, recalled or expired one can be duplicated. Recall it first if you want to start again.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RECALL / REMIND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull an envelope back.
 *
 * A DRAFT never reached the provider, so there is nothing to recall there —
 * calling Zoho with a NULL provider_id would be a guaranteed 4xx. The row is
 * simply moved to 'recalled', which the transition table permits from draft.
 *
 * `reason` is stored LOCALLY and only locally: Zoho's recall endpoint accepts
 * no reason field. The event payload records that fact explicitly so nobody
 * later assumes the client was told why.
 */
async function recallPipeline(db, id, { reason, createdBy = null } = {}) {
  const row = await esignService.getById(db, id);
  if (!row) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);

  const reasonClean = String(reason == null ? '' : reason).trim();
  if (reasonClean.length < 1 || reasonClean.length > MAX_REASON) {
    throw _err('ESIGN_BAD_REASON', `A recall reason of 1–${MAX_REASON} characters is required.`);
  }

  if (esignService.TERMINAL.has(row.status)) {
    throw _err(
      'ESIGN_RECALL_INVALID_STATE',
      `This request is already '${row.status}' and cannot be recalled.`
    );
  }

  let reasonSentToProvider = false;
  if (row.status !== 'draft') {
    if (!row.provider_id) {
      throw _err(
        'ESIGN_RECALL_INVALID_STATE',
        `This request is '${row.status}' but carries no provider id, so it cannot be recalled ` +
        `at the provider. This is a data inconsistency — check the audit trail.`
      );
    }
    const provider = await getProvider(db, row.provider);
    const out = await provider.recall(row.provider_id, reasonClean);
    reasonSentToProvider = Boolean(out && out.reasonSentToProvider);
  }

  const applied = await esignService.applyStatus(db, id, { status: 'recalled' });

  await _tryAppendEvent(db, id, {
    event: 'recalled',
    payload: {
      reason: reasonClean,
      reasonSentToProvider,
      by: createdBy,
      from_status: row.status,
      provider_called: row.status !== 'draft',
    },
  });

  return { row: applied.request, changed: applied.changed };
}

/**
 * Nudge the signer(s).
 *
 * Zoho reminds EVERY pending recipient and exposes no per-recipient parameter,
 * so the return says remindedAll:true and the caller must not tell a user it
 * nudged one person. A draft has nobody to remind; a terminal request has
 * nothing outstanding.
 */
async function remindPipeline(db, id, { createdBy = null } = {}) {
  const row = await esignService.getById(db, id);
  if (!row) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);

  if (!REMINDABLE.has(row.status)) {
    throw _err(
      'ESIGN_REMIND_INVALID_STATE',
      `This request is '${row.status}'. A reminder can only be sent while it is awaiting signature.`
    );
  }
  if (!row.provider_id) {
    throw _err('ESIGN_REMIND_INVALID_STATE', 'This request has no provider id, so no reminder can be sent.');
  }

  const provider = await getProvider(db, row.provider);
  const out = await provider.remind(row.provider_id);

  // 'reminded' is already on esignWebhookService's LOGGED_EVENTS allowlist, so
  // appending it here is what puts \"we chased them\" in the case log.
  await _tryAppendEvent(db, id, {
    event: 'reminded',
    payload: { remindedAll: true, by: createdBy, recipient_count: (row.recipients || []).length },
  });

  return { remindedAll: true, raw: out && out.raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// SATISFIED EXTERNALLY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The client signed on paper, or in the office, or faxed it back.
 *
 * The obligation IS discharged — 'satisfied_external' is a terminal SUCCESS in
 * esignService and stamps completed_at — so the order of operations matters:
 * the status is applied FIRST, then the provider is told, then the document is
 * filed. Filing or recalling can fail; the fact that the client signed cannot
 * be made un-true by a Dropbox outage.
 *
 * @param {object} o
 * @param {string} [o.note]        why, in a human's words
 * @param {Buffer} [o.pdfBuffer]   the signed paper copy, scanned
 * @param {number} [o.createdBy]
 */
async function markSatisfiedExternal(db, id, { note = null, pdfBuffer = null, createdBy = null } = {}) {
  const row = await esignService.getById(db, id);
  if (!row) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);

  if (!SATISFIABLE.has(row.status)) {
    throw _err(
      'ESIGN_SATISFY_INVALID_STATE',
      `This request is '${row.status}' and cannot be marked satisfied outside the system.`
    );
  }

  const noteClean = note == null ? null : String(note).trim().slice(0, MAX_NOTE);

  const applied = await esignService.applyStatus(db, id, { status: 'satisfied_external' });
  const updated = applied.request;

  // ── best-effort recall ───────────────────────────────────────────────────
  // The envelope is still live at Zoho and the client could still open the link
  // and sign a SECOND copy. Worth closing; not worth failing over, because the
  // paper original is already in hand.
  const warnings = [];
  let providerRecalled = false;
  if (LIVE_AT_PROVIDER.has(row.status) && row.provider_id) {
    try {
      const provider = await getProvider(db, row.provider);
      await provider.recall(row.provider_id, 'Satisfied outside the system');
      providerRecalled = true;
    } catch (err) {
      warnings.push(
        `The request was marked satisfied, but the signing link could not be cancelled at the ` +
        `provider (${err.message}). Cancel it by hand in the Zoho Sign dashboard so the client ` +
        `cannot sign a second copy.`
      );
      await _tryAppendEvent(db, id, {
        event: 'recall_failed',
        payload: { context: 'satisfied_external', error: err && err.message, code: err && err.code },
      });
    }
  }

  // ── file the paper copy ──────────────────────────────────────────────────
  let filing = null;
  if (pdfBuffer) {
    // Same magic-byte and size rules as a send. No footer is stamped: this
    // document was signed outside our chain of custody and re-writing it now
    // would alter an executed instrument.
    if (pdfBuffer.length > MAX_PDF_BYTES) {
      warnings.push(`The uploaded copy is larger than ${MAX_PDF_BYTES / (1024 * 1024)}MB and was not filed.`);
    } else {
      filing = await esignFilingService.fileExternalDocument(db, updated, { buffer: pdfBuffer });
      if (!filing.filed) {
        warnings.push(
          filing.note ||
          `The request was marked satisfied, but the uploaded copy could not be filed (${filing.reason}). ` +
          `Save it to the case folder by hand.`
        );
      }
      if (filing.warnings && filing.warnings.length) warnings.push(...filing.warnings);
    }
  }

  await _tryAppendEvent(db, id, {
    event: 'satisfied_external',
    payload: {
      note: noteClean,
      by: createdBy,
      from_status: row.status,
      provider_recalled: providerRecalled,
      filed_path: filing && filing.signedPdfPath ? filing.signedPdfPath : null,
      warnings,
    },
  });

  return {
    row: await esignService.getById(db, id),
    changed: applied.changed,
    filed: Boolean(filing && filing.filed),
    signedPdfPath: filing ? filing.signedPdfPath : null,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE SEND (Phase 2B)
//
// The template branch: load → resolve prefills → interpolate → render →
// sendPipeline. Everything downstream of the render is the SAME pipeline an
// ad-hoc send uses — a template send is an ad-hoc send whose PDF happens to be
// manufactured rather than uploaded.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal HTML escape — the five characters that matter: & < > " ' */
function _escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Matches esignTemplateService.extractPlaceholders — broad on purpose. */
const _PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

/**
 * Replace every {{key}} in `body` with the HTML-ESCAPED value from `values`.
 *
 * Escaping is unconditional: a prefill value is DATA, never markup. A debtor
 * named <script>… renders as text; a value of 'Smith & Sons' renders as
 * 'Smith &amp; Sons' and displays correctly. Templates wanting markup put it
 * in the template body, where the author controls it.
 *
 * An unknown {{key}} at send time throws — the belt to
 * esignTemplateService's save-time braces. It can only fire when a value map
 * with a hole reaches this function (a bug upstream), and a contract shipping
 * with a literal '{{fee_amount}}' on it is the outcome this line exists to
 * prevent.
 *
 * @param {string} body
 * @param {Object<string,string>} values
 * @returns {string} html
 * @throws  ESIGN_UNDECLARED_PLACEHOLDER
 */
function interpolateTemplate(body, values) {
  const vals = values || {};
  return String(body == null ? '' : body).replace(_PLACEHOLDER_RE, (_, rawKey) => {
    const key = rawKey.trim();
    if (!Object.prototype.hasOwnProperty.call(vals, key)) {
      throw _err(
        'ESIGN_UNDECLARED_PLACEHOLDER',
        `The template body uses {{${key}}}, but no value was resolved or supplied for it.`
      );
    }
    return _escapeHtml(vals[key]);
  });
}

/**
 * The debtor-visible default document name: '{template.name} – {last name}'.
 * Last name = final whitespace token of the primary debtor's name. It only
 * needs to be HUMAN ("Retainer Agreement – Smith"), not legally perfect —
 * suffix-bearing names ('John Smith Jr') yield 'Jr', and staff can override
 * documentName when it matters.
 */
function _defaultTemplateDocName(templateName, context) {
  const debtorName = context && context.debtor1 && context.debtor1.contact_name
    ? String(context.debtor1.contact_name).trim()
    : '';
  if (!debtorName) return templateName;
  const tokens = debtorName.split(/\s+/).filter(Boolean);
  const last = tokens.length ? tokens[tokens.length - 1] : '';
  return last ? `${templateName} – ${last}` : templateName;
}

/**
 * Merge resolved prefills with caller-supplied values (CALLER WINS — the UI
 * shows staff the resolved defaults and lets them edit), format overrides by
 * their declared type, and interpolate.
 *
 * Shared by sendFromTemplate and previewFromTemplate so the preview a staff
 * member approves and the document that goes out are the SAME rendering path.
 *
 * @returns {Promise<{html, merged, missingRequired, context, template}>}
 */
async function _resolveAndInterpolate(db, template, { linkableType, linkableId, values }) {
  const esignPrefillService = require('./esignPrefillService');

  const linkable = linkableId != null && linkableId !== ''
    ? { linkableType, linkableId }
    : null;

  const resolved = await esignPrefillService.resolvePrefills(db, template, linkable);

  const schema = Array.isArray(template.prefill_schema) ? template.prefill_schema : [];
  const typeByKey = new Map(schema.map((e) => [e.key, e.type]));

  const merged = { ...resolved.values };
  if (values && typeof values === 'object') {
    for (const [k, v] of Object.entries(values)) {
      // Only DECLARED keys are accepted; a stray caller key has no type, no
      // placeholder, and no business on the document.
      if (!typeByKey.has(k)) continue;
      merged[k] = esignPrefillService.formatValue(typeByKey.get(k), v);
    }
  }

  const missingRequired = schema
    .filter((e) => e.required && (merged[e.key] == null || merged[e.key] === ''))
    .map((e) => e.key);

  return {
    merged,
    missingRequired,
    context: resolved.context,
    template,
    // Interpolated lazily by callers that get past the required check —
    // preview fills blanks instead of failing.
    interpolate: (vals) => interpolateTemplate(template.body, vals),
  };
}

/**
 * Send a document manufactured from a template.
 *
 * @param {object} db
 * @param {object} o
 * @param {number}  o.templateId
 * @param {string}  o.linkableType     'case' | 'contact'
 * @param {string}  o.linkableId
 * @param {object}  [o.values]         caller overrides, key → raw value; wins
 *                                     over resolved prefills
 * @param {Array}   o.recipients       [{name, email, order}] — recipients are
 *                                     ALWAYS explicit; a template does not
 *                                     guess who signs
 * @param {string}  [o.documentName]   default '{template.name} – {debtor1 last name}'
 * @param {number}  [o.expirationDays] default template.expiration_days
 * @param {number}  o.createdBy
 * @returns {Promise<{row, testing}>}
 * @throws  ESIGN_NOT_FOUND | ESIGN_TEMPLATE_INACTIVE | ESIGN_MISSING_PREFILL
 *          + everything sendPipeline throws
 */
async function sendFromTemplate(db, {
  templateId, linkableType, linkableId, values = null,
  recipients, documentName = null, expirationDays = null, createdBy,
} = {}) {
  const esignTemplateService = require('./esignTemplateService');
  const pdfRenderService     = require('./pdfRenderService');

  const template = await esignTemplateService.getTemplate(db, templateId);
  if (!template) throw _err('ESIGN_NOT_FOUND', `Template ${templateId} not found.`);
  if (!template.active) {
    throw _err(
      'ESIGN_TEMPLATE_INACTIVE',
      `Template "${template.name}" is inactive and cannot be sent. Reactivate it, or pick another.`
    );
  }

  const r = await _resolveAndInterpolate(db, template, { linkableType, linkableId, values });

  if (r.missingRequired.length) {
    throw _err(
      'ESIGN_MISSING_PREFILL',
      `Required value(s) are still empty: ${r.missingRequired.join(', ')}. ` +
      `Fill them in and send again.`,
      { missing: r.missingRequired }
    );
  }

  // ── document by template_type (Phase 2E) ──────────────────────────────────
  // html: interpolate the body → chromium render (2B pipeline).
  // pdf:  the stored source PDF IS the document; values become ink via the
  //       text placement fields (sendPipeline's fill step — merged values are
  //       pre-escape formatted strings, exactly what pdf-lib should draw).
  let pdfBuffer;
  let textValues = null;
  if (template.template_type === 'pdf') {
    const stored = await esignTemplateService.getTemplatePdf(db, template.id);
    if (!stored) {
      throw _err('ESIGN_TEMPLATE_NO_PDF',
        `Template "${template.name}" has no source PDF attached yet. ` +
        `Upload one in the template editor before sending.`);
    }
    pdfBuffer  = stored.buffer;
    textValues = r.merged;
  } else {
    const html = r.interpolate(r.merged);
    pdfBuffer = await pdfRenderService.renderHtmlToPdf(html);
  }

  return sendPipeline(db, {
    linkableType,
    linkableId,
    kind:           template.kind,
    documentName:   documentName || _defaultTemplateDocName(template.name, r.context),
    recipients,
    placements:     template.placement_json,
    expirationDays: expirationDays != null ? expirationDays : template.expiration_days,
    createdBy,
    pdfBuffer,
    textValues,
    templateId:     template.id,
    // Phase 3 — rungs 1+2 of the reminder resolution ladder; sendPipeline's
    // _tryEnrollReminders handles the firm-default and off rungs.
    reminderPolicy: { off: Boolean(template.reminders_off), seqId: template.reminder_seq_id || null },
  });
}

/**
 * Render a template to PDF WITHOUT sending — the authoring/pre-send preview.
 *
 * NEVER creates rows, NEVER calls the provider, NEVER spends credits: this
 * function touches esignTemplateService, esignPrefillService and the renderer,
 * and nothing else. With no linkable, resolvers are skipped and only defaults
 * + supplied values apply (authoring-time preview). Keys still empty render as
 * '' — a preview with blanks is information; a preview that 400s is not.
 * Inactive templates ARE previewable: the author deactivating and reworking a
 * template still needs to see it.
 *
 * @returns {Promise<{pdfBuffer: Buffer, missing: string[], template: {id,name}}>}
 */
async function previewFromTemplate(db, {
  templateId, linkableType = null, linkableId = null, values = null,
} = {}) {
  const esignTemplateService = require('./esignTemplateService');
  const pdfRenderService     = require('./pdfRenderService');

  const template = await esignTemplateService.getTemplate(db, templateId);
  if (!template) throw _err('ESIGN_NOT_FOUND', `Template ${templateId} not found.`);

  const r = await _resolveAndInterpolate(db, template, { linkableType, linkableId, values });

  // Fill every remaining hole with '' so interpolation cannot throw — the
  // schema is the complete key set, so this covers every declared placeholder,
  // and save-time validation guarantees the body declares nothing else.
  const filled = { ...r.merged };
  const schema = Array.isArray(template.prefill_schema) ? template.prefill_schema : [];
  for (const e of schema) {
    if (filled[e.key] == null) filled[e.key] = '';
  }

  // pdf-type templates preview via pdf-lib fill — no chromium involved, and
  // blanks stay blank on the page (information, not an error), matching the
  // html preview's fill-with-'' posture above.
  let pdfBuffer;
  if (template.template_type === 'pdf') {
    const stored = await esignTemplateService.getTemplatePdf(db, template.id);
    if (!stored) {
      throw _err('ESIGN_TEMPLATE_NO_PDF',
        `Template "${template.name}" has no source PDF attached yet. Upload one first.`);
    }
    const out = await fillTextFields(stored.buffer, template.placement_json, filled);
    pdfBuffer = out.buffer;
  } else {
    const html = r.interpolate(filled);
    pdfBuffer = await pdfRenderService.renderHtmlToPdf(html);
  }

  const missing = schema
    .filter((e) => filled[e.key] === '')
    .map((e) => e.key);

  return { pdfBuffer, missing, template: { id: template.id, name: template.name } };
}

/**
 * The complete legal `kind` set at this moment: static KINDS ∪ kinds on
 * active templates. What validateSendInput enforces; exported so the UI can
 * populate a picker from the same truth.
 */
async function legalKinds(db) {
  const templateKinds = await require('./esignTemplateService').listActiveTemplateKinds(db);
  return [...new Set([...KINDS, ...templateKinds])];
}

// ─────────────────────────────────────────────────────────────────────────────
// READS
//
// DIVERGENCE, reported: these two run SQL from outside esignService, which 1A's
// header says is the module everything talks to the database through. They are
// here because 1A exposes no general list reader and no event reader, and the
// brief forbids changing it. Fold them into esignService when it is next open.
// ─────────────────────────────────────────────────────────────────────────────

/** Whole days since sent_at, or null for anything not yet sent. */
function _daysPending(sentAt) {
  if (!sentAt) return null;
  const t = sentAt instanceof Date ? sentAt.getTime() : new Date(sentAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / MS_PER_DAY));
}

/**
 * UI-shaped rows. Deliberately NOT the raw row: recipients are reduced to
 * name/email/status so a list endpoint cannot leak a signer's IP address, and
 * raw_payload (which holds whatever the vendor last sent us) never leaves the
 * server at all.
 */
function _shapeForList(row) {
  return {
    id:            row.id,
    linkable_type: row.linkable_type,
    linkable_id:   row.linkable_id,
    kind:          row.kind,
    status:        row.status,
    document_name: row.document_name,
    tracking_id:   row.tracking_id,
    recipients:    (row.recipients || []).map((r) => ({
      name: r.name, email: r.email, status: r.status,
    })),
    sent_at:       row.sent_at,
    completed_at:  row.completed_at,
    expires_at:    row.expires_at,
    days_pending:  _daysPending(row.sent_at),
  };
}

async function listRequests(db, { linkableType = null, linkableId = null, status = null, outstanding = false } = {}) {
  if (outstanding) {
    const rows = await esignService.listOutstanding(db, { linkableType, linkableId });
    const filtered = status ? rows.filter((r) => r.status === status) : rows;
    return filtered.map(_shapeForList);
  }

  const where = [];
  const params = [];
  if (linkableType != null) {
    if (!esignService.LINKABLE_TYPES.includes(linkableType)) {
      throw _err('ESIGN_BAD_LINKABLE', `Invalid link type "${linkableType}".`);
    }
    where.push('linkable_type = ?');
    params.push(linkableType);
  }
  if (linkableId != null) {
    where.push('linkable_id = ?');
    params.push(String(linkableId));   // idx_sr_linkable — see esignService header
  }
  if (status != null) {
    if (!esignService.STATUSES.includes(status)) {
      throw _err('ESIGN_BAD_STATUS', `Unknown status "${status}".`);
    }
    where.push('status = ?');
    params.push(status);
  }

  const [rows] = await db.query(
    `SELECT * FROM signing_requests
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(sent_at, created_at) DESC, id DESC`,
    params
  );

  // getById's shaping (JSON hydration, recipients-always-an-array) is what the
  // rest of the subsystem relies on, so route the raw rows back through it
  // rather than re-implementing _shape here and letting the two drift.
  return (rows || []).map((r) => _shapeForList({
    ...r,
    recipients: typeof r.recipients === 'string'
      ? (() => { try { return JSON.parse(r.recipients); } catch { return []; } })()
      : (Array.isArray(r.recipients) ? r.recipients : []),
  }));
}

/** One request plus its full audit trail, newest event last. */
async function getRequestDetail(db, id) {
  const row = await esignService.getById(db, id);
  if (!row) throw _err('ESIGN_NOT_FOUND', `Signing request ${id} not found.`);

  const [events] = await db.query(
    `SELECT id, event, recipient_email, payload, occurred_at, created_at
       FROM signing_request_events
      WHERE signing_request_id = ?
      ORDER BY occurred_at ASC, id ASC`,
    [id]
  );

  return {
    request: {
      ..._shapeForList(row),
      provider:        row.provider,
      provider_id:     row.provider_id,
      placement_json:  row.placement_json,
      template_id:     row.template_id,
      seq_instance_id: row.seq_instance_id,
      signed_pdf_path: row.signed_pdf_path,
      cert_pdf_path:   row.cert_pdf_path,
      // Phase 2E: whether the unsigned source is stored — the resend dialog's
      // "re-attach optional" switch. Existence only; the blob has its own route.
      has_source:      await esignService.hasSourcePdf(db, id),
      created_by:      row.created_by,
      created_at:      row.created_at,
      updated_at:      row.updated_at,
    },
    events: (events || []).map((e) => ({
      ...e,
      payload: typeof e.payload === 'string'
        ? (() => { try { return JSON.parse(e.payload); } catch { return null; } })()
        : e.payload,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // pipelines
  sendPipeline,
  resendPipeline,
  recallPipeline,
  remindPipeline,
  markSatisfiedExternal,
  // template branch (2B)
  sendFromTemplate,
  previewFromTemplate,
  interpolateTemplate,
  legalKinds,
  // reads
  listRequests,
  getRequestDetail,
  // pure helpers
  stampTrackingFooter,
  validateSendInput,
  // constants — routes and tests share one source of truth
  KINDS,
  MAX_PDF_BYTES,
  MAX_REASON,
  MAX_NOTE,
  DEFAULT_EXPIRATION_DAYS,
  MIN_EXPIRATION_DAYS,
  MAX_EXPIRATION_DAYS,
  MAX_RECIPIENTS,
  // internal/test handles
  _validateDocumentName,
  _validateRecipients,
  _validateExpirationDays,
  _daysPending,
  _tryEnrollReminders,
  _reminderPolicyForRow,
};