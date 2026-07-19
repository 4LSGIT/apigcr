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
const PREFILL_TYPES = Object.freeze(['text', 'number', 'date', 'money']);

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
  };
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
 * @param {Set<string>} resolverWhitelist  legal resolver strings
 * @returns {{ clean: object, warnings: string[] }}
 */
function validateTemplateInput(t, resolverWhitelist) {
  const {
    name, kind, body, prefillSchema, placementJson,
    expirationDays = 14, remindersOff = false, reminderSeqId = null,
    staticBody = false,
  } = t || {};

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
  const bodyClean = String(body == null ? '' : body);
  if (!bodyClean.trim()) {
    throw _err('ESIGN_BAD_TEMPLATE', 'Template body must not be empty.');
  }

  const placeholders = extractPlaceholders(bodyClean);
  if (placeholders.length === 0 && !staticBody) {
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
    if (resolver !== null && !resolverWhitelist.has(resolver)) {
      // Rejected at SAVE time, not send time — the author is the person who
      // can fix it, and they are looking at the editor right now.
      throw _err('ESIGN_BAD_RESOLVER',
        `prefill_schema[${i}].resolver "${resolver}" is not a known resolver. ` +
        `Known: ${[...resolverWhitelist].sort().join(', ')}.`);
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

  // ── body ↔ schema cross-check ─────────────────────────────────────────────
  const undeclared = placeholders.filter((p) => !keys.has(p));
  if (undeclared.length) {
    throw _err('ESIGN_UNDECLARED_PLACEHOLDER',
      `The body uses placeholder(s) not declared in prefill_schema: ` +
      `${undeclared.map((k) => `{{${k}}}`).join(', ')}.`,
      { placeholders: undeclared });
  }
  // Declared-but-unused is LEGAL (a schema shared across template revisions,
  // a value only the placement layer uses later) — warn, don't block.
  const warnings = [];
  const unused = [...keys].filter((k) => !placeholders.includes(k));
  if (unused.length) {
    warnings.push(`Declared but unused in the body: ${unused.join(', ')}.`);
  }

  // ── placement_json ────────────────────────────────────────────────────────
  // ONE validator for the whole subsystem — services/esign/placements.js.
  const placements = placementJson == null ? { fields: [] } : placementJson;
  validatePlacements(placements);

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

  return {
    clean: {
      name: nameClean,
      kind: kindClean,
      body: bodyClean,
      prefillSchema: schemaClean,
      placementJson: placements,
      expirationDays: exp,
      remindersOff: Boolean(remindersOff),
      reminderSeqId: seqId,
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
 */
async function listTemplates(db, { activeOnly = true } = {}) {
  const [rows] = await db.query(
    `SELECT id, name, kind, active, expiration_days, reminders_off, updated_at
       FROM contract_templates
      ${activeOnly ? 'WHERE active = 1' : ''}
      ORDER BY name ASC, id ASC`
  );
  return (rows || []).map((r) => ({
    ...r,
    active:        Number(r.active) === 1,
    reminders_off: Number(r.reminders_off) === 1,
  }));
}

/** One template, full row, JSON columns parsed. Null when absent. */
async function getTemplate(db, id) {
  const [[row]] = await db.query(
    'SELECT * FROM contract_templates WHERE id = ? LIMIT 1',
    [Number(id)]
  );
  return _shapeFull(row);
}

/**
 * Create. `resolverWhitelist` is a Set of legal resolver strings — pass
 * esignPrefillService.RESOLVER_NAMES (routes do).
 *
 * @returns {{ template: object, warnings: string[] }}
 */
async function createTemplate(db, input, resolverWhitelist) {
  const { clean, warnings } = validateTemplateInput(input, resolverWhitelist);

  // Both JSON columns supplied EXPLICITLY — non-strict sql_mode turns an
  // omitted NOT NULL JSON column into JSON null, and nothing errors until a
  // send tries to read the placement three weeks later.
  const [result] = await db.query(
    `INSERT INTO contract_templates
       (name, kind, body, prefill_schema, placement_json,
        reminder_seq_id, reminders_off, expiration_days, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      clean.name,
      clean.kind,
      clean.body,
      JSON.stringify(clean.prefillSchema),
      JSON.stringify(clean.placementJson),
      clean.reminderSeqId,
      clean.remindersOff ? 1 : 0,
      clean.expirationDays,
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

  const merged = {
    name:           has('name')           ? input.name           : existing.name,
    kind:           has('kind')           ? input.kind           : existing.kind,
    body:           has('body')           ? input.body           : existing.body,
    prefillSchema:  has('prefillSchema')  ? input.prefillSchema  : existing.prefill_schema,
    placementJson:  has('placementJson')  ? input.placementJson  : existing.placement_json,
    expirationDays: has('expirationDays') ? input.expirationDays : existing.expiration_days,
    remindersOff:   has('remindersOff')   ? input.remindersOff   : existing.reminders_off,
    reminderSeqId:  has('reminderSeqId')  ? input.reminderSeqId  : existing.reminder_seq_id,
    staticBody:     Boolean(input && input.staticBody),
  };

  const { clean, warnings } = validateTemplateInput(merged, resolverWhitelist);

  await db.query(
    `UPDATE contract_templates
        SET name = ?, kind = ?, body = ?, prefill_schema = ?, placement_json = ?,
            reminder_seq_id = ?, reminders_off = ?, expiration_days = ?
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
  // pure — shared with sendService + tests
  validateTemplateInput,
  extractPlaceholders,
  // constants
  PREFILL_TYPES,
  KEY_RE,
  MIN_NAME, MAX_NAME, MAX_KIND,
  MIN_EXPIRATION_DAYS, MAX_EXPIRATION_DAYS,
};
