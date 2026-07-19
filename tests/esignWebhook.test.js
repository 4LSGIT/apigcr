/**
 * Tests for services/esignWebhookService.js — inbound e-sign (Phase 1C).
 *
 * NO network, NO real DB. esignService, the filing service, the alert service
 * and the provider factory are jest-mocked; what is under test is the
 * ORCHESTRATION: what gets parsed out of an undocumented payload, what is
 * allowed to move a row, what a human is told, and what happens twice when
 * Zoho delivers twice.
 *
 * ── ON THE PARSER TESTS ─────────────────────────────────────────────────────
 * Zoho publishes no webhook payload reference. The shapes exercised below are
 * INFERRED, and the tests are written to prove the parser survives being
 * wrong — that it finds request_id in several plausible arrangements, that it
 * never lets the guessed part of the payload drive a state transition, and
 * that an unrecognizable body produces a captured warning rather than a 500.
 * When a real delivery is observed (checkpoint step D prints them), these
 * become tests of a known contract and should be tightened, not deleted.
 *
 *   npx jest tests/esignWebhook.test.js
 */

jest.mock('../services/esignService', () => ({
  applyStatus:       jest.fn(),
  appendEvent:       jest.fn(async () => ({ id: 1 })),
  getByProviderId:   jest.fn(),
  setLogHook:        jest.fn(),
  listOutstanding:   jest.fn(async () => []),
  getById:           jest.fn(),
  setPdfPaths:       jest.fn(),
}));

jest.mock('../services/esignFilingService', () => ({
  fileSignedDocuments: jest.fn(),
}));

jest.mock('../services/esignAlertService', () => ({
  raiseTask: jest.fn(async () => ({ ok: true, taskId: 777 })),
  resolveAlertAssignee: jest.fn(async () => 22),
}));

jest.mock('../services/logService', () => ({
  createLogEntry: jest.fn(async () => ({ log_id: 5150 })),
}));

jest.mock('../services/esign', () => ({
  getProvider: jest.fn(async () => ({
    downloadSignedPdf: jest.fn(),
    downloadCompletionCertificate: jest.fn(),
  })),
}));

const esignService = require('../services/esignService');
const esignFilingService = require('../services/esignFilingService');
const esignAlertService = require('../services/esignAlertService');
const logService = require('../services/logService');
const svc = require('../services/esignWebhookService');

// Captured at require time: the module self-wires its log hook on load, and
// beforeEach's clearAllMocks would otherwise erase the evidence.
const LOG_HOOK_AT_LOAD = esignService.setLogHook.mock.calls.map((c) => c[0]);

const TOKEN = 'a'.repeat(64);

function makeRequest(over = {}) {
  return {
    id: 42, provider: 'zoho_sign', provider_id: 'ZS-9001',
    linkable_type: 'case', linkable_id: 'AbC12dEf',
    kind: 'retainer', document_name: 'Retainer Agreement',
    tracking_id: 'YC-ESIGN-0042', status: 'sent',
    signed_pdf_path: null, cert_pdf_path: null, completed_at: null,
    created_by: 1,
    recipients: [{ name: 'John Smith', email: 'john@example.com', order: 1, status: 'sent' }],
    ...over,
  };
}

/** Minimal db: serves the token read and the duplicate-event probe. */
function makeDb({ token = TOKEN, duplicate = false } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (/FROM app_settings/i.test(sql)) return [token === null ? [] : [{ value: token }]];
      if (/FROM signing_request_events/i.test(sql)) return [duplicate ? [{ id: 9 }] : []];
      return [[]];
    }),
  };
}

