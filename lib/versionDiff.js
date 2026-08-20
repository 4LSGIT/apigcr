// lib/versionDiff.js
//
// Automation versioning (S3, 2026-08) — draft-vs-published diffing and
// publish-time validation for WORKFLOW definitions. (S4 adds the sequence
// equivalents to this module; keep both here so the two classifiers stay
// side-by-side and drift is visible.)
//
// ── Why the classifier exists ─────────────────────────────────────────────
// Publishing offers an opt-in "also apply to in-flight runs" ONLY when the
// diff is CONTENT-ONLY: same step count, same numbering, same types, same
// control-flow targets — only payload leaves changed (the typo-fix case).
// Anything structural cannot migrate: in-flight step pointers
// (workflow_executions.current_step_number, scheduled workflow_resume jobs'
// data.nextStep, decision_requests.resume_step) are step NUMBERS, meaningful
// only while numbering is stable.
//
// FAIL-CLOSED, POSITIVE WHITELIST (plan-v2 ruling O1): the classifier
// enumerates what counts as CONTENT; everything it cannot positively account
// for is STRUCTURAL. A misclassification in the structural direction costs a
// disabled checkbox; one in the content direction silently corrupts live
// runs. Content for workflows = `label`, `note`, and config leaves that are
// NOT branch targets. Everything else — step count, numbering, `type`,
// `function_name`, `error_policy`, any branch-target param (flat OR
// branches[].then), and ANY change to a custom_code step (its code can carry
// next_step control flow the engine can't see) — is structural.
//
// The branch-target param map is NOT duplicated here: routes/workflows.js
// owns BRANCH_TARGET_PARAMS (tests/control.flow.test.js pins its coverage)
// and passes it in via opts. Same for the terminal-sentinel test.
//
// ── Validation (plan-v2 ruling O5) ────────────────────────────────────────
// validateWorkflowDraft() is the publish gate:
//   errors   → block publish (out-of-range literal targets; foreach.end_step
//              not strictly after its own step; empty draft; broken numbering)
//   warnings → surfaced in the publish modal, do NOT block. Deliberate
//              divergence from the review's "promote remap warnings to
//              blockers": non-literal targets are LIVE production usage
//              (wf41 step 9's set_next.value = '{{jump_to}}' is a deliberate
//              dynamic jump), so blocking them would make real workflows
//              unpublishable. Out-of-range literals — the actually-broken
//              class — do block.
//   info     → custom_code mentioning next_step (author should eyeball).

'use strict';

