// routes/workflows.js
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const {
  advanceWorkflow,
  executeSingleStep,
  resolvePlaceholders,
  resolveSingle,
  resolveExecutionContactId,
  InvalidContactIdError,
  captureWorkflowInput,
} = require("../lib/workflow_engine");
const { executeJob } = require("../lib/job_executor");
const { diffWorkflowSteps, validateWorkflowDraft } = require("../lib/versionDiff");
// JSON columns may come back from mysql2 as either a string (unparsed)
// or a parsed object depending on driver version/config. Normalize to a
// string for INSERT so mysql2 doesn't SET-expand objects.
const toJson = v => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));

// ─────────────────────────────────────────────────────────────
// Slice 2.1 — test_input validation helper.
//
// workflows.test_input is authorial documentation of the init_data shape a
// workflow expects. Nullable; no runtime validation against it at start
// time. At save time we only check shape: must be absent/null/undefined, or
// a plain JSON object (not an array, not a primitive).
//
// Returns null on success, or { status, error } on failure — caller handles
// res.status(...).json(...).
// ─────────────────────────────────────────────────────────────
function validateTestInput(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    return {
      status: 400,
      error: 'test_input must be a JSON object or null (arrays and primitives are not accepted)',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Branch-target remap — step-renumbering slice.
//
// Several internal functions carry LITERAL step numbers in their params:
//   evaluate_condition → params.then, params.else
//   set_next           → params.value
//   schedule_resume    → params.nextStep, params.skipToStep
//   wait_for           → params.nextStep, params.skipToStep
//   wait_until_time    → params.nextStep
//
// Historically, inserting/deleting/reordering steps renumbered
// workflow_steps.step_number but never touched these targets — so every
// renumbering op silently broke every branch and delay in the workflow.
// remapBranchTargets() runs inside the same transaction as the renumber
// and rewrites integer targets through an old→new mapping function.
//
// IMPORTANT: the param list is keyed by function_name because `value` is a
// TARGET for set_next but a COMPARISON OPERAND for evaluate_condition —
// a blind param-name rewrite would corrupt conditions.
//
// Non-integer targets are left untouched. Terminal sentinels ('end',
// 'cancel', 'fail', and the deprecated 'null') are skipped SILENTLY; anything
// else non-literal (templated strings, typos) is reported in warnings.
// custom_code that mentions next_step
// is flagged too (the engine's isControlStep whitelist ignores next_step
// from custom_code, but flag it so authors eyeball their intent).
//
// mapFn(oldStepNumber) → newStepNumber, or null when the target step was
// deleted (left as-is + warned; author must fix by hand).
// ─────────────────────────────────────────────────────────────
//
// FLAT SCALAR PARAMS ONLY. evaluate_condition's multi-branch form nests its
// targets in params.branches[].then — an ARRAY, which this loop can't consume.
// That form is walked separately below; `branches` must NOT be added here.
//
// STILL HAND-MAINTAINED, DELIBERATELY: this map is keyed by PARAM NAME, and
// those differ per function in ways no flag can express (see the `value`
// warning above), so unlike isControlStep() it can't be derived from __meta.
// The invariant that IS enforced: every function carrying __meta.controlFlow
// must appear here, asserted by tests/control.flow.test.js. Extra keys are
// fine (wait_until_time has targets but isn't a control step); missing ones
// break silently — a renumber leaves the target pointing at the old step.
const BRANCH_TARGET_PARAMS = {
  evaluate_condition: ['then', 'else'],
  set_next:           ['value'],
  schedule_resume:    ['nextStep', 'skipToStep'],
  wait_for:           ['nextStep', 'skipToStep'],
  wait_until_time:    ['nextStep'],
  // foreach.end_step is the loop's EXIT target (the body's loop-back is a
  // set_next, already covered by `value` above). Omitted until 2026-08, so
  // every renumber silently left a foreach exit pointing at the old number.
  foreach:            ['end_step'],
  // request_decision.nextStep is the resume target after response/timeout
  // (HITL slice, 2026-08). Note: decision_requests.resume_step on ALREADY-
  // PAUSED executions is a frozen copy and is NOT remapped here — renumbering
  // a workflow while a decision is pending leaves that execution resuming at
  // the old number (same exposure every delayed execution already has via
  // its scheduled workflow_resume job's nextStep).
  request_decision:   ['nextStep'],
};

// Terminal sentinels are legitimate non-numeric targets — a renumber must leave
// them alone SILENTLY, or every insert/delete on a workflow that ends a branch
// emits a spurious "not auto-remapped" warning. Mirrors the accepted set in
// lib/workflow_engine.normalizeNextStep(); 'null' is the deprecated alias kept
// for wf41-era configs. Keep the two lists in step — tests/control.flow.test.js
// asserts it.
const TERMINAL_SENTINELS = new Set(['end', 'cancel', 'fail', 'null']);
const isTerminalSentinel = v =>
  typeof v === 'string' && TERMINAL_SENTINELS.has(v.trim().toLowerCase());

async function remapBranchTargets(connection, workflowId, version, mapFn) {
  const [steps] = await connection.query(
    `SELECT id, step_number, type, config FROM workflow_steps WHERE workflow_id = ? AND version = ? ORDER BY step_number ASC`,
    [workflowId, version]
  );

  const rewritten = [];
  const warnings  = [];

  for (const row of steps) {
    let cfg;
    try {
      cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    } catch { continue; }
    if (!cfg || typeof cfg !== 'object') continue;

    if (row.type === 'custom_code') {
      if (typeof cfg.code === 'string' && cfg.code.includes('next_step')) {
        warnings.push(`step ${row.step_number}: custom_code mentions next_step — not auto-remapped, review manually`);
      }
      continue;
    }
    if (row.type !== 'internal_function') continue;

    const paramNames = BRANCH_TARGET_PARAMS[cfg.function_name];
    if (!paramNames || !cfg.params || typeof cfg.params !== 'object') continue;

    let changed = false;
    for (const p of paramNames) {
      const v = cfg.params[p];
      if (v === undefined || v === null) continue;

      // Accept integer or all-digits string; leave 'cancel'/'fail'/templates alone.
      let iv = null;
      if (Number.isInteger(v)) iv = v;
      else if (typeof v === 'string' && /^\d+$/.test(v)) iv = parseInt(v, 10);
      else {
        if (!isTerminalSentinel(v)) {
          warnings.push(`step ${row.step_number}: ${cfg.function_name}.${p} is non-literal (${JSON.stringify(v)}) — not auto-remapped`);
        }
        continue;
      }

      const nv = mapFn(iv);
      if (nv === null || nv === undefined) {
        warnings.push(`step ${row.step_number}: ${cfg.function_name}.${p} targeted a deleted step (${iv}) — left as-is, fix manually`);
        continue;
      }
      if (nv !== iv) {
        cfg.params[p] = nv;
        changed = true;
        rewritten.push(`step ${row.step_number}: ${cfg.function_name}.${p} ${iv}→${nv}`);
      }
    }

    // evaluate_condition multi-branch form: params.branches is an array of
    // {variable|conditions, …, then} objects. The scalar loop above cannot
    // reach those `then`s, so they went unremapped AND unwarned. Same value
    // contract as the flat params (integer / digit-string remapped;
    // 'cancel'/'fail' left silent; anything else warned). `else` is the flat
    // sibling and is already handled above. Kept as its own block rather than
    // folded into the loop so the existing scalar path is untouched.
    if (cfg.function_name === 'evaluate_condition' && Array.isArray(cfg.params.branches)) {
      for (let i = 0; i < cfg.params.branches.length; i++) {
        const br = cfg.params.branches[i];
        if (!br || typeof br !== 'object') continue;
        const bv = br.then;
        if (bv === undefined || bv === null) continue;

        let biv = null;
        if (Number.isInteger(bv)) biv = bv;
        else if (typeof bv === 'string' && /^\d+$/.test(bv)) biv = parseInt(bv, 10);
        else {
          if (!isTerminalSentinel(bv)) {
            warnings.push(`step ${row.step_number}: evaluate_condition.branches[${i}].then is non-literal (${JSON.stringify(bv)}) — not auto-remapped`);
          }
          continue;
        }

        const bnv = mapFn(biv);
        if (bnv === null || bnv === undefined) {
          warnings.push(`step ${row.step_number}: evaluate_condition.branches[${i}].then targeted a deleted step (${biv}) — left as-is, fix manually`);
          continue;
        }
        if (bnv !== biv) {
          br.then = bnv;
          changed = true;
          rewritten.push(`step ${row.step_number}: evaluate_condition.branches[${i}].then ${biv}→${bnv}`);
        }
      }
    }

    if (changed) {
      await connection.query(
        `UPDATE workflow_steps SET config = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(cfg), row.id]
      );
    }
  }

  return { rewritten, warnings };
}

// ─────────────────────────────────────────────────────────────
// Internal-function param validation — metadata-driven
//
// Save-time validation for the params block of an `internal_function` step.
// The full validator (phase-1 meta shape + phase-2 iso_datetime/duration
// parse-checks) lives in lib/internal_functions/index.js — relocated there
// in scheduled-jobs Slice 5 so routes/scheduled_jobs.js shares it. Same
// return contract: null on success, or { status, error } on failure.
// ─────────────────────────────────────────────────────────────

const internalFunctions = require("../lib/internal_functions");

const validateInternalFunctionParams = internalFunctions.__validateFunctionParams;

/**
 * Convenience wrapper: validates an `internal_function` step's config block.
 * Skips silently for non-`internal_function` step types (those preserve
 * existing permissive behavior).
 */
function validateInternalFunctionConfig(stepType, config) {
  if (stepType !== 'internal_function') return null;
  if (config == null || typeof config !== 'object') return null;
  return validateInternalFunctionParams(config.function_name, config.params);
}

// ─────────────────────────────────────────────────────────────
// Webhook step config validation — async because credential FK check.
//
// Mirrors routes/sequences.js validateStepConfig 'webhook' branch and
// routes/scheduled_jobs.js validateWebhookJobData. Single source of truth
// would be nice but each engine has different config shapes (sequences put
// it in action_config, workflows in step.config, scheduled jobs in job
// data) so the gathering differs even though the field-level rules are
// identical. Kept duplicated rather than abstracted for readability.
//
// Returns null on success, or { status, error } on failure.
// ─────────────────────────────────────────────────────────────

const ALLOWED_HTTP_METHODS_WF = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_TIMEOUT_MS_WF = 120000;

async function validateWebhookConfig(db, type, config) {
  if (type !== 'webhook') return null;
  if (config == null || typeof config !== 'object') return null;

  const { url, method, credential_id, headers, body, timeout_ms } = config;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { status: 400, error: 'webhook config.url is required (non-empty string)' };
  }
  // URL parse-check: skip if it has placeholders, since the universal resolver
  // runs at execution time (same pattern as sequence webhook validation).
  if (!/\{\{.*?\}\}/.test(url)) {
    try { new URL(url); }
    catch { return { status: 400, error: `webhook config.url is not a valid URL: ${url}` }; }
  }
  if (method !== undefined && method !== null && method !== '') {
    const m = String(method).toUpperCase();
    if (!ALLOWED_HTTP_METHODS_WF.includes(m)) {
      return { status: 400, error: `webhook config.method must be one of ${ALLOWED_HTTP_METHODS_WF.join(', ')}` };
    }
  }
  if (credential_id !== undefined && credential_id !== null && credential_id !== '') {
    const n = Number(credential_id);
    if (!Number.isInteger(n) || n <= 0) {
      return { status: 400, error: 'webhook config.credential_id must be a positive integer' };
    }
    const [[row]] = await db.query(`SELECT id FROM credentials WHERE id = ?`, [n]);
    if (!row) {
      return { status: 400, error: `webhook config.credential_id ${n} does not exist in credentials table` };
    }
  }
  if (headers !== undefined && headers !== null) {
    if (typeof headers !== 'object' || Array.isArray(headers)) {
      return { status: 400, error: 'webhook config.headers must be a JSON object' };
    }
  }
  // body intentionally permissive — object, array, string, number all OK
  if (timeout_ms !== undefined && timeout_ms !== null) {
    const n = Number(timeout_ms);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMEOUT_MS_WF) {
      return { status: 400, error: `webhook config.timeout_ms must be a positive integer <= ${MAX_TIMEOUT_MS_WF}` };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// start_workflow target validation — async because workflow FK check.
//
// Slice 6R. Mirrors the webhook credential_id existence-check precedent
// above and routes/sequences.js's start_workflow action_config check: when
// an internal_function step is `start_workflow` and params.workflow_id is
// a literal (placeholder-free) value, verify the target workflow exists at
// save time. Placeholder values skip the check (resolved at runtime — same
// convention as the URL parse-check). The __meta types workflow_id as
// 'string' (so the form renders a text input that can hold placeholders),
// which loses the meta validator's integer check — the numeric-shape check
// here recovers it for literal values.
//
// Active is NOT checked here: saving a step against a currently-inactive
// workflow is legitimate authoring order (build child, wire parent,
// activate child). The runtime function throws on inactive.
//
// Returns null on success, or { status, error } on failure.
// ─────────────────────────────────────────────────────────────

async function validateStartWorkflowConfig(db, type, config) {
  if (type !== 'internal_function') return null;
  if (config == null || typeof config !== 'object') return null;
  if (config.function_name !== 'start_workflow') return null;
  const params = config.params;
  if (params == null || typeof params !== 'object' || Array.isArray(params)) return null;

  const wid = params.workflow_id;
  // Absent/empty → the meta validator's `required` check already 400s;
  // don't double-report here.
  if (wid === undefined || wid === null || wid === '') return null;
  // Placeholder → runtime concern.
  if (typeof wid === 'string' && /\{\{.*?\}\}/.test(wid)) return null;

  const n = Number(wid);
  if (!Number.isInteger(n) || n <= 0) {
    return { status: 400, error: `start_workflow params.workflow_id must be a positive integer or {{placeholder}} (got ${JSON.stringify(wid)})` };
  }
  const [[row]] = await db.query(`SELECT id FROM workflows WHERE id = ?`, [n]);
  if (!row) {
    return { status: 400, error: `start_workflow params.workflow_id ${n} does not exist in workflows table` };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// GET /workflows/functions — list available internal functions
// Used by the workflow/sequence editors to populate dropdowns dynamically.
// The sequence list is META-DRIVEN: functions carrying __meta.workflowOnly
// are excluded (workflow control flow / timing / variable manipulation live
// in the engine; sequences have their own timing). Functions WITHOUT meta
// default to sequence-eligible. There is no hardcoded exclusion list —
// declare workflowOnly: true on the function's __meta instead.
// MUST be defined before any /:id routes to avoid param capture
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// ensureDraft — which version do the step-editing routes write? (S3)
//
// Lazy copy-on-first-write: the first edit after a publish copies the
// published version's step rows into a NEW draft version and points
// workflows.draft_version at it; every subsequent edit (this editor's
// save-per-step model is unchanged) lands on that draft. Published versions
// are therefore immutable BY CONSTRUCTION — nothing ever writes to a version
// number once current_version has pointed at it.
//
// MUST run inside the route's db.withTransaction (every workflow step-mutating
// route is wrapped — verified in the 2026-08-18 plan review, D1 table). The
// parent-row FOR UPDATE below is both the concurrency arbiter (two concurrent
// first-edits serialize; the second sees draft_version set and reuses it) and
// the LOCK-ORDERING INVARIANT: every transaction touching the version tables
// locks the parent workflows row FIRST, so publish/discard/ensureDraft cannot
// deadlock each other (withTransaction has no deadlock retry — deliberate).
//
// Draft numbering: MAX(workflow_versions.version) + 1, NOT current_version + 1
// — discarded drafts are RETIRED in place (rows kept, retired_at set), so
// retired versions occupy numbers. Returns null when the workflow does not
// exist (doubles as the existence check, as before).
// ─────────────────────────────────────────────────────────────
async function ensureDraft(connection, workflowId) {
  const [[wf]] = await connection.query(
    `SELECT current_version, draft_version FROM workflows WHERE id = ? FOR UPDATE`,
    [workflowId]
  );
  if (!wf) return null;
  if (wf.draft_version != null) return wf.draft_version;

  const [[mx]] = await connection.query(
    `SELECT COALESCE(MAX(version), 0) AS mx FROM workflow_versions WHERE workflow_id = ?`,
    [workflowId]
  );
  const draftVersion = Math.max(Number(mx.mx), Number(wf.current_version)) + 1;

  // Copy the published version's rows. For a never-published workflow
  // (current_version = 0) this copies nothing → an empty draft, correct.
  await connection.query(
    `INSERT INTO workflow_steps (workflow_id, version, step_number, label, note, type, config, error_policy)
     SELECT workflow_id, ?, step_number, label, note, type, config, error_policy
       FROM workflow_steps
      WHERE workflow_id = ? AND version = ?`,
    [draftVersion, workflowId, wf.current_version]
  );

  // Draft metadata stub — published_at stays NULL until publish.
  await connection.query(
    `INSERT INTO workflow_versions (workflow_id, version, name, description, test_input)
     SELECT id, ?, name, description, test_input FROM workflows WHERE id = ?`,
    [draftVersion, workflowId]
  );

  await connection.query(
    `UPDATE workflows SET draft_version = ?, updated_at = NOW() WHERE id = ?`,
    [draftVersion, workflowId]
  );

  return draftVersion;
}

router.get('/workflows/functions', jwtOrApiKey, (req, res) => {
  // Filter out the __-prefixed helpers (validateParamsAgainstMeta, getMeta, getAllMeta)
  // added alongside the metadata registry — those aren't callable functions.
  const meta = internalFunctions.__getAllMeta();
  const allFunctions = Object.keys(internalFunctions).filter(
    name => typeof internalFunctions[name] === 'function' && !name.startsWith('__')
  );
  res.json({
    success: true,
    workflow: allFunctions,
    sequence: allFunctions.filter(f => !(meta[f] && meta[f].workflowOnly)),
    meta,
  });
});

/**
 * POST /workflows/:id/start
 * Starts a new execution of the workflow.
 *
 * Body shapes accepted:
 *   1. Wrapped:  { init_data: { ... }, contact_id?: N }
 *               ─ initData = body.init_data (or body.initData)
 *               ─ body.contact_id at TOP LEVEL is the explicit contact-id
 *                 override (Slice 4.3 Part B). Only honored in wrapped form;
 *                 see (2) for why.
 *   2. Flat:     { contactName: "...", anyOtherField: ... }
 *               ─ the entire body IS the init_data (backward-compat shape).
 *               ─ contact_id is NOT extracted from flat bodies — doing so
 *                 would silently strip it from init_data for legacy callers.
 *                 Flat callers can still contact-tie via the template's
 *                 `default_contact_id_from` (set on the workflow row).
 *
 * contact_id precedence (handled by resolveExecutionContactId):
 *   explicit wrapped body.contact_id > workflow.default_contact_id_from > NULL
 *
 * Returns the new execution ID and kicks off advanceWorkflow in the background.
 */
router.post("/workflows/:id/start", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  // Detect wrapped body. A body with either `init_data` or `initData` at the
  // top level is treated as wrapped; the rest of the top-level keys are
  // out-of-band (and only `contact_id` is interpreted there).
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const isWrapped = Object.prototype.hasOwnProperty.call(body, 'init_data') ||
                    Object.prototype.hasOwnProperty.call(body, 'initData');

  const initData = isWrapped
    ? (body.init_data || body.initData || {})
    : body;

  // Explicit contact_id override — wrapped-body only. Flat bodies never
  // produce an explicit override; they can still be contact-tied via the
  // template default.
  const explicitContactId = isWrapped ? body.contact_id : undefined;

  // Versioning (S3): the editor's Run button targets the DRAFT (decision 6 —
  // authors iterate on the draft and test-run it before publishing). Honored
  // via ?use_draft=1 (query param — orthogonal to the flat-body convention,
  // where every top-level body key is init_data content) or, on wrapped
  // bodies only, use_draft: true.
  const useDraft = req.query.use_draft === '1' || req.query.use_draft === 'true' ||
                   (isWrapped && body.use_draft === true);

  console.log(`[START] Received payload (wrapped=${isWrapped}):`, JSON.stringify(initData, null, 2));

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Load id + default_contact_id_from in one shot. Adding the column to the
    // SELECT is cheap; skipping it would force a separate round-trip.
    const [wfRows] = await connection.query(
      `SELECT id, active, default_contact_id_from, capture_mode, current_version, draft_version FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }
    const workflow = wfRows[0];

    // Inactive workflows cannot be started — manual or otherwise. Toggle the
    // workflow active in the editor first.
    if (!workflow.active) {
      return { respond: { status: 409, body: { error: "Workflow is inactive", message: "Activate the workflow before starting it." } } };
    }

    // Versioning (S3): resolve which version this run pins to.
    //   use_draft → the draft (editor test-runs); 409 if none exists.
    //   otherwise → the published current_version; 0 (never published) is
    //   refused loudly — the pre-versioning behavior was a silent zero-step
    //   execution marked 'completed' (review D4).
    let runVersion;
    if (useDraft) {
      if (workflow.draft_version == null) {
        return { respond: { status: 409, body: { error: "No draft to run", message: "This workflow has no unpublished draft. Run the published version, or edit a step to start a draft." } } };
      }
      runVersion = workflow.draft_version;
    } else {
      if (!workflow.current_version) {
        return { respond: { status: 409, body: { error: "Workflow has never been published", message: "Publish the workflow before starting it (or use use_draft to test the draft)." } } };
      }
      runVersion = workflow.current_version;
    }

    // Capture slice — one-shot capture of init_data when armed. Guarded
    // UPDATE inside captureWorkflowInput makes this race-free across the
    // four execution-creation sites (Cookbook §5.21).
    if (workflow.capture_mode === 'capturing') {
      await captureWorkflowInput(connection, workflowId, initData);
    }

    // Resolve contact_id via the shared helper. Throws on invalid explicit
    // override; we translate to a 400 below.
    let contactId;
    try {
      contactId = resolveExecutionContactId({
        explicitContactId,
        initData,
        defaultKey: workflow.default_contact_id_from,
      });
    } catch (e) {
      if (e instanceof InvalidContactIdError) {
        return { respond: { status: 400, body: { error: "Invalid contact_id", message: e.message } } };
      }
      throw e;
    }

    const [result] = await connection.query(
      `
      INSERT INTO workflow_executions
      (workflow_id, contact_id, status, init_data, variables, current_step_number, workflow_version)
      VALUES (?, ?, 'active', ?, ?, 1, ?)
      `,
      [workflowId, contactId, JSON.stringify(initData), JSON.stringify(initData), runVersion]
    );

      return { executionId: result.insertId, contactId };
    });

    if (outcome.respond) {
      return res.status(outcome.respond.status).json(outcome.respond.body);
    }

    const { executionId, contactId } = outcome;

    res.status(202).json({
      success: true,
      executionId,
      workflowId,
      contactId,     // echo back so callers can verify the resolved value
      status: "processing",
      message: "Workflow execution started and is now processing"
    });

    // Background advance — no timeout needed; recoverStuckJobs handles hangs
    (async () => {
      try {
        const advanceResult = await advanceWorkflow(executionId, db);
        console.log(`[ASYNC ADVANCE] Completed: ${advanceResult.status}`);
      } catch (err) {
        console.error(`[ASYNC ADVANCE] Failed for execution ${executionId}:`, err.message);
      }
    })();

  } catch (err) {
    console.error(`[START] Failed:`, err);
    res.status(500).json({ error: "Failed to start workflow", message: err.message });
  }
});



