// services/triggerService.js
//
/**
 * Trigger Service — domain-event trigger engine (Slice T1)
 * services/triggerService.js
 *
 * Third consumer of the shared automation primitives (after YisraHook and the
 * email/phone ingest rules): evaluates active `trigger_rules` for a domain
 * event's type against the event envelope (built by lib/domainEvents.js) and
 * fires each matching rule's ordered `trigger_rule_actions` through
 * lib/actionDispatchers.dispatch() — workflow / sequence / internal_function /
 * http — plus the `hook` action type that re-enters the YisraHook pipeline.
 *
 * SEMANTICS (carried verbatim from services/emailIngestRuleService.js —
 * hard-won rules, do not soften):
 *   - Throwing match rules log a warning and count as NON-match (fail-safe:
 *     a broken rule never fires actions).
 *   - NULL match_config on conditions mode is NON-match, NOT match-all.
 *     Explicit always-match = {operator:'and', conditions:[]}.
 *   - A failed transform → the rule still counts as MATCHED (metrics bump)
 *     but its actions do not fire (never feed garbage to actions); the
 *     failure is recorded as a warning in the execution row.
 *   - Action failures are isolated: one action failing does NOT abort the
 *     remaining actions of the same rule or later rules.
 *   - Live SQL rule edits propagate immediately (no cache).
 *
 * TRIGGER-SPECIFIC:
 *   - Rules are loaded per event_type (idx_event_active).
 *   - Every processed event writes ONE trigger_executions row
 *     (status matched / no_match / no_rules / depth_capped / error) carrying
 *     the envelope — this doubles as the sample-envelope source for the T2
 *     UI's field-discovery panel, which is why no_match/no_rules rows are
 *     kept. A retention sweep lands in T4.
 *   - Each action dispatch runs inside domainEvents.runAsAction(rule.id, …)
 *     so any events re-emitted by the action's side effects carry depth+1 /
 *     the rule id on the chain. processEvent drops events arriving at
 *     depth >= domainEvents.MAX_DEPTH ('depth_capped' row + alert).
 *   - No test-envelope gate (no replay path exists for domain events; the
 *     ingest gate is a deliberate divergence documented there).
 *
 * EVENT REGISTRY
 *   EVENT_TYPES is the authoritative catalog of emittable events + their
 *   envelope field catalogs (consumed by the T2 UI match-builder and by
 *   createRule validation). Adding an event type = adding an emit() call in
 *   a service + a registry entry here — both are code, one deploy.
 */

'use strict';

const { evaluateConditions } = require('./hookFilter');
const hookMapper             = require('./hookMapper');
const actionDispatchers      = require('../lib/actionDispatchers');
const domainEvents           = require('../lib/domainEvents');

// ─────────────────────────────────────────────────────────────
// EVENT REGISTRY
// ─────────────────────────────────────────────────────────────

const COMMON_FIELDS = [
  { path: 'event',      label: 'Event type' },
  { path: 'ts',         label: 'Timestamp (ISO)' },
  { path: 'depth',      label: 'Trigger chain depth' },
  { path: 'source',     label: 'Action source (manual/system/client/…)' },
  { path: 'actor.user_id', label: 'Acting user id (0 = system)' },
  { path: 'contact_id', label: 'Contact id' },
  { path: 'case_id',    label: 'Case id (null when caseless)' },
];

const APPT_DATA_FIELDS = [
  { path: 'data.appt_id',       label: 'Appt id' },
  { path: 'data.appt_type',     label: 'Appt type (free text)' },
  { path: 'data.appt_with',     label: 'Provider user id' },
  { path: 'data.appt_date',     label: 'Appt date (firm-local)' },
  { path: 'data.appt_status',   label: 'Appt status (post-mutation)' },
];

