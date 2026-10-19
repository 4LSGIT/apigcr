'use strict';

jest.mock('../startup/dbReadonly', () => ({}));

const svc = require('../services/assistantService');
const knowledge = require('../services/assistantKnowledgeService');
const prompts = require('../lib/aiPrompts');
const aiService = require('../services/aiService');
const assistantTicket = require('../lib/assistantTicket');
const reportService = require('../services/reportService');
const weatherService = require('../services/assistantWeatherService');

const sql = (text, extra = {}) => ({ id: 'q1', kind: 'sql.read', purpose: 'Find the relevant rows', sql: text, ...extra });
const staffDb = (overrides = {}) => ({
  query: jest.fn().mockResolvedValue([[{ user: 7, user_name: 'Stuart Sandweiss', user_initials: 'SS', roles: 'staff,attorney', ...overrides }]]),
});
const WORKSPACE = {
  v: 1,
  canonical_url: '/?files=cCASE1234%7Edocuments%2Cp42&open=file%3A0',
  files: [
    { kind: 'case', id: 'CASE1234', rest: 'documents' },
    { kind: 'contact', id: '42', rest: '' },
  ],
  active: { kind: 'file', index: 0, entity: { kind: 'case', id: 'CASE1234', rest: 'documents' } },
};

describe('assistant read-plan boundary', () => {
  test('accepts the three read-only operation kinds', () => {
    const plan = svc.validatePlan({
      action: 'query', summary: 'Look in records, calls and the manual', steps: [
        sql("SELECT contact_id, contact_name FROM contacts ORDER BY contact_id DESC LIMIT 10"),
        { id: 'q2', kind: 'manual.search', purpose: 'Find the documented behavior', query: 'locked reports' },
        { id: 'q3', kind: 'comms.search', purpose: 'Find the call', query: 'tractor', limit: 20 },
      ],
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(['sql.read', 'manual.search', 'comms.search']);
  });

  test('accepts a bounded weather lookup but no arbitrary URL', () => {
    const step = svc.validateStep({ id: 'q1', kind: 'weather.lookup', purpose: 'Current conditions', location: 'Detroit, Michigan', url: 'https://evil.test' }, 0);
    expect(step).toEqual({ id: 'q1', kind: 'weather.lookup', purpose: 'Current conditions', location: 'Detroit, Michigan' });
  });

  test('rejects action operations until the action phase exists', () => {
    expect(() => svc.validatePlan({ action: 'query', steps: [
      { id: 'q1', kind: 'email.send', purpose: 'Send it', to: 'x@example.com' },
    ] })).toThrow(/unavailable operation/);
  });

  test('rejects conversational PII reads even though explicit reports permit them', () => {
    expect(() => svc.validateStep(sql('SELECT contact_name, contact_ssn FROM contacts LIMIT 10'), 0)).toThrow(/may not read: contact_ssn/);
    expect(() => svc.validateStep(sql('SELECT contact_name, contact_dob FROM contacts LIMIT 10'), 0)).toThrow(/may not read: contact_dob/);
  });

  test('requires a bounded result and a date-bounded activity scan', () => {
    expect(() => svc.validateStep(sql('SELECT contact_id FROM contacts'), 0)).toThrow(/must end with LIMIT/);
    expect(() => svc.validateStep(sql('SELECT log_id, log_date FROM log LIMIT 20'), 0)).toThrow(/lower date bound/);
    expect(() => svc.validateStep(sql("SELECT log_id, log_date FROM log WHERE log_date >= DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 20"), 0)).not.toThrow();
  });

  test('history is short, role-normalized and text-capped', () => {
    const h = svc.cleanHistory(Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'anything', text: 'x'.repeat(2100) })));
    expect(h).toHaveLength(8);
    expect(h[0].role).toBe('user');
    expect(h[0].text).toHaveLength(2000);
  });

  test('workspace context must exactly match its canonical ID-only URL', () => {
    expect(svc.normalizeWorkspaceContext(WORKSPACE)).toEqual(WORKSPACE);
    expect(() => svc.normalizeWorkspaceContext({ ...WORKSPACE, canonical_url: '/?files=cOTHER123&open=file%3A0' }))
      .toThrow(/does not match/);
    expect(() => svc.normalizeWorkspaceContext({ ...WORKSPACE, canonical_url: '/?files=cCASE1234&ask=secret' }))
      .toThrow(/unsupported URL parameter/);
  });

  test('workspace entity ids are checked before the model sees them', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce([[]]) };
    await expect(svc.validateWorkspaceContext(db, WORKSPACE)).rejects.toThrow(/case that is unavailable/);
    expect(db.query).toHaveBeenCalledWith('SELECT case_id FROM cases WHERE case_id IN (?)', ['CASE1234']);
  });

  test('labels appointment wall time separately from its real UTC twin', () => {
    expect(svc.compactRows([{
      appt_date: new Date('2026-10-27T10:00:00.000Z'),
      appt_end: new Date('2026-10-27T10:10:00.000Z'),
      appt_date_utc: new Date('2026-10-27T14:00:00.000Z'),
    }])).toEqual([{
      appt_date: '2026-10-27 10:00:00 (firm-local wall time; America/Detroit; not UTC)',
      appt_end: '2026-10-27 10:10:00 (firm-local wall time; America/Detroit; not UTC)',
      appt_date_utc: '2026-10-27T14:00:00.000Z (UTC)',
    }]);
  });

  test('answers an unambiguous weekday follow-up from conversation context without a query', async () => {
    const spy = jest.spyOn(aiService, 'call');
    const out = await svc.plan({}, {
      question: 'what day of the week is it?', userId: 7,
      history: [{ role: 'assistant', text: 'The 341 meeting is set for 2026-10-27 at 10:00.' }],
    });
    expect(out).toMatchObject({ outcome: 'answer', answer: '2026-10-27 is a Tuesday.' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('turns legacy prose suggestions into exact clickable questions', () => {
    expect(svc.normalizeSuggestions("Ask firm data instead, for example: 'Which appointments are next?' or 'Which meetings are next?'")).toEqual([
      { label: 'Which appointments are next?', query: 'Which appointments are next?' },
      { label: 'Which meetings are next?', query: 'Which meetings are next?' },
    ]);
  });

  test('builds shell actions only from stable entity ids', () => {
    expect(svc.actionsForRow({ case_id: 'abc123', case_number_full: '26-123-mlo', contact_id: 9, contact_name: 'Ada', appt_id: 4, appt_type: '341' })).toEqual([
      { kind: 'case', id: 'abc123', label: '26-123-mlo' },
      { kind: 'contact', id: '9', label: 'Ada' },
      { kind: 'appointment', id: '4', label: '341' },
    ]);
  });

  test('recognizes generated aliases and deduplicates record actions across evidence', () => {
    const evidence = [{ rows: [
      { internal_case_id: 'c1', case_number: '26-1', client_contact_id: 8, contact_name: 'Ada', appointment_id: 40 },
      { case_relate_case_id: 'c1', event_id: 12, event_title: 'Hearing', linked_task_id: 7 },
    ] }];
    expect(svc.actionsForEvidence(evidence)).toEqual([
      { kind: 'case', id: 'c1', label: '26-1' },
      { kind: 'contact', id: '8', label: 'Ada' },
      { kind: 'appointment', id: '40', label: 'Appointment 40' },
      { kind: 'event', id: '12', label: 'Hearing' },
      { kind: 'task', id: '7', label: 'Task 7' },
    ]);
  });

  test('a planned ticket contains a plan that execution can revalidate', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'assistant-service-test-secret';
    const spy = jest.spyOn(aiService, 'call').mockResolvedValue({
      ok: true, callId: 1,
      json: { action: 'query', summary: 'Find the contact', steps: [sql('SELECT contact_id, contact_name FROM contacts LIMIT 5')] },
    });
    try {
      const db = staffDb();
      const made = await svc.plan(db, { question: 'Who is this?', history: [], userId: 7 });
      const decoded = assistantTicket.verify(made.ticket);
      expect(() => svc.validatePlan(decoded.plan)).not.toThrow();
      expect(decoded.uid).toBe(7);
      expect(decoded.viewer).toEqual({
        user_id: 7, display_name: 'Stuart Sandweiss', initials: 'SS', roles: ['staff', 'attorney'],
      });
      expect(db.query).toHaveBeenCalledWith(
        'SELECT user, user_name, user_initials, roles FROM users WHERE user = ? LIMIT 1',
        [7]
      );
      expect(spy.mock.calls[0][1].userInput).toMatch(/<current_staff server_verified="true">[\s\S]*"user_id":7[\s\S]*Stuart Sandweiss/);
    } finally {
      spy.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = old;
    }
  });

  test('a validated workspace snapshot is signed and supplied consistently to planning', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'assistant-service-test-secret';
    const db = { query: jest.fn(async (query) => {
      if (/FROM cases/.test(query)) return [[{ case_id: 'CASE1234' }]];
      if (/FROM contacts/.test(query)) return [[{ contact_id: 42 }]];
      return [[{ user: 7, user_name: 'Stuart Sandweiss', user_initials: 'SS', roles: 'staff' }]];
    }) };
    const spy = jest.spyOn(aiService, 'call').mockResolvedValue({
      ok: true, callId: 31,
      json: { action: 'query', summary: 'Use attached view', steps: [sql('SELECT case_id FROM cases LIMIT 1')] },
    });
    try {
      const made = await svc.plan(db, { question: 'What am I looking at?', userId: 7, workspaceContext: WORKSPACE });
      expect(assistantTicket.verify(made.ticket).workspace).toEqual(WORKSPACE);
      expect(spy.mock.calls[0][1].userInput).toMatch(/<workspace_context server_verified="true" immutable_for_request="true">[\s\S]*CASE1234/);
    } finally {
      spy.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });

  test('assistant destinations are a closed semantic allowlist', () => {
    expect(svc.normalizeDestinations([
      { id: 'automations.court_review', label: 'Take me there' },
      { id: 'javascript:alert(1)', label: 'Bad' },
      { id: 'automations.court_review', label: 'Duplicate' },
    ])).toEqual([{ id: 'automations.court_review', mode: 'take', label: 'Take me there' }]);
  });

  test('a temporary attachment and product model mode are bound into the plan', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'assistant-service-test-secret';
    const spy = jest.spyOn(aiService, 'call').mockResolvedValue({
      ok: true, callId: 11, json: { action: 'answer', answer: 'The attached notice sets a hearing.', suggestions: [] },
    });
    try {
      const out = await svc.plan(staffDb(), {
        question: 'What is this?', history: [], userId: 7, modelMode: 'faster_speed',
        temporaryAttachments: [{ name: 'notice.pdf', media_type: 'application/pdf', data_base64: Buffer.from('pdf').toString('base64') }],
      });
      expect(out).toMatchObject({ outcome: 'answer', model_mode: 'faster_speed' });
      expect(spy.mock.calls[0][1]).toMatchObject({
        model: 'claude-sonnet-4-6',
        attachments: [{ type: 'document', media_type: 'application/pdf', data_base64: expect.any(String) }],
      });
    } finally {
      spy.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = old;
    }
  });

  test('executes an approved SQL ticket and resolves citations against real rows', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'assistant-service-test-secret';
    const plan = svc.validatePlan({ action: 'query', summary: 'Find the contact', steps: [
      sql('SELECT contact_id, contact_name FROM contacts LIMIT 5'),
    ] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'Who?', history: [], workspace: WORKSPACE, plan: { action: 'query', ...plan } });
    const run = jest.spyOn(reportService, 'execute').mockResolvedValue({ rows: [{ contact_id: 9, contact_name: 'Ada' }], rowCount: 1, truncated: false });
    const answer = jest.spyOn(aiService, 'call').mockResolvedValue({
      ok: true, callId: 2,
      json: { answer: 'The likely contact is Ada.', citations: [{ query_id: 'q1', row_number: 1, label: 'Matched contact' }], suggested_follow_up: null },
    });
    try {
      const out = await svc.execute({}, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7 } });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][1].logMeta.log_sql).toBe(true);
      expect(out.answer).toMatch(/Ada/);
      expect(out.sources[0]).toMatchObject({ query_id: 'q1', row_number: 1, row: { contact_id: '9', contact_name: 'Ada' } });
      expect(out.sources[0].actions).toEqual([{ kind: 'contact', id: '9', label: 'Ada' }]);
      expect(out.entities).toEqual([{ kind: 'contact', id: '9', label: 'Ada' }]);
      expect(answer.mock.calls[0][1].userInput).toMatch(/<workspace_context server_verified="true" immutable_for_request="true">[\s\S]*CASE1234/);
    } finally {
      run.mockRestore();
      answer.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = old;
    }
  });

  test('executes an approved weather lookup through the narrow adapter', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'assistant-service-test-secret';
    const plan = svc.validatePlan({ action: 'query', summary: 'Get current weather', steps: [
      { id: 'q1', kind: 'weather.lookup', purpose: 'Current conditions', location: 'Detroit, Michigan' },
    ] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'Weather?', history: [], plan: { action: 'query', ...plan } });
    const lookup = jest.spyOn(weatherService, 'current').mockResolvedValue({ location: 'Detroit, Michigan, United States', temperature_2m: 55, observed_at: '2026-10-18T10:00' });
    const answer = jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 3, json: { answer: 'It is 55°F.', citations: [{ query_id: 'q1', row_number: 1, label: 'Current conditions' }], suggestions: [] } });
    try {
      const out = await svc.execute({}, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7 } });
      expect(lookup).toHaveBeenCalledWith('Detroit, Michigan');
      expect(out.answer).toBe('It is 55°F.');
    } finally {
      lookup.mockRestore(); answer.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });

  test('a collation failure produces one corrected plan for automatic retry', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'assistant-service-test-secret';
    const plan = svc.validatePlan({ action: 'query', summary: 'Find linked case', steps: [
      sql('SELECT c.case_id FROM cases c JOIN case_relate cr ON c.case_id = cr.case_relate_case_id LIMIT 5'),
    ] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'Find it', history: [], workspace: WORKSPACE, plan: { action: 'query', ...plan } });
    const run = jest.spyOn(reportService, 'execute').mockRejectedValue(new Error("Illegal mix of collations (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='"));
    const repair = jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 8, json: {
      action: 'query', summary: 'Retry the linked case lookup with an explicit collation', steps: [
        sql('SELECT c.case_id FROM cases c JOIN case_relate cr ON c.case_id COLLATE utf8mb4_general_ci = cr.case_relate_case_id COLLATE utf8mb4_general_ci LIMIT 5'),
      ],
    } });
    try {
      const out = await svc.execute({}, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7 } });
      expect(out).toMatchObject({ outcome: 'plan', notice: expect.stringMatching(/collation mismatch/i) });
      expect(out.steps[0].sql).toMatch(/COLLATE utf8mb4_general_ci/);
      expect(assistantTicket.verify(out.ticket)).toMatchObject({ repairs: 1, workspace: WORKSPACE });
      expect(repair.mock.calls[0][1].userInput).toMatch(/<workspace_context server_verified="true" immutable_for_request="true">[\s\S]*CASE1234/);
    } finally {
      run.mockRestore(); repair.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });

  test('an over-expensive query produces one narrower replacement plan', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'assistant-service-test-secret';
    const plan = svc.validatePlan({ action: 'query', summary: 'Find communication', steps: [
      sql("SELECT l.log_id FROM log l JOIN contacts c ON l.log_from COLLATE utf8mb4_general_ci = c.contact_email COLLATE utf8mb4_general_ci WHERE l.log_date >= DATE_SUB(NOW(), INTERVAL 14 DAY) LIMIT 20"),
    ] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'Who mentioned a tractor?', history: [], plan: { action: 'query', ...plan } });
    const run = jest.spyOn(reportService, 'execute').mockRejectedValue(new Error('Report refused: the query plan estimates too much work'));
    const repair = jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 9, json: {
      action: 'query', summary: 'Search a bounded candidate set', steps: [
        sql("SELECT l.log_id FROM log l WHERE l.log_date >= DATE_SUB(NOW(), INTERVAL 14 DAY) AND LOWER(l.log_data) LIKE '%tractor%' ORDER BY l.log_date DESC LIMIT 20"),
      ],
    } });
    try {
      const out = await svc.execute({}, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7 } });
      expect(out).toMatchObject({ outcome: 'plan', notice: expect.stringMatching(/narrowed/i) });
      expect(assistantTicket.verify(out.ticket).repairs).toBe(1);
    } finally {
      run.mockRestore(); repair.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });

  test('a MySQL limited-membership error is rewritten automatically', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'assistant-service-test-secret';
    const plan = svc.validatePlan({ action: 'query', summary: 'Read the latest messages', steps: [
      sql('SELECT l.log_id FROM log l WHERE l.log_date >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND l.log_id IN (SELECT x.log_id FROM log x WHERE x.log_date >= DATE_SUB(NOW(), INTERVAL 30 DAY) ORDER BY x.log_date DESC LIMIT 10) LIMIT 10'),
    ] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'Check the 10 most recent SMS messages', history: [], plan: { action: 'query', ...plan } });
    const run = jest.spyOn(reportService, 'execute').mockRejectedValue(new Error("This version of MySQL doesn't yet support 'LIMIT & IN/ALL/ANY/SOME subquery'"));
    const repair = jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 10, json: {
      action: 'query', summary: 'Read the latest messages directly', steps: [
        sql('SELECT l.log_id FROM log l WHERE l.log_date >= DATE_SUB(NOW(), INTERVAL 30 DAY) ORDER BY l.log_date DESC LIMIT 10'),
      ],
    } });
    try {
      const out = await svc.execute({}, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7 } });
      expect(out).toMatchObject({ outcome: 'plan', notice: expect.stringMatching(/database version does not support/i) });
      expect(repair.mock.calls[0][1].userInput).toMatch(/Do not put LIMIT inside an IN, ALL, ANY, or SOME subquery/);
      expect(assistantTicket.verify(out.ticket).repairs).toBe(1);
    } finally {
      run.mockRestore(); repair.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });
});

