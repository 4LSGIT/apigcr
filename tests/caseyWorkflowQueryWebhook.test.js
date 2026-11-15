'use strict';
/**
 * tests/caseyWorkflowQueryWebhook.test.js
 *
 * A17.4a / A17.4b — Casey authors query_db and webhook steps through the
 * workflow kinds (workflow.draft.v1, workflow.step_insert.v1,
 * workflow.step_edit.v1), under the plan's narrow contracts
 * (ref/ASK_CASEY_ACTIONS_PLAN.md A17.4a / A17.4b):
 *
 *   query_db — the model never supplies a query string; the normalizer
 *     builds the structure field by field: tables from the function's own
 *     allowlist, every column as ref.column against the LIVE columns of its
 *     table (information_schema), blocked columns refused in every position,
 *     operators and join types from the function's closed sets, the limit
 *     bounded; a shape it cannot fully check is refused. The card shows the
 *     table, the columns, each predicate in words, the limit, "reads only".
 *
 *   webhook — the URL is literal https, never templated, and in the user's
 *     own message or (no query string) on a host an existing step of the SAME
 *     workflow or a stored credential holds; auth only through a credential
 *     the user names by label (or this workflow's existing pair), never a new
 *     host paired with an existing credential, no header values; explicit
 *     method; timeout defaults to 15 s. The card shows the full URL, method,
 *     credential LABEL, body + A17.2 dry run, timeout, leaves-the-firm and
 *     the retry fact.
 *
 * Stub pool: information_schema answers from COLS, credentials from CREDS —
 * no real engine (the information_schema read is pinned on MySQL 8.4 by
 * tests/caseyQueryDbColumns.mysql.test.js).
 *
 *   npx jest tests/caseyWorkflowQueryWebhook.test.js
 */

const fs = require('fs');
const path = require('path');
const { normalizeActionDraft } = require(path.join(__dirname, '..', 'services', 'assistantService'));
const allowlist = require(path.join(__dirname, '..', 'lib', 'caseyAutomationAllowlist'));
const { stepFingerprint } = require(path.join(__dirname, '..', 'lib', 'versionDiff'));

const COLS = {
  cases: ['case_id', 'case_number', 'case_status', 'case_open_date', 'custom'],
  contacts: ['contact_id', 'contact_name', 'contact_email', 'custom'],
  case_relate: ['case_relate_id', 'case_relate_case_id', 'case_relate_client_id', 'case_relate_type'],
  users: ['user', 'user_name', 'password', 'password_hash', 'reset_token'],
};
const CREDS = [
  { id: 3, name: 'Zap Key', type: 'bearer', allowed_urls: '["https://hooks.zapier.com/*"]' },
  { id: 4, name: 'Loose Bearer', type: 'bearer', allowed_urls: null },
  { id: 5, name: 'Self', type: 'internal', allowed_urls: null },
];

const WF_ROW = { id: 27, name: 'Deadline chase', active: 1, current_version: 3, draft_version: 4 };
const BASE_ROWS = () => [
  { step_number: 1, type: 'internal_function', label: 'Find', note: null,
    config: JSON.stringify({ function_name: 'lookup_contact', params: { contact_id: '{{contact_id}}' } }), error_policy: null },
  { step_number: 2, type: 'webhook', label: 'Notify vendor', note: null,
    config: JSON.stringify({ url: 'https://api.vendor.example.com/v1/notify?token=SECRETTOKEN', method: 'POST',
      credential_id: 4, body: { id: '{{contact_id}}' } }),
    error_policy: JSON.stringify({ strategy: 'retry_then_ignore', max_retries: 1, backoff_seconds: 5 }) },
  { step_number: 3, type: 'internal_function', label: 'Read case', note: null,
    config: JSON.stringify({ function_name: 'query_db', set_vars: { n: '{{this.count}}' },
      params: { select: ['cases.case_number'], from: 'cases', where: [{ column: 'cases.case_id', op: '=', value: '{{caseId}}' }],
        where_mode: 'and', limit: 1, format: 'first', output_var: 'caseRow' } }), error_policy: null },
  { step_number: 4, type: 'webhook', label: 'Headers', note: null,
    config: JSON.stringify({ url: 'https://hdr.example.com/x', method: 'POST', headers: { Authorization: 'Bearer LITERAL' } }), error_policy: null },
];

