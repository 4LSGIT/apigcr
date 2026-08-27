// tests/documentsUpload.routes.test.js
//
/**
 * routes/api.documents.js — the STAFF UPLOAD pair (Documents S4)
 * plus lib/uploadTicket.js, which only exists to serve it.
 *
 *   POST /api/documents/upload-link    issue a destination + a signed ticket
 *   POST /api/documents/upload-commit  register what actually landed
 *
 * ── WHY THIS PAIR NEEDS ITS OWN SECURITY TESTS ──────────────────────────────
 * /upload-commit REGISTERS A FILE AND LINKS IT TO A CASE. If the case id came
 * out of the request body unauthenticated, this would be a "put any file on any
 * case" verb wearing an upload's clothes — and quietly a second, undocumented
 * POST /api/documents/register with attribution bolted on. Every test in the
 * `laundering` block below is about that endpoint refusing to be that.
 *
 * Three distinct guards, and each is tested SEPARATELY because each catches a
 * different attack and a passing test on one proves nothing about the others:
 *
 *   1. THE MAC       an unsigned/edited/expired ticket is refused outright, so
 *                    the context cannot be authored by the caller.
 *   2. THE PARENT    even with a VALID ticket, the committed file must be in
 *      CHECK         the folder that ticket named. Without this, a legitimate
 *                    ticket for case A could be replayed against a file sitting
 *                    in case B's folder — the ticket proves we chose a
 *                    destination, not that this file went there.
 *   3. THE STAT      the file's identity and path come from Dropbox, never
 *                    from the request. The client supplies only an id to look
 *                    up, and every claim it implies is re-derived.
 *
 * ── AND WHY external_id IS PREFERRED OVER THE ISSUED PATH ───────────────────
 * Every Dropbox upload here commits with `autorename:true`. A second
 * "statement.pdf" lands as "statement (1).pdf", which means THE PATH WE ISSUED
 * NOW NAMES A DIFFERENT, PRE-EXISTING FILE. Committing by path would register
 * that other document against this case, silently and plausibly. There is a
 * test for exactly that below and it is the most important one in the file.
 *
 * DRIVEN OVER REAL HTTP (tests/documentsRoutes.test.js convention).
 * MOCKED: the ingest service, the source registry, dropboxService,
 * uploadTargetService, and auth. The relation decision has its own suite in
 * tests/documentIngest.s4.test.js; what THIS file owns is the wiring.
 *
 * Run:
 *   npx jest tests/documentsUpload.routes.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');
process.env.JWT_SECRET = 'test-secret-for-upload-tickets';

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
  issueClientUploadLink: jest.fn(),
  unsortedBasePath:      jest.fn(),
}));
jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => {
  req.auth = { userId: 9 };
  next();
}));

const express      = require('express');
const sources      = require('../services/documentSourceService');
const ingest       = require('../services/documentIngestService');
const dropbox      = require('../services/dropboxService');
const uploadTarget = require('../services/uploadTargetService');
const tickets      = require('../lib/uploadTicket');
const router       = require('../routes/api.documents');

const CASE_FOLDER = '/  law office/   cases/ smith - c1';
const UNSORTED    = '/  Law Office/   Cases/  Unsorted Client Uploads';

let dbRows = [];                                // what `SELECT … FROM cases` returns
const DB = { query: async () => [dbRows] };

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = DB; next(); });
app.use(router);

let server, base;
beforeAll(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(r => server.close(r)); });

beforeEach(() => {
  jest.clearAllMocks();
  dbRows = [{ case_id: 'C1', case_dropbox: 'https://www.dropbox.com/s/case1' }];
  dropbox.getTemporaryUploadLink.mockResolvedValue({
    link: 'https://content.dropboxapi.com/apitul/1/xyz',
    path: `${CASE_FOLDER}/statement.pdf`,
  });
  uploadTarget.unsortedBasePath.mockResolvedValue(UNSORTED);
  ingest.registerWritten.mockResolvedValue({
    document: { id: 77, name: 'statement.pdf' },
    links: [{ link_type: 'case', link_id: 'C1', relation: 'path', created: true }],
  });
});

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** A provider whose stat returns a file at `path`. */
function mkProvider(path = `${CASE_FOLDER}/statement.pdf`, over = {}) {
  const p = {
    stat: jest.fn(async () => ({
      '.tag': 'file', id: 'id:LANDED', name: path.split('/').pop(),
      path_display: path, path_lower: path.toLowerCase(),
      size: 10, rev: '1', ...over,
    })),
  };
  sources.get.mockReturnValue(p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// lib/uploadTicket
// ─────────────────────────────────────────────────────────────────────────────

describe('uploadTicket', () => {
  test('round-trips its payload', () => {
    const t = tickets.sign({ path: '/a/b.pdf', link_type: 'case', link_id: 'C1' });
    expect(tickets.verify(t)).toMatchObject({ path: '/a/b.pdf', link_type: 'case', link_id: 'C1' });
  });

  test('a TAMPERED payload is refused — this is the whole point', () => {
    // Re-pointing a ticket at another case is the attack. Flipping the payload
    // without the key cannot produce a matching MAC.
    const t = tickets.sign({ path: '/a/b.pdf', link_type: 'case', link_id: 'C1' });
    const [p, sig] = t.split('.');
    const evil = Buffer.from(JSON.stringify({
      path: '/a/b.pdf', link_type: 'case', link_id: 'VICTIM', exp: Date.now() + 1e6,
    })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(() => tickets.verify(`${evil}.${sig}`)).toThrow(/invalid or has expired/);
    expect(p).not.toBe(evil);
  });

  test('an EXPIRED ticket is refused', () => {
    expect(() => tickets.verify(tickets.sign({ path: '/a' }, -1000))).toThrow(/invalid or has expired/);
  });

  test('garbage, empty and oversized inputs are refused without throwing something else', () => {
    for (const bad of ['', 'x', 'a.b', null, undefined, 42, 'a'.repeat(5000)]) {
      expect(() => tickets.verify(bad)).toThrow(/invalid or has expired/);
    }
  });

  test('every rejection is a 400 and says the SAME thing', () => {
    // "expired" vs "tampered" is useful in our log and an oracle to a prober.
    const errs = ['', 'a.b', tickets.sign({}, -1)].map(t => {
      try { tickets.verify(t); return null; } catch (e) { return e; }
    });
    expect(errs.every(e => e && e.status === 400)).toBe(true);
    expect(new Set(errs.map(e => e.message)).size).toBe(1);
  });

  test('outlives the Dropbox upload link it accompanies', () => {
    // A ticket that died first would leave a browser holding a file it
    // successfully uploaded and cannot register.
    expect(tickets.DEFAULT_TTL_MS).toBeGreaterThan(7200 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload-link — target resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/documents/upload-link', () => {
  test('a case with a folder targets the CASE FOLDER ROOT, not Client Uploads', async () => {
    // "Client Uploads" means "a client sent this in and nobody has filed it".
    // A staffer filing from the case tab has already done the filing.
    const r = await post('/api/documents/upload-link', { case_id: 'C1', filename: 'statement.pdf' });
    const b = await r.json();

    expect(r.status).toBe(200);
    expect(dropbox.getTemporaryUploadLink.mock.calls[0][1]).toMatchObject({
      sharedLink: 'https://www.dropbox.com/s/case1', filename: 'statement.pdf',
    });
    expect(dropbox.getTemporaryUploadLink.mock.calls[0][1].subfolder).toBeUndefined();
    expect(b).toMatchObject({ placement: 'case' });
    expect(uploadTarget.issueClientUploadLink).not.toHaveBeenCalled();
  });

  test('a case with NO folder falls to the SHARED ladder rather than a local reimplementation', async () => {
    // That ladder is the firm's actual policy for "this case has no folder"
    // (auto-create + review task, else the per-case bin). Forking it here
    // would let the staff and client surfaces drift apart.
    dbRows = [{ case_id: 'C2', case_dropbox: null }];
    uploadTarget.issueClientUploadLink.mockResolvedValue({
      case_id: 'C2', link: 'https://db/l', placement: 'unsorted', path: `${UNSORTED}/C2/x.pdf`,
    });

    const b = await (await post('/api/documents/upload-link', { case_id: 'C2', filename: 'x.pdf' })).json();

    expect(uploadTarget.issueClientUploadLink).toHaveBeenCalled();
    expect(b.placement).toBe('unsorted_case');
    expect(b.note).toMatch(/no working Dropbox folder/i);
    expect(tickets.verify(b.ticket)).toMatchObject({ link_type: 'case', link_id: 'C2' });
  });

  test('a case whose folder link is DEAD falls to the ladder too', async () => {
    dropbox.getTemporaryUploadLink.mockRejectedValueOnce(new Error('shared link revoked'));
    uploadTarget.issueClientUploadLink.mockResolvedValue({
      case_id: 'C1', link: 'https://db/l', placement: 'unsorted', path: `${UNSORTED}/C1/x.pdf`,
    });
    const r = await post('/api/documents/upload-link', { case_id: 'C1', filename: 'x.pdf' });
    expect(r.status).toBe(200);
    expect(uploadTarget.issueClientUploadLink).toHaveBeenCalled();
  });

  test('a CONTACT targets the unsorted bin and SAYS SO', async () => {
    // There is no contact folder convention in this firm's Dropbox. Inventing
    // one inside an upload endpoint would be a filing-policy decision made by
    // a side effect — so the file goes to the bin and the UI is told why.
    dropbox.getTemporaryUploadLink.mockResolvedValue({ link: 'https://db/l', path: `${UNSORTED}/x.pdf` });
    const b = await (await post('/api/documents/upload-link', { contact_id: '1001', filename: 'x.pdf' })).json();

    expect(dropbox.getTemporaryUploadLink.mock.calls[0][1]).toMatchObject({ path: UNSORTED });
    expect(b.placement).toBe('unsorted_contact');
    expect(b.note).toMatch(/no Dropbox folder convention/i);
    expect(tickets.verify(b.ticket)).toMatchObject({ link_type: 'contact', link_id: '1001' });
  });

  test('a GLOBAL upload targets the bin with NO context in the ticket', async () => {
    dropbox.getTemporaryUploadLink.mockResolvedValue({ link: 'https://db/l', path: `${UNSORTED}/x.pdf` });
    const b = await (await post('/api/documents/upload-link', { filename: 'x.pdf' })).json();

    expect(b.placement).toBe('unsorted_global');
    const claim = tickets.verify(b.ticket);
    expect(claim.link_type).toBeUndefined();
    expect(claim.link_id).toBeUndefined();
  });

  test('case_id AND contact_id together is a 400 — one upload has one owner', async () => {
    const r = await post('/api/documents/upload-link', { case_id: 'C1', contact_id: '1', filename: 'x' });
    expect(r.status).toBe(400);
  });

  test('a missing filename is a 400; an unknown case is a 404', async () => {
    expect((await post('/api/documents/upload-link', { case_id: 'C1' })).status).toBe(400);
    dbRows = [];
    expect((await post('/api/documents/upload-link', { case_id: 'NOPE', filename: 'x' })).status).toBe(404);
  });

  test('PATH SEPARATORS in the filename are stripped before they steer the destination', async () => {
    // A filename becomes a Dropbox path segment. A caller who can put '/' in
    // it can walk the file out of the folder the ticket is about to sign.
    await post('/api/documents/upload-link', { case_id: 'C1', filename: '../../etc/passwd' });
    const sent = dropbox.getTemporaryUploadLink.mock.calls[0][1].filename;
    expect(sent).not.toMatch(/[/\\]/);
    expect(sent).not.toMatch(/^\./);
  });

  test('the ticket carries the path Dropbox actually issued', async () => {
    const b = await (await post('/api/documents/upload-link', { case_id: 'C1', filename: 'statement.pdf' })).json();
    expect(tickets.verify(b.ticket).path).toBe(`${CASE_FOLDER}/statement.pdf`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload-commit — the laundering guards
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/documents/upload-commit — registration, not laundering', () => {
  const goodTicket = () =>
    tickets.sign({ path: `${CASE_FOLDER}/statement.pdf`, link_type: 'case', link_id: 'C1' });

  test('the happy path registers with the TICKET\'s context and echoes the target', async () => {
    mkProvider();
    const r = await post('/api/documents/upload-commit', {
      ticket: goodTicket(), external_id: 'id:LANDED',
    });
    const b = await r.json();

    expect(r.status).toBe(201);
    expect(ingest.registerWritten.mock.calls[0][1]).toMatchObject({
      links: [{ type: 'case', id: 'C1' }], createdBy: 9, eventSource: 'upload',
    });
    // The ECHO. The sync bus sniffs the response and never the request, so
    // without these a staff upload is a write with no address.
    expect(b).toMatchObject({ link_type: 'case', link_id: 'C1', relation: 'path' });
    expect(b.document).toMatchObject({ id: 77 });
  });

  test('GUARD 1 — no ticket, a forged ticket, or an expired one is a 400', async () => {
    mkProvider();
    for (const t of [undefined, 'forged.sig', tickets.sign({ path: '/x' }, -1)]) {
      const r = await post('/api/documents/upload-commit', { ticket: t, external_id: 'id:X' });
      expect(r.status).toBe(400);
    }
    expect(ingest.registerWritten).not.toHaveBeenCalled();
  });

  test('GUARD 1 — a body case_id CANNOT override the ticket', async () => {
    // The attack the MAC exists for: an authenticated staffer (or a stolen
    // key) attaching a document to a case they were never issued a link for.
    mkProvider();
    const b = await (await post('/api/documents/upload-commit', {
      ticket: goodTicket(), external_id: 'id:LANDED',
      case_id: 'VICTIM', link_type: 'case', link_id: 'VICTIM',
    })).json();

    expect(ingest.registerWritten.mock.calls[0][1].links).toEqual([{ type: 'case', id: 'C1' }]);
    expect(b.link_id).toBe('C1');
  });

  test('GUARD 2 — a VALID ticket + a file in ANOTHER folder is refused', async () => {
    // The check the MAC alone cannot make. Without it, a legitimate ticket for
    // case C1 replays against any file anywhere.
    mkProvider('/  law office/   cases/ jones - c9/secret.pdf');
    const r = await post('/api/documents/upload-commit', {
      ticket: goodTicket(), external_id: 'id:SOMEONE_ELSES',
    });

    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/not in the folder this upload was issued for/);
    expect(ingest.registerWritten).not.toHaveBeenCalled();
  });

  test('GUARD 2 — a file in a SUBFOLDER of the issued folder is refused', async () => {
    // Parent EQUALITY, not a prefix test: autorename never moves a file into a
    // subfolder, so a prefix test would only widen what can be committed.
    mkProvider(`${CASE_FOLDER}/private/secret.pdf`);
    expect((await post('/api/documents/upload-commit', {
      ticket: goodTicket(), external_id: 'id:X',
    })).status).toBe(400);
  });

  test('GUARD 2 — an AUTORENAMED file in the right folder IS accepted', async () => {
    // The flip side. Every upload commits autorename:true, so demanding path
    // equality would reject the normal second-upload-of-the-same-name case.
    mkProvider(`${CASE_FOLDER}/statement (1).pdf`);
    expect((await post('/api/documents/upload-commit', {
      ticket: goodTicket(), external_id: 'id:RENAMED',
    })).status).toBe(201);
  });

  test('GUARD 3 — external_id is PREFERRED over the issued path', async () => {
    // THE MOST IMPORTANT TEST HERE. With autorename, the issued path now names
    // a DIFFERENT, PRE-EXISTING file. Statting the path instead of the id
    // registers that other document against this case — silently, plausibly,
    // and wrongly.
    const p = mkProvider(`${CASE_FOLDER}/statement (1).pdf`);
    await post('/api/documents/upload-commit', { ticket: goodTicket(), external_id: 'id:LANDED' });
    expect(p.stat).toHaveBeenCalledWith(expect.anything(), 'id:LANDED');
  });

  test('GUARD 3 — with no external_id it falls back to the issued path', async () => {
    // Reachable when Dropbox's response body did not parse in the browser.
    const p = mkProvider();
    await post('/api/documents/upload-commit', { ticket: goodTicket() });
    expect(p.stat).toHaveBeenCalledWith(expect.anything(), `${CASE_FOLDER}/statement.pdf`);
  });

  test('a file that is not in Dropbox is a 404 saying the upload did not complete', async () => {
    const p = mkProvider();
    p.stat.mockRejectedValue(new Error('dropbox: POST /2/files/get_metadata → 409: path/not_found'));
    const r = await post('/api/documents/upload-commit', { ticket: goodTicket(), external_id: 'id:GONE' });

    expect(r.status).toBe(404);
    expect((await r.json()).message).toMatch(/did not complete/);
  });

  test('a FOLDER cannot be committed', async () => {
    mkProvider(`${CASE_FOLDER}/sub`, { '.tag': 'folder' });
    expect((await post('/api/documents/upload-commit', {
      ticket: goodTicket(), external_id: 'id:F',
    })).status).toBe(400);
  });

  test('a GLOBAL commit registers with NO links and echoes NO target', async () => {
    // yc-sync's docLinkGetter fails closed on a missing link_type, which is
    // correct: an unattached file changed no target's document set.
    mkProvider(`${UNSORTED}/x.pdf`);
    ingest.registerWritten.mockResolvedValue({ document: { id: 78 }, links: [] });

    const b = await (await post('/api/documents/upload-commit', {
      ticket: tickets.sign({ path: `${UNSORTED}/x.pdf` }), external_id: 'id:G',
    })).json();

    expect(ingest.registerWritten.mock.calls[0][1].links).toEqual([]);
    expect(b.link_type).toBeUndefined();
    expect(b.document).toMatchObject({ id: 78 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Declaration order
// ─────────────────────────────────────────────────────────────────────────────

test('the upload routes are NOT shadowed by /api/documents/:id', async () => {
  // Express matches in declaration order and both are two segments after the
  // prefix. If ':id' won, "upload-link" would arrive as an id, fail docId()'s
  // integer parse, and 400 with "Invalid id" — which is exactly what a caller
  // sending a bad body also gets, so this would be easy to misdiagnose.
  const r = await post('/api/documents/upload-link', {});
  expect((await r.json()).message).not.toMatch(/Invalid id/);
});
