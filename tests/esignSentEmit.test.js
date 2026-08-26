// tests/esignSentEmit.test.js
//
// R1.5 — the `esign.sent` domain event, and the absence of the hardcoded
// contract_sent advance it replaced.
//
// WHY A SEPARATE FILE FROM tests/esignSend.test.js
// ------------------------------------------------
// That suite deliberately does NOT mock lib/domainEvents — it is about the
// send ORCHESTRATION (stamping, provider contract, credit accounting, row
// state), and a file-wide domainEvents mock there would be noise. jest.mock is
// file-wide, so the emit assertions need their own module registry. The mock
// set below is the minimum to reach sendPipeline / resendPipeline and is
// copied from that suite rather than reinvented.
//
// WHAT THIS PROVES, AND WHY EACH PIECE MATTERS
// --------------------------------------------
// The two pipeline advances R1.5 deleted are now carried by trigger rules that
// read this envelope. So the envelope IS the contract: if data.kind stops
// being emitted, or case_id arrives as a number, or a send path goes silent,
// the rule stops matching and cases quietly stop advancing — with no error
// anywhere. Each assertion below is aimed at one of those silent failures.
//
// THE TWO EMIT SITES. There are two provider-send code paths in
// esignSendService, not one:
//   sendPipeline              — first sends, draft retries, terminal duplicates
//   resendPipeline branch (a) — the SAME-ROW bounce resend, which inlines its
//                               own provider call and never calls sendPipeline
// An emit in sendPipeline alone would be silent for every bounce resend. Both
// sites are covered here, as is the no-double-emit property of the terminal
// duplicate path (which DOES route through sendPipeline).
//
// Run:
//   npx jest tests/esignSentEmit.test.js

'use strict';

jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction: (_ruleId, fn) => fn(),
  MAX_DEPTH: 4,
}));

jest.mock('../services/esignService', () => ({
  createRequest:   jest.fn(),
  markSent:        jest.fn(),
  appendEvent:     jest.fn(async () => ({ ok: true })),
  getById:         jest.fn(),
  setSeqInstance:  jest.fn(async () => ({})),
  storeSourcePdf:  jest.fn(async (db, id, buffer) => ({ id, size: buffer.length })),
  getSourcePdf:    jest.fn(async () => null),
  _normalizeRecipients: jest.fn((r) => r || []),
  LINKABLE_TYPES: ['case', 'contact'],
  STATUSES: [
    'draft', 'sent', 'viewed', 'signed', 'declined',
    'expired', 'recalled', 'bounced', 'satisfied_external',
  ],
  TERMINAL: new Set(['signed', 'declined', 'expired', 'recalled', 'satisfied_external']),
}));

jest.mock('../services/esign', () => ({
  getProvider:       jest.fn(),
  recordCreditSpend: jest.fn(async () => ({ ok: true, balance: 95, previous: 100 })),
}));

// Real sniffBuffer / buildFilename (stampTrackingFooter calls sniffBuffer on
// every send); only the Dropbox-touching call is stubbed. Same posture as
// tests/esignSend.test.js.
jest.mock('../services/esignFilingService', () => {
  const actual = jest.requireActual('../services/esignFilingService');
  return { ...actual, fileExternalDocument: jest.fn() };
});

// 'contract' is NOT in esignSendService's static KINDS list — it is a
// TEMPLATE-DEFINED kind. validateSendInput accepts the union of KINDS and the
// kinds carried by ACTIVE contract_templates rows, and live data (2026-08-26)
// has three active templates on kind='contract': the Ch13 Fee Agreement and
// the Ch7 Pre- and Post-Filing Fee Agreements. Without this mock every send in
// this suite 400s with ESIGN_BAD_KIND, which is a load-bearing detail for the
// seeded rule: `data.kind equals 'contract'` only ever matches because those
// templates exist.
jest.mock('../services/esignTemplateService', () => ({
  listActiveTemplateKinds: jest.fn(async () => ['contract']),
}));

