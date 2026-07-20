// services/esign/pdfFill.js
//
/**
 * TEXT-FIELD FILL — draw resolved values into a PDF's text placements.
 * services/esign/pdfFill.js
 *
 * Phase 2E. The neutral placement schema (./placements.js) carries two field
 * classes: SIGNER fields (signature/initial/date) that the provider renders on
 * its signing page, and TEXT fields that WE render — this module — before the
 * document leaves the building. By the time Zoho receives the file, a text
 * field's value is ink on the page; zohoSignProvider skips the class entirely.
 *
 * Runs BEFORE stampTrackingFooter in the send pipeline: fill → stamp → send.
 * Both use pdf-lib; both preserve document metadata (`updateMetadata: false`)
 * and write classic xref tables (`useObjectStreams: false`) — see
 * stampTrackingFooter's header in esignSendService for why (old readers,
 * including this repo's own pdf-parse, choke on xref streams).
 *
 * ── GEOMETRY ────────────────────────────────────────────────────────────────
 * Placement boxes are PDF USER SPACE: origin bottom-left, points, y = the
 * box's BOTTOM edge. drawText's y is the text BASELINE. The baseline sits at
 * box-bottom + (boxH − fontSize)/2 + a small descender allowance, which
 * centers the glyphs vertically well enough for form fill-ins without font
 * metrics gymnastics.
 *
 * ── SIZING ──────────────────────────────────────────────────────────────────
 * Font size = field.font_size, else min(DEFAULT_SIZE, boxH − 2). If the value
 * is wider than the box at that size, the size shrinks until it fits, floored
 * at MIN_SIZE — below that the text simply overflows to the right rather than
 * becoming unreadable. A truncated fee amount on a legal document is worse
 * than an overflowing one; overflow is at least VISIBLY wrong.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * No validation of the placements object (callers run validatePlacements —
 * both send-service call sites already do), no resolution of values (the
 * prefill layer's job), no multi-line wrapping (fill-in boxes are single-line
 * by construction; a multi-line need is a template-body need). Missing/empty
 * values are SKIPPED here — required-value policy is enforced upstream where
 * the schema's `required` flags live; this module fills what it is given.
 *
 * Same known limitation as the footer stamp: rotated pages draw in unrotated
 * user space. Bankruptcy forms are not rotated.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const DEFAULT_SIZE = 11;   // points — matches typical form fill-in text
const MIN_SIZE     = 6;    // shrink floor; below this, overflow instead
const INK          = rgb(0.05, 0.05, 0.05); // near-black, distinguishable from pure print black

function _err(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** WinAnsi-safe: Helvetica cannot encode arbitrary unicode. Anything outside
    Latin-1 is replaced so a stray smart-quote from a paste cannot 500 a send.
    (encodeText throws on unencodable chars; replacing beats crashing, and the
    staff preview shows exactly what will print.) */
function winAnsiSafe(value) {
  // Printable Latin-1 plus the WinAnsi extras pdf-lib maps (curly quotes,
  // dashes, ellipsis, bullets). Anything else → '?'.
  return String(value).replace(/[^\x20-\x7E\xA0-\xFF\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u2022]/g, '?');
}

/**
 * Draw `values` into the text fields of `placements` on a copy of `pdfBuffer`.
 *
 * @param {Buffer} pdfBuffer
 * @param {object} placements  neutral schema (pre-validated by callers)
 * @param {Object<string,string>} values  key → string; missing/empty keys skip
 * @returns {Promise<{buffer: Buffer, filled: number, skipped: string[]}>}
 *          buffer   the filled document (the ORIGINAL buffer if there was
 *                   nothing to draw — zero-cost no-op for signer-only sends)
 *          filled   count of boxes drawn
 *          skipped  keys of text fields whose value was missing/empty
 * @throws  ESIGN_BAD_PDF on unloadable/encrypted input
 */
async function fillTextFields(pdfBuffer, placements, values = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw _err('ESIGN_BAD_PDF', 'No document was supplied to fill, or it was empty.');
  }

  const fields = (placements && Array.isArray(placements.fields) ? placements.fields : [])
    .filter((f) => f && f.type === 'text');

  if (fields.length === 0) {
    return { buffer: pdfBuffer, filled: 0, skipped: [] };
  }

  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  } catch (err) {
    const encrypted = /encrypt/i.test(err && err.message ? err.message : '');
    throw _err(
      'ESIGN_BAD_PDF',
      encrypted
        ? 'That PDF is password-protected or encrypted, so its fields cannot be filled. ' +
          'Save an unprotected copy and try again.'
        : `That PDF could not be read (${err && err.message}). It may be corrupt.`
    );
  }

  const font  = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  let filled = 0;
  const skipped = [];

  for (const f of fields) {
    const raw = values[f.key];
    if (raw == null || String(raw) === '') {
      skipped.push(f.key);
      continue;
    }
    const text = winAnsiSafe(raw);

    // 1-based neutral page → array index; out-of-range pages are an authoring
    // bug the editor should prevent, but a stored template can outlive a
    // re-uploaded shorter PDF — throw loud rather than draw on the wrong page.
    const idx = (Number.isInteger(f.page) ? f.page : 1) - 1;
    if (idx < 0 || idx >= pages.length) {
      throw _err(
        'ESIGN_INVALID_INPUT',
        `Text field "${f.key}" is placed on page ${idx + 1}, but the document has ` +
        `${pages.length} page(s). Re-open the placement editor and re-place it.`
      );
    }
    const page = pages[idx];

    const x = Number(f.x), y = Number(f.y), w = Number(f.w), h = Number(f.h);

    let size = Number(f.font_size) > 0
      ? Number(f.font_size)
      : Math.min(DEFAULT_SIZE, Math.max(MIN_SIZE, h - 2));

    // Shrink-to-fit with a floor; past the floor, overflow visibly.
    while (size > MIN_SIZE && font.widthOfTextAtSize(text, size) > w) {
      size -= 0.5;
    }

    page.drawText(text, {
      x,
      y: y + Math.max(0, (h - size) / 2) + size * 0.18, // vertical centering + descender lift
      size,
      font,
      color: INK,
    });
    filled += 1;
  }

  if (filled === 0) {
    return { buffer: pdfBuffer, filled: 0, skipped };
  }

  return {
    buffer: Buffer.from(await doc.save({ useObjectStreams: false })),
    filled,
    skipped,
  };
}

module.exports = { fillTextFields, winAnsiSafe, DEFAULT_SIZE, MIN_SIZE };
