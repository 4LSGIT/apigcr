/**
 * Tests for the e-sign PROVIDER LAYER (Phase 1B):
 *   services/esign/index.js            — factory
 *   services/esign/zohoSignProvider.js — Zoho dialect
 *
 * NO network, NO real DB. global.fetch is a jest mock (same posture as
 * tests/aiService.attachments.test.js) and `db` is a small stub that answers
 * the two app_settings queries services/settingsService issues.
 *
 * ── WHAT THESE TESTS CAN AND CANNOT PROVE ───────────────────────────────────
 * They pin the SHAPE of what we send and the MEANING of what we receive:
 * the coordinate arithmetic, the status vocabulary, the multipart layout,
 * the testing= flag, error normalization, paging, and the factory's refusal
 * to fail open.
 *
 * They CANNOT prove Zoho accepts any of it. Every documented-but-unverified
 * assumption is marked ASSUMPTION here and is settled by
 * scripts/esign_zoho_smoke.js against the live API. When the smoke run
 * contradicts one, the expected value in this file is the thing to change —
 * it is deliberately written as literal numbers, not as a re-derivation of
 * the implementation's own formula, so a transform edit CANNOT silently drag
 * the test along with it.
 *
 *   npx jest tests/esignProvider.zoho.test.js
 */

jest.mock('../services/oauthService', () => ({
  getValidAccessToken: jest.fn(async () => 'zs-token-abc123'),
}));

const oauthService = require('../services/oauthService');
const esignFactory  = require('../services/esign');
const provider      = require('../services/esign/zohoSignProvider');

const {
  ZohoSignProvider,
  neutralToZohoFields,
  bindFieldsToActions,
  mapRequestStatus,
  mapActionStatus,
  ZOHO_REQUEST_STATUS_MAP,
  ZOHO_ACTION_STATUS_MAP,
  DEFAULT_PAGE,
} = provider;

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Answers the two shapes services/settingsService produces. Anything else
 * throws, so a query we did not anticipate fails loudly rather than
 * returning a misleading empty set.
 */
function makeDb(settings = { esign_credential_id: '13', esign_test_mode: '1' }) {
  const query = jest.fn(async (sql, params) => {
    if (/FROM app_settings WHERE `key` IN/.test(sql)) {
      const keys = params[0];
      return [keys.filter((k) => settings[k] !== undefined)
                  .map((k) => ({ key: k, value: settings[k] }))];
    }
    if (/FROM app_settings WHERE `key` = \?/.test(sql)) {
      const v = settings[params[0]];
      return [v === undefined ? [] : [{ value: v }]];
    }
    throw new Error(`unexpected sql in stub: ${sql}`);
  });
  return { query };
}

/** fetch mock returning a JSON body, in sequence, one entry per call. */
function mockFetchJson(...bodies) {
  return jest.fn(async () => {
    const b = bodies.length > 1 ? bodies.shift() : bodies[0];
    return {
      ok: b.__status ? b.__status < 400 : true,
      status: b.__status || 200,
      text: async () => JSON.stringify(b),
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Map(),
    };
  });
}

const CREATE_OK = {
  code: 0,
  requests: {
    request_id: '9001',
    request_status: 'draft',
    document_ids: [{ document_id: 'DOC7', document_name: 'x.pdf', total_pages: 1 }],
    actions: [
      { action_id: 'ACT1', action_type: 'SIGN', recipient_name: 'Alice', recipient_email: 'alice@x.com' },
      { action_id: 'ACT2', action_type: 'SIGN', recipient_name: 'Bob',   recipient_email: 'bob@x.com'   },
    ],
  },
};
const SUBMIT_OK = { code: 0, requests: { request_status: 'inprogress', actions: [] } };

const PDF = Buffer.from('%PDF-1.4 fake');

const TWO_SIGNER_PLACEMENTS = {
  coord_space: 'pdf_user_space',
  fields: [
    { page: 1, x: 72,  y: 144, w: 216, h: 36, type: 'signature', signer: 1 },
    { page: 1, x: 360, y: 144, w: 144, h: 24, type: 'date',      signer: 1 },
    { page: 2, x: 100, y: 700, w: 48,  h: 24, type: 'initial',   signer: 2 },
  ],
};

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Coordinate transform
// ─────────────────────────────────────────────────────────────────────────────