function db({ rows = BASE_ROWS(), creds = CREDS } = {}) {
  return { query: jest.fn(async (sql, params) => {
    if (/FROM information_schema\.COLUMNS/.test(sql)) {
      return [params[0].flatMap((t) => (COLS[t] || []).map((c) => ({ table_name: t, column_name: c })))];
    }
    if (/SELECT id, name, type, allowed_urls FROM credentials/.test(sql)) return [creds.map((c) => ({ ...c }))];
    if (/SELECT id FROM workflows WHERE name/.test(sql)) return [[]];
    if (/SELECT id, name, active, current_version, draft_version FROM workflows/.test(sql)) return [params[0] === 27 ? [{ ...WF_ROW }] : []];
    if (/FROM workflow_steps WHERE workflow_id = \? AND version = \?/.test(sql)) return [rows.map((r) => ({ ...r }))];
    throw new Error(`db touched: ${sql}`);
  }) };
}

const EVIDENCE = [{ id: 'q1', label: 'Workflow 27 definition', rows: [{ workflow_id: 27, step_number: 1, row_number: 1 }] }];
const CITE = [{ query_id: 'q1', row_number: 1 }];

const qdb = (params, extra = {}) => ({ type: 'internal_function', config: { function_name: 'query_db', params, ...extra } });
const draft = (steps) => ({ kind: 'workflow.draft.v1', name: 'New flow', description: '', steps, evidence: [] });
const insert = (step, over = {}) => ({ kind: 'workflow.step_insert.v1', workflow_id: 27, step, evidence: CITE, ...over });
const edit = (stepNumber, changes) => ({ kind: 'workflow.step_edit.v1', workflow_id: 27, step_number: stepNumber, changes, evidence: CITE });

const GOOD_QUERY = {
  select: ['cases.case_number', 'c.contact_name'], from: 'cases',
  join: [{ type: 'left', table: 'case_relate', alias: 'cr', on: { left: 'cases.case_id', right: 'cr.case_relate_case_id' } },
    { table: 'contacts', alias: 'c', on: { left: 'cr.case_relate_client_id', right: 'c.contact_id' } }],
  where: [{ column: 'cases.case_status', op: 'in', value: ['Open', 'Filed'] }, { column: 'cases.case_id', op: '=', value: '{{caseId}}' }],
  order_by: [{ column: 'cases.case_open_date', dir: 'DESC' }],
  format: 'first', output_var: 'caseRow',
};

afterEach(() => { delete process.env.CASEY_WORKFLOW_AUTHORING_ENABLED; delete process.env.APP_URL; });

