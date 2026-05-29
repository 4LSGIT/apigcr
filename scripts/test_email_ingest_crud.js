#!/usr/bin/env node
// scripts/test_email_ingest_crud.js
//
// Integration test for Email Ingest Slice 3.1 CRUD endpoints.
// Drives every new endpoint against a running server and verifies DB state
// between steps via the readonly SQL endpoint. Cleans up after itself.
//
// Usage:
//   EI_JWT="<bearer token>" \
//   EI_BASE="https://app.4lsg.com" \
//   EI_RO_KEY="ycro_..." \
//   node scripts/test_email_ingest_crud.js
//
// Exits non-zero on first failed assertion (after best-effort cleanup).

const BASE   = process.env.EI_BASE   || 'https://app.4lsg.com';
const JWT    = process.env.EI_JWT    || '';
const RO_KEY = process.env.EI_RO_KEY || '';

if (!JWT)    { console.error('EI_JWT is required'); process.exit(2); }
if (!RO_KEY) { console.error('EI_RO_KEY is required'); process.exit(2); }

let passed = 0, failed = 0;
const created = { suppressionId: null, ruleId: null, actionId: null };

function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else      { failed++; console.error('  ✗', msg); }
}

async function api(method, path, body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = `Bearer ${JWT}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: res.status, json };
}

async function rosql(sql, params) {
  const res = await fetch(`${BASE}/api/readonly/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Readonly-Api-Key': RO_KEY },
    body: JSON.stringify({ sql, params }),
  });
  return res.json();
}

