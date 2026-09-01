// services/esignTemplateService.js
//
/**
 * CONTRACT TEMPLATES — CRUD + validation over contract_templates.
 * services/esignTemplateService.js
 *
 * Phase 2B. The table shipped in 1A and nothing read it until now. This module
 * is the ONLY writer; readers are esignSendService (sendFromTemplate) and the
 * template routes.
 *
 * ── VALIDATION IS AT SAVE TIME ──────────────────────────────────────────────
 * Every rule that can be checked without a case is checked when the template
 * is SAVED, not when it is sent: an unknown resolver, an undeclared
 * {{placeholder}}, a malformed placement. The person who can fix a template
 * error is the person authoring it, and they are looking at the editor now —
 * not the staff member sending a retainer three weeks later.
 *
 * ── KIND IS FREE VOCABULARY ─────────────────────────────────────────────────
 * 2A's KINDS list is the product's opinion about ad-hoc sends; templates may
 * DEFINE new kinds (≤64 chars, non-empty). The send-time legal set is the
 * union — see esignSendService.legalKinds(), which consults
 * listActiveTemplateKinds() below. Dependency direction: sendService requires
 * this module, never the reverse (no cycle).
 *
 * ── TEMPLATES ARE NEVER DELETED ─────────────────────────────────────────────
 * signing_requests.template_id points here; deleting a row would orphan the
 * history of every request sent from it. deactivateTemplate flips active=0,
 * which removes it from pickers and from the send path (sendFromTemplate
 * refuses inactive templates) while every past request keeps its provenance.
 *
 * ── sql_mode LANDMINE ───────────────────────────────────────────────────────
 * The session is not strict: an oversize varchar would truncate silently and
 * an omitted NOT NULL JSON column becomes JSON null. Both JSON columns are
 * therefore ALWAYS supplied explicitly, and every length rule is enforced
 * here in code.
 */

const { validatePlacements } = require('./esign/placements');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MIN_NAME = 3;
const MAX_NAME = 128;    // column: varchar(128)
const MAX_KIND = 64;     // column: varchar(64)

const MIN_EXPIRATION_DAYS = 1;
const MAX_EXPIRATION_DAYS = 90;

/** prefill_schema entry rules. */
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MIN_LABEL = 1;
const MAX_LABEL = 80;
const PREFILL_TYPES = Object.freeze(['text', 'number', 'date', 'money', 'options']);

/** Phase 2E. 'html' = body rendered to PDF; 'pdf' = stored PDF filled via pdf-lib. */
const TEMPLATE_TYPES = Object.freeze(['html', 'pdf']);

/**
 * G2. WHICH PICKER a template appears in — not what it can technically do.
 *
 *   'esign'     Send-for-Signature only. sendFromTemplate accepts it;
 *               documentGenerateService refuses it.
 *   'generate'  Generate-document only. The mirror: documentGenerateService
 *               accepts it, sendFromTemplate refuses it.
 *   'both'      Both pickers.
 *
 * The DEFAULT IS 'esign' and the column default matches, which is what makes
 * the migration safe: every template that existed before G2 is a signature
 * template and stays invisible to the generate path until a human says
 * otherwise. A new capability does not get to opt existing rows in.
 *
 * This is a POLICY flag, deliberately not a capability check — an html
 * template renders identically down either path (templateRenderService is the
 * one renderer). The refusals exist so a fee agreement cannot be quietly
 * generated-and-filed instead of sent for signature, which looks like success
 * and leaves nothing signed.
 */
const PURPOSES = Object.freeze(['esign', 'generate', 'both']);
const DEFAULT_PURPOSE = 'esign';

/**
 * Where a GENERATED document lands under the case folder — the generate-path
 * equivalent of formPdfService's hardcoded 'Forms'. Per-template because a fee
 * agreement and a court notice do not belong in the same drawer.
 * Column: varchar(64) NOT NULL DEFAULT 'Generated Documents'.
 */
const DEFAULT_FILE_SUBFOLDER = 'Generated Documents';
const MAX_FILE_SUBFOLDER = 64;

/**
 * Characters Dropbox rejects in a path segment. Same set formPdfService and
 * esignFilingService use — a THIRD literal copy, on purpose: importing
 * filePlacementService here would drag dropboxService, taskService and
 * documentIngestService into the template service's dependency graph for one
 * regex. Non-global (no /g) because this copy only ever .test()s, and a global
 * regex's stateful lastIndex makes repeated .test() calls alternate.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_SUBFOLDER = /[/\\:*?"<>|\u0000-\u001f]/;

/**
 * Completion triggers (esign workflow actions, part 2). A template may name
 * what to START when a request sent from it completes:
 *
 *   { signed:   { type: 'workflow'|'sequence', id: <int> },
 *     declined: { type: 'workflow'|'sequence', id: <int> } }
 *
 * 'signed' fires on both terminal successes (signed AND satisfied_external);
 * 'declined' only on declined. The value is SNAPSHOTTED onto the
 * signing_requests row at send time — firing (esignService.applyStatus)
 * reads the row, so a template edit never rewires an envelope in flight.
 */
const COMPLETION_TRIGGER_KEYS = Object.freeze(['signed', 'declined']);
const COMPLETION_TARGET_TYPES = Object.freeze(['workflow', 'sequence']);

