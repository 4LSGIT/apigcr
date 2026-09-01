// services/templateRenderService.js
//
/**
 * TEMPLATE RENDER — values in, a PDF buffer out.
 * services/templateRenderService.js
 *
 * G1. Extracted verbatim from esignSendService's 2B template branch. One
 * question, one module: "given a contract_templates row and a thing to render
 * it for, what are the values and what does the finished document look like?"
 *
 * ── WHAT IT OWNS ────────────────────────────────────────────────────────────
 *   resolveTemplateValues   resolved prefills + caller overrides → merged map
 *                           (+ the required-still-empty list, for the caller's
 *                           own policy) — CALLER WINS, formatted by declared type
 *   fillBlanks              the preview posture: every declared key that is
 *                           still null/undefined becomes ''
 *   interpolateTemplate     {{key}} → HTML-ESCAPED value, or throw
 *   renderTemplateToPdf     html → chromium; pdf → pdf-lib text fill
 *   defaultDocumentName     '{template.name} – {debtor last name}'
 *
 * ── WHAT IT DELIBERATELY DOES NOT OWN ───────────────────────────────────────
 * No sending, no rows, no provider, no credits, no filing, no reminders, no
 * stamping — every one of those stays in esignSendService / esignService /
 * services/esign. This module never learns that e-signature exists; it is
 * reachable from a plain "generate a document" path that has no envelope
 * behind it. It also does not decide POLICY on the values it reports:
 * missingRequired and missing are FACTS, and the caller chooses whether an
 * empty required key is a 400 (send) or a blank on the page (preview).
 *
 * ── FILL-NOW vs FILL-LATER (why the send path does not use this render) ─────
 * renderTemplateToPdf has FILL-NOW semantics: a pdf-type template comes back
 * with its text values already drawn. That is exactly right for a preview and
 * for a standalone generated document, and exactly WRONG for the e-sign send
 * pipeline, which must fill AFTER placement validation and options_key
 * injection and BEFORE footer stamping. sendFromTemplate therefore keeps its
 * own pdf branch (stored blob + deferred textValues) and only uses this module
 * for the html branch. Do not "simplify" that back together.
 *
 * ── REQUIRE POSTURE ─────────────────────────────────────────────────────────
 * esignTemplateService / esignPrefillService / pdfRenderService / esign/pdfFill
 * are required INSIDE the functions that use them, matching esignSendService:
 * it keeps the dependency graph acyclic no matter who requires whom later, and
 * it keeps jest module mocks effective (a top-level binding captured at load
 * time defeats a per-suite mock of the render or the blob reader).
 */

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
//
// Repo convention (esignService, esignSendService, logService): construct,
// attach .code, throw. Codes and messages are UNCHANGED from esignSendService —
// routes map on the code and the UI shows the message.
// ─────────────────────────────────────────────────────────────────────────────

function _err(code, message, extra = null) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERPOLATION
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

// ─────────────────────────────────────────────────────────────────────────────
// VALUES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge resolved prefills with caller-supplied values (CALLER WINS — the UI
 * shows staff the resolved defaults and lets them edit), format overrides by
 * their declared type, and report which required keys are still empty.
 *
 * Shared by every consumer — send, preview, and any non-esign generate path —
 * so the document a staff member approves and the document that goes out are
 * the SAME rendering path.
 *
 * @param {object} db
 * @param {object} template                getTemplate-shaped row
 * @param {object} o
 * @param {string} [o.linkableType]        'case' | 'contact'
 * @param {string} [o.linkableId]          absent/empty → authoring-time
 *                                         resolution (resolvers skipped)
 * @param {object} [o.values]              caller overrides, key → raw value
 * @returns {Promise<{merged, missingRequired, context, template, interpolate}>}
 */
