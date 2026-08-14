// services/formPdfService.js
//
/**
 * FORM SUBMISSION → PDF — archival render of a submitted form, filed to
 * Dropbox. X5 (external-forms arc; supermanager charter 2026-08-13, Fred
 * amendments 2026-08-14).
 *
 * One consumer: the `render_submission_pdf` internal function
 * (lib/internal_functions/pdf.js, workflow-only). No route exposes this.
 *
 * ── WHAT THE PDF SHOWS ──────────────────────────────────────────────────────
 * Exactly what the submitter saw (Fred, Q5 2026-08-14):
 *   - The definition is resolved by formService.getSubmissionForRender — the
 *     version whose schema matches the submission, so answers meet the layout
 *     that produced them. schema_matched:false adds a visible note instead.
 *   - showWhen is evaluated server-side against the SUBMITTED data with the
 *     renderer's exact semantics (render.html evalCondition / yc-forms
 *     _evaluateConditionals: checkbox → 'true'/'false', checkgroup → the
 *     comma-joined selection; ops eq/neq/in/notEmpty/includes; array = AND).
 *     Hidden sections/rows/fields are omitted — collect() stores values for
 *     hidden fields too, and printing a value the submitter never saw would
 *     misrepresent the form.
 *   - `type:"hidden"` fields are omitted (never visible), `embed` is omitted
 *     (display-only iframe; also refused externally). Visible-but-blank
 *     fields print as "—".
 *   - select/radio/checkgroup print option LABELS (value→label via the
 *     definition's static options; dynamic optionsFrom values print raw).
 *     Masked fields print the display format (_formatMask semantics).
 *   - DELIBERATE DEVIATIONS from strict screen fidelity: side-by-side row
 *     columns flatten to a label/value list (print-reliable), and a section
 *     whose every field is hidden is skipped entirely rather than printing a
 *     stray heading.
 *
 * ── WHERE THE FILE GOES (the ladder) ────────────────────────────────────────
 * Fred's ruling 2026-08-14 (overriding the charter's "requires a linked
 * submission" — that term existed only for save-location, and the e-sign
 * ladder already solved save-location for non-case entities):
 *
 *   case-linked submission:
 *     1. live cases.case_dropbox → <case folder>/Forms/   (created if absent)
 *     2. no case_dropbox → caseService.ensureCaseDropboxFolder (the same
 *        stage-aware creator intake / e-sign / client-upload use), then (1).
 *        The auto-create ALWAYS raises a staff task — a silently-created
 *        duplicate next to a hand-made never-linked folder is worse than the
 *        task. Task raised at create time: the folder exists and is linked
 *        even if the upload then fails.
 *     3. dead link / create failure / case row gone → the UNSORTED FORM
 *        SUBMISSIONS bin (X5.1: its own bin, app_settings
 *        'dropbox_unsorted_forms_path'), in a per-case subfolder named by the
 *        client-upload convention ("{case_id} - {lfm name}") so a case's
 *        strays stay together — plus a move-task raised only AFTER the upload
 *        actually lands.
 *   contact / appt / unlinked submission:
 *     straight to the unsorted bin as a loose file with an identity prefix
 *     ("contact 12 - Jane Doe - ", "appt 45 - ", "submission 288 - Bob - "),
 *     the e-sign unsorted-filename convention. NO task: the Form Inbox
 *     already surfaces unlinked submissions, and a task per anonymous PDF
 *     would duplicate that signal. The verdict's placement/placement_note
 *     tell the workflow author, who owns any notification.
 *   everything failed (Dropbox unreachable) → throws; the workflow step's
 *     error_policy decides retry/stop. Note the file may not exist — but a
 *     RETRY that succeeds files a second copy only under autorename, which
 *     is the acceptable failure mode (atomic, never lost).
 *
 * ── TEMP LINK ───────────────────────────────────────────────────────────────
 * A files/get_temporary_link (~4h) rides the verdict for send_email's
 * attachment_urls — short expiry is the leak posture the charter chose (the
 * URL dies on its own instead of living forever in a mailbox). Minting it is
 * BEST-EFFORT after a successful upload: failing the whole function over the
 * link would re-file the PDF on retry, so the verdict carries
 * temp_link:null + a warning instead and the author guards.
 *
 * ── RENDERING ───────────────────────────────────────────────────────────────
 * pdfRenderService.renderHtmlToPdf: chromium with NETWORK BLOCKED, renders
 * serialized on the 1GiB container. The HTML built here is therefore fully
 * self-contained — inline CSS only, and the firm logo (app_settings
 * 'fe-firm_logo_url') is fetched by THIS process and inlined as a data URI,
 * memoized per URL. A logo fetch failure degrades to a text-only header,
 * never to a render error.
 */