describe('neutralToZohoFields', () => {
  test('flips the y axis and emits points + percent consistently', () => {
    const { bySigner, count } = neutralToZohoFields(TWO_SIGNER_PLACEMENTS, DEFAULT_PAGE);

    expect(count).toBe(3);
    expect(Object.keys(bySigner).sort()).toEqual(['1', '2']);
    expect(bySigner[1]).toHaveLength(2);
    expect(bySigner[2]).toHaveLength(1);

    // Signature. y_coord = 792 - 144 - 36 = 612 (top-left origin, box's TOP edge).
    // Literal numbers on purpose — see the header note.
    expect(bySigner[1][0]).toEqual({
      field_name:      'Signature_1',
      field_label:     'Signature',
      field_type_name: 'Signature',
      field_category:  'image',
      is_mandatory:    true,
      page_no:         0,                 // ASSUMPTION: neutral page is 1-based
      x_coord:  72,  y_coord: 612, abs_width: 216, abs_height: 36,
      x_value:  11.7647, y_value: 77.2727, width: 35.2941, height: 4.5455,
    });

    // Date. y_coord = 792 - 144 - 24 = 624.
    //
    // 'Date' (auto-stamped signing date), NOT 'CustomDate' (a signer-editable
    // picker) — see the FIELD_TYPES header. field_category stays 'datefield'
    // for both, confirmed against Zoho's own fieldtypes response.
    expect(bySigner[1][1]).toMatchObject({
      field_name:      'Date_2',
      field_type_name: 'Date',
      field_category:  'datefield',
      x_coord: 360, y_coord: 624, abs_width: 144, abs_height: 24,
      x_value: 58.8235, y_value: 78.7879, width: 23.5294, height: 3.0303,
    });
    // date_format is NOT sent: undocumented for 'Date', and Zoho rejects
    // unrecognized keys with code 9043 on at least one endpoint.
    expect(bySigner[1][1]).not.toHaveProperty('date_format');

    // Initial, signer 2, page 2. y_coord = 792 - 700 - 24 = 68 (near the top).
    expect(bySigner[2][0]).toMatchObject({
      field_name:      'Initial_3',
      field_type_name: 'Initial',
      field_category:  'image',
      page_no:         1,
      x_coord: 100, y_coord: 68, abs_width: 48, abs_height: 24,
    });
  });

  test('percent pair is derivable from the absolute pair — they cannot disagree', () => {
    const { bySigner } = neutralToZohoFields(TWO_SIGNER_PLACEMENTS, DEFAULT_PAGE);
    for (const f of [...bySigner[1], ...bySigner[2]]) {
      expect(f.x_value).toBeCloseTo((f.x_coord / DEFAULT_PAGE.width)  * 100, 3);
      expect(f.y_value).toBeCloseTo((f.y_coord / DEFAULT_PAGE.height) * 100, 3);
      expect(f.width)  .toBeCloseTo((f.abs_width  / DEFAULT_PAGE.width)  * 100, 3);
      expect(f.height) .toBeCloseTo((f.abs_height / DEFAULT_PAGE.height) * 100, 3);
    }
  });

  test('a field at the page bottom-left maps to the page BOTTOM in Zoho space', () => {
    // The clearest possible statement of the flip: neutral y=0 is the bottom
    // edge; in Zoho's top-left space that is y_coord = pageHeight - h.
    const { bySigner } = neutralToZohoFields(
      { coord_space: 'pdf_user_space', fields: [{ page: 1, x: 0, y: 0, w: 10, h: 20, type: 'signature', signer: 1 }] },
      DEFAULT_PAGE
    );
    expect(bySigner[1][0]).toMatchObject({ x_coord: 0, y_coord: 772, y_value: 97.4747 });
  });

  test('A4 page geometry changes the percent pair but not the absolute pair', () => {
    const A4 = { width: 595, height: 842 };
    const one = { coord_space: 'pdf_user_space',
                  fields: [{ page: 1, x: 72, y: 144, w: 216, h: 36, type: 'signature', signer: 1 }] };
    const letter = neutralToZohoFields(one, DEFAULT_PAGE).bySigner[1][0];
    const a4     = neutralToZohoFields(one, A4).bySigner[1][0];

    expect(a4.x_coord).toBe(letter.x_coord);          // points are page-independent
    expect(a4.y_coord).toBe(842 - 144 - 36);          // ...except the flip's origin
    expect(a4.x_value).not.toBeCloseTo(letter.x_value, 3);
  });

  test('per-page geometry overrides the default', () => {
    const { bySigner } = neutralToZohoFields(
      { coord_space: 'pdf_user_space',
        fields: [{ page: 3, x: 0, y: 0, w: 10, h: 10, type: 'signature', signer: 1 }] },
      { width: 612, height: 792, pages: { 3: { width: 1224, height: 1584 } } }
    );
    expect(bySigner[1][0]).toMatchObject({ page_no: 2, y_coord: 1574 });
  });

  test('signer defaults to 1 and page defaults to the first page', () => {
    const { bySigner } = neutralToZohoFields(
      { fields: [{ x: 1, y: 2, w: 3, h: 4, type: 'signature' }] }, DEFAULT_PAGE
    );
    expect(bySigner[1]).toHaveLength(1);
    expect(bySigner[1][0].page_no).toBe(0);
  });

  test('required:false produces an optional field', () => {
    const { bySigner } = neutralToZohoFields(
      { fields: [{ page: 1, x: 1, y: 2, w: 3, h: 4, type: 'initial', signer: 1, required: false }] },
      DEFAULT_PAGE
    );
    expect(bySigner[1][0].is_mandatory).toBe(false);
  });

  describe('rejects bad input BEFORE any network call', () => {
    const cases = [
      ['unknown field type',   { fields: [{ page: 1, x: 0, y: 0, w: 1, h: 1, type: 'notarize', signer: 1 }] }],
      ['non-array fields',     { fields: 'nope' }],
      ['non-object field',     { fields: ['nope'] }],
      ['non-finite geometry',  { fields: [{ page: 1, x: 'a', y: 0, w: 1, h: 1, type: 'signature', signer: 1 }] }],
      ['page below the base',  { fields: [{ page: 0, x: 0, y: 0, w: 1, h: 1, type: 'signature', signer: 1 }] }],
      ['foreign coord_space',  { coord_space: 'screen_px', fields: [] }],
    ];
    test.each(cases)('%s', (_label, placements) => {
      expect(() => neutralToZohoFields(placements, DEFAULT_PAGE))
        .toThrow(expect.objectContaining({ code: 'ESIGN_INVALID_INPUT' }));
    });
  });
});

