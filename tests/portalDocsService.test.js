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
//   services/settingsService      getSetting  ← SINGULAR (getSettings is
//                                 mocked as a throwing tripwire). The service calls
//                                 getSetting(db, key) once per key, NOT
//                                 getSettings(db, [keys]). A `getSettings`
//                                 mock leaves `getSetting` undefined, which
//                                 makes the notification path throw into its
//                                 own try/catch and SKIP the email — the
//                                 "email not sent" assertions below would then
//                                 pass for the wrong reason. Hence the
//                                 explicit happy-path test that asserts the
//                                 email IS sent.
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
  // TRIPWIRE, not a working mock. If a future edit reintroduces a
  // getSettings(db, [keys]) call here, the service's own try/catch would
  // swallow it and silently skip the email again — exactly the failure this
  // suite was blind to. The throw makes the cause legible in the console; the
  // `expect(getSettings).not.toHaveBeenCalled()` assertion in the happy-path
  // test is what actually fails the run, since an assertion can't be caught
  // by production code.
  getSettings: jest.fn(() => {
    throw new Error(
      'settingsService.getSettings is not the portal-docs contract — ' +
      'the service reads ONE key via getSetting(db, NOTIFY_TO_KEY)'
    );
  }),
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
const SEEDED_NOTIFY_TO   = 'rena@4lsg.com';
const SEEDED_SENDER      = 'automations@4lsg.com';

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
    const db = stubDb([[scopeRow()], [{ contact_name: 'Jane Doe' }]]);

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
    const db1 = stubDb([[scopeRow()], [{ contact_name: 'Sam Secondary' }]]);
    const ctx1 = await svc.completeUpload(db1, 77, 'AbCdEf12', { files: [{ name: 'a.pdf' }] });
    expect(ctx1.clientName).toBe('Sam Secondary');
    expect(ctx1.contact_id).toBe(77);
    expect(db1.calls[1].params).toEqual([77]);

    const db2 = stubDb([[scopeRow()], []]);
    const ctx2 = await svc.completeUpload(db2, 77, 'AbCdEf12', { files: [{ name: 'a.pdf' }] });
    expect(ctx2.clientName).toBe('Client');
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
  beforeEach(() => {
    emailService.sendEmail.mockResolvedValue({});
    logService.createLogEntry.mockResolvedValue({});
    uploadTarget.inspectUploadDestination.mockResolvedValue(destCase());
    uploadTarget.raiseUnsortedUploadTask.mockResolvedValue({ ok: true, taskId: 1 });
    // Live defaults: recipient from app_settings, sender from firm config.
    getSetting.mockImplementation(async (db, key) =>
      key === svc.NOTIFY_TO_KEY ? SEEDED_NOTIFY_TO : null);
    cfg.mockImplementation(key =>
      key === 'email_automations' ? SEEDED_SENDER : null);
  });

  // ── recipient / sender resolution ─────────────────────────────────────────

  test('POSITIVE: happy path SENDS the email — recipient from app_settings, sender from firm config', async () => {
    // The contrast case for the two skip tests below. Without this, a broken
    // settings mock makes "sendEmail was not called" pass everywhere and the
    // off-switch assertions prove nothing.
    await svc.sendUploadNotifications({}, ctxFixture());

    expect(getSetting).toHaveBeenCalledTimes(1);
    expect(getSetting).toHaveBeenCalledWith({}, svc.NOTIFY_TO_KEY);
    expect(getSettings).not.toHaveBeenCalled();      // singular, one key — see mock
    expect(svc.NOTIFY_TO_KEY).toBe('portal_docs_notify_to');
    expect(cfg).toHaveBeenCalledWith('email_automations');

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const arg = emailService.sendEmail.mock.calls[0][1];
    expect(arg.to).toBe(SEEDED_NOTIFY_TO);
    expect(arg.from).toBe(SEEDED_SENDER);
    expect(arg.subject).toBe('New Documents Uploaded \u2014 Jane Doe (24-40226-mlo)');
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });

  test('edited recipient setting retargets the email — no hardcoded recipient left', async () => {
    getSetting.mockImplementation(async (db, key) =>
      key === svc.NOTIFY_TO_KEY ? 'shoshana@4lsg.com' : null);
    await svc.sendUploadNotifications({}, ctxFixture());
    expect(emailService.sendEmail.mock.calls[0][1].to).toBe('shoshana@4lsg.com');
  });

  test('sender follows cfg(email_automations) — one firm-wide setting moves every automation', async () => {
    cfg.mockImplementation(key => key === 'email_automations' ? 'office@4lsg.com' : null);
    await svc.sendUploadNotifications({}, ctxFixture());
    expect(emailService.sendEmail.mock.calls[0][1].from).toBe('office@4lsg.com');
  });

  test('sender falls back to the hardcoded automations address when firm config is unset', async () => {
    cfg.mockReturnValue(null);
    await svc.sendUploadNotifications({}, ctxFixture());
    expect(emailService.sendEmail.mock.calls[0][1].from).toBe('automations@4lsg.com');
  });

  test('blank/missing recipient → email SKIPPED (off-switch), log entry still written', async () => {
    getSetting.mockResolvedValue('   ');                 // blank = off
    await expect(svc.sendUploadNotifications({}, ctxFixture())).resolves.toBeDefined();
    expect(getSetting).toHaveBeenCalledTimes(1);          // the mock IS live
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);

    getSetting.mockResolvedValue(null);                   // key absent
    await svc.sendUploadNotifications({}, ctxFixture());
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(logService.createLogEntry).toHaveBeenCalledTimes(2);
  });

  test('settings read failure → email skipped self-caught, log entry still written', async () => {
    getSetting.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.sendUploadNotifications({}, ctxFixture())).resolves.toBeDefined();
    expect(getSetting).toHaveBeenCalledTimes(1);          // the mock IS live
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
  });

  // ── placement wording (complete-time re-inspection) ───────────────────────

  test('placement is re-derived server-side at complete time, not carried from issuance', async () => {
    await svc.sendUploadNotifications({}, ctxFixture());
    expect(uploadTarget.inspectUploadDestination).toHaveBeenCalledWith({}, 'AbCdEf12');
    const { html } = emailService.sendEmail.mock.calls[0][1];
    expect(html).toContain('Open Dropbox Folder');
    expect(uploadTarget.raiseUnsortedUploadTask).not.toHaveBeenCalled();
  });

  test('unsorted placement → warning wording, unsorted link, and a staff task', async () => {
    uploadTarget.inspectUploadDestination.mockResolvedValue({
      case_id: 'AbCdEf12',
      placement: 'unsorted',
      path: '/  Law Office/   Cases/  Unsorted Client Uploads/AbCdEf12 - Doe, Jane',
      link: 'https://www.dropbox.com/sh/unsorted',
    });
    await svc.sendUploadNotifications({}, ctxFixture());

    const { html } = emailService.sendEmail.mock.calls[0][1];
    expect(html).toContain('no working Dropbox folder');
    expect(html).toContain('href="https://www.dropbox.com/sh/unsorted"');
    expect(html).not.toContain('Open Dropbox Folder');

    expect(uploadTarget.raiseUnsortedUploadTask).toHaveBeenCalledTimes(1);
    expect(uploadTarget.raiseUnsortedUploadTask.mock.calls[0][1]).toEqual({
      caseId: 'AbCdEf12',
      clientName: 'Jane Doe',
      fileCount: 2,
      path: '/  Law Office/   Cases/  Unsorted Client Uploads/AbCdEf12 - Doe, Jane',
      link: 'https://www.dropbox.com/sh/unsorted',
    });
  });

  test('unsorted with no shared link → the path is shown instead, escaped', async () => {
    uploadTarget.inspectUploadDestination.mockResolvedValue({
      case_id: 'AbCdEf12',
      placement: 'unsorted',
      path: '/Unsorted/<AbCdEf12>',
      link: null,
    });
    await svc.sendUploadNotifications({}, ctxFixture());
    const { html } = emailService.sendEmail.mock.calls[0][1];
    expect(html).toContain('<code>/Unsorted/&lt;AbCdEf12&gt;</code>');
    expect(html).not.toContain('<code>/Unsorted/<AbCdEf12>');
  });

  test('inspection failure or null degrades to the ctx dropboxLink — never blocks the email', async () => {
    uploadTarget.inspectUploadDestination.mockRejectedValueOnce(new Error('dropbox down'));
    await expect(svc.sendUploadNotifications({}, ctxFixture())).resolves.toBeDefined();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail.mock.calls[0][1].html).toContain('Open Dropbox Folder');
    expect(uploadTarget.raiseUnsortedUploadTask).not.toHaveBeenCalled();

    uploadTarget.inspectUploadDestination.mockResolvedValueOnce(null);
    await svc.sendUploadNotifications({}, ctxFixture({ dropboxLink: '' }));
    expect(emailService.sendEmail.mock.calls[1][1].html)
      .toContain('No Dropbox link on file for this case.');
  });

  // ── body construction ─────────────────────────────────────────────────────

  test('EVERY interpolated HTML value is escaped — hostile filename, comment, item name, href', async () => {
    await svc.sendUploadNotifications({}, ctxFixture({
      clientName: 'Jane <b>Doe</b>',
      files: [{ name: '<img src=x onerror=alert(1)>.pdf', item_id: 7, item_name: 'Stubs <script>' }],
      fileCount: 1,
      comment: '"><script>steal()</script>',
    }));
    const { subject, html } = emailService.sendEmail.mock.calls[0][1];

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.pdf');
    expect(html).toContain('Stubs &lt;script&gt;');
    expect(html).toContain('&quot;&gt;&lt;script&gt;steal()&lt;/script&gt;');
    // The folder link sits in an href — the quote must not break the attribute.
    expect(html).toContain('href="https://www.dropbox.com/sh/abc&quot;123"');
    // Subject is a MIME header — deliberately NOT escaped (repo convention).
    expect(subject).toContain('Jane <b>Doe</b>');
  });

  test('files group under DB item names; unmatched files under Other documents', async () => {
    await svc.sendUploadNotifications({}, ctxFixture());
    const { html } = emailService.sendEmail.mock.calls[0][1];
    expect(html).toContain('<strong>Pay stubs</strong>');
    expect(html).toContain('<strong>Other documents</strong>');
    expect(html.indexOf('Pay stubs')).toBeLessThan(html.indexOf('Other documents'));
    expect(html).toContain('via the client portal');
  });

  test('omitted files are acknowledged rather than silently dropped', async () => {
    await svc.sendUploadNotifications({}, ctxFixture({ fileCount: 52, omittedCount: 2 }));
    expect(emailService.sendEmail.mock.calls[0][1].html)
      .toContain('and 2 more files not listed');
  });

  test('case log entry: type docs on the case, by 0, incoming, portal-tagged data', async () => {
    await svc.sendUploadNotifications({}, ctxFixture());
    const arg = logService.createLogEntry.mock.calls[0][1];
    expect(arg).toMatchObject({
      type: 'docs',
      link_type: 'case',
      link_id: 'AbCdEf12',
      by: 0,
      direction: 'incoming',
      subject: 'Client uploaded 2 documents via portal',
    });
    const data = JSON.parse(arg.data);
    expect(data).toMatchObject({ action: 'client_upload', source: 'portal', contact_id: 42, file_count: 2 });
    expect(data.files[0]).toEqual({ name: 'a.pdf', item_id: 7, item_name: 'Pay stubs' });
  });

  test('one failing side effect never blocks the other (self-caught)', async () => {
    emailService.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(svc.sendUploadNotifications({}, ctxFixture())).resolves.toBeDefined();
    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);

    logService.createLogEntry.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.sendUploadNotifications({}, ctxFixture())).resolves.toBeDefined();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(2);
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