'use strict';

const { DateTime } = require('luxon');
const dropboxService = require('./dropboxService');
const pdfRenderService = require('./pdfRenderService');
const taskService = require('./taskService');
// NOTE: deliberately NOT requiring uploadTargetService. X5.1 gave form PDFs
// their own unsorted bin (below), so the only thing left to share with the
// client-upload ladder was the per-case subfolder NAMING convention, which is
// 3 lines and already needs _casePrimaryName here.
const { getSetting } = require('./settingsService');
const { resolveAlertAssignee } = require('./esignAlertService');

const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';

/** Subfolder under the case folder. Created if absent (idempotent). */
const SUBFOLDER = 'Forms';

/**
 * The unsorted bin for form PDFs — X5.1, Fred 2026-08-14. Its OWN bin rather
 * than the client-uploads one: a client upload is a document the firm asked
 * for and must chase; a form PDF is a machine-generated archive of something
 * already recorded in the app. Mixing them makes the uploads bin a work queue
 * nobody can trust to be empty. Same shape as the esign/uploads bins (setting
 * if present, hardcoded default otherwise), so no migration is REQUIRED —
 * the app_settings row just makes it visible and editable in admin.
 */
const UNSORTED_PATH_KEY = 'dropbox_unsorted_forms_path';
const DEFAULT_UNSORTED_PATH = '/  Law Office/   Cases/  Unsorted Form Submissions';

/** app_settings key for the firm logo URL (the case-page header logo). */
const LOGO_URL_KEY = 'fe-firm_logo_url';

/** Logo fetch guards — a letterhead nicety must never sink a render. */
const LOGO_FETCH_TIMEOUT_MS = 8 * 1000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** tasks.task_source — marks these as machine-pushed. varchar(50). */
const TASK_SOURCE = 'form_pdf';

/** Longest form-title fragment allowed in a filename. */
const MAX_NAME_FRAGMENT = 100;

/** Longest identity prefix on an unsorted filename (e-sign convention). */
const MAX_PREFIX = 80;

// taskService.createTask THROWS above these rather than truncating (sql_mode
// is not strict). Clip so a task is never lost to a long name.
const MAX_TITLE = 100;
const MAX_DESC = 1000;

// tasks.task_link_id is varchar(20); real case ids are ~8 chars — tripwire.
const MAX_TASK_LINK_ID = 20;

/** Characters Dropbox rejects in a generated name (e-sign convention). */
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_NAME = /[/\\:*?"<>|\u0000-\u001f]/g;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * File-local HTML escaper — the repo's documented convention (no shared
 * export; see taskService.js). Every template- or submitter-sourced string
 * passes through here before entering the print HTML.
 */