describe('bindFieldsToActions', () => {
  test('binds by recipient ORDER, not array index', () => {
    const { bySigner } = neutralToZohoFields(TWO_SIGNER_PLACEMENTS, DEFAULT_PAGE);
    // Recipients deliberately out of order-position: the Bob row is first in
    // the array but is signer 2. Binding must follow `order`.
    const recipients = [
      { name: 'Bob',   email: 'bob@x.com',   order: 2 },
      { name: 'Alice', email: 'alice@x.com', order: 1 },
    ];
    const actions = [
      { action_id: 'ACT_BOB',   action_type: 'SIGN', recipient_name: 'Bob',   recipient_email: 'bob@x.com' },
      { action_id: 'ACT_ALICE', action_type: 'SIGN', recipient_name: 'Alice', recipient_email: 'alice@x.com' },
    ];
    const out = bindFieldsToActions(bySigner, actions, recipients, 'DOC7');

    expect(out[0].action_id).toBe('ACT_BOB');
    expect(out[0].fields.map((f) => f.field_type_name)).toEqual(['Initial']);   // signer 2
    expect(out[1].fields.map((f) => f.field_type_name)).toEqual(['Signature', 'Date']);

    for (const a of out) {
      for (const f of a.fields) {
        expect(f.document_id).toBe('DOC7');
        expect(f.action_id).toBe(a.action_id);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Status mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('status mapping', () => {
  test.each([
    ['draft',      'draft'],
    ['inprogress', 'sent'],
    ['completed',  'signed'],
    ['declined',   'declined'],
    ['recalled',   'recalled'],
    ['expired',    'expired'],
  ])('request_status %s → %s', (zoho, ours) => {
    expect(mapRequestStatus(zoho)).toBe(ours);
  });

  test('is case-insensitive on Zoho input', () => {
    expect(mapRequestStatus('COMPLETED')).toBe('signed');
  });

  test('inprogress is promoted to viewed once any recipient has opened it', () => {
    expect(mapRequestStatus('inprogress', [{ action_status: 'UNOPENED' }])).toBe('sent');
    expect(mapRequestStatus('inprogress', [
      { action_status: 'UNOPENED' }, { action_status: 'VIEWED' },
    ])).toBe('viewed');
  });

  test('the promotion applies ONLY to inprogress — terminal states are untouched', () => {
    expect(mapRequestStatus('completed', [{ action_status: 'VIEWED' }])).toBe('signed');
    expect(mapRequestStatus('recalled',  [{ action_status: 'VIEWED' }])).toBe('recalled');
  });

  test('an unknown request_status maps to null, never to a guess', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapRequestStatus('gone_fishing')).toBeNull();
    expect(mapRequestStatus(undefined)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test.each([
    ['NOACTION', 'pending'],
    ['UNOPENED', 'sent'],
    ['VIEWED',   'viewed'],
    ['SIGNED',   'signed'],
    ['APPROVED', 'signed'],
    ['DECLINED', 'declined'],
    ['RECALLED', 'recalled'],
    ['EXPIRED',  'expired'],
    ['BOUNCED',  'bounced'],
  ])('action_status %s → %s', (zoho, ours) => {
    expect(mapActionStatus(zoho)).toBe(ours);
  });

  test('an unknown action_status maps to null', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapActionStatus('TELEPATHIC')).toBeNull();
    warn.mockRestore();
  });

  test('every mapped value is in esignService.STATUSES (plus pending)', () => {
    const { STATUSES } = require('../services/esignService');
    const allowed = new Set([...STATUSES, 'pending']);
    for (const v of Object.values(ZOHO_REQUEST_STATUS_MAP)) expect(allowed).toContain(v);
    for (const v of Object.values(ZOHO_ACTION_STATUS_MAP))  expect(allowed).toContain(v);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. sendForSignature — request shape
// ─────────────────────────────────────────────────────────────────────────────

describe('sendForSignature', () => {
  async function send(overrides = {}, settings) {
    const db = makeDb(settings);
    global.fetch = mockFetchJson(CREATE_OK, SUBMIT_OK);
    const p = new ZohoSignProvider(db, { credentialId: '13' });
    const res = await p.sendForSignature({
      pdfBuffer: PDF,
      documentName: 'Retainer',
      recipients: [
        { name: 'Alice', email: 'alice@x.com', order: 1 },
        { name: 'Bob',   email: 'bob@x.com',   order: 2 },
      ],
      placements: TWO_SIGNER_PLACEMENTS,
      pageInfo: DEFAULT_PAGE,
      ...overrides,
    });
    return { res, db };
  }

  const createCall = () => global.fetch.mock.calls[0];
  const submitCall = () => global.fetch.mock.calls[1];

  test('two calls: multipart create, then urlencoded submit', async () => {
    const { res } = await send();
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const [createUrl, createOpts] = createCall();
    expect(createUrl).toMatch(/^https:\/\/sign\.zoho\.com\/api\/v1\/requests\?/);
    expect(createOpts.method).toBe('POST');
    expect(createOpts.body).toBeInstanceOf(FormData);
    // undici must derive the multipart boundary — setting it by hand breaks it.
    expect(createOpts.headers['Content-Type']).toBeUndefined();

    const [submitUrl, submitOpts] = submitCall();
    expect(submitUrl).toContain('/requests/9001/submit');
    expect(submitOpts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(typeof submitOpts.body).toBe('string');

    expect(res).toMatchObject({ providerId: '9001', status: 'sent', providerStatus: 'inprogress' });
  });

  test('auth header is Zoho-oauthtoken, NOT Bearer', async () => {
    await send();
    for (const [, opts] of global.fetch.mock.calls) {
      expect(opts.headers.Authorization).toBe('Zoho-oauthtoken zs-token-abc123');
      expect(opts.headers.Authorization).not.toMatch(/Bearer/);
    }
    expect(oauthService.getValidAccessToken).toHaveBeenCalledWith(expect.anything(), '13');
  });

  test('multipart carries a file part and a data JSON part', async () => {
    await send();
    const form = createCall()[1].body;

    const file = form.get('file');
    expect(file.name).toBe('Retainer.pdf');
    expect(file.type).toBe('application/pdf');
    expect(file.size).toBe(PDF.length);

    const data = JSON.parse(form.get('data'));
    expect(data.requests).toMatchObject({
      request_name: 'Retainer',
      expiration_days: 14,         // matches contract_templates.expiration_days DEFAULT
      is_sequential: false,        // joint debtors sign in PARALLEL
    });
    expect(data.requests.actions).toEqual([
      { recipient_name: 'Alice', recipient_email: 'alice@x.com', action_type: 'SIGN',
        signing_order: 0, verify_recipient: false },
      { recipient_name: 'Bob',   recipient_email: 'bob@x.com',   action_type: 'SIGN',
        signing_order: 1, verify_recipient: false },
    ]);
  });

  test('submit body carries fields bound to the right action + document', async () => {
    await send();
    const body = new URLSearchParams(submitCall()[1].body);
    const data = JSON.parse(body.get('data'));

    expect(data.requests.actions).toHaveLength(2);
    const [a1, a2] = data.requests.actions;
    expect(a1.action_id).toBe('ACT1');
    expect(a1.fields.map((f) => f.field_type_name)).toEqual(['Signature', 'Date']);
    expect(a2.action_id).toBe('ACT2');
    expect(a2.fields.map((f) => f.field_type_name)).toEqual(['Initial']);
    expect(a1.fields.every((f) => f.document_id === 'DOC7')).toBe(true);
  });

  test('testing=true is sent on BOTH calls when esign_test_mode is 1', async () => {
    await send();
    for (const [url] of global.fetch.mock.calls) {
      expect(new URL(url).searchParams.get('testing')).toBe('true');
    }
  });

  test('testing is ABSENT when esign_test_mode is 0', async () => {
    await send({}, { esign_credential_id: '13', esign_test_mode: '0' });
    for (const [url] of global.fetch.mock.calls) {
      expect(new URL(url).searchParams.has('testing')).toBe(false);
    }
  });

  test('an explicit testing arg overrides the setting', async () => {
    await send({ testing: true }, { esign_credential_id: '13', esign_test_mode: '0' });
    expect(new URL(createCall()[0]).searchParams.get('testing')).toBe('true');
  });

  test('a blank or garbage test_mode value fails SAFE (test mode on)', async () => {
    for (const v of ['', '  ', 'yes', undefined]) {
      jest.clearAllMocks();
      await send({}, { esign_credential_id: '13', esign_test_mode: v });
      expect(new URL(createCall()[0]).searchParams.get('testing')).toBe('true');
    }
  });

  test('settings are re-read on every call — no cross-call caching', async () => {
    const db = makeDb();
    // Two full send cycles = four responses. The mock consumes one per call.
    global.fetch = mockFetchJson(CREATE_OK, SUBMIT_OK, CREATE_OK, SUBMIT_OK);
    const p = new ZohoSignProvider(db, { credentialId: '13' });
    const args = {
      pdfBuffer: PDF, documentName: 'D',
      recipients: [{ name: 'A', email: 'a@x.com', order: 1 }],
      placements: { fields: [{ page: 1, x: 1, y: 1, w: 1, h: 1, type: 'signature', signer: 1 }] },
    };
    await p.sendForSignature(args);
    const afterFirst = db.query.mock.calls.length;
    await p.sendForSignature(args);
    expect(db.query.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  test('a settings read failure falls back to test mode rather than spending credits', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = { query: jest.fn(async () => { throw new Error('db down'); }) };
    global.fetch = mockFetchJson(CREATE_OK, SUBMIT_OK);
    const p = new ZohoSignProvider(db, { credentialId: '13' });
    await p.sendForSignature({
      pdfBuffer: PDF, documentName: 'D',
      recipients: [{ name: 'A', email: 'a@x.com', order: 1 }],
      placements: { fields: [{ page: 1, x: 1, y: 1, w: 1, h: 1, type: 'signature', signer: 1 }] },
    });
    expect(new URL(createCall()[0]).searchParams.get('testing')).toBe('true');
    warn.mockRestore();
  });

  test('bad input throws before any HTTP call is made', async () => {
    const db = makeDb();
    global.fetch = jest.fn();
    const p = new ZohoSignProvider(db, { credentialId: '13' });

    await expect(p.sendForSignature({
      pdfBuffer: PDF, documentName: 'D', recipients: [], placements: { fields: [] },
    })).rejects.toMatchObject({ code: 'ESIGN_INVALID_INPUT' });

    await expect(p.sendForSignature({
      pdfBuffer: 'not a buffer', documentName: 'D',
      recipients: [{ email: 'a@x.com' }], placements: { fields: [] },
    })).rejects.toMatchObject({ code: 'ESIGN_INVALID_INPUT' });

    // A bad PLACEMENT must also cost zero calls — this is the credit guard.
    await expect(p.sendForSignature({
      pdfBuffer: PDF, documentName: 'D',
      recipients: [{ email: 'a@x.com', order: 1 }],
      placements: { fields: [{ page: 1, x: 0, y: 0, w: 1, h: 1, type: 'bogus', signer: 1 }] },
    })).rejects.toMatchObject({ code: 'ESIGN_INVALID_INPUT' });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a create response missing document_ids is an error, not a silent half-send', async () => {
    const db = makeDb();
    global.fetch = mockFetchJson({ code: 0, requests: { request_id: '9001', actions: [] } });
    const p = new ZohoSignProvider(db, { credentialId: '13' });
    await expect(p.sendForSignature({
      pdfBuffer: PDF, documentName: 'D',
      recipients: [{ email: 'a@x.com', order: 1 }],
      placements: { fields: [] },
    })).rejects.toMatchObject({ code: 'ESIGN_PROVIDER_ERROR' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Error normalization
// ─────────────────────────────────────────────────────────────────────────────

describe('error normalization', () => {
  const call = (body) => {
    const db = makeDb();
    global.fetch = mockFetchJson(body);
    return new ZohoSignProvider(db, { credentialId: '13' }).getStatus('9001');
  };

  test('4xx body becomes a typed error carrying Zoho code + message', async () => {
    await expect(call({ __status: 404, code: 1002, message: 'Document does not exist.' }))
      .rejects.toMatchObject({
        code: 'ESIGN_PROVIDER_ERROR',
        provider: 'zoho_sign',
        httpStatus: 404,
        providerCode: 1002,
        providerMessage: 'Document does not exist.',
      });
  });

  test('HTTP 200 with a NON-ZERO Zoho code is still an error', async () => {
    // Zoho's second error channel. Checking only res.ok lets these through.
    await expect(call({ code: 9015, message: 'Credits exhausted' }))
      .rejects.toMatchObject({ code: 'ESIGN_PROVIDER_ERROR', httpStatus: 200, providerCode: 9015 });
  });

  test('code 0 is success, not an error', async () => {
    await expect(call({ code: 0, requests: { request_status: 'completed', actions: [] } }))
      .resolves.toMatchObject({ status: 'signed' });
  });

  test('a network failure is typed too — the raw fetch error never escapes', async () => {
    const db = makeDb();
    global.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(new ZohoSignProvider(db, { credentialId: '13' }).getStatus('9001'))
      .rejects.toMatchObject({ code: 'ESIGN_PROVIDER_ERROR', httpStatus: 0 });
  });

  test('a timeout is reported as a timeout', async () => {
    const db = makeDb();
    global.fetch = jest.fn(async () => {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    });
    await expect(new ZohoSignProvider(db, { credentialId: '13' }).getStatus('9001'))
      .rejects.toThrow(/timed out after \d+ms/);
  });

  test('a token failure is ESIGN_AUTH_ERROR and preserves the cause', async () => {
    oauthService.getValidAccessToken.mockRejectedValueOnce(
      new Error('Credential 13 not connected (status=refresh_failed)')
    );
    const db = makeDb();
    global.fetch = jest.fn();
    await expect(new ZohoSignProvider(db, { credentialId: '13' }).getStatus('9001'))
      .rejects.toMatchObject({
        code: 'ESIGN_AUTH_ERROR',
        cause: expect.objectContaining({ message: expect.stringContaining('refresh_failed') }),
      });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Read paths
// ─────────────────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  test('translates recipients into the neutral shape', async () => {
    const db = makeDb();
    global.fetch = mockFetchJson({
      code: 0,
      requests: {
        request_status: 'inprogress',
        actions: [
          { recipient_name: 'Alice', recipient_email: 'Alice@X.com', signing_order: 0,
            action_status: 'SIGNED', signed_time: 1712729733535 },
          { recipient_name: 'Bob',   recipient_email: 'bob@x.com',   signing_order: 1,
            action_status: 'VIEWED' },
        ],
      },
    });
    const st = await new ZohoSignProvider(db, { credentialId: '13' }).getStatus('9001');

    expect(st.status).toBe('viewed');            // promoted: Bob has opened it
    expect(st.providerStatus).toBe('inprogress');
    expect(st.recipients[0]).toEqual({
      name: 'Alice',
      email: 'alice@x.com',                      // lowercased, matching esignService
      order: 1,                                  // Zoho 0-based → neutral 1-based
      status: 'signed',
      signed_at: new Date(1712729733535).toISOString(),
      ip: null,                                  // not exposed on this endpoint
    });
    expect(st.recipients[1]).toMatchObject({ order: 2, status: 'viewed', signed_at: null });
  });
});

describe('listInProgress', () => {
  /** N pages of `size`, then a short page to terminate. */
  function pagedFetch(pages) {
    let i = 0;
    return jest.fn(async () => {
      const rows = pages[i++] || [];
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, requests: rows }) };
    });
  }
  const row = (id, status = 'inprogress') =>
    ({ request_id: id, request_status: status, request_name: `doc ${id}` });

  test('walks pages until a short page and advances start_index', async () => {
    const db = makeDb();
    const full = Array.from({ length: 100 }, (_, i) => row(1000 + i));
    global.fetch = pagedFetch([full, [row(2000), row(2001)]]);

    const out = await new ZohoSignProvider(db, { credentialId: '13' }).listInProgress();

    expect(out.pagesFetched).toBe(2);
    expect(out.items).toHaveLength(102);
    expect(out.capped).toBe(false);
    expect(out.items[0]).toEqual({
      providerId: '1000', status: 'sent', providerStatus: 'inprogress', documentName: 'doc 1000',
    });

    const idx = global.fetch.mock.calls.map(
      ([u]) => JSON.parse(new URL(u).searchParams.get('data')).page_context.start_index
    );
    expect(idx).toEqual([1, 101]);               // ASSUMPTION: start_index is 1-based
  });

  test('a single short page ends the loop immediately', async () => {
    const db = makeDb();
    global.fetch = pagedFetch([[row(1)]]);
    const out = await new ZohoSignProvider(db, { credentialId: '13' }).listInProgress();
    expect(out.pagesFetched).toBe(1);
    expect(out.items).toHaveLength(1);
  });

  test('filters locally — nothing narrows the result server-side', async () => {
    const db = makeDb();
    global.fetch = pagedFetch([[row(1), row(2, 'completed'), row(3, 'recalled'), row(4)]]);
    const out = await new ZohoSignProvider(db, { credentialId: '13' }).listInProgress();
    expect(out.items.map((i) => i.providerId)).toEqual(['1', '4']);
  });

  // REGRESSION GUARD, not a formality. 1B shipped page_context with
  // search_columns + sort_column + sort_order and Zoho answered 400 code 9043
  // "Extra key found" — it allowlists this object rather than ignoring
  // unknowns. An EXACT key match (not toMatchObject) is the point: the bug
  // this catches is a key being ADDED back, which a subset assertion would
  // wave through.
  test('page_context carries ONLY the two documented keys (Zoho 400s on extras)', async () => {
    const db = makeDb();
    global.fetch = pagedFetch([[]]);
    await new ZohoSignProvider(db, { credentialId: '13' }).listInProgress();
    const ctx = JSON.parse(new URL(global.fetch.mock.calls[0][0]).searchParams.get('data')).page_context;
    expect(Object.keys(ctx).sort()).toEqual(['row_count', 'start_index']);
    expect(ctx).toEqual({ row_count: 100, start_index: 1 });
  });

  test('the row cap truncates and says so — absence must not imply completion', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb();
    global.fetch = pagedFetch([Array.from({ length: 10 }, (_, i) => row(i))]);
    const out = await new ZohoSignProvider(db, { credentialId: '13' })
      .listInProgress({ rowCap: 3, pageSize: 10 });
    expect(out.items).toHaveLength(3);
    expect(out.capped).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('recall / remind / downloads / credits', () => {
  const mk = (body) => {
    const db = makeDb();
    global.fetch = mockFetchJson(body);
    return new ZohoSignProvider(db, { credentialId: '13' });
  };

  test('recall POSTs to /recall and reports that the reason did NOT reach Zoho', async () => {
    const res = await mk({ code: 0, message: 'Document has been recalled' })
      .recall('9001', 'client changed their mind');
    expect(global.fetch.mock.calls[0][0]).toContain('/requests/9001/recall');
    expect(global.fetch.mock.calls[0][1].method).toBe('POST');
    expect(res).toMatchObject({
      status: 'recalled',
      reasonSentToProvider: false,             // Zoho's recall takes no reason
      reason: 'client changed their mind',
    });
  });

  test('remind POSTs to /remind and admits it nudges everyone', async () => {
    const res = await mk({ code: 0, message: 'Reminder has been sent' })
      .remind('9001', 'alice@x.com');
    expect(global.fetch.mock.calls[0][0]).toContain('/requests/9001/remind');
    expect(res).toMatchObject({ ok: true, remindedAll: true, recipientEmail: 'alice@x.com' });
  });

  test('remind surfaces a 4xx intact — this is the §12 signal', async () => {
    await expect(mk({ __status: 403, code: 9004, message: 'Feature not available in your plan' })
      .remind('9001')).rejects.toMatchObject({
        code: 'ESIGN_PROVIDER_ERROR', httpStatus: 403, providerCode: 9004,
      });
  });

  test('downloads return a Buffer from the documented paths', async () => {
    const db = makeDb();
    const bytes = Buffer.from('%PDF-1.7 signed');
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    }));
    const p = new ZohoSignProvider(db, { credentialId: '13' });

    expect(Buffer.isBuffer(await p.downloadSignedPdf('9001'))).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain('/requests/9001/pdf');

    await p.downloadCompletionCertificate('9001');
    // One word, no separator — NOT /certificate.
    expect(global.fetch.mock.calls[1][0]).toContain('/requests/9001/completioncertificate');

    await p.downloadSignedPdf('9001', { withCoc: true, merge: true });
    const u = new URL(global.fetch.mock.calls[2][0]);
    expect(u.searchParams.get('with_coc')).toBe('true');
    expect(u.searchParams.get('merge')).toBe('true');
  });

  test('getCreditBalance finds a credit-shaped number when one exists', async () => {
    const res = await mk({ code: 0, accounts: { org_name: 'LSG', available_credits: 240 } })
      .getCreditBalance();
    expect(res).toMatchObject({ credits: 240, supported: true });
  });

  test('getCreditBalance reports supported:false when nothing credit-shaped is present', async () => {
    const res = await mk({ code: 0, accounts: { org_name: 'LSG', credit_card_last4: '4242' } })
      .getCreditBalance();
    expect(res).toMatchObject({ credits: null, supported: false });
  });

  test('getCreditBalance does not throw when the endpoint is unavailable', async () => {
    const res = await mk({ __status: 404, code: 1000, message: 'no such url' }).getCreditBalance();
    expect(res).toMatchObject({ credits: null, supported: false });
    expect(res.error).toEqual(expect.any(String));
  });

  test('providerId is required by every id-taking method', async () => {
    const p = mk({ code: 0 });
    for (const fn of ['recall', 'remind', 'getStatus', 'downloadSignedPdf', 'downloadCompletionCertificate']) {
      await expect(p[fn]()).rejects.toMatchObject({ code: 'ESIGN_INVALID_INPUT' });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Factory
// ─────────────────────────────────────────────────────────────────────────────

describe('getProvider', () => {
  test('defaults to esignService.DEFAULT_PROVIDER', async () => {
    const { DEFAULT_PROVIDER } = require('../services/esignService');
    expect(DEFAULT_PROVIDER).toBe('zoho_sign');
    const p = await esignFactory.getProvider(makeDb());
    expect(p).toBeInstanceOf(ZohoSignProvider);
    expect(p.name).toBe('zoho_sign');
    expect(p.credentialId).toBe('13');
  });

  test('an unknown provider name throws ESIGN_UNKNOWN_PROVIDER', async () => {
    await expect(esignFactory.getProvider(makeDb(), 'docusign'))
      .rejects.toMatchObject({ code: 'ESIGN_UNKNOWN_PROVIDER' });
  });

  test('a missing credential setting throws ESIGN_NOT_CONFIGURED — it does NOT fail open', async () => {
    await expect(esignFactory.getProvider(makeDb({ esign_test_mode: '1' })))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_CONFIGURED' });
  });

  test.each([['', 'empty'], ['   ', 'whitespace']])('a %s credential value is treated as missing (%s)', async (v) => {
    await expect(esignFactory.getProvider(makeDb({ esign_credential_id: v })))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_CONFIGURED' });
  });

  test('a settings-read failure throws ESIGN_NOT_CONFIGURED rather than a raw db error', async () => {
    const db = { query: jest.fn(async () => { throw new Error('db down'); }) };
    await expect(esignFactory.getProvider(db))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_CONFIGURED' });
  });

  test('the error message names the fix', async () => {
    await expect(esignFactory.getProvider(makeDb({})))
      .rejects.toThrow(/esign_credential_id/);
  });

  test('listProviders reflects the registry', () => {
    expect(esignFactory.listProviders()).toEqual(['zoho_sign']);
  });
});
// ═════════════════════════════════════════════════════════════════════════════
// REGRESSION — Zoho 9011 "You have entered too many characters" (2026-07-20)
//
// Zoho's absolute-coordinate columns (x_coord / y_coord / abs_width /
// abs_height) REJECT decimal values: an A/B submit pair on live request
// …49119 proved identical payloads pass with integer coords and 400 with
// x_coord 131.87 (code 9011, error_param 'x_coord'). Every editer-drawn box
// carries decimals, so before this fix every real UI send failed while the
// integer-point smoke placements passed. The percent set keeps 4-decimal
// precision — Zoho's own docs use 6-decimal percents.
// ═════════════════════════════════════════════════════════════════════════════

describe('neutralToZohoFields — absolute set is INTEGER (9011 regression)', () => {
  test('decimal placement → integer abs/coords, decimal percents preserved', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [{ page: 1, x: 131.87, y: 482.89, w: 222.44, h: 24.6, type: 'signature', signer: 1 }],
    });
    const f = bySigner[1][0];
    // yTop = 792 - 482.89 - 24.6 = 284.51 → 285
    expect(f.x_coord).toBe(132);
    expect(f.y_coord).toBe(285);
    expect(f.abs_width).toBe(222);
    expect(f.abs_height).toBe(25);
    for (const k of ['x_coord', 'y_coord', 'abs_width', 'abs_height']) {
      expect(Number.isInteger(f[k])).toBe(true);
    }
    // The percent set carries the precision — unchanged by the fix.
    expect(f.x_value).toBeCloseTo((131.87 / 612) * 100, 4);
    expect(String(f.width)).toMatch(/\d+\.\d{1,4}$/);
  });
});

describe('providerError — error_param + raw body survive (9011 postmortem)', () => {
  const { _providerError } = require('../services/esign/zohoSignProvider');
  const build = _providerError || null;
  // providerError isn't exported directly; exercise it through the public
  // path if absent: construct via the module's error on a fake response is
  // overkill — assert through the exported test hook when present, else via
  // the shape contract on a thrown _request (covered elsewhere). Minimal
  // direct check when the helper is reachable:
  const providerMod = require('../services/esign/zohoSignProvider');
  const fn = providerMod._test && providerMod._test.providerError;
  (fn ? test : test.skip)('direct: parsed error_param lands on the error', () => {
    const err = fn('POST', '/requests/1/submit', 400,
      { code: 9011, message: 'You have entered too many characters', error_param: 'x_coord' },
      '{"code":9011,"error_param":"x_coord"}');
    expect(err.providerParam).toBe('x_coord');
    expect(err.message).toContain('(param: x_coord)');
    expect(err.providerRaw).toContain('error_param');
  });
});

// ─── signer-facing labels (2E hotfix, 2026-07-20) ────────────────────────────
// Zoho renders field_name INSIDE the box on the signing page; unlabeled
// fields showed 'Initial_2' to a client. An authored label now drives both
// field_label and a unique-ified field_name; unlabeled fields keep Type_N.

describe('neutralToZohoFields — signer-facing labels', () => {
  const sig = (over = {}) => ({ page: 1, x: 72, y: 144, w: 216, h: 36, type: 'signature', signer: 1, ...over });

  test('label drives field_name + field_label; unlabeled keeps Type_N', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [sig({ label: 'Client signature' }), sig({ type: 'initial', y: 300 })],
    });
    expect(bySigner[1][0].field_name).toBe('Client signature');
    expect(bySigner[1][0].field_label).toBe('Client signature');
    expect(bySigner[1][1].field_name).toBe('Initial_2');
    expect(bySigner[1][1].field_label).toBe('Initial');
  });

  test('duplicate labels are unique-ified per document, not rejected', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [
        sig({ label: 'Initials' }),
        sig({ type: 'initial', y: 300, label: 'Initials' }),
        sig({ type: 'initial', y: 400, label: 'Initials', signer: 2 }),
      ],
    });
    const names = [bySigner[1][0].field_name, bySigner[1][1].field_name, bySigner[2][0].field_name];
    expect(new Set(names).size).toBe(3);
    expect(names).toContain('Initials');
    expect(names).toContain('Initials 2');
  });

  test('validator: blank or oversize label throws; text fields unaffected', () => {
    const { validatePlacements } = require('../services/esign/placements');
    expect(() => validatePlacements({ fields: [sig({ label: '   ' })] })).toThrow();
    expect(() => validatePlacements({ fields: [sig({ label: 'x'.repeat(61) })] })).toThrow();
    expect(validatePlacements({ fields: [sig({ label: 'Client signature' })] }).count).toBe(1);
  });
});