async function resolveTemplateValues(db, template, { linkableType, linkableId, values } = {}) {
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
    .filter((e) => {
      if (!e.required) return false;
      const v = merged[e.key];
      // options rows are LIST-valued: empty array = missing, same as '' for scalars.
      return v == null || v === '' || (Array.isArray(v) && v.length === 0);
    })
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
 * The PREVIEW posture, in one place: every declared key still null/undefined
 * becomes ''. The prefill_schema is the complete key set and save-time
 * validation guarantees the body declares nothing else, so after this call
 * interpolateTemplate cannot throw — a preview with blanks is information; a
 * preview that 400s is not.
 *
 * `missing` reports the keys that came out blank. It is deliberately NOT a
 * required-ness check: that is missingRequired's job, upstream, and a caller
 * that wants to refuse on a blank required key has already refused.
 *
 * Note options rows: a resolved-but-empty options value is `[]`, which is
 * neither null nor '', so it is left alone and does NOT appear in `missing`.
 * That matches the pre-extraction behavior exactly.
 *
 * @param {object} template
 * @param {object} merged
 * @returns {{filled: Object, missing: string[]}}
 */
function fillBlanks(template, merged) {
  const schema = Array.isArray(template && template.prefill_schema)
    ? template.prefill_schema
    : [];

  const filled = { ...(merged || {}) };
  for (const e of schema) {
    if (filled[e.key] == null) filled[e.key] = '';
  }

  const missing = schema
    .filter((e) => filled[e.key] === '')
    .map((e) => e.key);

  return { filled, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Template + a complete value map → a finished PDF buffer.
 *
 *   template_type 'pdf'   the stored source PDF IS the document; values become
 *                         ink via the text placement fields, drawn HERE
 *                         (pdf-lib, no chromium). Blanks stay blank on the
 *                         page — required-value policy lives upstream.
 *   otherwise ('html')    interpolate the body, then chromium.
 *
 * FILL-NOW: see the module header for why the e-sign SEND path deliberately
 * does not come through here for pdf-type templates.
 *
 * @param {object} db
 * @param {object} template   getTemplate-shaped row
 * @param {object} filled     complete value map (see fillBlanks)
 * @returns {Promise<Buffer>}
 * @throws  ESIGN_TEMPLATE_NO_PDF | ESIGN_UNDECLARED_PLACEHOLDER
 *          + everything pdfRenderService.renderHtmlToPdf throws
 */
async function renderTemplateToPdf(db, template, filled) {
  if (template && template.template_type === 'pdf') {
    const esignTemplateService = require('./esignTemplateService');
    const { fillTextFields }   = require('./esign/pdfFill');

    const stored = await esignTemplateService.getTemplatePdf(db, template.id);
    if (!stored) {
      throw _err('ESIGN_TEMPLATE_NO_PDF',
        `Template "${template.name}" has no source PDF attached yet. Upload one first.`);
    }
    const out = await fillTextFields(stored.buffer, template.placement_json, filled);
    return out.buffer;
  }

  const pdfRenderService = require('./pdfRenderService');
  const html = interpolateTemplate(template.body, filled);
  return pdfRenderService.renderHtmlToPdf(html);
}

// ─────────────────────────────────────────────────────────────────────────────
// NAMING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The debtor-visible default document name: '{template.name} – {last name}'.
 * Last name = final whitespace token of the primary debtor's name. It only
 * needs to be HUMAN ("Retainer Agreement – Smith"), not legally perfect —
 * suffix-bearing names ('John Smith Jr') yield 'Jr', and staff can override
 * documentName when it matters.
 *
 * @param {string} templateName
 * @param {object} context   resolveTemplateValues().context
 * @returns {string}
 */
function defaultDocumentName(templateName, context) {
  const debtorName = context && context.debtor1 && context.debtor1.contact_name
    ? String(context.debtor1.contact_name).trim()
    : '';
  if (!debtorName) return templateName;
  const tokens = debtorName.split(/\s+/).filter(Boolean);
  const last = tokens.length ? tokens[tokens.length - 1] : '';
  return last ? `${templateName} – ${last}` : templateName;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  interpolateTemplate,
  resolveTemplateValues,
  fillBlanks,
  renderTemplateToPdf,
  defaultDocumentName,
  // Generic value→safe-HTML escape. Exported because esignSendService's recall
  // notice needs the same escaper and TWO copies of an escaper is how one of
  // them quietly stops matching the other.
  escapeHtml: _escapeHtml,
};