function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Filesystem-safe fragment of a generated name (e-sign convention). */
function sanitizeNameFragment(name, max = MAX_NAME_FRAGMENT) {
  const cleaned = String(name == null ? '' : name)
    .replace(ILLEGAL_IN_NAME, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || 'form';
  return base.length <= max ? base : base.slice(0, max).trim();
}

/** Clip to `max`, marking the cut (esignAlertService convention). */
function _clip(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return `${str.slice(0, max - 14)}…(truncated)`;
}

/**
 * Submission timestamps are stored UTC; the filename and header show firm
 * time (the e-sign filing convention — the date a person looking for the
 * file will guess). created_at is used, NOT updated_at: linkSubmission (X4
 * adopt) bumps updated_at, so it stops meaning "submitted" the moment staff
 * touch the row.
 */
function _firmDate(d) {
  const dt = d
    ? DateTime.fromJSDate(d instanceof Date ? d : new Date(d), { zone: 'utc' }).setZone(FIRM_TZ)
    : DateTime.now().setZone(FIRM_TZ);
  return dt.isValid ? dt : DateTime.now().setZone(FIRM_TZ);
}

// ─────────────────────────────────────────────────────────────────────────────
// Condition evaluation — the renderer's semantics, over submitted data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One condition against the data object. EXACTLY render.html's evalCondition:
 * booleans (checkbox) stringify to 'true'/'false'; everything else String()s
 * with null/undefined → ''; checkgroup values are already the comma-joined
 * selection (collect() stores them that way).
 */
function evalCondition(c, all) {
  if (!c || typeof c !== 'object') return false;
  const raw = all[c.field];
  const cur = typeof raw === 'boolean' ? (raw ? 'true' : 'false')
    : (raw == null ? '' : String(raw));
  switch (c.op) {
    case 'eq': return cur === String(c.value != null ? c.value : '');
    case 'neq': return cur !== String(c.value != null ? c.value : '');
    case 'in': {
      const vals = Array.isArray(c.value) ? c.value : [c.value];
      return vals.some((v) => String(v != null ? v : '') === cur);
    }
    case 'notEmpty': return !!cur;
    case 'includes': {
      const want = (Array.isArray(c.value) ? c.value : [c.value])
        .map((v) => String(v != null ? v : '').trim())
        .filter(Boolean);
      const have = cur.split(',').map((s) => s.trim());
      return want.some((w) => have.indexOf(w) !== -1);
    }
    default: return false;
  }
}

/** A showWhen slot: absent → visible; array = AND (2.5A); object = one. */
function isVisible(sw, data) {
  if (sw == null) return true;
  if (Array.isArray(sw)) {
    if (sw.length === 0) return true;
    return sw.every((c) => evalCondition(c, data));
  }
  return evalCondition(sw, data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Value display — labels, masks, blanks
// ─────────────────────────────────────────────────────────────────────────────

/** {value,label} of one option entry (render.html optOf). */
function optOf(o) {
  if (o && typeof o === 'object') {
    return {
      value: String(o.value != null ? o.value : ''),
      label: String(o.label != null ? o.label : (o.value != null ? o.value : '')),
    };
  }
  return { value: String(o), label: String(o) };
}

/** Static-options value → label; unknown values (optionsFrom, Other) pass through. */
function _optionLabel(field, value) {
  const v = String(value == null ? '' : value);
  for (const o of field.options || []) {
    const op = optOf(o);
    if (op.value === v) return op.label;
  }
  return v;
}

/** Display format for masked values — yc-forms _formatMask semantics. */
function _formatMask(value, maskType) {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  switch (maskType) {
    case 'phone':
      if (digits.length === 10) return digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
      return String(value);
    case 'ssn':
      if (digits.length === 9) return digits.replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3');
      return String(value);
    case 'zip':
      if (digits.length === 5) return digits;
      if (digits.length === 9) return digits.replace(/^(\d{5})(\d{4})$/, '$1-$2');
      return String(value);
    case 'ein':
      if (digits.length === 9) return digits.replace(/^(\d{2})(\d{7})$/, '$1-$2');
      return String(value);
    case 'currency': {
      const num = parseFloat(String(value).replace(/[^\d.-]/g, ''));
      if (isNaN(num)) return String(value);
      return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    default:
      return String(value);
  }
}

/** Em dash for visible-but-blank (Fred, Q5). */
const BLANK = '\u2014';

/**
 * One field's display string. Checkboxes are Yes/No (an unanswered checkbox
 * IS an answer — No — so they never print the blank dash).
 */
function formatValue(field, raw) {
  const type = field.type;
  if (type === 'checkbox') {
    return (raw === true || raw === 'true') ? 'Yes' : 'No';
  }
  if (raw == null || String(raw) === '') return BLANK;
  if (type === 'select' || type === 'radio') return _optionLabel(field, raw);
  if (type === 'checkgroup' || type === 'tags') {
    const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return BLANK;
    return (type === 'checkgroup' ? parts.map((p) => _optionLabel(field, p)) : parts).join(', ');
  }
  if (type === 'datetime') return String(raw).replace('T', ' ');
  if (field.mask) return _formatMask(raw, field.mask);
  return String(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Print HTML
// ─────────────────────────────────────────────────────────────────────────────

/** Inline CSS — self-contained (network-blocked chromium). */
const PRINT_CSS = `
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a;
         font-size: 11pt; line-height: 1.45; margin: 0; }
  .hdr { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; margin-bottom: 16px; }
  .hdr img { max-height: 56px; max-width: 260px; display: block; margin-bottom: 8px; }
  h1 { font-size: 17pt; margin: 0 0 4px 0; }
  .meta { font-size: 9pt; color: #555; }
  .schema-note { font-size: 9pt; color: #8a5a00; background: #fff7e0;
                 border: 1px solid #e0c060; padding: 6px 8px; margin: 10px 0; }
  .tab-title { font-size: 13pt; font-weight: bold; border-bottom: 1px solid #999;
               margin: 18px 0 6px 0; padding-bottom: 2px; break-after: avoid; }
  .sec { margin: 12px 0; }
  .sec-title { font-size: 12pt; font-weight: bold; margin: 10px 0 2px 0; break-after: avoid; }
  .sec-subtitle { font-size: 9.5pt; color: #555; margin: 0 0 6px 0; break-after: avoid; }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv td { vertical-align: top; padding: 3px 6px; border-bottom: 1px solid #e5e5e5; }
  table.kv td.k { width: 38%; color: #444; font-size: 10pt; }
  table.kv td.v { white-space: pre-wrap; }
  table.kv tr { break-inside: avoid; }
  table.rep { width: 100%; border-collapse: collapse; margin: 4px 0 8px 0; font-size: 10pt; }
  table.rep th { text-align: left; border-bottom: 1.5px solid #888; padding: 3px 6px;
                 font-size: 9.5pt; color: #333; }
  table.rep td { border-bottom: 1px solid #e5e5e5; padding: 3px 6px; vertical-align: top;
                 white-space: pre-wrap; }
  table.rep tr { break-inside: avoid; }
  .none { color: #777; font-size: 10pt; font-style: italic; }
  .ftr { margin-top: 22px; padding-top: 6px; border-top: 1px solid #ccc;
         font-size: 8.5pt; color: #777; }
`;

/** kv rows for one standard section's visible fields. '' when none printable. */
function _sectionRowsHtml(section, data) {
  let rows = '';
  for (const row of section.rows || []) {
    if (!row || !isVisible(row.showWhen, data)) continue;
    for (const f of row.fields || []) {
      if (!f || !f.name) continue;
      if (f.type === 'hidden' || f.type === 'embed') continue;
      if (!isVisible(f.showWhen, data)) continue;
      const label = (f.label != null && f.label !== '') ? f.label : f.name;
      rows += `<tr><td class="k">${htmlEscape(label)}</td>` +
              `<td class="v">${htmlEscape(formatValue(f, data[f.name]))}</td></tr>`;
    }
  }
  return rows;
}

/** A repeater section as a table (headers = field labels). */
function _repeaterHtml(section, data) {
  const fields = (section.fields || []).filter((f) => f && f.name);
  const items = Array.isArray(data[section.repeater]) ? data[section.repeater] : [];
  let html = '';
  if (section.title) html += `<div class="sec-title">${htmlEscape(section.title)}</div>`;
  if (section.subtitle) html += `<div class="sec-subtitle">${htmlEscape(section.subtitle)}</div>`;
  if (!items.length) {
    html += `<div class="none">${BLANK} none ${BLANK}</div>`;
    return `<div class="sec">${html}</div>`;
  }
  const head = fields.map((f) =>
    `<th>${htmlEscape((f.label != null && f.label !== '') ? f.label : f.name)}</th>`).join('');
  const body = items.map((item) => {
    const cells = fields.map((f) =>
      `<td>${htmlEscape(formatValue(f, item && item[f.name]))}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  html += `<table class="rep"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  return `<div class="sec">${html}</div>`;
}

/** One list of sections (a container) to HTML. */
function _sectionsHtml(sections, data) {
  let html = '';
  for (const section of sections || []) {
    if (!section) continue;
    if (!isVisible(section.showWhen, data)) continue;
    if (Object.prototype.hasOwnProperty.call(section, 'repeater')) {
      html += _repeaterHtml(section, data);
      continue;
    }
    const rows = _sectionRowsHtml(section, data);
    // A visible section whose every field is hidden is skipped rather than
    // printing a stray heading (deliberate deviation — header comment).
    if (!rows) continue;
    let sec = '';
    if (section.title) sec += `<div class="sec-title">${htmlEscape(section.title)}</div>`;
    if (section.subtitle) sec += `<div class="sec-subtitle">${htmlEscape(section.subtitle)}</div>`;
    sec += `<table class="kv"><tbody>${rows}</tbody></table>`;
    html += `<div class="sec">${sec}</div>`;
  }
  return html;
}

/**
 * The complete, self-contained print HTML for one submission.
 *
 * PURE — everything network- or DB-derived (logo data URI, link label)
 * arrives precomputed, which is also what makes it unit-testable.
 *
 * @param {object} bundle   formService.getSubmissionForRender's return
 * @param {object} [opts]   { logoDataUri?:string|null, linkLabel?:string|null }
 * @returns {string} html
 */
function buildSubmissionHtml(bundle, opts = {}) {
  const { submission, title, definition, schema_matched } = bundle;
  const data = (submission && typeof submission.data === 'object' && submission.data) || {};
  const def = definition || {};

  const submitted = _firmDate(submission && submission.created_at);
  const metaBits = [
    `Submission #${htmlEscape(submission && submission.id)}`,
    `Submitted ${htmlEscape(submitted.toFormat('MMM d, yyyy h:mm a'))} (${htmlEscape(submitted.toFormat('ZZZZ'))})`,
  ];
  if (opts.linkLabel) metaBits.push(htmlEscape(opts.linkLabel));

  let body = '<div class="hdr">';
  if (opts.logoDataUri) body += `<img src="${htmlEscape(opts.logoDataUri)}" alt="">`;
  body += `<h1>${htmlEscape(title || (submission && submission.form_key) || 'Form')}</h1>`;
  body += `<div class="meta">${metaBits.join(' &middot; ')}</div>`;
  body += '</div>';

  if (schema_matched === false) {
    body += '<div class="schema-note">Note: the form layout that produced this submission is no ' +
      'longer available. Answers are shown against the current layout; fields added since may ' +
      'appear blank and removed fields are not shown.</div>';
  }

  if (Array.isArray(def.tabs)) {
    if (Array.isArray(def.stickyTop) && def.stickyTop.length) {
      body += _sectionsHtml(def.stickyTop, data);
    }
    def.tabs.forEach((tab) => {
      const inner = _sectionsHtml((tab && tab.sections) || [], data);
      if (!inner) return;   // a tab whose every section hid is skipped whole
      if (tab && tab.label) body += `<div class="tab-title">${htmlEscape(tab.label)}</div>`;
      body += inner;
    });
    if (Array.isArray(def.stickyBottom) && def.stickyBottom.length) {
      body += _sectionsHtml(def.stickyBottom, data);
    }
  } else {
    body += _sectionsHtml(def.sections || [], data);
  }

  body += `<div class="ftr">Generated ${htmlEscape(DateTime.now().setZone(FIRM_TZ).toFormat("MMM d, yyyy h:mm a"))}` +
    ` &middot; ${htmlEscape((submission && submission.form_key) || '')}` +
    ` &middot; submission ${htmlEscape(submission && submission.id)}</div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head>` +
    `<body>${body}</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logo — fetched by THIS process, inlined, memoized
// ─────────────────────────────────────────────────────────────────────────────

let _logoCache = { url: null, dataUri: null };

/** For tests. */
function _resetLogoCacheForTest() { _logoCache = { url: null, dataUri: null }; }

/**
 * app_settings 'fe-firm_logo_url' → data URI. Memoized per URL for the
 * process lifetime (a settings change picks up on the next cold start or URL
 * edit). NEVER throws — a letterhead must not sink a filing.
 */
async function _logoDataUri(db) {
  let url = null;
  try {
    const raw = await getSetting(db, LOGO_URL_KEY);
    if (raw != null && String(raw).trim() !== '') url = String(raw).trim();
  } catch (err) {
    console.warn(`[FORM PDF] ${LOGO_URL_KEY} lookup failed: ${err.message}`);
  }
  if (!url) return null;
  if (_logoCache.url === url) return _logoCache.dataUri;

  let dataUri = null;
  const controller = new AbortController();
  const tHandle = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.ok) {
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
      const buf = Buffer.from(await res.arrayBuffer());
      if (/^image\//.test(type) && buf.length > 0 && buf.length <= LOGO_MAX_BYTES) {
        dataUri = `data:${type};base64,${buf.toString('base64')}`;
      } else {
        console.warn(`[FORM PDF] logo at ${url} rejected (type=${type || '?'}, bytes=${buf.length})`);
      }
    } else {
      console.warn(`[FORM PDF] logo fetch ${url} → ${res.status}`);
    }
  } catch (err) {
    console.warn(`[FORM PDF] logo fetch failed: ${err.message}`);
  } finally {
    clearTimeout(tHandle);
  }
  _logoCache = { url, dataUri };   // failures memoize too — one attempt per URL per process
  return dataUri;
}

// ─────────────────────────────────────────────────────────────────────────────
// Linkage label + identity prefix (best-effort lookups, never throw)
// ─────────────────────────────────────────────────────────────────────────────

/** Primary-contact lfm name for a case (the shared identity convention). */
async function _casePrimaryName(db, caseId) {
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
    console.warn(`[FORM PDF] case name lookup failed for ${caseId}: ${err.message}`);
    return null;
  }
}

/** Header line describing what the submission is linked to. */
async function _linkLabel(db, sub) {
  const t = sub.link_type;
  if (t === 'case') {
    const name = await _casePrimaryName(db, sub.link_id);
    return `Case ${sub.link_id}${name ? ` \u2014 ${name}` : ''}`;
  }
  if (t === 'contact') {
    let name = null;
    try {
      const [[row]] = await db.query(
        'SELECT contact_lfm_name FROM contacts WHERE contact_id = ? LIMIT 1',
        [String(sub.link_id)]
      );
      name = row?.contact_lfm_name || null;
    } catch (err) {
      console.warn(`[FORM PDF] contact name lookup failed for ${sub.link_id}: ${err.message}`);
    }
    return `Contact #${sub.link_id}${name ? ` \u2014 ${name}` : ''}`;
  }
  if (t === 'appt') return `Appointment #${sub.link_id}`;
  return 'Not linked to a case';
}

/**
 * Best-effort submitter name for an UNLINKED submission's identity prefix:
 * the first non-empty string answer whose field name looks like a name key.
 * Purely a filename nicety over client-supplied data — sanitized, clipped.
 */
function _submitterNameGuess(data) {
  for (const [k, v] of Object.entries(data || {})) {
    if (!/(^|_)(full_?name|name)$/i.test(k)) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * "{idPart} - {name} - " for an unsorted loose filename (e-sign convention),
 * for submissions with no case home.
 */
async function _identityPrefix(db, sub) {
  let idPart;
  let name = null;
  if (sub.link_type === 'contact') {
    idPart = `contact ${sub.link_id}`;
    try {
      const [[row]] = await db.query(
        'SELECT contact_lfm_name FROM contacts WHERE contact_id = ? LIMIT 1',
        [String(sub.link_id)]
      );
      name = row?.contact_lfm_name || null;
    } catch (err) {
      console.warn(`[FORM PDF] identity lookup failed for contact ${sub.link_id}: ${err.message}`);
    }
  } else if (sub.link_type === 'appt') {
    idPart = `appt ${sub.link_id}`;
  } else {
    idPart = `submission ${sub.id}`;
    name = _submitterNameGuess(sub.data);
  }
  const parts = [sanitizeNameFragment(idPart, 40)];
  if (name) parts.push(sanitizeNameFragment(name, 40));
  const prefix = `${parts.join(' - ')} - `;
  return prefix.length <= MAX_PREFIX ? prefix : `${prefix.slice(0, MAX_PREFIX - 3)} - `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (best-effort, never block a filing)
// ─────────────────────────────────────────────────────────────────────────────

async function _raiseTask(db, { title, desc, caseId }) {
  try {
    const assignee = await resolveAlertAssignee(db);
    if (!assignee) {
      console.warn(`[FORM PDF] office_alerts_to names no user \u2014 dropping task: ${title}`);
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
      source: TASK_SOURCE,
    });
    console.log(`[FORM PDF] task #${task_id} \u2192 user ${assignee}: ${title}`);
    return { ok: true, taskId: task_id };
  } catch (err) {
    console.error(`[FORM PDF] failed to raise task "${title}": ${err && err.message}`);
    return { ok: false, reason: 'error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement — THE LADDER
// ─────────────────────────────────────────────────────────────────────────────

/** The form-PDF unsorted bin's base path (setting, else the default). */
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
    console.warn(`[FORM PDF] ${UNSORTED_PATH_KEY} lookup failed, using default: ${err.message}`);
  }
  return path || DEFAULT_UNSORTED_PATH;
}

/**
 * "{bin}/{case_id} - {lfm name}" — the per-case subfolder inside the form-PDF
 * bin, so one case's strays stay together instead of scattering through a flat
 * list. Naming mirrors uploadTargetService's client-upload convention (same
 * Primary-contact rule) on purpose: staff sorting either bin sees one format.
 * A failed name lookup degrades to the bare case id, never throws.
 */
async function _unsortedCaseFolderPath(db, caseId) {
  const base = await _unsortedBasePath(db);
  const name = await _casePrimaryName(db, caseId);
  const parts = [sanitizeNameFragment(String(caseId), 40)];
  if (name) parts.push(sanitizeNameFragment(name, 60));
  return dropboxService.joinPath(base, parts.join(' - '));
}

/**
 * Resolve where this submission's PDF belongs (header: THE LADDER).
 *
 * @returns {Promise<{credentialId, folderPath, filenamePrefix:string,
 *                    placement:'case'|'unsorted', placementNote:string|null,
 *                    warnings:string[], moveTaskAfterUpload:boolean}>}
 * Throws only when even the unsorted bin cannot be resolved (which, since
 * that rung is settings+string work, effectively means the credential lookup
 * failed — Dropbox trouble surfaces at upload time instead).
 */
async function _preparePlacement(db, sub) {
  const credentialId = await dropboxService._resolveCredential(db, {});
  const warnings = [];

  if (sub.link_type === 'case') {
    const caseId = String(sub.link_id);
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
        });
        console.log(`[FORM PDF] auto-created case folder for ${caseId}: ${ensured.path || '(pre-existing)'}`);
      } catch (err) {
        fallbackNote = `Case "${caseId}" has no Dropbox folder and auto-creating one failed (${err.message}).`;
      }
    } else if (!fallbackNote) {
      fallbackNote = `Case "${caseId}" was not found.`;
    }

    // ── rung 1 (possibly via rung 2): <case folder>/Forms ─────────────────
    if (sharedLink) {
      try {
        const caseFolder = await dropboxService.resolveLocation(db, credentialId, {
          sharedLink, expectFolder: true,
        });
        // files/upload creates missing parents, but creating explicitly keeps
        // the failure legible (e-sign convention). Idempotent.
        const created = await dropboxService.createFolder(db, {
          credentialId, path: dropboxService.joinPath(caseFolder, SUBFOLDER),
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

    // ── rung 3: the form bin, per-case subfolder ─────────────────────────
    const folderPath = await _unsortedCaseFolderPath(db, caseId);
    return {
      credentialId, folderPath, filenamePrefix: '',
      placement: 'unsorted', warnings,
      placementNote:
        `The PDF could not be filed to the case folder \u2014 ${fallbackNote} ` +
        `It was filed to the unsorted form-submissions folder instead (${folderPath}); ` +
        'move it into the correct case folder.',
      moveTaskAfterUpload: true,
    };
  }

  // ── contact / appt / unlinked: the unsorted bin, loose file w/ identity ──
  const base = await _unsortedBasePath(db);
  const what = sub.link_type === 'contact' ? `a contact (id ${sub.link_id})`
    : sub.link_type === 'appt' ? `an appointment (id ${sub.link_id})`
      : 'nothing yet';
  return {
    credentialId, folderPath: base,
    filenamePrefix: await _identityPrefix(db, sub),
    placement: 'unsorted', warnings,
    placementNote:
      `This submission is linked to ${what}, so there is no case folder to file into. ` +
      `The PDF went to the unsorted form-submissions folder (${base}).`,
    moveTaskAfterUpload: false,   // the Form Inbox already surfaces these
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render one SUBMITTED form submission to PDF and file it (header: the whole
 * story). Drafts are refused — a mid-entry snapshot presented as an archival
 * document would be a lie.
 *
 * @param {object} db
 * @param {object} o
 * @param {number|string} o.submissionId
 * @param {string}        [o.filename]   overrides the "{date} {title} (#id)"
 *                                       core; sanitized; ".pdf" enforced; an
 *                                       unsorted identity prefix still applies
 *                                       (bin hygiene is not the author's call)
 * @returns {Promise<{path, file_name, placement, placement_note,
 *                    temp_link, temp_link_expires_note, warnings,
 *                    submission_id, form_key, link_type, link_id}>}
 */
/**
 * Bundle → bytes. THE ONLY RENDER PATH — the workflow filing and the staff
 * Download/Print button share it verbatim, so what a person prints from the
 * inbox is byte-for-byte the document that gets filed and emailed. Anything
 * that diverges here becomes "the PDF I got isn't the PDF in the folder".
 *
 * X5.1. Does no Dropbox work and raises no tasks: a staff member pressing
 * Download five times must not litter the bin with five files.
 *
 * @returns {Promise<{buffer:Buffer, fileName:string, bundle:object,
 *                    submission:object}>}
 */
async function renderSubmissionPdf(db, { submissionId, filename: filenameOverride } = {}) {
  const formService = require('./formService');   // deferred require (convention)

  const id = Number(submissionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`submission_id "${submissionId}" is not a positive integer`);
  }

  const bundle = await formService.getSubmissionForRender(db, id);
  const sub = bundle.submission;
  if (sub.status !== 'submitted') {
    throw new Error(`submission ${id} is a draft \u2014 only submitted forms can be rendered`);
  }

  const [logoDataUri, linkLabel] = await Promise.all([
    _logoDataUri(db),
    _linkLabel(db, sub),
  ]);
  const html = buildSubmissionHtml(bundle, { logoDataUri, linkLabel });
  const buffer = await pdfRenderService.renderHtmlToPdf(html);

  // The filename CORE (no unsorted identity prefix — that is a bin-hygiene
  // concern owned by the filing path, and a downloaded file needs no prefix).
  const date = _firmDate(sub.created_at).toFormat('yyyy-MM-dd');
  let core;
  if (filenameOverride != null && String(filenameOverride).trim() !== '') {
    core = sanitizeNameFragment(String(filenameOverride).replace(/\.pdf$/i, ''), MAX_NAME_FRAGMENT + 30);
  } else {
    const frag = sanitizeNameFragment(bundle.title || sub.form_key, MAX_NAME_FRAGMENT);
    core = `${date} ${frag} (#${sub.id})`;
  }

  return { buffer, fileName: `${core}.pdf`, bundle, submission: sub };
}

async function fileSubmissionPdf(db, { submissionId, filename: filenameOverride } = {}) {
  const rendered = await renderSubmissionPdf(db, { submissionId, filename: filenameOverride });
  const { buffer: pdf, submission: sub } = rendered;
  const core = rendered.fileName.replace(/\.pdf$/i, '');

  // ── place + name ──────────────────────────────────────────────────────────
  const prep = await _preparePlacement(db, sub);
  const fileName = `${prep.filenamePrefix}${core}.pdf`;

  // ── upload — the path Dropbox RETURNS is authoritative (autorename) ──────
  const requested = dropboxService.joinPath(prep.folderPath, fileName);
  let meta;
  try {
    meta = await dropboxService.uploadFile(db, {
      credentialId: prep.credentialId,
      path: requested,
      content: pdf,
      mode: 'add',
      autorename: true,
    });
  } catch (err) {
    throw new Error(
      `could not upload the PDF to Dropbox (${requested}): ${err.message}` +
      (prep.placement === 'unsorted' ? ' The unsorted fallback also being unreachable means Dropbox itself is down.' : '')
    );
  }
  const actualPath = meta?.path_display || meta?.path_lower || requested;
  if (actualPath !== requested) {
    console.log(`[FORM PDF] Dropbox autorenamed: "${requested}" \u2192 "${actualPath}"`);
  }
  const actualName = actualPath.split('/').pop();

  // ── post-upload move-task (only after the file actually landed) ──────────
  if (prep.moveTaskAfterUpload) {
    await _raiseTask(db, {
      caseId: String(sub.link_id),
      title: `Move form PDF for case ${sub.link_id} out of Unsorted`,
      desc: `${prep.placementNote} File: ${actualPath}`,
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
      `The PDF was filed, but a temporary download link could not be created: ${err.message}. ` +
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
    temp_link_expires_note: tempLink ? 'Dropbox temporary link \u2014 expires ~4 hours after creation' : null,
    warnings,
    submission_id: sub.id,
    form_key: sub.form_key,
    link_type: sub.link_type,
    link_id: sub.link_id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  fileSubmissionPdf,
  renderSubmissionPdf,
  buildSubmissionHtml,
  UNSORTED_PATH_KEY,
  DEFAULT_UNSORTED_PATH,
  // exposed for tests (repo pattern)
  formatValue,
  isVisible,
  evalCondition,
  sanitizeNameFragment,
  _preparePlacement,
  _identityPrefix,
  _logoDataUri,
  _resetLogoCacheForTest,
  SUBFOLDER,
  TASK_SOURCE,
};
