// tests/esignReminders.test.js
//
// Phase 3 — reminder sequences + terminal-event cancellation.
//
//   1. esignService.applyStatus     terminal transition → enrollment cancelled
//   2. esignSendService             _tryEnrollReminders resolution ladder
//   3. internal_functions esign_remind — THE RACE GUARD (the
//      signed-client-must-never-get-nudged rule; plan §10 calls this the
//      highest-risk piece, so it gets the densest coverage here)
//   4. sequenceEngine               dup guard + INSERT carry signing_request_id
//   5. esignTemplateService         reminder_seq_id validated at save
//
// Mock posture: lib/sequenceEngine, services/settingsService,
// services/esignPrefillService, services/esign (provider factory) and
// services/esignWebhookService are jest.mock'd at the MODULE boundary;
// esignService runs REAL against a small SQL-dispatching db stub, because the
// thing under test in §1 is real applyStatus behavior, not a mock of it.

jest.mock('../lib/sequenceEngine', () => ({
  enrollContactByTemplateId: jest.fn(),
  cancelEnrollment: jest.fn(),
}));
jest.mock('../services/settingsService', () => ({
  getSetting: jest.fn(),
  getSettings: jest.fn(),
}));
jest.mock('../services/esignPrefillService', () => ({
  buildContext: jest.fn(),
  RESOLVER_NAMES: [],
}));
jest.mock('../services/esign', () => ({
  getProvider: jest.fn(),
  recordCreditSpend: jest.fn(),
}));
jest.mock('../services/esignWebhookService', () => ({
  processStatusChange: jest.fn(),
  LOGGED_EVENTS: new Set(),
}));

const sequenceEngine = require('../lib/sequenceEngine');
const settingsService = require('../services/settingsService');
const prefillService = require('../services/esignPrefillService');
const providerFactory = require('../services/esign');
const webhookService = require('../services/esignWebhookService');

const esignService = require('../services/esignService');
const sendService = require('../services/esignSendService');
const internalFns = require('../lib/internal_functions');