// routes/workflows.js (add to existing router)
router.get("/executions", jwtOrApiKey, async (req, res) => {
  const db = req.db;

  // Query params with defaults
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const status = req.query.status || null;
  const workflowId = req.query.workflow_id ? parseInt(req.query.workflow_id) : null;
  const search = req.query.search || null; // basic text search on name/variables

  try {
    let query = `
      SELECT 
        e.id, e.workflow_id, w.name as workflow_name, e.status, 
        e.current_step_number, e.steps_executed_count,
        e.created_at, e.updated_at, e.completed_at,
        JSON_LENGTH(e.variables) as variable_count
      FROM workflow_executions e
      LEFT JOIN workflows w ON e.workflow_id = w.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND e.status = ?`;
      params.push(status);
    }
    if (workflowId) {
      query += ` AND e.workflow_id = ?`;
      params.push(workflowId);
    }
    if (search) {
      query += ` AND (w.name LIKE ? OR JSON_SEARCH(e.variables, 'one', ?) IS NOT NULL)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY e.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(query, params);

    // Total count for pagination — must include the JOIN when search is active
    // because the WHERE clause references w.name
    const [countRows] = await db.query(
      `SELECT COUNT(*) as total FROM workflow_executions e` +
      (search ? ` LEFT JOIN workflows w ON e.workflow_id = w.id` : '') +
      ` WHERE 1=1` +
      (status ? ` AND e.status = ?` : '') +
      (workflowId ? ` AND e.workflow_id = ?` : '') +
      (search ? ` AND (w.name LIKE ? OR JSON_SEARCH(e.variables, 'one', ?) IS NOT NULL)` : ''),
      params.slice(0, -2) // exclude limit/offset
    );

    const total = countRows[0].total;

    // Flat envelope: { success, executions, total }. Matches the per-workflow
    // sibling (`GET /workflows/:id/executions`) and every cross-engine list
    // endpoint added since. Grep of the frontend (workflows.html, contact.html,
    // automationManager.html sub-pages) turned up no consumer of the prior
    // `pagination: { page, limit, total, totalPages }` envelope — the single
    // live caller (`workflows.html` executions tab) hits the per-workflow
    // sibling, not this one. See Cookbook §3.9.
    res.json({
      success: true,
      executions: rows,
      total,
    });
  } catch (err) {
    console.error("[GET EXECUTIONS] Failed:", err);
    res.status(500).json({ error: "Failed to list executions", message: err.message });
  }
});




router.get("/executions/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const includeHistory = req.query.history === "true";

  const executionId = parseInt(id, 10);
  if (isNaN(executionId) || executionId <= 0) {
    return res.status(400).json({ error: "Invalid execution ID" });
  }

  try {
    // Execution details
    const [execRows] = await db.query(
      `
      SELECT 
        e.*, w.name as workflow_name
      FROM workflow_executions e
      LEFT JOIN workflows w ON e.workflow_id = w.id
      WHERE e.id = ?
      `,
      [executionId]
    );

    if (execRows.length === 0) {
      return res.status(404).json({ error: "Execution not found" });
    }

    const execution = execRows[0];

    // Optional: full step history
    let history = null;
    if (includeHistory) {
      // LEFT JOIN: steps can be deleted after execution — ws.* is NULL then,
      // and the step_label fallback chain below handles it.
      const [historyRows] = await db.query(
        `
        SELECT h.*,
               ws.type   AS step_type,
               ws.config AS step_config_current
        FROM workflow_execution_steps h
        LEFT JOIN workflow_steps ws ON ws.id = h.step_id
        WHERE h.workflow_execution_id = ?
        ORDER BY h.executed_at ASC
        `,
        [executionId]
      );

      // string → try JSON.parse (mysql2 may already hand back objects for JSON columns)
      const tryParse = (v) => {
        if (typeof v !== 'string') return v;
        try { return JSON.parse(v); } catch { return v; }
      };

      history = historyRows.map(row => {
        if (row.output_data) row.output_data = tryParse(row.output_data);
        if (row.resolved_config) row.resolved_config = tryParse(row.resolved_config);

        // step_label: prefer the as-run function_name (exact), else the current
        // step config's function_name (may have been edited since the run),
        // else the step type, else null. step_label_source lets the UI caveat
        // the current_config case.
        const currentCfg = tryParse(row.step_config_current);
        let stepLabel = null;
        let labelSource = null;
        if (row.resolved_config && typeof row.resolved_config === 'object' && row.resolved_config.function_name) {
          stepLabel = row.resolved_config.function_name;
          labelSource = 'as_run';
        } else if (currentCfg && typeof currentCfg === 'object' && currentCfg.function_name) {
          stepLabel = currentCfg.function_name;
          labelSource = 'current_config';
        } else if (row.step_type) {
          stepLabel = row.step_type;
          labelSource = 'type';
        }
        row.step_label = stepLabel;
        row.step_label_source = labelSource;

        // Don't ship the full current config — it's not what ran and bloats
        // the payload. step_label already extracted what we need from it.
        delete row.step_config_current;

        return row;
      });
    }

    res.json({
      success: true,
      execution,
      history: includeHistory ? history : undefined
    });
  } catch (err) {
    console.error("[GET EXECUTION] Failed:", err);
    res.status(500).json({ error: "Failed to fetch execution", message: err.message });
  }
});



/**
 * GET /workflows/:id/executions
 * List all executions for a specific workflow
 * Query params (optional):
 *   - limit: number (default 50, max 200)
 *   - offset: number (default 0)  — preferred for paging; if omitted, derived from `page`
 *   - page: number (default 1)    — legacy; offset wins when present
 *   - status: string (e.g. active, completed, failed)
 *   - sort: string (created_at:desc or created_at:asc)
 * Response: { success, executions, total }
 */
router.get("/workflows/:id/executions", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
 
  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
 
  // Accept either ?limit/?offset (Slice 1 frontend idiom) or legacy ?page/?limit.
  // If ?offset is passed, it wins; otherwise derive offset from ?page.
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const offset = req.query.offset !== undefined
    ? Math.max(0, parseInt(req.query.offset) || 0)
    : (page - 1) * limit;
 
  const statusFilter = req.query.status || null;
  const sort = req.query.sort === 'created_at:asc' ? 'ASC' : 'DESC';
 
  try {
    let query = `
      SELECT 
        e.id,
        e.status,
        e.current_step_number,
        e.steps_executed_count,
        e.created_at,
        e.updated_at,
        e.completed_at,
        JSON_LENGTH(e.variables) as variable_count,
        (SELECT COUNT(*) 
         FROM workflow_execution_steps s 
         WHERE s.workflow_execution_id = e.id AND s.status = 'failed') as failed_steps
      FROM workflow_executions e
      WHERE e.workflow_id = ?
    `;
    const params = [workflowId];
    if (statusFilter) { query += ` AND e.status = ?`; params.push(statusFilter); }
    query += ` ORDER BY e.created_at ${sort} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const [rows] = await db.query(query, params);
 
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM workflow_executions e 
      WHERE e.workflow_id = ?
      ${statusFilter ? 'AND e.status = ?' : ''}
    `;
    const countParams = [workflowId];
    if (statusFilter) countParams.push(statusFilter);
    const [countRows] = await db.query(countQuery, countParams);
    const total = countRows[0].total;
 
    // Flat envelope: { success, executions, total }.
    // Prior version nested { pagination: { total } } but the Slice 1 frontend
    // read data.total directly → always undefined → pagination permanently broken.
    // Docs (09-api-reference.md) already describe the flat shape. No other
    // caller of this endpoint was found in a grep of the codebase.
    res.json({
      success: true,
      executions: rows.map(row => ({
        ...row,
        status_summary: row.status.startsWith('completed')
          ? (row.failed_steps > 0 ? 'completed_with_errors' : 'completed')
          : row.status
      })),
      total,
    });
  } catch (err) {
    console.error("[GET WORKFLOW EXECUTIONS] Failed:", err);
    res.status(500).json({ error: "Failed to fetch executions", message: err.message });
  }
});


/**
 * GET /workflows
 * List all workflow templates
 * Query params (optional):
 *   - page: number (default 1)
 *   - limit: number (default 20, max 100)
 *   - search: string (filter by name or description)
 *   - sort: string (name:asc, name:desc, created_at:desc, created_at:asc)
 */
router.get("/workflows", jwtOrApiKey, async (req, res) => {
  const db = req.db;

  // Query params with defaults
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const search = req.query.search || null;
  const sortField = req.query.sort?.split(':')[0] || 'created_at';
  const sortDir = req.query.sort?.split(':')[1]?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  // Optional active filter. When `active=true` is passed, only active workflows
  // are returned; `active=false` returns only inactive. Omitted → all.
  // The frontend's "show inactive" toggle (default off) passes active=true.
  const activeFilter = req.query.active === undefined
    ? null
    : (req.query.active === 'true' ? 1 : 0);

  // Valid sort fields to prevent injection
  const validSortFields = ['name', 'created_at', 'id'];
  const sort = validSortFields.includes(sortField) ? sortField : 'created_at';

  try {
    let query = `
      SELECT 
        id, name, description, active, test_input, capture_mode, captured_at, created_at, updated_at,
        current_version, draft_version,
        (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND version = COALESCE(w.draft_version, w.current_version)) as step_count
      FROM workflows w
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (name LIKE ? OR description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
    if (activeFilter !== null) {
      query += ` AND active = ?`;
      params.push(activeFilter);
    }

    query += ` ORDER BY ${sort} ${sortDir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(query, params);

    // Total count for pagination — mirror the same WHERE filters.
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM workflows w
      WHERE 1=1
    `;
    const countParams = [];
    if (search) {
      countQuery += ` AND (name LIKE ? OR description LIKE ?)`;
      countParams.push(`%${search}%`, `%${search}%`);
    }
    if (activeFilter !== null) {
      countQuery += ` AND active = ?`;
      countParams.push(activeFilter);
    }
    const [countRows] = await db.query(countQuery, countParams);
    const total = countRows[0].total;

    res.json({
      success: true,
      workflows: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: offset + limit < total,
        hasPrev: page > 1
      }
    });
  } catch (err) {
    console.error("[GET WORKFLOWS] Failed:", err);
    res.status(500).json({ error: "Failed to list workflows", message: err.message });
  }
});