/**
 * {{placeholder}} extraction. Deliberately BROAD — it captures anything
 * between double braces, including malformed keys, so that a typo like
 * {{Debtor Name}} is caught as undeclared rather than silently shipped as
 * literal text in a client-facing contract.
 */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS — repo convention: construct, attach .code, throw
// ─────────────────────────────────────────────────────────────────────────────

function _err(code, message, extra = null) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHAPING
// ─────────────────────────────────────────────────────────────────────────────

/** mysql2 may hand JSON columns back parsed or as strings; accept both. */
function _parseJsonCol(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
}

function _shapeFull(row) {
  if (!row) return null;
  return {
    ...row,
    active:         Number(row.active) === 1,
    reminders_off:  Number(row.reminders_off) === 1,
    prefill_schema: _parseJsonCol(row.prefill_schema, []),
    placement_json: _parseJsonCol(row.placement_json, { fields: [] }),
    completion_targets: _parseJsonCol(row.completion_targets, null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETION TARGETS — pure validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate + normalize a completion_targets value. PURE — the referential
 * "does workflow 12 actually exist" check is _assertCompletionTargetsExist
 * below, kept separate for the same reason the resolver whitelist is injected
 * into validateTemplateInput: table-testability.
 *
 * Accepts null (no triggers). A key whose VALUE is null is dropped — that is
 * the "cleared" spelling the merge path in esignSendService.sendFromTemplate
 * relies on. Returns null when nothing survives, so the DB column never holds
 * a semantically-empty `{}`.
 *
 * @throws ESIGN_BAD_TEMPLATE on any shape problem, naming the exact field.
 * @returns {?object} normalized { signed?: {type,id}, declined?: {type,id} }
 */
function validateCompletionTargets(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw _err('ESIGN_BAD_TEMPLATE',
      'completion_targets must be an object like ' +
      '{"signed": {"type": "workflow", "id": 12}} — or null for no triggers.');
  }
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!COMPLETION_TRIGGER_KEYS.includes(key)) {
      throw _err('ESIGN_BAD_TEMPLATE',
        `completion_targets has unknown trigger "${key}" ` +
        `(expected: ${COMPLETION_TRIGGER_KEYS.join(', ')}).`);
    }
    if (val == null) continue; // explicit-null = cleared
    if (typeof val !== 'object' || Array.isArray(val)) {
      throw _err('ESIGN_BAD_TEMPLATE',
        `completion_targets.${key} must be {"type": "workflow"|"sequence", "id": <int>}.`);
    }
    if (!COMPLETION_TARGET_TYPES.includes(val.type)) {
      throw _err('ESIGN_BAD_TEMPLATE',
        `completion_targets.${key}.type "${val.type}" is invalid ` +
        `(expected: ${COMPLETION_TARGET_TYPES.join(', ')}).`);
    }
    const id = Number(val.id);
    if (!Number.isInteger(id) || id < 1) {
      throw _err('ESIGN_BAD_TEMPLATE',
        `completion_targets.${key}.id must be a positive integer (got ${JSON.stringify(val.id)}).`);
    }
    out[key] = { type: val.type, id };
  }
  return Object.keys(out).length ? out : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every {{...}} in the body, trimmed, deduplicated, in order of appearance.
 * PURE — also used by esignSendService's interpolation tests.
 */
function extractPlaceholders(body) {
  const seen = new Set();
  const out = [];
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(String(body == null ? '' : body))) !== null) {
    const key = m[1].trim();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a full template shape. Throws on the first problem; returns the
 * normalized row-ready values plus warn-only findings.
 *
 * The resolver whitelist is INJECTED (a Set of legal resolver strings) rather
 * than required from esignPrefillService, purely so this function stays pure
 * and table-testable; callers pass esignPrefillService.RESOLVER_NAMES.
 *
 * @param {object} t
 * @param {string}  t.name
 * @param {string}  t.kind
 * @param {string}  t.body            HTML
 * @param {Array}   t.prefillSchema   [{key,label,type,resolver,default,required}]
 * @param {object}  t.placementJson   neutral placement schema
 * @param {number}  [t.expirationDays=14]
 * @param {boolean} [t.remindersOff=false]
 * @param {?number} [t.reminderSeqId] stored, NOT validated (Phase 3's table)
 * @param {boolean} [t.staticBody=false]  explicit "no placeholders on purpose"
 * @param {string}  [t.purpose='esign']   'esign' | 'generate' | 'both'
 * @param {string}  [t.fileSubfolder]     case-folder subfolder for generated output
 * @param {Set<string>} resolverWhitelist  legal resolver strings
 * @returns {{ clean: object, warnings: string[] }}
 */
function validateTemplateInput(t, resolverWhitelist) {
  const {
    name, kind, body, prefillSchema, placementJson,
    expirationDays = 14, remindersOff = false, reminderSeqId = null,
    staticBody = false, templateType = 'html', completionTargets = null,
    purpose = DEFAULT_PURPOSE, fileSubfolder = DEFAULT_FILE_SUBFOLDER,
  } = t || {};

  // ── template_type (Phase 2E) ──────────────────────────────────────────────
  // 'html' = body is an HTML template rendered to PDF (2B pipeline);
  // 'pdf'  = a stored source PDF (contract_template_pdfs) filled via pdf-lib
  //          text placement fields. One value-injection mechanism per type:
  //          html interpolates {{keys}} in the body, pdf draws text fields —
  //          never both, so an author can always answer "where does this value
  //          land" by looking at the type.
  if (!TEMPLATE_TYPES.includes(templateType)) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `template_type "${templateType}" is invalid (expected one of: ${TEMPLATE_TYPES.join(', ')}).`);
  }
  const isPdf = templateType === 'pdf';

  // ── purpose (G2) ──────────────────────────────────────────────────────────
  const purposeClean = purpose == null ? DEFAULT_PURPOSE : String(purpose);
  if (!PURPOSES.includes(purposeClean)) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `purpose "${purposeClean}" is invalid (expected one of: ${PURPOSES.join(', ')}).`);
  }

  // ── file_subfolder (G2) ───────────────────────────────────────────────────
  // Becomes a Dropbox PATH SEGMENT under the case folder, so it is validated
  // like a filename fragment rather than like free text: a '/' here would
  // silently create a nested tree nobody asked for, and the rest of the set
  // Dropbox rejects outright. Length is enforced HERE because sql_mode is not
  // strict — a 90-char value would truncate at 64 without a word.
  const subfolderClean =
    String(fileSubfolder == null ? DEFAULT_FILE_SUBFOLDER : fileSubfolder).trim();
  if (subfolderClean.length < 1 || subfolderClean.length > MAX_FILE_SUBFOLDER) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `file_subfolder must be 1–${MAX_FILE_SUBFOLDER} characters.`);
  }
  if (ILLEGAL_IN_SUBFOLDER.test(subfolderClean)) {
    throw _err('ESIGN_BAD_TEMPLATE',
      'file_subfolder must be a single folder name — it cannot contain / \\ : * ? " < > | ' +
      'or control characters.');
  }

  // ── name / kind ───────────────────────────────────────────────────────────
  const nameClean = String(name == null ? '' : name).trim();
  if (nameClean.length < MIN_NAME || nameClean.length > MAX_NAME) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `Template name must be ${MIN_NAME}–${MAX_NAME} characters.`);
  }

  const kindClean = String(kind == null ? '' : kind).trim();
  if (kindClean.length < 1 || kindClean.length > MAX_KIND) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `Template kind must be 1–${MAX_KIND} characters.`);
  }

  // ── body ──────────────────────────────────────────────────────────────────
  // pdf templates have NO body — the document IS the stored PDF. Anything a
  // caller sends is discarded to '' rather than stored-and-ignored (a body on
  // a pdf template would be a lie waiting for a reader).
  const bodyClean = isPdf ? '' : String(body == null ? '' : body);
  if (!isPdf && !bodyClean.trim()) {
    throw _err('ESIGN_BAD_TEMPLATE', 'Template body must not be empty.');
  }

  const placeholders = isPdf ? [] : extractPlaceholders(bodyClean);
  if (!isPdf && placeholders.length === 0 && !staticBody) {
    // The forgot-my-placeholders authoring error: a contract with the debtor's
    // name typed in literally. A body with zero {{placeholders}} is legal only
    // when the author says so explicitly.
    throw _err('ESIGN_BAD_TEMPLATE',
      'The body contains no {{placeholders}}. If this template is intentionally ' +
      'static (no per-case values at all), set static_body: true.');
  }

  // ── prefill_schema ────────────────────────────────────────────────────────
  if (!Array.isArray(prefillSchema)) {
    throw _err('ESIGN_BAD_PREFILL_SCHEMA', 'prefill_schema must be an array.');
  }
  const keys = new Set();
  const schemaClean = prefillSchema.map((e, i) => {
    if (!e || typeof e !== 'object') {
      throw _err('ESIGN_BAD_PREFILL_SCHEMA', `prefill_schema[${i}] must be an object.`);
    }
    const key = String(e.key == null ? '' : e.key);
    if (!KEY_RE.test(key)) {
      throw _err('ESIGN_BAD_PREFILL_SCHEMA',
        `prefill_schema[${i}].key "${key}" is invalid — lowercase letter first, ` +
        `then lowercase letters, digits or underscores, at most 40 characters.`);
    }
    if (keys.has(key)) {
      throw _err('ESIGN_BAD_PREFILL_SCHEMA', `prefill_schema key "${key}" appears more than once.`);
    }
    keys.add(key);

    const label = String(e.label == null ? '' : e.label).trim();
    if (label.length < MIN_LABEL || label.length > MAX_LABEL) {
      throw _err('ESIGN_BAD_PREFILL_SCHEMA',
        `prefill_schema[${i}].label must be ${MIN_LABEL}–${MAX_LABEL} characters.`);
    }

    if (!PREFILL_TYPES.includes(e.type)) {
      throw _err('ESIGN_BAD_PREFILL_SCHEMA',
        `prefill_schema[${i}].type "${e.type}" is invalid ` +
        `(expected one of: ${PREFILL_TYPES.join(', ')}).`);
    }

    const resolver = e.resolver == null ? null : String(e.resolver);

    // 'options' rows (2026-07-31) are LIST-valued: they feed dropdown
    // placements via options_key, never body placeholders or text fields.
    // They take NO resolver and NO default — the list is typed by staff at
    // send time, and any auto-computation (e.g. the post-filing fee
    // agreement's 14-day first-payment window) lives in the SENDING FORM
    // that owns that business rule, not here. Deliberate scoping (Fred,
    // 2026-07-31): every existing resolver is scalar-shaped, and a
    // form-specific date rule does not belong in the shared prefill layer.
    if (e.type === 'options') {
      if (resolver !== null) {
        throw _err('ESIGN_BAD_RESOLVER',
          `prefill_schema[${i}] ("${key}") is an options row — resolvers are not ` +
          `supported; the list is entered at send time (the sending form may ` +
          `pre-fill it).`);
      }
      if (e.default != null && String(e.default).trim() !== '') {
        throw _err('ESIGN_BAD_PREFILL_SCHEMA',
          `prefill_schema[${i}] ("${key}") is an options row — defaults are not supported; ` +
          `the list is entered at send time.`);
      }
    }

    if (resolver !== null && !resolverWhitelist.has(resolver)) {
      // Phase 2E: not a whitelist name — maybe an EXPRESSION
      // ({{table.column|modifier}}, delegated to resolverService). The pure
      // checks (syntax, allowed table, blocked column, no trigger_data) run
      // here; the column-EXISTENCE check needs a db and runs in
      // createTemplate/updateTemplate via assertExpressionColumnsExist.
      const prefill = require('./esignPrefillService');
      if (prefill.isExpressionResolver(resolver)) {
        prefill.validateExpressionResolver(resolver); // throws ESIGN_BAD_RESOLVER
      } else {
        // Rejected at SAVE time, not send time — the author is the person who
        // can fix it, and they are looking at the editor right now.
        throw _err('ESIGN_BAD_RESOLVER',
          `prefill_schema[${i}].resolver "${resolver}" is not a known resolver. ` +
          `Known: ${[...resolverWhitelist].sort().join(', ')}, or a ` +
          `{{table.column|modifier}} expression.`);
      }
    }

    return {
      key,
      label,
      type: e.type,
      resolver,
      default: e.default == null ? null : String(e.default),
      required: Boolean(e.required),
    };
  });

  // ── body ↔ schema cross-check (html) ──────────────────────────────────────
  const warnings = [];
  if (!isPdf) {
    const optionsInBody = placeholders.filter((p) =>
      schemaClean.some((e) => e.key === p && e.type === 'options'));
    if (optionsInBody.length) {
      throw _err('ESIGN_BAD_TEMPLATE',
        `Body placeholder(s) reference options-type row(s): ` +
        `${optionsInBody.map((k) => `{{${k}}}`).join(', ')} — a list cannot be ` +
        `interpolated as prose; options rows feed dropdowns via options_key.`);
    }
    const undeclared = placeholders.filter((p) => !keys.has(p));
    if (undeclared.length) {
      throw _err('ESIGN_UNDECLARED_PLACEHOLDER',
        `The body uses placeholder(s) not declared in prefill_schema: ` +
        `${undeclared.map((k) => `{{${k}}}`).join(', ')}.`,
        { placeholders: undeclared });
    }
    // Declared-but-unused is LEGAL (a schema shared across template revisions,
    // a value only the placement layer uses later) — warn, don't block.
    const unused = [...keys].filter((k) => !placeholders.includes(k));
    if (unused.length) {
      warnings.push(`Declared but unused in the body: ${unused.join(', ')}.`);
    }
  }

  // ── placement_json ────────────────────────────────────────────────────────
  // ONE validator for the whole subsystem — services/esign/placements.js.
  const placements = placementJson == null ? { fields: [] } : placementJson;
  validatePlacements(placements);

  // ── placement ↔ schema cross-check (Phase 2E) ─────────────────────────────
  // The pdf-type mirror of the body↔schema check above: a text field is the
  // pdf template's {{placeholder}}, so its key must be declared (undeclared →
  // throw) and declared-but-unplaced merely warns. Text fields on an HTML
  // template are REJECTED outright — html's mechanism is body interpolation,
  // and two injection paths on one template means nobody can say where a
  // value lands without reading both.
  const textFields = (placements.fields || []).filter((f) => f && f.type === 'text');
  const optionsRowKeys = new Set(schemaClean.filter((e) => e.type === 'options').map((e) => e.key));

  // ── options_key ↔ schema cross-check (2026-07-31, both template types) ────
  // A dropdown sourcing its list from a prefill value must name a DECLARED,
  // OPTIONS-TYPE row — a scalar row would inject a string where an array
  // belongs, and an undeclared key would resolve to nothing at send time.
  {
    const optionKeyed = (placements.fields || [])
      .filter((f) => f && f.type === 'dropdown' && f.options_key != null);
    for (const f of optionKeyed) {
      if (!keys.has(f.options_key)) {
        throw _err('ESIGN_UNDECLARED_PLACEHOLDER',
          `Dropdown options_key "${f.options_key}" is not declared in prefill_schema.`,
          { placeholders: [f.options_key] });
      }
      if (!optionsRowKeys.has(f.options_key)) {
        throw _err('ESIGN_BAD_TEMPLATE',
          `Dropdown options_key "${f.options_key}" must reference an options-type ` +
          `prefill row (it is declared as a scalar).`);
      }
    }
  }

  if (isPdf) {
    const badTextKeys = [...new Set(textFields.map((f) => f.key))].filter((k) => optionsRowKeys.has(k));
    if (badTextKeys.length) {
      throw _err('ESIGN_BAD_TEMPLATE',
        `Text placement field(s) reference options-type row(s): ${badTextKeys.join(', ')} — ` +
        `a list cannot be inked as prose; options rows feed dropdowns via options_key.`);
    }
    const undeclaredText = [...new Set(textFields.map((f) => f.key))].filter((k) => !keys.has(k));
    if (undeclaredText.length) {
      throw _err('ESIGN_UNDECLARED_PLACEHOLDER',
        `Placement text field(s) use key(s) not declared in prefill_schema: ` +
        `${undeclaredText.join(', ')}.`,
        { placeholders: undeclaredText });
    }
    // "Placed" = inked by a text field OR consumed by a dropdown's options_key.
    const placed = new Set(textFields.map((f) => f.key));
    (placements.fields || []).forEach((f) => {
      if (f && f.type === 'dropdown' && f.options_key != null) placed.add(f.options_key);
    });
    const unplaced = [...keys].filter((k) => !placed.has(k));
    if (unplaced.length) {
      warnings.push(`Declared but not placed on the PDF: ${unplaced.join(', ')}.`);
    }
  } else if (textFields.length) {
    throw _err('ESIGN_BAD_TEMPLATE',
      'Text placement fields are only valid on pdf-type templates. On an HTML ' +
      'template, put the {{placeholder}} in the body instead.');
  }

  // ── scalars ───────────────────────────────────────────────────────────────
  const exp = Number(expirationDays);
  if (!Number.isInteger(exp) || exp < MIN_EXPIRATION_DAYS || exp > MAX_EXPIRATION_DAYS) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `expiration_days must be a whole number between ${MIN_EXPIRATION_DAYS} and ${MAX_EXPIRATION_DAYS}.`);
  }

  // reminder_seq_id: PASSTHROUGH. Phase 3 owns the sequences table and will
  // validate the reference; storing an int now costs nothing and blocks nothing.
  const seqId = reminderSeqId == null ? null : Number(reminderSeqId);
  if (seqId !== null && (!Number.isInteger(seqId) || seqId < 1)) {
    throw _err('ESIGN_BAD_TEMPLATE', 'reminder_seq_id must be a positive integer or null.');
  }

  // ── completion_targets ────────────────────────────────────────────────────
  const completionTargetsClean = validateCompletionTargets(completionTargets);

  return {
    clean: {
      name: nameClean,
      kind: kindClean,
      templateType,
      purpose: purposeClean,
      fileSubfolder: subfolderClean,
      body: bodyClean,
      prefillSchema: schemaClean,
      placementJson: placements,
      expirationDays: exp,
      remindersOff: Boolean(remindersOff),
      reminderSeqId: seqId,
      completionTargets: completionTargetsClean,
    },
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List templates, WITHOUT bodies — body is MEDIUMTEXT and a list endpoint
 * that ships every contract's full HTML on every page load is a self-inflicted
 * wound. getTemplate fetches one body when the editor opens it.
 * has_pdf rides along from a LEFT JOIN on size — never the blob itself.
 *
 * `purpose` (G2) is a PICKER filter, not a validity filter: 'esign' asks for
 * everything the Send-for-Signature picker may offer ('esign' ∪ 'both'),
 * 'generate' for everything the Generate-document picker may offer
 * ('generate' ∪ 'both'). Anything else — including null, which is what the
 * manager view passes — filters nothing, because the admin list has to show
 * every template regardless of where it is offered.
 *
 * @param {object} db
 * @param {object} [o]
 * @param {boolean} [o.activeOnly=true]
 * @param {?string} [o.purpose=null]  'esign' | 'generate' | null
 */
async function listTemplates(db, { activeOnly = true, purpose = null } = {}) {
  const where = [];
  if (activeOnly) where.push('t.active = 1');
  if (purpose === 'esign') where.push("t.purpose IN ('esign','both')");
  else if (purpose === 'generate') where.push("t.purpose IN ('generate','both')");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await db.query(
    `SELECT t.id, t.name, t.kind, t.template_type, t.purpose, t.file_subfolder,
            t.active, t.expiration_days, t.reminders_off, t.updated_at,
            (p.template_id IS NOT NULL) AS has_pdf
       FROM contract_templates t
       LEFT JOIN contract_template_pdfs p ON p.template_id = t.id
      ${whereSql}
      ORDER BY t.name ASC, t.id ASC`
  );
  return (rows || []).map((r) => ({
    ...r,
    active:        Number(r.active) === 1,
    reminders_off: Number(r.reminders_off) === 1,
    has_pdf:       Number(r.has_pdf) === 1,
  }));
}

/** One template, full row, JSON columns parsed. Null when absent. */
async function getTemplate(db, id) {
  const [[row]] = await db.query(
    'SELECT * FROM contract_templates WHERE id = ? LIMIT 1',
    [Number(id)]
  );
  const shaped = _shapeFull(row);
  if (!shaped) return null;
  // has_pdf without the blob — the send/preview guards and the editor's
  // "re-upload?" affordance both ask this on every open.
  const [[pdfMeta]] = await db.query(
    'SELECT size, original_name FROM contract_template_pdfs WHERE template_id = ? LIMIT 1',
    [Number(id)]
  );
  shaped.has_pdf = Boolean(pdfMeta);
  shaped.pdf_size = pdfMeta ? Number(pdfMeta.size) : null;
  shaped.pdf_original_name = pdfMeta ? pdfMeta.original_name : null;
  return shaped;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE SOURCE PDF (Phase 2E) — contract_template_pdfs
// ─────────────────────────────────────────────────────────────────────────────

/** MEDIUMBLOB ceiling with headroom; templates are blank firm forms. */
const MAX_TEMPLATE_PDF_BYTES = 15 * 1024 * 1024;

/**
 * Attach/replace the source PDF of a pdf-type template. Upsert — re-uploading
 * is the normal authoring loop. Placements authored against the OLD pdf stay
 * on the template row; the editor re-opens them over the new pages, and
 * pdfFill throws loud on any field now past the last page.
 */
async function setTemplatePdf(db, templateId, buffer, originalName = null) {
  const template = await getTemplate(db, templateId);
  if (!template) throw _err('ESIGN_NOT_FOUND', `Template ${templateId} not found.`);
  if (template.template_type !== 'pdf') {
    throw _err('ESIGN_BAD_TEMPLATE',
      `Template "${template.name}" is '${template.template_type}', not 'pdf' — it has no source PDF.`);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw _err('ESIGN_BAD_PDF', 'No document was supplied, or it was empty.');
  }
  if (buffer.length > MAX_TEMPLATE_PDF_BYTES) {
    throw _err('ESIGN_PDF_TOO_LARGE',
      `The template PDF is ${(buffer.length / (1024 * 1024)).toFixed(1)}MB; the limit is ` +
      `${MAX_TEMPLATE_PDF_BYTES / (1024 * 1024)}MB. A blank form should not be this big — ` +
      `re-export it without embedded scans.`);
  }
  // One "is this a PDF" answer across the subsystem.
  if (require('./esignFilingService').sniffBuffer(buffer) !== 'pdf') {
    throw _err('ESIGN_BAD_PDF',
      'That file is not a PDF (it does not begin with a PDF signature). Convert it and retry.');
  }

  await db.query(
    `INSERT INTO contract_template_pdfs (template_id, pdf, size, original_name)
     VALUES (?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE pdf = new.pdf, size = new.size, original_name = new.original_name`,
    [Number(templateId), buffer, buffer.length,
     originalName == null ? null : String(originalName).slice(0, 255)]
  );
  return { template_id: Number(templateId), size: buffer.length };
}

/** @returns {Promise<?{buffer: Buffer, size: number, original_name: ?string}>} */
async function getTemplatePdf(db, templateId) {
  const [[row]] = await db.query(
    'SELECT pdf, size, original_name FROM contract_template_pdfs WHERE template_id = ? LIMIT 1',
    [Number(templateId)]
  );
  if (!row) return null;
  return {
    buffer: Buffer.isBuffer(row.pdf) ? row.pdf : Buffer.from(row.pdf),
    size: Number(row.size),
    original_name: row.original_name,
  };
}

/**
 * Phase 3 closes 2B's passthrough: reminder_seq_id must reference an EXISTING,
 * ACTIVE sequence_templates row at save time. Same posture as
 * assertExpressionColumnsExist below — the author is right there, so a
 * dangling id stops the save instead of silently producing sends that never
 * nudge. Runtime stays defensive anyway (enrollContactByTemplateId throws on
 * a missing/inactive template and the send's best-effort wrapper records it):
 * a sequence deactivated AFTER the template saved degrades, never breaks.
 *
 * @throws ESIGN_BAD_TEMPLATE
 */
async function _assertReminderSeqExists(db, seqId) {
  if (seqId == null) return;
  const [rows] = await db.query(
    `SELECT id, name, active FROM sequence_templates WHERE id = ? LIMIT 1`,
    [Number(seqId)]
  );
  if (!rows.length) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `reminder_seq_id ${seqId} does not match any sequence template. ` +
      `Pick an existing sequence, or leave it blank to use the firm default.`);
  }
  if (!rows[0].active) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `Sequence "${rows[0].name}" (#${seqId}) is inactive. ` +
      `Reactivate it, pick another, or leave the field blank for the firm default.`);
  }
}

