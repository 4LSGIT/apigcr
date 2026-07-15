#!/usr/bin/env node
/**
 * scripts/verify_strictstring_live.js  (worker tool — NOT tracked)
 *
 * The sweep proves no whole CONFIG is newly blocked. This proves the stronger
 * claim the ruling asked for: no live config passes a NUMBER (or any non-string
 * non-placeholder) to ANY of the nine strictString param instances — regardless
 * of whether that config also fails for some unrelated reason. Walks every live
 * internal_function config, reads the actual stored value at each strictString
 * param, and reports its JS type.
 *
 *   YC_RO_KEY=… node scripts/verify_strictstring_live.js
 */
const KEY = process.env.YC_RO_KEY;
if (!KEY) { console.error('set YC_RO_KEY'); process.exit(1); }
const IF = require('../lib/internal_functions');

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

// Build the strictString param set straight from the registry — no hardcoded
// list to drift.
const STRICT = new Map(); // fn -> Set(paramName)
for (const [fn, meta] of Object.entries(IF.__getAllMeta())) {
  for (const p of meta.params || []) {
    if (p.strictString) {
      if (!STRICT.has(fn)) STRICT.set(fn, new Set());
      STRICT.get(fn).add(p.name);
    }
  }
}

(async () => {
  console.log('strictString params in registry:');
  for (const [fn, set] of STRICT) console.log(`  ${fn}: ${[...set].join(', ')}`);
  console.log('');

  const steps = await sql(`
    SELECT s.workflow_id, s.step_number, s.config
    FROM workflow_steps s WHERE s.type='internal_function'
  `);
  const jobs = await sql(`
    SELECT id, data FROM scheduled_jobs
    WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.type'))='internal_function'
  `);

  const rows = [];
  const scan = (label, fn, params) => {
    const set = STRICT.get(fn);
    if (!set || !params) return;
    for (const name of set) {
      if (!(name in params)) continue;
      const v = params[name];
      rows.push({ label, fn, name, type: Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v), value: v });
    }
  };

  for (const s of steps) { const c = asJson(s.config) || {}; scan(`wf${s.workflow_id} s${s.step_number}`, c.function_name, c.params); }
  for (const j of jobs)  { const d = asJson(j.data)   || {}; scan(`job${j.id}`, d.function_name, d.params); }

  console.log(`live values found on strictString params: ${rows.length}`);
  for (const r of rows) {
    const disp = JSON.stringify(r.value);
    console.log(`  ${r.label.padEnd(10)} ${r.fn.padEnd(12)} ${r.name.padEnd(14)} ${r.type.padEnd(8)} ${disp && disp.length>50?disp.slice(0,47)+'…':disp}`);
  }
  console.log('');

  const bad = rows.filter(r => r.type !== 'string');
  if (bad.length === 0) {
    console.log('PASS — every live strictString value is a string. No number reaches any of the nine.');
  } else {
    console.log(`FAIL — ${bad.length} live strictString value(s) are NOT strings:`);
    for (const b of bad) console.log(`  ${b.label} ${b.fn}.${b.name} = ${JSON.stringify(b.value)} (${b.type})`);
    process.exitCode = 2;
  }
})();
