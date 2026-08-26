// tests/documentsRoutes.test.js
//
/**
 * routes/api.documents.js — the ROUTE layer (Documents S3).
 *
 * services/documentService.js has its own suite; this one covers only what the
 * route itself owns, which after S3 is mostly ONE endpoint:
 *
 *   • GET /api/documents/:id/raw — the same-origin byte proxy. Every branch:
 *       - THE SIZE GATE, and that it fires BEFORE any provider call. This is
 *         the whole reason the endpoint is safe to ship: provider.download
 *         returns a fully-buffered Buffer (dropboxService._content does
 *         Buffer.from(await res.arrayBuffer()) — there is no streaming path),
 *         so an ungated /raw on the 343 MB row on record is ~700 MB of
 *         transient heap and a Cloud Run OOM that takes every other in-flight
 *         request on the instance with it. A test that only checked the 413
 *         status would pass against an implementation that downloaded the file
 *         first and then refused it, which is the bug.
 *       - NULL size treated as OVER cap. "We don't know how big this is" is
 *         not a reason to find out by buffering it.
 *       - status 'deleted' → 410, not 404: the row exists and the caller's id
 *         was right, and the UI branches on the difference.
 *       - THE MIME ALLOW-LIST. An SVG served inline from this origin runs
 *         script in this origin, where the staff JWT lives in localStorage.
 *         The list is an allow-list and svg/html/xml must fall through it to
 *         octet-stream + attachment. Pinned as a property over a spread of
 *         extensions, not as three examples.
 *       - Content-Type comes from OUR ext map, never from row.mime (which is
 *         whatever the provider claimed).
 *       - nosniff, private caching, Content-Length, and RFC 5987 filename*.
 *
 *   • The LINK ECHO on both /links verbs. The sync bus's sniff sees the
 *     response body and NEVER the request body, so a detach without
 *     { link_type, link_id } in the response is an announcement with no
 *     address — the case widget that just lost a document keeps showing it.
 *     routes/api.appts.js echoes appt_id on POST /api/appts/cancel for exactly
 *     this reason. These assertions are the producer half of the contract that
 *     tests/ycSync.test.js's docLinkGetter tests consume.
 *
 * DRIVEN OVER REAL HTTP, the tests/portalDocsRoutes.js convention: the module
 * exports only the router, so mounting it in a real express app on an
 * ephemeral port is the honest way to exercise status codes, headers and
 * serialisation. No new dependency (express is a prod dep, fetch is global).
 *
 * MOCKED: services/documentService and services/documentSourceService (this
 * suite is about the route), and lib/auth.jwtOrApiKey (a passthrough that
 * injects req.auth — the real middleware is covered elsewhere; what THIS file
 * asserts is that /raw is mounted behind it at all).
 *
 * Run:
 *   npx jest tests/documentsRoutes.test.js
 */

'use strict';

// credentialCrypto is reached transitively by the real modules the route
// requires; it throws at REQUIRE time without a key.
process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

jest.mock('../services/documentService', () => ({
  getById:       jest.fn(),
  listLinks:     jest.fn(),
  link:          jest.fn(),
  unlink:        jest.fn(),
  update:        jest.fn(),
  list:          jest.fn(),
  setSharedLink: jest.fn(),
  upsertFromEntry: jest.fn(),
}));

jest.mock('../services/documentSourceService', () => ({
  get: jest.fn(),
}));

// The factory may not close over a plain outer variable (jest hoists it), so
// the counter lives on the mock itself and is read back through require().
jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => {
  req.auth = { userId: 9 };
  next();
}));

const express     = require('express');
const documents   = require('../services/documentService');
const sources     = require('../services/documentSourceService');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const router      = require('../routes/api.documents');

const DB = { marker: 'pool' };          // identity-checked, never queried

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = DB; next(); });
app.use(router);

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CAP = 25 * 1024 * 1024;

function docRow(overrides = {}) {
  return {
    id:              7,
    source:          'dropbox',
    external_id:     'id:glkBw_soyGAAAAAAAADg3g',
    name:            'Petition.pdf',
    path:            '/  Law Office/   Cases/Smith/Petition.pdf',
    ext:             'pdf',
    mime:            null,
    size:            1024,
    status:          'active',
    server_modified: new Date('2024-08-14T20:57:32Z'),
    ...overrides,
  };
}

