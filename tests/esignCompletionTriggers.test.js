/**
 * Tests for e-sign COMPLETION TRIGGERS (esign workflow actions, part 2).
 *
 * Three layers, three modules:
 *
 *   1. esignTemplateService.validateCompletionTargets — pure shape table.
 *   2. esignSendService.mergeCompletionTargets        — pure merge table.
 *   3. esignService.applyStatus firing                — which transitions fire
 *      which trigger, what the dispatch receives, and the never-un-say-a-status
 *      failure posture. actionDispatchers and esignAlertService are jest-mocked
 *      (they are lazy-required by the service, which jest's module registry
 *      intercepts all the same); db is a small stateful stub in the
 *      esignService.test.js tradition — the UPDATE is actually applied, so a
 *      firing test fails if the transition write is wrong, not merely the hook.
 *
 *   npx jest tests/esignCompletionTriggers.test.js
 */

jest.mock('../lib/actionDispatchers', () => ({
  dispatchWorkflow: jest.fn(),
  dispatchSequence: jest.fn(),
}));
jest.mock('../services/esignAlertService', () => ({
  raiseTask: jest.fn().mockResolvedValue({ ok: true, taskId: 999 }),
}));
// applyStatus's reminder-cancel hook lazy-requires sequenceEngine; requests in
// these tests carry no seq_instance_id, so a hard mock keeps the module graph
// (job_executor, internal_functions, …) out of the suite entirely.
jest.mock('../lib/sequenceEngine', () => ({
  cancelEnrollment: jest.fn().mockResolvedValue(undefined),
}));

const dispatchers        = require('../lib/actionDispatchers');
const esignAlertService  = require('../services/esignAlertService');
const esignService       = require('../services/esignService');
const esignTemplateService = require('../services/esignTemplateService');
const esignSendService   = require('../services/esignSendService');

const { validateCompletionTargets } = esignTemplateService;
const { mergeCompletionTargets }    = esignSendService;

const CASE_ID = 'AbC12dEf'; // 8-char opaque varchar, matches live shape

// ─────────────────────────────────────────────────────────────
// 1. validateCompletionTargets — pure shape table
// ─────────────────────────────────────────────────────────────

describe('validateCompletionTargets', () => {
  test('null / undefined → null', () => {
    expect(validateCompletionTargets(null)).toBeNull();
    expect(validateCompletionTargets(undefined)).toBeNull();
  });

  test('valid both keys normalize (id coerced to number)', () => {
    const out = validateCompletionTargets({
      signed:   { type: 'workflow', id: '12' },
      declined: { type: 'sequence', id: 4 },
    });
    expect(out).toEqual({
      signed:   { type: 'workflow', id: 12 },
      declined: { type: 'sequence', id: 4 },
    });
  });

  test('null-valued key is dropped; all-dropped → null', () => {
    expect(validateCompletionTargets({ signed: null })).toBeNull();
    expect(validateCompletionTargets({ signed: null, declined: { type: 'workflow', id: 1 } }))
      .toEqual({ declined: { type: 'workflow', id: 1 } });
  });

  test('empty object → null (column never holds {})', () => {
    expect(validateCompletionTargets({})).toBeNull();
  });

  test.each([
    ['array',            [],                                        /must be an object/],
    ['scalar',           'signed',                                  /must be an object/],
    ['unknown trigger',  { on_signed: { type: 'workflow', id: 1 } }, /unknown trigger "on_signed"/],
    ['bad target shape', { signed: 'workflow:12' },                 /signed must be/],
    ['bad type',         { signed: { type: 'hook', id: 1 } },       /type "hook" is invalid/],
    ['zero id',          { signed: { type: 'workflow', id: 0 } },   /positive integer/],
    ['non-numeric id',   { signed: { type: 'workflow', id: 'x' } }, /positive integer/],
  ])('%s throws ESIGN_BAD_TEMPLATE', (_label, raw, re) => {
    expect(() => validateCompletionTargets(raw)).toThrow(re);
    try { validateCompletionTargets(raw); } catch (e) { expect(e.code).toBe('ESIGN_BAD_TEMPLATE'); }
  });
});

// ─────────────────────────────────────────────────────────────
// 2. mergeCompletionTargets — pure merge table
// ─────────────────────────────────────────────────────────────

