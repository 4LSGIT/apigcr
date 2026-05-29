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
const validator = require('./emailIngestValidator');


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
    internal_functions: validator.internalFunctionNames(),
    credentials,
  };
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
    transform_modes:    TRANSFORM_MODES,
    action_types:       ACTION_TYPES,
    targets,
    execution_statuses: EXECUTION_STATUSES,
  };
}


module.exports = {
  getMeta,
};