// Stable stringify — key-order-independent equality for config/error_policy.
function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function parseMaybeJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// Literal step-number contract shared with remapBranchTargets: integer or
// all-digits string. Anything else is non-literal (sentinel / template / typo).
function asLiteralStep(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

// Extract every branch-target value from an internal_function step's config:
// flat params per BRANCH_TARGET_PARAMS + evaluate_condition's branches[].then
// array (which the flat map deliberately excludes). Returned as
// [{ path, value }] in a stable order so two extractions compare positionally.
function extractBranchTargets(cfg, branchTargetParams) {
  const out = [];
  if (!cfg || typeof cfg !== 'object') return out;
  const fn = cfg.function_name;
  const params = cfg.params && typeof cfg.params === 'object' ? cfg.params : {};
  const names = branchTargetParams[fn] || [];
  for (const p of names) {
    if (params[p] !== undefined) out.push({ path: `${fn}.${p}`, value: params[p] });
  }
  if (fn === 'evaluate_condition' && Array.isArray(params.branches)) {
    params.branches.forEach((br, i) => {
      if (br && typeof br === 'object' && br.then !== undefined) {
        out.push({ path: `evaluate_condition.branches[${i}].then`, value: br.then });
      }
    });
  }
  return out;
}

// ── diffWorkflowSteps(currentSteps, draftSteps, opts) ─────────────────────
// Both inputs: full workflow_steps rows (config/error_policy raw or parsed).
// opts: { branchTargetParams (required), isTerminalSentinel (required for the
//         dynamic-target set_vars gate) }
// Returns { classification: 'identical'|'content_only'|'structural',
//           changes: [{ step_number, kind, fields }],
//           structural_reasons: [string] }
function diffWorkflowSteps(currentSteps, draftSteps, opts) {
  const { branchTargetParams, isTerminalSentinel } = opts;
  const changes = [];
  const structural = [];

  // Dynamic-target flag (review III.F1): does EITHER version carry a branch
  // target that resolves at runtime (non-literal, non-sentinel — e.g.
  // "{{jump_to}}")? Only then can a set_vars edit move control flow, because
  // set_vars is what populates the variables such a target reads at dispatch
  // (the engine resolves config.set_vars on EVERY step type). Computed over
  // both sides so a draft that INTRODUCES a dynamic target is caught in the
  // same publish that edits set_vars. When no dynamic target exists, set_vars
  // can only feed payloads and stays content (wf15/16-style logging edits
  // remain migratable).
  const isSentinel = typeof isTerminalSentinel === 'function' ? isTerminalSentinel : () => false;
  const hasDynamicTarget = [...currentSteps, ...draftSteps].some((s) =>
    extractBranchTargets(parseMaybeJson(s.config), branchTargetParams)
      .some((t) => asLiteralStep(t.value) === null && t.value != null && !isSentinel(t.value))
  );

  const cur = new Map(currentSteps.map((s) => [s.step_number, s]));
  const dra = new Map(draftSteps.map((s) => [s.step_number, s]));

  if (currentSteps.length !== draftSteps.length) {
    structural.push(`step count changed (${currentSteps.length} → ${draftSteps.length})`);
  }
  for (const n of dra.keys()) if (!cur.has(n)) { changes.push({ step_number: n, kind: 'added' }); structural.push(`step ${n} added`); }
  for (const n of cur.keys()) if (!dra.has(n)) { changes.push({ step_number: n, kind: 'removed' }); structural.push(`step ${n} removed`); }

  for (const [n, c] of cur) {
    const d = dra.get(n);
    if (!d) continue;

    const fields = [];
    const cCfg = parseMaybeJson(c.config);
    const dCfg = parseMaybeJson(d.config);
    const cfgChanged = canonical(cCfg) !== canonical(dCfg);
    const labelChanged = (c.label ?? null) !== (d.label ?? null);
    const noteChanged = (c.note ?? null) !== (d.note ?? null);
    const typeChanged = c.type !== d.type;
    const epChanged = canonical(parseMaybeJson(c.error_policy)) !== canonical(parseMaybeJson(d.error_policy));

    if (!cfgChanged && !labelChanged && !noteChanged && !typeChanged && !epChanged) continue;

    if (labelChanged) fields.push('label');
    if (noteChanged) fields.push('note');
    if (typeChanged) { fields.push('type'); structural.push(`step ${n}: type changed (${c.type} → ${d.type})`); }
    if (epChanged) { fields.push('error_policy'); structural.push(`step ${n}: error_policy changed`); }

    if (cfgChanged) {
      fields.push('config');
      if (hasDynamicTarget &&
          canonical((cCfg && cCfg.set_vars) ?? null) !== canonical((dCfg && dCfg.set_vars) ?? null)) {
        structural.push(`step ${n}: set_vars changed while this workflow uses a runtime-resolved branch target — control flow cannot be vouched for`);
      }
      if (!typeChanged && d.type === 'custom_code') {
        // Any change to a custom_code step is structural — config.code can
        // carry next_step control flow no whitelist can vouch for.
        structural.push(`step ${n}: custom_code changed (always structural)`);
      } else if (!typeChanged && d.type === 'internal_function') {
        const cFn = cCfg && cCfg.function_name;
        const dFn = dCfg && dCfg.function_name;
        if (typeof cFn !== 'string' || typeof dFn !== 'string') {
          // A missing/non-string function_name defeats branch-target
          // extraction entirely (the param lookup keys on it), which made
          // this the one config shape that fell through to content
          // (review II.5). Such a step can't execute anyway — but the
          // classifier's contract is fail-CLOSED, not fail-harmless.
          structural.push(`step ${n}: internal_function without a valid function_name (cannot classify targets)`);
        } else if (cFn !== dFn) {
          structural.push(`step ${n}: function changed (${cFn} → ${dFn})`);
        } else {
          const ct = extractBranchTargets(cCfg, branchTargetParams);
          const dt = extractBranchTargets(dCfg, branchTargetParams);
          if (canonical(ct) !== canonical(dt)) {
            structural.push(`step ${n}: branch target(s) changed`);
          }
          // else: only non-target leaves changed → content
        }
      }
      // webhook (and any other type) config change with same type: content —
      // per the accepted review whitelist for WORKFLOWS ("leaves of config
      // that are not branch targets"). Sequences classify differently (S4).
    }

    changes.push({ step_number: n, kind: 'modified', fields });
  }

  const classification = structural.length ? 'structural' : (changes.length ? 'content_only' : 'identical');
  return { classification, changes, structural_reasons: structural };
}

// ── Retry-ladder budget (background-CPU slice, 2026-08) ──────────────────
// Workflow advances now run request-bound (queued via scheduleResume,
// executed inside the /process-jobs request — see routes/process_jobs.js).
// executeStep's inter-attempt sleeps (`backoffSec * attempt`, linear) are
// therefore in-request wall-clock bounded by Cloud Run's timeoutSeconds.
// An error_policy whose ladder can sleep longer than this budget would blow
// through the request mid-step, orphaning the execution as 'processing'
// until the 15-min recovery sweep. Guarded structurally at step save AND at
// publish (this module) so the config can never ship.
//
// Budget 300s = 1/3 of the 900s request timeout — headroom for the step's
// own attempts plus the rest of the batch. Worst pre-existing prod ladder
// (2026-08): 172s observed — inside budget; guard is non-breaking.
const RETRY_LADDER_BUDGET_SEC = 300;

// Total inter-attempt sleep for a policy, in seconds. MUST mirror
// lib/workflow_engine.js executeStep's defaults exactly:
//   maxRetries = Number(policy.max_retries) || 0
//   backoffSec = Number(policy.backoff_seconds) || 5
// Sleep sequence is backoff*1, backoff*2, ... backoff*maxRetries
// → backoff * mr(mr+1)/2. Null/undefined/non-object policy → 0.
function retryLadderSleepSec(policy) {
  const p = parseMaybeJson(policy);
  if (!p || typeof p !== 'object') return 0;
  const mr = Number(p.max_retries) || 0;
  const backoff = Number(p.backoff_seconds) || 5;
  if (mr <= 0) return 0;
  return backoff * (mr * (mr + 1)) / 2;
}

// ── validateWorkflowDraft(draftSteps, opts) ───────────────────────────────
// opts: { branchTargetParams, isTerminalSentinel }
// Returns { errors, warnings, info } — errors block publish.
function validateWorkflowDraft(draftSteps, opts) {
  const { branchTargetParams, isTerminalSentinel } = opts;
  const errors = [];
  const warnings = [];
  const info = [];

  if (!draftSteps.length) {
    errors.push('draft has no steps');
    return { errors, warnings, info };
  }

  const N = draftSteps.length;
  const numbers = draftSteps.map((s) => s.step_number).sort((a, b) => a - b);
  for (let i = 0; i < N; i++) {
    if (numbers[i] !== i + 1) {
      errors.push(`step numbering is not contiguous 1..${N} (found ${numbers.join(', ')})`);
      break;
    }
  }

  const checkTarget = (stepNumber, path, value, { foreachOwn = null } = {}) => {
    if (value === undefined || value === null) return;
    const iv = asLiteralStep(value);
    if (iv === null) {
      if (!isTerminalSentinel(value)) {
        warnings.push(`step ${stepNumber}: ${path} is non-literal (${JSON.stringify(value)}) — resolved at runtime; confirm it lands on a valid step`);
      }
      return;
    }
    if (iv < 1 || iv > N) {
      errors.push(`step ${stepNumber}: ${path} targets step ${iv}, outside 1..${N}`);
      return;
    }
    if (foreachOwn !== null && iv <= foreachOwn) {
      // In-range is not enough for the loop EXIT — a backwards/self exit is
      // an infinite loop (this param was the proven live foot-gun).
      errors.push(`step ${stepNumber}: foreach.end_step (${iv}) must be greater than the foreach step's own number (${foreachOwn})`);
    }
  };

  for (const s of draftSteps) {
    // Retry-ladder budget (see RETRY_LADDER_BUDGET_SEC above) — applies to
    // every step type; checked before the config parse so a step with a bad
    // policy but unparseable config still surfaces the policy error.
    const ladderSec = retryLadderSleepSec(s.error_policy);
    if (ladderSec > RETRY_LADDER_BUDGET_SEC) {
      errors.push(
        `step ${s.step_number}: error_policy retry sleeps total ${ladderSec}s ` +
        `(backoff_seconds × max_retries·(max_retries+1)/2) — exceeds the ` +
        `${RETRY_LADDER_BUDGET_SEC}s in-request budget; lower max_retries or backoff_seconds`
      );
    }

    const cfg = parseMaybeJson(s.config);
    if (!cfg || typeof cfg !== 'object') continue;

    if (s.type === 'custom_code') {
      if (typeof cfg.code === 'string' && cfg.code.includes('next_step')) {
        info.push(`step ${s.step_number}: custom_code mentions next_step — control flow not statically validated; review manually`);
      }
      continue;
    }
    if (s.type !== 'internal_function') continue;

    const fn = cfg.function_name;
    const params = cfg.params && typeof cfg.params === 'object' ? cfg.params : {};
    const names = branchTargetParams[fn] || [];
    for (const p of names) {
      checkTarget(s.step_number, `${fn}.${p}`, params[p], {
        foreachOwn: fn === 'foreach' && p === 'end_step' ? s.step_number : null,
      });
    }
    if (fn === 'evaluate_condition' && Array.isArray(params.branches)) {
      params.branches.forEach((br, i) => {
        if (br && typeof br === 'object') {
          checkTarget(s.step_number, `evaluate_condition.branches[${i}].then`, br.then);
        }
      });
    }
  }

  return { errors, warnings, info };
}

// ── Sequence classifier (S4) ──────────────────────────────────────────────
// Stricter than the workflow classifier, deliberately (plan-v2 ruling O1):
// sequence steps carry their control surface in COLUMNS (timing, condition,
// fire_guard, error_policy) rather than inside config, and several
// action_types have side effects beyond messaging. Content is ONLY a change
// to action_config leaves when the action_type is an unchanged sms / email /
// task — the payload-text cases. Everything else — action_type itself,
// timing, step condition, fire_guard, error_policy, webhook /
// start_workflow / internal_function config, step count, numbering, and the
// template-level condition — is structural. (Contrast: workflow webhook URL
// changes classify content; sequence webhook config does not. Both follow
// the accepted review whitelists.)
const SEQUENCE_CONTENT_ACTION_TYPES = new Set(['sms', 'email', 'task']);

// diffSequenceSteps(currentSteps, draftSteps, opts)
// opts: { currentCondition, draftCondition } — the two version rows'
// template_condition values (raw or parsed).
function diffSequenceSteps(currentSteps, draftSteps, opts = {}) {
  const changes = [];
  const structural = [];

  const curCond = canonical(parseMaybeJson(opts.currentCondition));
  const draCond = canonical(parseMaybeJson(opts.draftCondition));
  if (curCond !== draCond) {
    changes.push({ step_number: null, kind: 'modified', fields: ['template_condition'] });
    structural.push('template condition changed');
  }

  const cur = new Map(currentSteps.map((s) => [s.step_number, s]));
  const dra = new Map(draftSteps.map((s) => [s.step_number, s]));

  if (currentSteps.length !== draftSteps.length) {
    structural.push(`step count changed (${currentSteps.length} → ${draftSteps.length})`);
  }
  for (const n of dra.keys()) if (!cur.has(n)) { changes.push({ step_number: n, kind: 'added' }); structural.push(`step ${n} added`); }
  for (const n of cur.keys()) if (!dra.has(n)) { changes.push({ step_number: n, kind: 'removed' }); structural.push(`step ${n} removed`); }

  for (const [n, c] of cur) {
    const d = dra.get(n);
    if (!d) continue;

    const fields = [];
    const diffCol = (name) =>
      canonical(parseMaybeJson(c[name])) !== canonical(parseMaybeJson(d[name]));

    const typeChanged = c.action_type !== d.action_type;
    const cfgChanged = diffCol('action_config');
    const timingChanged = diffCol('timing');
    const condChanged = diffCol('condition');
    const guardChanged = diffCol('fire_guard');
    const epChanged = diffCol('error_policy');

    if (!typeChanged && !cfgChanged && !timingChanged && !condChanged && !guardChanged && !epChanged) continue;

    if (typeChanged) { fields.push('action_type'); structural.push(`step ${n}: action_type changed (${c.action_type} → ${d.action_type})`); }
    if (timingChanged) { fields.push('timing'); structural.push(`step ${n}: timing changed`); }
    if (condChanged) { fields.push('condition'); structural.push(`step ${n}: step condition changed`); }
    if (guardChanged) { fields.push('fire_guard'); structural.push(`step ${n}: fire guard changed`); }
    if (epChanged) { fields.push('error_policy'); structural.push(`step ${n}: error_policy changed`); }
    if (cfgChanged) {
      fields.push('action_config');
      if (typeChanged || !SEQUENCE_CONTENT_ACTION_TYPES.has(d.action_type)) {
        structural.push(`step ${n}: ${d.action_type} action_config changed (only sms/email/task payloads classify as content)`);
      }
      // else: sms/email/task payload change with same type → content
    }

    changes.push({ step_number: n, kind: 'modified', fields });
  }

  const classification = structural.length ? 'structural' : (changes.length ? 'content_only' : 'identical');
  return { classification, changes, structural_reasons: structural };
}

// validateSequenceDraftShape(draftSteps) — the synchronous half of the
// sequence publish gate: non-empty + contiguous numbering. The per-step
// timing / action_config validation is async (DB lookups) and runs in the
// route (routes/sequences.js validateTiming / validateStepConfig), appended
// to the errors array this returns.
function validateSequenceDraftShape(draftSteps) {
  const errors = [];
  if (!draftSteps.length) {
    errors.push('draft has no steps');
    return { errors };
  }
  const N = draftSteps.length;
  const numbers = draftSteps.map((s) => s.step_number).sort((a, b) => a - b);
  for (let i = 0; i < N; i++) {
    if (numbers[i] !== i + 1) {
      errors.push(`step numbering is not contiguous 1..${N} (found ${numbers.join(', ')})`);
      break;
    }
  }
  return { errors };
}

module.exports = {
  diffWorkflowSteps,
  validateWorkflowDraft,
  diffSequenceSteps,
  validateSequenceDraftShape,
  SEQUENCE_CONTENT_ACTION_TYPES,
  retryLadderSleepSec,
  RETRY_LADDER_BUDGET_SEC,
  // exported for tests and for canonical-equality checks at call sites
  // (e.g. the sequence PUT's no-op condition guard)
  canonical,
  parseMaybeJson,
  extractBranchTargets,
  asLiteralStep,
};
