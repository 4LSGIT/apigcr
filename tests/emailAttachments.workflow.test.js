// tests/emailAttachments.workflow.test.js
//
/**
 * Email attachments S2 (ref/EMAIL_ATTACHMENTS_DESIGN.md §7) — the "docs@
 * intake" workflow and rule 24's match/transform, AS SHIPPED: the JSON blocks
 * are read out of the two console scripts that write them
 * (ref/migrations/2026-11-06_docs_intake_{shadow,cutover}.console.js), so a
 * definition edited in a script is the definition tested here.
 *
 *   1. The workflow on the REAL engine (lib/workflow_engine advanceWorkflow +
 *      the real noop / evaluate_condition / set_next / send_email /
 *      email_attachments_* functions) over an in-memory execution row — the
 *      harness of tests/workflowEngine.cancelAndLoopGuard.test.js. Stubbed:
 *      the filing service (its SQL + Dropbox run in
 *      tests/emailAttachments.mysql.test.js), emailService, the opt-out
 *      check, and request_decision (its pause/resume is the decision route's;
 *      the stub answers at once, and the params it was handed are then run
 *      through the REAL request_decision's validation).
 *   2. Every step passes the save-time validator and the publish validator.
 *   3. MATCH on the production matcher; the shadow transform's new return
 *      and the cutover transform in the production runner (QuickJS guest).
 *   4. v3, the BURST DIGEST (S2d, design §8; ref/migrations/
 *      2026-11-09_docs_intake_digest.console.js): its base is the v2 the two
 *      scripts above left live; the wait loop, the send / done split and the
 *      burst's one decision on the real engine (the digest service stubbed —
 *      its SQL runs in tests/emailAttachments.mysql.test.js).
 *
 *   npx jest tests/emailAttachments.workflow.test.js
 */

'use strict';

jest.mock('../lib/taskQueue', () => ({ enqueueJobDispatch: jest.fn(async () => false), ACCEL_WINDOW_MS: 90_000 }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../services/emailAttachmentFilingService', () => ({
  fileMessageAttachments: jest.fn(), refileMessageAttachments: jest.fn(),
}));
jest.mock('../services/emailAttachmentDigestService', () => ({ check: jest.fn(), refileDigest: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/optoutService', () => ({
  ...jest.requireActual('../services/optoutService'),
  assertNotOptedOut: jest.fn(async () => {}),
}));

const fs = require('fs');
const path = require('path');
const { advanceWorkflow } = require('../lib/workflow_engine');
const registry = require('../lib/internal_functions');
const filingSvc = require('../services/emailAttachmentFilingService');
const digestSvc = require('../services/emailAttachmentDigestService');
const emailService = require('../services/emailService');
const notice = require('../services/emailAttachmentNotice');
const ruleSvc = require('../services/emailIngestRuleService');
const { validateWorkflowDraft, BRANCH_TARGET_PARAMS, isTerminalSentinel } = require('../lib/versionDiff');

const MIG = path.join(__dirname, '..', 'ref', 'migrations');
const SHADOW = fs.readFileSync(path.join(MIG, '2026-11-06_docs_intake_shadow.console.js'), 'utf8');
const CUTOVER = fs.readFileSync(path.join(MIG, '2026-11-06_docs_intake_cutover.console.js'), 'utf8');
const DIGEST = fs.readFileSync(path.join(MIG, '2026-11-09_docs_intake_digest.console.js'), 'utf8');
function block(src, name) {
  const open = `/* JSON:${name} */`;
  const close = `/* /JSON:${name} */`;
  const parts = src.split(open);
  if (parts.length !== 2) throw new Error(`marker ${open} must occur exactly once`);
  return JSON.parse(parts[1].split(close)[0]);
}
const STEPS = block(SHADOW, 'STEPS');
const MATCH = block(SHADOW, 'MATCH');
const NEW_RETURN = block(SHADOW, 'NEW_RETURN');
const CUTOVER_CODE = block(CUTOVER, 'CUTOVER_CODE');
const SHADOW_STEP1 = block(CUTOVER, 'SHADOW_STEP1');
const LIVE_STEP1 = block(CUTOVER, 'LIVE_STEP1');
// The workflow as the cutover leaves it: step 1 edited, nothing else.
const CUT_STEPS = STEPS.map((s, i) => (i === 0 ? { ...s, config: LIVE_STEP1 } : s));
const V2_STEPS = block(DIGEST, 'V2_STEPS');
const V3_STEPS = block(DIGEST, 'V3_STEPS');