const EVENT_TYPES = {
  'appt.created': {
    label: 'Appointment created',
    description: 'Fires post-commit from apptService.createAppt for every caller (API, booking, workflows, reschedules — the reschedule successor fires this too).',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'data.appt_platform', label: 'Platform' },
      { path: 'data.appt_source',   label: 'appt_source (row column)' },
      { path: 'data.appt_view_id',  label: 'Booking view id (null = internal)' },
      { path: 'extra.hook_event',   label: "'created' | 'rescheduled' | 'rebooked'" },
      { path: 'extra.rescheduled_from', label: 'Old appt id (reschedule successor only)' },
    ],
  },
  'appt.attended': {
    label: 'Appointment marked Attended',
    description: 'Fires from apptService.markAttended.',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'data.case_type',    label: 'Case type (joined; null when caseless)' },
      { path: 'data.case_subtype', label: 'Case subtype (joined)' },
      { path: 'extra.prior_status', label: 'Status before Attended' },
    ],
  },
  'appt.no_show': {
    label: 'Appointment marked No Show',
    description: 'Fires from apptService.markNoShow. Note: the no_show pipeline advance is (pre-existing) hardcoded in markNoShow itself — do not duplicate it as a rule.',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'data.case_type',    label: 'Case type (joined)' },
      { path: 'data.case_subtype', label: 'Case subtype (joined)' },
      { path: 'extra.prior_status', label: 'Status before No Show' },
      { path: 'extra.enrolled',     label: 'no_show sequence enrolled (bool)' },
    ],
  },
  'appt.cancelled': {
    label: 'Appointment cancelled',
    description: 'Fires from apptService.cancelAppt.',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'data.appt_view_id',  label: 'Booking view id' },
      { path: 'extra.prior_status', label: 'Status before Canceled' },
    ],
  },
  'appt.rescheduled': {
    label: 'Appointment rescheduled (old appt)',
    description: 'Fires from apptService.rescheduleAppt for the OLD appt after its successor exists. The successor separately fires appt.created with extra.hook_event=rescheduled.',
    fields: [
      ...COMMON_FIELDS, ...APPT_DATA_FIELDS,
      { path: 'extra.new_appt_id',  label: 'Successor appt id' },
      { path: 'extra.new_appt_date', label: 'Successor appt date' },
    ],
  },
  'appt.reschedule_later': {
    label: 'Appointment marked Reschedule Later',
    description: 'Fires from apptService.rescheduleLater (slot freed, no successor).',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.appt_id',   label: 'Appt id' },
      { path: 'data.appt_type', label: 'Appt type (free text)' },
      { path: 'data.appt_date', label: 'Appt date' },
      { path: 'data.appt_with', label: 'Provider user id' },
    ],
  },
  // ── T3 events ────────────────────────────────────────────
  'contact.created': {
    label: 'Contact created',
    description: 'Fires post-commit from contactService.createContact (all callers: intake, orphan-adopt, API).',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.contact_type',  label: 'Contact type' },
      { path: 'data.contact_name',  label: 'Full name' },
      { path: 'data.contact_phone', label: 'Primary phone' },
      { path: 'data.contact_email', label: 'Primary email' },
      { path: 'data.contact_tags',  label: 'Tags' },
      { path: 'data.contact_clio_id', label: 'Clio id' },
    ],
  },
  'contact.updated': {
    label: 'Contact updated',
    description: 'Fires post-commit from contactService.updateContact when something actually changed. changes carries per-field {from,to} for scalar columns; aggregate (phones/emails/addresses) reconciles surface as counts in extra. Not fired by direct SQL writers that bypass updateContact.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.contact_type',  label: 'Contact type' },
      { path: 'data.contact_name',  label: 'Full name' },
      { path: 'data.contact_phone', label: 'Primary phone (post-update)' },
      { path: 'data.contact_email', label: 'Primary email (post-update)' },
      { path: 'changes.contact_phone', label: 'Phone changed (exists = yes)' },
      { path: 'changes.contact_email', label: 'Email changed (exists = yes)' },
      { path: 'changes.contact_tags',  label: 'Tags changed (exists = yes)' },
      { path: 'extra.updated_fields',    label: 'Updated field list' },
      { path: 'extra.phones_changed',    label: 'Aggregate phones changed' },
      { path: 'extra.emails_changed',    label: 'Aggregate emails changed' },
      { path: 'extra.addresses_changed', label: 'Aggregate addresses changed' },
    ],
  },
  'case.created': {
    label: 'Case created',
    description: 'Fires from the intake case-create route and the petition-filing case-create branch (the two case INSERT sites). source distinguishes: intake | petition.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.case_type',    label: 'Case type' },
      { path: 'data.case_subtype', label: 'Case subtype' },
      { path: 'data.case_number',  label: 'Case number (opaque text)' },
      { path: 'data.case_chapter', label: 'Chapter (petition path only)' },
    ],
  },
  'case.updated': {
    label: 'Case updated',
    description: 'Fires from caseService.updateCase (detail form + the update_case internal function, which now delegates) when something actually changed. Direct SQL writers (court executor field writes, 341 pointer, dropbox path) bypass this deliberately. Stage moves are case.stage_advanced, not case.updated.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.case_type',    label: 'Case type' },
      { path: 'data.case_subtype', label: 'Case subtype' },
      { path: 'data.case_stage',   label: 'case_stage (legacy enum)' },
      { path: 'changes.case_number',   label: 'Docket changed (exists = yes)' },
      { path: 'changes.case_subtype',  label: 'Subtype changed (exists = yes)' },
      { path: 'changes.case_file_date', label: 'File date changed (exists = yes)' },
      { path: 'extra.updated_fields',  label: 'Updated field list' },
    ],
  },
  'case.stage_advanced': {
    label: 'Case pipeline stage advanced',
    description: 'Fires post-commit from pipelineService.advanceStage for every REAL advance (guard-skips and same-stage no-ops do not fire). advanceStage is the only case_stage_log writer, so this covers all surfaces: board drags, workflows, trigger rules, esign, checklists.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.stage_key',    label: 'New stage key' },
      { path: 'data.status_label', label: 'New stage label' },
      { path: 'data.case_stage',   label: 'New case_stage enum' },
      { path: 'data.template_id',  label: 'Template id' },
      { path: 'data.case_type',    label: 'Case type' },
      { path: 'data.case_subtype', label: 'Case subtype' },
      { path: 'extra.from_stage',  label: 'Previous stage key (null = first entry)' },
      { path: 'extra.note',        label: 'Advance note' },
    ],
  },
  'case.contact_linked': {
    label: 'Contact linked to case',
    description: 'Fires from caseService.addCaseContact. NOT fired by the intake/petition routes\' direct case_relate INSERTs at creation (case.created covers those).',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.relate_type', label: 'Relation type (Primary/Secondary/Other/Bystander)' },
    ],
  },
  'case.contact_unlinked': {
    label: 'Contact unlinked from case',
    description: 'Fires from caseService.removeCaseContact when a row was actually removed.',
    fields: [ ...COMMON_FIELDS ],
  },
  // ── T4 events ────────────────────────────────────────────
  'form.submitted': {
    label: 'Form submitted',
    description: 'Fires from formService.submitForm — both the internal client (case2/contact2 YisraForms) and the external surface. extra.surface = internal | external. The envelope deliberately excludes the submission data payload (large + potentially sensitive); rules needing values should route to a workflow that fetches the submission.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.form_key',      label: 'Form key' },
      { path: 'data.link_type',     label: 'Link type (contact/case/...)' },
      { path: 'data.version',       label: 'Submission version' },
      { path: 'data.submission_id', label: 'form_submissions.id' },
      { path: 'extra.surface',      label: "'internal' | 'external'" },
    ],
  },
  'esign.status_changed': {
    label: 'E-sign status changed',
    description: 'Fires from esignWebhookService.processStatusChange whenever a signing request actually transitions (webhook or reconciliation — source distinguishes). data.status is the INTERNAL status vocabulary: sent, viewed, signed, declined, bounced, recalled, expired, reminded. Filter data.status equals "signed" for completion.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.status',          label: 'New internal status' },
      { path: 'data.provider_status', label: 'Raw provider status' },
      { path: 'data.kind',            label: 'Request kind' },
      { path: 'data.document_name',   label: 'Document name' },
      { path: 'data.request_id',      label: 'signing_requests.id' },
      { path: 'extra.prior_status',   label: 'Status before the transition' },
      { path: 'extra.recipient_email', label: 'Recipient email (when per-recipient)' },
    ],
  },
  'checkitem.completed': {
    label: 'Checklist item completed',
    description: 'Fires from PATCH /checkitems/:id when an item transitions to complete (idempotent re-saves do not fire).',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.name',             label: 'Item name' },
      { path: 'data.checklist_id',     label: 'Checklist id' },
      { path: 'data.tag',              label: 'Checklist tag (e.g. docs_needed)' },
      { path: 'data.checklist_status', label: 'Parent status after recompute' },
    ],
  },
  'checklist.completed': {
    label: 'Checklist completed',
    description: 'Fires when a checklist transitions incomplete -> complete via an item status change or item deletion (the two mutation routes). Pairs with the docs pipeline: tag=docs_needed + all items complete is the natural docs-done signal.',
    fields: [
      ...COMMON_FIELDS,
      { path: 'data.checklist_id', label: 'Checklist id' },
      { path: 'data.title',        label: 'Checklist title' },
      { path: 'data.tag',          label: 'Checklist tag' },
      { path: 'data.link_type',    label: 'Link type' },
    ],
  },
};