/**
 * GET /workflows/:id
 * Get details of a single workflow template including its steps
 * Query params (optional):
 *   - includeSteps: boolean (default true) - whether to include full step list
 */
router.get("/workflows/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const includeSteps = req.query.includeSteps !== "false"; // default true

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    // Workflow metadata
    const [wfRows] = await db.query(
      `
      SELECT 
        id, name, description, active, test_input, capture_mode, captured_at, created_at, updated_at,
        current_version, draft_version,
        (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND version = COALESCE(w.draft_version, w.current_version)) as step_count,
        -- Renumber-safety slice — the editor warns before a reorder/delete on a
        -- workflow that has executions mid-flight. Those carry RAW STEP NUMBERS
        -- (workflow_executions.current_step_number, and scheduled_jobs.data.nextStep
        -- on a pending workflow_resume), and remapBranchTargets does not touch
        -- either — it only rewrites workflow_steps.config. Uses idx_workflow_status.
        (SELECT COUNT(*) FROM workflow_executions
          WHERE workflow_id = w.id
            AND status IN ('active','processing','delayed','held','pending')) as in_flight_executions
      FROM workflows w
      WHERE id = ?
      `,
      [workflowId]
    );

    if (wfRows.length === 0) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const workflow = wfRows[0];

    // Optional: full steps list
    let steps = null;
    if (includeSteps) {
      const [stepRows] = await db.query(
        `
        SELECT 
          id, step_number, label, note, type, config, error_policy, created_at, updated_at
        FROM workflow_steps
        WHERE workflow_id = ? AND version = ?
        ORDER BY step_number ASC
        `,
        // Editor view: the draft when one exists, else the published version.
        [workflowId, workflow.draft_version ?? workflow.current_version]
      );

      steps = stepRows;
    }

    res.json({
      success: true,
      workflow,
      steps: includeSteps ? steps : undefined,
      // Versioning (S3): which version the steps above came from, and whether
      // it is an unpublished draft. current_version/draft_version ride on the
      // workflow row itself (S2).
      editing_version: workflow.draft_version ?? workflow.current_version,
      has_draft: workflow.draft_version != null
    });
  } catch (err) {
    console.error("[GET WORKFLOW] Failed:", err);
    res.status(500).json({ error: "Failed to fetch workflow", message: err.message });
  }
});




