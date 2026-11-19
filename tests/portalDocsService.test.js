// tests/portalDocsService.test.js
//
// Slice 3 service assertions for services/portalDocsService.js — the portal
// docs contract: scope gating, item-belongs-to-case enforcement, server-side
// upload limits, projection whitelist, notification escaping + routing.
//
// Stub pattern from tests/portalCaseService.test.js (scripted mysql2 pool).
// Mocked collaborators — these tests exercise portalDocsService's RULES, not
// the adapters (which have their own coverage):
//
//   services/uploadTargetService  the upload-target LADDER (case folder →
//                                 auto-created folder → unsorted). Mocking it
//                                 also keeps taskService / esignAlertService /
//                                 dropboxService out of this suite's require
//                                 graph entirely.
//   services/emailService         sendEmail
//   services/logService           createLogEntry
//   services/settingsService      getSetting / getSettings — neither is read by
//                                 this service any more (the shared completion
//                                 phase resolves the recipient); both mocked.
//   lib/firmConfig                cfg('email_automations') — the SENDER. The
//                                 per-feature portal_docs_notify_from key was
//                                 dropped in the 2026-08 upload-fallback
//                                 change (absent from live app_settings);
//                                 mocking cfg is cleaner than seeding
//                                 AUTO_EMAIL because it lets the hardcoded
//                                 last-resort default be tested too.
//
// Run:
//   npx jest tests/portalDocsService.test.js

'use strict';

jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn(),
}));
jest.mock('../services/logService', () => ({
  createLogEntry: jest.fn(),
}));
jest.mock('../services/settingsService', () => ({
  getSetting: jest.fn(),
  // Since 2026-11-19 this service reads NO setting itself: the recipient
  // (email_attachments_reviewer) is resolved by the shared completion phase.
  // Both stay mocked so a regression that reads one here is visible.
  getSettings: jest.fn(() => { throw new Error('settingsService.getSettings: not the portal-docs contract'); }),
}));
jest.mock('../services/uploadTargetService', () => ({
  issueClientUploadLink:   jest.fn(),
  inspectUploadDestination: jest.fn(),
  raiseUnsortedUploadTask:  jest.fn(),
}));
jest.mock('../lib/firmConfig', () => ({
  cfg: jest.fn(),
}));

const emailService  = require('../services/emailService');
const logService    = require('../services/logService');
const uploadTarget  = require('../services/uploadTargetService');
const { getSetting, getSettings } = require('../services/settingsService');
const { cfg }        = require('../lib/firmConfig');
const svc            = require('../services/portalDocsService');
// T9 script-drift guard: registers this file's scripted stubs so a global
// afterEach can fail on over- OR under-consumption of the script array.
// See tests/helpers/scriptGuard.js.
const { scriptGuard } = require('./helpers/scriptGuard');

// Live app_settings / firm-config values as they actually stand (verified
// against app_settings 2026-08-07). portal_docs_notify_from is GONE — the
// sender is the firm-wide automations address. Keep in sync.

// ─────────────────────────────────────────────────────────────────────────────
// Stubs / fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  const guard = scriptGuard('stubDb', script);
  return {
    calls,
    guard,                       // escape hatches: expectOverruns() / allowLeftovers()
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) guard.overrun(sql);
      return [script.shift()];
    },
  };
}

// Whitelisted scope-row shape (what _scopedCaseRow SELECTs).
function scopeRow(over = {}) {
  return Object.assign({
    case_id: 'AbCdEf12',
    case_dropbox: 'https://www.dropbox.com/sh/abc123',
    case_display: '24-40226-mlo',
  }, over);
}

function item(id, name, status = 'incomplete', over = {}) {
  return Object.assign({ id, name, status }, over);
}

// Every key that must never appear anywhere in a client payload.
const FORBIDDEN_KEYS = [
  'case_dropbox', 'tag', 'position', 'checklist_id', 'created_by',
  'created_date', 'updated_date', 'case_status', 'contact_lname',
];

function deepKeys(obj, out = new Set()) {
  if (Array.isArray(obj)) { for (const v of obj) deepKeys(v, out); return out; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) { out.add(k); deepKeys(v, out); }
  }
  return out;
}

afterEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Scope gate
// ─────────────────────────────────────────────────────────────────────────────