// ── In-memory execution row (the cancelAndLoopGuard harness, trimmed) ───────
const EXEC_ID = 901;
const WF_ID = 88;
function makeWorld(stepDefs, variables) {
  const W = {
    exec: {
      id: EXEC_ID, workflow_id: WF_ID, contact_id: null, status: 'active',
      current_step_number: 1, steps_executed_count: 1, // not "fresh": skips the capture probe
      variables: { ...variables }, init_data: { ...variables }, workflow_version: 1,
    },
    steps: new Map(stepDefs.map((d, i) => [i + 1, {
      id: 6000 + i + 1, workflow_id: WF_ID, version: 1, step_number: i + 1, type: d.type, label: d.label,
      config: JSON.stringify(d.config), error_policy: d.error_policy ? JSON.stringify(d.error_policy) : null,
    }])),
    jobs: [],
    history: [],
  };
  const rules = [
    [/SELECT \* FROM workflow_executions[\s\S]*status IN \('active', 'delayed'\)[\s\S]*FOR UPDATE/i, () =>
      [['active', 'delayed'].includes(W.exec.status) ? [{ ...W.exec, variables: { ...W.exec.variables } }] : []]],
    [/UPDATE workflow_executions\s+SET status = 'processing'/i, () => { W.exec.status = 'processing'; return [{ affectedRows: 1 }]; }],
    [/SELECT capture_mode FROM workflows/i, () => [[{ capture_mode: 'off' }]]],
    [/SELECT \* FROM workflow_steps WHERE workflow_id = \? AND version = \? AND step_number = \?/i, (p) => {
      const s = W.steps.get(p[2]);
      return [s ? [{ ...s }] : []];
    }],
    [/SELECT variables, status FROM workflow_executions WHERE id = \?/i, () =>
      [[{ variables: { ...W.exec.variables }, status: W.exec.status }]]],
    [/SELECT variables FROM workflow_executions WHERE id = \?/i, () => [[{ variables: { ...W.exec.variables } }]]],
    [/UPDATE workflow_executions SET variables = \?/i, (p) => { W.exec.variables = JSON.parse(p[0]); return [{ affectedRows: 1 }]; }],
    [/INSERT INTO workflow_execution_steps/i, (p) => {
      W.history.push({ step_number: p[1], status: p[3], error: p[5] });
      return [{ insertId: W.history.length }];
    }],
    [/SET steps_executed_count = steps_executed_count \+ 1/i, () => { W.exec.steps_executed_count++; return [{ affectedRows: 1 }]; }],
    [/UPDATE workflow_executions\s+SET current_step_number = \?/i, (p) => { W.exec.current_step_number = p[0]; return [{ affectedRows: 1 }]; }],
    [/UPDATE workflow_executions\s+SET status = \?,\s*completed_at = NOW\(\)/i, (p) => {
      W.exec.status = p[0]; W.exec.current_step_number = null; return [{ affectedRows: 1 }];
    }],
    [/UPDATE workflow_executions SET status = \?, updated_at = NOW\(\)/i, (p) => { W.exec.status = p[0]; return [{ affectedRows: 1 }]; }],
    [/SELECT id FROM scheduled_jobs[\s\S]*idempotency_key = \?/i, () => [[]]],
    [/INSERT INTO scheduled_jobs/i, (p) => { W.jobs.push({ at: p[0], data: JSON.parse(p[2]) }); return [{ insertId: W.jobs.length }]; }],
    [/DELETE FROM scheduled_jobs[\s\S]*workflow_resume/i, () => [{ affectedRows: 0 }]],
    [/SELECT COUNT\(\*\) as total/i, () => [[{
      total: W.history.length, failed: W.history.filter(h => h.status === 'failed').length,
    }]]],
    [/SELECT status FROM workflow_executions WHERE id = \?/i, () => [[{ status: W.exec.status }]]],
  ];
  const db = {
    async query(rawSql, params = []) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      for (const [re, h] of rules) if (re.test(sql)) return h(params, sql);
      throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
    },
    async withTransaction(fnTx) { return fnTx(db); },
  };
  return { W, db };
}
const ranSteps = (W) => W.history.map(h => h.step_number);