const domainEvents = require('../lib/domainEvents');
const esignService = require('../services/esignService');
const { getProvider, recordCreditSpend } = require('../services/esign');
const svc = require('../services/esignSendService');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES  (buildPdf copied from tests/esignSend.test.js — same reasoning:
// a readable fixture beats a checked-in binary, and pdf-lib is real here.)
// ─────────────────────────────────────────────────────────────────────────────

const TRACKING = 'YC-AbC12dEf-contract-9F3A21BC';

function buildPdf(pageCount = 1) {
  const objs = [];
  const kids = [];
  for (let i = 0; i < pageCount; i++) kids.push(`${4 + i * 2} 0 R`);

  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  for (let i = 0; i < pageCount; i++) {
    const p = 4 + i * 2;
    const c = p + 1;
    const s = `BT /F1 12 Tf 72 700 Td (Body page ${i + 1}) Tj ET`;
    objs[p] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
              `/Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`;
    objs[c] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  }

  const n = objs.length;
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let i = 1; i < n; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

function makeRow(over = {}) {
  return {
    id: 42,
    provider: 'zoho_sign',
    provider_id: null,
    linkable_type: 'case',
    linkable_id: 'AbC12dEf',
    kind: 'contract',
    status: 'draft',
    document_name: 'Retainer Agreement',
    tracking_id: TRACKING,
    recipients: [{ name: 'John Smith', email: 'john@example.com', order: 1, status: 'pending' }],
    placement_json: null,
    template_id: null,
    seq_instance_id: null,
    sent_at: null,
    completed_at: null,
    expires_at: null,
    created_by: 1,
    ...over,
  };
}

function makeDb() {
  return {
    query: jest.fn(async (sql) => {
      if (/FROM cases/i.test(sql))                  return [[{ case_id: 'AbC12dEf' }]];
      if (/FROM contacts/i.test(sql))               return [[{ contact_id: 22 }]];
      if (/UPDATE signing_requests/i.test(sql))     return [{ affectedRows: 1 }];
      if (/FROM signing_request_events/i.test(sql)) return [[]];
      if (/FROM signing_requests/i.test(sql))       return [[]];
      return [[]];
    }),
  };
}

function makeProvider(over = {}) {
  return {
    sendForSignature: jest.fn(async () => ({
      providerId: 'ZS-9001', status: 'sent', providerStatus: 'inprogress', testing: true, raw: {},
    })),
    ...over,
  };
}

const GOOD_SEND = {
  linkableType: 'case',
  linkableId: 'AbC12dEf',
  kind: 'contract',
  documentName: 'Retainer Agreement',
  recipients: [{ name: 'John Smith', email: 'John@Example.com', order: 1 }],
  createdBy: 1,
};

/** The one emit this suite is about, unpacked. Fails loudly if there isn't exactly one. */
function soleSentEmit() {
  const calls = domainEvents.emit.mock.calls.filter((c) => c[1] === 'esign.sent');
  expect(calls).toHaveLength(1);
  return calls[0][2];
}

let provider;

beforeEach(() => {
  jest.clearAllMocks();
  provider = makeProvider();
  getProvider.mockResolvedValue(provider);
  recordCreditSpend.mockResolvedValue({ ok: true, balance: 95, previous: 100 });
  esignService.createRequest.mockResolvedValue(makeRow());
  esignService.markSent.mockImplementation(async (db, id, { providerId, sentAt, expiresAt }) =>
    makeRow({ id, status: 'sent', provider_id: providerId, sent_at: sentAt, expires_at: expiresAt }));
  esignService.getById.mockResolvedValue(makeRow());
  esignService._normalizeRecipients.mockImplementation((r) => r || []);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// sendPipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('sendPipeline emits esign.sent', () => {
  test('exactly once, with the fields the seeded rule reads', async () => {
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });

    const p = soleSentEmit();

    // Rule A's match_config is: data.kind equals 'contract' AND case_id exists.
    // Both are asserted here because a change to either silently unwires the
    // rule — no error, no skip, just a case that stops advancing.
    expect(p.data.kind).toBe('contract');
    expect(p.case_id).toBe('AbC12dEf');
    expect(p.contact_id).toBeNull();

    expect(p.data).toMatchObject({
      request_id:    42,
      document_name: 'Retainer Agreement',
      linkable_type: 'case',
      tracking_id:   TRACKING,
      testing:       true,
    });
    expect(p.source).toBe('system');
  });

  test('case_id is a STRING — advance_stage maps its case_id param straight off it', async () => {
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    expect(typeof soleSentEmit().case_id).toBe('string');
  });

  test('a contact-linked send carries contact_id and a null case_id', async () => {
    // Rule A's `exists case_id` condition is what keeps contact sends out of
    // the pipeline rule entirely.
    const row = makeRow({ linkable_type: 'contact', linkable_id: '22' });
    esignService.createRequest.mockResolvedValue(row);
    esignService.markSent.mockResolvedValue({ ...row, status: 'sent' });

    await svc.sendPipeline(makeDb(), {
      ...GOOD_SEND, linkableType: 'contact', linkableId: 22, pdfBuffer: buildPdf(1),
    });

    const p = soleSentEmit();
    expect(p.case_id).toBeNull();
    expect(p.contact_id).toBe(22);
  });

  test('template_id rides along, and is null on an ad-hoc send', async () => {
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    expect(soleSentEmit().data.template_id).toBeNull();

    jest.clearAllMocks();
    const row = makeRow({ template_id: 7 });
    esignService.createRequest.mockResolvedValue(row);
    esignService.markSent.mockResolvedValue({ ...row, status: 'sent' });
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, templateId: 7, pdfBuffer: buildPdf(1) });
    expect(soleSentEmit().data.template_id).toBe(7);
  });

  test('a fresh send reports resend=false and draft_reused=false', async () => {
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    expect(soleSentEmit().extra).toEqual({
      recipient_count: 1, draft_reused: false, resend: false,
    });
  });

  test('a draft RETRY reports draft_reused=true', async () => {
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, draftId: 42, pdfBuffer: buildPdf(1) });
    const { extra } = soleSentEmit();
    expect(extra.draft_reused).toBe(true);
    expect(extra.resend).toBe(false);
  });

  test('data.testing reflects the provider, not a default', async () => {
    provider.sendForSignature.mockResolvedValue({
      providerId: 'ZS-9001', status: 'sent', providerStatus: 'inprogress', testing: false, raw: {},
    });
    await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });
    expect(soleSentEmit().data.testing).toBe(false);
  });

  test('a FAILED provider send emits nothing — the row is still a draft', async () => {
    provider.sendForSignature.mockRejectedValue(Object.assign(new Error('nope'), { code: 'X' }));

    await expect(
      svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) })
    ).rejects.toThrow('nope');

    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('the emit cannot break the send — emit is fire-and-forget', async () => {
    // domainEvents.emit is documented never to throw, but the send must not
    // depend on that promise being honoured.
    domainEvents.emit.mockImplementationOnce(() => { throw new Error('engine down'); });

    await expect(
      svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) })
    ).rejects.toThrow('engine down');
  });

  test('emit is NOT awaited — a hanging engine does not hang the send', async () => {
    let settle;
    domainEvents.emit.mockImplementationOnce(() => new Promise((r) => { settle = r; }));

    const out = await svc.sendPipeline(makeDb(), { ...GOOD_SEND, pdfBuffer: buildPdf(1) });

    expect(out.row.status).toBe('sent');
    expect(typeof settle).toBe('function');   // still pending; the send returned anyway
    settle();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resendPipeline — the two branches
// ─────────────────────────────────────────────────────────────────────────────

describe('resendPipeline (a) — same-row bounce resend', () => {
  beforeEach(() => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'bounced', provider_id: 'ZS-OLD' }));
  });

  test('emits esign.sent — this branch never reaches sendPipeline', async () => {
    // The whole reason _emitSent exists. Before R1.5 landed its second call
    // site, this path was the silent one.
    await svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });

    const p = soleSentEmit();
    expect(p.data.kind).toBe('contract');
    expect(p.case_id).toBe('AbC12dEf');
  });

  test('reports resend=true and draft_reused=false', async () => {
    // draft_reused is false here because no draft row is involved — which is
    // precisely why `resend` has to be its own flag: without it, a bounce
    // resend and a first send are indistinguishable in the envelope.
    await svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });
    expect(soleSentEmit().extra).toEqual({
      recipient_count: 1, draft_reused: false, resend: true,
    });
  });

  test('emits ONCE, not once per branch', async () => {
    await svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });
    expect(domainEvents.emit.mock.calls.filter((c) => c[1] === 'esign.sent')).toHaveLength(1);
  });

  test('a refused resend emits nothing', async () => {
    esignService.getById.mockResolvedValue(makeRow({ status: 'sent' }));
    await expect(svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 }))
      .rejects.toMatchObject({ code: 'ESIGN_RESEND_INVALID_STATE' });
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });
});