describe('scope gate', () => {
  test('non-owned and nonexistent case both → null on every entry point', async () => {
    // One empty scope read covers both; the route turns null into ONE 404.
    expect(await svc.listDocs(stubDb([[]]), 42, 'NotYours1')).toBeNull();
    expect(await svc.createUploadLink(stubDb([[]]), 42, 'NotYours1',
      { filename: 'a.pdf', size: 100 })).toBeNull();
    expect(await svc.completeUpload(stubDb([[]]), 42, 'NotYours1',
      { files: [{ name: 'a.pdf' }] })).toBeNull();
    expect(await svc.recordLanded(stubDb([[]]), 42, 'NotYours1',
      { batch: 'b'.repeat(32), file: { name: 'a.pdf' } })).toBeNull();
    // Scope failure must short-circuit BEFORE the upload-target ladder.
    expect(uploadTarget.issueClientUploadLink).not.toHaveBeenCalled();
  });

  test('scope queries restrict to Primary/Secondary (Other/Bystander excluded)', async () => {
    const db = stubDb([[]]);
    await svc.listDocs(db, 42, 'X');
    expect(db.calls[0].sql).toContain(`case_relate_type IN ('Primary','Secondary')`);
    expect(db.calls[0].params).toEqual([42, 'X']);
  });

  test('downstream queries use the CANONICAL case_id from the scope row', async () => {
    // Collation-insensitive scope match — the checklist query must use the
    // DB's casing, not the request's.
    const db = stubDb([[scopeRow({ case_id: 'AbCdEf12' })], []]);
    await svc.listDocs(db, 42, 'ABCDEF12');
    expect(db.calls[1].params).toEqual(['AbCdEf12']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listDocs — projection + mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('listDocs', () => {
  test('item payload is EXACTLY {id, name, status} in client vocabulary', async () => {
    const db = stubDb([
      [scopeRow()],
      [
        item(7, 'Pay stubs', 'incomplete', { tag: 'internal-tag', position: 1, checklist_id: 55 }),
        item(8, 'Bank statements', 'complete', { tag: null, position: 2, checklist_id: 55 }),
      ],
    ]);
    const out = await svc.listDocs(db, 42, 'AbCdEf12');

    expect(out.case_id).toBe('AbCdEf12');
    expect(out.has_upload).toBe(true);
    expect(out.items).toEqual([
      { id: 7, name: 'Pay stubs', status: 'needed' },
      { id: 8, name: 'Bank statements', status: 'received' },
    ]);
    // Raw enum strings and internal fields never leave.
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/incomplete|complete|internal-tag/);
    const keys = deepKeys(out);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k)).toBe(false);
  });

  test('checklist query filters to case-linked Docs Needed, ordered by position', async () => {
    const db = stubDb([[scopeRow()], []]);
    await svc.listDocs(db, 42, 'AbCdEf12');
    const sql = db.calls[1].sql;
    expect(sql).toContain(`cl.link_type = 'case'`);
    expect(sql).toContain(`cl.tag = 'docs_needed'`);
    expect(sql).toContain('ORDER BY ci.position ASC, ci.id ASC');
  });

  test('has_upload is ALWAYS true (the ladder guarantees a destination) and the Dropbox link never leaves', async () => {
    // Pre-fallback this was `!!case_dropbox`. The upload-target ladder now
    // guarantees a destination for every case, so the field is a constant
    // kept for page-contract compatibility — a null/blank case_dropbox no
    // longer takes the upload button away from the client.
    const noDb = stubDb([[scopeRow({ case_dropbox: null })], []]);
    expect((await svc.listDocs(noDb, 42, 'AbCdEf12')).has_upload).toBe(true);

    const blankDb = stubDb([[scopeRow({ case_dropbox: '   ' })], []]);
    expect((await svc.listDocs(blankDb, 42, 'AbCdEf12')).has_upload).toBe(true);

    const yesDb = stubDb([[scopeRow()], []]);
    const out = await svc.listDocs(yesDb, 42, 'AbCdEf12');
    expect(out.has_upload).toBe(true);
    // The link itself is staff-facing and must never reach the client.
    expect(JSON.stringify(out)).not.toContain('dropbox.com');
    expect(deepKeys(out).has('case_dropbox')).toBe(false);
  });

  test('empty checklist → empty items array (friendly state, not an error)', async () => {
    const db = stubDb([[scopeRow()], []]);
    expect((await svc.listDocs(db, 42, 'AbCdEf12')).items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createUploadLink — limits + item gate
// ─────────────────────────────────────────────────────────────────────────────

describe('createUploadLink limits (server-side, at link issuance)', () => {
  const good = { filename: 'statement.pdf', size: 1024 };

  test('disallowed extensions are rejected 400 — .exe, extensionless, dot-terminal', async () => {
    for (const filename of ['evil.exe', 'noextension', 'trailingdot.', 'script.js', 'a.PDF.exe']) {
      const db = stubDb([[scopeRow()]]);
      await expect(svc.createUploadLink(db, 42, 'AbCdEf12', { filename, size: 100 }))
        .rejects.toMatchObject({ status: 400, portalCaseId: 'AbCdEf12' });
    }
    expect(uploadTarget.issueClientUploadLink).not.toHaveBeenCalled();
  });

  test('extension check is case-insensitive on the accept side', async () => {
    const db = stubDb([[scopeRow()]]);
    uploadTarget.issueClientUploadLink.mockResolvedValueOnce(
      { case_id: 'AbCdEf12', link: 'https://up', placement: 'case' });
    const out = await svc.createUploadLink(db, 42, 'AbCdEf12', { filename: 'ID.JPG', size: 100 });
    expect(out.link).toBe('https://up');
  });

  test('size gate: missing, zero, negative, non-integer, oversize all 400', async () => {
    for (const size of [undefined, 0, -5, 1.5, 'big', svc.MAX_FILE_SIZE + 1]) {
      const db = stubDb([[scopeRow()]]);
      await expect(svc.createUploadLink(db, 42, 'AbCdEf12', { filename: 'a.pdf', size }))
        .rejects.toMatchObject({ status: 400 });
    }
    expect(uploadTarget.issueClientUploadLink).not.toHaveBeenCalled();

    // Boundary: exactly MAX passes.
    const db = stubDb([[scopeRow()]]);
    uploadTarget.issueClientUploadLink.mockResolvedValueOnce(
      { case_id: 'AbCdEf12', link: 'https://up', placement: 'case' });
    await expect(svc.createUploadLink(db, 42, 'AbCdEf12',
      { filename: 'a.pdf', size: svc.MAX_FILE_SIZE })).resolves.toBeTruthy();
  });

  test('filename is sanitized before it reaches the upload-target ladder (path steering stripped)', async () => {
    const db = stubDb([[scopeRow()]]);
    uploadTarget.issueClientUploadLink.mockResolvedValueOnce(
      { case_id: 'AbCdEf12', link: 'https://up', placement: 'case' });
    await svc.createUploadLink(db, 42, 'AbCdEf12',
      { filename: '../..\\..\\secret/../x.pdf', size: 100 });

    // WHERE the file lands is uploadTargetService's business now (sharedLink /
    // subfolder / unsorted path all live in the ladder). This service's
    // contract at the seam is exactly two things: the CANONICAL case id, and a
    // filename that carries no path steering.
    const arg = uploadTarget.issueClientUploadLink.mock.calls[0][1];
    expect(arg.caseId).toBe('AbCdEf12');
    expect(arg.filename).not.toMatch(/[\/\\]/);
    expect(arg.filename[0]).not.toBe('.');
    expect(Object.keys(arg).sort()).toEqual(['caseId', 'filename']);
    // The scope-row db handle is passed through so the ladder reads one pool.
    expect(uploadTarget.issueClientUploadLink.mock.calls[0][0]).toBe(db);
  });

  test('no case_dropbox is NO LONGER a dead end — the ladder is consulted and a link comes back', async () => {
    // Replaces the deleted "no case_dropbox → 400" test. The 2026-08
    // upload-fallback change moved destination resolution into
    // uploadTargetService: this service no longer inspects case_dropbox at
    // issuance at all, it just calls the ladder and returns what it gets.
    const db = stubDb([[scopeRow({ case_dropbox: null })]]);
    uploadTarget.issueClientUploadLink.mockResolvedValueOnce(
      { case_id: 'AbCdEf12', link: 'https://up/unsorted', placement: 'unsorted',
        path: '/  Law Office/   Cases/  Unsorted Client Uploads/AbCdEf12 - Doe, Jane' });

    const out = await svc.createUploadLink(db, 42, 'AbCdEf12', good);

    expect(uploadTarget.issueClientUploadLink).toHaveBeenCalledTimes(1);
    expect(uploadTarget.issueClientUploadLink.mock.calls[0][1].caseId).toBe('AbCdEf12');
    expect(out).toEqual({ case_id: 'AbCdEf12', link: 'https://up/unsorted' });
    // Placement / path are ladder internals — they never reach the client.
    expect(Object.keys(out).sort()).toEqual(['case_id', 'link']);
  });

  test('ladder CASE_NOT_FOUND (row vanished mid-request) → uniform 404; every other error propagates with portalCaseId', async () => {
    const db1 = stubDb([[scopeRow()]]);
    const gone = new Error('issueClientUploadLink: case AbCdEf12 not found');
    gone.code = 'CASE_NOT_FOUND';
    uploadTarget.issueClientUploadLink.mockRejectedValueOnce(gone);
    const err1 = await svc.createUploadLink(db1, 42, 'AbCdEf12', good).catch(e => e);
    expect(err1.status).toBe(404);
    expect(err1.message).toBe('Not found');
    expect(err1.portalCaseId).toBe('AbCdEf12');

    // Total ladder failure (Dropbox unreachable) → route's 500 'Server error',
    // but attributed so the access log still names the case.
    const db2 = stubDb([[scopeRow()]]);
    uploadTarget.issueClientUploadLink.mockRejectedValueOnce(
      new Error('unsorted upload fallback failed (boom)'));
    const err2 = await svc.createUploadLink(db2, 42, 'AbCdEf12', good).catch(e => e);
    expect(err2.status).toBeUndefined();
    expect(err2.message).toBe('unsorted upload fallback failed (boom)');
    expect(err2.portalCaseId).toBe('AbCdEf12');
  });
});

describe('createUploadLink item-belongs-to-case gate', () => {
  test('foreign / unknown / other-case item id → 404-shaped error (no probing oracle)', async () => {
    for (const itemId of [999, '999', 0, -1, 'abc']) {
      const script = [[scopeRow()]];
      // Integer-shaped ids reach the DB (empty result); junk ids short-circuit.
      const n = Number(itemId);
      if (Number.isInteger(n) && n > 0) script.push([]);
      const db = stubDb(script);
      const err = await svc.createUploadLink(db, 42, 'AbCdEf12',
        { itemId, filename: 'a.pdf', size: 100 }).catch(e => e);
      expect(err.status).toBe(404);
      expect(err.message).toBe('Not found');
      expect(err.portalCaseId).toBe('AbCdEf12');
    }
    expect(uploadTarget.issueClientUploadLink).not.toHaveBeenCalled();
  });

  test('item lookup is scoped to THIS case via Docs Needed checklists', async () => {
    const db = stubDb([[scopeRow()], [item(7, 'Pay stubs')]]);
    uploadTarget.issueClientUploadLink.mockResolvedValueOnce(
      { case_id: 'AbCdEf12', link: 'https://up', placement: 'case' });
    await svc.createUploadLink(db, 42, 'AbCdEf12', { itemId: 7, filename: 'a.pdf', size: 100 });
    const sql = db.calls[1].sql;
    expect(sql).toContain(`cl.link_type = 'case'`);
    expect(sql).toContain(`cl.tag = 'docs_needed'`);
    expect(db.calls[1].params).toEqual([[7], 'AbCdEf12']);
  });

  test('omitted itemId is fine — general uploads stay supported', async () => {
    const db = stubDb([[scopeRow()]]);
    uploadTarget.issueClientUploadLink.mockResolvedValueOnce(
      { case_id: 'AbCdEf12', link: 'https://up', placement: 'case' });
    const out = await svc.createUploadLink(db, 42, 'AbCdEf12', { filename: 'a.pdf', size: 100 });
    expect(out).toEqual({ case_id: 'AbCdEf12', link: 'https://up' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// completeUpload — caps + resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('completeUpload', () => {
  test('caps: >50 files trimmed (true count kept), filename 255, comment 2000', async () => {
    const files = [];
    for (let i = 0; i < 52; i++) files.push({ name: 'f' + i + '.pdf' });
    files[0].name = 'x'.repeat(400) + '.pdf';
    const db = stubDb([[scopeRow()], [{ contact_name: 'Jane Doe' }], [], [{ case_id: 'AbCdEf12' }]]);   // + the binding read (no row) and the case PK read behind it (D3d-2: unbound → no link)

    const ctx = await svc.completeUpload(db, 42, 'AbCdEf12',
      { files, comment: 'c'.repeat(3000) });

    expect(ctx.fileCount).toBe(52);
    expect(ctx.files).toHaveLength(50);
    expect(ctx.omittedCount).toBe(2);
    expect(ctx.files[0].name).toHaveLength(255);
    expect(ctx.comment).toHaveLength(2000);
  });

  test('missing/empty files array → 400 with portalCaseId', async () => {
    for (const files of [undefined, null, [], 'nope']) {
      const db = stubDb([[scopeRow()]]);
      const err = await svc.completeUpload(db, 42, 'AbCdEf12', { files }).catch(e => e);
      expect(err.status).toBe(400);
      expect(err.portalCaseId).toBe('AbCdEf12');
    }
  });

  test('item names come from the DB; foreign item_id degrades to general, not a reject', async () => {
    const db = stubDb([
      [scopeRow()],
      [item(7, 'Pay stubs (DB name)')],          // item map: only 7 resolves
      [{ contact_name: 'Jane Doe' }],
      [],                                        // the binding read: no row (D3d-2: the scoped row's column is no fallback)
      [{ case_id: 'AbCdEf12' }],                 // the case PK read behind an unbound case
    ]);
    const ctx = await svc.completeUpload(db, 42, 'AbCdEf12', {
      files: [
        { name: 'a.pdf', item_id: 7 },
        { name: 'b.pdf', item_id: 999 },          // foreign — bytes already landed
        'bare-string.pdf',                        // tolerated, coerced
      ],
    });
    expect(ctx.files[0]).toEqual({ name: 'a.pdf', item_id: 7, item_name: 'Pay stubs (DB name)' });
    expect(ctx.files[1]).toEqual({ name: 'b.pdf', item_id: null, item_name: null });
    expect(ctx.files[2]).toEqual({ name: 'bare-string.pdf', item_id: null, item_name: null });
  });

  test('uploader is the AUTHENTICATED contact (fallback "Client")', async () => {
    const db1 = stubDb([[scopeRow()], [{ contact_name: 'Sam Secondary' }], [], [{ case_id: 'AbCdEf12' }]]);   // + the binding read (no row) + the PK read (D3d-2)
    const ctx1 = await svc.completeUpload(db1, 77, 'AbCdEf12', { files: [{ name: 'a.pdf' }] });
    expect(ctx1.dropboxLink).toBe('');   // D3d-2: unbound — the scoped row's retired column is no fallback
    expect(ctx1.clientName).toBe('Sam Secondary');
    expect(ctx1.contact_id).toBe(77);
    expect(db1.calls[1].params).toEqual([77]);

    const db2 = stubDb([[scopeRow()], [], [{ external_id: null, path_lower: null, human_link: 'https://www.dropbox.com/sh/bound' }]]);   // the binding is the link (D3d-2)
    const ctx2 = await svc.completeUpload(db2, 77, 'AbCdEf12', { files: [{ name: 'a.pdf' }] });
    expect(ctx2.dropboxLink).toBe('https://www.dropbox.com/sh/bound');
    expect(ctx2.clientName).toBe('Client');
  });
});

describe('completeUpload — the batch key (docs intake S3)', () => {
  const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const run = (batch) => svc.completeUpload(
    stubDb([[scopeRow()], [{ contact_name: 'Jane Doe' }], [], [{ case_id: 'AbCdEf12' }]]),
    42, 'AbCdEf12', { files: [{ name: 'a.pdf' }], batch });
  test('a valid key rides the context; absent or malformed → null (the pre-S3 path)', async () => {
    expect((await run(KEY)).batch).toBe(KEY);
    for (const bad of [undefined, null, '', 'short', 'has spaces in the key!!', 42, { k: KEY }, 'x'.repeat(41)]) {
      expect((await run(bad)).batch).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordLanded (docs intake S3)
// ─────────────────────────────────────────────────────────────────────────────

describe('recordLanded', () => {
  const batches = require('../services/clientUploadBatchService');
  const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  let landed;
  beforeEach(() => { landed = jest.spyOn(batches, 'landed').mockResolvedValue({ accepted: true, id: 5, opened: true }); });
  afterEach(() => landed.mockRestore());

  test('appends to the batch under the CANONICAL case id and the authenticated contact; no item → general', async () => {
    const db = stubDb([[scopeRow()]]);
    const r = await svc.recordLanded(db, 42, 'abcdef12', { batch: KEY, file: { name: 'W2.pdf', size: 99 }, comment: 'c'.repeat(3000) });
    expect(r).toEqual({ case_id: 'AbCdEf12', accepted: true });
    expect(landed).toHaveBeenCalledTimes(1);
    expect(landed.mock.calls[0][0]).toBe(db);
    expect(landed.mock.calls[0][1]).toEqual({
      source: 'portal', batchKey: KEY, caseId: 'AbCdEf12', contactId: 42,
      file: { name: 'W2.pdf', item_id: null, item_name: null },
      comment: 'c'.repeat(2000),
    });
    expect(db.calls).toHaveLength(1);   // scope only — no item read without an item
  });

  test('the item NAME comes from the DB; a foreign item id is filed as general, not rejected', async () => {
    const db = stubDb([[scopeRow()], [item(7, 'Pay stubs (DB name)')]]);
    await svc.recordLanded(db, 42, 'AbCdEf12', { batch: KEY, file: { name: 'a.pdf', item_id: 7, item_name: 'client says' } });
    expect(landed.mock.calls[0][1].file).toEqual({ name: 'a.pdf', item_id: 7, item_name: 'Pay stubs (DB name)' });
    expect(db.calls[1].params).toEqual([[7], 'AbCdEf12']);

    const db2 = stubDb([[scopeRow()], []]);
    await svc.recordLanded(db2, 42, 'AbCdEf12', { batch: KEY, file: { name: 'b.pdf', item_id: 999 } });
    expect(landed.mock.calls[1][1].file).toEqual({ name: 'b.pdf', item_id: null, item_name: null });
  });

  test('a refused append is still a normal answer (accepted:false), not an error', async () => {
    landed.mockResolvedValue({ accepted: false, reason: 'closed' });
    expect(await svc.recordLanded(stubDb([[scopeRow()]]), 42, 'AbCdEf12', { batch: KEY, file: { name: 'a.pdf' } }))
      .toEqual({ case_id: 'AbCdEf12', accepted: false });
  });

  test('a bad body → 400 carrying portalCaseId; nothing appended; the filename is capped', async () => {
    for (const body of [
      { file: { name: 'a.pdf' } },
      { batch: 'short', file: { name: 'a.pdf' } },
      { batch: KEY },
      { batch: KEY, file: 'a.pdf' },
      { batch: KEY, file: { name: '  ' } },
      undefined,
    ]) {
      const err = await svc.recordLanded(stubDb([[scopeRow()]]), 42, 'AbCdEf12', body).catch(e => e);
      expect(err.status).toBe(400);
      expect(err.portalCaseId).toBe('AbCdEf12');
    }
    expect(landed).not.toHaveBeenCalled();
    await svc.recordLanded(stubDb([[scopeRow()]]), 42, 'AbCdEf12', { batch: KEY, file: { name: 'n'.repeat(400) } });
    expect(landed.mock.calls[0][1].file.name).toHaveLength(255);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendUploadNotifications — routing, placement wording, parity + escaping
// ─────────────────────────────────────────────────────────────────────────────

function ctxFixture(over = {}) {
  return Object.assign({
    case_id: 'AbCdEf12',
    contact_id: 42,
    clientName: 'Jane Doe',
    caseDisplay: '24-40226-mlo',
    dropboxLink: 'https://www.dropbox.com/sh/abc"123',
    fileCount: 2,
    omittedCount: 0,
    files: [
      { name: 'a.pdf', item_id: 7, item_name: 'Pay stubs' },
      { name: 'b.pdf', item_id: null, item_name: null },
    ],
    comment: '',
  }, over);
}

/** inspectUploadDestination result for the ordinary "landed in the case
 *  folder" outcome. sharedLink deliberately carries the same quote as the
 *  fixture's dropboxLink so the href-escaping assertion holds either way. */
function destCase(over = {}) {
  return Object.assign({
    case_id: 'AbCdEf12',
    placement: 'case',
    sharedLink: 'https://www.dropbox.com/sh/abc"123',
  }, over);
}

describe('sendUploadNotifications', () => {
  // Since 2026-11-19 the side effects are services/clientUploadCompletionService
  // (shared with the public docReq route — tests/clientUploadCompletion.test.js
  // owns the notice, the reviewer, the log row and the task). This suite pins
  // the hand-off: the portal passes its AUTHENTICATED uploader and the resolved
  // item names, and nothing else of the old context is relied on.
  const completion = require('../services/clientUploadCompletionService');
  let spy;
  beforeEach(() => { spy = jest.spyOn(completion, 'completeClientUpload').mockResolvedValue({ sent: true }); });
  afterEach(() => spy.mockRestore());

  test('hands the batch to the shared completion phase as source portal, with the uploader', async () => {
    await expect(svc.sendUploadNotifications({ db: 1 }, ctxFixture())).resolves.toEqual({ sent: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const [db, o] = spy.mock.calls[0];
    expect(db).toEqual({ db: 1 });
    expect(o).toEqual({
      source: 'portal', caseId: 'AbCdEf12', contactId: 42, clientName: 'Jane Doe',
      files: [{ name: 'a.pdf', item_id: 7, item_name: 'Pay stubs' }, { name: 'b.pdf', item_id: null, item_name: null }],
      fileCount: 2, comment: null,
    });
  });

  test('the client comment and the true count travel; the legacy dropboxLink does not', async () => {
    await svc.sendUploadNotifications({}, ctxFixture({ comment: 'two months', fileCount: 52, omittedCount: 50, dropboxLink: 'https://old' }));
    const o = spy.mock.calls[0][1];
    expect(o).toMatchObject({ comment: 'two months', fileCount: 52 });
    expect(o).not.toHaveProperty('dropboxLink');
    expect(o).not.toHaveProperty('omittedCount');
  });

  test('with a batch key: the batch closes and completes through finishByClient (S3) — never directly', async () => {
    const batches = require('../services/clientUploadBatchService');
    const fin = jest.spyOn(batches, 'finishByClient').mockResolvedValue({ status: 'owned', result: { sent: true } });
    try {
      const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
      await expect(svc.sendUploadNotifications({ db: 2 }, ctxFixture({ batch: KEY, comment: 'note' }))).resolves.toEqual({ status: 'owned', result: { sent: true } });
      expect(spy).not.toHaveBeenCalled();
      expect(fin).toHaveBeenCalledWith({ db: 2 }, {
        source: 'portal', batchKey: KEY, caseId: 'AbCdEf12', contactId: 42, clientName: 'Jane Doe',
        files: [{ name: 'a.pdf', item_id: 7, item_name: 'Pay stubs' }, { name: 'b.pdf', item_id: null, item_name: null }],
        fileCount: 2, comment: 'note',
      });
      // batch null (absent / malformed upstream) → the direct hand-off
      await svc.sendUploadNotifications({}, ctxFixture({ batch: null }));
      expect(fin).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { fin.mockRestore(); }
  });

  test('the old recipient key is gone from the service (uploads notify the docs reviewer)', () => {
    expect(svc.NOTIFY_TO_KEY).toBeUndefined();
    expect(getSettings).not.toHaveBeenCalled();
    expect(getSetting).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper units
// ─────────────────────────────────────────────────────────────────────────────

describe('helpers', () => {
  test('status map: complete → received, everything else → needed', () => {
    expect(svc._clientStatus('complete')).toBe('received');
    expect(svc._clientStatus('incomplete')).toBe('needed');
    expect(svc._clientStatus(null)).toBe('needed');
  });

  test('sanitizeFilename: separators/leading dots stripped, 200 cap, empty → upload.dat', () => {
    expect(svc._sanitizeFilename('a/b\\c.pdf')).toBe('a_b_c.pdf');
    expect(svc._sanitizeFilename('...hidden.pdf')).toBe('hidden.pdf');
    expect(svc._sanitizeFilename('x'.repeat(300))).toHaveLength(200);
    expect(svc._sanitizeFilename('///')).toBe('___');
    expect(svc._sanitizeFilename('...')).toBe('upload.dat');
  });
});