// ── Realistic filing outputs: decision_options + notices built the way the
//    service builds them (notice.render is the real renderer) ──────────────
const CASES = [
  { case_id: 'CF8ZT7VE', case_number: '26-41234', case_type: 'Ch. 7', case_stage: 'Open' },
  { case_id: 'PVXC1RMM', case_number: '', case_type: 'Ch. 13', case_stage: 'Pending' },
];
function filingOutput({ decision = false } = {}) {
  const r = {
    mail_message_id: 3301, mailbox_id: 2,
    from: { email: 'client@example.com', name: 'Jane Client' },
    subject: 'my paystubs', date: '2026-11-06T15:00:00.000Z', target: 'auto',
    match: { case_id: decision ? null : 'CF8ZT7VE', method: decision ? null : 'sender_open_case',
      flag: decision ? 'multiple_open_cases' : null, candidates: decision ? CASES : [] },
    placement: decision ? 'unsorted' : 'case',
    case_id: decision ? null : 'CF8ZT7VE', contact_id: 77,
    folder_path: decision ? '/Unsorted Uploads/Emailed 261106 - Client, Jane' : '/Clients/Client, Jane/Client Uploads/Emailed 261106',
    folder_link: 'https://www.dropbox.com/scl/fo/abc/def',
    app_url: 'https://app.4lsg.com', case_link: null, contact_link: null,
    files: [{ part: '2', filename: 'paystub.pdf', status: 'filed', path: '/x/paystub.pdf', filed_name: 'paystub.pdf', bytes: 1000, document_id: 9 }],
    skipped: [], counts: { filed: 1, already_filed: 0, in_progress: 0, failed: 0, skipped: 0 }, warnings: [],
  };
  r.needs_decision = decision;
  r.decision_options = decision
    ? [...CASES.map(c => ({ label: `${c.case_id} — ${[c.case_number, c.case_type, c.case_stage].filter(Boolean).join(' · ')}`.slice(0, 100), value: c.case_id })),
      { label: 'Leave it in Unsorted', value: 'unsorted' }]
    : [];
  const prefix = 'New email to Docs@4LSG.com — ';
  const n = notice.render({ result: r, subjectPrefix: prefix, title: 'docs@4lsg.com' });
  r.notice_subject = n.subject;
  r.notice_html = n.html;
  r.notice_text = n.text;
  r.notice_html_decision = decision ? notice.render({ result: r, subjectPrefix: prefix, title: 'docs@4lsg.com', withOptions: true }).html : null;
  return r;
}
// rule 24's transform output in the shadow (digest fields + the reference)
const INIT = {
  subject: 'New email to Docs@4LSG.com — Jane Client (1 file)', html: '<html>digest</html>', text: 'digest',
  sender_email: 'client@example.com', files: 1, case_id: null,
  mail_message_id: 3301, source: 'gmail-firm', message_id: '1a1a42d6e7cb5b86',
};

// request_decision stand-in: answers at once with `choice`, keeps the meta so
// the engine still treats it as the control step it is.
const realRequestDecision = registry.request_decision;
let decisionCalls;
let choice;
beforeAll(() => {
  registry.request_decision = Object.assign(async (params) => {
    decisionCalls.push(params);
    return { success: true, next_step: params.nextStep, set_vars: { [params.result_var]: choice } };
  }, { __meta: realRequestDecision.__meta });
});
afterAll(() => { registry.request_decision = realRequestDecision; });
beforeEach(() => {
  decisionCalls = [];
  choice = undefined;
  filingSvc.fileMessageAttachments.mockReset();
  filingSvc.refileMessageAttachments.mockReset();
  emailService.sendEmail.mockReset();
  emailService.sendEmail.mockImplementation(async () => ({ ok: true }));
  digestSvc.check.mockReset();
  digestSvc.refileDigest.mockReset();
});

// The real request_decision, run until its first DB read: reaching the DB
// means every param check passed.
async function realDecisionAccepts(params) {
  const db = { query: async () => { throw new Error('SENTINEL_DB'); } };
  return realRequestDecision({ ...params, _execution_id: EXEC_ID, _step_number: 6 }, db);
}