async function main() {
  console.log(`\n=== Email Ingest CRUD integration test against ${BASE} ===\n`);

  // ── 1. List suppressions — expect >=2 (court + legacy mimic).
  console.log('1. List suppressions');
  {
    const { status, json } = await api('GET', '/api/email-ingest/suppressions');
    ok(status === 200, `GET suppressions -> 200 (got ${status})`);
    ok(Array.isArray(json?.suppressions) && json.suppressions.length >= 2,
       `>=2 suppressions (got ${json?.suppressions?.length})`);
  }

  // ── 2. POST suppression, GET single, PUT flip active, DELETE, verify gone.
  console.log('2. Suppression create/get/put/delete');
  {
    const create = await api('POST', '/api/email-ingest/suppressions', {
      name: 'CRUD test suppression',
      description: 'temp',
      match_mode: 'conditions',
      match_config: { operator: 'and', conditions: [{ path: 'from.email', op: 'equals', value: 'x@y.z' }] },
    });
    ok(create.status === 201, `POST -> 201 (got ${create.status})`);
    ok(create.json?.suppression?.id, 'created row has id');
    created.suppressionId = create.json?.suppression?.id;
    ok(create.json?.suppression?.active === 1, 'active defaults to 1');

    const single = await api('GET', `/api/email-ingest/suppressions/${created.suppressionId}`);
    ok(single.status === 200 && single.json?.suppression?.name === 'CRUD test suppression', 'GET single matches');

    const upd = await api('PUT', `/api/email-ingest/suppressions/${created.suppressionId}`, { active: 0 });
    ok(upd.status === 200 && upd.json?.suppression?.active === 0, 'PUT active=0 reflected');

    // verify in DB
    const db = await rosql('SELECT active FROM email_ingest_log_suppressions WHERE id = ?', [created.suppressionId]);
    ok(db?.rows?.[0]?.active === 0, 'DB confirms active=0');

    const del = await api('DELETE', `/api/email-ingest/suppressions/${created.suppressionId}`);
    ok(del.status === 204, `DELETE -> 204 (got ${del.status})`);

    const gone = await api('GET', `/api/email-ingest/suppressions/${created.suppressionId}`);
    ok(gone.status === 404, `GET deleted -> 404 (got ${gone.status})`);
    created.suppressionId = null;
  }

  // ── 3. List rules — expect >=1 (sentinel) with actions array.
  console.log('3. List rules');
  {
    const { status, json } = await api('GET', '/api/email-ingest/rules');
    ok(status === 200, `GET rules -> 200 (got ${status})`);
    ok(Array.isArray(json?.rules) && json.rules.length >= 1, `>=1 rule (got ${json?.rules?.length})`);
    ok(json?.rules?.every(r => Array.isArray(r.actions)), 'every rule has actions[] array');
  }

  // ── 4. Rule + action full lifecycle.
  console.log('4. Rule + action lifecycle');
  {
    const create = await api('POST', '/api/email-ingest/rules', {
      name: 'CRUD test rule',
      match_mode: 'conditions',
      match_config: { operator: 'and', conditions: [] },
    });
    ok(create.status === 201, `POST rule -> 201 (got ${create.status})`);
    created.ruleId = create.json?.rule?.id;
    ok(Array.isArray(create.json?.rule?.actions) && create.json.rule.actions.length === 0, 'new rule has empty actions[]');

    const single = await api('GET', `/api/email-ingest/rules/${created.ruleId}`);
    ok(single.status === 200, 'GET single rule -> 200');

    // Add a noop internal_function action (must exist in registry).
    const addAct = await api('POST', `/api/email-ingest/rules/${created.ruleId}/actions`, {
      action_type: 'internal_function',
      config: { function_name: 'noop' },
    });
    ok(addAct.status === 201, `POST action -> 201 (got ${addAct.status}) ${JSON.stringify(addAct.json)}`);
    created.actionId = addAct.json?.action?.id;

    const withAct = await api('GET', `/api/email-ingest/rules/${created.ruleId}`);
    ok(withAct.json?.rule?.actions?.some(a => a.id === created.actionId), 'rule.actions now contains new action');

    const updAct = await api('PUT', `/api/email-ingest/rule-actions/${created.actionId}`, { position: 5 });
    ok(updAct.status === 200 && updAct.json?.action?.position === 5, 'PUT action position=5');

    const delAct = await api('DELETE', `/api/email-ingest/rule-actions/${created.actionId}`);
    ok(delAct.status === 204, `DELETE action -> 204 (got ${delAct.status})`);
    const actGone = await rosql('SELECT COUNT(*) c FROM email_ingest_rule_actions WHERE id = ?', [created.actionId]);
    ok(Number(actGone?.rows?.[0]?.c) === 0, 'DB confirms action deleted');
    created.actionId = null;

    // Re-add an action so we can prove cascade delete on rule delete.
    const addAct2 = await api('POST', `/api/email-ingest/rules/${created.ruleId}/actions`, {
      action_type: 'internal_function', config: { function_name: 'noop' },
    });
    const cascadeActionId = addAct2.json?.action?.id;

    const updRule = await api('PUT', `/api/email-ingest/rules/${created.ruleId}`, { active: 0 });
    ok(updRule.status === 200 && updRule.json?.rule?.active === 0, 'PUT rule active=0');

    const delRule = await api('DELETE', `/api/email-ingest/rules/${created.ruleId}`);
    ok(delRule.status === 204, `DELETE rule -> 204 (got ${delRule.status})`);

    const ruleGone = await rosql('SELECT COUNT(*) c FROM email_ingest_rules WHERE id = ?', [created.ruleId]);
    ok(Number(ruleGone?.rows?.[0]?.c) === 0, 'DB confirms rule deleted');
    const cascGone = await rosql('SELECT COUNT(*) c FROM email_ingest_rule_actions WHERE id = ?', [cascadeActionId]);
    ok(Number(cascGone?.rows?.[0]?.c) === 0, 'DB confirms action cascade-deleted');
    created.ruleId = null;
  }

  // ── 5. List executions default page — pagination shape.
  console.log('5. List executions (default)');
  {
    const { status, json } = await api('GET', '/api/email-ingest/executions');
    ok(status === 200, `GET executions -> 200 (got ${status})`);
    ok(Array.isArray(json?.executions), 'executions is array');
    ok(typeof json?.total === 'number' && json.page === 1 && json.page_size === 50,
       `shape: page=${json?.page} page_size=${json?.page_size} total=${json?.total}`);
    ok(json?.executions?.length <= 50, 'page_size honored');
    ok(!json?.executions?.length || 'source_name' in json.executions[0], 'rows carry source_name');
  }

  // ── 6. Filter by status=skipped_suppression — expect >=5.
  console.log('6. Executions ?status=skipped_suppression');
  {
    const { status, json } = await api('GET', '/api/email-ingest/executions?status=skipped_suppression&page_size=200');
    ok(status === 200, `-> 200 (got ${status})`);
    ok(json?.executions?.every(e => e.status === 'skipped_suppression'), 'all rows match status filter');
    ok(json?.total >= 5, `>=5 skipped_suppression (got ${json?.total})`);
  }

  // ── 7. Filter has_match=true.
  console.log('7. Executions ?has_match=true');
  {
    const { status, json } = await api('GET', '/api/email-ingest/executions?has_match=true&page_size=200');
    ok(status === 200, `-> 200 (got ${status})`);
    ok(json?.total >= 1, `>=1 matched (got ${json?.total})`);
  }

  // ── 8. Single execution with matched_rules — linked.matched_rule_details hydrated.
  console.log('8. Single execution + linked hydration');
  {
    const probe = await rosql(
      `SELECT id FROM email_ingest_executions
        WHERE metadata->>'$.matched_rules' IS NOT NULL ORDER BY id DESC LIMIT 1`
    );
    const execId = probe?.rows?.[0]?.id;
    if (!execId) {
      ok(false, 'no execution with matched_rules to probe (skipped)');
    } else {
      const { status, json } = await api('GET', `/api/email-ingest/executions/${execId}`);
      ok(status === 200, `GET execution ${execId} -> 200 (got ${status})`);
      ok(json?.execution?.id, 'has execution');
      ok('linked' in json, 'has linked block');
      ok(Array.isArray(json?.linked?.matched_rule_details) && json.linked.matched_rule_details.length >= 1,
         'matched_rule_details hydrated');
      ok(json?.linked?.matched_rule_details?.every(d => 'id' in d && 'name' in d),
         'each detail has {id,name}');
    }
  }

  // ── 9. Meta.
  console.log('9. GET meta');
  {
    const { status, json } = await api('GET', '/api/email-ingest/meta');
    ok(status === 200, `-> 200 (got ${status})`);
    ok(Array.isArray(json?.match_operators) && json.match_operators.length === 15, `15 operators (got ${json?.match_operators?.length})`);
    ok(Array.isArray(json?.transform_modes) && json.transform_modes.length === 3, '3 transform_modes');
    ok(Array.isArray(json?.action_types) && json.action_types.length === 5, '5 action_types');
    ok(json?.action_types?.every(t => t.config_schema_hint), 'every action_type has config_schema_hint');
    ok(json?.targets && Array.isArray(json.targets.workflows), 'targets.workflows array');
    ok(Array.isArray(json?.targets?.hooks), 'targets.hooks array');
    ok(Array.isArray(json?.targets?.sequences), 'targets.sequences array');
    ok(Array.isArray(json?.targets?.credentials), 'targets.credentials array');
    ok(Array.isArray(json?.targets?.internal_functions) &&
       !json.targets.internal_functions.some(n => n.startsWith('__')),
       'internal_functions present and no __ helpers leaked');
    ok(Array.isArray(json?.execution_statuses) && json.execution_statuses.length === 7, '7 execution_statuses');
  }

  // ── 10. Validation: conditions + null config -> 400 structured.
  console.log('10. Validation: suppression conditions+null config');
  {
    const { status, json } = await api('POST', '/api/email-ingest/suppressions', {
      name: 'bad', match_mode: 'conditions', match_config: null,
    });
    ok(status === 400, `-> 400 (got ${status})`);
    ok(json?.error === 'validation_failed', 'error=validation_failed');
    ok(json?.field === 'match_config' || json?.errors?.some(e => e.field === 'match_config'),
       'flags match_config');
  }

  // ── 11. Validation: workflow action w/ bad workflow_id -> 400.
  console.log('11. Validation: action workflow_id=999999');
  {
    // need a rule to attach to
    const r = await api('POST', '/api/email-ingest/rules', {
      name: 'CRUD test rule v', match_mode: 'conditions', match_config: { operator: 'and', conditions: [] },
    });
    const rid = r.json?.rule?.id;
    const { status, json } = await api('POST', `/api/email-ingest/rules/${rid}/actions`, {
      action_type: 'workflow', config: { workflow_id: 999999 },
    });
    ok(status === 400, `-> 400 (got ${status})`);
    ok(json?.field === 'config.workflow_id' || json?.errors?.some(e => e.field === 'config.workflow_id'),
       'flags config.workflow_id');
    await api('DELETE', `/api/email-ingest/rules/${rid}`); // cleanup
  }

  // ── 12. Validation: internal_function nonexistent -> 400.
  console.log('12. Validation: internal_function nonexistent');
  {
    const r = await api('POST', '/api/email-ingest/rules', {
      name: 'CRUD test rule v2', match_mode: 'conditions', match_config: { operator: 'and', conditions: [] },
    });
    const rid = r.json?.rule?.id;
    const { status, json } = await api('POST', `/api/email-ingest/rules/${rid}/actions`, {
      action_type: 'internal_function', config: { function_name: 'definitely_not_a_real_function' },
    });
    ok(status === 400, `-> 400 (got ${status})`);
    ok(json?.field === 'config.function_name' || json?.errors?.some(e => e.field === 'config.function_name'),
       'flags config.function_name');
    await api('DELETE', `/api/email-ingest/rules/${rid}`); // cleanup
  }

  // ── 13. Auth: no JWT -> 401.
  console.log('13. Auth: no JWT');
  {
    const { status } = await api('GET', '/api/email-ingest/suppressions', undefined, { auth: false });
    ok(status === 401, `-> 401 (got ${status})`);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
}

async function cleanup() {
  // Best-effort: remove anything we created if a step threw mid-flight.
  try {
    if (created.actionId)      await api('DELETE', `/api/email-ingest/rule-actions/${created.actionId}`);
    if (created.ruleId)        await api('DELETE', `/api/email-ingest/rules/${created.ruleId}`);
    if (created.suppressionId) await api('DELETE', `/api/email-ingest/suppressions/${created.suppressionId}`);
  } catch (e) { console.error('cleanup error:', e.message); }
}

main()
  .catch(err => { console.error('FATAL:', err); failed++; })
  .finally(async () => {
    await cleanup();
    process.exit(failed > 0 ? 1 : 0);
  });