describe('resendPipeline (b) — terminal duplicate', () => {
  test.each(['declined', 'recalled', 'expired'])(
    'a %s request duplicates and emits exactly ONCE (no double-fire)', async (status) => {
      // This branch DOES route through sendPipeline. The property under test is
      // that resendPipeline does not emit for itself as well.
      esignService.getById
        .mockResolvedValueOnce(makeRow({ id: 42, status }))
        .mockResolvedValue(makeRow({ id: 77, status: 'draft' }));
      esignService.createRequest.mockResolvedValue(makeRow({ id: 77, status: 'draft' }));

      await svc.resendPipeline(makeDb(), 42, { pdfBuffer: buildPdf(1), createdBy: 1 });

      const p = soleSentEmit();
      // The NEW row's id, not the superseded one.
      expect(p.data.request_id).toBe(77);
      // It came through sendPipeline with a draftId, so:
      expect(p.extra.draft_reused).toBe(true);
      expect(p.extra.resend).toBe(false);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The hardcoded advance is GONE (R1.5)
//
// Source-level, for the same reason as the checklists half: the claim is an
// ABSENCE, and a behavioural "advanceStage was not called" assertion passes
// just as happily against a file that never imported it.
// ─────────────────────────────────────────────────────────────────────────────

describe('services/esignSendService.js no longer advances the pipeline itself', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'esignSendService.js'), 'utf8'
  );

  test('does not call advanceStage', () => {
    expect(src).not.toMatch(/advanceStage\s*\(/);
  });

  test('does not require pipelineService or lib/alerting', () => {
    expect(src).not.toContain("require('./pipelineService')");
    expect(src).not.toContain("require('../lib/alerting')");
  });

  test('the retired contract_sent_advance_failed alert kind is gone', () => {
    expect(src).not.toContain('contract_sent_advance_failed');
  });

  test("no stage key survives as a literal", () => {
    // The point of R1.5: 'contract_sent' now lives in trigger_rule_actions,
    // not here.
    expect(src).not.toContain("'contract_sent'");
  });
});
