#!/usr/bin/env node
/* eslint-disable no-console */
//
// scripts/test_dispatcher_extraction.js
//
// Slice 2.2 replay / equivalence test.
//
// Goal: prove the four dispatchers behave IDENTICALLY before and after the
// extraction into lib/actionDispatchers.js — same logData return for the same
// (target, targetOutput) inputs, across all four target types plus the error
// branches.
//
// Why a synthetic battery instead of live replay: the live RingCentral/Quo
// hooks (the dominant production traffic) dispatch to WORKFLOWS, which mutate
// workflow_executions. Re-firing real raw_input against prod would create
// duplicate executions and enroll real contacts. So we instead drive BOTH the
// pre-refactor code (services/hookServiceOriginal_dispatchers.js — a verbatim
// lift of the original region) and the post-refactor code
// (lib/actionDispatchers.js) with the SAME stubbed engines + stubbed fetch, and
// assert byte-identical logData. If the two code paths agree on every input,
// the extraction changed nothing observable.
//
// A SEPARATE live-data check (read-only) is in the companion shell script;
// this JS harness is the deterministic, CI-able proof.
//
// Run: node scripts/test_dispatcher_extraction.js
// Exit 0 = all pass, 1 = any divergence.

const assert = require('assert');

// ── Stub node-fetch BEFORE requiring the dispatchers (both share the cache) ──
const Module = require('module');
const realResolve = Module._resolveFilename;
const fetchCalls = [];
function fakeFetch(url, opts) {
  fetchCalls.push({ url, opts });
  // Deterministic 200 with a small JSON body. response.ok = true.
  return Promise.resolve({
    ok: true,
    status: 200,
    async text() { return JSON.stringify({ echoed: true, url }); },
  });
}
// Intercept require('node-fetch') for both modules.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') return fakeFetch;
  return origLoad.apply(this, arguments);
};

const original = require('../services/hookServiceOriginal_dispatchers.js');
const refactored = require('../lib/actionDispatchers.js');

// ── Fake DB ──────────────────────────────────────────────────────────────
// deliverWorkflow does: SELECT default_contact_id_from FROM workflows; INSERT
// workflow_executions (returns insertId). We return deterministic values so
// both code paths see the same thing.
let insertSeq = 1000;
function makeDb() {
  insertSeq = 1000; // reset per run so original & refactored get same insertIds
  return {
    async query(sql, params) {
      if (/FROM workflows WHERE id/.test(sql)) {
        return [[{ default_contact_id_from: 'contact_id' }]];
      }
      if (/INSERT INTO workflow_executions/.test(sql)) {
        return [{ insertId: ++insertSeq }];
      }
      return [[]];
    },
  };
}

// ── Test inputs ─────────────────────────────────────────────────────────
// Each case: a target row + the (already transform-applied) targetOutput.
// We run them through the ORIGINAL deliverToTarget and the NEW dispatch, then
// deep-compare the returned logData.