/**
 * SAVE-TIME referential check for completion targets — the completion-trigger
 * twin of _assertReminderSeqExists, same posture: the author is right there,
 * so a dangling or inactive target stops the save instead of silently
 * producing sends whose trigger dead-letters months later. Runtime stays
 * defensive anyway (applyStatus's fire path records a completion_trigger_failed
 * event and raises a task): a workflow deactivated AFTER the send degrades
 * loudly, never breaks the status transition.
 *
 * Exported: esignSendService re-runs it on PER-SEND overrides, which never
 * pass through template save.
 *
 * @throws ESIGN_BAD_TEMPLATE
 */
async function _assertCompletionTargetsExist(db, targets) {
  if (targets == null) return;
  for (const [key, t] of Object.entries(targets)) {
    if (t.type === 'workflow') {
      const [rows] = await db.query(
        'SELECT id, name, active FROM workflows WHERE id = ? LIMIT 1', [t.id]
      );
      if (!rows.length) {
        throw _err('ESIGN_BAD_TEMPLATE',
          `completion_targets.${key}: workflow ${t.id} does not exist.`);
      }
      if (!rows[0].active) {
        throw _err('ESIGN_BAD_TEMPLATE',
          `completion_targets.${key}: workflow "${rows[0].name}" (#${t.id}) is inactive. ` +
          `Reactivate it or pick another.`);
      }
    } else if (t.type === 'sequence') {
      const [rows] = await db.query(
        'SELECT id, name, active FROM sequence_templates WHERE id = ? LIMIT 1', [t.id]
      );
      if (!rows.length) {
        throw _err('ESIGN_BAD_TEMPLATE',
          `completion_targets.${key}: sequence template ${t.id} does not exist.`);
      }
      if (!rows[0].active) {
        throw _err('ESIGN_BAD_TEMPLATE',
          `completion_targets.${key}: sequence "${rows[0].name}" (#${t.id}) is inactive. ` +
          `Reactivate it or pick another.`);
      }
    }
  }
}