// V2 event candidates (noted, deliberately not emitted yet): checklist.created,
// checkitem.created, checkitem.uncompleted, checklist.uncompleted (reopen
// transitions), event.* (eventService lifecycle — court v2 will define needs),
// contact.opted_out as a discrete event (covered today by contact.updated +
// changes.<field> exists).

const ACTION_TYPES = new Set(['workflow', 'sequence', 'internal_function', 'http', 'hook']);

// ─────────────────────────────────────────────────────────────
// RULE LOADING
// ─────────────────────────────────────────────────────────────

/**
 * Load active rules for one event type, with their active actions joined in.
 * Two queries (rules, then actions) — same rationale as the ingest service.
 * Rules ordered position ASC, id ASC; actions position ASC, id ASC per rule.
 */
async function listActiveRulesForEvent(db, eventType) {
  const [rules] = await db.query(
    `SELECT id, event_type, name, match_mode, match_config,
            transform_mode, transform_config
       FROM trigger_rules
      WHERE active = 1 AND event_type = ?
      ORDER BY position ASC, id ASC`,
    [eventType]
  );
  if (!rules.length) return [];

  const ruleIds = rules.map(r => r.id);
  const placeholders = ruleIds.map(() => '?').join(',');
  const [actions] = await db.query(
    `SELECT id, rule_id, name, action_type, config, position
       FROM trigger_rule_actions
      WHERE active = 1 AND rule_id IN (${placeholders})
      ORDER BY rule_id ASC, position ASC, id ASC`,
    ruleIds
  );

  const actionsByRule = new Map();
  for (const a of actions) {
    if (!actionsByRule.has(a.rule_id)) actionsByRule.set(a.rule_id, []);
    actionsByRule.get(a.rule_id).push(a);
  }
  for (const r of rules) r.actions = actionsByRule.get(r.id) || [];
  return rules;
}

