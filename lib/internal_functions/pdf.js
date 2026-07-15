// lib/internal_functions/pdf.js

const fns = {};

// ─────────────────────────────────────────────────────────────
// PDF (text extraction — services/pdfService.js)
// ─────────────────────────────────────────────────────────────
//
// The CHEAP text path for automations: pulls the PDF's embedded text
// layer via pdf-parse. NO OCR happens here and NO AI call happens here —
// scanned/image-only PDFs come back with empty or near-empty text. For
// scans, route the file to query_ai with an attachment instead.
//
// Sources (exactly one): a URL (SSRF-guarded fetch via
// pdfService.fetchPdfFromUrl) or Dropbox by path / shared link
// (dropboxService.downloadFile — the shared-link-as-handle pattern used
// throughout the dropbox category; a link resolving to a FOLDER fails
// inside the service with its own message).

/**
 * parse_pdf
 * Extract text from a born-digital PDF and expose it to later steps —
 * typically as query_ai's `input`. Text-layer extraction ONLY (no OCR).
 *
 * params:
 *   url                  {string?}  — https URL (SSRF-guarded, 25MB cap); OR
 *   dropbox_path         {string?}  — Dropbox file path; OR
 *   dropbox_link         {string?}  — Dropbox shared link resolving to a FILE
 *   credential_id        {number?}  — Dropbox credential override (ignored for url)
 *   pages                {string?}  — "2-4,6" page selection
 *   from_text            {string?}  — slice begins at this literal anchor
 *   to_text              {string?}  — slice ends before this literal anchor
 *   max_length           {number?}  — truncate text (default 100000 —
 *                                     workflows variable-store the text;
 *                                     don't let a 500-page brief blow up
 *                                     variable storage)
 *   normalize_whitespace {boolean?} — default true
 *   output_var           {string?}  — also copy output into this named
 *                                     variable (query_db/query_ai convention)
 *
 * Output (same-step): {{this.output.text}}, {{this.output.text_length}},
 * {{this.output.total_pages}}, {{this.output.truncated}}, ...
 * Later steps must use output_var (next step's `this` is reset).
 *
 * Errors: pdfService's coded errors (NOT_A_PDF, ENCRYPTED_PDF,
 * FILE_TOO_LARGE, SSRF_BLOCKED, FETCH_*, BAD_PAGES, ...) and Dropbox
 * errors propagate prefixed "parse_pdf: ..." — the step's error_policy
 * handles retry/stop.
 *
 * example config:
 *   {
 *     "function_name": "parse_pdf",
 *     "params": {
 *       "dropbox_path": "{{petition_path}}",
 *       "pages": "1-3",
 *       "output_var": "petition_text"
 *     },
 *     "set_vars": { "petition_pages": "{{this.output.total_pages}}" }
 *   }
 */

fns.parse_pdf = async (params, db) => {
    const pdfService = require('../../services/pdfService');      // deferred require (convention)
    const {
      url,
      dropbox_path,
      dropbox_link,
      credential_id,
      pages,
      from_text,
      to_text,
      max_length,
      normalize_whitespace,
      output_var = null,
    } = params;

    const MAX_BYTES = 25 * 1024 * 1024;

    // Exactly one source (mirrors the exclusiveOneOf meta at runtime).
    const sources = [url, dropbox_path, dropbox_link].filter(
      v => v !== undefined && v !== null && v !== ''
    );
    if (sources.length !== 1) {
      throw new Error('parse_pdf: provide exactly one of url, dropbox_path, dropbox_link');
    }

    console.log(`[PARSE_PDF] ${url ? `url=${url}` : dropbox_path ? `path="${dropbox_path}"` : `link=${dropbox_link}`}`);

    let result;
    try {
      // ── acquire bytes ──
      let buffer;
      if (url) {
        // pdfService's own 25MB default; do not override.
        buffer = await pdfService.fetchPdfFromUrl(url);
      } else {
        const dropbox = require('../../services/dropboxService'); // deferred require (convention)
        const dl = await dropbox.downloadFile(db, {
          path: dropbox_path,
          sharedLink: dropbox_link,
          ...(credential_id != null && { credentialId: credential_id }),
        });
        buffer = dl.buffer;
        if (buffer.length > MAX_BYTES) {
          throw new Error('file exceeds 25MB');
        }
      }

      // ── extract ──
      result = await pdfService.parsePdf(buffer, {
        pages: pages || null,
        fromText: from_text || null,
        toText: to_text || null,
        maxLength: Number(max_length) || 100000,
        normalizeWhitespace: normalize_whitespace !== false,
        output: 'concatenated',
      });
    } catch (err) {
      throw new Error(`parse_pdf: ${err.message}`);
    }

    const output = {
      text:           result.text,
      text_length:    result.textLength,
      total_pages:    result.totalPages,
      pages_returned: result.pagesReturned,
      truncated:      result.truncated,
      from_matched:   result.fromMatched,
      to_matched:     result.toMatched,
    };

    const set_vars = {};
    if (output_var) set_vars[output_var] = output;

    return { success: true, output, set_vars };
  };

fns.parse_pdf.__meta = {
  category: 'pdf',
  description: 'Extract text from a PDF (by URL, Dropbox path, or Dropbox file shared link) for use in later steps — e.g. feed {{this.output.text}} or an output_var into query_ai\'s input. TEXT-LAYER EXTRACTION ONLY, NO OCR: scanned/image-only PDFs return empty or near-empty text — for scans use query_ai with a file attachment instead. 25MB file cap. No AI call happens here.',
  params: [
    { name: 'url', type: 'string', required: false, placeholderAllowed: true,
      description: 'https URL to a PDF (SSRF-guarded fetch, 25MB cap).',
      example: '{{attachment_url}}' },
    { name: 'dropbox_path', type: 'string', required: false, placeholderAllowed: true,
      description: 'Dropbox file path. Leading/embedded spaces preserved.',
      example: '/ {{contact_name}} - {{caseId}}/petition.pdf' },
    { name: 'dropbox_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Dropbox shared link resolving to a FILE (a folder link fails).' },
    { name: 'credential_id', type: 'integer', required: false,
      description: 'Dropbox credential override (app_settings dropbox_credential_id, default 8). Ignored for url.' },
    { name: 'pages', type: 'string', required: false, placeholderAllowed: true, strictString: true,
      description: 'Page selection, "2-4,6" syntax. Omit for all pages (200-page render cap). pdfService rejects a non-string spec (BAD_PAGES).',
      example: '1-3' },
    { name: 'from_text', type: 'string', required: false, placeholderAllowed: true,
      description: 'Slice the text starting at this literal anchor (inclusive).' },
    { name: 'to_text', type: 'string', required: false, placeholderAllowed: true,
      description: 'Slice the text ending before this literal anchor.' },
    { name: 'max_length', type: 'integer', required: false, default: 100000, min: 1,
      description: 'Truncate extracted text to this many characters (default 100000 — keeps variable storage sane).' },
    { name: 'normalize_whitespace', type: 'boolean', required: false, default: true,
      description: 'Collapse runs of whitespace per line.' },
    { name: 'output_var', type: 'string', required: false, placeholderAllowed: true,
      description: 'Also copy the output object into this named workflow variable for later steps (query_db/query_ai convention). Access the text as {{varname.text}}.',
      example: 'petition_text' },
  ],
  exclusiveOneOf: [['url', 'dropbox_path', 'dropbox_link']],
  example: {
    dropbox_path: '/ {{contact_name}} - {{caseId}}/petition.pdf',
    pages: '1-3',
    output_var: 'petition_text'
  }
};

module.exports = fns;