/**
 * SAVE-TIME column-existence check for expression resolvers (Phase 2E).
 *
 * validateTemplateInput's pure checks already settled syntax, allowed table
 * and blocked column; what only a db can answer is whether the COLUMN EXISTS.
 * resolverService soft-fails an unknown column at resolve time ('' on the
 * page) — acceptable at send, but at SAVE time the author is right there and
 * a typo'd column should stop the save, not blank a fee line three weeks on.
 *
 * One batched information_schema query for the whole schema; no-op when no
 * expression references anything.
 *
 * @throws ESIGN_BAD_RESOLVER naming every missing table.column
 */
async function assertExpressionColumnsExist(db, prefillSchema) {
  const prefill = require('./esignPrefillService');

  const pairs = new Map(); // 'table.column' → {table, column}
  for (const e of prefillSchema || []) {
    if (e && e.resolver != null && prefill.isExpressionResolver(e.resolver)) {
      // Re-scan (pure, cheap) rather than threading refs through clean —
      // validateExpressionResolver already proved these parse and pass policy.
      for (const ref of prefill.validateExpressionResolver(e.resolver)) {
        pairs.set(`${ref.table}.${ref.column}`, ref);
      }
    }
  }
  if (pairs.size === 0) return;

  const list = [...pairs.values()];
  const tuples = list.map(() => '(?, ?)').join(', ');
  const params = list.flatMap((r) => [r.table, r.column]);
  const [rows] = await db.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c
       FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE()
        AND (TABLE_NAME, COLUMN_NAME) IN (${tuples})`,
    params
  );
  const found = new Set((rows || []).map((r) => `${r.t}.${r.c}`));
  const missing = [...pairs.keys()].filter((k) => !found.has(k));
  if (missing.length) {
    throw _err('ESIGN_BAD_RESOLVER',
      `Expression resolver references column(s) that do not exist: ` +
      `${missing.join(', ')}. Check the spelling against the table's real columns.`);
  }
}