// ─────────────────────────────────────────────────────────────
// MATCH EVALUATION  (semantics verbatim from emailIngestRuleService)
// ─────────────────────────────────────────────────────────────

function _evaluateMatch(rule, envelope) {
  let config = rule.match_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}): ` +
        `match_config is not parseable JSON — treating as non-match`
      );
      return false;
    }
  }

  if (rule.match_mode === 'conditions') {
    // NULL → non-match (NOT match-all) — hookFilter.evaluateConditions(null,…)
    // returns TRUE, which for an automation rule would silently fire on every
    // event. Explicit always-match = {operator:'and', conditions:[]}.
    if (config == null) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}): ` +
        `NULL match_config on conditions mode — treating as non-match. ` +
        `For an explicit always-match, use {operator:'and', conditions:[]}.`
      );
      return false;
    }
    try {
      return !!evaluateConditions(config, envelope);
    } catch (err) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}) conditions error: ${err.message}`
      );
      return false;
    }
  }

  if (rule.match_mode === 'code') {
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}): empty code on code mode — non-match`
      );
      return false;
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('input', code);
      return !!fn(envelope);
    } catch (err) {
      console.warn(
        `[triggerService] rule ${rule.id} (${rule.name}) code error: ${err.message}`
      );
      return false;
    }
  }

  console.warn(
    `[triggerService] rule ${rule.id} (${rule.name}): ` +
    `unknown match_mode '${rule.match_mode}' — treating as non-match`
  );
  return false;
}

// ─────────────────────────────────────────────────────────────
// TRANSFORM EVALUATION  (semantics verbatim from emailIngestRuleService)
// ─────────────────────────────────────────────────────────────

/**
 * @returns {{ ok:true, output:object } | { ok:false, error:string }}
 */
function _runTransform(rule, envelope) {
  const mode = rule.transform_mode || 'passthrough';

  if (mode === 'passthrough') {
    return { ok: true, output: envelope };
  }

  let config = rule.transform_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      return { ok: false, error: `transform_config is not parseable JSON: ${e.message}` };
    }
  }

  if (mode === 'mapper') {
    if (!Array.isArray(config)) {
      return { ok: false, error: `mapper transform_config must be an array of mapping rules` };
    }
    try {
      const { output, errors } = hookMapper.executeMapper(config, envelope);
      if (errors && errors.length) {
        console.warn(
          `[triggerService] rule ${rule.id} (${rule.name}) mapper warnings: ` + errors.join('; ')
        );
      }
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: `mapper transform threw: ${err.message}` };
    }
  }

  if (mode === 'code') {
    const code = typeof config === 'string' ? config : config?.code;
    if (!code) return { ok: false, error: `empty code on code transform mode` };
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('input', code);
      const output = fn(envelope);
      if (output == null || typeof output !== 'object') {
        return { ok: false, error: `code transform must return an object (got ${typeof output})` };
      }
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: `code transform threw: ${err.message}` };
    }
  }

  return { ok: false, error: `unknown transform_mode '${mode}'` };
}

// ─────────────────────────────────────────────────────────────
// TARGET SYNTHESIS / HOOK WRAP / RESULT NORMALIZATION
// (verbatim adaptations from emailIngestRuleService)
// ─────────────────────────────────────────────────────────────

function _synthesizeTarget(action) {
  const cfg = (action.config && typeof action.config === 'object') ? action.config : {};
  return {
    id:            action.id,
    url:           cfg.url || null,
    method:        cfg.method || 'POST',
    headers:       cfg.headers || {},
    body_mode:     cfg.body_mode || null,
    body_template: cfg.body_template || null,
    credential_id: cfg.credential_id || null,
  };
}