// ─────────────────────────────────────────────────────────────
// Versioning endpoints (S3, 2026-08) — draft lifecycle.
//
// The step-editing routes above create drafts implicitly (ensureDraft on
// first edit after a publish). These four routes are the rest of the
// lifecycle: inspect history, diff the draft, publish it, or retire it.
// ─────────────────────────────────────────────────────────────

// GET /workflows/:id/versions — version history.
// step_count is per-version; is_current / is_draft / retired flags let the
// editor render the timeline without re-deriving state.
router.get("/workflows/:id/versions", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const workflowId = parseInt(req.params.id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
  try {
    const [[wf]] = await db.query(
      `SELECT current_version, draft_version FROM workflows WHERE id = ?`, [workflowId]
    );
    if (!wf) return res.status(404).json({ error: "Workflow not found" });

    const [versions] = await db.query(
      `SELECT v.version, v.name, v.description, v.published_at, v.published_by,
              v.retired_at, v.created_at,
              (SELECT COUNT(*) FROM workflow_steps s WHERE s.workflow_id = v.workflow_id AND s.version = v.version) AS step_count
         FROM workflow_versions v
        WHERE v.workflow_id = ?
        ORDER BY v.version DESC`,
      [workflowId]
    );
    res.json({
      success: true,
      current_version: wf.current_version,
      draft_version: wf.draft_version,
      versions: versions.map((v) => ({
        ...v,
        is_current: v.version === wf.current_version,
        is_draft: v.version === wf.draft_version,
      })),
    });
  } catch (err) {
    console.error("[GET VERSIONS] Failed:", err);
    res.status(500).json({ error: "Failed to fetch versions", message: err.message });
  }
});

// GET /workflows/:id/draft-diff — draft vs published, classified.
//
// classification drives the publish modal (plan-v2 ruling O1):
//   content_only → the "also apply to N in-flight run(s)" checkbox is offered
//   structural   → the checkbox is DISABLED, structural_reasons rendered inline
//   identical    → publish is a no-op re-stamp (allowed; rarely useful)
// validation (ruling O5) rides along so the modal can show blockers before
// the author clicks Publish. in_flight lists the executions a migration
// would touch: pinned to the version being superseded, non-terminal.
router.get("/workflows/:id/draft-diff", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const workflowId = parseInt(req.params.id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
  try {
    const [[wf]] = await db.query(
      `SELECT current_version, draft_version FROM workflows WHERE id = ?`, [workflowId]
    );
    if (!wf) return res.status(404).json({ error: "Workflow not found" });
    if (wf.draft_version == null) {
      return res.json({ success: true, has_draft: false, current_version: wf.current_version });
    }

    const [currentSteps] = await db.query(
      `SELECT * FROM workflow_steps WHERE workflow_id = ? AND version = ? ORDER BY step_number ASC`,
      [workflowId, wf.current_version]
    );
    const [draftSteps] = await db.query(
      `SELECT * FROM workflow_steps WHERE workflow_id = ? AND version = ? ORDER BY step_number ASC`,
      [workflowId, wf.draft_version]
    );

    const diff = diffWorkflowSteps(currentSteps, draftSteps, { branchTargetParams: BRANCH_TARGET_PARAMS });
    const validation = validateWorkflowDraft(draftSteps, {
      branchTargetParams: BRANCH_TARGET_PARAMS,
      isTerminalSentinel,
    });

    const [inFlight] = await db.query(
      `SELECT id, status, current_step_number, contact_id, created_at
         FROM workflow_executions
        WHERE workflow_id = ? AND workflow_version = ? AND status IN ('active','delayed','held')
        ORDER BY id DESC`,
      [workflowId, wf.current_version]
    );

    res.json({
      success: true,
      has_draft: true,
      current_version: wf.current_version,
      draft_version: wf.draft_version,
      classification: diff.classification,
      changes: diff.changes,
      structural_reasons: diff.structural_reasons,
      validation,
      in_flight: { count: inFlight.length, executions: inFlight },
    });
  } catch (err) {
    console.error("[DRAFT DIFF] Failed:", err);
    res.status(500).json({ error: "Failed to diff draft", message: err.message });
  }
});

// POST /workflows/:id/publish — make the draft the published version.
// Body: { migrate_in_flight?: boolean }
//
// Single transaction, parent row locked FIRST (lock-ordering invariant —
// same order as ensureDraft/discard, so the three can never deadlock):
//   1. validate the draft (O5) — errors 400 with the full validation object
//   2. if migrate_in_flight: re-run the classifier INSIDE the tx and refuse
//      anything but content_only (fail-closed server-side — the UI checkbox
//      is convenience, not the gate)
//   3. stamp the version row published (+ refresh its metadata snapshot from
//      the live workflows row — name/description/test_input may have moved
//      since ensureDraft froze the stub)
//   4. flip current_version, clear draft_version
//   5. optional migration: one UPDATE over non-terminal executions pinned to
//      the superseded version ('processing' rows finish on the old version —
//      deterministic and fine; numbering is unchanged by construction)
router.post("/workflows/:id/publish", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const workflowId = parseInt(req.params.id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
  const migrateInFlight = req.body?.migrate_in_flight === true;
  const publishedBy = (req.auth?.username || req.auth?.key_label || 'api').slice(0, 100);

  try {
    const outcome = await db.withTransaction(async (connection) => {
      const [[wf]] = await connection.query(
        `SELECT current_version, draft_version FROM workflows WHERE id = ? FOR UPDATE`,
        [workflowId]
      );
      if (!wf) return { respond: { status: 404, body: { error: "Workflow not found" } } };
      if (wf.draft_version == null) {
        return { respond: { status: 409, body: { error: "No draft to publish", message: "There are no unpublished changes." } } };
      }
      const draftV = wf.draft_version;
      const oldV = wf.current_version;

      const [draftSteps] = await connection.query(
        `SELECT * FROM workflow_steps WHERE workflow_id = ? AND version = ? ORDER BY step_number ASC`,
        [workflowId, draftV]
      );
      const validation = validateWorkflowDraft(draftSteps, {
        branchTargetParams: BRANCH_TARGET_PARAMS,
        isTerminalSentinel,
      });
      if (validation.errors.length) {
        return { respond: { status: 400, body: { error: "Draft failed publish validation", validation } } };
      }

      let migratedCount = null;
      let classification = null;
      if (migrateInFlight) {
        const [currentSteps] = await connection.query(
          `SELECT * FROM workflow_steps WHERE workflow_id = ? AND version = ? ORDER BY step_number ASC`,
          [workflowId, oldV]
        );
        const diff = diffWorkflowSteps(currentSteps, draftSteps, { branchTargetParams: BRANCH_TARGET_PARAMS });
        classification = diff.classification;
        if (diff.classification === 'structural') {
          return { respond: { status: 409, body: {
            error: "Structural changes cannot migrate in-flight runs",
            message: "In-flight step pointers are step numbers; they survive only content-only publishes.",
            structural_reasons: diff.structural_reasons,
          } } };
        }
      }

      await connection.query(
        `UPDATE workflow_versions v
           JOIN workflows w ON w.id = v.workflow_id
            SET v.published_at = NOW(), v.published_by = ?,
                v.name = w.name, v.description = w.description, v.test_input = w.test_input
          WHERE v.workflow_id = ? AND v.version = ?`,
        [publishedBy, workflowId, draftV]
      );
      await connection.query(
        `UPDATE workflows SET current_version = ?, draft_version = NULL, updated_at = NOW() WHERE id = ?`,
        [draftV, workflowId]
      );

      if (migrateInFlight) {
        const [r] = await connection.query(
          `UPDATE workflow_executions
              SET workflow_version = ?
            WHERE workflow_id = ? AND workflow_version = ? AND status IN ('active','delayed','held')`,
          [draftV, workflowId, oldV]
        );
        migratedCount = r.affectedRows;
      }

      return { published_version: draftV, previous_version: oldV, migrated_count: migratedCount, classification, validation };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[PUBLISH] Workflow ${workflowId}: v${outcome.previous_version} → v${outcome.published_version}` +
      (outcome.migrated_count != null ? ` (migrated ${outcome.migrated_count} in-flight)` : ''));
    res.json({ success: true, ...outcome });
  } catch (err) {
    console.error("[PUBLISH] Failed:", err);
    res.status(500).json({ error: "Failed to publish", message: err.message });
  }
});

// POST /workflows/:id/discard-draft — retire the draft IN PLACE.
//
// Retire, not delete (plan-v2 ruling O2): the draft's step rows are kept so
// any draft test-run's execution history stays fully resolvable (step ids in
// workflow_execution_steps keep pointing at real rows). retired_at marks the
// version dead; ensureDraft numbers the next draft past it (MAX+1).
router.post("/workflows/:id/discard-draft", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const workflowId = parseInt(req.params.id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
  try {
    const outcome = await db.withTransaction(async (connection) => {
      const [[wf]] = await connection.query(
        `SELECT current_version, draft_version FROM workflows WHERE id = ? FOR UPDATE`,
        [workflowId]
      );
      if (!wf) return { respond: { status: 404, body: { error: "Workflow not found" } } };
      if (wf.draft_version == null) {
        return { respond: { status: 409, body: { error: "No draft to discard" } } };
      }
      await connection.query(
        `UPDATE workflow_versions SET retired_at = NOW() WHERE workflow_id = ? AND version = ?`,
        [workflowId, wf.draft_version]
      );
      await connection.query(
        `UPDATE workflows SET draft_version = NULL, updated_at = NOW() WHERE id = ?`,
        [workflowId]
      );
      return { retired_version: wf.draft_version, current_version: wf.current_version };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);
    console.log(`[DISCARD DRAFT] Workflow ${workflowId}: retired v${outcome.retired_version}`);
    res.json({ success: true, ...outcome });
  } catch (err) {
    console.error("[DISCARD DRAFT] Failed:", err);
    res.status(500).json({ error: "Failed to discard draft", message: err.message });
  }
});

/**
 * POST /workflows
 * Create a new workflow template
 * Body: { name: string, description?: string, test_input?: object|null }
 * Returns the new workflow ID + basic info
 *
 * Slice 2.1: `test_input` is authorial documentation of the init_data shape
 * this workflow expects. Nullable. Plain JSON object only — arrays/primitives
 * rejected with 400. Not validated at runtime against actual init_data.
 */
router.post("/workflows", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, description = "", test_input } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "Workflow name is required" });
  }

  // Slice 2.1 — test_input shape validation.
  {
    const v = validateTestInput(test_input);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  try {
    // Versioning (S3, review D4a): new workflows are born UNPUBLISHED —
    // current_version = 0 is the first-class "never published" state. Every
    // dispatch site refuses it with a clear error (instead of silently
    // creating a zero-step execution and marking it completed). The first
    // step edit lazily creates draft v1 (ensureDraft); publish makes it live.
    const [result] = await db.query(
      `
      INSERT INTO workflows (name, description, test_input, current_version)
      VALUES (?, ?, ?, 0)
      `,
      [name.trim(), description.trim(), toJson(test_input)]
    );

    const workflowId = result.insertId;

    console.log(`[CREATE WORKFLOW] Created workflow ${workflowId}: ${name}`);

    res.status(201).json({
      success: true,
      workflowId,
      name: name.trim(),
      description: description.trim(),
      message: "Workflow template created successfully"
    });
  } catch (err) {
    console.error("[CREATE WORKFLOW] Failed:", err);
    res.status(500).json({ 
      error: "Failed to create workflow", 
      message: err.message 
    });
  }
});




/**
 * POST /workflows/:id/steps
 * Add a new step to a workflow (at the end by default)
 * Body: { 
 *   stepNumber?: number (optional - if provided, inserts at that position and shifts others),
 *   type: "webhook" | "internal_function" | "custom_code",
 *   config: { ... },
 *   error_policy?: { strategy, max_retries, backoff_seconds }
 * }
 */
router.post("/workflows/:id/steps", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { stepNumber, type, config, error_policy = null, label = null, note = null } = req.body;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  if (!["webhook", "internal_function", "custom_code"].includes(type)) {
    return res.status(400).json({ error: "Invalid step type" });
  }
  if (!config || typeof config !== "object") {
    return res.status(400).json({ error: "config object is required" });
  }

  // Timing-extensions slice — validate wait_for / schedule_resume params
  {
    const v = validateInternalFunctionConfig(type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Webhook credential injection slice — validate URL, method, credential FK, timeout
  {
    const v = await validateWebhookConfig(db, type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Slice 6R — start_workflow target FK check (literal workflow_id only)
  {
    const v = await validateStartWorkflowConfig(db, type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Existence check + draft resolution in one — first edit after a publish
    // lazily forks the draft (see ensureDraft above).
    const editVersion = await ensureDraft(connection, workflowId);
    if (editVersion == null) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    let targetStep = stepNumber;

    // If stepNumber not provided → add at the end
    if (!targetStep) {
      const [maxRow] = await connection.query(
        `SELECT MAX(step_number) as max FROM workflow_steps WHERE workflow_id = ? AND version = ?`,
        [workflowId, editVersion]
      );
      targetStep = (maxRow[0].max || 0) + 1;
    }

    // Shift existing steps up if inserting in the middle.
    // Two-pass to avoid unique constraint collisions: first move all affected
    // steps to a safe temp range (+10000), then set their final positions.
    let remap = null;
    if (stepNumber) {
      await connection.query(
        `UPDATE workflow_steps 
         SET step_number = step_number + 10000 
         WHERE workflow_id = ? AND version = ? AND step_number >= ?`,
        [workflowId, editVersion, targetStep]
      );
      await connection.query(
        `UPDATE workflow_steps 
         SET step_number = step_number - 10000 + 1 
         WHERE workflow_id = ? AND version = ? AND step_number >= ?`,
        [workflowId, editVersion, targetStep + 10000]
      );

      // Branch-target remap slice — every literal target >= targetStep
      // moved up by one; rewrite configs to follow. Runs BEFORE the new
      // step's INSERT so the remap never touches the incoming config
      // (its targets, if any, are authored against POST-insert numbering).
      remap = await remapBranchTargets(connection, workflowId, editVersion, (n) => n >= targetStep ? n + 1 : n);
    }

    // Insert the new step
    await connection.query(
      `
      INSERT INTO workflow_steps 
      (workflow_id, version, step_number, label, note, type, config, error_policy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [workflowId, editVersion, targetStep,
       (typeof label === 'string' && label.trim()) ? label.trim().slice(0, 100) : null,
       (typeof note  === 'string' && note.trim())  ? note.trim()                : null,
       type, JSON.stringify(config), JSON.stringify(error_policy)]
    );

      return { targetStep, remap };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    res.status(201).json({
      success: true,
      workflowId,
      stepNumber: outcome.targetStep,
      type,
      ...(outcome.remap ? { remap: outcome.remap } : {}),
      message: `Step ${outcome.targetStep} added to workflow ${workflowId}`
    });
  } catch (err) {
    console.error("[ADD STEP] Failed:", err);
    res.status(500).json({ error: "Failed to add step", message: err.message });
  }
});





/**
 * POST /workflows/bulk
 * Create a workflow template and all steps in one transaction
 *
 * Slice 2.1: also accepts `test_input` (authorial init_data shape doc).
 */
router.post("/workflows/bulk", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { name, description = "", test_input, steps } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Workflow name is required" });
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: "At least one step is required" });
  }

  // Slice 2.1 — test_input shape validation.
  {
    const v = validateTestInput(test_input);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  // Validate all steps BEFORE opening a transaction — so bad input gets a
  // clean 400 rather than a rollback + 500.
  const VALID_TYPES = new Set(["webhook", "internal_function", "custom_code"]);
  const usedNumbers = new Set();
  const stepValues = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (!VALID_TYPES.has(step.type)) {
      return res.status(400).json({ error: `Invalid step type at index ${i}` });
    }

    if (!step.config || typeof step.config !== "object") {
      return res.status(400).json({ error: `Step ${i + 1} must contain a valid config object` });
    }

    // Timing-extensions slice — validate wait_for / schedule_resume params
    {
      const v = validateInternalFunctionConfig(step.type, step.config);
      if (v) return res.status(v.status).json({
        error: `Step ${i + 1}: ${v.error}`,
        message: v.message,
      });
    }

    // Webhook credential injection slice — validate URL, method, credential FK, timeout
    {
      const v = await validateWebhookConfig(db, step.type, step.config);
      if (v) return res.status(v.status).json({
        error: `Step ${i + 1}: ${v.error}`,
        message: v.message,
      });
    }

    // Slice 6R — start_workflow target FK check (literal workflow_id only)
    {
      const v = await validateStartWorkflowConfig(db, step.type, step.config);
      if (v) return res.status(v.status).json({
        error: `Step ${i + 1}: ${v.error}`,
        message: v.message,
      });
    }

    const stepNumber = step.stepNumber ?? (i + 1);

    if (usedNumbers.has(stepNumber)) {
      return res.status(400).json({ error: `Duplicate stepNumber: ${stepNumber}` });
    }

    usedNumbers.add(stepNumber);

    stepValues.push([
      null,           // workflow_id — filled in after INSERT below
      stepNumber,
      (typeof step.label === 'string' && step.label.trim()) ? step.label.trim().slice(0, 100) : null,
      (typeof step.note  === 'string' && step.note.trim())  ? step.note.trim()                : null,
      step.type,
      JSON.stringify(step.config),
      step.error_policy ? JSON.stringify(step.error_policy) : null
    ]);
  }

  try {
    const workflowId = await db.withTransaction(async (connection) => {

    // Versioning (S3, review D4a): imports land UNPUBLISHED — the workflow is
    // created at current_version = 0 with the imported steps as DRAFT v1.
    // Publishing (with its validation gate) is what makes an import runnable;
    // an import bypassing the publish boundary would defeat it.
    const [workflowResult] = await connection.query(
      `INSERT INTO workflows (name, description, test_input, current_version, draft_version) VALUES (?, ?, ?, 0, 1)`,
      [name.trim(), description.trim(), toJson(test_input)]
    );

    const workflowId = workflowResult.insertId;

    // Patch in the real workflowId now that we have it
    const rows = stepValues.map(row => [workflowId, 1, row[1], row[2], row[3], row[4], row[5], row[6]]);

    await connection.query(
      `
      INSERT INTO workflow_steps
      (workflow_id, version, step_number, label, note, type, config, error_policy)
      VALUES ?
      `,
      [rows]
    );

    // Draft metadata stub — published_at NULL until the author publishes.
    await connection.query(
      `INSERT INTO workflow_versions (workflow_id, version, name, description, test_input)
       VALUES (?, 1, ?, ?, ?)`,
      [workflowId, name.trim(), description.trim(), toJson(test_input)]
    );

      return workflowId;
    });

    console.log(`[WORKFLOW CREATED] id=${workflowId} steps=${steps.length}`);

    return res.status(201).json({
      success: true,
      workflowId,
      name: name.trim(),
      stepCount: steps.length
    });

  } catch (err) {
    console.error("[WORKFLOW BULK CREATE ERROR]", err);
    return res.status(500).json({
      error: "Failed to create workflow",
      message: err.message
    });
  }
});