/** A provider stub whose download() records whether it was reached at all. */
function mkProvider({ buffer = Buffer.from('%PDF-1.4 hello') } = {}) {
  const p = {
    download:         jest.fn(async () => ({ buffer, metadata: null })),
    tempViewUrl:      jest.fn(async () => ({ url: 'https://dl.dropbox/x', metadata: null })),
    ensureSharedLink: jest.fn(async () => 'https://www.dropbox.com/s/abc'),
    stat:             jest.fn(),
  };
  sources.get.mockReturnValue(p);
  return p;
}

const raw = (id = 7) => fetch(`${base}/api/documents/${id}/raw`);

// ─────────────────────────────────────────────────────────────────────────────
// /raw — the size gate
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /:id/raw — the size gate', () => {
  test('a file UNDER the cap is served, and the provider is called once', async () => {
    documents.getById.mockResolvedValue(docRow({ size: CAP - 1 }));
    const p = mkProvider();

    const res = await raw();
    expect(res.status).toBe(200);
    expect(p.download).toHaveBeenCalledTimes(1);
    // The route hands the provider the registry's external_id, not a path —
    // the whole move/rename-stability premise of the registry.
    expect(p.download).toHaveBeenCalledWith(DB, 'id:glkBw_soyGAAAAAAAADg3g');
  });

  test('a file OVER the cap is 413 — and the provider is NEVER reached', async () => {
    // The load-bearing half. A 413 produced AFTER buffering 343 MB is the
    // exact outage this gate exists to prevent, and it would pass a
    // status-only assertion.
    documents.getById.mockResolvedValue(docRow({ size: 343 * 1024 * 1024 }));
    const p = mkProvider();

    const res = await raw();
    expect(res.status).toBe(413);
    expect(p.download).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.size).toBe(343 * 1024 * 1024);
    expect(body.cap).toBe(CAP);
    expect(typeof body.message).toBe('string');
  });

  test('exactly AT the cap is allowed; one byte over is not', async () => {
    documents.getById.mockResolvedValue(docRow({ size: CAP }));
    mkProvider();
    expect((await raw()).status).toBe(200);

    documents.getById.mockResolvedValue(docRow({ size: CAP + 1 }));
    mkProvider();
    expect((await raw()).status).toBe(413);
  });

  test('a NULL size is treated as OVER cap, with size:null in the body', async () => {
    // Unknown is not a reason to find out by buffering it blind.
    documents.getById.mockResolvedValue(docRow({ size: null }));
    const p = mkProvider();

    const res = await raw();
    expect(res.status).toBe(413);
    expect(p.download).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.size).toBeNull();
    expect(body.cap).toBe(CAP);
  });

  test('a non-numeric size is treated as unknown, not coerced', async () => {
    documents.getById.mockResolvedValue(docRow({ size: 'lots' }));
    const p = mkProvider();
    const res = await raw();
    expect(res.status).toBe(413);
    expect(p.download).not.toHaveBeenCalled();
    expect((await res.json()).size).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /raw — row state
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /:id/raw — row state', () => {
  test('a missing row is 404', async () => {
    documents.getById.mockResolvedValue(null);
    const p = mkProvider();
    const res = await raw();
    expect(res.status).toBe(404);
    expect(p.download).not.toHaveBeenCalled();
  });

  test("status 'deleted' is 410, NOT 404, and never touches the provider", async () => {
    // 404 means "your id is wrong"; 410 means "the file is gone and we know
    // it". The UI branches on that difference to show a useful message
    // instead of a dead-link error.
    documents.getById.mockResolvedValue(docRow({ status: 'deleted' }));
    const p = mkProvider();

    const res = await raw();
    expect(res.status).toBe(410);
    expect(p.download).not.toHaveBeenCalled();
    expect((await res.json()).message).toMatch(/deleted/i);
  });

  test("status 'missing' is still served — the row is stale, not dead", async () => {
    // 'missing' means the sync could not find it on the last pass. The bytes
    // may well still be there, and refusing to try would be a worse answer
    // than letting the provider say so.
    documents.getById.mockResolvedValue(docRow({ status: 'missing' }));
    const p = mkProvider();
    expect((await raw()).status).toBe(200);
    expect(p.download).toHaveBeenCalled();
  });

  test('a non-numeric :id is 400 before anything else', async () => {
    const res = await fetch(`${base}/api/documents/abc/raw`);
    expect(res.status).toBe(400);
    expect(documents.getById).not.toHaveBeenCalled();
  });

  test('/raw is mounted behind the auth middleware', async () => {
    documents.getById.mockResolvedValue(docRow());
    mkProvider();
    await raw();
    expect(jwtOrApiKey).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /raw — the mime allow-list
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /:id/raw — mime + disposition', () => {
  async function headersFor(ext, extra = {}) {
    documents.getById.mockResolvedValue(docRow({ ext, name: `file.${ext}`, ...extra }));
    mkProvider();
    const res = await raw();
    return {
      status: res.status,
      type:   res.headers.get('content-type'),
      disp:   res.headers.get('content-disposition'),
      nosniff: res.headers.get('x-content-type-options'),
      cache:  res.headers.get('cache-control'),
      length: res.headers.get('content-length'),
    };
  }

  test('the six inline types get their real mime and an inline disposition', async () => {
    const expected = {
      pdf:  'application/pdf',
      png:  'image/png',
      jpg:  'image/jpeg',
      jpeg: 'image/jpeg',
      gif:  'image/gif',
      webp: 'image/webp',
    };
    for (const [ext, mime] of Object.entries(expected)) {
      const h = await headersFor(ext);
      expect(h.status).toBe(200);
      expect(h.type).toBe(mime);
      expect(h.disp.startsWith('inline;')).toBe(true);
    }
  });

  test('SVG is NOT inline — it is a script host on this origin', async () => {
    // An SVG served inline from app.4lsg.com runs in app.4lsg.com, with the
    // staff session's localStorage — which is where the JWT lives. Case files
    // arrive from courts, opposing counsel and clients; this is not
    // theoretical. Called out separately from the loop below because it is the
    // one that looks like an image and is not treated as one.
    const h = await headersFor('svg');
    expect(h.type).toBe('application/octet-stream');
    expect(h.disp.startsWith('attachment;')).toBe(true);
  });

  test('every other extension falls through to octet-stream + attachment', async () => {
    for (const ext of ['html', 'htm', 'xml', 'xhtml', 'txt', 'csv', 'json',
                       'docx', 'xlsx', 'zip', 'exe', 'js', 'tif', '']) {
      const h = await headersFor(ext);
      expect(h.type).toBe('application/octet-stream');
      expect(h.disp.startsWith('attachment;')).toBe(true);
    }
  });

  test('the ext match is case-insensitive', async () => {
    // documentService lowercases ext on write, but a row predating that (or a
    // future provider) must not silently become a download.
    expect((await headersFor('PDF')).type).toBe('application/pdf');
  });

  test('Content-Type comes from the ext map, NEVER from row.mime', async () => {
    // row.mime is whatever the provider claimed. Letting a stored value pick
    // the Content-Type on a same-origin route defeats the allow-list entirely.
    const h = await headersFor('docx', { mime: 'image/svg+xml' });
    expect(h.type).toBe('application/octet-stream');
  });

  test('nosniff, private caching and Content-Length are always set', async () => {
    const h = await headersFor('pdf');
    expect(h.nosniff).toBe('nosniff');
    expect(h.cache).toBe('private, max-age=300');
    expect(Number(h.length)).toBe(Buffer.from('%PDF-1.4 hello').length);
  });

  test('the response body is the provider bytes, unmodified', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]);
    documents.getById.mockResolvedValue(docRow());
    mkProvider({ buffer: bytes });
    const res = await raw();
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /raw — filename encoding
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /:id/raw — Content-Disposition filename', () => {
  async function dispFor(name) {
    documents.getById.mockResolvedValue(docRow({ name }));
    mkProvider();
    return (await raw()).headers.get('content-disposition');
  }

  test('a non-ASCII name gets a scrubbed fallback AND an RFC 5987 filename*', async () => {
    // Case files carry client names. The ASCII parameter is lossy on purpose;
    // filename* is the one modern browsers actually use.
    const disp = await dispFor('Motion — Grünberger.pdf');
    expect(disp).toContain("filename*=UTF-8''");
    expect(disp).toContain(encodeURIComponent('Motion — Grünberger.pdf'));
    expect(disp).toMatch(/filename="Motion _ Gr_nberger\.pdf"/);
  });

  test('quotes and backslashes cannot break out of the quoted-string', async () => {
    const disp = await dispFor('a"b\\c.pdf');
    // Exactly two quote characters in the whole value: the ones we opened and
    // closed the ASCII parameter with.
    expect((disp.match(/"/g) || []).length).toBe(2);
  });

  test('CR/LF in a name cannot reach the header (no response-splitting)', async () => {
    // Node would throw on an invalid header value, so a 200 here IS the
    // assertion: the scrub happened before setHeader saw it.
    documents.getById.mockResolvedValue(docRow({ name: 'a\r\nX-Evil: 1.pdf' }));
    mkProvider();
    const res = await raw();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-evil')).toBeNull();
    expect(res.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
  });

  test('an empty name still produces a valid header', async () => {
    const disp = await dispFor('');
    expect(disp).toContain('filename="document"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /raw — provider failure
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /:id/raw — provider failure', () => {
  test('a provider 4xx passes through via mapErrorStatus', async () => {
    documents.getById.mockResolvedValue(docRow());
    const p = mkProvider();
    p.download.mockRejectedValue(
      Object.assign(new Error('dropbox POST files/download → 409: path/not_found'),
                    { status: 409 }));
    const res = await raw();
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('error');
  });

  test('a provider 5xx becomes 502 — we are the proxy', async () => {
    documents.getById.mockResolvedValue(docRow());
    const p = mkProvider();
    p.download.mockRejectedValue(
      Object.assign(new Error('dropbox blew up'), { status: 503 }));
    expect((await raw()).status).toBe(502);
  });

  test('an unknown source is a 400, not a 500', async () => {
    documents.getById.mockResolvedValue(docRow({ source: 'gdrive' }));
    sources.get.mockImplementation(() => {
      throw new Error("unknown document source 'gdrive'");
    });
    expect((await raw()).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The link echo — the sync bus's only handle on a detach
// ─────────────────────────────────────────────────────────────────────────────

describe('/:id/links — the sync-bus echo', () => {
  test('DELETE echoes { link_type, link_id } alongside removed:true', async () => {
    // Without these two keys the sniff has no address for the target whose
    // document set just changed, and the case widget keeps showing a document
    // that is no longer attached to it.
    documents.unlink.mockResolvedValue(true);

    const res = await fetch(`${base}/api/documents/7/links`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_type: 'case', link_id: 'aB3xY9' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'success', removed: true, link_type: 'case', link_id: 'aB3xY9',
    });
  });

  test('DELETE echoes the id as a STRING even when the caller sent a number', async () => {
    // The bus builds an address by concatenation; a number and a string must
    // not produce two different addresses for one contact.
    documents.unlink.mockResolvedValue(true);
    const res = await fetch(`${base}/api/documents/7/links`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_type: 'contact', link_id: 22 }),
    });
    const body = await res.json();
    expect(body.link_id).toBe('22');
    expect(typeof body.link_id).toBe('string');
  });

  test('a DELETE that removed nothing is 404 and echoes NOTHING', async () => {
    // Fail closed: announcing a detach that did not happen would cost every
    // open widget a refetch for no change.
    documents.unlink.mockResolvedValue(false);
    const res = await fetch(`${base}/api/documents/7/links`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_type: 'case', link_id: 'nope' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.link_type).toBeUndefined();
    expect(body.link_id).toBeUndefined();
  });

  test('POST echoes the SAME two keys, so one bus getter reads both verbs', async () => {
    // `links` alone cannot serve: it lists every target and marks none of them
    // as the one this call touched.
    documents.getById.mockResolvedValue(docRow());
    documents.link.mockResolvedValue({ linked: true, created: true });
    documents.listLinks.mockResolvedValue([
      { id: 1, link_type: 'case', link_id: 'aB3xY9' },
      { id: 2, link_type: 'contact', link_id: '22' },
    ]);

    const res = await fetch(`${base}/api/documents/7/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_type: 'case', link_id: 'aB3xY9' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.link_type).toBe('case');
    expect(body.link_id).toBe('aB3xY9');
    expect(Array.isArray(body.links)).toBe(true);   // unchanged, still returned
  });

  test('a missing link_type / link_id is still a 400 on both verbs', async () => {
    documents.getById.mockResolvedValue(docRow());
    for (const method of ['POST', 'DELETE']) {
      const res = await fetch(`${base}/api/documents/7/links`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link_type: 'case' }),
      });
      expect(res.status).toBe(400);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route ordering — /raw must not be swallowed
// ─────────────────────────────────────────────────────────────────────────────

describe('route table', () => {
  test("'raw' reaches the raw handler and not GET /:id", async () => {
    // Express matches in declaration order and `/api/documents/:id` is
    // declared BEFORE `/api/documents/:id/raw` — different path depth, so no
    // shadowing, but the same class of trap that put /register first.
    documents.getById.mockResolvedValue(docRow());
    mkProvider();
    const res = await raw();
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(documents.listLinks).not.toHaveBeenCalled();   // that is GET /:id's job
  });

  test('GET /:id is unaffected and still returns document + links', async () => {
    documents.getById.mockResolvedValue(docRow());
    documents.listLinks.mockResolvedValue([]);
    const res = await fetch(`${base}/api/documents/7`);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body.document.id).toBe(7);
    expect(body.links).toEqual([]);
  });
});