const cases = [
  // ---- HTTP ----
  {
    name: 'http: json body, POST, no credential',
    target: { id: 1, target_type: 'http', url: 'https://example.test/hook', method: 'POST',
              body_mode: 'json', headers: { 'X-Static': 'a' }, transform_mode: 'passthrough' },
    output: { a: 1, b: 'two' },
  },
  {
    name: 'http: template body',
    target: { id: 2, target_type: 'http', url: 'https://example.test/t', method: 'POST',
              body_mode: 'template', body_template: '{"name":"{{name}}"}', transform_mode: 'passthrough' },
    output: { name: 'Fred' },
  },
  {
    name: 'http: GET (no body)',
    target: { id: 3, target_type: 'http', url: 'https://example.test/g', method: 'GET',
              transform_mode: 'passthrough' },
    output: { ignored: true },
  },
  {
    name: 'http: headers as JSON string',
    target: { id: 4, target_type: 'http', url: 'https://example.test/h', method: 'POST',
              headers: '{"X-From-String":"y"}', transform_mode: 'passthrough' },
    output: { x: 1 },
  },
  // ---- WORKFLOW ----
  {
    name: 'workflow: valid, contact resolves from default key',
    target: { id: 10, target_type: 'workflow', config: { workflow_id: 7 }, transform_mode: 'passthrough' },
    output: { contact_id: 42, foo: 'bar' },
  },
  {
    name: 'workflow: missing workflow_id → failed',
    target: { id: 11, target_type: 'workflow', config: {}, transform_mode: 'passthrough' },
    output: { contact_id: 42 },
  },
  {
    name: 'workflow: config as JSON string',
    target: { id: 12, target_type: 'workflow', config: '{"workflow_id":9}', transform_mode: 'passthrough' },
    output: { contact_id: 1 },
  },
  // ---- SEQUENCE ----
  {
    name: 'sequence: by template_type',
    target: { id: 20, target_type: 'sequence',
              config: { template_type: 'welcome', contact_id_field: 'contact_id', trigger_data_fields: ['case_type'] },
              transform_mode: 'passthrough' },
    output: { contact_id: 5, case_type: 'ch7' },
  },
  {
    name: 'sequence: by template_id',
    target: { id: 21, target_type: 'sequence',
              config: { template_id: 3, contact_id_field: 'body.cid', trigger_data_fields: ['body.appt_id'] },
              transform_mode: 'passthrough' },
    output: { body: { cid: 8, appt_id: 99 } },
  },
  {
    name: 'sequence: missing contact_id → failed',
    target: { id: 22, target_type: 'sequence', config: { template_type: 'welcome' }, transform_mode: 'passthrough' },
    output: { nope: true },
  },
  {
    name: 'sequence: missing both template fields → failed',
    target: { id: 23, target_type: 'sequence', config: { contact_id_field: 'contact_id' }, transform_mode: 'passthrough' },
    output: { contact_id: 5 },
  },
  // ---- INTERNAL FUNCTION ----
  {
    name: 'internal_function: valid call',
    target: { id: 30, target_type: 'internal_function',
              config: { function_name: 'log_receipt', params_mapping: { kind: "'sms'", cid: 'contact_id' } },
              transform_mode: 'passthrough' },
    output: { contact_id: 7 },
  },
  {
    name: 'internal_function: missing function_name → failed',
    target: { id: 31, target_type: 'internal_function', config: { params_mapping: {} }, transform_mode: 'passthrough' },
    output: { contact_id: 7 },
  },
  {
    name: 'internal_function: unknown function → failed',
    target: { id: 32, target_type: 'internal_function', config: { function_name: 'does_not_exist' }, transform_mode: 'passthrough' },
    output: {},
  },
  {
    name: 'internal_function: throwing function → failed (catch path)',
    target: { id: 33, target_type: 'internal_function', config: { function_name: 'boom' }, transform_mode: 'passthrough' },
    output: {},
  },
  // ---- UNKNOWN TYPE ----
  {
    name: 'unknown target_type → failed',
    target: { id: 40, target_type: 'frobnicate', transform_mode: 'passthrough' },
    output: { z: 1 },
  },
];

// The original code path is deliverToTarget(target, hookTransformOutput, db)
// — it runs the target transform then dispatches. The new path is
// dispatch(db, type, config, input, {target}) where the CALLER (hookService's
// new deliverToTarget) has already run the transform and parsed config. To
// compare apples-to-apples we replicate the new hookService.deliverToTarget
// wrapper here: run the SAME transform via the original's runTransform, then
// call dispatch.

function newDeliverToTarget(target, hookTransformOutput, db) {
  const { output: targetOutput } = original.runTransform(
    target.transform_mode, target.transform_config, hookTransformOutput
  );
  const targetType = target.target_type || 'http';
  const targetConfig = refactored.parseTargetConfig(target);
  return refactored.dispatch(db, targetType, targetConfig, targetOutput, { target })
    .then((r) => r.result);
}

(async () => {
  let pass = 0, fail = 0;
  const failures = [];

  for (const c of cases) {
    // Clone targets/outputs per run to avoid cross-contamination.
    const t1 = JSON.parse(JSON.stringify(c.target));
    const t2 = JSON.parse(JSON.stringify(c.target));
    const o1 = JSON.parse(JSON.stringify(c.output));
    const o2 = JSON.parse(JSON.stringify(c.output));

    let origOut, newOut, err;
    try {
      origOut = await original.deliverToTarget(t1, o1, makeDb());
      newOut = await newDeliverToTarget(t2, o2, makeDb());
    } catch (e) {
      err = e;
    }

    if (err) {
      fail++;
      failures.push({ name: c.name, reason: 'threw: ' + err.message });
      console.log(`FAIL  ${c.name}  (threw: ${err.message})`);
      continue;
    }

    // For workflow success, the request_url + response_body embed the insertId.
    // Both paths use makeDb() which resets insertSeq, so insertId is identical
    // (1001) for both — they should match exactly. Verify rather than mask.
    try {
      assert.deepStrictEqual(newOut, origOut);
      pass++;
      console.log(`PASS  ${c.name}  [status=${origOut.status}]`);
    } catch (e) {
      fail++;
      failures.push({ name: c.name, orig: origOut, neu: newOut });
      console.log(`FAIL  ${c.name}`);
      console.log('  original:', JSON.stringify(origOut));
      console.log('  new     :', JSON.stringify(newOut));
    }
  }

  console.log(`\n${pass}/${pass + fail} passed.`);
  if (fail) {
    console.log('\nDIVERGENCES:');
    for (const f of failures) console.log(' -', f.name, f.reason || '');
    process.exit(1);
  }
  process.exit(0);
})();