/**
 * DELETE /workflows/:id
 * Delete a workflow template and ALL its steps
 * (Executions are kept for history)
 */
router.delete("/workflows/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Delete steps first (foreign key safety). Deliberately unversioned —
    // deleting the workflow removes EVERY version's rows (workflow_versions
    // follows via ON DELETE CASCADE). Audit class: ALL-VERSIONS.
    await connection.query(
      `DELETE FROM workflow_steps WHERE workflow_id = ?`,
      [workflowId]
    );

    // Delete workflow
    await connection.query(
      `DELETE FROM workflows WHERE id = ?`,
      [workflowId]
    );

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[DELETE WORKFLOW] Deleted workflow ${workflowId} and all steps`);

    res.json({
      success: true,
      message: `Workflow ${workflowId} and all its steps deleted`
    });
  } catch (err) {
    console.error("[DELETE WORKFLOW] Failed:", err);
    res.status(500).json({ error: "Failed to delete workflow", message: err.message });
  }
});




/**
 * DELETE /workflows/:id/steps/:stepNumber
 * Delete a specific step and automatically renumber all subsequent steps
 */
router.delete("/workflows/:id/steps/:stepNumber", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id, stepNumber } = req.params;

  const workflowId = parseInt(id, 10);
  const stepNum = parseInt(stepNumber, 10);

  if (isNaN(workflowId) || workflowId <= 0 || isNaN(stepNum) || stepNum <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID or step number" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Existence check + draft resolution in one — first edit after a publish
    // lazily forks the draft (see ensureDraft above).
    const editVersion = await ensureDraft(connection, workflowId);
    if (editVersion == null) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Verify step exists
    const [stepRows] = await connection.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND version = ? AND step_number = ?`,
      [workflowId, editVersion, stepNum]
    );
    if (stepRows.length === 0) {
      return { respond: { status: 404, body: { error: "Step not found" } } };
    }

    // Delete the step
    await connection.query(
      `DELETE FROM workflow_steps WHERE workflow_id = ? AND version = ? AND step_number = ?`,
      [workflowId, editVersion, stepNum]
    );

    // Renumber all higher steps down by 1.
    // ORDER BY ASC ensures MySQL processes lowest step first, so each
    // decrement lands in the slot just vacated — no unique constraint collision.
    await connection.query(
      `
      UPDATE workflow_steps 
      SET step_number = step_number - 1 
      WHERE workflow_id = ? AND version = ? AND step_number > ?
      ORDER BY step_number ASC
      `,
      [workflowId, editVersion, stepNum]
    );

    // Branch-target remap slice — targets above the deleted step slid down
    // by one; targets AT the deleted step are dangling (warned, left as-is).
    const remap = await remapBranchTargets(connection, workflowId, editVersion, (n) => {
      if (n === stepNum) return null;
      return n > stepNum ? n - 1 : n;
    });

      return { remap };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[DELETE STEP] Deleted step ${stepNum} from workflow ${workflowId} and renumbered`);

    res.json({
      success: true,
      remap: outcome.remap,
      message: `Step ${stepNum} deleted and subsequent steps renumbered`
    });
  } catch (err) {
    console.error("[DELETE STEP] Failed:", err);
    res.status(500).json({ error: "Failed to delete step", message: err.message });
  }
});



/**
 * PATCH /workflows/:id/steps/reorder
 * Reorder steps in a workflow
 * Two formats supported:
 * 1. Move single step: { "fromStep": 5, "toStep": 2 }
 * 2. Full new order: { "order": [3,1,4,2,5] }
 */
router.patch("/workflows/:id/steps/reorder", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { fromStep, toStep, order } = req.body;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Existence check + draft resolution in one — first edit after a publish
    // lazily forks the draft (see ensureDraft above).
    const editVersion = await ensureDraft(connection, workflowId);
    if (editVersion == null) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Branch-target remap slice — populated by whichever case runs below.
    let remapResult = null;

    // ────────────────────────────────────────────────
    // Case 1: Simple move (fromStep → toStep)
    // ────────────────────────────────────────────────
    if (fromStep !== undefined && toStep !== undefined) {
      const from = parseInt(fromStep, 10);
      const to = parseInt(toStep, 10);

      if (isNaN(from) || isNaN(to) || from < 1 || to < 1) {
        throw new Error("Invalid fromStep or toStep");
      }

      if (from === to) {
        return { respond: { status: 200, body: { success: true, message: "No change needed" } } };
      }

      // Park the moved row in the temp range FIRST — until 'from' is
      // vacated, the shift below would land its first row on a still-
      // occupied slot and hit uk_workflow_step (e.g. moving 3→2 shifts
      // 2→3 while the moved row still sits at 3). Same +10000 temp
      // convention as insert-at and the full-order path.
      const [parked] = await connection.query(
        `UPDATE workflow_steps
         SET step_number = ?
         WHERE workflow_id = ? AND version = ? AND step_number = ?`,
        [from + 10000, workflowId, editVersion, from]
      );
      if (parked.affectedRows === 0) {
        throw new Error(`No step at position ${from}`);
      }

      // Shift steps between from and to.
      // ORDER BY direction ensures each step moves into a slot just vacated
      // (starting with the slot 'from' just left), preventing unique
      // constraint collisions.
      if (from < to) {
        // Moving step forward: shift intermediate steps down — process ASC
        // so the lowest step moves first into the freed 'from' slot
        await connection.query(
          `UPDATE workflow_steps 
           SET step_number = step_number - 1 
           WHERE workflow_id = ? AND version = ? AND step_number > ? AND step_number <= ?
           ORDER BY step_number ASC`,
          [workflowId, editVersion, from, to]
        );
      } else {
        // Moving step backward: shift intermediate steps up — process DESC
        // so the highest step moves first into the freed 'from' slot
        await connection.query(
          `UPDATE workflow_steps 
           SET step_number = step_number + 1 
           WHERE workflow_id = ? AND version = ? AND step_number >= ? AND step_number < ?
           ORDER BY step_number DESC`,
          [workflowId, editVersion, to, from]
        );
      }

      // Place the moved step from the temp range into its final slot
      await connection.query(
        `UPDATE workflow_steps 
         SET step_number = ? 
         WHERE workflow_id = ? AND version = ? AND step_number = ?`,
        [to, workflowId, editVersion, from + 10000]
      );

      // Branch-target remap slice — follow the same old→new mapping the
      // renumber just applied.
      remapResult = await remapBranchTargets(connection, workflowId, editVersion, (n) => {
        if (n === from) return to;
        if (from < to && n > from && n <= to) return n - 1;
        if (to < from && n >= to && n < from) return n + 1;
        return n;
      });
    }

    // ────────────────────────────────────────────────
    // Case 2: Full new order array
    // ────────────────────────────────────────────────
    else if (Array.isArray(order) && order.length > 0) {
      if (order.some(n => !Number.isInteger(n) || n < 1)) {
        throw new Error("Invalid step numbers in order array");
      }

      // Two-pass approach to avoid unique constraint collisions.
      // A single pass can collide: e.g. moving old step 3 → 1 then old step 1 → 2
      // hits the row that was just renamed, not the original step 1.
      //
      // Pass 1: shift all steps into a safe temp range (+10000) so no final
      //         value can collide with any in-progress temp value.
      for (let i = 0; i < order.length; i++) {
        await connection.query(
          `UPDATE workflow_steps 
           SET step_number = ? 
           WHERE workflow_id = ? AND version = ? AND step_number = ?`,
          [order[i] + 10000, workflowId, editVersion, order[i]]
        );
      }

      // Pass 2: set final positions from the temp range.
      for (let i = 0; i < order.length; i++) {
        await connection.query(
          `UPDATE workflow_steps 
           SET step_number = ? 
           WHERE workflow_id = ? AND version = ? AND step_number = ?`,
          [i + 1, workflowId, editVersion, order[i] + 10000]
        );
      }

      // Branch-target remap slice — order[i] (old number) landed at i+1.
      // Steps absent from the order array kept their numbers (pre-existing
      // endpoint behavior), so unmapped targets pass through unchanged.
      const oldToNew = {};
      order.forEach((oldN, i) => { oldToNew[oldN] = i + 1; });
      remapResult = await remapBranchTargets(connection, workflowId, editVersion, (n) => oldToNew[n] ?? n);
    } 
    else {
      return { respond: { status: 400, body: { error: "Must provide either {fromStep, toStep} or {order: array}" } } };
    }

      return { remap: remapResult };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[REORDER] Workflow ${workflowId} steps reordered`);

    res.json({
      success: true,
      remap: outcome.remap,
      message: "Steps reordered successfully"
    });
  } catch (err) {
    console.error("[REORDER STEPS] Failed:", err);
    res.status(500).json({ error: "Failed to reorder steps", message: err.message });
  }
});



