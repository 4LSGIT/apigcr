// tests/storageReplay.routes.test.js
//
/**
 * STORAGE REPLAY GOLDEN — scenario 8, the upload routes (storage-seam D0).
 *
 * `POST /api/documents/upload-link` → the browser uploads straight to the
 * provider → `POST /api/documents/upload-commit` registers what landed; and
 * `GET /api/documents/:id/raw` reads bytes back through the provider seam.
 * Same recording fake, same world, same golden mechanics as
 * tests/storageReplay.test.js (its header has the rules); a separate file
 * because routes/api.documents.js needs documentSyncService mocked away to
 * load, and the main file drives the real one.
 *
 * Golden: tests/fixtures/storageReplay.routes.golden.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = 'test-secret-for-upload-tickets';
process.env.FIRM_TIMEZONE = process.env.FIRM_TIMEZONE || 'America/Detroit';

jest.mock('../services/dropboxService', () => require('./helpers/recordingDropbox').factory());
jest.mock('../services/settingsService', () => ({
  getSetting: jest.fn(async (db, key) => (mockWorld.current.settings[key] ?? null)),
  getSettings: jest.fn(async (db, keys) => Object.fromEntries(keys.map((k) => [k, mockWorld.current.settings[k] ?? null]))),
}));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async (db, t) => { mockWorld.current.effects.push({ kind: 'task.create', ...mockWorld.scrub(t) }); return { task_id: 700 + mockWorld.current.effects.length }; }),
}));
jest.mock('../services/esignAlertService', () => ({ resolveAlertAssignee: jest.fn(async () => 22) }));
jest.mock('../services/documentSyncService', () => ({}));
jest.mock('../services/documentService', () => ({
  getById: jest.fn(async (db, id) => mockWorld.rows.get(Number(id)) || null),
  list: jest.fn(async () => ({ rows: [], total: 0 })),
  listLinks: jest.fn(async () => []),
}));
jest.mock('../services/documentIngestService', () => ({
  registerWritten: jest.fn(async (db, o) => {
    const w = mockWorld.current; w.docN = (w.docN || 0) + 1;
    w.effects.push({ kind: 'registry.registerWritten', ...mockWorld.scrub({ entry: o.entry, links: o.links, createdBy: o.createdBy, eventSource: o.eventSource, source: o.source }) });
    const e = o.entry;
    const document = { id: 900 + w.docN, source: o.source, external_id: e.id, name: e.name, path: e.path_display, path_lower: e.path_lower, ext: String(e.name).split('.').pop().toLowerCase(), size: e.size, status: 'active' };
    mockWorld.rows.set(document.id, document);
    return { document, links: (o.links || []).map((l) => ({ link_type: l.type, link_id: String(l.id), relation: 'upload', created: true })) };
  }),
  registerWrittenSafe: jest.fn(async (db, o) => {
    const w = mockWorld.current;
    w.effects.push({ kind: 'registry.registerWrittenSafe', ...mockWorld.scrub({ entry: o.entry, links: o.links, createdBy: o.createdBy, eventSource: o.eventSource }) });
    return { ok: true, document: { id: 950 }, links: [] };
  }),
  registerLandedInFolder: jest.fn(),
}));
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
let mockAuth = { userId: 6 };
jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => { req.auth = mockAuth; next(); }));

const mockWorld = { current: null, rows: new Map(), scrub: require('./helpers/recordingDropbox').scrub };

const express = require('express');
const W = require('./helpers/storageReplayWorld');
const fake = require('../services/dropboxService').__fake;
const router = require('../routes/api.documents');
const freelook = require('../routes/freelook');

const GOLDEN = path.join(__dirname, 'fixtures', 'storageReplay.routes.golden.json');
const WRITE = process.env.STORAGE_GOLDEN_WRITE === '1';
if (WRITE && process.env.CI) throw new Error('STORAGE_GOLDEN_WRITE is refused under CI');
const golden = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : { scenarios: {} };
const records = {};

let db, server, base;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = db; next(); });
app.use(router);
app.use(freelook);

beforeAll(async () => {
  jest.useFakeTimers({ now: new Date('2026-11-17T15:00:00Z'), doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'] });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  jest.useRealTimers();
  await new Promise((r) => server.close(r));
  if (WRITE) fs.writeFileSync(GOLDEN, JSON.stringify({ ...golden, scenarios: { ...golden.scenarios, ...records } }, null, 1) + '\n');
});

const post = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

function seedBase(world) {
  const links = fake.seed({
    folders: [`${W.ACTIVE_ROOT}/  Active - Bankruptcy`, `${W.POTENTIAL_ROOT}/  Potential - Bankruptcy`, W.CASE_A_FOLDER, `${W.CASE_A_FOLDER}/Client Uploads`, ...Object.values(W.BINS)],
    links: [W.CASE_A_FOLDER],
  });
  world.cases.hjSFMabb.case_dropbox = links[W.CASE_A_FOLDER];
}

// ── 14. the free-look court-document capture: into the case folder, else the fallback folder
test('14 freelook: a case with a folder, a case without, an unknown case, a refused host', async () => {
  const name = '14 freelook: case folder / fallback folder / unknown case / bad host';
  fake.reset();
  const world = W.baseFixture();
  mockWorld.current = world;
  db = W.makeDb(world);
  seedBase(world);
  const realFetch = global.fetch;
  // The court serves the PDF directly (the first branch of fetchFreeLook); the
  // network is never touched — an *.uscourts.gov URL is the SSRF guard's input only.
  global.fetch = async (url, init) => (String(url).includes('uscourts.gov')
    ? new Response(Buffer.from('%PDF-1.7 free look'), { status: 200, headers: { 'content-type': 'application/pdf' } })
    : realFetch(url, init));
  const http = [];
  try {
    const step = async (label, body) => { const r = await post('/api/court/free-look', body); http.push({ label, status: r.status, ...mockWorld.scrub({ target: r.body.target, reason: r.body.reason, dropbox_path: r.body.dropbox_path, stage: r.body.stage, message: r.body.message }) }); };
    await step('case with a folder', { url: 'https://ecf.mieb.uscourts.gov/doc1/0001?caseid=1&magic_num=2', case_number: '26-44274', title: 'Minute Entry. Hearing Adjourned (BK)' });
    await step('case without a folder → fallback', { url: 'https://ecf.mieb.uscourts.gov/doc1/0002', case_number: '26-50001', title: 'Order' });
    await step('unknown case → fallback', { url: 'https://ecf.mieb.uscourts.gov/doc1/0003', case_number: '99-00000', title: 'Notice' });
    await step('refused host', { url: 'https://evil.example/doc1/0004', case_number: '26-44274', title: 'x' });
  } finally {
    global.fetch = realFetch;
  }
  const record = { calls: fake.calls.slice(), effects: world.effects.slice(), http, provider_state: fake.snapshot() };
  records[name] = record;
  if (!WRITE) {
    expect(golden.scenarios[name]).toBeDefined();
    expect(record).toEqual(golden.scenarios[name]);
  }
});

test('8 routes: upload-link → browser upload → upload-commit, every placement; a foreign file refused; raw read-back', async () => {
  const name = '8 routes: upload-link, upload-commit, raw';
  fake.reset();
  const world = W.baseFixture();
  mockWorld.current = world;
  mockWorld.rows.clear();
  db = W.makeDb(world);
  seedBase(world);
  const http = [];
  const step = async (label, p, body) => { const r = await post(p, body); http.push({ label, status: r.status, ...mockWorld.scrub({ placement: r.body.placement, path: r.body.path, note: r.body.note, message: r.body.message, link_type: r.body.link_type, link_id: r.body.link_id, relation: r.body.relation }) }); return r.body; };

  const a = await step('case A link', '/api/documents/upload-link', { case_id: 'hjSFMabb', filename: 'W2 2025.pdf' });
  fake.simulateUpload(a.path, '%PDF-1.7 w2');
  const committed = await step('case A commit', '/api/documents/upload-commit', { ticket: a.ticket });

  const b = await step('case B link (no folder → ladder creates)', '/api/documents/upload-link', { case_id: 'k9PotLd2', filename: 'Pay stub.pdf' });
  fake.simulateUpload(b.path, '%PDF-1.7 stub');
  await step('case B commit', '/api/documents/upload-commit', { ticket: b.ticket });

  const d = await step('case D link (dead folder → unsorted_case)', '/api/documents/upload-link', { case_id: 'deadLnk1', filename: 'Lease.pdf' });
  fake.simulateUpload(d.path, '%PDF-1.7 lease');
  await step('case D commit', '/api/documents/upload-commit', { ticket: d.ticket });

  const c = await step('contact link (unsorted_contact)', '/api/documents/upload-link', { contact_id: 502, filename: 'ID.png' });
  fake.simulateUpload(c.path, 'png bytes');
  await step('contact commit', '/api/documents/upload-commit', { ticket: c.ticket });

  const g = await step('global link (unsorted_global)', '/api/documents/upload-link', { filename: 'misc.docx' });
  fake.simulateUpload(g.path, 'docx bytes');
  await step('global commit', '/api/documents/upload-commit', { ticket: g.ticket });

  await step('commit of a file outside the issued folder is refused', '/api/documents/upload-commit', { ticket: a.ticket, external_id: fake.node(`${W.CASE_A_FOLDER}/Client Uploads/Pay stub.pdf`) ? fake.node(`${W.CASE_A_FOLDER}/Client Uploads/Pay stub.pdf`).id : 'id:f0002' });
  await step('commit of a file that never landed is a 404', '/api/documents/upload-commit', { ticket: g.ticket, external_id: 'id:f9999' });
  await step('both owners refused', '/api/documents/upload-link', { case_id: 'hjSFMabb', contact_id: 502, filename: 'x.pdf' });
  await step('404 case', '/api/documents/upload-link', { case_id: 'noSuchCs', filename: 'x.pdf' });

  const raw = await fetch(`${base}/api/documents/${committed.document.id}/raw`);
  http.push({ label: 'raw read-back', status: raw.status, type: raw.headers.get('content-type'), disposition: raw.headers.get('content-disposition'), bytes: (await raw.arrayBuffer()).byteLength });

  const record = { calls: fake.calls.slice(), effects: world.effects.slice(), http, provider_state: fake.snapshot() };
  records[name] = record;
  if (!WRITE) {
    expect(golden.scenarios[name]).toBeDefined();
    expect(record).toEqual(golden.scenarios[name]);
  }
});
