/**
 * Tests for lib/internal_functions/esign.js — the reconciliation job (1C).
 *
 * This job exists because webhooks get lost: a deploy lands mid-delivery,
 * Cloud Run suspends the instance between our 200 and the end of the pipeline,
 * a token gets rotated. All of those look identical from inside the app — a
 * row stuck at 'sent' forever — so the tests below are mostly about the job
 * NOT quietly failing in the same silent way.
 *
 * The load-bearing assertion is that it routes through
 * esignWebhookService.processStatusChange rather than reimplementing filing.
 * That is a manager amendment, and it is the kind of thing that rots first:
 * the reconciliation path only runs when a webhook was MISSED, so nobody
 * exercises it by hand.
 *
 *   npx jest tests/esignReconcile.test.js
 */

jest.mock('../services/esignService', () => ({
  listOutstanding: jest.fn(async () => []),
  getById:         jest.fn(),
  appendEvent:     jest.fn(async () => ({ ok: true })),
  setLogHook:      jest.fn(),
}));

jest.mock('../services/esignWebhookService', () => ({
  processStatusChange: jest.fn(async () => ({ changed: true, filed: true })),
}));

jest.mock('../services/esignFilingService', () => ({
  fileSignedDocuments: jest.fn(),
}));

jest.mock('../services/esignAlertService', () => ({
  raiseTask: jest.fn(async () => ({ ok: true, taskId: 500 })),
}));

jest.mock('../services/esign', () => ({ getProvider: jest.fn() }));

const esignService = require('../services/esignService');
const esignWebhookService = require('../services/esignWebhookService');
const esignFilingService = require('../services/esignFilingService');
const esignAlertService = require('../services/esignAlertService');
const { getProvider } = require('../services/esign');

const fns = require('../lib/internal_functions/esign');
const reconcile = fns.esign_reconcile;

function row(over = {}) {
  return {
    id: 1, provider: 'zoho_sign', provider_id: 'ZS-1',
    linkable_type: 'case', linkable_id: 'AbC12dEf',
    kind: 'retainer', document_name: 'Retainer', tracking_id: 'YC-ESIGN-0001',
    status: 'sent', signed_pdf_path: null, completed_at: null,
    ...over,
  };
}

function makeDb({ unfiled = [] } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (/FROM signing_requests/i.test(sql)) return [unfiled];
      return [[]];
    }),
  };
}