/**
 * PUT /workflows/:id
 * Update workflow name and/or description and/or test_input
 * Body: { "name"?: string, "description"?: string, "test_input"?: object|null }
 * Partial updates are supported (at least one field required)
 *
 * Slice 2.1: `test_input` is accepted as a partial-update field. Pass `null`
 * to explicitly clear it. Omit from body to leave unchanged.
 */
router.put("/workflows/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name, description, test_input, active } = req.body;

  const workflowId = parseInt(id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  // At least one field must be provided for a meaningful update
  if (name === undefined && description === undefined && test_input === undefined && active === undefined) {
    return res.status(400).json({ error: "At least one field (name, description, test_input, or active) is required" });
  }

  // Slice 2.1 — test_input shape validation (only if present in body).
  if (test_input !== undefined) {
    const v = validateTestInput(test_input);
    if (v) return res.status(v.status).json({ error: v.error });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify workflow exists
    const [wfRows] = await connection.query(
      `SELECT id FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Build dynamic update (only update fields that were sent)
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push((name || "").trim());
    }
    if (description !== undefined) {
      updates.push("description = ?");
      params.push((description || "").trim());
    }
    if (test_input !== undefined) {
      updates.push("test_input = ?");
      params.push(toJson(test_input));
    }
    if (active !== undefined) {
      updates.push("active = ?");
      params.push(active ? 1 : 0);
    }

    const query = `
      UPDATE workflows 
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE id = ?
    `;
    params.push(workflowId);

    await connection.query(query, params);

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[UPDATE WORKFLOW] Updated workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      message: "Workflow updated successfully"
    });
  } catch (err) {
    console.error("[UPDATE WORKFLOW] Failed:", err);
    res.status(500).json({ 
      error: "Failed to update workflow", 
      message: err.message 
    });
  }
});


/**
 * PUT /workflows/:id/steps/:stepNumber
 * Full replace of a step (type + config + error_policy)
 * Body: { "type": "...", "config": {...}, "error_policy": {...} }
 */
router.put("/workflows/:id/steps/:stepNumber", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id, stepNumber } = req.params;
  const { type, config, error_policy, label, note } = req.body;

  const workflowId = parseInt(id, 10);
  const stepNum = parseInt(stepNumber, 10);

  if (isNaN(workflowId) || workflowId <= 0 || isNaN(stepNum) || stepNum <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID or step number" });
  }

  if (!["webhook", "internal_function", "custom_code"].includes(type)) {
    return res.status(400).json({ error: "Invalid step type" });
  }
  if (!config || typeof config !== "object") {
    return res.status(400).json({ error: "config object is required" });
  }

  // Timing-extensions slice — validate wait_for / schedule_resume params
  {
    const v = validateInternalFunctionConfig(type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Webhook credential injection slice — validate URL, method, credential FK, timeout
  {
    const v = await validateWebhookConfig(db, type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  // Slice 6R — start_workflow target FK check (literal workflow_id only)
  {
    const v = await validateStartWorkflowConfig(db, type, config);
    if (v) return res.status(v.status).json({ error: v.error, message: v.message });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Draft resolution (see ensureDraft above). Also serves as the workflow
    // existence check this route historically lacked.
    const editVersion = await ensureDraft(connection, workflowId);
    if (editVersion == null) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Verify step exists on the edit-target version
    const [rows] = await connection.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND version = ? AND step_number = ?`,
      [workflowId, editVersion, stepNum]
    );
    if (rows.length === 0) {
      return { respond: { status: 404, body: { error: "Step not found" } } };
    }

    // Label/note slice — deliberately NOT full-replace semantics: existing
    // API callers (worker prompts) PUT {type, config, error_policy} without
    // label/note, and nulling labels on every such PUT would silently erase
    // them. Keys absent from the body → columns left unchanged; keys present
    // (including explicit null / '') → written.
    const extraSets = [];
    const extraVals = [];
    if (label !== undefined) {
      extraSets.push('label = ?');
      extraVals.push((typeof label === 'string' && label.trim()) ? label.trim().slice(0, 100) : null);
    }
    if (note !== undefined) {
      extraSets.push('note = ?');
      extraVals.push((typeof note === 'string' && note.trim()) ? note.trim() : null);
    }

    await connection.query(
      `
      UPDATE workflow_steps 
      SET type = ?, config = ?, error_policy = ?${extraSets.length ? ', ' + extraSets.join(', ') : ''}, updated_at = NOW()
      WHERE workflow_id = ? AND version = ? AND step_number = ?
      `,
      [
        type,
        JSON.stringify(config),
        error_policy ? JSON.stringify(error_policy) : null,
        ...extraVals,
        workflowId,
        editVersion,
        stepNum
      ]
    );

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[UPDATE STEP] Fully replaced step ${stepNum} in workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      stepNumber: stepNum,
      message: `Step ${stepNum} fully updated`
    });
  } catch (err) {
    console.error("[PUT STEP] Failed:", err);
    res.status(500).json({ error: "Failed to update step", message: err.message });
  }
});



/**
 * PATCH /workflows/:id/steps/:stepNumber
 * Partial update (only fields you send)
 * Body example: { "error_policy": { "strategy": "retry_then_abort", "max_retries": 3 } }
 * or { "config": { "url": "new-url" } }
 */