describe('mergeCompletionTargets', () => {
  const tmpl = { signed: { type: 'workflow', id: 12 }, declined: { type: 'sequence', id: 4 } };

  test('undefined override → template verbatim (normalized)', () => {
    expect(mergeCompletionTargets(tmpl, undefined)).toEqual(tmpl);
    expect(mergeCompletionTargets(null, undefined)).toBeNull();
  });

  test('null override → null (disable for this send)', () => {
    expect(mergeCompletionTargets(tmpl, null)).toBeNull();
  });

  test('per-key: provided replaces, absent keeps', () => {
    expect(mergeCompletionTargets(tmpl, { signed: { type: 'workflow', id: 99 } })).toEqual({
      signed: { type: 'workflow', id: 99 }, declined: { type: 'sequence', id: 4 },
    });
  });

  test('null-valued key clears just that trigger', () => {
    expect(mergeCompletionTargets(tmpl, { declined: null })).toEqual({
      signed: { type: 'workflow', id: 12 },
    });
    expect(mergeCompletionTargets({ signed: { type: 'workflow', id: 12 } }, { signed: null }))
      .toBeNull();
  });

  test('override onto a template with none', () => {
    expect(mergeCompletionTargets(null, { signed: { type: 'sequence', id: 7 } })).toEqual({
      signed: { type: 'sequence', id: 7 },
    });
  });

  test('unknown key in override throws even when null-valued', () => {
    expect(() => mergeCompletionTargets(tmpl, { on_signed: null })).toThrow(/unknown trigger/);
    expect(() => mergeCompletionTargets(tmpl, [])).toThrow(/must be an object/);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. applyStatus firing — stateful db stub
// ─────────────────────────────────────────────────────────────

/**
 * Minimal stateful stub: one signing_requests row whose UPDATE actually
 * applies, an events sink, and a case_relate answer for the Primary-contact
 * lookup. JSON columns are returned parsed (mysql2 behaviour _shape relies on).
 */
function makeDb(row, { primaryContactId = 501 } = {}) {
  const state = { row: { ...row }, events: [], queries: [] };
  const db = {
    state,
    query: async (sql, params = []) => {
      state.queries.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');

      if (/SELECT \* FROM signing_requests WHERE id = \?/i.test(s)) {
        return [[{ ...state.row }]];
      }
      if (/^UPDATE signing_requests SET /i.test(s)) {
        // Apply the SET list positionally: 'status = ?, ...' — enough fidelity
        // for these transitions (status / recipients / raw / completed_at).
        const sets = s.match(/SET (.*) WHERE/i)[1].split(',').map((x) => x.trim());
        sets.forEach((clause, i) => {
          const col = clause.split('=')[0].trim();
          state.row[col] = params[i];
        });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO signing_request_events/i.test(s)) {
        state.events.push({ sql: s, params });
        return [{ insertId: state.events.length }];
      }
      if (/FROM case_relate/i.test(s)) {
        return [[primaryContactId == null ? undefined : { contact_id: primaryContactId }]];
      }
      throw new Error(`stub: unexpected SQL: ${s}`);
    },
  };
  return db;
}

function baseRow(overrides = {}) {
  return {
    id: 42,
    provider: 'zoho_sign',
    provider_id: 'ZR-1',
    linkable_type: 'case',
    linkable_id: CASE_ID,
    kind: 'retainer',
    status: 'viewed',
    document_name: 'Retainer — Smith',
    tracking_id: 'YC-x-retainer-AAAA1111',
    recipients: [{ name: 'A', email: 'a@b.c', order: 1, status: 'pending', signed_at: null, ip: null }],
    placement_json: null,
    raw_payload: null,
    template_id: 3,
    expires_at: null,
    completed_at: null,
    seq_instance_id: null,
    signed_pdf_path: null,
    cert_pdf_path: null,
    created_by: 1,
    completion_targets: { signed: { type: 'workflow', id: 12 }, declined: { type: 'sequence', id: 4 } },
    ...overrides,
  };
}

function eventNames(db) {
  // event name is the first param of the events INSERT (verified below on the
  // first assertion of the first test — if _insertEvent's column order ever
  // moves, that test fails loudly rather than these silently matching nothing).
  return db.state.events.map((e) => e.params[1]);
}

describe('applyStatus completion-trigger firing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dispatchers.dispatchWorkflow.mockResolvedValue({
      status: 'success',
      response_body: JSON.stringify({ executionId: 777, workflowId: 12, status: 'started' }),
    });
    dispatchers.dispatchSequence.mockResolvedValue({
      status: 'success',
      response_body: JSON.stringify({ enrollmentId: 888 }),
    });
  });

  test('viewed → signed fires the signed workflow target with the case payload', async () => {
    const db = makeDb(baseRow());
    const out = await esignService.applyStatus(db, 42, { status: 'signed', source: 'webhook' });

    expect(out.changed).toBe(true);
    expect(db.state.row.status).toBe('signed');
    expect(dispatchers.dispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(dispatchers.dispatchSequence).not.toHaveBeenCalled();

    const [synth, config, payload] = dispatchers.dispatchWorkflow.mock.calls[0];
    expect(synth).toEqual({ id: null });
    expect(config).toEqual({ workflow_id: 12 });
    expect(payload).toMatchObject({
      signing_request_id: 42,
      tracking_id: 'YC-x-retainer-AAAA1111',
      status: 'signed',
      kind: 'retainer',
      linkable_type: 'case',
      linkable_id: CASE_ID,
      case_id: CASE_ID,       // carried as STRING — varchar landmine
      contact_id: 501,        // Primary via case_relate
      template_id: 3,
    });
    // case_relate bound as string
    const crq = db.state.queries.find((q) => /case_relate/.test(q.sql));
    expect(crq.params).toEqual([CASE_ID]);

    expect(eventNames(db)).toContain('completion_trigger_fired');
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  test('satisfied_external fires the SIGNED target (terminal success)', async () => {
    const db = makeDb(baseRow());
    await esignService.applyStatus(db, 42, { status: 'satisfied_external' });
    expect(dispatchers.dispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(dispatchers.dispatchWorkflow.mock.calls[0][1]).toEqual({ workflow_id: 12 });
  });

  test('declined fires the declined sequence target with contact_id + trigger fields', async () => {
    const db = makeDb(baseRow());
    await esignService.applyStatus(db, 42, { status: 'declined' });

    expect(dispatchers.dispatchSequence).toHaveBeenCalledTimes(1);
    expect(dispatchers.dispatchWorkflow).not.toHaveBeenCalled();
    const [, config, payload] = dispatchers.dispatchSequence.mock.calls[0];
    expect(config.template_id).toBe(4);
    expect(config.contact_id_field).toBe('contact_id');
    expect(config.trigger_data_fields).toEqual(expect.arrayContaining([
      'signing_request_id', 'tracking_id', 'status', 'kind', 'case_id',
    ]));
    expect(payload.contact_id).toBe(501);
  });

  test('contact-linkable payload: contact_id is the linkable itself, no case_relate query', async () => {
    const db = makeDb(baseRow({ linkable_type: 'contact', linkable_id: '384' }));
    await esignService.applyStatus(db, 42, { status: 'signed' });
    const payload = dispatchers.dispatchWorkflow.mock.calls[0][2];
    expect(payload.contact_id).toBe(384);
    expect(payload.case_id).toBeNull();
    expect(db.state.queries.some((q) => /case_relate/.test(q.sql))).toBe(false);
  });

  test('recalled and expired fire NOTHING', async () => {
    for (const status of ['recalled', 'expired']) {
      const db = makeDb(baseRow());
      await esignService.applyStatus(db, 42, { status });
      expect(dispatchers.dispatchWorkflow).not.toHaveBeenCalled();
      expect(dispatchers.dispatchSequence).not.toHaveBeenCalled();
    }
  });

  test('no targets on the row → nothing fires, nothing queried', async () => {
    const db = makeDb(baseRow({ completion_targets: null }));
    await esignService.applyStatus(db, 42, { status: 'signed' });
    expect(dispatchers.dispatchWorkflow).not.toHaveBeenCalled();
    expect(db.state.queries.some((q) => /case_relate/.test(q.sql))).toBe(false);
  });

  test('signed with only a declined target → nothing fires', async () => {
    const db = makeDb(baseRow({ completion_targets: { declined: { type: 'sequence', id: 4 } } }));
    await esignService.applyStatus(db, 42, { status: 'signed' });
    expect(dispatchers.dispatchWorkflow).not.toHaveBeenCalled();
    expect(dispatchers.dispatchSequence).not.toHaveBeenCalled();
  });

  test('idempotent redelivery (same status) never fires', async () => {
    const db = makeDb(baseRow({ status: 'signed', completed_at: '2026-07-29 12:00:00' }));
    const out = await esignService.applyStatus(db, 42, { status: 'signed' });
    expect(out.changed).toBe(false);
    expect(dispatchers.dispatchWorkflow).not.toHaveBeenCalled();
  });

  test('dispatch failure: status STANDS, failed event + task, no throw', async () => {
    dispatchers.dispatchWorkflow.mockResolvedValue({
      status: 'failed', error: 'workflow #12 is inactive', response_body: null,
    });
    const db = makeDb(baseRow());
    const out = await esignService.applyStatus(db, 42, { status: 'signed' });

    expect(out.changed).toBe(true);          // never un-said
    expect(db.state.row.status).toBe('signed');
    expect(eventNames(db)).toContain('completion_trigger_failed');
    expect(eventNames(db)).not.toContain('completion_trigger_fired');
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.desc).toMatch(/workflow #12 is inactive/);
  });

  test('dispatch THROW is contained the same way', async () => {
    dispatchers.dispatchSequence.mockRejectedValue(new Error('boom'));
    const db = makeDb(baseRow());
    const out = await esignService.applyStatus(db, 42, { status: 'declined' });
    expect(out.changed).toBe(true);
    expect(eventNames(db)).toContain('completion_trigger_failed');
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
  });

  test('case with no Primary: workflow still fires with contact_id null', async () => {
    const db = makeDb(baseRow(), { primaryContactId: null });
    await esignService.applyStatus(db, 42, { status: 'signed' });
    expect(dispatchers.dispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(dispatchers.dispatchWorkflow.mock.calls[0][2].contact_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// createRequest snapshot write
// ─────────────────────────────────────────────────────────────

describe('createRequest completion_targets snapshot', () => {
  function captureDb() {
    const cap = { insert: null };
    return {
      cap,
      query: async (sql, params = []) => {
        const s = sql.replace(/\s+/g, ' ');
        if (/^INSERT INTO signing_requests/i.test(s)) {
          cap.insert = { sql: s, params };
          return [{ insertId: 7 }];
        }
        if (/SELECT \* FROM signing_requests WHERE id = \?/i.test(s)) {
          return [[{ id: 7, recipients: [], status: 'draft', linkable_type: 'case', linkable_id: CASE_ID, kind: 'retainer', tracking_id: 'YC-t' }]];
        }
        if (/INSERT INTO signing_request_events/i.test(s)) return [{ insertId: 1 }];
        throw new Error(`unexpected SQL: ${s}`);
      },
    };
  }

  test('targets are stringified into the completion_targets column', async () => {
    const db = captureDb();
    const targets = { signed: { type: 'workflow', id: 12 } };
    await esignService.createRequest(db, {
      linkableType: 'case', linkableId: CASE_ID, kind: 'retainer',
      createdBy: 0, completionTargets: targets,
    });
    expect(db.cap.insert.sql).toMatch(/completion_targets/);
    expect(db.cap.insert.params).toContain(JSON.stringify(targets));
  });

  test('null targets write NULL', async () => {
    const db = captureDb();
    await esignService.createRequest(db, {
      linkableType: 'case', linkableId: CASE_ID, kind: 'retainer', createdBy: 0,
    });
    const idx = db.cap.insert.sql.replace(/\s+/g, ' ')
      .match(/\(([^)]+)\) VALUES/)[1].split(',').map((c) => c.trim())
      .indexOf('completion_targets');
    expect(idx).toBeGreaterThan(-1);
    // completion_targets is the last column AND the last '?' (provider_id and
    // status are literals in the VALUES list), so it is simply the final param.
    expect(db.cap.insert.params[db.cap.insert.params.length - 1]).toBeNull();
  });
});