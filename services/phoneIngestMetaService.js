// services/phoneIngestMetaService.js
//
/**
 * Phone Ingest — Meta Service (Stage 1)
 * services/phoneIngestMetaService.js
 *
 * Assembles GET /api/phone-ingest/meta — the payload the phone suppression UI
 * consumes to render the match-builder. Stage 1 is suppression-only, so this
 * is deliberately smaller than emailIngestMetaService: no action_types, no
 * targets, no transform_modes, no execution_statuses (those are Layer-3
 * concerns phone doesn't have — phone automation already lives in the
 * per-event workflows).
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
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────

function getMeta() {
  const match_operators = listOperators().map((op) => ({
    value: op,
    label: OPERATOR_LABELS[op] || op,
  }));

  return {
    match_operators,
    match_modes:  MATCH_MODES,
    match_fields: MATCH_FIELDS,
  };
}


module.exports = {
  getMeta,
  MATCH_FIELDS,
};