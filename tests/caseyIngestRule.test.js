'use strict';
/**
 * tests/caseyIngestRule.test.js
 *
 * A20.2 / A20.3 — Casey authors email AND phone ingest rules. Six kinds on
 * the P1 card engine, each ONE request to the rule editor's own route:
 *   ingest_rule.create.v1         POST   /api/{ch}-ingest/rules          born INACTIVE
 *   ingest_rule.update.v1         PUT    /api/{ch}-ingest/rules/:id
 *   ingest_rule.set_active.v1     PUT    /api/{ch}-ingest/rules/:id      {active}
 *   ingest_rule.action_add.v1     POST   /api/{ch}-ingest/rules/:id/actions
 *   ingest_rule.action_update.v1  PUT    /api/{ch}-ingest/rule-actions/:id
 *   ingest_rule.action_remove.v1  DELETE /api/{ch}-ingest/rule-actions/:id
 * Pinned here (no database — the real-engine half is
 * tests/caseyIngestRule.mysql.test.js):
 *   1. the normalizer: every edit's expected_base is the CITED rule row's
 *      definition_updated_at and must equal the live stamp; the grammar is
 *      built field by field (no empty groups, no NEW regex, closed action
 *      configs, allowlisted functions, literal firm senders, no http); code
 *      bodies are allowed and flagged as automations.manage-only; the family
 *      flag is real;
 *   2. the browser's fixed request builder (run out of public/assistant.html
 *      itself): create pins active:0 and sends exactly the normalized rule +
 *      actions with the draft_id as Idempotency-Key; every edit sends the
 *      baked expected_base and only its own fields; the annotation fields
 *      never reach a route;
 *   3. the builder → route seam: the body the browser builds is the body the
 *      route hands its service (the service is spied, never the route).
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { normalizeActionDraft } = require(path.join(REPO, 'services', 'assistantService'));
const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');

function fnSrc(src, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`function ${name} not found`);
  let parens = 0;
  let body = match.index + match[0].length - 1;
  for (; body < src.length; body++) {
    if (src[body] === '(') parens++;
    else if (src[body] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let i = src.indexOf('{', body); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
function constSrc(src, name) {
  const match = new RegExp(`const\\s+${name}\\s*=`).exec(src);
  let depth = 0;
  for (let i = match.index; i < src.length; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`const ${name} unterminated`);
}
const BROWSER = ['ingestRulePath', 'ingestRuleId', 'ingestRuleLabel', 'ingestRuleValue', 'ingestRuleHead', 'ingestRuleSideText',
  'ingestRuleActionLine', 'ingestRuleText', 'ingestRuleRequest', 'ingestRuleDispatch', 'ingestRuleResult', 'ingestRulePrecheck'];
function browser(P = {}) {
  const src = [constSrc(html, 'INGEST_RULE_ACTION_KINDS'), constSrc(html, 'INGEST_RULE_PATHS'),
    constSrc(html, 'INGEST_RULE_UPDATE_FIELDS'), constSrc(html, 'INGEST_ACTION_UPDATE_FIELDS'),
    ...BROWSER.map((n) => fnSrc(html, n)),
    `return { ${BROWSER.join(', ')} };`].join('\n');
  return new Function('P', src)(P); // eslint-disable-line no-new-func
}

const STAMP = '2026-10-27T10:00:00.123Z';
const COND = { operator: 'and', conditions: [{ path: 'from.email', op: 'equals', value: 'notices@court.gov' }] };

// A fake app pool: every query the normalizer may make, by shape. Anything
// else throws, so an unexpected read is a failure, not a silent pass.
function fakeDb(over = {}) {
  const rule = over.rule === undefined ? {
    id: 12, name: 'Court notices', description: 'old', active: 1, position: 3,
    match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', transform_config: null,
    match_count: 940, last_matched_at: new Date(), last_modified_by: 6, created_at: new Date(), updated_at: new Date(),
    definition_updated_at: new Date(STAMP),
  } : over.rule;
  const actions = over.actions || [{ id: 40, rule_id: 12, name: 'Start deadlines', position: 0, active: 1, action_type: 'workflow', config: { workflow_id: 24 } },
    { id: 41, rule_id: 12, name: 'Relay', position: 1, active: 1, action_type: 'http', config: { url: 'https://x.example.com/t/SECRET', method: 'POST', credential_id: 3 } }];
  const workflows = { 24: { id: 24, name: 'Court deadlines', active: 1, current_version: 3 }, 25: { id: 25, name: 'Off', active: 0, current_version: 1 },
    61: { id: 61, name: 'Draft only', active: 1, current_version: 0 }, ...(over.workflows || {}) };
  const seen = [];
  const db = {
    seen,
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql);
      seen.push(s);
      if (/FROM (email|phone)_ingest_rules WHERE id = \?/.test(s)) return [rule && Number(params[0]) === Number(rule.id) ? [{ ...rule }] : []];
      if (/FROM (email|phone)_ingest_rule_actions\s+WHERE rule_id = \?/.test(s)) return [actions.filter((a) => Number(a.rule_id) === Number(params[0]))];
      if (/FROM (email|phone)_ingest_rules WHERE name = \?/.test(s)) return [over.nameClash ? [{ id: 99 }] : []];
      if (/SELECT COUNT\(\*\) AS n FROM (email|phone)_ingest_rules WHERE active = 1/.test(s)) return [[{ n: 4 }]];
      if (/FROM workflows WHERE id = \?/.test(s)) return [workflows[params[0]] ? [workflows[params[0]]] : []];
      if (/FROM sequence_templates WHERE id = \?/.test(s)) return [params[0] === 5 ? [{ id: 5, name: 'No-show chase', active: 1 }] : []];
      if (/FROM hooks WHERE slug = \?/.test(s)) return [params[0] === 'court-relay' ? [{ id: 7, slug: 'court-relay', name: 'Court relay', active: 1 }] : []];
      // Forward destination classification + the opt-out lookup.
      if (/FROM phone_lines WHERE phone_number = \? AND active = 1\)/.test(s)) return [[{ n: ['2485592400', '2486213656'].includes(params[0]) ? 1 : 0 }]];
      if (/FROM email_credentials WHERE email = \?\)/.test(s)) return [[{ n: params[1] === 'shoshana@staff.example' ? 1 : 0 }]];
      if (/FROM contact_phones r LEFT JOIN contacts/.test(s)) return [(over.optedOut || []).includes(params[0][0]) ? [{ row_id: 1, contact_id: 9, destination: params[0][0], contact_name: 'Pat' }] : []];
      if (/FROM contact_emails r LEFT JOIN contacts/.test(s)) return [(over.optedOut || []).includes(params[0][0]) ? [{ row_id: 1, contact_id: 9, destination: params[0][0], contact_name: 'Pat' }] : []];
      if (/FROM email_credentials WHERE email = \?/.test(s)) return [params[0] === 'automations@4lsg.com' ? [{ email: 'automations@4lsg.com', from_name: 'Automations' }] : []];
      if (/FROM phone_lines WHERE phone_number = \?/.test(s)) return [params[0] === '2486213656' ? [{ phone_number: '2486213656', display_name: 'Main' }] : []];
      if (/SELECT id, name FROM credentials/.test(s)) return [[{ id: 3, name: 'Clio OAuth' }]];
      throw new Error(`db touched: ${s}`);
    }),
  };
  return db;
}

const ruleEvidence = (over = {}) => [{ id: 'q1', kind: 'automation.definition', purpose: 'read the rule', rows: [{
  row: 'rule', channel: 'email', email_ingest_rule_id: 12, name: 'Court notices', active: 'true',
  definition_updated_at: STAMP, ...over }] }];
const REF = [{ query_id: 'q1', row_number: 1 }];

afterEach(() => { delete process.env.CASEY_INGEST_AUTHORING_ENABLED; });

describe('ingest_rule.create.v1 — a rule born inactive', () => {
  const create = (over = {}) => ({
    kind: 'ingest_rule.create.v1', channel: 'email', name: 'Trustee notices', description: 'Start the 341 chase',
    match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', transform_config: null,
    actions: [{ action_type: 'workflow', config: { workflow_id: 24 } }], evidence: [], ...over,
  });

  test('normalizes the rule, verifies the action target, states the evaluation order, and is not code', async () => {
    const out = await normalizeActionDraft(fakeDb(), create(), []);
    expect(out).toMatchObject({
      kind: 'ingest_rule.create.v1', status: 'draft', channel: 'email',
      rule: { name: 'Trustee notices', position: 0, match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', transform_config: null },
      actions: [{ action_type: 'workflow', config: { workflow_id: 24 }, side_effect: 'starts-workflow' }],
      code: { match: false, transform: false }, requires_capability: null,
    });
    expect(out.actions[0].summary).toMatch(/starts workflow #24 "Court deadlines"/);
    expect(out.order).toMatch(/evaluated after 4 active rules/);
    expect(out).not.toHaveProperty('rule.active');   // active is the builder's pin, never the model's
  });

  test('empty groups (match-all) and NEW regex are refused by name; known operators only', async () => {
    const db = fakeDb();
    await expect(normalizeActionDraft(db, create({ match_config: { operator: 'and', conditions: [] } }), []))
      .rejects.toThrow(/empty "and" matches EVERY message/);
    await expect(normalizeActionDraft(db, create({ match_config: { operator: 'and', conditions: [{ operator: 'or', conditions: [] }] } }), []))
      .rejects.toThrow(/has no conditions/);
    await expect(normalizeActionDraft(db, create({ match_config: { operator: 'and', conditions: [{ path: 'subject', op: 'matches', value: '(a+)+b' }] } }), []))
      .rejects.toThrow(/does not write new regular expressions/);
    await expect(normalizeActionDraft(db, create({ transform_mode: 'mapper', transform_config: [{ to: 'n', from: 'subject', transforms: ['regex:(\\d+)'] }] }), []))
      .rejects.toThrow(/does not write new regex transforms/);
    await expect(normalizeActionDraft(db, create({ transform_mode: 'mapper', transform_config: [{ to: 'n', template: '{{subject|regex:(\\d+)}}' }] }), []))
      .rejects.toThrow(/does not write new regex transforms/);
    await expect(normalizeActionDraft(db, create({ match_config: { operator: 'and', conditions: [{ path: 'subject', op: 'like', value: 'x' }] } }), []))
      .rejects.toThrow(/not a condition operator/);
    await expect(normalizeActionDraft(db, create({ match_config: { operator: 'and', conditions: [{ path: '__proto__.x', op: 'equals', value: 'x' }] } }), []))
      .rejects.toThrow(/must be a dot path/);
    await expect(normalizeActionDraft(db, create({ match_config: { path: 'subject', op: 'equals', value: 'x' } }), []))
      .rejects.toThrow(/must be a group/);
  });

  test('a mapper is built rule by rule with known transforms; passthrough takes no config', async () => {
    const out = await normalizeActionDraft(fakeDb(), create({ transform_mode: 'mapper',
      transform_config: [{ to: 'case_no', from: 'subject', transforms: ['after:Case ', 'trim'] }, { to: 'kind', value: 'court' }] }), []);
    expect(out.rule.transform_config).toEqual([{ to: 'case_no', from: 'subject', transforms: ['after:Case ', 'trim'] }, { to: 'kind', value: 'court' }]);
    await expect(normalizeActionDraft(fakeDb(), create({ transform_mode: 'mapper', transform_config: [{ to: 'x', from: 'a', template: 'b' }] }), []))
      .rejects.toThrow(/exactly one of from, template, or value/);
    await expect(normalizeActionDraft(fakeDb(), create({ transform_mode: 'mapper', transform_config: [{ to: 'x', from: 'a', transforms: ['explode'] }] }), []))
      .rejects.toThrow(/not a mapper transform/);
    await expect(normalizeActionDraft(fakeDb(), create({ transform_mode: 'passthrough', transform_config: [{ to: 'x', from: 'a' }] }), []))
      .rejects.toThrow(/takes no transform_config/);
  });

  test('CODE match/transform bodies are allowed and flagged: only automations.manage can apply them', async () => {
    const out = await normalizeActionDraft(fakeDb(), create({ match_mode: 'code', match_config: { code: 'return input.subject.includes("341");' },
      transform_mode: 'code', transform_config: 'return { n: 1 };' }), []);
    expect(out.rule.match_config).toEqual({ code: 'return input.subject.includes("341");' });
    expect(out.rule.transform_config).toEqual({ code: 'return { n: 1 };' });
    expect(out).toMatchObject({ code: { match: true, transform: true }, requires_capability: 'automations.manage' });
    await expect(normalizeActionDraft(fakeDb(), create({ match_mode: 'code', match_config: { code: '   ' } }), []))
      .rejects.toThrow(/in code mode is/);
  });

  test('actions: existing ACTIVE targets only, closed configs, allowlisted functions, literal firm senders, no http', async () => {
    const db = fakeDb();
    const one = (action) => normalizeActionDraft(db, create({ actions: [action] }), []);
    await expect(one({ action_type: 'workflow', config: { workflow_id: 999 } })).rejects.toThrow(/workflow 999 does not exist/);
    await expect(one({ action_type: 'workflow', config: { workflow_id: 25 } })).rejects.toThrow(/is inactive/);
    const unpublished = await one({ action_type: 'workflow', config: { workflow_id: 61 } });
    expect(unpublished.actions[0].notes.join(' ')).toMatch(/never been published/);
    await expect(one({ action_type: 'workflow', config: { workflow_id: 24, url: 'https://x' } })).rejects.toThrow(/unsupported fields for a workflow action: url/);
    await expect(one({ action_type: 'sequence', config: { template_type: 'no_show' } })).rejects.toThrow(/unsupported fields/);
    await expect(one({ action_type: 'sequence', config: {} })).rejects.toThrow(/needs config.template_id/);
    const seq = await one({ action_type: 'sequence', config: { template_id: 5, contact_id_field: 'contact.id' } });
    expect(seq.actions[0]).toMatchObject({ config: { template_id: 5, contact_id_field: 'contact.id' }, side_effect: 'enrolls-sequence' });
    await expect(one({ action_type: 'hook', config: { slug: 'nope' } })).rejects.toThrow(/no hook has slug "nope"/);
    expect((await one({ action_type: 'hook', config: { slug: 'court-relay' } })).actions[0].summary).toMatch(/re-enters hook #7/);
    await expect(one({ action_type: 'http', config: { url: 'https://evil.example.com' } })).rejects.toThrow(/does not author http actions yet/);
    await expect(one({ action_type: 'internal_function', config: { function_name: 'update_db', params_mapping: {} } }))
      .rejects.toThrow(/outside Casey's authoring allowlist/);
    await expect(one({ action_type: 'internal_function', config: { function_name: 'forward_as_mms', params_mapping: {} } }))
      .rejects.toThrow(/outside Casey's authoring allowlist/);
    await expect(one({ action_type: 'internal_function', config: { function_name: 'send_email',
      params_mapping: { from: 'from.email', to: "'staff@4lsg.com'", subject: 'subject', text: 'text' } } }))
      .rejects.toThrow(/quoted literal firm mailbox/);
    await expect(one({ action_type: 'internal_function', config: { function_name: 'send_email',
      params_mapping: { from: "'someone@gmail.com'", to: "'staff@4lsg.com'", subject: 'subject', text: 'text' } } }))
      .rejects.toThrow(/not a configured firm mailbox/);
    await expect(one({ action_type: 'internal_function', config: { function_name: 'send_email',
      params_mapping: { from: "'automations@4lsg.com'", to: "'a@b.c'", subject: 's', text: 't', bogus: 'x' } } }))
      .rejects.toThrow(/has no param\(s\) bogus/);
    const mail = await one({ action_type: 'internal_function', config: { function_name: 'send_email',
      params_mapping: { from: "'automations@4lsg.com'", to: 'from.email', subject: 'subject', text: 'text' } } });
    expect(mail.actions[0]).toMatchObject({ side_effect: 'external-send' });
    expect(mail.actions[0].notes.join(' ')).toMatch(/SENDS AN EMAIL from Automations <automations@4lsg.com> to the message's from\.email .*recipient comes from the message itself/);
    await expect(normalizeActionDraft(db, create({ actions: new Array(6).fill({ action_type: 'workflow', config: { workflow_id: 24 } }) }), []))
      .rejects.toThrow(/takes 0-5 actions/);
  });

  test('both channels; unknown keys refused by name; the family flag makes all six kinds not exist', async () => {
    const phone = await normalizeActionDraft(fakeDb(), create({ channel: 'phone',
      match_config: { operator: 'and', conditions: [{ path: 'link_id', op: 'equals', value: '2485550100' }] } }), []);
    expect(phone.channel).toBe('phone');
    await expect(normalizeActionDraft(fakeDb(), create({ channel: 'fax' }), [])).rejects.toThrow(/channel "email" or "phone"/);
    await expect(normalizeActionDraft(fakeDb(), create({ active: 1 }), [])).rejects.toThrow(/unsupported fields: active/);
    process.env.CASEY_INGEST_AUTHORING_ENABLED = '0';
    for (const kind of ['ingest_rule.create.v1', 'ingest_rule.update.v1', 'ingest_rule.set_active.v1',
      'ingest_rule.action_add.v1', 'ingest_rule.action_update.v1', 'ingest_rule.action_remove.v1']) {
      await expect(normalizeActionDraft(fakeDb(), { ...create(), kind }, [])).rejects.toThrow(/Action kind is unavailable/);
    }
  });

  test('a non-catalog path is a card note, never a refusal (live rules use to.0.email)', async () => {
    const out = await normalizeActionDraft(fakeDb(), create({ match_config: { operator: 'and', conditions: [{ path: 'to.0.email', op: 'starts_with', value: 'remindme+' }] } }), []);
    expect(out.notes.join(' ')).toMatch(/to\.0\.email, which is not in the email match-field catalog/);
  });
});

describe('forwards (Fred, 2026-10-27): forward_as_email / forward_as_sms as ingest actions only', () => {
  const create = (action, over = {}) => ({ kind: 'ingest_rule.create.v1', channel: 'email', name: 'Forward convert-case mail',
    match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', actions: [action], evidence: [], ...over });
  const fwd = (fn, mapping) => ({ action_type: 'internal_function', config: { function_name: fn, params_mapping: mapping } });
  const EMAIL = { event: '$', from: "'automations@4lsg.com'", to: "'shoshana@staff.example'", subject_prefix: "'Fwd: '" };
  const SMS = { event: '$', from: "'2486213656'", to: "'2485592400'", body_prefix: "'ALERT: '" };

  test('the four live shapes normalize: literal sender, literal destination on the card, external-send', async () => {
    const out = await normalizeActionDraft(fakeDb(), create(fwd('forward_as_email', EMAIL)), []);
    expect(out.actions[0]).toMatchObject({ side_effect: 'external-send', config: { function_name: 'forward_as_email', params_mapping: EMAIL } });
    expect(out.actions[0].summary).toMatch(/^forwards every matching message to shoshana@staff\.example \(firm \/ staff\)/);
    const sms = await normalizeActionDraft(fakeDb(), create(fwd('forward_as_sms', SMS)), []);
    expect(sms.actions[0].summary).toMatch(/to 2485592400 \(firm \/ staff\) \(forward_as_sms, from Main \(2486213656\)\)/);
  });

  test('an outside destination is allowed but called out; an opted-out one is refused (the function refuses it at send time)', async () => {
    const out = await normalizeActionDraft(fakeDb(), create(fwd('forward_as_email', { ...EMAIL, to: "'pat@gmail.com'" })), []);
    expect(out.actions[0].summary).toMatch(/pat@gmail\.com — OUTSIDE THE FIRM/);
    expect(out.actions[0].notes.join(' ')).toMatch(/every matching client message will be sent to someone outside the firm/);
    await expect(normalizeActionDraft(fakeDb({ optedOut: ['pat@gmail.com'] }), create(fwd('forward_as_email', { ...EMAIL, to: "'pat@gmail.com'" })), []))
      .rejects.toThrow(/has opted out of email/);
    await expect(normalizeActionDraft(fakeDb({ optedOut: ['3135550100'] }), create(fwd('forward_as_sms', { ...SMS, to: "'313-555-0100'" })), []))
      .rejects.toThrow(/has opted out of texts/);
  });

  test('no destination or sender from the message, event is "$", passthrough only, literal prefixes', async () => {
    const db = fakeDb();
    await expect(normalizeActionDraft(db, create(fwd('forward_as_email', { ...EMAIL, to: 'from.email' })), []))
      .rejects.toThrow(/never forwards to a value taken out of the incoming message/);
    await expect(normalizeActionDraft(db, create(fwd('forward_as_sms', { ...SMS, to: 'from' })), []))
      .rejects.toThrow(/never forwards to a value taken out of the incoming message/);
    await expect(normalizeActionDraft(db, create(fwd('forward_as_email', { ...EMAIL, from: 'to.0.email' })), []))
      .rejects.toThrow(/never from a value taken out of the incoming message/);
    await expect(normalizeActionDraft(db, create(fwd('forward_as_email', { ...EMAIL, from: "'nobody@gmail.com'" })), []))
      .rejects.toThrow(/not a configured firm mailbox/);
    await expect(normalizeActionDraft(db, create(fwd('forward_as_email', { ...EMAIL, event: 'text' })), []))
      .rejects.toThrow(/event is "\$"/);
    await expect(normalizeActionDraft(db, create(fwd('forward_as_email', EMAIL), { transform_mode: 'mapper', transform_config: [{ to: 'a', from: 'subject' }] }), []))
      .rejects.toThrow(/transform must be passthrough/);
    await expect(normalizeActionDraft(db, create(fwd('forward_as_email', { ...EMAIL, subject_prefix: 'subject' })), []))
      .rejects.toThrow(/subject_prefix is a quoted literal/);
    await expect(normalizeActionDraft(db, create(fwd('forward_as_email', { ...EMAIL, to: "'a@b.com, c@d.com'" })), []))
      .rejects.toThrow(/is not one email address/);
    await expect(normalizeActionDraft(db, create(fwd('forward_as_sms', { ...SMS, to: "'555'" })), []))
      .rejects.toThrow(/is not a 10-digit phone number/);
  });

  test('a transform change that would break an existing forward is refused', async () => {
    const db = fakeDb({ actions: [{ id: 12, rule_id: 12, name: null, position: 0, active: 1, action_type: 'internal_function',
      config: { function_name: 'forward_as_email', params_mapping: EMAIL } }] });
    await expect(normalizeActionDraft(db, { kind: 'ingest_rule.update.v1', email_ingest_rule_id: 12,
      changes: { transform_mode: 'mapper', transform_config: [{ to: 'a', from: 'subject' }] }, evidence: REF }, ruleEvidence()))
      .rejects.toThrow(/Action #12 forwards the incoming message/);
  });

  test('forwards are INGEST-only: not workflow-draft authorable (the native workflow picker hides them)', async () => {
    const { CASEY_AUTHORABLE_FUNCTIONS, caseyIngestActionClass } = require(path.join(REPO, 'lib', 'caseyAutomationAllowlist'));
    expect(CASEY_AUTHORABLE_FUNCTIONS.has('forward_as_email')).toBe(false);
    expect(caseyIngestActionClass('forward_as_email')).toBe('external-send');
    expect(caseyIngestActionClass('send_email')).toBe('external-send');
    expect(caseyIngestActionClass('update_db')).toBeNull();
    expect(caseyIngestActionClass('__proto__')).toBeNull();
    await expect(normalizeActionDraft({ query: async () => [[]] }, { kind: 'workflow.draft.v1', name: 'Fwd test',
      steps: [{ type: 'internal_function', config: { function_name: 'forward_as_email', params: { event: {}, to: 'a@b.c', from: 'x@y.z' } } }], evidence: [] }, []))
      .rejects.toThrow(/"forward_as_email" is outside Casey's authoring allowlist/);
  });
});

describe('the edit kinds — expected_base from the cited evidence, never a fresh read', () => {
  const update = (changes, over = {}) => ({ kind: 'ingest_rule.update.v1', email_ingest_rule_id: 12, changes, evidence: REF, ...over });

  test('the base IS the cited rule row\'s definition_updated_at; an ACTIVE rule is marked live with the revert path', async () => {
    const out = await normalizeActionDraft(fakeDb(), update({ name: 'Court notices (MIEB)' }), ruleEvidence());
    expect(out).toMatchObject({ channel: 'email', rule: { rule_id: 12, active: 1 }, live: 1,
      changes: { name: 'Court notices (MIEB)' }, before: { name: 'Court notices' },
      expected_base: { definition_updated_at: STAMP } });
    expect(out.live_text).toMatch(/LIVE: this rule is ACTIVE — the change applies to the very next matching email/);
    expect(out.revert_text).toMatch(/change log/);
  });

  test('no citation of the rule row, a citation of another rule, or a moved live stamp: refused', async () => {
    await expect(normalizeActionDraft(fakeDb(), update({ name: 'x' }, { evidence: [] }), ruleEvidence()))
      .rejects.toThrow(/must cite the rule row of an automation.definition read/);
    await expect(normalizeActionDraft(fakeDb(), update({ name: 'x' }), ruleEvidence({ email_ingest_rule_id: 13 })))
      .rejects.toThrow(/must cite the rule row/);
    await expect(normalizeActionDraft(fakeDb(), update({ name: 'x' }), ruleEvidence({ row: 'action' })))
      .rejects.toThrow(/must cite the rule row/);
    await expect(normalizeActionDraft(fakeDb(), update({ name: 'x' }), ruleEvidence({ definition_updated_at: '2026-10-27T09:59:59.000Z' })))
      .rejects.toThrow(/changed after Casey read it/);
    await expect(normalizeActionDraft(fakeDb(), { ...update({ name: 'x' }), phone_ingest_rule_id: 12 }, ruleEvidence()))
      .rejects.toThrow(/exactly one of email_ingest_rule_id or phone_ingest_rule_id/);
  });

  test('mode and config travel together; passthrough sends null; no-op and active are refused', async () => {
    const db = fakeDb();
    await expect(normalizeActionDraft(db, update({ match_mode: 'code' }), ruleEvidence())).rejects.toThrow(/needs the new match_config too/);
    await expect(normalizeActionDraft(db, update({ transform_mode: 'mapper' }), ruleEvidence())).rejects.toThrow(/needs the new transform_config too/);
    const cfg = await normalizeActionDraft(db, update({ match_config: { operator: 'or', conditions: [COND.conditions[0], { path: 'subject', op: 'contains', value: '341' }] } }), ruleEvidence());
    expect(cfg.changes).toEqual({ match_mode: 'conditions', match_config: { operator: 'or', conditions: [COND.conditions[0], { path: 'subject', op: 'contains', value: '341' }] } });
    expect(cfg.before).toEqual({ match_mode: 'conditions', match_config: COND });
    await expect(normalizeActionDraft(db, update({ match_mode: 'conditions', match_config: COND }), ruleEvidence())).rejects.toThrow(/changes nothing/);
    await expect(normalizeActionDraft(db, update({ active: 1 }), ruleEvidence())).rejects.toThrow(/ingest_rule\.set_active\.v1/);
    const mapped = fakeDb({ rule: { id: 12, name: 'R', active: 0, position: 0, match_mode: 'conditions', match_config: COND,
      transform_mode: 'mapper', transform_config: [{ to: 'a', from: 'b' }], definition_updated_at: new Date(STAMP) } });
    const pt = await normalizeActionDraft(mapped, update({ transform_mode: 'passthrough' }), ruleEvidence());
    expect(pt.changes).toEqual({ transform_mode: 'passthrough', transform_config: null });
    expect(pt.live).toBe(0);
    expect(pt.live_text).toMatch(/INACTIVE — live ingest never evaluates it/);
  });

  test('a regex the rule ALREADY runs may be kept verbatim; a new one may not', async () => {
    const rx = 'regex:([0-9]+-[0-9]+)';
    const db = fakeDb({ rule: { id: 12, name: 'Court', active: 1, position: 101, match_mode: 'conditions',
      match_config: { operator: 'and', conditions: [{ path: 'subject', op: 'matches', value: '^Notice' }] },
      transform_mode: 'mapper', transform_config: [{ to: 'case_number', from: 'subject', transforms: [rx, 'trim'] }],
      definition_updated_at: new Date(STAMP) } });
    const kept = await normalizeActionDraft(db, update({ transform_config: [{ to: 'case_number', from: 'subject', transforms: [rx, 'trim'] }, { to: 'chapter', value: '13' }] }), ruleEvidence());
    expect(kept.changes.transform_config[0].transforms[0]).toBe(rx);
    await expect(normalizeActionDraft(db, update({ transform_config: [{ to: 'c', from: 'subject', transforms: ['regex:(x+)+y'] }] }), ruleEvidence()))
      .rejects.toThrow(/does not write new regex transforms/);
    const keepMatch = await normalizeActionDraft(db, update({ match_config: { operator: 'and', conditions: [{ path: 'subject', op: 'matches', value: '^Notice' }, { path: 'from.email', op: 'ends_with', value: 'uscourts.gov' }] } }), ruleEvidence());
    expect(keepMatch.changes.match_config.conditions[0]).toEqual({ path: 'subject', op: 'matches', value: '^Notice' });
  });

  test('set_active: the danger card names the live traffic and every action that will fire', async () => {
    const db = fakeDb({ rule: { id: 12, name: 'Court notices', active: 0, position: 3, match_mode: 'conditions', match_config: COND,
      transform_mode: 'code', transform_config: { code: 'return input;' }, definition_updated_at: new Date(STAMP) } });
    const on = await normalizeActionDraft(db, { kind: 'ingest_rule.set_active.v1', email_ingest_rule_id: 12, active: true, evidence: REF }, ruleEvidence());
    expect(on).toMatchObject({ active: 1, live: 1, expected_base: { definition_updated_at: STAMP } });
    expect(on.impact.join('\n')).toMatch(/STARTS PROCESSING LIVE TRAFFIC/);
    expect(on.impact.join('\n')).toMatch(/2 active action\(s\) fire on every match: #40 workflow "Start deadlines", #41 http "Relay"/);
    expect(on.impact.join('\n')).toMatch(/its transform is a code body/);
    await expect(normalizeActionDraft(db, { kind: 'ingest_rule.set_active.v1', email_ingest_rule_id: 12, active: false, evidence: REF }, ruleEvidence()))
      .rejects.toThrow(/already inactive/);
    await expect(normalizeActionDraft(db, { kind: 'ingest_rule.set_active.v1', email_ingest_rule_id: 12, active: 1, evidence: REF }, ruleEvidence()))
      .rejects.toThrow(/active: true or false/);
  });

  test('action add / update / remove: the action must belong to the rule; http is never re-pointed and its URL never shown', async () => {
    const db = fakeDb();
    const add = await normalizeActionDraft(db, { kind: 'ingest_rule.action_add.v1', email_ingest_rule_id: 12,
      action: { action_type: 'hook', name: 'Relay', config: { slug: 'court-relay' } }, evidence: REF }, ruleEvidence());
    expect(add).toMatchObject({ live: 1, action: { action_type: 'hook', name: 'Relay', config: { slug: 'court-relay' } }, expected_base: { definition_updated_at: STAMP } });
    await expect(normalizeActionDraft(db, { kind: 'ingest_rule.action_update.v1', email_ingest_rule_id: 12, rule_action_id: 77,
      changes: { name: 'x' }, evidence: REF }, ruleEvidence())).rejects.toThrow(/is not one of email ingest rule 12's actions/);
    await expect(normalizeActionDraft(db, { kind: 'ingest_rule.action_update.v1', email_ingest_rule_id: 12, rule_action_id: 41,
      changes: { config: { url: 'https://new.example.com' } }, evidence: REF }, ruleEvidence())).rejects.toThrow(/does not re-point http actions/);
    await expect(normalizeActionDraft(db, { kind: 'ingest_rule.action_update.v1', email_ingest_rule_id: 12, rule_action_id: 40,
      changes: { action_type: 'hook' }, evidence: REF }, ruleEvidence())).rejects.toThrow(/action type never changes/);
    const off = await normalizeActionDraft(db, { kind: 'ingest_rule.action_update.v1', email_ingest_rule_id: 12, rule_action_id: 41,
      changes: { active: false }, evidence: REF }, ruleEvidence());
    expect(off).toMatchObject({ changes: { active: 0 }, before: { active: 1 }, target: { rule_action_id: 41, action_type: 'http' } });
    expect(JSON.stringify(off)).not.toMatch(/SECRET|\/t\//);
    expect(off.target.config).toMatch(/x\.example\.com.*Clio OAuth/);
    const repoint = await normalizeActionDraft(db, { kind: 'ingest_rule.action_update.v1', email_ingest_rule_id: 12, rule_action_id: 40,
      changes: { config: { workflow_id: 61 } }, evidence: REF }, ruleEvidence());
    expect(repoint).toMatchObject({ changes: { config: { workflow_id: 61 } }, side_effect: 'starts-workflow' });
    const rm = await normalizeActionDraft(db, { kind: 'ingest_rule.action_remove.v1', email_ingest_rule_id: 12, rule_action_id: 41, evidence: REF }, ruleEvidence());
    expect(rm).toMatchObject({ target: { rule_action_id: 41 }, expected_base: { definition_updated_at: STAMP } });
    expect(JSON.stringify(rm)).not.toMatch(/SECRET/);
  });
});

describe('the browser\'s fixed request builder (run from public/assistant.html)', () => {
  const b = browser();

  test('create: POST, active pinned 0, exactly the normalized rule + actions, idempotent; annotations never sent', async () => {
    const draft = await normalizeActionDraft(fakeDb(), {
      kind: 'ingest_rule.create.v1', channel: 'phone', name: 'Clio code', match_mode: 'conditions',
      match_config: { operator: 'and', conditions: [{ path: 'message', op: 'contains', value: 'Clio login code' }] },
      transform_mode: 'mapper', transform_config: [{ to: 'code', from: 'message', transforms: ['digits_only'] }],
      actions: [{ action_type: 'workflow', name: 'Store it', config: { workflow_id: 24 } }], evidence: [] }, []);
    const req = b.ingestRuleRequest(draft);
    expect(req).toEqual({ path: '/api/phone-ingest/rules', method: 'POST', idempotent: true, body: {
      name: 'Clio code', active: 0, position: 0, match_mode: 'conditions', match_config: draft.rule.match_config,
      transform_mode: 'mapper', transform_config: [{ to: 'code', from: 'message', transforms: ['digits_only'] }],
      actions: [{ action_type: 'workflow', config: { workflow_id: 24 }, active: 1, position: 0, name: 'Store it' }] } });
    expect(JSON.stringify(req.body)).not.toMatch(/summary|side_effect|notes|order|requires_capability/);
  });

  test('a passthrough create sends no transform_config; a model channel outside the map never builds a path', () => {
    const req = b.ingestRuleRequest({ kind: 'ingest_rule.create.v1', channel: 'email',
      rule: { name: 'n', position: 2, match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', transform_config: null }, actions: [] });
    expect(req.body).toEqual({ name: 'n', active: 0, position: 2, match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', actions: [] });
    for (const channel of ['https://evil', '../x', 'constructor', undefined]) {
      expect(() => b.ingestRuleRequest({ kind: 'ingest_rule.create.v1', channel, rule: {}, actions: [] })).toThrow(/no known channel/);
    }
  });

  test('every edit sends the baked expected_base and only its own fields, to its own route', async () => {
    const db = fakeDb();
    const upd = await normalizeActionDraft(db, { kind: 'ingest_rule.update.v1', email_ingest_rule_id: 12,
      changes: { name: 'N2', position: 7 }, evidence: REF }, ruleEvidence());
    expect(b.ingestRuleRequest({ ...upd, changes: { ...upd.changes, active: 1, url: 'x' } })).toEqual({ path: '/api/email-ingest/rules/12', method: 'PUT', idempotent: false,
      body: { name: 'N2', position: 7, expected_base: { definition_updated_at: STAMP } } });
    const on = await normalizeActionDraft(fakeDb({ rule: { id: 12, name: 'R', active: 0, position: 0, match_mode: 'conditions', match_config: COND,
      transform_mode: 'passthrough', transform_config: null, definition_updated_at: new Date(STAMP) } }),
    { kind: 'ingest_rule.set_active.v1', email_ingest_rule_id: 12, active: true, evidence: REF }, ruleEvidence());
    expect(b.ingestRuleRequest(on)).toEqual({ path: '/api/email-ingest/rules/12', method: 'PUT', idempotent: false,
      body: { active: 1, expected_base: { definition_updated_at: STAMP } } });
    const add = await normalizeActionDraft(db, { kind: 'ingest_rule.action_add.v1', email_ingest_rule_id: 12,
      action: { action_type: 'sequence', config: { template_id: 5 }, position: 2 }, evidence: REF }, ruleEvidence());
    expect(b.ingestRuleRequest(add)).toEqual({ path: '/api/email-ingest/rules/12/actions', method: 'POST', idempotent: false,
      body: { action_type: 'sequence', config: { template_id: 5 }, active: 1, position: 2, expected_base: { definition_updated_at: STAMP } } });
    const au = await normalizeActionDraft(db, { kind: 'ingest_rule.action_update.v1', email_ingest_rule_id: 12, rule_action_id: 40,
      changes: { name: 'Deadlines', active: false }, evidence: REF }, ruleEvidence());
    expect(b.ingestRuleRequest(au)).toEqual({ path: '/api/email-ingest/rule-actions/40', method: 'PUT', idempotent: false,
      body: { name: 'Deadlines', active: 0, expected_base: { definition_updated_at: STAMP } } });
    const rm = await normalizeActionDraft(db, { kind: 'ingest_rule.action_remove.v1', email_ingest_rule_id: 12, rule_action_id: 40, evidence: REF }, ruleEvidence());
    expect(b.ingestRuleRequest(rm)).toEqual({ path: '/api/email-ingest/rule-actions/40', method: 'DELETE', idempotent: false,
      body: { expected_base: { definition_updated_at: STAMP } } });
  });

  test('results: the receipt is the rule; a DELETE 204 is a confirmed removal; a mismatched rule id is refused', async () => {
    const draft = { kind: 'ingest_rule.action_remove.v1', channel: 'email', rule: { rule_id: 12 } };
    const apiSend = jest.fn(async () => null);
    const live = browser({ apiSend });
    const res = await live.ingestRuleDispatch({ path: '/api/email-ingest/rule-actions/40', method: 'DELETE', body: {} });
    expect(res).toEqual({ deleted: true });
    expect(live.ingestRuleResult(draft, res)).toEqual({ ingest_rule_id: 12 });
    await expect(live.ingestRuleDispatch({ path: '/api/email-ingest/rules/12', method: 'PUT', body: {} })).rejects.toThrow(/Request failed/);
    expect(b.ingestRuleResult({ kind: 'ingest_rule.create.v1' }, { rule: { id: 31 } })).toEqual({ ingest_rule_id: 31 });
    expect(() => b.ingestRuleResult({ kind: 'ingest_rule.update.v1', rule: { rule_id: 12 } }, { rule: { id: 13 } })).toThrow(/different rule/);
    expect(b.ingestRuleResult({ kind: 'ingest_rule.action_add.v1', rule: { rule_id: 12 } }, { action: { id: 50, rule_id: 12 } })).toEqual({ ingest_rule_id: 12 });
  });

  test('click-time precheck: a moved stamp or a vanished rule refuses; the same stamp passes; create needs none', async () => {
    const draft = { kind: 'ingest_rule.update.v1', channel: 'phone', rule: { rule_id: 3 }, expected_base: { definition_updated_at: STAMP } };
    const same = browser({ apiSend: jest.fn(async () => ({ rule: { id: 3, definition_updated_at: STAMP } })) });
    expect(await same.ingestRulePrecheck(draft)).toBe('');
    const moved = browser({ apiSend: jest.fn(async () => ({ rule: { id: 3, definition_updated_at: '2026-10-27T10:00:00.124Z' } })) });
    expect(await moved.ingestRulePrecheck(draft)).toMatch(/changed since this card was prepared, so nothing was changed/);
    const gone = browser({ apiSend: jest.fn(async () => { const e = new Error('Rule not found'); e.status = 404; throw e; }) });
    expect(await gone.ingestRulePrecheck(draft)).toMatch(/no longer exists/);
    const reader = jest.fn();
    expect(await browser({ apiSend: reader }).ingestRulePrecheck({ kind: 'ingest_rule.create.v1', channel: 'email' })).toBe('');
    expect(reader).not.toHaveBeenCalled();
  });

  test('the card text says LIVE for an active rule, shows before/after, the code capability, and the change log', async () => {
    const upd = await normalizeActionDraft(fakeDb(), { kind: 'ingest_rule.update.v1', email_ingest_rule_id: 12,
      changes: { transform_mode: 'code', transform_config: { code: 'return { n: 1 };' } }, evidence: REF }, ruleEvidence());
    const text = b.ingestRuleText(upd);
    expect(text).toMatch(/Live: LIVE: this rule is ACTIVE/);
    expect(text).toMatch(/transform_mode — before: passthrough\ntransform_mode — after: code/);
    expect(text).toMatch(/only a user holding automations\.manage can apply it/);
    expect(text).toMatch(/Undo: every change is recorded before\/after in the rule's change log/);
    expect(b.ingestRuleLabel({ kind: 'ingest_rule.set_active.v1', active: 1 })).toBe('Activate ingest rule');
    expect(b.ingestRuleLabel({ kind: 'ingest_rule.set_active.v1', active: 0 })).toBe('Deactivate ingest rule');
  });
});

describe('the builder → route seam: the browser\'s body is what the route hands its service', () => {
  const express = require('express');
  const http = require('http');
  let mockAuth;
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../lib/auth.jwtOrApiKey', () => jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));
  });
  afterAll(() => { jest.dontMock('../lib/auth.jwtOrApiKey'); jest.resetModules(); });

  function send(router, db, { method, path: p, body, headers = {} }) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = db; next(); });
    a.use(router);
    const data = JSON.stringify(body || {});
    return new Promise((resolve, reject) => {
      const srv = a.listen(0, () => {
        const req = http.request({ port: srv.address().port, path: p, method,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }); });
        });
        req.on('error', (e) => { srv.close(); reject(e); });
        req.end(data);
      });
    });
  }

  test.each(['email', 'phone'])('%s: create reaches createRule with active 0 + the actions; an update reaches updateRule with the expected_base', async (ch) => {
    mockAuth = { type: 'jwt', userId: 2, username: 'staff', roles: ['staff'] };
    const svc = require(`../services/${ch}IngestRuleService`);
    const router = require(`../routes/api.${ch}Ingest`);
    const created = jest.spyOn(svc, 'createRule').mockImplementation(async () => ({ id: 31, actions: [] }));
    const updated = jest.spyOn(svc, 'updateRule').mockImplementation(async () => ({ id: 12 }));
    const getById = jest.spyOn(svc, 'getById').mockImplementation(async () => ({ id: 12, match_mode: 'conditions', transform_mode: 'passthrough', actions: [] }));
    const db = { query: async () => [[]] };
    try {
      const draft = { kind: 'ingest_rule.create.v1', channel: ch,
        rule: { name: 'n', position: 0, match_mode: 'conditions', match_config: COND, transform_mode: 'passthrough', transform_config: null },
        actions: [{ action_type: 'workflow', config: { workflow_id: 24 }, summary: 'x', side_effect: 'starts-workflow', notes: [] }] };
      const req = browser().ingestRuleRequest(draft);
      const res = await send(router, db, req);
      expect(res.status).toBe(201);
      expect(created.mock.calls[0][1]).toEqual(req.body);
      expect(created.mock.calls[0][1]).toMatchObject({ active: 0, actions: [{ action_type: 'workflow', config: { workflow_id: 24 }, active: 1, position: 0 }] });
      const upd = browser().ingestRuleRequest({ kind: 'ingest_rule.update.v1', channel: ch, rule: { rule_id: 12 },
        changes: { name: 'N2' }, expected_base: { definition_updated_at: STAMP } });
      expect((await send(router, db, upd)).status).toBe(200);
      expect(updated.mock.calls[0][2]).toEqual(upd.body);
      expect(updated.mock.calls[0][4]).toMatchObject({ expectedBase: { definition_updated_at: STAMP } });
    } finally { created.mockRestore(); updated.mockRestore(); getById.mockRestore(); }
  });
});