router.patch("/workflows/:id/steps/:stepNumber", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id, stepNumber } = req.params;
  const { type, config, error_policy, label, note } = req.body;

  const workflowId = parseInt(id, 10);
  const stepNum = parseInt(stepNumber, 10);

  if (isNaN(workflowId) || workflowId <= 0 || isNaN(stepNum) || stepNum <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID or step number" });
  }

  // At least one field must be provided
  if (type === undefined && config === undefined && error_policy === undefined
      && label === undefined && note === undefined) {
    return res.status(400).json({ error: "At least one field is required" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Draft resolution (see ensureDraft above). Also serves as the workflow
    // existence check this route historically lacked.
    const editVersion = await ensureDraft(connection, workflowId);
    if (editVersion == null) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    // Verify step exists on the edit-target version
    const [rows] = await connection.query(
      `SELECT id, type, config FROM workflow_steps WHERE workflow_id = ? AND version = ? AND step_number = ?`,
      [workflowId, editVersion, stepNum]
    );
    if (rows.length === 0) {
      return { respond: { status: 404, body: { error: "Step not found" } } };
    }

    // Timing-extensions slice — if type or config is being updated, validate
    // the resulting (type, config) pair. If only one of the two was supplied,
    // load the other from the existing row so we always validate the
    // combination, not a partial view. Mirrors the pattern used for
    // action_type/action_config validation in routes/sequences.js.
    if (type !== undefined || config !== undefined) {
      let typeToCheck   = type;
      let configToCheck = config;
      if (typeToCheck === undefined) typeToCheck = rows[0].type;
      if (configToCheck === undefined) {
        configToCheck = typeof rows[0].config === 'string'
          ? JSON.parse(rows[0].config)
          : rows[0].config;
      }
      const v = validateInternalFunctionConfig(typeToCheck, configToCheck);
      if (v) {
        return { respond: { status: v.status, body: { error: v.error, message: v.message } } };
      }
      // Webhook credential injection slice — same combination-check pattern.
      const wv = await validateWebhookConfig(db, typeToCheck, configToCheck);
      if (wv) {
        return { respond: { status: wv.status, body: { error: wv.error, message: wv.message } } };
      }
      // Slice 6R — start_workflow target FK check, same combination pattern.
      const swv = await validateStartWorkflowConfig(db, typeToCheck, configToCheck);
      if (swv) {
        return { respond: { status: swv.status, body: { error: swv.error, message: swv.message } } };
      }
    }

    const updates = [];
    const params = [];

    if (type !== undefined) {
      updates.push("type = ?");
      params.push(type);
    }
    if (config !== undefined) {
      updates.push("config = ?");
      params.push(JSON.stringify(config));
    }
    if (error_policy !== undefined) {
      updates.push("error_policy = ?");
      params.push(error_policy ? JSON.stringify(error_policy) : null);
    }
    if (label !== undefined) {
      updates.push("label = ?");
      params.push((typeof label === 'string' && label.trim()) ? label.trim().slice(0, 100) : null);
    }
    if (note !== undefined) {
      updates.push("note = ?");
      params.push((typeof note === 'string' && note.trim()) ? note.trim() : null);
    }

    const query = `
      UPDATE workflow_steps 
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE workflow_id = ? AND version = ? AND step_number = ?
    `;
    params.push(workflowId, editVersion, stepNum);

    await connection.query(query, params);

      return {};
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[PATCH STEP] Updated step ${stepNum} in workflow ${workflowId}`);

    res.json({
      success: true,
      workflowId,
      stepNumber: stepNum,
      message: `Step ${stepNum} partially updated`
    });
  } catch (err) {
    console.error("[PATCH STEP] Failed:", err);
    res.status(500).json({ error: "Failed to patch step", message: err.message });
  }
});



/**
 * POST /workflows/:id/duplicate
 * Duplicate a workflow + ALL its steps
 * Body (optional): { "name"?: string }  → if not provided, defaults to "Copy of Original Name"
 */
router.post("/workflows/:id/duplicate", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name: customName } = req.body;

  const originalId = parseInt(id, 10);
  if (isNaN(originalId) || originalId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Get original workflow
    //
    // Slice 2.1: also SELECT test_input so the duplicate carries over the
    // authorial init_data shape doc. Symmetric with description carry-over.
    const [wfRows] = await connection.query(
      `SELECT name, description, test_input, captured_input, captured_at, current_version, draft_version FROM workflows WHERE id = ?`,
      [originalId]
    );
    if (wfRows.length === 0) {
      return { respond: { status: 404, body: { error: "Workflow not found" } } };
    }

    const original = wfRows[0];

    // Create new workflow
    const newName = customName?.trim() || `Copy of ${original.name}`;
    // Capture slice: sample + timestamp copy (hooks-clone parity) but
    // capture_mode never copies — the duplicate starts disarmed (default).
    // Versioning (S3): content comes from the source's PUBLISHED version
    // (plan-v2 decision 7); a never-published source falls back to its draft.
    // The duplicate itself lands UNPUBLISHED (current_version = 0, content as
    // draft v1) — publishing implicitly on duplicate would bypass the review
    // boundary.
    const sourceVersion = original.current_version || original.draft_version || 0;

    const [newWfResult] = await connection.query(
      `INSERT INTO workflows (name, description, test_input, captured_input, captured_at, current_version, draft_version) VALUES (?, ?, ?, ?, ?, 0, 1)`,
      [newName, original.description || "", toJson(original.test_input), toJson(original.captured_input), original.captured_at ?? null]
    );
    const newWorkflowId = newWfResult.insertId;

    // Duplicate all steps
    const [steps] = await connection.query(
      `
      SELECT step_number, label, note, type, config, error_policy 
      FROM workflow_steps 
      WHERE workflow_id = ? AND version = ?
      ORDER BY step_number ASC
      `,
      [originalId, sourceVersion]
    );

    if (steps.length > 0) {
      const stepValues = steps.map(step => [
        newWorkflowId,
        1,
        step.step_number,
        step.label ?? null,
        step.note ?? null,
        step.type,
        toJson(step.config),
        toJson(step.error_policy)
      ]);

      await connection.query(
        `
        INSERT INTO workflow_steps 
        (workflow_id, version, step_number, label, note, type, config, error_policy)
        VALUES ?
        `,
        [stepValues]
      );
    }

    // Draft metadata stub for the duplicate's v1 — published_at NULL until
    // the author publishes.
    await connection.query(
      `INSERT INTO workflow_versions (workflow_id, version, name, description, test_input)
       VALUES (?, 1, ?, ?, ?)`,
      [newWorkflowId, newName, original.description || "", toJson(original.test_input)]
    );

      return { newWorkflowId, newName, stepCount: steps.length };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    console.log(`[DUPLICATE] Workflow ${originalId} → ${outcome.newWorkflowId} (${outcome.stepCount} steps)`);

    res.status(201).json({
      success: true,
      originalWorkflowId: originalId,
      newWorkflowId: outcome.newWorkflowId,
      newName: outcome.newName,
      stepCount: outcome.stepCount,
      message: `Workflow duplicated successfully`
    });
  } catch (err) {
    console.error("[DUPLICATE WORKFLOW] Failed:", err);
    res.status(500).json({ 
      error: "Failed to duplicate workflow", 
      message: err.message 
    });
  }
});



/**
 * POST /executions/:id/cancel
 * Emergency cancel of a running workflow execution.
 *
 * Body: { reason: string }  — REQUIRED, min 3 chars after trim. Stored in
 *                             the new workflow_executions.cancel_reason column
 *                             (Slice 4.3 Part B). Mirrors the sequence-cancel
 *                             pattern — honest audit trail for manual stops.
 *
 * Side effects:
 *   - workflow_executions: status → 'cancelled', cancel_reason set,
 *     updated_at + completed_at = NOW()
 *   - scheduled_jobs: any pending/running 'workflow_resume' for this
 *     execution is deleted (not "failed" — deletion matches the legacy
 *     behaviour of this route, and cancelled resumes have no audit value).
 */
router.post("/executions/:id/cancel", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const executionId = parseInt(id, 10);
  if (isNaN(executionId) || executionId <= 0) {
    return res.status(400).json({ error: "Invalid execution ID" });
  }

  // Validate reason — required, min 3 chars after trim.
  const rawReason = (req.body && typeof req.body.reason === 'string') ? req.body.reason : '';
  const reason = rawReason.trim();
  if (reason.length < 3) {
    return res.status(400).json({
      error: "Reason required",
      message: "reason is required and must be at least 3 characters after trim",
    });
  }
  // Hard cap at the column width (500) — truncate rather than 400 here.
  // A 500-char reason is already aggressive; silently trimming is kinder
  // than refusing the cancel over overflow.
  const reasonStored = reason.length > 500 ? reason.slice(0, 500) : reason;

  try {
    const outcome = await db.withTransaction(async (connection) => {

    // Verify execution exists and is still cancellable.
    const [execRows] = await connection.query(
      `
      SELECT status 
      FROM workflow_executions 
      WHERE id = ? 
        AND status IN ('active', 'processing', 'delayed', 'held')
      `,
      [executionId]
    );

    if (execRows.length === 0) {
      return { respond: { status: 400, body: { error: "Cannot cancel", message: "Execution not found or already finished" } } };
    }

    // Mark as cancelled (with reason).
    await connection.query(
      `
      UPDATE workflow_executions 
      SET status        = 'cancelled', 
          cancel_reason = ?,
          updated_at    = NOW(),
          completed_at  = NOW()
      WHERE id = ?
      `,
      [reasonStored, executionId]
    );

    // Delete any pending resume jobs for this execution.
    await connection.query(
      `
      DELETE FROM scheduled_jobs 
      WHERE type = 'workflow_resume' 
        AND workflow_execution_id = ? 
        AND status IN ('pending', 'running')
      `,
      [executionId]
    );

    // Decision cascade (HITL slice): close any pending decision_requests so
    // their links render "no longer needed" instead of resuming a cancelled
    // execution. Paired tasks are dismissed post-commit (taskService writes
    // its own log rows + side effects — keep those off this transaction).
    const [pendingDecisions] = await connection.query(
      `SELECT id, paired_task_id FROM decision_requests
        WHERE workflow_execution_id = ? AND status = 'pending'`,
      [executionId]
    );
    if (pendingDecisions.length > 0) {
      await connection.query(
        `UPDATE decision_requests SET status = 'cancelled', updated_at = NOW()
          WHERE workflow_execution_id = ? AND status = 'pending'`,
        [executionId]
      );
    }

      return { pendingDecisions };
    });

    if (outcome.respond) return res.status(outcome.respond.status).json(outcome.respond.body);

    // Post-commit, best-effort: dismiss paired tasks for cancelled decisions.
    for (const d of (outcome.pendingDecisions || [])) {
      if (!d.paired_task_id) continue;
      try {
        await require('../services/taskService').deleteTask(
          db, d.paired_task_id, 0, { via: 'workflow_cancelled' }
        );
      } catch (taskErr) {
        // Already completed/deleted races are fine.
        console.warn(`[CANCEL] Could not dismiss decision task ${d.paired_task_id}:`, taskErr.message);
      }
    }

    console.log(`[CANCEL] Execution ${executionId} cancelled by user — reason: ${reasonStored}`);

    res.json({
      success: true,
      executionId,
      cancel_reason: reasonStored,
      message: "Workflow execution cancelled successfully",
    });
  } catch (err) {
    console.error("[CANCEL EXECUTION] Failed:", err);
    res.status(500).json({
      error: "Failed to cancel execution",
      message: err.message,
    });
  }
});



/**
 * POST /executions/:id/resume
 * Slice 4 — resume a terminal execution from a chosen step, or redo one step.
 *
 * Body: { mode: 'resume' | 'single_step', step_number, variables? }
 *   - mode 'resume':      re-arm the execution at step_number and let
 *                         advanceWorkflow run it to completion (202, detached).
 *   - mode 'single_step': execute exactly that step synchronously via
 *                         executeSingleStep — records history, merges set_vars,
 *                         never navigates or changes status (200).
 *   - variables (optional): plain object — FULL REPLACE of
 *                         workflow_executions.variables before execution.
 *
 * Eligibility: any status EXCEPT live ('active','processing','delayed') —
 * failed, cancelled, completed, completed_with_errors are all resumable.
 * Deliberate: completed runs can contain mistakes that weren't recorded as
 * errors (wrong recipient, bad data) and operators need to redo them.
 *
 * We deliberately do NOT check workflows.active — resume is an operator
 * repair tool and must work on workflows that have since been deactivated.
 *
 * Final-status honesty: getWorkflowFinalStatus counts ALL history rows, so a
 * resumed execution that finishes cleanly will still end
 * 'completed_with_errors' if old failed rows exist. This is correct — history
 * is honest — do not "fix" it by filtering old rows.
 */
router.post("/executions/:id/resume", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const executionId = parseInt(id, 10);
  if (isNaN(executionId) || executionId <= 0) {
    return res.status(400).json({ error: "Invalid execution ID" });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const { mode, step_number, variables } = body;

  try {
    // 1. Execution exists.
    const [execRows] = await db.query(
      `SELECT id, workflow_id, workflow_version, status FROM workflow_executions WHERE id = ?`,
      [executionId]
    );
    if (execRows.length === 0) {
      return res.status(404).json({ error: "Execution not found" });
    }
    const execution = execRows[0];

    // 2. Not live. Everything else is eligible (see route doc above).
    if (['active', 'processing', 'delayed'].includes(execution.status)) {
      return res.status(409).json({
        error: "Cannot resume",
        message: `Cannot resume a live execution (status '${execution.status}')`,
      });
    }

    // 3. Mode.
    if (mode !== 'resume' && mode !== 'single_step') {
      return res.status(400).json({
        error: "Invalid mode",
        message: "mode must be 'resume' or 'single_step'",
      });
    }

    // 4. step_number is a positive integer AND exists on this workflow.
    const stepNum = Number(step_number);
    if (!Number.isInteger(stepNum) || stepNum <= 0) {
      return res.status(400).json({
        error: "Invalid step_number",
        message: "step_number must be a positive integer",
      });
    }
    // PINNED-READ: the resume target must exist on the version this execution
    // is pinned to — validating against current_version would approve a resume
    // into a version the execution will never run (audit M5).
    const [stepRows] = await db.query(
      `SELECT id FROM workflow_steps WHERE workflow_id = ? AND version = ? AND step_number = ?`,
      [execution.workflow_id, execution.workflow_version, stepNum]
    );
    if (stepRows.length === 0) {
      return res.status(400).json({
        error: "Step not found",
        message: `Workflow ${execution.workflow_id} has no step ${stepNum}`,
      });
    }

    // 5. variables, when present, must be a plain object. Semantics: FULL
    //    REPLACE of workflow_executions.variables (not a merge).
    const hasVariables = variables !== undefined;
    if (hasVariables && (
      variables === null ||
      typeof variables !== 'object' ||
      Array.isArray(variables)
    )) {
      return res.status(400).json({
        error: "Invalid variables",
        message: "variables must be a plain JSON object when provided",
      });
    }

    if (mode === 'resume') {
      if (hasVariables) {
        await db.query(
          `UPDATE workflow_executions
           SET status = 'active', current_step_number = ?, completed_at = NULL,
               variables = ?, updated_at = NOW()
           WHERE id = ?`,
          [stepNum, JSON.stringify(variables), executionId]
        );
      } else {
        await db.query(
          `UPDATE workflow_executions
           SET status = 'active', current_step_number = ?, completed_at = NULL,
               updated_at = NOW()
           WHERE id = ?`,
          [stepNum, executionId]
        );
      }

      console.log(`[RESUME] Execution ${executionId} resumed from step ${stepNum}${hasVariables ? ' (variables replaced)' : ''}`);

      res.status(202).json({
        success: true,
        executionId,
        mode: 'resume',
        resumed_from: stepNum,
      });

      // Background advance — mirrors POST /workflows/:id/start exactly.
      (async () => {
        try {
          const advanceResult = await advanceWorkflow(executionId, db);
          console.log(`[ASYNC ADVANCE] (resume) Completed: ${advanceResult.status}`);
        } catch (err) {
          console.error(`[ASYNC ADVANCE] (resume) Failed for execution ${executionId}:`, err.message);
        }
      })();
      return;
    }

    // mode === 'single_step' — replace variables FIRST so the template
    // context builds from them, then run synchronously.
    if (hasVariables) {
      await db.query(
        `UPDATE workflow_executions SET variables = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(variables), executionId]
      );
    }

    const result = await executeSingleStep(executionId, stepNum, db);

    console.log(`[RESUME] Execution ${executionId} single-step redo of step ${stepNum}: ${result.success ? 'success' : 'failed'}`);

    return res.status(200).json({
      success: result.success,
      mode: 'single_step',
      step_number: stepNum,
      result,
    });
  } catch (err) {
    console.error("[RESUME EXECUTION] Failed:", err);
    res.status(500).json({
      error: "Failed to resume execution",
      message: err.message,
    });
  }
});



