// services/emailIngestMetaService.js
//
/**
 * Email Ingest — Meta Service (Phase 3 Slice 3.1)
 * services/emailIngestMetaService.js
 *
 * Assembles GET /api/email-ingest/meta — the dropdown + form-hint payload the
 * Phase 3.2 UI consumes. Nothing here is enforced server-side; validation is
 * separate (emailIngestValidator). The config_schema_hint blocks describe the
 * `config` shape each action_type's dispatcher actually reads.
 *
 * Dispatcher-verified config keys (lib/actionDispatchers.js):
 *   workflow          → config.workflow_id          (contact resolved from the
 *                       workflow's own default_contact_id_from — NOT config)
 *   sequence          → config.template_id OR config.template_type, plus
 *                       config.contact_id_field (default 'contact_id') and
 *                       config.trigger_data_fields (array of field paths)
 *   hook              → config.slug
 *   internal_function → config.function_name, config.params_mapping
 *   http              → config.url / method / headers / body_mode /
 *                       body_template / credential_id
 *
 * Operator list comes from hookFilter.listOperators() (the live registry), so
 * it can't drift from the engine; human labels are mapped here.
 */

const { listOperators } = require('./hookFilter');

// CIRCULAR-DEPENDENCY NOTE: emailIngestValidator requires
// ../lib/internal_functions, and the phone-log pipeline lives inside
// internal_functions and pulls in the phone ingest services. Today nothing in
// that load graph requires this service back, so a top-level
// `const validator = require('./emailIngestValidator')` happens to work — but
// any future edge from the internal_functions graph into the email ingest
// services would turn it into a partial-exports capture (the default empty {}
// mid-load), with validator.* coming back undefined at runtime. Resolve it
// lazily, matching phoneIngestMetaService / phoneIngestRuleService /
// phoneIngestSuppressionService, so the email and phone sides carry the same
// convention and the landmine class is closed.
function _validator() {
  // Lazy require — see CIRCULAR-DEPENDENCY NOTE above. Node caches the module,
  // so this is a cheap registry lookup after first load, not a re-parse.
  return require('./emailIngestValidator');
}


// ─────────────────────────────────────────────────────────────
// STATIC ENUMS / LABELS
// ─────────────────────────────────────────────────────────────

const OPERATOR_LABELS = {
  equals:       'equals',
  not_equals:   'not equals',
  contains:     'contains',
  not_contains: 'does not contain',
  starts_with:  'starts with',
  ends_with:    'ends with',
  gt:           '>',
  gte:          '>=',
  lt:           '<',
  lte:          '<=',
  exists:       'exists',
  not_exists:   'does not exist',
  in:           'in',
  not_in:       'not in',
  matches:      'matches regex',
};

const MATCH_MODES = [
  { value: 'conditions', label: 'Conditions tree' },
  { value: 'code',       label: 'Custom code (JS)' },
];

const TRANSFORM_MODES = [
  { value: 'passthrough', label: 'Passthrough' },
  { value: 'mapper',      label: 'Field mapper' },
  { value: 'code',        label: 'Custom code (JS)' },
];

const EXECUTION_STATUSES = [
  { value: 'logged',               label: 'Logged' },
  { value: 'duplicate',            label: 'Duplicate' },
  { value: 'skipped_firm_to_firm', label: 'Skipped (firm-to-firm)' },
  { value: 'skipped_suppression',  label: 'Skipped (suppression rule)' },
  { value: 'auth_failed',          label: 'Auth failed' },
  { value: 'validation_failed',    label: 'Validation failed' },
  { value: 'error',                label: 'Error' },
];

// ─────────────────────────────────────────────────────────────
// MATCH FIELD CATALOG (server-owned — mirrors phoneIngestMetaService.MATCH_FIELDS)
//
// Content = the 12 fields formerly HARDCODED as `EMAIL_MATCH_FIELDS` in
// emailIngest.html. Converging email onto phone's server-owned pattern: the
// server is now the single source of truth, and the frontend matchFields()
// reads meta.match_fields (path→value), exactly like phone.
//
// Shape is { path, label, type } — same as phone MINUS `channels` (email has
// no sms/call split, so no per-field channel tagging). The frontend's
// matchFields() treats an absent `channels` as "both / no tag", so omitting it
// is correct (a present-but-empty array would behave the same).
//
// This catalog is ALSO consumed by emailIngestSampleService as the projection
// target (the sample panel shows real values for exactly these paths). The
// sample adapter maps each path to a clean source:
//   from.email / to / subject / body / source / headers.message_id / auth.*
//     → always recoverable from email_log + log.log_extra.
//   from.name / kind / headers.list_id / headers.in_reply_to → only present in
//     intact (<16KB, parseable) raw_input rows (~25%); otherwise present:false.
// ─────────────────────────────────────────────────────────────

