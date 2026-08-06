// tests/portalDocsService.test.js
//
// Slice 3 service assertions for services/portalDocsService.js — the portal
// docs contract: scope gating, item-belongs-to-case enforcement, server-side
// upload limits, projection whitelist, notification escaping.
//
// Stub pattern from tests/portalCaseService.test.js (scripted mysql2 pool);
// dropboxService / emailService / logService are jest-mocked so these tests
// exercise portalDocsService's rules, not the adapters (which have their own
// coverage).
//
// Run:
//   npx jest tests/portalDocsService.test.js

'use strict';

jest.mock('../services/dropboxService', () => ({
  getTemporaryUploadLink: jest.fn(),
}));
jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn(),
}));
jest.mock('../services/logService', () => ({
  createLogEntry: jest.fn(),
}));

const dropbox      = require('../services/dropboxService');
const emailService = require('../services/emailService');
const logService   = require('../services/logService');
const svc          = require('../services/portalDocsService');

// ─────────────────────────────────────────────────────────────────────────────
// Stubs / fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Plain pool stub: query() shifts the next scripted [rows] result.
function stubDb(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
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
    expect(dropbox.getTemporaryUploadLink).not.toHaveBeenCalled();
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
    expect(sql).toContain(`cl.title = 'Docs Needed'`);
    expect(sql).toContain('ORDER BY ci.position ASC, ci.id ASC');
  });

  test('has_upload is a bare boolean — the Dropbox link itself never leaves', async () => {
    const noDb = stubDb([[scopeRow({ case_dropbox: null })], []]);
    const out1 = await svc.listDocs(noDb, 42, 'AbCdEf12');
    expect(out1.has_upload).toBe(false);

    const blankDb = stubDb([[scopeRow({ case_dropbox: '   ' })], []]);
    expect((await svc.listDocs(blankDb, 42, 'AbCdEf12')).has_upload).toBe(false);

    const yesDb = stubDb([[scopeRow()], []]);
    const out2 = await svc.listDocs(yesDb, 42, 'AbCdEf12');
    expect(out2.has_upload).toBe(true);
    expect(JSON.stringify(out2)).not.toContain('dropbox.com');
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
    expect(dropbox.getTemporaryUploadLink).not.toHaveBeenCalled();
  });

  test('extension check is case-insensitive on the accept side', async () => {
    const db = stubDb([[scopeRow()]]);
    dropbox.getTemporaryUploadLink.mockResolvedValueOnce({ link: 'https://up', path: '/p' });
    const out = await svc.createUploadLink(db, 42, 'AbCdEf12', { filename: 'ID.JPG', size: 100 });
    expect(out.link).toBe('https://up');
  });

  test('size gate: missing, zero, negative, non-integer, oversize all 400', async () => {
    for (const size of [undefined, 0, -5, 1.5, 'big', svc.MAX_FILE_SIZE + 1]) {
      const db = stubDb([[scopeRow()]]);
      await expect(svc.createUploadLink(db, 42, 'AbCdEf12', { filename: 'a.pdf', size }))
        .rejects.toMatchObject({ status: 400 });
    }
    // Boundary: exactly MAX passes.
    const db = stubDb([[scopeRow()]]);
    dropbox.getTemporaryUploadLink.mockResolvedValueOnce({ link: 'https://up', path: '/p' });
    await expect(svc.createUploadLink(db, 42, 'AbCdEf12',
      { filename: 'a.pdf', size: svc.MAX_FILE_SIZE })).resolves.toBeTruthy();
  });

  test('filename is sanitized before it reaches Dropbox (path steering stripped)', async () => {
    const db = stubDb([[scopeRow()]]);
    dropbox.getTemporaryUploadLink.mockResolvedValueOnce({ link: 'https://up', path: '/p' });
    await svc.createUploadLink(db, 42, 'AbCdEf12',
      { filename: '../..\\..\\secret/../x.pdf', size: 100 });
    const arg = dropbox.getTemporaryUploadLink.mock.calls[0][1];
    expect(arg.filename).not.toMatch(/[\/\\]/);
    expect(arg.filename[0]).not.toBe('.');
    expect(arg.subfolder).toBe('Client Uploads');
    expect(arg.sharedLink).toBe('https://www.dropbox.com/sh/abc123');
  });

  test('no case_dropbox → 400 with client-safe wording (no infra naming)', async () => {
    const db = stubDb([[scopeRow({ case_dropbox: null })]]);
    const err = await svc.createUploadLink(db, 42, 'AbCdEf12', good).catch(e => e);
    expect(err.status).toBe(400);
    expect(err.message).not.toMatch(/dropbox/i);
  });

  test("Dropbox 'expected a folder' → 400 client-safe; other errors propagate with portalCaseId", async () => {
    const db1 = stubDb([[scopeRow()]]);
    dropbox.getTemporaryUploadLink.mockRejectedValueOnce(new Error('link expected a folder'));
    const err1 = await svc.createUploadLink(db1, 42, 'AbCdEf12', good).catch(e => e);
    expect(err1.status).toBe(400);
    expect(err1.message).not.toMatch(/dropbox|folder/i);

    const db2 = stubDb([[scopeRow()]]);
    dropbox.getTemporaryUploadLink.mockRejectedValueOnce(new Error('boom'));
    const err2 = await svc.createUploadLink(db2, 42, 'AbCdEf12', good).catch(e => e);
    expect(err2.message).toBe('boom');
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
    expect(dropbox.getTemporaryUploadLink).not.toHaveBeenCalled();
  });

  test('item lookup is scoped to THIS case via Docs Needed checklists', async () => {
    const db = stubDb([[scopeRow()], [item(7, 'Pay stubs')]]);
    dropbox.getTemporaryUploadLink.mockResolvedValueOnce({ link: 'https://up', path: '/p' });
    await svc.createUploadLink(db, 42, 'AbCdEf12', { itemId: 7, filename: 'a.pdf', size: 100 });
    const sql = db.calls[1].sql;
    expect(sql).toContain(`cl.link_type = 'case'`);
    expect(sql).toContain(`cl.title = 'Docs Needed'`);
    expect(db.calls[1].params).toEqual([[7], 'AbCdEf12']);
  });

  test('omitted itemId is fine — general uploads stay supported', async () => {
    const db = stubDb([[scopeRow()]]);
    dropbox.getTemporaryUploadLink.mockResolvedValueOnce({ link: 'https://up', path: '/p' });
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
// sendUploadNotifications — parity + escaping
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

describe('sendUploadNotifications', () => {
  beforeEach(() => {
    emailService.sendEmail.mockResolvedValue({});
    logService.createLogEntry.mockResolvedValue({});
  });

  test('email recipient/sender parity with the public flow', async () => {
    await svc.sendUploadNotifications({}, ctxFixture());
    const arg = emailService.sendEmail.mock.calls[0][1];
    expect(arg.from).toBe('automations@4lsg.com');
    expect(arg.to).toBe('rena@4lsg.com');
    expect(arg.subject).toBe('New Documents Uploaded \u2014 Jane Doe (24-40226-mlo)');
  });

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
    // dropboxLink sits in an href — the quote must not break the attribute.
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