// ── A17.4a ────────────────────────────────────────────────────────────────
describe('A17.4a — query_db steps', () => {
  test('a draft step is BUILT field by field: defaults written, ops/types canonical, the card review computed', async () => {
    const out = await normalizeActionDraft(db(), draft([qdb(GOOD_QUERY)]), []);
    const step = out.steps[0];
    expect(step.side_effect).toBe('read');
    expect(step.config).toEqual({ function_name: 'query_db', params: {
      select: ['cases.case_number', 'c.contact_name'], from: 'cases',
      join: [{ type: 'left', table: 'case_relate', alias: 'cr', on: { left: 'cases.case_id', right: 'cr.case_relate_case_id' } },
        { type: 'left', table: 'contacts', alias: 'c', on: { left: 'cr.case_relate_client_id', right: 'c.contact_id' } }],
      where: [{ column: 'cases.case_status', op: 'IN', value: ['Open', 'Filed'] }, { column: 'cases.case_id', op: '=', value: '{{caseId}}' }],
      where_mode: 'and', order_by: [{ column: 'cases.case_open_date', dir: 'desc' }], limit: 100, format: 'first', output_var: 'caseRow',
    } });
    expect(step.query).toEqual({
      reads_only: true, table: 'cases',
      joins: ['LEFT JOIN case_relate AS cr ON cases.case_id = cr.case_relate_case_id', 'LEFT JOIN contacts AS c ON cr.case_relate_client_id = c.contact_id'],
      columns: ['cases.case_number', 'c.contact_name'],
      predicates: ['cases.case_status is one of ["Open", "Filed"]', 'cases.case_id equals {{caseId}} (filled when the step runs)'],
      combine: 'all', order: ['cases.case_open_date descending'], limit: 100,
      returns: 'the first matching row only', stores: ['{{caseRow}} ← the first matching row only'],
    });
  });

  test('normalizing its own output is a fixed point (the stored params ARE what was reviewed)', async () => {
    const once = (await normalizeActionDraft(db(), draft([qdb(GOOD_QUERY)]), [])).steps[0].config.params;
    const twice = (await normalizeActionDraft(db(), draft([qdb(once)]), [])).steps[0].config.params;
    expect(twice).toEqual(once);
  });

  test('a column the table does not have is refused, naming the readable columns (blocked ones left out)', async () => {
    await expect(normalizeActionDraft(db(), draft([qdb({ select: ['cases.case_nmber'], from: 'cases' })]), []))
      .rejects.toThrow(/cases has no column "case_nmber"\. Its columns: case_id, case_number, case_status, case_open_date$/);
  });

  test('blocked columns are refused in EVERY position (the runtime refuses them too since 2026-11-15; Casey says so before any query)', async () => {
    for (const params of [
      { select: ['users.password'], from: 'users' },
      { select: ['users.user'], from: 'users', where: [{ column: 'users.password_hash', op: 'LIKE', value: 'a%' }] },
      { select: ['users.user'], from: 'users', order_by: [{ column: 'users.password' }] },
      { select: ['cases.case_id'], from: 'cases', where: [{ column: 'cases.custom', op: 'IS NOT NULL' }] },
    ]) {
      await expect(normalizeActionDraft(db(), draft([qdb(params)]), [])).rejects.toThrow(/is a blocked column; query_db never reads it/);
    }
  });

  test('Casey\'s floor over the runtime: token / credential columns are refused; SSN-class columns follow the automation ruling', async () => {
    // The bearer tokens are on the runtime's own blocked list since 2026-11-15
    // (lib/internal_functions/db.js QUERY_DB_BLOCKED_COLUMNS), so that refusal
    // speaks first; Casey's floor still catches the chat-denied names the
    // runtime does not block (draft_key, track_token, attachments, delivery_info).
    await expect(normalizeActionDraft(db(), draft([qdb({ select: ['users.user'], from: 'users', where: [{ column: 'users.reset_token', op: 'IS NOT NULL' }] })]), []))
      .rejects.toThrow(/users\.reset_token is a blocked column; query_db never reads it/);
    await expect(normalizeActionDraft(db(), draft([qdb({ select: ['users.user'], from: 'users', where: [{ column: 'users.draft_key', op: 'IS NOT NULL' }] })]), []))
      .rejects.toThrow(/draft_key is a token or credential column; Casey never authors a read of it/);
    const cols = { ...COLS, contacts: [...COLS.contacts, 'contact_ssn'] };
    const ssnDb = db();
    const inner = ssnDb.query;
    ssnDb.query = jest.fn(async (sql, params) => (/information_schema/.test(sql)
      ? [params[0].flatMap((t) => (cols[t] || []).map((c) => ({ table_name: t, column_name: c })))] : inner(sql, params)));
    const out = await normalizeActionDraft(ssnDb, draft([qdb({ select: ['contacts.contact_ssn'], from: 'contacts' })]), []);
    expect(out.steps[0].query.columns).toEqual(['contacts.contact_ssn']);
  });

  test('shapes the validator cannot fully check are refused, never passed through', async () => {
    const cases = [
      [{ select: ['*'], from: 'cases' }, /"\*" — name each column/],
      [{ select: ['case_number'], from: 'cases' }, /must be table\.column/],
      [{ select: ['x.case_number'], from: 'cases' }, /names "x", which is neither the from table/],
      [{ select: ['cases.case_id'], from: 'app_settings' }, /"from" must be one of the function's tables/],
      [{ select: ['cases.case_id'], from: 'cases', join: [{ table: 'credentials', on: { left: 'cases.case_id', right: 'credentials.id' } }] }, /join 1 table must be one of/],
      [{ select: ['cases.case_id'], from: 'cases', join: [{ table: 'contacts', on: { left: 'cases.case_id', right: 'cases.case_number' } }] }, /join 1 must connect contacts/],
      [{ select: ['cases.case_id'], from: 'cases', join: [{ table: 'contacts', alias: 'users', on: { left: 'cases.case_id', right: 'users.contact_id' } }] }, /alias must be .* not be a table name/],
      [{ select: ['cases.case_id'], from: 'cases', join: [{ type: 'cross', table: 'contacts', on: { left: 'cases.case_id', right: 'contacts.contact_id' } }] }, /join 1 type must be one of/],
      [{ select: ['cases.case_id'], from: 'cases', where: [{ column: 'cases.case_id', op: 'IN', value: '{{ids}}' }] }, /needs a literal list/],
      [{ select: ['cases.case_id'], from: 'cases', where: [{ column: 'cases.case_id', op: '=', value: null }] }, /test for empty with IS NULL/],
      [{ select: ['cases.case_id'], from: 'cases', where: [{ column: 'cases.case_id', op: 'REGEXP', value: 'x' }] }, /op must be one of/],
      [{ select: ['cases.case_id'], from: 'cases', where: [{ column: 'cases.case_id', op: 'IS NULL', value: 1 }] }, /takes no value/],
      [{ select: ['cases.case_id'], from: 'cases', limit: 5000 }, /limit must be a whole number 1-1000/],
      [{ select: ['cases.case_id'], from: 'cases', format: 'html_rows' }, /does not author query_db html_rows/],
      [{ select: ['cases.case_id'], from: 'cases', base_url: 'https://evil.example.com' }, /does not author query_db html_rows/],
      [{ select: ['cases.case_id'], from: 'cases', sql: 'SELECT 1' }, /unsupported params: sql/],
      [{ select: ['cases.case_id'], from: 'cases', output_var: 'this' }, /output_var must be a plain variable name/],
      [{ select: ['cases.case_id'], from: 'cases', where: [{ column: 'cases.case_id', op: '=', value: '{{id|phone}}' }] }, /take no \|modifiers/],
    ];
    for (const [params, re] of cases) {
      await expect(normalizeActionDraft(db(), draft([qdb(params)]), [])).rejects.toThrow(re);
    }
  });

  test('a query_db step config takes only function_name, params, set_vars, next_step', async () => {
    await expect(normalizeActionDraft(db(), draft([qdb({ select: ['cases.case_id'], from: 'cases' }, { timeout_ms: 5 })]), []))
      .rejects.toThrow(/config carries unsupported fields: timeout_ms/);
  });

  test('query_db stays OFF the generic list and off every ingest action — its own structural map only', () => {
    expect(allowlist.CASEY_AUTHORABLE_FUNCTIONS.has('query_db')).toBe(false);
    expect(allowlist.caseyIngestActionClass('query_db')).toBeNull();
    expect(Object.fromEntries(allowlist.CASEY_STRUCTURED_FUNCTIONS)).toEqual({ query_db: 'read' });
  });

  test('the normalizer reads the function\'s OWN rule sets, not a copy', () => {
    const rules = require(path.join(__dirname, '..', 'lib', 'internal_functions')).__QUERY_DB_RULES;
    expect([...rules.tables]).toContain('cases');
    expect(rules.blockedColumns.users).toEqual(['password', 'password_hash', 'reset_token']);
    expect(Object.isFrozen(rules)).toBe(true);
  });

  test('insert: a query_db step rides the step kind with the expected_base', async () => {
    const out = await normalizeActionDraft(db(), insert(qdb({ select: ['contacts.contact_name'], from: 'contacts' })), EVIDENCE);
    expect(out.step).toMatchObject({ type: 'internal_function', side_effect: 'read' });
    expect(out.step.query.columns).toEqual(['contacts.contact_name']);
    expect(out.expected_base).toEqual({ draft_version: 4, step_count: 4 });
  });

  test('edit: params are replaced WHOLE by a built structure; set_vars stays as stored; before/after shown', async () => {
    const out = await normalizeActionDraft(db(), edit(3, { params: { select: ['cases.case_number', 'cases.case_status'], from: 'cases',
      where: [{ column: 'cases.case_id', op: '=', value: '{{caseId}}' }], limit: 1, format: 'first', output_var: 'caseRow' } }), EVIDENCE);
    expect(out.target).toEqual({ step_number: 3, type: 'internal_function', label: 'Read case', function_name: 'query_db' });
    expect(out.new_config.set_vars).toEqual({ n: '{{this.count}}' });
    expect(out.new_config.params.select).toEqual(['cases.case_number', 'cases.case_status']);
    expect(out.before.params.select).toEqual(['cases.case_number']);
    expect(out.query.columns).toEqual(['cases.case_number', 'cases.case_status']);
    expect(out.expected_base.step_fingerprint).toBe(stepFingerprint(BASE_ROWS()[2]));
    await expect(normalizeActionDraft(db(), edit(3, { params: { select: ['users.password'], from: 'users' } }), EVIDENCE))
      .rejects.toThrow(/blocked column/);
    await expect(normalizeActionDraft(db(), edit(3, { code: '1;' }), EVIDENCE)).rejects.toThrow(/not a code step/);
  });
});

// ── A17.4b ────────────────────────────────────────────────────────────────
const ZAP = 'https://hooks.zapier.com/hooks/catch/1/abc';
const hook = (config, extra = {}) => ({ type: 'webhook', config, ...extra });

describe('A17.4b — webhook steps', () => {
  test('a URL the user typed, with a credential they named, normalizes to the stored shape and the full card annotation', async () => {
    const out = await normalizeActionDraft(db(), draft([hook({ url: ZAP, method: 'post', credential: 'zap key', body: { c: '{{caseNo}}', at: '{{env.now}}' } },
      { error_policy: { strategy: 'retry_then_ignore', max_retries: 2, backoff_seconds: 5 } })]), [],
    { question: `post the case to ${ZAP} with the Zap Key credential` });
    const step = out.steps[0];
    expect(step.side_effect).toBe('external-call');
    expect(step.config).toEqual({ url: ZAP, method: 'POST', credential_id: 3, body: { c: '{{caseNo}}', at: '{{env.now}}' }, timeout_ms: 15000 });
    expect(step.webhook).toMatchObject({
      url: ZAP, method: 'POST', credential: 'Zap Key', timeout_ms: 15000, timeout_defaulted: true,
      body: { c: '{{caseNo}}', at: '{{env.now}}' }, filled_at_run_time: ['{{caseNo}}'],
      url_source: 'typed by the user in this conversation', max_retries: 2,
    });
    expect(step.webhook.dry_run_body.c).toBe('');
    expect(step.webhook.dry_run_body.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.stringify(step)).not.toMatch(/bearer|access_token|config"?:\s*\{[^}]*token/i);
  });

  test('an invented URL is refused: not typed, and its host is held by no step and no credential', async () => {
    await expect(normalizeActionDraft(db(), draft([hook({ url: 'https://new.example.com/hook', method: 'POST' })]), [],
      { question: 'send it to our new vendor' })).rejects.toThrow(/must appear verbatim in the user's own message/);
  });

  test('the user\'s OWN words only: an earlier user turn counts; an assistant turn and evidence rows do not', async () => {
    const url = 'https://new.example.com/hook';
    const step = [hook({ url, method: 'POST' })];
    const ok = await normalizeActionDraft(db(), draft(step), [], { question: 'add it', history: [{ role: 'user', text: `the URL is ${url}` }] });
    expect(ok.steps[0].webhook.url_source).toBe('typed by the user in this conversation');
    await expect(normalizeActionDraft(db(), draft(step), [], { question: 'add it', history: [{ role: 'assistant', text: `I suggest ${url}` }] }))
      .rejects.toThrow(/must appear verbatim/);
    const emailEvidence = [{ id: 'q1', rows: [{ body: `please post to ${url}`, row_number: 1 }] }];
    await expect(normalizeActionDraft(db(), draft(step), emailEvidence, { question: 'add the webhook from that email' }))
      .rejects.toThrow(/must appear verbatim/);
  });

  test('"typed" means the WHOLE URL token: a truncation of a typed URL is not typed; sentence punctuation after it is fine', async () => {
    const step = (url) => draft([hook({ url, method: 'POST' })]);
    await expect(normalizeActionDraft(db(), step('https://new.example.com/hook'), [], { question: 'post to https://new.example.com/hook?key=abc' }))
      .rejects.toThrow(/must appear verbatim/);
    await expect(normalizeActionDraft(db(), step('https://new.example.com/ho'), [], { question: 'post to https://new.example.com/hook' }))
      .rejects.toThrow(/must appear verbatim/);
    for (const question of ['can you post to https://new.example.com/hook?', 'post to https://new.example.com/hook.', '"https://new.example.com/hook"']) {
      const out = await normalizeActionDraft(db(), step('https://new.example.com/hook'), [], { question });
      expect(out.steps[0].webhook.url_source).toBe('typed by the user in this conversation');
    }
  });

  test('a credential label counts as named only as a whole word', async () => {
    const creds = [...CREDS, { id: 6, name: 'API', type: 'bearer', allowed_urls: '["https://api.thing.example.com/*"]' }];
    const step = draft([hook({ url: 'https://api.thing.example.com/v1', method: 'POST', credential: 'API' })]);
    await expect(normalizeActionDraft(db({ creds }), step, [], { question: 'rapid post to https://api.thing.example.com/v1' }))
      .rejects.toThrow(/credential "API" was not named/);
    const out = await normalizeActionDraft(db({ creds }), step, [], { question: 'post to https://api.thing.example.com/v1 with the api credential' });
    expect(out.steps[0].config.credential_id).toBe(6);
  });

  test('a host held by a stored credential or a step of the SAME workflow is evidence — unless the URL carries a query string', async () => {
    const viaCred = await normalizeActionDraft(db(), draft([hook({ url: 'https://hooks.zapier.com/hooks/catch/9/xyz', method: 'POST' })]), [], { question: 'add a zapier call' });
    expect(viaCred.steps[0].webhook.url_source).toBe('host named by the allowed URLs of credential "Zap Key"');
    const viaStep = await normalizeActionDraft(db(), insert(hook({ url: 'https://api.vendor.example.com/v1/other', method: 'GET' })), EVIDENCE, { question: 'also call the vendor' });
    expect(viaStep.step.webhook.url_source).toBe('same host as step 2 of this workflow');
    await expect(normalizeActionDraft(db(), insert(hook({ url: 'https://api.vendor.example.com/v1/other?token=abc', method: 'GET' })), EVIDENCE, { question: 'also call the vendor' }))
      .rejects.toThrow(/query string is the user's to type/);
    // A new draft has no "same workflow": the vendor host is evidence only for workflow 27.
    await expect(normalizeActionDraft(db(), draft([hook({ url: 'https://api.vendor.example.com/v1/other', method: 'GET' })]), [], { question: 'call the vendor' }))
      .rejects.toThrow(/must appear verbatim/);
  });

  test('templated, non-https, userinfo, fragment URLs, a missing method, headers, a credential_id, a GET body and a long timeout are refused', async () => {
    const q = { question: 'see https://x.example.com/a' };
    const cases = [
      [{ url: '{{base}}/hook', method: 'POST' }, /never templated/],
      [{ url: 'https://x.example.com/{{id}}', method: 'POST' }, /never templated/],
      [{ url: 'http://x.example.com/a', method: 'POST' }, /must be https/],
      [{ url: 'https://u:p@x.example.com/a', method: 'POST' }, /never carries a username or password/],
      [{ url: 'https://x.example.com/a#f', method: 'POST' }, /no #fragment/],
      [{ url: 'https://x.example.com/a' }, /explicit method/],
      [{ url: 'https://x.example.com/a', method: 'TRACE' }, /explicit method/],
      [{ url: 'https://x.example.com/a', method: 'POST', headers: { Authorization: 'Bearer x' } }, /writes no webhook headers/],
      [{ url: 'https://x.example.com/a', method: 'POST', credential_id: 3 }, /never a credential_id/],
      [{ url: 'https://x.example.com/a', method: 'GET', body: { a: 1 } }, /GET webhook sends no body/],
      [{ url: 'https://x.example.com/a', method: 'POST', timeout_ms: 300000 }, /timeout_ms must be a whole number 1000-120000/],
      [{ url: 'https://x.example.com/a', method: 'POST', body: { to: '{{x|phone}}' } }, /take no \|modifiers/],
      [{ url: 'https://x.example.com/a', method: 'POST', set_vars: { this: '{{this}}' } }, /set_vars maps/],
    ];
    for (const [config, re] of cases) {
      await expect(normalizeActionDraft(db(), draft([hook(config)]), [], q)).rejects.toThrow(re);
    }
  });

  test('credentials: named by the user, by exact label; never a new host paired with a credential', async () => {
    const step = (credential, url = ZAP) => draft([hook({ url, method: 'POST', credential })]);
    // Not named by the user (and no same-workflow pair) → refused.
    await expect(normalizeActionDraft(db(), step('Zap Key'), [], { question: `post to ${ZAP}` }))
      .rejects.toThrow(/credential "Zap Key" was not named by the user/);
    // Unknown label → refused, listing the labels (never a value).
    await expect(normalizeActionDraft(db(), step('Nope'), [], { question: `post to ${ZAP} with Nope` }))
      .rejects.toThrow(/no credential is labelled "Nope" — the user picks one by its exact label: Zap Key, Loose Bearer, Self/);
    // A credential with no allowed URLs on a host this workflow never used it with → refused.
    await expect(normalizeActionDraft(db(), step('Loose Bearer'), [], { question: `post to ${ZAP} with Loose Bearer` }))
      .rejects.toThrow(/never pairs a credential with a new host/);
    // allowed_urls that do not cover the URL → the run-time scope check would refuse it.
    await expect(normalizeActionDraft(db(), step('Zap Key', 'https://other.example.com/x'), [], { question: 'post to https://other.example.com/x with Zap Key' }))
      .rejects.toThrow(/credential "Zap Key" would refuse this URL/);
    // An internal credential reaches only the app's own host.
    process.env.APP_URL = 'https://app.example.com';
    const own = await normalizeActionDraft(db(), step('Self', 'https://app.example.com/api/x'), [], { question: 'post to https://app.example.com/api/x using Self' });
    expect(own.steps[0].config.credential_id).toBe(5);
  });

  test('the same (host, credential) pair a step of THIS workflow already uses is reusable without naming it', async () => {
    const out = await normalizeActionDraft(db(), insert(hook({ url: 'https://api.vendor.example.com/v1/again', method: 'POST', credential: 'Loose Bearer', body: { a: 1 } })),
      EVIDENCE, { question: 'call the vendor again after step 1' });
    expect(out.step.config.credential_id).toBe(4);
    expect(out.step.webhook.credential).toBe('Loose Bearer');
  });

  test('edit: a body change keeps the stored URL (query token and all — the user\'s own) and credential, defaulting the timeout', async () => {
    const out = await normalizeActionDraft(db(), edit(2, { webhook: { body: { id: '{{contact_id}}', note: 'v2' } } }), EVIDENCE, { question: 'add a note field to the vendor call' });
    expect(out.target).toEqual({ step_number: 2, type: 'webhook', label: 'Notify vendor' });
    expect(out.new_config).toEqual({ url: 'https://api.vendor.example.com/v1/notify?token=SECRETTOKEN', method: 'POST', credential_id: 4,
      body: { id: '{{contact_id}}', note: 'v2' }, timeout_ms: 15000 });
    expect(out.webhook).toMatchObject({ url_source: 'unchanged — as stored on this step', credential: 'Loose Bearer', timeout_defaulted: true, max_retries: 1 });
    expect(out.before.webhook).toEqual({ url: 'https://api.vendor.example.com/v1/notify?token=SECRETTOKEN', method: 'POST',
      credential: 'Loose Bearer', body: { id: '{{contact_id}}' }, timeout_ms: '30000 (engine default — not set)', set_vars: null });
    expect(out.expected_base.step_fingerprint).toBe(stepFingerprint(BASE_ROWS()[1]));
  });

  test('edit: a stored next_step (control flow) stays exactly as stored through a call edit', async () => {
    const rows = BASE_ROWS();
    rows[1] = { ...rows[1], config: JSON.stringify({ ...JSON.parse(rows[1].config), next_step: 4 }) };
    const out = await normalizeActionDraft(db({ rows }), edit(2, { webhook: { method: 'PUT' } }), EVIDENCE, { question: 'use PUT' });
    expect(out.new_config.next_step).toBe(4);
    expect(out.new_config.method).toBe('PUT');
  });

  test('edit: a moved URL is held to the insert\'s evidence; a stored credential does not follow it to a new host', async () => {
    await expect(normalizeActionDraft(db(), edit(2, { webhook: { url: 'https://elsewhere.example.com/x' } }), EVIDENCE, { question: 'move it' }))
      .rejects.toThrow(/must appear verbatim/);
    await expect(normalizeActionDraft(db(), edit(2, { webhook: { url: 'https://elsewhere.example.com/x' } }), EVIDENCE,
      { question: 'move it to https://elsewhere.example.com/x' })).rejects.toThrow(/credential "Loose Bearer" was not named/);
    const cleared = await normalizeActionDraft(db(), edit(2, { webhook: { url: 'https://elsewhere.example.com/x', credential: null } }), EVIDENCE,
      { question: 'move it to https://elsewhere.example.com/x, no auth' });
    expect(cleared.new_config.credential_id).toBeUndefined();
  });

  test('edit refusals: literal headers on the stored step, cross-type changes, credential_id/headers in the change', async () => {
    await expect(normalizeActionDraft(db(), edit(4, { webhook: { method: 'PUT' } }), EVIDENCE, { question: 'use PUT' }))
      .rejects.toThrow(/Step 4 carries headers — Casey does not edit a webhook step with literal headers/);
    await expect(normalizeActionDraft(db(), edit(2, { params: {} }), EVIDENCE)).rejects.toThrow(/edited through "webhook"/);
    await expect(normalizeActionDraft(db(), edit(1, { webhook: { method: 'GET' } }), EVIDENCE)).rejects.toThrow(/not a webhook step/);
    await expect(normalizeActionDraft(db(), edit(2, { webhook: { headers: { X: '1' } } }), EVIDENCE)).rejects.toThrow(/writes no webhook headers/);
    await expect(normalizeActionDraft(db(), edit(2, { webhook: { credential_id: 3 } }), EVIDENCE)).rejects.toThrow(/never a credential_id/);
    // A label-only edit of a webhook step needs no call review at all.
    const label = await normalizeActionDraft(db(), edit(4, { label: 'Renamed' }), EVIDENCE);
    expect(label.new_config).toBeUndefined();
  });

  test('the family flag still governs both step types', async () => {
    process.env.CASEY_WORKFLOW_AUTHORING_ENABLED = '0';
    await expect(normalizeActionDraft(db(), draft([hook({ url: ZAP, method: 'POST' })]), [], { question: ZAP })).rejects.toThrow(/Action kind is unavailable/);
    await expect(normalizeActionDraft(db(), insert(qdb({ select: ['cases.case_id'], from: 'cases' })), EVIDENCE)).rejects.toThrow(/Action kind is unavailable/);
  });
});

// ── The card: the browser's own renderers, lifted from assistant.html ─────
describe('the card shows what the contract promises', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  function fnSrc(src, name) {
    const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
    if (!match) throw new Error(`function ${name} not found`);
    let parens = 0, body = match.index + match[0].length - 1;
    for (; body < src.length; body++) {
      if (src[body] === '(') parens++;
      else if (src[body] === ')' && --parens === 0) break;
    }
    let depth = 0;
    for (let i = body; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(match.index, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  }
  const names = ['workflowSendLines', 'workflowQueryLines', 'workflowWebhookLines', 'workflowDraftStepLine', 'workflowDraftText',
    'workflowStepWorkflowLine', 'workflowStepInsertText', 'workflowStepEditValue', 'workflowStepEditText', 'workflowStepActionRequest', 'workflowDraftRequest'];
  // eslint-disable-next-line no-new-func
  const ui = new Function(`${names.map((n) => fnSrc(html, n)).join('\n')}; return { ${names.join(', ')} };`)();

  test('a query_db step: table, columns, predicates in words, limit, reads only', async () => {
    const out = await normalizeActionDraft(db(), draft([qdb(GOOD_QUERY)]), []);
    const text = ui.workflowDraftText(out);
    expect(text).toContain('[query_db]');
    expect(text).toContain('READS ONLY: this step reads firm records and writes nothing.');
    expect(text).toContain('Table: cases');
    expect(text).toContain('Columns: cases.case_number, c.contact_name');
    expect(text).toContain('Rows where ALL of these hold:');
    expect(text).toContain('  - cases.case_status is one of ["Open", "Filed"]');
    expect(text).toContain('Limit: 100 rows; returns the first matching row only');
  });

  test('a webhook step: full URL, method, credential LABEL, body + dry run, timeout, leaves the firm, retries', async () => {
    const out = await normalizeActionDraft(db(), insert(hook({ url: ZAP, method: 'POST', credential: 'Zap Key', body: { c: '{{caseNo}}' } },
      { error_policy: { strategy: 'retry_then_abort', max_retries: 1, backoff_seconds: 5 } })), EVIDENCE, { question: `${ZAP} with Zap Key` });
    const text = ui.workflowStepInsertText(out);
    for (const line of [
      'LEAVES THE FIRM: when the workflow runs (after a human publishes it), this step sends an HTTP request to an outside address.',
      `URL: ${ZAP}`, 'Method: POST', 'Credential: "Zap Key" (its secret is added when the step runs and is never shown)',
      "Timeout: 15000 ms (Casey's 15-second default; the cap is 120 seconds)",
      'Body as stored: {"c":"{{caseNo}}"}', 'Body in a dry run with no run-time values: {"c":""}', 'Filled when the step runs: {{caseNo}}',
      'RETRIES: up to 1 more attempt on ANY failure, whatever the error strategy — a timeout included, even when the endpoint already acted — so a non-idempotent endpoint can be hit 2 times.',
    ]) expect(text).toContain(line);
    // The request carries the stored config only — no annotation rides to the route.
    const req = ui.workflowStepActionRequest(out);
    expect(req.body.config).toEqual({ url: ZAP, method: 'POST', credential_id: 3, body: { c: '{{caseNo}}' }, timeout_ms: 15000 });
    expect(req.body.webhook).toBeUndefined();
    expect(JSON.stringify(req.body)).not.toContain('side_effect');
  });

  test('a webhook edit: before / after and the new call reviewed in full', async () => {
    const out = await normalizeActionDraft(db(), edit(2, { webhook: { method: 'PUT' } }), EVIDENCE, { question: 'use PUT for the vendor call' });
    const text = ui.workflowStepEditText(out);
    expect(text).toContain('Step 2: [webhook] Notify vendor');
    expect(text).toMatch(/webhook — before: \{"url":"https:\/\/api\.vendor\.example\.com\/v1\/notify\?token=SECRETTOKEN","method":"POST"/);
    expect(text).toMatch(/webhook — after: \{.*"method":"PUT"/);
    expect(text).toContain('URL source: unchanged — as stored on this step');
    expect(text).toContain('RETRIES: up to 1 more attempt');
    expect(ui.workflowStepActionRequest(out).body.config.method).toBe('PUT');
  });
});