function makeProvider(statuses = {}) {
  return {
    getStatus: jest.fn(async (pid) => statuses[pid] || { status: 'sent', providerStatus: 'inprogress', recipients: [], raw: {} }),
    downloadSignedPdf: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getProvider.mockResolvedValue(makeProvider());
  esignService.listOutstanding.mockResolvedValue([]);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('registration', () => {
  test('is exported under its own name and carries usable metadata', () => {
    expect(typeof reconcile).toBe('function');
    expect(reconcile.__meta.category).toBe('system');
    expect(reconcile.__meta.params.map((p) => p.name).sort()).toEqual(['dry_run', 'max_rows']);
  });

  // The directory is auto-scanned — dropping the file in IS the wiring.
  test('the registry picks it up without an index edit', () => {
    const registry = require('../lib/internal_functions');
    const all = registry.functions || registry;
    expect(Object.keys(all)).toContain('esign_reconcile');
  });
});

// ─────────────────────────────────────────────────────────────
describe('pass A — outstanding rows', () => {
  test('a row whose status moved goes through the SHARED choke point', async () => {
    esignService.listOutstanding.mockResolvedValue([row()]);
    const provider = makeProvider({ 'ZS-1': { status: 'signed', providerStatus: 'completed', recipients: [], raw: { r: 1 } } });
    getProvider.mockResolvedValue(provider);

    const out = await reconcile({}, makeDb());

    expect(esignWebhookService.processStatusChange).toHaveBeenCalledTimes(1);
    const [, req, opts] = esignWebhookService.processStatusChange.mock.calls[0];
    expect(req.id).toBe(1);
    expect(opts).toMatchObject({ status: 'signed', providerStatus: 'completed', source: 'reconcile' });
    // Same provider instance reused, not rebuilt per row.
    expect(opts.provider).toBe(provider);
    expect(out.output).toMatchObject({ checked: 1, moved: 1, filed: 1 });
  });

  test('a row that has not moved is left alone', async () => {
    esignService.listOutstanding.mockResolvedValue([row()]);
    const out = await reconcile({}, makeDb());

    expect(esignWebhookService.processStatusChange).not.toHaveBeenCalled();
    expect(out.output).toMatchObject({ checked: 1, moved: 0, unchanged: 1 });
  });

  test('rows with no provider_id are skipped — they were never sent', async () => {
    esignService.listOutstanding.mockResolvedValue([row({ provider_id: null }), row({ id: 2, provider_id: 'ZS-2' })]);
    const out = await reconcile({}, makeDb());
    expect(out.output.checked).toBe(1);
  });

  test('max_rows caps the work', async () => {
    esignService.listOutstanding.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => row({ id: i + 1, provider_id: `ZS-${i + 1}` }))
    );
    const out = await reconcile({ max_rows: 5 }, makeDb());
    expect(out.output.checked).toBe(5);
  });

  // One envelope Zoho cannot answer for must not cost us the other 199.
  test('one bad row does not end the run', async () => {
    esignService.listOutstanding.mockResolvedValue([
      row({ id: 1, provider_id: 'ZS-1' }),
      row({ id: 2, provider_id: 'ZS-BAD' }),
      row({ id: 3, provider_id: 'ZS-3' }),
    ]);
    getProvider.mockResolvedValue({
      getStatus: jest.fn(async (pid) => {
        if (pid === 'ZS-BAD') throw new Error('Zoho 500');
        return { status: 'signed', providerStatus: 'completed', recipients: [], raw: {} };
      }),
    });

    const out = await reconcile({}, makeDb());
    expect(out.output).toMatchObject({ checked: 3, moved: 2, failed: 1 });
    expect(out.output.errors[0]).toMatchObject({ request_id: 2 });
  });

  // A revoked token fails every row identically. One task, not two hundred.
  test('failures produce exactly one summary task', async () => {
    esignService.listOutstanding.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => row({ id: i + 1, provider_id: `ZS-${i + 1}` }))
    );
    getProvider.mockResolvedValue({
      getStatus: jest.fn(async () => { throw new Error('invalid oauth token'); }),
    });

    await reconcile({}, makeDb());
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.title).toMatch(/6 problem/);
    expect(task.desc).toMatch(/and 1 more/);
    expect(task.desc).toMatch(/Connections/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('pass B — signed but never filed', () => {
  // The specific hole the 200-then-work pattern opens. Pass A cannot see
  // these: a signed row is not outstanding.
  test('re-files a signed row with no stored path', async () => {
    const signed = row({ id: 9, status: 'signed', provider_id: 'ZS-9' });
    esignService.getById.mockResolvedValue(signed);
    esignFilingService.fileSignedDocuments.mockResolvedValue({
      filed: true, skipped: false, reason: null, warnings: [],
      signedPdfPath: '/x/y (signed).pdf', certPdfPath: null,
    });

    const out = await reconcile({}, makeDb({ unfiled: [{ id: 9 }] }));

    expect(esignFilingService.fileSignedDocuments).toHaveBeenCalledTimes(1);
    expect(out.output.refiled).toBe(1);
    expect(esignService.appendEvent).toHaveBeenCalledWith(
      expect.anything(), 9, expect.objectContaining({ event: 'filed' })
    );
  });

  test('a row that turns out to be filed already is a no-op', async () => {
    esignService.getById.mockResolvedValue(row({ id: 9, status: 'signed', signed_pdf_path: '/x/y.pdf' }));
    const out = await reconcile({}, makeDb({ unfiled: [{ id: 9 }] }));

    expect(esignFilingService.fileSignedDocuments).not.toHaveBeenCalled();
    expect(out.output.refiled).toBe(0);
  });

  test('a still-unfilable row is counted as a failure, not retried into a loop', async () => {
    esignService.getById.mockResolvedValue(row({ id: 9, status: 'signed' }));
    esignFilingService.fileSignedDocuments.mockResolvedValue({
      filed: false, skipped: true, reason: 'no_case_dropbox',
      note: 'Case has no Dropbox folder link.', warnings: [], signedPdfPath: null, certPdfPath: null,
    });

    const out = await reconcile({}, makeDb({ unfiled: [{ id: 9 }] }));
    expect(out.output.failed).toBe(1);
    expect(out.output.errors[0].error).toMatch(/Dropbox folder/);
  });

  test('the lookback window is bounded — stale failures are a human problem', async () => {
    const db = makeDb({ unfiled: [] });
    await reconcile({}, db);
    const [sql, params] = db.query.mock.calls.find((c) => /FROM signing_requests/i.test(c[0]));
    expect(sql).toMatch(/signed_pdf_path IS NULL/);
    expect(sql).toMatch(/INTERVAL \? DAY/);
    expect(params[0]).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────
describe('dry run', () => {
  test('reports what would change and writes nothing', async () => {
    esignService.listOutstanding.mockResolvedValue([row()]);
    getProvider.mockResolvedValue(makeProvider({
      'ZS-1': { status: 'signed', providerStatus: 'completed', recipients: [], raw: {} },
    }));

    const out = await reconcile({ dry_run: true }, makeDb({ unfiled: [{ id: 9 }] }));

    expect(out.output).toMatchObject({ dry_run: true, moved: 1 });
    expect(out.output.changes[0]).toMatchObject({ request_id: 1, from: 'sent', to: 'signed' });
    expect(esignWebhookService.processStatusChange).not.toHaveBeenCalled();
    expect(esignFilingService.fileSignedDocuments).not.toHaveBeenCalled();
  });

  test('accepts the string "true" the workflow editor produces', async () => {
    esignService.listOutstanding.mockResolvedValue([row()]);
    const out = await reconcile({ dry_run: 'true' }, makeDb());
    expect(out.output.dry_run).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('when nothing can run', () => {
  // Failing 200 rows identically tells you nothing. Fail once, loudly.
  test('an unbuildable provider aborts with a single explanatory task', async () => {
    getProvider.mockRejectedValue(new Error('esign_credential_id is not set'));

    const out = await reconcile({}, makeDb());

    expect(out.success).toBe(false);
    expect(out.output.aborted).toBe(true);
    expect(esignService.listOutstanding).not.toHaveBeenCalled();
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    expect(esignAlertService.raiseTask.mock.calls[0][1].desc).toMatch(/esign_credential_id/);
  });

  test('a listOutstanding failure aborts rather than reporting a clean run', async () => {
    esignService.listOutstanding.mockRejectedValue(new Error('table missing'));
    const out = await reconcile({}, makeDb());
    expect(out.success).toBe(false);
    expect(out.output.aborted).toBe(true);
  });

  test('an empty queue is a successful no-op', async () => {
    const out = await reconcile({}, makeDb());
    expect(out.success).toBe(true);
    expect(out.output).toMatchObject({ checked: 0, moved: 0, failed: 0 });
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });
});
