#!/usr/bin/env node
/**
 * scripts/sweep_validate_live.js  (worker tool — NOT tracked/deployed)
 *
 * Pulls every LIVE internal_function config from the readonly SQL API and runs
 * it through internalFunctions.__validateFunctionParams — the exact function
 * the save routes call (routes/workflows.js:837/969/1442/1555,
 * routes/scheduled_jobs.js:161/488). Any row it reports is a config that would
 * 400 on save today.
 *
 * COLLECT-ALL: the real validator short-circuits on the first error, which
 * hides co-occurring failures on the same step. So we ALSO re-run each
 * provided param through the same code path in isolation (single-spec mini
 * meta) to enumerate every failing param. `BLOCKED` counts configs; `failing
 * params` counts individual bad params.
 *
 * usage:  YC_RO_KEY=ycro_… node scripts/sweep_validate_live.js [--json] [--values]
 */
const KEY = process.env.YC_RO_KEY;
if (!KEY) { console.error('set YC_RO_KEY'); process.exit(1); }

const IF = require('../lib/internal_functions');
const vMeta = IF.__validateParamsAgainstMeta;

async function sql(q) {
  const r = await fetch('https://app.4lsg.com/api/readonly/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Readonly-Api-Key': KEY },
    body: JSON.stringify({ sql: q }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(JSON.stringify(j));
  return j.rows;
}

const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const isNullish = (v) => v === undefined || v === null || v === '';
const show = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 70 ? s.slice(0, 67) + '…' : s;
};

/** Every failing param on a config, not just the first. */
function diagnose(fnName, params) {
  const meta = IF.__getMeta(fnName);
  const out = [];
  if (!meta) return out;

  // 1. Whole-config pass (groups, required, phase-2 parse checks).
  const full = IF.__validateFunctionParams(fnName, params);

  // 2. Per-param isolation pass — reuses the real per-spec type code path.
  const p = params || {};
  const perParam = [];
  for (const spec of meta.params || []) {
    if (!(spec.name in p) || isNullish(p[spec.name])) continue;
    const e = vMeta({ params: [spec] }, { [spec.name]: p[spec.name] });
    if (e) perParam.push({ param: spec.name, type: spec.type, error: e.error, value: p[spec.name] });
  }
  out.push(...perParam);

  // 3. If the whole-config error isn't explained by a per-param error, it's a
  //    group / required / phase-2 failure — surface it separately.
  if (full && !perParam.some(x => full.error.startsWith(x.param + ':'))) {
    out.push({ param: '(config)', type: '-', error: full.error, value: undefined });
  }
  return out;
}

(async () => {
  const steps = await sql(`
    SELECT s.id, s.workflow_id, s.step_number, s.config, w.name AS wf_name, w.active
    FROM workflow_steps s
    JOIN workflows w ON w.id = s.workflow_id
    WHERE s.type = 'internal_function'
    ORDER BY s.workflow_id, s.step_number
  `);

  const jobs = await sql(`
    SELECT id, name AS job_name, data, active
    FROM scheduled_jobs
    WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.type')) = 'internal_function'
    ORDER BY id
  `);

  const fails = [];
  for (const s of steps) {
    const cfg = asJson(s.config) || {};
    const errs = diagnose(cfg.function_name, cfg.params);
    if (errs.length) {
      fails.push({ kind: 'wf', label: `wf${s.workflow_id} s${s.step_number}`,
        active: s.active, fn: cfg.function_name, errs, wf: s.workflow_id });
    }
  }
  for (const j of jobs) {
    const d = asJson(j.data) || {};
    const errs = diagnose(d.function_name, d.params);
    if (errs.length) {
      fails.push({ kind: 'job', label: `job${j.id}`, active: j.active,
        fn: d.function_name, errs, wf: null });
    }
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(fails, null, 2));
    return;
  }

  const wfFails  = fails.filter(f => f.kind === 'wf');
  const jobFails = fails.filter(f => f.kind === 'job');
  const errCount = fails.reduce((n, f) => n + f.errs.length, 0);
  const showVals = process.argv.includes('--values');

  console.log(`internal_function workflow steps : ${steps.length}`);
  console.log(`internal_function scheduled jobs : ${jobs.length}`);
  console.log(`BLOCKED workflow steps           : ${wfFails.length}`);
  console.log(`BLOCKED scheduled jobs           : ${jobFails.length}`);
  console.log(`failing params (all, not just 1st): ${errCount}`);
  console.log('');
  for (const f of fails) {
    for (const e of f.errs) {
      const val = showVals ? `   <= ${show(e.value)}` : '';
      console.log(`${f.label.padEnd(11)}${String(f.fn).padEnd(20)}${String(e.param).padEnd(12)}${String(e.type).padEnd(9)}${e.error}${val}`);
    }
  }
  console.log('');
  const wfSet = [...new Set(wfFails.map(f => f.wf))].sort((a, b) => a - b);
  console.log(`distinct workflows edit-locked   : ${wfSet.length} -> ${wfSet.join(', ')}`);
})();