describe('assistant knowledge and prompts', () => {
  test('manual search grounds a product question', () => {
    const rows = knowledge.search('locked reports', 5);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => /reports/i.test(`${r.title} ${r.manual_path}`))).toBe(true);
  });

  test('both assistant prompts are registered JSON prompts', () => {
    expect(prompts.getPrompt('assistant_plan')).toMatchObject({ output_type: 'json', version: '5', model: 'claude-opus-5' });
    expect(prompts.getPrompt('assistant_answer')).toMatchObject({ output_type: 'json', version: '5', model: 'claude-opus-5' });
    expect(prompts.getPrompt('assistant_plan').system).toMatch(/COLLATE utf8mb4_general_ci/);
    expect(prompts.getPrompt('assistant_plan').system).toMatch(/Never generate[\s\S]*x IN \(SELECT \.\.\. LIMIT n\)/);
    expect(prompts.getPrompt('assistant_plan').system).toMatch(/users\.roles[\s\S]*canonical role field/);
    expect(prompts.getPrompt('assistant_plan').system).toMatch(/DATE_FORMAT\(appt_date,[\s\S]*AS appt_date_local/);
    expect(prompts.getPrompt('assistant_answer').system).toMatch(/trailing Z[\s\S]*transport artifact/);
    expect(prompts.getPrompt('assistant_plan').system).toMatch(/First-person references[\s\S]*exactly that user_id/);
    expect(prompts.getPrompt('assistant_plan').system).toMatch(/My next appointment[\s\S]*appt_with/);
  });
});