/** The inferred Zoho shape: a `requests` container plus `notifications` meta. */
function zohoBody({ status = 'completed', id = 'ZS-9001', op = 'RequestCompleted', actions } = {}) {
  return {
    notifications: {
      operation_type: op,
      performed_by_email: 'john@example.com',
      performed_at: 1784500000000,
    },
    requests: {
      request_id: id,
      request_name: 'Retainer Agreement',
      request_status: status,
      actions: actions ?? [
        { recipient_name: 'John Smith', recipient_email: 'john@example.com',
          action_status: 'SIGNED', signing_order: 0, action_id: 'ACT1' },
      ],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  esignService.applyStatus.mockImplementation(async (db, id, { status }) => ({
    changed: true, request: makeRequest({ id, status, completed_at: new Date('2026-07-19T18:00:00Z') }),
  }));
  esignService.getByProviderId.mockResolvedValue(makeRequest());
  esignFilingService.fileSignedDocuments.mockResolvedValue({
    filed: true, skipped: false, reason: null, note: null,
    signedPdfPath: '/Clients/Smith/Signed Documents/2026-07-19 Retainer Agreement (signed).pdf',
    certPdfPath: null, warnings: [],
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('token verification', () => {
  test('accepts the configured token', async () => {
    expect(await svc.verifyToken(makeDb(), TOKEN)).toEqual({ ok: true });
  });

  test('rejects a wrong token', async () => {
    const out = await svc.verifyToken(makeDb(), 'b'.repeat(64));
    expect(out).toEqual({ ok: false, reason: 'token_mismatch' });
  });

  test('rejects an absent token', async () => {
    expect((await svc.verifyToken(makeDb(), undefined)).reason).toBe('token_missing');
  });

  // An unauthenticated endpoint that mutates signing status is worse than a
  // broken one. Unset MUST close the door, not open it.
  test('FAILS CLOSED when the secret is unset', async () => {
    expect((await svc.verifyToken(makeDb({ token: null }), TOKEN)).reason).toBe('token_unset');
    expect((await svc.verifyToken(makeDb({ token: '   ' }), TOKEN)).reason).toBe('token_unset');
  });

  test('a DB failure closes the door too', async () => {
    const db = { query: jest.fn(async () => { throw new Error('pool exhausted'); }) };
    expect((await svc.verifyToken(db, TOKEN)).reason).toBe('token_unreadable');
  });

  // timingSafeEqual throws on length mismatch; hashing first makes the compare
  // total, so a short token must return false rather than blow up.
  test('comparison survives length mismatches instead of throwing', () => {
    expect(svc.safeEqual('short', TOKEN)).toBe(false);
    expect(svc.safeEqual(TOKEN, TOKEN)).toBe(true);
    expect(svc.safeEqual('', '')).toBe(true);
    expect(svc.safeEqual(null, undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('payload parsing', () => {
  test('reads the inferred requests + notifications shape', () => {
    const p = svc.parseZohoWebhook(zohoBody());
    expect(p.ok).toBe(true);
    expect(p.providerId).toBe('ZS-9001');
    expect(p.providerStatus).toBe('completed');
    expect(p.operationType).toBe('RequestCompleted');
    expect(p.performedByEmail).toBe('john@example.com');
    expect(p.actions).toHaveLength(1);
    expect(p.occurredAt).toBe(new Date(1784500000000).toISOString());
  });

  test('accepts a JSON string body (unknown content-type path)', () => {
    const p = svc.parseZohoWebhook(JSON.stringify(zohoBody()));
    expect(p.ok).toBe(true);
    expect(p.providerId).toBe('ZS-9001');
  });

  test('unwraps a urlencoded data=<json> wrapper', () => {
    const p = svc.parseZohoWebhook({ data: JSON.stringify(zohoBody()) });
    expect(p.ok).toBe(true);
    expect(p.providerStatus).toBe('completed');
    expect(p.notes.join(' ')).toMatch(/unwrapped/);
  });

  test('finds request_id even when the container is not where we guessed', () => {
    const p = svc.parseZohoWebhook({
      payload: { envelope: { request_id: 'ZS-777', request_status: 'declined' } },
    });
    expect(p.ok).toBe(true);
    expect(p.providerId).toBe('ZS-777');
    expect(p.providerStatus).toBe('declined');
  });

  test('takes the first element when requests arrives as an array', () => {
    const p = svc.parseZohoWebhook({ requests: [{ request_id: 'ZS-1', request_status: 'inprogress' }] });
    expect(p.providerId).toBe('ZS-1');
  });

  test('an unidentifiable body is not ok, and says why', () => {
    const p = svc.parseZohoWebhook({ hello: 'world' });
    expect(p.ok).toBe(false);
    expect(p.notes.join(' ')).toMatch(/no request_id/);
  });

  test('malformed JSON is reported, not thrown', () => {
    const p = svc.parseZohoWebhook('{not json');
    expect(p.ok).toBe(false);
    expect(p.notes.join(' ')).toMatch(/not valid JSON/);
  });

  test('empty bodies are handled', () => {
    expect(svc.parseZohoWebhook(null).ok).toBe(false);
    expect(svc.parseZohoWebhook('').ok).toBe(false);
    expect(svc.parseZohoWebhook('   ').ok).toBe(false);
  });

  // Untrusted input. Deep nesting must hit the depth cap, not the stack.
  test('pathological nesting terminates', () => {
    let deep = { request_id: 'ZS-BURIED' };
    for (let i = 0; i < 500; i++) deep = { nest: deep };
    expect(() => svc.parseZohoWebhook(deep)).not.toThrow();
  });

  test('collects id-shaped fields for a future dedupe key', () => {
    const body = zohoBody();
    body.notifications.notification_id = 'NTF-1';
    expect(svc.parseZohoWebhook(body).hintIds).toMatchObject({ notification_id: 'NTF-1' });
  });

  test('coerceBody classifies each inbound form', () => {
    expect(svc.coerceBody({ a: 1 })).toEqual({ obj: { a: 1 }, note: null });
    expect(svc.coerceBody('{"a":1}').obj).toEqual({ a: 1 });
    expect(svc.coerceBody(null).note).toMatch(/empty/);
    expect(svc.coerceBody(42).note).toMatch(/unusable/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('handleZohoWebhook — routing', () => {
  test('an envelope we never sent is a 200 and a warn, not a retry', async () => {
    esignService.getByProviderId.mockResolvedValue(null);
    const out = await svc.handleZohoWebhook(makeDb(), { body: zohoBody({ id: 'ZS-FOREIGN' }) });

    expect(out).toMatchObject({ ok: true, action: 'unknown_provider_id', providerId: 'ZS-FOREIGN' });
    expect(esignService.applyStatus).not.toHaveBeenCalled();
  });

  // Valid token + garbage body = capture and move on. A 500 here would make
  // Zoho retry a body that will never parse.
  test('an unparseable body is captured, never fatal', async () => {
    const out = await svc.handleZohoWebhook(makeDb(), { body: 'total garbage', rawBody: 'total garbage' });
    expect(out).toMatchObject({ ok: true, action: 'unparseable' });
    expect(esignService.applyStatus).not.toHaveBeenCalled();
  });

  test('a status-less notification writes an audit row and nothing else', async () => {
    const body = { notifications: { operation_type: 'RequestReminded' }, requests: { request_id: 'ZS-9001' } };
    const out = await svc.handleZohoWebhook(makeDb(), { body });

    expect(out).toMatchObject({ ok: true, action: 'event_only', event: 'reminded' });
    expect(esignService.applyStatus).not.toHaveBeenCalled();
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42, expect.objectContaining({ event: 'reminded' })
    );
  });

  test('a duplicate delivery inside the window is dropped', async () => {
    const out = await svc.handleZohoWebhook(makeDb({ duplicate: true }), { body: zohoBody() });
    expect(out).toMatchObject({ ok: true, action: 'duplicate' });
    expect(esignService.applyStatus).not.toHaveBeenCalled();
    expect(esignFilingService.fileSignedDocuments).not.toHaveBeenCalled();
  });

  // THE POINT OF THE DEFENSIVE PARSER. operation_type is a guess; request_status
  // is verified. A payload whose operation_type screams "completed" must not
  // move the row when the status field is a vocabulary we do not know.
  test('an unknown request_status records an event and moves nothing', async () => {
    const out = await svc.handleZohoWebhook(makeDb(), {
      body: zohoBody({ status: 'some_new_zoho_status', op: 'RequestCompleted' }),
    });

    expect(esignService.applyStatus).not.toHaveBeenCalled();
    expect(out.reason).toBe('unmapped_status');
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42,
      expect.objectContaining({ event: 'provider_status_unmapped' })
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe('handleZohoWebhook — the signed path', () => {
  test('files the documents and reports it', async () => {
    const out = await svc.handleZohoWebhook(makeDb(), { body: zohoBody() });

    expect(esignService.applyStatus).toHaveBeenCalledWith(
      expect.anything(), 42, expect.objectContaining({ status: 'signed' })
    );
    expect(esignFilingService.fileSignedDocuments).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, action: 'processed', changed: true, filed: true });
  });

  test('maps Zoho actions into neutral recipients', async () => {
    await svc.handleZohoWebhook(makeDb(), { body: zohoBody() });
    const { recipients } = esignService.applyStatus.mock.calls[0][2];
    expect(recipients).toEqual([
      expect.objectContaining({ email: 'john@example.com', order: 1, status: 'signed' }),
    ]);
  });

  test('a clean filing writes a "filed" audit row and raises no task', async () => {
    await svc.handleZohoWebhook(makeDb(), { body: zohoBody() });
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42, expect.objectContaining({ event: 'filed' })
    );
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  test('a failed filing raises a task naming the reason and the tracking id', async () => {
    esignFilingService.fileSignedDocuments.mockResolvedValue({
      filed: false, skipped: true, reason: 'no_case_dropbox',
      note: 'Case "AbC12dEf" has no Dropbox folder link (cases.case_dropbox is empty).',
      signedPdfPath: null, certPdfPath: null, warnings: [],
    });

    const out = await svc.handleZohoWebhook(makeDb(), { body: zohoBody() });

    expect(out.filed).toBe(false);
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.title).toMatch(/File signed doc manually/);
    expect(task.desc).toMatch(/case_dropbox/);
    expect(task.desc).toMatch(/YC-ESIGN-0042/);
    expect(task).toMatchObject({ linkableType: 'case', linkableId: 'AbC12dEf' });
  });

  test('a filing that succeeded WITH warnings still raises a task, and says so', async () => {
    esignFilingService.fileSignedDocuments.mockResolvedValue({
      filed: true, skipped: false, reason: null, note: null,
      signedPdfPath: '/x/y (signed).zip', certPdfPath: null,
      warnings: ['Zoho returned a ZIP archive, not a single PDF — this envelope held more than one file.'],
    });

    await svc.handleZohoWebhook(makeDb(), { body: zohoBody() });
    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.desc).toMatch(/ZIP archive/);
    expect(task.desc).toMatch(/IS in Dropbox/);
  });

  test('an idempotent replay that finds it already filed says nothing to anyone', async () => {
    esignFilingService.fileSignedDocuments.mockResolvedValue({
      filed: false, skipped: true, reason: 'already_filed',
      signedPdfPath: '/x/y.pdf', certPdfPath: null, warnings: [], note: null,
    });

    await svc.handleZohoWebhook(makeDb(), { body: zohoBody() });
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('handleZohoWebhook — failure statuses', () => {
  test('declined raises a task that names the person and closes the loop', async () => {
    await svc.handleZohoWebhook(makeDb(), { body: zohoBody({ status: 'declined' }) });

    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.title).toMatch(/^E-sign DECLINED/);
    expect(task.desc).toMatch(/john@example\.com/);
    expect(task.desc).toMatch(/does not pass on a decline reason/i);
    expect(esignFilingService.fileSignedDocuments).not.toHaveBeenCalled();
  });

  // Zoho's request-status vocabulary has SIX values and none of them is a
  // bounce (ZOHO_REQUEST_STATUS_MAP: draft/inprogress/completed/declined/
  // recalled/expired). A failed delivery can therefore only arrive as a
  // status-less notification, so that is the path tested.
  test('Zoho has no request-level bounce status — the map is the proof', () => {
    const { ZOHO_REQUEST_STATUS_MAP } = require('../services/esign/zohoSignProvider');
    expect(Object.keys(ZOHO_REQUEST_STATUS_MAP)).toEqual(
      ['draft', 'inprogress', 'completed', 'declined', 'recalled', 'expired']
    );
    expect(Object.values(ZOHO_REQUEST_STATUS_MAP)).not.toContain('bounced');
  });

  test('a bounce-shaped notification alerts staff to fix the address and re-send', async () => {
    const out = await svc.handleZohoWebhook(makeDb(), {
      body: { notifications: { operation_type: 'RecipientBounced' }, requests: { request_id: 'ZS-9001' } },
    });

    expect(out).toMatchObject({ action: 'event_only', alerted: true });
    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.title).toMatch(/^E-sign BOUNCED/);
    expect(task.desc).toMatch(/re-send/i);
  });

  // The whole point of alerting off a keyword instead of transitioning: a
  // wrong guess must cost a spurious task, never a corrupted row.
  test('a bounce alert does NOT move the row', async () => {
    await svc.handleZohoWebhook(makeDb(), {
      body: { notifications: { operation_type: 'DeliveryFailed' }, requests: { request_id: 'ZS-9001' } },
    });
    expect(esignService.applyStatus).not.toHaveBeenCalled();
  });

  test('processStatusChange still handles a bounced status if one ever arrives', async () => {
    await svc.processStatusChange(makeDb(), makeRequest(), { status: 'bounced', source: 'reconcile' });
    expect(esignAlertService.raiseTask.mock.calls[0][1].title).toMatch(/^E-sign BOUNCED/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('processStatusChange — the shared choke point', () => {
  // The amendment: reconciliation must not reimplement filing. Same function,
  // same filing call, same alerts — only `source` differs.
  test('reconcile and webhook take the identical path', async () => {
    const provider = { downloadSignedPdf: jest.fn() };
    const out = await svc.processStatusChange(makeDb(), makeRequest(), {
      status: 'signed', providerStatus: 'completed', provider, source: 'reconcile',
    });

    expect(out.source).toBe('reconcile');
    expect(out.filed).toBe(true);
    expect(esignFilingService.fileSignedDocuments).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: 42 }), { provider }
    );
  });

  test('a caller-supplied provider is reused, not rebuilt per row', async () => {
    const { getProvider } = require('../services/esign');
    const provider = { downloadSignedPdf: jest.fn() };
    await svc.processStatusChange(makeDb(), makeRequest(), {
      status: 'signed', provider, source: 'reconcile',
    });
    expect(getProvider).not.toHaveBeenCalled();
  });

  // applyStatus soft-refuses a late event rather than throwing. That must read
  // as "nothing to do", never as a failure — and must not re-file.
  test('a late event on a terminal row changes nothing and files nothing', async () => {
    esignService.applyStatus.mockResolvedValue({ changed: false, reason: 'terminal' });

    const out = await svc.processStatusChange(makeDb(), makeRequest({ status: 'signed' }), {
      status: 'expired', providerStatus: 'expired',
    });

    expect(out).toMatchObject({ changed: false, reason: 'terminal', filed: false });
    expect(esignFilingService.fileSignedDocuments).not.toHaveBeenCalled();
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  test('an illegal transition is recorded and reported, never swallowed silently', async () => {
    const err = new Error('INVALID_ESIGN_TRANSITION: draft → viewed');
    esignService.applyStatus.mockRejectedValue(err);

    const out = await svc.processStatusChange(makeDb(), makeRequest(), { status: 'viewed' });

    expect(out.reason).toBe('transition_error');
    expect(out.error).toMatch(/INVALID_ESIGN_TRANSITION/);
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 42, expect.objectContaining({ event: 'status_apply_failed' })
    );
  });

  test('a provider that cannot be built is reported, not thrown', async () => {
    const { getProvider } = require('../services/esign');
    getProvider.mockRejectedValueOnce(new Error('esign_credential_id is not set'));

    const out = await svc.processStatusChange(makeDb(), makeRequest(), { status: 'signed' });
    expect(out.filing.reason).toBe('no_provider');
    expect(esignAlertService.raiseTask).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('the log hook', () => {
  const ev = (event, over = {}) => ({
    signing_request_id: 42, event, recipient_email: 'john@example.com',
    request: makeRequest({ status: event }), ...over,
  });

  test('logs the seven allowlisted events', async () => {
    for (const e of ['sent', 'signed', 'declined', 'bounced', 'recalled', 'expired', 'reminded']) {
      logService.createLogEntry.mockClear();
      await svc.writeEventLog(makeDb(), ev(e));
      expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    }
  });

  // _fireLogHook runs on EVERY audit row. Without the filter the case log
  // fills with drafts and per-open noise.
  test('does NOT log created or viewed', async () => {
    for (const e of ['created', 'viewed', 'delivered', 'filed', 'provider_notification']) {
      await svc.writeEventLog(makeDb(), ev(e));
    }
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });

  test('writes the Phase 0 shape: type esign, by 0, structured data', async () => {
    await svc.writeEventLog(makeDb(), ev('signed'));
    const row = logService.createLogEntry.mock.calls[0][1];

    expect(row).toMatchObject({
      type: 'esign', by: 0, link_type: 'case', link_id: 'AbC12dEf', direction: 'incoming',
    });
    expect(row.data).toMatchObject({
      event: 'signed', source: 'zoho_sign', tracking_id: 'YC-ESIGN-0042', kind: 'retainer',
    });
    expect(row.subject).toMatch(/Retainer Agreement/);
  });

  // by:0 is a constant because these are machine events. Who asked for the
  // send is a fact about the request and rides in data, not in log_by.
  test('human attribution lives in data.created_by, never in log_by', async () => {
    await svc.writeEventLog(makeDb(), ev('sent'));
    const row = logService.createLogEntry.mock.calls[0][1];
    expect(row.by).toBe(0);
    expect(row.data.created_by).toBe(1);
  });

  test('direction splits on who acted', async () => {
    await svc.writeEventLog(makeDb(), ev('sent'));
    expect(logService.createLogEntry.mock.calls[0][1]).toMatchObject({
      direction: 'outgoing', to: 'john@example.com',
    });

    logService.createLogEntry.mockClear();
    await svc.writeEventLog(makeDb(), ev('declined'));
    expect(logService.createLogEntry.mock.calls[0][1]).toMatchObject({
      direction: 'incoming', from: 'john@example.com',
    });
  });

  test('signed rows carry the filed paths into the log', async () => {
    await svc.writeEventLog(makeDb(), ev('signed', {
      request: makeRequest({ signed_pdf_path: '/x/y (signed).pdf', cert_pdf_path: '/x/y (certificate).pdf' }),
    }));
    expect(logService.createLogEntry.mock.calls[0][1].data).toMatchObject({
      signed_pdf_path: '/x/y (signed).pdf', cert_pdf_path: '/x/y (certificate).pdf',
    });
  });

  test('an event with no request attached is skipped, not crashed on', async () => {
    await expect(svc.writeEventLog(makeDb(), { event: 'signed', request: null })).resolves.toBeUndefined();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });

  // Self-wiring: routes are require()d at boot by server.js's readdir
  // auto-mount, the route requires this module, so the hook is live
  // process-wide before any request or job runs. startup/init.js is a no-op
  // and is deliberately NOT involved.
  test('the hook is installed on esignService at require time', () => {
    expect(LOG_HOOK_AT_LOAD).toContain(svc.writeEventLog);
  });
});

// ─────────────────────────────────────────────────────────────
describe('event naming', () => {
  test('folds recognisable operations onto our own vocabulary', () => {
    expect(svc._eventNameFor('RequestReminded')).toBe('reminded');
    expect(svc._eventNameFor('RecipientViewed')).toBe('viewed');
    expect(svc._eventNameFor('DocumentDelivered')).toBe('delivered');
  });

  test('normalises anything else into a varchar(64)-safe snake_case name', () => {
    expect(svc._eventNameFor('SomeBrandNewThing')).toBe('some_brand_new_thing');
    expect(svc._eventNameFor('weird!!! chars@here')).toBe('weird_chars_here');
    expect(svc._eventNameFor('X'.repeat(200)).length).toBeLessThanOrEqual(64);
    expect(svc._eventNameFor(null)).toBe('provider_notification');
    expect(svc._eventNameFor('!!!')).toBe('provider_notification');
  });
});

// ─────────────────────────────────────────────────────────────
describe('duplicate detection', () => {
  test('matches on our ingest time, not the provider claim', async () => {
    const db = makeDb();
    await svc.isDuplicateEvent(db, 42, 'signed', 'john@example.com');
    const [sql] = db.query.mock.calls.find((c) => /signing_request_events/i.test(c[0]));
    expect(sql).toMatch(/created_at\s*>=/);
    expect(sql).not.toMatch(/occurred_at\s*>=/);
    expect(sql).toMatch(/recipient_email <=> \?/);   // null-safe
  });

  // A duplicate audit row is noise; a dropped one is a hole in a legal trail.
  test('fails OPEN when the probe itself errors', async () => {
    const db = { query: jest.fn(async () => { throw new Error('deadlock'); }) };
    expect(await svc.isDuplicateEvent(db, 42, 'signed', null)).toBe(false);
  });
});
