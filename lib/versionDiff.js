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
// opts: { branchTargetParams }  (required)
// Returns { classification: 'identical'|'content_only'|'structural',
//           changes: [{ step_number, kind, fields }],
//           structural_reasons: [string] }
function diffWorkflowSteps(currentSteps, draftSteps, opts) {
  const { branchTargetParams } = opts;
  const changes = [];
  const structural = [];

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
      if (!typeChanged && d.type === 'custom_code') {
        // Any change to a custom_code step is structural — config.code can
        // carry next_step control flow no whitelist can vouch for.
        structural.push(`step ${n}: custom_code changed (always structural)`);
      } else if (!typeChanged && d.type === 'internal_function') {
        const cFn = cCfg && cCfg.function_name;
        const dFn = dCfg && dCfg.function_name;
        if (cFn !== dFn) {
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
  // exported for tests and for canonical-equality checks at call sites
  // (e.g. the sequence PUT's no-op condition guard)
  canonical,
  parseMaybeJson,
  extractBranchTargets,
  asLiteralStep,
};