beforeEach(() => {
  jest.clearAllMocks();
  settingsService.getSettings.mockResolvedValue({ esign_reminder_seq_id: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// db stub for §1 — just enough SQL dispatch for applyStatus + events
// ─────────────────────────────────────────────────────────────────────────────

function makeRow(over = {}) {
  return {
    id: 7, provider: 'zoho_sign', provider_id: 'ZP1',
    linkable_type: 'case', linkable_id: 'ABC12345', kind: 'retainer',
    status: 'sent', document_name: 'Retainer — Test', tracking_id: 'TRK-7',
    recipients: JSON.stringify([{ name: 'A', email: 'a@x.com', order: 1, status: 'pending', signed_at: null, ip: null }]),
    placement_json: null, template_id: null, seq_instance_id: 55,
    signed_pdf_path: null, cert_pdf_path: null,
    sent_at: '2026-07-20 10:00:00', completed_at: null, expires_at: null,
    raw_payload: null, created_by: 1,
    created_at: '2026-07-20 09:00:00', updated_at: '2026-07-20 10:00:00',
    ...over,
  };
}

function makeDb(row) {
  const state = { row, events: [] };
  const query = jest.fn(async (sql, params = []) => {
    const s = sql.trim();
    if (/^SELECT \* FROM signing_requests WHERE id = \?/i.test(s)) {
      return [state.row && Number(params[0]) === state.row.id
        ? [{ ...state.row, recipients: JSON.parse(state.row.recipients) }] : []];
    }
    if (/^UPDATE signing_requests SET/i.test(s)) {
      // apply "status = ?" and friends naively: first param is status
      if (/^UPDATE signing_requests SET status = \?/i.test(s)) state.row.status = params[0];
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO signing_request_events/i.test(s)) {
      state.events.push({ event: params[1], payload: params[3] });
      return [{ insertId: state.events.length, affectedRows: 1 }];
    }
    throw new Error(`db stub: unhandled SQL: ${s.slice(0, 80)}`);
  });
  return { query, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. TERMINAL TRANSITION CANCELS THE ENROLLMENT
// ─────────────────────────────────────────────────────────────────────────────

describe('applyStatus — terminal-event cancellation (Phase 3)', () => {
  test('sent → signed cancels the enrollment and records reminders_cancelled', async () => {
    const db = makeDb(makeRow({ status: 'viewed', seq_instance_id: 55 }));
    const out = await esignService.applyStatus(db, 7, { status: 'signed' });
    expect(out.changed).toBe(true);
    expect(sequenceEngine.cancelEnrollment).toHaveBeenCalledWith(db, 55, 'esign_signed');
    const names = db.state.events.map((e) => e.event);
    expect(names).toContain('signed');
    expect(names).toContain('reminders_cancelled');
  });

  test('every terminal status cancels; the reason names it', async () => {
    for (const status of ['declined', 'expired', 'recalled']) {
      jest.clearAllMocks();
      const db = makeDb(makeRow({ status: 'sent', seq_instance_id: 99 }));
      await esignService.applyStatus(db, 7, { status });
      expect(sequenceEngine.cancelEnrollment).toHaveBeenCalledWith(db, 99, `esign_${status}`);
    }
  });

  test('a NON-terminal transition never touches the enrollment', async () => {
    const db = makeDb(makeRow({ status: 'sent', seq_instance_id: 55 }));
    await esignService.applyStatus(db, 7, { status: 'viewed' });
    expect(sequenceEngine.cancelEnrollment).not.toHaveBeenCalled();
  });

  test('terminal with NO enrollment pointer is a clean no-op', async () => {
    const db = makeDb(makeRow({ status: 'sent', seq_instance_id: null }));
    const out = await esignService.applyStatus(db, 7, { status: 'signed' });
    expect(out.changed).toBe(true);
    expect(sequenceEngine.cancelEnrollment).not.toHaveBeenCalled();
    expect(db.state.events.map((e) => e.event)).not.toContain('reminders_cancelled');
  });

  test('a cancel failure cannot un-say the transition — best effort, evented', async () => {
    sequenceEngine.cancelEnrollment.mockRejectedValueOnce(new Error('seq table locked'));
    const db = makeDb(makeRow({ status: 'sent', seq_instance_id: 55 }));
    const out = await esignService.applyStatus(db, 7, { status: 'signed' });
    expect(out.changed).toBe(true);            // the transition stands
    expect(out.request.status).toBe('signed');
    expect(db.state.events.map((e) => e.event)).toContain('reminder_cancel_failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ENROLLMENT RESOLUTION LADDER
// ─────────────────────────────────────────────────────────────────────────────

describe('_tryEnrollReminders — the resolution ladder', () => {
  const row = () => ({
    id: 7, linkable_type: 'case', linkable_id: 'ABC12345',
    tracking_id: 'TRK-7', document_name: 'Retainer — Test',
  });
  let setSeq, appendEv;
  beforeEach(() => {
    setSeq = jest.spyOn(esignService, 'setSeqInstance').mockResolvedValue({});
    appendEv = jest.spyOn(esignService, 'appendEvent').mockResolvedValue({});
    prefillService.buildContext.mockResolvedValue({ debtor1: { contact_id: 301 } });
    sequenceEngine.enrollContactByTemplateId.mockResolvedValue({
      enrollmentId: 88, templateName: 'E-Sign Reminder — Default',
      totalSteps: 3, firstJobScheduledAt: '2026-07-24T14:00:00.000Z',
    });
  });
  afterEach(() => { setSeq.mockRestore(); appendEv.mockRestore(); });

  test('rung 1: template says off → nothing happens at all', async () => {
    const out = await sendService._tryEnrollReminders({}, row(), { off: true, seqId: 12 });
    expect(out).toEqual({ enrolled: false, reason: 'template_off' });
    expect(sequenceEngine.enrollContactByTemplateId).not.toHaveBeenCalled();
    expect(settingsService.getSettings).not.toHaveBeenCalled();
  });

  test('rung 2: template sequence wins over the firm default', async () => {
    const out = await sendService._tryEnrollReminders({}, row(), { off: false, seqId: 12 });
    expect(out.enrolled).toBe(true);
    // buildContext takes an OPTIONS OBJECT — the original Phase 3 code called
    // it positionally and this mock happily accepted it, hiding a live bug
    // (request 23: every send evented no_contact). Pin the shape here so the
    // mock can never absorb that drift again; the contract test at the bottom
    // of this describe proves the real function rejects the positional form.
    expect(prefillService.buildContext).toHaveBeenCalledWith({}, {
      linkableType: 'case', linkableId: 'ABC12345',
    });
    expect(sequenceEngine.enrollContactByTemplateId)
      .toHaveBeenCalledWith({}, 301, 12, expect.objectContaining({
        signing_request_id: 7, case_id: 'ABC12345', tracking_id: 'TRK-7',
      }));
    expect(settingsService.getSettings).not.toHaveBeenCalled();
    expect(setSeq).toHaveBeenCalledWith({}, 7, 88);
    const evNames = appendEv.mock.calls.map((c) => c[2].event);
    expect(evNames).toContain('reminders_enrolled');
  });

  test('rung 3: no policy → firm default setting', async () => {
    settingsService.getSettings.mockResolvedValue({ esign_reminder_seq_id: '26' });
    const out = await sendService._tryEnrollReminders({}, row(), null);
    expect(out.enrolled).toBe(true);
    expect(sequenceEngine.enrollContactByTemplateId)
      .toHaveBeenCalledWith({}, 301, 26, expect.anything());
  });

  test('rung 4: no policy, no setting → off, quietly', async () => {
    settingsService.getSettings.mockResolvedValue({ esign_reminder_seq_id: '' });
    const out = await sendService._tryEnrollReminders({}, row(), null);
    expect(out).toEqual({ enrolled: false, reason: 'no_sequence_configured' });
    expect(sequenceEngine.enrollContactByTemplateId).not.toHaveBeenCalled();
  });

  test('a garbage setting value reads as unset, never as NaN', async () => {
    settingsService.getSettings.mockResolvedValue({ esign_reminder_seq_id: 'soon™' });
    const out = await sendService._tryEnrollReminders({}, row(), null);
    expect(out.reason).toBe('no_sequence_configured');
  });

  test('no resolvable contact → evented, not enrolled, not thrown', async () => {
    prefillService.buildContext.mockResolvedValue({ debtor1: null });
    const out = await sendService._tryEnrollReminders({}, row(), { off: false, seqId: 12 });
    expect(out).toEqual({ enrolled: false, reason: 'no_contact' });
    const evNames = appendEv.mock.calls.map((c) => c[2].event);
    expect(evNames).toContain('reminders_not_enrolled');
  });

  test('contact-linked send: no case_id in trigger_data', async () => {
    const r = { ...row(), linkable_type: 'contact', linkable_id: '301' };
    await sendService._tryEnrollReminders({}, r, { off: false, seqId: 12 });
    const td = sequenceEngine.enrollContactByTemplateId.mock.calls[0][3];
    expect(td).not.toHaveProperty('case_id');
    expect(td.signing_request_id).toBe(7);
  });

  test('CONTRACT: the real buildContext requires the options object — positional args yield an empty context', async () => {
    // Guards the exact drift the mock hid: if buildContext ever moves to a
    // positional signature (or the helper regresses to one), one of these two
    // assertions goes red. The real module runs against a db stub that would
    // answer any query it makes.
    const real = jest.requireActual('../services/esignPrefillService');
    const db = { query: jest.fn(async () => [[{ contact_id: 301, contact_name: 'X' }]]) };

    const positional = await real.buildContext(db, 'case', 'ABC12345');
    expect(positional).toEqual({ caseRow: null, debtor1: null, debtor2: null });
    expect(db.query).not.toHaveBeenCalled(); // never even reached the db

    const objectForm = await real.buildContext(db, { linkableType: 'contact', linkableId: '301' });
    expect(objectForm.debtor1).toMatchObject({ contact_id: 301 });
  });

  test('an enrollment failure is evented and swallowed — the send already happened', async () => {
    sequenceEngine.enrollContactByTemplateId.mockRejectedValue(new Error('already enrolled'));
    const out = await sendService._tryEnrollReminders({}, row(), { off: false, seqId: 12 });
    expect(out.enrolled).toBe(false);
    expect(out.reason).toBe('error');
    const evNames = appendEv.mock.calls.map((c) => c[2].event);
    expect(evNames).toContain('reminders_enroll_failed');
    expect(setSeq).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. esign_remind — THE RACE GUARD
// ─────────────────────────────────────────────────────────────────────────────

describe('esign_remind — signed clients are never nudged', () => {
  const request = (over = {}) => ({
    id: 7, provider: 'zoho_sign', provider_id: 'ZP1', status: 'sent',
    tracking_id: 'TRK-7', seq_instance_id: 55, recipients: [], ...over,
  });
  let getById, remind;
  const provider = { getStatus: jest.fn() };

  beforeEach(() => {
    getById = jest.spyOn(esignService, 'getById');
    remind = jest.spyOn(sendService, 'remindPipeline').mockResolvedValue({ remindedAll: true, raw: {} });
    providerFactory.getProvider.mockResolvedValue(provider);
  });
  afterEach(() => { getById.mockRestore(); remind.mockRestore(); });

  test('happy path: live status agrees the request is outstanding → nudge', async () => {
    getById.mockResolvedValue(request({ status: 'viewed' }));
    provider.getStatus.mockResolvedValue({ status: 'viewed', providerStatus: 'inprogress' });
    const out = await internalFns.esign_remind({ signing_request_id: 7 }, {});
    expect(out.success).toBe(true);
    expect(out.output.reminded).toBe(true);
    expect(remind).toHaveBeenCalledWith({}, 7, { createdBy: null });
    expect(webhookService.processStatusChange).not.toHaveBeenCalled();
  });

  test('THE case: locally sent, provider says signed → webhook applied, NO nudge, clock stopped', async () => {
    getById
      .mockResolvedValueOnce(request({ status: 'sent' }))    // initial load
      .mockResolvedValueOnce(request({ status: 'signed' })); // re-read after apply
    provider.getStatus.mockResolvedValue({
      status: 'signed', providerStatus: 'completed', recipients: [], raw: { r: 1 },
    });
    webhookService.processStatusChange.mockResolvedValue({ changed: true });

    const out = await internalFns.esign_remind({ signing_request_id: 7 }, {});

    expect(webhookService.processStatusChange).toHaveBeenCalledWith({}, expect.objectContaining({ id: 7 }),
      expect.objectContaining({ status: 'signed', source: 'reminder_check' }));
    expect(remind).not.toHaveBeenCalled();                       // ← the whole point
    expect(out.output).toMatchObject({ reminded: false, skipped: 'became_terminal', webhook_was_missed: true });
    // defensive cancel on top of applyStatus's own hook
    expect(sequenceEngine.cancelEnrollment).toHaveBeenCalledWith({}, 55, 'esign_signed_lazy');
  });

  test('live status check FAILS → throws, never reminds on stale state', async () => {
    getById.mockResolvedValue(request());
    provider.getStatus.mockRejectedValue(new Error('Zoho 503'));
    await expect(internalFns.esign_remind({ signing_request_id: 7 }, {}))
      .rejects.toThrow(/live status check failed/);
    expect(remind).not.toHaveBeenCalled();
  });

  test('provider unavailable → throws, never reminds', async () => {
    getById.mockResolvedValue(request());
    providerFactory.getProvider.mockRejectedValue(new Error('no credential'));
    await expect(internalFns.esign_remind({ signing_request_id: 7 }, {}))
      .rejects.toThrow(/provider unavailable/);
    expect(remind).not.toHaveBeenCalled();
  });

  test('locally terminal already → skip + defensive cancel, no provider call at all', async () => {
    getById.mockResolvedValue(request({ status: 'signed' }));
    const out = await internalFns.esign_remind({ signing_request_id: 7 }, {});
    expect(out.output).toMatchObject({ reminded: false, skipped: 'terminal', enrollment_cancelled: true });
    expect(sequenceEngine.cancelEnrollment).toHaveBeenCalledWith({}, 55, 'esign_signed_lazy');
    expect(providerFactory.getProvider).not.toHaveBeenCalled();
    expect(remind).not.toHaveBeenCalled();
  });

  test('draft / never-sent → skip quietly, clock keeps running', async () => {
    getById.mockResolvedValue(request({ status: 'draft', provider_id: null }));
    const out = await internalFns.esign_remind({ signing_request_id: 7 }, {});
    expect(out.output.skipped).toBe('not_sent');
    expect(sequenceEngine.cancelEnrollment).not.toHaveBeenCalled();
    expect(remind).not.toHaveBeenCalled();
  });

  test('row deleted from under the clock → skip, success', async () => {
    getById.mockResolvedValue(null);
    const out = await internalFns.esign_remind({ signing_request_id: 7 }, {});
    expect(out).toMatchObject({ success: true, output: { skipped: 'not_found' } });
  });

  test('bounced (live agrees) → skip; Zoho would re-send to a dead mailbox', async () => {
    getById.mockResolvedValue(request({ status: 'bounced' }));
    provider.getStatus.mockResolvedValue({ status: 'bounced', providerStatus: 'inprogress' });
    const out = await internalFns.esign_remind({ signing_request_id: 7 }, {});
    expect(out.output.skipped).toBe('bounced');
    expect(remind).not.toHaveBeenCalled();
  });

  test('garbage params throw before any I/O', async () => {
    for (const bad of [undefined, null, 0, -3, 'seven']) {
      await expect(internalFns.esign_remind({ signing_request_id: bad }, {}))
        .rejects.toThrow(/positive integer signing_request_id/);
    }
    expect(getById).not.toHaveBeenCalled();
  });

  test('defensive cancel failing does not fail the skip', async () => {
    getById.mockResolvedValue(request({ status: 'expired' }));
    sequenceEngine.cancelEnrollment.mockRejectedValue(new Error('nope'));
    const out = await internalFns.esign_remind({ signing_request_id: 7 }, {});
    expect(out.success).toBe(true);
    expect(out.output).toMatchObject({ skipped: 'terminal', enrollment_cancelled: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ENGINE — signing_request_id in the dup guard and the INSERT
// ─────────────────────────────────────────────────────────────────────────────

describe('sequenceEngine — signing_request_id scoping (real module)', () => {
  // The engine is mocked above for the OTHER sections; here we need the real
  // one, isolated from the mock registry.
  let realEngine;
  beforeAll(() => {
    jest.isolateModules(() => { realEngine = jest.requireActual('../lib/sequenceEngine'); });
  });

  function engineDb({ existingEnrollment = false } = {}) {
    const captured = { dupParams: null, insertCols: null, insertParams: null };
    const query = jest.fn(async (sql, params = []) => {
      const s = sql.trim();
      if (/^SELECT \* FROM sequence_templates WHERE id = \?/i.test(s)) {
        return [[{ id: 26, name: 'E-Sign Reminder — Default', type: 'esign_reminder', active: 1 }]];
      }
      if (/^SELECT \* FROM sequence_steps/i.test(s)) {
        return [[{
          id: 1, template_id: 26, step_number: 1, action_type: 'internal_function',
          action_config: '{"function_name":"esign_remind","params":{"signing_request_id":"{{trigger_data.signing_request_id}}"}}',
          timing: '{"type":"immediate"}', condition: null, fire_guard: null, error_policy: null,
        }]];
      }
      if (/FROM sequence_enrollments\s+WHERE contact_id = \?/i.test(s)) {
        captured.dupSql = s;
        captured.dupParams = params;
        return [existingEnrollment ? [{ id: 44 }] : []];
      }
      if (/^INSERT INTO sequence_enrollments/i.test(s)) {
        captured.insertSql = s;
        captured.insertParams = params;
        return [{ insertId: 88, affectedRows: 1 }];
      }
      if (/^INSERT INTO scheduled_jobs/i.test(s) || /scheduled_jobs/i.test(s)) {
        return [{ insertId: 5, affectedRows: 1 }];
      }
      if (/^UPDATE sequence_enrollments/i.test(s)) return [{ affectedRows: 1 }];
      return [[]];
    });
    return { query, captured };
  }

  test('trigger_data.signing_request_id lands in the dup guard AND the INSERT', async () => {
    const db = engineDb();
    await realEngine.enrollContactByTemplateId(db, 301, 26, { signing_request_id: 7 });
    // dup guard: both <=> scopes present, appt null, signing request 7
    expect(db.captured.dupSql).toMatch(/appt_id <=> \?/);
    expect(db.captured.dupSql).toMatch(/signing_request_id <=> \?/);
    expect(db.captured.dupParams).toEqual([301, 26, null, 7]);
    // INSERT: column named, value positioned after appt_id
    expect(db.captured.insertSql).toMatch(/signing_request_id/);
    expect(db.captured.insertParams[2]).toBeNull(); // appt_id
    expect(db.captured.insertParams[3]).toBe(7);    // signing_request_id
  });

  test('an active enrollment for the SAME request is refused as a duplicate', async () => {
    const db = engineDb({ existingEnrollment: true });
    await expect(realEngine.enrollContactByTemplateId(db, 301, 26, { signing_request_id: 7 }))
      .rejects.toThrow(/already enrolled.*signing request 7/);
  });

  test('appt-scoped enrollments still carry NULL signing_request_id', async () => {
    const db = engineDb();
    await realEngine.enrollContactByTemplateId(db, 301, 26, { appt_id: 12 });
    expect(db.captured.dupParams).toEqual([301, 26, 12, null]);
    expect(db.captured.insertParams[2]).toBe(12);
    expect(db.captured.insertParams[3]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. TEMPLATE SAVE — reminder_seq_id is validated now
// ─────────────────────────────────────────────────────────────────────────────

describe('esignTemplateService — reminder_seq_id closes the 2B passthrough', () => {
  const templateService = require('../services/esignTemplateService');

  function tmplDb({ seqRow } = {}) {
    const query = jest.fn(async (sql, params = []) => {
      const s = sql.trim();
      if (/^SELECT id, name, active FROM sequence_templates/i.test(s)) {
        return [seqRow ? [seqRow] : []];
      }
      if (/information_schema/i.test(s)) return [[]];
      if (/^INSERT INTO contract_templates/i.test(s)) return [{ insertId: 3, affectedRows: 1 }];
      if (/^SELECT .* FROM contract_templates WHERE id = \?/i.test(s) || /FROM contract_templates/i.test(s)) {
        return [[{
          id: 3, name: 'Retainer', kind: 'retainer', template_type: 'html',
          body: '<p>hi</p>', prefill_schema: '[]', placement_json: '{"fields":[]}',
          reminder_seq_id: params && params[0] === 3 ? 26 : null, reminders_off: 0,
          expiration_days: 14, active: 1,
        }]];
      }
      return [[]];
    });
    return { query };
  }

  const input = (over = {}) => ({
    name: 'Retainer', kind: 'retainer', body: '<p>hi</p>',
    prefillSchema: [], placementJson: { fields: [] },
    reminderSeqId: 26, staticBody: true, ...over,
  });

  test('a dangling reminder_seq_id stops the save', async () => {
    const db = tmplDb({ seqRow: null });
    await expect(templateService.createTemplate(db, input(), new Set()))
      .rejects.toMatchObject({ code: 'ESIGN_BAD_TEMPLATE' });
  });

  test('an INACTIVE sequence stops the save, by name', async () => {
    const db = tmplDb({ seqRow: { id: 26, name: 'Old Cadence', active: 0 } });
    await expect(templateService.createTemplate(db, input(), new Set()))
      .rejects.toThrow(/"Old Cadence".*inactive/);
  });

  test('an active sequence saves; null skips the check entirely', async () => {
    const db = tmplDb({ seqRow: { id: 26, name: 'E-Sign Reminder — Default', active: 1 } });
    const out = await templateService.createTemplate(db, input(), new Set());
    expect(out.template).toBeTruthy();

    const db2 = tmplDb({ seqRow: null });
    const out2 = await templateService.createTemplate(db2, input({ reminderSeqId: null }), new Set());
    expect(out2.template).toBeTruthy();
    // no sequence_templates lookup was made
    const seqLookups = db2.query.mock.calls.filter(([q]) => /sequence_templates/i.test(q));
    expect(seqLookups).toHaveLength(0);
  });
});