async function run(variables = INIT, steps = STEPS) {
  const { W, db } = makeWorld(steps, variables);
  await advanceWorkflow(EXEC_ID, db);
  return W;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('docs@ intake on the real engine', () => {
  test('filed to a case: file → notice to the step-1 recipient → end', async () => {
    const out = filingOutput();
    filingSvc.fileMessageAttachments.mockResolvedValue(out);
    const W = await run();
    expect(ranSteps(W)).toEqual([1, 2, 3, 4, 5]);
    expect(W.exec.status).toBe('completed');
    const [, opts] = filingSvc.fileMessageAttachments.mock.calls[0];
    expect(opts.ref).toEqual({ mail_message_id: '3301', source: 'gmail-firm', message_id: '1a1a42d6e7cb5b86',
      mailbox_id: undefined, folder: undefined, uid: undefined });
    expect(opts.target).toBe('auto');
    expect(opts.noticeSubjectPrefix).toBe('New email to Docs@4LSG.com — ');   // SB's mail filters key on it
    expect(opts.noticeTitle).toBe('docs@4lsg.com');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail.mock.calls[0][1]).toEqual({
      from: 'automations@4lsg.com', to: 'it@4lsg.com',
      subject: out.notice_subject, html: out.notice_html, text: out.notice_text,
    });
    expect(decisionCalls).toEqual([]);
    expect(filingSvc.refileMessageAttachments).not.toHaveBeenCalled();
    expect(W.exec.variables.needs_decision).toBe('false');
  });

  test('no row id on the envelope: the step resolves by source + message_id', async () => {
    filingSvc.fileMessageAttachments.mockResolvedValue(filingOutput());
    await run({ ...INIT, mail_message_id: null });
    expect(filingSvc.fileMessageAttachments.mock.calls[0][1].ref).toEqual({
      mail_message_id: undefined, source: 'gmail-firm', message_id: '1a1a42d6e7cb5b86',
      mailbox_id: undefined, folder: undefined, uid: undefined });
  });

  test('case unclear: one button per candidate, the pick moves the files', async () => {
    const out = filingOutput({ decision: true });
    filingSvc.fileMessageAttachments.mockResolvedValue(out);
    filingSvc.refileMessageAttachments.mockResolvedValue({ case_id: 'CF8ZT7VE', moved: [{ part: '2' }], already_there: [], failed: [], warnings: [],
      folder_path: '/Clients/Client, Jane/Client Uploads/Emailed 261106', folder_link: 'https://www.dropbox.com/x' });
    choice = 'CF8ZT7VE';
    const W = await run();
    expect(ranSteps(W)).toEqual([1, 2, 3, 6, 7, 8, 9]);
    expect(W.exec.status).toBe('completed');
    expect(decisionCalls).toHaveLength(1);
    const d = decisionCalls[0];
    expect(Array.isArray(d.options)).toBe(true);                 // the ARRAY, not "[object Object],…"
    expect(d.options).toEqual(out.decision_options);
    expect(d.recipient_kind).toBe('user');
    expect(String(d.recipient_id)).toBe('6');
    expect(d.email_subject).toBe(out.notice_subject);
    expect(d.email_html).toBe(out.notice_html_decision);
    expect(d.email_html).toContain('[[options_html]]');
    expect(d).toMatchObject({ result_var: 'chosen_case', timeout: '7d', timeout_value: 'unsorted', nextStep: 7,
      send_email: true, create_task: false, email_from: 'automations@4lsg.com' });
    expect(d.question).toBe('Which case do the files emailed by client@example.com belong to?');
    await expect(realDecisionAccepts(d)).rejects.toThrow('SENTINEL_DB');
    expect(filingSvc.refileMessageAttachments).toHaveBeenCalledTimes(1);
    expect(filingSvc.refileMessageAttachments.mock.calls[0][1]).toMatchObject({ mailMessageId: '3301', caseId: 'CF8ZT7VE' });
    expect(emailService.sendEmail).not.toHaveBeenCalled();       // the decision email is request_decision's own
    expect(W.exec.variables.refile_failed).toBe('0');
  });

  test('"Leave it in Unsorted" (or the 7-day timeout): nothing moves', async () => {
    filingSvc.fileMessageAttachments.mockResolvedValue(filingOutput({ decision: true }));
    choice = 'unsorted';
    const W = await run();
    expect(ranSteps(W)).toEqual([1, 2, 3, 6, 7]);
    expect(W.exec.status).toBe('completed');
    expect(filingSvc.refileMessageAttachments).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('a move that leaves files behind says so (plain text, no email-derived HTML)', async () => {
    const out = filingOutput({ decision: true });
    filingSvc.fileMessageAttachments.mockResolvedValue(out);
    filingSvc.refileMessageAttachments.mockResolvedValue({ case_id: 'CF8ZT7VE', moved: [], already_there: [], warnings: [],
      failed: [{ part: '2', filename: 'a.pdf', error: 'x' }, { part: '3', filename: 'b.pdf', error: 'y' }],
      folder_path: '/Clients/Client, Jane/Client Uploads/Emailed 261106', folder_link: 'https://www.dropbox.com/y' });
    choice = 'CF8ZT7VE';
    const W = await run();
    expect(ranSteps(W)).toEqual([1, 2, 3, 6, 7, 8, 9, 10]);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const m = emailService.sendEmail.mock.calls[0][1];
    expect(m.to).toBe('it@4lsg.com');
    expect(m.subject).toBe('NOT MOVED — ' + out.notice_subject);
    expect(m.html).toBeUndefined();
    expect(m.text).toContain('2 of the files emailed by client@example.com could not be moved to case CF8ZT7VE');
    expect(m.text).toContain(out.folder_path);
    expect(m.text).toContain(`workflow execution ${EXEC_ID}, mail message 3301`);
  });

  describe('after the cutover\'s step-1 edit, every message reaches SB', () => {
    // Step 1 is the ONE recipient setting: a step that named it@ / user 6
    // itself would keep notifying Fred after the cutover.
    test('the notice', async () => {
      filingSvc.fileMessageAttachments.mockResolvedValue(filingOutput());
      await run(INIT, CUT_STEPS);
      expect(emailService.sendEmail.mock.calls.map(c => c[1].to)).toEqual(['shoshana@metrodetroitbankruptcylaw.com']);
    });
    test('the pick-the-case email, and the left-behind note', async () => {
      filingSvc.fileMessageAttachments.mockResolvedValue(filingOutput({ decision: true }));
      filingSvc.refileMessageAttachments.mockResolvedValue({ case_id: 'CF8ZT7VE', moved: [], already_there: [], warnings: [],
        failed: [{ part: '2', filename: 'a.pdf', error: 'x' }], folder_path: '/c', folder_link: 'https://www.dropbox.com/c' });
      choice = 'CF8ZT7VE';
      const W = await run(INIT, CUT_STEPS);
      expect(ranSteps(W)).toEqual([1, 2, 3, 6, 7, 8, 9, 10]);
      expect(decisionCalls.map(d => [d.recipient_kind, String(d.recipient_id)])).toEqual([['user', '5']]);
      expect(emailService.sendEmail.mock.calls.map(c => c[1].to)).toEqual(['shoshana@metrodetroitbankruptcylaw.com']);
    });
  });

  describe('failures abort the run (the error sweep pages IT) instead of carrying on', () => {
    let st;
    beforeEach(() => { st = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; }); });
    afterEach(() => st.mockRestore());

    test('filing throws: retried, then failed — no notice built from nothing', async () => {
      filingSvc.fileMessageAttachments.mockRejectedValue(new Error('MESSAGE_NOT_STORED'));
      const W = await run();
      expect(filingSvc.fileMessageAttachments).toHaveBeenCalledTimes(3);     // max_retries 2
      expect(W.exec.status).toBe('failed');
      expect(ranSteps(W)).toEqual([1, 2]);
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    test('the notice will not send: retried, then failed', async () => {
      filingSvc.fileMessageAttachments.mockResolvedValue(filingOutput());
      emailService.sendEmail.mockRejectedValue(new Error('relay down'));
      const W = await run();
      expect(emailService.sendEmail).toHaveBeenCalledTimes(3);
      expect(W.exec.status).toBe('failed');
      expect(ranSteps(W)).toEqual([1, 2, 3, 4]);
    });
  });

  test('the real request_decision refuses options that did not resolve to an array', async () => {
    // An unset variable resolves to '' — the save-time pass on the placeholder
    // must not become a run-time pass.
    const out = filingOutput({ decision: true });
    const base = { question: 'q', result_var: 'chosen_case', timeout: '7d', timeout_value: 'unsorted',
      recipient_kind: 'user', recipient_id: '6' };
    await expect(realDecisionAccepts({ ...base, options: '' })).rejects.toThrow('options must be an array');
    await expect(realDecisionAccepts({ ...base, options: '[object Object]' })).rejects.toThrow('options must be an array');
    await expect(realDecisionAccepts({ ...base, options: out.decision_options })).rejects.toThrow('SENTINEL_DB');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('docs@ intake — the definitions pass the save and publish gates', () => {
  test('every step passes the save-time validator', () => {
    for (const s of STEPS) {
      expect([s.config.function_name, registry.__validateFunctionParams(s.config.function_name, s.config.params)])
        .toEqual([s.config.function_name, null]);
    }
  });
  test('the draft passes publish validation (targets in range, no pause-free loop, retry budget)', () => {
    const rows = STEPS.map((s, i) => ({ step_number: i + 1, type: s.type, config: JSON.stringify(s.config),
      error_policy: s.error_policy ? JSON.stringify(s.error_policy) : null }));
    const v = validateWorkflowDraft(rows, { branchTargetParams: BRANCH_TARGET_PARAMS, isTerminalSentinel });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
  test('the cutover script knows the shadow\'s labels and step-1 recipient', () => {
    const labels = STEPS.map(s => s.label);
    for (const l of labels) expect(CUTOVER).toContain(JSON.stringify(l).slice(1, -1));
    expect(STEPS[0].config).toEqual(SHADOW_STEP1);
    expect(SHADOW_STEP1.set_vars).toEqual({ notify_email: 'it@4lsg.com', notify_user_id: 6 });
    expect(LIVE_STEP1.set_vars).toEqual({ notify_email: 'shoshana@metrodetroitbankruptcylaw.com', notify_user_id: 5 });
    // the cutover recognises the shadow transform by this line of NEW_RETURN
    expect(NEW_RETURN).toContain('  // docs@ intake workflow (ref/EMAIL_ATTACHMENTS_DESIGN.md §7): the stored message it files from\n');
    expect(CUTOVER).toContain("'  // docs@ intake workflow (ref/EMAIL_ATTACHMENTS_DESIGN.md §7): the stored message it files from\\n'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('v3 — one notice per burst (S2d)', () => {
  // A burst's notice as email_attachments_digest hands it over (here: the
  // single-email notice — a burst of one — or that notice with options).
  function digestSend(filing, over = {}) {
    return {
      action: 'send', ended_by: 'quiet', digest_key: 'docs@', digest_of: 3305, mail_message_id: filing.mail_message_id,
      mail_message_ids: [3301, 3305], count: 2, from: filing.from, files_filed: 2,
      unsorted_ids: filing.placement === 'unsorted' ? [3301, 3305] : [],
      unsorted_folder_path: filing.placement === 'unsorted' ? filing.folder_path : null,
      unsorted_folder_link: filing.placement === 'unsorted' ? filing.folder_link : null,
      case_ids: filing.case_id ? [filing.case_id] : [],
      needs_decision: filing.needs_decision, decision_options: filing.decision_options,
      notice_subject: filing.notice_subject + ' [digest]', notice_html: filing.notice_html.replace('</body>', 'digest</body>'),
      notice_text: filing.notice_text + '\n(digest)', notice_html_decision: filing.notice_html_decision,
      warnings: [], ...over,
    };
  }
  const waitOut = (secs) => ({ action: 'wait', wait: `${secs}s`, wait_ms: secs * 1000, pending: 2, digest_of: null, digest_key: 'docs@', mail_message_id: 3301 });
  /** Run, then resume every wait the way process_jobs does (status active, current_step = nextStep). */
  async function runToEnd(variables = INIT, steps = V3_STEPS) {
    const { W, db } = makeWorld(steps, variables);
    await advanceWorkflow(EXEC_ID, db);
    for (let i = 0; i < 10 && W.exec.status === 'delayed'; i++) {
      const job = W.jobs[W.jobs.length - 1];
      W.exec.status = 'active';
      W.exec.current_step_number = job.data.nextStep;
      await advanceWorkflow(EXEC_ID, db);
    }
    return W;
  }

  test('its base is exactly the v2 the shadow + cutover scripts left live', () => {
    expect(V2_STEPS).toEqual(CUT_STEPS);
  });

  test('the sender is still sending: file at once, wait, ask again — then ONE notice (the burst\'s) to SB', async () => {
    const filing = filingOutput();
    filingSvc.fileMessageAttachments.mockResolvedValue(filing);
    const sent = digestSend(filing);
    digestSvc.check.mockResolvedValueOnce(waitOut(275)).mockResolvedValueOnce(waitOut(65)).mockResolvedValueOnce(sent);
    const t0 = Date.now();
    const W = await runToEnd();
    expect(ranSteps(W)).toEqual([1, 2, 3, 4, 5, 3, 4, 5, 3, 4, 6, 7, 8, 9]);
    expect(W.exec.status).toBe('completed');
    expect(filingSvc.fileMessageAttachments).toHaveBeenCalledTimes(1);           // the files go in at once
    expect(filingSvc.fileMessageAttachments.mock.calls[0][1]).toMatchObject({ digestKey: 'docs@', noticeSubjectPrefix: 'New email to Docs@4LSG.com — ' });
    expect(digestSvc.check).toHaveBeenCalledTimes(3);
    expect(digestSvc.check.mock.calls.map(c => c[1])).toEqual(Array(3).fill({ digestKey: 'docs@', mailMessageId: '3301', quietMs: 300_000, capMs: 1_800_000 }));
    // each wait is a real pause of the computed length, resuming at the digest step
    expect(W.jobs.map(j => j.data.nextStep)).toEqual([3, 3]);
    const delays = W.jobs.map(j => (new Date(j.at).getTime() - t0) / 1000);
    expect(delays[0]).toBeGreaterThanOrEqual(274);
    expect(delays[0]).toBeLessThan(290);
    expect(delays[1]).toBeGreaterThanOrEqual(64);
    expect(delays[1]).toBeLessThan(80);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail.mock.calls[0][1]).toEqual({
      from: 'automations@4lsg.com', to: 'shoshana@metrodetroitbankruptcylaw.com',
      subject: sent.notice_subject, html: sent.notice_html, text: sent.notice_text,
    });
    expect(W.exec.variables.needs_decision).toBe('false');
  });

  test('another email\'s execution covers this one: end, no notice, no decision', async () => {
    filingSvc.fileMessageAttachments.mockResolvedValue(filingOutput());
    digestSvc.check.mockResolvedValueOnce(waitOut(200)).mockResolvedValueOnce({ action: 'done', digest_of: 3305, digest_key: 'docs@', mail_message_id: 3301 });
    const W = await runToEnd();
    expect(ranSteps(W)).toEqual([1, 2, 3, 4, 5, 3, 4, 6]);
    expect(W.exec.status).toBe('completed');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(decisionCalls).toEqual([]);
  });

  test('the burst\'s ONE decision: the burst\'s options and notice; the answer moves the burst', async () => {
    const filing = filingOutput({ decision: true });
    filingSvc.fileMessageAttachments.mockResolvedValue(filing);
    const sent = digestSend(filing, { decision_options: [...filing.decision_options.slice(0, -1), { label: 'Leave them in Unsorted', value: 'unsorted' }],
      notice_html_decision: filing.notice_html_decision.replace('</body>', 'digest</body>') });
    digestSvc.check.mockResolvedValueOnce(sent);
    digestSvc.refileDigest.mockResolvedValue({ case_id: 'CF8ZT7VE', mail_message_ids: [3301, 3305], warnings: [],
      moved: [{ part: '2', mail_message_id: 3301 }], already_there: [], failed: [{ part: '2', filename: 'b.pdf', error: 'x', mail_message_id: 3305 }],
      folder_path: '/Clients/Client, Jane/Client Uploads/Emailed 261106', folder_link: 'https://www.dropbox.com/m', folders: [] });
    choice = 'CF8ZT7VE';
    const W = await runToEnd();
    expect(ranSteps(W)).toEqual([1, 2, 3, 4, 6, 7, 10, 11, 12, 13, 14]);
    expect(W.exec.status).toBe('completed');
    expect(decisionCalls).toHaveLength(1);
    const d = decisionCalls[0];
    expect(d.options).toEqual(sent.decision_options);                            // the ARRAY
    expect(d.email_html).toBe(sent.notice_html_decision);
    expect(d.email_subject).toBe(sent.notice_subject);
    expect(d).toMatchObject({ recipient_kind: 'user', result_var: 'chosen_case', timeout: '7d', timeout_value: 'unsorted', nextStep: 11 });
    expect(String(d.recipient_id)).toBe('5');
    expect(d.question).toBe('Which case do the files emailed by client@example.com belong to?');
    await expect(realDecisionAccepts(d)).rejects.toThrow('SENTINEL_DB');
    expect(digestSvc.refileDigest).toHaveBeenCalledTimes(1);
    expect(digestSvc.refileDigest.mock.calls[0][1]).toMatchObject({ digestKey: 'docs@', digestOf: '3305', caseId: 'CF8ZT7VE' });
    expect(filingSvc.refileMessageAttachments).not.toHaveBeenCalled();
    const m = emailService.sendEmail.mock.calls.map(c => c[1]);
    expect(m).toHaveLength(1);                                                   // the left-behind note only
    expect(m[0]).toMatchObject({ to: 'shoshana@metrodetroitbankruptcylaw.com', subject: 'NOT MOVED — ' + sent.notice_subject });
    expect(m[0].html).toBeUndefined();
    expect(m[0].text).toContain('1 of the files emailed by client@example.com could not be moved to case CF8ZT7VE');
    expect(m[0].text).toContain(`still in the unsorted folder:\n${filing.folder_path}\n${filing.folder_link}`);
    expect(m[0].text).toContain(`workflow execution ${EXEC_ID}, notice 3305`);
  });

  test('"Leave them in Unsorted" (or the timeout): nothing moves', async () => {
    const filing = filingOutput({ decision: true });
    filingSvc.fileMessageAttachments.mockResolvedValue(filing);
    digestSvc.check.mockResolvedValueOnce(digestSend(filing));
    choice = 'unsorted';
    const W = await runToEnd();
    expect(ranSteps(W)).toEqual([1, 2, 3, 4, 6, 7, 10, 11]);
    expect(digestSvc.refileDigest).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('a digest step that keeps failing aborts the run (the error sweep pages IT) — no notice from nothing', async () => {
    const st = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    try {
      filingSvc.fileMessageAttachments.mockResolvedValue(filingOutput());
      digestSvc.check.mockRejectedValue(new Error('NOT_QUEUED'));
      const W = await runToEnd();
      expect(digestSvc.check).toHaveBeenCalledTimes(3);
      expect(W.exec.status).toBe('failed');
      expect(ranSteps(W)).toEqual([1, 2, 3]);
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    } finally { st.mockRestore(); }
  });

  test('every v3 step passes the save-time validator; the draft passes publish validation (no pause-free loop)', () => {
    for (const st of V3_STEPS) {
      expect([st.config.function_name, registry.__validateFunctionParams(st.config.function_name, st.config.params)])
        .toEqual([st.config.function_name, null]);
    }
    const rows = V3_STEPS.map((st, i) => ({ step_number: i + 1, type: st.type, config: JSON.stringify(st.config),
      error_policy: st.error_policy ? JSON.stringify(st.error_policy) : null }));
    const v = validateWorkflowDraft(rows, { branchTargetParams: BRANCH_TARGET_PARAMS, isTerminalSentinel });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(new Set(V3_STEPS.map(st => st.label)).size).toBe(V3_STEPS.length);
    // every step that names the digest uses ONE key
    const keys = V3_STEPS.map(st => st.config.params && st.config.params.digest_key).filter(Boolean);
    expect(keys).toEqual(['docs@', 'docs@', 'docs@']);
    // the preflight's expected refusal is the service's own words
    // (the service's own wording is pinned in tests/emailAttachments.mysql.test.js "refusals")
    expect(DIGEST).toContain('/is not queued under digest "preflight"/');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('rule 24 — match and transforms on the production runners', () => {
  const env = (over = {}) => ({
    kind: 'email', source: 'gmail-firm', envelope: { recipient: 'stuart@4lsg.com' },
    from: { email: 'client@example.com', name: '' }, to: [{ email: 'stuart@4lsg.com', name: '' }], cc: [], ...over,
  });
  const addrs = (n, at) => Array.from({ length: n }, (_, i) => ({ name: '', email: i === at ? 'docs@4lsg.com' : `p${i}@example.com` }));
  const matches = (e) => ruleSvc._evaluateMatch({ id: 24, name: 'docs@', match_mode: 'conditions', match_config: MATCH }, e);

  test.each([
    ['delivered to docs@ (the worker\'s Delivered-To)', env({ envelope: { recipient: 'docs@4lsg.com' } }), true],
    ['docs@ first in To', env({ to: addrs(1, 0) }), true],
    ['docs@ fourth in To, delivered elsewhere', env({ to: addrs(4, 3) }), true],
    ['docs@ tenth in To', env({ to: addrs(10, 9) }), true],
    ['docs@ in Cc', env({ cc: addrs(1, 0) }), true],
    ['docs@ tenth in Cc', env({ cc: addrs(10, 9) }), true],
    ['docs@ eleventh in To (past the enumerated slots)', env({ to: addrs(11, 10) }), false],
    ['docs@ only as the sender', env({ from: { email: 'docs@4lsg.com', name: '' } }), false],
    ['a look-alike address', env({ to: [{ name: '', email: 'docs@4lsg.com.example.net' }] }), false],
    ['mail to stuart@ only', env(), false],
  ])('%s', async (_label, e, want) => {
    expect(await matches(e)).toBe(want);
  });

  const worker = env({ envelope: { recipient: 'docs@4lsg.com' }, headers: { message_id: '1a1a42d6e7cb5b86' },
    mailbox: { id: 2, message_row_id: 3301 } });
  const gasEnvelope = env({ envelope: { recipient: 'docs@4lsg.com' }, headers: { message_id: '<x@mail.yahoo.com>' } });

  test('the shadow transform\'s new return: digest fields plus the reference', async () => {
    const code = "const outSubject = 's', html = '<b>h</b>', text = 't', email = 'client@example.com', nFiles = 1, caseId = null;\n" + NEW_RETURN;
    const rule = { id: 24, name: 'docs@', transform_mode: 'code', transform_config: { code } };
    const a = await ruleSvc._runTransform(rule, worker);
    expect(a.ok).toBe(true);
    expect(a.output).toEqual({ subject: 's', html: '<b>h</b>', text: 't', sender_email: 'client@example.com', files: 1, case_id: null,
      mail_message_id: 3301, source: 'gmail-firm', message_id: '1a1a42d6e7cb5b86' });
    const b = await ruleSvc._runTransform(rule, gasEnvelope);
    expect(b.output).toMatchObject({ mail_message_id: null, source: 'gmail-firm', message_id: '<x@mail.yahoo.com>' });
  });

  test('the shadow edit on rule 24\'s captured live transform: the digest is unchanged, the reference added', async () => {
    // ref/migrations/2026-10-26_docs_digest_transform.json is the live body the
    // shadow script edits; the script refuses any other base (its stamp).
    const cap = JSON.parse(fs.readFileSync(path.join(MIG, '2026-10-26_docs_digest_transform.json'), 'utf8'));
    const OLD_RETURN = 'return { subject: outSubject, html, text, sender_email: email, files: nFiles, case_id: caseId };';
    expect(SHADOW).toContain(`const OLD_RETURN = '${OLD_RETURN}';`);
    expect(SHADOW).toContain(`const RULE_BASE_STAMP = '${cap.definition_updated_at}';`);
    const oldCode = cap.transform_config.code;
    expect(oldCode.split(OLD_RETURN)).toHaveLength(2);
    const newCode = oldCode.replace(OLD_RETURN, () => NEW_RETURN);
    const message = { ...worker, subject: 'paystubs - case CF8ZT7VE', date: 'Fri, 06 Nov 2026 10:05:00 -0500',
      from: { email: 'client@example.com', name: 'Jane Client' }, text: 'Here you go.\n\nOn Thu, Nov 5, 2026 at 9:00 AM Office wrote:\n> old',
      attachments: [{ filename: 'paystub.pdf', mime: 'application/pdf', size: 40000, part: '2' }] };
    const before = await ruleSvc._runTransform({ id: 24, name: 'docs@', transform_mode: 'code', transform_config: { code: oldCode } }, message);
    const after = await ruleSvc._runTransform({ id: 24, name: 'docs@', transform_mode: 'code', transform_config: { code: newCode } }, message);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    const { mail_message_id, source, message_id, ...digest } = after.output;
    expect(digest).toEqual(before.output);
    expect(before.output.subject).toBe('New email to Docs@4LSG.com — Jane Client (1 file)');
    expect({ mail_message_id, source, message_id }).toEqual({ mail_message_id: 3301, source: 'gmail-firm', message_id: '1a1a42d6e7cb5b86' });
  });

  test('the cutover transform: the reference alone', async () => {
    const rule = { id: 24, name: 'docs@', transform_mode: 'code', transform_config: { code: CUTOVER_CODE } };
    const a = await ruleSvc._runTransform(rule, worker);
    expect(a).toEqual({ ok: true, output: { mail_message_id: 3301, source: 'gmail-firm', message_id: '1a1a42d6e7cb5b86' } });
    const b = await ruleSvc._runTransform(rule, gasEnvelope);
    expect(b.output).toEqual({ mail_message_id: null, source: 'gmail-firm', message_id: '<x@mail.yahoo.com>' });
  });
});
