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
  _announceFiling: jest.fn(async () => {}),
  WEBHOOK_LAST_SEEN_KEY: 'esign_webhook_last_seen_at',
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

function makeDb({ unfiled = [], settings = {}, lastWebhookEvent = null } = {}) {
  return {
    query: jest.fn(async (sql, params = []) => {
      // Must be tested BEFORE signing_requests — the dead-channel check's
      // audit fallback reads signing_request_events.
      if (/FROM signing_request_events/i.test(sql)) {
        return [[{ at: lastWebhookEvent }]];
      }
      if (/FROM signing_requests/i.test(sql)) return [unfiled];
      // settingsService.getSetting — serve the heartbeat (and anything else).
      if (/FROM app_settings/i.test(sql)) {
        const v = settings[params[0]];
        return [v != null ? [{ value: v }] : []];
      }
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
describe('dead-channel check — moved rows + webhook silence', () => {
  const HEARTBEAT_KEY = 'esign_webhook_last_seen_at';

  /** One outstanding row that Zoho reports as moved. */
  function armOneMove() {
    esignService.listOutstanding.mockResolvedValue([row()]);
    getProvider.mockResolvedValue(makeProvider({
      'ZS-1': { status: 'signed', providerStatus: 'completed', recipients: [], raw: {} },
    }));
  }

  test('moved ≥1 with NO heartbeat on record → one loud task', async () => {
    armOneMove();
    const out = await reconcile({}, makeDb()); // settings empty = never seen

    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.title).toMatch(/webhooks appear to be DOWN/);
    expect(task.desc).toMatch(/YC-ESIGN-0001: sent → signed/);
    expect(task.desc).toMatch(/EVER/);
    expect(task.desc).toMatch(/esign_webhook_hmac_mode/);
    expect(task.desc).toMatch(/esign_webhook_token/);
    expect(out.output.webhook_silence_alerted).toBe(true);
  });

  test('moved ≥1 with a STALE heartbeat (>24h) → task, timestamp named', async () => {
    armOneMove();
    const stale = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    await reconcile({}, makeDb({ settings: { [HEARTBEAT_KEY]: stale } }));

    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    expect(esignAlertService.raiseTask.mock.calls[0][1].desc).toContain(stale);
  });

  test('moved ≥1 with a FRESH heartbeat → no task (a single dropped delivery is routine)', async () => {
    armOneMove();
    const fresh = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const out = await reconcile({}, makeDb({ settings: { [HEARTBEAT_KEY]: fresh } }));

    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
    expect(out.output).toMatchObject({ moved: 1, webhook_silence_alerted: false });
  });

  test('moved = 0 with a stale heartbeat → no task (silence alone is normal)', async () => {
    esignService.listOutstanding.mockResolvedValue([row()]); // status unchanged
    const out = await reconcile({}, makeDb());

    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
    expect(out.output).toMatchObject({ moved: 0, webhook_silence_alerted: false });
  });

  test('dry run never raises the task, even when rows would move', async () => {
    armOneMove();
    const out = await reconcile({ dry_run: true }, makeDb());

    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
    expect(out.output).toMatchObject({ dry_run: true, moved: 1, webhook_silence_alerted: false });
  });

  test('many moved rows → still exactly ONE task, capped at 5 listed', async () => {
    esignService.listOutstanding.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) =>
        row({ id: i + 1, provider_id: `ZS-${i + 1}`, tracking_id: `YC-ESIGN-000${i + 1}` }))
    );
    getProvider.mockResolvedValue({
      getStatus: jest.fn(async () => ({ status: 'signed', providerStatus: 'completed', recipients: [], raw: {} })),
    });

    await reconcile({}, makeDb());
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.desc).toMatch(/and 2 more/);
  });

  test('an unparseable heartbeat value counts as silence, not as fresh', async () => {
    armOneMove();
    await reconcile({}, makeDb({ settings: { [HEARTBEAT_KEY]: 'not-a-date' } }));
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
  });

  test('a settings-read failure falls back to the audit log rather than aborting', async () => {
    // Previously this pushed a 'dead-channel-check' error and gave up. The
    // heartbeat is now only the PREFERRED source: an unreadable one degrades
    // to the newest webhook-sourced event, which still answers the question.
    armOneMove();
    const fresh = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const db = makeDb({ lastWebhookEvent: fresh });
    const inner = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM app_settings/i.test(sql)) throw new Error('pool exhausted');
      return inner(sql, params);
    });

    const out = await reconcile({}, db);
    expect(out.success).toBe(true);
    expect(out.output.moved).toBe(1);
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();   // audit says fresh
    expect(out.output.errors).toHaveLength(0);
  });

  test('no heartbeat but a FRESH webhook-sourced audit row → no task', async () => {
    // The 2026-07-27 false positive (task 1077): the heartbeat setting did not
    // exist yet, an absent row read as "no delivery EVER", and the alert fired
    // while three webhook events landed within nine minutes.
    armOneMove();
    const fresh = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const out = await reconcile({}, makeDb({ lastWebhookEvent: fresh }));

    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
    expect(out.output.webhook_silence_alerted).toBe(false);
  });

  test('no heartbeat and a STALE audit row → task, and it says where the time came from', async () => {
    armOneMove();
    const stale = new Date(Date.now() - 40 * 60 * 60 * 1000);
    await reconcile({}, makeDb({ lastWebhookEvent: stale }));

    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    const desc = esignAlertService.raiseTask.mock.calls[0][1].desc;
    expect(desc).toContain(stale.toISOString());
    expect(desc).toMatch(/no heartbeat on record/);
  });

  test('the heartbeat WINS over the audit row when both are present', async () => {
    armOneMove();
    const heartbeat = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleAudit = new Date(Date.now() - 40 * 60 * 60 * 1000);
    await reconcile({}, makeDb({
      settings: { [HEARTBEAT_KEY]: heartbeat },
      lastWebhookEvent: staleAudit,
    }));

    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  // ── expiry is not a missed webhook ──────────────────────────────────────
  // Zoho DOES webhook expiries, but batched ~22h after the clock runs out —
  // verified on request 30, where reconcile applied the move at 11:00 and the
  // webhook arrived at 21:30 the same day and noop'd. This job polls nightly,
  // so it wins that race structurally. Counting the win as a loss is what
  // produced task 1114 on 2026-08-15.

  function armMoves(...targets) {
    esignService.listOutstanding.mockResolvedValue(
      targets.map((_, i) => row({ id: i + 1, provider_id: `ZS-${i + 1}`, tracking_id: `YC-ESIGN-000${i + 1}` }))
    );
    const statuses = {};
    targets.forEach((status, i) => {
      statuses[`ZS-${i + 1}`] = { status, providerStatus: status, recipients: [], raw: {} };
    });
    getProvider.mockResolvedValue(makeProvider(statuses));
  }

  test('expired-only moves never raise the task, however silent the channel', async () => {
    armMoves('expired', 'expired', 'expired');
    const out = await reconcile({}, makeDb());   // no heartbeat, no audit row

    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
    expect(out.output).toMatchObject({ moved: 3, actor_moved: 0, webhook_silence_alerted: false });
  });

  test('a mixed run counts only the actor-driven moves', async () => {
    armMoves('expired', 'signed', 'expired');
    const out = await reconcile({}, makeDb());

    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    const desc = esignAlertService.raiseTask.mock.calls[0][1].desc;
    expect(desc).toMatch(/applied 1 status change\(s\)/);
    expect(desc).toMatch(/YC-ESIGN-0002: sent → signed/);
    expect(desc).not.toMatch(/→ expired/);
    expect(out.output).toMatchObject({ moved: 3, actor_moved: 1 });
  });

  test('declined and viewed still count as actor-driven', async () => {
    armMoves('declined', 'viewed');
    const out = await reconcile({}, makeDb());

    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    expect(out.output.actor_moved).toBe(2);
  });

  test('the alert still names every setting an operator needs to check', async () => {
    armOneMove();
    await reconcile({}, makeDb());
    const desc = esignAlertService.raiseTask.mock.calls[0][1].desc;
    expect(desc).toMatch(/ESIGN WEBHOOK/);            // the log filter
    expect(desc).toMatch(/Zoho Sign console/);        // "Zoho stopped calling"
    expect(desc).toMatch(/esign_webhook_token/);
    expect(desc).toMatch(/esign_webhook_hmac_mode/);
    expect(desc).toMatch(/esign_webhook_secret/);
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

  // The fallback ladder means a late filing can succeed WITH strings attached
  // — unsorted placement, an auto-created folder, a ZIP. Before this branch
  // existed those were counted as "failed" and the nightly summary printed
  // "filing failed" about a document sitting in Dropbox.
  test('a filing that landed with warnings is refiled AND announced, never counted failed', async () => {
    esignService.getById.mockResolvedValue(row({ id: 9, status: 'signed' }));
    esignFilingService.fileSignedDocuments.mockResolvedValue({
      filed: true, skipped: false, reason: null, note: null, placement: 'unsorted',
      signedPdfPath: '/  Law Office/   Cases/  Unsorted E-Signed Documents/x (signed).pdf',
      certPdfPath: null,
      warnings: ['The document could not be filed to a case folder — …'],
    });

    const out = await reconcile({}, makeDb({ unfiled: [{ id: 9 }] }));

    expect(out.output.refiled).toBe(1);
    expect(out.output.failed).toBe(0);
    expect(esignWebhookService._announceFiling).toHaveBeenCalledTimes(1);
    const [, , result] = esignWebhookService._announceFiling.mock.calls[0];
    expect(result).toMatchObject({ source: 'reconcile', late: true });
    expect(result.filing.placement).toBe('unsorted');
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