// Hook authors write filter/transform paths against the unified webhook shape
// { body, headers, query, method, meta } — wrap the transformed envelope as
// `body` so trigger-invoked hooks use the identical convention (same ruling
// as ingest Slice 2.3).
function _wrapForHook(transformedInput, rule, action) {
  return {
    body:    transformedInput,
    headers: {},
    query:   {},
    method:  'POST',
    meta: {
      source:         'trigger_rule',
      rule_id:        rule.id,
      rule_action_id: action.id,
      received_at:    new Date().toISOString(),
    },
  };
}

function _normalizeHookResult(hookRet) {
  const status = hookRet && hookRet.status;
  const execId = (hookRet && (hookRet.executionId ?? hookRet.execution_id)) ?? null;

  const SUCCESS = new Set(['delivered', 'filtered', 'captured']);
  const isSuccess = SUCCESS.has(status);

  const out = {
    status: isSuccess ? 'success' : 'failed',
    result: { hook_execution_id: execId, hook_status: status || null },
  };
  if (!isSuccess) {
    out.error = (hookRet && hookRet.error) || `hook returned status '${status || 'unknown'}'`;
  }
  return out;
}

function _extractActionResult(actionType, logData) {
  if (!logData || typeof logData !== 'object') return null;

  let body = null;
  if (typeof logData.response_body === 'string' && logData.response_body) {
    try { body = JSON.parse(logData.response_body); } catch { body = null; }
  }

  switch (actionType) {
    case 'workflow':
      return {
        workflow_execution_id: body?.executionId ?? null,
        workflow_id:           body?.workflowId ?? null,
      };
    case 'sequence':
      return { enrollment_id: body?.enrollmentId ?? body?.enrollment_id ?? null };
    case 'internal_function': {
      // Surface advance_stage-style outputs compactly for the executions view.
      const out = { response_status: logData.response_status ?? null };
      if (body && body.output && typeof body.output === 'object') out.output = body.output;
      return out;
    }
    case 'http':
      return { response_status: logData.response_status ?? null };
    default:
      return { response_status: logData.response_status ?? null };
  }
}

// ─────────────────────────────────────────────────────────────
// METRICS BUMP (fire-and-forget)
// ─────────────────────────────────────────────────────────────

async function _bumpMetrics(db, ruleIds) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return;
  const placeholders = ruleIds.map(() => '?').join(',');
  await db.query(
    `UPDATE trigger_rules
        SET match_count = match_count + 1, last_matched_at = NOW()
      WHERE id IN (${placeholders})`,
    ruleIds
  );
}

// ─────────────────────────────────────────────────────────────
// ACTION DISPATCH — never throws; failures captured into the outcome.
// ─────────────────────────────────────────────────────────────