const MATCH_FIELDS = [
  { path: 'from.email',          label: 'From — email address',                 type: 'string' },
  { path: 'from.name',           label: 'From — display name',                  type: 'string' },
  { path: 'to',                  label: 'To (raw)',                             type: 'string' },
  { path: 'subject',             label: 'Subject',                              type: 'string' },
  { path: 'kind',                label: 'Kind (email)',                         type: 'string' },
  { path: 'source',              label: 'Source (gmail-firm / siteground-php)', type: 'string' },
  { path: 'headers.message_id',  label: 'Header — Message-ID',                  type: 'string' },
  { path: 'headers.list_id',     label: 'Header — List-ID',                     type: 'string' },
  { path: 'headers.in_reply_to', label: 'Header — In-Reply-To',                 type: 'string' },
  { path: 'auth.spf',            label: 'Auth — SPF result',                    type: 'string' },
  { path: 'auth.dkim',           label: 'Auth — DKIM result',                   type: 'string' },
  { path: 'auth.dmarc',          label: 'Auth — DMARC result',                  type: 'string' },
  // Body is large free text (email_log.body, often HTML). Offered LAST — like
  // phone's `message` — because content matching (contains) is the only sane
  // use; equals/large-value matches against it are a footgun. The sample panel
  // caps its displayed value to a snippet (see emailIngestSampleService).
  { path: 'body',                label: 'Body (full text)',                     type: 'string' },
];

// config_schema_hint per action_type — verified against the dispatchers.
const ACTION_TYPES = [
  {
    value: 'workflow',
    label: 'Start workflow',
    config_schema_hint: {
      required: ['workflow_id'],
      fields: {
        workflow_id: { type: 'select', source: 'workflows', label: 'Workflow' },
      },
      note: 'Contact is resolved from the workflow\'s own default_contact_id_from; not set here.',
    },
  },
  {
    value: 'sequence',
    label: 'Enroll in sequence',
    config_schema_hint: {
      required: ['template_id'],
      fields: {
        template_id:         { type: 'select', source: 'sequences', label: 'Sequence template' },
        template_type:       { type: 'string', label: 'Sequence type (alternative to template_id)' },
        contact_id_field:    { type: 'string', label: 'Contact-id field path', default: 'contact_id' },
        trigger_data_fields: { type: 'json',   label: 'Trigger-data field paths (array, optional)' },
      },
      note: 'Provide template_id (preferred) OR template_type. contact_id_field is read from the transform output.',
    },
  },
  {
    value: 'hook',
    label: 'Invoke hook',
    config_schema_hint: {
      required: ['slug'],
      fields: {
        slug: { type: 'select', source: 'hooks', value_field: 'slug', label: 'Hook' },
      },
    },
  },
  {
    value: 'internal_function',
    label: 'Call internal function',
    config_schema_hint: {
      required: ['function_name'],
      fields: {
        function_name:  { type: 'select', source: 'internal_functions', label: 'Function' },
        params_mapping: { type: 'json', label: 'Params mapping (optional)' },
      },
    },
  },
  {
    value: 'http',
    label: 'HTTP request',
    config_schema_hint: {
      required: ['url'],
      fields: {
        url:           { type: 'string', label: 'URL' },
        method:        { type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'POST' },
        headers:       { type: 'json', label: 'Static headers (optional)' },
        body_mode:     { type: 'select', options: ['transform_output', 'template'], default: 'transform_output' },
        body_template: { type: 'string', label: 'Body template (if body_mode=template)' },
        credential_id: { type: 'select', source: 'credentials', label: 'Credential (optional)' },
      },
    },
  },
];


// ─────────────────────────────────────────────────────────────
// TARGET LISTS (from live tables)
// ─────────────────────────────────────────────────────────────

async function _targets(db) {
  const [workflows] = await db.query(
    `SELECT id, name FROM workflows WHERE active = 1 ORDER BY name ASC`
  );
  const [sequences] = await db.query(
    `SELECT id, name, type FROM sequence_templates WHERE active = 1 ORDER BY name ASC`
  );
  const [hooks] = await db.query(
    `SELECT id, slug, name FROM hooks WHERE active = 1 ORDER BY name ASC`
  );
  // credentials has no `active` column — return all.
  const [credentials] = await db.query(
    `SELECT id, name, type FROM credentials ORDER BY name ASC`
  );

  return {
    workflows,
    sequences,
    hooks,
    internal_functions: _validator().internalFunctionNames(),
    internal_function_meta: _internalFunctionMeta(),
    credentials,
  };
}

// name → { category } for the grouped function picker (fnPicker.js).
// Names without __meta simply have no entry (they group under 'other'
// client-side). uiHidden is deliberately NOT included: the ingest surfaces
// ignore hiding, and omitting the flag makes that impossible to get wrong.
//
// Lazy require of lib/internal_functions — same rationale as
// phoneIngestMetaService's CIRCULAR-DEPENDENCY NOTE: the phone-log pipeline
// lives inside internal_functions and pulls in ingest services, so a
// top-level require here could capture a mid-load module. Node caches the
// module, so this is a cheap lookup after first load.
function _internalFunctionMeta() {
  const allMeta = require('../lib/internal_functions').__getAllMeta();
  const out = {};
  for (const [name, m] of Object.entries(allMeta)) {
    if (m && m.category) out[name] = { category: m.category };
  }
  return out;
}


// ─────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────

async function getMeta(db) {
  const match_operators = listOperators().map((op) => ({
    value: op,
    label: OPERATOR_LABELS[op] || op,
  }));

  const targets = await _targets(db);

  return {
    match_operators,
    match_modes:        MATCH_MODES,
    match_fields:       MATCH_FIELDS,
    transform_modes:    TRANSFORM_MODES,
    action_types:       ACTION_TYPES,
    targets,
    execution_statuses: EXECUTION_STATUSES,
  };
}


module.exports = {
  getMeta,
  MATCH_FIELDS,
};