// tests/documentsGenerate.routes.test.js
//
/**
 * G2 — routes/api.documents.js :: POST /api/documents/generate
 *
 * A thin boundary, so the tests are about the three things a boundary owns and
 * nothing else:
 *
 *   1. SNAKE → CAMEL. The wire is snake_case and the service takes camelCase.
 *      A silently-dropped key here is a document generated without the values
 *      the caller sent, which looks like success.
 *   2. THE ACTING USER. This file's rule is req.auth.userId or NULL — it does
 *      NOT invent a 0 the way api.esign.actions.js does, because an API-key
 *      caller legitimately has no user. Asserted both ways.
 *   3. CODE → STATUS. The service throws the shared ESIGN_* vocabulary; this
 *      file has no code→status switch to extend, so the generate route carries
 *      its own map. Every code in it is exercised, plus the uncoded default.
 *
 * Also asserted: DECLARATION ORDER. '/api/documents/generate' and
 * '/api/documents/:id' are both two segments and Express matches in declaration
 * order — if ':id' ever moves above this route, "generate" arrives as an id,
 * fails docId()'s integer parse, and the endpoint 400s with "Invalid id". That
 * is a silent, total break with a misleading message, so it gets a test.
 *
 * DRIVEN OVER REAL HTTP (tests/documentsUpload.routes.test.js convention).
 *
 *   npx jest tests/documentsGenerate.routes.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');
process.env.JWT_SECRET = 'test-secret-for-generate-routes';

jest.mock('../services/documentGenerateService', () => ({
  generateFromTemplate: jest.fn(),
}));

// Everything else the router pulls in, stubbed to nothing — this suite touches
// one endpoint and must not drag the registry or the sync engine along.
jest.mock('../services/documentService', () => ({
  getById: jest.fn(), listLinks: jest.fn(), link: jest.fn(), unlink: jest.fn(),
  update: jest.fn(), list: jest.fn(), setSharedLink: jest.fn(),
  upsertFromEntry: jest.fn(),
}));
jest.mock('../services/documentSourceService', () => ({ get: jest.fn() }));
jest.mock('../services/documentSyncService', () => ({}));
jest.mock('../services/documentIngestService', () => ({ registerWritten: jest.fn() }));
jest.mock('../services/dropboxService', () => ({ getTemporaryUploadLink: jest.fn() }));
jest.mock('../services/uploadTargetService', () => ({
  issueClientUploadLink: jest.fn(), unsortedBasePath: jest.fn(),
}));

// `mock`-prefixed on purpose: jest hoists mock factories above every other
// statement in the file, and only names matching /^mock/i may be referenced
// from inside one. Reassigned per-test to swap the caller's identity.
let mockAuth = { userId: 9 };
jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => {
  req.auth = mockAuth;
  next();
}));

const express  = require('express');
const generate = require('../services/documentGenerateService');
const router   = require('../routes/api.documents');

const DB = { query: async () => [[]] };

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = DB; next(); });
app.use(router);

let server, base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const VERDICT = {
  path: '/Clients/Smith, John/Notices/2026-09-01 Discharge Notice – Smith.pdf',
  file_name: '2026-09-01 Discharge Notice – Smith.pdf',
  placement: 'case',
  placement_note: null,
  temp_link: 'https://dl/x',
  temp_link_expires_note: 'Dropbox temporary link — expires ~4 hours after creation',
  warnings: [],
  credential_id: 8,
  document_id: 909,
  template_id: 8,
  template_name: 'Discharge Notice',
  document_name: 'Discharge Notice – Smith',
  link_type: 'case',
  link_id: 'AbC12dEf',
  missing_optional: [],
};

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const generatePost = (body) => post('/api/documents/generate', body);

/** Make the service reject with a coded error. */
function rejectWith(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  generate.generateFromTemplate.mockRejectedValue(err);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { userId: 9 };
  generate.generateFromTemplate.mockResolvedValue(VERDICT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. HAPPY PATH + MAPPING
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/documents/generate', () => {
  test('200 with the verdict in this file\'s envelope', async () => {
    const res = await generatePost({
      template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body).toMatchObject({
      path: VERDICT.path,
      file_name: VERDICT.file_name,
      placement: 'case',
      temp_link: 'https://dl/x',
      document_id: 909,
      template_id: 8,
      template_name: 'Discharge Notice',
      document_name: 'Discharge Notice – Smith',
      link_type: 'case',
      link_id: 'AbC12dEf',
    });
  });

  test('every snake_case key reaches the service as camelCase', async () => {
    await generatePost({
      template_id: 8,
      linkable_type: 'contact',
      linkable_id: '1001',
      values: { fee: '1500' },
      document_name: 'Fee Notice',
    });

    expect(generate.generateFromTemplate).toHaveBeenCalledWith(DB, {
      templateId: 8,
      linkableType: 'contact',
      linkableId: '1001',
      values: { fee: '1500' },
      documentName: 'Fee Notice',
      createdBy: 9,
    });
  });

  test('absent optional keys arrive as null, not undefined', async () => {
    await generatePost({ template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf' });
    const arg = generate.generateFromTemplate.mock.calls[0][1];
    expect(arg.values).toBeNull();
    expect(arg.documentName).toBeNull();
  });

  test('an empty body does not crash the route — the service owns validation', async () => {
    rejectWith('ESIGN_BAD_TEMPLATE', 'template_id must be a positive integer (got undefined).');
    const res = await generatePost({});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ESIGN_BAD_TEMPLATE');
  });

  test('a completely missing body is handled', async () => {
    rejectWith('ESIGN_BAD_TEMPLATE', 'template_id must be a positive integer (got undefined).');
    const res = await fetch(`${base}/api/documents/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ACTING USER
// ─────────────────────────────────────────────────────────────────────────────

describe('createdBy', () => {
  test('comes from the JWT', async () => {
    mockAuth = { userId: 42 };
    await generatePost({ template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf' });
    expect(generate.generateFromTemplate.mock.calls[0][1].createdBy).toBe(42);
  });

  test('a numeric-string userId is coerced', async () => {
    mockAuth = { userId: '42' };
    await generatePost({ template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf' });
    expect(generate.generateFromTemplate.mock.calls[0][1].createdBy).toBe(42);
  });

  test('an API-key caller gets NULL, not an invented 0', async () => {
    // This file's documented rule (see actingUserId): API-key callers have no
    // user and we do not make one up. Deliberately different from
    // api.esign.actions.js's resolveCreatedBy, which falls back to 0.
    mockAuth = {};
    await generatePost({ template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf' });
    expect(generate.generateFromTemplate.mock.calls[0][1].createdBy).toBeNull();
  });

  test('the route is behind jwtOrApiKey', async () => {
    // The middleware is what PUTS req.auth there, so a request has to actually
    // run — beforeEach's clearAllMocks resets the call count every test.
    const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
    await generatePost({ template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf' });
    expect(jwtOrApiKey).toHaveBeenCalled();

    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../routes/api.documents'), 'utf8');
    expect(src).toContain("router.post('/api/documents/generate', jwtOrApiKey,");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CODE → STATUS
// ─────────────────────────────────────────────────────────────────────────────

describe('error mapping', () => {
  test.each([
    // caller got the input wrong
    ['ESIGN_MISSING_PREFILL',    400, 'Required value(s) are still empty: fee.'],
    ['ESIGN_BAD_LINKABLE',       400, 'No case or contact was selected.'],
    ['ESIGN_BAD_TEMPLATE',       400, 'template_id must be a positive integer (got "x").'],
    ['ESIGN_BAD_PREFILL_SCHEMA', 400, 'prefill_schema must be an array.'],
    // right template, wrong id
    ['ESIGN_NOT_FOUND',          404, 'Template 99 not found.'],
    // right template, wrong state or wrong picker
    ['ESIGN_TEMPLATE_INACTIVE',  409, 'Template "X" is inactive and cannot be used.'],
    ['ESIGN_TEMPLATE_PURPOSE',   409, 'Template "X" is a signature-only template.'],
    ['ESIGN_TEMPLATE_NO_PDF',    409, 'Template "X" has no source PDF attached yet.'],
  ])('%s → %i', async (code, status, message) => {
    rejectWith(code, message);

    const res = await generatePost({
      template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf',
    });

    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.code).toBe(code);
    expect(body.message).toBe(message);
  });

  test('ESIGN_MISSING_PREFILL forwards `missing` — the one thing a caller can act on', async () => {
    rejectWith('ESIGN_MISSING_PREFILL',
      'Required value(s) are still empty: fee, trustee. Fill them in and send again.',
      { missing: ['fee', 'trustee'] });

    const res = await generatePost({
      template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).missing).toEqual(['fee', 'trustee']);
  });

  test('`missing` is omitted when the error does not carry one', async () => {
    rejectWith('ESIGN_NOT_FOUND', 'Template 99 not found.');
    const res = await generatePost({
      template_id: 99, linkable_type: 'case', linkable_id: 'AbC12dEf',
    });
    expect(Object.prototype.hasOwnProperty.call(await res.json(), 'missing')).toBe(false);
  });

  test('an UNKNOWN code is a 500 rather than a guessed 4xx', async () => {
    rejectWith('SOMETHING_NEW', 'the renderer exploded');
    const res = await generatePost({
      template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf',
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('SOMETHING_NEW');
    // A coded error's message is still shown — it came from our own vocabulary.
    expect(body.message).toBe('the renderer exploded');
  });

  test('an UNCODED error is a 500 whose message does not leak internals', async () => {
    generate.generateFromTemplate.mockRejectedValue(new Error('ECONNREFUSED 10.1.2.3:3306'));

    const res = await generatePost({
      template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf',
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('DOC_GENERATE_ERROR');
    expect(body.message).toBe('Something went wrong generating this document.');
    expect(body.message).not.toContain('ECONNREFUSED');
  });

  test('a render failure surfaces as a 500 — the caller cannot fix chromium', async () => {
    rejectWith('ESIGN_RENDER_FAILED', 'chromium exited before the PDF was produced');
    const res = await generatePost({
      template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf',
    });
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DECLARATION ORDER
// ─────────────────────────────────────────────────────────────────────────────

describe('route declaration order', () => {
  test('"generate" is not swallowed by GET /api/documents/:id', async () => {
    // Both are two segments after the prefix. If ':id' were declared first,
    // this POST would still reach the generate handler (different verb), but a
    // future POST '/api/documents/:id' would not — so assert the source order
    // directly rather than relying on a verb accident.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../routes/api.documents'), 'utf8');
    const generateAt = src.indexOf("router.post('/api/documents/generate'");
    const idAt = src.indexOf("router.get('/api/documents/:id'");
    expect(generateAt).toBeGreaterThan(-1);
    expect(idAt).toBeGreaterThan(-1);
    expect(generateAt).toBeLessThan(idAt);
  });

  test('the endpoint answers, i.e. it is actually mounted', async () => {
    const res = await generatePost({
      template_id: 8, linkable_type: 'case', linkable_id: 'AbC12dEf',
    });
    expect(res.status).not.toBe(404);
    expect(generate.generateFromTemplate).toHaveBeenCalled();
  });

  test('the service is required lazily, so the router loads without it', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../routes/api.documents'), 'utf8');
    // Same deferred-require convention every other heavy dependency in this
    // file uses — the router must not pull chromium's neighbours in at mount.
    expect(src).toContain("require('../services/documentGenerateService')");
    expect(src.indexOf("require('../services/documentGenerateService')"))
      .toBeGreaterThan(src.indexOf("router.post('/api/documents/generate'"));
  });
});