/**
 * Create. `resolverWhitelist` is a Set of legal resolver strings — pass
 * esignPrefillService.RESOLVER_NAMES (routes do).
 *
 * @returns {{ template: object, warnings: string[] }}
 */
async function createTemplate(db, input, resolverWhitelist) {
  const { clean, warnings } = validateTemplateInput(input, resolverWhitelist);
  await assertExpressionColumnsExist(db, clean.prefillSchema);
  await _assertReminderSeqExists(db, clean.reminderSeqId);
  await _assertCompletionTargetsExist(db, clean.completionTargets);

  // Both JSON columns supplied EXPLICITLY — non-strict sql_mode turns an
  // omitted NOT NULL JSON column into JSON null, and nothing errors until a
  // send tries to read the placement three weeks later.
  //
  // G2's two columns are APPENDED rather than slotted in next to
  // template_type, even though that is where they sit in the table. The column
  // list here is a bind order, not a schema description, and
  // tests/esignTemplates.test.js reads prefill_schema and placement_json out of
  // params[4] and params[5] by position. Inserting ahead of them would shift
  // both and break a test that has nothing to do with this feature. Append-only
  // is the rule for this statement.
  const [result] = await db.query(
    `INSERT INTO contract_templates
       (name, kind, template_type, body, prefill_schema, placement_json,
        reminder_seq_id, reminders_off, expiration_days, completion_targets,
        purpose, file_subfolder, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      clean.name,
      clean.kind,
      clean.templateType,
      clean.body,
      JSON.stringify(clean.prefillSchema),
      JSON.stringify(clean.placementJson),
      clean.reminderSeqId,
      clean.remindersOff ? 1 : 0,
      clean.expirationDays,
      clean.completionTargets == null ? null : JSON.stringify(clean.completionTargets),
      clean.purpose,
      clean.fileSubfolder,
    ]
  );

  return { template: await getTemplate(db, result.insertId), warnings };
}

/**
 * Update. PARTIAL: absent fields keep their stored values; the MERGED result
 * is what gets validated, so an update can never leave a template in a state
 * that createTemplate would have refused.
 *
 * `active` is NOT updatable here — deactivateTemplate is the only lever, on
 * purpose, so "who turned this template off" is always one code path.
 */
async function updateTemplate(db, id, input, resolverWhitelist) {
  const existing = await getTemplate(db, id);
  if (!existing) throw _err('ESIGN_NOT_FOUND', `Template ${id} not found.`);

  const has = (k) => input != null && Object.prototype.hasOwnProperty.call(input, k);

  // template_type is IMMUTABLE after create: an html body and a stored PDF
  // are different artifacts with different validation; "converting" one is
  // really creating the other. A caller sending a DIFFERENT type gets a
  // throw, not a silent keep.
  if (has('templateType') && String(input.templateType) !== existing.template_type) {
    throw _err('ESIGN_BAD_TEMPLATE',
      `template_type cannot be changed (this template is '${existing.template_type}'). ` +
      `Create a new template instead.`);
  }

  const merged = {
    name:           has('name')           ? input.name           : existing.name,
    kind:           has('kind')           ? input.kind           : existing.kind,
    templateType:   existing.template_type,
    // G2. Unlike template_type these ARE mutable: flipping a template into the
    // generate picker, or re-pointing its output drawer, is a policy edit, not
    // a change of artifact. Same keep-the-stored-value-when-absent rule as
    // every other field here.
    purpose:        has('purpose')        ? input.purpose        : existing.purpose,
    fileSubfolder:  has('fileSubfolder')  ? input.fileSubfolder  : existing.file_subfolder,
    body:           has('body')           ? input.body           : existing.body,
    prefillSchema:  has('prefillSchema')  ? input.prefillSchema  : existing.prefill_schema,
    placementJson:  has('placementJson')  ? input.placementJson  : existing.placement_json,
    expirationDays: has('expirationDays') ? input.expirationDays : existing.expiration_days,
    remindersOff:   has('remindersOff')   ? input.remindersOff   : existing.reminders_off,
    reminderSeqId:  has('reminderSeqId')  ? input.reminderSeqId  : existing.reminder_seq_id,
    completionTargets: has('completionTargets') ? input.completionTargets : existing.completion_targets,
    staticBody:     Boolean(input && input.staticBody),
  };

  const { clean, warnings } = validateTemplateInput(merged, resolverWhitelist);
  await assertExpressionColumnsExist(db, clean.prefillSchema);
  await _assertReminderSeqExists(db, clean.reminderSeqId);
  await _assertCompletionTargetsExist(db, clean.completionTargets);

  // Appended, not slotted in — same reason as createTemplate's INSERT above:
  // this list is a bind order and existing tests read params by position.
  await db.query(
    `UPDATE contract_templates
        SET name = ?, kind = ?, body = ?, prefill_schema = ?, placement_json = ?,
            reminder_seq_id = ?, reminders_off = ?, expiration_days = ?,
            completion_targets = ?, purpose = ?, file_subfolder = ?
      WHERE id = ?`,
    [
      clean.name,
      clean.kind,
      clean.body,
      JSON.stringify(clean.prefillSchema),
      JSON.stringify(clean.placementJson),
      clean.reminderSeqId,
      clean.remindersOff ? 1 : 0,
      clean.expirationDays,
      clean.completionTargets == null ? null : JSON.stringify(clean.completionTargets),
      clean.purpose,
      clean.fileSubfolder,
      Number(id),
    ]
  );

  return { template: await getTemplate(db, id), warnings };
}

/**
 * Deactivate. Rows are NEVER deleted — signing_requests.template_id is
 * history, and history does not get orphaned to tidy a picker.
 */
async function deactivateTemplate(db, id) {
  const existing = await getTemplate(db, id);
  if (!existing) throw _err('ESIGN_NOT_FOUND', `Template ${id} not found.`);

  await db.query('UPDATE contract_templates SET active = 0 WHERE id = ?', [Number(id)]);
  return getTemplate(db, id);
}

/**
 * Distinct kinds carried by ACTIVE templates. Consumed by
 * esignSendService.legalKinds() / validateSendInput — the union of this and
 * 2A's static KINDS is the send-time legal set.
 */
async function listActiveTemplateKinds(db) {
  const [rows] = await db.query(
    'SELECT DISTINCT kind FROM contract_templates WHERE active = 1'
  );
  return (rows || []).map((r) => r.kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deactivateTemplate,
  listActiveTemplateKinds,
  assertExpressionColumnsExist,
  setTemplatePdf,
  getTemplatePdf,
  // pure — shared with sendService + tests
  validateTemplateInput,
  extractPlaceholders,
  validateCompletionTargets,
  // referential — sendService re-runs it on per-send overrides
  _assertCompletionTargetsExist,
  // constants
  PREFILL_TYPES,
  TEMPLATE_TYPES,
  PURPOSES,
  DEFAULT_PURPOSE,
  DEFAULT_FILE_SUBFOLDER,
  MAX_FILE_SUBFOLDER,
  COMPLETION_TRIGGER_KEYS,
  COMPLETION_TARGET_TYPES,
  MAX_TEMPLATE_PDF_BYTES,
  KEY_RE,
  MIN_NAME, MAX_NAME, MAX_KIND,
  MIN_EXPIRATION_DAYS, MAX_EXPIRATION_DAYS,
};