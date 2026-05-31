// services/phoneIngestMetaService.js
//
/**
 * Phone Ingest — Meta Service (L3)
 * services/phoneIngestMetaService.js
 *
 * Assembles GET /api/phone-ingest/meta — the payload the phone suppression +
 * automation-rule UI consumes to render the match-builder AND the L3 action
 * builder. Originally suppression-only (Stage 1); L3 restores `action_types`,
 * `targets`, and `execution_statuses` to reach parity with
 * emailIngestMetaService.
 *
 * Phone-specific divergences from email's meta:
 *   - No `sources` target list (phone has no sources table — events arrive via
 *     YisraHooks→workflows, not multi-source HTTP receivers).
 *   - `execution_statuses` carries the phone enum only: logged | suppressed |
 *     error. (Phone never auto-skips firm-to-firm as a distinct status — see
 *     phoneIngestExecutionsService header.)
 *   - `match_fields` is the phone catalog (incl. extra.firmToFirm); email has
 *     no equivalent curated catalog block.
 *
 * `action_types` is ported verbatim from emailIngestMetaService — the action
 * dispatcher is shared (lib/actionDispatchers), so the config_schema_hint
 * blocks are identical.
 *
 * match_operators comes from hookFilter.listOperators() (the live registry) so
 * it can't drift from the engine; human labels are mapped here.
 *
 * match_fields is the curated catalog the match-builder offers as dropdown
 * options. Every path here must actually exist on the create_log params object
 * phone_log receives, or a rule built against it silently never matches. The
 * catalog is the verified UNION across the 5 phone workflows (wf17/18/19 sms,
 * wf20/21 call); per-field `channels` notes which event types populate it so
 * the UI can hint (it does NOT filter — a call-only field offered for an sms
 * rule just never matches, which is harmless).
 */

const { listOperators } = require('./hookFilter');
// Phone L3 reuses the table-agnostic email validator (same as
// phoneIngestRuleService) for the internal_functions target list.
//
// CIRCULAR-DEPENDENCY NOTE: emailIngestValidator requires
// ../lib/internal_functions, and the phone-log pipeline lives inside
// internal_functions and pulls in the phone ingest services. A top-level
// `const validator = require('./emailIngestValidator')` can therefore capture
// emailIngestValidator's exports while it is still mid-load (the default empty
// {}), leaving validator.internalFunctionNames undefined — the "Accessing
// non-existent property ... inside circular dependency" warning + a runtime
// TypeError when GET /api/phone-ingest/meta builds its target lists (which
// breaks the whole phone-ingest UI, since every tab loads /meta first).
// Resolve it lazily: require at CALL time, by which point the module graph has
// finished initializing. (Same fix already applied to
// phoneIngestSuppressionService and phoneIngestRuleService.)
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

// Phone enum ONLY (phoneIngestExecutionsService.VALID_STATUSES):
// logged | suppressed | error. Email's richer set (duplicate, skipped_*,
// auth_failed, validation_failed) does not apply to the phone pipeline.
const EXECUTION_STATUSES = [
  { value: 'logged',     label: 'Logged' },
  { value: 'suppressed', label: 'Suppressed' },
  { value: 'error',      label: 'Error' },
];

// config_schema_hint per action_type — ported verbatim from
// emailIngestMetaService. The action dispatcher (lib/actionDispatchers) is
// shared between email and phone L3, so these hints are identical.
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
// MATCH FIELD CATALOG
//
// Verified against the live create_log params of all 5 phone workflows
// (readonly query, May 2026). `channels` is advisory for the UI only.
//   sms  steps: wf17 s1, wf18 s1, wf19 s4
//   call steps: wf20 s4, wf21 s1
// ─────────────────────────────────────────────────────────────

const MATCH_FIELDS = [
  // The field you almost always want: canonical 10-digit other-party number,
  // direction-independent (create_log derives link_id as the non-firm party).
  { path: 'link_id',               label: 'Other party number (link_id)', type: 'string', channels: ['sms', 'call'] },

  { path: 'type',                  label: 'Event type (sms/call)',        type: 'string', channels: ['sms', 'call'] },
  { path: 'direction',             label: 'Direction',                    type: 'string', channels: ['sms', 'call'] },
  { path: 'from',                  label: 'From number',                  type: 'string', channels: ['sms', 'call'] },
  { path: 'to',                    label: 'To number',                    type: 'string', channels: ['sms', 'call'] },

  { path: 'extra.provider',        label: 'Provider',                     type: 'string', channels: ['sms', 'call'] },
  { path: 'extra.line',            label: 'Firm line',                    type: 'string', channels: ['sms', 'call'] },
  { path: 'extra.conversation_id', label: 'Conversation ID',              type: 'string', channels: ['sms', 'call'] },
  { path: 'extra.firmToFirm',      label: 'Firm-to-firm (other party is a firm number)', type: 'boolean', channels: ['sms', 'call'] },

  // call-only
  { path: 'extra.provider_status', label: 'Call status (provider)',       type: 'string', channels: ['call'] },
  { path: 'data.status',           label: 'Call status',                  type: 'string', channels: ['call'] },
  { path: 'data.duration_seconds', label: 'Call duration (seconds)',      type: 'number', channels: ['call'] },

  // sms-only — content matching is rarely the intent; offered last.
  { path: 'message',               label: 'Message body',                 type: 'string', channels: ['sms'] },
];


// ─────────────────────────────────────────────────────────────
// TARGET LISTS (from live tables)
//
// Ported from emailIngestMetaService._targets, MINUS any `sources` list —
// phone has no sources table.
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