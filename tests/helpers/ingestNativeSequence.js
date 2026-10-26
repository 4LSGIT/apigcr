// tests/helpers/ingestNativeSequence.js
//
/**
 * The NATIVE ingest-rule management call sequence (no expected_base — what
 * public/automation/emailIngest.html and phoneIngest.html send), and the
 * normalizer that makes its responses comparable across runs.
 *
 * Used twice, so both runs are the same calls by construction:
 *   - recorded ONCE against the pre-A20-slice-1 code (base 2c1c86a) into
 *     tests/fixtures/ingestNativeGolden.json;
 *   - replayed by tests/ingestRuleChangeLog.mysql.test.js against the current
 *     code, which must produce the same bodies once `definition_updated_at`
 *     (the one added key) is checked and stripped.
 *
 * Normalization: ids → '#1', '#2'… in order of first appearance (rule and
 * action ids share one map, keyed by kind); created_at / updated_at /
 * last_matched_at → '<ts>' when set. Nothing else is touched.
 */

'use strict';

const http = require('http');
const express = require('express');

const COND = { operator: 'and', conditions: [{ path: 'subject', op: 'contains', value: 'Golden' }] };
const MAPPER = [{ from: 'subject', to: 'title' }];
const MISSING = 987654;

/** Serve `router` on an ephemeral port with req.db = db; returns { send, close }. */
async function mount(router, db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const send = (method, urlPath, payload) => new Promise((resolve, reject) => {
    const data = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (r) => {
      let raw = '';
      r.on('data', (c) => { raw += c; });
      r.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = { __raw: raw }; }
        resolve({ status: r.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
  const close = () => new Promise((r) => server.close(r));
  return { send, close };
}

async function runNativeSequence(send, ch, { workflowId }) {
  const base = `/api/${ch}-ingest`;
  const steps = [];
  const step = async (name, method, urlPath, body) => {
    const r = await send(method, urlPath, body);
    steps.push({ step: name, status: r.status, body: r.body });
    return r;
  };

  const c = await step('create', 'POST', `${base}/rules`, {
    name: `${ch} golden`, description: 'd', active: 0, position: 5,
    match_mode: 'conditions', match_config: COND, transform_mode: 'mapper', transform_config: MAPPER,
  });
  const id = c.body && c.body.rule && c.body.rule.id;
  await step('get', 'GET', `${base}/rules/${id}`);
  await step('update', 'PUT', `${base}/rules/${id}`, { name: `${ch} golden renamed`, active: 1 });
  await step('update-noop', 'PUT', `${base}/rules/${id}`, { name: `${ch} golden renamed`, active: 1 });
  await step('update-invalid', 'PUT', `${base}/rules/${id}`, { match_mode: 'regex' });
  await step('update-invalid-name', 'PUT', `${base}/rules/${id}`, { name: '' });
  await step('update-missing', 'PUT', `${base}/rules/${MISSING}`, { name: 'x' });
  const a = await step('action-add', 'POST', `${base}/rules/${id}/actions`,
    { action_type: 'workflow', config: { workflow_id: workflowId }, name: 'wf' });
  const aid = a.body && a.body.action && a.body.action.id;
  await step('action-add-badref', 'POST', `${base}/rules/${id}/actions`,
    { action_type: 'workflow', config: { workflow_id: MISSING } });
  await step('action-add-missing-rule', 'POST', `${base}/rules/${MISSING}/actions`,
    { action_type: 'workflow', config: { workflow_id: workflowId } });
  await step('action-update', 'PUT', `${base}/rule-actions/${aid}`, { name: 'wf2', position: 3 });
  await step('action-update-empty', 'PUT', `${base}/rule-actions/${aid}`, {});
  await step('action-update-badref', 'PUT', `${base}/rule-actions/${aid}`, { config: { workflow_id: MISSING } });
  await step('action-update-missing', 'PUT', `${base}/rule-actions/${MISSING}`, { name: 'x' });
  const d = await step('duplicate', 'POST', `${base}/rules/${id}/duplicate`, {});
  await step('duplicate-missing', 'POST', `${base}/rules/${MISSING}/duplicate`, {});
  await step('list', 'GET', `${base}/rules`);
  await step('action-delete', 'DELETE', `${base}/rule-actions/${aid}`);
  await step('action-delete-missing', 'DELETE', `${base}/rule-actions/${aid}`);
  await step('delete-dup', 'DELETE', `${base}/rules/${d.body && d.body.rule && d.body.rule.id}`);
  await step('delete', 'DELETE', `${base}/rules/${id}`);
  await step('delete-missing', 'DELETE', `${base}/rules/${id}`);
  return steps;
}

const TS_KEYS = new Set(['created_at', 'updated_at', 'last_matched_at']);

/**
 * Normalize a recorded step list. `stamps` collects every
 * definition_updated_at seen (then removed), so a caller can assert on them.
 */
function normalize(steps, { stamps = [] } = {}) {
  const ids = new Map();
  const tok = (v) => {
    const k = String(v);
    if (!ids.has(k)) ids.set(k, `#${ids.size + 1}`);
    return ids.get(k);
  };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'definition_updated_at') { stamps.push(x); continue; }
        if ((k === 'id' || k === 'rule_id') && x != null) out[k] = tok(x);
        else if (TS_KEYS.has(k) && x != null) out[k] = '<ts>';
        else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return steps.map((s) => ({ step: s.step, status: s.status, body: walk(s.body) }));
}

module.exports = { mount, runNativeSequence, normalize, COND, MAPPER, MISSING };