/**
 * POST /workflows/test-step
 * Test a single step in isolation — resolves placeholders against provided
 * variables, then either previews (dry_run) or executes the step.
 *
 * Body:
 *   step      { type, config, error_policy? }  — step definition (no id/workflow_id needed)
 *   variables { key: value, ... }              — simulated workflow variables
 *   env       { executionId?, stepNumber? }    — optional env overrides for {{env.*}}
 *   dry_run   boolean (optional)               — resolve-only, no execution, no side effects
 *
 * Dry-run returns:
 *   { success: true, dry_run: true, resolved_config, unresolved_placeholders,
 *     validation_error?, credential_note? }
 *
 * Live returns (unchanged shape, plus retries_skipped when the step's
 * error_policy declared max_retries > 0 — the tester never sleeps through
 * retry backoff; effective retries are forced to 0):
 *   { success, output, set_vars, next_step, delayed_until, error?,
 *     duration_ms, attempts, would_abort?, retries_skipped? }
 */
router.post("/workflows/test-step", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const { step, variables = {}, env = {}, dry_run = false } = req.body;

  // Strip phantom step-output keys from incoming variables. The tester UI
  // historically seeded a variable row for every {{placeholder}} found in the
  // step config — including {{this.*}} step-output references — which then
  // arrive here as variables with empty values. resolveSingle checks
  // `key in variables` FIRST, so a phantom `this.output.x` key shadows the
  // real post-execution `this` resolution and set_vars silently resolve to "".
  // Step-output references are never legitimate *input* variables, so strip
  // them server-side regardless of which client (or cached client) sent them.
  for (const k of Object.keys(variables)) {
    if (k === 'this' || k.startsWith('this.')) delete variables[k];
  }

  if (!step || !step.type || !step.config) {
    return res.status(400).json({ error: "step.type and step.config are required" });
  }

  const VALID_TYPES = ["webhook", "internal_function", "custom_code"];
  if (!VALID_TYPES.includes(step.type)) {
    return res.status(400).json({ error: `Invalid step type: ${step.type}` });
  }

  // Parse config if it arrived as a string
  let config = step.config;
  if (typeof config === "string") {
    try { config = JSON.parse(config); }
    catch { return res.status(400).json({ error: "step.config is not valid JSON" }); }
  }

  // Parse error_policy if present
  let errorPolicy = step.error_policy || { strategy: "ignore" };
  if (typeof errorPolicy === "string") {
    try { errorPolicy = JSON.parse(errorPolicy); } catch { errorPolicy = { strategy: "ignore" }; }
  }

  const context = {
    variables,
    this: {},
    env: {
      executionId: env.executionId ?? "test",
      stepNumber:  env.stepNumber  ?? 1,
      now:         new Date().toISOString(),
      ...env
    }
  };

  // Resolve placeholders in config
  const resolvedConfig = resolvePlaceholders(config, context);

  // ── Dry run: resolve-only preview. No executeJob call, no side effects
  // for any step type. Always 200 — validation problems are surfaced as
  // data, not errors, so the author still sees the resolved view.
  if (dry_run) {
    const out = {
      success:         true,
      dry_run:         true,
      resolved_config: resolvedConfig,
      // Tokens in the ORIGINAL config that resolve to null (unknown variable,
      // this.* pre-execution, unknown env helper). Cannot scan resolvedConfig —
      // resolvePlaceholders blanks unresolved tokens to '' (resolveSingle
      // returns null, replace callback does `?? ''`), so tokens never survive
      // resolution. Probing the original tokens via resolveSingle also
      // correctly distinguishes an unset variable (null → flagged) from a
      // variable explicitly set to empty string ('' → not flagged).
      unresolved_placeholders: [...new Set(
        [...JSON.stringify(config).matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim())
      )].filter(k => resolveSingle(k, context) == null).map(k => `{{${k}}}`),
    };

    if (step.type === "internal_function") {
      const vErr = validateInternalFunctionParams(config.function_name, resolvedConfig.params);
      if (vErr) out.validation_error = vErr.error;
    }

    // NEVER resolve or echo credential headers here — that would leak
    // secrets into the preview. Just note that injection happens at send.
    if (step.type === "webhook" && (config.credential_id || resolvedConfig.credential_id)) {
      out.credential_note = "Credential headers are injected at send time and are not shown in preview.";
    }

    return res.json(out);
  }

  // ── Live run. The tester never honors retry backoff — a 3×30s policy
  // would hang this HTTP request for minutes. Effective retries are forced
  // to 0; retries_skipped flags when the step's policy declared any.
  const strategy       = errorPolicy.strategy || "ignore";
  const policyRetries  = Number(errorPolicy.max_retries) || 0;
  const retriesSkipped = policyRetries > 0;

  // Build job data
  const jobData = { type: step.type, ...resolvedConfig };

  // Inject _variables for evaluate_condition
  if (step.type === "internal_function" && resolvedConfig.params) {
    jobData.params = { ...resolvedConfig.params, _variables: variables };
  }

  const startTime = Date.now();
  let rawResult, success, errorMsg;
  const attempt = 1; // retries forced off in tester — see above

  try {
    rawResult = await executeJob({ data: jobData }, db);
    success = true;
  } catch (err) {
    success  = false;
    errorMsg = err.message;
  }

  const duration_ms = Date.now() - startTime;

  if (!success) {
    return res.json({
      success:      false,
      error:        errorMsg,
      duration_ms,
      attempts:     attempt,
      would_abort:  strategy === "abort" || strategy === "retry_then_abort",
      ...(retriesSkipped ? { retries_skipped: true } : {})
    });
  }

  // Resolve set_vars from config (static) + function return
  context.this = rawResult;
  let staticSetVars = {};
  if (config.set_vars) {
    staticSetVars = resolvePlaceholders(config.set_vars, context);
  }
  const set_vars = { ...staticSetVars, ...(rawResult?.set_vars || {}) };

  // Extract control signals
  const next_step    = rawResult?.next_step    ?? null;
  const delayed_until = rawResult?.delayed_until ?? null;

  res.json({
    success:      true,
    output:       rawResult,
    set_vars,
    next_step,
    delayed_until,
    duration_ms,
    attempts:     attempt,
    resolved_config: resolvedConfig,   // handy for debugging placeholder resolution
    ...(retriesSkipped ? { retries_skipped: true } : {})
  });
});

// ─────────────────────────────────────────────────────────────
// Capture mode — one-shot capture of the next real init_data.
//
// Mirrors the hooks capture lifecycle (routes/api.hooks.js):
//   - start arms capture_mode='capturing'
//   - the NEXT execution start (any of the four creation sites) writes
//     captured_input/captured_at and flips capture_mode back to 'off'
//     via a guarded UPDATE (race-free across sites/instances)
//   - start/stop do NOT clear captured_input — the sample is preserved
//     until the next successful capture overwrites it
// ─────────────────────────────────────────────────────────────

router.post("/workflows/:id/capture/start", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const workflowId = parseInt(req.params.id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
  // Intercept slice — body.mode selects semantics:
  //   'tap'       (default) → 'capturing': record init_data, run proceeds
  //   'intercept'           → 'intercept': record init_data, execution is
  //                            created then parked 'held' before step 1
  //                            (see workflow_engine step-0 block)
  const captureMode = (req.body && req.body.mode === 'intercept') ? 'intercept' : 'capturing';
  try {
    const [r] = await db.query(
      `UPDATE workflows SET capture_mode = ? WHERE id = ?`,
      [captureMode, workflowId]
    );
    if (r.affectedRows === 0 && r.changedRows === 0) {
      const [[row]] = await db.query(`SELECT id FROM workflows WHERE id = ?`, [workflowId]);
      if (!row) return res.status(404).json({ error: "Workflow not found" });
    }
    res.json({ status: 'success', capture_mode: captureMode });
  } catch (err) {
    console.error("[WF CAPTURE START] Failed:", err);
    res.status(500).json({ error: "Failed to start capture", message: err.message });
  }
});

router.post("/workflows/:id/capture/stop", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const workflowId = parseInt(req.params.id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
  try {
    const [r] = await db.query(
      `UPDATE workflows SET capture_mode = 'off' WHERE id = ?`,
      [workflowId]
    );
    if (r.affectedRows === 0 && r.changedRows === 0) {
      const [[row]] = await db.query(`SELECT id FROM workflows WHERE id = ?`, [workflowId]);
      if (!row) return res.status(404).json({ error: "Workflow not found" });
    }
    res.json({ status: 'success', capture_mode: 'off' });
  } catch (err) {
    console.error("[WF CAPTURE STOP] Failed:", err);
    res.status(500).json({ error: "Failed to stop capture", message: err.message });
  }
});

router.get("/workflows/:id/captured", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const workflowId = parseInt(req.params.id, 10);
  if (isNaN(workflowId) || workflowId <= 0) {
    return res.status(400).json({ error: "Invalid workflow ID" });
  }
  try {
    const [[row]] = await db.query(
      `SELECT capture_mode, captured_input, captured_at FROM workflows WHERE id = ?`,
      [workflowId]
    );
    if (!row) return res.status(404).json({ error: "Workflow not found" });
    let sample = row.captured_input;
    if (typeof sample === 'string') {
      try { sample = sample ? JSON.parse(sample) : null; } catch { /* leave as-is */ }
    }
    res.json({
      status: 'success',
      capture_mode: row.capture_mode,
      captured_input: sample,
      captured_at: row.captured_at,
    });
  } catch (err) {
    console.error("[WF CAPTURED GET] Failed:", err);
    res.status(500).json({ error: "Failed to fetch captured input", message: err.message });
  }
});

module.exports = router;

// Test-only handle (tests/workflows.ensureDraft.test.js) — exercises the
// draft fork against a scripted mock connection without standing up auth.
router._test = { ensureDraft };