async function _dispatchAction(db, rule, action, transformedInput) {
  const base = {
    rule_id:        rule.id,
    rule_action_id: action.id,
    action_type:    action.action_type,
  };

  let config = action.config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      return { ...base, status: 'failed', error: `config not parseable JSON: ${e.message}` };
    }
  }
  if (config == null || typeof config !== 'object') config = {};

  try {
    if (action.action_type === 'hook') {
      // Lazy require — hookService transitively reaches delivery engines.
      const hookService = require('./hookService');
      const slug = config.slug;
      if (!slug) {
        return { ...base, status: 'failed', error: `hook action missing config.slug` };
      }
      const wrapped = _wrapForHook(transformedInput, rule, action);
      const hookRet = await hookService.executeHook(db, slug, wrapped);
      const norm = _normalizeHookResult(hookRet);
      return { ...base, status: norm.status, ...(norm.error ? { error: norm.error } : {}), result: norm.result };
    }

    const target = _synthesizeTarget({ ...action, config });
    const ret = await actionDispatchers.dispatch(
      db,
      action.action_type,
      config,
      transformedInput,
      {
        target,
        source:         'trigger_rule',
        rule_id:        rule.id,
        rule_action_id: action.id,
      }
    );
    return {
      ...base,
      status: ret.status === 'success' ? 'success' : 'failed',
      ...(ret.error ? { error: ret.error } : {}),
      result: _extractActionResult(action.action_type, ret.result),
    };
  } catch (err) {
    return { ...base, status: 'failed', error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// EXECUTION LOG
// ─────────────────────────────────────────────────────────────

async function _insertExecution(db, envelope, { status, rulesMatched = 0, outcomes = null, error = null }) {
  try {
    await db.query(
      `INSERT INTO trigger_executions
         (event_type, contact_id, case_id, depth, status, rules_matched, outcomes, envelope, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        envelope.event,
        envelope.contact_id ?? null,
        envelope.case_id ?? null,
        envelope.depth ?? 0,
        status,
        rulesMatched,
        outcomes ? JSON.stringify(outcomes) : null,
        JSON.stringify(envelope),
        error,
      ]
    );
  } catch (err) {
    // Never let audit failure disturb anything upstream.
    console.error(`[triggerService] execution log insert failed (${envelope.event}):`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ORCHESTRATOR — called by domainEvents.emit (fire-and-forget path)
// ─────────────────────────────────────────────────────────────

/**
 * Process one domain event: depth-cap check → load rules for the event type →
 * match → transform → dispatch actions → execution row + metrics.
 *
 * May throw only on truly unexpected engine errors; domainEvents.emit catches
 * and alerts. Per-rule / per-action failures never throw out of here.
 */
async function processEvent(db, envelope) {
  // Depth cap — the loop-guard backstop.
  if ((envelope.depth ?? 0) >= domainEvents.MAX_DEPTH) {
    console.warn(
      `[triggerService] DEPTH CAP: dropping ${envelope.event} at depth ${envelope.depth} ` +
      `(chain: ${JSON.stringify(envelope.chain)})`
    );
    await _insertExecution(db, envelope, {
      status: 'depth_capped',
      error:  `depth ${envelope.depth} >= MAX_DEPTH ${domainEvents.MAX_DEPTH}; chain ${JSON.stringify(envelope.chain)}`,
    });
    try {
      const { alert } = require('../lib/alerting');
      alert(db, {
        source: 'app', kind: 'trigger_depth_capped', severity: 'warning',
        group_key: 'trigger_depth',
        title: `Trigger chain depth cap hit on ${envelope.event}`,
        message: `Likely a rule loop. Chain: ${JSON.stringify(envelope.chain)}`,
        context: { event: envelope.event, chain: envelope.chain },
      }).catch(() => {});
    } catch (_) {}
    return { status: 'depth_capped' };
  }

  let rules;
  try {
    rules = await listActiveRulesForEvent(db, envelope.event);
  } catch (err) {
    await _insertExecution(db, envelope, { status: 'error', error: `rule load failed: ${err.message}` });
    throw err;
  }

  if (!rules.length) {
    await _insertExecution(db, envelope, { status: 'no_rules' });
    return { status: 'no_rules' };
  }

  const matchedRuleIds = [];
  const actionOutcomes = [];
  const warnings       = [];

  for (const rule of rules) {
    if (!_evaluateMatch(rule, envelope)) continue;

    // Matched (regardless of transform/action outcomes) — same contract as
    // the ingest service: matched reflects MATCH.
    matchedRuleIds.push(rule.id);

    const tr = _runTransform(rule, envelope);
    if (!tr.ok) {
      const w = `rule ${rule.id} (${rule.name}) transform failed: ${tr.error} — actions skipped`;
      console.warn(`[triggerService] ${w}`);
      warnings.push(w);
      continue;
    }

    for (const action of rule.actions) {
      // ALS child scope: any emit() reached through this action's side
      // effects carries depth+1 and this rule on the chain.
      const outcome = await domainEvents.runAsAction(rule.id, () =>
        _dispatchAction(db, rule, action, tr.output)
      );
      actionOutcomes.push(outcome);
    }
  }

  const status = matchedRuleIds.length ? 'matched' : 'no_match';

  await _insertExecution(db, envelope, {
    status,
    rulesMatched: matchedRuleIds.length,
    outcomes: {
      matched_rule_ids: matchedRuleIds,
      action_outcomes:  actionOutcomes,
      ...(warnings.length ? { warnings } : {}),
    },
  });

  if (matchedRuleIds.length) {
    _bumpMetrics(db, matchedRuleIds)
      .catch(err => console.error('[triggerService] metrics bump failed:', err.message));
  }

  return { status, matchedRuleIds, actionOutcomes, warnings };
}

// ─────────────────────────────────────────────────────────────
// DRY RUN — match + transform only; NOTHING dispatches, no execution row,
// no metrics. Backs POST /api/triggers/test.
// ─────────────────────────────────────────────────────────────

async function evaluateDryRun(db, envelope) {
  const rules = await listActiveRulesForEvent(db, envelope.event);
  const report = [];

  for (const rule of rules) {
    const entry = {
      rule_id: rule.id,
      name:    rule.name,
      matched: _evaluateMatch(rule, envelope),
    };
    if (entry.matched) {
      const tr = _runTransform(rule, envelope);
      entry.transform_ok = tr.ok;
      if (!tr.ok) {
        entry.transform_error = tr.error;
      } else {
        entry.transformed = tr.output;
        entry.would_fire = rule.actions.map(a => ({
          rule_action_id: a.id,
          name:           a.name,
          action_type:    a.action_type,
        }));
      }
    }
    report.push(entry);
  }
  return { rules_evaluated: rules.length, report };
}

/**
 * Evaluate a DRAFT (unsaved) match+transform config against one envelope —
 * the ingest test-match precedent (Slice 10A) applied to triggers: the T2
 * editor tests its CURRENT state without saving. Pure function, no DB, no
 * dispatch, no rows.
 *
 * @param {{match_mode, match_config, transform_mode, transform_config}} draft
 * @param {object} envelope
 * @returns {{matched:boolean, transform_ok?:boolean, transformed?:object, transform_error?:string}}
 */
function evaluateDraft(draft, envelope) {
  const rule = {
    id: 0,
    name: '(draft)',
    match_mode:       draft.match_mode || 'conditions',
    match_config:     draft.match_config ?? null,
    transform_mode:   draft.transform_mode || 'passthrough',
    transform_config: draft.transform_config ?? null,
  };
  const out = { matched: _evaluateMatch(rule, envelope) };
  if (out.matched) {
    const tr = _runTransform(rule, envelope);
    out.transform_ok = tr.ok;
    if (tr.ok) out.transformed = tr.output;
    else out.transform_error = tr.error;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// CRUD — backs routes/api.triggers.js
// ─────────────────────────────────────────────────────────────

function _badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function _notFound(msg)   { const e = new Error(msg); e.status = 404; return e; }

function _validateRuleFields(fields, { partial = false } = {}) {
  if (!partial || fields.event_type !== undefined) {
    if (!fields.event_type || !EVENT_TYPES[fields.event_type]) {
      throw _badRequest(
        `event_type must be one of: ${Object.keys(EVENT_TYPES).join(', ')}`
      );
    }
  }
  if (!partial || fields.name !== undefined) {
    if (!fields.name || !String(fields.name).trim()) throw _badRequest('name is required');
  }
  if (fields.match_mode !== undefined && !['conditions', 'code'].includes(fields.match_mode)) {
    throw _badRequest(`match_mode must be 'conditions' or 'code'`);
  }
  if (fields.transform_mode !== undefined &&
      !['passthrough', 'mapper', 'code'].includes(fields.transform_mode)) {
    throw _badRequest(`transform_mode must be 'passthrough', 'mapper', or 'code'`);
  }
}

function _validateActions(actions) {
  if (!Array.isArray(actions)) throw _badRequest('actions must be an array');
  actions.forEach((a, i) => {
    if (!a || !ACTION_TYPES.has(a.action_type)) {
      throw _badRequest(
        `actions[${i}].action_type must be one of: ${[...ACTION_TYPES].join(', ')}`
      );
    }
    if (a.config == null || typeof a.config !== 'object') {
      throw _badRequest(`actions[${i}].config must be an object`);
    }
  });
}

async function listRules(db, { event_type = null } = {}) {
  const where = [];
  const params = [];
  if (event_type) { where.push('event_type = ?'); params.push(event_type); }
  const [rules] = await db.query(
    `SELECT * FROM trigger_rules
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY event_type ASC, position ASC, id ASC`,
    params
  );
  if (!rules.length) return rules;
  const ids = rules.map(r => r.id);
  const [actions] = await db.query(
    `SELECT * FROM trigger_rule_actions
      WHERE rule_id IN (${ids.map(() => '?').join(',')})
      ORDER BY rule_id ASC, position ASC, id ASC`,
    ids
  );
  const byRule = new Map();
  for (const a of actions) {
    if (!byRule.has(a.rule_id)) byRule.set(a.rule_id, []);
    byRule.get(a.rule_id).push(a);
  }
  for (const r of rules) r.actions = byRule.get(r.id) || [];
  return rules;
}

async function getRule(db, id) {
  const [[rule]] = await db.query(`SELECT * FROM trigger_rules WHERE id = ?`, [id]);
  if (!rule) throw _notFound(`trigger rule ${id} not found`);
  const [actions] = await db.query(
    `SELECT * FROM trigger_rule_actions WHERE rule_id = ? ORDER BY position ASC, id ASC`,
    [id]
  );
  rule.actions = actions;
  return rule;
}

/**
 * Create a rule (+ optional actions array in the same call).
 */
async function createRule(db, fields, { userId = null } = {}) {
  _validateRuleFields(fields);
  if (fields.actions !== undefined) _validateActions(fields.actions);

  const {
    event_type, name, description = null, active = 1, position = 0,
    match_mode = 'conditions', match_config = null,
    transform_mode = 'passthrough', transform_config = null,
    actions = [],
  } = fields;

  return db.withTransaction(async (conn) => {
    const [res] = await conn.query(
      `INSERT INTO trigger_rules
         (event_type, name, description, active, position, match_mode, match_config,
          transform_mode, transform_config, last_modified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event_type, String(name).trim(), description, active ? 1 : 0, position,
        match_mode, match_config == null ? null : JSON.stringify(match_config),
        transform_mode, transform_config == null ? null : JSON.stringify(transform_config),
        userId,
      ]
    );
    const ruleId = res.insertId;
    for (const [i, a] of actions.entries()) {
      await conn.query(
        `INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ruleId, a.name || null, a.position ?? i, a.active === false ? 0 : 1,
         a.action_type, JSON.stringify(a.config)]
      );
    }
    return ruleId;
  }).then(ruleId => getRule(db, ruleId));
}

/**
 * Partial update. If `actions` is present it REPLACES the rule's full action
 * set (delete-all + reinsert, transactional) — same "authoritative array"
 * semantics as the contact aggregate reconcilers, but simpler because
 * actions have no cross-table references.
 */
async function updateRule(db, id, fields, { userId = null } = {}) {
  await getRule(db, id); // 404 guard
  _validateRuleFields(fields, { partial: true });
  if (fields.actions !== undefined) _validateActions(fields.actions);

  const COLS = ['event_type', 'name', 'description', 'active', 'position',
                'match_mode', 'match_config', 'transform_mode', 'transform_config'];
  const JSON_COLS = new Set(['match_config', 'transform_config']);

  const sets = [];
  const vals = [];
  for (const c of COLS) {
    if (fields[c] === undefined) continue;
    sets.push(`\`${c}\` = ?`);
    if (JSON_COLS.has(c)) {
      vals.push(fields[c] == null ? null : JSON.stringify(fields[c]));
    } else if (c === 'active') {
      vals.push(fields[c] ? 1 : 0);
    } else {
      vals.push(fields[c]);
    }
  }
  sets.push('last_modified_by = ?');
  vals.push(userId);

  await db.withTransaction(async (conn) => {
    await conn.query(
      `UPDATE trigger_rules SET ${sets.join(', ')} WHERE id = ?`,
      [...vals, id]
    );
    if (fields.actions !== undefined) {
      await conn.query(`DELETE FROM trigger_rule_actions WHERE rule_id = ?`, [id]);
      for (const [i, a] of fields.actions.entries()) {
        await conn.query(
          `INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, a.name || null, a.position ?? i, a.active === false ? 0 : 1,
           a.action_type, JSON.stringify(a.config)]
        );
      }
    }
  });
  return getRule(db, id);
}

async function deleteRule(db, id) {
  await getRule(db, id); // 404 guard
  await db.withTransaction(async (conn) => {
    await conn.query(`DELETE FROM trigger_rule_actions WHERE rule_id = ?`, [id]);
    await conn.query(`DELETE FROM trigger_rules WHERE id = ?`, [id]);
  });
  return { deleted: true, id };
}

// ─────────────────────────────────────────────────────────────
// EXECUTIONS (read-only)
// ─────────────────────────────────────────────────────────────

async function listExecutions(db, {
  event_type = null, status = null, case_id = null, contact_id = null,
  limit = 50, before_id = null,
} = {}) {
  const where = [];
  const params = [];
  if (event_type) { where.push('event_type = ?'); params.push(event_type); }
  if (status)     { where.push('status = ?');     params.push(status); }
  if (case_id)    { where.push('case_id = ?');    params.push(String(case_id)); }
  if (contact_id) { where.push('contact_id = ?'); params.push(contact_id); }
  if (before_id)  { where.push('id < ?');         params.push(before_id); }

  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const [rows] = await db.query(
    `SELECT id, event_type, contact_id, case_id, depth, status, rules_matched,
            error, created_at
       FROM trigger_executions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ${lim}`,
    params
  );
  return rows;
}

async function getExecution(db, id) {
  const [[row]] = await db.query(`SELECT * FROM trigger_executions WHERE id = ?`, [id]);
  if (!row) throw _notFound(`execution ${id} not found`);
  return row;
}

/**
 * Recent envelopes for one event type — the T2 field-discovery/sample panel
 * source (mirrors the ingest UIs' sample blocks).
 */
async function listRecentEnvelopes(db, eventType, { limit = 10 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const [rows] = await db.query(
    `SELECT id, envelope, status, created_at
       FROM trigger_executions
      WHERE event_type = ?
      ORDER BY id DESC
      LIMIT ${lim}`,
    [eventType]
  );
  return rows;
}

module.exports = {
  EVENT_TYPES,
  processEvent,
  evaluateDryRun,
  evaluateDraft,
  listActiveRulesForEvent,
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  listExecutions,
  getExecution,
  listRecentEnvelopes,
};